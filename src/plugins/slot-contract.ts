/**
 * The unified slot contract (I4, plan §I4 "src/plugins/slot-contract.ts").
 *
 * Two shapes existed before this file: `QtSlotContribution` in `src/types.ts`
 * (surface/id/label/icon/render, with `render` never called by anyone) and
 * `SettingsSlotContribution` in `src/settings/slots.ts` (component/url/schema,
 * the one the QML panel actually reads). A plugin could satisfy one and be
 * invisible to the other. This contract is the single shape both sides agree on:
 * it keeps the settings fields, adds the render function that makes limited
 * conversion possible, and adds the `client.webEntry` declaration the fallback
 * decision needs.
 *
 * Two behaviours are load-bearing and easy to get wrong:
 *  - A duplicate id on the same surface is *refused*, never overwritten. Two
 *    plugins that both claim `acme.panel` must not silently shadow each other.
 *  - `dispose()` removes a registration only if the record still belongs to it,
 *    so a stale disposer from an unloaded plugin cannot delete a live one that
 *    re-used the id.
 */

/** Ids a slot may carry; same shape the settings registry already enforces. */
export const SLOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface SlotIssue {
  readonly path: string
  readonly message: string
}

/**
 * Whether a slot ships a web build, declared as a tri-state on purpose:
 *  - the field is absent  → the plugin never said (an older or unknown SDK)
 *  - the field is `null`  → the plugin explicitly has no web build
 *  - the field is a URL   → the plugin can be opened in the WebUI
 *
 * "Absent" must not be read as "none": that would send a plugin that does have a
 * web build down the text fallback and lose functionality.
 */
export type SlotWebEntry =
  | { readonly kind: 'declared'; readonly url: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'undeclared' }

export interface SlotClientDeclaration {
  readonly webEntry?: string | null
}

export interface SlotContributionInput {
  readonly id: string
  readonly title?: string
  readonly description?: string
  readonly order?: number
  readonly section?: string
  readonly label?: string
  readonly icon?: string
  /** Renders the slot; its return value is what the converter consumes. */
  readonly render?: (props: Record<string, unknown>) => unknown
  /** Handles an action routed back from QML; returns the next props, if any. */
  readonly action?: (
    event: string,
    payload: unknown,
    props: Record<string, unknown>,
  ) => Record<string, unknown> | void
  /** A QML component handed over by a native plugin (opaque to this package). */
  readonly component?: unknown
  /** A QML file URL, for slots that ship their own view. */
  readonly url?: string
  /** An optional author-declared form schema; not a conversion path. */
  readonly schema?: unknown
  readonly properties?: Record<string, unknown>
  /** Settings control type, when the slot is a single generated control. */
  readonly uiType?: string
  readonly client?: SlotClientDeclaration
}

export interface NormalisedSlot {
  readonly id: string
  readonly title?: string
  readonly description?: string
  readonly order: number
  readonly section?: string
  readonly label?: string
  readonly icon?: string
  readonly render?: (props: Record<string, unknown>) => unknown
  readonly action?: (
    event: string,
    payload: unknown,
    props: Record<string, unknown>,
  ) => Record<string, unknown> | void
  readonly component?: unknown
  readonly url?: string
  readonly schema?: unknown
  readonly properties?: Record<string, unknown>
  readonly uiType?: string
  readonly client?: SlotClientDeclaration
}

export interface SlotContribution extends NormalisedSlot {
  readonly surface: string
  /** Registration order, used as the tie-break when two slots share `order`. */
  readonly sequence: number
}

export type SlotNormalisation =
  | { readonly ok: true; readonly value: NormalisedSlot }
  | { readonly ok: false; readonly issues: SlotIssue[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate and default one contribution. The one hard requirement is that the
 * slot has *something* to render: a render function, a QML component, a URL, or
 * a schema. A slot with none of those would occupy a place in the panel and show
 * nothing, which is worse than being refused.
 */
export function normaliseSlotContribution(surface: string, input: unknown): SlotNormalisation {
  const issues: SlotIssue[] = []
  if (typeof surface !== 'string' || surface.length === 0) {
    issues.push({ path: 'surface', message: 'a slot needs a surface name' })
  }
  if (!isRecord(input)) {
    issues.push({ path: '$', message: 'a slot contribution must be an object' })
    return { ok: false, issues }
  }

  const id = input['id']
  if (typeof id !== 'string' || id.length === 0) {
    issues.push({ path: 'id', message: 'a slot contribution needs an id' })
  } else if (!SLOT_ID_PATTERN.test(id)) {
    issues.push({
      path: 'id',
      message: `slot id "${id}" must match ${SLOT_ID_PATTERN.source}`,
    })
  }

  const order = input['order']
  if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) {
    issues.push({ path: 'order', message: 'order must be a finite number' })
  }

  for (const key of ['title', 'description', 'section', 'label', 'icon', 'url', 'uiType'] as const) {
    const value = input[key]
    if (value !== undefined && typeof value !== 'string') {
      issues.push({ path: key, message: `${key} must be a string` })
    }
  }

  const render = input['render']
  if (render !== undefined && typeof render !== 'function') {
    issues.push({ path: 'render', message: 'render must be a function' })
  }
  const action = input['action']
  if (action !== undefined && typeof action !== 'function') {
    issues.push({ path: 'action', message: 'action must be a function' })
  }
  const properties = input['properties']
  if (properties !== undefined && !isRecord(properties)) {
    issues.push({ path: 'properties', message: 'properties must be an object' })
  }
  const client = input['client']
  if (client !== undefined && !isRecord(client)) {
    issues.push({ path: 'client', message: 'client must be an object' })
  } else if (isRecord(client)) {
    const webEntry = client['webEntry']
    if (webEntry !== undefined && webEntry !== null && typeof webEntry !== 'string') {
      issues.push({ path: 'client.webEntry', message: 'client.webEntry must be a URL, null or absent' })
    } else if (typeof webEntry === 'string' && webEntry.length === 0) {
      issues.push({ path: 'client.webEntry', message: 'client.webEntry must not be an empty string' })
    }
  }

  const hasRender = typeof render === 'function'
  const hasComponent = input['component'] !== undefined
  const hasUrl = typeof input['url'] === 'string' && input['url'].length > 0
  const hasSchema = input['schema'] !== undefined
  if (!hasRender && !hasComponent && !hasUrl && !hasSchema) {
    issues.push({
      path: '$',
      message: 'a slot needs a render function, a component, a url or a schema to render',
    })
  }

  if (issues.length > 0) return { ok: false, issues }

  const value: NormalisedSlot = {
    id: id as string,
    order: typeof order === 'number' ? order : 0,
    ...(typeof input['title'] === 'string' ? { title: input['title'] } : {}),
    ...(typeof input['description'] === 'string' ? { description: input['description'] } : {}),
    ...(typeof input['section'] === 'string' ? { section: input['section'] } : {}),
    ...(typeof input['label'] === 'string' ? { label: input['label'] } : {}),
    ...(typeof input['icon'] === 'string' ? { icon: input['icon'] } : {}),
    ...(hasRender ? { render: render as (props: Record<string, unknown>) => unknown } : {}),
    ...(typeof action === 'function'
      ? {
          action: action as (
            event: string,
            payload: unknown,
            props: Record<string, unknown>,
          ) => Record<string, unknown> | void,
        }
      : {}),
    ...(hasComponent ? { component: input['component'] } : {}),
    ...(hasUrl ? { url: input['url'] as string } : {}),
    ...(hasSchema ? { schema: input['schema'] } : {}),
    ...(isRecord(properties) ? { properties } : {}),
    ...(typeof input['uiType'] === 'string' ? { uiType: input['uiType'] } : {}),
    ...(isRecord(client) ? { client: client as SlotClientDeclaration } : {}),
  }
  return { ok: true, value }
}

/**
 * Read the web-entry declaration without collapsing "absent" into "none".
 * `Object.hasOwn` is the only correct test here: `=== undefined` cannot tell an
 * explicit `undefined` from a missing key, and a prototype-inherited value must
 * not count as a declaration either.
 */
export function readWebEntry(contribution: {
  readonly client?: SlotClientDeclaration | undefined
}): SlotWebEntry {
  const client = contribution.client
  if (client === undefined || !Object.hasOwn(client, 'webEntry')) return { kind: 'undeclared' }
  const webEntry = client.webEntry
  if (webEntry === null) return { kind: 'none' }
  if (typeof webEntry === 'string' && webEntry.length > 0) return { kind: 'declared', url: webEntry }
  return { kind: 'undeclared' }
}

export interface SlotRefusal {
  readonly surface: string
  readonly id: string
  readonly reason: 'invalid' | 'duplicate'
  readonly issues: SlotIssue[]
}

export interface SlotRegistration {
  readonly contribution: SlotContribution
  /** Safe to call more than once; only removes the record it created. */
  dispose(): void
}

export type SlotRegisterResult =
  | { readonly ok: true; readonly registration: SlotRegistration }
  | { readonly ok: false; readonly refusal: SlotRefusal }

export interface SlotRegistryOptions {
  /** Called after every mutation so the host can tell Qt to re-list. */
  readonly onChange?: (() => void) | undefined
}

/**
 * Ordered, duplicate-free slot store. Ordering is `order` first and registration
 * sequence second — `Array.prototype.sort` is not stable on every Qt-supported
 * JavaScript engine, so the tie-break is explicit rather than inherited.
 */
export class SlotRegistry {
  private readonly records = new Map<string, { contribution: SlotContribution; token: object }>()
  private readonly onChange: (() => void) | undefined
  private readonly listeners = new Set<() => void>()
  private sequence = 0

  constructor(options: SlotRegistryOptions = {}) {
    this.onChange = options.onChange
  }

  /**
   * Observe mutations. The bridge subscribes here so a plugin registering a slot
   * after startup still reaches Qt; the constructor option alone would only work
   * for whoever built the registry.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    this.onChange?.()
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // One bad listener must not stop the others from re-listing.
      }
    }
  }

  private static key(surface: string, id: string): string {
    return `${surface}:${id}`
  }

  register(surface: string, input: unknown): SlotRegisterResult {
    const normalised = normaliseSlotContribution(surface, input)
    if (!normalised.ok) {
      const id = isRecord(input) && typeof input['id'] === 'string' ? input['id'] : ''
      return { ok: false, refusal: { surface, id, reason: 'invalid', issues: normalised.issues } }
    }

    const key = SlotRegistry.key(surface, normalised.value.id)
    if (this.records.has(key)) {
      return {
        ok: false,
        refusal: {
          surface,
          id: normalised.value.id,
          reason: 'duplicate',
          issues: [
            {
              path: 'id',
              message: `a slot with id ${normalised.value.id} already exists on ${surface}`,
            },
          ],
        },
      }
    }

    this.sequence += 1
    const contribution: SlotContribution = {
      ...normalised.value,
      surface,
      sequence: this.sequence,
    }
    const token = {}
    this.records.set(key, { contribution, token })
    this.notify()

    let disposed = false
    return {
      ok: true,
      registration: {
        contribution,
        dispose: () => {
          if (disposed) return
          disposed = true
          const current = this.records.get(key)
          // Only drop the record this registration created: a stale disposer must
          // not delete a live slot that re-used the same id.
          if (current !== undefined && current.token === token) {
            this.records.delete(key)
            this.notify()
          }
        },
      },
    }
  }

  remove(surface: string, id: string): boolean {
    const key = SlotRegistry.key(surface, id)
    if (!this.records.has(key)) return false
    this.records.delete(key)
    this.notify()
    return true
  }

  has(surface: string, id: string): boolean {
    return this.records.has(SlotRegistry.key(surface, id))
  }

  get(surface: string, id: string): SlotContribution | undefined {
    return this.records.get(SlotRegistry.key(surface, id))?.contribution
  }

  /** Look a slot up by id alone, for `ui.render` which has no surface in hand. */
  byId(id: string): SlotContribution | undefined {
    for (const record of this.records.values()) {
      if (record.contribution.id === id) return record.contribution
    }
    return undefined
  }

  contributions(surface: string): SlotContribution[] {
    const matching: SlotContribution[] = []
    for (const record of this.records.values()) {
      if (record.contribution.surface === surface) matching.push(record.contribution)
    }
    matching.sort((left, right) => {
      if (left.order !== right.order) return left.order - right.order
      return left.sequence - right.sequence
    })
    return matching
  }

  /** Every contribution on every surface, in surface then order order. */
  all(): SlotContribution[] {
    const surfaces = this.surfaces()
    const collected: SlotContribution[] = []
    for (const surface of surfaces) collected.push(...this.contributions(surface))
    return collected
  }

  surfaces(): string[] {
    const names = new Set<string>()
    for (const record of this.records.values()) names.add(record.contribution.surface)
    return [...names].sort()
  }

  size(): number {
    return this.records.size
  }

  clear(): void {
    if (this.records.size === 0) return
    this.records.clear()
    this.notify()
  }
}

export function createSlotRegistry(options: SlotRegistryOptions = {}): SlotRegistry {
  return new SlotRegistry(options)
}
