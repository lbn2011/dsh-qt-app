# CI notes

Two workflows live in `.github/workflows/`:

| File | Trigger | Jobs |
| --- | --- | --- |
| `build.yml` | `push` (`main`, `dev/**`), `pull_request`, `workflow_dispatch` | `napi` (ubuntu-22.04 / windows-2022): build the cmark-gfm addon → upload `prebuild/`; `qt-build` (ubuntu-22.04 / windows-2022 / macos-14): `pnpm build` → Qt 6.7.3 → CMake configure/build → `pnpm package` → upload executable + package |
| `test.yml` | same | `napi` (addon build + verify + unit tests); `typescript` (matrix): `pnpm typecheck`, `pnpm test`; `napi-integration`: full suite with a real addon on disk; `qml-lint`: `qmllint` over `qml/`; `qml-tests`: `qmltestrunner` over `tests/qml/`; `packaging` (ubuntu-22.04 / windows-2022): `pnpm package` |

## Repository root assumption

GitHub only reads workflows from `<repo>/.github/workflows`. These files assume
the **repository root is this package** (`dsh-qt-app/`), which matches the fork
used for CI (`lbn2011/dsh-qt-app`).

When the package is developed inside the monorepo (`/data/EAC-Desktop`), the
workflows are *not* picked up by the monorepo's own `.github/workflows/` — they
are inert templates that the CI mirror runs from the package root. Do not copy
them to the monorepo root; the monorepo pipeline is owned separately.

## Toolchain pins

| Item | Value | Why |
| --- | --- | --- |
| Qt | `6.7.3` (`jurplel/install-qt-action@v4`) | matches the `find_package(Qt6 6.5 REQUIRED …)` floor. No extra `modules:` is requested: in Qt 6, Quick Controls 2 ships with qtdeclarative, and a Qt 5 style `qtquickcontrols2` module name fails to resolve for 6.x |
| Node | `22.19.0` | Cordis 4.x + `engines.node >= 22.19` |
| pnpm | from `packageManager: pnpm@12.16.1` | do **not** also pass `version:` to `pnpm/action-setup@v4`, it errors on the duplicate |
| Python | `3.11` (addon job only) | `node-gyp` needs Python; 3.11 avoids the removed `distutils` in 3.12+ |

## Install mode

`pnpm-lock.yaml` is committed, so the TypeScript jobs run
`pnpm install --frozen-lockfile` and fail if the lockfile drifts from
`package.json`. Run `pnpm install` locally after changing dependencies and
commit the updated lockfile with the change.

`pnpm-workspace.yaml` also carries `allowBuilds: { esbuild: true }`: pnpm >= 12
blocks dependency build scripts by default, and `tsx` needs esbuild's install
script. Without that entry `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`.

The addon job uses `npm install --ignore-scripts` on purpose: the install hook in
`dsh-qt-napi` compiles the addon, and letting it run here would bury a compile
failure inside dependency installation. The build is its own step.

## The addon (`dsh-qt-napi`) and why CMake does not link cmark-gfm

`dsh-qt-napi` is a **separate repository** (`lbn2011/dsh-qt-napi`) that vendors
cmark-gfm and compiles it into the N-API addon `qt-bridge.node`. Node uses it to
parse/render Markdown; the Qt executable never calls cmark. The two processes talk
over a newline-delimited JSON stdio bridge and the Qt side receives an AST.

Both workflows therefore build the addon in their own `napi` job and hand its
`prebuild/` tree to the Qt jobs through an artifact. Linking cmark-gfm into the
Qt target would duplicate symbols against the addon's static build and ship a
parser that is never called.

The Qt jobs unpack that artifact into `dsh-qt-napi/prebuild/` and export

```sh
DSH_QT_NAPI_DIR=<workspace>/dsh-qt-napi
```

CMakeLists.txt picks this up through an environment fallback (`-DDSH_QT_NAPI_DIR`
still works and takes precedence), resolves the addon in this priority order, and
installs it to `dsh-qt-napi/prebuild/<platform>-<arch>/` inside the package:

1. `prebuild/*/qt-bridge.node` (the published layout — preferred)
2. `qt-bridge.node`
3. `build/Release/qt-bridge.node`
4. `build/Debug/qt-bridge.node`

The order is explicit rather than a single `file(GLOB)` because glob results are
sorted alphabetically, which silently preferred `build/Release` over `prebuild`
(`"build" < "prebuild"`).

If the addon is absent the build still succeeds and packages the degraded
renderer; CI asserts the addon actually got bundled so that silent regression
cannot ship.

## QML TestCase expectations

`qml-tests` runs, headless (`QT_QPA_PLATFORM=offscreen`), from the package root:

```sh
qmltestrunner -input tests/qml -import qml
```

Consequences for authors:

- **Discovery is directory-based.** Any `tests/qml/tst_*.qml` is picked up; there
  is no list to update. The `-import qml` flag makes `import "../components"` and
  friends resolvable from the test files.
- **A suite that fails to load can be silently skipped**, and some Qt versions
  still exit 0. The job therefore counts `*** Start testing of` lines in
  `qmltest.log` and fails if fewer suites ran than `tst_*.qml` files on disk, then
  separately greps for `Failures: [1-9]` / `Errors: [1-9]`. A new suite that
  cannot even be instantiated fails the job rather than passing by omission.
- `qmltest.log` is uploaded as an artifact on every run, so a failure is
  diagnosable without re-running.
- Suites must not need a display, a network, or the Node side. Components that
  reach for `ctx` must keep working when it is undefined — that is why
  `qml/components/Theme.qml` falls back to its own palette and why
  `qml/views/settings/*` accept a `bridgeOverride`.
- The `qmllint` job treats warnings as failures. Context properties such as `ctx`
  are invisible to qmllint, so the guarded access is wrapped in a scoped
  `// qmllint disable unqualified` / `enable unqualified` pair; do not widen that
  to the whole file.

`cmake --build build --target qml-tests` runs the same suites locally when a Qt
toolchain is present (the target is skipped with a status message otherwise).

## Packaging

`pnpm package` configures, builds and packages in one step:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && \
  cmake --build build --config Release --target package-app
```

`package-app` runs the `install` target and then CPack. Artifacts are written to
`dist/package/` (`CPACK_OUTPUT_FILE_PREFIX`), which is git-ignored, and are named
`dsh-qt-app-<version>-<system>-<processor>`. Generators per platform:

| Platform | Generators |
| --- | --- |
| Windows | `ZIP`, plus `NSIS` when `makensis` is on `PATH` |
| macOS | `DragNDrop` (`.dmg`) |
| other | `TGZ`, `ZIP` |

## What CI does *not* do

- It does not launch the GUI. The Qt jobs compile, test and package; nothing opens
  a window. `qmltestrunner` is the only thing that instantiates QML, and it runs
  offscreen.
- It does not symbolically verify the macOS package: the macOS legs never start
  (see below).
- It does not publish anything. Artifacts are retained 7 days; releasing is a
  manual step.

## Known gaps

**macOS runners are unavailable to this project.** `macos-14` jobs are cancelled
before step 1 with "The configuration `macos-14-arm64-us-default` is not
supported", and `macos-13` queues indefinitely. The matrix keeps `macos-14` so the
cancellation is explicit and visible rather than a silently missing platform.
macOS is therefore unvalidated end to end, including the `.dmg` generator.

**Windows addon builds are unverified locally.** The addon was developed and
built on Linux; the Windows leg of the `napi` job is its first real MSVC compile.

## Local limits

Qt/C++ compilation is deliberately excluded from the development machine: there
is no `qmake6`, `qmllint`, `qmltestrunner` or `qmlformat`, so `native/main.cpp`
and every `.qml` file are only statically reviewed locally (brace/paren balance,
import and symbol checks by inspection, `cmake` configure against a stub Qt
package for `CMakeLists.txt`). CI is the first real compile, so treat a local
"looks fine" as a hypothesis, not a result.

Local verification is limited to:

```sh
pnpm typecheck            # src + tests
pnpm test                 # node:test suites
pnpm build                # tsc emit
cmake -S . -B /tmp/check  # fails at find_package(Qt6) without a Qt toolchain,
                          # but parses everything before it
```
