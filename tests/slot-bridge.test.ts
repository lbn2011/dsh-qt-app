/**
 * `mirrorRendererSlots` is the only path that carries a plugin's render
 * callback from `ctx.qtRenderer` into the slot registry read by `ui.render`.
 * These cases pin the two failure modes that would otherwise be silent: a
 * contribution registered after startup never reaching QML, and a removed
 * contribution lingering as a dead slot.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createSlotRegistry } from '../src/plugins/slot-contract.js'
import { mirrorRendererSlots } from '../src/plugins/slot-bridge.js'
import type { QtSlotContribution } from '../src/types.js'

class FakeRenderer {
  readonly slots = new Map<string, QtSlotContribution>()
  private readonly listeners = new Set<() => void>()

  subscribeSlots(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  add(contribution: QtSlotContribution): void {
    this.slots.set(`${contribution.surface}:${contribution.id}`, contribution)
    for (const listener of [...this.listeners]) listener()
  }

  remove(surface: string, id: string): void {
    this.slots.delete(`${surface}:${id}`)
    for (const listener of [...this.listeners]) listener()
  }
}

const TREE = { type: 'button', props: { onClick: () => undefined }, children: [] }

describe('mirrorRendererSlots', () => {
  it('mirrors contributions that exist before the mirror starts', () => {
    const renderer = new FakeRenderer()
    renderer.slots.set('conversation.settings.form:acme', {
      surface: 'conversation.settings.form',
      id: 'acme',
      label: 'Acme',
      render: () => TREE,
    })
    const registry = createSlotRegistry()
    const dispose = mirrorRendererSlots(renderer, registry)

    const slot = registry.byId('acme')
    assert.ok(slot)
    assert.equal(slot.surface, 'conversation.settings.form')
    assert.equal(slot.label, 'Acme')
    assert.deepEqual(slot.render?.({}), TREE)
    dispose()
    assert.equal(registry.byId('acme'), undefined)
  })

  it('mirrors a contribution registered after startup and drops removals', () => {
    const renderer = new FakeRenderer()
    const registry = createSlotRegistry()
    const dispose = mirrorRendererSlots(renderer, registry)
    assert.equal(registry.byId('late'), undefined)

    renderer.add({ surface: 'conversation.chat.flow', id: 'late', render: () => ({ type: 'separator' }) })
    assert.ok(registry.byId('late'))

    renderer.remove('conversation.chat.flow', 'late')
    assert.equal(registry.byId('late'), undefined)
    dispose()
  })

  it('keeps the earlier registration when a stale disposer runs', () => {
    const renderer = new FakeRenderer()
    const registry = createSlotRegistry()
    const dispose = mirrorRendererSlots(renderer, registry)
    renderer.add({ surface: 'conversation.chat.flow', id: 'twin', render: () => TREE })

    const registration = registry.byId('twin')
    assert.ok(registration)
    // Simulate a stale disposer from a previous registration of the same id.
    const other = registry.register('conversation.chat.flow', { id: 'twin', render: () => TREE })
    assert.equal(other.ok, false)

    dispose()
    assert.equal(registry.byId('twin'), undefined)
  })
})
