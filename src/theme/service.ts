/**
 * Cordis service wrapper around {@link ThemeManager} (Phase 2f).
 *
 * The manager is a plain class so it can be unit-tested and embedded without a
 * plugin context; this wrapper is the piece plugins actually see:
 *
 * ```ts
 * declare module '@deepseek-ai/cordis' {
 *   interface Context { theme: ThemeService }
 * }
 * ```
 *
 * Registering `ctx.theme` (rather than re-using `ctx.qtRenderer`) keeps the
 * theme contract independent of the renderer: a headless profile can mount the
 * theme service, and t17's settings UI can depend on `theme` alone.
 *
 * QML export: `snapshot()` / `toQmlProperties()` return the flat token map that
 * `native/main.cpp` installs as the `theme` context property. That wiring is
 * t16's job — this module deliberately does not touch the C++ host, so the
 * service can ship and be tested before the Qt refactor lands.
 */
import type { Context, Logger } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

import { DEFAULT_THEME_ID } from './builtins.js'
import { createThemeManager } from './manager.js'
import type { ThemeChangeListener, ThemeManager, ThemeManagerOptions } from './manager.js'
import type { ThemeDefinition, ThemeQmlSnapshot } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Theme service, provided by the `dsh-qt-app` plugin when the Qt profile
     * mounts the theme track. Plugins that read tokens should declare
     * `inject: ['theme']`.
     */
    theme: ThemeService
  }
}

/** Name the service registers under (`ctx.theme`). */
export const THEME_SERVICE_NAME = 'theme'

/** Logger channel used for rejected themes and persistence failures. */
export const THEME_LOGGER_NAME = 'dsh-qt-theme'

/** Options accepted by {@link ThemeService}. */
export type ThemeServiceOptions = ThemeManagerOptions

/**
 * `ctx.theme` — owns the active theme for the native UI.
 *
 * Thin by design: every rule (clamping, validation, persistence, notification)
 * lives in {@link ThemeManager}; this class only adapts it to Cordis and adds
 * the flow-control helpers QML needs.
 */
export class ThemeService extends Service {
  /** The underlying manager; available for advanced callers and tests. */
  readonly manager: ThemeManager

  private readonly logger_: Logger

  constructor(ctx: Context, options: ThemeServiceOptions = {}) {
    super(ctx, THEME_SERVICE_NAME)

    const logger = ctx.logger(THEME_LOGGER_NAME)
    this.logger_ = logger
    // Cordis `Logger` satisfies `ThemeLogger`: `warn(format, ...args)` accepts
    // the single-message call the manager makes.
    this.manager = createThemeManager({ ...options, logger })
  }

  /** Active theme id (e.g. `dark`). */
  get activeId(): string {
    return this.manager.activeId
  }

  /** Clamped font scale in effect. */
  get fontScale(): number {
    return this.manager.fontScale
  }

  /** Monotonic revision; QML can compare it to skip redundant repaints. */
  get revision(): number {
    return this.manager.revision
  }

  /** The active theme with the font scale applied. */
  active(): ThemeDefinition {
    return this.manager.active()
  }

  /** Every installed theme, default first. */
  list(): ThemeDefinition[] {
    return this.manager.list()
  }

  /** Switch themes; persists and notifies listeners. */
  setActive(id: string): void {
    this.manager.setActive(id)
  }

  /** Set the font scale (clamped to 0.75 … 1.5); returns the value in effect. */
  setFontScale(scale: number): number {
    return this.manager.setFontScale(scale)
  }

  /** Subscribe to theme changes; returns the unsubscribe function. */
  onChange(listener: ThemeChangeListener): () => void {
    return this.manager.onChange(listener)
  }

  /** Load custom theme files from the user config dir (or `directory`). */
  loadCustomThemes(directory?: string): ReturnType<ThemeManager['loadCustomThemes']> {
    return directory === undefined
      ? this.manager.loadCustomThemes()
      : this.manager.loadCustomThemes(directory)
  }

  /** Flat token map for the QML context property. */
  snapshot(): ThemeQmlSnapshot {
    return this.manager.snapshot()
  }

  /** Alias of {@link snapshot} for the C++ host. */
  toQmlProperties(): ThemeQmlSnapshot {
    return this.manager.toQmlProperties()
  }

  /**
   * Push the current snapshot to a sink (the Qt host's context property).
   *
   * Returns the unsubscribe function, so a plugin can bind it to `ctx.effect`
   * and stop pushing the moment the fiber unloads.
   */
  bindSink(sink: (snapshot: ThemeQmlSnapshot) => void): () => void {
    sink(this.snapshot())
    const unsubscribe = this.manager.onChange(() => {
      try {
        sink(this.snapshot())
      } catch (error) {
        this.logger_.warn('theme sink failed: %s', String(error))
      }
    })
    return unsubscribe
  }

  /** Restore the default theme and scale. */
  reset(): void {
    this.manager.reset()
  }
}

/** Cordis plugin name for a standalone theme mount. */
export const name = 'dsh-qt-theme'

/** No service dependencies: the theme track must mount on its own. */
export const inject: string[] = []

/**
 * Mount the theme service on `ctx` and make sure QML receives the first
 * snapshot even when no theme was ever persisted.
 */
export function apply(ctx: Context, options: ThemeServiceOptions = {}): ThemeService {
  const service = new ThemeService(ctx, options)
  ctx.effect(() => {
    // Force the first read so a corrupt or missing file is reported at mount
    // time rather than on the first repaint.
    service.active()
    return () => {
      /* nothing to release: the manager owns no timers or handles */
    }
  })
  return service
}

export default { name, inject, apply, DEFAULT_THEME_ID }
