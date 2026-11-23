/**
 * Real two-process end-to-end test for protocol v1.
 *
 * This is the test that proves the Phase 3 host actually talks to the Qt binary
 * instead of only to a fake pipe: a real `dsh-qt-app` child is spawned with
 * `DSH_QT_HOST_SELFTEST=1`, performs the v1 handshake over stdio, sends
 * `host.ping` once it is connected, and exits 0 after the reply.
 *
 * It is named `*.e2e.ts` on purpose: `pnpm test` runs `tests/*.test.ts` and must
 * keep passing on machines where the binary was never built. Run it explicitly
 * after `cmake --build build`:
 *
 *     pnpm exec tsx --test tests/host-e2e.e2e.ts
 *
 * Windows note: the binary is `build/dsh-qt-app.exe`; `DSH_QT_APP_BINARY`
 * overrides the path entirely.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { HostBridgeService } from '../src/host/bridge-service.js'
import { HostTransport } from '../src/host/transport.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultBinary = join(root, 'build', process.platform === 'win32' ? 'dsh-qt-app.exe' : 'dsh-qt-app')
const binary = process.env.DSH_QT_APP_BINARY ?? defaultBinary

test(
  'real Qt host: v1 handshake, host.ping round trip, clean exit',
  { skip: existsSync(binary) ? false : `no Qt binary at ${binary}; run cmake --build build first`, timeout: 20_000 },
  async () => {
    const child = spawn(binary, [], {
      cwd: root,
      env: {
        ...process.env,
        DSH_QT_HOST_SELFTEST: '1',
        QT_QPA_PLATFORM: process.platform === 'win32' ? 'windows' : 'offscreen',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    assert.ok(child.stdout !== null && child.stdin !== null && child.stderr !== null)

    const stderr: string[] = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim() !== '') stderr.push(line)
    })

    const transport = new HostTransport({ input: child.stdout, output: child.stdin })
    const host = new HostBridgeService(new Context(), {
      autoLaunch: false,
      handshakeTimeoutMs: 10_000,
      requestTimeoutMs: 10_000,
    })

    const states: string[] = []
    host.onStateChange((state) => states.push(state))
    let pings = 0
    host.register('ping', () => {
      pings += 1
      return { pong: true, host: 'node-e2e' }
    })

    host.attach({ transport, child })

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        const timer = setTimeout(() => {
          child.kill()
          rejectExit(new Error(`the Qt host did not exit in 15 s; stderr:\n${stderr.join('\n')}`))
        }, 15_000)
        child.once('error', (error) => {
          clearTimeout(timer)
          rejectExit(error)
        })
        child.once('exit', (code, signal) => {
          clearTimeout(timer)
          resolveExit({ code, signal })
        })
      },
    )

    assert.deepEqual(
      stderr.filter((line) => line.includes('[selftest]')),
      [
        '[selftest] state=connecting',
        '[selftest] state=connected',
        '[selftest] ping=ok pong=1 error=',
      ],
      `selftest stderr was:\n${stderr.join('\n')}`,
    )
    assert.deepEqual(states.slice(0, 2), ['connecting', 'connected'])
    assert.equal(pings, 1, 'the Qt side performs exactly one host.ping')
    assert.equal(exit.code, 0)
    assert.equal(exit.signal, null)
    assert.equal(host.state, 'disconnected')
    assert.ok(host.stats.handled >= 1)
    assert.equal(host.stats.protocolErrors, 0)
    host.dispose()
  },
)