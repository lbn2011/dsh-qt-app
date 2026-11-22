/**
 * Unit tests for N-API binding discovery.
 *
 * Discovery must be deterministic and must never throw: the Qt host has to boot
 * even when `dsh-qt-napi` is missing or built for another platform.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createFallbackBridge,
  discoverCandidates,
  escapeHtml,
  isNapiBridge,
  loadNapiModule,
  prebuildTriple,
} from '../src/qt-bridge/napi-loader.js'
import type { NapiBridge } from '../src/qt-bridge/napi-loader.js'
import { NAPI_BINARY_NAME, NAPI_PACKAGE_NAME, NAPI_PATH_ENV } from '../src/constants.js'

const fakeBridge: NapiBridge = {
  renderMarkdown: (text: string) => `<p>${text}</p>`,
  highlightCode: (code: string) => `<code>${code}</code>`,
}

// Discovery skips absolute paths that do not exist, so the "loads a real file"
// cases need actual files on disk (contents are irrelevant: requireFn is faked).
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-qt-napi-'))
const explicitBinding = join(sandbox, 'qt-bridge.node')
const envBinding = join(sandbox, 'qt-bridge-env.node')
writeFileSync(explicitBinding, '')
writeFileSync(envBinding, '')
process.on('exit', () => {
  rmSync(sandbox, { recursive: true, force: true })
})

test('prebuildTriple() matches the prebuild directory layout', () => {
  assert.equal(prebuildTriple('linux', 'x64'), 'linux-x64')
  assert.equal(prebuildTriple('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(prebuildTriple('win32', 'x64'), 'win32-x64')
})

test('discoverCandidates() is ordered explicit -> env -> package -> local build', () => {
  const candidates = discoverCandidates({
    explicitPath: '/opt/dsh/qt-bridge.node',
    env: { [NAPI_PATH_ENV]: '/env/qt-bridge.node' },
    platform: 'linux',
    arch: 'x64',
    searchRoots: ['/repo'],
  })

  assert.equal(candidates[0], '/opt/dsh/qt-bridge.node')
  assert.equal(candidates[1], '/env/qt-bridge.node')
  assert.equal(candidates[2], `${NAPI_PACKAGE_NAME}/prebuild/linux-x64/${NAPI_BINARY_NAME}.node`)
  assert.equal(candidates[3], NAPI_PACKAGE_NAME)
  // Root-derived candidates are built with path.join(), so the expectations must
  // use the platform separator too (this test runs on Windows and macOS in CI).
  assert.ok(candidates.includes(join('/repo', NAPI_PACKAGE_NAME, 'build', 'Release', `${NAPI_BINARY_NAME}.node`)))
  assert.ok(candidates.includes(join('/repo', NAPI_PACKAGE_NAME, 'build', `${NAPI_BINARY_NAME}.node`)))
  // No duplicates, even if an explicit path repeats a discovered one.
  assert.equal(new Set(candidates).size, candidates.length)
})

test('loadNapiModule() loads the first candidate that exposes the bridge API', () => {
  const loaded = loadNapiModule({
    explicitPath: explicitBinding,
    searchRoots: [],
    requireFn: (specifier) => {
      assert.equal(specifier, explicitBinding)
      return fakeBridge
    },
  })

  assert.equal(loaded.degraded, false)
  assert.equal(loaded.source, 'explicit')
  assert.equal(loaded.bridge, fakeBridge)
  assert.deepEqual(loaded.attempted, [explicitBinding])
  assert.equal(loaded.error, undefined)
})

test('loadNapiModule() reports the env variable as its source', () => {
  const loaded = loadNapiModule({
    env: { [NAPI_PATH_ENV]: envBinding },
    searchRoots: [],
    requireFn: () => fakeBridge,
  })
  assert.equal(loaded.source, 'env')
  assert.equal(loaded.degraded, false)
})

test('loadNapiModule() falls back instead of throwing when nothing resolves', () => {
  const loaded = loadNapiModule({
    explicitPath: '/definitely/not/here/qt-bridge.node',
    searchRoots: [],
    requireFn: () => {
      throw new Error('MODULE_NOT_FOUND')
    },
  })

  assert.equal(loaded.degraded, true)
  assert.equal(loaded.source, 'fallback')
  assert.ok(loaded.bridge.version?.startsWith('fallback:'))
  assert.ok(loaded.attempted.length >= 1)
  assert.ok(loaded.error instanceof Error)
})

test('loadNapiModule() rejects a module that lacks the bridge API', () => {
  const loaded = loadNapiModule({
    explicitPath: explicitBinding,
    searchRoots: [],
    requireFn: () => ({ hello: 'world' }),
  })

  assert.equal(loaded.degraded, true)
  assert.match(loaded.error?.message ?? '', /renderMarkdown\(\)\/highlightCode\(\)/)
})

test('isNapiBridge() requires both rendering functions', () => {
  assert.equal(isNapiBridge(fakeBridge), true)
  assert.equal(isNapiBridge({ renderMarkdown: () => '' }), false)
  assert.equal(isNapiBridge(null), false)
  assert.equal(isNapiBridge('bridge'), false)
})

test('escapeHtml() neutralises markup', () => {
  assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;')
})

test('createFallbackBridge() renders escaped plain text with a language class', () => {
  const bridge = createFallbackBridge('missing addon')
  assert.equal(bridge.version, 'fallback:missing addon')
  assert.equal(
    bridge.renderMarkdown('<img src=x onerror=alert(1)>'),
    '<pre class="dsh-qt-fallback">&lt;img src=x onerror=alert(1)&gt;</pre>',
  )
  assert.equal(
    bridge.highlightCode('a < b', 'cpp'),
    '<pre class="dsh-qt-fallback"><code class="language-cpp">a &lt; b</code></pre>',
  )
  // A missing language degrades to the `text` class.
  assert.match(String(bridge.highlightCode('x')), /language-text/)
})
