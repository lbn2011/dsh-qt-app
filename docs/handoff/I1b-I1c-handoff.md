# I1b/I1c 交接：Node 宿主启动 Qt 与 protocol v1 贯通

基线：`33e516c32856878c37f92ddbbada81f9e437f3ba`（app 基仓）。
协议冻结：`9a198da05059eb013e06678d3b5c1c1698644aa5`（I1a，`src/bridge/protocol.ts`）。
本文只描述 I1b（Node 侧）与 I1c（原生侧）新增的公共面；内部实现以源码为准。

## 1. 拓扑（已实现）

```
Cordis apply()
  └─ QtRendererService (ctx.qtRenderer)          既有渲染/主题/设置服务
  └─ HostBridgeService (ctx.hostBridge)          新增：持有或接纳 Qt 子进程
       ├─ launchQtHost()  → spawn(build/dsh-qt-app, stdio: pipe/pipe/pipe)
       ├─ HostTransport   → NDJSON 读写 + 分帧
       └─ 握手成功后 connected；11 个旧 QML 方法经 QmlBridge.dispatch 路由
native/main.cpp
  └─ DshQtBridge → 发 hello{v:1} → 收 hello.ack → connected → req/res/evt
```

Qt 进程永不 spawn、永不监听端口；Node 是唯一持有子进程句柄的一方（S1）。
`apply()` 默认 `autoLaunch: true`，但**只有**在 `application`/平台允许时才会真正拉起进程；
测试与无头环境必须显式 `autoLaunch: false`（`tests/index.test.ts` 已如此）。

## 2. Node 侧公共面

### `src/host/launcher.ts`

```ts
discoverQtBinaries(options?): QtBinaryCandidate[]
resolveQtBinary(options?): QtBinaryCandidate | null
class QtLaunchError extends Error { readonly code: 'unavailable' }
launchQtHost(options?): LaunchedQtHost
// LaunchedQtHost { child, transport, binaryPath, pid }
// LaunchQtHostOptions { binaryPath?, root?, args?, env?, cwd?, maxInboundFrameBytes?, logger?, onStderr? }
```

二进制优先级：显式 `binaryPath` > `DSH_QT_APP_BINARY` > `<root>/build/dsh-qt-app[.exe]` > `<root>/build/Release/…`。
**显式路径或环境变量一旦给出即为权威**：指向不存在的文件直接抛 `unavailable`，不回退到 `build/`（否则会静默运行另一份构建）。
stderr 始终被读取并逐行转给 `onStderr`/`logger`——不读会填满管道并卡住子进程。

### `src/host/transport.ts`

```ts
class HostTransport {
  constructor(options: { input: Readable; output: Writable; maxInboundFrameBytes?; logger? })
  start(): void; stop(): void
  get active(): boolean
  send(frame: Envelope): ProtocolError | null   // 成功返回 null（不是 undefined）
  onFrame(cb): () => void; onError(cb): () => void; onClose(cb): () => void
  get stats(): { framesIn, framesOut, bytesIn, bytesOut, writeErrors }
}
```

写失败只记录并上报，不会抛异常；解码错误经 `onError` 上报后连接保持（由服务决定是否断开）。

### `src/host/bridge-service.ts`

```ts
class HostBridgeService extends Service {   // ctx.hostBridge
  register(method, handler, options?): () => void
  unregister(method): void
  attach({ transport, child?, pid? }): void
  launch(): LaunchedQtHost | null
  start(): void
  invoke(method, params?, { timeoutMs }?): Promise<unknown>
  emitEvent(name, payload?, topic?): void
  onStateChange(cb): () => void
  onEvent(cb): () => void
  get state(): 'idle'|'connecting'|'connected'|'disconnected'|'unavailable'
  get stats(): HostBridgeStats   // pending/handled/failed/timeouts/duplicateIds/lateReplies/…
  dispose(): void
}
class HostBridgeError extends Error { code: RpcErrorCode }
DEFAULT_METHOD_TIMEOUTS = { 'markdown.render': 10_000, 'plugin.install': 120_000, … }
```

生命周期语义（均有测试覆盖）：

- 状态只会单向推进：`idle → connecting`，`hello.ack` 到达且 epoch 匹配才 `connected`；**ack 之前不显示 connected**。
- 握手 5s（可配 `handshakeTimeoutMs`）未完成 → `unavailable`，迟到的 ack 被忽略。
- `invoke` 超时 reject `timeout` 并保留 id 至迟到回复到达后按 id 丢弃（计入 `lateReplies`）。
- 重复 id → 一条 `duplicate-id` 错误 res，原有在飞请求不受影响；表上限 1024。
- `evt` 按 `epoch + seq` 去重；epoch 变化清空去重集合；未知 `kind`/未知 `evt.name` 忽略。
- EOF / 子进程退出 → 所有在飞请求以 `unavailable` reject，状态 `disconnected`，`lastError` 记原因。
- `dispose` 先摘除 sink 与监听，再以 `cancelled` 拒绝在飞请求；重复 dispose 为 no-op；给了 `child` 时最多等 500ms 再 kill。

### `src/index.ts`

`QtPluginConfig` 新增：`autoLaunch?`、`appBinary?`、`hostEnv?`、`composer?`、`hostRequestTimeoutMs?`、`hostHandshakeTimeoutMs?`、`logger?`。
`apply()` 用 `createServiceBridge({ renderer, composer? })` 建桥（parser 默认 `fallbackParserAdapter`，因此 `markdown.parse` 永远可用），把 `QML_BRIDGE_METHODS` 11 项注册到 host，再 `ctx.effect` 管理 `host.start()` / 卸载时 `host.dispose() + qmlBridge.dispose()`。

## 3. 旧 11 方法的返回形状（与 `qml-bridge.ts` 完全一致）

| method | result |
|---|---|
| `ping` | `{pong:true, stats, methods}` |
| `markdown.parse` | `{document}` |
| `markdown.render` | `{html}` |
| `code.highlight` | `{markup}` |
| `theme.apply` | `{applied, activeId}` |
| `theme.scale` | `{scale}` |
| `settings.get` | `{name, value}` |
| `settings.set` | `{name, accepted, value}` |
| `settings.save` | `{saved:true}` |
| `settings.all` | `{values}` |
| `composer.submit` | `{accepted}` |

路由失败时错误码沿用 `QmlBridgeErrorCode` 的 7 个值；`HostBridgeError` 直接透传。

## 4. 原生侧（`native/main.cpp`）

- `StdioTransport` 未改：仍是 NDJSON over stdin/stdout，4 MiB 入站 / 8 MiB 出站上限。
- `DshQtBridge` 改为 kind 判别信封；`transportState()` 暴露 `connecting|connected|disconnected`，`describe()` 与 `transportState` 一致，不再“active 即 connected”。
- 启动即发 `hello{v:1, role:'qt', epoch:QUuid, app, qt, caps:[11 项]}`，5s 内无 `hello.ack`（epoch 必须匹配）→ `nack protocol` + 断开。
- 连接前 `submit_` 的请求只入队（`Pending.sent=false`），connected 后一次性 flush；请求 id 前缀 `qt-`，事件序号 `seq` 单调。
- 处理 `host.ping`（返回 `{state, pending}`）、`host.quit`（回 res 后退出）、未知方法回 `unknown-method`。
- 断连：EOF → 拒绝全部在飞请求 → 发 `evt transport.state` → **仅当曾 connected** 时 500 ms 后退出，避免单测/独立启动立即死。
- `DSH_QT_HOST_SELFTEST=1`：不建 QML engine，打印 `[selftest] state=…`，connected 后发一次 `host.ping`，收到回复打印 `[selftest] ping=ok pong=1 error=` 并 `quit()`；10 s 硬超时 `exit(3)`。真实 e2e 依赖这三行 stderr。

## 5. 验证与已知缺口

真实双进程验证：

```bash
cmake -S . -B build -DDSH_QT_WEBENGINE=OFF
cmake --build build -j2
pnpm exec tsx --test tests/host-e2e.e2e.ts     # 需要 build/dsh-qt-app 存在
```

缺口 / 边界（下游必须知道）：

1. **Windows 未构建验证**：只用 `spawn(..., windowsHide)` 与 `.exe` 名称分支，CI 双腿尚未实跑。
2. `DSH_QT_WEBENGINE` 目前未被 CMakeLists 使用（WebEngine 属 I5），配置时会给出 “Manually-specified variables were not used” 警告，属预期。
3. QML 套件经 `qmltestrunner` 独立进程运行，看不到 C++ 单例，因此**没有** `tst_protocol.qml`；协议正确性由 C++ 自测 + `tests/host-launcher.test.ts` + `tests/host-e2e.e2e.ts` 覆盖。
4. `build/` 与 `docs/test-records/*.log` 不入库（见 `.gitignore`）；日志只在本工作树留证。
5. 会话/工具事件（`session/event`、`tool/call`、`tool/result`）的 QML 接线属 I2/I3；本任务只提供 `emitEvent` 与 `onEvent` 通道。