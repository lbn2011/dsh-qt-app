#!/usr/bin/env node
// Verify the dsh-qt-napi addon inside a packaged archive.
//
// CMake decides *at configure time* which prebuild directory to bundle
// (scripts/cmake/dsh-qt-napi-addon.cmake). This script checks the artifact that
// actually came out the other end of CPack, because that is the thing users
// install and the only place a wrong-triple or wrong-format binary is
// irreversible. T29-A is the reason: the Windows package shipped an ELF addon
// under prebuild/win32-x64/, every build signal stayed green, and the app would
// have degraded to plain <pre> Markdown without saying anything.
//
// Usage:
//   node scripts/check-package-addon.mjs --dir <unpacked-archive-root> \
//        --triple <platform>-<arch> [--expect-source <file>] [--expect-sha256 <hex>]
//
//   --dir           root of the unpacked package (the directory holding bin/)
//   --triple        the triple this package targets, e.g. win32-x64, linux-x64
//   --expect-source the artifact the build staged from; its bytes must match the
//                   packaged addon exactly (this is what binds the archive to the
//                   addon artifact the job downloaded)
//   --expect-sha256 assert a specific digest (optional; implied by --expect-source)
//   --expect-addon  required (default) or degraded. `degraded` is the approved
//                   no-addon build: the package must NOT carry dsh-qt-napi/ and
//                   must still ship LICENSE + THIRD-PARTY-NOTICES.md.
//
// Every mode also asserts the archive's own contents: LICENSE and
// THIRD-PARTY-NOTICES.md at the root, and a host executable whose object format
// matches the target triple.
//
// Exit codes follow scripts/check-archive.sh: 0 pass, 1 assertion failed, 2 usage.
//
// The archive is unpacked by the caller: `tar -xzf` for .tar.gz on Linux,
// `7z x`/`Expand-Archive` for .zip on Windows. Keeping extraction out of here
// means the checks are identical on every runner and testable without an archive.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const USAGE = `usage: check-package-addon.mjs --dir <unpacked-root> --triple <platform>-<arch> [--expect-source <file>] [--expect-sha256 <hex>] [--expect-addon required|degraded]`

const FORMATS = {
  elf: { label: 'ELF', magic: [0x7f, 0x45, 0x4c, 0x46] },
  pe: { label: 'PE', magic: [0x4d, 0x5a] },
  macho: { label: 'Mach-O', magic: [0xcf, 0xfa, 0xed, 0xfe] },
}

function fail(message) {
  console.error(`check-package-addon: ${message}`)
  process.exit(1)
}

function usage(message) {
  console.error(`check-package-addon: ${message}`)
  console.error(USAGE)
  process.exit(2)
}

function parseArgs(argv) {
  const args = { dir: '', triple: '', expectSource: '', expectSha256: '', expectAddon: 'required' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) usage(`${arg} needs a value`)
      i += 1
      return next
    }
    switch (arg) {
      case '--dir':
        args.dir = value()
        break
      case '--triple':
        args.triple = value()
        break
      case '--expect-source':
        args.expectSource = value()
        break
      case '--expect-sha256':
        args.expectSha256 = value().toLowerCase()
        break
      case '--expect-addon':
        args.expectAddon = value()
        break
      case '--help':
      case '-h':
        console.log(USAGE)
        process.exit(0)
        break
      default:
        usage(`unknown argument: ${arg}`)
    }
  }
  if (!args.dir) usage('--dir is required')
  if (!args.triple) usage('--triple is required')
  if (!['required', 'degraded'].includes(args.expectAddon)) {
    usage(`--expect-addon must be required or degraded; got '${args.expectAddon}'`)
  }
  if (!/^(win32|linux|darwin)-[a-z0-9]+$/.test(args.triple)) {
    usage(`--triple must look like win32-x64, linux-arm64, darwin-arm64; got '${args.triple}'`)
  }
  return args
}

// The format a triple implies. Mirrors dsh_qt_napi_expected_format in CMake.
export function expectedFormat(triple) {
  if (triple.startsWith('win32-')) return 'pe'
  if (triple.startsWith('linux-')) return 'elf'
  if (triple.startsWith('darwin-')) return 'macho'
  return ''
}

export function detectFormat(path) {
  const head = readFileSync(path).subarray(0, 8)
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
    return 'elf'
  }
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return 'pe'
  // Mach-O thin (LE/BE, 32/64) and fat binaries.
  const magic = head.subarray(0, 4)
  const machoMagics = [
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xfe, 0xed, 0xfa, 0xce],
    [0xca, 0xfe, 0xba, 0xbe],
    [0xbe, 0xba, 0xfe, 0xca],
  ]
  for (const candidate of machoMagics) {
    if (candidate.every((byte, index) => magic[index] === byte)) return 'macho'
  }
  return 'unknown'
}

export function label(format) {
  return FORMATS[format]?.label ?? 'unrecognised'
}

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// Collect every qt-bridge.node under <dir>/dsh-qt-napi/prebuild/, keyed by the
// directory name that carries the triple.
export function collectAddons(root) {
  const prebuild = join(root, 'dsh-qt-napi', 'prebuild')
  if (!existsSync(prebuild)) return []
  return readdirSync(prebuild)
    .map((name) => {
      const path = join(prebuild, name, 'qt-bridge.node')
      if (!existsSync(path)) return null
      if (!statSync(path).isFile()) return null
      return { triple: name, path }
    })
    .filter(Boolean)
}

// Pure check function so the test suite can exercise every branch without a
// process exit. Returns { ok, problems, addon }.
export function checkPackageAddon({
  dir,
  triple,
  expectSource = '',
  expectSha256 = '',
  expectAddon = 'required',
}) {
  const problems = []
  const addonRel = `dsh-qt-napi/prebuild/${triple}/qt-bridge.node`

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, problems: [`${dir} is not a directory`], addon: null }
  }

  // Contents every package must carry, addon or not. This is the Windows-side
  // counterpart of scripts/check-archive.sh, which only reads .tar.gz.
  for (const required of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    const path = join(dir, required)
    if (!existsSync(path) || !statSync(path).isFile()) {
      problems.push(`missing ${required} at the archive root`)
    } else if (statSync(path).size === 0) {
      problems.push(`${required} is empty`)
    }
  }

  const expected = expectedFormat(triple)
  if (!expected) problems.push(`no format rule for triple '${triple}'`)

  // The host executable must be for the same platform as the target triple. A
  // package whose exe and addon disagree is the shape T29-A produced. macOS ships
  // an app bundle, so both layouts are accepted there (macOS is not validated yet
  // — see docs/PHASE-3-STATUS.md).
  const exeCandidates = triple.startsWith('win32-')
    ? ['bin/dsh-qt-app.exe']
    : triple.startsWith('darwin-')
      ? ['dsh-qt-app.app/Contents/MacOS/dsh-qt-app', 'bin/dsh-qt-app']
      : ['bin/dsh-qt-app']
  const exeName = exeCandidates.find((candidate) => existsSync(join(dir, candidate))) ?? exeCandidates[0]
  const exe = join(dir, exeName)
  if (!existsSync(exe)) {
    problems.push(`missing ${exeCandidates.join(' or ')}`)
  } else {
    const exeFormat = detectFormat(exe)
    if (expected && exeFormat !== expected) {
      problems.push(`${exeName} is ${label(exeFormat)}, expected ${label(expected)} for ${triple}`)
    }
  }

  const found = collectAddons(dir)

  // The approved no-addon build: the renderer degrades to plain <pre> on
  // purpose, so an addon tree here means the build picked up something it should
  // not have.
  if (expectAddon === 'degraded') {
    if (found.length > 0) {
      const list = found.map((entry) => `dsh-qt-napi/prebuild/${entry.triple}/qt-bridge.node`).join(', ')
      problems.push(`--expect-addon degraded, but the package carries ${list}`)
    }
    return { ok: problems.length === 0, problems, addon: null }
  }

  if (found.length === 0) {
    problems.push(
      `no dsh-qt-napi/prebuild/*/qt-bridge.node in ${dir} — the package would ship the degraded renderer`,
    )
    return { ok: false, problems, addon: null }
  }
  const foreign = found.filter((entry) => entry.triple !== triple)
  if (foreign.length > 0) {
    const list = foreign.map((entry) => `dsh-qt-napi/prebuild/${entry.triple}/qt-bridge.node`).join(', ')
    problems.push(
      `package carries addon directories for other triples (${list}); only ${addonRel} belongs in a ${triple} package`,
    )
  }
  const addon = found.find((entry) => entry.triple === triple)
  if (!addon) {
    const present = found.map((entry) => entry.triple).join(', ')
    problems.push(`missing ${addonRel} (package has: ${present})`)
    return { ok: false, problems, addon: null }
  }

  const format = detectFormat(addon.path)
  if (expected && format !== expected) {
    problems.push(
      `${addonRel} is ${label(format)}, but a ${triple} package needs ${label(expected)} — ` +
        'the loader would fail require() and degrade silently',
    )
  }

  const digest = sha256(addon.path)
  if (expectSource) {
    if (!existsSync(expectSource)) {
      problems.push(`--expect-source ${expectSource} does not exist`)
    } else {
      const sourceFormat = detectFormat(expectSource)
      if (expected && sourceFormat !== expected) {
        problems.push(`--expect-source ${expectSource} is ${label(sourceFormat)}, expected ${label(expected)}`)
      }
      const sourceDigest = sha256(expectSource)
      if (sourceDigest !== digest) {
        problems.push(
          `packaged addon sha256 ${digest} does not match --expect-source ${expectSource} (${sourceDigest}) — ` +
            'the archive does not carry the artifact this build staged',
        )
      }
    }
  }
  if (expectSha256 && expectSha256 !== digest) {
    problems.push(`packaged addon sha256 ${digest} does not match --expect-sha256 ${expectSha256}`)
  }

  return {
    ok: problems.length === 0,
    problems,
    addon: { ...addon, format, sha256: digest, rel: relative(dir, addon.path) },
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = checkPackageAddon({
    dir: args.dir,
    triple: args.triple,
    expectSource: args.expectSource,
    expectSha256: args.expectSha256,
    expectAddon: args.expectAddon,
  })
  if (!result.ok) {
    for (const problem of result.problems) console.error(`check-package-addon: ${problem}`)
    process.exit(1)
  }
  if (!result.addon) {
    console.log(`check-package-addon: ${args.triple} package carries no addon (degraded renderer, as requested)`)
    console.log('check-package-addon: LICENSE and THIRD-PARTY-NOTICES.md are present')
    return
  }
  const { rel, format, sha256: digest } = result.addon
  console.log(`check-package-addon: ${rel} is ${label(format)} sha256 ${digest} (target ${args.triple})`)
  console.log(`check-package-addon: ${args.triple} package carries the addon at the path the loader searches`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
