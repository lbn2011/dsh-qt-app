// forms.ts — the bridge between a SettingsSchema entry and a QML control.
//
// schema.ts says what a setting *is*; this module says what a control needs in
// order to draw it. The two are kept apart on purpose:
//
//   * schema.ts stays a pure data catalogue with no UI vocabulary beyond
//     `ui.type`, so validation can be reasoned about without any view code;
//   * forms.ts flattens one entry plus one value into a plain object — no
//     classes, no methods, no getters — because that object is handed straight
//     to QML, and QML reads plain JS values far more cheaply than it does a
//     TypeScript instance propped up by a proxy.
//
// The descriptor shape below is the contract for `SettingsForm.qml`: every
// property is present on every descriptor (absent options become `null`), so a
// control can read `field.minimum` unconditionally instead of testing for
// `undefined` first. That matters in QML, where `undefined` and `null` behave
// differently in a binding and only one of them is falsy in a `Math.max`.

import {
  BUILTIN_SETTINGS,
  SETTINGS_SECTIONS,
  settingsInSection,
  validateSettingValue,
  type SettingOption,
  type SettingType,
  type SettingUiType,
  type SettingValue,
  type SettingValues,
  type SettingsSchema,
  type SettingsSchemaSet
} from './schema.js'

/** One legal choice of a `select`, flattened for QML. */
export interface SettingsFieldOption {
  /** Stored value. */
  readonly value: SettingValue
  /** Display label. */
  readonly label: string
  /** Optional one-line explanation. */
  readonly description: string
}

/**
 * Everything a form control needs to render one setting.
 *
 * Scalar fields that a control might not use are `null` rather than optional:
 * a missing minimum is genuinely "no minimum", not "unspecified", and QML binds
 * `field.minimum !== null` more reliably than a `hasOwnProperty` test.
 */
export interface SettingsFieldDescriptor {
  /** Stable dotted key; this is what a value edit is reported against. */
  readonly name: string
  /** Human label, never empty. */
  readonly label: string
  /** One-line explanation; empty when the schema has none. */
  readonly description: string
  /**
   * Where the setting belongs in the pane.
   *
   * A string rather than `SettingsSection`: the built-in catalogue uses the four
   * known sections, but a plugin may contribute a setting under its own section
   * id and have the panel grow a tab for it.
   */
  readonly section: string
  /** Declared value kind. */
  readonly valueType: SettingType
  /** Which control to draw. */
  readonly uiType: SettingUiType
  /** Current value. */
  readonly value: SettingValue
  /** Catalogue default, so a form can offer "reset to default". */
  readonly defaultValue: SettingValue
  /** Choices for a `select`; empty for every other control. */
  readonly options: readonly SettingsFieldOption[]
  /** Placeholder for text/number inputs; empty when unspecified. */
  readonly placeholder: string
  /** Display suffix such as `%`; empty when unspecified. */
  readonly unit: string
  /** Numeric lower bound, or null. */
  readonly minimum: number | null
  /** Numeric upper bound, or null. */
  readonly maximum: number | null
  /** Numeric step, or null. */
  readonly step: number | null
  /** Minimum string length, or null. */
  readonly minLength: number | null
  /** Maximum string length, or null. */
  readonly maxLength: number | null
  /** True when the value only takes effect after a restart. */
  readonly requiresRestart: boolean
  /** True when the value must never be written to disk. */
  readonly transient: boolean
  /** Sort key inside the section; lower first. */
  readonly order: number
}

/** One section of a generated form. */
export interface SettingsFormSection {
  /** Section id; one of `SETTINGS_SECTIONS` or a plugin-defined one. */
  readonly section: string
  /** Title-cased section id, for a heading. */
  readonly title: string
  /** Fields in display order. */
  readonly fields: readonly SettingsFieldDescriptor[]
}

/** Title-case a dotted key: `hideSystemMessages` → `Hide system messages`. */
export function humaniseSettingName(name: string): string {
  const spaced = name
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  if (spaced.length === 0) return name
  const lower = spaced.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/** Title-case a section id: `appearance` → `Appearance`. */
export function humaniseSection(section: string): string {
  return humaniseSettingName(section)
}

function flattenOptions(options: readonly SettingOption[] | undefined): SettingsFieldOption[] {
  if (options === undefined) return []
  const flattened: SettingsFieldOption[] = []
  for (const option of options) {
    flattened.push({
      value: option.value,
      label: option.label,
      description: option.description ?? ''
    })
  }
  return flattened
}

function numberOrNull(value: number | undefined): number | null {
  return value === undefined ? null : value
}

/**
 * Flatten one schema entry (plus its current value) into a descriptor.
 *
 * `value` defaults to the entry's own default, so a caller with no store yet —
 * a preview, a QML test, a plugin author sketching a form — gets a renderable
 * control without inventing values.
 */
export function describeSetting(entry: SettingsSchema, value?: SettingValue): SettingsFieldDescriptor {
  return {
    name: entry.name,
    label: entry.ui.label ?? humaniseSettingName(entry.name),
    description: entry.description,
    section: entry.section,
    valueType: entry.type,
    uiType: entry.ui.type,
    value: value === undefined ? entry.default : value,
    defaultValue: entry.default,
    options: flattenOptions(entry.options),
    placeholder: entry.ui.placeholder ?? '',
    unit: entry.ui.unit ?? '',
    minimum: numberOrNull(entry.minimum),
    maximum: numberOrNull(entry.maximum),
    step: numberOrNull(entry.step),
    minLength: numberOrNull(entry.minLength),
    maxLength: numberOrNull(entry.maxLength),
    requiresRestart: entry.requiresRestart === true,
    transient: entry.transient === true,
    order: entry.ui.order ?? 0
  }
}

/**
 * Flatten a whole catalogue, optionally overriding values.
 *
 * Order is declaration order, *not* `ui.order`: grouping by section is
 * `settingsFormSections`' job, and a flat list that silently re-sorts confuses
 * callers that zip it against the catalogue.
 */
export function settingsFieldDescriptors(
  schemaSet: SettingsSchemaSet = BUILTIN_SETTINGS,
  values?: Partial<SettingValues>
): SettingsFieldDescriptor[] {
  const descriptors: SettingsFieldDescriptor[] = []
  for (const entry of schemaSet) {
    const override = values === undefined ? undefined : values[entry.name]
    descriptors.push(describeSetting(entry, override))
  }
  return descriptors
}

/** Group descriptors into sections, preserving `settingsInSection` ordering. */
export function settingsFormSections(
  schemaSet: SettingsSchemaSet = BUILTIN_SETTINGS,
  values?: Partial<SettingValues>
): SettingsFormSection[] {
  const sections: SettingsFormSection[] = []
  // Known sections keep their declared order; any section a plugin invented is
  // appended in first-seen order so its tab appears rather than being dropped.
  const order: string[] = [...SETTINGS_SECTIONS]
  for (const entry of schemaSet) {
    if (!order.includes(entry.section)) order.push(entry.section)
  }
  for (const section of order) {
    const entries = settingsInSection(section, schemaSet)
    if (entries.length === 0) continue
    const fields: SettingsFieldDescriptor[] = []
    for (const entry of entries) {
      const override = values === undefined ? undefined : values[entry.name]
      fields.push(describeSetting(entry, override))
    }
    sections.push({ section, title: humaniseSection(section), fields })
  }
  return sections
}

/**
 * Coerce a value that arrived from a text control into the setting's own type.
 *
 * QML text controls hand back strings, so `"1.25"` has to become the number
 * 1.25 before it can be validated — but only for a field that really is a
 * number. Returns null when the input cannot be coerced, which the caller
 * reports as "no change" rather than storing a guess: silently turning `""` into
 * 0 is exactly the kind of coercion schema.ts refuses to do.
 */
export function coerceFieldInput(field: SettingsFieldDescriptor, raw: unknown): SettingValue | null {
  if (raw === null || raw === undefined) return null
  if (field.valueType === 'number') {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
    if (typeof raw !== 'string') return null
    const text = raw.trim()
    if (text.length === 0) return null
    const parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (field.valueType === 'boolean') {
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'number') return raw !== 0
    if (typeof raw !== 'string') return null
    const text = raw.trim().toLowerCase()
    if (text === 'true' || text === '1' || text === 'yes') return true
    if (text === 'false' || text === '0' || text === 'no') return false
    return null
  }
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return null
}

/**
 * Coerce *and* validate, so a control can hand back either a storable value or
 * the reason it was refused.
 */
export function normaliseFieldInput(
  entry: SettingsSchema,
  raw: unknown
): { readonly ok: true; readonly value: SettingValue } | { readonly ok: false; readonly message: string } {
  const descriptor = describeSetting(entry)
  const coerced = coerceFieldInput(descriptor, raw)
  if (coerced === null) {
    return { ok: false, message: `cannot read a ${entry.type} from this input` }
  }
  const validated = validateSettingValue(entry, coerced)
  if (!validated.ok) return { ok: false, message: validated.issue.message }
  return { ok: true, value: validated.value }
}

/** Display string for a field, e.g. `1.25` or `20000 ms`. */
export function formatFieldDisplay(field: SettingsFieldDescriptor, value?: SettingValue): string {
  const shown = value === undefined ? field.value : value
  if (field.uiType === 'toggle') return shown === true ? 'On' : 'Off'
  if (field.options.length > 0) {
    for (const option of field.options) {
      if (option.value === shown) return option.label
    }
  }
  const text = String(shown)
  if (field.unit.length === 0) return text
  // `%`, `px` and `ms` read as symbols and hug the number; a word unit needs a
  // space, or a long count renders as `20000chars`.
  const joinsTightly = !/^[A-Za-z]/.test(field.unit) || field.unit.length <= 2
  return joinsTightly ? `${text}${field.unit}` : `${text} ${field.unit}`
}

/** Index of `value` inside a field's options, or -1. Used to seed a ComboBox. */
export function optionIndexOf(field: SettingsFieldDescriptor, value?: SettingValue): number {
  const target = value === undefined ? field.value : value
  for (let index = 0; index < field.options.length; index += 1) {
    const option = field.options[index]
    if (option !== undefined && option.value === target) return index
  }
  return -1
}

/** The `ui.type` values `SettingsForm.qml` knows how to draw. */
export const RENDERABLE_UI_TYPES: readonly SettingUiType[] = [
  'toggle',
  'select',
  'slider',
  'number',
  'text',
  'color'
] as const

/** True when a descriptor has a dedicated QML control. */
export function isRenderableUiType(uiType: SettingUiType): boolean {
  return RENDERABLE_UI_TYPES.includes(uiType)
}
