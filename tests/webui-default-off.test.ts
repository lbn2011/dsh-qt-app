/**
 * Real-listener tests for `I5` (on-demand WebUI fallback).
 *
 * These run against the *installed* DSH tree, not against fakes, because the
 * two acceptance claims are physical facts about sockets and processes:
 *
 *   1. mounting the fallback adds **no** listener — only `webui.open` binds;
 *   2. the fallback only ever releases the listener/child **it** created and
 *      leaves unrelated services alone.
 *
 * Listener ownership is measured the only way that cannot be fooled by port
 * numbers: LISTEN sockets from `/proc/net/tcp{,6}` intersected with the socket
 * inodes this process holds open in `/proc/<pid>/fd`. A test that merely probed
 * `127.0.0.1:3080` would pass on a machine that happens to have a WebUI running
 * and would prove nothing.
 *
 * `DSH_HOME` is redirected to a throwaway directory before anything spawns, so
 * the child backend never reads or writes the real installation's credentials.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { SHARED_SESSION_NOTICE, WebuiService } from '../src/webui/index.js'
import type { WebuiStatus } from '../src/webui/index.js'

const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-qt-webui-'))
process.env['DSH_HOME'] = isolatedHome

after(() => {
  rmSync(isolatedHome, { recursive: true, force: true })
})

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

/** @returns the LISTEN ports owned by `pid`, sorted. */
function listeningPortsOf(pid: number): number[] {
  const inodes = new Set<number>()
  let entries: string[]
  try {
    entries = readdirSync(`/proc/${String(pid)}/fd`)
  } catch {
    return []
  }
  for (const entry of entries) {
    try {
      const match = /^socket:\[(\d+)\]$/u.exec(readlinkSync(`/proc/${String(pid)}/fd/${entry}`))
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

/** @returns the pids whose parent is `pid`. */
function childPidsOf(pid: number): number[] {
  const pids: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      if (ppid === pid) pids.push(Number(entry))
    } catch {
      // process exited
    }
  }
  return pids
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${what} was not met within ${String(timeoutMs)}ms`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function listenOnRandomPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((_request, response) => response.end('external'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

interface Instance {
  readonly service: WebuiService
  readonly statuses: WebuiStatus[]
  readonly logs: string[]
}

function service(config: ConstructorParameters<typeof WebuiService>[1] = {}): Instance {
  const statuses: WebuiStatus[] = []
  const logs: string[] = []
  const created = new WebuiService(new Context(), {
    readyTimeoutMs: 25_000,
    openTimeoutMs: 40_000,
    backoffMs: [50],
    logger: {
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
    },
    ...config,
  })
  created.onState((status) => statuses.push(status))
  return { service: created, statuses, logs }
}

test('default off: mounting the fallback binds nothing and spawns nothing', async () => {
  const before = listeningPortsOf(process.pid)
  const { service: instance, statuses } = service()

  assert.equal(instance.status.state, 'Idle')
  assert.equal(instance.status.mode, null)
  assert.equal(instance.status.maskedUrl, null)
  assert.equal(instance.takeAuthenticatedUrl(), null)

  // Give an accidentally-started listener or child time to appear.
  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.deepEqual(listeningPortsOf(process.pid), before, 'mounting must not bind a port')
  assert.deepEqual(childPidsOf(process.pid), [], 'mounting must not spawn a host process')
  assert.deepEqual(statuses, [], 'no state change happens before webui.open')
  instance.dispose()
})

test('open() binds one loopback listener in this process; close() releases it', async () => {
  const before = listeningPortsOf(process.pid)
  const { service: instance, statuses, logs } = service({ modePlan: ['in-process'] })

  const result = await instance.open({ slotId: 'panel:webui' })

  assert.equal(result.mode, 'in-process')
  assert.equal(result.sharedSession, true, 'the same process shares the session tree')
  assert.match(result.maskedUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?token=\*\*\*$/u)
  assert.equal(result.notice, null)
  const origin = new URL(result.maskedUrl)
  const port = Number(origin.port)

  const after = listeningPortsOf(process.pid)
  const added = after.filter((candidate) => !before.includes(candidate))
  assert.deepEqual(added, [port], 'exactly one new listener, owned by this process')

  // Unauthenticated access is refused with the official challenge.
  const challenge = await fetch(`${origin.origin}/`, { redirect: 'manual' })
  assert.equal(challenge.status, 401)
  assert.match(await challenge.text(), /dsh web authentication required/u)

  // The /api fence rejects an untrusted request before any route runs.
  const api = await fetch(`${origin.origin}/api/remote.mux`, { redirect: 'manual' })
  assert.equal(api.status, 401)
  const crossSite = await fetch(`${origin.origin}/api/remote.mux`, {
    headers: { 'sec-fetch-site': 'cross-site' },
    redirect: 'manual',
  })
  assert.equal(crossSite.status, 403)

  // The one-shot token URL authenticates exactly like `dsh web` does.
  const tokenUrl = instance.takeAuthenticatedUrl()
  assert.ok(tokenUrl !== null)
  assert.equal(instance.takeAuthenticatedUrl(), null, 'the token is handed out once')
  const exchange = await fetch(tokenUrl, { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0] ?? ''
  assert.ok(cookie.startsWith('dsh-auth-'), 'the official session cookie is issued')
  assert.equal(exchange.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(exchange.headers.get('cache-control'), 'no-store')

  const page = await fetch(`${origin.origin}/`, { headers: { cookie }, redirect: 'manual' })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<base href="\.\/">/u)

  // Nothing the UI can read carries the raw token.
  const rawToken = new URL(tokenUrl).searchParams.get('token')
  assert.ok(rawToken !== null && rawToken.length >= 32)
  assert.equal(JSON.stringify(instance.status).includes(rawToken), false)
  assert.equal(JSON.stringify(statuses).includes(rawToken), false)
  assert.equal(logs.join('\n').includes(rawToken), false)

  await instance.close()
  assert.equal(instance.status.state, 'Idle')
  assert.deepEqual(listeningPortsOf(process.pid), before, 'close() releases the port')
  await assert.rejects(fetch(`${origin.origin}/`, { signal: AbortSignal.timeout(1_000) }))

  // A second open is a fresh attempt, not a stale handle.
  const reopened = await instance.open()
  assert.equal(reopened.reused, false)
  assert.deepEqual(
    listeningPortsOf(process.pid).filter((candidate) => !before.includes(candidate)),
    [Number(new URL(reopened.maskedUrl).port)],
  )
  await instance.close()
  instance.dispose()
})

test('the child fallback owns only its own process and leaves other listeners alone', async () => {
  const external = await listenOnRandomPort()
  const before = listeningPortsOf(process.pid)
  const { service: instance } = service({ modePlan: ['child'] })

  const result = await instance.open()

  assert.equal(result.mode, 'child')
  assert.equal(result.sharedSession, false, 'a second process cannot share the session tree')
  assert.equal(result.notice, SHARED_SESSION_NOTICE)
  assert.equal(instance.status.notice, SHARED_SESSION_NOTICE)
  assert.match(result.maskedUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?token=\*\*\*$/u)
  const childOrigin = new URL(result.maskedUrl)
  const childPort = Number(childOrigin.port)

  // The listener belongs to the child, not to this process.
  assert.equal(listeningPortsOf(process.pid).includes(childPort), false)
  const children = childPidsOf(process.pid)
  assert.equal(children.length, 1, 'exactly one host child process')
  const childPid = children[0]
  assert.ok(childPid !== undefined)
  assert.deepEqual(listeningPortsOf(childPid), [childPort])
  assert.deepEqual(listeningPortsOf(process.pid), before, 'this process still binds nothing')

  // The child inherits the isolated DSH_HOME, so it cannot touch real credentials.
  const environ = readFileSync(`/proc/${String(childPid)}/environ`, 'utf8').split('\0')
  assert.ok(
    environ.includes(`DSH_HOME=${isolatedHome}`),
    'the fallback child must run against the isolated home',
  )

  // Kill the child behind the service's back: it must report the failure, not
  // scan ports, and it must not touch the unrelated listener.
  process.kill(childPid, 'SIGKILL')
  await waitFor(() => instance.status.state === 'Failed', 15_000, 'Failed state after a dead child')
  assert.equal(instance.status.reason, 'crashed')
  assert.equal(instance.status.maskedUrl, null)
  assert.equal(instance.takeAuthenticatedUrl(), null)

  assert.equal(listeningPortsOf(process.pid).includes(external.port), true)
  const stillThere = await fetch(`http://127.0.0.1:${String(external.port)}/`)
  assert.equal(await stillThere.text(), 'external')
  await assert.rejects(fetch(`${childOrigin.origin}/`, { signal: AbortSignal.timeout(1_000) }))
  await waitFor(() => childPidsOf(process.pid).length === 0, 5_000, 'child process to be gone')

  await instance.close()
  assert.equal(instance.status.state, 'Idle')
  await external.close()
  instance.dispose()
})
