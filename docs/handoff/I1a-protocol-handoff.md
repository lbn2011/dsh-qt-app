# Handoff — I1a protocol v1 (for I1b, I1c, I2–I5)

Source of truth: `docs/PHASE-3-IMPLEMENTATION-PLAN.md` §3.1/§3.3/§3.4 @ `62a9812`.
Module: `src/bridge/protocol.ts`, re-exported from `src/bridge/index.ts`.
Status: types + framing only. No transport, no spawn, no method implementations.

## Import rules

Use `import type` for envelopes; do **not** redeclare frame shapes anywhere else.

```ts
import {
  NdjsonDecoder,
  encodeFrame,
  makeError,
  PROTOCOL_VERSION,
  type Envelope,
  type EvtFrame,
  type HelloAckFrame,
  type HelloFrame,
  type ReqFrame,
  type ResErrFrame,
  type ResFrame,
  type ResOkFrame,
} from '../bridge/protocol.js'
```

Relative imports keep the `.js` extension (ESM, `module: NodeNext`).

## Writing frames (Node host → Qt)

```ts
const encoded = encodeFrame(frame)      // validates, rejects > 8 MiB, single line
if (!encoded.ok) return encoded.error   // ProtocolError {code,message,retryable?}
process.stdout.write(encoded.line + '\n')
```

Buffering/backpressure is the transport's job (I1b); this module only validates and
serialises one frame. `encodeFrame` refuses to emit an unknown `kind` (`bad-params`).

## Reading frames (Qt → Node host)

```ts
const decoder = new NdjsonDecoder({ maxFrameBytes: 4 * 1024 * 1024 }) // default
onData((chunk) => {
  const { frames, errors, ignored } = decoder.push(chunk) // string | Uint8Array
  for (const error of errors) { /* protocol/bad-params: log; decide disconnect */ }
  for (const frame of frames) dispatch(frame)
})
onEnd(() => { const tail = decoder.end(); /* truncated frame → protocol error */ })
```

- Unterminated tail is buffered; `bufferedBytes` exposes its size (for watermarks/logs).
- An oversized line yields one `protocol` error and the decoder resynchronises at the next
  newline — do not kill the process for it unless policy says so.
- Unknown `kind` is counted in `ignored` and never dispatched, never answered.

## Code and error policy

`PROTOCOL_ERRORS` (14 literals): `unknown-method`, `bad-params`, `unavailable`, `busy`,
`timeout`, `refused`, `internal`, `not-found`, `conflict`, `unsupported`, `cancelled`,
`duplicate-id`, `protocol`, `SETTINGS_CONFLICT`.
`RpcErrorCode` additionally allows the pass-through form `ManagementError.<code>`.

Classification pinned by tests: missing `v` → `bad-params` (legacy flat frames);
present-but-other `v` → `protocol`; malformed JSON / missing id → `bad-params`.

## Not implemented here (owners downstream)

- Handshake state machine, `epoch`/`seq` dedupe, pending map, timeouts, cancel, dispose →
  I1b (`src/host/*`) on the Node side, I1c in `native/main.cpp`.
- `req`/`res` correlation and the "exactly one reply" rule → I1b.
- Method payload schemas (`tool.row`, `settings.describe`, …) → I2–I5; they import these
  envelopes and freeze their own payload types in their own modules.

## Verification protocol for later tasks (shared, reusable)

Heavy commands (install, test, typecheck, cmake) must run serialised:

```sh
flock -w 900 -x /data/qt-phase3/logs/verify.lock -c \
  'systemd-run --scope -p CPUQuota=200% -p MemoryMax=4G --quiet <cmd>'
```

Notes: `systemd-run --scope` cannot be combined with `--wait`; `/usr/bin/time` is not
installed; `pnpm test` cannot be filtered by appending a path (the npm script carries
`tests/*.test.ts`) — use `pnpm exec tsx --test <file...>`. Logs go to
`docs/test-records/<task>-<phase>.log` with the real exit code recorded next to them.