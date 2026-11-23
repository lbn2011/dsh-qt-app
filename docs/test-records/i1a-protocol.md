# I1a test record — protocol v1 types and NDJSON framing

Task: t14 / I1a (owner host-architect-qiu). Worktree `/data/qt-phase3/app/wt/qiu-host`,
branch `phase3/host-qiu`, base `33e516c32856878c37f92ddbbada81f9e437f3ba`.
Contract: docs/PHASE-3-IMPLEMENTATION-PLAN.md §3.1/§3.3/§3.4 at `62a9812`.

## Commands, resource limits, results

All heavy commands ran serialised under the team-wide verification mutex and cgroup cap:

```
flock -w 900 -x /data/qt-phase3/logs/verify.lock -c \
  'systemd-run --scope -p CPUQuota=200% -p MemoryMax=4G --quiet <cmd>'
```

| # | Command | Exit | Evidence |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` (online; offline failed on missing `@esbuild/linux-arm64` metadata) | 0 | `i1a-install.log` — 14 packages, lockfile 40 entries |
| 2 | `pnpm exec tsx --test tests/protocol.test.ts` (red, before implementation) | 1 | `i1a-red.log` — `✖ tests/protocol.test.ts`, pass 0 / fail 1 (module not found) |
| 3 | intermediate run after first implementation | 1 | pass 15 / fail 3 (see history below); log overwritten by run 4 |
| 4 | `pnpm exec tsx --test tests/protocol.test.ts` (green, final) | 0 | `i1a-green.log` — tests 18 / pass 18 / fail 0 / duration_ms 169.3 |
| 5 | `pnpm typecheck` (`tsc -p tsconfig.test.json`) | 0 | `i1a-typecheck.log` — no diagnostics |

## Failure history (honest record)

Run 3 exposed three real problems, all fixed in-tree:

1. `legacy flat request frames are rejected` expected `bad-params`, got `protocol`.
   Decision: a frame with **no `v`** is malformed (`bad-params`); only a *present but
   different* `v` is an unsupported protocol version (`protocol`). Implementation fixed,
   test expectation kept.
2. `decoder stitches a frame split across chunks` produced 0 frames: `NdjsonDecoder.push`
   buffered the partial tail but never prepended it when the next chunk arrived. Fixed by
   merging `#buffer` into the input before scanning for `\n`.
3. `decoder resynchronises after an oversized frame` reported 2 errors: the test's
   `maxFrameBytes: 64` was smaller than a valid `req` line, so the following good frame was
   also rejected. Test-parameter bug; the limit is now derived from the encoded frame length
   (+16) so the test still proves resynchronisation.

Run 5 initially failed with a TypeScript widening error (`kind: string` in a spread-built
`evt`); fixed by annotating the fixture as `EvtFrame` before `encodeFrame`.

## What is covered

- request/hello/hello.ack/nack/res round-trip; exact byte identity of one line.
- legacy flat frame → `bad-params`; unknown `v` → `protocol`; unknown `kind` → ignored
  (`frame === undefined`, `ignored === true`, no reply).
- res without id, req with empty id / missing method, invalid JSON, non-object payload,
  evt with `seq` of -1 / 1.5 / "1" or missing epoch → `bad-params`.
- inbound > 4 MiB rejected with `protocol`; outbound > 8 MiB refused with `protocol`.
- multi-frame chunk ordering; half-frame stitching with `bufferedBytes` back to 0; truncated
  tail at `end()` reported once and never emitted; oversized line followed by an intact
  frame still delivered (resync); blank lines and CRLF tolerated.
- `PROTOCOL_ERRORS.length === 14`; `makeError` keeps `retryable` absent vs `true` distinct.

## Limits of this evidence

- Node-side only. The C++ mirror (I1c) and the real stdio transport (I1b) are **not**
  implemented or measured here; nothing here proves a handshake with a real Qt process.
- `pnpm install` needs network on a cold store; the offline path is not usable yet.
- macOS untouched (`gap(not-validated)`).