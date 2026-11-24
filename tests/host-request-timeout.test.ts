/**
 * Regression test for the request timeout timer (t45, finding T44-1).
 *
 * The timer that rejects a timed-out request is the only thing that settles the
 * caller's promise, so it must keep the event loop alive. It used to be unref'd:
 * under Node 22.19.0 a caller waiting on a silent host was left with no active
 * handle, the loop drained with the request still pending
 * (`Promise resolution is still pending but the event loop has already
 * resolved`) and `node:test` cancelled the rest of
 * `tests/host-launcher.test.ts` — 8 tests, exit 1, on Ubuntu and Windows alike.
 *
 * The check runs in a plain child process on purpose: `node:test` holds the loop
 * open itself, so an in-process assertion would pass with or without the fix.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')
const fixture = join(import.meta.dirname, 'fixtures', 'pending-request.ts')
const FIXTURE_TIMEOUT_MS = 30_000

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

function runFixture(): Promise<Run> {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  return new Promise<Run>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the fixture did not finish within ${String(FIXTURE_TIMEOUT_MS)}ms\n${stdout}${stderr}`))
    }, FIXTURE_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

test('a pending request keeps the event loop alive until its timeout settles it', async () => {
  const run = await runFixture()

  assert.equal(run.code, 0, run.stderr)
  // Without the fix the process exits before the timeout fires and prints
  // nothing at all, so the marker is the assertion that matters.
  assert.match(run.stdout, /^settled:timeout$/mu, `the request never settled; stdout=${JSON.stringify(run.stdout)}`)
})
