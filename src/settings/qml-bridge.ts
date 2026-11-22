// qml-bridge.ts — the object QML holds when it wants to read or write settings.
//
// QML cannot construct a `SettingsStore`: it has no way to import a TypeScript
// module, and it cannot watch a Node object for changes. What it can do is hold a
// `var` pointing at a plain JS object and call methods on it. So this module
// narrows the store down to exactly that: a handful of synchronous functions
// that return JSON scalars, plain objects and arrays.
//
// Three rules make the seam safe:
//
//   1. **Nothing throws across the boundary.** A QML control cannot catch a
//      TypeScript exception usefully, so every method degrades to a safe value
//      and records why in `lastError()`.
//   2. **Writes go through `trySet`.** The store validates and refuses illegal
//      values atomically; the bridge reports the refusal as `false` instead of
//      pretending the write happened.
//   3. **Reads are cheap and copy-free where they can be.** `all()` hands back a
//      frozen snapshot; `fields()` builds descriptors on demand, which is fine
//      because a form is built once per pane opening, not per frame.

import { MemorySettingsStorage } from './paths.js'
import { SettingsStore } from './store.js'
import {
  settingsFieldDescriptors,
  settingsFormSections,
  type SettingsFieldDescriptor,
  type SettingsFormSection
} from './forms.js'
import { getSettingSchema, type SettingValue, type SettingValues, type SettingsSchemaSet } from './schema.js'

/**
 * The surface QML codes against.
 *
 * Every method is total: given nonsense it returns a neutral value rather than
 * throwing, and `lastError()` explains the most recent refusal.
 */
export interface SettingsQmlBridge {
  /** Current value of one setting, or null when the name is unknown. */
  get(name: string): SettingValue | null
  /** Write one setting; false when it was refused or unknown. */
  set(name: string, value: unknown): boolean
  /** Every known setting, as a plain object. */
  all(): SettingValues
  /** Names in catalogue order. */
  names(): string[]
  /** Sections in catalogue order. */
  sections(): string[]
  /** Descriptors for a section, or for everything when `section` is empty. */
  fields(section?: string): SettingsFieldDescriptor[]
  /** Descriptors grouped into sections. */
  formSections(): SettingsFormSection[]
  /** Increments on every accepted write; QML can use it as a change stamp. */
  revision(): number
  /** Where the settings file lives. */
  location(): string
  /** Why the most recent refused call was refused, or an empty string. */
  lastError(): string
  /** The store behind the bridge, for TypeScript callers that need it. */
  readonly store: SettingsStore
}

/** Minimal logger surface, matching cordis' logger shape. */
export interface SettingsBridgeLogger {
  warn(message: string): void
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Wrap a store for QML.
 *
 * The bridge holds the store directly rather than copying values, so a
 * TypeScript caller that writes through the store and a QML control that writes
 * through the bridge always see the same state — there is exactly one copy of
 * the truth, which is the store's value map.
 */
export function createSettingsQmlBridge(
  store: SettingsStore,
  options?: { readonly logger?: SettingsBridgeLogger }
): SettingsQmlBridge {
  let lastError_ = ''

  const remember = (message: string): void => {
    lastError_ = message
    options?.logger?.warn(`[dsh-qt settings] ${message}`)
  }

  const bridge: SettingsQmlBridge = {
    get(name: string): SettingValue | null {
      try {
        const known = store.has(name)
        if (!known) {
          lastError_ = `unknown setting ${name}`
          return null
        }
        return store.get(name)
      } catch (error) {
        remember(`${describeError(error)}`)
        return null
      }
    },

    set(name: string, value: unknown): boolean {
      try {
        if (!store.has(name)) {
          remember(`unknown setting ${name}`)
          return false
        }
        const result = store.trySet(name, value)
        if (!result.ok) {
          remember(result.issue.message)
          return false
        }
        lastError_ = ''
        return true
      } catch (error) {
        remember(describeError(error))
        return false
      }
    },

    all(): SettingValues {
      try {
        return store.all()
      } catch (error) {
        remember(describeError(error))
        return {}
      }
    },

    names(): string[] {
      try {
        return [...store.names()]
      } catch (error) {
        remember(describeError(error))
        return []
      }
    },

    sections(): string[] {
      try {
        return settingsFormSections(store.schema, store.all()).map((section) => section.section)
      } catch (error) {
        remember(describeError(error))
        return []
      }
    },

    fields(section?: string): SettingsFieldDescriptor[] {
      try {
        const descriptors = settingsFieldDescriptors(store.schema, store.all())
        if (section === undefined || section.length === 0) return descriptors
        return descriptors.filter((field) => field.section === section)
      } catch (error) {
        remember(describeError(error))
        return []
      }
    },

    formSections(): SettingsFormSection[] {
      try {
        return settingsFormSections(store.schema, store.all())
      } catch (error) {
        remember(describeError(error))
        return []
      }
    },

    revision(): number {
      return store.revision
    },

    location(): string {
      return store.location
    },

    lastError(): string {
      return lastError_
    },

    store
  }

  return bridge
}

/**
 * A bridge backed by an in-memory store, for previews and QML tests.
 *
 * Uses the built-in catalogue and a memory storage, so a control can be driven
 * end to end without touching the user's `settings.json`.
 */
export function createInMemorySettingsBridge(options?: {
  readonly schema?: SettingsSchemaSet
  readonly logger?: SettingsBridgeLogger
}): SettingsQmlBridge {
  const storage = new MemorySettingsStorage()
  const store = new SettingsStore({
    storage,
    ...(options?.schema === undefined ? {} : { schema: options.schema }),
    ...(options?.logger === undefined ? {} : { logger: options.logger })
  })
  store.load()
  return createSettingsQmlBridge(store, options?.logger === undefined ? undefined : { logger: options.logger })
}

/** The catalogue name of one setting, or null. */
export function settingSchemaOrNull(name: string): SettingsSchemaSet[number] | null {
  const entry = getSettingSchema(name)
  return entry ?? null
}
