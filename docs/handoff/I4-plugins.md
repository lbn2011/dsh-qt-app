# I4 交接：插件管理适配、统一槽位契约与有限 React→QML 转换

基线：`33e516c32856878c37f92ddbbada81f9e437f3ba`（app 基仓）。
已并入：`1beba7d`（I1b/I1c + protocol v1，本 worktree 以 `--no-ff` 合并为 `c800340`）。
计划依据：`62a9812` `docs/PHASE-3-IMPLEMENTATION-PLAN.md` §3.3 方法表、§3.6 转换契约、§I4 文件清单。
本文只描述 I4 新增的公共面与**尚未接线**的部分；内部实现以源码为准。

## 1. 拓扑（I4 新增部分）

```
Cordis apply()
  └─ QtRendererService (ctx.qtRenderer)      既有
  └─ HostBridgeService  (ctx.hostBridge)     既有（I1b）
       └─ PluginService   (I4，未在 apply 中实例化——见 §4)
            ├─ slot.*  → SlotRegistry（统一槽位形状）
            ├─ plugin.* → ctx.pluginManager（官方服务，原样透传）
            └─ ui.*    → convertSlotTree()（纯函数）
native/QML
  └─ PluginsBridge.qml        非可视桥接：request() + requestReplied
  └─ SlotWebFallback.qml      非 native 转换结果的展示层
```

**没有新增依赖**：不 import React，不 import `@deepseek-ai/dsh-plugin-manager`（类型在本地结构化声明，见 §2.1），
不复制官方管理逻辑——`plugin.*` 只做参数校验、调用、失败收敛、事件与 opId 记账。

## 2. Node 侧公共面

### 2.1 `src/plugins/service.ts`

```ts
createPluginService(options: PluginServiceOptions): PluginService

interface PluginServiceOptions {
  manager: PluginManagerPort   // ctx.pluginManager 的形状化视图（全 optional）
  host: MethodHostPort         // { register(method, handler): () => void; emitEvent(name, payload?) }
  slots?: SlotRegistry         // 缺省时内部 createSlotRegistry()
  maxRetainedOps?: number      // 默认 20
}
interface PluginService {
  readonly slots: SlotRegistry
  attach(): () => void         // 注册全部方法；返回 disposer（幂等）
  dispose(): void              // 注销方法 + 停止发事件（已落定的 waitForOp 仍会 resolve）
  ops(): PluginOperationSnapshot[]
  waitForOp(opId: string): Promise<PluginOperationSnapshot>
}
```

注册的方法（`PLUGIN_SERVICE_METHODS`，14 个）：

| 方法 | 返回 |
| --- | --- |
| `plugin.list` / `plugin.bundles` | 官方 `PluginInfo[]` / `BundleInfo[]`，**原样** |
| `plugin.setEnabled{id,enabled}` / `plugin.bundle.setEnabled{name,enabled}` | 官方 `ChangeResult`，**原样**（含 `restart` 语义） |
| `plugin.install{spec}` / `plugin.remove{name}` / `plugin.update{name,version}` | **立即** `{opId}`；落定结果用 `waitForOp(opId)` 或 `plugin.op.progress` |
| `plugin.op.cancel{opId}` | `{opId, cancelling:boolean}` |
| `plugin.inspect` / `plugin.versions` | 官方结果原样 |
| `slot.list{surface}` | `{contributions:[投影…]}`，**投影不含 render 函数**（可 JSON 往返） |
| `ui.register{slotId,spec}` | `{ok, contribution?}` 或 `{ok:false, refusal}` |
| `ui.render{slotId,props}` / `ui.action{slotId,event,payload}` | `ConversionResult`（`native`/`web`/`text`） |

**只注册宿主真正提供的方法**：`manager` 上没有 `listBundles` 就**不注册** `plugin.bundles`（调用方得到 `unknown-method`，
而不是一个永远返回 `[]` 的假方法）。`plugin.install/remove/update/plugin.op.cancel` 始终注册——它们是长任务入口，
manager 缺失时调用会以 `PluginServiceError('unavailable')` 拒绝，而不是静默成功。

失败收敛：任何 manager 异常都变成 `ChangeResult` 值而不是抛出：

```ts
{ changed: false, application: 'failed', stage: 'enable', target: 'acme',
  error: { code: 'incompatible-version', diagnostic: 'needs dsh >= 0.3' } }
```

`error` 只有 `code` 与 `diagnostic` 两个键；`code` 取官方 `ManagementError.code`，没有则 `'operation-error'`。
**失败不发 `plugin.changed`**（列表没变，推它只会让界面闪一下）。

事件（Node→Qt，`host.emitEvent`）：

| 事件 | 载荷 | 含义 |
| --- | --- | --- |
| `plugin.changed` | `{target, application}` | 只有 `changed === true` 才发；列表需要重新拉取（**不推全量**） |
| `plugin.op.progress` | `{opId, phase:'installing'\|'cancelling'\|'settled'}` | 长任务相位；`settled` 后应重拉列表 |
| `slot.changed` | `{surface?}` | 槽位注册/注销 |
| `ui.unsupported` | `{slotId, type}` | 宿主不认识该 `ui.type`（P1），Qt 侧必须显示「不支持」+ 可用回退 |

### 2.2 `src/plugins/slot-contract.ts` — 统一槽位形状

```ts
normaliseSlotContribution(surface: string, input: SlotContributionInput): SlotNormalisation
readWebEntry(contribution: SlotContribution): SlotWebEntry   // {kind:'declared',url} | {kind:'none'} | {kind:'undeclared'}
createSlotRegistry(options?: { onChange?: () => void }): SlotRegistry

interface SlotContributionInput {
  id: string; title?: string; description?: string; order?: number; section?: string
  label?: string; icon?: string
  render?: (props) => unknown; action?: (event, payload, props) => unknown
  component?: unknown; url?: string; schema?: unknown; properties?: Record<string, unknown>
  uiType?: string
  client?: { webEntry?: string | null }   // 三态：缺省=未声明 / null=声明无 / url=有
}
class SlotRegistry {
  register(surface, input): SlotRegisterResult   // {ok:true, registration} | {ok:false, refusal}
  remove(surface, id): boolean
  has(surface, id): boolean
  get(surface, id): SlotContribution | undefined
  byId(id): SlotContribution | undefined          // 跨 surface，供 ui.render
  contributions(surface): SlotContribution[]      // order 再 sequence 排序
  all(): SlotContribution[]; surfaces(): string[]; size(): number; clear(): void
  subscribe(listener: () => void): () => void
}
```

与既有 `src/settings/slots.ts` 的关系：**形状 A（本文件）是权威形状**。`SettingsSlotContribution` 的
`surface/id/section/order/title/description/component/url/schema/properties` 是它的子集，语义一致；
差异只有三点（都由 qiu-host 在共享文件里裁决，见 §4）：`render`/`action`/`uiType`/`client` 是新增字段，
`refusal` 形状从 `{reason, issues}` 扩展到含 `duplicate`，`webEntry` 是三态而非可选字符串。

### 2.3 `src/ui/converter.ts` — 纯函数转换

```ts
convertSlotTree(input: unknown, options?: {slotId?: string; webEntry?: SlotWebEntry}): ConversionResult

type ConversionResult =
  | { status: 'native'; tree: NativeNode }
  | { status: 'web';    reason: ConversionReason }
  | { status: 'text';   reason: ConversionReason; text: string }
```

成功结果**只有** `status` 与 `tree` 两个键（多余键会让「原生渲染成功」变成模糊状态）。
拒绝时：`webEntry.kind === 'declared'` → `web`（有地方可去）；否则 → `text` + 可读文本。
原因码 `CONVERSION_REASON_NAMES`：`F1 unsupported-element`、`F2 unsupported-prop`、`F3 unsupported-event`、
`F4 third-party-component`、`F5 complex-dom`、`F6 dynamic-code`。预算 `MAX_NODES=5000`、`MAX_DEPTH=32`，
环引用按 F1 拒绝（不挂起）。

**明确不做**：`style` 对象一律 F5（CSS 子集未实现，不做半应用）；非 `https` 链接 F2；
`dangerouslySetInnerHTML`/`innerHTML`/`eval`/`require`/`Function` 一律 F6；未知 `ui.type` **不进转换器**，
由 service 发 `ui.unsupported` 并回退文本（P1）。

### 2.4 `src/ui/controls.ts`

`UI_TYPES`（`select|slider|toggle|text|number|color`）、`isSupportedUiType()`、`CONTROL_FOR_UI_TYPE`（映射到
`qml/views/settings/` 既有控件）、`QML_COMPONENT_FOR_KIND`（`NativeNode.kind` → QML 组件名）、
各元素/属性/事件白名单与 `UNSUPPORTED_CONTROL_NOTICE`。**白名单就是契约**：改这里等于改 §3.6 的支持子集。

## 3. QML 侧公共面

### 3.1 `qml/views/settings/PluginsBridge.qml`（非可视）

属性：`qtBridge`、`rows`、`bundles`、`bundlesAvailable`、`slots`、`loading`、`operation`、`lastError`、只读 `busy`。
信号：`changed()`、`slotListChanged()`、`failed(string)`、`operationPhaseChanged(string opId, string phase)`、
`rendered(string slotId, var result)`、`unsupportedControl(string slotId, string type)`。
方法：`refresh()`、`refreshSlots(surface)`、`setEnabled(id, enabled)`、`setBundleEnabled(name, enabled)`、
`install(spec)`、`update(name, version)`、`remove(name)`、`cancel()`、`renderSlot(slotId, props)`、`act(slotId, event, payload)`。

注意：`property var slots` / `property var operation` 自带 `slotsChanged` / `operationChanged` 信号，
自定义信号因此命名为 `slotListChanged` / `operationPhaseChanged`（qmllint `duplicated-name` 会拦）。

### 3.2 `qml/views/SlotWebFallback.qml`（可视）

入参 `conversion`（`ConversionResult`）、`slotTitle`、`slotId`、`fullWebuiUrl`；信号 `openRequested(string slotId, string url)`。
objectName：`slotWebFallback`、`slotFallbackTitle`、`slotFallbackHeadline`、`slotFallbackText`、
`slotFallbackReason`、`slotFallbackOpenButton`、`slotFallbackPanelNotice`、`slotFallbackOpenPanelButton`、
`slotFallbackNoWebEntry`。

P3 的两级回退（`canOpenSlot` / `canOpenPanel` 两个只读布尔决定显示哪一级）：

| 条件 | 显示 | 语义 |
| --- | --- | --- |
| `webEntry.kind === 'declared'` | `slotFallbackOpenButton`「Open this plugin in the WebUI」 | 槽位级入口优先，打开就是这个槽位 |
| 无槽位入口，但宿主给了 `fullWebuiUrl` | `slotFallbackPanelNotice` + `slotFallbackOpenPanelButton`「Open the full WebUI」 | 打开的是**整面板**，所以先明说「打不开这个槽位，会落到首页」，不得声称已定位 |
| 两者都没有 | `slotFallbackNoWebEntry` | 明说没有 web 版本也没有 WebUI，不给死按钮 |

`fullWebuiUrl` 由调用方注入（宿主才知道 WebUI 是否在跑、根 URL 是什么）；本组件不探测、不猜。
`slotId` 在两种情况下都会随 `openRequested` 回传，宿主据此决定是深链还是落到根。

## 4. 待接线（qiu-host 单写共享文件）

以下都是**共享文件**，本任务按契约未修改：

1. `src/index.ts` `apply()`：在既有 `ctx.effect(() => {...}, 'dsh-qt-app: host bridge')` 内
   `const plugins = createPluginService({manager: ctx.pluginManager ?? {}, host}); const detach = plugins.attach();`
   并在 disposer 里 `detach(); plugins.dispose()`。`ctx.pluginManager` 缺失时传 `{}`：只有 `slot.*`/`ui.*` 可用。
2. `src/types.ts:62` `QtSlotContribution`：改为从 `src/plugins/slot-contract.ts` 再导出 `SlotContributionInput` /
   `SlotContribution`，删掉本地重复定义。`QtRendererService.registerSlot()`（`src/index.ts:257`）应改为委派
   `PluginService.slots.register()`——现在它是裸 `Map.set`，**无重复校验、disposer 无身份校验**，与统一契约不一致。
3. `src/settings/slots.ts:49` `SettingsSlotContribution`：保留现有字段（向后兼容），但 `SettingsSlotRegistry.register()`
   应能接受 `SlotContribution`（超集）；`normaliseSettingsSlotContribution` 与 `normaliseSlotContribution` 需合并或
   让前者委派后者，否则两套校验会漂移。
4. `qml/views/settings/PluginsSettings.qml:83`：`Manage plugins` 按钮现在 `enabled: false`。接上后应为
   `enabled: bridge.rows.length > 0 && !bridge.busy`，`onClicked: bridge.refresh()`，并把 `bridge.rows` 渲染成列表；
   失败文案绑 `bridge.lastError`（`application === 'failed'` 时显示 `code: diagnostic`）。
5. `qml/views/settings/SettingsPanel.qml:127`：`slotContributions` 的注释说由 `ctx.qtRenderer.slotContributions("conversation.settings.*")`
   填充，但**该方法在 TS 侧不存在**（`grep slotContributions src/` 零命中）。接上后改为：
   `PluginsBridge { id: plugins; qtBridge: ctx.dshQt }`，面板 `refreshSlots(surface)` 后绑 `plugins.slots`，
   逐槽位调 `plugins.renderSlot(slotId, props)`，结果 `status === 'native'` 走 SlotHost/SlotForms，
   否则交给 `SlotWebFallback`——并**必须**把宿主 WebUI 的根 URL 传进去（`fullWebuiUrl`），
   否则 P3 的第二级回退（整面板）在界面上永远不会出现。`SlotWebFallback` 的 `openRequested` 由谁接、
   怎么打开 WebEngine，是 I5/web-fallback 的 `webui.open` 契约，本任务不实现。
6. `native/main.cpp` `handleEvent_()`（约 :1016-1022）：目前只处理 `theme.reload`，**其余 evt 一律丢弃**。
   需要把未知事件转成 QML 信号 `eventReceived(QString name, QVariant payload)`，PluginsBridge 已经用
   `ignoreUnknownSignals: true` + `onEventReceived` 等它；在此之前进度/失效通知不会到达，界面靠「落定后重拉」保持正确
   （功能可用，只是慢一拍）。
7. 真实安装路径未验证：`plugin.install/update/remove` 的 opId 语义与官方 `installBundle({requestId})` /
   `cancelInstall(requestId)` / `waitForInstall(requestId)` 对齐，但**没有联网跑过真实 npm 安装**（I4 out of scope，
   CI 用 fake registry）。`plugin.update` 的 `restore` 字段原样透传，未做二次解释。

## 5. 验收证据

见 `docs/test-records/I4-plugins.md`。要点：46 个新用例全绿、全仓 393 个 TS 用例全绿、`pnpm typecheck` 0 错误、
`qmllint` 整目录 0 warning、既有 QML 套件 168 passed / 0 failed；两个新 QML 组件的运行时用例 11 passed，
但**写在 `/tmp/i4qml/` 未入仓**（`tests/qml/` 不在 I4 in-scope 路径）——请 t10/quality-reviewer 落成
`tests/qml/tst_i4plugins.qml`，否则 CI 的 `qml-tests` 不会守住它们。真实插件管理器与联网安装仍未跑过。
