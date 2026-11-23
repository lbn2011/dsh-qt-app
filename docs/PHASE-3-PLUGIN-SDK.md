# Phase 3 · 插件管理与原生 SDK 适配契约（t3 交付）

状态：**规划与核验稿，未实现、未在真实宿主中运行**。
性质：只读核验。本文件未操作任何真实插件、未启动任何服务、未修改 DSH 官方源码。
作者：plugin-sdk（团队 dsh-qt-phase3）

本文回答四件事，全部结论都能落到具体文件与行号：

1. 官方插件服务**实际**提供了哪些列表/启停/安装/卸载/更新能力与权限边界（§3 兼容矩阵）；
2. Qt 侧现有槽位契约与官方 Web 槽位契约**在哪些点上不一致**（§4 槽位矩阵）；
3. 原生 SDK 的 manifest / slot / view / action / dispose / 版本协商草案（§5）；
4. 「简单 React 可转子集」到底能到什么程度、什么时候必须拒绝并回退（§6、§7）。

---

## 0. 取证范围与路径偏差（必须先读）

### 0.1 任务书里的一个路径不存在

任务书写 `/data/dsh-Go/sdk/plugin-kit`。**该路径不存在**：`/data` 下没有 `dsh-Go` 目录，全盘 `find -name plugin-kit -type d` 无结果。

实际使用的 plugin-kit 位于：

```
/root/dsh-ecosystem-spec/projects/dsh-plugin-kit    # dsh-plugin-kit@0.1.0-draft.1
```

若后续有人按任务书路径去找，会找不到。此处如实记录，不猜测该目录曾存在或被移动。

### 0.2 实际读取的四个源码位置

| 位置 | 用途 | 读取方式 |
|---|---|---|
| `/data/EAC-Desktop/dsh-qt-app` | Qt profile 现状（槽位、settings、QML） | 只读 |
| `/data/EAC-Desktop/dsh-qt-napi` | N-API 桥与第三方许可证 | 只读 |
| `/data/dsh-official` | 官方插件服务与官方槽位契约 | 只读 |
| `/root/dsh-ecosystem-spec/projects/` | plugin-kit / compat-spec / compat-platform / test-driver | 只读 |

`/data/dsh-official` 是 **0.2.3-alpha.2**（`package.json:3`）。

### 0.3 本文档的结论等级

本文严格区分三档，不做「已验证 100%」这类表述：

- **【源码实证】**：在源码中读到，附文件与行号。可复现。
- **【fixture 实证】**：仓库内已有测试/fixture 覆盖该行为。
- **【未验证】**：设计推断或依赖缺失，明确标注为未验证。

---

## 1. 版本与许可证台账

| 组件 | 版本 | 许可证 | 证据 |
|---|---|---|---|
| `@deepseek-ai/dsh-qt-app` | 0.1.0 | MIT | `dsh-qt-app/package.json`（license 字段）；`dsh-qt-app/LICENSE` |
| `dsh-qt-napi` | 0.1.0 | MIT | `dsh-qt-napi/package.json`（license 字段）；`dsh-qt-napi/LICENSE` |
| `dsh-qt-napi` vendored cmark-gfm | `0.29.0.gfm.14`（上游 rev `7fe8904ee31fa24b772ae565c4908b1394850de6`，2026-11-18） | **BSD-2-Clause** | `vendor/cmark-gfm/PROVENANCE.md`（含 upstream 表与「故意不 vendored」清单）+ `vendor/cmark-gfm/COPYING` |
| `@deepseek-ai/dsh-plugin-manager` | 0.2.3-alpha.2 | MIT | `packages/boot/plugin-manager/package.json` |
| `dsh-plugin-kit` | 0.1.0-draft.1 | MIT | `/root/dsh-ecosystem-spec/projects/dsh-plugin-kit/package.json` |
| `dsh-compat-spec` | 0.1.0-draft.1（协议同为 0.1.0-draft.1；configSchema 修订 0.2.0-draft.1） | MIT | 该仓 `README.md` 状态表 |
| `dsh-compat-platform` | 0.1.0-draft.1（五个包同版本） | MIT | 该仓 `README.md` |
| 官方 Web 客户端 React | `^18.2.0` | MIT | `apps/web/package.json:63`、`packages/client/ui-renderer/package.json:50` |
| 官方宿主（本 checkout） | 0.2.3-alpha.2 | — | `/data/dsh-official/package.json:3` |

**许可证结论**：本文涉及的自有组件与生态项目全部 MIT（`dsh-qt-app/LICENSE`、`dsh-qt-napi/LICENSE` 首行均为 `MIT License`，两个 `package.json` 的 `license` 字段均为 `MIT`）。

唯一需要单独处理的是 qt-napi 里 **vendored 的 cmark-gfm**：

- 它是 **BSD-2-Clause**（`vendor/cmark-gfm/PROVENANCE.md` 的 upstream 表明确写 `license | BSD-2-Clause — see COPYING`）。
- 但 `COPYING` 是一份**复合**许可文件，除 BSD-2-Clause（cmark 核心 + test 软件）外，还列了 MIT 片段（houdini / buffer / utf8proc / markdowntest 的 normalize.py）与 **CC-BY-SA 4.0**（CommonMark 规范的 `test/spec.txt`）。
- 核对结果：`test/` **没有**被 vendored（`vendor/cmark-gfm/` 只有 `COPYING`、`PROVENANCE.md`、`src/`、`extensions/`、`gen/`，共 63 个文件，无 `spec.txt`）。所以 **CC-BY-SA 那部分不随本仓分发**，但 `COPYING` 原样保留，不得裁剪。

**要求**：任何分发 Qt 二进制或 `qt-bridge.node` 的产物，都必须原样带上 `vendor/cmark-gfm/COPYING` 与 `PROVENANCE.md`。第三方许可证**保留、不合并、不改写**。

### 1.1 已发现的版本错位（必须交给版本协商处理）

| 轴 | 值 A | 值 B | 冲突 |
|---|---|---|---|
| Cordis | qt-app 实际安装 **4.1.0** | plugin-kit 精确 pin **4.0.6-alpha.1**（`src/protocol.js:42-43`） | qt-app `package.json` 声明 `^4.1.0`，kit 生成的插件 peer 写死 `4.0.6-alpha.1` |
| DSH 宿主 | 本 checkout **0.2.3-alpha.2** | plugin-kit `HOST_VERSION='0.2.2-alpha.2'`（`src/protocol.js:53`） | kit 生成物按 0.2.2-alpha.2 的接口书写 |
| 协议 | plugin-kit `PROTOCOL_VERSION='0.1.0-draft.1'`（`src/protocol.js:32`） | compat-spec `schemaVersion='0.1.0-draft.1'` / `'0.2.0-draft.1'` | 两套「协议版本」同名不同物，**不可互相代入** |

【源码实证】`dsh-qt-app/node_modules/@deepseek-ai/cordis/package.json` → `4.1.0`。

**这意味着**：不能直接声称「plugin-kit 生成的插件能在 Qt profile 里跑」。kit 自己的 README 与每个模板文件头都写着 "This file has never been loaded by that build or any other."（`templates/host-tool/index.js:9-11`、`templates/client-slot/client.js:14-16`）。本文沿用同一诚实口径。

---

## 2. 官方插件服务：真实 API 面

`packages/boot/plugin-manager/src/index.ts`：

```ts
export class PluginManager extends TypertRemoteService   // :325
static inject = ['loader', 'profileContext']              // :326
super(ctx, 'pluginManager')                               // :373
```

### 2.1 公开 @Remote 方法（全部带行号）

| 能力 | 方法 | 行号 | 关键语义 |
|---|---|---|---|
| 列表 | `listPlugins(): Promise<PluginInfo[]>` | :480 | 每行带 `readOnlyReason` |
| 列表 | `listBundles(): Promise<BundleInfo[]>` | :506 | bundle 维度 |
| 启停 | `setPluginEnabled(id, enabled)` | :937 | 写 patch → reload |
| 启停 | `setBundleEnabled(name, enabled)` | :955 | `selectBundle` + `publishAndReload` |
| 安装 | `installBundle(spec, options?)` | :977 | 失败/取消/装上未成 patch 会回滚 |
| 安装等待 | `waitForInstall(requestId)` | :1129 | 配合 `plugin-manager/install-state` |
| 安装取消 | `cancelInstall(requestId)` | :1139 | |
| 卸载 | `removeBundle(name)` | :1156 | 多重前置拒绝 |
| 更新 | `updateBundle(name, version, options?)` | :746 | remove→install，失败 restore |
| 检查 | `inspect(spec, options?, signal?)` | :628 | |
| 版本列表 | `listVersions(name, options?, signal?)` | :688 | |
| 详情 | `readBundleDetail(name, language, options?)` | :418 | |
| 注册表 | `registries()` | :612 | |
| 豁免 | `listVersionExemptions()` / `setVersionExemption(...)` | :454 / :467 | 版本豁免 |

### 2.2 权限与只读边界【源码实证】

- `listPlugins()` 对 `PROTECTED_PLUGINS.has(moduleName) || entryId === ownerEntryId` 返回 `readOnlyReason: 'management-required'`（:487-489）；对不可寻址 patch 返回 `'unaddressable'`（:490-493）。
- 启停遇到只读行直接抛该 reason（:941-943），未知 id 抛 `ManagementFailure('unknown-plugin')`。
- 构建脚本批准：`installBundle` 的 `approvedBuilds` 走 `approveBuilds(profile.dir, ...)`（:999-1002），`build-approval.ts`（96 行）负责登记与批准。**这意味着安装路径存在「执行第三方构建脚本」这一提权面**，Qt 侧 UI 必须显式呈现，不得静默批准。
- 平台门禁：`assertBundlePlatform(platforms, process.platform)` 在 :543 / :585 / :1285 三处校验。
- 版本不兼容：`ManagementFailure('incompatible-version', ...)` 在 :578 / :873 / :1053 / :1095 / :1287；`operations.ts:344-376` 明确「不兼容版本永不安装，已在用的保持可用」。

### 2.3 事务、失败隔离与回滚【源码实证】

`private async change(operation, request, reason, identity?)`（:1376-1440）：

- 全程 `withFileLock(join(profile.dir, 'package.json'), { waitMs: lockWaitMs })`（:1376-1440 内），锁等待默认 120000 ms（Config :327-343）。
- 内部 catch 把异常转成 `result.application='failed'` + `error=managementError(error)`（:1397-1408）；`InstallCancelledError` → `'cancelled'`。
- 无 HMR 时默认 `application='restart-required'`, `restartReason='no-hmr'`（:1389-1391）。
- `result.changed = before !== this.diskState()`，随后 emit `plugin-manager/changed`。
- 诊断事件 `plugin-manager/operation`（started/settled/unknown）在 :1442-1458，**诊断失败不影响结果**（:1459-1464）。

安装回滚（`installBundle` 文档注释 :966-972）：失败/取消/装上但无 bundle patch 的运行会恢复 `package.json` 与 `pnpm-lock.yaml`，**已下载文件可残留**。这是官方已声明的边界，Qt 侧不得把它宣传成「完全无残留」。

更新回滚（:789-806）：HMR 下 remove→install，失败时若 `stage==='enable'`（装上了没起来）先再 remove，再按原来源重装（git source 或 `name@from`）。

卸载（:1156-1188）：`not-removable` → `stop-profile`（非 HMR 且已 started）→ `bundle-in-use`（仍有 fiber 存活，:1170-1173）→ `pnpm remove` 非 0 退出即 throw（:1180-1183）。

---

## 3. 兼容矩阵：官方服务 ↔ dsh-qt-app 现状

**结论：qt-app 目前对插件管理是零接线。**

【源码实证】在 `dsh-qt-app` 全仓（排除 `node_modules`、`lib`）检索 `pluginManager|plugin-manager|installBundle|listPlugins`：**0 命中**。

| 官方能力 | 官方入口 | qt-app 现状 | 缺口 |
|---|---|---|---|
| 插件列表 | `listPlugins()` :480 | 无 | 需要 QML 模型 + 只读原因展示 |
| Bundle 列表 | `listBundles()` :506 | 无 | 同上 |
| 单插件启停 | `setPluginEnabled` :937 | 无 | 需处理 `'overridden'` 返回值（:946-950）与 `readOnlyReason` |
| Bundle 启停 | `setBundleEnabled` :955 | 无 | |
| 安装 | `installBundle` :977 | 无 | 需 requestId 生命周期、`waitForInstall`、`cancelInstall` |
| 卸载 | `removeBundle` :1156 | 无 | 需把 `stop-profile` / `bundle-in-use` 翻成人话 |
| 更新 | `updateBundle` :746 | 无 | 需展示 checking/removing/installing/restoring 四阶段 |
| 版本列表/检查 | `listVersions` :688 / `inspect` :628 | 无 | 安装前的目标选择 |
| 注册表 | `registries()` :612 | 无 | |
| 版本豁免 | `setVersionExemption` :467 | 无 | 需 `acceptRisk` 二次确认 |
| 构建批准 | `approveBuilds`（`build-approval.ts`） | 无 | **安全关键**：必须显式 UI 批准 |
| 插件页 | `PluginsSettings.qml` | 只有占位 | 见下 |

`qml/views/settings/PluginsSettings.qml` 现状：

- `acceptedSurfaces` 硬编码两个 surface（:29-32），与 `src/constants.ts:55-58` 手工镜像；
- 有一个 "Manage plugins" 按钮，**`enabled: false`**（:83），注释写明「没有插件管理器可打开」——这是诚实的 not-yet，也正是 Phase 3 要替换的那一处。

---

## 4. 槽位契约矩阵：三处不一致

这是本任务最关键的发现：**同一份「槽位贡献」在 Qt 侧存在两套互不相通的形状，而 QML 消费的是第三套期望。**

### 4.1 两套 TypeScript 形状并存

| | 形状 A：`QtSlotContribution` | 形状 B：`SettingsSlotContribution` |
|---|---|---|
| 定义 | `src/types.ts:62-71` | `src/settings/slots.ts:49-70` |
| 字段 | `surface, id, label?, icon?, render?(props) => unknown` | `surface, id, section, order, title, description, component, url, schema, properties` |
| 注册入口 | `QtRendererService.registerSlot()`（`src/index.ts:257`） | `SettingsSlotRegistry.register()`（`slots.ts:260`） |
| 存储 | `QtRendererService.slots` Map（`src/index.ts:130`） | registry 内部 Map（`slots.ts:249-251`） |
| 重复 ID | **无校验，后写覆盖**（`src/index.ts:257-263`） | **拒绝**（`slots.ts:265-270`） |
| 谁消费 | 无人 | QML `SlotHost.qml` |

形状 A 的 `render` 回调（`src/types.ts:70`，注释「opaque to the Cordis layer」）在 QML 里**无法被调用**——QML 只能读属性，不能调用 JS 函数并把返回值变成控件。所以形状 A 在当前架构下是死路。

形状 B 才是 QML 真正读的东西（见 §4.2）。

### 4.2 QML 期望一个并不存在的 API

`qml/views/settings/SettingsPanel.qml:123-129` 注释与代码：

```
 * The host fills this in from
 * `ctx.qtRenderer.slotContributions("conversation.settings.*")`.
property var slotContributions: []
```

【源码实证】`QtRendererService` 上**没有** `slotContributions()` 方法；只有 `listSlots(surface?: string)`（`src/index.ts:271`），且签名是**精确 surface 相等**（:273 `slot.surface === surface`），**不支持 `"conversation.settings.*"` 这种通配**。

→ 名字不符 + 通配语义缺失 + 返回形状是 A 而 QML 需要 B。三处同时错位。

这是 Phase 3 必须补的第一个接缝（见 §5.3 的 `slotContributions(pattern)` 设计）。

### 4.3 官方 Web 槽位名与 Qt 槽位名不同

| Qt 侧名字 | 官方 Web 是否同名 | 官方声明 |
|---|---|---|
| `conversation.settings.section` | **否**，官方是 `settings.section` | `packages/client/ui-settings/src/client/contract/slots.ts:81`，`{ kind:'list', scope:'root' }` |
| `conversation.settings.form` | **否**，官方无对应（`settings.section` 内部自渲染） | 同上 |
| `conversation.chat.flow` | 是 | `packages/client/ui-chat/src/client/contract/slots.ts:450`，`{ kind:'single', scope:'session' }` |
| `conversation.session.header` | 是 | `packages/client/ui-conversation/src/client/contract/slots.ts:239` |
| `settings.general` | 是（作为 `settings.section` 的一个 id，不是独立 slot 名） | 语义不同 |
| `session.panel.section` | 是 | 官方 session-panel 契约 |
| `conversation.input.composer` | 未在官方契约中找到同名声明 | 【未验证】可能对应别的名字 |
| `sidebar.left.panel` | 未在官方契约中找到同名声明 | 【未验证】 |

**两个必须记住的语义丢失**：

1. 官方槽位带 `kind: 'single' | 'list'` 与 `scope: 'root' | 'session'`；Qt 的 `QtSlotContribution`（`src/types.ts:62-71`）**两者都没有**。把 `conversation.chat.flow`（官方 `single`）当插件贡献面用，会与「单占位」语义冲突。
2. 官方槽位组件类型是 `SlotComponent<P> = (props: P) => ReactNode`（`packages/client/ui-slots/src/index.ts:441`）——**就是 React 函数组件**。Qt 侧没有 React 运行时。这直接决定 §6。

### 4.4 已经被 fixture 覆盖的部分

QML 半个契约**有 fixture**，可以引用，但不要外推到 TS 半个。注意：QML fixture 本次**未运行**（需 Qt 构建环境），只有 TS 侧 319/319 是本次实跑通过的。

| 行为 | fixture |
|---|---|
| schema-only 贡献由生成器绘制 | `tests/qml/tst_settingsplugin.qml:62` |
| 生成表单把编辑回传宿主 | `tests/qml/tst_settingsplugin.qml:91` |
| component 贡献交给插件自己 | `tests/qml/tst_settingsplugin.qml:118`（断言 `loader.item.objectName === "pluginOwnBody"`，:140） |
| 空贡献显示说明而不是空白 | `tests/qml/tst_settingsplugin.qml:145` |
| 同一 section 内按 order 排序 | `tests/qml/tst_settingsplugin.qml:164` |
| 插件 section 变成新 tab | `tests/qml/tst_settingsplugin.qml:187`、`tst_settings.qml:196` |
| **坏槽位不拖垮面板** | `tests/qml/tst_settings.qml:293` |
| acceptedSurfaces 与 TS 侧一致 | `tests/qml/tst_settings.qml:189` |
| 注册表拒绝重复 id | `tests/settings-forms.test.ts`（"the registry refuses a duplicate id instead of silently replacing"） |
| dispose 幂等且只删自己 | 同上（"disposing a registration removes only that contribution"） |
| order + 注册序 tie-break | 同上（"forms are grouped by section and ordered, with registration as tie-break"） |
| 无内容贡献被拒 | 同上（"a contribution with nothing to render is refused"，断言文案含 `component, a url or a schema`） |

**未覆盖**：从真实 Cordis 插件 → `SettingsSlotRegistry` → QML `slotContributions` 的整条链路。原因是 §4.2 那个 API 根本不存在。

---

## 5. 原生 SDK 草案

> **位置由 t6 决定**。本节只给契约内容，不建远端、不新建 npm 包、不改 `dsh-qt-app` 的 `exports`。当前 `dsh-qt-app/package.json` 只有 `"."` 一个导出子路径，没有插件面向的 SDK 入口。

### 5.1 设计原则

1. **不发明第三方运行时**。SDK 是**类型与契约**，不是框架。plugin-kit 自己就写着「Not an SDK and not a replacement for Cordis」（`package.json` description）。
2. **复用官方语义**。槽位名、`kind`、`scope`、disposer 归属，全部对齐官方 `ctx.slots` 契约，Qt 只做**投影**，不做第二套真相。
3. **注册必须挂在 fiber 上**。官方 `slots.register` 实现是 `return this.ctx.effect(() => this._register(...), 'slots.register()')`（`ui-renderer/src/client/registry.ts:772`）。Qt 侧 `registerSlot`（`src/index.ts:257`）**没有** `ctx.effect` 包装，插件崩了会泄漏。SDK 必须要求走 `ctx.effect`。
4. **清理用现成的**。plugin-kit 的 `createCleanupScope()`（`src/cleanup.js`）已经是 LIFO + 单 disposer guard + 幂等 close + AggregateError；`registerManagedResource()`（`src/managed-registration.js`）已实现「任一 acquisition 失败则 LIFO 回滚、`.primary` 保留原始错误」。**直接复用，不重写。**

### 5.2 manifest 草案

沿用 compat-spec 的声明协议（它是现成的、有 JSON Schema、有 conformance 向量的）：`schemaVersion` / `plugin` / `capabilities` / `resources`（`spec/declaration-protocol.md:48-140`）。Qt 侧只**增加一个资源 kind**，不新造协议：

```jsonc
{
  "schemaVersion": "0.1.0-draft.1",
  "plugin": { "id": "acme.qt-panel", "version": "0.1.0" },
  "capabilities": { "required": ["cordis.effect", "ctx.slots"], "optional": [] },
  "resources": [
    {
      "kind": "slot",
      "name": "settings.section",               // 官方槽位名（§4.3）；Qt 私有名 conversation.settings.section 见 O2
      "scope": "plugin",
      "qt": {                                    // Qt 专属渲染描述（可选）
        "mode": "schema",                        // "schema" | "qml"
        "qml": "qrc:/qml/plugins/AcmePanel.qml"  // mode==="qml" 时必填
      }
    }
  ]
}
```

要点：

- `kind: "slot"`、`name`、`scope` 与 compat-spec `resources` 的既有 claim 形状一致（`declaration-protocol.md:104-140`）。
- `qt` 是**扩展字段**。compat-spec 明确「Unknown fields are rejected」（`declaration-protocol.md:69-71`），所以 `qt` 字段必须先由 compat-spec 走一次修订，**或** Qt 侧声明自己是 `0.2.0-draft.1` 之后的新修订。**这是开放问题 O1，不能自行加字段。**

### 5.3 slot / view 契约

```ts
/** Qt 原生渲染能接受的三种贡献。三者必居其一（对齐 slots.ts:192-197）。 */
type QtSlotPayload =
  | { schema: SettingsSchema[] }        // 声明式：由 SettingsForm 绘制，插件零 QML
  | { qml: string }                     // 命令式：QML 文件 URL，交给 Loader.source
  | { component: unknown }              // 进程内 Component（仅测试/内嵌）

interface QtSlotContribution {
  surface: string          // 官方槽位名，如 'settings.section'
  id: string               // 唯一，`^[A-Za-z0-9][A-Za-z0-9._-]*$`（slots.ts:33）
  kind: 'single' | 'list'  // 新增：对齐官方 kind
  scope: 'root' | 'session'| 'plugin'
  order?: number
  title?: string
  description?: string
  properties?: Record<string, unknown>
  payload: QtSlotPayload
}
```

宿主侧唯一入口（替换 §4.2 那个不存在的 API）：

```ts
/** 返回匹配 pattern 的贡献，按 order 后按注册序。pattern 支持末尾 `*` 通配。 */
slotContributions(pattern?: string): QtSlotContribution[]
```

**为什么用 pattern 而不是 surface 全等**：`SettingsPanel.qml:127` 已经这么写了；而且面板需要一次拿到 `conversation.settings.*` 两个 surface 的全部贡献。实现上是 `listSlots`（`src/index.ts:271`）的超集，不破坏既有调用。

### 5.4 动作（action）契约

插件页需要「对某个 bundle 执行某个操作」。官方 `ui-plugin-manager` 已经定义了这套：`PluginTabInstall{spec, registry?, title, version}`、`PluginTabUpdate{packageName, version, spec}`、`PluginDetailProps{subject}`（`packages/client/ui-plugin-manager/src/client/slot-contract.ts`）。**Qt 侧直接镜像这三个类型，不另起名字**，并且沿用它的做法：`import type` 合并契约、运行时不导入该包。

### 5.5 dispose 契约

```ts
// 强制：注册即 effect，dispose 由 fiber 拥有
ctx.effect(() => {
  const dispose = renderer.registerSlot(contribution)
  return dispose
}, `qt-slot:${surface}:${id}`)
```

三条硬要求，全部有现成实现可抄：

| 要求 | 依据 |
|---|---|
| dispose 幂等，只删自己注册的那一条 | `slots.ts:276-285`（「仅当记录仍为自身时才删除」，防旧 disposer 误删新注册） |
| 卸载时按 LIFO 逆序清理 | plugin-kit `cleanup.js` |
| 单个 disposer 抛错不中断其余，最终 AggregateError | plugin-kit `cleanup.js` |

### 5.6 版本协商

分三个**互不相干**的轴，不许合并成一个数字：

| 轴 | 谁声明 | 谁校验 | 失败表现 |
|---|---|---|---|
| 协议版本 `schemaVersion` | 插件 manifest | compat-spec validator（`src/index.js`） | `INVALID_VALUE`，插件不被接纳 |
| 宿主/平台兼容 | 插件 `package.json` 的 `engines.dsh`、`dsh.bundle.platforms` | 官方 `assertBundlePlatform`（`index.ts:543/585/1285`）、`incompatible-version`（:578/873/1053/1095/1287） | 不安装；已在用的保持可用（`operations.ts:344-376`） |
| Qt 渲染能力 | 插件 manifest 的 `qt.mode` | **Qt 侧新增** | 见 §6 拒绝条件 |

**协商原则：拒绝优于降级猜测。** compat-spec 已经把这条写死了：「Unsupported revisions are rejected rather than treated as a supported subset.」（`declaration-protocol.md:72-74`）。Qt 侧照抄这个态度。

`plugin-kit` 的 `HOST_VERSION='0.2.2-alpha.2'`（`protocol.js:53`）与本 checkout `0.2.3-alpha.2` 的错位（§1.1）必须由 t6/t9 决定：要么抬 kit 的 pin，要么声明「kit 生成物面向 0.2.2，Qt profile 面向 0.2.3，二者不保证互操作」。**现在不能宣称兼容。**

---

## 6. 「简单 React 可转子集」——能到哪、到哪就必须拒绝

### 6.1 先说结论

**没有任何「React → QML」自动转换。** 本文不宣称、也不规划任意 React 转换。原因不是工程量，而是语义：

- 官方槽位组件是 `(props) => ReactNode`（`ui-slots/src/index.ts:441`），一个**函数**。要把它变成 QML，需要执行它并调和返回的 React 元素树。
- React 元素树里可以有任何东西：hooks（`useState`/`useEffect`/`useContext`）、portal、异步 suspense、事件闭包、context provider。QML 没有对应的调度模型。
- Qt 侧 `SlotHost.qml` 的 `Loader` 只接受 `sourceComponent`（QML Component）或 `source`（QML 文件 URL）（`SlotHost.qml:170-171`）。它不会执行 JS 函数。

所以只有一条路是**真能落地**的：**把插件的 UI 意图降维成声明式 schema，而不是转换它的 React 代码。**

### 6.2 可转的「子集」到底是什么

这里的「子集」指：**一个 React 设置面板，若它的可见结构完全可以用下面 6 种控件表达，就可以用 schema 重述，由 `SettingsForm` 原生绘制。**

控件词表来自 `src/settings/schema.ts`：`SettingUiType = 'select' | 'slider' | 'toggle' | 'text' | 'number' | 'color'`。

| 可转（→ schema） | 不可转（→ 拒绝或回退） |
|---|---|
| 单个布尔开关 → `toggle` | 任何 `useState` / `useReducer` 本地状态 |
| 枚举单选 → `select`（必须有 `options`） | 任何 `useEffect` / 定时器 / 订阅 |
| 有限区间数值 → `slider` 或 `number` | 异步取数、`Suspense`、`fetch` |
| 单行文本 → `text` | 自定义布局（flex/grid/绝对定位/拖拽） |
| 颜色 → `color`（受 `SETTING_COLOR_PATTERN` 约束） | 列表增删、表格、树、虚拟滚动 |
| 分组与排序 → `section` + `order` | portal、`Context` provider、跨组件状态共享 |
| 标签/占位/单位/描述 → `label`/`placeholder`/`unit`/`description` | 事件回调、命令式 API、DOM 直接操作 |
| — | 任何 `dangerouslySetInnerHTML` 或任意 HTML |

这个子集**有实证支撑**：`SettingUiType` 的 6 个值在 `src/settings/forms.ts` 里每个都有对应 QML 控件（`FormControlToggle`/`Select`/`Number`/`Slider`/`TextInput`/`ColorPicker`，见 `qml/views/settings/`），并且 `tests/settings-forms.test.ts` 有 "every ui.type in the catalogue has a control" 这条测试守着。

### 6.3 拒绝与回退条件（硬规则）

按顺序判定，**任一条命中即不得原生渲染**：

| # | 条件 | 判定依据 | 动作 |
|---|---|---|---|
| R1 | 贡献既无 `schema`、也无 `qml`/`component` | 已在 `slots.ts:192-197` 实现 | 拒绝注册，返回 issue（不静默吞） |
| R2 | 贡献只有 React 组件（`SlotComponent`），无 schema、无 QML | manifest 无 `qt.mode`，且来源是 Web client bundle | **不注册**，记 `unsupported-react`，交给 §7 回退 |
| R3 | 声明 `qt.mode: "schema"`，但 schema 里出现词表外的 `ui.type` | `schema.ts` 的 `SettingUiType` 联合 | 拒绝该条，降级为 `text`（`SettingsForm.qml:24` 注释即此行为），并在 UI 上标注「降级绘制」 |
| R4 | 声明 `qt.mode: "qml"`，但 `qml` 路径加载失败 | `SlotHost.qml:91` `failedToLoad`、:177-179 发 `failed(id, reason)` | 该槽位显示内联错误，**面板其余部分不受影响**（`tst_settings.qml:293` 已测） |
| R5 | 贡献的 `surface` 不在宿主已声明面内 | `NATIVE_SLOT_SURFACES`（`constants.ts:67-75`）/ `surfaces` Set | 拒绝注册并回 `unknown-surface` |
| R6 | 同 surface 重复 `id` | `slots.ts:265-270` 已实现（settings 侧）；**`src/index.ts:257` 侧尚未实现** | 拒绝，**不得覆盖**（覆盖会让先注册者静默消失） |
| R7 | 平台不匹配 | `assertBundlePlatform`（`index.ts:543/585/1285`） | 不安装，报 `incompatible-version` |

**明确禁止的表述**：「Qt 原生 UI 可以渲染任意 React 插件 UI」。不成立，且与 `SlotHost.qml` 的实现直接矛盾。

---

## 7. 与 t5 的复杂插件回退协议（草案，待确认）

### 7.1 前提：t5 的结果缺失

t5（`web-fallback` / 「核对按需 WebUI 与嵌入兼容路径」）**执行失败**（attempt 1，503 `no_healthy_account`），无任何产出。因此本节是**单方面草案**，不是与 t5 达成的约定。必须由 t5 重跑后确认或推翻，最终并入 t9「冻结跨模块事件、桥调用与插件回退契约」。

### 7.2 分工边界（提议）

| 场景 | 归属 | 理由 |
|---|---|---|
| 贡献是 schema 或 QML | **Qt 原生**（t3 范围内） | `SlotHost.qml` 已支持，有 fixture |
| 贡献是 React 组件、且插件同时提供了 Web 构建产物 | **WebView 回退**（t5） | 需要真实浏览器引擎执行 React |
| 贡献是 React 组件、且插件**没有** Web 产物 | **拒绝**（t3 判定，t5 不兜） | 没有可执行的东西，回退也无意义 |
| 整个插件页（插件管理页）自身 | **Qt 原生** | 官方 `PluginManager` 是宿主服务，不需要 React |

### 7.3 提议的回退协议（需要 t5 确认的三条）

1. **判定点唯一**：由 `slotContributions()` 的调用方判定，不由 QML 判定。QML 永远只收到「能画的」或「明确标记为需回退的」两类，不允许它去猜。
2. **回退是逐槽位，不是逐面板**。一个插件的一个 tab 需要 React，不应该把整个设置面板推进 WebView——`SlotHost.qml` 的错误隔离已经证明逐槽位隔离是可行且已测的（`tst_settings.qml:293`）。
3. **回退必须可见**。用户要能看到「此面板由 WebView 渲染」，因为它的主题、快捷键、缩放、输入法行为都与原生不同。静默回退会被当成原生 bug。

### 7.4 与 t5 待对齐的开放问题

- WebView 的生命周期归谁（Qt 侧持有 `QWebEngineView` 还是 t5 的宿主服务）？
- React 18 从哪来？官方 web 声明 `^18.2.0`（`apps/web/package.json:63`），回退页面的模块表必须与之一致。
- 回退页与原生页如何共享 settings store？（原生侧唯一真相是 `SettingsStore`，`qml-bridge.ts:72-79` 明确「exactly one copy of the truth」。）

---

## 8. 失败与生命周期：四个必须覆盖的场景

### 8.1 重复 ID

| 侧 | 现状 | 需要的动作 |
|---|---|---|
| `SettingsSlotRegistry` | **已拒绝**，`slots.ts:265-270`，issue 文案 `a contribution with id X already exists on Y`；fixture：`tests/settings-forms.test.ts` | 保持 |
| `QtRendererService.registerSlot` | **静默覆盖**，`src/index.ts:257-263`（`this.slots.set(key, contribution)`，无检查） | 必须改为拒绝并返回失败结果，否则先注册者的 disposer 会把后来者的记录删掉 |

【源码实证】`src/index.ts:260-262` 的 disposer 是 `this.slots.delete(key)`，不带身份校验——这正是 `slots.ts:276-285` 用「记录仍为自身」规避的那个 bug。

### 8.2 失败隔离

- QML 侧：`SlotHost.qml` 的 `failed` 信号 + 内联错误标签（:97、:192-200），fixture `tst_settings.qml:293`。**已实现、已测。**
- 事件循环侧：`src/index.ts:154-156` 的 `onError` 只 `warn`，单 listener 失败不影响其余。**已实现。**
- 插件管理侧：官方 `change()` 把异常收敛为 `application='failed'`（`index.ts:1397-1408`），诊断事件失败不影响结果（:1459-1464）。**可直接依赖。**

### 8.3 卸载时的槽清理

顺序必须是：先停插件 fiber → 再由 `ctx.effect` 的 disposer 清槽 → 最后清 UI 模型。理由：官方 `removeBundle` 在非 HMR 且仍 started 时直接抛 `stop-profile`（`index.ts:1160-1168`），且 reload 后若仍有 fiber 存活抛 `bundle-in-use`（:1170-1173）。**Qt 侧若先清槽再停 fiber，会出现「插件还在跑但 UI 已消失」的中间态。**

### 8.4 安装回滚

依赖官方语义，**不自己实现**：

- 失败/取消 → 恢复 `package.json` + `pnpm-lock.yaml`，但**已下载文件可残留**（`index.ts:966-972`）。UI 文案必须如实写，不能写「完全回滚」。
- 更新失败 → `restore` 阶段按原来源重装（:789-806）。
- 全部包在 `withFileLock`（:1376-1440）里，Qt 侧不需要额外加锁，但**必须处理锁等待超时**（默认 120000 ms）。

---

## 9. 原生 / Web 示例验证矩阵

「示例验证」= 用现有 fixture 证明哪一段是真的通的，哪一段不是。

**本次实际执行过的一条命令**（这是本文唯一的运行时证据）：

```
cd dsh-qt-app && npx tsx --test tests/*.test.ts
→ tests 319 / pass 319 / fail 0 / duration 2359ms
```

它只覆盖 **TypeScript 侧**。QML fixture 需要 Qt 构建环境与 `qmltestrunner`，**本次未运行**（任务约束为只读、不启动服务），故下表中 QML 行标注为「fixture 存在，本次未运行」——这不是「已验证通过」。

| 环节 | 验证手段 | 状态 |
|---|---|---|
| TS 全套单测 | `npx tsx --test tests/*.test.ts` | **本次实跑通过 319/319** |
| schema 贡献 → 原生表单 | `tst_settingsplugin.qml:62` | fixture 存在，本次未运行 |
| 表单编辑回传 | `tst_settingsplugin.qml:91` | fixture 存在，本次未运行 |
| QML Component 贡献 | `tst_settingsplugin.qml:118` | fixture 存在，本次未运行 |
| 空贡献文案 | `tst_settingsplugin.qml:145` | fixture 存在，本次未运行 |
| order 排序 | `tst_settingsplugin.qml:164` | fixture 存在，本次未运行 |
| 坏槽位隔离 | `tst_settings.qml:293` | fixture 存在，本次未运行 |
| 注册表拒绝重复 ID | `tests/settings-forms.test.ts` | **本次实跑通过** |
| dispose 幂等 | `tests/settings-forms.test.ts` | **本次实跑通过** |
| acceptedSurfaces 双端一致 | `tests/settings-slots.test.ts` | **本次实跑通过**（QML 半边未运行） |
| **TS 插件 → registry → QML** | 无 | **未验证**（`slotContributions()` 不存在） |
| **真实 Cordis 插件注册** | 无 | **未验证**（未操作真实插件） |
| **官方 `PluginManager` 调用** | 无 | **未验证**（未启动服务） |
| **plugin-kit 生成物在本 profile 加载** | 无 | **未验证**（kit 自身也声明 "never been loaded"） |
| **React 组件在 Qt 原生渲染** | 无 | **不成立**（架构上不可能，见 §6） |

### 9.1 实现阶段必须补的 fixture（按优先级）

1. `slotContributions("conversation.settings.*")` 通配匹配 + 排序 + 形状 B 完整字段 —— TS 单测。
2. 同一 id 在 `QtRendererService.registerSlot` 上被拒绝，且先注册者的 disposer 不影响后来者 —— TS 单测。
3. `ctx.effect` 包装后 fiber dispose 触发槽清理 —— TS 单测（可用 `createInMemorySettingsBridge` 同款内存替身思路）。
4. 一个「声明 schema 的假插件」从 registry 到 QML 的端到端 —— QML fixture + TS 侧注入。
5. `PluginManager` 替身（stub）驱动的插件页状态机：`readOnlyReason` / `stop-profile` / `bundle-in-use` / `restart-required` 四条文案路径。

**在 1–5 全部绿之前，不得声称「插件管理已可用」。**

---

## 10. 文件边界

### 10.1 本任务（t3）只写了一个文件

```
dsh-qt-app/docs/PHASE-3-PLUGIN-SDK.md    # 本文件
```

除此之外**未修改任何文件**。只读核验，未启动服务，未操作真实插件。

### 10.2 实现阶段建议的写入边界

| 文件 | 变更性质 | 风险 |
|---|---|---|
| `dsh-qt-app/src/index.ts` | 改 `registerSlot` 加重复校验 + `ctx.effect`；新增 `slotContributions(pattern)` | 中：`slots` Map 形状若从 A 换到 B，是破坏性变更 |
| `dsh-qt-app/src/types.ts` | `QtSlotContribution` 补 `kind`/`scope`/`payload` | 中：形状 A 目前无人消费，替换成本低，但要一次换干净 |
| `dsh-qt-app/src/settings/slots.ts` | 基本不动（已是对的），可能需要 surface 名对齐 | 低 |
| `dsh-qt-app/src/bridge/qml-bridge.ts` | 新增插件管理方法通道（`plugin.list/enable/install/remove/update`） | 中：要守住「不跨边界抛异常」规则（:9-19） |
| `dsh-qt-app/qml/views/settings/PluginsSettings.qml` | 替换占位为真实列表 | 低 |
| `dsh-qt-app/qml/views/settings/PluginManager*.qml` | 新增 | 低 |
| `dsh-qt-app/tests/*.test.ts` | 新增 fixture（§9.1） | 无 |

**不得触碰**：

- `/data/dsh-official/**` —— 官方源码，本阶段不改。
- `dsh-qt-napi/vendor/cmark-gfm/**` —— 第三方，许可证必须原样保留。
- EAC（`/data/EAC-Desktop` 的 EAC 部分）—— 不合入。
- `dsh-qt-app/package.json` 的 `exports` —— SDK 入口位置由 t6 决定。

---

## 11. 开放问题（需要 t6/t9 或对应负责人裁决）

| # | 问题 | 影响 | 建议归属 |
|---|---|---|---|
| O1 | manifest 里的 `qt` 扩展字段如何合法化？compat-spec 拒绝未知字段（`declaration-protocol.md:69-71`） | 阻塞 manifest 定稿 | t6 |
| O2 | `conversation.settings.*` 这个 Qt 私有命名要不要改回官方的 `settings.section`？改了要动 QML + TS + fixture | 影响回退协议与插件复用 | t9 |
| O3 | `QtSlotContribution` 形状 A 是直接替换成 B，还是保留 A 做内部视图？ | 破坏性 vs 复杂度 | t6 |
| O4 | plugin-kit `HOST_VERSION` 0.2.2-alpha.2 与本 checkout 0.2.3-alpha.2 的错位怎么处理 | 决定「kit 生成物能否装进 Qt profile」 | t6 |
| O5 | qt-app 声明 `cordis ^4.1.0`，kit pin `4.0.6-alpha.1`，谁让 | 同上 | t6 |
| O6 | SDK 落地位置（独立包 / qt-app 子路径导出 / 纯类型文档） | 决定 §5 是代码还是文档 | **t6** |
| O7 | WebView 回退的引擎归属与 React 来源 | 阻塞 §7 | t5（需重跑）+ t9 |

---

## 12. 一页结论

1. 官方插件服务的**能力面是完整的**（列表/启停/安装/卸载/更新/版本/豁免/构建批准，§2.1 全带行号），事务、锁、回滚、失败隔离都是现成的，**Qt 侧应当直接调用，不要重写**。
2. qt-app 对插件管理**零接线**（全仓 0 命中），`PluginsSettings.qml:83` 那个禁用的按钮就是全部现状。
3. 槽位契约有**三处不一致**：两套 TS 形状并存（`types.ts:62` vs `slots.ts:49`）、QML 期望的 `slotContributions()` 不存在（`SettingsPanel.qml:127`）、官方槽位名与 Qt 槽位名不同（`settings.section` vs `conversation.settings.section`）。这是 Phase 3 的第一优先修复项。
4. **不存在 React → QML 转换**。可落地的是「把 UI 意图降维成 6 种控件的 schema」；其余按 §6.3 的 R1–R7 拒绝，或按 §7 交给 WebView。
5. 版本错位真实存在（Cordis 4.1.0 vs pin 4.0.6-alpha.1；宿主 0.2.3-alpha.2 vs kit 0.2.2-alpha.2），**不能宣称兼容**，须由 t6/t9 裁决。
6. 许可证：自有组件与生态项目全部 MIT（两个 `LICENSE` 首行均 `MIT License`）。唯一例外是 vendored cmark-gfm（**BSD-2-Clause**，`PROVENANCE.md` 明示），其 `COPYING` 为复合文件且含 CC-BY-SA 4.0 片段——但 `test/spec.txt` 未 vendored，故该片段不随本仓分发。分发二进制时必须原样带上 `COPYING` 与 `PROVENANCE.md`。
