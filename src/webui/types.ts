/**
 * Shared vocabulary for the on-demand WebUI fallback (`I5`).
 *
 * The state names, method names and the `sharedSession` flag are the wire
 * contract with the Qt host (see `docs/handoff/I5-webui.md`); the Qt side
 * switches on exactly these strings, so they must not drift.
 */

/**
 * Lifecycle of the fallback listener.
 *
 * `Idle` is the default: the plugin mounts with no listener, no child process
 * and no timer. Every other state is only reachable from an explicit
 * `webui.open` request.
 */
export type WebuiState =
  | 'Idle'
  | 'Resolving'
  | 'Spawning'
  | 'WaitingReady'
  | 'Ready'
  | 'Failed'
  | 'Stopping'

/** Which candidate carried the listener. */
export type WebuiMode = 'in-process' | 'child'

/** Why a state is `Failed` (also the `reason` in a rejected `webui.open`). */
export type WebuiFailureReason =
  | 'timeout'
  | 'unavailable'
  | 'mount-failed'
  | 'spawn-failed'
  | 'crashed'
  | 'refused'
  | 'closed'

/**
 * Everything the UI may know about the fallback.
 *
 * This payload is broadcast as the `webui.state` event, so it is QML-readable
 * by design and therefore **must never carry a token**: `maskedUrl` is the only
 * URL field here.
 */
export interface WebuiStatus {
  readonly state: WebuiState
  readonly mode: WebuiMode | null
  /** `true` only when the listener shares this process' session tree. */
  readonly sharedSession: boolean
  readonly maskedUrl: string | null
  readonly reason: WebuiFailureReason | null
  readonly attempts: number
  readonly slotId: string | null
  /** User-visible caveat, e.g. the second-process session warning. */
  readonly notice: string | null
}

/** Reply to `webui.open`. Carries no token. */
export interface WebuiOpenResult {
  readonly mode: WebuiMode
  readonly maskedUrl: string
  readonly sharedSession: boolean
  readonly notice: string | null
  /** `true` when an already-running listener was reused instead of a new one. */
  readonly reused: boolean
}

/** Reply to `webui.probe`. */
export interface WebuiProbeResult {
  readonly state: WebuiState
  readonly reachable: boolean
  /**
   * `null` when the fence could not be observed (not listening, or the reply
   * was neither the auth challenge nor a success).
   */
  readonly authenticated: boolean | null
  readonly reason: WebuiFailureReason | null
}

/** What a backend resolves once its listener is bound. */
export interface WebuiReady {
  /** `http(s)://host:port`, no token. Safe to log. */
  readonly origin: string
  /** `origin?token=…` — native-only, never forwarded to QML. */
  readonly authenticatedUrl: string
}

/** One running listener, owned by this process. */
export interface WebuiBackendHandle {
  readonly mode: WebuiMode
  readonly sharedSession: boolean
  /** `true` when the backend reused a service the host already provided. */
  readonly reusedCredentials: boolean
  /** Resolves once the socket is bound and the URL is known. */
  ready(): Promise<WebuiReady>
  /**
   * Release the listener. Only ever touches resources this handle created:
   * its own fibers or its own child process.
   */
  close(): Promise<void>
  /** Notified when the listener dies outside `close()` (child crash, …). */
  onExit(listener: (reason: WebuiFailureReason) => void): () => void
}

export interface WebuiBackendStartOptions {
  readonly host: string
  readonly port: number
  readonly readyTimeoutMs: number
  /** Slot the surface was requested for, when the caller named one. */
  readonly slotId?: string | null
}

/** Strategy for binding the listener: same-process mount or a child `dsh web`. */
export interface WebuiBackend {
  readonly mode: WebuiMode
  start(options: WebuiBackendStartOptions): Promise<WebuiBackendHandle>
}

/** Error carrying the machine-readable reason that ends up in `webui.state`. */
export class WebuiError extends Error {
  readonly reason: WebuiFailureReason
  readonly attempts: number

  constructor(reason: WebuiFailureReason, message: string, attempts = 0) {
    super(message)
    this.name = 'WebuiError'
    this.reason = reason
    this.attempts = attempts
  }
}

/** Narrow an unknown thrown value to a `WebuiFailureReason`. */
export function failureReasonOf(error: unknown, fallback: WebuiFailureReason): WebuiFailureReason {
  return error instanceof WebuiError ? error.reason : fallback
}
