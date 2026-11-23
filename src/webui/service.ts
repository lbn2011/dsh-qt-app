/**
 * `WebuiService` — the on-demand WebUI fallback state machine (`I5`).
 *
 * Design points that the Qt host relies on:
 *
 *   * **Default off.** Construction starts no timer, no child, no listener; the
 *     status is `Idle`. Only `open()` leaves `Idle`.
 *   * **Single instance.** A second `open()` while opening joins the in-flight
 *     attempt; a second `open()` while `Ready` returns the same listener with
 *     `reused: true`. There is never more than one listener owned by this
 *     process.
 *   * **Same process first, second process as fallback.** `auto` tries the
 *     in-process mount twice and only then spawns `dsh web`, because only the
 *     in-process mount shares the session tree (P4 warning otherwise).
 *   * **Token isolation.** `status.maskedUrl` is the only URL the UI can read;
 *     the raw `authenticatedUrl` is handed out exactly once by
 *     `takeAuthenticatedUrl()` for the native `webui.token` reply.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

import type { HostBridgeService } from '../host/bridge-service.js'
import { createInProcessBackend } from './in-process.js'
import type { InProcessBackendOptions } from './in-process.js'
import { createChildBackend } from './process.js'
import type { ChildBackendOptions } from './process.js'
import { maskAuthenticatedUrl, maskTokenInText } from './token.js'
import { failureReasonOf, WebuiError } from './types.js'
import type {
  WebuiBackend,
  WebuiBackendHandle,
  WebuiFailureReason,
  WebuiMode,
  WebuiOpenResult,
  WebuiProbeResult,
  WebuiStatus,
} from './types.js'

/** Overall deadline for one `webui.open` (matches `DEFAULT_METHOD_TIMEOUTS`). */
export const DEFAULT_OPEN_TIMEOUT_MS = 20_000
/** Per-attempt readiness deadline handed to the backend. */
export const DEFAULT_READY_TIMEOUT_MS = 8_000
/** Attempt plan for `mode: 'auto'`: same process twice, then a child. */
export const DEFAULT_MODE_PLAN: readonly WebuiMode[] = ['in-process', 'in-process', 'child']
/** Backoff between attempts. */
export const DEFAULT_BACKOFF_MS: readonly number[] = [250, 750]
/** Shown whenever the fallback runs in its own process (P4). */
export const SHARED_SESSION_NOTICE =
  '此回退在新进程中运行：会话与当前窗口不共享，历史不互通；需要连续会话请使用同进程回退或官方 dsh web。'

export interface WebuiLogger {
  info?(message: string): void
  warn?(message: string): void
}

export interface WebuiServiceConfig {
  /** Bind address for the listener. Defaults to `127.0.0.1`. */
  readonly host?: string
  /** Bind port; `0` asks the OS for a free port (default). */
  readonly port?: number
  /** Overall `open()` deadline. */
  readonly openTimeoutMs?: number
  /** Per-attempt readiness deadline. */
  readonly readyTimeoutMs?: number
  /** Attempt plan; the last entry repeats when it is shorter than the plan. */
  readonly modePlan?: readonly WebuiMode[]
  readonly backoffMs?: readonly number[]
  /** Backends; tests inject fakes here. */
  readonly inProcess?: InProcessBackendOptions
  readonly child?: ChildBackendOptions
  /** Backend overrides, keyed by mode; tests inject fakes here. */
  readonly backends?: Partial<Record<WebuiMode, WebuiBackend>>
  readonly logger?: WebuiLogger
}

interface AttemptFailure {
  readonly reason: WebuiFailureReason
  readonly message: string
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Owns the optional listener. Registered as the `webui` service.
 */
export class WebuiService extends Service {
  private readonly config_: Required<Pick<WebuiServiceConfig, 'host' | 'port' | 'openTimeoutMs' | 'readyTimeoutMs' | 'modePlan'>> &
    Pick<WebuiServiceConfig, 'backoffMs' | 'logger'>
  private readonly backends_: Map<WebuiMode, WebuiBackend>
  private readonly statusListeners_ = new Set<(status: WebuiStatus) => void>()
  private status_: WebuiStatus = {
    state: 'Idle',
    mode: null,
    sharedSession: false,
    maskedUrl: null,
    reason: null,
    attempts: 0,
    slotId: null,
    notice: null,
  }
  private handle_: WebuiBackendHandle | null = null
  private rawUrl_: string | null = null
  private opening_: Promise<WebuiOpenResult> | null = null
  private closing_: Promise<void> | null = null
  private unwatchExit_: (() => void) | null = null
  private disposed_ = false

  constructor(ctx: Context, config: WebuiServiceConfig = {}) {
    super(ctx, 'webui')
    this.config_ = {
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 0,
      openTimeoutMs: config.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS,
      readyTimeoutMs: config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      modePlan: config.modePlan ?? DEFAULT_MODE_PLAN,
      ...(config.backoffMs === undefined ? {} : { backoffMs: config.backoffMs }),
      ...(config.logger === undefined ? {} : { logger: config.logger }),
    }
    this.backends_ = new Map<WebuiMode, WebuiBackend>([
      ['in-process', createInProcessBackend(ctx, config.inProcess ?? {})],
      ['child', createChildBackend(config.child ?? {})],
    ])
    for (const [mode, backend] of Object.entries(config.backends ?? {})) {
      if (backend !== undefined) this.backends_.set(mode as WebuiMode, backend)
    }
  }

  /** Current status. Always safe to hand to QML (no token). */
  get status(): WebuiStatus {
    return this.status_
  }

  /** Subscribe to status changes (the `webui.state` event source). */
  onState(listener: (status: WebuiStatus) => void): () => void {
    this.statusListeners_.add(listener)
    return () => this.statusListeners_.delete(listener)
  }

  /**
   * Start (or reuse) the fallback listener.
   *
   * @param options.slotId - the slot that asked for DOM, recorded for the UI.
   * @returns the open result; `reused` is `true` when nothing new was started.
   */
  async open(options: { slotId?: string | null } = {}): Promise<WebuiOpenResult> {
    if (this.disposed_) throw new WebuiError('closed', 'webui: the service is disposed')
    const slotId = options.slotId ?? null
    if (this.opening_ !== null) {
      // Same instance, same promise: two clicks must not bind two listeners.
      return await this.opening_
    }
    if (this.status_.state === 'Ready' && this.handle_ !== null && this.status_.maskedUrl !== null) {
      this.patch({ slotId })
      return {
        mode: this.status_.mode ?? 'in-process',
        maskedUrl: this.status_.maskedUrl,
        sharedSession: this.status_.sharedSession,
        notice: this.status_.notice,
        reused: true,
      }
    }
    if (this.closing_ !== null) await this.closing_
    this.opening_ = this.runOpen_(slotId)
    try {
      return await this.opening_
    } finally {
      this.opening_ = null
    }
  }

  /** Release the listener we own. Never touches anything else. */
  async close(): Promise<void> {
    if (this.closing_ !== null) return await this.closing_
    const handle = this.handle_
    if (handle === null && this.status_.state !== 'Failed') return
    this.closing_ = this.runClose_(handle)
    try {
      await this.closing_
    } finally {
      this.closing_ = null
    }
  }

  /**
   * Observe the listener without changing it.
   *
   * The fence fingerprint is the official one: an unauthenticated `GET /`
   * answers `401` with `dsh web authentication required`, while a `403` on
   * `/api` means the browser-trust fence is in place.
   */
  async probe(): Promise<WebuiProbeResult> {
    const maskedUrl = this.status_.maskedUrl
    if (maskedUrl === null) {
      return { state: this.status_.state, reachable: false, authenticated: null, reason: this.status_.reason }
    }
    const origin = new URL(maskedUrl).origin
    try {
      const response = await fetch(`${origin}/`, { redirect: 'manual' })
      const body = await response.text().catch(() => '')
      if (response.status === 401) {
        const fenced = body.includes('dsh web authentication required')
        return { state: this.status_.state, reachable: true, authenticated: false, reason: fenced ? null : 'refused' }
      }
      if (response.status === 303 || response.status === 200) {
        return { state: this.status_.state, reachable: true, authenticated: true, reason: null }
      }
      return { state: this.status_.state, reachable: true, authenticated: null, reason: null }
    } catch {
      return { state: this.status_.state, reachable: false, authenticated: null, reason: 'refused' }
    }
  }

  /**
   * Hand the raw authenticated URL to the native layer exactly once.
   *
   * @returns `origin?token=…` on the first call after `open()`, then `null`.
   *   The value is meant for the `webui.token` reply only; the C++ host strips
   *   it before any QML signal sees it.
   */
  takeAuthenticatedUrl(): string | null {
    const url = this.rawUrl_
    this.rawUrl_ = null
    return url
  }

  dispose(): void {
    this.disposed_ = true
    this.unwatchExit_?.()
    this.unwatchExit_ = null
    void this.handle_?.close().catch(() => undefined)
    this.handle_ = null
    this.rawUrl_ = null
    this.statusListeners_.clear()
  }

  private async runOpen_(slotId: string | null): Promise<WebuiOpenResult> {
    const deadline = Date.now() + this.config_.openTimeoutMs
    const failures: AttemptFailure[] = []
    const plan = this.config_.modePlan
    this.patch({ state: 'Resolving', reason: null, attempts: 0, slotId, maskedUrl: null, mode: null })

    for (let index = 0; index < plan.length; index += 1) {
      if (this.disposed_) throw new WebuiError('closed', 'webui: the service was disposed while opening')
      const mode = plan[index] ?? 'child'
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        failures.push({ reason: 'timeout', message: 'webui: open deadline exceeded before the last attempt' })
        break
      }
      const backoff = this.config_.backoffMs?.[index] ?? 0
      if (index > 0 && backoff > 0) await sleep(Math.min(backoff, Math.max(0, remaining)))

      this.patch({ state: 'Spawning', mode, attempts: index + 1 })
      let handle: WebuiBackendHandle | null = null
      try {
        const backend = this.backends_.get(mode)
        if (backend === undefined) throw new WebuiError('unavailable', `webui: no backend for ${mode}`)
        handle = await backend.start({
          host: this.config_.host,
          port: this.config_.port,
          readyTimeoutMs: Math.min(this.config_.readyTimeoutMs, Math.max(1_000, remaining)),
          slotId,
        })
        this.patch({ state: 'WaitingReady' })
        const ready = await handle.ready()
        const maskedUrl = maskAuthenticatedUrl(ready.authenticatedUrl)
        this.handle_ = handle
        this.rawUrl_ = ready.authenticatedUrl
        this.unwatchExit_ = handle.onExit((reason) => {
          this.handle_ = null
          this.rawUrl_ = null
          this.unwatchExit_ = null
          this.patch({ state: 'Failed', reason, maskedUrl: null, sharedSession: false })
          this.config_.logger?.warn?.(`webui: the listener died (${reason})`)
        })
        this.patch({
          state: 'Ready',
          mode: handle.mode,
          sharedSession: handle.sharedSession,
          maskedUrl,
          reason: null,
          notice: handle.sharedSession ? null : SHARED_SESSION_NOTICE,
        })
        this.config_.logger?.info?.(
          `webui: ready via ${handle.mode} at ${new URL(ready.origin).origin}${
            handle.reusedCredentials ? ' (reused host credentials)' : ''
          }`,
        )
        return {
          mode: handle.mode,
          maskedUrl,
          sharedSession: handle.sharedSession,
          notice: this.status_.notice,
          reused: false,
        }
      } catch (error) {
        const reason = failureReasonOf(error, mode === 'child' ? 'spawn-failed' : 'mount-failed')
        const message = maskTokenInText(error instanceof Error ? error.message : String(error))
        failures.push({ reason, message })
        this.config_.logger?.warn?.(`webui: attempt ${String(index + 1)} (${mode}) failed: ${message}`)
        if (handle !== null) {
          try {
            await handle.close()
          } catch {
            // already gone
          }
        }
      }
    }

    const last = failures.at(-1) ?? { reason: 'unavailable' as WebuiFailureReason, message: 'webui: no attempt was made' }
    this.patch({
      state: 'Failed',
      reason: last.reason,
      maskedUrl: null,
      sharedSession: false,
      notice: null,
      attempts: failures.length,
    })
    throw new WebuiError(last.reason, last.message, failures.length)
  }

  private async runClose_(handle: WebuiBackendHandle | null): Promise<void> {
    this.unwatchExit_?.()
    this.unwatchExit_ = null
    this.patch({ state: 'Stopping' })
    try {
      if (handle !== null) await handle.close()
    } catch (error) {
      this.config_.logger?.warn?.(
        `webui: close failed: ${maskTokenInText(error instanceof Error ? error.message : String(error))}`,
      )
    }
    this.handle_ = null
    this.rawUrl_ = null
    this.patch({
      state: 'Idle',
      mode: null,
      sharedSession: false,
      maskedUrl: null,
      reason: null,
      attempts: 0,
      notice: null,
    })
  }

  private patch(next: Partial<WebuiStatus>): void {
    this.status_ = { ...this.status_, ...next }
    for (const listener of this.statusListeners_) {
      try {
        listener(this.status_)
      } catch {
        // a listener must not break the state machine
      }
    }
  }
}

/**
 * Wire the service to the Qt host: `webui.open|close|probe|token` requests plus
 * the `webui.state` event stream.
 *
 * `webui.token` is the only method whose reply contains the bearer token; the
 * C++ host answers it natively and never republishes it to QML.
 *
 * @param host - the Qt host bridge.
 * @param service - the fallback service.
 * @returns a disposer that unregisters every method and the event forwarder.
 */
export function attachWebuiToHost(host: HostBridgeService, service: WebuiService): () => void {
  const disposers: Array<() => void> = [
    host.register('webui.open', (params) => {
      const slotId =
        typeof params === 'object' && params !== null && 'slotId' in params
          ? ((params as { slotId?: unknown }).slotId as string | null | undefined) ?? null
          : null
      return service.open({ slotId })
    }),
    host.register('webui.close', async () => {
      await service.close()
      return { closed: true }
    }),
    host.register('webui.probe', () => service.probe()),
    host.register('webui.token', () => {
      const authenticatedUrl = service.takeAuthenticatedUrl()
      return authenticatedUrl === null
        ? { authenticatedUrl: null, maskedUrl: service.status.maskedUrl }
        : { authenticatedUrl, maskedUrl: service.status.maskedUrl }
    }),
    service.onState((status) => {
      host.emitEvent('webui.state', status)
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // idempotent by contract
      }
    }
  }
}

/** The four method names this module registers. */
export const WEBUI_METHODS = ['webui.open', 'webui.close', 'webui.probe', 'webui.token'] as const
