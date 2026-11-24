/**
 * End-to-end proof of the WebEngine branch (T28-2 / T28-3).
 *
 * The shipped binary is built with `-DDSH_QT_WEBENGINE=ON`; the test spawns it
 * headless and serves a real HTTP page from this process. The fake part is
 * deliberately narrow: a `HostBridgeService` answers `webui.open`,
 * `webui.token` and `webui.close` the way the Node `WebuiService` does. The
 * load itself, the token hand-over, the Chromium navigation and the close path
 * are the production ones.
 *
 * Assertions:
 *   1. `webui.open` → Ready → `webui.token` reaches the native consumer with
 *      `outcome=embedded` and a masked URL;
 *   2. Chromium commits the marker page: `loadFinished` is forwarded as
 *      `loadState=loaded` with the real `<title>`, and the HTTP server saw the
 *      request with the correct bearer token;
 *   3. `closeWebui()` drives the view to `about:blank` (`state=closed`,
 *      `url=about:blank`, `visible=0`) before the process exits 0;
 *   4. no frame or line contains the raw token.
 *
 * The second test covers T28-3: the external-browser fallback records the
 * exact URL it would hand to the desktop (`DSH_QT_OPEN_URL_LOG`) and this test
 * performs a real GET against it, while the same server rejects a missing or
 * wrong token. The hook only records; it never stands in for a load.
 *
 * Not part of `pnpm test` (pattern `tests/*.test.ts`). Run after a WebEngine
 * build:
 *   DSH_QT_APP_BINARY=build-webengine/dsh-qt-app \
 *   pnpm exec tsx --test tests/webengine-chromium.e2e.ts
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { HostBridgeService } from '../src/host/bridge-service.js'
import { HostTransport } from '../src/host/transport.js'

const root = resolve(import.meta.dirname, '..')
const binary = process.env['DSH_QT_APP_BINARY']
  ?? join(root, 'build-webengine', process.platform === 'win32' ? 'dsh-qt-app.exe' : 'dsh-qt-app')

const cache = join(root, 'build-webengine', 'CMakeCache.txt')
const webengineConfigured = existsSync(cache) && /DSH_QT_WEBENGINE:BOOL=ON/u.test(readFileSync(cache, 'utf8'))
const skip =
  process.platform !== 'linux'
    ? 'real Chromium e2e is only wired for Linux CI'
    : !existsSync(binary)
      ? `no WebEngine binary at ${binary}; run cmake -S . -B build-webengine -DDSH_QT_WEBENGINE=ON && cmake --build build-webengine first`
      : !webengineConfigured
        ? `${cache} does not say DSH_QT_WEBENGINE:BOOL=ON`
        : false

const MARKER = 'DSH-WEBUI-MARKER-7419'
const SECRET = 'chromium-e2e-secret-7419'

interface Served {
  readonly server: Server
  readonly port: number
  readonly authorizedHits: string[]
  readonly rejectedHits: string[]
}

/** @returns a marker page that only answers with the exact `?token=`. */
async function serveMarkedPage(): Promise<Served> {
  const authorizedHits: string[] = []
  const rejectedHits: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204).end()
      return
    }
    if (url.searchParams.get('token') !== SECRET) {
      rejectedHits.push(url.pathname)
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('denied')
      return
    }
    authorizedHits.push(url.pathname)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      `<!doctype html><html><head><title>${MARKER}</title></head>`
        + `<body><h1 id="marker">${MARKER}</h1></body></html>`,
    )
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return { server, port: address.port, authorizedHits, rejectedHits }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
}

interface RunResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
}

async function runHost(
  mode: string,
  extraEnv: Record<string, string>,
  onTransport: (host: HostBridgeService) => void,
): Promise<RunResult> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-qt-webengine-'))
  const child: ChildProcess = spawn(binary, [], {
    cwd: root,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_QT_HOST_SELFTEST: mode,
      DSH_QT_WEBUI_LINGER_MS: '200',
      QT_QPA_PLATFORM: 'offscreen',
      QTWEBENGINE_CHROMIUM_FLAGS: '--no-sandbox --disable-gpu --disable-dev-shm-usage',
      QTWEBENGINE_DISABLE_SANDBOX: '1',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  assert.ok(child.stdout !== null && child.stdin !== null && child.stderr !== null)

  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) if (line.trim() !== '') stderr.push(line)
  })

  const host = new HostBridgeService(new Context(), { autoLaunch: false, handshakeTimeoutMs: 10_000 })
  onTransport(host)
  host.attach({ transport: new HostTransport({ input: child.stdout, output: child.stdin }), child })

  const result = await new Promise<RunResult>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectExit(new Error(`the Qt host did not exit; stderr:\n${stderr.join('\n')}`))
    }, 120_000)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveExit({ code, signal, stderr: stderr.join('\n') })
    })
  })
  host.dispose()
  rmSync(home, { recursive: true, force: true })
  return result
}

test(
  'WebEngine: open → token → real Chromium load → marker/title → close reaches about:blank',
  { skip, timeout: 150_000 },
  async () => {
    const served = await serveMarkedPage()
    const authenticatedUrl = `http://127.0.0.1:${String(served.port)}/?token=${SECRET}`
    try {
      const result = await runHost('webui-chromium', {}, (host) => {
        host.register('webui.open', () => {
          // The real service emits `webui.state` and then settles the reply;
          // the native side drives the embed from the event.
          host.emitEvent('webui.state', {
            state: 'Ready',
            mode: 'in-process',
            maskedUrl: `http://127.0.0.1:${String(served.port)}/?token=***`,
          })
          return { state: 'Ready', mode: 'in-process' }
        })
        host.register('webui.token', () => ({
          authenticatedUrl,
          maskedUrl: `http://127.0.0.1:${String(served.port)}/?token=***`,
        }))
        host.register('webui.close', () => ({}))
      })

      const text = result.stderr
      assert.equal(result.code, 0, `unexpected exit (${String(result.signal)}); stderr:\n${text}`)
      assert.match(text, /\[selftest\] webview\.available=1/u)
      assert.match(text, /\[selftest\] webview\.container=1/u)
      assert.match(text, /\[selftest\] webui\.state=Ready mode=in-process/u)
      assert.match(text, new RegExp(
        `\\[selftest\\] webui\\.token intent=embed outcome=embedded masked=http://127\\.0\\.0\\.1:${String(served.port)}/\\?token=\\*\\*\\* `, 'u'))
      // Loaded with the real title, not a guessed one.
      assert.match(text, /\[selftest\] webview\.load state=loaded /u)
      assert.match(text, new RegExp(`title=${MARKER} `, 'u'))
      assert.match(text, new RegExp(`url=http://127\\.0\\.0\\.1:${String(served.port)}/\\?token=\\*\\*\\*(?:\\n|$)`, 'u'))
      // Close commits about:blank before the process leaves.
      assert.match(text, /\[selftest\] webview\.load state=closed /u)
      assert.match(text, /\[selftest\] webview\.close visible=0 url=about:blank/u)

      assert.ok(served.authorizedHits.length > 0, 'Chromium never fetched the marker page with the token')
      assert.deepEqual(served.rejectedHits, [], 'Chromium must only request the authenticated URL')
      assert.ok(!text.includes(SECRET), 'the raw token reached stderr')
    } finally {
      await closeServer(served.server)
    }
  },
)

test(
  'external fallback: DSH_QT_OPEN_URL_LOG records the token URL and a real GET authenticates',
  { skip, timeout: 60_000 },
  async () => {
    const served = await serveMarkedPage()
    const logDir = mkdtempSync(join(tmpdir(), 'dsh-qt-open-url-'))
    const log = join(logDir, 'opened-url.log')
    try {
      const result = await runHost('webui-browser', { DSH_QT_OPEN_URL_LOG: log }, (host) => {
        host.register('webui.token', () => ({
          authenticatedUrl: `http://127.0.0.1:${String(served.port)}/?token=${SECRET}`,
          maskedUrl: `http://127.0.0.1:${String(served.port)}/?token=***`,
        }))
      })

      const text = result.stderr
      assert.equal(result.code, 0, `unexpected exit; stderr:\n${text}`)
      assert.match(text, /\[selftest\] webui\.token intent=browser outcome=external /u)
      assert.match(text, new RegExp(`masked=http://127\\.0\\.0\\.1:${String(served.port)}/\\?token=\\*\\*\\* `, 'u'))

      assert.ok(existsSync(log), 'the test hook did not record the URL')
      const mode = statSync(log).mode & 0o777
      assert.equal(mode, 0o600, `hook log must be owner-only, got ${mode.toString(8)}`)
      const recorded = readFileSync(log, 'utf8').trim()
      assert.equal(recorded, `http://127.0.0.1:${String(served.port)}/?token=${SECRET}`)

      // The recorded URL really authenticates; the same endpoint rejects a
      // missing or wrong token. This is a real HTTP GET, not a dispatch claim.
      const ok = await fetch(recorded)
      assert.equal(ok.status, 200)
      assert.match(await ok.text(), new RegExp(MARKER, 'u'))
      assert.equal((await fetch(`http://127.0.0.1:${String(served.port)}/`)).status, 401)
      assert.equal((await fetch(`http://127.0.0.1:${String(served.port)}/?token=wrong`)).status, 401)
      assert.ok(!text.includes(SECRET), 'the raw token reached stderr')
    } finally {
      await closeServer(served.server)
      rmSync(logDir, { recursive: true, force: true })
    }
  },
)