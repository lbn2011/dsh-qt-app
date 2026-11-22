# CI notes

Two workflows live in `.github/workflows/`:

| File | Trigger | Jobs |
| --- | --- | --- |
| `build.yml` | `push` (`main`, `dev/**`), `pull_request`, `workflow_dispatch` | `qt6 (ubuntu-22.04 / windows-2022 / macos-14)`: `pnpm install` → `pnpm build` → Qt 6.7.3 install → CMake configure → CMake build → upload `dist/` artifact |
| `test.yml` | same | `typescript (matrix)` : `pnpm typecheck`, `pnpm test`; `qml lint`: `qmllint qml/**/*.qml` + CMake configure |

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
| Qt | `6.7.3` (`jurplel/install-qt-action@v4`, module `qtquickcontrols2`) | matches the `find_package(Qt6 6.5 REQUIRED …)` floor |
| Node | `22.19.0` | Cordis 4.x + `engines.node >= 22.19` |
| pnpm | `12` | matches `packageManager: pnpm@12.16.1`; reads `allowBuilds` from `pnpm-workspace.yaml` |

## Install mode

`pnpm-lock.yaml` is committed, so both workflows run
`pnpm install --frozen-lockfile` and fail if the lockfile drifts from
`package.json`. Run `pnpm install` locally after changing dependencies and
commit the updated lockfile with the change.

`pnpm-workspace.yaml` also carries `allowBuilds: { esbuild: true }`: pnpm >= 12
blocks dependency build scripts by default, and `tsx` needs esbuild's install
script. Without that entry `pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`.

## What CI does *not* do

- It does not launch the GUI: the build job only compiles and stages artifacts.
- It does not run the QML `TestCase` suites — those arrive with phase 1c and
  will need `xvfb-run` on Linux.
- It does not compile `dsh-qt-napi` (separate repository, prebuilt binaries).

## Local limits

Qt/C++ compilation is deliberately excluded from the development machine. Local
verification is limited to `pnpm install --dry-run`, `pnpm typecheck`,
`pnpm test` and YAML/syntax checks.
