/**
 * Real external-fallback probe (I-WEBUI2) for t32 acceptance ⑥.
 *
 * Spawns the official `dsh web --port 0 --no-open` in an isolated DSH_HOME and
 * checks the contract the fallback relies on:
 *
 *   1. the printed URL is the documented `dsh web: <url>` line and carries a
 *      one-shot token;
 *   2. a request without that token is refused (401), and a forged token is
 *      refused too — that gate is why the token may never reach QML;
 *   3. the tokenized URL itself is accepted (the browser path);
 *   4. when the process is killed the port is released, so ownership is the
 *      ChildProcess handle and nothing else.
 *
 * Offline, isolated profile, no model calls. Run explicitly:
 * `pnpm exec tsx --test tests/webui-external.e2e.ts`.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const DSH_BIN = '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'

function runWeb(home: string): Promise<{ child: ChildProcess; url: Promise<string> }> {
  const child = spawn(process.execPath, [DSH_BIN, 'web', '--port', '0', '--no-open'], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const url = new Promise<string>((resolve, reject) => {
    let buffered = ''
    const onData = (chunk: string): void => {
      buffered += chunk
      const match = /dsh web:\s*(http:\/\/\S+)/u.exec(buffered)
      if (match !== null && match[1] !== undefined) {
        resolve(match[1])
        cleanup()
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`no "dsh web:" line within 30s; stderr so far:\n${buffered}`))
    }, 30_000)
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', (code) => {
      cleanup()
      reject(new Error(`dsh web exited early (code ${String(code)})`))
    })
  })
  return Promise.resolve({ child, url })
}

async function status(url: string, cookie?: string): Promise<number> {
  const response = await fetch(url, { headers: cookie === undefined ? {} : { cookie } })
  await response.arrayBuffer()
  return response.status
}

function portOf(url: string): number {
  return Number.parseInt(new URL(url).port, 10)
}

test('the official external WebUI gates on its one-shot token and releases its port', { timeout: 90_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-qt-web-external-'))
  const { child, url } = await runWeb(home)
  let port = 0
  try {
    const printed = await url
    const parsed = new URL(printed)
    assert.equal(parsed.hostname, '127.0.0.1', 'the external fallback binds loopback only')
    const token = parsed.searchParams.get('token')
    assert.ok(token !== null && token.length > 8, `no one-shot token in ${printed}`)
    port = portOf(printed)

    // A browser with the printed URL is accepted through the 303 + cookie
    // handshake; a bare fetch without a cookie jar shows exactly that redirect.
    const handshake = await fetch(printed, { redirect: 'manual' })
    await handshake.arrayBuffer()
    assert.equal(handshake.status, 303, 'the tokenized URL must answer a 303 handshake')
    const setCookie = handshake.headers.getSetCookie()
    assert.ok(setCookie.length > 0, 'the handshake must set the session cookie')
    const cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ')
    assert.equal(
      await status(`http://127.0.0.1:${String(port)}/`, cookie),
      200,
      'the handshake cookie must open the app',
    )

    // Any other caller is refused, even on loopback.
    assert.equal(await status(`http://127.0.0.1:${String(port)}/`), 401, 'no-token request must be refused')
    assert.equal(
      await status(`http://127.0.0.1:${String(port)}/?token=forged-token`),
      401,
      'a forged token must be refused',
    )

    // The token is not a bearer header: a bogus cookie is refused as well.
    assert.equal(
      await status(`http://127.0.0.1:${String(port)}/`, 'dsh_session=forged'),
      401,
      'a forged session cookie must be refused',
    )
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))

    // After exit the listener must be gone: the probe process cannot connect.
    const closed = await new Promise<boolean>((resolve) => {
      const probe = spawn('bash', ['-c', `exec 3<>/dev/tcp/127.0.0.1/${String(port)}`], { stdio: 'ignore' })
      probe.on('exit', (code) => resolve(code !== 0))
      probe.on('error', () => resolve(true))
    })
    assert.equal(closed, true, `port ${String(port)} still accepts connections after exit`)
  }
})
