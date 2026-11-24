/**
 * Distribution checks for Phase 3 acceptance ⑥: the license material must
 * travel with the real package, not only with an `install` tree.
 *
 * The CMake half of this file does what the release pipeline does:
 *
 *   1. `cpack -G TGZ` (from the build tree, with a test-owned copy of
 *      `CPackConfig.cmake` whose output prefix points at a temp directory);
 *   2. assert the archive name, the adjacent `.sha256`, and that the hash of
 *      the bytes on disk matches it;
 *   3. extract the archive and assert `LICENSE` and `THIRD-PARTY-NOTICES.md`
 *      sit at the archive root, with the notices still naming the vendored
 *      renderer and the pinned addon commit;
 *   4. negatives: an archive without the notices is rejected, and a checksum
 *      that does not describe the archive is rejected.
 *
 * The `install` path stays covered too; both routes are release surfaces.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const packageJson = join(root, 'package.json')
const build = join(root, 'build')

const REQUIRED = ['LICENSE', 'THIRD-PARTY-NOTICES.md']

/** Throws unless `directory` ships the required license material. */
function assertLicenseMaterial(directory: string): void {
  for (const file of REQUIRED) {
    assert.ok(existsSync(join(directory, file)), `${directory} does not ship ${file}`)
  }
  const notices = readFileSync(join(directory, 'THIRD-PARTY-NOTICES.md'), 'utf8')
  assert.match(notices, /cmark-gfm/u, 'third-party notices must name the vendored markdown renderer')
  assert.match(notices, /87084a6901297a4fe9af997d4b8cdf9d829b0f67/u, 'notices must pin the addon commit they describe')
}

/**
 * Produces a `CPackConfig.cmake` whose output directory is `output`.
 *
 * `cpack -B` is ignored once the config file sets `CPACK_OUTPUT_FILE_PREFIX`,
 * and passing `-D CPACK_OUTPUT_FILE_PREFIX=...` is overridden by the config
 * too, so the test rewrites that single line in a private copy. Everything
 * else (install rules, checksum, file name) stays exactly the shipped config.
 */
function isolatedCpackConfig(output: string): string {
  const source = join(build, 'CPackConfig.cmake')
  assert.ok(existsSync(source), 'no CPackConfig.cmake; configure the CMake build first')
  const config = readFileSync(source, 'utf8')
  const rewritten = config
    .split('\n')
    .map((line) => (/^set\(CPACK_OUTPUT_FILE_PREFIX /u.test(line)
      ? `set(CPACK_OUTPUT_FILE_PREFIX "${output}")`
      : line))
    .join('\n')
  assert.notEqual(rewritten, config, 'CPackConfig.cmake has no CPACK_OUTPUT_FILE_PREFIX line to redirect')
  const file = join(output, 'CPackConfig.test.cmake')
  writeFileSync(file, rewritten)
  return file
}

/** Runs CPack for one generator into `output` and returns the archive path. */
function runCpack(generator: string, output: string): string {
  mkdirSync(output, { recursive: true })
  const config = isolatedCpackConfig(output)
  execFileSync('cpack', ['-G', generator, '--config', config], {
    cwd: build,
    stdio: 'pipe',
    timeout: 180_000,
  })
  const archives = readdirSync(output).filter((name) => name.endsWith('.tar.gz'))
  assert.equal(archives.length, 1, `expected exactly one TGZ in ${output}, got ${archives.join(', ')}`)
  return join(output, archives[0] as string)
}

/**
 * The file name of `filePath`, whichever separator style it uses.
 *
 * The hosted Windows runners hand us `C:\...\bad.tar.gz`, where splitting on
 * `/` alone yields the whole path, so the comparison below must understand both
 * separators on every host (T48-1).
 */
function fileName(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return cut === -1 ? filePath : filePath.slice(cut + 1)
}

/** Parses an adjacent `<archive>.sha256` file. */
function readChecksumFile(archive: string): string {
  const file = `${archive}.sha256`
  assert.ok(existsSync(file), `missing checksum file ${file}`)
  const text = readFileSync(file, 'utf8').trim()
  const match = /^([0-9a-f]{64})\s+\*?(.+)$/u.exec(text)
  assert.ok(match !== null, `malformed checksum file: ${JSON.stringify(text)}`)
  assert.equal(match[2], fileName(archive), 'checksum file names a different archive')
  return match[1] as string
}

/** Throws unless the SHA-256 of `archive` matches (or equals `expected`). */
function verifyChecksum(archive: string, expected = readChecksumFile(archive)): void {
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  assert.equal(actual, expected, 'SHA-256 does not describe the archive bytes')
}

/** Extracts `archive` and returns the single root directory. */
function extractArchive(archive: string): string {
  const destination = mkdtempSync(join(tmpdir(), 'dsh-qt-extract-'))
  execFileSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'pipe', timeout: 60_000 })
  const entries = readdirSync(destination)
  assert.equal(entries.length, 1, `archive must have one root directory, found ${entries.join(', ')}`)
  return join(destination, entries[0] as string)
}

test('package.json ships the license material', () => {
  const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as { files?: string[] }
  for (const file of REQUIRED) {
    assert.ok(manifest.files?.includes(file), `package.json "files" omits ${file}`)
  }
  assertLicenseMaterial(root)
})

test('CMake install places the license material next to the binary', { timeout: 120_000 }, (context) => {
  if (!existsSync(join(build, 'CMakeCache.txt'))) {
    context.skip('no CMake build tree; configure and build first')
    return
  }
  const prefix = mkdtempSync(join(tmpdir(), 'dsh-qt-install-'))
  execFileSync('cmake', ['--install', build, '--prefix', prefix], { stdio: 'pipe', timeout: 90_000 })
  assertLicenseMaterial(prefix)
})

test('CPack TGZ archive carries LICENSE + notices at its root and a valid SHA-256', { timeout: 240_000 }, (context) => {
  if (!existsSync(join(build, 'CPackConfig.cmake'))) {
    context.skip('no CPack config; configure the CMake build first')
    return
  }
  const output = mkdtempSync(join(tmpdir(), 'dsh-qt-cpack-'))
  const archive = runCpack('TGZ', output)

  assert.match(archive, /dsh-qt-app-.+-Linux-.+\.tar\.gz$/u, 'unexpected package file name')
  verifyChecksum(archive)

  const packagedRoot = extractArchive(archive)
  assertLicenseMaterial(packagedRoot)
  // The binary travels next to the license material, not instead of it.
  assert.ok(existsSync(join(packagedRoot, 'bin', 'dsh-qt-app')), 'archive is missing bin/dsh-qt-app')
})

test('an archive missing the notices is rejected', () => {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-qt-badpkg-'))
  const tree = join(staging, 'dsh-qt-app-bad')
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, 'LICENSE'), 'MIT\n')
  const archive = join(staging, 'bad.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', staging, 'dsh-qt-app-bad'], { stdio: 'pipe' })
  const packagedRoot = extractArchive(archive)
  assert.throws(() => assertLicenseMaterial(packagedRoot), /THIRD-PARTY-NOTICES\.md/u)
})

test('the checksum name check understands Windows and POSIX paths', () => {
  assert.equal(fileName('C:\\Users\\runner\\AppData\\Local\\Temp\\dsh-qt-badsum-x\\bad.tar.gz'), 'bad.tar.gz')
  assert.equal(fileName('/tmp/dsh-qt-badsum-x/bad.tar.gz'), 'bad.tar.gz')
  assert.equal(fileName('bad.tar.gz'), 'bad.tar.gz')
})

test('a checksum that does not describe the archive is rejected', () => {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-qt-badsum-'))
  const tree = join(staging, 'dsh-qt-app-bad')
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, 'LICENSE'), 'MIT\n')
  writeFileSync(join(tree, 'THIRD-PARTY-NOTICES.md'), 'cmark-gfm\n87084a6901297a4fe9af997d4b8cdf9d829b0f67\n')
  const archive = join(staging, 'bad.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', staging, 'dsh-qt-app-bad'], { stdio: 'pipe' })
  assert.throws(
    () => {
      writeFileSync(`${archive}.sha256`, `${'0'.repeat(64)}  bad.tar.gz\n`)
      verifyChecksum(archive)
    },
    /SHA-256 does not describe the archive bytes/u,
  )
})