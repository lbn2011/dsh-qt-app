import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

// The gate that checks the *packaged* archive, i.e. what a user installs. The
// CMake rules decide at configure time which prebuild directory to bundle; this
// is the independent check on the artifact that comes out of CPack. T29-A is the
// regression both exist for: a Windows package that carried an ELF addon under
// prebuild/win32-x64/, with every build signal green.
const root = resolve(import.meta.dirname, '..')
const script = join(root, 'scripts', 'check-package-addon.mjs')

const MAGIC = {
  elf: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  pe: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
  macho: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
} as const

type Format = keyof typeof MAGIC

interface TreeOptions {
  triple: string
  addonFormats?: Record<string, Format>
  exeFormat?: Format
  license?: boolean
  notices?: boolean
  exe?: boolean
}

function writePackage(options: TreeOptions): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pkg-addon-'))
  const tree = join(dir, 'pkg')
  mkdirSync(join(tree, 'bin'), { recursive: true })
  if (options.license !== false) writeFileSync(join(tree, 'LICENSE'), 'MIT License\n')
  if (options.notices !== false) writeFileSync(join(tree, 'THIRD-PARTY-NOTICES.md'), '# notices\n')
  if (options.exe !== false) {
    const exeName = options.triple.startsWith('win32-') ? 'dsh-qt-app.exe' : 'dsh-qt-app'
    const exeFormat = options.exeFormat ?? defaultFormat(options.triple)
    writeFileSync(join(tree, 'bin', exeName), MAGIC[exeFormat])
  }
  for (const [triple, format] of Object.entries(options.addonFormats ?? { [options.triple]: defaultFormat(options.triple) })) {
    const dirForTriple = join(tree, 'dsh-qt-napi', 'prebuild', triple)
    mkdirSync(dirForTriple, { recursive: true })
    writeFileSync(join(dirForTriple, 'qt-bridge.node'), MAGIC[format])
  }
  return tree
}

function defaultFormat(triple: string): Format {
  if (triple.startsWith('win32-')) return 'pe'
  if (triple.startsWith('darwin-')) return 'macho'
  return 'elf'
}

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

function run(args: string[], cli: string = script): Run {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// T80-1: the gate used to decide "am I the entry point?" by comparing
// `import.meta.url` against a hand-built `file://${process.argv[1]}`. That
// comparison is never true on Windows (argv[1] starts with a drive letter) and
// is also false for any path a file URL has to percent-encode, so the CLI ran
// nothing and exited 0 — a gate that silently passes is worse than no gate. A
// checkout path is not something the build controls, so the tests below run the
// CLI from a directory that contains a space, a '#', and a literal '%41'.
function copyCliToHostilePath(): string {
  const base = mkdtempSync(join(tmpdir(), 'dsh gate path '))
  const checkout = join(base, 'checkout #1 %41')
  mkdirSync(join(checkout, 'scripts'), { recursive: true })
  const copy = join(checkout, 'scripts', 'check-package-addon.mjs')
  copyFileSync(script, copy)
  return copy
}

// The gate reports the addon relative to the unpacked archive root, and
// `path.relative()` spells that with the host separator: `dsh-qt-napi/prebuild/
// <triple>/qt-bridge.node` on Linux, `dsh-qt-napi\prebuild\<triple>\...` on
// Windows (T84-1: assertions that hard-coded `/` went red on windows-2022 while
// the gate itself was correct). Pin the exact loader path for the requested
// triple, accepting either separator, and keep format, digest and target strict.
const SEP = '[\\\\/]'

function loaderAddonPath(triple: string): RegExp {
  const rel = ['dsh-qt-napi', 'prebuild', triple, 'qt-bridge\\.node'].join(SEP)
  return new RegExp(`check-package-addon: ${rel} is `, 'u')
}

function withHostileCli(fn: (cli: string) => void): void {
  const cli = copyCliToHostilePath()
  try {
    fn(cli)
  } finally {
    rmSync(join(cli, '..', '..'), { recursive: true, force: true })
  }
}

function withPackage(options: TreeOptions, fn: (tree: string) => void): void {
  const tree = writePackage(options)
  try {
    fn(tree)
  } finally {
    rmSync(join(tree, '..'), { recursive: true, force: true })
  }
}

test('accepts a package that carries the addon for its own triple', () => {
  withPackage({ triple: 'linux-x64' }, (tree) => {
    const result = run(['--dir', tree, '--triple', 'linux-x64'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, loaderAddonPath('linux-x64'))
    assert.match(result.stdout, /is ELF sha256 [0-9a-f]{64} \(target linux-x64\)/u)
    assert.match(result.stdout, /linux-x64 package carries the addon at the path the loader searches/u)
  })
})

test('accepts a Windows package whose addon is PE', () => {
  withPackage({ triple: 'win32-x64' }, (tree) => {
    const result = run(['--dir', tree, '--triple', 'win32-x64'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /qt-bridge\.node is PE/u)
  })
})

test('rejects an ELF addon inside a Windows package (T29-A)', () => {
  withPackage({ triple: 'win32-x64', addonFormats: { 'win32-x64': 'elf' } }, (tree) => {
    const result = run(['--dir', tree, '--triple', 'win32-x64'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /is ELF, but a win32-x64 package needs PE/u)
  })
})

test('rejects a package that also carries another triple', () => {
  withPackage(
    { triple: 'win32-x64', addonFormats: { 'win32-x64': 'pe', 'linux-x64': 'elf' } },
    (tree) => {
      const result = run(['--dir', tree, '--triple', 'win32-x64'])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /carries addon directories for other triples \(dsh-qt-napi\/prebuild\/linux-x64/u)
    },
  )
})

test('rejects a package whose addon is not the artifact the build staged', () => {
  withPackage({ triple: 'linux-x64' }, (tree) => {
    const source = join(tree, '..', 'staged.node')
    writeFileSync(source, Buffer.concat([MAGIC.elf, Buffer.from('different build\n')]))
    try {
      const result = run(['--dir', tree, '--triple', 'linux-x64', '--expect-source', source])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /does not match --expect-source/u)
    } finally {
      rmSync(source, { force: true })
    }
  })
})

test('accepts the staged artifact when the bytes match', () => {
  withPackage({ triple: 'linux-x64' }, (tree) => {
    const source = join(tree, 'dsh-qt-napi', 'prebuild', 'linux-x64', 'qt-bridge.node')
    const result = run(['--dir', tree, '--triple', 'linux-x64', '--expect-source', source])
    assert.equal(result.status, 0, result.stderr)
  })
})

test('rejects a package whose addon digest differs from --expect-sha256', () => {
  withPackage({ triple: 'linux-x64' }, (tree) => {
    const digest = createHash('sha256').update(MAGIC.pe).digest('hex')
    const result = run(['--dir', tree, '--triple', 'linux-x64', '--expect-sha256', digest])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /does not match --expect-sha256/u)
  })
})

test('rejects a package with no addon when one is required', () => {
  withPackage({ triple: 'linux-x64', addonFormats: {} }, (tree) => {
    const result = run(['--dir', tree, '--triple', 'linux-x64'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /no dsh-qt-napi\/prebuild\/\*\/qt-bridge\.node/u)
  })
})

test('accepts the approved degraded package and rejects a stray addon in it', () => {
  withPackage({ triple: 'linux-x64', addonFormats: {} }, (tree) => {
    const ok = run(['--dir', tree, '--triple', 'linux-x64', '--expect-addon', 'degraded'])
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /carries no addon \(degraded renderer/u)
  })
  withPackage({ triple: 'linux-x64' }, (tree) => {
    const result = run(['--dir', tree, '--triple', 'linux-x64', '--expect-addon', 'degraded'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /--expect-addon degraded, but the package carries/u)
  })
})

test('rejects a package missing LICENSE or notices', () => {
  withPackage({ triple: 'linux-x64', license: false }, (tree) => {
    const result = run(['--dir', tree, '--triple', 'linux-x64'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /missing LICENSE at the archive root/u)
  })
  withPackage({ triple: 'linux-x64', notices: false }, (tree) => {
    const result = run(['--dir', tree, '--triple', 'linux-x64'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /missing THIRD-PARTY-NOTICES\.md at the archive root/u)
  })
})

test('rejects a package whose executable is for another platform', () => {
  withPackage({ triple: 'win32-x64', exeFormat: 'elf' }, (tree) => {
    const result = run(['--dir', tree, '--triple', 'win32-x64'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /bin\/dsh-qt-app\.exe is ELF, expected PE for win32-x64/u)
  })
})

test('rejects a package with no executable', () => {
  withPackage({ triple: 'linux-x64', exe: false }, (tree) => {
    const result = run(['--dir', tree, '--triple', 'linux-x64'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /missing bin\/dsh-qt-app/u)
  })
})

test('accepts a Mach-O addon for a darwin triple', () => {
  withPackage({ triple: 'darwin-arm64' }, (tree) => {
    const result = run(['--dir', tree, '--triple', 'darwin-arm64'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /qt-bridge\.node is Mach-O/u)
  })
})

test('treats a malformed triple as a usage error', () => {
  withPackage({ triple: 'linux-x64' }, (tree) => {
    const result = run(['--dir', tree, '--triple', 'linux'])
    assert.equal(result.status, 2)
    assert.match(result.stderr, /--triple must look like/u)
  })
})

test('runs from a checkout path that needs URL escaping (T80-1)', () => {
  withHostileCli((cli) => {
    withPackage({ triple: 'win32-x64' }, (tree) => {
      const result = run(['--dir', tree, '--triple', 'win32-x64'], cli)
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, loaderAddonPath('win32-x64'))
      assert.match(result.stdout, /is PE sha256 [0-9a-f]{64} \(target win32-x64\)/u)
      assert.match(result.stdout, /win32-x64 package carries the addon at the path the loader searches/u)
    })
  })
})

test('rejects a wrong digest from a checkout path that needs URL escaping (T80-1)', () => {
  withHostileCli((cli) => {
    withPackage({ triple: 'linux-x64' }, (tree) => {
      const result = run(
        ['--dir', tree, '--triple', 'linux-x64', '--expect-sha256', '0'.repeat(64)],
        cli,
      )
      assert.equal(result.status, 1)
      assert.match(result.stderr, /does not match --expect-sha256/u)
    })
  })
})

test('rejects the wrong architecture from a checkout path that needs URL escaping (T80-1)', () => {
  withHostileCli((cli) => {
    withPackage({ triple: 'win32-x64', addonFormats: { 'win32-x64': 'elf' } }, (tree) => {
      const result = run(['--dir', tree, '--triple', 'win32-x64'], cli)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /is ELF, but a win32-x64 package needs PE/u)
    })
  })
})

test('importing the gate runs no checks', () => {
  withHostileCli((cli) => {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(cli).href)})`],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
  })
})

// Verbatim stdout from the two CI jobs that disagreed in T84-1: the
// windows-2022 job printed the addon path with backslashes, the ubuntu-22.04
// job with forward slashes, and only the Windows one went red. Both must be
// accepted by the same assertion, and both keep their format, digest and target.
const CI_SAMPLES = [
  {
    job: 'windows-2022',
    triple: 'win32-x64',
    eol: '\r\n',
    path: 'dsh-qt-napi\\prebuild\\win32-x64\\qt-bridge.node',
    digest: 'ba6a1f2f644e0870c6aee38d1c6d7b463397d5e8171e08eeb7da40d3fcfa977e',
    format: 'PE',
  },
  {
    job: 'ubuntu-22.04',
    triple: 'linux-x64',
    eol: '\n',
    path: 'dsh-qt-napi/prebuild/linux-x64/qt-bridge.node',
    digest: '86bdc061d786dcefbb992f54dcef974ee7dc50862575e46fbb626eef6731a60f',
    format: 'ELF',
  },
] as const

for (const sample of CI_SAMPLES) {
  test(`accepts the ${sample.job} CI sample (T84-1)`, () => {
    const stdout = [
      `check-package-addon: ${sample.path} is ${sample.format} sha256 ${sample.digest} (target ${sample.triple})`,
      `check-package-addon: ${sample.triple} package carries the addon at the path the loader searches`,
      '',
    ].join(sample.eol)
    assert.match(stdout, loaderAddonPath(sample.triple))
    assert.match(stdout, new RegExp(`is ${sample.format} sha256 ${sample.digest} \\(target ${sample.triple}\\)`, 'u'))
  })
}

test('rejects the same file name reported for another directory (T84-1)', () => {
  for (const separator of ['/', '\\']) {
    const wrongTriple = ['dsh-qt-napi', 'prebuild', 'linux-x64', 'qt-bridge.node'].join(separator)
    const wrongParent = ['vendor', 'dsh-qt-napi', 'prebuild', 'win32-x64', 'qt-bridge.node'].join(separator)
    for (const line of [wrongTriple, wrongParent]) {
      const stdout = `check-package-addon: ${line} is PE sha256 ${'0'.repeat(64)} (target win32-x64)\n`
      assert.doesNotMatch(stdout, loaderAddonPath('win32-x64'), `${line} must not satisfy the win32-x64 assertion`)
    }
  }
})

test('rejects a package whose addon sits in a same-named directory elsewhere', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pkg-addon-'))
  const tree = join(dir, 'pkg')
  mkdirSync(join(tree, 'bin'), { recursive: true })
  writeFileSync(join(tree, 'LICENSE'), 'MIT License\n')
  writeFileSync(join(tree, 'THIRD-PARTY-NOTICES.md'), '# notices\n')
  writeFileSync(join(tree, 'bin', 'dsh-qt-app.exe'), MAGIC.pe)
  // The loader searches `<root>/dsh-qt-napi/prebuild/win32-x64/qt-bridge.node`.
  // The same names under a different parent must not satisfy it.
  const stray = join(tree, 'vendor', 'dsh-qt-napi', 'prebuild', 'win32-x64')
  mkdirSync(stray, { recursive: true })
  writeFileSync(join(stray, 'qt-bridge.node'), MAGIC.pe)
  try {
    const result = run(['--dir', tree, '--triple', 'win32-x64'])
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /no dsh-qt-napi\/prebuild\/\*\/qt-bridge\.node/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
