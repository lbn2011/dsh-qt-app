# Handoff — I5 on-demand WebUI fallback (for the host-integration task)

Source of truth: `docs/PHASE-3-IMPLEMENTATION-PLAN.md` §I5 @ `62a9812`.
Investigation record: `docs/PHASE-3-WEB-FALLBACK.md` (t5, line-number evidence).
Module: `src/webui/*`, `native/webview_host.{h,cc}`, `qml/views/WebFallbackPanel.qml`.
Status: Node lifecycle + native embed host + QML panel are implemented and tested.
**Not wired**: `CMakeLists.txt`, `native/main.cpp`, `src/index.ts` — those files are
single-writer (qiu-host), so the three edits below are handed over rather than made.

Everything here was verified against the installed host **0.2.2-rc.1**
(`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/…`).
Line numbers and export names are version-specific; re-check them if the host moves
to 0.2.3-alpha.2, which is what the plugin-kit baseline targets.

## 1. What the module owns

```
src/webui/types.ts        WebuiState/WebuiMode/WebuiStatus/WebuiBackend contracts, WebuiError
src/webui/token.ts        maskAuthenticatedUrl / maskTokenInText / containsRawToken
src/webui/process.ts      candidate B: `dsh web --host … --port 0 --no-open` child backend
src/webui/in-process.ts   candidate A: ctx.plugin() mount of the official web bundle
src/webui/service.ts      WebuiService (state machine, retry plan) + attachWebuiToHost()
src/webui/index.ts        re-exports
native/webview_host.h/.cc QWebEngine embedding, token stays in C++
qml/views/WebFallbackPanel.qml  renders state, forwards intent, never holds the URL
```

Method surface (`WEBUI_METHODS`): `webui.open` (20 s timeout), `webui.close`,
`webui.probe`, `webui.token`.

## 2. Node wiring — `src/index.ts`

```ts
import { WebuiService, attachWebuiToHost } from './webui/index.js'

// inside apply(), next to the existing host bridge effect:
const webui = new WebuiService(ctx, config.webui ?? {})
ctx.effect(() => {
  const detach = attachWebuiToHost(host, webui)
  return () => {
    detach()
    void webui.dispose()
  }
}, 'dsh-qt-app: webui fallback')
```

Notes:

- `attachWebuiToHost()` registers all four methods and forwards `webui.state` as an
  `evt` frame. Registering twice throws (`HostBridgeService.register` is strict), so
  mount it exactly once per bridge instance.
- `WebuiService` needs no config to be correct: defaults are
  `modePlan: ['in-process','in-process','child']`, `openTimeoutMs: 20000`,
  `readyTimeoutMs: 8000`, `backoffMs: [250, 750]`.
- In-process mounting reuses `ctx.credentials` when the host already provides it
  (`reusedCredentials: true`); it never registers a second credential provider.
- The service is **inert until `webui.open`**: mounting binds no socket and spawns no
  process (test `tests/webui-default-off.test.ts`, case 1, asserts this against
  `/proc`).

## 3. CMake wiring — `CMakeLists.txt`

`docs/test-records/i1b-i1c.md` already passes `-DDSH_QT_WEBENGINE=OFF` to `cmake`,
which today only produces an "unused variable" warning. Declaring the option here
keeps that flag meaningful instead of dead.

```cmake
# Optional: the fallback degrades to the browser hand-off without it.
option(DSH_QT_WEBENGINE "Build with QtWebEngine embedding (ships Chromium)" ON)
find_package(Qt6 QUIET OPTIONAL_COMPONENTS WebEngineQuick)
if(DSH_QT_WEBENGINE AND TARGET Qt6::WebEngineQuick)
  set(DSH_QT_HAS_WEBENGINE 1)
  target_link_libraries(dsh-qt-app PRIVATE Qt6::WebEngineQuick)
else()
  set(DSH_QT_HAS_WEBENGINE 0)
endif()
target_compile_definitions(dsh-qt-app PRIVATE DSH_QT_HAS_WEBENGINE=${DSH_QT_HAS_WEBENGINE})

target_sources(dsh-qt-app PRIVATE native/webview_host.h native/webview_host.cc)
```

- `native/webview_host.h/.cc` are already written to compile in **both** configurations;
  only the define differs. `native/webview_host.cc` was syntax-checked with
  `DSH_QT_HAS_WEBENGINE=0` against Qt 6.8.2 headers (see the test record).
- `DSH_QT_HAS_WEBENGINE=1` also needs `QtWebEngineQuick` **and**
  `QtWebEngine::initialize()` called before `QGuiApplication` — the plan's §I5
  ordering rule. Concretely, at the very top of `main()`:
  `#if DSH_QT_HAS_WEBENGINE` `QtWebEngineQuick::initialize();` `#endif`.
- Do **not** add a `modules:` list to `jurplel/install-qt-action` for CI: the current
  workflows request no modules and Qt 6.7.3 resolves `qtquickcontrols2` to a failing
  module name. Either keep the CI default (`HAS_WEBENGINE=0`, browser hand-off) or add
  a dedicated job that installs `qtwebengine` — decide that in the packaging task, not
  here. `.github/workflows/build.yml:153-157` and `test.yml:258-264/292-296/403-407`
  are the four call sites.

## 4. Qt wiring — `native/main.cpp`

Three pieces, all of them small:

```cpp
// 1. one instance, exposed to QML as a context property next to `dshQt`/`ctx`
auto *webview = new WebviewHost(&app);
engine.rootContext()->setContextProperty(QStringLiteral("webviewHost"), webview);

// 2. forward the state event (main.cpp already routes `evt` frames)
} else if (kind == QLatin1String("evt")) {
    handleEvent_(message);
}
// in handleEvent_(), next to the existing `theme.reload` branch:
if (name == QLatin1String("webui.state")) {
    const QVariantMap status = frame.value(QStringLiteral("payload")).toObject().toVariantMap();
    webview_->applyStatus(status);
    emit webuiStateChanged(status);   // QML panel binds to this
}

// 3. serve the two signals that need the raw URL
connect(panel, SIGNAL(embedRequested()), this, SLOT(embedWebui()));
connect(panel, SIGNAL(externalOpenRequested()), this, SLOT(openWebuiExternally()));
```

`embedWebui()` / `openWebuiExternally()` must both do the same first step: call
`dshQt.request("webui.token")` and wait for the `requestReplied` signal. The reply
carries `{ url, maskedUrl }`; `url` is consumed natively —

- embed: `webview_->loadAuthenticated(result["url"].toString(), result["maskedUrl"].toString())`
- browser: `QDesktopServices::openUrl(QUrl(result["url"].toString()))`

— and **never** stored in a QML property, forwarded through `requestReplied`, or
logged. `webui.token` is one-shot: a second call before the next `webui.open` returns
`{ url: null, maskedUrl }`, which is what makes "no token in QML" testable
(`tests/webui-service.test.ts`).

`webui.close` must also call `webview_->close()`, so the stored URL and the page are
dropped together.

## 5. QML wiring — where the panel goes

`WebFallbackPanel` is a leaf `Item`; give it the two properties it cannot guess:

```qml
WebFallbackPanel {
    webviewHost: typeof webviewHost !== "undefined" ? webviewHost : null
    onOpenRequested: { dshQt.request("webui.open", {}); }   // reply → applyStatus()
    onCloseRequested: { dshQt.request("webui.close", {}); }
    onRetryRequested: { dshQt.request("webui.open", {}); }
}
```

The `webui.open` reply payload is a `WebuiStatus`; feed it to `applyStatus()` (and to
`webviewHost.applyStatus()`), because the first state event may arrive before QML has
finished binding. Without a native host the panel stays `Idle` and disables its
buttons — `qmllint` and `qmltestrunner` need no stubs.

## 6. Behaviour contract the panel depends on

| state | panel | WebviewHost |
| --- | --- | --- |
| `Idle` | buttons enabled, nothing loaded | hidden, URL cleared |
| `Resolving`/`Spawning`/`WaitingReady` | busy label, no buttons | hidden |
| `Ready`, `sharedSession: false` | embed slot (if WebEngine) or browser block | `loadAuthenticated()` |
| `Ready`, `sharedSession: true` (child) | same + `notice` banner | `loadAuthenticated()` |
| `Failed` | `statusText` = reason, retry button | hidden, `close()` |
| `Stopping` | busy label | hidden |

`Failed.reason` is one of `timeout | unavailable | mount-failed | spawn-failed |
crashed | refused | closed`; the panel prints it verbatim, so keep the strings stable.

## 7. Open items this handoff does **not** settle

1. **Who starts the Qt process** — no code in the repo spawns `dsh-qt-app`; the
   acceptance runs in this module start it (or run Node standalone) directly. Owned by
   t1 / the launcher task.
2. **Per-slot deep links** — `openSlot()` returns `{mode, reason}` and the official
   SPA exposes no per-slot route (t5 §8), so the fallback is panel-level today.
3. **WebEngine packaging cost** — enabling `DSH_QT_HAS_WEBENGINE=1` ships the Chromium
   stack (~200 MB); that is a packaging decision, not a code one.
