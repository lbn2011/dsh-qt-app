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
    assert.match(result.stdout, /dsh-qt-napi\/prebuild\/linux-x64\/qt-bridge\.node is ELF/u)
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
      assert.match(result.stdout, /dsh-qt-napi\/prebuild\/win32-x64\/qt-bridge\.node is PE/u)
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
