# Phase 2 Build & Review Results (t23 review gate)

- Reviewed by: reviewer-glm5 (t23 attempt 2)
- Date: 2026-11-23 (Asia/Shanghai)
- Repo: lbn2011/dsh-qt-app, branch dev/phase-1, head reviewed: 46a9406 (t22, CI extension & packaging)
- Scope: Phase 2 deliverables t10–t22 (Markdown / Theme / Settings / Bridge / CI & packaging) against docs/PHASE-2-PLAN.md §5 (definition of done)

## 1. Local verification (all passed)

| Command | Result |
|---|---|
| `pnpm exec tsc --noEmit -p .` | exit 0 |
| `pnpm exec tsc --noEmit -p tsconfig.test.json` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm test` | 319/319 pass, 0 fail |

## 2. Deliverable inventory (verified on disk @ 46a9406)

- **Markdown**: src/markdown/{types,fallback-parser,renderer,streaming}.ts; qml/markdown/ = 14 components; QML suites tst_markdown/tst_markdowninline/tst_markdownstreaming.
- **Highlighting (D1)**: src/highlight/ (8 files) with shiki-loader.ts (probe + lazy load) and pure-TS tokenizer fallback; `maxHighlightChars` schema cap (src/settings/schema.ts:155, default 20 000, maximum 1 000 000) — D1 RESOLVED as decided (Shiki lazy + maxHighlightChars guard).
- **Theme**: src/theme/ (schema, builtins dark/light, manager with fontScale clamp, persist, service); qml/components/Theme.qml façade over C++ ThemeBridge; ThemeSettings/ThemeForm live switching; tst_theme.qml + tst_themesettings.qml.
- **Settings (D2)**: src/settings/ (schema, store with schemaVersion migration + backup recovery, forms, slots, qml-bridge, paths, builtin settings.json); SettingsPanel.qml tabbed shell (Theme/Language/Plugins/About + dynamic plugin sections); schema-driven FormControl* suite; SlotHost.qml for plugin form contributions; tst_settings*/tst_formcontrol/tst_settingsplugin.qml — D2 RESOLVED (modal settings pane).
- **D3**: no apiKey field exists in the settings schema — consistent with the plan ruling D3 = apiKeyRef env-var only, keyring deferred to Phase 4. No secret material found in schema/store (grep for apiKey/api_key/secret/env returns no hits in src/settings). D3 recorded as deferred per plan.
- **Bridge (t21)**: src/bridge/{index,qml-bridge,services}.ts; tests/qml-bridge.test.ts covers Node↔QML wiring; native/main.cpp gained StdioTransport with QSocketNotifier (POSIX) / QTimer polling (Windows).
- **CI/packaging (t22)**: build.yml (napi ubuntu+windows matrix feeding Qt matrix) and test.yml (napi + packaging with CPack). CMakeLists.txt globs qml/markdown/*.qml with FATAL_ERROR guard (t22 plan condition met).

## 3. Integration flow (message → Markdown render → theme apply → settings save)

Covered at unit level: markdown streaming tests (tst_markdownstreaming.qml, tests/markdown-streaming.test.ts), theme parity + switching tests, settings store persist/restart/migration tests, and bridge round-trip tests (tests/qml-bridge.test.ts). Full visual end-to-end was not executable in this environment (no local Qt display) — see §6 limitations. All programmatic legs of the flow pass locally.

## 4. CI status on lbn2011/dsh-qt-app @ 46a9406 — **NOT GREEN (blockers)**

Run 45049991925 (build) / 45049992016 (test), 2026-11-22T17:32Z:

| Job | Result | Cause |
|---|---|---|
| napi (ubuntu-22.04) build | ✅ | — |
| napi (ubuntu-22.04) addon unit tests (test.yml) | ❌ | test harness expects `dsh-qt-app/lib/qt-bridge/napi-loader.js` to pre-exist (`run "pnpm -C dsh-qt-app build" first`) — test.yml does not build the TS package before the napi job |
| napi (windows-2022) build | ❌ | `spawnSync npx.cmd EINVAL` during node-gyp invocation (Node-24-on-runner vs actions targeting Node 20 / node-gyp spawn issue) |
| qt build (build.yml) | skipped (0s) | dependent on failed/skipped napi artifact stage |
| packaging (ubuntu-22.04) | ❌ | **`native/main.cpp:364: error: 'pollTimer_' was not declared in this scope`** — genuine C++ compile error |

## 5. Findings

- **F1 (blocker, must fix)**: native/main.cpp:364 references `pollTimer_` (and `readNotifier_`) unconditionally in `StdioTransport::stop()`, but both members are declared inside `#ifndef Q_OS_WIN / #else` blocks (lines 534–538). On Linux `pollTimer_` does not exist → compile failure. Fix: wrap line 364's condition per-platform (`#ifdef Q_OS_WIN` → check `pollTimer_`, else check `readNotifier_`).
- **F2 (blocker, CI infra)**: test.yml napi job runs addon unit tests that require the built TS output (`dsh-qt-app/lib/...`) which test.yml never builds. Add a pnpm build step to the napi job (or gate the loader-integration tests on a built package).
- **F3 (blocker, CI infra)**: windows napi build fails with `spawnSync npx.cmd EINVAL` (node-gyp spawn under Node 24 runner). Pin Node version for the napi jobs or invoke node-gyp directly (`node-gyp configure build`), avoiding `npx.cmd`.
- **F4 (non-blocking, known gap)**: macOS remains an accepted gap (documented in build.yml); t11 Windows compile was deferred to first CI run — that evidence now exists and is failing (F3).
- **F5 (non-blocking)**: qt build matrix (build.yml) never executed at this head because the napi artifact stage failed; Linux/Windows Qt compile evidence still comes from the earlier Phase 1 runs and must be re-confirmed after F1–F3 are fixed.

## 6. Risks (plan §6) — resolution status

- R-qt-availability: resolved for CI (aqtinstall on runners); unresolvable locally (no Qt in sandbox) — documented limitation.
- R-streaming-perf: addressed by DeltaMarkdownParser stable-id incremental re-parse; 60fps tick p95 evidence pending real-GPU/display run (deferred to Phase 3 profiling).
- R-degraded-mode: resolved (fallback parser parity tests + napi-loader degradation tests).
- R-cmark-version: resolved (0.29.0.gfm.14 vendored; '0.30+' criterion ruled unsatisfiable by captain).
- R-macOS: deferred (accepted gap, documented in build.yml and Phase 1 record).
- R-settings-secrets: resolved for Phase 2 (no secret fields; D3 defers apiKeyRef handling to Phase 3/4).

## 7. Decisions

- D1 (syntax highlighting): RESOLVED — Shiki lazy loader + probe, pure-TS tokenizer fallback, maxHighlightChars cap in settings schema.
- D2 (settings pane): RESOLVED — tabbed SettingsPanel with schema-driven forms and plugin SlotHost.
- D3 (API key storage): DEFERRED per plan — no apiKeyRef field shipped in Phase 2; keyring stays Phase 4; schema contains no secret material.

## 8. Gate verdict

Verdict: **needs_revision** — all t10–t22 code deliverables are present, coherent and locally green (319/319 tests, typecheck, build clean), but the Phase 2 acceptance criterion "CI passed on Linux/Windows" is not met at head 46a9406 due to F1 (C++ compile error), F2 (test.yml ordering) and F3 (Windows node-gyp spawn). After those fixes and a green CI run, the gate can pass on re-review; D1–D3 and risk dispositions are recorded above.
