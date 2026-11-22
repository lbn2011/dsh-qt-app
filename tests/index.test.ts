/**
 * Unit tests for the `qtRenderer` Cordis service and the plugin entry point.
 *
 * The Qt host itself is not exercised here (no Qt on this machine by design);
 * these tests pin the TypeScript contract: service registration, N-API
 * delegation and degradation, dialog round-trips, view/slot registries, and the
 * event-loop lifecycle tied to the plugin fiber.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import plugin, { QtRendererService, apply, inject, name, version } from '../src/index.js'
import type { QtPluginConfig } from '../src/index.js'
import { NATIVE_SLOT_SURFACES, PLUGIN_NAME, PLUGIN_VERSION, QML_ENTRY_URL } from '../src/constants.js'
import type { NapiBridge } from '../src/qt-bridge/napi-loader.js'

const fakeBridge: NapiBridge = {
  version: 'test-1.0.0',
  renderMarkdown: (text: string) => `<p>${text}</p>`,
  highlightCode: (code: string, language?: string) => `<code data-lang="${language ?? 'none'}">${code}</code>`,
}

function mount(options: QtPluginConfig = {}): Context {
  const ctx = new Context()
  apply(ctx, { autoStartEventLoop: false, bridge: fakeBridge, ...options })
  return ctx
}

test('plugin exports a Cordis-compatible shape', () => {
  assert.equal(name, PLUGIN_NAME)
  assert.equal(version, PLUGIN_VERSION)
  assert.equal(typeof apply, 'function')
  assert.ok(Array.isArray(inject))
  assert.equal(plugin.name, PLUGIN_NAME)
  assert.equal(plugin.apply, apply)
})

test('apply() registers ctx.qtRenderer and declares the native surfaces', () => {
  const ctx = mount()
  assert.ok(ctx.qtRenderer instanceof QtRendererService)
  assert.equal(ctx.qtRenderer.name, 'qtRenderer')
  assert.equal(ctx.qtRenderer.qmlEntry, QML_ENTRY_URL)

  const surfaces = ctx.qtRenderer.listSurfaces()
  assert.equal(surfaces.length, NATIVE_SLOT_SURFACES.length)
  for (const surface of NATIVE_SLOT_SURFACES) {
    assert.ok(surfaces.includes(surface), `missing native surface ${surface}`)
  }

  // The event loop must not run when the caller opted out.
  assert.equal(ctx.qtRenderer.eventLoop.running, false)
})

test('apply() starts the event loop through ctx.effect when enabled', async () => {
  const ctx = new Context()
  await ctx.plugin(plugin, { bridge: fakeBridge })
  assert.equal(ctx.qtRenderer.eventLoop.running, true)

  const stats = ctx.qtRenderer.stats
  assert.equal(stats.name, PLUGIN_NAME)
  assert.equal(stats.version, PLUGIN_VERSION)
  assert.equal(stats.bridgeDegraded, false)
  assert.equal(stats.bridgeSource, 'explicit')
})

test('renderMarkdown()/highlightCode() delegate to the N-API bridge', async () => {
  const ctx = mount()
  assert.equal(await ctx.qtRenderer.renderMarkdown('# title'), '<p># title</p>')
  assert.equal(await ctx.qtRenderer.highlightCode('let a = 1', 'ts'), '<code data-lang="ts">let a = 1</code>')
})

test('a missing addon degrades to escaped plain text instead of throwing', async () => {
  const ctx = new Context()
  apply(ctx, { autoStartEventLoop: false, napiPath: '/nonexistent/dsh-qt-napi/qt-bridge.node' })

  const stats = ctx.qtRenderer.stats
  assert.equal(stats.bridgeDegraded, true)
  assert.equal(stats.bridgeSource, 'fallback')
  assert.ok(ctx.qtRenderer.bridgeLoad.attempted.length > 0)

  const html = await ctx.qtRenderer.renderMarkdown('<script>alert(1)</script>')
  assert.ok(html.includes('&lt;script&gt;'), 'fallback must escape markup')
  assert.equal(html.includes('<script>'), false)
})

test('showDialog() posts to the event loop and settles via resolveDialog()', async () => {
  const ctx = mount()
  const pending = ctx.qtRenderer.showDialog({
    title: 'Delete session?',
    message: 'This cannot be undone.',
    buttons: [
      { label: 'Cancel', id: 'cancel' },
      { label: 'Delete', id: 'delete', default: true },
    ],
  })

  assert.deepEqual(ctx.qtRenderer.pendingDialogs(), ['dialog-1'])
  assert.equal(ctx.qtRenderer.eventLoop.queue.size, 1)

  const [message] = ctx.qtRenderer.eventLoop.queue.drain()
  assert.equal(message?.type, 'dialog.open')
  const payload = message?.payload as { id: string; title: string; buttons: unknown[] }
  assert.equal(payload.id, 'dialog-1')
  assert.equal(payload.title, 'Delete session?')
  assert.equal(payload.buttons.length, 2)

  assert.equal(ctx.qtRenderer.resolveDialog('dialog-1', { button: 'delete' }), true)
  assert.deepEqual(await pending, { button: 'delete' })
  assert.deepEqual(ctx.qtRenderer.pendingDialogs(), [])

  // Settling an unknown dialog is a no-op, not an error.
  assert.equal(ctx.qtRenderer.resolveDialog('dialog-1', { button: 'delete' }), false)
})

test('showDialog() rejects an empty button list', async () => {
  const ctx = mount()
  await assert.rejects(() => ctx.qtRenderer.showDialog({ title: 'Empty', buttons: [] }), RangeError)
})

test('view and slot registries are disposable', () => {
  const ctx = mount()
  const renderer = ctx.qtRenderer

  const disposeView = renderer.registerView('settings', 'qrc:/qml/views/Settings.qml')
  assert.deepEqual(renderer.listViews(), [{ id: 'settings', qmlPath: 'qrc:/qml/views/Settings.qml' }])
  disposeView()
  assert.deepEqual(renderer.listViews(), [])

  const disposeSlot = renderer.registerSlot({
    surface: 'conversation.chat.flow',
    id: 'token-counter',
    label: 'Tokens',
  })
  assert.equal(renderer.listSlots('conversation.chat.flow').length, 1)
  assert.equal(renderer.listSlots('settings.general').length, 0)

  // Registering the same contribution twice keeps a single entry.
  renderer.registerSlot({ surface: 'conversation.chat.flow', id: 'token-counter' })
  assert.equal(renderer.listSlots().length, 1)

  assert.equal(renderer.unregisterSlot('conversation.chat.flow', 'token-counter'), true)
  assert.equal(renderer.listSlots().length, 0)
  disposeSlot()
})

test('declareSurface() extends the native surface set', () => {
  const ctx = mount({ declareNativeSurfaces: false })
  assert.deepEqual(ctx.qtRenderer.listSurfaces(), [])
  ctx.qtRenderer.declareSurface('conversation.message.image')
  assert.deepEqual(ctx.qtRenderer.listSurfaces(), ['conversation.message.image'])
})

test('stats expose bridge, registry and queue counters', () => {
  const ctx = mount({ tickMs: 20, maxQueue: 8 })
  ctx.qtRenderer.eventLoop.post({ type: 'composer.submit', payload: { text: 'hi' } })

  const stats = ctx.qtRenderer.stats
  assert.equal(stats.pending, 1)
  assert.equal(stats.views, 0)
  assert.equal(stats.slots, 0)
  assert.equal(stats.surfaces, NATIVE_SLOT_SURFACES.length)
  assert.equal(stats.pendingDialogs, 0)
  assert.equal(stats.running, false)
  assert.equal(ctx.qtRenderer.eventLoop.tickMs, 20)
  assert.equal(ctx.qtRenderer.eventLoop.queue.maxSize, 8)
})
