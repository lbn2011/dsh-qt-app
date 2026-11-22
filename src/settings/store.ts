// store.ts — the settings store.
//
// One reactive map over a schema-declared set of preferences, backed by a JSON
// file that survives restarts. The shape is deliberately small:
//
//   get(name)             → value, or the schema default when unset
//   set(name, value)      → validate, persist, notify
//   watch(name, listener) → subscribe; returns an unsubscribe function
//
// Three rules that everything else follows from:
//
//   1. **Nothing changes on a rejection.** `set()` validates first, and a bad
//      value leaves both the map and the file exactly as they were. A settings
//      API that half-applies a change is worse than one that refuses.
//   2. **Listeners never break the store.** Each listener runs in its own
//      try/catch; one throwing subscriber must not stop the others or abort a
//      save. This mirrors the rule in src/theme/manager.ts.
//   3. **The file is for humans.** Keys are sorted, the envelope is indented,
//      unknown keys written by a newer build are preserved instead of dropped,
//      and a corrupt file is moved aside rather than deleted.
import {
  BUILTIN_SETTINGS,
  getSettingSchema,
  settingNames,
  validateSettingValue,
  validateSettings
} from './schema.js'
import type {
  SettingValidationIssue,
  SettingValue,
  SettingValues,
  SettingsSchema,
  SettingsSchemaSet
} from './schema.js'
import {
  SETTINGS_FILE_VERSION,
  backupCorruptSettingsFile,
  createFileSettingsStorage,
  migratePersistedSettings,
  parsePersistedSettings,
  resolveSettingsPaths,
  serialisePersistedSettings
} from './paths.js'
import type { SettingsStorage } from './paths.js'

/** Minimal logger surface; a Cordis `Logger` satisfies it structurally. */
export interface SettingsLogger {
  warn(message: string, ...rest: unknown[]): void
}

/** A change delivered to listeners. */
export interface SettingsChange {
  /** Setting name, or '*' for a bulk change (load, reset, setMany). */
  readonly name: string
  /** Value after the change. */
  readonly value: SettingValue | undefined
  /** Value before the change. */
  readonly previous: SettingValue | undefined
  /** True when the change was written to disk. */
  readonly persisted: boolean
}

/** Listener for one key. */
export type SettingsListener = (value: SettingValue, previous: SettingValue | undefined) => void

/** Listener for every change. */
export type SettingsChangeListener = (change: SettingsChange) => void

/** Options accepted by the constructor. */
export interface SettingsStoreOptions {
  /** Schema to enforce. Defaults to `BUILTIN_SETTINGS`. */
  readonly schema?: SettingsSchemaSet
  /** Explicit storage; when absent a file storage is built from the paths below. */
  readonly storage?: SettingsStorage
  /** Override the config directory instead of resolving it from the environment. */
  readonly configDir?: string
  /** Environment used to resolve the config directory. */
  readonly env?: NodeJS.ProcessEnv
  /** Where to report recoverable problems. Silent by default. */
  readonly logger?: SettingsLogger
  /** Set false to batch writes yourself via `save()`. Defaults to true. */
  readonly autoSave?: boolean
}

/** What `load()` did. */
export interface SettingsLoadResult {
  /** True when a usable file was found and applied. */
  readonly loaded: boolean
  /** True when the file was rewritten because it was an older format. */
  readonly migrated: boolean
  /** True when the file came from a newer build and was left untouched. */
  readonly fromFuture: boolean
  /** True when a corrupt file was moved aside. */
  readonly recovered: boolean
  /** Values rejected while loading (each degraded to its default). */
  readonly issues: readonly SettingValidationIssue[]
  /** Number of preferences currently in force. */
  readonly count: number
}

/** Result of an attempted `set()`, for callers that prefer not to catch. */
export type SettingsSetResult =
  | { readonly ok: true; readonly value: SettingValue; readonly changed: boolean }
  | { readonly ok: false; readonly issue: SettingValidationIssue }

/** Thrown by `set()` for an unknown name. */
export class UnknownSettingError extends Error {
  /** The offending key. Kept apart from `name`, which stays the class name. */
  readonly settingName: string

  constructor(name: string) {
    super(`unknown setting: ${name}`)
    this.name = 'UnknownSettingError'
    this.settingName = name
  }
}

/** Thrown by `set()` when the value fails its schema. */
export class SettingValidationError extends Error {
  readonly issue: SettingValidationIssue

  constructor(issue: SettingValidationIssue) {
    super(`${issue.path}: ${issue.message}`)
    this.name = 'SettingValidationError'
    this.issue = issue
  }
}

/**
 * Persistent settings.
 *
 * Construction does not touch the disk; call `load()` to read the file. That
 * split matters for tests and for the Cordis plugin, which wants to install the
 * service and read the file from inside an effect rather than in the constructor.
 */
export class SettingsStore {
  private readonly schema_: SettingsSchemaSet
  private readonly storage_: SettingsStorage
  private readonly logger_: SettingsLogger | undefined
  private readonly autoSave_: boolean

  private values_: Record<string, SettingValue> = {}
  private unknown_: Record<string, SettingValue> = {}
  private loaded_ = false
  private schemaVersion_ = SETTINGS_FILE_VERSION
  private lastError_: string | null = null

  /** Per-key listeners, keyed by setting name. */
  private readonly listeners_ = new Map<string, Set<SettingsListener>>()
  /** Global listeners, fed every change. */
  private readonly globalListeners_ = new Set<SettingsChangeListener>()
  /** Rejections recorded during `load()` or `set()`, newest last. */
  private readonly rejected_ = new Map<string, SettingValidationIssue>()
  /** Bumped on every effective change; cheap cache invalidator for callers. */
  private revision_ = 0

  constructor(options: SettingsStoreOptions = {}) {
    this.schema_ = options.schema ?? BUILTIN_SETTINGS
    this.logger_ = options.logger
    this.autoSave_ = options.autoSave !== false

    if (options.storage !== undefined) {
      this.storage_ = options.storage
    } else {
      const paths = options.configDir !== undefined
        ? { directory: options.configDir, file: `${options.configDir}/settings.json` }
        : resolveSettingsPaths(options.env ?? process.env)
      this.storage_ = createFileSettingsStorage(paths.file)
    }

    // Start from the schema's own defaults so `get()` works before `load()` — a
    // store that returns undefined for every key until read is a trap, not a
    // feature. Every entry contributes, so a custom schema needs no merge step.
    for (const entry of this.schema_) this.values_[entry.name] = entry.default
  }

  // ---- Reads -------------------------------------------------------------

  /** Value of `name`, or its default when unset. Throws for an unknown name. */
  get<T extends SettingValue = SettingValue>(name: string): T {
    this.schemaFor_(name)
    return this.values_[name] as T
  }

  /** Value of `name`, or `fallback` when unset/unknown. Never throws. */
  getOr(name: string, fallback: SettingValue): SettingValue {
    if (getSettingSchema(name, this.schema_) === undefined) return fallback
    const value = this.values_[name]
    return value === undefined ? fallback : value
  }

  /** True when the name is in the schema. */
  has(name: string): boolean {
    return getSettingSchema(name, this.schema_) !== undefined
  }

  /** Schema entry for `name`, or undefined. */
  schemaFor(name: string): SettingsSchema | undefined {
    return getSettingSchema(name, this.schema_)
  }

  /** Every known name, in schema order. */
  names(): string[] {
    return settingNames(this.schema_)
  }

  /** Snapshot of every validated value. Frozen; safe to hand to QML. */
  all(): SettingValues {
    return Object.freeze({ ...this.values_ })
  }

  /** Keys this store does not own but will keep on disk (newer build's data). */
  unknown(): SettingValues {
    return Object.freeze({ ...this.unknown_ })
  }

  /** True once `load()` has run, even if no file existed. */
  get loaded(): boolean {
    return this.loaded_
  }

  /** Bumped on every effective change. */
  get revision(): number {
    return this.revision_
  }

  /** On-disk format version currently in force. */
  get schemaVersion(): number {
    return this.schemaVersion_
  }

  /** Where the file lives (or 'memory://…' for a fake storage). */
  get location(): string {
    return this.storage_.describe()
  }

  /** Last persistence or load error, for diagnostics. */
  get lastError(): string | null {
    return this.lastError_
  }

  /** Rejections recorded since construction, newest last. */
  rejections(): SettingValidationIssue[] {
    return [...this.rejected_.values()]
  }

  /** Number of listeners on one key (or in total, when name is omitted). */
  listenerCount(name?: string): number {
    if (name !== undefined) return this.listeners_.get(name)?.size ?? 0
    let total = this.globalListeners_.size
    for (const set of this.listeners_.values()) total += set.size
    return total
  }

  // ---- Writes ------------------------------------------------------------

  /**
   * Set one preference.
   *
   * Validates, applies, persists and notifies — in that order, so a rejection
   * changes nothing. Throws `UnknownSettingError` for a name outside the schema
   * and `SettingValidationError` for a value outside its value space; use
   * `trySet()` when a failure is expected rather than exceptional.
   */
  set(name: string, value: unknown, options: { persist?: boolean; silent?: boolean } = {}): SettingValue {
    const entry = this.schemaFor_(name)
    const result = validateSettingValue(entry, value)
    if (!result.ok) {
      this.rejected_.set(name, result.issue)
      throw new SettingValidationError(result.issue)
    }

    const previous = this.values_[name]
    const changed = previous !== result.value
    if (!changed) {
      // Already in force: rewriting the file would be a needless disk write on
      // every repeated UI event, and would churn the mtime for watchers.
      this.rejected_.delete(name)
      return result.value
    }

    this.values_[name] = result.value
    this.rejected_.delete(name)

    let persisted = false
    if (options.persist !== false && this.autoSave_ && !entry.transient) {
      persisted = this.persist_()
    }

    this.revision_ += 1
    if (options.silent !== true) this.notify_(name, result.value, previous, persisted)

    return result.value
  }

  /** Non-throwing `set()`. */
  trySet(name: string, value: unknown, options: { persist?: boolean; silent?: boolean } = {}): SettingsSetResult {
    const entry = getSettingSchema(name, this.schema_)
    if (entry === undefined) {
      const issue: SettingValidationIssue = {
        path: name,
        reason: 'unknown-setting',
        message: `unknown setting: ${name}`
      }
      this.rejected_.set(name, issue)
      return { ok: false, issue }
    }

    const result = validateSettingValue(entry, value)
    if (!result.ok) {
      this.rejected_.set(name, result.issue)
      return { ok: false, issue: result.issue }
    }

    const previous = this.values_[name]
    const changed = previous !== result.value
    this.rejected_.delete(name)

    if (!changed) return { ok: true, value: result.value, changed: false }

    this.values_[name] = result.value

    let persisted = false
    if (options.persist !== false && this.autoSave_ && !entry.transient) persisted = this.persist_()

    this.revision_ += 1
    if (options.silent !== true) this.notify_(name, result.value, previous, persisted)

    return { ok: true, value: result.value, changed: true }
  }

  /** Set several preferences, persisting once. Unknown/invalid keys are reported, not thrown. */
  setMany(
    patch: Readonly<Record<string, unknown>>,
    options: { persist?: boolean } = {}
  ): { applied: string[]; issues: SettingValidationIssue[] } {
    const applied: string[] = []
    const issues: SettingValidationIssue[] = []
    const changes: SettingsChange[] = []

    for (const [name, value] of Object.entries(patch)) {
      const entry = getSettingSchema(name, this.schema_)
      if (entry === undefined) {
        issues.push({ path: name, reason: 'unknown-setting', message: `unknown setting: ${name}` })
        continue
      }
      const result = validateSettingValue(entry, value)
      if (!result.ok) {
        issues.push(result.issue)
        continue
      }
      const previous = this.values_[name]
      if (previous !== result.value) {
        this.values_[name] = result.value
        this.revision_ += 1
        changes.push({ name, value: result.value, previous, persisted: false })
      }
      applied.push(name)
    }

    const persisted = changes.length > 0 && options.persist !== false && this.autoSave_
      ? this.persist_()
      : false
    for (const change of changes) this.notify_(change.name, change.value, change.previous, persisted)

    return { applied, issues }
  }

  /** Restore one key (or every key) to its schema default. */
  reset(name?: string): void {
    if (name !== undefined) {
      const entry = this.schemaFor_(name)
      this.set(entry.name, entry.default)
      return
    }

    for (const entry of this.schema_) this.values_[entry.name] = entry.default
    this.rejected_.clear()
    this.revision_ += 1
    const persisted = this.autoSave_ ? this.persist_() : false
    this.notify_('*', undefined, undefined, persisted)
  }

  // ---- Persistence -------------------------------------------------------

  /**
   * Read the file and apply it.
   *
   * Never throws: a missing file is a first run, a corrupt file is backed up
   * (when its location allows it), and a file from a newer build is applied
   * best-effort without being rewritten.
   */
  load(): SettingsLoadResult {
    let raw: string | null = null
    try {
      raw = this.storage_.read()
    } catch (error) {
      this.lastError_ = this.describeError_(error)
      this.logger_?.warn(`could not read ${this.location}: ${this.lastError_}`)
      this.loaded_ = true
      return {
        loaded: false, migrated: false, fromFuture: false, recovered: false,
        issues: [], count: Object.keys(this.values_).length
      }
    }

    if (raw === null) {
      // First run: defaults are already in place, and nothing is written until
      // the user actually changes something.
      this.loaded_ = true
      return {
        loaded: false, migrated: false, fromFuture: false, recovered: false,
        issues: [], count: Object.keys(this.values_).length
      }
    }

    const parsed = parsePersistedSettings(raw)
    if (parsed === null) {
      this.logger_?.warn(`${this.location} is not valid settings JSON; using defaults`)
      const backup = this.backup_()
      this.loaded_ = true
      return {
        loaded: false, migrated: false, fromFuture: false, recovered: backup,
        issues: [], count: Object.keys(this.values_).length
      }
    }

    const migration = migratePersistedSettings(parsed)
    if (migration.migrated) {
      this.logger_?.warn(
        `${this.location}: migrated settings from schemaVersion ${String(parsed.schemaVersion)} `
        + `to ${String(migration.state.schemaVersion)}`
      )
    }
    if (migration.fromFuture) {
      this.logger_?.warn(
        `${this.location} was written by a newer build (schemaVersion ${String(parsed.schemaVersion)}); reading it without rewriting`
      )
    }

    const validation = validateSettings(migration.state.values, this.schema_)
    this.values_ = { ...validation.values }
    this.unknown_ = { ...validation.unknown }
    this.schemaVersion_ = migration.state.schemaVersion
    for (const issue of validation.issues) this.rejected_.set(issue.path, issue)
    this.loaded_ = true
    this.revision_ += 1

    // Rewrite only after the state is in force: persisting first would stamp the
    // old version (and the old values) onto the new file.
    let migrated = migration.migrated
    if (migrated && !migration.fromFuture) {
      if (!this.persist_()) migrated = false
    }

    if (validation.issues.length > 0) {
      this.logger_?.warn(
        `${this.location}: ${String(validation.issues.length)} setting(s) fell back to default: `
        + validation.issues.map((issue) => `${issue.path} (${issue.message})`).join('; ')
      )
    }

    this.notify_('*', undefined, undefined, migrated)

    return {
      loaded: true,
      migrated,
      fromFuture: migration.fromFuture,
      recovered: false,
      issues: validation.issues,
      count: Object.keys(this.values_).length
    }
  }

  /** Write the current values. Returns false when the write failed. */
  save(): boolean {
    return this.persist_()
  }

  // ---- Subscriptions -----------------------------------------------------

  /**
   * Subscribe to one key.
   *
   * Returns an unsubscribe function which is safe to call twice. `immediate`
   * pushes the current value once, on subscribe — the convenience that makes a
   * `watch()` call equivalent to "keep this in sync forever".
   */
  watch(name: string, listener: SettingsListener, options: { immediate?: boolean } = {}): () => void {
    this.schemaFor_(name)

    let set = this.listeners_.get(name)
    if (set === undefined) {
      set = new Set()
      this.listeners_.set(name, set)
    }
    set.add(listener)

    if (options.immediate === true) {
      const current = this.values_[name]
      if (current !== undefined) {
        try {
          listener(current, undefined)
        } catch (error) {
          this.logger_?.warn(`immediate listener for ${name} threw: ${this.describeError_(error)}`)
        }
      }
    }

    let active = true
    return () => {
      if (!active) return
      active = false
      const current = this.listeners_.get(name)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) this.listeners_.delete(name)
    }
  }

  /** Subscribe to every change (including bulk ones, with `name === '*'`). */
  watchAll(listener: SettingsChangeListener): () => void {
    this.globalListeners_.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.globalListeners_.delete(listener)
    }
  }

  /** Remove every listener; mainly for tests and for plugin teardown. */
  clearListeners(): void {
    this.listeners_.clear()
    this.globalListeners_.clear()
  }

  // ---- Internals ---------------------------------------------------------

  /** Schema lookup that throws `UnknownSettingError` instead of returning undefined. */
  private schemaFor_(name: string): SettingsSchema {
    const entry = getSettingSchema(name, this.schema_)
    if (entry === undefined) throw new UnknownSettingError(name)
    return entry
  }

  /** Write values + preserved unknown keys, then report failures. */
  private persist_(): boolean {
    const merged: Record<string, unknown> = { ...this.unknown_ }
    for (const [name, value] of Object.entries(this.values_)) {
      // Transient keys are session-only by declaration: they must not appear in
      // the file even as their default, or a later run would read them back and
      // silently turn them persistent.
      const entry = getSettingSchema(name, this.schema_)
      if (entry?.transient === true) continue
      merged[name] = value
    }
    const contents = serialisePersistedSettings({ schemaVersion: SETTINGS_FILE_VERSION, values: merged })
    try {
      this.storage_.write(contents)
      this.lastError_ = null
      this.schemaVersion_ = SETTINGS_FILE_VERSION
      return true
    } catch (error) {
      // Reported, not thrown: a read-only config dir must not crash the app, and
      // the value is still live in memory for this session.
      this.lastError_ = this.describeError_(error)
      this.logger_?.warn(`could not write ${this.location}: ${this.lastError_}`)
      return false
    }
  }

  /** Move a corrupt file aside when the storage is a real file. */
  private backup_(): boolean {
    const location = this.storage_.describe()
    if (!location.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(location)) return false
    const backup = backupCorruptSettingsFile(location)
    if (backup !== null) this.logger_?.warn(`moved corrupt settings to ${backup}`)
    return backup !== null
  }

  /** Deliver one change to per-key and global listeners, isolating failures. */
  private notify_(name: string, value: SettingValue | undefined, previous: SettingValue | undefined, persisted: boolean): void {
    const change: SettingsChange = { name, value, previous, persisted }

    if (name !== '*') {
      const set = this.listeners_.get(name)
      if (set !== undefined) {
        // Copy before iterating: a listener may unsubscribe itself or others.
        for (const listener of [...set]) {
          try {
            listener(value as SettingValue, previous)
          } catch (error) {
            this.logger_?.warn(`listener for ${name} threw: ${this.describeError_(error)}`)
          }
        }
      }
    }

    for (const listener of [...this.globalListeners_]) {
      try {
        listener(change)
      } catch (error) {
        this.logger_?.warn(`change listener threw: ${this.describeError_(error)}`)
      }
    }
  }

  /** Error to a single log-friendly line. */
  private describeError_(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error)
  }
}

/** Convenience factory, matching `createThemeManager()` in src/theme/manager.ts. */
export function createSettingsStore(options: SettingsStoreOptions = {}): SettingsStore {
  return new SettingsStore(options)
}
