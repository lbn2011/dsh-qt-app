# t29 — I9 reviewed-candidate CI integration record

Status: **FAILED** (remote Windows/Linux CI red; macOS not validated). This record is append-only evidence
for the t29 attempt; the candidate itself is unchanged.

## 1. Identities

| Object | Value |
| --- | --- |
| app candidate pushed | `2cc080757ac497577aae88ed09f97fd2e0fd9221` (t34 final SHA, t35 review pass) |
| app branch pushed | `dev/phase3-i9` (not force; remote SHA re-read equals the candidate) |
| app remote | `https://github.com/lbn2011/dsh-qt-app.git` |
| addon (dsh-qt-napi) | `87084a6901297a4fe9af997d4b8cdf9d829b0f67` = remote `main` = `package.json` pin |
| test run | https://github.com/lbn2011/dsh-qt-app/actions/runs/45408926248 |
| build run | https://github.com/lbn2011/dsh-qt-app/actions/runs/45408926079 |

Push command (verbatim): `git push origin 2cc080757ac497577aae88ed09f97fd2e0fd9221:refs/heads/dev/phase3-i9`.
The push was a fast-forward branch creation, not a force push. Only the standalone app repository was pushed;
no EAC repository or release was touched.

The worktree keeps two untracked records that belong to other tasks and are **not** part of this candidate:
`docs/test-records/phase-3-results.md`, `docs/test-records/phase-3-results-round2.md`.

## 2. Remote job results (GitHub-hosted runners)

test run `45408926248` (push, 2026-11-24T13:58:12Z):

| Job | Conclusion | Evidence |
| --- | --- | --- |
| napi (ubuntu-22.04) | success | napi build/tests green |
| napi (windows-2022) | success | napi build/tests green |
| typescript (windows-2022) | **failure** | `[gate] spawn-error spawn pnpm ENOENT`, `[gate] exit=127` (job `138497148552`) |
| typescript (macos-14) | **cancelled** | cancelled after ~2 s without executing a step (job `138497148433`); not validated |
| qml tests | success | Qt QML suite green |
| qml lint | **failure** | `xargs: qmllint: exited with status 255; aborting`, step exit 124 (job `138497148856`) |
| packaging (windows-2022) | success | Windows Qt build + package job green |
| packaging (ubuntu-22.04) | **failure** | archive produced and `sha256sum -c` OK; new content-assert step exited 2 (job `138497152250`) |
| qt webengine (ubuntu-22.04) | **failure** | configure printed `DSH_QT_WEBENGINE=ON but Qt6::WebEngineQuick is not installed — embedding disabled`; assertion failed (job `138497148298`) |
| typescript (ubuntu-22.04) | **cancelled** | unit tests emitted 3 failures at 13:58:45Z, then produced no output until the 20-minute job timeout cancelled it at 14:18:35Z (job `138497148599`) |
| napi integration | **cancelled** | same 3 unit-test failures at 14:01:03Z, then no output until cancellation at 14:20:47Z (job `138498573941`, 20-minute timeout) |

build run `45408926079` (same push):

| Job | Conclusion |
| --- | --- |
| napi (ubuntu-22.04) | success |
| napi (windows-2022) | success |
| qt build (ubuntu-22.04) | success |
| qt build (windows-2022) | **failure** — `[gate] spawn-error spawn pnpm ENOENT`, `[gate] exit=127 command=pnpm build` (job `138498293877`) |
| qt build (macos-14) | **cancelled** (~2 s, no step) |

Consequences: there is **no** remote Windows Qt build/package/e2e evidence, **no** remote WebEngine=ON
compile or real Chromium load evidence, and **no** remote external-browser load evidence. The local evidence
in `docs/test-records/t34-repair-round-2.md` stays valid for the same SHA, but it cannot substitute for the
missing remote jobs.

## 3. Findings (blocking for I9)

### T29-1 (high) — packaging content assertion breaks the archive pipeline

- File: `.github/workflows/test.yml`, packaging job step “Assert archive ships LICENSE + notices + SHA-256”.
- Problem: `root=$(tar -tzf "$archive" | head -1 | cut -d/ -f1)` runs under `set -o pipefail`; `head` closes
  the pipe early, `tar` reports `tar: stdout: write error`, the step exits 2 even though the archive and its
  SHA-256 are correct (job `138497152250`, log `/data/qt-phase3/logs/t29-pack-linux-job.log`).
- Required fix: consume the tar listing completely (write it to a file or read the full list) or derive the
  root entry without an early-closing pipe; keep the real exit status. Do not wrap in `|| true` and do not
  make the assertion non-fatal.

### T29-2 (high) — gate runner spawns `pnpm` without Windows executable resolution

- File: `scripts/gate.mjs:23`.
- Problem: `spawn(command[0], command.slice(1), …)` resolves `pnpm` through PATH as a bare name; on Windows
  pnpm is `pnpm.cmd`, so spawn raises `ENOENT` and every gated step exits 127. Failing jobs: typescript
  (windows) `138497148552`, qt build (windows) `138498293877`. This is the pre-existing I-GATE1 defect and it
  removes all Windows evidence from both workflows.
- Required fix: resolve the executable per platform (e.g. `pnpm.cmd` on win32, or `shell: true` only after
  verifying quoting/exit-code semantics) and cover it with positive and negative tests (missing executable,
  non-zero exit propagation, argument quoting). Do not switch to an unconditional `shell: true`.

### T29-3 (high) — QtWebEngine module not detected in the CI Qt installation

- Files: `.github/workflows/test.yml` (qt-webengine job), `CMakeLists.txt:42-43`.
- Problem: the job installs the `qtwebengine` module, yet configure reports
  `DSH_QT_WEBENGINE=ON but Qt6::WebEngineQuick is not installed — embedding disabled`
  (log `/data/qt-phase3/logs/t29-webengine-job.log`). `find_package(Qt6 QUIET OPTIONAL_COMPONENTS
  WebEngineQuick)` hides the reason. Hypothesis (unconfirmed): a missing transitive module
  (`qtwebchannel`/`qtpositioning`) makes the QUIET package lookup fail.
- Required fix: reproduce with a non-QUIET `find_package` diagnostic to identify the missing module; install
  the complete required module set (or fix the lookup); keep the compile-time assertion
  `-DDSH_QT_HAS_WEBENGINE=1`. Do not drop the assertion or silently accept OFF.

### T29-4 (medium) — qmllint gate fails on the CI Qt version

- File: `.github/workflows/test.yml`, qml-lint job (`find qml -name '*.qml' -print0 | xargs -0 -r qmllint`).
- Problem: Qt 6.7.3 `qmllint` exits 255 on at least one file, so xargs aborts and the step exits 124. The same
  tree passes `qmllint` with the local Qt 6.8.2 (exit 0, only pre-existing warnings). Exit 124 here is the
  xargs abort status, not a timeout.
- Required fix: locate the exact file/diagnostic (run `qmllint` per file, capture stderr/exit codes), decide
  whether it is a real QML error or a version-specific checker bug, and fix the QML or pin the checker
  behaviour explicitly. Keep the lint gate; do not globally disable warnings.

### T29-5 (high) — unit suite is not hermetic on CI: fails on host-dependent WebUI tests, then hangs until the job timeout

- Files: `tests/webui-default-off.test.ts:160,169,239`; `src/webui/service.ts:325`.
- Problem: on GitHub runners the unit step executed 466 tests successfully and then failed 3 WebUI tests:
  - `not ok 467 - default off: mounting the fallback binds nothing and spawns nothing` —
    `mounting must not spawn a host process`, actual child pid `[2772]` (the test asserts an absolute
    empty child list instead of comparing with the pre-test snapshot);
  - `not ok 468 - open() binds one loopback listener…` — `webui: no host module root configured (set
    DSH_HOST_ROOT to the installed dsh node_modules)`;
  - `not ok 469 - the child fallback…` — `webui: could not start dsh: spawn dsh ENOENT`.
  After those failures the step printed nothing for ~20 minutes and was cancelled by the job
  `timeout-minutes: 20`. The suite is green locally only because this machine has the host installed and its
  test process has no extra child at mount time.
- Required fix: make the unit suite hermetic — compare child processes before/after instead of asserting an
  absolute empty list; skip or provision the host-dependent in-process/child cases when `DSH_HOST_ROOT` and
  `dsh` are unavailable; ensure a failed `open()` still settles all timers/handles so the test process exits.
  If CI must cover the real in-process backend, install/pin the host in the workflow and pass
  `DSH_HOST_ROOT`; do not raise the job timeout to hide a hang.

### T29-6 (medium) — build workflow run reports `cancelled` overall

- The `build` run `45408926079` completed with conclusion `cancelled` while four jobs are `success` and the
  Windows Qt job failed. The overall run status therefore cannot be used as a green signal. Cause not
  established within this task; when the repair round re-runs CI, record the run-level conclusion explicitly
  and investigate any cancellation that is not the known macOS pool gap.

## 4. What passed

- Both NAPI jobs (ubuntu/windows) and the Windows packaging job succeeded.
- Linux Qt build succeeded.
- The Linux packaging job produced both TGZ/ZIP archives and the sibling SHA-256 verified with
  `sha256sum -c` before the content-assert step failed.
- The local SHA evidence (t34/t35) remains valid: WebEngine=ON build, real Chromium load/close, real external
  browser via isolated profile + Xvfb, real CPack archive content checks, OFF fallback.

## 5. Boundaries

- macOS is **not validated**: both macOS jobs were cancelled before running steps.
- Windows has no Qt build/package/e2e evidence due to T29-2.
- No release, deployment, or force push was performed. Nothing was merged into EAC.
- CI was observed through managed job ids; no repeated polling was used for this record.