# t45 — the remaining failures of the hosted test run

Baseline: `78d9d84748af5b0b7bf9318a1342499766ed215e` (reviewed by t43), worktree
`/data/qt-phase3/app/wt/ci-hosted-fix`, branch `phase3/ci-hosted-fix`.
Evidence: the hosted run `45422765444` logs collected by t44
(`/data/qt-phase3/logs/t44-*.log`) and the t44 record
`docs/test-records/t44-ci-revalidation.md` (commit `0812263`).

Every group below lists the first error exactly as the runner printed it, the
root cause established by experiment, and the change that removes it. Nothing was
made to pass by weakening an assertion: the failure/skip/cancel paths are kept and
are expected to stay reachable.

Local tool versions: Node 26.13.1 (default) and Node 22.19.0 (via
`npx -y node@22.19.0`), pnpm 12.16.1, actionlint 1.7.7, Linux x86_64 with system
Qt 6.8.x. All heavy commands ran under `flock /data/qt-phase3/verify.lock
systemd-run --scope -p CPUQuota=200% -p MemoryMax=4G`.

## Group A — `tests/host-launcher.test.ts` (8 tests, all three Linux/Windows jobs)

First error (typescript ubuntu, `tests/host-launcher.test.ts:189`):

```
not ok 68 - a timed-out request rejects; its late reply is dropped by id
  failureType: 'cancelledByParent'
  error: 'Promise resolution is still pending but the event loop has already resolved'
  code: 'ERR_TEST_FAILURE'
```

The same 8 tests (68–75) were cancelled in `typescript (windows-2022)` and in the
`napi integration` job, with `# fail 0` and `# cancelled 8` in the summary — so the
job failed while no test reported a failed assertion.

**Root cause.** `HostBridgeService.invoke()` created the request deadline with
`setTimeout(...)` and then called `timer.unref()` on it. That timer is the only
thing that settles the caller's promise, so with a silent host and no other active
handle the loop drained and Node exited with the message above; `node:test` then
cancelled every remaining test in the file.

Reproduced exactly, and the difference is the Node version only:

| command | Node 22.19.0 | Node 26.13.1 |
| --- | --- | --- |
| `tsx --test tests/host-launcher.test.ts` before the fix | `# pass 2 / # cancelled 8`, exit 1 | 10/10 pass |
| same command after the fix | `# pass 10 / # cancelled 0`, exit 0 | 10/10 pass |

**Fix.** `src/host/bridge-service.ts` — the request timer is no longer unref'd, with
a comment stating why. `settle_()` and `dispose()` still `clearTimeout()` it, so a
connected host does not keep the process alive after every reply. The handshake
watchdog keeps its `unref()`: it is a liveness check, not a promise settlement, and
the state machine reports `unavailable` on its own.

**Regression test.** `tests/host-request-timeout.test.ts` runs
`tests/fixtures/pending-request.ts` as a bare child process (the test runner holds
the loop open itself, so an in-process assertion would pass either way), which
completes the handshake on an in-memory pipe pair and then leaves one request with
a 50 ms deadline against a host that never answers. It asserts exit code 0 and
`settled:timeout`.

Sensitivity (the check that the test would have caught the bug): with
`timer.unref()` temporarily restored, Node 22.19.0 reports

```
not ok 1 - a pending request keeps the event loop alive until its timeout settles it
  error: 'the request never settled; stdout=""'
```

and exit 1; with the fix it passes on both Node versions. Logs:
`t45-regression-first.log`, `t45-regression-sensitivity.log`.

## Group B — `webui real host`: green tests, red gate

First error (job `webui real host (pinned dsh host)`):

```
Run grep -q '^ℹ skipped 0$' webui-real-host.log
##[error]Process completed with exit code 1
```

while the suite itself reported `# tests 3 / # pass 3 / # fail 0 / # skipped 0`.

**Root cause.** Two independent defects in the step, not in the tests:

1. Node prints the spec summary (`ℹ skipped 0`) only when stdout is a TTY. The step
   pipes through `tee`, so the log carries the TAP summary (`# skipped 0`) and the
   pattern could never match.
2. `... | tee webui-real-host.log` without `pipefail` reports `tee`'s status, so a
   genuinely failing suite would have exited 0 — a false green in the other
   direction.

**Fix** (`.github/workflows/test.yml`, job `webui real host`):
`Real host WebUI tests` now runs under `set -euo pipefail` and tees `2>&1`;
`Fail if a host test was skipped` accepts either summary form and requires all of
`pass 3`, `fail 0`, `skipped 0`, printing the log on mismatch. Requiring the pass
count is what keeps an empty or truncated log from reading as success, so the "zero
skips" gate is stricter than before, not looser. The tests themselves are
untouched.

## Group C — `qt webengine`: the module was never usable

First error (job `qt webengine (ubuntu-22.04)`):

```
##[error]CMake did not enable Qt WebEngine — the module is missing
```

preceded by

```
-- dsh-qt-app: DSH_QT_WEBENGINE=ON but Qt6::WebEngineQuick is not installed — embedding disabled
-- dsh-qt-app:   Qt6_DIR=/home/runner/work/dsh-qt-app/Qt/6.7.3/gcc_64/lib/cmake/Qt6
-- dsh-qt-app:   Qt6::WebChannelQuick is missing; WebEngineQuick links it. Install the qtwebchannel module as well as qtwebengine.
```

**Root cause.** Not the probe. `find_package(Qt6 QUIET OPTIONAL_COMPONENTS
WebEngineQuick)` (CMakeLists.txt:42) is correct: configured locally against a Qt
tree that has the packages, it prints `dsh-qt-app: Qt WebEngine embedding enabled`
both with and without an explicit `-DQt6_DIR`. The hosted tree was incomplete:
`aqt` installs only the archives named in `modules`, and the official 6.7.3
metadata makes `qt.qt6.673.addons.qtwebengine` depend on `qtpositioning` and
`qtwebchannel`. `Qt6WebEngineQuickDependencies` calls `find_dependency(Positioning)`,
that fails, and the optional component disappears silently — the earlier
`qtwebengine qtwebchannel` list (T29-3) still missed `qtpositioning` (T44-3).

**Fix** (`.github/workflows/test.yml`, job `qt webengine`):
`modules: qtwebengine qtwebchannel qtpositioning`, plus a new step
`Assert the WebEngine CMake packages are installed` that requires
`$QT_ROOT_DIR/lib/cmake/{Qt6WebEngineQuick,Qt6WebChannelQuick,Qt6Positioning}` and
fails with the missing path (and a directory listing) before configuring. The
`DSH_QT_WEBENGINE=ON` assertion, the real Chromium load/close e2e and the
external-browser e2e are unchanged — the branch must still compile and actually run
Chromium.

## Group D — Windows portability (3 independent defects)

1. `not ok 1 - check-archive accepts a real archive with license material`
   (`tests/archive.test.ts:32`) — `tar (child): Cannot connect to C: resolve
   failed` / `tar: Child returned status 128`, `2 !== 0`. **Root cause:** the test
   handed an absolute `C:\...` path to GNU tar, which reads `C:` as a remote host.
   `scripts/check-archive.sh` did the same with its `tar -tzf "$archive"`.
   **Fix:** the test builds the archive with `cwd` + a relative file name, and the
   script lists it as `(cd "$archive_dir" && tar -tzf "$archive_name" ...)`. The
   archive itself, the required-entry checks and the SHA-256 check are unchanged.
2. `not ok 9 - resolveExecutable searches PATH with an injectable filesystem`
   (`tests/gate-lib.test.ts:52`) — expected `/opt/tools/pnpm`, got `null`.
   **Root cause:** the test hard-coded POSIX directories while the resolver joins
   with the host's `path.join`, so on Windows the candidate became
   `\opt\tools\pnpm` and never matched the injected set.
   **Fix:** the fixture derives both PATH entries and the expected result from
   `tmpdir()` and the host platform (the command carries `.cmd` on Windows so
   PATHEXT expansion stays out of the way). `scripts/gate-lib.mjs` is unchanged: the
   host-flavoured join is the correct production behaviour, since real PATH entries
   are host paths and the `platform` argument governs only the PATH separator and
   PATHEXT expansion. (An earlier attempt made the join follow the injected platform
   and broke the win32-simulation test at `tests/gate-lib.test.ts:74` — that test
   simulates win32 on Linux with `/` paths, which is exactly the behaviour the
   host-flavoured join provides.)
3. `tests/webui-default-off.test.ts` read `/proc/net/tcp` on Windows, so the suite
   died with `ENOENT` before any platform guard ran. **Fix:** a `procSkip` reason
   (`existsSync('/proc/net/tcp')`) guards the three listener-ownership tests. On
   Linux nothing changes — the default-off assertions still run and still assert
   that nothing listens; on platforms without `/proc` the tests skip with a stated
   reason instead of failing.

## Preserved negatives (deliberately still reachable)

- `tests/host-launcher.test.ts` still fails if a pending request stops settling —
  the new regression test is what pins that, and it goes red when the `unref` is
  restored.
- The two `realHostSkip` cases in `tests/webui-default-off.test.ts` still skip
  without `DSH_HOST_ROOT`, and the CI job still requires `skipped 0` where the host
  is installed.
- The two CMake-dependent packaging tests still skip without a build tree (4 skips
  on the hosted ubuntu job: those two plus the two real-host ones) — unchanged.
- The `qt webengine` job still fails when the WebEngine branch does not compile.

## Verification run here (Linux only)

| command | result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm test` (Node 26.13.1) | `# tests 500 / # pass 498 / # fail 0 / # cancelled 0 / # skipped 2`, exit 0 |
| `npx -y node@22.19.0 --import tsx --test --test-timeout=120000 tests/*.test.ts` | `# tests 500 / # pass 498 / # fail 0 / # cancelled 0 / # skipped 2`, exit 0 |
| `pnpm exec tsx --test tests/archive.test.ts tests/gate-lib.test.ts` | 12/12 pass, exit 0 |
| `git diff --check` | exit 0 |
| `actionlint -oneline .github/workflows/test.yml` | exit 0, no output |

Logs: `/data/qt-phase3/logs/t45-fullsuite.log`, `t45-archive-gatelib2.log`,
`t45-regression-first.log`, `t45-regression-sensitivity.log`.

## Still needs a hosted run (not claimed here)

- `qtpositioning` really resolving `Qt6WebEngineQuick` on the runner, the WebEngine
  branch compiling, and the real Chromium load/close + external-browser e2e passing.
- Windows: `check-archive` with a drive-letter path, the portable `resolveExecutable`
  fixture, and `procSkip` skipping cleanly instead of erroring.
- `webui real host`: the new summary assertion against the TAP output the runner
  actually produces.
- macOS: nothing was verified. The `typescript (macos-14)` job was cancelled at
  15:12:20Z without starting a step (t44's T44-5), which is a run-level artefact of
  fail-fast, not evidence either way. The `procSkip` guard makes the `/proc` tests
  skip there with a reason instead of erroring, but no macOS run backs that up.
