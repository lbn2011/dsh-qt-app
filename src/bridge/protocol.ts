/**
 * protocol v1 — the frozen wire contract between the Node host and the Qt
 * native process, spoken as newline-delimited JSON over stdio.
 *
 * Frozen by docs/PHASE-3-IMPLEMENTATION-PLAN.md §3.1/§3.3 at commit 62a9812.
 * This module owns *only* types, validation and framing: no transport, no
 * spawn, no method implementations. Every other task must `import type` these
 * envelopes instead of re-declaring them.
 *
 * Wire rules:
 *   * one UTF-8 JSON object per line, `\n`-terminated, no embedded newlines;
 *   * inbound frames ≤ 4 MiB, outbound ≤ 8 MiB;
 *   * unknown `v` is a `protocol` error (peer must disconnect);
 *   * unknown `kind` is ignored silently (forward compatibility);
 *   * every `req` gets exactly one `res` with the same `id`; `evt` never replies.
 */
export const PROTOCOL_VERSION = 1 as const

/** Largest frame the host accepts from the Qt process. */
export const MAX_INBOUND_FRAME_BYTES = 4 * 1024 * 1024
/** Largest frame the host will emit to the Qt process. */
export const MAX_OUTBOUND_FRAME_BYTES = 8 * 1024 * 1024

/**
 * Closed set of protocol/rpc error codes (§3.3). Official pass-through codes
 * (`SETTINGS_CONFLICT`, `ManagementError.*`) are carried verbatim so the Qt
 * side can render the host's own diagnostics without a second mapping.
 */
export const PROTOCOL_ERRORS = [
  'unknown-method',
  'bad-params',
  'unavailable',
  'busy',
  'timeout',
  'refused',
  'internal',
  'not-found',
  'conflict',
  'unsupported',
  'cancelled',
  'duplicate-id',
  'protocol',
  'SETTINGS_CONFLICT',
] as const

export type ProtocolErrorCode = (typeof PROTOCOL_ERRORS)[number]
/** Protocol codes plus the official `ManagementError.<code>` pass-through. */
export type RpcErrorCode = ProtocolErrorCode | `ManagementError.${string}`

export interface ProtocolError {
  code: RpcErrorCode
  message: string
  retryable?: boolean
}

export function makeError(code: RpcErrorCode, message: string, retryable?: boolean): ProtocolError {
  return retryable === undefined ? { code, message } : { code, message, retryable }
}

interface FrameBase {
  v: typeof PROTOCOL_VERSION
}

/** First frame from Qt after stdio is ready; host must answer `hello.ack`/`nack`. */
export interface HelloFrame extends FrameBase {
  kind: 'hello'
  role: 'qt'
  epoch: string
  app: string
  qt: string
  caps: readonly string[]
}

export interface HelloAckFrame extends FrameBase {
  kind: 'hello.ack'
  epoch: string
  host: string
  caps: readonly string[]
  limits: { maxFrame: number }
}

export interface NackFrame extends FrameBase {
  kind: 'nack'
  code: RpcErrorCode
  message: string
}

export interface ReqFrame extends FrameBase {
  kind: 'req'
  id: string
  method: string
  params?: unknown
}

export interface ResOkFrame extends FrameBase {
  kind: 'res'
  id: string
  ok: true
  result?: unknown
}

export interface ResErrFrame extends FrameBase {
  kind: 'res'
  id: string
  ok: false
  error: ProtocolError
}

export type ResFrame = ResOkFrame | ResErrFrame

export interface EventTopic {
  session?: string
  turn?: string
}

export interface EvtFrame extends FrameBase {
  kind: 'evt'
  seq: number
  epoch: string
  name: string
  topic?: EventTopic
  payload?: unknown
}

export type Envelope = HelloFrame | HelloAckFrame | NackFrame | ReqFrame | ResFrame | EvtFrame

export type EncodeResult = { ok: true; line: string; bytes: number } | { ok: false; error: ProtocolError }

export type DecodeResult =
  | { ok: true; ignored: boolean; frame?: Envelope }
  | { ok: false; error: ProtocolError }

export interface DecodeBatch {
  frames: Envelope[]
  errors: ProtocolError[]
  /** Lines that were well-formed JSON with an unknown `kind`. */
  ignored: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

export function isRpcErrorCode(value: unknown): value is RpcErrorCode {
  if (typeof value !== 'string') return false
  if ((PROTOCOL_ERRORS as readonly string[]).includes(value)) return true
  return value.startsWith('ManagementError.') && value.length > 'ManagementError.'.length
}

function isProtocolError(value: unknown): value is ProtocolError {
  if (!isRecord(value)) return false
  if (!isRpcErrorCode(value.code) || !isNonEmptyString(value.message)) return false
  return value.retryable === undefined || typeof value.retryable === 'boolean'
}

function isEventTopic(value: unknown): value is EventTopic {
  if (!isRecord(value)) return false
  for (const key of ['session', 'turn'] as const) {
    const entry = value[key]
    if (entry !== undefined && !isNonEmptyString(entry)) return false
  }
  return true
}

type Validated = { frame: Envelope } | { ignored: true } | { error: ProtocolError }

function validate(value: unknown): Validated {
  if (!isRecord(value)) {
    return { error: makeError('bad-params', 'frame must be a JSON object') }
  }
  if (value.v === undefined) {
    // A legacy flat `{id,method,params}` frame is malformed, not a future version.
    return { error: makeError('bad-params', `frame is missing protocol version v; expected ${PROTOCOL_VERSION}`) }
  }
  if (value.v !== PROTOCOL_VERSION) {
    return { error: makeError('protocol', `unsupported protocol version ${String(value.v)}; expected ${PROTOCOL_VERSION}`) }
  }

  const kind = value.kind
  if (typeof kind !== 'string') {
    return { error: makeError('bad-params', 'frame is missing a string kind') }
  }

  switch (kind) {
    case 'hello': {
      if (value.role !== 'qt') return { error: makeError('bad-params', 'hello.role must be "qt"') }
      if (!isNonEmptyString(value.epoch)) return { error: makeError('bad-params', 'hello.epoch must be a non-empty string') }
      if (typeof value.app !== 'string' || typeof value.qt !== 'string') {
        return { error: makeError('bad-params', 'hello.app and hello.qt must be strings') }
      }
      if (!isStringArray(value.caps)) return { error: makeError('bad-params', 'hello.caps must be a string array') }
      return { frame: value as unknown as HelloFrame }
    }
    case 'hello.ack': {
      if (!isNonEmptyString(value.epoch)) return { error: makeError('bad-params', 'hello.ack.epoch must be a non-empty string') }
      if (typeof value.host !== 'string') return { error: makeError('bad-params', 'hello.ack.host must be a string') }
      if (!isStringArray(value.caps)) return { error: makeError('bad-params', 'hello.ack.caps must be a string array') }
      const limits = value.limits
      if (!isRecord(limits) || typeof limits.maxFrame !== 'number' || !Number.isInteger(limits.maxFrame) || limits.maxFrame <= 0) {
        return { error: makeError('bad-params', 'hello.ack.limits.maxFrame must be a positive integer') }
      }
      return { frame: value as unknown as HelloAckFrame }
    }
    case 'nack': {
      if (!isRpcErrorCode(value.code)) return { error: makeError('bad-params', 'nack.code is not a known protocol code') }
      if (!isNonEmptyString(value.message)) return { error: makeError('bad-params', 'nack.message must be a non-empty string') }
      return { frame: value as unknown as NackFrame }
    }
    case 'req': {
      if (!isNonEmptyString(value.id)) return { error: makeError('bad-params', 'req.id must be a non-empty string') }
      if (!isNonEmptyString(value.method)) return { error: makeError('bad-params', 'req.method must be a non-empty string') }
      return { frame: value as unknown as ReqFrame }
    }
    case 'res': {
      if (!isNonEmptyString(value.id)) return { error: makeError('bad-params', 'res.id must be a non-empty string') }
      if (typeof value.ok !== 'boolean') return { error: makeError('bad-params', 'res.ok must be a boolean') }
      if (value.ok) {
        if (value.error !== undefined) return { error: makeError('bad-params', 'res.ok=true must not carry error') }
        return { frame: value as unknown as ResOkFrame }
      }
      if (!isProtocolError(value.error)) return { error: makeError('bad-params', 'res.ok=false requires error{code,message}') }
      return { frame: value as unknown as ResErrFrame }
    }
    case 'evt': {
      if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 0) {
        return { error: makeError('bad-params', 'evt.seq must be a non-negative integer') }
      }
      if (!isNonEmptyString(value.epoch)) return { error: makeError('bad-params', 'evt.epoch must be a non-empty string') }
      if (!isNonEmptyString(value.name)) return { error: makeError('bad-params', 'evt.name must be a non-empty string') }
      if (value.topic !== undefined && !isEventTopic(value.topic)) {
        return { error: makeError('bad-params', 'evt.topic must be {session?,turn?}') }
      }
      return { frame: value as unknown as EvtFrame }
    }
    default:
      // Forward compatibility: a peer may send kinds this build does not know.
      return { ignored: true }
  }
}

function byteLength(line: string): number {
  return Buffer.byteLength(line, 'utf8')
}

/**
 * Serialise and validate one frame. The returned line never contains the
 * trailing newline; callers append it (or use `NdjsonDecoder` on the other end).
 */
export function encodeFrame(frame: Envelope): EncodeResult {
  const validated = validate(frame)
  if ('error' in validated) return { ok: false, error: validated.error }
  if ('ignored' in validated) return { ok: false, error: makeError('bad-params', 'refusing to encode an unknown frame kind') }

  let line: string
  try {
    line = JSON.stringify(validated.frame)
  } catch (error) {
    return { ok: false, error: makeError('bad-params', `frame is not serialisable: ${String(error)}`) }
  }
  if (line.includes('\n')) return { ok: false, error: makeError('bad-params', 'frame must not contain a newline') }

  const bytes = byteLength(line)
  if (bytes > MAX_OUTBOUND_FRAME_BYTES) {
    return {
      ok: false,
      error: makeError('protocol', `frame is ${bytes} bytes; outbound limit is ${MAX_OUTBOUND_FRAME_BYTES} bytes`),
    }
  }
  return { ok: true, line, bytes }
}

/** Decode exactly one line (a trailing `\n`/`\r\n` is tolerated). */
export function decodeFrame(line: string): DecodeResult {
  let text = line
  if (text.endsWith('\n')) text = text.slice(0, -1)
  if (text.endsWith('\r')) text = text.slice(0, -1)
  if (text.trim().length === 0) return { ok: true, ignored: true }
  if (text.includes('\n')) return { ok: false, error: makeError('bad-params', 'decodeFrame expects a single line') }

  const bytes = byteLength(text)
  if (bytes > MAX_INBOUND_FRAME_BYTES) {
    return {
      ok: false,
      error: makeError('protocol', `frame is ${bytes} bytes; inbound limit is ${MAX_INBOUND_FRAME_BYTES} bytes`),
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: makeError('bad-params', 'frame is not valid JSON') }
  }

  const validated = validate(parsed)
  if ('error' in validated) return { ok: false, error: validated.error }
  if ('ignored' in validated) return { ok: true, ignored: true }
  return { ok: true, ignored: false, frame: validated.frame }
}

export interface NdjsonDecoderOptions {
  /** Override the inbound limit (tests and Qt-side small-buffer peers). */
  maxFrameBytes?: number
}

/**
 * Incremental newline-delimited decoder: feed arbitrary chunks, get whole
 * frames. A partial tail is buffered until its newline arrives; an oversized
 * line is reported once and the decoder resynchronises at the next newline.
 */
export class NdjsonDecoder {
  readonly #maxFrameBytes: number
  #buffer = ''
  #discarding = false
  #bufferedBytes = 0

  constructor(options: NdjsonDecoderOptions = {}) {
    const max = options.maxFrameBytes ?? MAX_INBOUND_FRAME_BYTES
    if (!Number.isInteger(max) || max <= 0) throw new RangeError('maxFrameBytes must be a positive integer')
    this.#maxFrameBytes = max
  }

  /** Bytes currently buffered for the unterminated tail. */
  get bufferedBytes(): number {
    return this.#bufferedBytes
  }

  push(chunk: string | Uint8Array): DecodeBatch {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8')
    const batch: DecodeBatch = { frames: [], errors: [], ignored: 0 }

    let input = text
    if (this.#buffer.length > 0) {
      input = this.#buffer + text
      this.#buffer = ''
      this.#bufferedBytes = 0
    }
    let start = 0

    for (let index = input.indexOf('\n'); index !== -1; index = input.indexOf('\n', start)) {
      const raw = input.slice(start, index)
      start = index + 1
      this.#consumeLine(raw, batch)
    }

    if (start < input.length) {
      if (this.#discarding) return batch
      this.#buffer += input.slice(start)
      this.#bufferedBytes = byteLength(this.#buffer)
      if (this.#bufferedBytes > this.#maxFrameBytes) {
        batch.errors.push(
          makeError('protocol', `frame exceeds inbound limit ${this.#maxFrameBytes} bytes; discarding until the next newline`),
        )
        this.#buffer = ''
        this.#bufferedBytes = 0
        this.#discarding = true
      }
    }
    return batch
  }

  /** Flush at stream end: a remaining partial frame is an error, never a frame. */
  end(): DecodeBatch {
    const batch: DecodeBatch = { frames: [], errors: [], ignored: 0 }
    if (this.#discarding) {
      this.#discarding = false
      return batch
    }
    if (this.#buffer.length > 0) {
      batch.errors.push(makeError('protocol', 'truncated frame at end of stream'))
      this.#buffer = ''
      this.#bufferedBytes = 0
    }
    return batch
  }

  #consumeLine(raw: string, batch: DecodeBatch): void {
    if (this.#discarding) {
      // The oversized line ended; resume in sync with the next frame.
      this.#discarding = false
      return
    }
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim().length === 0) return

    if (byteLength(line) > this.#maxFrameBytes) {
      batch.errors.push(makeError('protocol', `frame exceeds inbound limit ${this.#maxFrameBytes} bytes`))
      return
    }

    const decoded = decodeFrame(line)
    if (!decoded.ok) {
      batch.errors.push(decoded.error)
      return
    }
    if (decoded.ignored || decoded.frame === undefined) {
      batch.ignored += 1
      return
    }
    batch.frames.push(decoded.frame)
  }
}