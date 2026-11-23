/**
 * Tests for the plugin-manager bridge (I4, plan §3.3) and the unified slot contract.
 *
 * Three things are being pinned down here, and they are the reason this file is
 * longer than the surface it covers:
 *
 *  1. The bridge is a *pass-through*. The official manager already decides
 *     `application`, `restartReason` and the `ManagementError` codes; if this
 *     layer re-derived any of them the Qt panel would show a second, disagreeing
 *     opinion. So `ChangeResult`s are asserted verbatim.
 *  2. Failures never escape as exceptions. A rejected install has to come back
 *     as a settled operation with `application: 'failed'`, otherwise one broken
 *     plugin takes down the whole settings panel (P1, failure isolation).
 *  3. Long operations are asynchronous by contract: the call returns an `opId`
 *     immediately and the outcome arrives as `plugin.op.progress`.
 *
 * The slot half covers duplicate ids, disposal (unloading must not leave a dead
 * slot behind) and the fact that `slot.list` is JSON-safe: QML cannot receive a
 * function, so the projection has to say `hasRender: true` rather than ship it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createPluginService,
  PLUGIN_SERVICE_METHODS,
} from '../src/plugins/service.js'
import type { MethodHostPort, PluginManagerPort, PluginService } from '../src/plugins/service.js'
import { createSlotRegistry } from '../src/plugins/slot-contract.js'

interface RecordedEvent {
  name: string
  payload?: unknown
}

interface FakeHost {
  port: MethodHostPort
  call(method: string, params?: unknown): Promise<unknown>
  has(method: string): boolean
  events: RecordedEvent[]
  clear(): void
  registered(): string[]
}

function fakeHost(): FakeHost {
  const handlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>()
  const events: RecordedEvent[] = []
  const port: MethodHostPort = {
    register(method, handler) {
      assert.equal(handlers.has(method), false, `method ${method} registered twice`)
      handlers.set(method, handler)
      return () => {
        handlers.delete(method)
      }
    },
    emitEvent(name, payload) {
      events.push(payload === undefined ? { name } : { name, payload })
    },
  }
  return {
    port,
    async call(method, params) {
      const handler = handlers.get(method)
      assert.ok(handler, `no handler for ${method}`)
      return await handler(params)
    },
    has(method) {
      return handlers.has(method)
    },
    events,
    clear() {
      events.length = 0
    },
    registered() {
      return [...handlers.keys()].sort()
    },
  }
}

const ROW = {
  id: 'acme',
  moduleName: '@acme/dsh-plugin',
  enabled: true,
  rows: ['acme'],
  readOnlyReason: undefined,
}

function manager(overrides: Partial<PluginManagerPort> = {}): PluginManagerPort {
  return {
    listPlugins: () => [ROW],
    ...overrides,
  }
}

function service(
  overrides: Partial<PluginManagerPort> = {},
  options: { maxRetainedOps?: number } = {},
): { service: PluginService; host: FakeHost } {
  const host = fakeHost()
  const created = createPluginService({
    manager: manager(overrides),
    host: host.port,
    ...(options.maxRetainedOps === undefined ? {} : { maxRetainedOps: options.maxRetainedOps }),
  })
  created.attach()
  return { service: created, host }
}

function progressEvents(host: FakeHost): Record<string, unknown>[] {
  return host.events
    .filter((event) => event.name === 'plugin.op.progress')
    .map((event) => event.payload as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Method surface
// ---------------------------------------------------------------------------

test('the read and toggle methods are registered from the plan method table', () => {
  const { host } = service({
    listBundles: () => [],
    setPluginEnabled: async () => ({}),
    setBundleEnabled: async () => ({}),
  })
  for (const method of ['plugin.list', 'plugin.bundles', 'plugin.setEnabled', 'plugin.bundle.setEnabled']) {
    assert.equal(host.has(method), true, `${method} should be registered`)
  }
  for (const method of ['plugin.install', 'plugin.remove', 'plugin.update', 'plugin.op.cancel']) {
    assert.equal(host.has(method), true, `${method} should be registered`)
  }
  assert.deepEqual(PLUGIN_SERVICE_METHODS.includes('plugin.list'), true)
})

test('methods the installed manager does not expose are not advertised', () => {
  // The installed 0.2.2-rc.1 manager has these, but a host running an older or
  // trimmed build must not offer a button that can only fail.
  const { host } = service()
  assert.equal(host.has('plugin.bundles'), false)
  assert.equal(host.has('plugin.setEnabled'), false)
  assert.equal(host.has('plugin.list'), true)
})

test('plugin.list passes the official rows through untouched', async () => {
  const rows = [
    { id: 'acme', moduleName: '@acme/dsh-plugin', enabled: true, rows: ['acme'] },
    { id: 'locked', moduleName: '@deepseek-ai/dsh-official', enabled: true, readOnlyReason: 'management-required' },
  ]
  const { host } = service({ listPlugins: () => rows })
  assert.deepEqual(await host.call('plugin.list'), rows)
})

// ---------------------------------------------------------------------------
// Pass-through of ChangeResult, including the restart semantics
// ---------------------------------------------------------------------------

test('plugin.setEnabled returns the ChangeResult verbatim, restart reason included', async () => {
  const result = {
    changed: true,
    application: 'restart-required',
    restartReason: 'no-hmr',
    stage: 'enable',
    target: 'acme',
    enabled: false,
  }
  const calls: unknown[] = []
  const { host } = service({
    setPluginEnabled: async (id, enabled) => {
      calls.push([id, enabled])
      return result
    },
  })

  assert.deepEqual(await host.call('plugin.setEnabled', { id: 'acme', enabled: false }), result)
  assert.deepEqual(calls, [['acme', false]])
  // The list is stale after a change; Qt re-fetches rather than trusting a push.
  assert.deepEqual(
    host.events.map((event) => event.name),
    ['plugin.changed'],
  )
  assert.deepEqual(host.events[0]?.payload, { target: 'acme', application: 'restart-required' })
})

test('plugin.bundle.setEnabled keeps the bundle-level result as it came', async () => {
  const result = { changed: true, application: 'applied', stage: 'enable', target: '@acme/bundle' }
  const { host } = service({ setBundleEnabled: async () => result })
  assert.deepEqual(await host.call('plugin.bundle.setEnabled', { name: '@acme/bundle', enabled: true }), result)
})

// ---------------------------------------------------------------------------
// Failure convergence — never throw, always a settled ChangeResult
// ---------------------------------------------------------------------------

test('a rejected toggle becomes a failed ChangeResult instead of an exception', async () => {
  const failure = Object.assign(new Error('nope'), { code: 'incompatible-version', diagnostic: 'needs dsh >= 0.3' })
  const { host } = service({
    setPluginEnabled: async () => {
      throw failure
    },
  })

  const result = (await host.call('plugin.setEnabled', { id: 'acme', enabled: true })) as Record<string, unknown>
  assert.equal(result['changed'], false)
  assert.equal(result['application'], 'failed')
  assert.equal(result['stage'], 'enable')
  assert.equal(result['target'], 'acme')
  assert.deepEqual(result['error'], { code: 'incompatible-version', diagnostic: 'needs dsh >= 0.3' })
  // Nothing changed, so the panel must not be told to re-fetch.
  assert.deepEqual(host.events, [])
})

test('an unknown error shape is still reported with a stable code', async () => {
  const { host } = service({
    setPluginEnabled: async () => {
      throw new Error('pnpm exploded')
    },
  })
  const result = (await host.call('plugin.setEnabled', { id: 'acme', enabled: true })) as Record<string, unknown>
  assert.equal(result['application'], 'failed')
  assert.deepEqual(result['error'], { code: 'operation-error', diagnostic: 'pnpm exploded' })
})

test('bad params are refused before the manager is touched', async () => {
  let touched = false
  const { host } = service({
    setPluginEnabled: async () => {
      touched = true
      return {}
    },
  })
  await assert.rejects(host.call('plugin.setEnabled', { id: '', enabled: true }), /bad-params/)
  await assert.rejects(host.call('plugin.setEnabled', { id: 'acme', enabled: 'yes' }), /bad-params/)
  assert.equal(touched, false)
})

// ---------------------------------------------------------------------------
// Long operations: opId now, progress later
// ---------------------------------------------------------------------------

test('plugin.install returns an opId immediately and reports progress', async () => {
  const result = { changed: true, application: 'restart-required', restartReason: 'no-hmr', stage: 'install', target: 'acme' }
  let requestId: unknown
  const { service: created, host } = service({
    installBundle: async (_spec, options) => {
      requestId = (options as { requestId?: unknown }).requestId
      return result
    },
  })

  const reply = (await host.call('plugin.install', { spec: 'acme@1.2.3' })) as { opId: string }
  assert.equal(typeof reply.opId, 'string')
  assert.ok(reply.opId.length > 0)

  const settled = await created.waitForOp(reply.opId)
  assert.equal(settled.phase, 'settled')
  assert.deepEqual(settled.result, result)
  // The official manager correlates its own install-state events by requestId.
  assert.equal(requestId, reply.opId)

  const phases = progressEvents(host).map((event) => event['phase'])
  assert.deepEqual(phases, ['installing', 'settled'])
  assert.deepEqual(
    host.events.filter((event) => event.name === 'plugin.changed').map((event) => event.payload),
    [{ target: 'acme', application: 'restart-required' }],
  )
})

test('a rejected install settles as failed and keeps the other methods usable', async () => {
  const failure = Object.assign(new Error('registry unreachable'), { code: 'operation-error' })
  const { service: created, host } = service({
    installBundle: async () => {
      throw failure
    },
  })

  const reply = (await host.call('plugin.install', { spec: 'acme@1.2.3' })) as { opId: string }
  const settled = await created.waitForOp(reply.opId)
  assert.equal(settled.phase, 'settled')
  assert.equal((settled.result as Record<string, unknown>)['application'], 'failed')
  assert.equal((settled.result as Record<string, unknown>)['changed'], false)
  assert.deepEqual(
    host.events.filter((event) => event.name === 'plugin.changed'),
    [],
    'a failed install must not invalidate the list',
  )

  // Failure isolation: the service is still fully functional afterwards.
  assert.deepEqual(await host.call('plugin.list'), [ROW])
})

test('plugin.update reports the update result and its restore step', async () => {
  const update = {
    from: '1.0.0',
    to: '1.1.0',
    step: 'install',
    result: { changed: true, application: 'applied', stage: 'install', target: 'acme' },
    restore: { changed: false, application: 'failed', stage: 'install', target: 'acme' },
  }
  const { service: created, host } = service({ updateBundle: async () => update })

  const reply = (await host.call('plugin.update', { name: 'acme', version: '1.1.0' })) as { opId: string }
  const settled = await created.waitForOp(reply.opId)
  assert.deepEqual(settled.result, update.result)
  assert.deepEqual(settled.update, { from: '1.0.0', to: '1.1.0', step: 'install', restore: update.restore })
})

test('plugin.remove settles with the official not-removable failure', async () => {
  const failure = Object.assign(new Error('built in'), { code: 'not-removable' })
  const { service: created, host } = service({
    removeBundle: async () => {
      throw failure
    },
  })
  const reply = (await host.call('plugin.remove', { name: 'acme' })) as { opId: string }
  const settled = await created.waitForOp(reply.opId)
  assert.equal((settled.result as Record<string, unknown>)['application'], 'failed')
  assert.deepEqual((settled.result as Record<string, unknown>)['error'], { code: 'not-removable', diagnostic: 'built in' })
})

test('cancelling an operation asks the manager and marks the op', async () => {
  const cancelled: string[] = []
  let release: ((value: unknown) => void) | undefined
  const pending = new Promise<unknown>((resolve) => {
    release = resolve
  })
  const { service: created, host } = service({
    installBundle: async () => await pending,
    cancelInstall: async (requestId) => {
      cancelled.push(requestId)
      return true
    },
  })

  const reply = (await host.call('plugin.install', { spec: 'acme' })) as { opId: string }
  const cancelReply = (await host.call('plugin.op.cancel', { opId: reply.opId })) as Record<string, unknown>
  assert.deepEqual(cancelReply, { opId: reply.opId, cancelling: true })
  assert.deepEqual(cancelled, [reply.opId])

  release?.({ changed: false, application: 'cancelled', stage: 'install', target: 'acme' })
  const settled = await created.waitForOp(reply.opId)
  assert.equal((settled.result as Record<string, unknown>)['application'], 'cancelled')
  assert.equal(settled.phase, 'settled')
})

test('cancelling an unknown operation answers instead of throwing', async () => {
  const { host } = service()
  assert.deepEqual(await host.call('plugin.op.cancel', { opId: 'op-nope' }), {
    opId: 'op-nope',
    cancelling: false,
  })
})

test('retained operations stay bounded so a long session cannot grow forever', async () => {
  const { service: created, host } = service(
    { removeBundle: async () => ({ changed: false, application: 'failed', stage: 'remove', target: 'acme' }) },
    { maxRetainedOps: 3 },
  )
  for (let index = 0; index < 6; index += 1) {
    const reply = (await host.call('plugin.remove', { name: 'acme' })) as { opId: string }
    await created.waitForOp(reply.opId)
  }
  assert.equal(created.ops().length, 3)
})

test('dispose unregisters every method and stops emitting', async () => {
  let release: ((value: unknown) => void) | undefined
  const pending = new Promise<unknown>((resolve) => {
    release = resolve
  })
  const host = fakeHost()
  const created = createPluginService({
    manager: manager({ installBundle: async () => await pending }),
    host: host.port,
  })
  created.attach()
  const reply = (await host.call('plugin.install', { spec: 'acme' })) as { opId: string }

  created.dispose()
  assert.deepEqual(host.registered(), [])
  const before = host.events.length
  release?.({ changed: true, application: 'applied', stage: 'install', target: 'acme' })
  await created.waitForOp(reply.opId)
  assert.equal(host.events.length, before, 'a disposed service must stay silent')
})

// ---------------------------------------------------------------------------
// Slot contract: duplicates, disposal, and the JSON-safe projection
// ---------------------------------------------------------------------------

test('a duplicate slot id is refused and the first registration survives', () => {
  const slots = createSlotRegistry()
  const first = slots.register('conversation.settings.form', {
    id: 'acme.panel',
    render: () => 'first',
  })
  assert.equal(first.ok, true)

  const second = slots.register('conversation.settings.form', {
    id: 'acme.panel',
    render: () => 'second',
  })
  assert.equal(second.ok, false)
  if (second.ok) throw new Error('unreachable')
  assert.equal(second.refusal.reason, 'duplicate')
  assert.match(second.refusal.issues[0]?.message ?? '', /acme\.panel/)

  assert.equal(slots.size(), 1)
  assert.equal(slots.get('conversation.settings.form', 'acme.panel')?.render?.({}), 'first')
})

test('disposing a slot removes only that slot and leaves the rest alone', () => {
  const slots = createSlotRegistry()
  const a = slots.register('conversation.settings.form', { id: 'acme.a', render: () => 'a' })
  const b = slots.register('conversation.settings.form', { id: 'acme.b', render: () => 'b' })
  if (!a.ok || !b.ok) throw new Error('registration should succeed')

  a.registration.dispose()
  a.registration.dispose() // idempotent
  assert.equal(slots.has('conversation.settings.form', 'acme.a'), false)
  assert.equal(slots.has('conversation.settings.form', 'acme.b'), true)
  assert.deepEqual(
    slots.contributions('conversation.settings.form').map((slot) => slot.id),
    ['acme.b'],
  )

  // A stale disposer must not delete a slot that was re-registered later.
  const again = slots.register('conversation.settings.form', { id: 'acme.a', render: () => 'a2' })
  if (!again.ok) throw new Error('re-registration should succeed')
  a.registration.dispose()
  assert.equal(slots.get('conversation.settings.form', 'acme.a')?.render?.({}), 'a2')
})

test('slot.list projects functions out and reports the web entry tri-state', async () => {
  const host = fakeHost()
  const slots = createSlotRegistry()
  const created = createPluginService({
    manager: manager(),
    host: host.port,
    slots,
  })
  created.attach()

  slots.register('conversation.settings.form', {
    id: 'acme.panel',
    title: 'Acme',
    order: 20,
    render: () => 'x',
    client: { webEntry: 'https://example.com/acme' },
  })
  slots.register('conversation.settings.form', { id: 'acme.plain', schema: { fields: [] } })
  slots.register('conversation.settings.form', {
    id: 'acme.none',
    render: () => 'x',
    client: { webEntry: null },
  })

  const reply = (await host.call('slot.list', { surface: 'conversation.settings.form' })) as {
    contributions: Record<string, unknown>[]
  }
  // JSON round-trip must not lose or throw on anything: QML receives plain values.
  const projected = JSON.parse(JSON.stringify(reply)) as { contributions: Record<string, unknown>[] }
  assert.equal(projected.contributions.length, 3)

  const byId = new Map(projected.contributions.map((slot) => [slot['id'], slot]))
  assert.equal(byId.get('acme.panel')?.['hasRender'], true)
  assert.equal(byId.get('acme.plain')?.['hasRender'], false)
  assert.equal(byId.get('acme.plain')?.['hasSchema'], true)
  assert.equal('render' in (byId.get('acme.panel') ?? {}), false, 'a function must never cross the bridge')

  assert.deepEqual(byId.get('acme.panel')?.['webEntry'], { kind: 'declared', url: 'https://example.com/acme' })
  assert.deepEqual(byId.get('acme.none')?.['webEntry'], { kind: 'none' })
  // Undeclared is not "none": an older plugin simply never said.
  assert.deepEqual(byId.get('acme.plain')?.['webEntry'], { kind: 'undeclared' })
})

test('registering and removing slots notifies Qt so it can re-list', async () => {
  const host = fakeHost()
  const slots = createSlotRegistry()
  const created = createPluginService({ manager: manager(), host: host.port, slots })
  created.attach()

  const registered = slots.register('conversation.settings.form', { id: 'acme.panel', render: () => 'x' })
  if (!registered.ok) throw new Error('registration should succeed')
  assert.deepEqual(host.events.map((event) => event.name), ['slot.changed'])

  host.clear()
  registered.registration.dispose()
  assert.deepEqual(host.events.map((event) => event.name), ['slot.changed'])
})

// ---------------------------------------------------------------------------
// ui.render / ui.action
// ---------------------------------------------------------------------------

test('ui.render converts a slot tree and ui.action re-renders with the new props', async () => {
  const host = fakeHost()
  const slots = createSlotRegistry()
  const created = createPluginService({ manager: manager(), host: host.port, slots })
  created.attach()

  slots.register('conversation.settings.form', {
    id: 'acme.counter',
    render: (props: Record<string, unknown>) => ({
      type: 'button',
      props: { onClick: { handler: 'bump' } },
      children: [`count ${String(props['count'] ?? 0)}`],
    }),
    action: (_event: string, _payload: unknown, props: Record<string, unknown>) => ({
      count: Number(props['count'] ?? 0) + 1,
    }),
  })

  const first = (await host.call('ui.render', { slotId: 'acme.counter' })) as Record<string, unknown>
  assert.equal(first['status'], 'native')
  assert.deepEqual((first['tree'] as Record<string, unknown>)['label'], 'count 0')

  const second = (await host.call('ui.action', {
    slotId: 'acme.counter',
    event: 'click',
    payload: { at: 1 },
  })) as Record<string, unknown>
  assert.equal(second['status'], 'native')
  assert.deepEqual((second['tree'] as Record<string, unknown>)['label'], 'count 1')
})

test('an unknown control type is reported and falls back instead of rendering blank', async () => {
  const host = fakeHost()
  const slots = createSlotRegistry()
  const created = createPluginService({ manager: manager(), host: host.port, slots })
  created.attach()

  slots.register('conversation.settings.form', { id: 'acme.chart', uiType: 'chart', render: () => 'x' })

  const result = (await host.call('ui.render', { slotId: 'acme.chart' })) as Record<string, unknown>
  assert.equal(result['status'], 'text')
  assert.deepEqual(
    host.events.filter((event) => event.name === 'ui.unsupported').map((event) => event.payload),
    [{ slotId: 'acme.chart', type: 'chart' }],
  )
})

test('rendering an unknown slot names the slot rather than returning an empty tree', async () => {
  const { host } = service()
  await assert.rejects(host.call('ui.render', { slotId: 'nope' }), /unknown-slot/)
})
