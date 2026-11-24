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
 * The second test covers T28-3 without recording the URL: an isolated
 * HOME/XDG profile registers a throw-away desktop entry, QDesktopServices
 * really dispatches through xdg-open, and a real Chromium (headless, driven by
 * `tests/fixtures/controlled-browser.sh`) navigates the authenticated page.
 * The post-JavaScript DOM is the evidence; the raw token never leaves the
 * process arguments and is never written to a log or exposed to QML.
 *
 * Not part of `pnpm test` (pattern `tests/*.test.ts`). Run after a WebEngine
 * build:
 *   DSH_QT_APP_BINARY=build-webengine/dsh-qt-app \
 *   pnpm exec tsx --test tests/webengine-chromium.e2e.ts
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
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
        + `<body><h1 id="marker">${MARKER}</h1>`
        + '<div id="js-executed">pending</div>'
        + '<script>document.getElementById("js-executed").textContent="ran-7419"</script>'
        + '</body></html>',
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function commandAvailable(name: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0
}

const fixtureBrowser = join(root, 'tests/fixtures/controlled-browser.sh')
const browserAvailable =
  commandAvailable('chromium') || commandAvailable('google-chrome') || commandAvailable('chromium-browser')
const xvfbAvailable = commandAvailable('Xvfb')
const browserSkip =
  skip
  || (!existsSync(fixtureBrowser) ? `missing browser fixture ${fixtureBrowser}` : false)
  || (!browserAvailable ? 'no real Chromium/Chrome on PATH for the external-browser e2e' : false)
  || (!xvfbAvailable ? 'Xvfb is required so xdg-open consults the isolated desktop entry' : false)

async function startXvfb(): Promise<{ display: string; child: ChildProcess }> {
  for (let n = 90; n < 100; n += 1) {
    const socket = `/tmp/.X11-unix/X${String(n)}`
    if (existsSync(socket)) continue
    const child = spawn('Xvfb', [`:${String(n)}`, '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], {
      stdio: 'ignore',
    })
    for (let i = 0; i < 40; i += 1) {
      await delay(50)
      if (existsSync(socket)) return { display: `:${String(n)}`, child }
      if (child.exitCode !== null) break
    }
    child.kill('SIGKILL')
  }
  throw new Error('could not start Xvfb on displays :90-:99')
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await delay(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

function browserProcessesFor(profile: string): string {
  const found = spawnSync('pgrep', ['-f', profile], { encoding: 'utf8' })
  return (found.stdout ?? '').trim()
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
  'external browser: QDesktopServices → xdg-open → real Chromium runs the page JS marker, then cleans up',
  { skip: browserSkip, timeout: 150_000 },
  async () => {
    const served = await serveMarkedPage()
    const browserRoot = mkdtempSync(join(tmpdir(), 'dsh-qt-browser-'))
    const home = join(browserRoot, 'home')
    const config = join(browserRoot, 'config')
    const data = join(browserRoot, 'data')
    const cacheDir = join(browserRoot, 'cache')
    const profile = join(browserRoot, 'profile')
    const dom = join(browserRoot, 'dom.html')
    for (const dir of [home, config, data, cacheDir]) mkdirSync(dir, { recursive: true })
    mkdirSync(join(data, 'applications'), { recursive: true })
    writeFileSync(
      join(data, 'applications', 'dsh-e2e-browser.desktop'),
      '[Desktop Entry]\n'
        + 'Type=Application\n'
        + 'Name=DSH E2E Browser\n'
        + `Exec=${fixtureBrowser} %u\n`
        + 'MimeType=x-scheme-handler/http;x-scheme-handler/https;\n'
        + 'NoDisplay=true\n',
    )
    writeFileSync(
      join(config, 'mimeapps.list'),
      '[Default Applications]\n'
        + 'x-scheme-handler/http=dsh-e2e-browser.desktop\n'
        + 'x-scheme-handler/https=dsh-e2e-browser.desktop\n',
    )
    const xvfb = await startXvfb()
    try {
      const result = await runHost('webui-browser', {
        HOME: home,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data,
        XDG_CACHE_HOME: cacheDir,
        DISPLAY: xvfb.display,
        DSH_E2E_PROFILE: profile,
        DSH_E2E_DOM: dom,
        DSH_E2E_BROWSER: process.env['DSH_E2E_BROWSER'] ?? '',
        DSH_QT_SELFTEST_REAL_BROWSER: '1',
        QT_QPA_PLATFORM: 'xcb',
      }, (host) => {
        host.register('webui.token', () => ({
          authenticatedUrl: `http://127.0.0.1:${String(served.port)}/?token=${SECRET}`,
          maskedUrl: `http://127.0.0.1:${String(served.port)}/?token=***`,
        }))
      })

      const text = result.stderr
      assert.equal(result.code, 0, `unexpected exit; stderr:\n${text}`)
      assert.match(text, /\[selftest\] webui\.token intent=browser outcome=external /u)
      assert.match(text, new RegExp(`masked=http://127\\.0\\.0\\.1:${String(served.port)}/\\?token=\\*\\*\\* `, 'u'))
      assert.ok(!text.includes(SECRET), 'the raw token reached stderr')

      // The browser is launched detached by the desktop; wait for it to commit
      // the page. This is execution evidence, not a dispatch claim.
      await waitFor(() => existsSync(dom) && readFileSync(dom, 'utf8') !== '', 90_000, 'the real browser DOM')
      const rendered = readFileSync(dom, 'utf8')
      assert.match(rendered, /<title>DSH-WEBUI-MARKER-7419<\/title>/u)
      assert.match(rendered, /<h1 id="marker">DSH-WEBUI-MARKER-7419<\/h1>/u)
      assert.match(rendered, /<div id="js-executed">ran-7419<\/div>/u, 'the page JavaScript did not run in the browser')
      assert.ok(!rendered.includes(SECRET), 'the raw token reached the rendered DOM')

      assert.ok(served.authorizedHits.length > 0, 'the real browser never requested the authenticated page')
      assert.deepEqual(served.rejectedHits, [], 'the real browser must only request the authenticated URL')

      // Cleanup: the browser exits on its own, leaving no profile process.
      await waitFor(() => browserProcessesFor(profile) === '', 30_000, 'the browser to exit')
      rmSync(browserRoot, { recursive: true, force: true })
      assert.ok(!existsSync(profile), 'the isolated browser profile was not cleaned up')
    } finally {
      xvfb.child.kill('SIGKILL')
      rmSync(browserRoot, { recursive: true, force: true })
      await closeServer(served.server)
    }
  },
)
