# t95 — Windows stdio blocking the Qt GUI thread: fix and regression

Baseline: `5744512bfa3c570bc07207de7a3d5417ad8ba450` (independent `dsh-qt-app` repo).
Worktree: `/data/qt-phase3/app/wt/t95-win-pipe`, branch `phase3/t95-win-pipe`.
Scope: `native/main.cpp`, `tests/gui-heartbeat.e2e.ts` (new), `.github/workflows/test.yml` (new job), this record.

## 1. The defect (T93-1)

`StdioTransport` read stdin from a 25 ms `QTimer` and called `::_read` directly:

```cpp
// native/main.cpp @ 5744512, Windows branch of start()
pollTimer_ = new QTimer(this);
pollTimer_->setInterval(25);
connect(pollTimer_, &QTimer::timeout, this, &StdioTransport::readAvailable);
pollTimer_->start();

// readAvailable(), Windows branch
got = ::_read(0, chunk, static_cast<unsigned int>(sizeof(chunk)));
if (got < 0) return;
```

On Windows a synchronous `::_read` on an anonymous pipe with no buffered data
**blocks until a byte arrives**. The timer therefore did not poll: the GUI thread
parked inside the first idle read, and with it every `QTimer` in the process —
the 50 ms heartbeat, the 500 ms outbound sweep and the 5 s handshake deadline.
The process stays alive (so a supervisor or the user sees a running
`dsh-qt-app`), no window is painted, and nothing is logged. The POSIX branch
never had this problem: `QSocketNotifier` only fires when the descriptor is
readable, which is exactly why no test caught it.

`main.cpp` even states the invariant it broke, in the class comment:

```
 *   1. **Never block the UI thread.** Reads happen only when the descriptor is
 *      readable; writes are attempted immediately and, if the pipe is full,
 *      handed to a timer instead of spinning or waiting.
```

## 2. The fix (minimal, in `native/main.cpp`)

* **Readiness before read.** `readAvailable()` returns early unless
  `stdinReadiness_()` reports `Ready` (a read cannot block) or `Broken` (the peer
  closed). Windows asks `PeekNamedPipe`; POSIX uses `::poll` with
  `POLLIN|POLLHUP|POLLERR|POLLNVAL`. The handle is classified once at startup with
  `GetFileType`: only `FILE_TYPE_PIPE` gets the peek, because a redirected file or
  a console has no byte count to peek at and a read there returns 0 at EOF rather
  than blocking — those keep the plain read path. `ERROR_BROKEN_PIPE` and
  `ERROR_PIPE_NOT_CONNECTED` mean EOF; **any other** `PeekNamedPipe` failure emits
  `failed("stdin peek failed (error N)")` and stops the transport through the
  existing failure path instead of being swallowed as "nothing to read".
* **Writes never block the GUI thread on either platform.** The queue is the
  single source of truth; `flush_()` on Windows only wakes a dedicated writer
  thread (`writerLoop_`), which performs the blocking `::_write` outside the GUI
  thread, handles partial writes (5 ms backoff) and reports a hard failure back
  through a queued connection. On POSIX `flush_()` writes in place but only after
  `::poll(POLLOUT, 0)` says the descriptor takes bytes, and never more than one
  `PIPE_BUF` per call — a slow reader cannot spin or park the event loop there
  either.
* **Unchanged:** frame order, the 4 MB inbound / 8 MB outbound caps, the
  handshake protocol, the EOF semantics ("a broken pipe is not fatal" for the
  connection, "do not linger as a ghost window" for the window), and the Linux
  read path (`QSocketNotifier` stays the default there; `DSH_QT_STDIO_POLL=1`
  only selects the polled path for tests). **Changed in repair round 3:** the
  drop policy now removes only frames that have not started going out, overflow
  degrades instead of disconnecting, and both caps are counted over one queue —
  see §8.
* **Test instrumentation, not production behaviour.** `startGuiHeartbeat()`
  appends `hb <seq> <elapsedMs> <topLevelWindows> <exposed> <visible>` to
  `DSH_QT_HEARTBEAT_FILE` every 50 ms from the GUI thread, and
  `DSH_QT_STDIO_TEST_LEGACY_READ=1` restores the old `::_read`-per-tick shape so
  the regression can prove it still fails. Both are inert unless the variables
  are set.

## 3. The regression (`tests/gui-heartbeat.e2e.ts`)

`pnpm test` does **not** run this file: its pattern is `tests/*.test.ts` and this
one is `*.e2e.ts` because it needs a built binary. Run it explicitly:

```bash
DSH_QT_APP_BINARY=build/dsh-qt-app pnpm exec tsx --test tests/gui-heartbeat.e2e.ts
```

Seven cases as of the repair round in §7 (three in the first revision).

Real binary, real Node pipe, production `HostBridgeService` + `HostTransport`:

1. **`polled reads: the GUI thread keeps ticking while stdin stays open and silent`** —
   after the handshake nothing is written for 2 s; requires >= 20 ticks, no gap
   above 250 ms, at least one top-level `QWindow`, and one exposed frame.
2. **`the pre-fix read loop parks the GUI thread until a frame arrives`** — same
   run with `DSH_QT_STDIO_TEST_LEGACY_READ=1`: <= 3 ticks over 2.5 s, the process
   still alive, and `host.ping` still answered (`{pending: 0, state: "connected"}`)
   — the pipe works while the GUI thread does not. That combination is the
   defect, not "the process exists".
3. **`closing stdin keeps the GUI ticking and then exits cleanly instead of lingering`** —
   EOF: >= 8 further ticks, then exit code 0 (no ghost window).

Run it (it is `*.e2e.ts`, so `pnpm test` does not pick it up):

```
DSH_QT_APP_BINARY=/tmp/t95-build/dsh-qt-app pnpm exec tsx --test tests/gui-heartbeat.e2e.ts
```

## 4. Evidence collected locally (Linux, this machine)

Build: `cmake -S . -B /tmp/t95-build -DCMAKE_BUILD_TYPE=Release -DDSH_QT_WEBENGINE=OFF` (exit 0),
`cmake --build /tmp/t95-build --parallel 2` (exit 0).

Raw heartbeat probe, 2 s of silence, `QT_QPA_PLATFORM=offscreen`:

| read path | ticks | first / last beat |
| --- | --- | --- |
| `QSocketNotifier` (Linux default) | 26 | `hb 1 638 1 0 1` → `hb 26 1874 1 1 1` |
| polled (`DSH_QT_STDIO_POLL=1`) | 39 | `hb 1 56 1 0 1` → `hb 39 1970 1 1 1` |
| pre-fix shape (`+ DSH_QT_STDIO_TEST_LEGACY_READ=1`) | 0 | — |

Regression runs (`tests/gui-heartbeat.e2e.ts`, four consecutive runs): 3/3 cases
pass each time, exit 0.

Full suite and typecheck (unchanged by this work):

| command | exit | result |
| --- | --- | --- |
| `node scripts/gate.mjs -- pnpm typecheck` | 0 | — |
| `node scripts/gate.mjs -- pnpm test` | 0 | 523 tests, 521 pass, 0 fail, 2 skipped |

## 5. What is *not* verified here

* **No Windows machine or Windows toolchain was available.** The `Q_OS_WIN`
  branches of the fix (`PeekNamedPipe`, the `GetFileType` classification,
  `CancelSynchronousIo`, the writer thread) are **reviewed but neither compiled
  nor executed** here — this host only has a Linux compiler, so even the syntax
  of those branches is unproven locally. The CI job compiles and runs them. The new CI job
  `qt-gui-heartbeat` runs the same test on `windows-2022` and `ubuntu-22.04`; its
  first remote run is the missing evidence, and it has not been observed yet.
* **A pristine `5744512` binary cannot produce this evidence at all** — it has no
  heartbeat channel, so "the original fails" is shown by the
  `DSH_QT_STDIO_TEST_LEGACY_READ=1` fixture, which compiles the exact pre-fix
  read shape into the same binary, plus the pre-instrumentation probe numbers in
  the table above. Anyone reading the red column should read it that way.
* **Exposure vs. a real desktop.** `exposed=1` under `offscreen` proves a window
  was created and exposed by the platform plugin; it is not a screenshot of a
  real desktop. A first-window observation on the user's own Windows machine
  remains separate evidence (set `DSH_QT_EXPECT_NO_DESKTOP=1` only to record that
  gap, never to relax the heartbeat assertions).
* **The user's four-process snapshot is not explained by this record.** PIDs
  3084/4180/5392/7396, all `SessionId 1`, `MainWindowHandle=0`, empty titles,
  `Responding=True`, with none of the three Qt/DSH variables set in the current
  PowerShell session, is *consistent with* "the process is alive and no
  top-level window is mapped", which is what a parked GUI thread looks like. It
  does not identify the cause, `Responding` is not a GUI heartbeat (it is a
  window-message probe that says nothing when there is no window), and the
  origin of four concurrent instances is unproven. The shipped build
  (`43d15d59`) predates the heartbeat instrumentation, so this evidence only
  becomes possible after a build carrying this change.
* **Pre-existing noise, unrelated:** `qrc:/qml/main.qml:375:5: QML
  WebFallbackPanel: Binding loop detected for property "webviewHost"` appears on
  every run, before and after this change.

## 6. Files

| file | change |
| --- | --- |
| `native/main.cpp` | readiness gates (`PeekNamedPipe` / `poll`), Windows writer thread, atomic counters, heartbeat hook, legacy-read test fixture |
| `tests/gui-heartbeat.e2e.ts` | new regression, three cases, real binary + real pipe |
| `.github/workflows/test.yml` | new `qt-gui-heartbeat` job, `ubuntu-22.04` + `windows-2022` |
| `docs/test-records/t95-windows-gui-block.md` | this record |

## 7. Repair round (independent review, round 2)

The first revision fixed the read side but left four holes the review named:
a writer parked in `WriteFile` could hang `stop()` forever, the outbound cap
only saw half the queue, the POSIX writer still handed whole frames to `::write`,
and inbound throughput was one 4 KB read per tick. All four are fixed here, each
with a case that fails on the previous revision.

### 7.1 What changed in `native/main.cpp`

* **One queue, one byte count.** `class OutboundQueue` holds every frame that has
  not been written yet — the ones waiting for the writer and the one the writer
  is chewing on. `send()` drops whole frames from its head until the incoming
  frame fits under `kMaxOutboundBytes`; `queuedFrames()`/`queuedBytes()` report
  the same numbers the cap uses. `stop()` clears the queue and resets the
  overflow flag, so a reconnect starts from zero.
* **Bounded shutdown.** `stop()` sets `stop`, clears the queue, wakes the writer,
  calls `CancelSynchronousIo(writer_.native_handle())` and waits
  `kWriterJoinTimeoutMs` (2 s) on a `std::future`; a writer that still has not
  returned is detached after `orphaned` is set, so the detached thread may only
  touch the shared `WriterState` (held by `shared_ptr`) and never the transport.
* **Never-blocking writes on both platforms.** POSIX `flush_()` takes one frame,
  `poll(POLLOUT, 0)`, then writes at most `kWriteChunkBytes` (4096 = `PIPE_BUF`)
  per call, requeueing the tail on `EAGAIN`; Windows hands the frame to the writer
  thread, which may block but only on its own thread.
* **Read budget.** `readOnce_()` moves up to `kReadBudgetPerTick` (64 KB) per
  tick, looping while the pipe still has data, so a megabyte lands in a few ticks
  instead of ~6 s while the GUI keeps its cadence.
* **Handle classification.** `GetFileType` decides whether stdin is a pipe; a
  non-pipe keeps the plain read. Unexpected `PeekNamedPipe` errors are reported.
* **Heartbeat diagnostics.** A heartbeat file that cannot be opened now prints the
  path and `errorString()` to stderr instead of failing silently — the one failure
  mode that would otherwise look exactly like a frozen GUI thread. The path must be
  unique per instance: two processes appending to one file interleave their `hb`
  lines and the sequence stops meaning anything.
* **Test hooks, inert in production.** `DSH_QT_OUTBOUND_QUEUE_SELFTEST=1` replays
  the queue table and exits; `DSH_QT_TEST_HOOKS=1` adds a `host.echo` method that
  answers with a payload of a requested size, which is how large frames are driven
  in both directions.

### 7.2 Red on the previous revision, green here

Red was taken with the **same test file** against a binary built from the
reviewed revision `4ac11ac` plus *only* the `host.echo` test hook, so the single
difference between the two runs is the transport itself:

```bash
git -C ../base archive 4ac11ac | tar -x -C /tmp/t97-old-hooks   # + the echo hook only
cmake -S /tmp/t97-old-hooks -B /tmp/t97-old-hooks/build -DCMAKE_BUILD_TYPE=Release -DDSH_QT_WEBENGINE=OFF
cmake --build /tmp/t97-old-hooks/build --parallel 2
DSH_QT_APP_BINARY=/tmp/t97-old-hooks/build/dsh-qt-app pnpm exec tsx --test tests/gui-heartbeat.e2e.ts
```

| Case | `4ac11ac` (pre-repair) | this revision |
| --- | --- | --- |
| silent stdin, GUI keeps ticking | pass | pass |
| pre-fix read shape parks the thread | pass | pass |
| EOF keeps ticking, then exits 0 | pass | pass |
| stalled reader + 200 KB reply | **fail** — `the GUI thread stalled while its reader was not draining (0 → 0 beats)` | pass |
| 1 MB inbound frame | **fail** — the app died before the frame landed (`write EPIPE`) | pass, well under 2 s |
| quit while the reader is stalled | **fail** — `the app hung instead of exiting with a stalled reader` (no exit in 5 s) | pass, exit code 0 |
| outbound queue table (no pipe) | **fail** — the selftest entry does not exist there | pass, 13 `ok` lines |

Totals: `4ac11ac` **tests 7 / pass 3 / fail 4**; this revision **tests 7 / pass 7 /
fail 0**.

Queue accounting, no pipe involved:

```bash
DSH_QT_OUTBOUND_QUEUE_SELFTEST=1 build/dsh-qt-app      # 13 ok lines, exit 0
```

The seventh case in `tests/gui-heartbeat.e2e.ts` runs exactly that command and
asserts the whole table is `ok`, so the accounting is covered wherever the
regression runs.

### 7.3 CI entry

`.github/workflows/test.yml` job `qt-gui-heartbeat` runs the same file on
`ubuntu-22.04` and `windows-2022`, requires `pass 7` and `fail 0`, rejects a
skipped run, and records in the job summary whether window exposure was asserted
(a hosted Windows runner has no interactive desktop, so `DSH_QT_EXPECT_NO_DESKTOP=1`
is set there and the summary says exposure was not asserted).

### 7.4 What is still not verified

* **The Windows code paths have not been executed.** This machine is Linux: the
  `PeekNamedPipe`, `CancelSynchronousIo`, writer-thread and `GetFileType` branches
  compile and were reviewed, but no Windows run exists. The `qt-gui-heartbeat` job
  has never run on a hosted runner. Nothing here is a Windows result.
* **Everything above is local simulation on Linux**, with `DSH_QT_STDIO_POLL=1`
  selecting the same read shape Windows uses and `QT_QPA_PLATFORM=offscreen`
  replacing the real desktop. Exposure reported under offscreen is not a
  first-window observation on a real machine.
* **The user's machine is not diagnosed.** A live snapshot showed several
  `dsh-qt-app` processes with `MainWindowHandle=0`; that is consistent with "the
  process is alive but no top-level window is mapped", and it does not distinguish
  this defect from any other cause. The delivered binary (`43d15d59`) has no
  heartbeat channel, so that evidence can only come from a build that includes
  this change.

## 8. Repair round 3 (t98 review items A–H)

Base: `a56529c` on `phase3/t95-win-pipe`. All work below is in `native/main.cpp`,
`tests/gui-heartbeat.e2e.ts` and `.github/workflows/test.yml`; no packaging, no
installer, no delivered artifact was touched.

### 8.1 Overflow degrades instead of disconnecting (A, B, F)

* One queue (`OutboundQueue`) owns the bytes; the old `outbound_` + `pending_`
  pair is gone, so the 8 MB cap now counts **everything** that has not been
  written yet and `queuedFrames()`/`queuedBytes()` read the same source.
* `dropOldestToFit()` skips frames that already started going out (and frames
  pinned by a warning) and removes whole frames only, oldest first. A frame on
  the wire always finishes, so a peer never sees half a line.
* When only started frames are left, the **new** frame is dropped instead of
  tearing the session down. Both paths increment `droppedFrames`, and the
  transport emits one `warn` per episode carrying the **cumulative** count, not
  the per-episode delta: `outbound queue overflow; N frame(s) dropped so far` /
  `outbound queue is full of frames already on the wire; N frame(s) dropped so
  far, new replies are dropped until the peer reads again`.
* Once the queue drains back under a quarter of the cap, `maybeReportDrain_()`
  emits `outbound queue drained; N frame(s) were dropped in total` and re-arms
  the latch, so a second episode reports again and its number is larger than the
  first. The quarter-cap threshold is deliberate: at the limit itself the latch
  would flap and turn the channel into a warning storm.
* `warn` is a separate signal from `failed`: it never reaches a disconnect path.
  `DshQtBridge` turns it into a `transport.warn` event carrying `reason`,
  cumulative `droppedFrames`, `queuedBytes`, `oversizedInbound` and
  `malformedInbound`, sent **uncapped and pinned** so the report of a loss cannot
  itself be the frame the loss drops. A 4 KB control reserve keeps those frames
  inside the same 8 MB budget as everything else.
* `stop()` clears the queue, adds the discarded frames to `droppedFrames` and
  reports them (`dropped N unsent frame(s) while stopping the transport`).
* `rejectProtocol_()` now answers with a nack plus a `transport.warn` instead of
  disconnecting; only a handshake-epoch mismatch stays fatal.
* The regression gained three cases: overflow-survives-and-parses (10 × 1 MB
  replies while the reader is paused), oversized-inbound-resynchronises, and
  stdin-redirected-from-a-file. The existing bounded-exit case now writes raw
  frames and `waitExit()` clears its timer, so a stalled reader cannot leave a
  pending promise behind at file end (that flake hid a real hang once). The overflow case asserts the session stays
  connected, the GUI keeps ticking, every reply that did arrive is a whole
  1 MB frame, `handled + dropped <= 10`, and a later `host.ping` still answers.
  It deliberately does **not** claim all ten requests were answered: replies
  that arrive after the caller's 5 s timeout are timeouts, not answers.

### 8.2 Non-pipe stdin (C, E, R4)

`stdinReadiness_()` classifies the handle once with `GetFileType` and each kind
has its own contract:

| Kind | How readiness is decided | Why it cannot block |
| --- | --- | --- |
| pipe (`FILE_TYPE_PIPE`) | `PeekNamedPipe` byte count | a peek never reads; 0 bytes means "nothing yet" |
| disk file (`FILE_TYPE_DISK`) | `WaitForSingleObject(handle, 0)` | a file is always signalled and `_read` returns 0 at EOF |
| console (`FILE_TYPE_CHAR`) | **refused** — one `transport.warn`, no read | a console is signalled by any input *record*, and its input is not a byte stream: "signalled" does **not** mean a synchronous read returns |
| unknown | **refused** — one `transport.warn`, no read | nothing proves a read cannot block |

`ERROR_BROKEN_PIPE`/`ERROR_PIPE_NOT_CONNECTED` mean EOF; every other peek
failure goes to `failed()` instead of being read as "nothing yet".
`tests/gui-heartbeat.e2e.ts` covers the redirected-file shape on Linux (empty
file as stdin, ≥15 beats, process stays up); the Windows console shape is **not**
executed here — it is now a documented refusal rather than a silent assumption.

### 8.3 Inbound limits (D, G)

`readAvailable()` drains in bounded slices (`kReadBudgetPerTick`, 64 KB per
tick) so a burst cannot starve the GUI thread, and an oversized inbound line is
dropped through the next newline — including when the newline has not arrived
yet (`discardingLine_`), so the tail of a discarded line is never parsed as a
fresh frame. Malformed JSON is dropped with one `transport.warn` instead of
being fatal.

Parsing continues in the same pass (R1): after the oversized line is cut, the
loop keeps going, so frames that arrived **behind** it in the same read are
answered without waiting for the peer to send anything else, and an idle tick
still parses whatever a previous read left buffered.

### 8.4 Red/green evidence (local, Linux)

| Case | Before (`a56529c`) | After |
| --- | --- | --- |
| overflow (10 × 1 MB, reader paused) | disconnect via `fail_`, no warning | stays connected, one `transport.warn` with `droppedFrames >= 1`, GUI keeps ticking |
| oversized inbound (5 MB line, then ping) | tail of the line parsed as a new frame → `malformed frame` | dropped to the next newline, `transport.warn` reports the oversize, ping answers |
| queue selftest | 17 checks | 17 checks, now including started/pinned protection |
| resync: 4 MB line + request in one write (R1) | request never answered until more bytes arrived | answered in the same pass |
| resync: late newline (R1) | answered | answered |
| parser selftest: cap tripped with the newline already buffered (R1) | shape unreachable through a pipe in this test | 8 checks pass in-process, same pass parses the frame behind the line |
| overflow episodes ×2 (R2) | no drain summary at all, so the host cannot tell how much it lost | episode 1 reports `dropped so far`, drain reports the total, episode 2 reports a **larger** cumulative number, `queuedBytes <= 8_388_608`, payload carries `oversizedInbound`/`malformedInbound` |
| full e2e file | 7 cases | 13 cases, all passing |

The "before" column for the R1/R2 rows is measured, not assumed: this exact test
file was run against a binary built from `58b2a5e` in a separate worktree
(`/tmp/t113-base-build/dsh-qt-app`, same CMake flags) and reported
`tests 13 / pass 10 / fail 3` (`/tmp/t113-before13.log`). The three failures are
exactly the cases this round adds or fixes:

| Pre-fix failure | Message |
| --- | --- |
| `two overflow episodes are reported separately and the totals accumulate` | `the drained queue never produced a summary warn` — the pre-fix build has no drain summary, so the host can never learn the cumulative loss |
| `an oversized line is dropped through its newline without losing the frame behind it` | `a valid frame behind an oversized line in the same write was never answered` (t103 R1) |
| `the parser selftest covers the cap-tripped-with-newline-buffered shape deterministically` | the pre-fix binary has no `DSH_QT_INBOUND_RESYNC_SELFTEST` entry, so the selftest run does not produce its report |

The review note that produced this round described the pre-fix outcome as "4 of 5
failing, 1 of 5 passing". That framing did not reproduce: the failures are whole
tests (not sub-checks of five), and the other ten cases pass on the same binary.
The measured numbers above are what this record stands on.

Commands (Linux, this machine):

```
cmake -S . -B /tmp/t95-build -DCMAKE_BUILD_TYPE=Release -DDSH_QT_WEBENGINE=OFF
cmake --build /tmp/t95-build --parallel 2
DSH_QT_APP_BINARY=/tmp/t95-build/dsh-qt-app pnpm exec tsx --test tests/gui-heartbeat.e2e.ts
DSH_QT_OUTBOUND_QUEUE_SELFTEST=1 /tmp/t95-build/dsh-qt-app
node scripts/gate.mjs -- pnpm typecheck
node scripts/gate.mjs -- pnpm test
git diff --check
```

`pnpm test` runs `tests/*.test.ts` only — it does **not** cover
`tests/gui-heartbeat.e2e.ts`, which needs a built binary and is run explicitly
(as above, and in the `qt-gui-heartbeat` CI job).

### 8.5 Still not verified here

* No Windows machine **and no Windows toolchain** was available: the
  `PeekNamedPipe`, `GetFileType`, `CancelSynchronousIo` and writer-thread paths
  are reviewed, not compiled and not executed here. CI compiles and runs them.
* The Windows console (non-pipe) stdin shape has no executed test; the transport
  now refuses it with a warning instead of assuming a read is safe.
* `qt-gui-heartbeat` has not run on a hosted runner yet; the CI job is the entry
  point and asserts `pass 11`, `fail 0`, no skips.
* `QT_QPA_PLATFORM=offscreen` exposes a top-level window here, but that is not a
  visible first window on a user's desktop.
* **The intermittent file-level abort is still unexplained.** Symptom: node:test
  cancels the whole file with `'Promise resolution is still pending but the event
  loop has already resolved'` while individual cases are still running — it is
  not an assertion failure, and re-running the same command turns green. Last
  observed 2026-11-26 ~01:0x +08:00 on this machine under shared load (other
  agents building at the same time), 3 of 10 runs, logs `/tmp/t95-e2e*.log` and
  `/tmp/t108-*.log`. Two real leaks were fixed along the way (`waitExit()` used
  to leave a timer behind; the bounded-exit case used `host.invoke` where the
  host's own bookkeeping could stay pending, now it writes raw NDJSON frames),
  and the current round ran the full file three times on the fixed SHA with
  `0 cancelled / 0 fail` each time — but that is evidence of absence over three
  runs, **not** proof that the root cause is gone. Treat a future abort as this
  known symptom, not as a regression in the transport.
