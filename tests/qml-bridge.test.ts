// tests/qml-bridge.test.ts — the QML ⇄ Node request bridge.
//
// These tests exercise the real dispatcher, not a stand-in: `dispatch()` is the
// same path a QML call takes once it reaches Node, so a passing suite means the
// reply shape, the error codes and the concurrency accounting are what QML will
// actually observe.
//
// Three groups:
//   1. transport bookkeeping — ids, one reply per request, malformed frames.
//   2. dispatch semantics — every method, its validation and its failure codes.
//   3. service adapters — the seam that bends Cordis services into the bridge.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  QmlBridge,
  QmlBridgeCallError,
  QML_BRIDGE_METHODS,
  QML_NOTIFY_TYPE,
  QML_REQUEST_TYPE,
  createContextBridge,
  createServiceBridge,
  fallbackParserAdapter,
  rendererFromService,
  settingsFromStore,
  themeFromService,
  type QmlBridgeOptions,
  type QmlBridgeOutbound,
  type QmlBridgeReply,
} from '../src/bridge/index.js'
import { createEventLoopBridge } from '../src/event-loop/timer.js'
import type { MarkdownJSON } from '../src/markdown/types.js'

/** Collect every reply a bridge emits, so tests can assert on the wire shape. */
function sinkOf(): { replies: QmlBridgeOutbound[]; sink: (reply: QmlBridgeOutbound) => void } {
  const replies: QmlBridgeOutbound[] = []
  return { replies, sink: (reply) => replies.push(reply) }
}

/** A bridge whose renderer answers deterministically. */
function makeBridge(overrides: QmlBridgeOptions = {}): { bridge: QmlBridge; replies: QmlBridgeOutbound[] } {
  const { replies, sink } = sinkOf()
  const bridge = new QmlBridge({
    sink,
    parser: fallbackParserAdapter,
    renderer: {
      renderMarkdown: (text) => `<p>${text}</p>`,
      highlightCode: (code, language) => `<code data-lang="${language ?? ''}">${code}</code>`,
    },
    theme: {
      applyTheme: (value) => ({ applied: value }),
      // Mirrors ThemeService.setFontScale(): it *returns* the effective value, and
      // only a numeric return is honoured by the bridge.
      setFontScale: (scale) => Math.min(1.5, Math.max(0.8, scale)),
      activeId: 'dark',
      fontScale: 1,
    },
    settings: {
      get: (name) => (name === 'theme' ? 'dark' : undefined),
      set: (name) => name !== 'forbidden',
    },
    composer: {
      submit: (text) => ({ accepted: text !== 'reject me' }),
    },
    ...overrides,
  })
  return { bridge, replies }
}

/** Feed one request through the event-loop entry point. */
function send(bridge: QmlBridge, id: string, method: string, params?: Record<string, unknown>): void {
  bridge.accept({
    type: QML_REQUEST_TYPE,
    payload: params === undefined ? { id, method } : { id, method, params },
    timestamp: Date.now(),
  })
}

/** Wait for the microtask queue plus a macrotask, so async handlers settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

// ---- transport bookkeeping -------------------------------------------------

test('a request produces exactly one reply carrying its id and method', async () => {
  const { bridge, replies } = makeBridge()
  send(bridge, 'req-1', 'markdown.render', { text: 'hello' })
  await settle()

  assert.equal(replies.length, 1)
  const reply = replies[0] as QmlBridgeOutbound
  assert.equal(reply.type, 'qml.reply')
  const payload = reply.payload
  assert.equal(payload.id, 'req-1')
  assert.equal(payload.method, 'markdown.render')
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.result, { html: '<p>hello</p>' })
  assert.equal(typeof payload.elapsedMs, 'number')
})

test('a malformed frame is dropped and still answered, so the host cannot leak an id', async () => {
  const { bridge, replies } = makeBridge()
  bridge.accept({ type: QML_REQUEST_TYPE, payload: { id: 'broken-1', method: 42 }, timestamp: Date.now() })
  await settle()

  assert.equal(replies.length, 1)
  const payload = replies[0]?.payload as QmlBridgeReply
  assert.equal(payload.id, 'broken-1')
  assert.equal(payload.ok, false)
  assert.equal(payload.error?.code, 'bad-params')
  assert.equal(bridge.stats.dropped, 1)
})

test('a notification runs without emitting a reply', async () => {
  // One sink attached to the bridge under test: asserting on a sink from a
  // *different* bridge would pass no matter what this one did.
  const { replies, sink } = sinkOf()
  let seen = 0
  const bridgeWithComposer = new QmlBridge({
    sink,
    composer: {
      submit: () => {
        seen += 1
        return { accepted: true }
      },
    },
  })
  bridgeWithComposer.accept({
    type: QML_NOTIFY_TYPE,
    payload: { id: 'note-1', method: 'composer.submit', params: { text: 'hi' } },
    timestamp: Date.now(),
  })
  await settle()

  assert.equal(seen, 1)
  assert.equal(replies.length, 0)
})

test('an unknown method answers unknown-method instead of throwing', async () => {
  const { bridge, replies } = makeBridge()
  send(bridge, 'req-2', 'does.not.exist')
  await settle()

  const payload = replies[0]?.payload as QmlBridgeReply
  assert.equal(payload.ok, false)
  assert.equal(payload.error?.code, 'unknown-method')
})

// ---- dispatch semantics ----------------------------------------------------

test('markdown.parse returns the AST document QML renders', async () => {
  const { bridge } = makeBridge()
  const result = (await bridge.request('markdown.parse', { text: '# Title\n\nbody *em*' })) as {
    document: MarkdownJSON
  }
  assert.equal(result.document.type, 'document')
  const children = (result.document as { children?: MarkdownJSON[] }).children ?? []
  assert.equal(children.length, 2)
  assert.equal(children[0]?.type, 'heading')
  assert.equal(children[1]?.type, 'paragraph')
})

test('markdown.parse without a parser reports unavailable rather than crashing', async () => {
  // Built without the key at all: `exactOptionalPropertyTypes` forbids passing
  // an explicit `undefined` for an optional property, and "absent" is the real
  // situation here (a host that attached no parser).
  const bridge = new QmlBridge({ sink: sinkOf().sink })
  await assert.rejects(
    () => bridge.request('markdown.parse', { text: '# x' }),
    (error: unknown) => error instanceof QmlBridgeCallError && error.code === 'unavailable',
  )
})

test('markdown.render and code.highlight forward to the renderer', async () => {
  const { bridge } = makeBridge()
  const rendered = (await bridge.request('markdown.render', { text: 'x' })) as { html: string }
  assert.equal(rendered.html, '<p>x</p>')

  const highlighted = (await bridge.request('code.highlight', {
    code: 'let a = 1',
    language: 'javascript',
  })) as { markup: string }
  assert.equal(highlighted.markup, '<code data-lang="javascript">let a = 1</code>')
})

test('a missing parameter is bad-params, not a silent undefined', async () => {
  const { bridge } = makeBridge()
  await assert.rejects(
    () => bridge.request('code.highlight', {}),
    (error: unknown) => error instanceof QmlBridgeCallError && error.code === 'bad-params',
  )
})

test('theme.apply reports the applied mode and theme.scale the clamped value', async () => {
  const { bridge } = makeBridge()
  const applied = (await bridge.request('theme.apply', { mode: 'light' })) as Record<string, unknown>
  // The reply carries what the service actually applied plus the scheme now in
  // force, so QML can reconcile a control without a second round trip.
  assert.deepEqual(applied['applied'], { applied: 'light' })
  assert.equal(applied['activeId'], 'dark')

  const scaled = (await bridge.request('theme.scale', { scale: 9 })) as { scale: number }
  assert.equal(scaled.scale, 1.5)

  await assert.rejects(
    () => bridge.request('theme.apply', { mode: '   ' }),
    (error: unknown) => error instanceof QmlBridgeCallError && error.code === 'bad-params',
  )
})

test('settings.set treats a refusal as an answer, settings.get returns the value', async () => {
  const { bridge } = makeBridge()
  const refused = (await bridge.request('settings.set', { name: 'forbidden', value: 1 })) as {
    accepted: boolean
  }
  assert.equal(refused.accepted, false)

  const read = (await bridge.request('settings.get', { name: 'theme' })) as { value: unknown }
  assert.equal(read.value, 'dark')
})

test('composer.submit rejects blank text and reports the verdict', async () => {
  const { bridge } = makeBridge()
  await assert.rejects(
    () => bridge.request('composer.submit', { text: '   ' }),
    (error: unknown) => error instanceof QmlBridgeCallError && error.code === 'bad-params',
  )

  const accepted = (await bridge.request('composer.submit', { text: 'hello' })) as {
    accepted: boolean
  }
  assert.equal(accepted.accepted, true)

  const rejected = (await bridge.request('composer.submit', { text: 'reject me' })) as {
    accepted: boolean
  }
  assert.equal(rejected.accepted, false)
})

test('a throwing handler is contained as internal and the bridge keeps working', async () => {
  let calls = 0
  const { bridge } = makeBridge({
    renderer: {
      renderMarkdown: () => {
        calls += 1
        throw new Error('renderer exploded')
      },
      highlightCode: () => '',
    },
  })

  await assert.rejects(
    () => bridge.request('markdown.render', { text: 'x' }),
    (error: unknown) => error instanceof QmlBridgeCallError && error.code === 'internal',
  )
  assert.equal(calls, 1)

  // The failure must not poison the bridge.
  const pong = (await bridge.request('ping')) as { pong: boolean }
  assert.equal(pong.pong, true)
})

test('a slow handler times out instead of hanging the caller', async () => {
  const { bridge } = makeBridge({
    timeoutMs: 10,
    renderer: {
      renderMarkdown: () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('late'), 200)
        }),
      highlightCode: () => '',
    },
  })

  await assert.rejects(
    () => bridge.request('markdown.render', { text: 'slow' }),
    (error: unknown) => error instanceof QmlBridgeCallError && error.code === 'timeout',
  )
})

test('concurrency is bounded and overflow answers busy immediately', async () => {
  let inFlight = 0
  let peak = 0
  const { bridge, replies } = makeBridge({
    maxConcurrent: 2,
    maxPending: 1,
    renderer: {
      renderMarkdown: async (text) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 10))
        inFlight -= 1
        return `<p>${text}</p>`
      },
      highlightCode: () => '',
    },
  })

  for (let index = 0; index < 5; ++index) send(bridge, `c-${index}`, 'markdown.render', { text: String(index) })
  // The overflow reply must be immediate, not queued behind the slow ones.
  const busy = replies.filter((reply) => reply.payload.error?.code === 'busy')
  assert.equal(busy.length, 2)
  assert.ok(peak <= 2, `concurrency peaked at ${peak}`)

  await settle()
  await settle()
  await settle()
  assert.ok(peak <= 2, `concurrency peaked at ${peak}`)
  assert.ok(bridge.stats.rejected >= 1)
})

// ---- event loop integration ------------------------------------------------

test('a request posted on the real event loop is answered through the sink', async () => {
  const { bridge, replies } = makeBridge()
  const loop = createEventLoopBridge({ tickMs: 1, unref: false })
  const disconnect = bridge.connectEventLoop(loop)
  loop.start()

  loop.post({
    type: QML_REQUEST_TYPE,
    payload: { id: 'loop-1', method: 'markdown.render', params: { text: 'via loop' } },
  })

  for (let attempt = 0; attempt < 40 && replies.length === 0; ++attempt) {
    loop.tick()
    await settle()
  }

  disconnect()
  loop.dispose()

  assert.equal(replies.length, 1)
  const payload = replies[0]?.payload as QmlBridgeReply
  assert.equal(payload.id, 'loop-1')
  assert.deepEqual(payload.result, { html: '<p>via loop</p>' })
})

// ---- service adapters ------------------------------------------------------

test('rendererFromService forwards options only when they are present', async () => {
  const seen: Array<[string, unknown]> = []
  const renderer = rendererFromService({
    renderMarkdown: (text: string, options?: unknown) => {
      seen.push([text, options])
      return `<p>${text}</p>`
    },
    highlightCode: (code: string, language?: string) => {
      seen.push([code, language])
      return code
    },
  })

  await renderer.renderMarkdown('a')
  await renderer.renderMarkdown('b', { enableTables: false })
  await renderer.highlightCode('c')
  await renderer.highlightCode('d', 'python')

  assert.deepEqual(seen[0], ['a', undefined])
  assert.deepEqual(seen[1], ['b', { enableTables: false }])
  assert.deepEqual(seen[2], ['c', undefined])
  assert.deepEqual(seen[3], ['d', 'python'])
})

test('themeFromService refuses "auto" instead of pinning a scheme', async () => {
  const activated: string[] = []
  const theme = themeFromService({
    setActive: (id: string) => {
      activated.push(id)
    },
    activeId: 'dark',
    fontScale: 1,
  })

  theme.applyTheme?.('light')
  assert.deepEqual(activated, ['light'])

  assert.throws(() => theme.applyTheme?.('auto'), /auto/)
  assert.throws(() => theme.setFontScale?.(1.2), /setFontScale/)
  assert.equal(theme.activeId, 'dark')
})

test('settingsFromStore normalises a throwing store to a boolean', () => {
  const store = settingsFromStore({
    get: (name: string) => (name === 'fontSize' ? 1 : undefined),
    set: (name: string, value: unknown) => {
      if (name !== 'fontSize') throw new Error('unknown setting')
      return value
    },
  })

  assert.equal(store.set('fontSize', 1.25), true)
  assert.equal(store.set('nope', 1), false)
  assert.equal(store.get('fontSize'), 1)
})

test('createServiceBridge works with no services at all and answers unavailable', async () => {
  const { replies, sink } = sinkOf()
  const bridge = createServiceBridge({}, { sink, parser: fallbackParserAdapter })
  send(bridge, 'empty-1', 'markdown.render', { text: 'x' })
  await settle()

  const payload = replies[0]?.payload as QmlBridgeReply
  assert.equal(payload.ok, false)
  assert.equal(payload.error?.code, 'unavailable')
})

test('createContextBridge picks up ctx.qtRenderer and the settings store', async () => {
  const bridge = createContextBridge({
    qtRenderer: {
      renderMarkdown: (text: string) => `<p>${text}</p>`,
      highlightCode: (code: string) => code,
    },
    settings: {
      get: (name: string) => name,
      set: () => true,
    },
  })

  const rendered = (await bridge.request('markdown.render', { text: 'ctx' })) as { html: string }
  assert.equal(rendered.html, '<p>ctx</p>')

  const parsed = (await bridge.request('markdown.parse', { text: 'plain' })) as { document: MarkdownJSON }
  assert.equal(parsed.document.type, 'document')
})

test('the documented method list matches what the dispatcher answers', async () => {
  const { bridge } = makeBridge()
  for (const method of QML_BRIDGE_METHODS) {
    // Every documented method must be recognised: a wrong name would answer
    // unknown-method, which is exactly the drift this test exists to catch.
    const reply = await bridge.dispatch({ id: `m-${method}`, method, params: {} })
    if (!reply.ok && reply.error?.code === 'unknown-method') assert.fail(`${method} is not implemented`)
  }
})
