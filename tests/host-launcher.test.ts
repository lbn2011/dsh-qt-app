/**
 * Unit tests for the host end of protocol v1 (`src/host/`).
 *
 * A real Qt process is deliberately *not* spawned here: the service is attached
 * to two `PassThrough` streams and fed encoded frames, which pins the protocol
 * bookkeeping (handshake gating, id uniqueness, timeouts, late replies, EOF,
 * disposal) independently of the GUI binary. The real child process is covered
 * by `tests/host-e2e.e2e.ts`, which is built and run separately.
 */
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { HostBridgeError, HostBridgeService } from '../src/host/bridge-service.js'
import { HostTransport } from '../src/host/transport.js'
import { PROTOCOL_VERSION, encodeFrame } from '../src/bridge/protocol.js'
import type { Envelope } from '../src/bridge/protocol.js'
import { QML_BRIDGE_METHODS } from '../src/bridge/index.js'
import { apply } from '../src/index.js'
import type { NapiBridge } from '../src/qt-bridge/napi-loader.js'
import type { QtPluginConfig } from '../src/index.js'

const fakeBridge: NapiBridge = {
  version: 'test-1.0.0',
  renderMarkdown: (text: string) => `<p>${text}</p>`,
  highlightCode: (code: string, language?: string) =>
    `<code data-lang="${language ?? 'none'}">${code}</code>`,
}

interface Harness {
  ctx: Context
  host: HostBridgeService
  toHost: PassThrough
  fromHost: PassThrough
  frames: Envelope[]
  sent: Envelope[]
  states: string[]
  sendQt(frame: Envelope): void
  rawQt(text: string): void
}

function hostOf(ctx: Context): HostBridgeService {
  return (ctx as unknown as { hostBridge: HostBridgeService }).hostBridge
}

/**
 * Build a service attached to an in-memory pipe pair.
 *
 * `toHost` carries Qt → host frames; `fromHost` collects host → Qt frames.
 */
function harness(options: { config?: QtPluginConfig; attachService?: boolean } = {}): Harness {
  const ctx = new Context()
  let host: HostBridgeService
  if (options.attachService === true) {
    apply(ctx, { autoStartEventLoop: false, autoLaunch: false, bridge: fakeBridge, ...options.config })
    host = hostOf(ctx)
  } else {
    host = new HostBridgeService(ctx, { autoLaunch: false, handshakeTimeoutMs: 2_000 })
  }

  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const frames: Envelope[] = []
  const sent: Envelope[] = []
  const states: string[] = []
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
  host.onStateChange((state) => states.push(state))

  return {
    ctx,
    host,
    toHost,
    fromHost,
    frames,
    sent,
    states,
    sendQt(frame) {
      const encoded = encodeFrame(frame)
      if (!encoded.ok) throw new Error(encoded.error.message)
      sent.push(frame)
      toHost.write(encoded.line + '\n')
    },
    rawQt(text) {
      toHost.write(text)
    },
  }
}

const hello: Envelope = {
  v: PROTOCOL_VERSION,
  kind: 'hello',
  role: 'qt',
  epoch: 'epoch-1',
  app: 'dsh-qt-app',
  qt: '6.8.2',
  caps: ['markdown.parse'],
}

function req(id: string, method: string, params?: unknown): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: 'req',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  }
}

function resOk(id: string, result?: unknown): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: 'res',
    id,
    ok: true,
    ...(result === undefined ? {} : { result }),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function framesOf<K extends Envelope['kind']>(
  frames: Envelope[],
  kind: K,
): Array<Extract<Envelope, { kind: K }>> {
  return frames.filter((frame): frame is Extract<Envelope, { kind: K }> => frame.kind === kind)
}

function replyFor(frames: Envelope[], id: string): Extract<Envelope, { kind: 'res' }> | undefined {
  for (const frame of frames) {
    if (frame.kind === 'res' && frame.id === id) return frame
  }
  return undefined
}

test('nothing is connected before the handshake; hello.ack completes it', async () => {
  const h = harness()
  h.host.attach({ transport: new HostTransport({ input: h.toHost, output: h.fromHost }) })
  assert.equal(h.host.state, 'connecting')
  assert.equal(h.host.connected, false)
  assert.deepEqual(h.states, ['connecting'])

  // Requests before the ack are rejected instead of queued forever.
  await assert.rejects(h.host.invoke('ping'), /not connected/)

  h.sendQt(hello)
  await waitFor(() => h.host.state === 'connected')

  const acks = framesOf(h.frames, 'hello.ack')
  assert.equal(acks.length, 1)
  const ack = acks[0]
  assert.ok(ack !== undefined)
  assert.equal(ack.epoch, 'epoch-1')
  assert.ok(ack.caps.includes('markdown.render'))
  assert.equal(ack.limits.maxFrame, 4 * 1024 * 1024)
  assert.deepEqual(h.states, ['connecting', 'connected'])
  h.host.dispose()
})

test('a quiet Qt host fails the handshake with timeout', async () => {
  const ctx = new Context()
  const host = new HostBridgeService(ctx, { autoLaunch: false, handshakeTimeoutMs: 20 })
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  host.attach({ transport: new HostTransport({ input: toHost, output: fromHost }) })
  await waitFor(() => host.state === 'disconnected')
  assert.match(host.lastError ?? '', /handshake/)
  assert.equal(host.connected, false)
  host.dispose()
})

test('a timed-out request rejects; its late reply is dropped by id', async () => {
  const h = harness()
  h.host.attach({ transport: new HostTransport({ input: h.toHost, output: h.fromHost }) })
  h.sendQt(hello)
  await waitFor(() => h.host.state === 'connected')

  await assert.rejects(h.host.invoke('ping', undefined, { timeoutMs: 20 }), /no reply/)
  await waitFor(() => framesOf(h.frames, 'req').length === 1)
  const request = framesOf(h.frames, 'req').at(-1)
  assert.ok(request !== undefined && request.kind === 'req')

  h.sendQt(resOk(request.id, { pong: true }))
  await waitFor(() => h.host.stats.lateReplies === 1)
  assert.equal(h.host.stats.pending, 0)
  assert.equal(h.host.stats.handled, 0)
  h.host.dispose()
})

test('the host answers the 11 legacy methods over v1', async () => {
  const h = harness({
    attachService: true,
    config: { composer: (text: string) => ({ accepted: true, text }) },
  })
  h.host.attach({ transport: new HostTransport({ input: h.toHost, output: h.fromHost }) })
  h.sendQt(hello)
  await waitFor(() => h.host.state === 'connected')

  const params: Record<string, Record<string, unknown>> = {
    'markdown.parse': { text: '# title' },
    'markdown.render': { text: '# title' },
    'code.highlight': { code: 'let a = 1', language: 'ts' },
    'theme.apply': { mode: 'dark' },
    'theme.scale': { scale: 1.25 },
    'settings.get': { name: 'theme' },
    'settings.set': { name: 'theme', value: 'dark' },
    'settings.save': {},
    'settings.all': {},
    'composer.submit': { text: 'hello' },
  }

  let index = 0
  for (const method of QML_BRIDGE_METHODS) {
    const id = `qt-${++index}`
    h.sendQt(req(id, method, params[method] ?? {}))
  }
  await waitFor(() => framesOf(h.frames, 'res').length === QML_BRIDGE_METHODS.length)

  const byMethod = new Map<string, Extract<Envelope, { kind: 'res' }>>()
  const requests = h.sent.filter((frame) => frame.kind === 'req')
  for (const reply of framesOf(h.frames, 'res')) {
    const request = requests.find((frame) => frame.id === reply.id)
    assert.ok(request !== undefined)
    byMethod.set(request.method, reply)
  }
  assert.equal(byMethod.size, QML_BRIDGE_METHODS.length)

  const ping = byMethod.get('ping')
  assert.ok(ping !== undefined && ping.ok)
  assert.equal((ping.result as { pong: boolean }).pong, true)

  const parsed = byMethod.get('markdown.parse')
  assert.ok(parsed !== undefined && parsed.ok)
  assert.ok((parsed.result as { document: unknown }).document !== undefined)

  const rendered = byMethod.get('markdown.render')
  assert.ok(rendered !== undefined && rendered.ok)
  assert.match((rendered.result as { html: string }).html, /<p># title/)

  const highlighted = byMethod.get('code.highlight')
  assert.ok(highlighted !== undefined && highlighted.ok)
  assert.match((highlighted.result as { markup: string }).markup, /<font color="#[0-9a-f]+">let<\/font>/)

  const submitted = byMethod.get('composer.submit')
  assert.ok(submitted !== undefined && submitted.ok)
  assert.equal((submitted.result as { accepted: boolean }).accepted, true)

  // The services Phase 3 adds (settings, theme) are honest about not existing
  // yet instead of inventing values.
  for (const method of ['settings.get', 'settings.set', 'settings.save', 'settings.all', 'theme.apply', 'theme.scale']) {
    const reply = byMethod.get(method)
    assert.ok(reply !== undefined, `missing reply for ${method}`)
    assert.equal(reply.ok, false)
    assert.ok(!reply.ok)
    assert.equal(reply.error.code, 'unavailable')
  }
  h.host.dispose()
})

test('duplicate and unknown request ids get exactly one coded reply', async () => {
  const h = harness()
  h.host.attach({ transport: new HostTransport({ input: h.toHost, output: h.fromHost }) })
  h.sendQt(hello)
  await waitFor(() => h.host.state === 'connected')
  h.host.register('ping', () => ({ pong: true }))

  h.sendQt(req('qt-1', 'ping'))
  h.sendQt(req('qt-1', 'ping'))
  h.sendQt(req('qt-2', 'nope'))
  await waitFor(() => framesOf(h.frames, 'res').length === 3)
  await waitFor(() => h.host.stats.handled === 1)

  const replies = framesOf(h.frames, 'res')
  assert.equal(replies.length, 3, 'one reply per request, the duplicate included')
  assert.equal(replies.filter((reply) => reply.ok).length, 1)
  const duplicate = replies.find((reply) => !reply.ok && reply.error.code === 'duplicate-id')
  const unknown = replies.find((reply) => !reply.ok && reply.error.code === 'unknown-method')
  assert.ok(duplicate !== undefined)
  assert.ok(unknown !== undefined)
  assert.equal(h.host.stats.duplicateIds, 1)
  assert.equal(h.host.stats.handled, 1)
  h.host.dispose()
})

test('events are delivered once per epoch+seq; unknown kinds are ignored', async () => {
  const h = harness()
  h.host.attach({ transport: new HostTransport({ input: h.toHost, output: h.fromHost }) })
  h.sendQt(hello)
  await waitFor(() => h.host.state === 'connected')

  const seen: Array<{ name: string; seq: number }> = []
  h.host.onEvent((event) => seen.push({ name: event.name, seq: event.seq }))
  const evt: Envelope = {
    v: PROTOCOL_VERSION,
    kind: 'evt',
    seq: 0,
    epoch: 'epoch-1',
    name: 'tool/call',
    payload: { callId: 'c1' },
  }
  h.sendQt(evt)
  h.sendQt(evt)
  h.rawQt(`${JSON.stringify({ v: PROTOCOL_VERSION, kind: 'mystery' })}\n`)
  await waitFor(() => h.host.stats.duplicateEvents === 1)

  // The unknown `kind` frame is dropped inside the decoder (reported as
  // `ignored`), so it never reaches the service: the session stays connected.
  assert.deepEqual(seen, [{ name: 'tool/call', seq: 0 }])
  assert.equal(h.host.stats.eventsIn, 1)
  assert.equal(h.host.state, 'connected')
  h.host.dispose()
})

test('EOF rejects in-flight requests and leaves the host disconnected', async () => {
  const h = harness()
  h.host.attach({ transport: new HostTransport({ input: h.toHost, output: h.fromHost }) })
  h.sendQt(hello)
  await waitFor(() => h.host.state === 'connected')

  const inflight = h.host.invoke('ping')
  await waitFor(() => h.host.stats.pending === 1)
  h.toHost.end()
  await assert.rejects(inflight, /unavailable/)
  assert.equal(h.host.state, 'disconnected')
  assert.match(h.host.lastError ?? '', /closed/)
  h.host.dispose()
})

test('dispose detaches first, then rejects with cancelled', async () => {
  const h = harness()
  h.host.attach({ transport: new HostTransport({ input: h.toHost, output: h.fromHost }) })
  h.sendQt(hello)
  await waitFor(() => h.host.state === 'connected')

  const inflight = h.host.invoke('ping')
  await waitFor(() => h.host.stats.pending === 1)
  h.host.dispose()
  await assert.rejects(inflight, /disposed/)
  assert.equal(h.host.state, 'disconnected')
  await assert.rejects(h.host.invoke('ping'), /disposed/)
  // A second dispose is a no-op, not a crash.
  h.host.dispose()
})

test('the launcher reports a missing binary as unavailable instead of throwing', () => {
  const ctx = new Context()
  const host = new HostBridgeService(ctx, { autoLaunch: false, binaryPath: '/nonexistent/dsh-qt-app' })
  assert.equal(host.launch(), null)
  assert.equal(host.state, 'unavailable')
  assert.match(host.lastError ?? '', /not found|no executable/i)
  host.dispose()
})

test('a handler that throws becomes an error reply with its protocol code', async () => {
  const h = harness()
  h.host.attach({ transport: new HostTransport({ input: h.toHost, output: h.fromHost }) })
  h.sendQt(hello)
  await waitFor(() => h.host.state === 'connected')
  h.host.register('settings.get', (params) => {
    const name = (params as { name?: unknown } | undefined)?.name
    if (typeof name !== 'string') throw new HostBridgeError('bad-params', 'name is required')
    return { name, value: null }
  })

  h.sendQt(req('qt-1', 'settings.get', { name: 42 }))
  await waitFor(() => framesOf(h.frames, 'res').length === 1)
  const reply = replyFor(h.frames, 'qt-1')
  assert.ok(reply !== undefined)
  assert.ok(!reply.ok)
  assert.equal(reply.error.code, 'bad-params')
  assert.equal(h.host.stats.failed, 1)
  h.host.dispose()
})