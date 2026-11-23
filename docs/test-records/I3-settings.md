# I3 test record — settings / models / credentials

Task t19. Worktree `/data/qt-phase3/app/wt/settings-llm`, base `33e516c`, with
t17's reviewed host bridge merged (`1beba7de…`). Linux x86_64, Qt 6.8.2,
node v26.13.1.

All heavy commands ran under the shared budget:
`flock -w 900 -x /data/qt-phase3/logs/verify.lock -c 'systemd-run --scope -p
CPUQuota=200% -p MemoryMax=4G --quiet <command>'`.

## Final results

| # | Command | Exit | Result | Log |
|---|---|---|---|---|
| 1 | `pnpm typecheck` | 0 | no diagnostics | `logs/i3-typecheck-final.log` |
| 2 | `pnpm exec tsx --test --test-reporter=tap tests/settings-rpc.test.ts tests/llm-operations.test.ts` | 0 | `# tests 31 / # pass 31 / # fail 0 / # cancelled 0 / # skipped 0` | `logs/i3-tests-final.log` |
| 3 | `qmllint -I qml` × 4 files | 0 | no warnings | `logs/i3-qmllint.log` |
| 4 | `QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input tests/qml/tst_settingsbridge.qml` — **local pre-commit check only; the file is not shipped because `tests/qml/` is outside this task's declared scope** | 0 | `Totals: 9 passed, 0 failed, 0 skipped` (7 test functions + setup/teardown) | `logs/i3-qml-tests.log` |

The `*.log` files are gitignored and stay on the development machine; this file
keeps the exit codes and the failure history.

## Failure history (kept deliberately)

1. **Harness serialization, not a test result.** The first two attempts to run
   the TS suites returned `Error: tool result must be losslessly JSON-serializable`
   from the shell tool: the default `tsx --test` reporter prints `✔`/`ℹ` glyphs
   and the tool result could not be serialized. Fixed by redirecting output to a
   log and reading only ASCII TAP summary lines
   (`--test-reporter=tap | grep -aE '^# (tests|pass|fail)'`). The suites were
   never marked green on the strength of that error.
2. **Real hang in `llm.models.discover`.** `two discoveries cannot share an
   operation id` hung for ~19 s: the cancel path aborted the `AbortSignal` and
   assumed the provider would settle, but a provider that ignores its signal
   leaves the promise pending forever. Fixed in `src/llm/operations.ts` with
   `abortRejection(signal)` and `Promise.race([discoverModels(...),
   aborted.promise])`, disposing the abort listener in `finally`. Cancel now
   settles immediately; a late success still resolves as `cancelled`.
3. **Test fixture bug.** `mutate forwards path operations…` expected the
   re-read revision to be 4, but the fake's descriptor list was empty, so the
   implementation correctly returned `null`. Fixed by seeding one descriptor.
4. **QML test isolation bug (local check).** Two cases failed with `busy` still
   true after a reply. Cause: `init()` reset the bridge's public state but not its
   private `_pending`/`_pendingCount`, so requests left in flight by earlier cases
   kept the counter non-zero. Fixed by clearing both in `init()`. The case file
   itself is not committed: `tests/qml/` is outside this task's declared scope, so
   only its log and this history remain.
5. **QML component defects found by `qmllint`, fixed before the final run:**
   a hand-written `signal providersChanged()` duplicated the auto-generated
   property notifier, and a bare `Connections` child is not allowed under
   `QtObject` (no default property). The bridge now relies on the property
   notifier and keeps its `Connections` in a named property.

## Coverage (by acceptance clause)

* **mutate + revision conflict.** Describe always requests redaction and the
  implementation additionally deletes `secrets[].path` values (sentinel never
  appears in the JSON). `mutate` forwards `ops` and `expectedRevision` verbatim,
  never calls `replace`/`update` (counters asserted at 0), maps
  `SettingsConflictError` to `conflict` with `{namespace, expected, actual}`,
  rejects `replace`/`update`/`delete` shapes as `bad-params`, refuses a read-only
  service with `refused` before touching it, and re-reads the namespace revision
  afterwards. Eleven malformed-input shapes are covered.
* **Cancellable discovery.** Signal is aborted, the call resolves `cancelled`
  immediately, a second cancel reports `cancelled: false`, a late provider
  success is still `cancelled`, a duplicate live `operationId` is
  `duplicate-id`, and provider errors are scrubbed of the one-shot key.
* **Default model.** `get` projects `currentSelection`; `set` validates, calls
  `saveSelection`, re-reads, and reports `unsupported` with
  `{requested, actual}` when the profile cannot persist; identical selections are
  a no-op; a missing service is `unavailable`.
* **API keys.** `cred.set`/`cred.unset` are the only writers; `cred.describe`
  returns configured/source/writable and has no value slot; the draft is a local
  variable, never logged (logger records the ref only), and scrubbed from error
  text. `cred.list` returns keys/kinds only.
* **Native forms.** `qmllint` is clean on all three shipped components. A local
  (pre-commit, not shipped) `tst_settingsbridge.qml` drove the bridge against a
  fake host and covered reply correlation, dropped late replies, cancel
  bookkeeping, one-shot discovery key pass-through with no retained copy,
  official method names and payloads for credential writes, mutate forwarding,
  and the no-host `unavailable` degradation; its log is in
  `logs/i3-qml-tests.log`.

## Secret-handling statement

No real credential store was read. `~/.dsh`, `~/.config` and the process
environment were not inspected for secrets. The only key-shaped strings in this
work are the two sentinels above; the assertion boundary is the serialized
method result, the callback arguments, the bridge's public properties
(`lastError` included), and the recording logger.

## Not validated here

Windows and macOS builds; mounting the Models page in the real window; a real
profile's settings document and credential provider. Those need the shared-file
wiring described in `docs/handoff/I3-settings.md` and belong to t26/t27.