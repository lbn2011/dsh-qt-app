/**
 * Distribution checks for t32 acceptance ⑥: the license material must travel
 * with both packaging paths (npm tarball and CMake install), and a package that
 * loses it must fail loudly.
 *
 * The CMake half only runs when a build tree exists; it installs into a temp
 * prefix, the same way the release pipeline does, and asserts the two files are
 * present there.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const packageJson = join(root, 'package.json')

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

test('package.json ships the license material', () => {
  const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as { files?: string[] }
  for (const file of REQUIRED) {
    assert.ok(manifest.files?.includes(file), `package.json "files" omits ${file}`)
  }
  assertLicenseMaterial(root)
})

test('CMake install places the license material next to the binary', { timeout: 120_000 }, (context) => {
  const build = join(root, 'build')
  if (!existsSync(join(build, 'CMakeCache.txt'))) {
    context.skip('no CMake build tree; configure and build first')
    return
  }
  const prefix = mkdtempSync(join(tmpdir(), 'dsh-qt-install-'))
  execFileSync('cmake', ['--install', build, '--prefix', prefix], { stdio: 'pipe', timeout: 90_000 })
  assertLicenseMaterial(prefix)
})

test('a distribution missing the notices is rejected', () => {
  const empty = mkdtempSync(join(tmpdir(), 'dsh-qt-empty-dist-'))
  mkdirSync(empty, { recursive: true })
  writeFileSync(join(empty, 'LICENSE'), 'MIT\n')
  assert.throws(() => assertLicenseMaterial(empty), /THIRD-PARTY-NOTICES\.md/u)
  writeFileSync(join(empty, 'THIRD-PARTY-NOTICES.md'), 'cmark-gfm\n87084a6901297a4fe9af997d4b8cdf9d829b0f67\n')
  assertLicenseMaterial(empty)
})
