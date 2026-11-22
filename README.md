# dsh-qt-app

Native **Qt 6 / QML** UI profile for DeepSeek Harness (DSH). It replaces the
Tauri/Rust WebUI shell with a Qt Quick window while keeping the Cordis plugin
system and the existing DSH slot surfaces intact: the TypeScript side is a
regular Cordis plugin, the C++ side is a thin Qt host, and the two talk through
an N-API bridge (`dsh-qt-napi`) pumped by a 10 ms libuv timer.

> **Status: phase 1a (skeleton).** This commit only establishes the package
> layout, the TypeScript/CMake configuration and the CI template. The Cordis
> renderer service, the N-API loader and the QML views land in phases 1b–1c.

Design references:

- [`../docs/superpowers/specs/2026-11-22-dsh-qt-profile-design.md`](../docs/superpowers/specs/2026-11-22-dsh-qt-profile-design.md)
- [`../docs/superpowers/specs/2026-11-22-dsh-qt-implementation-plan.md`](../docs/superpowers/specs/2026-11-22-dsh-qt-implementation-plan.md)

## Platform prerequisites

Common requirements for every platform:

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | **>= 22.19** | Cordis 4.x is ESM-only; `engines.node` enforces this |
| pnpm | **>= 12** | `corepack enable` (the pinned `packageManager` is pnpm 12.16.1) |
| CMake | **>= 3.21** | required by Qt 6 QML tooling (`cmake_minimum_required`) |
| C++ compiler | C++20 | MSVC 19.3x, clang 15+, gcc 11+ |
| Qt | **>= 6.5** | components: `Core`, `Gui`, `Quick`, `Qml`, `QuickControls2` (+ `Test` for QML tests) |

### Windows

- Visual Studio 2022 (MSVC v143 toolset) or Build Tools for Visual Studio 2022 with the *Desktop development with C++* workload.
- Qt 6.5+ MSVC 2022 64-bit kit, installed with the **Qt Quick Controls 2** module, e.g. via the online installer or:
  ```powershell
  # aqtinstall (optional, non-interactive install)
  pip install aqtinstall
  aqt install-qt windows desktop 6.7.3 win64_msvc2022_64 -m qtquickcontrols2
  ```
- `cmake` on `PATH` (bundled with Visual Studio or the standalone installer).

### macOS

- Xcode 15+ command line tools (`xcode-select --install`).
- Qt 6.5+ for `clang_64`, e.g. `brew install qt@6` (then `export PATH="$(brew --prefix qt@6)/bin:$PATH"`).
- Apple Silicon and Intel (`macos-14` runners) are both supported by the CI matrix.

### Linux

- A C++20 toolchain (`build-essential`, gcc 11+) and CMake 3.21+.
- Qt 6.5+ base + declarative development packages, e.g. on Debian/Ubuntu:
  ```bash
  sudo apt-get install -y qt6-base-dev qt6-declarative-dev qt6-quickcontrols2-dev \
      qml6-module-qtquick qml6-module-qtquick-controls qml6-module-qtquick-layouts \
      libgl1-mesa-dev libxkbcommon-dev libxcb-cursor0
  ```
- A running display server (X11 or Wayland) for launching the window; the CI job only builds, so `xvfb` is not required.

## Quick start

```bash
# 1. clone (the package is mirrored to its own repository for CI)
git clone https://github.com/lbn2011/dsh-qt-app.git
cd dsh-qt-app

# 2. install JavaScript dependencies (Cordis + toolchain); the committed
#    pnpm-lock.yaml makes this reproducible
corepack enable
pnpm install --frozen-lockfile

# 3. typecheck and run the unit tests (fast, no Qt needed)
pnpm typecheck
pnpm test

# 4. build the TypeScript plugin (src/ -> lib/)
pnpm build

# 5. configure and build the Qt host (requires the Qt 6.5+ kit above)
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release --parallel

# 6. run it
./build/dsh-qt-app          # Linux
# .\build\Release\dsh-qt-app.exe   # Windows (MSVC multi-config)
# ./build/dsh-qt-app.app/Contents/MacOS/dsh-qt-app   # macOS bundle
```

> **Do not compile Qt on the development machine of this repository.** Qt/C++
> builds are executed by GitHub Actions (`.github/workflows/build.yml`); local
> runs are limited to the light TypeScript commands above.

### Available scripts

| Script | What it does |
| --- | --- |
| `pnpm build` | `tsc -p tsconfig.json` → `lib/` (+ `.d.ts`) |
| `pnpm typecheck` | `tsc -p tsconfig.test.json` — typechecks `src/` **and** `tests/`, no emit |
| `pnpm test` | `tsx --test tests/*.test.ts` (node:test runner) |
| `pnpm clean` | remove `lib/`, `dist/`, `build/` |
| `pnpm cmake:configure` | `cmake -S . -B build -DCMAKE_BUILD_TYPE=Release` |
| `pnpm cmake:build` | `cmake --build build --config Release` |

## Qt6 requirements (as encoded in `CMakeLists.txt`)

- `cmake_minimum_required(VERSION 3.21)` — first line of `CMakeLists.txt`.
- `find_package(Qt6 6.5 REQUIRED COMPONENTS Core Gui Quick Qml QuickControls2)`.
- `CMAKE_CXX_STANDARD 20` (extensions off), `CMAKE_AUTOMOC ON`, `qt_standard_project_setup()`.
- Target `dsh-qt-app` = `native/main.cpp` + `qml/config.h`; QML is embedded with
  `qt_add_resources()` under the `qrc:/qml/` prefix.
- Optional target `qmllint` is generated when the `qmllint` binary is found; the
  CI `test` workflow runs it over every `qml/**/*.qml` file.

## Directory layout

```
dsh-qt-app/
├── src/                     # TypeScript / Cordis plugin
│   ├── index.ts             # plugin entry: name / inject / apply
│   └── constants.ts         # shared constants (mirror of qml/config.h)
├── qml/                     # Qt 6 / QML sources
│   ├── config.h             # build-time macros (version, N-API names, tick)
│   └── main.qml             # ApplicationWindow skeleton (1280x800)
├── native/
│   └── main.cpp             # Qt host: context property + qrc:/qml/main.qml
├── tests/
│   └── skeleton.test.ts     # node:test smoke tests for the package contract
├── docs/                    # architecture, CI and testing notes
├── .github/workflows/       # build.yml (Qt matrix), test.yml (TS + qmllint)
├── CMakeLists.txt           # Qt 6.5+ / CMake 3.21+ project
├── tsconfig.json            # build config (src -> lib)
├── tsconfig.test.json       # typecheck config (src + tests, noEmit)
├── pnpm-workspace.yaml      # single-package workspace, packages/* reserved
├── package.json             # Cordis deps + scripts
├── LICENSE                  # MIT
└── README.md
```

## Continuous integration

| Workflow | Runner matrix | What it proves |
| --- | --- | --- |
| `build.yml` | `ubuntu-22.04`, `windows-2022`, `macos-14` | `pnpm build`, CMake configure + Qt 6 build, artifacts uploaded to `dist/` |
| `test.yml` | TS job on all three OSes, `qmllint` job on Linux | `pnpm typecheck`, `pnpm test`, `qmllint qml/`, CMake configure |

Both workflows are written for a repository whose **root is this package**
(`dsh-qt-app/`), matching the fork `lbn2011/dsh-qt-app` used for CI. See
[`docs/ci.md`](docs/ci.md) for details and for the monorepo sync note.

## Roadmap

- **1b** — Cordis `qtRenderer` service, N-API loader (`src/qt-bridge/`), 10 ms event-loop bridge (`src/event-loop/`).
- **1c** — QML views (`qml/views/`, `qml/models/`, `qml/components/`) and QML tests.
- **1d** — full CI validation run, artifacts and test records.
- **2–4** — settings, theme, sidebar, plugin compatibility (React → QML conversion, WebView fallback), packaging.

## License

MIT — see [LICENSE](LICENSE).
