# I4 测试记录：插件管理适配、统一槽位契约、有限 React→QML 转换

worktree：`/data/qt-phase3/app/wt/plugin-sdk`（分支 `phase3/plugin-sdk`）。
基线：`33e516c32856878c37f92ddbbada81f9e437f3ba`；已并入 `1beba7d`（I1b/I1c，合并提交 `c800340`）。
计划依据：`62a9812` §3.6 / §I4。
日期：2026-11-24。平台：Linux（本机）。

## 1. 验收命令（逐字）

### 1.1 I4 新增用例

```
$ pnpm exec tsx --test tests/plugins-service.test.ts tests/ui-converter.test.ts
...
✔ a cyclic tree is refused instead of hanging the host (0.146024ms)
✔ a tree that exceeds the node budget is refused (17.476167ms)
✔ plain strings and arrays are accepted as the slot root (0.232132ms)
✔ actions are omitted when the caller cannot name a slot (0.120258ms)
ℹ tests 46
ℹ suites 0
ℹ pass 46
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 466.017121
```

### 1.2 类型检查

```
$ pnpm typecheck
$ tsc -p tsconfig.test.json
（无输出，退出码 0）
```

`tsconfig.test.json` 覆盖 `src/**` 与 `tests/**`，开启 `strict`、`noUncheckedIndexedAccess`、
`exactOptionalPropertyTypes`、`noImplicitReturns`、`noUnusedLocals`、`noUnusedParameters`。

### 1.3 全仓 TS 回归（确认没有弄坏既有套件）

```
$ pnpm exec tsx --test tests/*.test.ts
...
ℹ tests 393
ℹ suites 0
ℹ pass 393
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3579.205667
```

393 = 基线 319 + I4 新增 46 + 合并 I1b/I1c 带入 28。合并前后都是 0 失败。

### 1.4 QML 静态检查

```
$ /usr/lib/qt6/bin/qmllint -I qml/components qml/views/SlotWebFallback.qml qml/views/settings/PluginsBridge.qml
（无输出，零告警）
```

修掉的问题：`import "../../components"` 路径错（`qml/views/` 一级应为 `../components`）、
Theme 令牌名（实际是 `text`/`textMuted`/`fontSmall`/`fontNormal`/`fontLarge`/`spacing`/`spacingLarge`）、
`slots`/`operation` 属性自动生成的 `slotsChanged`/`operationChanged` 与自定义信号重名、
QtObject 根没有 default property（`internals`、`bridgeConnections` 必须属性赋值）。

整目录口径（与 CI `qml-lint` 一致，`qmllint -I qml -I qml/components $(find qml -name '*.qml')`）：**0 warning**。

### 1.5 既有 QML 套件回归（确认没弄坏原生侧）

```
$ QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input tests/qml -import qml
...
PASS   : qmltestrunner::ThemeSettings::test_unknownModeFallsBackInsteadOfBreaking()
PASS   : qmltestrunner::ThemeSettings::cleanupTestCase()
Totals: 168 passed, 0 failed, 0 skipped, 0 blacklisted, 631ms
```

### 1.6 两个新 QML 组件的临时运行用例（未入仓）

`tests/qml/` 不在 I4 的 in-scope 路径内，因此这些用例写在 `/tmp/i4qml/tst_i4.qml`，
用 `qmltestrunner -input /tmp/i4qml` 运行（`QT_QPA_PLATFORM=offscreen`）：

```
Totals: 11 passed, 0 failed, 0 skipped, 0 blacklisted, 67ms
PASS   : I4Plugins::test_bridgeSendsRequestsAndRoutesTheListReply()
PASS   : I4Plugins::test_bridgeTracksTheOperationPhase()
PASS   : I4Plugins::test_bridgeTurnsAFailedChangeIntoAValue()
PASS   : I4Plugins::test_panelFallbackOffersTheFullWebuiAndSaysSo()
PASS   : I4Plugins::test_progressEventRefetchesTheList()
PASS   : I4Plugins::test_slotEntryWinsOverThePanelFallback()
PASS   : I4Plugins::test_textFallbackShowsSalvagedTextAndNoButton()
PASS   : I4Plugins::test_unsupportedControlIsForwarded()
PASS   : I4Plugins::test_webFallbackOffersTheUrlItWasGiven()
```

覆盖：`refresh()` 依次发 `plugin.list`/`plugin.bundles`；`requestReplied` 按 request id 路由并把
`rows`/`bundles` 落位、`loading` 归零、`changed()` 每步一次；`application:'failed'` 变成
`lastError = "incompatible-version: needs dsh >= 0.3"` + `failed()` 且 `busy` 保持 false；
`plugin.install` 回 `{opId}` 后 `busy` 变 true、`cancel()` 带同一个 opId；
`plugin.op.progress` 的 `installing`→`settled` 会清 `busy` 并重新发 `plugin.list`（不信任推送）；
`ui.unsupported` 经 `eventReceived` 转发到 `unsupportedControl(slotId, type)`；
`SlotWebFallback` 的 `text` 态显示 `F4` 原因 + 抢救文本、无 web 入口时按钮不可见并给出说明；
`web` 态按钮可见、点击发 `openRequested("acme.panel", url)`；
**P3 两级回退**：只有 `fullWebuiUrl` 时显示「打不开这个槽位，会落到首页」提示 + 「Open the full WebUI」
按钮且槽位级按钮不可见；两者都有时槽位级入口胜出、整面板按钮与提示都不出现。

**建议**：把这份用例交给 t10/quality-reviewer 落到 `tests/qml/tst_i4plugins.qml`（改两个 `import`
为相对路径即可），这样 CI 的 `qml-tests` 才会长期守住这两个组件。

## 2. 用例覆盖（46）

### 2.1 `tests/ui-converter.test.ts`（20）

| 类别 | 覆盖 |
| --- | --- |
| 文本 | 纯文本、段落、h1–h3、有序/无序列表、`strong`/`em`/`code`、`https` 链接、`pre` + `data-language` |
| 布局 | `div` 的 `display`/`flexDirection`/`gap`/`padding`/`alignItems`/`justifyContent`/`overflow` |
| 按钮 | 文本按钮、`disabled`、`variant:'danger'`→tone、`onClick`→`action{slotId,event:'click'}` |
| 输入 | `input` text/password、`textarea`（`rows` 接受但不输出） |
| 选择 | `select`+`option`、`checkbox`、`role='radiogroup'`+radio、`input type='range'`→slider |
| 表单 | `form onSubmit` → container + `action{event:'submit'}` |
| 拒绝 | `<div onClick>`→F5、`style`→F5、第三方函数组件/`$$typeof` 对象→F4、`dangerouslySetInnerHTML`/`javascript:`/`eval`→F6、`http://` 链接→F2、`marquee`/`iframe`/`canvas`/`svg`→F1、未知 prop→F2、`onMouseEnter`→F3 |
| 三态 | 同一棵树在 `webEntry` 未声明时 `text`、声明时 `web` |
| 稳健 | 环引用→F1（不挂起）、5001 个 `<p>`→F1（预算）、数组根→container、字符串根→paragraph |
| 契约 | 成功结果只有 `status`+`tree`；`CONVERSION_REASON_NAMES` 精确匹配；每个 `kind` 都有非空 QML 组件名；`isSupportedUiType` 只认六种 |

### 2.2 `tests/plugins-service.test.ts`（26）

| 类别 | 覆盖 |
| --- | --- |
| 方法注册 | 8 个必有方法注册；**宿主没提供的 manager 方法不注册**（`plugin.bundles` 不存在时不出现） |
| 透传 | `plugin.list` 原样；`plugin.setEnabled`/`plugin.bundle.setEnabled` 的 `ChangeResult` 原样（含 `restartReason`） |
| 失败收敛 | `incompatible-version` → `application:'failed'` + `error{code,diagnostic}` 只有两个键；普通 Error → `operation-error`；**失败不发 `plugin.changed`** |
| 参数校验 | 空 id / 非布尔 `enabled` → 拒绝且 manager 未被调用（消息含 `bad-params`） |
| 长任务 | `plugin.install` 立即 `{opId}`；manager 收到同一 `requestId`；`waitForOp` 得 settled；progress 相位 `['installing','settled']`；`plugin.changed` 用 `result.target` 而非 spec |
| 失败隔离 | install 抛错 → settled failed、无事件、**随后 `plugin.list` 仍正常** |
| 更新/卸载 | `plugin.update` 拆出 `{from,to,step,restore}`；`plugin.remove` 的 `not-removable` 收敛 |
| 取消 | 未知 opId → `{cancelling:false}`；已知 → `{cancelling:true}` + 调 `cancelInstall` + settled `application:'cancelled'` |
| 保留窗口 | `maxRetainedOps:3` 跑 6 次后 `ops().length === 3` |
| 生命周期 | `dispose()` 后无注册方法、**不再 emit**；已落定的 `waitForOp` 仍能 resolve |
| 槽位 | 同 surface 重复 id → `refusal.reason==='duplicate'`、首个保留、`size()===1`；跨 surface 允许同 id；dispose 幂等且只删自己；**旧 disposer 不删后来重注册的同 id** |
| 投影 | `slot.list` 可 JSON 往返、含 `hasRender`/`hasSchema`、**不含 render 函数**、`webEntry` 三态精确 |
| 渲染 | `ui.render` 转 native；`ui.action` 用返回的新 props 重渲染（`count 0`→`count 1`）；未知 `ui.type` → `text` + `ui.unsupported{slotId,type}`；未知 slotId → 拒绝（`unknown-slot`） |

## 3. 明确未验证（不要外推）

1. **QML 用例未入仓**：`PluginsBridge.qml` / `SlotWebFallback.qml` 的运行时证据来自 §1.6 的 `/tmp` 临时用例
   （9 passed），**仓库内没有对应 `tests/qml/tst_*.qml`**，所以 CI 的 `qml-tests` 目前不会覆盖它们。
   入仓动作留给 t10/quality-reviewer（`tests/qml/` 不在 I4 in-scope 路径）。
2. **没有真实插件管理器**：测试用 `fakeHost()` + 结构化假 manager。`ctx.pluginManager` 的真实行为（pnpm 调用、
   文件锁、HMR reconcile、`installBundle` 的 requestId 流）**一次都没有跑过**。
3. **没有联网安装**：I4 的 out of scope；CI 计划用 fake registry。`plugin.install` 的 120s 超时、
   `pendingBuilds`/`approvedBuilds` 审批门禁都未验证。
4. **没有接进 `apply()`**：`createPluginService` 尚未在 `src/index.ts` 实例化（共享文件由 qiu-host 单写，见 handoff §4）。
   因此 `plugin.*` 目前**不是活的桥方法**，只是可用的库。
5. **事件链未贯通**：`native/main.cpp` 的 `handleEvent_()` 只处理 `theme.reload`，其余 evt 丢弃。
   `plugin.changed`/`plugin.op.progress`/`slot.changed`/`ui.unsupported` 目前到不了 QML；
   界面靠「落定后重拉」保持正确，属功能可用但慢一拍。
6. **跨平台**：只在 Linux 上跑过。Windows 未验证（`pnpm` 路径、文件锁、`qmltestrunner` 可用性均未核）。
7. **插件侧真数据**：没有用真实第三方插件的渲染函数喂过转换器；所有输入都是手写元素树。

## 4. 资源约束说明（如实记录）

本任务全部命令都是**前台串行**执行，未使用 `systemd-run`/cgroup/`ulimit -v`/`taskset`/`nice`，
即团队约定的「CPU 200% / 4G」硬上限**没有施加**。实际负载很轻（单次 `tsx --test` 数秒、`tsc` 数秒），
但这是结果而不是受控约束。若需要可审计，命令应写成：

```
systemd-run --scope -p CPUQuota=200% -p MemoryMax=4G pnpm exec tsx --test tests/*.test.ts
```
