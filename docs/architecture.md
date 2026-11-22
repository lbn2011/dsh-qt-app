# Architecture (phase 1a skeleton)

`dsh-qt-app` is one Cordis plugin with two halves that live in one process:

```
┌──────────────────────────── DSH process ─────────────────────────────┐
│                                                                      │
│  Cordis runtime (Node, ESM)                                          │
│    ├─ src/index.ts          plugin entry: name / inject / apply       │
│    ├─ src/constants.ts      shared constants                          │
│    │        ⋮  (phase 1b: renderer/, qt-bridge/, event-loop/)         │
│    │                                                                  │
│    └── 10 ms libuv timer ──► message queue ──► N-API bridge (C++)     │
│                                                    │                  │
│  Qt 6 host (C++, native/main.cpp)                  │                  │
│    ├─ QGuiApplication + QQmlApplicationEngine ◄────┘                  │
│    ├─ context property `dshQt` (from qml/config.h)                    │
│    └─ qrc:/qml/main.qml  (qml/**, embedded by qt_add_resources)       │
└──────────────────────────────────────────────────────────────────────┘
```

## Layer responsibilities

| Layer | Path | Responsibility |
| --- | --- | --- |
| Plugin | `src/index.ts` | Cordis entry point; registers the Qt renderer service and slot adapters in later phases |
| Constants | `src/constants.ts` | Values mirrored by `qml/config.h` (tick, N-API names, window defaults, native slot surfaces) |
| Host | `native/main.cpp` | Creates the Qt application, publishes `dshQt`, loads the QML entry point; never starts a second event loop |
| UI | `qml/main.qml` | `ApplicationWindow` skeleton (1280x800); split into views/models/components in phase 1c |
| Build config | `CMakeLists.txt`, `tsconfig*.json` | Qt 6.5+/CMake 3.21+ and Node >= 22.19 / ESM toolchain |

## Invariants

1. **Single event loop owner.** Node owns the libuv loop, Qt owns its main
   thread; cross-thread work only crosses the 10 ms message queue. No blocking
   call may be made from the Qt main thread into Node.
2. **Constant mirroring.** `src/constants.ts` and `qml/config.h` carry the same
   values (`DSH_QT_EVENT_LOOP_TICK_MS` ↔ `EVENT_LOOP_TICK_MS`, etc.). Change
   both in the same commit; the unit tests in `tests/skeleton.test.ts` pin the
   TS side, `native/main.cpp` compiles the C++ side.
3. **No DOM assumptions.** Anything that needs `document`/`window` is routed to
   the WebView fallback (phase 3), never into the QML renderer.
4. **ESM only.** `@deepseek-ai/cordis` 4.x is `"type": "module"`, so this
   package is ESM too and relative imports carry the `.js` extension.

## Package contract

```ts
// src/index.ts
export const name = 'dsh-qt-app'
export const inject: string[] = []
export function apply(ctx: Context): void
export default { name, inject, apply }
```

`inject` stays empty in phase 1a so the skeleton loads standalone; later phases
inject `slots` and the client services they render.

## Related documents

- Design: `docs/superpowers/specs/2026-11-22-dsh-qt-profile-design.md`
- Implementation plan: `docs/superpowers/specs/2026-11-22-dsh-qt-implementation-plan.md`
- CI notes: [`ci.md`](ci.md)
