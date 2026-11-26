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
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

/** One `ob` line: a tick from the Qt-free observer thread, on its own clock. */
interface ObserverBeat {
  readonly sequence: number
  readonly steady: number
}

/** One `blk`/`blk-end` pair, written by the test-only GUI park. */
interface BlockProbe {
  readonly startedAt: number
  readonly ms: number
  readonly endedAt: number | null
}

/** One `host.ping` answer, as documented in the host protocol. */
interface PingAnswer {
  readonly state: string
  readonly pending: number
  readonly details: readonly PendingDetail[] | null
}

/** One entry of the Qt→Node request book, exposed only under test hooks. */
interface PendingDetail {
  readonly id: string
  readonly method: string
  readonly ageMs: number
  readonly sent: boolean
}

interface FileRead {
  readonly exists: boolean
  readonly size: number
  readonly mtimeMs: number | null
  readonly readError: string | null
  readonly text: string
}

/**
 * One sampling instant of both heartbeat channels.
 *
 * The file's contents alone cannot explain a failure: an empty beat list means
 * "the GUI thread never ticked", "the file was never created" or "the file could
 * not be read", and those want different answers. Every assertion that depends
 * on a sample therefore reports the whole thing through `describeSample`.
 */
interface HeartbeatSample {
  readonly path: string
  readonly exists: boolean
  readonly size: number
  readonly mtimeMs: number | null
  readonly readError: string | null
  readonly beats: readonly Beat[]
  readonly blocks: readonly BlockProbe[]
  readonly observerPath: string
  readonly observerExists: boolean
  readonly observerSize: number
  readonly observerError: string | null
  readonly observer: readonly ObserverBeat[]
  /** Bytes the host has received from / sent to the Qt side so far. */
  readonly bytesIn: number
  readonly bytesOut: number
  readonly collectedAt: number
}

function readTextFile(path: string): FileRead {
  let size = 0
  let mtimeMs: number | null = null
  try {
    const stat = statSync(path)
    size = stat.size
    mtimeMs = stat.mtimeMs
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'EUNKNOWN'
    if (code === 'ENOENT')
      return { exists: false, size: 0, mtimeMs: null, readError: null, text: '' }
    return {
      exists: false,
      size: 0,
      mtimeMs: null,
      readError: `${code}: ${(error as Error).message}`,
      text: '',
    }
  }
  try {
    return { exists: true, size, mtimeMs, readError: null, text: readFileSync(path, 'utf8') }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'EUNKNOWN'
    return {
      exists: true,
      size,
      mtimeMs,
      readError: `${code}: ${(error as Error).message}`,
      text: '',
    }
  }
}

function parseBeats(text: string): Beat[] {
  const beats: Beat[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('hb ')) continue
    const [, sequence, elapsed, windows, exposed, visible] = line.trim().split(/\s+/)
    beats.push({
      sequence: Number(sequence),
      elapsed: Number(elapsed),
      windows: Number(windows),
      exposed: Number(exposed),
      visible: Number(visible),
    })
  }
  return beats
}

function parseObserver(text: string): ObserverBeat[] {
  const ticks: ObserverBeat[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('ob ')) continue
    const [, sequence, steady] = line.trim().split(/\s+/)
    ticks.push({ sequence: Number(sequence), steady: Number(steady) })
  }
  return ticks
}

function parseBlocks(text: string): BlockProbe[] {
  const blocks: BlockProbe[] = []
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields[0] === 'blk') {
      blocks.push({ startedAt: Number(fields[1]), ms: Number(fields[2]), endedAt: null })
      continue
    }
    if (fields[0] === 'blk-end') {
      const last = blocks[blocks.length - 1]
      if (last !== undefined && last.endedAt === null)
        blocks[blocks.length - 1] = { ...last, endedAt: Number(fields[1]) }
    }
  }
  return blocks
}

/** Beats only, without the rest of the sample. Kept for the byte-level tests. */
function readBeats(path: string): Beat[] {
  return parseBeats(readTextFile(path).text)
}

/** Longest stretch between two consecutive GUI ticks, in ms. */
function longestGap(beats: readonly Beat[]): number {
  let gap = 0
  for (let index = 1; index < beats.length; index += 1)
    gap = Math.max(gap, beats[index]!.elapsed - beats[index - 1]!.elapsed)
  return gap
}

/** Longest stretch between two consecutive observer ticks, in ms. */
function longestObserverGap(ticks: readonly ObserverBeat[]): number {
  let gap = 0
  for (let index = 1; index < ticks.length; index += 1)
    gap = Math.max(gap, ticks[index]!.steady - ticks[index - 1]!.steady)
  return gap
}

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  // A request to a process that died without answering would otherwise keep the
  // file-level promise pending and turn a clear failure into a runner timeout.
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

function readPingAnswer(reply: unknown): PingAnswer | null {
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) return null
  const answer = reply as Record<string, unknown>
  const state = answer['state']
  const pending = answer['pending']
  if (typeof state !== 'string' || typeof pending !== 'number') return null
  const rawDetails = answer['pendingDetails']
  let details: PendingDetail[] | null = null
  if (Array.isArray(rawDetails)) {
    details = []
    for (const entry of rawDetails) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      details.push({
        id: typeof record['id'] === 'string' ? record['id'] : '',
        method: typeof record['method'] === 'string' ? record['method'] : '',
        ageMs: typeof record['ageMs'] === 'number' ? record['ageMs'] : -1,
        sent: record['sent'] === true,
      })
    }
  }
  return { state, pending, details }
}

/** Everything one sample knows, on one line: the failure message, not a guess. */
function describeSample(sample: HeartbeatSample): string {
  const first = sample.beats[0]
  const last = sample.beats[sample.beats.length - 1]
  const parts = [
    `beats=${sample.beats.length}`,
    first === undefined ? 'first=none' : `first=#${first.sequence}@${first.elapsed}ms`,
    last === undefined
      ? 'last=none'
      : `last=#${last.sequence}@${last.elapsed}ms windows=${last.windows} exposed=${last.exposed} visible=${last.visible}`,
    `longestGap=${longestGap(sample.beats)}ms`,
    `blocks=${JSON.stringify(sample.blocks)}`,
    `observer=${sample.observer.length}`,
    `observerGap=${longestObserverGap(sample.observer)}ms`,
    `bytesIn=${sample.bytesIn} bytesOut=${sample.bytesOut}`,
    `beatFile=${sample.path} exists=${sample.exists} size=${sample.size}`,
    `mtime=${sample.mtimeMs === null ? 'none' : new Date(sample.mtimeMs).toISOString()}`,
    `readError=${sample.readError === null ? 'none' : sample.readError}`,
    `observerFile exists=${sample.observerExists} size=${sample.observerSize}`,
    `observerReadError=${sample.observerError === null ? 'none' : sample.observerError}`,
    `collectedAt=${new Date(sample.collectedAt).toISOString()}`,
  ]
  return parts.join(' ')
}

/** The four start-up legs, each measured against the same spawn instant. */
interface Stages {
  readonly connectedMs: number
  readonly firstTickMs: number | null
  readonly firstWindowMs: number | null
  readonly firstTickElapsedMs: number | null
  readonly observerBeforeFirstTick: number
}

interface SteadyWindow {
  readonly windowMs: number
  readonly before: HeartbeatSample
  readonly after: HeartbeatSample
  readonly fresh: readonly Beat[]
  readonly gap: number
}

interface Session {
  readonly child: ChildProcessWithoutNullStreams
  readonly host: HostBridgeService
  readonly beats: string
  readonly observerFile: string
  readonly label: string
  readonly startedAt: number
  /** What the child wrote to stderr so far; drained, not interpreted. */
  readonly stderr: readonly string[]
  sample(): HeartbeatSample
  waitConnected(): Promise<void>
  /** First GUI tick, or null when the deadline passes without one. */
  waitFirstBeat(timeoutMs?: number): Promise<Beat | null>
  waitFirstWindow(timeoutMs?: number): Promise<Beat | null>
  measureStartup(): Promise<Stages>
  sampleSteady(options: { minimumBeats?: number; windowMs: number }): Promise<SteadyWindow>
  archive(): void
  waitExit(ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null>
  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function launch(options: {
  polled?: boolean
  legacyRead?: boolean
  testHooks?: boolean
  label: string
  /** Test-only negative control: park the GUI thread for this many ms. */
  blockGuiMs?: number
  /** Use this path as the beat file (a directory makes the open fail). */
  heartbeatFile?: string
  /** Set to false to run without the independent observer channel. */
  observer?: boolean
}): Session {
  const beats = options.heartbeatFile ?? join(tmpdir(), `dsh-qt-heartbeat-${process.pid}-${options.label}.txt`)
  if (options.heartbeatFile === undefined) rmSync(beats, { force: true })
  const observerFile = join(tmpdir(), `dsh-qt-heartbeat-observer-${process.pid}-${options.label}.txt`)
  rmSync(observerFile, { force: true })
  const startedAt = Date.now()
  const child = spawn(binary, [], {
    cwd: root,
    env: {
      ...process.env,
      DSH_QT_HEARTBEAT_FILE: beats,
      ...(options.observer === false ? {} : { DSH_QT_HEARTBEAT_OBSERVER_FILE: observerFile }),
      QT_QPA_PLATFORM: process.platform === 'win32' ? 'windows' : 'offscreen',
      ...(options.polled === true ? { DSH_QT_STDIO_POLL: '1' } : {}),
      ...(options.legacyRead === true ? { DSH_QT_STDIO_TEST_LEGACY_READ: '1' } : {}),
      ...(options.testHooks === true ? { DSH_QT_TEST_HOOKS: '1' } : {}),
      ...(options.blockGuiMs === undefined ? {} : { DSH_QT_TEST_BLOCK_GUI_MS: String(options.blockGuiMs) }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  // Kept, not dropped: a heartbeat channel that cannot be opened has to be
  // reportable, and silence there looks exactly like a frozen GUI thread.
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 200) stderr.push(chunk)
  })
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

  const sample = (): HeartbeatSample => {
    const beatFile = readTextFile(beats)
    const observerRead = readTextFile(observerFile)
    const stats = host.stats.transport
    return {
      path: beats,
      exists: beatFile.exists,
      size: beatFile.size,
      mtimeMs: beatFile.mtimeMs,
      readError: beatFile.readError,
      beats: parseBeats(beatFile.text),
      blocks: parseBlocks(beatFile.text),
      observerPath: observerFile,
      observerExists: observerRead.exists,
      observerSize: observerRead.size,
      observerError: observerRead.readError,
      observer: parseObserver(observerRead.text),
      bytesIn: stats === null ? 0 : stats.bytesIn,
      bytesOut: stats === null ? 0 : stats.bytesOut,
      collectedAt: Date.now(),
    }
  }

  const waitConnected = async (): Promise<void> => {
    const deadline = Date.now() + 15_000
    while (!host.connected) {
      if (Date.now() > deadline)
        throw new Error(`the Qt host never completed the handshake (state: ${host.state})`)
      await delay(25)
    }
  }

  const waitFirstBeat = async (timeoutMs = 20_000): Promise<Beat | null> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const current = sample()
      const beat = current.beats[0]
      if (beat !== undefined) return beat
      if (Date.now() > deadline) return null
      await delay(25)
    }
  }

  const waitFirstWindow = async (timeoutMs = 25_000): Promise<Beat | null> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const beat = sample().beats.find((entry) => entry.windows >= 1)
      if (beat !== undefined) return beat
      if (Date.now() > deadline) return null
      await delay(25)
    }
  }

  const measureStartup = async (): Promise<Stages> => {
    await waitConnected()
    const connectedMs = Date.now() - startedAt
    // The observer has to be running before the GUI timer is: sample it while the
    // beat file is still empty, which is the window the pre-fix bug hid in.
    const early = sample()
    const tick = await waitFirstBeat()
    const firstTickMs = tick === null ? null : Date.now() - startedAt
    const window = await waitFirstWindow()
    const stages: Stages = {
      connectedMs,
      firstTickMs,
      firstWindowMs: window === null ? null : Date.now() - startedAt,
      firstTickElapsedMs: tick === null ? null : tick.elapsed,
      observerBeforeFirstTick: early.observer.length,
    }
    console.log(`# stages ${options.label}: ${JSON.stringify(stages)}`)
    return stages
  }

  const sampleSteady = async (steady: {
    minimumBeats?: number
    windowMs: number
  }): Promise<SteadyWindow> => {
    const minimum = steady.minimumBeats ?? 10
    const deadline = Date.now() + 20_000
    while (sample().beats.length < minimum) {
      if (Date.now() > deadline) break
      await delay(25)
    }
    const before = sample()
    await delay(steady.windowMs)
    const after = sample()
    const fresh = after.beats.slice(before.beats.length)
    return { windowMs: steady.windowMs, before, after, fresh, gap: longestGap(fresh) }
  }

  const archive = (): void => {
    const directory = process.env['DSH_QT_HB_ARTIFACT_DIR']
    if (directory === undefined || directory === '') return
    try {
      mkdirSync(directory, { recursive: true })
      const final = sample()
      if (final.exists) copyFileSync(beats, join(directory, `${options.label}-hb.txt`))
      if (final.observerExists)
        copyFileSync(observerFile, join(directory, `${options.label}-observer.txt`))
      writeFileSync(
        join(directory, `${options.label}-summary.json`),
        `${JSON.stringify(
          {
            label: options.label,
            platform: process.platform,
            binary,
            beats: final.beats.length,
            observer: final.observer.length,
            blocks: final.blocks,
            bytesIn: final.bytesIn,
            bytesOut: final.bytesOut,
            stderr: stderr.join(''),
          },
          null,
          2,
        )}\n`,
      )
    } catch (error) {
      // Archiving is evidence collection; it never fails a run.
      console.log(`# could not archive the samples: ${(error as Error).message}`)
    }
  }

  const waitExit = async (
    ms: number,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> => {
    if (child.exitCode !== null || child.signalCode !== null)
      return { code: child.exitCode, signal: child.signalCode }
    // The timer is cleared when the process exits: a `Promise.race` against an
    // un-cancelled `delay` leaves a pending timer behind, and the test runner
    // reports that as "promise resolution is still pending" at file end.
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null } | null>((done) => {
      const timer = setTimeout(() => {
        child.off('exit', onExit)
        done(null)
      }, ms)
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        clearTimeout(timer)
        done({ code, signal })
      }
      child.once('exit', onExit)
    })
  }

  const stop = async (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      archive()
      host.dispose()
      return { code: child.exitCode, signal: child.signalCode }
    }
    child.kill()
    const result = await waitExit(5_000)
    if (result === null) child.kill('SIGKILL')
    archive()
    host.dispose()
    return result ?? { code: null, signal: 'SIGKILL' }
  }

  return {
    child,
    host,
    beats,
    observerFile,
    label: options.label,
    startedAt,
    stderr,
    sample,
    waitConnected,
    waitFirstBeat,
    waitFirstWindow,
    measureStartup,
    sampleSteady,
    archive,
    waitExit,
    stop,
  }
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
      // Item A of the review: the start-up legs are measured one by one and each
      // one is bounded, so "the GUI never ticked" can no longer be mistaken for
      // "the process was merely slow to start".
      const stages = await session.measureStartup()
      assert.ok(
        stages.connectedMs <= 15_000,
        `the handshake took ${stages.connectedMs} ms: ${describeSample(session.sample())}`,
      )
      assert.ok(
        stages.firstTickMs !== null && stages.firstTickMs <= 20_000,
        `the GUI thread produced no first tick within 20 s: ${describeSample(session.sample())}`,
      )
      assert.ok(
        stages.firstWindowMs !== null && stages.firstWindowMs <= 25_000,
        `no top-level QWindow appeared within 25 s: ${describeSample(session.sample())}`,
      )
      // Steady state is measured from the first tick on, never from the handshake:
      // on a cold runner the event loop turns long after the frame arrives.
      await delay(0)
      const steady = await session.sampleSteady({ minimumBeats: 10, windowMs: 2_000 })
      assert.equal(session.child.exitCode, null, 'the child must still be running while we sample')
      assert.ok(
        steady.fresh.length >= 20,
        `the GUI thread ticked ${steady.fresh.length} times in ${steady.windowMs} ms of silence after its first tick: ${describeSample(steady.after)}`,
      )
      assert.ok(
        steady.gap <= 250,
        `the GUI thread stalled for ${steady.gap} ms while stdin was silent: ${describeSample(steady.after)}`,
      )
      const last = steady.after.beats[steady.after.beats.length - 1]
      assert.ok(
        last !== undefined && last.windows >= 1,
        `no top-level QWindow was ever created: ${describeSample(steady.after)}`,
      )
      if (expectNoDesktop) {
        assert.ok(last.visible >= 1, 'the window was never shown, even though this runner reports a desktop')
        console.log('# window exposure is not asserted here: DSH_QT_EXPECT_NO_DESKTOP=1 (no visible desktop)')
      } else {
        assert.ok(
          steady.after.beats.some((beat) => beat.exposed >= 1),
          `the window was created but never exposed: ${describeSample(steady.after)}`,
        )
      }
      console.log(
        `# steady: ${steady.fresh.length} ticks in ${steady.windowMs} ms, longest gap ${steady.gap} ms, bytes in/out ${steady.after.bytesIn}/${steady.after.bytesOut}`,
      )
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
      // The pre-fix loop parks inside its very first read, so the heartbeat file
      // may never get a tick at all. Wait for one *bounded* window instead of
      // sleeping past it, so a slow runner cannot be mistaken for a parked GUI.
      const firstTick = await session.waitFirstBeat(3_000)
      const stalled = session.sample()
      console.log(
        `# legacy: first tick ${firstTick === null ? 'never observed within 3 s' : `at ${firstTick.elapsed} ms`}; ${describeSample(stalled)}`,
      )
      // The old loop blocks inside the very first read, so the heartbeat file
      // barely moves while the process stays alive — the user-visible symptom.
      assert.ok(
        stalled.beats.length <= 3,
        `the legacy read loop kept ticking (${stalled.beats.length} beats); it no longer reproduces the freeze: ${describeSample(stalled)}`,
      )
      assert.equal(session.child.exitCode, null, 'the frozen process is still alive, which is the point')
      // A frame unblocks the read and the protocol advances — the app answers —
      // yet the GUI thread only turns for that one frame and parks again. That
      // combination is the defect: the pipe works, the window does not.
      // The observer runs on its own 50 ms cadence and starts with the process, so
      // give it a bounded window rather than sampling the instant the handshake
      // lands: what matters is that it keeps writing while the GUI cannot.
      const observerDeadline = Date.now() + 3_000
      let observerAtFrame = stalled.observer.length
      while (session.sample().observer.length < 5 && Date.now() < observerDeadline)
        await delay(25)
      observerAtFrame = session.sample().observer.length
      assert.ok(
        observerAtFrame >= 5,
        `the observer channel never ticked while the GUI was parked: ${describeSample(session.sample())}`,
      )
      const reply = await settleWithin(session.host.invoke('host.ping'), 6_000)
      // The ping reply is checked field by field (item C): `pending` is this
      // process's outstanding Qt→Node request count, not a verdict on the GUI, so
      // the assertion is about the book being empty and the transport being up.
      const answer = readPingAnswer(reply)
      assert.ok(answer !== null, `the frozen app did not answer host.ping: ${JSON.stringify(reply)}`)
      assert.equal(answer.pending, 0, `the parked app reported ${answer.pending} outstanding requests: ${JSON.stringify(reply)}`)
      assert.equal(answer.state, 'connected', `the parked app reported state ${answer.state}: ${JSON.stringify(reply)}`)
      await delay(500)
      const observerAfterFrame = session.sample().observer.length
      assert.ok(
        observerAfterFrame - observerAtFrame >= 5,
        `the independent observer wrote ${observerAfterFrame - observerAtFrame} ticks in 500 ms while the GUI was parked: ${describeSample(session.sample())}`,
      )
      // Whether the parked loop turns once more depends on which of the two
      // timers Qt dispatches first, so the durable invariant is the *rate*: over
      // 2.5 s the thread must stay at a couple of ticks with a gap of a second or
      // more, against >= 20 ticks and <= 250 ms gaps on the fixed path.
      const resumed = session.sample()
      assert.ok(
        resumed.beats.length <= 3,
        `the GUI thread ran at full rate after a frame (${stalled.beats.length} → ${resumed.beats.length} beats): ${describeSample(resumed)}`,
      )
      // The durable invariant is the *rate after* the frame, not the absolute
      // elapsed time of the last tick: answering the ping is what unblocks the
      // read, so one further tick is expected however the two timers interleave.
      // What must not happen is the thread returning to a normal rate — the fixed
      // path adds about ten ticks over the same 500 ms.
      const added = resumed.beats.length - stalled.beats.length
      assert.ok(
        added <= 2,
        `the GUI thread resumed a normal rate after one frame (${stalled.beats.length} → ${resumed.beats.length} beats): ${describeSample(resumed)}`,
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
      // Back-pressure is a steady-state property, so the baseline has to start
      // from a first tick, not from the handshake: otherwise "no tick yet" and
      // "the thread stalled" are the same observation.
      const firstTick = await session.waitFirstBeat()
      assert.ok(
        firstTick !== null,
        `the GUI thread never ticked before the back-pressure window: ${describeSample(session.sample())}`,
      )
      const baseline = session.sample()
      const before = baseline.beats.length
      const bytesInBefore = baseline.bytesIn
      const bytesOutBefore = baseline.bytesOut
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
      const settled = session.sample()
      assert.ok(
        settled.bytesIn - bytesInBefore >= 200_000,
        `the transport counted only ${settled.bytesIn - bytesInBefore} inbound bytes for a 200 KB reply: ${describeSample(settled)}`,
      )
      console.log(
        `# back-pressure: ${during.length - before} ticks during the stalled second, bytes in ${settled.bytesIn - bytesInBefore} / out ${settled.bytesOut - bytesOutBefore}`,
      )
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
      // Raw frames: the host's request bookkeeping would leave a pending promise
      // behind once the process exits, and this case is about the transport.
      const ask = (id: string, method: string, params?: Record<string, unknown>): void => {
        session.child.stdin.write(`${JSON.stringify({ v: 1, kind: 'req', id, method, params })}\n`)
      }
      ask('stall-0', 'host.echo', { bytes: 200_000 })
      ask('stall-1', 'host.echo', { bytes: 200_000 })
      await delay(750)
      assert.equal(session.child.exitCode, null, 'the app should still be running before it is asked to quit')
      const quitAt = Date.now()
      ask('quit-0', 'host.quit')
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

test(
  'overflow degrades instead of disconnecting, and every received frame still parses',
  { skip: skipReason, timeout: 120_000 },
  async () => {
    // t98 finding 1/2: overflow used to go through the fatal path, and the drop
    // policy could remove a frame that was already half-written. Now the oldest
    // *unstarted* frames go, the frame on the wire always finishes, and the loss
    // is reported once as a `transport.warn` event — no disconnect.
    const session = launch({ polled: true, testHooks: true, label: 'overflow' })
    const events: { name: string; payload: Record<string, unknown> }[] = []
    session.host.onEvent((event) => {
      events.push({ name: event.name, payload: (event.payload ?? {}) as Record<string, unknown> })
    })
    try {
      await session.waitConnected()
      const beatsBefore = readBeats(session.beats).length
      session.child.stdout.pause()
      // Ten 1 MB replies: the first fills the pipe and is already on the wire, the
      // rest queue well past the 8 MB cap.
      const requests = Array.from({ length: 10 }, () =>
        session.host.invoke('host.echo', { bytes: 1_000_000 }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      )
      await delay(4_000)
      const beatsDuring = readBeats(session.beats)
      assert.ok(
        beatsDuring.length - beatsBefore >= 30,
        `the GUI thread stalled while its reader was paused (${beatsBefore} → ${beatsDuring.length} beats)`,
      )
      assert.equal(session.child.exitCode, null, 'overflow must not kill the session')
      session.child.stdout.resume()
      const results = await Promise.all(requests)

      // The warning is queued behind the replies that were already waiting, so
      // it arrives once the reader drains them — wait for it rather than assume
      // it is already here.
      const warnDeadline = Date.now() + 15_000
      while (
        events.every((event) => event.name !== 'transport.warn') &&
        Date.now() < warnDeadline
      ) {
        await delay(50)
      }
      const warn = events.find((event) => event.name === 'transport.warn')
      assert.ok(
        warn !== undefined,
        `no transport.warn event reached the host: names=${JSON.stringify(events.map((e) => e.name))} ` +
          `state=${session.host.state} exit=${String(session.child.exitCode)} beats=${readBeats(session.beats).length} ` +
          `fulfilled=${results.filter((r) => r.ok).length} rejected=${results.filter((r) => !r.ok).length} ` +
          `lastError=${String(session.host.lastError)} stats=${JSON.stringify(session.host.stats)}`,
      )
      const dropped = Number(warn!.payload.droppedFrames ?? 0)
      assert.ok(dropped > 0, `the warn event did not report a drop count: ${JSON.stringify(warn!.payload)}`)

      const fulfilled = results.filter((result) => result.ok)
      assert.ok(fulfilled.length > 0, 'no reply survived the stall')
      for (const result of fulfilled) {
        const payload = (result as { ok: true; value: { bytes: number; payload: string } }).value
        assert.equal(payload.payload.length, 1_000_000, 'a reply was split or truncated across the stall')
      }
      // Accounting stays honest in both directions: the drop is reported, and no
      // more replies are counted as answered than the requests that were sent.
      // A reply that arrives after its caller gave up is a timeout, not an
      // answer, so this case does not claim all ten were answered.
      const stats = session.host.stats
      assert.ok(
        stats.handled + dropped <= 10,
        `handled ${stats.handled} + dropped ${dropped} exceeds the ${10} requests sent`,
      )
      assert.ok(
        stats.handled >= 1,
        `no reply was handled at all (timeouts ${stats.timeouts}, dropped ${dropped})`,
      )
      const ping = readPingAnswer(await session.host.invoke('host.ping'))
      // Field by field: `pending` is the Qt→Node request book, `state` the
      // transport's, and under the test hooks the book travels with it.
      assert.equal(ping?.state, 'connected', 'the session did not survive the overflow')
      assert.equal(ping?.pending, 0, 'the overflow left requests outstanding')
      assert.equal(session.child.exitCode, null, 'the process is still running after the overflow')
    } finally {
      await session.stop()
    }
  },
)

test(
  'two overflow episodes are reported separately and the totals accumulate',
  { skip: skipReason, timeout: 180_000 },
  async () => {
    // t103 R2: one warn per episode is only useful if the numbers reconcile.
    // Episode one must report a drop, then a drain summary with the running
    // total; episode two must report a *larger* cumulative total, and every
    // report must stay inside the 8 MB cap and carry the inbound counters.
    const session = launch({ polled: true, testHooks: true, label: 'overflow-episodes' })
    interface Warn {
      reason: string
      droppedFrames: number
      queuedBytes: number
      oversizedInbound: unknown
      malformedInbound: unknown
    }
    const warns: Warn[] = []
    session.host.onEvent((event) => {
      if (event.name !== 'transport.warn')
        return
      const payload = (event.payload ?? {}) as Record<string, unknown>
      warns.push({
        reason: String(payload.reason ?? ''),
        droppedFrames: Number(payload.droppedFrames ?? 0),
        queuedBytes: Number(payload.queuedBytes ?? 0),
        oversizedInbound: payload.oversizedInbound,
        malformedInbound: payload.malformedInbound,
      })
    })
    const isOverflow = (warn: Warn): boolean => /outbound queue overflow|full of frames/.test(warn.reason)
    const waitFor = async (predicate: () => boolean, ms: number): Promise<void> => {
      const deadline = Date.now() + ms
      while (!predicate() && Date.now() < deadline)
        await delay(50)
    }
    const flood = (): Promise<unknown>[] =>
      Array.from({ length: 10 }, () =>
        session.host.invoke('host.echo', { bytes: 1_000_000 }).then(
          () => undefined,
          () => undefined,
        ),
      )
    try {
      await session.waitConnected()

      // Episode one: pause the reader, queue ten 1 MB replies, then drain.
      session.child.stdout.pause()
      const episode1 = flood()
      await delay(4_000)
      session.child.stdout.resume()
      await Promise.all(episode1)
      await waitFor(() => warns.some(isOverflow), 20_000)
      const overflow1 = warns.find(isOverflow)
      assert.ok(overflow1 !== undefined, 'the first overflow produced no transport.warn')
      assert.ok(overflow1!.droppedFrames > 0, `the first overflow reported no drop: ${JSON.stringify(overflow1)}`)
      assert.ok(
        overflow1!.queuedBytes <= 8_388_608,
        `a warn reported more queued bytes than the cap: ${overflow1!.queuedBytes}`,
      )

      await waitFor(() => warns.some((warn) => /drained/.test(warn.reason)), 20_000)
      const drain = warns.find((warn) => /drained/.test(warn.reason))
      assert.ok(drain !== undefined, 'the drained queue never produced a summary warn')
      assert.match(
        drain!.reason,
        /drained; \d+ frame\(s\) were dropped in total/,
        `the drain summary does not report a cumulative total: ${drain!.reason}`,
      )
      const totalAfterFirst = drain!.droppedFrames
      assert.ok(
        totalAfterFirst >= overflow1!.droppedFrames,
        `the drain summary (${totalAfterFirst}) is smaller than the first report (${overflow1!.droppedFrames})`,
      )
      assert.ok(drain!.queuedBytes <= 8_388_608, 'the drain summary reports more bytes than the cap')

      // Episode two: the latch was re-armed by the drain, so this must report
      // again, with a larger running total.
      session.child.stdout.pause()
      const episode2 = flood()
      await delay(4_000)
      session.child.stdout.resume()
      await Promise.all(episode2)
      await waitFor(() => warns.filter(isOverflow).length >= 2, 20_000)
      const overflow2 = warns.filter(isOverflow)[1]
      assert.ok(overflow2 !== undefined, 'the second overflow produced no transport.warn')
      assert.ok(
        overflow2!.droppedFrames > totalAfterFirst,
        `the second episode did not report a larger cumulative total ` +
          `(${overflow2!.droppedFrames} <= ${totalAfterFirst})`,
      )
      assert.ok(
        overflow2!.queuedBytes <= 8_388_608,
        `the second warn reports more bytes than the cap: ${overflow2!.queuedBytes}`,
      )
      assert.equal(
        typeof overflow2!.oversizedInbound,
        'number',
        'the warn payload does not carry the oversized-inbound counter',
      )
      assert.equal(
        typeof overflow2!.malformedInbound,
        'number',
        'the warn payload does not carry the malformed-inbound counter',
      )
      assert.equal(session.child.exitCode, null, 'the second overflow killed the session')
      const ping = (await settleWithin(session.host.invoke('host.ping'), 5_000)) as { state: unknown }
      assert.equal(ping.state, 'connected', 'the session did not survive two overflow episodes')
    } finally {
      await session.stop()
    }
  },
)

test(
  'an oversized inbound frame is dropped and the next frame still parses',
  { skip: skipReason, timeout: 120_000 },
  async () => {
    // t98 finding 7 (inbound side): the buffer used to be cleared and the tail of
    // the oversized line parsed as if it were a fresh frame. Now the transport
    // resynchronises on the next newline and keeps the session.
    const session = launch({ polled: true, testHooks: true, label: 'inbound-overflow' })
    const events: { name: string; payload: Record<string, unknown> }[] = []
    session.host.onEvent((event) => {
      events.push({ name: event.name, payload: (event.payload ?? {}) as Record<string, unknown> })
    })
    try {
      await session.waitConnected()
      const oversized = JSON.stringify({
        v: 1,
        kind: 'req',
        id: 'oversized-1',
        method: 'host.ping',
        params: { pad: 'x'.repeat(5_000_000) },
      })
      session.child.stdin.write(`${oversized}\n`)
      await delay(1_000)
      assert.equal(session.child.exitCode, null, 'the app exited on an oversized inbound frame')
      const ping = readPingAnswer(await settleWithin(session.host.invoke('host.ping'), 5_000))
      assert.equal(ping?.state, 'connected', 'the session died on an oversized frame')
      assert.equal(ping?.pending, 0, 'the oversized frame left requests outstanding')
      const warn = events.find((event) => event.name === 'transport.warn')
      assert.ok(warn !== undefined, 'the oversized frame was dropped without telling the host')
      assert.match(String(warn!.payload.reason ?? ''), /inbound frame exceeded/)
      assert.equal(session.child.exitCode, null, 'the process is still running')
    } finally {
      await session.stop()
    }
  },
)

test(
  'an oversized line is dropped through its newline without losing the frame behind it',
  { skip: skipReason, timeout: 120_000 },
  async () => {
    // t103 R1: the resynchronisation path used to `return` right after cutting
    // the oversized line out of the buffer, so a complete frame that arrived in
    // the same read sat in the buffer unparsed until the peer happened to send
    // more bytes. The host then failed it on its 5 s timeout. Both shapes are
    // covered here: the newline already buffered (same write) and the newline
    // arriving later (the discardingLine_ path).
    const session = launch({ polled: true, label: 'oversized-resync' })
    try {
      await session.waitConnected()

      const pingLine = (id: string): string =>
        `${JSON.stringify({ v: 1, kind: 'req', id, method: 'host.ping' })}\n`

      // Shape A: 4 MB + 8 KB of filler, its newline, and a valid request, all in
      // one write — so the newline is already in the buffer when the cap trips.
      const sameWrite = Buffer.concat([
        Buffer.alloc(4_202_496, 0x78),
        Buffer.from(`\n${pingLine('resync-same-write')}`),
      ])
      session.child.stdin.write(sameWrite)
      const first = (await settleWithin(session.host.invoke('host.ping'), 3_000)) as {
        state: unknown
        pending: unknown
      } | null
      // A missing answer must read as "the frame behind the oversized line was
      // never parsed", not as a TypeError on a null field.
      assert.ok(
        first !== null,
        'a valid frame behind an oversized line in the same write was never answered',
      )
      // `pending` is the Qt side's own outstanding-request count, not a verdict
      // on this frame: the assertion is that the ping was answered at all while
      // the session is still connected.
      assert.equal(first.state, 'connected', 'the session left the connected state')
      assert.equal(typeof first.pending, 'number', 'host.ping did not answer with a payload')
      assert.ok(
        typeof first.pending === 'number',
        'a valid frame behind an oversized line in the same write was never answered',
      )

      // Shape B: the oversized line is cut short, its newline arrives later, and
      // the frame follows it. Dropping must not roll back to "parse the tail".
      session.child.stdin.write(Buffer.alloc(5_000_000, 0x79))
      await delay(300)
      session.child.stdin.write(Buffer.from(`\n${pingLine('resync-late-newline')}`))
      const second = (await settleWithin(session.host.invoke('host.ping'), 3_000)) as {
        state: unknown
        pending: unknown
      } | null
      assert.ok(
        second !== null,
        'a frame after a late newline was never answered',
      )
      assert.equal(second.state, 'connected', 'a frame after a late newline was never answered')
      assert.equal(typeof second.pending, 'number', 'host.ping did not answer with a payload')
      assert.equal(session.child.exitCode, null, 'the session died on an oversized line')
    } finally {
      await session.stop()
    }
  },
)

test(
  'stdin redirected from a file does not freeze the GUI thread',
  { skip: skipReason, timeout: 60_000 },
  async () => {
    // t98 finding 3: a non-pipe stdin used to take the plain blocking read. On
    // Windows a redirected file is "always readable", and an empty console is
    // never readable — both used to park the GUI thread. Here stdin is a real
    // file with no data: the app must keep ticking, and it must not spin either.
    const beats = join(tmpdir(), `dsh-qt-heartbeat-${process.pid}-file-stdin.txt`)
    const input = join(tmpdir(), `dsh-qt-stdin-${process.pid}.txt`)
    rmSync(beats, { force: true })
    rmSync(input, { force: true })
    writeFileSync(input, '')
    const fd = openSync(input, 'r')
    const child = spawn(binary, [], {
      cwd: root,
      env: {
        ...process.env,
        DSH_QT_HEARTBEAT_FILE: beats,
        QT_QPA_PLATFORM: process.platform === 'win32' ? 'windows' : 'offscreen',
      },
      stdio: [fd, 'pipe', 'pipe'],
      windowsHide: true,
    })
    closeSync(fd)
    child.stdout?.resume()
    child.stderr?.resume()
    try {
      await delay(1_500)
      const sampled = readBeats(beats)
      assert.ok(sampled.length >= 15, `the GUI thread stopped ticking with file stdin (${sampled.length} beats)`)
      assert.equal(child.exitCode, null, 'the app exited instead of staying up with an empty file stdin')
    } finally {
      child.kill()
      rmSync(input, { force: true })
    }
  },
)

test(
  'the parser selftest covers the cap-tripped-with-newline-buffered shape deterministically',
  { skip: skipReason, timeout: 60_000 },
  () => {
    // A pipe delivers at most 64 KB per read, so the e2e case above cannot
    // guarantee that the newline is already in the buffer on the very pass that
    // trips the 4 MB cap — it depends on how the kernel coalesces the writes.
    // This drives the same parser directly (no I/O, no timers) so the shape is
    // covered on every run instead of only when the timing happens to line up.
    const result = spawnSync(binary, [], {
      env: { ...process.env, DSH_QT_INBOUND_RESYNC_SELFTEST: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.equal(result.status, 0, `the parser selftest exited ${result.status}: ${result.stderr}`)
    assert.doesNotMatch(result.stdout, /^not ok/m, 'a parser selftest check failed')
    assert.match(result.stdout, /inbound-resync selftest: pass/)
    assert.match(
      result.stdout,
      /cap trips with the newline buffered: the frame behind it is parsed in the same pass/,
    )
  },
)

/*
 * The next three cases exist because the earlier suite could not tell three
 * different things apart: a GUI thread that is slow to start, a GUI thread that
 * is genuinely parked, and a measurement channel that is itself dead. Each one
 * uses only harness-side facilities (no new production behaviour), so they run
 * unchanged on a Windows runner.
 */

test(
  'a deliberately parked GUI thread is visible to the observer and stops the heartbeat',
  { skip: skipReason, timeout: 90_000 },
  async () => {
    // The negative control for the whole exercise. `DSH_QT_TEST_BLOCK_GUI_MS`
    // parks the GUI thread on the first tick that has a window, which is what a
    // blocking read would do by accident. If this cannot be detected, a green
    // Windows run would prove nothing.
    const session = launch({ polled: true, testHooks: true, blockGuiMs: 1_200, label: 'parked' })
    try {
      await session.waitConnected()
      const deadline = Date.now() + 25_000
      let sample = session.sample()
      let observerAtPark = -1
      while (sample.blocks.length === 0 || sample.blocks[0]!.endedAt === null) {
        if (observerAtPark < 0 && sample.blocks.length > 0) observerAtPark = sample.observer.length
        if (Date.now() > deadline) break
        await delay(25)
        sample = session.sample()
      }
      const block = sample.blocks[0]
      assert.ok(
        block !== undefined && block.endedAt !== null,
        `the test-only GUI park never ran to completion: ${describeSample(sample)}`,
      )
      // Pin the narrowing where the closure can see it: the assertion above
      // proves both, but a callback body does not inherit that proof.
      const startedAt = block.startedAt
      const endedAt = block.endedAt
      assert.equal(block.ms, 1_200, `the park was asked for 1200 ms, not ${block.ms}`)
      assert.ok(
        endedAt - startedAt >= 1_200,
        `the GUI thread was parked for only ${endedAt - startedAt} ms: ${describeSample(sample)}`,
      )
      // A parked GUI thread cannot tick, and that is a sharper statement than a
      // gap width: no tick may carry an elapsed time inside the parked window.
      const ticksDuringPark = sample.beats.filter(
        (beat) => beat.elapsed > startedAt && beat.elapsed < endedAt,
      )
      assert.equal(
        ticksDuringPark.length,
        0,
        `the GUI thread ticked while it was supposedly parked: ${JSON.stringify(ticksDuringPark)} — ${describeSample(sample)}`,
      )
      // ...and the observer thread must not: it is the channel that separates
      // "the GUI is stuck" from "the whole process is wedged".
      const observerAtEnd = session.sample().observer.length
      assert.ok(
        observerAtPark >= 0,
        `the park marker was seen only after it had already ended: ${describeSample(sample)}`,
      )
      assert.ok(
        observerAtEnd - observerAtPark >= 10,
        `the observer wrote ${observerAtEnd - observerAtPark} ticks during a 1200 ms GUI park: ${describeSample(sample)}`,
      )
      // Once the park ends the GUI thread returns to its normal rate, so the gap
      // above is the park and not a corrupted sampling channel.
      const steady = await session.sampleSteady({ minimumBeats: 10, windowMs: 1_000 })
      assert.ok(
        steady.fresh.length >= 10,
        `the GUI thread did not recover after the park (${steady.fresh.length} ticks in ${steady.windowMs} ms): ${describeSample(steady.after)}`,
      )
      assert.ok(
        steady.gap <= 250,
        `the GUI thread never returned to its steady rate after the park (gap ${steady.gap} ms): ${describeSample(steady.after)}`,
      )
      console.log(
        `# park: ${block.endedAt - block.startedAt} ms parked, ${ticksDuringPark.length} GUI ticks inside the park, ${observerAtEnd - observerAtPark} observer ticks meanwhile`,
      )
    } finally {
      await session.stop()
    }
  },
)

test(
  'the observer channel ticks before the GUI thread has ever ticked',
  { skip: skipReason, timeout: 90_000 },
  async () => {
    // The start-up hole item A is about: the handshake completes long before the
    // event loop runs, and everything the old harness measured inside that window
    // was measuring the wrong thread.
    const session = launch({ polled: true, label: 'startup' })
    try {
      await session.waitConnected()
      const early = session.sample()
      const tick = await session.waitFirstBeat()
      assert.ok(tick !== null, `the GUI thread never produced a first tick: ${describeSample(session.sample())}`)
      const after = session.sample()
      assert.ok(
        after.observer.length >= 1,
        `the observer channel never ticked: ${describeSample(after)}`,
      )
      assert.ok(
        after.observer.length > after.beats.length,
        `the observer did not lead the GUI thread (${after.observer.length} observer ticks vs ${after.beats.length} GUI ticks): ${describeSample(after)}`,
      )
      assert.ok(
        tick.elapsed >= 0,
        `the first tick carried a negative elapsed time: ${JSON.stringify(tick)}`,
      )
      console.log(
        `# startup: ${after.observer.length} observer ticks before the first GUI tick (elapsed ${tick.elapsed} ms); early sample: ${describeSample(early)}`,
      )
    } finally {
      await session.stop()
    }
  },
)

test(
  'a heartbeat file that cannot be opened is reported and never stops the app',
  { skip: skipReason, timeout: 90_000 },
  async () => {
    // A silent failure here is indistinguishable from a frozen GUI thread, which
    // is the one thing this channel exists to rule out. The path below is a
    // directory, so the open fails for a reason that is not "not yet created".
    const blocker = join(tmpdir(), `dsh-qt-heartbeat-blocked-${process.pid}-${Date.now()}`)
    mkdirSync(blocker)
    const session = launch({ polled: true, label: 'unopenable', heartbeatFile: blocker })
    try {
      await session.waitConnected()
      const reply = await settleWithin(session.host.invoke('host.ping'), 6_000)
      const answer = readPingAnswer(reply)
      assert.ok(answer !== null, `the app did not answer a frame after the heartbeat path failed: ${JSON.stringify(reply)}`)
      assert.equal(answer.state, 'connected', `the transport did not stay connected: ${JSON.stringify(reply)}`)
      const stderr = session.stderr.join('')
      assert.match(
        stderr,
        /heartbeat file .* could not be opened/,
        `the heartbeat failure was silent on stderr: ${JSON.stringify(stderr)}`,
      )
      assert.equal(
        session.child.exitCode,
        null,
        'a heartbeat path problem must never end the process',
      )
      console.log(`# unopenable heartbeat path: reported on stderr, app still connected`)
    } finally {
      await session.stop()
      rmSync(blocker, { recursive: true, force: true })
    }
  },
)

test(
  'the ping answer names the requests the Qt side still owes it',
  { skip: skipReason, timeout: 90_000 },
  async () => {
    // Item B of the review: `pending` used to be read as "the GUI is alive". It
    // is this process's outstanding Qt→Node request count. With the test hooks on,
    // the book travels with the answer, so the two meanings cannot be confused.
    const session = launch({ polled: true, testHooks: true, label: 'pending-book' })
    try {
      await session.waitConnected()
      const reply = await settleWithin(session.host.invoke('host.ping'), 6_000)
      const answer = readPingAnswer(reply)
      assert.ok(answer !== null, `host.ping did not answer with the documented fields: ${JSON.stringify(reply)}`)
      assert.ok(
        answer.details !== null,
        `the test hook did not expose the request book: ${JSON.stringify(reply)}`,
      )
      assert.equal(
        answer.details.length,
        answer.pending,
        `the book holds ${answer.details.length} entries while the count says ${answer.pending}`,
      )
      for (const detail of answer.details) {
        assert.ok(detail.id.length > 0, `a request book entry has no id: ${JSON.stringify(detail)}`)
        assert.ok(
          detail.method.length > 0,
          `a request book entry has no method: ${JSON.stringify(detail)}`,
        )
        assert.ok(
          !detail.method.startsWith('host.'),
          `the Qt-side book contains a request this host issued: ${JSON.stringify(detail)}`,
        )
        assert.ok(detail.ageMs >= 0, `a request book entry has a negative age: ${JSON.stringify(detail)}`)
      }
      // The start-up requests do get answered; once they are, the book empties.
      // That is the assertion the old test tried to make with a bare `pending: 0`
      // in the middle of a blocked read.
      const deadline = Date.now() + 5_000
      let drained = session.sample()
      let settledAnswer = answer
      while (settledAnswer.pending > 0 && Date.now() < deadline) {
        await delay(50)
        const next = readPingAnswer(await settleWithin(session.host.invoke('host.ping'), 6_000))
        if (next !== null) settledAnswer = next
      }
      drained = session.sample()
      assert.equal(
        settledAnswer.pending,
        0,
        `the request book never drained within 5 s: ${JSON.stringify(settledAnswer)}`,
      )
      assert.equal(
        settledAnswer.details?.length ?? -1,
        0,
        `the drained book still lists entries: ${JSON.stringify(settledAnswer)}`,
      )
      console.log(
        `# request book: ${answer.pending} outstanding at the handshake, 0 after settling; ${describeSample(drained)}`,
      )
    } finally {
      await session.stop()
    }
  },
)
