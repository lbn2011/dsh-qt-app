// src/bridge/qml-bridge.ts — the QML ⇄ Node request boundary.
//
// ## Why this exists
//
// QML runs on the GUI thread. Node rendering (Markdown, syntax highlighting,
// settings persistence) can take tens of milliseconds — long enough to drop
// frames if QML called into it synchronously. So QML never calls Node directly:
// it posts a request and listens for a reply signal.
//
//     QML: dshQt.renderMarkdown(text)   →  returns a request id immediately
//          dshQt.markdownRendered(id, html, error)
//
//     host:  writes {"type":"qml.request","id":…,"method":…,"params":…}
//     this:  drains it on the 10 ms event-loop tick, runs the handler,
//            writes {"type":"qml.reply", …} back
//
// Nothing on this side ever throws at the boundary, and nothing awaits inside
// the event-loop listener: a request that takes 400 ms costs one busy slot, not
// a stalled queue.
//
// ## The invariants worth stating
//
//   1. **Every request gets exactly one reply.** Success, refusal, timeout or
//      crash — one reply, carrying the id it answers. QML holds a pending entry
//      per id, so a missing reply is a leak and a duplicate reply is a bug.
//   2. **A slow handler cannot starve the queue.** Concurrency is bounded and
//      excess work waits in a bounded FIFO. Overflow is rejected *immediately*
//      with `busy`, which is a far better failure than a silent 3-second lag.
//   3. **Handler bugs are contained.** Anything a handler throws becomes an
//      `internal` reply. One broken plugin surface cannot take down the loop.
//   4. **No reply is ever sent synchronously from `handle()`.** Re-entering the
//      drain loop from inside a listener is how you get ordering bugs that only
//      reproduce under load.

import type { EventLoopMessage } from '../event-loop/timer.js'
import type { CodeBlockOptions, MarkdownOptions } from '../types.js'

/** Methods the QML side may call. */
export type QmlBridgeMethod =
  | 'markdown.parse'
  | 'markdown.render'
  | 'code.highlight'
  | 'theme.apply'
  | 'theme.scale'
  | 'settings.get'
  | 'settings.set'
  | 'settings.save'
  | 'settings.all'
  | 'composer.submit'
  | 'ping'

/** Machine-readable failure reasons; stable, because QML branches on them. */
export type QmlBridgeErrorCode =
  | 'unknown-method'
  | 'bad-params'
  | 'unavailable'
  | 'busy'
  | 'timeout'
  | 'refused'
  | 'internal'

/** One failure, as reported both to QML and to the logger. */
export interface QmlBridgeError {
  code: QmlBridgeErrorCode
  message: string
}

/** An inbound request. `id` is minted by the Qt host. */
export interface QmlBridgeRequest {
  id: string
  method: string
  params?: Record<string, unknown>
}

/** The single answer to a request. */
export interface QmlBridgeReply {
  id: string
  method: string
  ok: boolean
  result?: unknown
  error?: QmlBridgeError
  /** Milliseconds spent, measured from receipt (diagnostics only). */
  elapsedMs: number
  timestamp: number
}

/** Outbound message written to the host. */
export interface QmlBridgeOutbound {
  type: 'qml.reply'
  payload: QmlBridgeReply
}

/** Transport sink; in the app this writes a JSON line to the host process. */
export type QmlBridgeSink = (message: QmlBridgeOutbound) => void

/** Minimal logger, compatible with the Cordis `Logger` this package uses. */
export interface QmlBridgeLogger {
  warn(message: string, ...rest: unknown[]): void
}

/**
 * The renderer surface this bridge needs.
 *
 * Deliberately narrower than `QtRendererService`: a test stub, a future
 * out-of-process renderer and the real service all satisfy it, and neither
 * return type is fixed to a promise (the N-API addon may answer synchronously).
 */
export interface QmlBridgeRenderer {
  renderMarkdown(text: string, options?: MarkdownOptions): Promise<string> | string
  highlightCode(code: string, language?: string, options?: CodeBlockOptions): Promise<string> | string
}

/**
 * The parser surface this bridge needs.
 *
 * QML cannot run the TypeScript parser, so the AST the QML renderer consumes
 * has to be produced on this side and shipped across as plain JSON. Keeping this
 * separate from {@link QmlBridgeRenderer} is deliberate: rendering to HTML and
 * parsing to an AST are different jobs, and a host may have one without the
 * other.
 */
export interface QmlBridgeParser {
  /** Parse Markdown into the `MarkdownJSON` document described in the plan §3.1. */
  parseMarkdown(source: string, options?: MarkdownOptions): unknown
}

/** The theme surface this bridge needs. */
export interface QmlBridgeTheme {
  /** Apply a scheme id or mode (`"dark"`, `"light"`, `"auto"`). */
  applyTheme?(value: unknown): unknown
  /** Activate a scheme by id, when the implementation only offers that. */
  setActive?(id: string): unknown
  /** Set the font scale; returns the effective value when it clamps. */
  setFontScale?(scale: number): unknown
  /** Current scheme, read for the reply payload. */
  readonly activeId?: string
  /** Current scale, read for the reply payload. */
  readonly fontScale?: number
}

/** The settings surface this bridge needs. */
export interface QmlBridgeSettings {
  get(name: string): unknown
  set(name: string, value: unknown): boolean
  save?(): unknown
  all?(): unknown
}

/** The composer surface this bridge needs. */
export interface QmlBridgeComposer {
  submit(text: string): unknown
}

/** Anything with `subscribe()`, e.g. `EventLoopBridge`. */
export interface QmlBridgeEventSource {
  subscribe(listener: (message: EventLoopMessage) => void): () => void
}

/** Options for {@link QmlBridge}. */
export interface QmlBridgeOptions {
  renderer?: QmlBridgeRenderer
  parser?: QmlBridgeParser
  theme?: QmlBridgeTheme
  settings?: QmlBridgeSettings
  composer?: QmlBridgeComposer
  /** Where replies go; defaults to a no-op (useful in tests that await only). */
  sink?: QmlBridgeSink
  /** Per-request budget in milliseconds; defaults to 5000. */
  timeoutMs?: number
  /** Requests handled at once; defaults to 8. */
  maxConcurrent?: number
  /** Requests allowed to wait for a slot; defaults to 64. */
  maxPending?: number
  logger?: QmlBridgeLogger
  /** Injectable clock, for tests that assert on `elapsedMs`. */
  now?: () => number
}

/** Live counters, exposed over the `ping` method and to tests. */
export interface QmlBridgeStats {
  handled: number
  failed: number
  rejected: number
  timedOut: number
  inFlight: number
  queued: number
  dropped: number
}

/** Default per-request budget: generous enough for a cold Shiki import. */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 5_000
/** Default concurrency: more than this and the UI is already behind. */
export const DEFAULT_MAX_CONCURRENT = 8
/** Default queue depth: overflow means something is stuck, not merely busy. */
export const DEFAULT_MAX_PENDING = 64

/** Event-loop message type carrying a request that expects a reply. */
export const QML_REQUEST_TYPE = 'qml.request'
/** Event-loop message type carrying a fire-and-forget notification. */
export const QML_NOTIFY_TYPE = 'qml.notify'

/** Every method this bridge answers, in documentation order. */
export const QML_BRIDGE_METHODS: readonly QmlBridgeMethod[] = [
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

/** Thrown by {@link QmlBridge.request} so Node callers can branch on `code`. */
export class QmlBridgeCallError extends Error {
  readonly code: QmlBridgeErrorCode

  constructor(code: QmlBridgeErrorCode, message: string) {
    super(message)
    this.name = 'QmlBridgeError'
    this.code = code
  }
}

function errorOf(code: QmlBridgeErrorCode, message: string): QmlBridgeError {
  return { code, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Request/response bridge between the Qt host and the Node services.
 *
 * Construct it with the services it should expose, hand it a sink, and bind it
 * to the event loop with {@link connectEventLoop}.
 */
export class QmlBridge {
  readonly timeoutMs: number
  readonly maxConcurrent: number
  readonly maxPending: number

  private readonly renderer_: QmlBridgeRenderer | undefined
  private readonly parser_: QmlBridgeParser | undefined
  private readonly theme_: QmlBridgeTheme | undefined
  private readonly settings_: QmlBridgeSettings | undefined
  private readonly composer_: QmlBridgeComposer | undefined
  private readonly logger_: QmlBridgeLogger | undefined
  private readonly now_: () => number

  private sink_: QmlBridgeSink
  private unsubscribes_: Array<() => void> = []

  private inFlight_ = 0
  private queue_: QmlBridgeRequest[] = []
  private seq_ = 0

  private handled_ = 0
  private failed_ = 0
  private rejected_ = 0
  private timedOut_ = 0
  private dropped_ = 0

  constructor(options: QmlBridgeOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(`timeoutMs must be a positive number, received ${String(timeoutMs)}`)
    }
    const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new RangeError(`maxConcurrent must be a positive integer, received ${String(maxConcurrent)}`)
    }
    const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
    if (!Number.isInteger(maxPending) || maxPending < 0) {
      throw new RangeError(`maxPending must be a non-negative integer, received ${String(maxPending)}`)
    }

    this.timeoutMs = timeoutMs
    this.maxConcurrent = maxConcurrent
    this.maxPending = maxPending
    this.renderer_ = options.renderer
    this.parser_ = options.parser
    this.theme_ = options.theme
    this.settings_ = options.settings
    this.composer_ = options.composer
    this.logger_ = options.logger
    this.now_ = options.now ?? (() => Date.now())
    this.sink_ = options.sink ?? (() => {})
  }

  /** Replace the transport (e.g. once the host process is connected). */
  setSink(sink: QmlBridgeSink): void {
    this.sink_ = sink
  }

  /** Bind to an event loop; returns a disposer. Idempotent per source. */
  connectEventLoop(source: QmlBridgeEventSource): () => void {
    const unsubscribe = source.subscribe((message) => {
      this.accept(message)
    })
    this.unsubscribes_.push(unsubscribe)
    return () => {
      unsubscribe()
      this.unsubscribes_ = this.unsubscribes_.filter((entry) => entry !== unsubscribe)
    }
  }

  /**
   * Event-loop entry point.
   *
   * Never throws, never awaits, and never replies synchronously: the reply is
   * always delivered through the sink after the current tick unwinds.
   */
  accept(message: EventLoopMessage): void {
    if (message.type !== QML_REQUEST_TYPE && message.type !== QML_NOTIFY_TYPE) return
    const wantsReply = message.type === QML_REQUEST_TYPE

    let request: QmlBridgeRequest
    try {
      request = this.parseRequest_(message.payload)
    } catch (error) {
      this.dropped_ += 1
      this.logger_?.warn('dropped malformed qml request: %s', String(error))
      if (wantsReply) {
        // A malformed request still deserves an answer, or the host leaks the id.
        const fallbackId = isRecord(message.payload) && typeof message.payload['id'] === 'string'
          ? message.payload['id']
          : `invalid-${++this.seq_}`
        this.emit_({
          id: fallbackId,
          method: 'unknown',
          ok: false,
          error: errorOf('bad-params', `malformed request: ${String(error)}`),
          elapsedMs: 0,
          timestamp: this.now_(),
        })
      }
      return
    }

    if (!wantsReply) {
      // Fire-and-forget: run it, report failures, stay quiet otherwise.
      void this.dispatch(request).then((reply) => {
        if (!reply.ok) this.logger_?.warn('notify %s failed: %s', reply.method, reply.error?.message ?? 'unknown')
      })
      return
    }

    if (this.inFlight_ < this.maxConcurrent) {
      this.run_(request)
      return
    }

    if (this.queue_.length >= this.maxPending) {
      this.rejected_ += 1
      this.logger_?.warn('qml bridge queue full (%d pending); rejecting %s', this.queue_.length, request.method)
      this.emit_({
        id: request.id,
        method: request.method,
        ok: false,
        error: errorOf('busy', `bridge queue is full (${this.queue_.length} pending); retry shortly`),
        elapsedMs: 0,
        timestamp: this.now_(),
      })
      return
    }

    this.queue_.push(request)
  }

  /**
   * Call a method directly from Node.
   *
   * Same dispatcher, same bookkeeping, same errors as a QML call — so a test can
   * exercise the exact path the host uses without staging a fake transport.
   *
   * @throws {QmlBridgeCallError} when the handler fails.
   */
  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const request: QmlBridgeRequest = { id: `local-${++this.seq_}`, method }
    if (params !== undefined) request.params = params
    const reply = await this.dispatch(request)
    if (!reply.ok) {
      const failure = reply.error ?? errorOf('internal', 'request failed without an error')
      throw new QmlBridgeCallError(failure.code, failure.message)
    }
    return reply.result
  }

  /**
   * Run one request to completion and build its reply.
   *
   * Public because the event loop is not the only caller: `request()` uses it,
   * and tests use it to assert on replies without a transport.
   */
  async dispatch(request: QmlBridgeRequest): Promise<QmlBridgeReply> {
    const started = this.now_()
    const finish = (partial: Omit<QmlBridgeReply, 'id' | 'method' | 'elapsedMs' | 'timestamp'>): QmlBridgeReply => {
      this.handled_ += 1
      if (partial.ok !== true) this.failed_ += 1
      const reply: QmlBridgeReply = {
        id: request.id,
        method: request.method,
        ok: partial.ok,
        elapsedMs: Math.max(0, this.now_() - started),
        timestamp: this.now_(),
      }
      if (partial.result !== undefined) reply.result = partial.result
      if (partial.error !== undefined) reply.error = partial.error
      return reply
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          this.timedOut_ += 1
          reject(new QmlBridgeCallError('timeout', `${request.method} exceeded ${String(this.timeoutMs)} ms`))
        }, this.timeoutMs)
        // A pending request must not keep a test process (or a shutting-down
        // host) alive on its own; the caller still sees the rejection.
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
      })

      const work = this.invoke_(request)
      const result = await Promise.race([work, timeout])
      return finish({ ok: true, result })
    } catch (error) {
      if (error instanceof QmlBridgeCallError) {
        return finish({ ok: false, error: errorOf(error.code, error.message) })
      }
      // A handler bug must not escape as an unhandled rejection.
      const message = error instanceof Error ? error.message : String(error)
      this.logger_?.warn('qml bridge handler %s threw: %s', request.method, message)
      return finish({ ok: false, error: errorOf('internal', message) })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Live counters. */
  get stats(): QmlBridgeStats {
    return {
      handled: this.handled_,
      failed: this.failed_,
      rejected: this.rejected_,
      timedOut: this.timedOut_,
      inFlight: this.inFlight_,
      queued: this.queue_.length,
      dropped: this.dropped_,
    }
  }

  /** Drop queued work and detach from the event loop. Idempotent. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribes_) {
      try {
        unsubscribe()
      } catch {
        // A disposed source must not prevent the rest from unsubscribing.
      }
    }
    this.unsubscribes_ = []
    this.dropped_ += this.queue_.length
    this.queue_ = []
  }

  // -- internals ------------------------------------------------------------

  private parseRequest_(payload: unknown): QmlBridgeRequest {
    if (!isRecord(payload)) throw new TypeError('payload must be an object')
    const id = payload['id']
    const method = payload['method']
    if (typeof id !== 'string' || id === '') throw new TypeError('payload.id must be a non-empty string')
    if (typeof method !== 'string' || method === '') throw new TypeError('payload.method must be a non-empty string')
    const request: QmlBridgeRequest = { id, method }
    const params = payload['params']
    if (params !== undefined && params !== null) {
      if (!isRecord(params)) throw new TypeError('payload.params must be an object')
      request.params = params
    }
    return request
  }

  private run_(request: QmlBridgeRequest): void {
    this.inFlight_ += 1
    void this.dispatch(request)
      .then((reply) => {
        this.emit_(reply)
      })
      .catch((error: unknown) => {
        // dispatch() is written not to reject; this is belt and braces so a
        // future edit cannot silently swallow a reply.
        this.logger_?.warn('qml bridge dispatch escaped: %s', String(error))
        this.emit_({
          id: request.id,
          method: request.method,
          ok: false,
          error: errorOf('internal', String(error)),
          elapsedMs: 0,
          timestamp: this.now_(),
        })
      })
      .finally(() => {
        this.inFlight_ -= 1
        this.drainQueue_()
      })
  }

  private drainQueue_(): void {
    while (this.inFlight_ < this.maxConcurrent && this.queue_.length > 0) {
      const next = this.queue_.shift()
      if (next === undefined) return
      this.run_(next)
    }
  }

  private emit_(reply: QmlBridgeReply): void {
    try {
      this.sink_({ type: 'qml.reply', payload: reply })
    } catch (error) {
      // A broken transport must not turn into an unhandled rejection.
      this.logger_?.warn('qml bridge sink threw: %s', String(error))
    }
  }

  private async invoke_(request: QmlBridgeRequest): Promise<unknown> {
    const params = request.params ?? {}
    switch (request.method as QmlBridgeMethod | string) {
      case 'ping':
        return { pong: true, stats: this.stats, methods: QML_BRIDGE_METHODS }

      case 'markdown.parse': {
        const parser = this.parser_
        if (parser === undefined) throw new QmlBridgeCallError('unavailable', 'no markdown parser is attached')
        const source = this.requireString_(params, 'text')
        const options = this.optionalRecord_(params, 'options') as MarkdownOptions | undefined
        const document = options === undefined
          ? parser.parseMarkdown(source)
          : parser.parseMarkdown(source, options)
        return { document }
      }

      case 'markdown.render': {
        const renderer = this.renderer_
        if (renderer === undefined) throw new QmlBridgeCallError('unavailable', 'no renderer is attached')
        const text = this.requireString_(params, 'text')
        const options = this.optionalRecord_(params, 'options') as MarkdownOptions | undefined
        const html = options === undefined
          ? await renderer.renderMarkdown(text)
          : await renderer.renderMarkdown(text, options)
        return { html }
      }

      case 'code.highlight': {
        const renderer = this.renderer_
        if (renderer === undefined) throw new QmlBridgeCallError('unavailable', 'no renderer is attached')
        const code = this.requireString_(params, 'code')
        const language = this.optionalString_(params, 'language')
        const options = this.optionalRecord_(params, 'options') as CodeBlockOptions | undefined
        const markup = language === undefined
          ? await renderer.highlightCode(code)
          : options === undefined
            ? await renderer.highlightCode(code, language)
            : await renderer.highlightCode(code, language, options)
        return { markup }
      }

      case 'theme.apply': {
        const theme = this.theme_
        if (theme === undefined) throw new QmlBridgeCallError('unavailable', 'no theme service is attached')
        // Accept `mode` (the QML argument name) and `themeId` (the domain name).
        const raw = params['mode'] ?? params['themeId']
        if (typeof raw !== 'string' || raw.trim() === '') {
          throw new QmlBridgeCallError('bad-params', 'theme.apply needs a non-empty "mode" or "themeId"')
        }
        const value = raw.trim()
        let applied: unknown = value
        if (typeof theme.applyTheme === 'function') applied = theme.applyTheme(value)
        else if (typeof theme.setActive === 'function') applied = theme.setActive(value)
        else throw new QmlBridgeCallError('unavailable', 'the theme service offers neither applyTheme() nor setActive()')
        return { applied, activeId: theme.activeId ?? null }
      }

      case 'theme.scale': {
        const theme = this.theme_
        if (theme === undefined) throw new QmlBridgeCallError('unavailable', 'no theme service is attached')
        if (typeof theme.setFontScale !== 'function') {
          throw new QmlBridgeCallError('unavailable', 'the theme service has no setFontScale()')
        }
        const scale = params['scale']
        if (typeof scale !== 'number' || !Number.isFinite(scale)) {
          throw new QmlBridgeCallError('bad-params', 'theme.scale needs a finite numeric "scale"')
        }
        const effective = theme.setFontScale(scale)
        return {
          // A service that clamps reports the value it actually took.
          scale: typeof effective === 'number' && Number.isFinite(effective) ? effective : theme.fontScale ?? scale,
        }
      }

      case 'settings.get': {
        const settings = this.settings_
        if (settings === undefined) throw new QmlBridgeCallError('unavailable', 'no settings store is attached')
        const name = this.requireString_(params, 'name')
        return { name, value: settings.get(name) ?? null }
      }

      case 'settings.set': {
        const settings = this.settings_
        if (settings === undefined) throw new QmlBridgeCallError('unavailable', 'no settings store is attached')
        const name = this.requireString_(params, 'name')
        if (!Object.hasOwn(params, 'value')) {
          throw new QmlBridgeCallError('bad-params', 'settings.set needs a "value"')
        }
        const accepted = settings.set(name, params['value']) === true
        // A refusal is a legitimate answer, not an exception: QML reverts the
        // control and reads the stored value back.
        return { name, accepted, value: settings.get(name) ?? null }
      }

      case 'settings.save': {
        const settings = this.settings_
        if (settings === undefined) throw new QmlBridgeCallError('unavailable', 'no settings store is attached')
        if (typeof settings.save !== 'function') {
          throw new QmlBridgeCallError('unavailable', 'the settings store cannot save explicitly')
        }
        await settings.save()
        return { saved: true }
      }

      case 'settings.all': {
        const settings = this.settings_
        if (settings === undefined) throw new QmlBridgeCallError('unavailable', 'no settings store is attached')
        if (typeof settings.all !== 'function') {
          throw new QmlBridgeCallError('unavailable', 'the settings store cannot list its values')
        }
        return { values: settings.all() }
      }

      case 'composer.submit': {
        const composer = this.composer_
        if (composer === undefined) throw new QmlBridgeCallError('unavailable', 'no composer is attached')
        const text = this.requireString_(params, 'text')
        if (text.trim() === '') throw new QmlBridgeCallError('bad-params', 'composer.submit needs non-empty text')
        const outcome = await composer.submit(text)
        // A composer may answer with `false`, with `{accepted: false}`, or with
        // anything truthy. Treating the object form as "accepted" would silently
        // mark a refused turn as delivered, which is the one answer the UI acts on.
        const accepted = outcome === false
          ? false
          : isRecord(outcome) && typeof outcome['accepted'] === 'boolean'
            ? outcome['accepted']
            : true
        return { accepted }
      }

      default:
        throw new QmlBridgeCallError(
          'unknown-method',
          `unknown method ${request.method}; known: ${QML_BRIDGE_METHODS.join(', ')}`,
        )
    }
  }

  private requireString_(params: Record<string, unknown>, key: string): string {
    const value = params[key]
    if (typeof value !== 'string') {
      throw new QmlBridgeCallError('bad-params', `"${key}" must be a string`)
    }
    return value
  }

  private optionalString_(params: Record<string, unknown>, key: string): string | undefined {
    const value = params[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') throw new QmlBridgeCallError('bad-params', `"${key}" must be a string when present`)
    return value
  }

  private optionalRecord_(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
    const value = params[key]
    if (value === undefined || value === null) return undefined
    if (!isRecord(value)) throw new QmlBridgeCallError('bad-params', `"${key}" must be an object when present`)
    return value
  }
}

/** Convenience factory. */
export function createQmlBridge(options: QmlBridgeOptions = {}): QmlBridge {
  return new QmlBridge(options)
}
