/**
 * Unit tests for the on-demand WebUI fallback (`src/webui/`).
 *
 * The real listeners are exercised in `tests/webui-default-off.test.ts`; here
 * the backends are fakes so the state machine, the single-instance rule, the
 * failure/retry path, the `webui.*` wire methods and — most importantly — token
 * isolation can be pinned deterministically.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { PROTOCOL_VERSION, encodeFrame } from '../src/bridge/protocol.js'
import type { Envelope, ReqFrame } from '../src/bridge/protocol.js'
import { HostBridgeService } from '../src/host/bridge-service.js'
import { HostTransport } from '../src/host/transport.js'
import {
  SHARED_SESSION_NOTICE,
  WEBUI_METHODS,
  WebuiError,
  WebuiService,
  attachWebuiToHost,
  containsRawToken,
  maskAuthenticatedUrl,
  parseAnnouncement,
} from '../src/webui/index.js'
import type {
  WebuiBackend,
  WebuiBackendHandle,
  WebuiBackendStartOptions,
  WebuiFailureReason,
  WebuiMode,
  WebuiReady,
  WebuiStatus,
} from '../src/webui/index.js'

const TOKEN = 'secrettokenvalue0123456789'
const AUTHENTICATED_URL = `http://127.0.0.1:41234/?token=${TOKEN}`

interface FakeHandle extends WebuiBackendHandle {
  readonly isClosed: () => boolean
  emitExit(reason: WebuiFailureReason): void
}

interface FakeBackendOptions {
  readonly mode: WebuiMode
  readonly sharedSession?: boolean
  readonly reusedCredentials?: boolean
  readonly authenticatedUrl?: string
  /** Fail `start()` with this reason. */
  readonly failStart?: WebuiFailureReason
  /** Fail `ready()` with this reason. */
  readonly failReady?: WebuiFailureReason
}

interface FakeBackend extends WebuiBackend {
  readonly starts: WebuiBackendStartOptions[]
  readonly handles: FakeHandle[]
}

class FakeFailure extends WebuiError {
  constructor(reason: WebuiFailureReason) {
    super(reason, `fake failure: ${reason}`)
  }
}

function fakeBackend(options: FakeBackendOptions): FakeBackend {
  const starts: WebuiBackendStartOptions[] = []
  const handles: FakeHandle[] = []
  const authenticatedUrl = options.authenticatedUrl ?? AUTHENTICATED_URL
  return {
    mode: options.mode,
    starts,
    handles,
    async start(startOptions: WebuiBackendStartOptions): Promise<WebuiBackendHandle> {
      starts.push(startOptions)
      if (options.failStart !== undefined) throw new FakeFailure(options.failStart)
      let closed = false
      const exitListeners = new Set<(reason: WebuiFailureReason) => void>()
      const ready: WebuiReady = { origin: new URL(authenticatedUrl).origin, authenticatedUrl }
      const handle: FakeHandle = {
        mode: options.mode,
        sharedSession: options.sharedSession ?? options.mode === 'in-process',
        reusedCredentials: options.reusedCredentials ?? false,
        ready: async () => {
          if (options.failReady !== undefined) throw new FakeFailure(options.failReady)
          return ready
        },
        close: async () => {
          closed = true
        },
        onExit: (listener) => {
          exitListeners.add(listener)
          return () => exitListeners.delete(listener)
        },
        isClosed: () => closed,
        emitExit: (reason) => {
          for (const listener of exitListeners) listener(reason)
        },
      }
      handles.push(handle)
      return handle
    },
  }
}

interface Logs {
  readonly statuses: WebuiStatus[]
  readonly lines: string[]
}

function serviceWith(backends: { inProcess?: WebuiBackend; child?: WebuiBackend }, logs: Logs): WebuiService {
  const service = new WebuiService(new Context(), {
    backoffMs: [0, 0],
    readyTimeoutMs: 1_000,
    openTimeoutMs: 3_000,
    logger: {
      info: (message: string) => logs.lines.push(message),
      warn: (message: string) => logs.lines.push(message),
    },
    backends: {
      ...(backends.inProcess === undefined ? {} : { 'in-process': backends.inProcess }),
      ...(backends.child === undefined ? {} : { child: backends.child }),
    },
  })
  service.onState((status) => logs.statuses.push(status))
  return service
}

function newLogs(): Logs {
  return { statuses: [], lines: [] }
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function stop(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

test('mounts idle: no listener, no attempt, no token', () => {
  const logs = newLogs()
  const inProcess = fakeBackend({ mode: 'in-process' })
  const child = fakeBackend({ mode: 'child' })
  const service = serviceWith({ inProcess, child }, logs)

  assert.equal(service.status.state, 'Idle')
  assert.equal(service.status.mode, null)
  assert.equal(service.status.maskedUrl, null)
  assert.equal(service.status.sharedSession, false)
  assert.equal(service.takeAuthenticatedUrl(), null)
  // Nothing was started, so a plugin that never receives `webui.open` cannot
  // bind a port.
  assert.equal(inProcess.starts.length, 0)
  assert.equal(child.starts.length, 0)
  assert.equal(logs.statuses.length, 0)
})

test('open walks Idle → Resolving → Spawning → WaitingReady → Ready', async () => {
  const logs = newLogs()
  const service = serviceWith({ inProcess: fakeBackend({ mode: 'in-process' }) }, logs)

  const result = await service.open({ slotId: 'panel:weather' })

  assert.deepEqual(
    logs.statuses.map((status) => status.state),
    ['Resolving', 'Spawning', 'WaitingReady', 'Ready'],
  )
  assert.equal(result.mode, 'in-process')
  assert.equal(result.sharedSession, true)
  assert.equal(result.reused, false)
  assert.equal(result.notice, null)
  assert.equal(result.maskedUrl, 'http://127.0.0.1:41234/?token=***')
  assert.equal(service.status.slotId, 'panel:weather')
  assert.equal(service.status.attempts, 1)
})

test('the token leaves the process exactly once, through takeAuthenticatedUrl', async () => {
  const logs = newLogs()
  const service = serviceWith({ inProcess: fakeBackend({ mode: 'in-process' }) }, logs)

  const result = await service.open()

  assert.equal(service.takeAuthenticatedUrl(), AUTHENTICATED_URL)
  assert.equal(service.takeAuthenticatedUrl(), null)
  // Nothing the UI can read carries the token.
  assert.equal(containsRawToken(JSON.stringify(result)), false)
  assert.equal(containsRawToken(JSON.stringify(logs.statuses)), false)
  assert.equal(containsRawToken(logs.lines.join('\n')), false)
  assert.equal(service.status.maskedUrl, 'http://127.0.0.1:41234/?token=***')
})

test('repeated open reuses the single listener instead of binding a second one', async () => {
  const logs = newLogs()
  const inProcess = fakeBackend({ mode: 'in-process' })
  const service = serviceWith({ inProcess }, logs)

  const [first, second] = await Promise.all([service.open(), service.open()])
  const third = await service.open()

  assert.equal(inProcess.starts.length, 1, 'concurrent opens must join the in-flight attempt')
  assert.equal(first.reused, false)
  assert.equal(second.reused, false)
  assert.equal(third.reused, true)
  assert.equal(third.maskedUrl, first.maskedUrl)
  assert.equal(service.takeAuthenticatedUrl(), AUTHENTICATED_URL)
  assert.equal(service.takeAuthenticatedUrl(), null, 'a reuse must not mint a second token')
})

test('close releases the listener and returns to Idle', async () => {
  const logs = newLogs()
  const inProcess = fakeBackend({ mode: 'in-process' })
  const service = serviceWith({ inProcess }, logs)

  await service.open()
  await service.close()

  assert.equal(inProcess.handles[0]?.isClosed(), true)
  assert.equal(service.status.state, 'Idle')
  assert.equal(service.status.maskedUrl, null)
  assert.equal(service.takeAuthenticatedUrl(), null)
  // Reopening after a close starts a fresh attempt.
  await service.open()
  assert.equal(inProcess.starts.length, 2)
})

test('auto mode falls back to a child process after two in-process failures', async () => {
  const logs = newLogs()
  const inProcess = fakeBackend({ mode: 'in-process', failReady: 'timeout' })
  const child = fakeBackend({ mode: 'child' })
  const service = serviceWith({ inProcess, child }, logs)

  const result = await service.open()

  assert.equal(inProcess.starts.length, 2)
  assert.equal(child.starts.length, 1)
  assert.equal(result.mode, 'child')
  assert.equal(result.sharedSession, false)
  assert.equal(result.notice, SHARED_SESSION_NOTICE, 'a second process must warn that the session is not shared')
  assert.equal(logs.statuses.at(-1)?.notice, SHARED_SESSION_NOTICE)
})

test('open fails with Failed{timeout} when every attempt times out', async () => {
  const logs = newLogs()
  const inProcess = fakeBackend({ mode: 'in-process', failReady: 'timeout' })
  const child = fakeBackend({ mode: 'child', failReady: 'timeout' })
  const service = serviceWith({ inProcess, child }, logs)

  await assert.rejects(service.open(), (error: unknown) => {
    assert.equal((error as { reason?: string }).reason, 'timeout')
    return true
  })

  assert.equal(service.status.state, 'Failed')
  assert.equal(service.status.reason, 'timeout')
  assert.equal(service.status.maskedUrl, null)
  assert.equal(service.status.attempts, 3)
  assert.equal(service.takeAuthenticatedUrl(), null)
})

test('a dead child flips the state to Failed without touching unrelated listeners', async () => {
  const logs = newLogs()
  const inProcess = fakeBackend({ mode: 'in-process', failStart: 'mount-failed' })
  const child = fakeBackend({ mode: 'child' })
  const service = serviceWith({ inProcess, child }, logs)

  // A stand-in "external service" that must survive the whole lifecycle.
  const external = createServer((_request, response) => response.end('external'))
  const externalPort = await listen(external)

  await service.open()
  child.handles[0]?.emitExit('crashed')

  assert.equal(service.status.state, 'Failed')
  assert.equal(service.status.reason, 'crashed')
  assert.equal(service.status.maskedUrl, null)
  assert.equal(service.takeAuthenticatedUrl(), null)
  assert.equal(child.handles[0]?.isClosed(), false, 'an already-dead child needs no signal')

  // The unrelated listener is untouched and still answering.
  assert.equal(external.listening, true)
  const response = await fetch(`http://127.0.0.1:${String(externalPort)}/`)
  assert.equal(await response.text(), 'external')
  await stop(external)
})

test('probe recognises the official auth challenge and the /api fence', async () => {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api')) {
      response.statusCode = 403
      response.end('forbidden')
      return
    }
    response.statusCode = 401
    response.end('dsh web authentication required; reopen the URL printed by dsh web.')
  })
  const port = await listen(server)
  const logs = newLogs()
  const service = serviceWith(
    {
      inProcess: fakeBackend({
        mode: 'in-process',
        authenticatedUrl: `http://127.0.0.1:${String(port)}/?token=${TOKEN}`,
      }),
    },
    logs,
  )

  await service.open()
  const probe = await service.probe()

  assert.deepEqual(probe, { state: 'Ready', reachable: true, authenticated: false, reason: null })
  await service.close()
  await stop(server)
})

test('probe reports an unreachable listener as refused', async () => {
  const logs = newLogs()
  const service = serviceWith({ inProcess: fakeBackend({ mode: 'in-process' }) }, logs)

  await service.open()
  const probe = await service.probe()

  // Nothing is bound on the fake origin, so the socket is refused.
  assert.equal(probe.reachable, false)
  assert.equal(probe.reason, 'refused')
  assert.equal(probe.authenticated, null)
  await service.close()
})

interface Harness {
  readonly host: HostBridgeService
  readonly frames: Envelope[]
  sendQt(frame: Envelope): void
}

function harness(): Harness {
  const host = new HostBridgeService(new Context(), { autoLaunch: false, handshakeTimeoutMs: 2_000 })
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const frames: Envelope[] = []
  let pending = ''
  fromHost.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline < 0) return
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line.trim() !== '') frames.push(JSON.parse(line) as Envelope)
    }
  })
  host.attach({ transport: new HostTransport({ input: toHost, output: fromHost }) })
  const sendQt = (frame: Envelope): void => {
    const encoded = encodeFrame(frame)
    if (!encoded.ok) throw new Error(encoded.error.message)
    toHost.write(`${encoded.line}\n`)
  }
  sendQt({
    v: PROTOCOL_VERSION,
    kind: 'hello',
    role: 'qt',
    epoch: 'epoch-webui',
    app: 'dsh-qt-app',
    qt: '6.8.2',
    caps: ['markdown.parse'],
  })
  return { host, frames, sendQt }
}

function replyTo(frames: Envelope[], id: string): Extract<Envelope, { kind: 'res' }> | undefined {
  return frames.find((frame): frame is Extract<Envelope, { kind: 'res' }> => frame.kind === 'res' && frame.id === id)
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('webui.* over the wire: open/close carry no token, webui.token does', async () => {
  const logs = newLogs()
  const service = serviceWith({ inProcess: fakeBackend({ mode: 'in-process' }) }, logs)
  const h = harness()
  await waitFor(() => h.host.state === 'connected')
  const detach = attachWebuiToHost(h.host, service)

  assert.deepEqual([...WEBUI_METHODS], ['webui.open', 'webui.close', 'webui.probe', 'webui.token'])

  const request = (id: string, method: string, params?: unknown): ReqFrame => ({
    v: PROTOCOL_VERSION,
    kind: 'req',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  })

  h.sendQt(request('q1', 'webui.open', { slotId: 'panel:x' }))
  await waitFor(() => replyTo(h.frames, 'q1') !== undefined)
  const openReply = replyTo(h.frames, 'q1')
  assert.ok(openReply?.ok === true)
  assert.equal(containsRawToken(JSON.stringify(openReply)), false)
  assert.match(JSON.stringify(openReply), /token=\*\*\*/)

  h.sendQt(request('q2', 'webui.token'))
  await waitFor(() => replyTo(h.frames, 'q2') !== undefined)
  const tokenReply = replyTo(h.frames, 'q2')
  if (tokenReply === undefined || tokenReply.ok !== true) assert.fail('webui.token did not reply ok')
  assert.equal((tokenReply.result as { authenticatedUrl: string }).authenticatedUrl, AUTHENTICATED_URL)

  h.sendQt(request('q3', 'webui.token'))
  await waitFor(() => replyTo(h.frames, 'q3') !== undefined)
  const secondTokenReply = replyTo(h.frames, 'q3')
  if (secondTokenReply === undefined || secondTokenReply.ok !== true) assert.fail('webui.token did not reply ok')
  assert.equal((secondTokenReply.result as { authenticatedUrl: string | null }).authenticatedUrl, null)

  h.sendQt(request('q4', 'webui.close'))
  await waitFor(() => replyTo(h.frames, 'q4') !== undefined)
  const closeReply = replyTo(h.frames, 'q4')
  if (closeReply === undefined || closeReply.ok !== true) assert.fail('webui.close did not reply ok')
  assert.deepEqual(closeReply.result, { closed: true })

  // The state stream reached the UI, and no frame leaked a token.
  const states = h.frames.filter(
    (frame): frame is Extract<Envelope, { kind: 'evt' }> => frame.kind === 'evt' && frame.name === 'webui.state',
  )
  assert.ok(states.length >= 3)
  // Every frame except the explicit `webui.token` reply must be token-free.
  const withoutTokenReply = h.frames.filter((frame) => !(frame.kind === 'res' && frame.id === 'q2'))
  assert.equal(containsRawToken(JSON.stringify(withoutTokenReply)), false)

  detach()
  assert.equal(h.host.unregister('webui.open'), false, 'detach unregisters every method')
  h.host.dispose()
})

test('maskAuthenticatedUrl masks the token and keeps other query parameters', () => {
  assert.equal(maskAuthenticatedUrl('http://127.0.0.1:1/?token=abc'), 'http://127.0.0.1:1/?token=***')
  assert.equal(
    maskAuthenticatedUrl('http://127.0.0.1:1/?a=1&token=abc#frag'),
    'http://127.0.0.1:1/?a=1&token=***#frag',
  )
  assert.equal(maskAuthenticatedUrl('http://127.0.0.1:1/'), 'http://127.0.0.1:1/')
})

test('parseAnnouncement reads only the official ready line', () => {
  assert.equal(parseAnnouncement('dsh web: http://127.0.0.1:3080/?token=x'), 'http://127.0.0.1:3080/?token=x')
  assert.equal(parseAnnouncement('dsh web: opening the default browser; pass --no-open to disable'), null)
  assert.equal(parseAnnouncement('Server listening on http://127.0.0.1:3080'), null)
  assert.equal(parseAnnouncement(''), null)
})
