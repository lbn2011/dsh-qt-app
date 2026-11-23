/**
 * Unit tests for the protocol v1 envelope and NDJSON framing.
 *
 * These pin the wire contract frozen in docs/PHASE-3-IMPLEMENTATION-PLAN.md
 * §3.1/§3.3: one JSON object per `\n`-terminated line, a closed error-code set,
 * `id` on every req/res, and explicit rejection of oversized or unknown
 * frames. Transport (spawn/stdio owners) and business methods are out of scope.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_INBOUND_FRAME_BYTES,
  MAX_OUTBOUND_FRAME_BYTES,
  NdjsonDecoder,
  PROTOCOL_ERRORS,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  makeError,
  type EvtFrame,
  type HelloAckFrame,
  type HelloFrame,
  type NackFrame,
  type ReqFrame,
  type ResFrame,
} from '../src/bridge/protocol.js'

const req: ReqFrame = { v: 1, kind: 'req', id: 'qt-42', method: 'tool.snapshot', params: { sessionKey: 's-1' } }
const hello: HelloFrame = {
  v: 1,
  kind: 'hello',
  role: 'qt',
  epoch: 'e-7f3a',
  app: '0.1.0',
  qt: '6.8.2',
  caps: ['tool', 'settings', 'plugins', 'webui', 'ui.react'],
}
const helloAck: HelloAckFrame = {
  v: 1,
  kind: 'hello.ack',
  epoch: 'e-7f3a',
  host: '0.2.2-rc.1',
  caps: ['tool'],
  limits: { maxFrame: MAX_OUTBOUND_FRAME_BYTES },
}
const nack: NackFrame = { v: 1, kind: 'nack', code: 'protocol', message: 'unsupported protocol version' }
const evt: EvtFrame = { v: 1, kind: 'evt', seq: 1, epoch: 'e-1', name: 'tool.row', payload: {} }

test('request round-trips through encodeFrame/decodeFrame', () => {
  const encoded = encodeFrame(req)
  assert.equal(encoded.ok, true)
  if (!encoded.ok) return
  assert.equal(encoded.line.includes('\n'), false, 'encodeFrame emits one line without the terminator')
  assert.ok(encoded.bytes > 0)

  const decoded = decodeFrame(encoded.line)
  assert.equal(decoded.ok, true)
  if (!decoded.ok) return
  assert.deepEqual(decoded.frame, req)
})

test('hello, hello.ack and nack envelopes round-trip', () => {
  for (const frame of [hello, helloAck, nack] as const) {
    const encoded = encodeFrame(frame)
    assert.equal(encoded.ok, true)
    if (!encoded.ok) continue
    const decoded = decodeFrame(encoded.line)
    assert.equal(decoded.ok, true)
    if (!decoded.ok) continue
    assert.deepEqual(decoded.frame, frame)
  }
})

test('res frames carry id and either result or a closed error code', () => {
  const ok: ResFrame = { v: 1, kind: 'res', id: 'qt-42', ok: true, result: { rows: [] } }
  const bad: ResFrame = { v: 1, kind: 'res', id: 'qt-42', ok: false, error: { code: 'busy', message: 'queue full', retryable: true } }
  for (const frame of [ok, bad]) {
    const encoded = encodeFrame(frame)
    assert.equal(encoded.ok, true)
    if (!encoded.ok) continue
    const decoded = decodeFrame(encoded.line)
    assert.equal(decoded.ok, true)
    if (!decoded.ok) continue
    assert.deepEqual(decoded.frame, frame)
  }
})

test('legacy flat request frames are rejected, not silently coerced', () => {
  const decoded = decodeFrame(JSON.stringify({ id: 'qt-1', method: 'ping', params: {} }))
  assert.equal(decoded.ok, false)
  if (decoded.ok) return
  assert.equal(decoded.error.code, 'bad-params')
})

test('an unknown protocol version is a protocol error', () => {
  const decoded = decodeFrame(JSON.stringify({ v: 2, kind: 'req', id: 'qt-1', method: 'ping' }))
  assert.equal(decoded.ok, false)
  if (decoded.ok) return
  assert.equal(decoded.error.code, 'protocol')
})

test('an unknown kind is ignored without a reply', () => {
  const decoded = decodeFrame(JSON.stringify({ v: 1, kind: 'telemetry', id: 'x' }))
  assert.equal(decoded.ok, true)
  if (!decoded.ok) return
  assert.equal(decoded.frame, undefined)
  assert.equal(decoded.ignored, true)
})

test('a res without id is rejected', () => {
  const decoded = decodeFrame(JSON.stringify({ v: 1, kind: 'res', ok: true, result: {} }))
  assert.equal(decoded.ok, false)
  if (decoded.ok) return
  assert.equal(decoded.error.code, 'bad-params')
})

test('a req without a non-empty id or method is rejected', () => {
  for (const line of [
    JSON.stringify({ v: 1, kind: 'req', method: 'ping' }),
    JSON.stringify({ v: 1, kind: 'req', id: '', method: 'ping' }),
    JSON.stringify({ v: 1, kind: 'req', id: 'qt-1' }),
  ]) {
    const decoded = decodeFrame(line)
    assert.equal(decoded.ok, false, line)
    if (decoded.ok) continue
    assert.equal(decoded.error.code, 'bad-params')
  }
})

test('malformed JSON and non-object payloads are rejected', () => {
  for (const line of ['{"v":1,"kind":', '[1,2,3]', 'null', '42']) {
    const decoded = decodeFrame(line)
    assert.equal(decoded.ok, false, line)
    if (decoded.ok) continue
    assert.equal(decoded.error.code, 'bad-params')
  }
})

test('an evt without a monotonic seq or epoch is rejected', () => {
  const base: EvtFrame = { v: 1, kind: 'evt', epoch: 'e-7f3a', name: 'tool.row', seq: 1, payload: {} }
  const encoded = encodeFrame(base)
  assert.equal(encoded.ok, true)

  for (const seq of [-1, 1.5, '1']) {
    const decoded = decodeFrame(JSON.stringify({ ...base, seq }))
    assert.equal(decoded.ok, false, String(seq))
    if (decoded.ok) continue
    assert.equal(decoded.error.code, 'bad-params')
  }
  const noEpoch = decodeFrame(JSON.stringify({ v: 1, kind: 'evt', name: 'tool.row', seq: 1 }))
  assert.equal(noEpoch.ok, false)
})

test('frames above the inbound limit are rejected with protocol', () => {
  const line = `{"v":1,"kind":"req","id":"qt-1","method":"ping","params":{"pad":"${'x'.repeat(MAX_INBOUND_FRAME_BYTES)}"}}`
  const decoded = decodeFrame(line)
  assert.equal(decoded.ok, false)
  if (decoded.ok) return
  assert.equal(decoded.error.code, 'protocol')
  assert.match(decoded.error.message, /65536|4194304/, 'message should mention the limit in bytes')
})

test('encodeFrame refuses frames above the outbound limit', () => {
  const big: ReqFrame = { v: 1, kind: 'req', id: 'qt-1', method: 'ping', params: { pad: 'x'.repeat(MAX_OUTBOUND_FRAME_BYTES) } }
  const encoded = encodeFrame(big)
  assert.equal(encoded.ok, false)
  if (encoded.ok) return
  assert.equal(encoded.error.code, 'protocol')
})

test('decoder emits every frame from a multi-frame chunk in order', () => {
  const decoder = new NdjsonDecoder()
  const lines = [req, helloAck, evt]
    .map((frame) => {
      const encoded = encodeFrame(frame)
      assert.equal(encoded.ok, true)
      return encoded.ok ? encoded.line : ''
    })
    .join('\n')

  const result = decoder.push(`${lines}\n`)
  assert.equal(result.frames.length, 3)
  assert.equal(result.errors.length, 0)
  assert.equal(result.ignored, 0)
  assert.deepEqual(result.frames[0], req)
  assert.deepEqual(result.frames[1], helloAck)
})

test('decoder stitches a frame split across chunks', () => {
  const decoder = new NdjsonDecoder()
  const encoded = encodeFrame(req)
  assert.equal(encoded.ok, true)
  if (!encoded.ok) return
  const cut = Math.floor(encoded.line.length / 2)

  const first = decoder.push(encoded.line.slice(0, cut))
  assert.equal(first.frames.length, 0, 'an unterminated line is buffered, not emitted')
  assert.equal(first.errors.length, 0)

  const second = decoder.push(`${encoded.line.slice(cut)}\n`)
  assert.equal(second.frames.length, 1)
  assert.deepEqual(second.frames[0], req)
  assert.equal(decoder.bufferedBytes, 0)
})

test('decoder reports a truncated tail at end() instead of emitting it', () => {
  const decoder = new NdjsonDecoder()
  const encoded = encodeFrame(req)
  assert.equal(encoded.ok, true)
  if (!encoded.ok) return
  decoder.push(encoded.line.slice(0, 10))
  const tail = decoder.end()
  assert.equal(tail.frames.length, 0)
  assert.equal(tail.errors.length, 1)
  assert.equal(tail.errors[0]?.code, 'protocol')
})

test('decoder resynchronises after an oversized frame', () => {
  const encoded = encodeFrame(req)
  assert.equal(encoded.ok, true)
  if (!encoded.ok) return
  // Limit chosen so the intact frame fits but the padded one does not.
  const decoder = new NdjsonDecoder({ maxFrameBytes: encoded.line.length + 16 })
  const oversized = JSON.stringify({ v: 1, kind: 'req', id: 'qt-1', method: 'ping', params: { pad: 'x'.repeat(256) } })

  const result = decoder.push(`${oversized}\n${encoded.line}\n`)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'protocol')
  assert.equal(result.frames.length, 1, 'the next intact frame is still delivered')
  assert.deepEqual(result.frames[0], req)
})

test('decoder ignores blank lines and tolerates CRLF terminators', () => {
  const decoder = new NdjsonDecoder()
  const encoded = encodeFrame(req)
  assert.equal(encoded.ok, true)
  if (!encoded.ok) return
  const result = decoder.push(`\n\r\n${encoded.line}\r\n`)
  assert.equal(result.frames.length, 1)
  assert.equal(result.errors.length, 0)
})

test('PROTOCOL_ERRORS is the frozen closed set and makeError narrows it', () => {
  assert.equal(PROTOCOL_VERSION, 1)
  assert.ok(PROTOCOL_ERRORS.includes('protocol'))
  assert.ok(PROTOCOL_ERRORS.includes('duplicate-id'))
  assert.ok(PROTOCOL_ERRORS.includes('SETTINGS_CONFLICT'))
  assert.equal(PROTOCOL_ERRORS.length, 14)

  const error = makeError('timeout', 'no reply within 5000 ms', true)
  assert.deepEqual(error, { code: 'timeout', message: 'no reply within 5000 ms', retryable: true })
  assert.equal(makeError('busy', 'queue full').retryable, undefined)
})