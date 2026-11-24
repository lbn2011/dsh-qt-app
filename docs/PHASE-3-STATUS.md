# Phase 3 实施现状（t47 远程复验候选，待修复）

本文描述**当前代码实际接通的链路**与已跑过的验证。设计意图见
`docs/PHASE-3-IMPLEMENTATION-PLAN.md` 与 `docs/PHASE-3-*.md`；两者冲突时以
本文与源码为准，未实现的能力在这里明确标为缺口。t26 的候选声明（上一版）
在 t27 审查中被指出**过早**（token 泄漏、WebUI/槽位/真实 profile 未验收），
本文只保留被实测覆盖的结论，失败史见 `docs/test-records/t32-repair-round-2.md`。

## 1. 运行时拓扑（无失实版本）

```
DSH profile (Node)
└── dsh-qt-app 插件 (Cordis)
    ├── QtRendererService      渲染服务 / 旧 11 个 QML 方法 / 槽位渲染函数镜像
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
  之前保持 `connecting`（`src/host/bridge-service.ts`；`tests/host-e2e.e2e.ts` 断言
  `state=connecting` 先于 `connected`）。
- **默认无 Web 监听**：`WebuiService` 构造只注册状态机，不启动 backend；
  `tests/webui-default-off.test.ts` 断言 Idle、无端口、无子进程、无状态事件；真实
  profile 探针（`tests/official-profile.e2e.ts`）在运行期间采样 `/proc`，未出现监听端口。
- **WebUI token 只经一次原生消费**：`webui.token` 回复在 `DshQtBridge::complete_`
  内转交 `resolveWebuiToken_`（`native/main.cpp`），按**请求 id** 绑定 embed/browser
  意图；embed 且 WebEngine 可用时 `loadAuthenticated`，否则（非自测）用
  `QDesktopServices::openUrl`；随后 URL 内存清零，QML 只收到
  `webuiTokenResolved(id,intent,outcome,maskedUrl,error)`，`maskedUrl` 中 token 为 `***`。
  该回复**绝不**再走通用 `requestReplied`。关闭或超时后迟到的回复按 `cancelled` 丢弃。

## 2. 已从实际应用访问的面

| 面 | QML 入口 | Node 侧 | 证据 |
| --- | --- | --- | --- |
| 工具可视化 | `ChatView` → `ToolCallModel`/`ToolCallRow`（五态、折叠、复制） | `src/tools/projection.ts` + `attachToolProjection`（`src/index.ts`） | `tests/qml/tst_toolcallmodel.qml`；真实 profile 的 `tool.row` running→ok（`tests/official-profile.e2e.ts`） |
| 设置/模型 | `SettingsPanel` → `ModelsForm`、`SettingsBridge` | `registerSettingsMethods` / `registerLlmMethods` | `tests/qml/tst_settingsbridge.qml`；`tests/integration-wiring.test.ts` |
| 凭据 | `ApiKeyField`（新增/替换/删除，永不回显） | `registerCredentialMethods` → 官方 `ctx.credentials` | 同上（帧 JSON 断言不含 sentinel secret） |
| 插件管理 | `SettingsPanel` → `PluginsSettings`（列/启停/刷新） | `createPluginService(...).attach()` → 官方 `ctx.pluginManager` | `tests/plugin-manager-live.e2e.ts`（真实 profile 列表/停用/启用 + ChangeResult） |
| 槽位渲染 | `PluginsSettings` → `GeneratedSlot` → `GeneratedView`/`GeneratedNode` | `ui.render` / `ui.action`；`mirrorRendererSlots` 把 `QtRendererService` 的 render 函数镜像进 SlotRegistry | `tests/qml/tst_generatedview.qml` 14 例；`tests/slot-bridge.test.ts`；`tests/generated-slot-live.e2e.ts`（真实 Qt：渲染→点击→Node 重渲染 Count 1） |
| WebUI 回退 | `WebFallbackPanel`（状态/重试/嵌入/外部打开） | `WebuiService` + `attachWebuiToHost` | `tests/webui-live.e2e.ts`（真实 `WebuiService` in-process + 真实 Qt，open→Ready→token→close，端口消失）；`tests/webui-external.e2e.ts`（官方 `dsh web` 303+cookie 栅栏、无/伪造凭据 401） |
| 旧 Phase 2 方法 | `MarkdownText`/`CodeBlock`/`MessageInput`/`Theme` | `registerLegacyMethods`（11 个 v1 方法） | `tests/host-e2e.e2e.ts`（ping/markdown.parse/theme.scale 真实往返） |

`qml/main.qml` 的 `Connections` 只监听 `eventReceived`：
`tool.row`/`tool.snapshot`/`webui.state`/`slot.changed`；未知信号
（`ignoreUnknownSignals: true`）不会让 QML 崩。

## 3. 验证证据（t32 本机实测，Linux，串行预算）

所有命令经 `flock /data/qt-phase3/logs/verify.lock` + `systemd-run CPUQuota=200% MemoryMax=4G`
串行执行，退出码原样记录：

| 命令 | 退出码 | 摘要 | 日志 |
| --- | --- | --- | --- |
| `pnpm typecheck` | 0 | src + tests 无错 | `logs/t32-typecheck.log` |
| `pnpm test` | 0 | **484/484 pass**（含 gate、packaging 5、integration-wiring 5；t34 后计数） | `logs/t34-test.log` |
| `pnpm build` | 0 | `tsc -p tsconfig.json` | `logs/t32-build.log` |
| `cmake -S . -B build -DDSH_QT_WEBENGINE=OFF` | 0 | WebEngine 关闭 | `logs/t32-cmake-configure.log` |
| `cmake --build build` | 0 | 含 `webview_host.cc`、C++ token 分派 | `logs/t32-build2.log`、`t32-build3.log` |
| `cmake --build build --target qml-tests` | 0 | QML 套件（含 `tst_generatedview.qml`） | `logs/t32-qml-final.log` |
| `tsx --test tests/host-e2e.e2e.ts` | 0 | 7/7：握手、三方法、shipped QML、token 生命周期（成功/错误/超时/重复/关闭后迟到） | `logs/t32-e2e2.log` |
| `tsx --test tests/webui-live.e2e.ts` | 0 | 1/1：真实 WebuiService open→Ready→token→close | `logs/t32-webui-live2.log` |
| `tsx --test tests/official-profile.e2e.ts` | 0 | 1/1：真实 headless profile + 假模型 + 真实 Qt，会话/tool.row/无监听 | `logs/t32-official-profile.log` |
| `tsx --test tests/generated-slot-live.e2e.ts` | 0 | 1/1：渲染→点击→Node 重渲染 | `/tmp/e2e7.log` |
| `tsx --test tests/plugin-manager-live.e2e.ts` | 0 | 1/1：真实 ctx.pluginManager 列表/停用/启用 | `logs/t32-plugin-manager.log` |
| `tsx --test tests/webui-external.e2e.ts` | 0 | 1/1：官方 `dsh web` 栅栏负例与端口释放 | `logs/t32-webui-external2.log` |
| `tsx --test tests/webengine-chromium.e2e.ts` | 0 | 2/2：WebEngine=ON 真实 Chromium 认证加载/标题/maskedUrl/关闭 about:blank；真实 QDesktopServices→xdg-open→Chromium 执行 DOM/JS 标记（隔离 profile） | `logs/t34-r2-chromium-e2e.log` |

CI 锁：`.github/workflows/{build,test}.yml` 用 `NAPI_SHA` checkout addon，并断言
`git rev-parse HEAD` 与 `package.json` 的 `dshQtNapi.commit` 等于该 SHA；
typecheck/test/build/package/CMake configure/build 步骤经 `scripts/gate.mjs`
运行（退出码保真，stderr 记录 `[gate] exit=…`；Windows 的 `.cmd` 经
`scripts/gate-lib.mjs` 用 `%ComSpec%` 启动，不做无条件 `shell:true`）；
`tests/gate.test.ts` / `tests/gate-lib.test.ts` 覆盖透传、参数边界、ENOENT 127、
信号 128+n、PATHEXT 解析与引用。
`webui-real-host` job 安装固定 `@deepseek-ai/dsh@0.2.2-rc.1` 并设
`DSH_HOST_ROOT`/`DSH_REQUIRE_REAL_HOST=1` 跑宿主相关 WebUI 测试；单元 job 无宿主时
显式 skip，不伪装通过。归档由 `scripts/check-archive.sh` 全量消费 tar 输出并校验
`.sha256` + 根目录 `LICENSE`/`THIRD-PARTY-NOTICES.md`（`tests/archive.test.ts` 含缺件/
坏哈希负例）。Qt 6.7.3 的 `qmllint` 对任一 warning 返回 255，`qml/` 已修到 0 warning。
`THIRD-PARTY-NOTICES.md` 随 `cmake --install`/CPack 安装到包根；`tests/packaging.test.ts`
既实测临时 install prefix，也真实执行 `cpack -G TGZ`、校验同名 `.sha256`、解归档断言根目录
含 `LICENSE`/`THIRD-PARTY-NOTICES.md`/`bin/dsh-qt-app`，并覆盖缺 notices、坏校验和两个负例。
CI 另有 `qt-webengine` job（`modules: qtwebengine qtwebchannel qtpositioning`、offscreen、
`--no-sandbox --disable-gpu`）编译期断言 `DSH_QT_HAS_WEBENGINE=1` 并在该构建下跑
真实 Chromium 加载/关闭 e2e；WebEngineQuick 链接的 `Qt6::WebChannelQuick` 在独立的
`qtwebchannel` 模块里，其 `find_dependency(Positioning)` 又需要独立的 `qtpositioning`
模块；只装 `qtwebengine` 会让 CMake 包不可解析。t47 远程复验发现该 job 的编译期断言
位于 `Build` 之前却检查构建产物二进制，故真实 Chromium e2e 尚未执行，待修复。

## 4. 缺口（如实报告，不在本轮声称完成）

- **远程 CI 仍未通过（t47 复验，候选 55a0e9d）**：Windows TypeScript 单测剩 1 个平台
  路径断言失败（`tests/packaging.test.ts` 用 `split('/')` 取 basename，Windows 反斜杠
  路径不成立）；`qt-webengine` job 在 `Build` 前执行 `test -x build-webengine/dsh-qt-app`，
  导致配置已确认 `Qt WebEngine embedding enabled` 后仍 exit 1，真实 Chromium e2e 未运行；
  macOS 两 job 启动即 cancelled，未验证。已转绿：Ubuntu TypeScript、两平台 NAPI 与
  packaging、qml tests（229/0）、qml lint、真实宿主门（3/3，skipped 0）、两平台 Qt build。
  失败史见 `docs/test-records/t44-ci-revalidation.md`、`t45-hosted-test-failures.md`、
  `t47-ci-revalidation.md`。
- **Qt WebEngine 嵌入加载与外部浏览器仅 Linux 本机验证**（嵌入用 offscreen，外部浏览器用 Xvfb/xcb）：t34 在本机 Qt 6.8.2 +
  `qt6-webengine-dev` 上构建 `build-webengine`（`DSH_QT_HAS_WEBENGINE=1`），真实 Chromium
  加载标记页、标题命中、maskedUrl 只含 `token=***`、关闭后 about:blank，2/2 通过
  （`tests/webengine-chromium.e2e.ts`）。**Windows/macOS 与真实桌面窗口仍无运行证据**；
  CI 的 `qt-webengine` job 尚未在远程 runner 实际触发。「CI 必过」不成立，需首跑确认。
- **外部浏览器已有真实执行证据（Linux/Xvfb）**：隔离 HOME/XDG profile 注册临时 desktop
  entry，`QDesktopServices`→`xdg-open`→真实 Chromium headless 导航认证页，DOM 中
  `id="js-executed"` 由页面 JS 改写为 `ran-7419`，token 不出现在 DOM/stderr，浏览器退出后
  无 profile 进程并删除临时目录。没有 Windows/macOS 桌面会话证据；生产默认浏览器配置不变。
- **真实模型/真实用户 profile 未跑**：`tests/official-profile.e2e.ts` 使用隔离
  `DSH_HOME` + 本地确定性假模型（一次 `bash` tool_use + 一次文本），不接触真实凭据、
  不调用付费模型；标题请求判据为 `thinking.type==='disabled' && messages.length===1`。
- **macOS/Windows**：代码与 CI 矩阵存在；t47 已在远程真实执行 Windows/Linux 构建与
  NAPI，Windows unit 仍有 1 个测试失败，macOS runner 启动即取消，均未验证。WebEngine
  真实 Chromium 加载/关闭在远程尚未执行（job 步骤顺序问题），跨平台 GUI/嵌入行为待补。
- **插件槽位注册通道的边界**：render/action 函数经 `mirrorRendererSlots` 从
  `QtRendererService.registerSlot` 镜像到 `PluginService` 的 SlotRegistry；`ui.register`
  RPC 仍只承载可序列化元数据（函数无法过线），这一语义写入契约文档。
- **QML 渲染子集**：`GeneratedNode` 只覆盖 converter 产出的有限 `NativeNode` 子集
  （文本/布局/按钮/输入/选择/复选/单选/滑块/分隔/预格式），超界显示 unsupported 文案并由
  `ConverterResult.status==='web'|'text'` 走回退；不执行任意 React hooks/DOM。
