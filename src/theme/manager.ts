/**
 * `ThemeManager` — the runtime owner of the active theme (Phase 2f).
 *
 * Responsibilities, in the order they matter:
 *
 *  1. **Hold the active theme** and resolve it to the values QML paints with,
 *     including the user's font scale.
 *  2. **Validate on the boundary** — built-ins are trusted, everything else
 *     (custom files, hand-edited JSON) goes through `validateTheme` and is
 *     rejected with a reason instead of being partially applied.
 *  3. **Persist the choice**, never the palette: id + font scale only, written
 *     atomically, degrading to a session-only theme when the disk is read-only.
 *  4. **Notify subscribers** so a switch repaints the whole tree (t16) without
 *     any component polling.
 *
 * Scaling model: font sizes and the text-height metrics
 * (`controlHeight`, `composerHeight`, `headerHeight`) are multiplied by the
 * font scale and rounded; lateral layout (`sidebarWidth`) and
 * `animationDuration` are not, because a bigger font should not make the window
 * narrower or the transitions slower. Scaling always starts from the base
 * definition, so 0.75 → 1.5 → 1 returns exactly to the authored values instead
 * of compounding rounding error.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { BUILTIN_THEMES, DEFAULT_THEME_ID } from './builtins.js'
import {
  backupCorruptThemeFile,
  createFileThemeStorage,
  migratePersistedTheme,
  parsePersistedTheme,
  resolveConfigDir,
  serialisePersistedTheme,
  THEME_FILE_VERSION,
} from './persist.js'
import type { ThemeStorage } from './persist.js'
import { FONT_SCALE_MAX, FONT_SCALE_MIN, QML_TOKEN_MAP, QML_TOKEN_NAMES } from './types.js'
import type {
  QmlTokenName,
  ThemeDefinition,
  ThemeQmlSnapshot,
  ThemeValidationIssue,
  ThemeValidationResult,
} from './types.js'
import { cloneTheme, describeIssues, readThemePath, validateTheme } from './validate.js'

/** Why a change notification fired. */
export type ThemeChangeReason =
  | 'load'
  | 'activate'
  | 'fontScale'
  | 'apply'
  | 'register'
  | 'reset'

/** Context handed to change listeners alongside the resolved theme. */
export interface ThemeChangeMeta {
  /** What caused the change. */
  reason: ThemeChangeReason
  /** Theme id before the change (equal to `themeId` for scale changes). */
  previousId: string
  /** Theme id after the change. */
  themeId: string
  /** Font scale after the change. */
  fontScale: number
  /** Monotonic revision, so QML can skip redundant work. */
  revision: number
}

/** Change listener; receives the fully resolved theme. */
export type ThemeChangeListener = (theme: ThemeDefinition, meta: ThemeChangeMeta) => void

/** Minimal logging surface (cordis `Logger` satisfies it). */
export interface ThemeLogger {
  /** Record a non-fatal problem: rejected file, failed write, throwing listener. */
  warn(message: string): void
}

/** Per-file result of {@link ThemeManager.loadCustomThemes}. */
export interface CustomThemeResult {
  /** File name that was loaded. */
  file: string
  /** Id of the theme it provided. */
  themeId: string
}

/** Per-file rejection from {@link ThemeManager.loadCustomThemes}. */
export interface CustomThemeRejection {
  /** File name that was rejected. */
  file: string
  /** Why it was rejected. */
  issues: readonly ThemeValidationIssue[]
}

/** Options accepted by {@link ThemeManager}. */
export interface ThemeManagerOptions {
  /** Additional themes (custom or test fixtures); validated like any other. */
  themes?: readonly ThemeDefinition[]
  /** Storage backend; defaults to `<configDir>/theme.json`. */
  storage?: ThemeStorage
  /** Config directory used to build the default storage and find custom themes. */
  configDir?: string
  /** Theme id to start with, before `load()` reads the persisted choice. */
  themeId?: string
  /** Initial font scale. */
  fontScale?: number
  /** Call `load()` in the constructor; defaults to true. */
  autoLoad?: boolean
  /** Diagnostic sink. */
  logger?: ThemeLogger
}

/** Thrown when a caller asks for a theme id that is not registered. */
export class ThemeNotFoundError extends Error {
  /** Stable error code, for callers that switch on it. */
  readonly code = 'DSH_QT_THEME_NOT_FOUND'
  /** The id that was not found. */
  readonly themeId: string

  constructor(themeId: string) {
    super(`unknown theme id: ${themeId}`)
    this.name = 'ThemeNotFoundError'
    this.themeId = themeId
  }
}

/** Clamp a font scale into the supported range; non-finite input falls back to 1. */
export function clampFontScale(scale: number): number {
  // NaN has no sensible clamp target; both infinities do.
  if (Number.isNaN(scale)) return 1
  if (scale < FONT_SCALE_MIN) return FONT_SCALE_MIN
  if (scale > FONT_SCALE_MAX) return FONT_SCALE_MAX
  // Two decimals is finer than any slider step and kills float dust like
  // 0.7500000000000001 leaking into persisted JSON.
  return Math.round(scale * 100) / 100
}

/** Round a scaled pixel size, never below 1 px. */
function scaleSize(value: number, scale: number): number {
  return Math.max(1, Math.round(value * scale))
}

/**
 * Apply a font scale to a theme.
 *
 * Pure function: the input is not modified. Returns a fresh definition whose
 * `typography.fontScale` is the clamped scale.
 */
export function scaleTheme(base: ThemeDefinition, fontScale: number): ThemeDefinition {
  const scale = clampFontScale(fontScale)
  const theme = cloneTheme(base)
  theme.typography.fontScale = scale
  if (scale === 1) return theme

  theme.typography.fontSmall = scaleSize(base.typography.fontSmall, scale)
  theme.typography.fontNormal = scaleSize(base.typography.fontNormal, scale)
  theme.typography.fontLarge = scaleSize(base.typography.fontLarge, scale)
  theme.typography.fontTitle = scaleSize(base.typography.fontTitle, scale)
  theme.metrics.controlHeight = scaleSize(base.metrics.controlHeight, scale)
  theme.metrics.composerHeight = scaleSize(base.metrics.composerHeight, scale)
  theme.metrics.headerHeight = scaleSize(base.metrics.headerHeight, scale)
  return theme
}

/**
 * Flatten a theme into the map `native/main.cpp` hands to QML as a context
 * property: every `Theme.qml` token under its QML name.
 */
export function themeToQmlTokens(theme: ThemeDefinition): Record<QmlTokenName, string | number> {
  const tokens = {} as Record<QmlTokenName, string | number>
  for (const name of QML_TOKEN_NAMES) {
    const path = QML_TOKEN_MAP[name]
    // Derived properties like appearance are computed from the theme id,
    // not read from the schema.
    if (path === '__derived:appearance') {
      tokens[name] = theme.id === 'light' ? 'light' : 'dark'
      continue
    }
    const value = readThemePath(theme, path)
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TypeError(`theme token ${name} resolves to ${typeof value}, expected string or number`)
    }
    tokens[name] = value
  }
  return tokens
}

/**
 * Owns the theme registry, the active theme and its persistence.
 *
 * Not a Cordis service itself; `src/theme/service.ts` wraps it as `ctx.theme` so
 * the manager stays usable (and testable) without a plugin context.
 */
export class ThemeManager {
  // Plain `private`, not `#private`: Cordis proxies services and invokes members
  // with a shadow receiver, where ECMAScript private fields would throw.
  private readonly definitions_ = new Map<string, ThemeDefinition>()
  private readonly builtinIds_ = new Set<string>()
  private readonly listeners_ = new Set<ThemeChangeListener>()
  private readonly rejected_ = new Map<string, readonly ThemeValidationIssue[]>()
  private readonly storage_: ThemeStorage
  private readonly configDir_: string
  private logger_: ThemeLogger | undefined
  private activeId_: string
  private fontScale_: number
  private revision_ = 0
  private lastPersistError_: string | undefined

  constructor(options: ThemeManagerOptions = {}) {
    for (const theme of BUILTIN_THEMES) {
      this.definitions_.set(theme.id, cloneTheme(theme))
      this.builtinIds_.add(theme.id)
    }

    this.configDir_ = options.configDir ?? resolveConfigDir()
    this.storage_ = options.storage ?? createFileThemeStorage(this.configDir_)
    this.logger_ = options.logger
    this.activeId_ = options.themeId ?? DEFAULT_THEME_ID
    this.fontScale_ = clampFontScale(options.fontScale ?? 1)

    if (!this.definitions_.has(this.activeId_)) {
      // An explicit but unknown start id is a programming error, not user data.
      throw new ThemeNotFoundError(this.activeId_)
    }

    for (const theme of options.themes ?? []) this.install_(theme)

    if (options.autoLoad ?? true) this.load()
  }

  /** Id of the active theme. */
  get activeId(): string {
    return this.activeId_
  }

  /** Clamped font scale in effect. */
  get fontScale(): number {
    return this.fontScale_
  }

  /** Monotonic revision; increments on every applied change. */
  get revision(): number {
    return this.revision_
  }

  /** Where the choice is persisted. */
  get storagePath(): string {
    return this.storage_.describe()
  }

  /** Last persistence failure, if the disk is unhappy. */
  get lastPersistError(): string | undefined {
    return this.lastPersistError_
  }

  /** Themes that failed validation, keyed by id, for diagnostics. */
  get rejected(): ReadonlyMap<string, readonly ThemeValidationIssue[]> {
    return this.rejected_
  }

  /** The active theme, with the font scale applied. */
  active(): ThemeDefinition {
    return scaleTheme(this.require_(this.activeId_), this.fontScale_)
  }

  /** Built-in and custom themes, default first, as fresh copies. */
  list(): ThemeDefinition[] {
    return [...this.definitions_.values()].map((theme) => cloneTheme(theme))
  }

  /** Registered theme ids, default first. */
  ids(): string[] {
    return [...this.definitions_.keys()]
  }

  /** True when `id` is registered. */
  has(id: string): boolean {
    return this.definitions_.has(id)
  }

  /** True when `id` is a built-in (read-only) theme. */
  isBuiltin(id: string): boolean {
    return this.builtinIds_.has(id)
  }

  /**
   * Return a registered theme by id, **without** the font scale applied.
   *
   * This is the authoring view: what the file declares, not what the UI paints.
   */
  loadTheme(id: string): ThemeDefinition {
    return cloneTheme(this.require_(id))
  }

  /** Switch the active theme; persists and notifies. No-op when already active. */
  setActive(id: string): void {
    const theme = this.require_(id)
    if (this.activeId_ === theme.id) return
    const previousId = this.activeId_
    this.activeId_ = theme.id
    this.persist_()
    this.notify_('activate', previousId)
  }

  /**
   * Validate and apply a theme definition in one step.
   *
   * On success the theme becomes active, is persisted and subscribers are
   * notified. On failure the current theme is untouched and the issues are
   * returned — a rejected theme is *never* partially applied.
   */
  applyTheme(candidate: unknown): ThemeValidationResult {
    const result = validateTheme(candidate)
    if (!result.ok) {
      const key = themeIdOf(candidate) ?? '<unknown>'
      this.rejected_.set(key, result.issues)
      this.logger_?.warn(`rejected theme ${key}: ${describeIssues(result.issues)}`)
      return result
    }

    const previousId = this.activeId_
    this.install_(result.theme)
    this.activeId_ = result.theme.id
    this.rejected_.delete(result.theme.id)
    this.persist_()
    this.notify_('apply', previousId)
    return result
  }

  /** Validate and register a theme without activating it. */
  register(candidate: unknown): ThemeValidationResult {
    const result = validateTheme(candidate)
    if (!result.ok) {
      const key = themeIdOf(candidate) ?? '<unknown>'
      this.rejected_.set(key, result.issues)
      this.logger_?.warn(`rejected theme ${key}: ${describeIssues(result.issues)}`)
      return result
    }
    const added = !this.definitions_.has(result.theme.id)
    this.install_(result.theme)
    this.rejected_.delete(result.theme.id)
    if (added) this.notify_('register', this.activeId_)
    return result
  }

  /**
   * Load every `*.json` theme file from a directory (default
   * `<configDir>/themes`).
   *
   * A malformed file is skipped and recorded; a missing directory is not an
   * error. Returns what was loaded and what was rejected so the settings UI can
   * show both.
   */
  loadCustomThemes(directory: string = join(this.configDir_, 'themes')): {
    loaded: CustomThemeResult[]
    rejected: CustomThemeRejection[]
  } {
    const loaded: CustomThemeResult[] = []
    const rejected: CustomThemeRejection[] = []

    let files: string[]
    try {
      files = readdirSync(directory)
        .filter((file) => file.toLowerCase().endsWith('.json'))
        .sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger_?.warn(`theme directory ${directory} is unreadable: ${String(error)}`)
      }
      return { loaded, rejected }
    }

    for (const file of files) {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(join(directory, file), 'utf8'))
      } catch (error) {
        const issues: ThemeValidationIssue[] = [{ path: '', message: `not valid JSON: ${String(error)}` }]
        rejected.push({ file, issues })
        this.rejected_.set(file, issues)
        this.logger_?.warn(`rejected theme file ${file}: ${issues[0]?.message ?? 'unreadable'}`)
        continue
      }

      const result = validateTheme(parsed)
      if (!result.ok) {
        rejected.push({ file, issues: result.issues })
        this.rejected_.set(themeIdOf(parsed) ?? file, result.issues)
        this.logger_?.warn(`rejected theme file ${file}: ${describeIssues(result.issues)}`)
        continue
      }

      this.install_(result.theme)
      loaded.push({ file, themeId: result.theme.id })
    }

    if (loaded.length > 0) this.notify_('register', this.activeId_)
    return { loaded, rejected }
  }

  /**
   * Set the user font scale (clamped to 0.75 … 1.5).
   *
   * Returns the value actually in effect, so a slider can snap to the clamp.
   */
  setFontScale(scale: number): number {
    const next = clampFontScale(scale)
    if (next === this.fontScale_) return this.fontScale_
    this.fontScale_ = next
    const theme = this.require_(this.activeId_)
    theme.typography.fontScale = next
    this.persist_()
    this.notify_('fontScale', this.activeId_)
    return next
  }

  /** Subscribe to theme changes; returns the unsubscribe function. */
  onChange(listener: ThemeChangeListener): () => void {
    this.listeners_.add(listener)
    return () => {
      this.listeners_.delete(listener)
    }
  }

  /** Alias of {@link onChange}, matching the plan's `watch(listener)` wording. */
  watch(listener: ThemeChangeListener): () => void {
    return this.onChange(listener)
  }

  /** Number of active subscribers (diagnostics / tests). */
  listenerCount(): number {
    return this.listeners_.size
  }

  /**
   * Load the persisted choice.
   *
   * Corrupt or unknown data degrades instead of failing: the corrupt file is
   * preserved next to the original as `theme.json.bak`, the default theme is
   * used, and the scale falls back to 1.
   */
  load(): void {
    let raw: string | null
    try {
      raw = this.storage_.read()
    } catch (error) {
      this.lastPersistError_ = String(error)
      this.logger_?.warn(`could not read theme file ${this.storagePath}: ${String(error)}`)
      this.notify_('load', this.activeId_)
      return
    }

    if (raw === null) {
      // First run: adopt the defaults as if they had been loaded.
      this.notify_('load', this.activeId_)
      return
    }

    const persisted = parsePersistedTheme(raw)
    if (persisted === null) {
      const backup = backupCorruptThemeFile(this.configDir_)
      this.logger_?.warn(
        `theme file ${this.storagePath} is unreadable${backup === null ? '' : ` (kept as ${backup})`}; using ${DEFAULT_THEME_ID}`,
      )
      this.activeId_ = DEFAULT_THEME_ID
      this.fontScale_ = 1
      this.notify_('load', this.activeId_)
      return
    }

    const migration = migratePersistedTheme(persisted)
    if (migration.fromFuture) {
      this.logger_?.warn(
        `theme file ${this.storagePath} was written by a newer build (schemaVersion ${persisted.schemaVersion}); using it as-is`,
      )
    } else if (migration.migrated) {
      this.logger_?.warn(
        `migrated theme file ${this.storagePath} from schemaVersion ${persisted.schemaVersion} to ${migration.state.schemaVersion}`,
      )
    }

    const previousId = this.activeId_
    this.activeId_ = this.definitions_.has(migration.state.themeId) ? migration.state.themeId : DEFAULT_THEME_ID
    if (this.activeId_ !== persisted.themeId) {
      this.logger_?.warn(`persisted theme ${persisted.themeId} is not installed; using ${DEFAULT_THEME_ID}`)
    }
    this.fontScale_ = clampFontScale(migration.state.fontScale)

    // Rewrite only *after* the migrated state has been applied: persisting first
    // would stamp the old version on the new file and lose the loaded choice.
    if (migration.migrated) this.persist_()

    this.notify_('load', previousId)
  }

  /** Persist the current choice; failures are recorded, never thrown. */
  save(): boolean {
    return this.persist_() === undefined
  }

  /** Restore the default theme and scale; persists and notifies. */
  reset(): void {
    const previousId = this.activeId_
    this.activeId_ = DEFAULT_THEME_ID
    this.fontScale_ = 1
    this.persist_()
    this.notify_('reset', previousId)
  }

  /** Flat snapshot for the QML context property. */
  snapshot(): ThemeQmlSnapshot {
    const theme = this.active()
    return {
      id: theme.id,
      name: theme.name,
      appearance: theme.appearance,
      fontScale: theme.typography.fontScale,
      tokens: themeToQmlTokens(theme),
    }
  }

  /** Alias of {@link snapshot}, named for the C++ caller in `native/main.cpp`. */
  toQmlProperties(): ThemeQmlSnapshot {
    return this.snapshot()
  }

  // ---- internals ---------------------------------------------------------

  /** Fetch a registered base definition or throw. */
  private require_(id: string): ThemeDefinition {
    const theme = this.definitions_.get(id)
    if (theme === undefined) throw new ThemeNotFoundError(id)
    return theme
  }

  /** Store a definition under its id, replacing any same-id entry. */
  private install_(theme: ThemeDefinition): void {
    this.definitions_.set(theme.id, cloneTheme(theme))
  }

  /** Write the current choice; returns the error message on failure. */
  private persist_(): string | undefined {
    const payload = serialisePersistedTheme({
      schemaVersion: THEME_FILE_VERSION,
      themeId: this.activeId_,
      fontScale: this.fontScale_,
    })
    try {
      this.storage_.write(payload)
      this.lastPersistError_ = undefined
      return undefined
    } catch (error) {
      const message = String(error)
      this.lastPersistError_ = message
      this.logger_?.warn(`could not persist theme choice to ${this.storagePath}: ${message}`)
      return message
    }
  }

  /** Fan out a change to every subscriber; a throwing listener cannot block the rest. */
  private notify_(reason: ThemeChangeReason, previousId: string): void {
    this.revision_ += 1
    if (this.listeners_.size === 0) return

    const theme = this.active()
    const meta: ThemeChangeMeta = {
      reason,
      previousId,
      themeId: theme.id,
      fontScale: theme.typography.fontScale,
      revision: this.revision_,
    }
    for (const listener of [...this.listeners_]) {
      try {
        listener(theme, meta)
      } catch (error) {
        this.logger_?.warn(`theme listener failed during ${reason}: ${String(error)}`)
      }
    }
  }
}

/** Best-effort id of an untrusted theme candidate, used as the rejection key. */
function themeIdOf(candidate: unknown): string | undefined {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  const id = (candidate as Record<string, unknown>)['id']
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** Create a manager with default options. */
export function createThemeManager(options: ThemeManagerOptions = {}): ThemeManager {
  return new ThemeManager(options)
}
