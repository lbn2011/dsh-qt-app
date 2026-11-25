# T77 — the packaged addon is chosen by target triple, and the archive is checked

Baseline: `5671824` (`docs: record the t58 remote CI result`), the commit the
t29 verification ran against and the head of `origin/dev/phase3-i9`. Worktree
`/data/qt-phase3/app/wt/t77-napi-select`, branch `phase3/t77-napi-select`.
Independent app repository only: nothing was pushed, the EAC tree and the
`dsh-qt-napi` repository were not touched, and no other worktree was modified.

## The defect being repaired (T29-A)

The Windows package from the t29 remote run carried a **Linux** binary as its
addon:

```
$ file dsh-qt-app-0.1.0-Windows-AMD64/dsh-qt-napi/prebuild/win32-x64/qt-bridge.node
… ELF 64-bit LSB shared object, x86-64 … not stripped
$ file dsh-qt-app-0.1.0-Windows-AMD64/bin/dsh-qt-app.exe
… PE32+ executable for MS Windows 6.00 (console), x86-64 …
```

Nothing failed anywhere. The chain, each link verified against the sources at
`5671824`:

1. `dsh-qt-napi@87084a6` **commits** `prebuild/linux-x64/qt-bridge.node`
   (`.gitignore` carries `!prebuild/`, with the comment "prebuild/ IS committed
   on purpose"). sha256 `a511463e37c65d0ac919e65df2dded3d8d4c8175b12be09be3b3c7aca1343649`.
2. The Windows `napi` job checks that repository out, so `prebuild/` holds the
   committed `linux-x64` (ELF) *and* the freshly staged `win32-x64` (PE32+,
   sha256 `44897ffa96937f3088fff988c2c062b8382281880cde2589383c4ebb16471f59`).
3. `CMakeLists.txt:221-227` (baseline) globbed
   `file(GLOB … "${DSH_QT_NAPI_DIR}/prebuild/*/qt-bridge.node")`, sorted the
   paths and took the first hit. `linux-x64` sorts before `win32-x64`.
4. `CMakeLists.txt:301-304` installed that file as
   `dsh-qt-napi/prebuild/${DSH_QT_NAPI_TRIPLE}/qt-bridge.node` — i.e. the ELF
   landed under `win32-x64/`.
5. `src/qt-bridge/napi-loader.ts:146,158` searches only
   `<root>/dsh-qt-napi/prebuild/<platform>-<arch>/qt-bridge.node`, so
   `require()` of the ELF failed, and the loader is documented to never throw:
   "an unreachable/incompatible addon yields the degraded fallback".

The build gate could not see any of this: `build.yml:410` asserted only that
`build/cmake_install.cmake` mentions `qt-bridge.node` — which it did.

## What changed

| file | change |
| --- | --- |
| `scripts/cmake/dsh-qt-napi-addon.cmake` | new. Strict staging rules: target-triple hit wins, a foreign platform never substitutes, the chosen file's object format must match the triple. |
| `CMakeLists.txt` | the glob-and-sort block is replaced by `dsh_qt_napi_target_triple()` + `dsh_qt_napi_stage()`; the triple is now computed before staging instead of after. |
| `tests/cmake/napi-addon-resolution.cmake` | new. 8-case table, script mode (`cmake -P`), no Qt and no compiler. |
| `tests/cmake/legacy-staging.cmake` | new. The baseline algorithm, copied verbatim as the red case. |
| `scripts/check-package-addon.mjs` | new. Inspects the unpacked CPack archive: loader path, object format, digest against the staged artifact, `LICENSE` + notices, host executable format. |
| `tests/check-package-addon.test.ts` | new. 14 cases over the gate, including the T29-A shape. |
| `.github/workflows/build.yml` | the weak `grep cmake_install.cmake` gate is replaced by unpack-and-inspect of the real archive. |
| `.github/workflows/test.yml` | the staging table runs on every OS (resolver green + legacy red); the packaging job now checks the archive on **both** legs instead of Linux only. |
| `THIRD-PARTY-NOTICES.md` | the claim that the `qt-webengine` job "has not yet been observed running on a hosted runner" was outdated after run 45444359081; replaced with what that run actually did. |

### The rules, in the order they apply

1. `-DDSH_QT_NAPI_ADDON` (explicit override) — still subject to rule 4.
2. `prebuild/<target triple>/qt-bridge.node` — exact hit, preferred.
3. No exact hit but `prebuild/` carries other triples → `FATAL_ERROR` naming the
   triples present and the one required.
4. Object format must match the triple: `win32-*` → PE, `linux-*` → ELF,
   `darwin-*` → Mach-O, read from the first four bytes.
5. No `DSH_QT_NAPI_DIR` at all → `mode=degraded`, the approved no-addon build.
6. Flat host layouts (`qt-bridge.node`, `build/Release`, `build/Debug`) still
   resolve, because a host build has no triple in its path.

## Evidence — baseline red, then green

Local, in the worktree. Red first, with the baseline algorithm:

```
$ cmake -DMODE=legacy -DDSH_QT_NAPI_TEST_ROOT=/tmp/t77-fixtures \
        -P tests/cmake/napi-addon-resolution.cmake
FAIL case1-win32-beats-sorting: resolved
  '/tmp/t77-fixtures/both/prebuild/linux-x64/qt-bridge.node',
  expected suffix 'prebuild/win32-x64/qt-bridge.node'
FAIL case3-missing-darwin-triple: staging succeeded, expected a hard failure
FAIL case4-only-foreign-platform: staging succeeded, expected a hard failure
FAIL case7-mislabelled-format: staging succeeded, expected a hard failure
napi-addon-resolution (legacy): 4 of 8 checks failed      # exit 1
```

Case 1 is T29-A itself: the Windows target resolved the Linux ELF.

Green with the new rules:

```
$ cmake -DMODE=resolver -DDSH_QT_NAPI_TEST_ROOT=/tmp/t77-fixtures \
        -P tests/cmake/napi-addon-resolution.cmake
-- ok case1-win32-beats-sorting: …/both/prebuild/win32-x64/qt-bridge.node
-- ok case2-linux-beats-sorting: …/both/prebuild/linux-x64/qt-bridge.node
-- ok case3-missing-darwin-triple: rejected
-- ok case4-only-foreign-platform: rejected
-- ok case5-no-addon-anywhere: rejected
-- ok case6-host-build-layout: …/flat/build/Release/qt-bridge.node
-- ok case7-mislabelled-format: rejected
-- ok case8-degraded-mode: mode=degraded
-- napi-addon-resolution (resolver): all 8 checks passed   # exit 0
```

## Evidence — real configure, real archive (Linux host)

Fixtures: `prebuild/linux-x64/qt-bridge.node` is a real ELF (`/bin/true`),
`prebuild/win32-x64/qt-bridge.node` starts with `MZ` — i.e. the exact layout the
Windows CI job has on disk.

```
$ cmake -S . -B /tmp/t77-cfg1 -DDSH_QT_NAPI_DIR=/tmp/t77-real/both \
        -DDSH_QT_WEBENGINE=OFF -DCMAKE_BUILD_TYPE=Release
-- dsh-qt-app: napi prebuild triple is linux-x64
-- dsh-qt-app: bundling dsh-qt-napi addon /tmp/t77-real/both/prebuild/linux-x64/qt-bridge.node
$ grep qt-bridge.node /tmp/t77-cfg1/cmake_install.cmake
file(INSTALL DESTINATION "${CMAKE_INSTALL_PREFIX}/dsh-qt-napi/prebuild/linux-x64" …
     FILES "/tmp/t77-real/both/prebuild/linux-x64/qt-bridge.node")
```

The three negative configures fail where they should:

| fixture | result |
| --- | --- |
| only `prebuild/win32-x64` on a `linux-x64` build | exit 1 — "has no addon for the target triple 'linux-x64'; it only carries prebuild/{win32-x64}. Refusing to bundle a binary built for another platform" |
| `prebuild/linux-x64/qt-bridge.node` that is really a PE | exit 1 — "the resolved addon … is PE, but the target triple 'linux-x64' needs ELF (win32-* takes PE, linux-* takes ELF, darwin-* takes Mach-O)" |
| no `DSH_QT_NAPI_DIR` | exit 0 — "no DSH_QT_NAPI_DIR given — packaging will ship the degraded renderer" |

Then a real build and a real CPack archive:

```
$ cmake --build /tmp/t77-cfg1 --parallel 2 && cmake --build /tmp/t77-cfg1 --target package-app
$ tar -tzf dist/package/dsh-qt-app-0.1.0-Linux-x86_64.tar.gz
dsh-qt-app-0.1.0-Linux-x86_64/bin/dsh-qt-app
dsh-qt-app-0.1.0-Linux-x86_64/dsh-qt-napi/prebuild/linux-x64/qt-bridge.node
dsh-qt-app-0.1.0-Linux-x86_64/LICENSE
dsh-qt-app-0.1.0-Linux-x86_64/THIRD-PARTY-NOTICES.md
$ node scripts/check-package-addon.mjs --dir <unpacked> --triple linux-x64 \
       --expect-source /tmp/t77-real/both/prebuild/linux-x64/qt-bridge.node
check-package-addon: dsh-qt-napi/prebuild/linux-x64/qt-bridge.node is ELF
  sha256 b381cc8c55ec524b9fa92897f0882e855357468b4a763519cec47e05994d61ff (target linux-x64)
check-package-addon: linux-x64 package carries the addon at the path the loader searches
```

## Evidence — the new gate rejects the real T29-A archive

The Windows package artifact from build run 45444359152 (artifact
14943938434) was unpacked and fed to the gate:

```
$ node scripts/check-package-addon.mjs \
      --dir <unpacked>/dsh-qt-app-0.1.0-Windows-AMD64 --triple win32-x64 \
      --expect-source <napi artifact>/win32-x64/qt-bridge.node
check-package-addon: dsh-qt-napi/prebuild/win32-x64/qt-bridge.node is ELF, but a
  win32-x64 package needs PE — the loader would fail require() and degrade silently
check-package-addon: packaged addon sha256 a511463e37c65d0ac919e65df2dded3d8d4c8175b12be09be3b3c7aca1343649
  does not match --expect-source … (44897ffa96937f3088fff988c2c062b8382281880cde2589383c4ebb16471f59)
exit 1
```

Two independent diagnoses of the same defect: the format contradicts the target
triple, and the bytes are not the artifact this build staged. Had this gate
existed in the t29 run, the Windows `qt-build` job would have gone red instead of
shipping.

`node --test tests/check-package-addon.test.ts` → 14 pass, 0 fail. Cases include
the ELF-in-Windows-package shape, a package carrying a second triple, a digest
mismatch against the staged artifact, the approved degraded package (and a stray
addon inside it), missing `LICENSE`/notices, a wrong-format executable, and a
Mach-O addon for `darwin-arm64`.

## Verification run on the committed tree

```
cmake -DMODE=resolver -DDSH_QT_NAPI_TEST_ROOT=build/napi-fixtures-resolver \
      -P tests/cmake/napi-addon-resolution.cmake     # exit 0, all 8 checks passed
cmake -DMODE=legacy   -DDSH_QT_NAPI_TEST_ROOT=build/napi-fixtures-legacy \
      -P tests/cmake/napi-addon-resolution.cmake     # exit 1, 4 of 8 checks failed
node --test tests/check-package-addon.test.ts        # 14 pass, 0 fail
node scripts/gate.mjs -- pnpm typecheck              # exit 0 (src + tests)
node scripts/gate.mjs -- pnpm test                   # 515 tests, 513 pass, 0 fail, 2 skipped
ruby -ryaml … build.yml test.yml                     # both parse
git diff --check                                     # clean
git status --short                                   # empty
```

The two skips are the host-dependent WebUI tests, which the `webui real host` job
runs against an installed DSH tree. The fixture root is passed as
`build/napi-fixtures-*` on purpose: an earlier draft matched failure messages
verbatim, and CMake's line wrapping split a phrase when the fixture path grew, so
the child output is whitespace-collapsed before matching and the table no longer
depends on the path length.

## Local versus remote

Run locally in this worktree:

- `cmake -DMODE=legacy …` (red, exit 1) and `cmake -DMODE=resolver …` (green,
  exit 0);
- four real configures (one positive, three negatives) and one real
  build + `package-app`, giving a real `.tar.gz`/`.zip` whose addon sits at
  `dsh-qt-napi/prebuild/linux-x64/qt-bridge.node`;
- `scripts/check-package-addon.mjs` against that archive (pass) and against the
  real T29-A Windows archive from run 45444359152 (fail, as it must);
- `node --test tests/check-package-addon.test.ts` (14/14);
- `ruby -ryaml` parse of both edited workflows.

Still to be confirmed on a hosted runner (needs a new push and an independent
review of this commit — not done here, nothing was pushed):

- `qt build (windows-2022)` with the new unpack-and-inspect step: the archive
  must carry a PE addon whose digest equals the downloaded `napi-prebuild`
  artifact. This is the only place the Windows triple is really exercised; the
  local Linux host cannot produce a `win32-x64` build;
- `packaging (windows-2022)` with the new contents gate (`--expect-addon
  degraded`);
- `typescript (windows-2022)` running the staging table (needs `cmake` on the
  Windows runner, which the hosted images provide).

## Limits

- macOS: still not validated. `qt build (macos-14)` has never executed (the job
  is cancelled within a second of starting, no runner). The gate accepts a
  `dsh-qt-app.app/Contents/MacOS/dsh-qt-app` bundle path for `darwin-*` triples
  so the step is not wrong by construction, but no Mach-O package has been built
  or inspected.
- The gate inspects the archive, not the running app. Whether a correctly
  packaged addon actually loads is covered by the loader tests
  (`tests/napi-loader.test.ts`) and the host e2e, not by this record.
- `prebuild/linux-x64/qt-bridge.node` remains committed in `dsh-qt-napi`. That is
  the upstream repository's deliberate choice and is not touched here; the fix is
  that this build no longer trusts an arbitrary `prebuild/*` entry.
