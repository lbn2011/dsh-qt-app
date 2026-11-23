# t26 集成交接：共享接线、CI SHA 锁、许可分发

## 合入来源
仅合入六个已审固定 SHA（台账见 `docs/PHASE-3-MERGE-LEDGER.md`）。本提交不改动
已审模块的语义，只增加宿主/界面接线、CI 锁、许可与文档。

## 新增接线（全部在 `src/index.ts:apply` 内按序装配）
1. `HostBridgeService` + `createServiceBridge`/`registerLegacyMethods`（旧 11 方法保留原名原返回形状）。
2. `registerSettingsMethods` / `registerLlmMethods` / `registerCredentialMethods`，
   官方服务通过 `optionalService()`（`ctx.reflect.get(name,false)`）解析；缺失即整组
   降级为 `unavailable`，不让 fiber 失败。
3. `createPluginService({manager, host}).attach()` → 官方 `ctx.pluginManager`。
4. `attachToolProjection(ctx, host)`：`ctx.on('session/event')` → `ToolProjection` →
   `evt tool.row`；`tool.snapshot` 供重连/切会话对账。epoch 随机，切换会话即轮换。
5. `WebuiService` + `attachWebuiToHost`：构造不启动；默认 Idle。
6. `ctx.effect` 统管 `host.start()` 与逆序 dispose。

## Qt/QML
- `native/main.cpp`：`eventReceived`/`webuiStateChanged` 信号；`webui.token` 只在 C++
  消费（embed 需 `WebviewHost::loadAuthenticated`，否则外部浏览器）；token 不入 QML/日志。
- `native/webview_host.{h,cc}`：可选 WebEngine；`DSH_QT_HAS_WEBENGINE=0` 时 `available=false`，
  `loadAuthenticated` 返回 false 并发出 `loadFailed("webengine-unavailable")`（QML 据此提示
  用外部浏览器打开；`DshQtBridge` 的 `webui.token` 分支在 embed 不可用时直接 `QDesktopServices::openUrl`）。
- `qml/main.qml`：`Connections` 分发 `tool.row|tool.snapshot|webui.state|slot.changed`；
  `ChatView` 内 `ToolCallModel`；`SettingsPanel` 的 models/plugins 页接 `SettingsBridge`/
  `PluginsBridge`；`WebFallbackPanel` 只暴露状态与按钮。

## CI / 分发
- addon 锁：`NAPI_SHA=87084a69…`；checkout `ref` + `git rev-parse` 断言 +
  `package.json: dshQtNapi.commit` 断言（build.yml 与 test.yml 各一份）。
- `THIRD-PARTY-NOTICES.md`：MIT 项目、pinned addon、cmark-gfm 0.29.0.gfm.14 BSD-2 全文；
  `cmake --install`/CPack 安装到包根，`package.json files` 同步。

## 测试与证据
- 新增 `tests/integration-wiring.test.ts`（5 例）：官方服务 fake + 真实 v1 帧；
  覆盖 settings 脱敏/revision、mutate、llm providers/default、cred.describe、
  plugin.list、webui.probe=Idle、tool.row 推送 + tool.snapshot、以及
  「任何帧不含 sentinel secret」。
- 迁移并持久化 `tests/qml/tst_settingsbridge.qml`、`tests/qml/tst_i4plugins.qml`。
- 实测（Linux，`logs/t26-*.log`）：typecheck 0；`pnpm test` 473/473；`pnpm build` 0；
  cmake configure/build 0；qml-tests 215/0；`tests/host-e2e.e2e.ts` **2/2**——真实 Qt 子进程
  走 ping/`markdown.parse`/`theme.scale` 三条真实路由，且无宿主时 QML 入口在 offscreen
  下加载无错、传输保持 connecting。

## 已知缺口（交下一轮独立审查）
- 真实 DSH profile 会话流未在 CI 启动；wiring 用 fake 官方服务。
- macOS/Windows 仅 CI 构建，无本机运行证据；WebEngine 嵌入路径未本机实测（构建用 OFF）。
- `I-WEBUI2`（真实 `dsh web` 探测）与 `I-GATE1`（门禁包装器）未实现。
