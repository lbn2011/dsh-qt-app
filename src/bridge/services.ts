// src/bridge/services.ts — adapters from the Cordis services to the bridge.
//
// `qml-bridge.ts` is deliberately ignorant of Cordis: it talks to small
// interfaces. This file is the one place that knows the real services
// (`ctx.qtRenderer`, `ctx.theme`, the settings store) and bends them into those
// interfaces.
//
// Two rules hold throughout:
//
//   * **Never widen what a service promises.** If `ThemeService` has no
//     `applyTheme()`, the adapter does not invent one — it either maps to a real
//     method or reports `unavailable` with a message that says what is missing.
//     A silent no-op here would look like "theme switching is broken" in the UI.
//   * **Always return the effective value.** A service that clamps (font scale
//     0.8–1.5) must have the clamped number flow back to QML, or the control
//     shows a value that is not in force.

import { parseMarkdown } from '../markdown/fallback-parser.js'
import type { CodeBlockOptions, MarkdownOptions } from '../types.js'
import {
  QmlBridge,
  type QmlBridgeComposer,
  type QmlBridgeEventSource,
  type QmlBridgeLogger,
  type QmlBridgeOptions,
  type QmlBridgeRenderer,
  type QmlBridgeParser,
  type QmlBridgeSettings,
  type QmlBridgeTheme,
} from './qml-bridge.js'

/** The parts of `QtRendererService` this bridge consumes. */
export interface RendererLike {
  renderMarkdown(text: string, options?: MarkdownOptions): Promise<string> | string
  highlightCode(code: string, language?: string, options?: CodeBlockOptions): Promise<string> | string
}

/** The parts of `ThemeService` (src/theme/service.ts) this bridge consumes. */
export interface ThemeServiceLike {
  applyTheme?(value: unknown): unknown
  setActive?(id: string): unknown
  setFontScale?(scale: number): unknown
  readonly activeId?: string
  readonly fontScale?: number
}

/**
 * Anything that behaves like the settings store or the t20 QML bridge.
 *
 * Both shapes are accepted on purpose: `SettingsStore` has `set()` that
 * *throws*, the QML bridge has `set()` that returns `false`. The adapter below
 * hides that difference from QML.
 */
export interface SettingsLike {
  get(name: string): unknown
  set(name: string, value: unknown): unknown
  save?(): unknown
  all?(): unknown
}

/** Adapter for `ctx.qtRenderer`. */
export function rendererFromService(renderer: RendererLike): QmlBridgeRenderer {
  return {
    renderMarkdown(text: string, options?: MarkdownOptions): Promise<string> | string {
      return options === undefined
        ? renderer.renderMarkdown(text)
        : renderer.renderMarkdown(text, options)
    },
    highlightCode(code: string, language?: string, options?: CodeBlockOptions): Promise<string> | string {
      if (language === undefined) return renderer.highlightCode(code)
      return options === undefined
        ? renderer.highlightCode(code, language)
        : renderer.highlightCode(code, language, options)
    },
  }
}

/**
 * The default parser adapter: the pure-TypeScript fallback parser.
 *
 * The native `parse()` from dsh-qt-napi was verified in t11 to produce an
 * identical AST for the sample documents, but the TypeScript parser is always
 * present — the addon may be missing (degraded install, wrong platform) and a
 * chat view that cannot parse Markdown at all is a worse failure than one that
 * parses with the portable implementation. A host that wants the native parser
 * injects it through `options.parser`.
 */
export const fallbackParserAdapter: QmlBridgeParser = {
  parseMarkdown(source: string, options?: MarkdownOptions): unknown {
    const node = options === undefined ? parseMarkdown(source) : parseMarkdown(source, options)
    return node.toJSON()
  },
}

/**
 * Adapter for `ctx.theme`.
 *
 * `ThemeService` exposes `setActive(id)` and `setFontScale(scale)`; a
 * `ThemeManager` handed over directly would expose the same two. `"auto"` is a
 * QML-side decision (it follows the platform colour scheme), so it is refused
 * here with a message that says so rather than silently pinning a scheme.
 */
export function themeFromService(theme: ThemeServiceLike): QmlBridgeTheme {
  const adapter: QmlBridgeTheme = {}
  Object.defineProperty(adapter, 'activeId', {
    get: () => theme.activeId,
    enumerable: true,
    configurable: true,
  })
  Object.defineProperty(adapter, 'fontScale', {
    get: () => theme.fontScale,
    enumerable: true,
    configurable: true,
  })

  adapter.applyTheme = (value: unknown): unknown => {
    const requested = String(value).trim().toLowerCase()
    if (typeof theme.applyTheme === 'function') return theme.applyTheme(requested)
    if (requested === 'auto') {
      throw new Error('the theme service cannot follow the system scheme; "auto" is resolved by the QML host')
    }
    if (typeof theme.setActive !== 'function') {
      throw new Error('the theme service offers neither applyTheme() nor setActive()')
    }
    return theme.setActive(requested)
  }

  adapter.setFontScale = (scale: number): unknown => {
    if (typeof theme.setFontScale !== 'function') {
      throw new Error('the theme service has no setFontScale()')
    }
    return theme.setFontScale(scale)
  }

  return adapter
}

/**
 * Adapter for the settings store.
 *
 * `SettingsStore.set()` throws `UnknownSettingError`/`SettingValidationError`;
 * the QML bridge must answer `accepted: false` instead, because an invalid value
 * is user input, not a crash. Both behaviours are normalised to a boolean.
 */
export function settingsFromStore(store: SettingsLike): QmlBridgeSettings {
  const adapter: QmlBridgeSettings = {
    get(name: string): unknown {
      return store.get(name)
    },
    set(name: string, value: unknown): boolean {
      try {
        const outcome = store.set(name, value)
        // `SettingsStore.set` returns void on success and throws on refusal;
        // the t20 QML bridge returns a boolean. Normalise both.
        return outcome !== false
      } catch {
        return false
      }
    },
  }
  if (typeof store.save === 'function') {
    adapter.save = () => store.save?.()
  }
  if (typeof store.all === 'function') {
    adapter.all = () => store.all?.()
  }
  return adapter
}

/** Adapter for any function that accepts a submitted message body. */
export function composerFromHandler(
  handler: (text: string) => unknown,
): QmlBridgeComposer {
  return {
    async submit(text: string): Promise<unknown> {
      return await handler(text)
    },
  }
}

/** Services the app hands to {@link createServiceBridge}. */
export interface BridgeServices {
  renderer?: RendererLike
  theme?: ThemeServiceLike
  settings?: SettingsLike
  composer?: (text: string) => unknown
}

/**
 * Build a bridge over the real services.
 *
 * Everything is optional: a headless test may attach only a renderer, and the
 * QML side gets a clean `unavailable` error for whatever is missing rather than
 * a half-wired bridge that fails in interesting ways later.
 */
export function createServiceBridge(
  services: BridgeServices,
  options: Omit<QmlBridgeOptions, 'renderer' | 'theme' | 'settings' | 'composer'> = {},
): QmlBridge {
  const wired: QmlBridgeOptions = { ...options }
  // Parsing always has a portable implementation, so QML can always obtain an
  // AST even when no Node service is attached at all.
  wired.parser = options.parser ?? fallbackParserAdapter
  if (services.renderer !== undefined) wired.renderer = rendererFromService(services.renderer)
  if (services.theme !== undefined) wired.theme = themeFromService(services.theme)
  if (services.settings !== undefined) wired.settings = settingsFromStore(services.settings)
  if (services.composer !== undefined) wired.composer = composerFromHandler(services.composer)
  return new QmlBridge(wired)
}

/**
 * The minimal shape of a Cordis context this module reads.
 *
 * Structural rather than an import of `Context` so a test can pass a plain
 * object, and so this file does not depend on a service being registered.
 */
export interface BridgeContextLike {
  qtRenderer?: RendererLike
  theme?: ThemeServiceLike
  settings?: SettingsLike
}

/** Build a bridge straight from a Cordis context. */
export function createContextBridge(
  ctx: BridgeContextLike,
  options: Omit<QmlBridgeOptions, 'renderer' | 'theme' | 'settings' | 'composer'> & {
    composer?: (text: string) => unknown
    logger?: QmlBridgeLogger
  } = {},
): QmlBridge {
  const services: BridgeServices = {}
  if (ctx.qtRenderer !== undefined) services.renderer = ctx.qtRenderer
  if (ctx.theme !== undefined) services.theme = ctx.theme
  if (ctx.settings !== undefined) services.settings = ctx.settings
  if (options.composer !== undefined) services.composer = options.composer
  const { composer: _composer, ...rest } = options
  return createServiceBridge(services, rest)
}

/** Re-exported so callers need only one import. */
export type { QmlBridgeEventSource }
