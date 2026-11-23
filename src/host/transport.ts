// src/host/transport.ts — newline-delimited protocol v1 transport.
//
// The Node host owns the Qt child process and therefore owns the pipes:
// outbound frames go to the child's stdin, inbound frames arrive on its stdout.
// This module is the only place that knows about those streams; the bridge
// service above it deals in frames, never in chunks.
//
// Two failure classes are deliberately distinct:
//
//   * **Transport failure** (`onError`) — the peer sent something that violates
//     protocol v1 (bad JSON, a frame over the limit, an unsupported envelope).
//     The bridge answers with `nack` and closes; it must not pretend the
//     streams are still usable.
//   * **Stream close** (`onClose`) — EOF, pipe error or an explicit `stop()`.
//     Requests in flight cannot be answered after this point.
//
// Bytes are counted before decoding so a malformed-but-huge frame is reported
// as a size violation rather than a JSON error.

import { NdjsonDecoder, encodeFrame } from '../bridge/protocol.js'
import type { Envelope, ProtocolError } from '../bridge/protocol.js'

/** Minimal logger; structurally compatible with the Cordis logger. */
export interface HostTransportLogger {
  warn(message: string, ...rest: unknown[]): void
}

export interface HostTransportOptions {
  /** Frames from the Qt process (normally `child.stdout`). */
  input: NodeJS.ReadableStream
  /** Frames to the Qt process (normally `child.stdin`). */
  output: NodeJS.WritableStream
  /** Override the inbound frame limit (tests only). */
  maxInboundFrameBytes?: number
  logger?: HostTransportLogger
}

/** Live counters for diagnostics and `ctx.hostBridge.stats`. */
export interface HostTransportStats {
  framesIn: number
  framesOut: number
  bytesIn: number
  bytesOut: number
  writeErrors: number
}

type FrameListener = (frame: Envelope) => void
type ErrorListener = (error: ProtocolError) => void
type CloseListener = (reason: string) => void

/**
 * NDJSON transport over an already-open pair of streams.
 *
 * `start()` attaches listeners once; `stop()` detaches them and reports any
 * truncated tail as a protocol error before announcing the close. `send()`
 * returns the encoding error instead of throwing: callers answer a request with
 * that error rather than crashing the host.
 */
export class HostTransport {
  private readonly input_: NodeJS.ReadableStream
  private readonly output_: NodeJS.WritableStream
  private readonly logger_: HostTransportLogger | undefined
  private readonly decoder_: NdjsonDecoder

  private frameListeners_ = new Set<FrameListener>()
  private errorListeners_ = new Set<ErrorListener>()
  private closeListeners_ = new Set<CloseListener>()

  private started_ = false
  private stopped_ = false
  private failed_ = false

  private framesIn_ = 0
  private framesOut_ = 0
  private bytesIn_ = 0
  private bytesOut_ = 0
  private writeErrors_ = 0

  private readonly onData_ = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength
    this.bytesIn_ += bytes
    const batch = this.decoder_.push(chunk)
    this.framesIn_ += batch.frames.length
    for (const frame of batch.frames) {
      for (const listener of [...this.frameListeners_]) listener(frame)
    }
    for (const error of batch.errors) {
      this.fail_(error)
    }
  }

  private readonly onEnd_ = (): void => {
    this.close_('stdin closed')
  }

  private readonly onStreamError_ = (error: Error): void => {
    this.fail_({ code: 'internal', message: `transport stream error: ${error.message}` })
    this.close_(`stream error: ${error.message}`)
  }

  private readonly onOutputError_ = (error: Error): void => {
    this.writeErrors_ += 1
    this.logger_?.warn('host transport write error: %s', error.message)
  }

  constructor(options: HostTransportOptions) {
    this.input_ = options.input
    this.output_ = options.output
    this.logger_ = options.logger
    this.decoder_ = new NdjsonDecoder(
      options.maxInboundFrameBytes === undefined
        ? {}
        : { maxFrameBytes: options.maxInboundFrameBytes },
    )
  }

  /** Attach listeners. Idempotent; a stopped transport cannot be restarted. */
  start(): void {
    if (this.started_ || this.stopped_) return
    this.started_ = true
    this.input_.on('data', this.onData_)
    this.input_.on('end', this.onEnd_)
    this.input_.on('close', this.onEnd_)
    this.input_.on('error', this.onStreamError_)
    this.output_.on('error', this.onOutputError_)
  }

  /** Detach listeners and report the end of the stream once. */
  stop(reason = 'transport stopped'): void {
    if (this.stopped_) return
    this.stopped_ = true
    if (this.started_) {
      this.input_.removeListener('data', this.onData_)
      this.input_.removeListener('end', this.onEnd_)
      this.input_.removeListener('close', this.onEnd_)
      this.input_.removeListener('error', this.onStreamError_)
      this.output_.removeListener('error', this.onOutputError_)
    }
    const tail = this.decoder_.end()
    for (const error of tail.errors) this.fail_(error)
    this.close_(reason)
  }

  /** True while the transport has not been stopped. */
  get active(): boolean {
    return this.started_ && !this.stopped_
  }

  /** A protocol violation was reported on this transport. */
  get failed(): boolean {
    return this.failed_
  }

  get stats(): HostTransportStats {
    return {
      framesIn: this.framesIn_,
      framesOut: this.framesOut_,
      bytesIn: this.bytesIn_,
      bytesOut: this.bytesOut_,
      writeErrors: this.writeErrors_,
    }
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners_.add(listener)
    return () => this.frameListeners_.delete(listener)
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners_.add(listener)
    return () => this.errorListeners_.delete(listener)
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners_.add(listener)
    return () => this.closeListeners_.delete(listener)
  }

  /**
   * Encode and write one frame.
   *
   * @returns `null` when written, the encoding error when the frame cannot be
   *   sent (too large, not serialisable, unknown shape).
   */
  send(frame: Envelope): ProtocolError | null {
    const encoded = encodeFrame(frame)
    if (!encoded.ok) return encoded.error
    const line = `${encoded.line}\n`
    this.bytesOut_ += encoded.bytes + 1
    this.framesOut_ += 1
    try {
      this.output_.write(line)
      return null
    } catch (error) {
      this.writeErrors_ += 1
      const message = error instanceof Error ? error.message : String(error)
      this.logger_?.warn('host transport write failed: %s', message)
      const failure: ProtocolError = { code: 'internal', message: `write failed: ${message}` }
      this.fail_(failure)
      return failure
    }
  }

  private fail_(error: ProtocolError): void {
    this.failed_ = true
    for (const listener of [...this.errorListeners_]) listener(error)
  }

  private close_(reason: string): void {
    for (const listener of [...this.closeListeners_]) listener(reason)
  }
}