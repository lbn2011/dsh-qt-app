# T48 — Windows packaging checksum name and the WebEngine job order

Baseline: `353848b` (`docs: record the t47 remote CI revalidation`), which is
`55a0e9d` (`fix(test): settle request timeouts and repair the hosted-run gates`)
plus the t47 record. Worktree `/data/qt-phase3/app/wt/ci-packaging-fix`, branch
`phase3/ci-packaging-fix`. Independent app repository only — nothing was pushed
and the t44/t47 worktree at `353848b` was left untouched.

Run under repair: **45428635227** (`test`) / 45428635641 (`build`), `event=push`,
`headSha=353848b…`, created 2026-11-24T15:42:35Z. The t45 repairs held: 10 of 12
jobs passed (`napi` ubuntu/windows, `napi integration`, `packaging`
ubuntu/windows, `qml lint`, `qml tests`, `typescript` ubuntu, `webui real host`).
Two jobs failed, and they are the two failures this record repairs:

| job | id | result |
| --- | --- | --- |
| `typescript (windows-2022)` | 138567465428 | failure |
| `qt webengine (ubuntu-22.04)` | 138567465006 | failure |
| `typescript (macos-14)` | 138567465297 | cancelled 15:42:36→15:42:37 (no steps ran) |

Raw logs: `/data/qt-phase3/logs/t47-job-138567465428.log`,
`/data/qt-phase3/logs/t47-job-138567465006.log`,
`/data/qt-phase3/logs/t47-test-jobs.tsv`.

## T48-1 — Windows: the checksum name check split on `/` only

First error, verbatim from `t47-job-138567465428.log:1425-1449`:

```
not ok 201 - a checksum that does not describe the archive is rejected
  location: 'D:\a\dsh-qt-app\dsh-qt-app\tests\packaging.test.ts:153:1'
  failureType: 'testCodeFailure'
  error: The input did not match the regular expression /SHA-256 does not describe the archive bytes/u. Input:
  'AssertionError [ERR_ASSERTION]: checksum file names a different archive\n' +
    '+ actual - expected\n' +
    "+ 'bad.tar.gz'\n" +
    "- 'C:\\\\Users\\\\RUNNER~1\\\\AppData\\\\Local\\\\Temp\\\\dsh-qt-badsum-XousvQ\\\\bad.tar.gz'\n"
  stack: readChecksumFile (tests\packaging.test.ts:88:10)
         verifyChecksum (tests\packaging.test.ts:93:53)
```

The test itself is correct: it writes `0000…  bad.tar.gz` next to the archive and
expects `verifyChecksum` to reject the checksum. It failed one level earlier,
inside `readChecksumFile`, because that helper derived the expected file name
with `archive.split('/').pop()`. A Windows absolute path (`C:\Users\…\bad.tar.gz`)
contains no `/`, so the "file name" became the whole path and the helper threw
`checksum file names a different archive` — a different assertion message than
the one the test asserts on. Only one test failed in that job; the rest of the
suite (481 pass) was unaffected, and `grep -n "split('/')"` over `tests/`,
`src/` and `scripts/` shows this was the only such split.

Change (`tests/packaging.test.ts`): a `fileName()` helper that cuts on the last
of either separator, whatever host it runs on, and the original assertion is
kept verbatim apart from calling it:

```ts
function fileName(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return cut === -1 ? filePath : filePath.slice(cut + 1)
}

assert.equal(match[2], fileName(archive), 'checksum file names a different archive')
```

Before/after, using the exact path from the CI failure:

```
path      : C:\Users\RUNNER~1\AppData\Local\Temp\dsh-qt-badsum-XousvQ\bad.tar.gz
old (split /).pop() -> "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\dsh-qt-badsum-XousvQ\\bad.tar.gz"
new fileName()      -> "bad.tar.gz"
posix path new      -> "bad.tar.gz"
```

A regression test that runs on every host pins both separator styles, so the
Windows behaviour is covered on Linux CI too:

```
✔ the checksum name check understands Windows and POSIX paths (0.18273ms)
✔ a checksum that does not describe the archive is rejected (4.519238ms)
✔ an archive missing the notices is rejected (18.89614ms)
```

The packaging assertions themselves (LICENSE + notices at the archive root, one
TGZ per CPack run, SHA-256 over the archive bytes) are unchanged.

## T48-2 — WebEngine job: the binary was asserted before it was built

First error, verbatim from `t47-job-138567465006.log:1148-1180`: the step
`Assert the WebEngine branch is compiled in` ran `set -euo pipefail`, printed the
matching `flags.make` line and then failed on its last command:

```
CXX_DEFINES = -DDSH_QT_HAS_WEBENGINE=1 … -DQT_WEBENGINECORE_LIB -DQT_WEBENGINEQUICK_LIB
##[error]Process completed with exit code 1.       (15:44:18.93)
```

`test -x build-webengine/dsh-qt-app` was the failing command: the executable is
produced by the *next* step (`Build: cmake --build build-webengine --parallel 2`),
so the assertion could never pass. Everything after it — `Install Chrome` and
`Real Chromium auth load/close and external browser e2e` — never ran, which is
why the run had no real-Chromium evidence at all.

The same log shows the t45 module repair worked: the configure output already
carried `-- dsh-qt-app: Qt WebEngine embedding enabled` and the preflight
`Assert the WebEngine CMake packages are installed` passed with
`qtwebengine qtwebchannel qtpositioning`.

Change (`.github/workflows/test.yml`, job `qt-webengine`):

* `Assert the WebEngine branch is compiled in` keeps the two assertions that only
  need the configure output (the `embedding enabled` line and
  `-DDSH_QT_HAS_WEBENGINE=1` in `flags.make`) and no longer touches the binary.
* New step after `Build`: `Assert the built binary links Qt WebEngine` —
  `test -x build-webengine/dsh-qt-app` plus an `ldd` check for
  `libQt6WebEngineQuick`, printing the number of WebEngine libraries linked.
* `Real Chromium auth load/close and external browser e2e` now runs under
  `set -euo pipefail` and tees to `webengine-e2e.log`, so a failure both fails the
  step and leaves its output; `Upload WebEngine e2e output` uploads both logs.

Step order after the change (15 steps, extracted from the file):

```
 5. Install Qt with the WebEngine module      (modules: qtwebengine qtwebchannel qtpositioning)
 8. Assert the WebEngine CMake packages are installed
 9. Configure with WebEngine ON               -> configure-webengine.log
10. Assert the WebEngine branch is compiled in   (configure output only)
11. Build                                     -> build-webengine/dsh-qt-app
12. Assert the built binary links Qt WebEngine   (test -x + ldd)
13. Install Chrome for the external-browser e2e
14. Real Chromium auth load/close and external browser e2e  (DSH_QT_APP_BINARY -> the step-11 binary)
15. Upload WebEngine e2e output
```

Local replay of that order on the same repository (system Qt 6, `chromium` as the
external browser; log `/data/qt-phase3/logs/t48-webengine-order.log`):

```
configure_rc=0
== 2a. OLD assertion (test -x at configure time) ==
old_assert_rc=1 (expect 1: binary not built yet; grep lines above passed)
== 2b. NEW configure-time assertion (no binary check) ==
new_configure_assert_rc=0 (expect 0)
== 3. Build ==
[100%] Built target dsh-qt-app
build_rc=0
== 4. NEW post-build assertion ==
webengine libraries linked: 2
new_postbuild_assert_rc=0 (expect 0)
```

The old ordering fails and the new one passes on the same tree, and the real
Chromium e2e then runs against that binary
(`/data/qt-phase3/logs/t48-webengine-e2e.log`):

```
✔ WebEngine: open → token → real Chromium load → marker/title → close reaches about:blank (1341.047805ms)
✔ external browser: QDesktopServices → xdg-open → real Chromium runs the page JS marker, then cleans up (2882.942469ms)
ℹ tests 2 / pass 2 / fail 0 / cancelled 0 / skipped 0
e2e_rc=0
```

Failure propagation of the new assertion, checked by pointing it at a binary
without WebEngine:

```
== negative: ldd assert on a non-WebEngine binary ==
::error::the built binary does not link Qt6WebEngineQuick
	libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6
negative_rc=1 (expect 1)
```

## Verification (this machine, Linux)

All commands ran inside `flock /data/qt-phase3/logs/verify.lock` +
`systemd-run --scope -p CPUQuota=200% -p MemoryMax=4G`, one at a time.

| command | result | log |
| --- | --- | --- |
| `pnpm typecheck` | `$ tsc -p tsconfig.test.json`, exit 0 | — |
| `pnpm exec tsx --test tests/packaging.test.ts` | 6 tests, 4 pass, 2 skipped (CPack needs a `build/` tree; CI's packaging job configures one), 0 fail | `t48-packaging-node26.log` |
| `pnpm test` (Node 26.13.1) | 501 tests, 499 pass, 0 fail, 0 cancelled, 2 skipped, exit 0 | `t48-full-node26.log` |
| `npx -y node@22.19.0 --import tsx --test … tests/*.test.ts` | 501 tests, 499 pass, 0 fail, 0 cancelled, 2 skipped, exit 0 | `t48-full-node22.log` |
| `cmake -S . -B build-webengine -DDSH_QT_WEBENGINE=ON` + build | configure 0, build 0, binary links 2 WebEngine libraries | `t48-webengine-order.log` |
| `pnpm exec tsx --test tests/webengine-chromium.e2e.ts` | 2/2 pass with real Chromium | `t48-webengine-e2e.log` |
| `actionlint -oneline .github/workflows/test.yml` (1.7.7) | exit 0, no findings | — |
| `git diff --check` / `git show --check HEAD` | exit 0 | — |

The two local skips are the pre-existing CPack checks
(`no CPack config; configure the CMake build first`) and
`installed DSH host not prepared` in the WebUI suite; neither is skipped in the
CI jobs that provide those prerequisites.

## Preserved negatives

* The checksum rejection test still asserts the rejection and its message; the
  Windows-shaped name is now an extra case, not a replacement.
* The WebEngine job still fails when CMake does not enable the module, when the
  target lacks `-DDSH_QT_HAS_WEBENGINE=1`, and now also when the built binary does
  not link `libQt6WebEngineQuick`.
* The real-Chromium e2e keeps both halves (embedded load/close and the external
  browser dispatch) and is not skipped or narrowed.

## Still needs a hosted run

* `typescript (windows-2022)`: the `fileName` fix is only exercised through the
  injected Windows-shaped string locally; the real Windows temp path must pass on
  the runner.
* `qt webengine (ubuntu-22.04)`: qtpositioning resolution, the configure-time
  assertions, the new binary/`ldd` assertion and the real Chromium e2e with
  `google-chrome` have not run on the runner yet.
* `typescript (macos-14)` is still cancelled before any step; there is no macOS
  evidence in this run and none is claimed.
