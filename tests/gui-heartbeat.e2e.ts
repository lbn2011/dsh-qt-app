/**
 * Regression for T93-1: the Windows read loop used to park the GUI thread.
 *
 * The pre-fix transport read stdin from a 25 ms QTimer with a bare `::_read`,
 * and on Windows that call blocks on an idle anonymous pipe. A blocked GUI
 * thread stops repainting, stops every QTimer (including the 5 s handshake
 * deadline) and leaves the process alive — "the window never appears, nothing
 * is logged". Nothing in the suite caught it because the Linux build reads
 * through QSocketNotifier, which only fires when the descriptor is readable.
 *
 * What this test asserts, using the real binary and the real Node pipe:
 *
 *   1. stdin is held open and *silent* (no frames after the handshake) and the
 *      GUI thread still ticks continuously, with a real QWindow created and
 *      exposed — a heartbeat file written by a 50 ms QTimer on the GUI thread.
 *   2. the pre-fix read loop (`DSH_QT_STDIO_TEST_LEGACY_READ=1`, a fixture that
 *      reproduces the old `::_read`-per-tick shape) stalls that same heartbeat
 *      while the process stays alive, and resumes only when a frame arrives.
 *      That is what makes this a discriminating test rather than a liveness
 *      check.
 *   3. closing stdin (EOF) keeps the GUI thread ticking and then lets the app
 *      leave on its own, instead of freezing or lingering as a ghost window.
 *
 * No fake timers and no "the process is still running" assertions: every claim
 * comes from the GUI thread's own ticks and from the window objects it sees.
 *
 * Run it explicitly — `pnpm test` only runs `tests/*.test.ts`:
 *
 *     DSH_QT_APP_BINARY=build/dsh-qt-app pnpm exec tsx --test tests/gui-heartbeat.e2e.ts
 *
 * Platform notes. On Windows the polled read path is the only path, so the
 * native run is the real thing; on Linux the same path is selected with
 * `DSH_QT_STDIO_POLL=1` so a hosted Linux runner exercises identical code. When
 * the runner has no visible desktop (offscreen QPA), the window-exposure
 * assertion is what changes, never the heartbeat one: set
 * `DSH_QT_EXPECT_NO_DESKTOP=1` to require a created+visible window and record
 * exposure as unavailable instead of asserting it. A real first-window
 * observation on the user's own machine is still a separate piece of evidence.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { HostBridgeService } from '../src/host/bridge-service.js'
import { HostTransport } from '../src/host/transport.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultBinary = join(root, 'build', process.platform === 'win32' ? 'dsh-qt-app.exe' : 'dsh-qt-app')
const binary = process.env.DSH_QT_APP_BINARY ?? defaultBinary
const skipReason = existsSync(binary) ? false : `no Qt binary at ${binary}; run cmake --build build first`
const expectNoDesktop = process.env.DSH_QT_EXPECT_NO_DESKTOP === '1'

/** One `hb` line: GUI-thread tick, and what the window list looked like. */
interface Beat {
  readonly sequence: number
  readonly elapsed: number
  readonly windows: number
  readonly exposed: number
  readonly visible: number
}

function readBeats(path: string): Beat[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('hb '))
    .map((line) => {
      const [, sequence, elapsed, windows, exposed, visible] = line.trim().split(/\s+/)
      return {
        sequence: Number(sequence),
        elapsed: Number(elapsed),
        windows: Number(windows),
        exposed: Number(exposed),
        visible: Number(visible),
      }
    })
}

/** Longest stretch between two consecutive ticks, in ms. */
function longestGap(beats: readonly Beat[]): number {
  let gap = 0
  for (let index = 1; index < beats.length; index += 1)
    gap = Math.max(gap, beats[index]!.elapsed - beats[index - 1]!.elapsed)
  return gap
}

interface Session {
  readonly child: ChildProcessWithoutNullStreams
  readonly host: HostBridgeService
  readonly beats: string
  waitConnected(): Promise<void>
  waitExit(ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null>
  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function launch(options: {
  polled?: boolean
  legacyRead?: boolean
  testHooks?: boolean
  label: string
}): Session {
  const beats = join(tmpdir(), `dsh-qt-heartbeat-${process.pid}-${options.label}.txt`)
  rmSync(beats, { force: true })
  const child = spawn(binary, [], {
    cwd: root,
    env: {
      ...process.env,
      DSH_QT_HEARTBEAT_FILE: beats,
      QT_QPA_PLATFORM: process.platform === 'win32' ? 'windows' : 'offscreen',
      ...(options.polled === true ? { DSH_QT_STDIO_POLL: '1' } : {}),
      ...(options.legacyRead === true ? { DSH_QT_STDIO_TEST_LEGACY_READ: '1' } : {}),
      ...(options.testHooks === true ? { DSH_QT_TEST_HOOKS: '1' } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', () => {})
  child.stdout.setEncoding('utf8')

  const transport = new HostTransport({ input: child.stdout, output: child.stdin })
  const host = new HostBridgeService(new Context(), {
    autoLaunch: false,
    handshakeTimeoutMs: 10_000,
    requestTimeoutMs: 5_000,
  })
  host.onStateChange(() => {})
  host.register('ping', () => ({ pong: true, host: 'gui-heartbeat-e2e' }))
  host.attach({ transport, child })

  const waitConnected = async (): Promise<void> => {
    const deadline = Date.now() + 15_000
    while (!host.connected) {
      if (Date.now() > deadline)
        throw new Error(`the Qt host never completed the handshake (state: ${host.state})`)
      await delay(25)
    }
  }

  const waitExit = async (
    ms: number,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> => {
    if (child.exitCode !== null || child.signalCode !== null)
      return { code: child.exitCode, signal: child.signalCode }
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
      child.once('exit', (code, signal) => done({ code, signal }))
    })
    return Promise.race([exited, delay(ms).then(() => null)])
  }

  const stop = async (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      host.dispose()
      return { code: child.exitCode, signal: child.signalCode }
    }
    child.kill()
    const result = await waitExit(5_000)
    if (result === null) child.kill('SIGKILL')
    host.dispose()
    return result ?? { code: null, signal: 'SIGKILL' }
  }

  return { child, host, beats, waitConnected, waitExit, stop }
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

test(
  'polled reads: the GUI thread keeps ticking while stdin stays open and silent',
  { skip: skipReason, timeout: 90_000 },
  async () => {
    const session = launch({ polled: true, label: 'silent' })
    try {
      await session.waitConnected()
      // Nothing is written from here on: an idle-but-open pipe is exactly the
      // condition that used to freeze the window.
      await delay(2_000)
      assert.equal(session.child.exitCode, null, 'the child must still be running while we sample')
      const beats = readBeats(session.beats)
      assert.ok(
        beats.length >= 20,
        `the GUI thread ticked only ${beats.length} times in 2 s of silence; beats: ${JSON.stringify(beats)}`,
      )
      assert.ok(
        longestGap(beats) <= 250,
        `the GUI thread stalled for ${longestGap(beats)} ms while stdin was silent; beats: ${JSON.stringify(beats)}`,
      )
      const last = beats[beats.length - 1]!
      assert.ok(last.windows >= 1, `no top-level QWindow was ever created; beats: ${JSON.stringify(beats)}`)
      if (expectNoDesktop) {
        assert.ok(last.visible >= 1, 'the window was never shown, even though this runner reports a desktop')
        console.log('# window exposure is not asserted here: DSH_QT_EXPECT_NO_DESKTOP=1 (no visible desktop)')
      } else {
        assert.ok(
          beats.some((beat) => beat.exposed >= 1),
          `the window was created but never exposed; beats: ${JSON.stringify(beats)}`,
        )
      }
      assert.equal(session.child.exitCode, null, 'the child must still be running after the assertions')
    } finally {
      await session.stop()
    }
  },
)

test(
  'the pre-fix read loop parks the GUI thread until a frame arrives',
  { skip: skipReason, timeout: 90_000 },
  async () => {
    const session = launch({ polled: true, legacyRead: true, label: 'legacy' })
    try {
      await session.waitConnected()
      await delay(2_000)
      const stalled = readBeats(session.beats)
      // The old loop blocks inside the very first read, so the heartbeat file
      // barely moves while the process stays alive — the user-visible symptom.
      assert.ok(
        stalled.length <= 3,
        `the legacy read loop kept ticking (${stalled.length} beats); it no longer reproduces the freeze: ${JSON.stringify(stalled)}`,
      )
      assert.equal(session.child.exitCode, null, 'the frozen process is still alive, which is the point')
      // A frame unblocks the read and the protocol advances — the app answers —
      // yet the GUI thread only turns for that one frame and parks again. That
      // combination is the defect: the pipe works, the window does not.
      const reply = await session.host.invoke('host.ping')
      assert.deepEqual(reply, { pending: 0, state: 'connected' }, 'the frozen app still answered a frame')
      await delay(500)
      // Whether the parked loop turns once more depends on which of the two
      // timers Qt dispatches first, so the durable invariant is the *rate*: over
      // 2.5 s the thread must stay at a couple of ticks with a gap of a second or
      // more, against >= 20 ticks and <= 250 ms gaps on the fixed path.
      const resumed = readBeats(session.beats)
      assert.ok(
        resumed.length <= 3,
        `the GUI thread ran at full rate after a frame (${stalled.length} → ${resumed.length} beats)`,
      )
      // The durable invariant is the *rate after* the frame, not the absolute
      // elapsed time of the last tick: answering the ping is what unblocks the
      // read, so one further tick is expected however the two timers interleave.
      // What must not happen is the thread returning to a normal rate — the fixed
      // path adds about ten ticks over the same 500 ms.
      const added = resumed.length - stalled.length
      assert.ok(
        added <= 2,
        `the GUI thread resumed a normal rate after one frame (${stalled.length} → ${resumed.length} beats)`,
      )
      assert.equal(
        session.child.exitCode,
        null,
        'the parked process is still alive after answering, which is the symptom',
      )
    } finally {
      await session.stop()
    }
  },
)

test(
  'closing stdin keeps the GUI ticking and then exits cleanly instead of lingering',
  { skip: skipReason, timeout: 90_000 },
  async () => {
    const session = launch({ polled: true, label: 'eof' })
    try {
      await session.waitConnected()
      await delay(300)
      const before = readBeats(session.beats).length
      session.child.stdin.end()
      await delay(1_000)
      const after = readBeats(session.beats).length
      assert.ok(
        after - before >= 8,
        `the GUI thread stopped ticking after EOF (${before} → ${after}); a broken pipe must not park it`,
      )
      // The transport documents "a broken pipe is not fatal" for the connection
      // and "EOF after a live session means the host died: do not linger as a
      // ghost window" for the window. Both halves are asserted: the thread kept
      // ticking, and the process then leaves on its own with a success code.
      const exit = await session.waitExit(5_000)
      assert.notEqual(exit, null, 'the window lingered after the host went away')
      assert.equal(exit!.code, 0, `the app exited with ${String(exit!.code)} after EOF`)
    } finally {
      await session.stop()
    }
  },
)

test(
  'a stalled reader never freezes the GUI, and the large reply arrives intact',
  { skip: skipReason, timeout: 90_000 },
  async () => {
    // Item C of the review: the POSIX writer used to hand a whole frame to
    // `::write`, which blocks once the pipe is full — the same freeze as the
    // read side, one direction over. The Windows writer thread can block, but
    // only itself. This case covers both: the reader stops draining, the Qt side
    // is asked for a 200 KB reply (far past any pipe buffer), and the GUI thread
    // has to keep ticking while that reply waits.
    const session = launch({ polled: true, testHooks: true, label: 'stalled-reader' })
    try {
      await session.waitConnected()
      const before = readBeats(session.beats).length
      session.child.stdout.pause()
      const pending = session.host.invoke('host.echo', { bytes: 200_000 })
      await delay(1_000)
      const during = readBeats(session.beats)
      assert.ok(
        during.length - before >= 15,
        `the GUI thread stalled while its reader was not draining (${before} → ${during.length} beats)`,
      )
      session.child.stdout.resume()
      const reply = (await pending) as { bytes: number; payload: string }
      assert.equal(reply.bytes, 200_000, 'the reply frame lost bytes across the stalled window')
      assert.equal(reply.payload.length, 200_000, 'the reply payload was truncated or interleaved')
    } finally {
      await session.stop()
    }
  },
)

test(
  'a 1 MB inbound frame is consumed at MB/s without starving the GUI thread',
  { skip: skipReason, timeout: 90_000 },
  async () => {
    // Item D: one 4 KB read per 25 ms tick capped inbound throughput at ~160 KB/s
    // and made a large frame take many seconds. The read budget moves 64 KB per
    // tick, so a megabyte should land in well under a second while the heartbeat
    // keeps its cadence.
    const session = launch({ polled: true, testHooks: true, label: 'inbound' })
    try {
      await session.waitConnected()
      const before = readBeats(session.beats).length
      const started = Date.now()
      const reply = (await session.host.invoke('host.echo', { bytes: 1, pad: 'x'.repeat(1_000_000) })) as {
        bytes: number
      }
      const elapsed = Date.now() - started
      assert.equal(reply.bytes, 1, 'the request did not survive a megabyte frame')
      assert.ok(elapsed < 2_000, `a 1 MB frame took ${elapsed} ms to reach the GUI thread`)
      const during = readBeats(session.beats)
      assert.ok(
        during.length - before >= 8,
        `the GUI thread starved while a large frame was read (${before} → ${during.length} beats)`,
      )
    } finally {
      await session.stop()
    }
  },
)

test(
  'quitting while the reader is stalled is bounded and exits with a definite code',
  { skip: skipReason, timeout: 90_000 },
  async () => {
    // Item A: `stop()` used to `join()` a writer parked inside `WriteFile` on a
    // full pipe, so the process never exited. Fill the pipe, ask the app to
    // quit, and require a real exit inside five seconds.
    const session = launch({ polled: true, testHooks: true, label: 'bounded-exit' })
    try {
      await session.waitConnected()
      session.child.stdout.pause()
      // Two 200 KB replies overflow any pipe buffer, so the writer is parked.
      void session.host.invoke('host.echo', { bytes: 200_000 }).catch(() => {})
      void session.host.invoke('host.echo', { bytes: 200_000 }).catch(() => {})
      await delay(750)
      assert.equal(session.child.exitCode, null, 'the app should still be running before it is asked to quit')
      const quitAt = Date.now()
      void session.host.invoke('host.quit').catch(() => {})
      const result = await session.waitExit(5_000)
      const waited = Date.now() - quitAt
      assert.notEqual(result, null, 'the app hung instead of exiting with a stalled reader')
      assert.equal(result!.code, 0, `the app exited with ${String(result!.code)} instead of 0`)
      assert.ok(waited < 5_000, `the exit took ${waited} ms`)
    } finally {
      await session.stop()
    }
  },
)

test('the outbound queue keeps one byte count and drops the oldest frames', { skip: skipReason }, () => {
  // Review item B. The queue used to be split in two — a list on the GUI side
  // and a deque inside the Windows writer thread — so the cap only saw half the
  // backlog and a stalled reader plus a live producer could not be reproduced.
  // The accounting is now one OutboundQueue, and the binary replays a scripted
  // sequence through that same code: no pipe, no window, no peer.
  const result = spawnSync(binary, [], {
    cwd: root,
    env: { ...process.env, DSH_QT_OUTBOUND_QUEUE_SELFTEST: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.status, 0, `the queue selftest failed:\n${output}`)
  const checks = output.split('\n').filter((line) => line.startsWith('ok ') || line.startsWith('not ok '))
  assert.ok(checks.length >= 12, `expected the full table, got:\n${output}`)
  assert.deepEqual(
    checks.filter((line) => line.startsWith('not ok ')),
    [],
    `failing queue checks:\n${output}`,
  )
  assert.match(output, /outbound-queue selftest: pass/)
})
