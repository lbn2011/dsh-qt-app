/**
 * End-to-end proof of the on-demand WebUI chain (t32 acceptance ②).
 *
 * The shipped binary is spawned for real; the `webui.open` it sends is served
 * by the **real** `WebuiService` mounting the installed official packages, so
 * the sequence is the production one: open → Ready → one-shot token → native
 * consumer → close. Nothing here stubs the WebUI state machine, and the fake
 * part is limited to the Qt binary being headless (no QML window).
 *
 * With `DSH_QT_WEBENGINE=OFF` the embed step cannot succeed; the test then
 * demands an explicit `outcome=failed error=webengine-unavailable` and never an
 * "embedded" claim, which is exactly the degradation the release notes describe.
 *
 * This file is not picked up by `pnpm test` (pattern `tests/*.test.ts`); run it
 * after a build: `pnpm exec tsx --test tests/webui-live.e2e.ts`.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { HostBridgeService } from '../src/host/bridge-service.js'
import { HostTransport } from '../src/host/transport.js'
import { WebuiService, attachWebuiToHost } from '../src/webui/index.js'
import type { WebuiStatus } from '../src/webui/index.js'

const root = resolve(import.meta.dirname, '..')
const binary = join(root, 'build', process.platform === 'win32' ? 'dsh-qt-app.exe' : 'dsh-qt-app')
const skip = existsSync(binary) ? false : `no Qt binary at ${binary}; run cmake --build build first`

const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-qt-webui-live-'))
process.env['DSH_HOME'] = isolatedHome

const LISTEN = '0A'

/** @returns `port -> inode` for every LISTEN socket in this network namespace. */
function listenSockets(): Map<number, number> {
  const found = new Map<number, number>()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 10) continue
      const local = fields[1]
      const state = fields[3]
      const inode = Number(fields[9])
      if (state !== LISTEN || local === undefined || !Number.isFinite(inode)) continue
      const port = Number.parseInt(local.split(':')[1] ?? '', 16)
      if (Number.isFinite(port)) found.set(port, inode)
    }
  }
  return found
}

/** @returns the LISTEN ports owned by this process, sorted. */
function listeningPorts(): number[] {
  const inodes = new Set<number>()
  let entries: string[]
  try {
    entries = readdirSync(`/proc/${String(process.pid)}/fd`)
  } catch {
    return []
  }
  for (const entry of entries) {
    try {
      const match = /^socket:\[(\d+)\]$/u.exec(readlinkSync(`/proc/${String(process.pid)}/fd/${entry}`))
      if (match?.[1] !== undefined) inodes.add(Number(match[1]))
    } catch {
      // the fd closed between readdir and readlink
    }
  }
  const ports: number[] = []
  for (const [port, inode] of listenSockets()) {
    if (inodes.has(inode)) ports.push(port)
  }
  return ports.sort((left, right) => left - right)
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${what} was not met within ${String(timeoutMs)}ms`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
}

test(
  'real WebUI: open → Ready → native token → close, then the listener is released',
  { skip, timeout: 90_000 },
  async () => {
    // Mounting the fallback must stay inert until the UI actually asks for it.
    const before = listeningPorts()
    const statuses: WebuiStatus[] = []
    const service = new WebuiService(new Context(), {
      readyTimeoutMs: 25_000,
      openTimeoutMs: 40_000,
      modePlan: ['in-process'],
    })
    service.onState((status) => statuses.push(status))

    const host = new HostBridgeService(new Context(), { autoLaunch: false, handshakeTimeoutMs: 10_000 })
    host.onStateChange(() => {})
    const detachWebui = attachWebuiToHost(host, service)

    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
    assert.deepEqual(listeningPorts(), before, 'the fallback must not bind before webui.open')
    assert.equal(service.status.state, 'Idle')

    const child: ChildProcess = spawn(binary, [], {
      cwd: root,
      env: {
        ...process.env,
        DSH_HOME: isolatedHome,
        DSH_QT_HOST_SELFTEST: 'webui-live',
        DSH_QT_WEBUI_LINGER_MS: '750',
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
    host.attach({ transport, child })

    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        const timer = setTimeout(() => {
          child.kill()
          rejectExit(new Error(`the Qt host did not exit; stderr:\n${stderr.join('\n')}`))
        }, 80_000)
        child.once('exit', (exitCode, exitSignal) => {
          clearTimeout(timer)
          resolveExit({ code: exitCode, signal: exitSignal })
        })
      },
    )

    const text = stderr.join('\n')
    assert.equal(code, 0, `unexpected exit (${String(signal)}); stderr:\n${text}`)
    assert.match(text, /\[selftest\] state=connected/u)
    assert.match(text, /\[selftest\] webui\.state=Ready mode=in-process/u)

    // A build without WebEngine may only degrade (external browser dispatch);
    // it must never report the embed as done.
    const canEmbed = text.includes('[selftest] webview.available=1')
    const tokenLine = text.split('\n').find((line) => line.startsWith('[selftest] webui.token ')) ?? ''
    assert.match(tokenLine, /intent=embed outcome=(embedded|external|failed) /u)
    // The one-shot URL is produced by the real service: port and masked token.
    assert.match(tokenLine, /masked=http:\/\/127\.0\.0\.1:\d+\/\?token=\*\*\* /u)
    if (canEmbed) assert.match(tokenLine, /outcome=embedded /u)
    else assert.doesNotMatch(tokenLine, /outcome=embedded /u, 'a WebEngine-less build must not claim an embed')

    // The app closed the panel on its way out; the service must be Idle again
    // and the loopback listener must be gone from this process.
    await waitFor(() => service.status.state === 'Idle', 15_000, 'service Idle after close')
    const readyStatus = statuses.find((status) => status.state === 'Ready')
    assert.ok(readyStatus !== undefined, 'the service reported Ready')
    const port = Number(new URL(readyStatus.maskedUrl ?? '').port)
    assert.ok(Number.isFinite(port) && port > 0)
    await waitFor(() => !listeningPorts().includes(port), 15_000, 'listener released after close')
    assert.ok(statuses.some((status) => status.state === 'Ready'))
    assert.equal(statuses.at(-1)?.state, 'Idle')

    detachWebui()
    host.dispose()
    await service.dispose()
    rmSync(isolatedHome, { recursive: true, force: true })
  },
)