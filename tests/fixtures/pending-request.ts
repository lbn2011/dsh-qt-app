/**
 * Fixture for `tests/host-request-timeout.test.ts`.
 *
 * It answers the protocol handshake over an in-memory pipe pair and then leaves
 * exactly one thing pending: a request whose timeout has to reject it. The
 * script is run as a bare process (not under `node:test`) because the test
 * runner keeps the event loop alive on its own; only a bare script shows whether
 * the request timer does.
 *
 * Prints `settled:<code>` when the promise settled. Prints nothing when the
 * event loop drained with the request still pending.
 */
import { PassThrough } from 'node:stream'

import { Context } from '@deepseek-ai/cordis'

import { PROTOCOL_VERSION, encodeFrame } from '../../src/bridge/protocol.js'
import { HostBridgeService } from '../../src/host/bridge-service.js'
import { HostTransport } from '../../src/host/transport.js'

const HANDSHAKE_POLL_MS = 5
const REQUEST_TIMEOUT_MS = 50

async function main(): Promise<void> {
  const host = new HostBridgeService(new Context(), { autoLaunch: false, handshakeTimeoutMs: 5_000 })
  const toHost = new PassThrough()
  const fromHost = new PassThrough()

  let buffered = ''
  let connected = false
  fromHost.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) return
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (line.trim() === '') continue
      const frame = JSON.parse(line) as { kind?: string }
      if (frame.kind === 'hello.ack') connected = true
    }
  })

  host.attach({ transport: new HostTransport({ input: toHost, output: fromHost }) })

  const hello = encodeFrame({
    v: PROTOCOL_VERSION,
    kind: 'hello',
    role: 'qt',
    epoch: 'epoch-fixture',
    app: 'dsh-qt-app',
    qt: '6.8.2',
    caps: [],
  })
  if (!hello.ok) throw new Error(hello.error.message)
  toHost.write(`${hello.line}\n`)

  while (!connected) {
    await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_POLL_MS))
  }

  const code = await host.invoke('ping', undefined, { timeoutMs: REQUEST_TIMEOUT_MS }).then(
    () => 'resolved',
    (error: { code?: string }) => error.code ?? 'error',
  )
  process.stdout.write(`settled:${code}\n`)
  host.dispose()
}

void main()
