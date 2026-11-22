// slots.ts — the `conversation.settings.form` (and `...section`) handler.
//
// t19 taught the settings panel to *host* slot contributions: it renders a
// `conversation.settings.section` contribution as a tab and a
// `conversation.settings.form` contribution as a block inside the tab named by
// its `section` field. What was still missing is the other half of that
// contract — the part that decides whether an incoming contribution is legal
// before the panel tries to draw it.
//
// That is this module. A plugin hands over an untrusted object; the registry
// either accepts it as a typed `SettingsSlotContribution` or refuses it with
// per-field issues. Nothing here touches QML: the panel reads a plain snapshot,
// and the refusal path is testable in Node.

import { SETTINGS_SLOT_SURFACES, type SettingsSlotSurface } from '../constants.js'
import { validateSchemaSet, type SettingsSchema, type SettingsSchemaSet } from './schema.js'
import {
  describeSetting,
  humaniseSettingName,
  type SettingsFieldDescriptor
} from './forms.js'

/** Surface whose contributions become extra tabs in the settings pane. */
export const SETTINGS_SECTION_SURFACE: SettingsSlotSurface = SETTINGS_SLOT_SURFACES[0]

/** Surface whose contributions become form blocks inside an existing tab. */
export const SETTINGS_FORM_SURFACE: SettingsSlotSurface = SETTINGS_SLOT_SURFACES[1]

/** Tab a form lands in when the contribution names no `section`. */
export const DEFAULT_FORM_SECTION = 'plugins'

/** Contribution ids are used as object keys and objectNames, so keep them tame. */
const CONTRIBUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** One problem with an incoming contribution. */
export interface SettingsSlotIssue {
  /** Dotted path into the contribution, e.g. `schema.0.ui.type`. */
  readonly path: string
  /** What is wrong, in one sentence. */
  readonly message: string
}

/**
 * A validated contribution, as the panel consumes it.
 *
 * `surface` is filled in by the registry: a contribution does not get to decide
 * where it appears, only the surface it was registered against does.
 */
export interface SettingsSlotContribution {
  /** Stable id, unique within its surface. */
  readonly surface: SettingsSlotSurface
  /** Stable id, unique within its surface. */
  readonly id: string
  /** Tab the contribution belongs to; meaningful for forms. */
  readonly section: string
  /** Sort key, lower first; ties keep registration order. */
  readonly order: number
  /** Heading shown above the contribution. */
  readonly title: string
  /** Optional one-line explanation. */
  readonly description: string
  /** A QML Component to instantiate, when the contribution supplies one. */
  readonly component: unknown
  /** A QML URL to load, when the contribution supplies one instead. */
  readonly url: string
  /** Settings the plugin wants rendered by the built-in form generator. */
  readonly schema: SettingsSchemaSet
  /** Extra properties assigned onto the loaded item. */
  readonly properties: Readonly<Record<string, unknown>>
}

/** Result of normalising one contribution. */
export type SettingsSlotNormalisation =
  | { readonly ok: true; readonly contribution: SettingsSlotContribution }
  | { readonly ok: false; readonly issues: readonly SettingsSlotIssue[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issue(path: string, message: string): SettingsSlotIssue {
  return { path, message }
}

/**
 * Validate one contribution against the settings slot contract.
 *
 * A contribution must be *renderable*: a `component`, a `url`, or a `schema`
 * the built-in generator can turn into controls. Anything else would produce a
 * tab that renders nothing, which reads as a bug to the user rather than as an
 * empty plugin.
 */
export function normaliseSettingsSlotContribution(
  surface: SettingsSlotSurface,
  input: unknown
): SettingsSlotNormalisation {
  if (!isRecord(input)) {
    return { ok: false, issues: [issue('', 'a contribution must be an object')] }
  }

  const issues: SettingsSlotIssue[] = []

  const rawId = input['id']
  const id = typeof rawId === 'string' ? rawId.trim() : ''
  if (id.length === 0) {
    issues.push(issue('id', 'id must be a non-empty string'))
  } else if (!CONTRIBUTION_ID_PATTERN.test(id)) {
    issues.push(issue('id', 'id may only contain letters, digits, dot, dash and underscore'))
  }

  const rawSection = input['section']
  let section = DEFAULT_FORM_SECTION
  if (rawSection !== undefined && rawSection !== null) {
    if (typeof rawSection !== 'string' || rawSection.trim().length === 0) {
      issues.push(issue('section', 'section must be a non-empty string when present'))
    } else {
      section = rawSection.trim()
    }
  }

  const rawOrder = input['order']
  let order = 0
  if (rawOrder !== undefined && rawOrder !== null) {
    if (typeof rawOrder !== 'number' || !Number.isFinite(rawOrder)) {
      issues.push(issue('order', 'order must be a finite number when present'))
    } else {
      order = rawOrder
    }
  }

  const rawTitle = input['title']
  let title = humaniseSettingName(id.length > 0 ? id : 'plugin')
  if (rawTitle !== undefined && rawTitle !== null) {
    if (typeof rawTitle !== 'string') {
      issues.push(issue('title', 'title must be a string when present'))
    } else {
      title = rawTitle
    }
  }

  const rawDescription = input['description']
  let description = ''
  if (rawDescription !== undefined && rawDescription !== null) {
    if (typeof rawDescription !== 'string') {
      issues.push(issue('description', 'description must be a string when present'))
    } else {
      description = rawDescription
    }
  }

  const component = input['component'] ?? null
  const rawUrl = input['url']
  let url = ''
  if (rawUrl !== undefined && rawUrl !== null) {
    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
      issues.push(issue('url', 'url must be a non-empty string when present'))
    } else {
      url = rawUrl.trim()
    }
  }

  // Schema: entries are validated by schema.ts, not re-implemented here.
  const rawSchema = input['schema']
  let schema: SettingsSchemaSet = []
  if (rawSchema !== undefined && rawSchema !== null) {
    if (!Array.isArray(rawSchema)) {
      issues.push(issue('schema', 'schema must be an array of setting entries'))
    } else {
      const entries: SettingsSchema[] = []
      for (let index = 0; index < rawSchema.length; index += 1) {
        const entry = rawSchema[index]
        if (isRecord(entry)) entries.push(entry as unknown as SettingsSchema)
        else issues.push(issue(`schema.${String(index)}`, 'a setting entry must be an object'))
      }
      for (const problem of validateSchemaSet(entries)) {
        issues.push(issue(`schema.${problem.path}`, problem.message))
      }
      schema = entries
    }
  }

  const rawProperties = input['properties']
  let properties: Record<string, unknown> = {}
  if (rawProperties !== undefined && rawProperties !== null) {
    if (!isRecord(rawProperties)) {
      issues.push(issue('properties', 'properties must be an object when present'))
    } else {
      properties = { ...rawProperties }
    }
  }

  const hasComponent = component !== null && component !== undefined
  const hasUrl = url.length > 0
  const hasSchema = schema.length > 0
  if (!hasComponent && !hasUrl && !hasSchema) {
    issues.push(issue('', 'a contribution needs a component, a url or a schema to render'))
  }

  if (issues.length > 0) return { ok: false, issues }

  return {
    ok: true,
    contribution: {
      surface,
      id,
      section,
      order,
      title,
      description,
      component,
      url,
      schema,
      properties
    }
  }
}

/** Accepted registration, with the disposer a plugin keeps. */
export interface SettingsSlotRegistration {
  /** The stored contribution. */
  readonly contribution: SettingsSlotContribution
  /** Remove the contribution again; safe to call twice. */
  dispose(): void
}

/** Refused registration. */
export interface SettingsSlotRefusal {
  /** Why it was refused. */
  readonly issues: readonly SettingsSlotIssue[]
}

/** Result of `SettingsSlotRegistry.register`. */
export type SettingsSlotRegisterResult =
  | ({ readonly ok: true } & SettingsSlotRegistration)
  | ({ readonly ok: false } & SettingsSlotRefusal)

/**
 * Registry of settings contributions, keyed by `surface:id`.
 *
 * Ordering rule: `contributions()` sorts by `order` and then by registration
 * sequence, which is what the QML side needs to stay stable between renders —
 * `Array.prototype.sort` is not guaranteed stable on every Qt build, so the
 * sequence number is an explicit tie-breaker rather than a hope.
 */
export class SettingsSlotRegistry {
  private readonly entries_ = new Map<string, { contribution: SettingsSlotContribution; sequence: number }>()
  private sequence_ = 0

  private static keyFor(surface: string, id: string): string {
    return `${surface}:${id}`
  }

  /**
   * Register a contribution.
   *
   * A duplicate id on the same surface is refused rather than silently
   * replacing: two plugins claiming one id is a bug worth surfacing, and the
   * alternative (last writer wins) makes it depend on load order.
   */
  register(surface: SettingsSlotSurface, input: unknown): SettingsSlotRegisterResult {
    const normalised = normaliseSettingsSlotContribution(surface, input)
    if (!normalised.ok) return { ok: false, issues: normalised.issues }

    const key = SettingsSlotRegistry.keyFor(surface, normalised.contribution.id)
    if (this.entries_.has(key)) {
      return {
        ok: false,
        issues: [issue('id', `a contribution with id ${normalised.contribution.id} already exists on ${surface}`)]
      }
    }

    this.sequence_ += 1
    const record = { contribution: normalised.contribution, sequence: this.sequence_ }
    this.entries_.set(key, record)

    let disposed = false
    return {
      ok: true,
      contribution: normalised.contribution,
      dispose: () => {
        if (disposed) return
        disposed = true
        if (this.entries_.get(key) === record) this.entries_.delete(key)
      }
    }
  }

  /** Remove a contribution; true when something was removed. */
  remove(surface: SettingsSlotSurface, id: string): boolean {
    return this.entries_.delete(SettingsSlotRegistry.keyFor(surface, id))
  }

  /** True when this surface already holds this id. */
  has(surface: SettingsSlotSurface, id: string): boolean {
    return this.entries_.has(SettingsSlotRegistry.keyFor(surface, id))
  }

  /** Contributions for one surface, in render order. */
  contributions(surface: SettingsSlotSurface): SettingsSlotContribution[] {
    const collected: { contribution: SettingsSlotContribution; sequence: number }[] = []
    for (const record of this.entries_.values()) {
      if (record.contribution.surface === surface) collected.push(record)
    }
    collected.sort((left, right) => {
      if (left.contribution.order !== right.contribution.order) {
        return left.contribution.order - right.contribution.order
      }
      return left.sequence - right.sequence
    })
    return collected.map((record) => record.contribution)
  }

  /**
   * `conversation.settings.form` contributions for one tab.
   *
   * A form that names no section goes to `plugins` — decided here rather than
   * in QML so both renderers agree, and so it is unit-testable.
   */
  formsFor(section: string): SettingsSlotContribution[] {
    const wanted = section.length > 0 ? section : DEFAULT_FORM_SECTION
    return this.contributions(SETTINGS_FORM_SURFACE).filter(
      (contribution) => contribution.section === wanted
    )
  }

  /** Extra tabs requested by plugins, in render order. */
  sectionTabs(): SettingsSlotContribution[] {
    return this.contributions(SETTINGS_SECTION_SURFACE)
  }

  /** Tab ids that plugin contributions want the panel to show. */
  requestedSections(): string[] {
    const seen = new Set<string>()
    const ordered: string[] = []
    for (const contribution of this.contributions(SETTINGS_FORM_SURFACE)) {
      if (seen.has(contribution.section)) continue
      seen.add(contribution.section)
      ordered.push(contribution.section)
    }
    return ordered
  }

  /** Total contributions, or those of one surface. */
  size(surface?: SettingsSlotSurface): number {
    if (surface === undefined) return this.entries_.size
    let count = 0
    for (const record of this.entries_.values()) {
      if (record.contribution.surface === surface) count += 1
    }
    return count
  }

  /** Drop everything; used when the hosting plugin unloads. */
  clear(): void {
    this.entries_.clear()
    this.sequence_ = 0
  }
}

/** Convenience constructor. */
export function createSettingsSlotRegistry(): SettingsSlotRegistry {
  return new SettingsSlotRegistry()
}

/**
 * Turn a schema-only contribution into renderable descriptors.
 *
 * A plugin can ship settings without shipping a single line of QML: declare the
 * entries, and the panel draws the same controls the built-in catalogue uses.
 */
export function settingsFormFields(contribution: SettingsSlotContribution): SettingsFieldDescriptor[] {
  const fields: SettingsFieldDescriptor[] = []
  for (const entry of contribution.schema) fields.push(describeSetting(entry))
  return fields
}

/** True when the contribution wants the built-in generator rather than QML. */
export function usesGeneratedForm(contribution: SettingsSlotContribution): boolean {
  if (contribution.schema.length === 0) return false
  return contribution.component === null || contribution.component === undefined
}
