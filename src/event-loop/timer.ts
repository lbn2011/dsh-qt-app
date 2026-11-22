/**
 * Event-loop bridge between the Qt/QML host and Node's libuv loop.
 *
 * QML emits UI events from the Qt thread; Node must consume them on the libuv
 * thread without ever blocking Qt. The bridge is a fixed-cadence drain loop:
 *
 *   Qt side  --post()-->  MessageQueue  --tick() @10ms-->  listeners
 *
 * Design notes:
 *  - `tickMs` defaults to `EVENT_LOOP_TICK_MS` (10ms) so UI feedback latency
 *    stays under one frame while idle CPU cost stays negligible.
 *  - `tick()` is re-entrancy guarded: a listener that calls `post()` (or even
 *    `tick()`) cannot recurse into a nested drain, which would otherwise let a
 *    chatty plugin starve the rest of the loop.
 *  - The queue is bounded (`MESSAGE_QUEUE_MAX`) and drops the *oldest* entries,
 *    so a stalled consumer degrades into lost frames instead of unbounded
 *    memory growth.
 *  - Listener exceptions are routed to `onError`; one broken subscriber must
 *    not stop delivery to the others.
 */
import { EVENT_LOOP_TICK_MS, MESSAGE_QUEUE_MAX } from '../constants.js'

/** One message travelling from the Qt host into Node. */
export interface EventLoopMessage {
  /** Channel name, e.g. `composer.submit`. */
  type: string
  /** Channel payload; opaque to the bridge. */
  payload?: unknown
  /** Milliseconds since epoch, stamped by `post()` unless supplied. */
  timestamp: number
}

/** Message accepted by `EventLoopBridge.post()`. */
export interface EventLoopPost {
  type: string
  payload?: unknown
  timestamp?: number
}

/** Listener invoked for every drained message. */
export type EventLoopListener = (message: EventLoopMessage) => void

/** Options for {@link EventLoopBridge}. */
export interface EventLoopBridgeOptions {
  /** Tick cadence in milliseconds; defaults to 10. */
  tickMs?: number
  /** Queue capacity; defaults to 4096. */
  maxQueue?: number
  /** Messages delivered per tick; defaults to 64. */
  maxBatchPerTick?: number
  /** Do not keep the Node process alive for the timer; defaults to true. */
  unref?: boolean
  /** Optional single sink, called before subscribers. */
  onMessage?: EventLoopListener
  /** Called when a sink/subscriber throws. */
  onError?: (error: unknown, message?: EventLoopMessage) => void
}

/** Live counters exposed by `EventLoopBridge.stats`. */
export interface EventLoopStats {
  ticks: number
  processed: number
  dropped: number
  pending: number
  listeners: number
  running: boolean
}

/**
 * Bounded FIFO with drop-oldest overflow policy.
 *
 * `push()` returns `false` when it had to evict an older message, which lets
 * callers surface backpressure to the Qt side.
 */
export class MessageQueue<T> {
  readonly maxSize: number
  #items: T[] = []
  #dropped = 0

  constructor(maxSize: number = MESSAGE_QUEUE_MAX) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new RangeError(`MessageQueue maxSize must be a positive integer, received ${String(maxSize)}`)
    }
    this.maxSize = maxSize
  }

  /** Number of queued items. */
  get size(): number {
    return this.#items.length
  }

  /** Number of items evicted since construction (or the last `clear()`). */
  get dropped(): number {
    return this.#dropped
  }

  /** True when nothing is queued. */
  get isEmpty(): boolean {
    return this.#items.length === 0
  }

  /** Enqueue one item; returns false when an older item had to be evicted. */
  push(item: T): boolean {
    let evicted = false
    while (this.#items.length >= this.maxSize) {
      this.#items.shift()
      this.#dropped += 1
      evicted = true
    }
    this.#items.push(item)
    return !evicted
  }

  /** Remove and return up to `limit` items, oldest first. */
  drain(limit: number = this.#items.length): T[] {
    if (limit <= 0) return []
    return this.#items.splice(0, limit)
  }

  /** Inspect the oldest item without removing it. */
  peek(): T | undefined {
    return this.#items[0]
  }

  /** Drop everything currently queued (does not reset the dropped counter). */
  clear(): void {
    this.#items = []
  }
}

/** Fixed-cadence drain loop driving QML → Node delivery. */
export class EventLoopBridge {
  readonly tickMs: number
  readonly maxBatchPerTick: number
  readonly queue: MessageQueue<EventLoopMessage>

  #timer: NodeJS.Timeout | undefined
  #listeners = new Set<EventLoopListener>()
  #draining = false
  #ticks = 0
  #processed = 0
  #unref: boolean
  #onMessage: EventLoopListener | undefined
  #onError: ((error: unknown, message?: EventLoopMessage) => void) | undefined

  constructor(options: EventLoopBridgeOptions = {}) {
    const tickMs = options.tickMs ?? EVENT_LOOP_TICK_MS
    if (!Number.isFinite(tickMs) || tickMs <= 0) {
      throw new RangeError(`tickMs must be a positive number, received ${String(tickMs)}`)
    }
    this.tickMs = tickMs
    this.maxBatchPerTick = options.maxBatchPerTick ?? 64
    this.queue = new MessageQueue<EventLoopMessage>(options.maxQueue ?? MESSAGE_QUEUE_MAX)
    this.#unref = options.unref ?? true
    this.#onMessage = options.onMessage
    this.#onError = options.onError
  }

  /** True while the interval is installed. */
  get running(): boolean {
    return this.#timer !== undefined
  }

  /** Install the drain interval; idempotent. */
  start(): void {
    if (this.#timer !== undefined) return
    const timer = setInterval(() => {
      this.tick()
    }, this.tickMs)
    // Never keep the host process alive just for UI polling.
    if (this.#unref) timer.unref()
    this.#timer = timer
  }

  /** Remove the drain interval; idempotent. Queued messages are retained. */
  stop(): void {
    if (this.#timer === undefined) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  /** Alias of {@link stop} for `ctx.effect()` disposers. */
  dispose(): void {
    this.stop()
  }

  /**
   * Enqueue one message.
   *
   * @returns false when the bounded queue had to evict an older message.
   */
  post(message: EventLoopPost): boolean {
    const envelope: EventLoopMessage = {
      type: message.type,
      timestamp: message.timestamp ?? Date.now(),
    }
    if (message.payload !== undefined) envelope.payload = message.payload
    return this.queue.push(envelope)
  }

  /** Register a listener; returns an unsubscribe function. */
  subscribe(listener: EventLoopListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Drain one batch synchronously.
   *
   * Re-entrant calls (from inside a listener) return 0 without draining, so the
   * loop always unwinds back to the timer.
   *
   * @returns number of messages delivered.
   */
  tick(): number {
    if (this.#draining) return 0
    this.#draining = true
    this.#ticks += 1
    let delivered = 0
    try {
      const batch = this.queue.drain(this.maxBatchPerTick)
      for (const message of batch) {
        delivered += 1
        this.#deliver(message)
      }
    } finally {
      this.#draining = false
      this.#processed += delivered
    }
    return delivered
  }

  /** Snapshot of the counters. */
  get stats(): EventLoopStats {
    return {
      ticks: this.#ticks,
      processed: this.#processed,
      dropped: this.queue.dropped,
      pending: this.queue.size,
      listeners: this.#listeners.size,
      running: this.running,
    }
  }

  #deliver(message: EventLoopMessage): void {
    if (this.#onMessage) {
      try {
        this.#onMessage(message)
      } catch (error) {
        this.#reportError(error, message)
      }
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(message)
      } catch (error) {
        this.#reportError(error, message)
      }
    }
  }

  #reportError(error: unknown, message: EventLoopMessage): void {
    if (this.#onError) {
      try {
        this.#onError(error, message)
      } catch {
        // An error reporter that throws must not break the drain loop.
      }
      return
    }
    // Fall back to stderr: silently swallowing listener bugs hides real faults.
    console.error('[dsh-qt-app] event-loop listener failed:', error)
  }
}

/** Convenience factory mirroring the 10ms bridge used by the Qt host. */
export function createEventLoopBridge(options: EventLoopBridgeOptions = {}): EventLoopBridge {
  return new EventLoopBridge(options)
}
