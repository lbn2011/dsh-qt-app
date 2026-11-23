# I3 handoff — settings / models / credentials

Task t19 (Phase 3, task I3). Worktree `/data/qt-phase3/app/wt/settings-llm`,
branch `phase3/settings-llm`, merged t17's reviewed host bridge
(`1beba7de40e4957b08e1b45107f12998918d1c25`) before starting.

This note is for **qiu-host**, who is the single writer of the shared files this
task must not touch (`src/index.ts`, `qml/main.qml`,
`qml/views/settings/SettingsPanel.qml`). Everything else listed here is new and
owned by settings-llm.

## 1. What was added

| File | Role |
|---|---|
| `src/bridge/settings-rpc.ts` | `settings.describe` / `settings.mutate` over the official `ctx.settings` (`SettingsForms`) |
| `src/llm/directory.ts` | merges `listProviders()` with `listConfigurableProviders()` into one view |
| `src/llm/operations.ts` | `llm.providers.list`, `llm.models.discover` (+ cancel), `llm.default.get/set` |
| `src/credentials/rpc.ts` | `cred.describe` / `cred.set` / `cred.unset` / `cred.list` over the official `CredentialProvider` |
| `qml/views/settings/SettingsBridge.qml` | QML side of the native `request`/`requestReplied` correlation |
| `qml/views/settings/ModelsForm.qml` | provider directory, cancellable discovery, default-model selection |
| `qml/views/settings/ApiKeyField.qml` | write-only credential row (draft cleared after save) |
| `tests/settings-rpc.test.ts` | 14 cases |
| `tests/llm-operations.test.ts` | 17 cases |

Public surface (all re-exported from their modules, no side effects at import):

```ts
createSettingsRpc({ settings?: SettingsServiceLike, logger? }): SettingsRpc
registerSettingsMethods(registrar: MethodRegistrar, deps: SettingsRpcDeps): Array<() => void>

createLlmDirectory(llm: LlmServiceLike): LlmDirectory          // .providers()
createLlmOperations({ llm?, defaultModel?, logger? }): LlmOperations
registerLlmMethods(registrar, deps: LlmOperationsDeps): Array<() => void>

createCredentialsRpc({ credentials?: CredentialsServiceLike, logger? }): CredentialsRpc
registerCredentialMethods(registrar, deps: CredentialsRpcDeps): Array<() => void>
```

`MethodRegistrar.register(method, handler)` is structurally the same signature as
`HostBridgeService.register`, so the host service can be passed directly.

## 2. Method contract

Registered names:

| Method | Params | Result |
|---|---|---|
| `settings.describe` | `{ ns?: string }` | `{ revision: number, namespaces: [{ ns, autoGenerate, revision, applies, value, secrets }] }` |
| `settings.mutate` | `{ ns, ops: Array<{op:'set'|'unset', path: string[], value?}>, expectedRevision? }` | `{ ns, revision, applied: true }` |
| `llm.providers.list` | `{}` | `{ providers: [{ id, name, configurable, settingsNs, settingsPath }] }` |
| `llm.models.discover` | `{ settingsNs, provider?, baseURL?, api?, apiKey?, operationId? }` | `{ operationId, models: [{ id, name?, contextWindow?, maxTokens?, inputModalities? }] }` |
| `llm.models.cancel` | `{ operationId }` | `{ operationId, cancelled: boolean }` |
| `llm.default.get` | `{}` | `{ selection: { provider, model, reasoningEffort? }, applied: true }` |
| `llm.default.set` | `{ provider, model, reasoningEffort? }` | `{ selection, applied: true }` |
| `cred.describe` | `{ ref }` | `{ ref, configured, source: string \| null, writable }` |
| `cred.set` | `{ ref, value }` | `{ ref, configured: true, writable }` |
| `cred.unset` | `{ ref }` | `{ ref, configured: false, writable }` |
| `cred.list` | `{}` | `{ records: [{ key, scope, id, kind }] }` |

Errors use the closed 14-code vocabulary from `src/bridge/protocol.ts`
(`bad-params`, `unavailable`, `conflict`, `refused`, `busy`, `duplicate-id`,
`cancelled`, `unsupported`, `internal`, …). `SETTINGS_CONFLICT` from the official
service is mapped to `conflict` with `details = { namespace, expected, actual }`.

Hard rules enforced in code:

* `settings.mutate` accepts **only** path operations. `replace`/`update` are
  rejected as `bad-params`; the descriptor projection has no `update`/`replace`
  handle at all (`SettingsServiceLike` only declares `describe` and `mutate`).
* Every `settings.describe` calls `describe({ redactSecrets: true })` itself and
  then additionally deletes the values at each `descriptor.secrets[].path`;
  `schema` is not shipped because schemastery objects are not JSON-safe.
* `cred.*` never returns a value: `CredentialStatus` has no value slot, and the
  draft given to `cred.set` is only a local variable. Error messages are scrubbed
  of the draft before leaving the module.
* `llm.models.discover` races the provider call against an abort promise, so a
  cancel settles **immediately** even if the provider ignores its signal; a late
  success is still reported as `cancelled`. An `apiKey` is single-use, never
  stored in the registry, never logged, and is scrubbed (`[redacted]`) from
  provider error text.
* `llm.default.*` uses `ctx.agentDefaultModel` (`currentSelection` /
  `saveSelection`), not a settings namespace. When the profile mounts no
  configuration editor the official `saveSelection` returns silently, so the
  method re-reads the selection and reports `unsupported` if the value did not
  change.

## 3. Wiring instructions for qiu-host (shared files)

1. `src/index.ts` — in `apply`, after the host bridge is constructed:

   ```ts
   import { createSettingsRpc, registerSettingsMethods } from './bridge/settings-rpc.js'
   import { createLlmOperations, registerLlmMethods } from './llm/operations.js'
   import { createCredentialsRpc, registerCredentialMethods } from './credentials/rpc.js'

   const settingsRpc = createSettingsRpc({ settings: ctx.settings as never, logger })
   const llmOps = createLlmOperations({ llm: ctx.llm, defaultModel: ctx.agentDefaultModel, logger })
   const credRpc = createCredentialsRpc({ credentials: ctx.credentialsProvider /* see note */, logger })

   ctx.effect(() => {
     const disposers = [
       ...registerSettingsMethods(host, { settings: ctx.settings }),
       ...registerLlmMethods(host, { llm }, { defaultModel }),
       ...registerCredentialMethods(host, { credentials }),
     ]
     return () => disposers.forEach((d) => d())
   }, 'dsh-qt-app: settings/llm/credential methods')
   ```

   Notes: use the **registrar form** with the real services; do not pass
   `undefined` and hope — the modules then answer `unavailable` (that is the
   tested degradation path). `ctx.credentials` in 0.2.2-rc.1 is the
   `CredentialProvider` instance; confirm the property name against the installed
   `.d.ts` at wiring time and type it through `CredentialsServiceLike`.
2. `qml/main.qml` — replace the `readonly property var settingsBridge: null`
   placeholder with:

   ```qml
   SettingsBridge { id: settingsBridge; host: dshQt }   // dshQt is the ctx.host object
   readonly property var settingsBridgeRef: settingsBridge
   ```

   and pass `settingsBridgeRef` where `settingsBridge: window.settingsBridge` is
   already consumed (`SettingsPanel`). Keep `host` as the native object; the
   bridge only needs `request`, `cancelRequest` and the `requestReplied` signal.
3. `SettingsPanel.qml` — add a Models entry/tab that instantiates
   `ModelsForm { settingsBridge: root.settingsBridge }`. `SettingsPanel` is a
   single-writer file; the exact placement is left to qiu-host.
4. Credentials UI: `ApiKeyField` needs a `credentialRef` the host publishes (the
   environment-style name, e.g. `DEEPSEEK_API_KEY`). No official mapping from a
   provider to a credential ref is exposed in 0.2.2-rc.1; do **not** invent one.
   Wire the field only where the integration can name the ref, otherwise leave it
   hidden (`credentialRef: ""` hides it).

## 4. QML component notes

* `SettingsBridge` exposes `describe(namespace?, cb)`, `mutate(ns, ops,
  expectedRevision, cb)`, `loadProviders(cb)`, `discover(params, cb)`,
  `cancelDiscover(operationId, cb)`, `loadDefault(cb)`, `saveDefault(selection,
  cb)`, `describeCredential(ref, cb)`, `setCredential(ref, value, cb)`,
  `unsetCredential(ref, cb)`, `listCredentials(cb)`, `cancel(id)`, `cancelAll()`.
  Callbacks are `(ok, result, error)` and run exactly once; a reply for an id
  nobody waits for is dropped silently.
* `ModelsForm` names its own discovery operation (`qml-discover-N`) so Cancel can
  address it before the result exists; the discovery key draft is cleared when
  the call settles, on success and failure alike.
* `ApiKeyField` never pre-fills from the host, clears its draft after save
  (even on failure), and only renders `configured`/`source`/`writable`.

## 5. Verification (actual, this worktree)

Command wrappers: `flock -w 900 -x /data/qt-phase3/logs/verify.lock -c
'systemd-run --scope -p CPUQuota=200% -p MemoryMax=4G --quiet …'`.

| Command | Exit | Evidence |
|---|---|---|
| `pnpm typecheck` | 0 | `logs/i3-typecheck-final.log` (`tsc -p tsconfig.test.json`, no diagnostics) |
| `pnpm exec tsx --test --test-reporter=tap tests/settings-rpc.test.ts tests/llm-operations.test.ts` | 0 | 31 tests / 31 pass / 0 fail, `logs/i3-tests-final.log` |
| `qmllint` on the three components | 0 | `logs/i3-qmllint.log` |
| `QT_QPA_PLATFORM=offscreen qmltestrunner -input tests/qml/tst_settingsbridge.qml` (local pre-commit check, file **not shipped**: `tests/qml/` is outside this task's declared scope) | 0 | 9 passed / 0 failed (incl. setup/teardown), `logs/i3-qml-tests.log` |

## 6. Boundaries and follow-ups

* No real credential was read, written or listed. Tests use the sentinels
  `sk-live-THIS-MUST-NEVER-ESCAPE-9f3a` and `sk-live-DISCOVERY-ONLY-4c7b`
  against fakes only; the scan boundary for secret leakage is the JSON returned
  by each method, the callback arguments, `lastError`, and the recording logger.
* Linux-only validation (Qt 6.8.2, node v26.13.1). Windows/macOS not built or
  run; nothing here is platform-specific, but that is a report, not a proof.
* The Models page was not mounted into the real window (that needs the shared
  files above); t26/t27 own the real-profile QML event chain.
* `settings.flush` / `settings.changed` are not implemented: the official service
  exposes neither a flush nor a change event in 0.2.2-rc.1. Do not fake them; a
  future version can add them behind the same registrar.