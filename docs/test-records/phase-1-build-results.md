# Phase 1 — build & test results (GitHub Actions)

Recorded 2026-11-22. This is the evidence record for Phase 1 (project skeleton, Cordis
plugin entry, event-loop bridge, QML structure): what was pushed, where CI ran, what each
platform reported, and which failures were found and fixed.

## 1. What was pushed

The `dsh-qt-app/` subtree of the development checkout was published to the fork with
`git subtree split`, so the fork holds the Qt profile as its own repository root.

| Item | Value |
| --- | --- |
| Repository | `lbn2011/dsh-qt-app` (public fork) |
| Branch | `dev/phase-1` |
| Source commit (monorepo) | `8cf9eec24b730f22c0cac66dd8a11a08483714d8` |
| Split commit (fork) | `c6124513451e39c4fc109eb2214b95af3be80951` |
| Push mode | new branch, fast-forward only, **no force push** |

Commands used (from the monorepo root):

```bash
git add dsh-qt-app
git commit -m "feat(dsh-qt-app): Phase 1a-1d …"
git subtree split --prefix=dsh-qt-app -b dsh-qt-app-split5
git push fork dsh-qt-app-split5:dev/phase-1
```

Secret scan before every push: the staged diff was grepped for `ghp_`, `github_pat_`,
`AKIA`, `PRIVATE KEY`, `npm_`, `sk-`, `client_secret`, `refresh_token` — no matches.
`pnpm-lock.yaml` contains no absolute registry URLs, and no `.env`, keystore, or token file
is tracked (`git ls-files` covers 38 files, all under `dsh-qt-app/`).

## 2. Workflows

| Workflow | Jobs | Trigger |
| --- | --- | --- |
| `.github/workflows/build.yml` | `qt6 (ubuntu-22.04)`, `qt6 (windows-2022)`, `qt6 (macos-14)` | push to `main`/`dev/**`, PR, manual |
| `.github/workflows/test.yml` | `typescript (3 OS)`, `qml lint`, `qml tests` | same |

Toolchain in CI: Qt 6.7.3 (`jurplel/install-qt-action@v4`, cache hit), Node 22.19.0,
pnpm from the `packageManager` field via `pnpm/action-setup@v4`, install with
`--frozen-lockfile`. QML tests run headless with `QT_QPA_PLATFORM=offscreen` and
`qmltestrunner -input tests/qml -import qml`.

## 3. Results of the validation runs

Validation commit `c612451` (source `8cf9eec`):

* build — <https://github.com/lbn2011/dsh-qt-app/actions/runs/45020385315>
* test — <https://github.com/lbn2011/dsh-qt-app/actions/runs/45020385325>

| Platform | build.yml | test.yml |
| --- | --- | --- |
| ubuntu-22.04 | **success** (17 steps) | **success** — typescript 11 steps, qml lint 8 steps, qml tests 8 steps |
| windows-2022 | **success** (17 steps) | **success** — typescript 11 steps |
| macos-14 | **cancelled** (0 steps) | **cancelled** (0 steps) |

Test counts: 36 TypeScript unit tests (`node --test` via `tsx`), 24 QML tests
(`qmltestrunner`), 0 qmllint warnings.

Build artifacts (ubuntu/windows): `dsh-qt-app-Linux-X64` (18 448 bytes),
`dsh-qt-app-Windows-X64` (57 118 bytes) — a Qt-linked executable plus the QML resource
bundle, staged into `dist/` and uploaded with `actions/upload-artifact@v4`.

## 4. macOS — blocker

The macOS matrix entry does not run in this environment. The job is cancelled about one
second after it is created, before its first step:

```text
gh api repos/lbn2011/dsh-qt-app/check-runs/<id>/annotations
→ The configuration 'macos-14-arm64-us-default' is not supported
```

Job metadata: `conclusion=cancelled`, `steps=0`, `runner_name=""`. Switching the matrix to
`macos-13` (x86_64) does not help either — both macOS jobs then stay `queued` indefinitely
with no runner assigned (runs 45020651538 / 45020651666), which is worse because the whole
run never reaches a conclusion. The matrix therefore keeps `macos-14`, where the failure is
immediate and self-documenting.

**Status: macOS is unvalidated.** The workflow definition itself is correct (same steps as
the Linux job plus `brew`-free Qt installation via `install-qt-action`); it needs a runner
that supports macOS before it can turn green. This must be re-run before Phase 1 is
declared complete on macOS.

## 5. Failures found and fixed during the phase

Four red→green iterations were needed. All fixes are in the pushed history.

| # | Symptom | Root cause | Fix |
| --- | --- | --- | --- |
| 1 | `qml lint` failed: `xargs: qmllint: exited with status 255; aborting`, 9 × `Unqualified access [unqualified]` in `qml/views/SessionSidebar.qml` | delegate referenced outer ids without bound component context; `qmllint` exits non-zero on *warnings* | added `pragma ComponentBehavior: Bound` to the file |
| 2 | `typescript (windows-2022)` failed 35/36: `discoverCandidates() is ordered explicit -> env -> package -> local build` | the loader builds candidates with `path.join`, so expectations differ by separator | test expectations built with `path.join('/repo', …)` instead of hard-coded `/` |
| 3 | `qml tests` failed: empty-state assertion, `messageCount=2` while the model had 0 rows | `ListView.count` updates across a `ListModel` reset **without** emitting `countChanged`, so bindings never re-evaluate | `messageCount` now derives from the model (`messageModel.count`) |
| 4 | `qml tests` still failed: `empty.visible=false` with `messageCount=0` | `Item.visible` propagates from the parent, and `qmltestrunner` keeps its window hidden (`testCase.visible=false`), so every descendant reports `visible=false` — the assertion target was invalid | `ChatView` exposes `showEmptyState`, `EmptyState.visible` binds to it, the test asserts the flag |

## 6. Local resource limits

The development box has no Qt toolchain and must not compile C++ or run heavy suites
(a previous run saturated the CPU and the host was rebooted). Therefore:

* **No local Qt/C++ build, no local `qmllint`/`qmltestrunner`.** All Qt compilation and all
  QML validation happen on GitHub Actions only.
* Local verification is limited to the Node/pnpm side and light shell commands, executed
  under a CPU/memory cap: `systemd-run -u … -p CPUQuota=200% -p MemoryMax=4G` (or `nice`).
* Local evidence used: `pnpm -C dsh-qt-app build`, `pnpm -C dsh-qt-app typecheck`,
  `pnpm -C dsh-qt-app test` (36/36), `node -e "require('./dsh-qt-app/lib/index.js')"`.
* CI runners are standard GitHub-hosted runners (2-core for ubuntu/windows); no self-hosted
  or large runners were used.

## 7. Reproducing

```bash
# locally (Node side only)
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test

# on CI, or on a machine with Qt 6.5+
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
qmltestrunner -input tests/qml -import qml
```

## 8. Follow-ups

1. Run the macOS job once a macOS-capable runner is available (see §4).
2. `qmltestrunner` needs `QT_QPA_PLATFORM=offscreen` on Linux CI; keep that in the workflow
   when the QML tree grows a real `main.qml` window test.
3. The QML resource list is globbed with `CONFIGURE_DEPENDS`, so new `.qml` files are picked
   up automatically — do not reintroduce a hand-maintained file list.
