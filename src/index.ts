/**
 * Cordis plugin entry point for the DSH Qt6/QML profile.
 *
 * The plugin provides a single service, `ctx.qtRenderer`, which is the API the
 * QML host and other plugins talk to:
 *
 *  - Markdown / code highlighting, delegated to the `dsh-qt-napi` addon with a
 *    degraded fallback so a missing binary never breaks the host.
 *  - Native dialogs, resolved asynchronously by the Qt side.
 *  - View registration (`registerView`) and plugin slot contributions
 *    (`registerSlot`) for the surfaces the native UI renders itself.
 *  - The 10 ms event-loop bridge that carries QML events into Node.
 *
 * See `docs/architecture.md` for the surrounding picture and
 * `docs/superpowers/specs/2026-11-22-dsh-qt-implementation-plan.md` §2.1 for the
 * contract this file implements.
 */
import type { Context, Logger } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'

import {
  EVENT_LOOP_TICK_MS,
  NATIVE_SLOT_SURFACES,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  QML_ENTRY_URL,
} from './constants.js'
import type { SettingsSlotSurface } from './constants.js'
import { EventLoopBridge, createEventLoopBridge } from './event-loop/timer.js'
import { highlight as highlightSource } from './highlight/index.js'
import type { EventLoopBridgeOptions, EventLoopStats } from './event-loop/timer.js'
import { loadNapiModule } from './qt-bridge/napi-loader.js'
import type { NapiBridge, NapiLoadResult } from './qt-bridge/napi-loader.js'
import type {
  CodeBlockOptions,
  DialogOptions,
  DialogResult,
  MarkdownOptions,
  QtSlotContribution,
  QtViewRegistration,
} from './types.js'

export * from './constants.js'
export * from './types.js'
export { EventLoopBridge, MessageQueue, createEventLoopBridge } from './event-loop/timer.js'
export type {
  EventLoopBridgeOptions,
  EventLoopListener,
  EventLoopMessage,
  EventLoopPost,
  EventLoopStats,
} from './event-loop/timer.js'
export { createFallbackBridge, discoverCandidates, escapeHtml, isNapiBridge, loadNapiModule, prebuildTriple } from './qt-bridge/napi-loader.js'
export type { NapiBridge, NapiLoadOptions, NapiLoadResult, NapiSource } from './qt-bridge/napi-loader.js'

/**
 * Slot surfaces the settings panel (`qml/views/settings/`) hosts.
 *
 * `conversation.settings.section` contributions become extra tabs alongside the
 * built-in Theme / Plugins / About tabs, and `conversation.settings.form`
 * contributions are rendered as forms inside the tab named by their `section`
 * field. Declared here as well as in `constants.ts` so the plugin entry is the
 * one place a plugin author reads to discover what the native UI accepts;
 * `tests/settings-slots.test.ts` keeps the two declarations identical.
 */
export const SETTINGS_SLOT_SURFACES = [
  'conversation.settings.section',
  'conversation.settings.form',
] as const satisfies readonly SettingsSlotSurface[]

/** Cordis plugin display name. */
export const name = PLUGIN_NAME

/** Plugin version, reported by `ctx.qtRenderer.stats`. */
export const version = PLUGIN_VERSION

/**
 * Services this plugin needs before it may start.
 *
 * Empty: the renderer must be mountable on its own so the Qt host can boot even
 * when no other plugin is installed.
 */
export const inject: string[] = []

/** Configuration accepted by the plugin (and by `new QtRendererService`). */
export interface QtPluginConfig {
  /** Event-loop cadence in milliseconds; defaults to 10. */
  tickMs?: number
  /** Queue capacity; defaults to `MESSAGE_QUEUE_MAX`. */
  maxQueue?: number
  /** Start the event-loop timer on mount; defaults to true. */
  autoStartEventLoop?: boolean
  /** Pre-built bridge (tests / embedders); skips discovery. */
  bridge?: NapiBridge
  /** Explicit addon path; overrides discovery. */
  napiPath?: string
  /** Register the native slot surfaces on mount; defaults to true. */
  declareNativeSurfaces?: boolean
}

/** Snapshot returned by `ctx.qtRenderer.stats`. */
export interface QtRendererStats extends EventLoopStats {
  name: string
  version: string
  views: number
  slots: number
  surfaces: number
  pendingDialogs: number
  bridgeSource: string
  bridgeDegraded: boolean
}

/**
 * The `ctx.qtRenderer` service.
 *
 * Registered by `super(ctx, 'qtRenderer')`, so it disappears with the owning
 * fiber (unload, reload, crash) without manual teardown.
 */
export class QtRendererService extends Service {
  /** 10 ms bridge carrying QML events into Node. */
  readonly eventLoop: EventLoopBridge
  /** Loaded N-API bridge (real addon or degraded fallback). */
  readonly bridge: NapiBridge
  /** Discovery diagnostics for the bridge. */
  readonly bridgeLoad: NapiLoadResult

  /** Registered QML views, keyed by id. */
  readonly views = new Map<string, QtViewRegistration>()
  /** Plugin slot contributions, keyed by `surface:id`. */
  readonly slots = new Map<string, QtSlotContribution>()
  /** Slot surfaces the native UI can render. */
  readonly surfaces = new Set<string>()

  // NOTE: plain `private` fields, not `#private`. Cordis wraps every service in
  // a traceable Proxy and invokes members with a "shadow" receiver, so ECMAScript
  // private fields would throw "Cannot read private member" at runtime.
  private logger_: Logger | undefined
  private dialogSeq_ = 0
  private pendingDialogs_ = new Map<string, (result: DialogResult) => void>()

  constructor(ctx: Context, options: QtPluginConfig = {}) {
    super(ctx, 'qtRenderer')

    this.logger_ = ctx.logger(PLUGIN_NAME)

    const bridgeLoad: NapiLoadResult = options.bridge
      ? { bridge: options.bridge, degraded: false, source: 'explicit', attempted: [] }
      : loadNapiModule(options.napiPath === undefined ? {} : { explicitPath: options.napiPath })
    this.bridgeLoad = bridgeLoad
    this.bridge = bridgeLoad.bridge

    const bridgeOptions: EventLoopBridgeOptions = {
      tickMs: options.tickMs ?? EVENT_LOOP_TICK_MS,
      onError: (error, message) => {
        this.logger_?.warn('event-loop listener failed (%s): %s', message?.type ?? 'unknown', String(error))
      },
    }
    if (options.maxQueue !== undefined) bridgeOptions.maxQueue = options.maxQueue
    this.eventLoop = createEventLoopBridge(bridgeOptions)

    if (options.declareNativeSurfaces ?? true) {
      for (const surface of NATIVE_SLOT_SURFACES) this.surfaces.add(surface)
    }

    if (bridgeLoad.degraded) {
      this.logger_?.warn(
        'dsh-qt-napi binding not found; using degraded renderer (tried %d candidates)',
        bridgeLoad.attempted.length,
      )
    } else {
      this.logger_?.info('dsh-qt-napi binding loaded from %s', bridgeLoad.source)
    }
  }

  /** QML resource URL the host should load. */
  get qmlEntry(): string {
    return QML_ENTRY_URL
  }

  /** Render Markdown through the N-API addon (or the degraded fallback). */
  async renderMarkdown(text: string, options?: MarkdownOptions): Promise<string> {
    return await this.bridge.renderMarkdown(text, options)
  }

  /**
   * Highlight a code block as Qt rich-text markup.
   *
   * Phase 2 decision D1: highlighting is a pure-TypeScript concern. Shiki is used
   * when the host happens to have it installed, otherwise the built-in tokenizer
   * answers, and a block longer than `maxHighlightChars` is returned uncoloured
   * rather than tokenized. The N-API addon deliberately does no highlighting, so
   * it is not consulted here.
   */
  async highlightCode(code: string, language?: string, options?: CodeBlockOptions): Promise<string> {
    const result = await highlightSource(code, language, {
      ...(options?.theme === undefined ? {} : { scheme: options.theme }),
    })
    return result.html
  }

  /**
   * Show a native dialog and wait for the Qt side to settle it.
   *
   * The Qt host receives the dialog id through the event loop and answers with
   * {@link resolveDialog}; a dialog that is never answered keeps its promise
   * pending, so callers should apply their own timeout.
   *
   * @throws RangeError when `options.buttons` is empty.
   */
  async showDialog(options: DialogOptions): Promise<DialogResult> {
    if (options.buttons.length === 0) {
      throw new RangeError('showDialog() requires at least one button')
    }
    const id = `dialog-${++this.dialogSeq_}`
    const promise = new Promise<DialogResult>((resolve) => {
      this.pendingDialogs_.set(id, resolve)
    })
    this.eventLoop.post({
      type: 'dialog.open',
      payload: { id, title: options.title, message: options.message, buttons: options.buttons, icon: options.icon },
    })
    return await promise
  }

  /**
   * Settle a pending dialog from the Qt side.
   *
   * @returns true when a dialog with that id was waiting.
   */
  resolveDialog(id: string, result: DialogResult): boolean {
    const resolve = this.pendingDialogs_.get(id)
    if (!resolve) return false
    this.pendingDialogs_.delete(id)
    resolve(result)
    return true
  }

  /** Ids of dialogs awaiting an answer. */
  pendingDialogs(): string[] {
    return [...this.pendingDialogs_.keys()]
  }

  /** Register a QML view; returns a disposer. */
  registerView(id: string, qmlPath: string): () => void {
    this.views.set(id, { id, qmlPath })
    return () => {
      this.views.delete(id)
    }
  }

  /** Registered views, insertion order. */
  listViews(): QtViewRegistration[] {
    return [...this.views.values()]
  }

  /** Register a plugin slot contribution; returns a disposer. */
  registerSlot(contribution: QtSlotContribution): () => void {
    const key = `${contribution.surface}:${contribution.id}`
    this.slots.set(key, contribution)
    return () => {
      this.slots.delete(key)
    }
  }

  /** Remove a slot contribution. */
  unregisterSlot(surface: string, id: string): boolean {
    return this.slots.delete(`${surface}:${id}`)
  }

  /** Slot contributions, optionally filtered by surface. */
  listSlots(surface?: string): QtSlotContribution[] {
    const all = [...this.slots.values()]
    return surface === undefined ? all : all.filter((slot) => slot.surface === surface)
  }

  /** Declare that the native UI renders `surface`. */
  declareSurface(surface: string): void {
    this.surfaces.add(surface)
  }

  /** Declared slot surfaces. */
  listSurfaces(): string[] {
    return [...this.surfaces]
  }

  /** Snapshot of service counters. */
  get stats(): QtRendererStats {
    return {
      ...this.eventLoop.stats,
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      views: this.views.size,
      slots: this.slots.size,
      surfaces: this.surfaces.size,
      pendingDialogs: this.pendingDialogs_.size,
      bridgeSource: this.bridgeLoad.source,
      bridgeDegraded: this.bridgeLoad.degraded,
    }
  }
}

/**
 * Cordis apply hook: create the renderer service and drive its event loop for
 * as long as the plugin fiber is alive.
 *
 * @param ctx — the Cordis context the plugin is mounted on.
 * @param config — optional plugin configuration.
 */
export function apply(ctx: Context, config: QtPluginConfig = {}): void {
  const renderer = new QtRendererService(ctx, config)

  if (config.autoStartEventLoop ?? true) {
    ctx.effect(() => {
      renderer.eventLoop.start()
      return () => {
        renderer.eventLoop.stop()
      }
    }, 'dsh-qt-app: event loop')
  }
}

/**
 * Object-style plugin export, accepted by `ctx.plugin(dshQtApp)` in addition to
 * the named `apply` export.
 */
export default { name, inject, apply }
