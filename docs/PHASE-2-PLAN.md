# Phase 2 — Core UI plan (settings · theme · Markdown)

Status: **draft for review** (author: dev-qiu on t6, reviewer: reviewer-glm5).
Scope owner: `dsh-qt-app/`. Phase 1 baseline: commits up to `91517df` locally / `08e4a152` on
`lbn2011/dsh-qt-app@dev/phase-1`, CI record in `docs/test-records/phase-1-build-results.md`.

Revision note (t6, revision 4): the plan is unchanged in substance, but the implementation
tasks are numbered **`t10`–`t23`**, not `t7`–`t20`. Team task ids `t7`, `t8` and `t9` were
consumed by the Phase 1 interim review, final review and closeout gates, so that range is no
longer free and could not be created. §9 carries the id mapping and the exact task records the
captain must create.

Phase 2 turns the Phase 1 skeleton into a UI that looks and behaves like the Tauri WebUI:
a settings panel, a real theme system, and a Markdown renderer that produces QML components
instead of HTML. Everything here is planned against the code that actually exists today, and
every task carries the paths it may touch so the work stays reviewable.

---

## 1. Where Phase 1 left us

What is already in the tree (and therefore reusable):

| Area | Current state | File |
| --- | --- | --- |
| Plugin entry | Cordis `apply()` mounts `QtRendererService` as `ctx.qtRenderer` | `src/index.ts` |
| Renderer API | `renderMarkdown`, `highlightCode`, `showDialog`/`resolveDialog`, `registerView`/`listViews`, `registerSlot`/`unregisterSlot`/`listSlots`, `declareSurface`/`listSurfaces`, `stats` | `src/index.ts` |
| Native bridge | `loadNapiModule()` discovers `dsh-qt-napi`, never throws, degrades to an HTML-escaped fallback | `src/qt-bridge/napi-loader.ts` |
| Event loop | 10 ms `setInterval` drain loop, bounded drop-oldest queue, re-entrancy guard, error isolation | `src/event-loop/timer.ts` |
| Design tokens | 27 hard-coded tokens — 13 colours, 13 ints (font sizes, spacing, radii, sizes, animation), 1 font family string | `qml/components/Theme.qml` |
| Chat UI | `ChatView` (ListView + `showEmptyState`), `MessageDelegate` (plain text), `MessageInput` (`signal send(string)`), `SessionSidebar`, `SessionHeader`, `EmptyState` | `qml/views/`, `qml/components/` |
| Models | `MessageModel` (role/text/timestamp/pending), `SessionModel` | `qml/models/` |
| Shell | `main.qml` — 1280×800 `ApplicationWindow`, local echo only, **no Node side attached** | `qml/main.qml` |
| Tests | 36 TS unit tests, 24 QML tests, qmllint clean | `tests/`, `tests/qml/` |

Known gaps this phase must close:

1. **No Node↔QML traffic.** `main.qml::sendMessage()` appends locally; nothing reaches
   `ctx.agents`. Settings and theme changes cannot reach the engine.
2. **Messages are plain text.** `MessageDelegate` uses `textFormat: Text.PlainText`.
3. **Theme is a single hard-coded palette** duplicated by `property Theme theme: Theme {}`
   defaults in six components; no light mode, no font scaling, no persistence.
4. **No settings surface at all** — no store, no panel, no `settings.*` slot host.
5. **The native module does not exist yet** (`dsh-qt-napi` is a separate package; the loader
   always falls back today).

Non-goals for Phase 2 (deferred to Phase 3/4 per the implementation plan §5): plugin sidebar
and plugin manager, tool-call cards, WebView fallback for DOM-dependent plugins, message
virtualisation beyond the current ListView, command palette, crash recovery.

---

## 2. Task graph

Four tracks that can run in parallel after their entry task: **M**arkdown, **T**heme,
**S**ettings, and **I**ntegration/gate. `t6` is this planning task; the implementation tasks
are `t10`–`t23`.

```text
M:  t10 ──► t11 ──► t12 ──► t13 ─────────────┐
                 └──► t14 ─────────────┐  │
T:  t15 ──► t16 ──► t17 ───────────┐   │  │
S:  t18 ──► t19 ──► t20 ────────┐  │   │  │
                 (t16 ──► t19)  │  │   │  │
                                ▼  ▼   ▼  ▼
I:                             t21 ──► t22 ──► t23
```

Edge list (every edge is "must finish before"):

| Task | Depends on |
| --- | --- |
| t10 Markdown AST contract + TS fallback | — |
| t11 cmark-gfm N-API binding | t10 |
| t12 QML markdown component tree | t10, t11 |
| t13 Code block + syntax highlighting | t12 |
| t14 Streaming-safe incremental rendering | t12 |
| t15 Theme token schema + ThemeManager | — |
| t16 QML theming refactor (light/dark, font scale) | t15 |
| t17 Theme settings UI + live switch | t16 |
| t18 Settings store, schema, persistence | — |
| t19 Settings panel shell | t16, t18 |
| t20 Settings forms (LLM, system prompt, plugin slots) | t19 |
| t21 Node↔QML wiring over the event-loop bridge | t14, t17, t20 |
| t22 CI + packaging extension | t13, t21 |
| t23 Phase 2 review gate + results record | t22 |

The graph is a DAG (all edges point from a lower task id to a higher one, so a topological
order exists by construction). It was checked mechanically — see §7 for the verification
transcript — and must be re-checked with `agent_teams_status` once the captain creates the
tasks, since only then do the dependencies exist in team state.

**Critical path**: `t10 → t11 → t12 → t14 → t21 → t22 → t23` (7 tasks) — the Markdown track.
The theme and settings tracks are each 6 tasks to the gate (`t15→t16→t17→t21→t22→t23` and
`t18→t19→t20→t21→t22→t23`), and `t10→t11→t12→t13→t22→t23` is 6, so **t11 (the cmark-gfm
native build) is on the critical path**: a slip there delays the phase gate directly, not only
through t12. That is the reason R2 lands t10 (the pure-TS fallback) first.

Parallelism: t10/t15/t18 can start on day one; t11 and t16 then run concurrently.

---

## 3. Interfaces fixed before implementation

These contracts are the reason t10, t15 and t18 exist: they can all be written and unit-tested
before any Qt code changes, and they keep the three feature tracks from colliding.

### 3.1 Markdown AST (`src/markdown/ast.ts`, t10)

The bridge and the QML renderer agree on one JSON shape; nothing else crosses the boundary.

```ts
export type MarkdownNode =
  | { type: 'paragraph'; children: MarkdownNode[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MarkdownNode[] }
  | { type: 'text'; value: string }
  | { type: 'strong' | 'emphasis' | 'strikethrough'; children: MarkdownNode[] }
  | { type: 'code'; value: string; language?: string; inline: boolean }
  | { type: 'link'; href: string; title?: string; children: MarkdownNode[] }
  | { type: 'list'; ordered: boolean; start?: number; items: MarkdownNode[][] }
  | { type: 'blockquote'; children: MarkdownNode[] }
  | { type: 'thematicBreak' }
  | { type: 'table'; header: MarkdownNode[][]; rows: MarkdownNode[][][] }
  | { type: 'html'; value: string }          // rendered as escaped text, never as HTML

export interface MarkdownDocument { type: 'document'; children: MarkdownNode[] }
export function parseMarkdown(text: string, options?: MarkdownOptions): MarkdownDocument
```

`parseMarkdown` is implemented twice behind one signature: the pure-TS implementation
(`src/markdown/fallback.ts`, ships in Phase 2 and is the degraded path) and the cmark-gfm
implementation (`dsh-qt-napi`, used when the module loads). Both are tested against the same
fixture file so the fallback cannot silently drift.

Hard rule: raw HTML in a message is **escaped text**, never rendered — the native side never
emits an `html` node that QML would execute.

### 3.2 Theme (`src/theme/schema.ts`, t15)

```ts
export interface ThemePalette {              // every token Theme.qml has today, plus semantic ones
  background: string; surface: string; surfaceAlt: string; surfaceAccent: string;
  border: string; text: string; textMuted: string; textInverse: string;
  accent: string; accentHover: string; danger: string; warning: string; success: string;
  codeBackground: string; codeBorder: string; linkColor: string;
}
export interface ThemeTypography { fontFamily: string; fontScale: number; codeFontFamily: string }
export interface ThemeDefinition {
  id: string; name: string; appearance: 'dark' | 'light';
  palette: ThemePalette; typography: ThemeTypography;
}
export interface ThemeManager {
  active(): ThemeDefinition
  list(): ThemeDefinition[]
  setActive(id: string): void
  setFontScale(scale: number): void      // clamped 0.75 … 1.5
  onChange(listener: (theme: ThemeDefinition) => void): () => void
  load(): void                            // reads persisted choice, falls back to 'dark'
}
```

Built-ins: `dark` (today's values, so Phase 1 screenshots stay valid) and `light`. Custom
theme files are read from the user config dir but must pass schema validation before use.

### 3.3 Settings (`src/settings/schema.ts`, t18)

```ts
export interface SettingsSchema {
  llm: { provider: string; model: string; baseUrl: string; apiKeyRef: string; temperature: number; maxTokens: number }
  agent: { systemPrompt: string; autoApproveTools: boolean }
  ui: { themeId: string; fontScale: number; showTimestamps: boolean; sendOnEnter: boolean }
  markdown: { codeHighlight: boolean; wrapCode: boolean; maxHighlightChars: number }
  advanced: { eventLoopTickMs: number; logLevel: 'error' | 'warn' | 'info' | 'debug' }
}
```

Persistence: one JSON file (`settings.json`) in the platform config dir, written atomically
(temp file + rename), with a `schemaVersion` field and a migration function per version step.
`apiKeyRef` stores a *reference* (env var name or keyring id), never the secret itself.

Store API: `get()`, `patch(partial)`, `reset()`, `onChange(listener)`, `validate()` returning
per-field errors so the QML form can show inline messages instead of failing the whole save.

---

## 4. Task contracts

Every task below states objective, in-scope paths, acceptance and the verify command a
reviewer can run. Estimates assume one developer and CI-only Qt validation (team policy: no
local Qt builds).

### M — Markdown

#### t10 — Markdown AST contract and pure-TS fallback parser
**Objective**: define `MarkdownNode`/`MarkdownDocument` and implement `parseMarkdown` in
pure TypeScript, covering paragraphs, headings, emphasis, inline code, fenced code, links,
ordered/unordered lists, blockquotes, thematic breaks and tables; raw HTML escaped.
**In scope**: `dsh-qt-app/src/markdown/`, `dsh-qt-app/tests/`.
**Acceptance**: AST types exported from `src/index.ts`; ≥30 unit tests including a fixture
round-trip file shared with t11; malformed input (unclosed fence, stray backtick, 10k-char
line) never throws; `renderMarkdown()` in `QtRendererService` returns rendered text through
the fallback when no native module is present.
**Verify**: `pnpm -C dsh-qt-app typecheck && pnpm -C dsh-qt-app test`
**Estimate**: 1.5 d.

#### t11 — cmark-gfm N-API binding
**Objective**: implement `renderMarkdownAst(text, options)` in `dsh-qt-napi` with
node-addon-api + cmark-gfm, returning exactly the t10 `MarkdownDocument` shape (JSON string
across the boundary), with `GFM` extensions enabled and raw HTML escaped.
**In scope**: `dsh-qt-napi/` (native sources, binding.gyp / CMake, prebuild config).
**Acceptance**: builds on ubuntu-22.04 and windows-2022 in CI (macOS blocked, see §6);
output byte-identical to the t10 fallback on the shared fixture set; a 100 KB message parses
in <20 ms on CI hardware; module load failure still degrades cleanly through `loadNapiModule`.
**Verify**: CI job `native` green + `pnpm -C dsh-qt-app test` with the native module present.
**Estimate**: 2 d.

#### t12 — QML markdown component tree
**Objective**: render a `MarkdownDocument` with QML components: `MarkdownView` (root),
`MarkdownBlock` (per node type), `MarkdownInline` (text runs with formatting), `CodeBlock`,
`ListItem`, `BlockQuote`, `Table` (via a simple grid; horizontally scrollable).
**In scope**: `dsh-qt-app/qml/markdown/`, `dsh-qt-app/tests/qml/`.
**Acceptance**: `MessageDelegate` switches from `Text.PlainText` to `MarkdownView` for
assistant/system messages; selection of text works; no binding loops (qmllint clean, no
`QML warning` in the qml-tests log); `tests/qml/tst_markdownview.qml` covers at least
paragraph/heading/list/code/link/table rendering and asserts the rendered child count and
visible text per node type; unknown node types render as escaped text rather than failing.
**Verify**: CI `qml lint` + `qml tests` green; `grep -q MarkdownView qml/components/MessageDelegate.qml`.
**Estimate**: 2.5 d.

#### t13 — Code blocks with syntax highlighting
**Objective**: `CodeBlock.qml` with language label, copy button, horizontal scroll and
highlighted spans; highlighting comes from `ctx.qtRenderer.highlightCode()` (Shiki or
highlight.js driven from the Node side, behind a worker/queue so it never blocks the event
loop), with plain monospace as the fallback.
**In scope**: `dsh-qt-app/qml/markdown/CodeBlock.qml`, `dsh-qt-app/src/highlight/`,
`dsh-qt-app/tests/`.
**Acceptance**: highlighting is opt-out via `settings.markdown.codeHighlight`; texts longer
than `maxHighlightChars` (default 20 000) skip highlighting; unknown language falls back to
plain text without an error dialog; copy button writes to the QML clipboard; unit tests cover
the language-alias map and the size guard.
**Verify**: `pnpm -C dsh-qt-app test`; CI `qml tests` green.
**Estimate**: 1.5 d.

#### t14 — Streaming-safe incremental rendering
**Objective**: render assistant messages while they stream: partial Markdown (unclosed
fences/emphasis) must not flicker, and re-parsing must be incremental (re-parse only the
unstable tail) with a debounce tied to the 10 ms bridge tick.
**In scope**: `dsh-qt-app/src/markdown/streaming.ts`, `dsh-qt-app/qml/markdown/`,
`dsh-qt-app/tests/`.
**Acceptance**: a 500-chunk stream produces a stable document (no node churn for already
closed blocks) and stays under a 16 ms per-tick render budget on CI; `pending` flag from
`MessageModel` drives a cursor; tests cover unclosed fences, trailing `**`, and a chunk
boundary inside a table row.
**Verify**: `pnpm -C dsh-qt-app test` (streaming suite) + CI green.
**Estimate**: 1.5 d.

### T — Theme

#### t15 — Theme token schema and ThemeManager
**Objective**: move today's 27 `Theme.qml` tokens (13 colours, 13 ints, 1 font family) into the typed `ThemeDefinition` schema,
ship `dark` (identical to current values) and `light` palettes, implement `ThemeManager`
with `setActive`/`setFontScale`/`onChange`, persistence of the chosen theme id, and schema
validation for user-supplied theme files.
**In scope**: `dsh-qt-app/src/theme/`, `dsh-qt-app/tests/`.
**Acceptance**: every colour token in `qml/components/Theme.qml` has a schema counterpart
(checked by a unit test that parses the QML file and diffs the token names); font scale is
clamped to 0.75–1.5; invalid theme files are rejected with a reason and never applied;
`pnpm test` covers load/save/migration and the token-diff test.
**Verify**: `pnpm -C dsh-qt-app typecheck && pnpm -C dsh-qt-app test`.
**Estimate**: 1 d.

#### t16 — QML theming refactor
**Objective**: replace the six `property Theme theme: Theme {}` defaults with one theme
provider (a QML singleton backed by `ThemeManager`, exposed to QML as a context property set
from `native/main.cpp` or an attached property), so a theme switch repaints the whole tree.
**In scope**: `dsh-qt-app/qml/`, `dsh-qt-app/native/main.cpp`.
**Acceptance**: no component instantiates its own palette; `Theme.qml` becomes a read-only
facade over the provider; light and dark both pass the existing 24 QML tests; a
`tst_theme.qml` asserts that switching the provider changes a component's background colour;
qmllint clean (no unqualified access).
**Verify**: CI `qml lint` + `qml tests` green.
**Estimate**: 1.5 d.

#### t17 — Theme settings UI and live switching
**Objective**: a theme section in the settings panel: appearance choice (dark/light/follow
system), font scale slider with live preview, token preview swatches; applies immediately and
persists.
**In scope**: `dsh-qt-app/qml/views/settings/ThemeSettings.qml`, `dsh-qt-app/tests/qml/`.
**Acceptance**: change applies without restart; "follow system" reads the platform colour
scheme and re-applies on change; the slider clamps at 0.75/1.5; the choice survives a
restart (asserted by a store round-trip test); `tst_themesettings.qml` covers the three cases.
**Verify**: CI `qml tests` green + `pnpm -C dsh-qt-app test`.
**Estimate**: 1 d.

### S — Settings

#### t18 — Settings store, schema and persistence
**Objective**: implement the §3.3 schema, defaults, `get`/`patch`/`reset`/`validate`/
`onChange`, atomic JSON persistence with `schemaVersion` migration, and the `apiKeyRef`
indirection (never persist secrets).
**In scope**: `dsh-qt-app/src/settings/`, `dsh-qt-app/tests/`.
**Acceptance**: corrupt/partial JSON falls back to defaults without data loss (the bad file is
preserved as `settings.json.bak`); a write is atomic (no truncated file if the process dies
mid-write — tested with a simulated rename failure); validation returns per-field errors;
no secret ever appears in the persisted file (test greps the written JSON for the dummy key);
`QtRendererService` exposes `settings` and `stats.settingsVersion`.
**Verify**: `pnpm -C dsh-qt-app typecheck && pnpm -C dsh-qt-app test`.
**Estimate**: 1.5 d.

#### t19 — Settings panel shell
**Objective**: `SettingsView.qml` — a modal/pane with a section list (Appearance, Model,
Agent, Editor, Advanced), keyboard navigation, Esc to close, and a search filter over
section and field labels; wired to `ctx.qtRenderer.showSettings()` and a menu/gear entry
point in `SessionHeader`.
**In scope**: `dsh-qt-app/qml/views/settings/`, `dsh-qt-app/qml/views/SessionHeader.qml`,
`dsh-qt-app/tests/qml/`.
**Acceptance**: opens/closes from the gear and from `showSettings()`; the search box filters
sections; unsaved-changes indicator plus Apply/Cancel semantics; `tst_settingsview.qml`
covers open/close, filter, and the dirty-state flag; no focus trap regression in the
composer.
**Verify**: CI `qml tests` green; `grep -q SettingsView qml/main.qml`.
**Estimate**: 1.5 d.

#### t20 — Settings forms and plugin slot host
**Objective**: the actual fields — provider/model/base URL/temperature/max tokens, system
prompt editor, editor preferences — with inline validation, plus the `settings.*` surface
host so plugins can contribute their own settings panes through
`ctx.qtRenderer.registerSlot({ surface: 'settings.section', … })`.
**In scope**: `dsh-qt-app/qml/views/settings/`, `dsh-qt-app/src/settings/`,
`dsh-qt-app/tests/`.
**Acceptance**: every schema field has a control and round-trips through the store; invalid
values block Apply and show a message; the system prompt survives a restart; plugin slots
render in registration order and are removed on `unregisterSlot`; tests cover validation
errors, the slot host, and the prompt round-trip.
**Verify**: `pnpm -C dsh-qt-app test`; CI `qml tests` green.
**Estimate**: 2 d.

### I — Integration and gate

#### t21 — Node↔QML wiring over the event-loop bridge
**Objective**: make `main.qml` talk to the engine: user turns go to `ctx.agents`, assistant
deltas come back through the 10 ms bridge into `MessageModel`, settings/theme changes are
applied at runtime, and `showDialog`/`resolveDialog` drive tool confirmations. Degraded mode
(no native module) must remain usable.
**In scope**: `dsh-qt-app/qml/main.qml`, `dsh-qt-app/src/bridge/`, `dsh-qt-app/native/main.cpp`,
`dsh-qt-app/tests/`.
**Acceptance**: an end-to-end test drives send → streaming delta → completion through the
queue with a fake agent; no message is dropped under a 5 000-message burst (queue drop counter
stays 0 at the configured bound); UI stays responsive (tick p95 < 16 ms in the perf test);
killing the native module mid-stream falls back without a crash; the local echo path is gone.
**Verify**: `pnpm -C dsh-qt-app test` + CI green.
**Estimate**: 2 d.

#### t22 — CI and packaging extension
**Objective**: extend the pipelines for Phase 2: a `native` job building `dsh-qt-napi` on
ubuntu + windows, QML test suites for the new components, settings/theme persistence tests on
the TS side, artifact staging including the native module, and `docs/ci.md` updated.
**In scope**: `dsh-qt-app/.github/workflows/`, `dsh-qt-app/docs/ci.md`, `dsh-qt-app/CMakeLists.txt`.
**Acceptance**: build.yml and test.yml green on ubuntu + windows (macOS still blocked, see
§6); the existing `qml-lint` and `qml-tests` jobs report the new `qml/markdown/` and
`qml/views/settings/` suites without new wiring (GLOB_RECURSE + `find qml` already cover
them — assert the new suites appear in the job log, do not re-add the jobs); the packaged
artifact contains the native module and the app starts in degraded mode when it is removed;
`docs/ci.md` documents every job and its failure modes.
**Verify**: CI green + `grep -q 'native' dsh-qt-app/.github/workflows/build.yml`.
**Estimate**: 1.5 d.

#### t23 — Phase 2 review gate and results record
**Objective**: reviewer-glm5 verifies the phase against this plan, and the results record is
written: what shipped, CI evidence per platform, deviations, open risks.
**In scope**: `dsh-qt-app/docs/test-records/`.
**Acceptance**: review verdict `pass` with findings closed; `docs/test-records/phase-2-results.md`
contains commit hashes, run URLs, per-platform conclusions, resource limits, and the
deviations list; `docs/PHASE-2-PLAN.md` is updated to mark each task's final state.
**Verify**: `grep -q 'actions/runs' dsh-qt-app/docs/test-records/phase-2-results.md` + review pass.
**Estimate**: 0.5 d.

**Total**: 21.5 developer-days of work, ~12 days on the critical path with the three tracks
running in parallel (Markdown 9, Theme 3.5, Settings 5, Integration 4).

---

## 5. Definition of done for Phase 2

A build from `dev/phase-2` satisfies all of:

1. An assistant reply containing headings, lists, a table, inline code and a fenced code block
   renders correctly in both light and dark themes, with syntax highlighting on.
2. Theme switching and font scaling apply live and survive a restart.
3. The settings panel edits every schema field, validates inline, persists atomically, and
   hosts plugin-contributed sections.
4. Streaming replies render incrementally without flicker and keep the UI at ≥60 fps
   (tick p95 < 16 ms) for a 500-chunk message.
5. Removing the native module leaves the app usable (plain-text markdown + no highlighting),
   with a single warning in the log.
6. `qml lint`, `qml tests`, `typecheck` and unit tests are green on ubuntu-22.04 and
   windows-2022; macOS remains an accepted, documented gap.

---

## 6. Risks and blockers

| # | Risk | Impact | Mitigation |
| --- | --- | --- | --- |
| R1 | **No macOS runner** — `macos-14` jobs are cancelled with `The configuration 'macos-14-arm64-us-default' is not supported`; `macos-13` queues forever | macOS stays unvalidated for Phase 2 as well | Keep the matrix entry so the gap is visible; treat macOS as an accepted deviation in the Phase 2 record; re-run when a macOS-capable runner exists. Do not let it block t23 |
| R2 | **cmark-gfm native build** across platforms (node-gyp toolchain, headers, prebuilds) | t11 slips, blocking t12/t13/t14 | Land the pure-TS fallback (t10) first so QML work never waits; build the native job early on both OSes; pin cmark-gfm and node-addon-api versions; ship prebuilds for the CI targets |
| R3 | **QML rich text is not HTML** — no CSS, limited inline layout | Markdown fidelity below the WebUI | AST → component tree (never HTML strings); define the supported subset in t10 and render unknown nodes as escaped text; explicitly out-of-scope: nested tables, footnotes, math, embedded HTML |
| R4 | **Syntax highlighting cost** (Shiki is heavy: grammars + themes) | Startup latency, memory > 150 MB target | Load grammars lazily on first use; `maxHighlightChars` guard; plain-text fallback; measure in t22 |
| R5 | **Theme refactor touches every component** | Regression across all existing QML tests | t15 keeps a token-parity test, t16 keeps the 24 existing tests green as the gate; no component may own a palette after t16 |
| R6 | **Settings persistence** (atomic write, schema drift, secrets) | Corrupted config or leaked API key | Atomic rename + `.bak` recovery; `schemaVersion` migration; `apiKeyRef` only, secret-grep test in t18 |
| R7 | **No local Qt** (team policy: no local C++ builds) | QML/native bugs surface only in CI, slower loops | Keep every change CI-verifiable; add the `native` job in t22 early; keep suites small and fast (<5 min) |
| R8 | **Bridge throughput** under streaming bursts | Dropped messages, UI stutter | t21 exercises a 5 000-message burst and asserts the drop counter stays 0; bounded queue already exists in `src/event-loop/timer.ts` |
| R9 | **Scope creep** toward plugin management (Phase 3) | Phase 2 does not converge | Non-goals in §1 are contractual; plugin work limited to the `settings.section` slot host in t20 |

Open decisions for the reviewer:

- **D1**: Shiki vs highlight.js for t13 — Shiki matches the WebUI exactly but costs memory;
  highlight.js is lighter with lower fidelity. Recommendation: Shiki, lazily loaded, with the
  size guard (R4).
- **D2**: settings dialog vs settings page — dialog is simpler, page scales better with plugin
  sections. Recommendation: modal pane (t19) that can be promoted to a page later.
- **D3**: whether `apiKeyRef` should support an OS keyring in Phase 2 or only env-var
  references. Recommendation: env-var references only; keyring in Phase 4.

---

## 7. Verification of this plan

Acyclicity, ordering and the critical path were checked mechanically, by parsing the §2 edge
table straight out of this file (script kept verbatim in §7.1 so the check is reproducible,
not a claim):

```text
$ node /tmp/dag-check.mjs dsh-qt-app/docs/PHASE-2-PLAN.md
file:        dsh-qt-app/docs/PHASE-2-PLAN.md
tasks:       14 (t10..t23)
edges:       16
entry tasks: t10 t15 t18
topological: t10 t11 t12 t13 t14 t15 t16 t17 t18 t19 t20 t21 t22 t23
cycle check: none
critical:    t10 -> t11 -> t12 -> t14 -> t21 -> t22 -> t23 (7 tasks)
monotone:    yes (every edge low-id -> high-id)
errors:      none
exit=0
```

What that establishes: all 16 declared dependencies resolve to tasks in the phase, no task
depends on itself, no duplicate edges, a complete topological order exists (`cycle check:
none`), and the three entry tasks (`t10`, `t15`, `t18`) are exactly the ones with no
predecessor. The "monotone" line means every edge points from a lower id to a higher id, which
is why the order above is also a valid implementation order.

**Not yet established**, and this is the part the reviewer should verify last: the plan defines
the graph, but the graph does not exist in team state until the captain creates `t10`–`t23`.
The acceptance criterion "dependency graph verified acyclic with `agent_teams_status`" can only
be satisfied **after** creation, by running `agent_teams_status` and confirming (a) every task
reports the dependencies in §2 and (b) the task list shows no cycle. Until then this document
is the only source of truth for the edges.

### 7.1 The check script

Verbatim source of the run above (dependency-free Node ESM; it parses §2 out of this very
file, so re-running it after any edit re-validates the graph rather than trusting this prose):

```js
// Mechanical check of the Phase 2 task graph declared in docs/PHASE-2-PLAN.md §2.
// Usage: node /tmp/dag-check.mjs dsh-qt-app/docs/PHASE-2-PLAN.md
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? 'dsh-qt-app/docs/PHASE-2-PLAN.md'
const text = readFileSync(file, 'utf8')

// Take the first markdown table after the "Edge list" heading.
const section = text.split('Edge list (every edge is "must finish before"):')[1]
if (!section) throw new Error('edge list heading not found')
const rows = section
  .split('\n')
  .filter((l) => l.startsWith('|') && !/^\|\s*-+/.test(l) && !/^\|\s*Task\s*\|/.test(l))

const deps = new Map()
for (const row of rows) {
  const cells = row.split('|').slice(1, -1).map((c) => c.trim())
  if (cells.length < 2) continue
  const id = cells[0].match(/^t\d+/)?.[0]
  if (!id) continue
  const cell = cells[1]
  const list = cell === '—' || cell === '' ? [] : [...cell.matchAll(/t\d+/g)].map((m) => m[0])
  deps.set(id, list)
}

const ids = [...deps.keys()]
const errors = []

// 1. every dependency must exist
for (const [id, list] of deps) {
  for (const d of list) {
    if (!deps.has(d)) errors.push(`${id} depends on unknown task ${d}`)
    if (d === id) errors.push(`${id} depends on itself`)
  }
}
// 2. duplicates
for (const [id, list] of deps) {
  if (new Set(list).size !== list.length) errors.push(`${id} lists a duplicate dependency`)
}

// 3. Kahn topological sort
const indeg = new Map(ids.map((id) => [id, 0]))
for (const [, list] of deps) for (const d of list) indeg.set(d, (indeg.get(d) ?? 0) + 1)
// indeg counts dependents; build reverse adjacency for topo order (deps first)
const children = new Map(ids.map((id) => [id, []])) // dep -> [task]
const work = new Map(ids.map((id) => [id, 0]))
for (const [id, list] of deps) {
  work.set(id, list.length)
  for (const d of list) children.get(d).push(id)
}
const queue = ids.filter((id) => work.get(id) === 0).sort()
const order = []
while (queue.length) {
  const id = queue.shift()
  order.push(id)
  for (const c of children.get(id)) {
    work.set(c, work.get(c) - 1)
    if (work.get(c) === 0) {
      // insert keeping numeric order for determinism
      const idx = queue.findIndex((q) => Number(q.slice(1)) > Number(c.slice(1)))
      if (idx === -1) queue.push(c)
      else queue.splice(idx, 0, c)
    }
  }
}
const cyclic = order.length !== ids.length
if (cyclic) {
  const stuck = ids.filter((id) => !order.includes(id))
  errors.push(`cycle detected among: ${stuck.join(', ')}`)
}

// 4. longest path (critical path) in task count
const memo = new Map()
const longest = (id, seen = new Set()) => {
  if (seen.has(id)) return 0
  if (memo.has(id)) return memo.get(id)
  const list = deps.get(id) ?? []
  const best = list.length === 0 ? 0 : Math.max(...list.map((d) => longest(d, new Set([...seen, id]))))
  const v = best + 1
  memo.set(id, v)
  return v
}
const lens = ids.map((id) => [id, longest(id)])
const maxLen = Math.max(...lens.map(([, v]) => v))
// reconstruct one critical path
let cursor = lens.find(([, v]) => v === maxLen)[0]
const path = [cursor]
while ((deps.get(cursor) ?? []).length) {
  const list = deps.get(cursor)
  cursor = list.reduce((a, b) => (longest(a) >= longest(b) ? a : b))
  path.push(cursor)
}
path.reverse()

// 5. edges all point "forward" (informational)
const forward = [...deps].every(([id, list]) => list.every((d) => Number(d.slice(1)) < Number(id.slice(1))))

console.log(`file:        ${file}`)
console.log(`tasks:       ${ids.length} (${ids[0]}..${ids[ids.length - 1]})`)
console.log(`edges:       ${ids.reduce((n, id) => n + deps.get(id).length, 0)}`)
console.log(`entry tasks: ${ids.filter((id) => deps.get(id).length === 0).join(' ')}`)
console.log(`topological: ${order.join(' ')}`)
console.log(`cycle check: ${cyclic ? 'CYCLE' : 'none'}`)
console.log(`critical:    ${path.join(' -> ')} (${maxLen} tasks)`)
console.log(`monotone:    ${forward ? 'yes (every edge low-id -> high-id)' : 'no'}`)
console.log(`errors:      ${errors.length === 0 ? 'none' : JSON.stringify(errors, null, 2)}`)
process.exit(errors.length === 0 ? 0 : 1)
```

It is not committed under `scripts/` because `docs/` is the only path in t6's scope; adding it
as `dsh-qt-app/scripts/check-task-graph.mjs` with a CI call is t22's work (CI extension).

### 7.2 Id range deviation (explicit)

The t6 acceptance text asks for "task IDs created as t6–t20". That range cannot be honoured:
`t6` is this planning task itself, and `t7`/`t8`/`t9` are the already-completed Phase 1
interim review (`t7`), final review (`t8`) and closeout (`t9`). Creating `t7`–`t9` is
impossible without destroying completed gate records, so the phase's 14 implementation tasks
take the next free ids, **`t10`–`t23`**. The intended invariant — "14 tasks, contiguous ids,
`t6` is the plan, the rest are implementation" — is preserved; only the offsets moved by 3.
See §9 for the mapping.

---

## 8. Sign-off

| Role | Person | Statement | State |
| --- | --- | --- | --- |
| Author | dev-qiu (t6) | Plan written and revised to revision 4; interfaces, task contracts, risks and the DAG above are what the phase will be implemented against | signed |
| Reviewer | reviewer-glm5 | Plan is implementable, risks are acceptable, task graph is acyclic and complete | **signed — `APPROVED`** on commit `7dcaccb`, 2026-11-22 |

### 8.1 The approval, and what it covers

reviewer-glm5 approved commit `7dcaccb` (this document at revision 4) with the GitHub comment
`APPROVED — Phase 2 Core UI plan (settings · theme · Markdown), commit 7dcaccb, revision 4`,
after independently re-running the §7.1 script against that commit (14 tasks, 16 edges, cycle
check none, same critical path) and reviewing §3/§4/§6 against the Phase 1 record. The
rulings, which are now decisions of record:

- **Id range**: t10–t23 accepted (§7.2). The "t6–t20" wording in the t6 acceptance criterion
  predates the Phase 1 gates that consumed t7–t9; no change required.
- **Decomposition**: keep 14 tasks / ~21.5 dev-days. The settings track is explicitly **not**
  to be merged — t18 is pure-TS and unit-testable, t19/t20 are CI-only QML verification, and
  merging them would mix both in one contract and invent a theme↔settings dependency.
- **D1** Shiki, lazily loaded, behind `maxHighlightChars` (accepted).
- **D2** modal settings pane in t19, promotable to a page later (accepted).
- **D3** `apiKeyRef` env-var references only in Phase 2, OS keyring in Phase 4 (accepted).

Conditions carried into the phase (non-blocking for the sign-off): the captain must run
`agent_teams_status` after creating t10–t23 to confirm the edges and acyclicity in team state;
t22 must confirm the existing `GLOB_RECURSE` in `qt_add_resources` picks up the new
`qml/markdown/` and `qml/views/settings/` trees (it will — `CONFIGURE_DEPENDS` over `qml/*.qml`)
rather than re-adding them by hand, since the qmltestrunner job and the lint glob already exist
from Phase 1 t4; macOS stays an accepted gap (R1).

Post-approval edit note: the only content change after `7dcaccb` is this §8 recording plus a
correction in §1/§4 — the token count said 30, the file actually declares 27. The reviewer's
verdict covers the plan's structure, which this does not alter.

Sign-off procedure: reviewer-glm5 comments on the commit that adds/updates this file
(`lbn2011/dsh-qt-app@dev/phase-1`, `dsh-qt-app/docs/PHASE-2-PLAN.md`; the commit is the
`git log -1 -- dsh-qt-app/docs/PHASE-2-PLAN.md` of that branch) with either `APPROVED` plus
any findings, or the required changes. The captain then creates `t10`–`t23` from §9 and
Phase 2 implementation starts at `t10`/`t15`/`t18` in parallel.

Known limitations of this plan, for the reviewer to weigh rather than discover:

- The graph is verified mechanically as a **document** (§7). It is not yet verifiable with
  `agent_teams_status`, because the tasks do not exist until the captain creates them. The
  post-creation check is a required step of t23, not of this task.
- QML and native correctness is unexecuted locally by team policy (no local Qt): every
  acceptance criterion above is written to be checkable in CI, not by hand on a laptop.
- macOS is an accepted, documented gap (R1); the plan deliberately does not promise it.

---

## 9. Task records for the captain

Only the captain can create tasks, so this section is the exact payload. Create these 14
records, with these dependency edges and no others; `t10`, `t15` and `t18` have no
predecessors and may start on day one.

| Id | Kind | Title | Depends on | In scope |
| --- | --- | --- | --- | --- |
| t10 | work | Phase 2a: Markdown AST contract and pure-TS fallback parser | — | `dsh-qt-app/src/markdown/`, `dsh-qt-app/tests/` |
| t11 | work | Phase 2b: cmark-gfm N-API binding (`dsh-qt-napi`) | t10 | `dsh-qt-napi/` |
| t12 | work | Phase 2c: QML markdown component tree | t10, t11 | `dsh-qt-app/qml/markdown/`, `dsh-qt-app/tests/qml/` |
| t13 | work | Phase 2d: Code blocks with syntax highlighting | t12 | `dsh-qt-app/qml/markdown/CodeBlock.qml`, `dsh-qt-app/src/highlight/`, `dsh-qt-app/tests/` |
| t14 | work | Phase 2e: Streaming-safe incremental rendering | t12 | `dsh-qt-app/src/markdown/streaming.ts`, `dsh-qt-app/qml/markdown/`, `dsh-qt-app/tests/` |
| t15 | work | Phase 2f: Theme token schema and `ThemeManager` | — | `dsh-qt-app/src/theme/`, `dsh-qt-app/tests/` |
| t16 | work | Phase 2g: QML theming refactor (light/dark, font scale) | t15 | `dsh-qt-app/qml/`, `dsh-qt-app/native/main.cpp` |
| t17 | work | Phase 2h: Theme settings UI and live switching | t16 | `dsh-qt-app/qml/views/settings/ThemeSettings.qml`, `dsh-qt-app/tests/qml/` |
| t18 | work | Phase 2i: Settings store, schema and persistence | — | `dsh-qt-app/src/settings/`, `dsh-qt-app/tests/` |
| t19 | work | Phase 2j: Settings panel shell | t16, t18 | `dsh-qt-app/qml/views/settings/`, `dsh-qt-app/qml/views/SessionHeader.qml`, `dsh-qt-app/tests/qml/` |
| t20 | work | Phase 2k: Settings forms and plugin slot host | t19 | `dsh-qt-app/qml/views/settings/`, `dsh-qt-app/src/settings/`, `dsh-qt-app/tests/` |
| t21 | work | Phase 2l: Node↔QML wiring over the event-loop bridge | t14, t17, t20 | `dsh-qt-app/qml/main.qml`, `dsh-qt-app/src/bridge/`, `dsh-qt-app/native/main.cpp`, `dsh-qt-app/tests/` |
| t22 | work | Phase 2m: CI and packaging extension | t13, t21 | `dsh-qt-app/.github/workflows/`, `dsh-qt-app/docs/ci.md`, `dsh-qt-app/CMakeLists.txt` |
| t23 | review | Phase 2 review gate and results record | t22 | `dsh-qt-app/docs/test-records/` |

Notes for creation:

1. **`t23` must be created as a `review` kind and assigned to reviewer-glm5**, not as `work`:
   it is the phase gate, and the developer must not review their own phase.
2. Objective and acceptance text per task are §4 above; paste §4's "Acceptance" and "Verify"
   for each task so the reviewer has a contract to check against.
3. The ids follow the free range, not the `t6`–`t20` wording in the t6 acceptance criterion;
   see §7.2. Mapping from the earlier draft: 7→10, 8→11, 9→12, 10→13, 11→14, 12→15, 13→16,
   14→17, 15→18, 16→19, 17→20, 18→21, 19→22, 20→23.
4. After creation, run `agent_teams_status` and confirm the 16 edges in §2 appear exactly once
   each and the list reports no cycle. If any mismatch appears, correct the task records
   rather than this document.
5. Phase 1 leftovers are **already closed** by t4, contrary to §4's original wording: `CMakeLists.txt`
   registers `qml/*.qml` via `file(GLOB_RECURSE ... CONFIGURE_DEPENDS)`, and `test.yml` has a
   `qml-tests` job running `qmltestrunner -input tests/qml -import qml` plus a `qml-lint` job
   covering the whole tree. So `t22` must **not** re-add either; it only has to confirm the
   GLOB still matches the new `qml/markdown/` and `qml/views/settings/` trees and cover the
   genuinely new pieces: the `native` job building `dsh-qt-napi`, artifact staging of the
   native module, the settings/theme persistence tests on the TS side, and `docs/ci.md`.
