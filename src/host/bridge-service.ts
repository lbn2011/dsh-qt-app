// src/host/bridge-service.ts — host side of protocol v1.
//
// The service owns one Qt child process (through a {@link HostTransport}) and
// is the `ctx.hostBridge` service the rest of Phase 3 talks to:
//
//   * `register(method, handler)` — answer requests the UI sends (`req` → `res`)
//   * `emitEvent(name, payload)` — push session/tool events to the UI (`evt`)
//   * `invoke(method, params)`   — call into the UI (`req` → `res`)
//
// Lifecycle is explicit because "the UI looks connected" has to mean the
// handshake actually completed, not that a pipe happens to be open:
//
//   idle → connecting ──hello.ack sent──▶ connected
//                    └──timeout/protocol──▶ disconnected
//   connected ──EOF/exit/protocol──▶ disconnected
//   any launch failure ──▶ unavailable        (the rest of the profile runs)
//
// Request bookkeeping is intentionally strict: ids are unique for the life of
// the session, a request has exactly one outcome, late replies are dropped by
// id, and disposal detaches before rejecting so no handler can answer into a
// dead session.

import type { ChildProcess } from 'node:child_process'

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

import {
  MAX_INBOUND_FRAME_BYTES,
  PROTOCOL_VERSION,
  isRpcErrorCode,
  makeError,
} from '../bridge/protocol.js'
import type {
  Envelope,
  EvtFrame,
  HelloAckFrame,
  ProtocolError,
  ReqFrame,
  ResFrame,
  RpcErrorCode,
} from '../bridge/protocol.js'

import { launchQtHost } from './launcher.js'
import type { LaunchQtHostOptions, LaunchedQtHost } from './launcher.js'
import type { HostTransport, HostTransportStats } from './transport.js'

/** States reported by {@link HostBridgeService.state}. */
export type HostBridgeState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'unavailable'

/** Minimal logger; structurally compatible with the Cordis logger. */
export interface HostBridgeLogger {
  warn(message: string, ...rest: unknown[]): void
}

export interface HostBridgeConfig {
  /** Spawn the Qt binary when `start()` runs. Tests set this to false. */
  autoLaunch?: boolean
  /** Explicit binary path; otherwise the launcher searches its candidates. */
  binaryPath?: string
  /** Package root override (tests). */
  root?: string
  /** Extra environment for the child (e.g. `QT_QPA_PLATFORM`). */
  launchEnv?: NodeJS.ProcessEnv
  /** Extra argv after the binary. */
  launchArgs?: string[]
  /** Name advertised in `hello.ack`. */
  hostName?: string
  /** Time allowed between spawning and the Qt `hello` + our `hello.ack`. */
  handshakeTimeoutMs?: number
  /** Default per-request timeout for host → Qt calls. */
  requestTimeoutMs?: number
  /** Per-method overrides; see {@link DEFAULT_METHOD_TIMEOUTS}. */
  methodTimeouts?: Record<string, number>
  logger?: HostBridgeLogger
  /** Inbound frame limit override (tests). */
  maxInboundFrameBytes?: number
}

/** Frozen timeouts from the Phase 3 contract. */
export const DEFAULT_METHOD_TIMEOUTS: Readonly<Record<string, number>> = Object.freeze({
  'markdown.render': 10_000,
  'plugin.install': 120_000,
  'plugin.update': 120_000,
  'plugin.remove': 120_000,
  'webui.open': 20_000,
})

export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000

/** Capabilities this host advertises in `hello.ack`. */
const HOST_CAPS: readonly string[] = [
  'markdown.parse',
  'markdown.render',
  'code.highlight',
  'theme.apply',
  'theme.scale',
  'settings.get',
  'settings.set',
  'settings.save',
  'settings.all',
  'composer.submit',
  'ping',
]

/** A handler answers one `req`; a throw becomes an error `res`. */
export type HostBridgeHandler = (params: unknown) => unknown | Promise<unknown>

/** Error thrown by handlers (or `invoke`) with an explicit protocol code. */
export class HostBridgeError extends Error {
  readonly code: RpcErrorCode

  constructor(code: RpcErrorCode, message: string) {
    super(message)
    this.name = 'HostBridgeError'
    this.code = code
  }
}

export interface HostBridgeStats {
  state: HostBridgeState
  pid: number | null
  epoch: string | null
  pending: number
  handled: number
  failed: number
  timeouts: number
  cancelled: number
  duplicateIds: number
  lateReplies: number
  duplicateEvents: number
  protocolErrors: number
  ignoredFrames: number
  eventsOut: number
  eventsIn: number
  lastError: string | null
  transport: HostTransportStats | null
}

export interface HostEvent {
  name: string
  payload: unknown
  topic?: { session?: string; turn?: string }
  seq: number
  epoch: string
}

export interface HostAttachment {
  transport: HostTransport
  child?: ChildProcess
  pid?: number
}

interface InFlight {
  id: string
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type StateListener = (state: HostBridgeState, previous: HostBridgeState) => void
type EventListener = (event: HostEvent) => void

/**
 * Host end of the UI bridge.
 *
 * Registered as `ctx.hostBridge` by the plugin's `apply()`; the Qt binary is
 * launched from `start()` (normally through `ctx.effect`).
 */
export class HostBridgeService extends Service {
  private readonly config_: HostBridgeConfig
  private readonly logger_: HostBridgeLogger | undefined
  private readonly handlers_ = new Map<string, HostBridgeHandler>()
  private readonly pending_ = new Map<string, InFlight>()
  private readonly seenQtIds_ = new Set<string>()
  private readonly seenQtIdOrder_: string[] = []
  private readonly stateListeners_ = new Set<StateListener>()
  private readonly eventListeners_ = new Set<EventListener>()
  private readonly detach_: Array<() => void> = []

  private transport_: HostTransport | null = null
  private child_: ChildProcess | null = null
  private pid_: number | null = null
  private state_: HostBridgeState = 'idle'
  private epoch_: string | null = null
  private lastEventSeq_ = -1
  private sequence_ = 0
  private eventSeq_ = 0
  private lastError_: string | null = null
  private handshakeTimer_: NodeJS.Timeout | null = null
  private failing_ = false
  private disposed_ = false

  private handled_ = 0
  private failed_ = 0
  private timedOut_ = 0
  private cancelled_ = 0
  private duplicateIds_ = 0
  private lateReplies_ = 0
  private duplicateEvents_ = 0
  private protocolErrors_ = 0
  private ignoredFrames_ = 0
  private eventsOut_ = 0
  private eventsIn_ = 0

  constructor(ctx: Context, config: HostBridgeConfig = {}) {
    super(ctx, 'hostBridge')
    this.config_ = config
    this.logger_ = config.logger
  }

  get state(): HostBridgeState {
    return this.state_
  }

  get epoch(): string | null {
    return this.epoch_
  }

  get pid(): number | null {
    return this.pid_
  }

  get lastError(): string | null {
    return this.lastError_
  }

  get stats(): HostBridgeStats {
    return {
      state: this.state_,
      pid: this.pid_,
      epoch: this.epoch_,
      pending: this.pending_.size,
      handled: this.handled_,
      failed: this.failed_,
      timeouts: this.timedOut_,
      cancelled: this.cancelled_,
      duplicateIds: this.duplicateIds_,
      lateReplies: this.lateReplies_,
      duplicateEvents: this.duplicateEvents_,
      protocolErrors: this.protocolErrors_,
      ignoredFrames: this.ignoredFrames_,
      eventsOut: this.eventsOut_,
      eventsIn: this.eventsIn_,
      lastError: this.lastError_,
      transport: this.transport_ === null ? null : this.transport_.stats,
    }
  }

  /**
   * Register the handler for one method.
   *
   * @returns an unregister function (idempotent).
   */
  register(method: string, handler: HostBridgeHandler): () => void {
    if (method === '') throw new Error('method must be a non-empty string')
    if (this.handlers_.has(method)) {
      throw new Error(`a handler is already registered for ${method}`)
    }
    this.handlers_.set(method, handler)
    return () => {
      if (this.handlers_.get(method) === handler) this.handlers_.delete(method)
    }
  }

  unregister(method: string): boolean {
    return this.handlers_.delete(method)
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners_.add(listener)
    return () => this.stateListeners_.delete(listener)
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners_.add(listener)
    return () => this.eventListeners_.delete(listener)
  }

  /** Launch the Qt host (when configured to) and begin the handshake. */
  start(): void {
    if (this.disposed_ || this.transport_ !== null) return
    if (this.config_.autoLaunch === false) return
    this.launch()
  }

  /**
   * Spawn the Qt binary and attach to its stdio.
   *
   * @returns the launched host, or `null` when there is nothing to launch (an
   *   explicit `binaryPath` that does not exist is still a failed launch).
   */
  launch(): LaunchedQtHost | null {
    if (this.disposed_) return null
    if (this.transport_ !== null) {
      this.logger_?.warn('qt host bridge is already attached; ignoring launch()')
      return null
    }
    try {
      const launched = launchQtHost(this.launchOptions_())
      this.attach({
        transport: launched.transport,
        child: launched.child,
        ...(launched.pid === undefined ? {} : { pid: launched.pid }),
      })
      return launched
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError_ = message
      this.setState_('unavailable')
      this.logger_?.warn('failed to launch the Qt host: %s', message)
      return null
    }
  }

  /**
   * Attach to an already-spawned Qt process (the e2e test path).
   *
   * The transport is started here; the handshake begins when the Qt `hello`
   * arrives, so nothing marks the UI connected until that and our `hello.ack`.
   */
  attach(connection: HostAttachment): void {
    if (this.disposed_) throw new Error('cannot attach to a disposed host bridge')
    if (this.transport_ !== null) throw new Error('host bridge is already attached')

    this.transport_ = connection.transport
    this.child_ = connection.child ?? null
    this.pid_ = connection.pid ?? connection.child?.pid ?? null

    this.detach_.push(connection.transport.onFrame((frame) => this.handleFrame_(frame)))
    this.detach_.push(connection.transport.onError((error) => this.handleTransportError_(error)))
    this.detach_.push(connection.transport.onClose((reason) => this.handleClose_(reason)))
    connection.transport.start()

    if (connection.child !== undefined) {
      connection.child.once('exit', (code, signal) => this.handleChildExit_(code, signal))
      connection.child.once('error', (error) => this.handleChildError_(error))
    }

    this.setState_('connecting')
    this.handshakeTimer_ = setTimeout(() => {
      this.handshakeTimer_ = null
      if (this.state_ !== 'connecting') return
      this.fail_('timeout', 'the Qt host did not answer the handshake within 5 s')
    }, this.config_.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS)
    this.handshakeTimer_.unref()
  }

  /** True while the protocol handshake completed and the pipe is live. */
  get connected(): boolean {
    return this.state_ === 'connected'
  }

  /**
   * Call the UI.
   *
   * Rejects with `unavailable` before the handshake and with `timeout` after
   * the deadline; a timed-out request keeps its id reserved, so a late reply is
   * dropped rather than delivered to a second caller.
   */
  invoke(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
    if (this.disposed_) {
      return Promise.reject(new HostBridgeError('cancelled', 'host bridge is disposed'))
    }
    if (this.state_ !== 'connected' || this.transport_ === null) {
      return Promise.reject(
        new HostBridgeError('unavailable', `the Qt host is not connected (state: ${this.state_})`),
      )
    }
    const id = `host-${++this.sequence_}`
    const timeoutMs = options.timeoutMs ?? this.timeoutFor_(method)
    const frame: ReqFrame = {
      v: PROTOCOL_VERSION,
      kind: 'req',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending_.get(id)
        if (pending === undefined) return
        this.pending_.delete(id)
        this.timedOut_ += 1
        reject(new HostBridgeError('timeout', `no reply to ${method} within ${timeoutMs} ms`))
      }, timeoutMs)
      // This timer is deliberately *not* unref'd: it is the only thing that
      // settles the caller's promise. Unref'd, a caller waiting on a silent host
      // is left with no active handle, and Node 22 drains the event loop with the
      // request still pending (`Promise resolution is still pending but the event
      // loop has already resolved`), which cancelled the rest of the suite. It is
      // cleared on settle (see `settle_`) and on dispose, so a connected host does
      // not keep the process alive after every request has been answered.
      this.pending_.set(id, { id, method, resolve, reject, timer })
      const transport = this.transport_
      const written =
        transport === null ? makeError('unavailable', 'transport is gone') : transport.send(frame)
      if (written !== null) {
        this.settle_(id)
        reject(new HostBridgeError(written.code, written.message))
      }
    })
  }

  /** Push one event to the UI. Requires a completed handshake. */
  emitEvent(name: string, payload?: unknown, topic?: HostEvent['topic']): void {
    if (name === '') throw new HostBridgeError('bad-params', 'event name must be non-empty')
    if (this.state_ !== 'connected' || this.transport_ === null || this.epoch_ === null) {
      throw new HostBridgeError('unavailable', `the Qt host is not connected (state: ${this.state_})`)
    }
    const frame: EvtFrame = {
      v: PROTOCOL_VERSION,
      kind: 'evt',
      seq: this.eventSeq_++,
      epoch: this.epoch_,
      name,
      ...(topic === undefined ? {} : { topic }),
      ...(payload === undefined ? {} : { payload }),
    }
    const error = this.transport_.send(frame)
    if (error !== null) throw new HostBridgeError(error.code, error.message)
    this.eventsOut_ += 1
  }

  /**
   * Detach, then reject everything in flight, then ask the child to exit.
   *
   * Order matters: a handler that settles after disposal must find no transport
   * and no pending entry, so it cannot write into a closed session.
   */
  dispose(): void {
    if (this.disposed_) return
    this.disposed_ = true

    for (const off of this.detach_.splice(0)) off()
    if (this.handshakeTimer_ !== null) {
      clearTimeout(this.handshakeTimer_)
      this.handshakeTimer_ = null
    }
    const transport = this.transport_
    this.transport_ = null
    transport?.stop('host bridge disposed')

    for (const [id, pending] of [...this.pending_]) {
      clearTimeout(pending.timer)
      pending.reject(new HostBridgeError('cancelled', 'host bridge disposed; request cancelled'))
      this.pending_.delete(id)
    }
    this.cancelled_ += 1

    const child = this.child_
    this.child_ = null
    if (child !== null) {
      child.removeAllListeners('exit')
      child.removeAllListeners('error')
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.stdin?.end()
        } catch {
          // The pipe is already gone; the kill below still applies.
        }
        const killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill()
        }, 500)
        killTimer.unref()
      }
    }
    this.setState_('disconnected')
  }

  // ── frames ────────────────────────────────────────────────────────────────

  private handleFrame_(frame: Envelope): void {
    switch (frame.kind) {
      case 'hello':
        this.handleHello_(frame)
        return
      case 'nack':
        this.fail_('protocol', `the Qt host rejected the handshake: ${frame.code}: ${frame.message}`)
        return
      case 'res':
        this.handleReply_(frame)
        return
      case 'req':
        this.handleRequest_(frame)
        return
      case 'evt':
        this.handleEvent_(frame)
        return
      case 'hello.ack':
        // The host is the one that sends acks; an ack from Qt is meaningless.
        this.ignoredFrames_ += 1
        return
      default:
        this.ignoredFrames_ += 1
    }
  }

  private handleHello_(frame: Extract<Envelope, { kind: 'hello' }>): void {
    if (this.state_ !== 'connecting') {
      this.protocolErrors_ += 1
      this.sendNack_('protocol', 'duplicate hello: a session is already in progress')
      this.fail_('protocol', 'the Qt host sent a second hello for this session')
      return
    }
    this.epoch_ = frame.epoch
    const ack: HelloAckFrame = {
      v: PROTOCOL_VERSION,
      kind: 'hello.ack',
      epoch: frame.epoch,
      host: this.config_.hostName ?? 'dsh-qt-host',
      caps: [...HOST_CAPS],
      limits: { maxFrame: MAX_INBOUND_FRAME_BYTES },
    }
    // `send()` returns null on success; do not collapse it with `??`.
    const transport = this.transport_
    if (transport === null) {
      this.fail_('unavailable', 'could not write hello.ack: transport is gone')
      return
    }
    const error = transport.send(ack)
    if (error !== null) {
      this.fail_('unavailable', `could not write hello.ack: ${error.message}`)
      return
    }
    if (this.handshakeTimer_ !== null) {
      clearTimeout(this.handshakeTimer_)
      this.handshakeTimer_ = null
    }
    // Connected means "we answered the handshake", not "a pipe exists".
    this.setState_('connected')
  }

  private handleReply_(frame: Extract<Envelope, { kind: 'res' }>): void {
    const pending = this.pending_.get(frame.id)
    if (pending === undefined) {
      this.lateReplies_ += 1
      return
    }
    this.pending_.delete(frame.id)
    clearTimeout(pending.timer)
    if (frame.ok) {
      this.handled_ += 1
      pending.resolve(frame.result)
    } else {
      this.failed_ += 1
      pending.reject(new HostBridgeError(frame.error.code, frame.error.message))
    }
  }

  private handleRequest_(frame: Extract<Envelope, { kind: 'req' }>): void {
    if (this.state_ !== 'connected') {
      this.sendResError_(frame.id, 'unavailable', `the Qt host is not connected (state: ${this.state_})`)
      return
    }
    if (this.seenQtIds_.has(frame.id)) {
      this.duplicateIds_ += 1
      this.sendResError_(frame.id, 'duplicate-id', `request id ${frame.id} was already used`)
      return
    }
    this.rememberQtId_(frame.id)

    const handler = this.handlers_.get(frame.method)
    if (handler === undefined) {
      this.sendResError_(frame.id, 'unknown-method', `unknown method: ${frame.method}`)
      return
    }

    // Exactly one reply per request: a handler can neither double-answer nor
    // answer after a protocol failure by racing the settle guard.
    let settled = false
    Promise.resolve()
      .then(() => handler(frame.params))
      .then(
        (result) => {
          if (settled) return
          settled = true
          if (this.disposed_ || this.transport_ === null) return
          this.handled_ += 1
          const reply: ResFrame = {
            v: PROTOCOL_VERSION,
            kind: 'res',
            id: frame.id,
            ok: true,
            ...(result === undefined ? {} : { result }),
          }
          this.transport_.send(reply)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          if (this.disposed_ || this.transport_ === null) return
          this.failed_ += 1
          const failure = errorFromThrown(error)
          this.sendResError_(frame.id, failure.code, failure.message)
        },
      )
  }

  private handleEvent_(frame: Extract<Envelope, { kind: 'evt' }>): void {
    if (this.epoch_ === null || frame.epoch !== this.epoch_) {
      this.ignoredFrames_ += 1
      return
    }
    if (frame.seq <= this.lastEventSeq_) {
      this.duplicateEvents_ += 1
      return
    }
    this.lastEventSeq_ = frame.seq
    this.eventsIn_ += 1
    const event: HostEvent = {
      name: frame.name,
      payload: frame.payload,
      seq: frame.seq,
      epoch: frame.epoch,
      ...(frame.topic === undefined ? {} : { topic: frame.topic }),
    }
    for (const listener of [...this.eventListeners_]) listener(event)
    if (frame.name === 'transport.state') {
      this.handleQtTransportState_(frame.payload)
    }
  }

  private handleQtTransportState_(payload: unknown): void {
    if (payload === null || typeof payload !== 'object') return
    const state = (payload as { state?: unknown }).state
    if (state === 'connected' && this.state_ === 'connecting') {
      // The hello.ack is written before the Qt state event arrives; this is a
      // belt-and-braces path for transports where the ack write is delayed.
      this.setState_('connected')
    }
  }

  private handleTransportError_(error: ProtocolError): void {
    this.protocolErrors_ += 1
    this.sendNack_(error.code, error.message)
    this.fail_('protocol', `protocol violation from the Qt host: ${error.code}: ${error.message}`)
  }

  private handleClose_(reason: string): void {
    if (this.failing_ || this.disposed_) return
    this.fail_('unavailable', `the Qt host closed the connection: ${reason}`)
  }

  private handleChildExit_(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.disposed_) return
    this.fail_('unavailable', `the Qt host exited (code ${String(code)}, signal ${String(signal)})`)
  }

  private handleChildError_(error: Error): void {
    if (this.disposed_) return
    this.fail_('unavailable', `the Qt host failed to start: ${error.message}`)
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private sendNack_(code: RpcErrorCode, message: string): void {
    if (this.transport_ === null) return
    this.transport_.send({
      v: PROTOCOL_VERSION,
      kind: 'nack',
      code,
      message,
    })
  }

  private sendResError_(id: string, code: RpcErrorCode, message: string): void {
    if (this.transport_ === null) return
    const reply: ResFrame = {
      v: PROTOCOL_VERSION,
      kind: 'res',
      id,
      ok: false,
      error: { code, message },
    }
    this.transport_.send(reply)
  }

  private settle_(id: string): void {
    const pending = this.pending_.get(id)
    if (pending === undefined) return
    this.pending_.delete(id)
    clearTimeout(pending.timer)
    pending.reject(new HostBridgeError('unavailable', 'the frame could not be written'))
  }

  /** Reject everything in flight, close the transport and report the state. */
  private fail_(code: 'protocol' | 'timeout' | 'unavailable', reason: string): void {
    if (this.failing_ || this.disposed_) return
    this.failing_ = true
    this.lastError_ = reason
    this.epoch_ = null
    if (this.handshakeTimer_ !== null) {
      clearTimeout(this.handshakeTimer_)
      this.handshakeTimer_ = null
    }
    const transport = this.transport_
    this.transport_ = null
    transport?.stop(reason)

    for (const [id, pending] of [...this.pending_]) {
      clearTimeout(pending.timer)
      pending.reject(new HostBridgeError('unavailable', `${code}: ${reason}`))
      this.pending_.delete(id)
    }
    this.setState_('disconnected')
    this.failing_ = false
  }

  private setState_(state: HostBridgeState): void {
    if (this.state_ === state) return
    const previous = this.state_
    this.state_ = state
    for (const listener of [...this.stateListeners_]) listener(state, previous)
  }

  private timeoutFor_(method: string): number {
    return (
      this.config_.methodTimeouts?.[method] ??
      DEFAULT_METHOD_TIMEOUTS[method] ??
      this.config_.requestTimeoutMs ??
      DEFAULT_REQUEST_TIMEOUT_MS
    )
  }

  private rememberQtId_(id: string): void {
    this.seenQtIds_.add(id)
    this.seenQtIdOrder_.push(id)
    if (this.seenQtIdOrder_.length > 1024) {
      const oldest = this.seenQtIdOrder_.shift()
      if (oldest !== undefined) this.seenQtIds_.delete(oldest)
    }
  }

  private launchOptions_(): LaunchQtHostOptions {
    const options: LaunchQtHostOptions = {
      ...(this.config_.binaryPath === undefined ? {} : { binaryPath: this.config_.binaryPath }),
      ...(this.config_.root === undefined ? {} : { root: this.config_.root }),
      ...(this.config_.launchEnv === undefined ? {} : { env: this.config_.launchEnv }),
      ...(this.config_.launchArgs === undefined ? {} : { args: this.config_.launchArgs }),
      ...(this.config_.maxInboundFrameBytes === undefined
        ? {}
        : { maxInboundFrameBytes: this.config_.maxInboundFrameBytes }),
    }
    if (this.config_.logger !== undefined) {
      return { ...options, logger: this.config_.logger }
    }
    return options
  }
}

function errorFromThrown(error: unknown): { code: RpcErrorCode; message: string } {
  if (error instanceof HostBridgeError) return { code: error.code, message: error.message }
  if (error !== null && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown }
    if (isRpcErrorCode(candidate.code) && typeof candidate.message === 'string') {
      return { code: candidate.code, message: candidate.message }
    }
  }
  if (error instanceof Error) return { code: 'internal', message: error.message }
  return { code: 'internal', message: String(error) }
}