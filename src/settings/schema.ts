// schema.ts — the settings catalogue.
//
// Every user-visible preference is declared exactly once, here. The entry is the
// single source of truth for four things at once:
//
//   * the value's type and default (so a fresh install needs no file),
//   * the legal value space (enumerated options, numeric range, string length),
//   * how the settings UI should render it (`ui.type`), and
//   * where it belongs in the pane (`section`, `order`).
//
// Validation is deliberately strict: nothing is coerced. `"1.5"` is not the
// number 1.5, `"yes"` is not `true`, and an option list is exhaustive. A caller
// that gets a value past `set()` can rely on its type — which is what lets the
// QML side bind to it without defensive casts. That mirrors the rule
// src/theme/validate.ts already applies to theme files.

/** A setting's value. Only JSON scalars, so a settings file stays diffable. */
export type SettingValue = string | number | boolean

/** Value kinds a schema entry may declare. */
export type SettingType = 'string' | 'number' | 'boolean'

/** Widget the settings pane should use for an entry. */
export type SettingUiType = 'select' | 'slider' | 'toggle' | 'text' | 'number'

/** One legal choice of a `select` entry. */
export interface SettingOption {
  /** Stored value. */
  readonly value: SettingValue
  /** Human label shown in the UI. */
  readonly label: string
  /** Optional one-line explanation shown under the label. */
  readonly description?: string
}

/**
 * How to render an entry.
 *
 * Kept as an object rather than a bare `uiType: string` because the extra keys
 * (unit, placeholder, suffix) are what the QML side actually needs, and they
 * belong next to the control they describe.
 */
export interface SettingUiDescriptor {
  /** Widget kind. */
  readonly type: SettingUiType
  /** Short label; defaults to a title-cased `name` when absent. */
  readonly label?: string
  /** Placeholder for `text` / `number` inputs. */
  readonly placeholder?: string
  /** Suffix appended to a `slider` / `number` value, e.g. "%" or "px". */
  readonly unit?: string
  /** Position inside the section; ties keep declaration order. */
  readonly order?: number
}

/**
 * One setting.
 *
 * This is the interface the task calls `SettingsSchema`: a per-setting record
 * carrying its `name`, `type`, `default`, the `options` when the value space is
 * enumerated, and the `ui` descriptor. (A *collection* of these is a
 * `SettingsSchemaSet` below — the singular name is kept because `SettingsSchema`
 * is the name the public contract uses for the entry itself.)
 */
export interface SettingsSchema {
  /** Stable dotted key, e.g. `theme`. Never localised, never renamed. */
  readonly name: string
  /** Value kind. */
  readonly type: SettingType
  /** Value used when the file has no entry. Must satisfy this very schema. */
  readonly default: SettingValue
  /** Exhaustive value space for a `select` entry (and only for one). */
  readonly options?: readonly SettingOption[]
  /** How the settings pane renders it. `ui.type` is the widget kind. */
  readonly ui: SettingUiDescriptor
  /** Pane section this belongs to. */
  readonly section: string
  /** One-line description shown to the user. */
  readonly description: string
  /** Inclusive numeric bounds, `number` entries only. */
  readonly minimum?: number
  readonly maximum?: number
  /** Numeric granularity, `number` entries only. */
  readonly step?: number
  /** Inclusive string length bounds, `string` entries only. */
  readonly minLength?: number
  readonly maxLength?: number
  /** True when the value is only read at start-up. */
  readonly requiresRestart?: boolean
  /** True when the store never persists this key (session-only). */
  readonly transient?: boolean
}

/** A keyed collection of schema entries, in declaration order. */
export type SettingsSchemaSet = readonly SettingsSchema[]

/** A validated settings map: key to value. */
export type SettingValues = Readonly<Record<string, SettingValue>>

/** Why a value was rejected. Dotted `path` is the setting name. */
export interface SettingValidationIssue {
  /** Setting name (or a nested path for schema-coherence problems). */
  readonly path: string
  /** Machine-readable reason. */
  readonly reason:
    | 'unknown-setting'
    | 'wrong-type'
    | 'not-an-option'
    | 'below-minimum'
    | 'above-maximum'
    | 'not-on-step'
    | 'too-short'
    | 'too-long'
    | 'not-finite'
  /** Human sentence, suitable for a log line or a tooltip. */
  readonly message: string
}

/** Result of validating one value against one entry. */
export type SettingValidationResult =
  | { readonly ok: true; readonly value: SettingValue }
  | { readonly ok: false; readonly issue: SettingValidationIssue }

/** Result of validating a whole settings object against the schema set. */
export interface SettingsValidationResult {
  /** Values that survived, with defaults filled in for missing keys. */
  readonly values: SettingValues
  /** Keys the schema does not know; preserved on save, ignored by get(). */
  readonly unknown: SettingValues
  /** Everything that was rejected, in schema-declaration order. */
  readonly issues: readonly SettingValidationIssue[]
  /** True when nothing was rejected. */
  readonly ok: boolean
}

// ---------------------------------------------------------------------------
// Built-in schema
// ---------------------------------------------------------------------------

/** Pane section ids, in display order. */
export const SETTINGS_SECTIONS = ['appearance', 'messages', 'editor', 'advanced'] as const

/** One of `SETTINGS_SECTIONS`. */
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/** Theme modes offered by the pane. Mirrors qml/components/Theme.qml. */
export const THEME_MODES = ['auto', 'dark', 'light'] as const

/** Font-scale bounds. Mirrors kMinFontScale / kMaxFontScale in native/main.cpp. */
export const MIN_FONT_SIZE = 0.8
export const MAX_FONT_SIZE = 1.5

/** Upper bound for the highlight ceiling; 0 disables highlighting entirely. */
export const MAX_HIGHLIGHT_CHARS = 1_000_000

/**
 * The catalogue.
 *
 * Ordering matters twice: it is the order used by `all()` and the fallback order
 * in the UI when two entries share the same `ui.order`.
 */
export const BUILTIN_SETTINGS: SettingsSchemaSet = [
  {
    name: 'theme',
    type: 'string',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Auto', description: 'Follow the system colour scheme.' },
      { value: 'dark', label: 'Dark', description: 'Always use the dark palette.' },
      { value: 'light', label: 'Light', description: 'Always use the light palette.' }
    ],
    ui: { type: 'select', label: 'Appearance', order: 10 },
    section: 'appearance',
    description: 'Colour scheme used by the window.'
  },
  {
    name: 'fontSize',
    type: 'number',
    default: 1,
    minimum: MIN_FONT_SIZE,
    maximum: MAX_FONT_SIZE,
    step: 0.05,
    ui: { type: 'slider', label: 'Font scale', unit: '%', order: 20 },
    section: 'appearance',
    description: 'Multiplier applied to text and control metrics.'
  },
  {
    name: 'language',
    type: 'string',
    default: 'en',
    options: [{ value: 'en', label: 'English', description: 'Interface language.' }],
    ui: { type: 'select', label: 'Language', order: 30 },
    section: 'appearance',
    description: 'Interface language.',
    requiresRestart: true
  },
  {
    name: 'hideSystemMessages',
    type: 'boolean',
    default: false,
    ui: { type: 'toggle', label: 'Hide system messages', order: 10 },
    section: 'messages',
    description: 'Do not render system notices in the transcript.'
  },
  {
    name: 'showTimestamps',
    type: 'boolean',
    default: false,
    ui: { type: 'toggle', label: 'Show timestamps', order: 20 },
    section: 'messages',
    description: 'Print the time next to every message.'
  },
  {
    name: 'maxHighlightChars',
    type: 'number',
    default: 20_000,
    minimum: 0,
    maximum: MAX_HIGHLIGHT_CHARS,
    step: 1_000,
    ui: { type: 'number', label: 'Highlight limit', unit: 'chars', order: 10 },
    section: 'editor',
    description: 'Code blocks longer than this are shown unhighlighted.'
  },
  {
    name: 'codeFontFamily',
    type: 'string',
    default: 'monospace',
    minLength: 1,
    maxLength: 120,
    ui: { type: 'text', label: 'Code font', placeholder: 'monospace', order: 20 },
    section: 'editor',
    description: 'Family used to render code blocks.'
  }
]

/** Index of `BUILTIN_SETTINGS` by name. Built once. */
const BUILTIN_INDEX: ReadonlyMap<string, SettingsSchema> = new Map(
  BUILTIN_SETTINGS.map((entry) => [entry.name, entry])
)

/** Look an entry up by name. */
export function getSettingSchema(
  name: string,
  schemaSet: SettingsSchemaSet = BUILTIN_SETTINGS
): SettingsSchema | undefined {
  if (schemaSet === BUILTIN_SETTINGS) return BUILTIN_INDEX.get(name)
  return schemaSet.find((entry) => entry.name === name)
}

/** Every known setting name, in declaration order. */
export function settingNames(schemaSet: SettingsSchemaSet = BUILTIN_SETTINGS): string[] {
  return schemaSet.map((entry) => entry.name)
}

/** Entries of one section, in `ui.order` then declaration order. */
export function settingsInSection(
  section: string,
  schemaSet: SettingsSchemaSet = BUILTIN_SETTINGS
): SettingsSchema[] {
  return schemaSet
    .filter((entry) => entry.section === section)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const orderA = a.entry.ui.order ?? Number.MAX_SAFE_INTEGER
      const orderB = b.entry.ui.order ?? Number.MAX_SAFE_INTEGER
      return orderA === orderB ? a.index - b.index : orderA - orderB
    })
    .map(({ entry }) => entry)
}

/**
 * Defaults for every known setting.
 *
 * A fresh install needs no settings file at all: `get()` falls back here, so a
 * missing file is a normal first run rather than an error.
 */
export function defaultSettings(schemaSet: SettingsSchemaSet = BUILTIN_SETTINGS): SettingValues {
  const values: Record<string, SettingValue> = {}
  for (const entry of schemaSet) values[entry.name] = entry.default
  return values
}

/** Defaults of `BUILTIN_SETTINGS`, frozen so a caller cannot mutate the catalogue. */
export const DEFAULT_SETTINGS: SettingValues = Object.freeze(defaultSettings())

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Human text for one issue. */
function issue(
  path: string,
  reason: SettingValidationIssue['reason'],
  message: string
): SettingValidationIssue {
  return { path, reason, message }
}

/** `typeof` check that also rejects `null` and boxed primitives. */
function matchesType(type: SettingType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'boolean':
      return typeof value === 'boolean'
    default:
      return false
  }
}

/** Options whose stored value equals `value`, compared strictly. */
function findOption(entry: SettingsSchema, value: SettingValue): SettingOption | undefined {
  return entry.options?.find((option) => option.value === value)
}

/**
 * Validate one value against one entry.
 *
 * Strict by design — see the file header. The one asymmetry that *is* intended:
 * a number must also be finite, because `NaN` and `Infinity` survive JSON.parse
 * as `null` and would otherwise corrupt the file on the next save.
 */
export function validateSettingValue(entry: SettingsSchema, value: unknown): SettingValidationResult {
  if (!matchesType(entry.type, value)) {
    return {
      ok: false,
      issue: issue(
        entry.name,
        'wrong-type',
        `expected ${entry.type}, received ${value === null ? 'null' : typeof value}`
      )
    }
  }

  if (entry.type === 'number') {
    const numeric = value as number
    if (!Number.isFinite(numeric)) {
      return { ok: false, issue: issue(entry.name, 'not-finite', 'must be a finite number') }
    }
    if (entry.minimum !== undefined && numeric < entry.minimum) {
      return {
        ok: false,
        issue: issue(entry.name, 'below-minimum', `must be at least ${String(entry.minimum)}`)
      }
    }
    if (entry.maximum !== undefined && numeric > entry.maximum) {
      return {
        ok: false,
        issue: issue(entry.name, 'above-maximum', `must be at most ${String(entry.maximum)}`)
      }
    }
    // Step compliance is checked only when the value is off by more than float
    // dust; 1.05 stored as 1.0499999999999998 must not be rejected.
    if (entry.step !== undefined && entry.step > 0) {
      const steps = numeric / entry.step
      if (Math.abs(steps - Math.round(steps)) > 1e-9) {
        return {
          ok: false,
          issue: issue(entry.name, 'not-on-step', `must be a multiple of ${String(entry.step)}`)
        }
      }
    }
  }

  if (entry.type === 'string') {
    const text = value as string
    if (entry.minLength !== undefined && text.length < entry.minLength) {
      return {
        ok: false,
        issue: issue(entry.name, 'too-short', `must be at least ${String(entry.minLength)} characters`)
      }
    }
    if (entry.maxLength !== undefined && text.length > entry.maxLength) {
      return {
        ok: false,
        issue: issue(entry.name, 'too-long', `must be at most ${String(entry.maxLength)} characters`)
      }
    }
  }

  if (entry.options !== undefined) {
    if (findOption(entry, value as SettingValue) === undefined) {
      const allowed = entry.options.map((option) => String(option.value)).join(', ')
      return {
        ok: false,
        issue: issue(entry.name, 'not-an-option', `must be one of: ${allowed}`)
      }
    }
  }

  return { ok: true, value: value as SettingValue }
}

/**
 * Validate a whole settings object.
 *
 * Missing keys take their default; unknown keys are collected separately rather
 * than dropped, so a file written by a newer build survives a save by this one.
 */
export function validateSettings(
  raw: unknown,
  schemaSet: SettingsSchemaSet = BUILTIN_SETTINGS
): SettingsValidationResult {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
  const values: Record<string, SettingValue> = {}
  const unknownValues: Record<string, SettingValue> = {}
  const issues: SettingValidationIssue[] = []

  for (const entry of schemaSet) {
    const present = Object.prototype.hasOwnProperty.call(source, entry.name)
    const candidate = present ? source[entry.name] : entry.default
    const result = validateSettingValue(entry, candidate)
    if (result.ok) {
      values[entry.name] = result.value
    } else {
      // A bad stored value degrades to the default instead of invalidating the
      // whole file: one corrupted key must not reset every other preference.
      values[entry.name] = entry.default
      issues.push(result.issue)
    }
  }

  const known = new Set(schemaSet.map((entry) => entry.name))
  for (const [key, value] of Object.entries(source)) {
    if (known.has(key)) continue
    // Unknown keys are kept only when they are representable in JSON anyway.
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      unknownValues[key] = value
    }
  }

  return {
    values: Object.freeze(values),
    unknown: Object.freeze(unknownValues),
    issues: Object.freeze(issues),
    ok: issues.length === 0
  }
}

/**
 * Check the catalogue itself.
 *
 * Run by the test suite today; intended for the day an entry is generated from
 * an N-API plugin manifest, where a malformed declaration must fail loudly
 * instead of shipping a control that can never accept its own default.
 */
export function validateSchemaSet(schemaSet: SettingsSchemaSet = BUILTIN_SETTINGS): SettingValidationIssue[] {
  const problems: SettingValidationIssue[] = []
  const seen = new Set<string>()

  for (const entry of schemaSet) {
    if (entry.name.length === 0) {
      problems.push(issue('', 'unknown-setting', 'name must not be empty'))
      continue
    }
    if (seen.has(entry.name)) {
      problems.push(issue(entry.name, 'unknown-setting', 'duplicate setting name'))
    }
    seen.add(entry.name)

    const ownDefault = validateSettingValue(entry, entry.default)
    if (!ownDefault.ok) {
      problems.push(issue(entry.name, ownDefault.issue.reason, `default is invalid: ${ownDefault.issue.message}`))
    }

    if (entry.type !== 'number') {
      if (entry.minimum !== undefined || entry.maximum !== undefined || entry.step !== undefined) {
        problems.push(issue(entry.name, 'wrong-type', 'numeric bounds on a non-number setting'))
      }
    } else if (entry.minimum !== undefined && entry.maximum !== undefined
        && entry.minimum > entry.maximum) {
      problems.push(issue(entry.name, 'below-minimum', 'minimum is greater than maximum'))
    }

    if (entry.ui.type === 'select' && (entry.options === undefined || entry.options.length === 0)) {
      problems.push(issue(entry.name, 'not-an-option', 'a select control needs options'))
    }
    if (entry.ui.type !== 'select' && entry.options !== undefined) {
      problems.push(issue(entry.name, 'not-an-option', 'options on a non-select control are ignored'))
    }

    if (entry.options !== undefined) {
      const values = new Set<string>()
      for (const option of entry.options) {
        const key = String(option.value)
        if (values.has(key)) {
          problems.push(issue(entry.name, 'not-an-option', `duplicate option value ${key}`))
        }
        values.add(key)
      }
    }
  }

  return problems
}
