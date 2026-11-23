# Phase 3 实施现状（t26 集成候选）

本文描述**当前代码实际接通的链路**与已跑过的验证。设计意图见
`docs/PHASE-3-IMPLEMENTATION-PLAN.md` 与 `docs/PHASE-3-*.md`；两者冲突时以
本文与源码为准，未实现的能力在这里明确标为缺口。

## 1. 运行时拓扑（无失实版本）

```
DSH profile (Node)
└── dsh-qt-app 插件 (Cordis)
    ├── QtRendererService      渲染服务 / 旧 11 个 QML 方法
    ├── HostBridgeService      协议 v1 宿主端（spawn + stdio NDJSON）
    │   └── child: dsh-qt-app (Qt 6 GUI, 唯一 UI 进程)
    ├── Settings/Llm/Credentials RPC   → 官方 ctx.settings/ctx.llm/ctx.credentials
    ├── PluginService           → 官方 ctx.pluginManager（14 方法 + slot/action）
    ├── ToolProjection          ← ctx.on('session/event')，推送 tool.row / tool.snapshot
    └── WebuiService            按需；默认 Idle，不监听、不 spawn
```

- **只有一个 UI 进程**：Node 宿主持有并 spawn Qt 子进程（`src/host/launcher.ts`），
  子进程只读写自己的 stdin/stdout；Qt 侧不 spawn 任何进程、不监听端口（`native/main.cpp`）。
- **握手前不显示已连接**：`HostBridgeService` 在收到 Qt `hello` 并回 `hello.ack`
  之前保持 `connecting`，`host.state` 只有握手完成后才是 `connected`
  （`src/host/bridge-service.ts`；e2e 断言 `[selftest] state=connecting` 先于 `connected`）。
- **默认无 Web 监听**：`WebuiService` 构造只注册状态机，不启动 backend；
  `tests/webui-default-off.test.ts` 断言 Idle、无端口、无子进程、无状态事件。
  只有显式 `webui.open` 才走同进程 `WebServer{127.0.0.1, port:0}` 或
  `dsh web --port 0 --no-open` 第二进程退路（`docs/PHASE-3-WEB-FALLBACK.md`）。
- WebUI token 只进入 C++ 专有消费者（`DshQtBridge` 的 `webui.token` 回复；
  embed=WebEngine `loadAuthenticated`，否则 `QDesktopServices::openUrl`），
  QML 只见 `maskedUrl`；日志与帧中不出现 token。

## 2. 已从实际应用访问的面

| 面 | QML 入口 | Node 侧 | 证据 |
| --- | --- | --- | --- |
| 工具可视化 | `ChatView` → `ToolCallModel`/`ToolCallRow`（五态、折叠、复制） | `src/tools/projection.ts` + `attachToolProjection`（`src/index.ts`） | `tests/qml/tst_toolcallmodel.qml`；QML 全套 215 通过 |
| 设置/模型 | `SettingsPanel` → `ModelsForm`、`SettingsBridge` | `registerSettingsMethods` / `registerLlmMethods` | `tests/qml/tst_settingsbridge.qml`；`tests/integration-wiring.test.ts` |
| 凭据 | `ApiKeyField`（新增/替换/删除，永不回显） | `registerCredentialMethods` → 官方 `ctx.credentials` | 同上（帧 JSON 断言不含 sentinel secret） |
| 插件管理 | `SettingsPanel` → `PluginsSettings`（列/启停/刷新） | `createPluginService(...).attach()` → 官方 `ctx.pluginManager` | `tests/qml/tst_i4plugins.qml`；wiring 的 `plugin.list` |
| WebUI 回退 | `WebFallbackPanel`（状态/重试/嵌入/外部打开） | `WebuiService` + `attachWebuiToHost` | `tests/webui-service.test.ts`、`tests/webui-default-off.test.ts`；`requestWebui` 走 `qtBridge.request('webui.open')` |
| 旧 Phase 2 方法 | `MarkdownText`/`CodeBlock`/`MessageInput`/`Theme` | `registerLegacyMethods`（11 个 v1 方法） | `tests/qml-bridge.test.ts`、`tests/host-e2e.e2e.ts` |

`qml/main.qml` 的 `Connections` 只监听 `eventReceived`：
`tool.row`/`tool.snapshot`/`webui.state`/`slot.changed`；未知信号
（`ignoreUnknownSignals: true`）不会让 QML 崩。

## 3. 验证证据（本机 t26 实测，Linux）

所有命令在共享预算下串行执行（`flock` + `systemd-run CPUQuota=200% MemoryMax=4G`），
退出码原样记录：

| 命令 | 退出码 | 摘要 | 日志 |
| --- | --- | --- | --- |
| `pnpm typecheck` | 0 | src + tests 无错 | `logs/t26-typecheck-final.log` |
| `pnpm test` | 0 | **473/473 pass**（含新增 `tests/integration-wiring.test.ts` 5 例） | `logs/t26-test-final.log` |
| `pnpm build` | 0 | `tsc -p tsconfig.json` → lib/ | `logs/t26-build-final.log` |
| `cmake -S . -B build -DDSH_QT_WEBENGINE=OFF` | 0 | WebEngine 关闭仍可配置 | `logs/t26-cmake-configure.log` |
| `cmake --build build` | 0 | 含 `native/webview_host.cc` | `logs/t26-cmake-build.log` |
| `cmake --build build --target qml-tests` | 0 | **215 passed / 0 failed** | `logs/t26-qml-final.log` |
| `pnpm exec tsx --test tests/host-e2e.e2e.ts` | 0 | **2/2**：真实 `build/dsh-qt-app` 子进程走 ping→`markdown.parse`→`theme.scale` 三条真实路由并干净退出；无宿主时 QML 入口（工具/设置/插件/WebUI 面板）在 offscreen 下加载无错、传输保持 connecting | `logs/t26-e2e3.log` |

CI 侧的确定性锁：`.github/workflows/{build,test}.yml` 用 `NAPI_SHA` checkout
addon，并各有一条断言步（`git rev-parse HEAD` 与 `package.json` 的
`dshQtNapi.commit` 都必须等于该 SHA）。`THIRD-PARTY-NOTICES.md` 随
`cmake --install`/CPack 安装到包根，覆盖本项目 MIT、addon（pinned SHA）、
其 vendored cmark-gfm 0.29.0.gfm.14（BSD-2 全文）。

## 4. 缺口（如实报告，不在本次声称完成）

- **macOS**：CI 有 `macos-14` 构建矩阵，但无本机/CI 运行证据；WebEngine 回退与
  原生窗口行为未在 macOS 验证。
- **Windows**：代码与 CI job 存在，但本机未运行 Windows GUI/e2e；Windows 证据
  依赖 CI（本轮未触发远端 CI）。
- **Qt WebEngine**：本机构建用 `-DDSH_QT_WEBENGINE=OFF`（未安装 WebEngine），
  因此嵌入式 WebUI 的“加载成功”路径未本机实测；无 WebEngine 时按设计降级为
  外部浏览器打开（`QDesktopServices`），该分支已编译并在 QML 层覆盖。
- **真实 DSH profile 会话流**：未在 CI 启动完整 profile 的真实会话；当前以
  官方服务 fake + v1 帧（`tests/integration-wiring.test.ts`）与真实 Qt 子进程
  （`tests/host-e2e.e2e.ts`）分层覆盖，二者不能替代真实 profile 的端到端证据。
