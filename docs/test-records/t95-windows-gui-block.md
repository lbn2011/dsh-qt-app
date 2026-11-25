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
  `stdinReadable_()` says the descriptor has data or has reached EOF/error.
  Windows uses `PeekNamedPipe`; POSIX uses `::poll` with `POLLIN|POLLHUP|POLLERR|POLLNVAL`.
  A `PeekNamedPipe` failure is treated as EOF only for `ERROR_BROKEN_PIPE`, so a
  real error still reaches the existing failure path.
* **Writes never block the GUI thread on Windows.** `flush_()` moves the queued
  frames into a `pending_` deque and wakes a dedicated writer thread
  (`writerLoop_`), which performs the blocking `::_write` outside the GUI
  thread, handles partial writes (5 ms backoff) and reports a hard failure back
  through a queued connection. The POSIX branch gained a `POLLOUT` gate with
  `::poll(..., 0)`, so a slow reader cannot spin the event loop there either.
* **Unchanged:** frame order, the 4 MB inbound / 8 MB outbound caps and the
  oldest-first drop policy, the handshake protocol, the EOF semantics ("a broken
  pipe is not fatal" for the connection, "do not linger as a ghost window" for
  the window), and the Linux read path (`QSocketNotifier` stays the default
  there; `DSH_QT_STDIO_POLL=1` only selects the polled path for tests).
* **Test instrumentation, not production behaviour.** `startGuiHeartbeat()`
  appends `hb <seq> <elapsedMs> <topLevelWindows> <exposed> <visible>` to
  `DSH_QT_HEARTBEAT_FILE` every 50 ms from the GUI thread, and
  `DSH_QT_STDIO_TEST_LEGACY_READ=1` restores the old `::_read`-per-tick shape so
  the regression can prove it still fails. Both are inert unless the variables
  are set.

## 3. The regression (`tests/gui-heartbeat.e2e.ts`)

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

* **No Windows machine was available.** The Windows branch of the fix
  (`PeekNamedPipe`, the writer thread) has been compiled and reviewed on Linux
  only; `Q_OS_WIN` code paths were not executed locally. The new CI job
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
