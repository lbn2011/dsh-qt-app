/**
 * Real two-process end-to-end test for protocol v1.
 *
 * This is the test that proves the Phase 3 host actually talks to the Qt binary
 * instead of only to a fake pipe: a real `dsh-qt-app` child is spawned with
 * `DSH_QT_HOST_SELFTEST=1`, performs the v1 handshake over stdio, sends
 * `host.ping` once it is connected, and exits 0 after the reply.
 *
 * It is named `*.e2e.ts` on purpose: `pnpm test` runs `tests/*.test.ts` and must
 * keep passing on machines where the binary was never built. Run it explicitly
 * after `cmake --build build`:
 *
 *     pnpm exec tsx --test tests/host-e2e.e2e.ts
 *
 * Windows note: the binary is `build/dsh-qt-app.exe`; `DSH_QT_APP_BINARY`
 * overrides the path entirely.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { HostBridgeService } from '../src/host/bridge-service.js'
import { HostTransport } from '../src/host/transport.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultBinary = join(root, 'build', process.platform === 'win32' ? 'dsh-qt-app.exe' : 'dsh-qt-app')
const binary = process.env.DSH_QT_APP_BINARY ?? defaultBinary

test(
  'real Qt host: v1 handshake, host.ping round trip, clean exit',
  { skip: existsSync(binary) ? false : `no Qt binary at ${binary}; run cmake --build build first`, timeout: 20_000 },
  async () => {
    const child = spawn(binary, [], {
      cwd: root,
      env: {
        ...process.env,
        DSH_QT_HOST_SELFTEST: '1',
        QT_QPA_PLATFORM: process.platform === 'win32' ? 'windows' : 'offscreen',
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

    const transport = new HostTransport({ input: child.stdout, output: child.stdin })
    const host = new HostBridgeService(new Context(), {
      autoLaunch: false,
      handshakeTimeoutMs: 10_000,
      requestTimeoutMs: 10_000,
    })

    const states: string[] = []
    host.onStateChange((state) => states.push(state))
    let pings = 0
    host.register('ping', () => {
      pings += 1
      return { pong: true, host: 'node-e2e' }
    })
    // The Qt selftest walks three real routes of the shipped bridge in order:
    // handshake, renderer and theme service.
    let markdownParses = 0
    host.register('markdown.parse', () => {
      markdownParses += 1
      return { document: { type: 'document', children: [] } }
    })
    let scales = 0
    host.register('theme.scale', () => {
      scales += 1
      return { scale: 1.25 }
    })

    host.attach({ transport, child })

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        const timer = setTimeout(() => {
          child.kill()
          rejectExit(new Error(`the Qt host did not exit in 15 s; stderr:\n${stderr.join('\n')}`))
        }, 15_000)
        child.once('error', (error) => {
          clearTimeout(timer)
          rejectExit(error)
        })
        child.once('exit', (code, signal) => {
          clearTimeout(timer)
          resolveExit({ code, signal })
        })
      },
    )

    assert.deepEqual(
      stderr.filter((line) => line.includes('[selftest]')),
      [
        '[selftest] state=connecting',
        '[selftest] state=connected',
        '[selftest] ping=ok error=',
        '[selftest] pong=1',
        '[selftest] markdown.parse=ok error=',
        '[selftest] theme.scale=ok error=',
      ],
      `selftest stderr was:\n${stderr.join('\n')}`,
    )
    assert.deepEqual(states.slice(0, 2), ['connecting', 'connected'])
    assert.equal(pings, 1, 'the Qt side performs exactly one host.ping')
    assert.equal(markdownParses, 1, 'the renderer route is reachable from the real binary')
    assert.equal(scales, 1, 'the theme route is reachable from the real binary')
    assert.equal(exit.code, 0)
    assert.equal(exit.signal, null)
    assert.equal(host.state, 'disconnected')
    assert.ok(host.stats.handled >= 1)
    assert.equal(host.stats.protocolErrors, 0)
    host.dispose()
  },
)
/** Sentinel that must never leave the native token consumer. */
const WEBUI_SENTINEL = 'sk-e2e-THIS-TOKEN-MUST-NOT-REACH-QML-4f19'

interface WebuiRun {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
  readonly host: HostBridgeService
  readonly requests: readonly string[]
}

/**
 * Drive the real binary through its `webui.token` path with a real Node host.
 *
 * `reply` decides what the host answers: the success shape, a protocol error,
 * a duplicate success, or nothing at all (timeout). The Qt side is the shipped
 * binary — only the host script is test code, which is what the acceptance
 * criterion asks for (a sentinel through the actual C++ response path).
 */
async function runWebuiCase(
  mode: string,
  reply: 'ok' | 'error' | 'duplicate' | 'none',
  options: { closeDelayMs?: number } = {},
): Promise<WebuiRun> {
  const child = spawn(binary, [], {
    cwd: root,
    env: {
      ...process.env,
      DSH_QT_HOST_SELFTEST: mode,
      DSH_QT_WEBUI_SENTINEL: WEBUI_SENTINEL,
      ...(reply === 'duplicate' ? { DSH_QT_WEBUI_LINGER_MS: '150' } : {}),
      QT_QPA_PLATFORM: process.platform === 'win32' ? 'windows' : 'offscreen',
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

  const transport = new HostTransport({ input: child.stdout, output: child.stdin })
  // Capture the request id before the bridge service answers it: the duplicate
  // case replays a second `res` for that exact id, which the Qt side must drop.
  let tokenRequestId = ''
  transport.onFrame((frame) => {
    if (frame.kind === 'req' && frame.method === 'webui.token')
      tokenRequestId = frame.id
  })
  const host = new HostBridgeService(new Context(), {
    autoLaunch: false,
    handshakeTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
  })
  host.onStateChange(() => {})
  const requests: string[] = []
  const authenticatedUrl = `https://127.0.0.1:43117/?token=${WEBUI_SENTINEL}`
  const maskedUrl = 'https://127.0.0.1:43117/?token=***'
  let tokens = 0

  host.register('webui.token', async () => {
    tokens += 1
    requests.push('webui.token')
    if (reply === 'none')
      return new Promise(() => {})
    if (reply === 'error')
      throw Object.assign(new Error('the WebUI backend failed'), { code: 'unavailable' })
    if (options.closeDelayMs !== undefined)
      await new Promise((resolve) => setTimeout(resolve, options.closeDelayMs))
    if (reply === 'duplicate') {
      const id = tokenRequestId
      setTimeout(() => {
        transport.send({ v: 1, kind: 'res', id, ok: true, result: { authenticatedUrl, maskedUrl } })
      }, 30)
    }
    return { authenticatedUrl, maskedUrl, sharedSession: true }
  })
  host.register('webui.close', () => {
    requests.push('webui.close')
    return { state: 'Idle' }
  })
  host.attach({ transport, child })

  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill()
        rejectExit(new Error(`the Qt host did not exit; stderr:\n${stderr.join('\n')}`))
      }, 15_000)
      child.once('exit', (exitCode, exitSignal) => {
        clearTimeout(timer)
        resolveExit({ code: exitCode, signal: exitSignal })
      })
    },
  )

  return { exitCode: code, signal, stderr: stderr.join('\n'), host, requests }
}

const tokenLine = (run: WebuiRun): string =>
  run.stderr.split('\n').find((line) => line.startsWith('[selftest] webui.token ')) ?? ''

test(
  'real Qt host: webui.token reaches the native consumer and never the QML signal',
  { skip: existsSync(binary) ? false : `no Qt binary at ${binary}; run cmake --build build first`, timeout: 25_000 },
  async () => {
    const run = await runWebuiCase('webui', 'ok')
    assert.equal(run.exitCode, 0)
    // This build is configured with DSH_QT_WEBENGINE=OFF, so the embed intent
    // can only prove the fallback hand-off; it is never reported as a success.
    assert.equal(tokenLine(run), `[selftest] webui.token intent=embed outcome=external masked=${'https://127.0.0.1:43117/?token=***'} error=`)
    assert.equal(run.stderr.includes(WEBUI_SENTINEL), false, 'the sentinel must not reach stderr')
    assert.equal(run.stderr.includes('LEAK'), false, 'no generic signal may carry the authenticated URL')
    assert.equal(run.requests.filter((name) => name === 'webui.token').length, 1)
    run.host.dispose()
  },
)

test(
  'real Qt host: a closed WebUI ignores the late token and never reopens',
  { skip: existsSync(binary) ? false : `no Qt binary at ${binary}; run cmake --build build first`, timeout: 25_000 },
  async () => {
    // The host answers 300 ms late; the Qt side has already closed the panel.
    const run = await runWebuiCase('webui-close', 'ok', { closeDelayMs: 300 })
    assert.equal(run.exitCode, 0)
    // The close clears the id binding, so the late reply has no intent left.
    assert.match(tokenLine(run), /intent= outcome=cancelled /)
    assert.equal(run.stderr.includes(WEBUI_SENTINEL), false)
    assert.ok(run.requests.includes('webui.close'), 'the close must be sent to the host')
    run.host.dispose()
  },
)

test(
  'real Qt host: a failed webui.token reports only the masked outcome',
  { skip: existsSync(binary) ? false : `no Qt binary at ${binary}; run cmake --build build first`, timeout: 25_000 },
  async () => {
    const run = await runWebuiCase('webui-fail', 'error')
    assert.equal(run.exitCode, 0)
    assert.match(tokenLine(run), /outcome=failed /)
    assert.match(tokenLine(run), /error=unavailable/)
    assert.equal(run.stderr.includes(WEBUI_SENTINEL), false)
    assert.equal(run.stderr.includes('LEAK'), false)
    run.host.dispose()
  },
)

test(
  'real Qt host: a duplicated token reply is resolved exactly once',
  { skip: existsSync(binary) ? false : `no Qt binary at ${binary}; run cmake --build build first`, timeout: 25_000 },
  async () => {
    const run = await runWebuiCase('webui', 'duplicate')
    assert.equal(run.exitCode, 0)
    const resolved = run.stderr.split('\n').filter((line) => line.startsWith('[selftest] webui.token '))
    assert.equal(resolved.length, 1, `expected one resolution, got:\n${run.stderr}`)
    assert.equal(run.stderr.includes(WEBUI_SENTINEL), false)
    run.host.dispose()
  },
)

test(
  'real Qt host: a timed-out token request fails closed without leaking the URL',
  { skip: existsSync(binary) ? false : `no Qt binary at ${binary}; run cmake --build build first`, timeout: 25_000 },
  async () => {
    const run = await runWebuiCase('webui', 'none')
    assert.equal(run.exitCode, 0)
    assert.match(tokenLine(run), /outcome=failed /)
    assert.match(tokenLine(run), /error=timeout/)
    assert.equal(run.stderr.includes(WEBUI_SENTINEL), false)
    run.host.dispose()
  },
)

test(
  'real Qt host: the shipped QML entry loads with every wired surface',
  { skip: existsSync(binary) ? false : `no Qt binary at ${binary}; run cmake --build build first`, timeout: 20_000 },
  async () => {
    // No Node host on purpose: this proves the window itself compiles —
    // ToolCallModel, SettingsBridge, PluginsBridge, WebFallbackPanel and the
    // eventReceived Connections — while the transport stays in `connecting`.
    const child = spawn(binary, [], {
      cwd: root,
      env: {
        ...process.env,
        QT_QPA_PLATFORM: process.platform === 'win32' ? 'windows' : 'offscreen',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    assert.ok(child.stderr !== null && child.stdout !== null)
    const stderr: string[] = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim() !== '') stderr.push(line)
    })
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    await new Promise((resolve) => setTimeout(resolve, 3000))
    assert.equal(child.exitCode, null, `the window must stay up; stderr:\n${stderr.join('\n')}`)
    child.kill()
    await exited
    const failures = stderr.filter(
      (line) => /is not a type|Cannot assign|unavailable|TypeError|ReferenceError/.test(line),
    )
    assert.deepEqual(failures, [], `QML load errors:\n${stderr.join('\n')}`)
    assert.equal(/state=connecting/.test(stderr.join('\n')), false, 'no selftest output without the flag')
  },
)
