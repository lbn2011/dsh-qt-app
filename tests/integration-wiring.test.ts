/**
 * Wiring integration: one mounted plugin, all four native surfaces.
 *
 * `apply()` is the only place where the Qt plugin meets the rest of the host,
 * so this suite mounts it exactly as a profile would — with the official
 * services present, the Node host attached to an in-memory v1 pipe — and then
 * drives it the way Qt does: `hello`, then one `req` frame per method group.
 *
 * The fakes below implement only the official surface each group calls. The
 * settings fixture carries a secret under a path the descriptor declares as
 * redacted; if any reply frame ever contains it, this suite fails. No real
 * credential store is touched.
 */
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { HostBridgeService } from '../src/host/bridge-service.js'
import { HostTransport } from '../src/host/transport.js'
import { PROTOCOL_VERSION, encodeFrame } from '../src/bridge/protocol.js'
import type { Envelope } from '../src/bridge/protocol.js'
import { apply } from '../src/index.js'
import type { NapiBridge } from '../src/qt-bridge/napi-loader.js'

const SECRET = 'sk-wiring-THIS-MUST-NEVER-ESCAPE-7d21'

const fakeBridge: NapiBridge = {
  version: 'wiring-1.0.0',
  renderMarkdown: (text: string) => `<p>${text}</p>`,
  highlightCode: (code: string) => `<code>${code}</code>`,
}

const settings = {
  writable: true,
  describe: () => [
    {
      ns: 'demo',
      autoGenerate: false,
      schema: {},
      value: { model: { name: 'demo-model' }, apiKey: SECRET },
      revision: 3,
      applies: 'live',
      secrets: [{ path: ['apiKey'], set: true }],
    },
  ],
  mutate: async () => undefined,
}

const llm = {
  listProviders: () => [{ id: 'demo', name: 'Demo provider' }],
  listConfigurableProviders: () => [
    { provider: 'demo', displayName: 'Demo provider', settingsNs: 'demo', settingsPath: ['provider'] },
  ],
  discoverModels: async () => [{ id: 'demo-model', name: 'Demo model' }],
}

const credentials = {
  describe: async () => ({ configured: true, writable: true, source: 'env' }),
  set: async () => undefined,
  unset: async () => undefined,
  listRecords: async () => [{ key: 'user/DEMO_API_KEY', kind: 'credential' }],
}

const manager = {
  listPlugins: () => [{ id: 'demo-plugin', name: 'Demo plugin', enabled: true, version: '1.2.3' }],
  listBundles: () => [],
}

const defaultModel = {
  currentSelection: () => ({ provider: 'demo', model: 'demo-model' }),
  saveSelection: async () => undefined,
}

interface Harness {
  ctx: Context
  host: HostBridgeService
  frames: Envelope[]
  sent: Envelope[]
  sendQt(frame: Envelope): void
}

function harness(): Harness {
  const ctx = new Context()
  // A provided service is visible to the plugin's reflection lookup, exactly
  // like a profile that mounted dsh-settings/dsh-llm/dsh-credentials first.
  ctx.provide('settings', settings)
  ctx.provide('llm', llm)
  ctx.provide('credentials', credentials)
  ctx.provide('pluginManager', manager)
  ctx.provide('agentDefaultModel', defaultModel)

  apply(ctx, { autoStartEventLoop: false, autoLaunch: false, bridge: fakeBridge })

  const host = (ctx as unknown as { hostBridge: HostBridgeService }).hostBridge
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const frames: Envelope[] = []
  const sent: Envelope[] = []
  let pending = ''
  fromHost.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline < 0) return
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line.trim()) frames.push(JSON.parse(line) as Envelope)
    }
  })
  host.attach({ transport: new HostTransport({ input: toHost, output: fromHost }) })
  return {
    ctx,
    host,
    frames,
    sent,
    sendQt(frame) {
      const encoded = encodeFrame(frame)
      if (!encoded.ok) throw new Error(encoded.error.message)
      sent.push(frame)
      toHost.write(encoded.line + '\n')
    },
  }
}

const hello: Envelope = {
  v: PROTOCOL_VERSION,
  kind: 'hello',
  role: 'qt',
  epoch: 'epoch-wiring',
  app: 'dsh-qt-app',
  qt: '6.8.2',
  caps: [],
}

function req(id: string, method: string, params?: unknown): Envelope {
  return { v: PROTOCOL_VERSION, kind: 'req', id, method, ...(params === undefined ? {} : { params }) }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function replyFor(h: Harness, id: string): Extract<Envelope, { kind: 'res' }> {
  for (const frame of h.frames) {
    if (frame.kind === 'res' && frame.id === id) return frame
  }
  throw new Error(`no reply for ${id}`)
}

async function connected(): Promise<Harness> {
  const h = harness()
  h.sendQt(hello)
  await waitFor(() => h.host.state === 'connected')
  return h
}

test('settings.describe redacts declared secrets and keeps the revision', async () => {
  const h = await connected()
  h.sendQt(req('q1', 'settings.describe', {}))
  await waitFor(() => h.frames.some((frame) => frame.kind === 'res' && frame.id === 'q1'))
  assert.ok(!JSON.stringify(h.frames).includes(SECRET), 'a declared secret reached a reply frame')
  const reply = replyFor(h, 'q1')
  assert.equal(reply.ok, true)
  const result = reply.result as { revision: number; namespaces: Array<{ ns: string; value: unknown }> }
  assert.equal(result.revision, 3)
  assert.equal(result.namespaces[0]?.ns, 'demo')
  h.host.dispose()
})

test('settings.mutate is forwarded as path ops', async () => {
  const h = await connected()
  h.sendQt(
    req('q2', 'settings.mutate', {
      ns: 'demo',
      ops: [{ op: 'set', path: ['model', 'name'], value: 'next-model' }],
      expectedRevision: 3,
    }),
  )
  await waitFor(() => h.frames.some((frame) => frame.kind === 'res' && frame.id === 'q2'))
  assert.equal(replyFor(h, 'q2').ok, true)
  h.host.dispose()
})

test('llm.providers.list, llm.default.get and cred.describe answer without a secret', async () => {
  const h = await connected()
  h.sendQt(req('q3', 'llm.providers.list'))
  h.sendQt(req('q4', 'llm.default.get'))
  h.sendQt(req('q5', 'cred.describe', { ref: 'DEMO_API_KEY' }))
  await waitFor(() => ['q3', 'q4', 'q5'].every((id) => h.frames.some((f) => f.kind === 'res' && f.id === id)))
  assert.equal(replyFor(h, 'q3').ok, true)
  assert.equal(replyFor(h, 'q4').ok, true)
  assert.equal(replyFor(h, 'q5').ok, true)
  assert.ok(!JSON.stringify(h.frames).includes(SECRET))
  h.host.dispose()
})

test('plugin.list reaches the manager and webui stays idle until asked', async () => {
  const h = await connected()
  h.sendQt(req('q6', 'plugin.list'))
  h.sendQt(req('q7', 'webui.probe'))
  await waitFor(() => ['q6', 'q7'].every((id) => h.frames.some((f) => f.kind === 'res' && f.id === id)))
  assert.equal(replyFor(h, 'q6').ok, true)
  const probe = replyFor(h, 'q7')
  assert.equal(probe.ok, true)
  assert.equal((probe.result as { state: string }).state, 'Idle')
  h.host.dispose()
})

test('tool rows are pushed for the live session and served by tool.snapshot', async () => {
  const h = await connected()
  // Let the ack flush so the event write is observed by the collector.
  await new Promise((resolve) => setTimeout(resolve, 20))
  ;(h.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit(
    'session/event',
    { id: 'session-wiring' },
    {
      type: 'tool/call',
      seq: 1,
      time: 1,
      // Official tool events carry the turn/step the row is grouped under;
      // the projection rejects a call without them as malformed.
      data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"a"}' },
    },
  )
  await waitFor(() => h.frames.some((frame) => frame.kind === 'evt' && frame.name === 'tool.row'))
  const push = h.frames.find((frame) => frame.kind === 'evt' && frame.name === 'tool.row')
  assert.ok(push && push.kind === 'evt')
  const payload = push.payload as { sessionKey: string; rows: Array<{ callId: string }> }
  assert.equal(payload.sessionKey, 'session-wiring')
  assert.equal(payload.rows[0]?.callId, 'call-1')

  h.sendQt(req('q8', 'tool.snapshot', { sessionKey: 'session-wiring' }))
  await waitFor(() => h.frames.some((frame) => frame.kind === 'res' && frame.id === 'q8'))
  const reply = replyFor(h, 'q8')
  assert.equal(reply.ok, true)
  const snapshot = reply.result as { sessionKey: string; rows: unknown[] }
  assert.equal(snapshot.sessionKey, 'session-wiring')
  assert.equal(snapshot.rows.length, 1)
  h.host.dispose()
})
