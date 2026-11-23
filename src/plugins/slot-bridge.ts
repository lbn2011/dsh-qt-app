/**
 * Mirror `ctx.qtRenderer` slot contributions into the plugin slot registry.
 *
 * `QtRendererService.registerSlot` is how native packages hand the host a slot
 * with a render function. The settings panel and `ui.render` / `ui.action` read
 * `SlotRegistry`, which only `ui.register` could fill — and an RPC frame cannot
 * carry functions. This bridge is the one path that lets a render callback reach
 * the converter, so a plugin registering at load time and one registering after
 * startup both end up visible to QML.
 */
import type { QtSlotContribution } from '../types.js'
import type { SlotRegistry } from './slot-contract.js'

/** The slice of `QtRendererService` this bridge needs. */
export interface RendererSlotSource {
  readonly slots: Map<string, QtSlotContribution>
  subscribeSlots(listener: () => void): () => void
}

function key(surface: string, id: string): string {
  return `${surface}:${id}`
}

/**
 * Start mirroring. Returns a disposer that stops observing and removes every
 * registration this bridge created.
 */
export function mirrorRendererSlots(source: RendererSlotSource, registry: SlotRegistry): () => void {
  const disposers = new Map<string, () => void>()

  const sync = (): void => {
    const live = new Set<string>()
    for (const contribution of source.slots.values()) {
      const slotKey = key(contribution.surface, contribution.id)
      live.add(slotKey)
      if (disposers.has(slotKey)) continue
      const result = registry.register(contribution.surface, {
        id: contribution.id,
        ...(contribution.label === undefined ? {} : { label: contribution.label }),
        ...(contribution.icon === undefined ? {} : { icon: contribution.icon }),
        ...(contribution.render === undefined ? {} : { render: contribution.render }),
        ...(contribution.action === undefined ? {} : { action: contribution.action }),
      })
      // `dispose` is idempotent and only removes the record it created, so a
      // slot that re-registers under the same id keeps the live contribution.
      if (result.ok) disposers.set(slotKey, () => result.registration.dispose())
    }
    for (const [slotKey, dispose] of [...disposers]) {
      if (live.has(slotKey)) continue
      dispose()
      disposers.delete(slotKey)
    }
  }

  sync()
  const unsubscribe = source.subscribeSlots(sync)
  return () => {
    unsubscribe()
    for (const dispose of disposers.values()) dispose()
    disposers.clear()
  }
}
