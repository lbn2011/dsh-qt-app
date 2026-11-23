# Phase 3 · LLM 配置与 Settings 接线核验（t4）

范围：`dsh-qt-app` 的 Settings/LLM 接线，对照官方 DSH（`@deepseek-ai/dsh@0.2.2-rc.1`，实读其 `lib/types/*.d.ts`）的供应商、模型、凭据、设置服务真实 API。
方法：只读核验源码 + 已安装包类型声明；未读取任何真实 key，未调用付费模型，未改动用户配置。
平台：Windows 优先、Linux 支持、macOS 缺口在 §10 如实标注。

---

## 0. 结论摘要

| # | 结论 | 影响 |
| --- | --- | --- |
| C1 | `settingsBridge` 恒为 `null` 不是「忘了赋值」，而是**跨进程拓扑**下 C++ 无法注入 JS 对象：Qt 宿主与 Node 之间只有换行分隔的 stdio JSON-RPC，没有对象通道 | 必须改为「C++ 属性 + NOTIFY」或「RPC 快照」推送，QML 侧自建 bridge |
| C2 | 该 RPC 通道**两端都没有服务端实现**：`src/` 内零 `spawn`、零 `process.stdin`，`QmlBridge` 在生产路径从未被实例化 | 这是 Phase 3 的 G0 前置缺口，影响所有模块，不只是设置 |
| C3 | 生产路径从未调用 `createSettingsStore()`，`ctx.settings` 也不存在 → 即使通道打通，`settings.get/set` 也只会回 `unavailable` | 必须补宿主入口并明确「自有 store vs 官方 `ctx.settings`」的分工 |
| C4 | 内置 schema 只有 7 项外观/消息/编辑器设置，**没有任何 LLM/供应商/模型/凭据字段** | LLM 配置不是「补几个字段」，而是要接官方命名空间视图 |
| C5 | theme/font 存在 **2 个文件 3 个写者**，且 `auto` 语义已分叉 | 必须先定唯一来源，否则 LLM 页一起进来后写冲突会被放大 |
| C6 | 官方已有完整且带脱敏 + 乐观并发的设置/凭据/模型 API，**不要自建第二套** | Qt 侧只做投影与控件，不复制 schema、不落明文 key |

---

## 1. 现状核验（逐条带证据）

### 1.1 `settingsBridge = null`

- `qml/main.qml:202` `readonly property var settingsBridge: null`，注释自述「Left null on purpose: a QML-side descriptor object would have to be pushed from Node, and until that exists the forms use the fallback descriptors they ship with」。
- 消费方仅 4 个文件：`qml/main.qml`、`qml/views/settings/{SettingsPanel,ThemeForm,MessagesForm,LanguageForm}.qml`。统一模式：
  `fields: (bridge && typeof bridge.fields === "function") ? bridge.fields(root.formSection) : root.fallbackFields`。
- `native/main.cpp` 只提供 `submit_()` + 信号（`settingRead` / `settingSaved` / `requestReplied`），**从未构造可注入 QML 的 bridge 对象**；`getSetting()` / `saveSetting()` 返回的是请求 id 字符串，不是值。
- 结论：`null` 是拓扑决定的，不是遗漏。修法见 §5 G2。

### 1.2 描述符推送

- 不存在。JS 侧方法白名单只有 `settings.get|set|save|all`（`src/bridge/qml-bridge.ts:45-48, 205-212`），没有 `settings.describe` / `fields` / `formSections` / `revision` / `location`；C++ 侧也没有对应 submit。
- `src/settings/qml-bridge.ts` 里那套完整的 `SettingsQmlBridge`（`get/set/all/names/sections/fields/formSections/revision/location/lastError`）**只在测试里用**（`tests/settings-forms.test.ts`、`tests/qml-bridge.test.ts`），生产路径无引用。
- 后果：表单只能显示各 `*Form.qml` 自带的 `fallbackFields`；描述符与 store 无单一来源，改 schema 不会自动反映到 UI。

### 1.3 读写路径

- 读：QML → `window.qtBridge.getSetting(name)` → `settings.get` → Node `QmlBridge` → `settingsFromStore(store).get()` → `SettingsStore.get()`。
- 写：QML → `window.qtBridge.saveSetting(name, value)` → `settings.set` → `settingsFromStore().set()`（`try/catch` 把异常规范成 `false`）→ `SettingsStore.set()`（先校验，失败不改动）。
- 断点：`src/bridge/services.ts:206` 的 `wired.settings = settingsFromStore(...)` 只在 `createServiceBridge()` 里，而 `createServiceBridge` / `createContextBridge` / `new QmlBridge(...)` 在 `src/` 内**零调用**（仅 `tests/qml-bridge.test.ts`）。`src/index.ts` 的 `apply()` 只做两件事：`new QtRendererService()` + 启动 10 ms 事件循环。
- 另一侧：`native/main.cpp` 的 `StdioTransport` 读 stdin、写 stdout，注释写「The Node side writes one JSON object per line to our stdin」，但仓内 `grep -rn "process.stdin\|readline\|createInterface"` 与 `grep -rn "spawn\|child_process"` 均**零命中**。
- 结论：读写链路在类型层完整、在运行层两端悬空（G1/G3/G4）。

### 1.4 重启回读

- 设计上具备：`SettingsStore.load()` 处理首启/损坏备份/未来版本只读，`createFileSettingsStorage()` 原子写，`settings.json` 带 `schemaVersion`。
- 实际上不具备：`load()` 在 `src/` 内唯一调用点是 `createInMemorySettingsBridge()`（`src/settings/qml-bridge.ts:206`），而它同样只在测试中使用。生产启动路径无人 `load()`。
- theme 一侧相反：`native ThemeBridge::load()` 在启动时读 `theme.json`，所以**重启后主题能回读，普通设置不能**。这种不一致本身就是接线缺口的证据。

### 1.5 已核实的其它事实

- `package.json` 依赖只有 `@deepseek-ai/cordis`、`cordis-plugin-include`、`cordis-plugin-loader`；**不含** `dsh-settings` / `dsh-llm` / `dsh-credentials`，`inject: string[] = []`。
- `src/constants.ts` 声明 `SETTINGS_SLOT_SURFACES = ['conversation.settings.section', 'conversation.settings.form']`，`SettingsPanel.qml` 内置 4 个 tab：Theme / Language / Plugins / About —— **没有 Models 页**。
- QML 控件能力（`SettingsForm.qml:191-207` + `FormControl.qml`）：`toggle / select / slider / number / text / color`，未知类型回落 text。**没有密码框、没有可重复列表编辑器、没有卡片式行、没有状态徽标**。
- 空态：`SettingsForm.qml` 有 `settingsFormEmpty`（"This section has no settings yet."）；加载态、错误态、冲突态均无。

---

## 2. 官方真实 API（Qt 侧只做投影，不复制）

### 2.1 设置：`ctx.settings`（`dsh-settings`）

```ts
class SettingsForms extends Service {
  get writable: boolean
  get documentPath: string
  prepareDocument(): Promise<string>
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
  update(ns, patch: object, expectedRevision?: number): Promise<void>
  replace(ns, section, expectedRevision?: number): Promise<void>
  mutate(ns, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}
// SettingsDescriptor { ns, autoGenerate, schema, value, revision, base?, user?, applies: 'live', secrets?: RedactedSecret[] }
// SettingsConflictError.code = 'SETTINGS_CONFLICT'（expected / actual）
// SettingsPathOp = { op:'set', path: string[], value } | { op:'unset', path: string[] }
```

关键语义（源码注释原文）：路径式 `mutate` 存在的理由是「a configuration UI reads the redacted descriptor, which by construction never received the `role('secret')` fields … a wholesale `replace` rebuilt from a redacted document silently deletes every secret the wire never returned」。
⇒ **Qt 侧禁止用 `replace` 提交从脱敏视图重建的整段配置**，只能发路径操作。

### 2.2 远端控制器（`dsh-api-settings-controller`）

`ctx.remote.settings`：`describe(): SettingsDescribeValue`、`update(ns, patch, expectedRevision)`、`replace`、`mutate`、`openSettingsDocument(signal)`；拒绝码 `settings/conflict`、`settings/rejected`。
`ctx.remote.credentials`：`describe(refs: string[]): Record<string, CredentialInfo>`（批量，超上限拒绝）、`set(ref, value)`、`unset(ref)`；注释「Secret values cross in one direction only — no method here returns one」；拒绝码 `credential/rejected`。

视图类型：`SettingsNamespaceView { autoGenerate, ns, schema: JsonValue, value, base?, user?, applies:'live', secrets: SettingsSecretView[], revision }`；`SettingsSecretView { path: string[], set: boolean }`；`SettingsDescribeValue { writable, hasDocument, namespaces }`；事件 `settings/document-updated`。
脱敏：`redactSecrets(schema, value) → { value, secrets: RedactedSecret[] }`，`role('secret')` 字段在跨 wire 前被移除。

### 2.3 供应商与模型：`ctx.llm`（`dsh-llm`）

```ts
listProviders(): LlmProviderInfo[]                       // { id, name }
listConfigurableProviders(): LlmConfigurableProvider[]   // { provider, displayName, settingsNs, settingsPath, declared?, defaultBaseURL?, baseURLEnv?, nativeAuth? }
registerModelDiscovery(settingsNs, discover)
discoverModels(settingsNs, request: LlmModelDiscoveryRequest, signal?): Promise<LlmDiscoveredModel[]>  // 拒绝码 llm/model-discovery-rejected
listModels(provider); resolveModelInfo(provider, model); resolveCallConfig(config); prepareCall(config); stream(options)
```

- `LlmModelDiscoveryRequest { provider?, baseURL?, api?, apiKey? }`，`apiKey` 注释：「Credential for this interrogation alone; the harness never stores it」。
- `LlmDiscoveredModel { id, name?, contextWindow?, maxTokens?, inputModalities? }`。
- `LlmNativeAuth { env: readonly string[], oauth: boolean }`（无凭据引用、靠环境变量或 OAuth 认证的路由）。
- 凭据诊断 `assertUsableApiKey(raw, pkg, ref)` 的注释直接就是我们的日志准则：「The key never enters the message: `ref` names where to fix it, and echoing any part of a secret into a log or a UI is the failure this diagnosis avoids」。

供应商配置真实字段（两个适配器族）：

| 供应商 | 配置形态 | 关键字段 |
| --- | --- | --- |
| DeepSeek（`dsh-llm-deepseek`） | 扁平 `Config`，**无 apiKey 字段** | `baseURL?`（回退 `$DEEPSEEK_BASE_URL`，再回退 `https://api.deepseek.com/anthropic`）、`thinking?`、`reasoningEffort?`（默认 `high`）、`maxTokens`（默认 256000）、`defaultContextWindow`（默认 1e6）、`models: DeepSeekCatalogModel[]`、`streamIdleTimeoutMs`、`retryPolicy?` 等 |
| 通用多供应商（`dsh-llm-pi-ai`） | `providers: Record<route, PiAiProviderProfile>`，**dict key 即路由 id** | `apiKeyEnv?`（「Credential reference (environment-variable name) resolved per request through `ctx.credentials`」）、`displayName?`、`api?`、`baseURL?`、`models?: PiAiModelProfile[]`、`modelOverrides?`、`compat?`、`defaultContextWindow?`、`defaultMaxTokens?`、`defaultInput?`（默认 `[text]`，不可为空）、`headers?`、`reasoning?`、`thinkingBudgets?`、`cacheRetention?`、`transport?`、`timeoutMs?` |

### 2.4 默认 / 会话模型（`dsh-agent-default-model`）

`ctx.agentDefaultModel`：`Config { provider, model, reasoningEffort? }`（均 `Volatile`）、`currentSelection(): ModelSelection`、`saveSelection(next): Promise<void>`（「Saves commit in submission order」）。
Qt 侧现状：`qml/models/SessionModel.qml:21` 有 `property string model`，由宿主 update 写入，**只读展示**；没有切换入口。

### 2.5 凭据存储（`dsh-credentials-local`）

- 位置：`$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`），**不是 keyring**，是带跨进程写锁的 YAML 映射 `CredentialRef → string`。
- 优先级：托管文件 > 继承的进程环境 > `<cwd>/.env` > `$DSH_HOME/.env`（后三者只读，provider 从不写）。
- 写入语义：每次写入重新读文档、只 patch 自己那个 key，注释与其它条目格式保留；外部改动热发布；删除的条目不会残留在内存快照。
- 空值 = 未配置。
- ⇒ 「沿用官方秘密存储」= 调 `ctx.credentials.set(ref, value)` / `remote.credentials.set`，**绝不**把 key 写进 `settings.json` 或任何 QML 属性。

### 2.6 官方 Models 页的现成契约（`dsh-client-ui-settings-models`）

可直接照搬的操作集合（`operations.d.ts`）：

```ts
storeCredential(ref, value): Promise<string | undefined>   // 返回拒绝文案，成功为 undefined
removeCredential(ref): Promise<string | undefined>
writeSettings(ns, ops: SettingsPathOpView[], expectedRevision): Promise<
  | { kind:'written', view: SettingsNamespaceView }
  | { kind:'conflict', message }
  | { kind:'refused', message }>
discoverModels(settingsNs, request): Promise<{ kind:'found', models } | { kind:'refused', message }>
```

页面快照（`store.d.ts`）：`status: 'idle'|'loading'|'ready'|'error'`、`error`、`credentialError`（凭据增强失败不影响行可用）、`writable`、`rows: ProviderRow[]`、`namespaces: Map<ns, SettingsNamespaceView>`。
`ProviderRow` 字段：`entry`（join 后的 `llm/listProviders` × `llm/listConfigurableProviders`）、`configured`、`removable`、`apiKeyEnv`、`credential?: CredentialInfo`、`derivedCredential?`、`credentialChecks?`、`accountAvailable?`。
辅助规则：`deriveKeyRef(provider)` 由路由 id 推导引用名（如 `minimax-cn` → `MINIMAX_CN_API_KEY`）；`apiKeyFailure(draft)`：空 = 不失败（保持已存），**纯空白 = 失败**（`keyBlank`），非法字符 = 失败（`keyIllegalCharacters`）。

---

## 3. 字段 → 控件 → API 映射

### 3.1 新增 `models` section（数据全部来自官方命名空间视图）

| 字段（视图来源） | 控件 | 现有能力 | 读 API | 写 API |
| --- | --- | --- | --- | --- |
| 供应商列表（`joinProviderDirectory` 结果） | 卡片列表 + 激活/未激活徽标 + 错误行 | 缺卡片、缺徽标 | `llm.listProviders()` + `llm.listConfigurableProviders()` | — |
| `displayName` / `provider` | 只读文本（标题/副标题） | 有 text（只读） | 同上 | — |
| `active`、`declared` | 徽标 | 缺 | 同上 | — |
| `settingsNs` / `settingsPath` | 隐藏（内部路由） | — | 同上 | 写操作的 `ns` 参数 |
| `baseURL` | 文本输入 + 占位符显示 `defaultBaseURL` / `baseURLEnv` 提示 | 有 text | `describe()` → `nodeAtPath(settingsPath + ['baseURL'])` | `mutate(ns, [{op:'set', path:['baseURL'], value}], expectedRevision)` |
| `apiKeyEnv`（引用名） | 文本输入 + 「已配置/未配置」徽标 | 缺徽标 | `remote.credentials.describe([ref])` → `CredentialInfo` | `mutate(ns, [{op:'set', path:['apiKeyEnv'], value: ref}])` |
| API key 明文 | **密码框**（`echoMode: TextInput.Password`）+ 提交后立即清空 | **缺**（需新增 `ApiKeyField.qml`） | 只读 `CredentialInfo.configured`，永不取值 | `remote.credentials.set(ref, value)` / `unset(ref)` |
| `models`（模型列表） | 可重复行编辑器（id / contextWindow / maxTokens / 删除 / 新增） | **缺**（需新增 `ModelListEditor.qml`） | `describe()` → 路径读 | 一次性 `mutate` 多条 `set/unset` 路径操作（不要 `replace`） |
| 模型发现结果 | 「探测」按钮 + 候选列表勾选 | 缺 | `llm.discoverModels(settingsNs, { baseURL, api, apiKey })` | 勾选后转成模型列表写操作 |
| `reasoningEffort` | 下拉（`off/low/high/max`，DeepSeek 默认 `high`） | 有 select | `describe()` 路径读 | `mutate` |
| `thinking` | 开关（`enabled/disabled`） | 有 toggle | 同上 | `mutate` |
| `maxTokens` / `defaultContextWindow` | 数字输入（整数、正、有限） | 有 number | 同上 | `mutate` |
| `nativeAuth`（`env[]` / `oauth`） | 只读提示（「此路由从环境变量认证」） | 缺 | 目录条目 | — |
| 默认模型 `provider` / `model` / `reasoningEffort` | 两个下拉 + 一个下拉 | 有 select | `agentDefaultModel.currentSelection()` | `agentDefaultModel.saveSelection({...})` |
| 会话模型（当前会话实际使用） | 只读标签（在 `SessionHeader`） | 有 label | `SessionModel.model` | —（Phase 3 不做会话级切换） |
| 冲突提示条 | 顶部内联横幅 + 「重新加载」 | 缺 | `writeSettings` 返回 `conflict` | 重新 `describe()` |

### 3.2 既有 appearance/messages/editor section（继续走本地 `SettingsStore`）

保持现状的 7 个字段不动，**唯一例外是 `theme` 与 `fontSize`（见 §7）**。
来源划分规则（要写进 t9 契约）：**同一个设置键只能属于一个来源**；`models` 下的键一律来自官方命名空间，本地 store 的 schema 里不得出现同名键。

### 3.3 控件能力缺口（QML 侧要新增的最小集）

1. `ApiKeyField.qml`：密码框 + 「已配置」徽标 + 空白/非法字符前端判定（复刻 `apiKeyFailure` 规则：空 = 保持，纯空白 = 报错）+ 提交后清空 draft。
2. `ModelListEditor.qml`：可重复行（增/删/改），提交前做整段校验。
3. `ProviderCard.qml`：行卡片 + 状态徽标 + 行内错误。
4. `SettingsForm.qml` 增补三态：`loading`（骨架/占位）、`error`（含重试）、`conflict`（含重新加载）。

---

## 4. 时序

### 4.1 面板打开（加载 / 空态）

```
QML  SettingsPanel.opened
      │  bridge.fields(section)        ← 本地 store 的 descriptors（同步、纯函数）
      │  bridge.describeModels()       ← 新增，返回 Promise/信号驱动
      ▼
C++   submit('settings.describe')      ← 一次拿全部命名空间（脱敏）
      submit('llm.directory')          ← providers ∪ configurableProviders
      submit('credentials.describe', {refs})   ← 批量，仅 ref 名
      ▼
Node  ctx.settings.describe({redactSecrets:true})
      ctx.llm.listProviders() + listConfigurableProviders()
      ctx.remote.credentials.describe(refs)
      ▼
C++   settingsSnapshotChanged(snapshot)   ← 单次信号，含 revision/ns/rows/error
      ▼
QML   status: loading → ready | error
      行渲染（空态：无任何可配置供应商时显示「没有可配置的供应商」+ 引导）
```

要点：**打开面板不做任何写操作**；`describe` 是幂等只读；凭据读取只返回 `{configured, kind, writable}`。

### 4.2 保存（乐观更新 + 失败回滚）

```
QML  字段编辑 → 本地 draft
      onEditingFinished → bridge.setPath(ns, path, value, expectedRevision)
      ▼
C++  submit('settings.mutate', {ns, ops:[{op:'set',path,value}], expectedRevision})
      ▼
Node ctx.settings.mutate(ns, ops, expectedRevision)
      ├─ ok          → 返回新 revision + 该 ns 新视图
      ├─ SETTINGS_CONFLICT → 返回 {kind:'conflict', message}（不重试、不自动合并）
      └─ 其它拒绝     → {kind:'refused', message}
      ▼
C++  settingSaved(id, ns, accepted, error) + settingsSnapshotChanged
      ▼
QML  accepted → 用视图里的生效值回填（服务端可能 clamp）
      !accepted → 回滚到最近一次快照值 + 行内错误文案 + 保留 conflict 横幅
```

硬约束：**提交只发路径操作**，禁止 `replace` 整段（会静默删掉脱敏视图从未拿到的 secret 字段）。

### 4.3 凭据（单向）

```
QML  ApiKeyField.draft（仅在内存，不进 settings、不进持久化 QML 属性）
      apiKeyFailure(draft) 为空 → 直接 return（保持已存）
      ▼
C++  submit('credentials.set', {ref, value})   ← value 只在这一跳出现
      ▼
Node ctx.remote.credentials.set(ref, value) → $DSH_HOME/.credentials.yaml
      ▼
C++  回 {ok} 或 {error: 拒绝文案}（**永不回显 value**）
      ▼
QML  成功：draft 立即清空 + 徽标置「已配置」；失败：显示文案，draft 保留
```

### 4.4 模型发现（不联网的验证路径见 §9）

```
QML  「探测」→ { baseURL, api, apiKey: draft ?? undefined }
C++  submit('llm.discoverModels', {settingsNs, request})
Node ctx.llm.discoverModels(settingsNs, request)
     ├─ found   → 候选列表（只填 UI，不自动保存）
     └─ refused → 内联错误（llm/model-discovery-rejected）
```

### 4.5 重启回读

```
启动 → native ThemeBridge::load() 读 theme.json（已有）
      → 宿主入口 load() 官方 settings 文档（ctx.settings.describe 即从 documentPath 读）
      → 面板打开 → describe 一次 → 值来自持久化层
断言：重启后 ①LLM 供应商/模型/endpoint 一致 ②凭据只有「已配置」状态一致、明文不出现 ③主题一致
```

---

## 5. 接线缺口清单

| ID | 缺口 | 证据 | 归属 |
| --- | --- | --- | --- |
| **G0** | Node 侧无 stdio 服务端：无 `spawn`、无 `process.stdin`，`QmlBridge` 生产路径零实例化 | `grep -rn "spawn\|child_process\|process.stdin" src/` 零命中；`new QmlBridge(` 仅测试 | t1/t6（跨模块前置） |
| **G1** | 自有 `SettingsStore` 未挂载：`createSettingsStore()` 在 `src/` 零调用 | `src/settings/store.ts:628` 仅导出 | 本任务 |
| **G2** | `settingsBridge` 无填充路径：C++ 只有 RPC id，无对象/属性 | `main.qml:202`；`main.cpp` 仅 `submit_`+信号 | 本任务 |
| **G3** | RPC 白名单缺 `settings.describe/save/revision/location`、全部 `llm.*`、`credentials.*` | `qml-bridge.ts:45-48, 205-212` | 本任务 |
| **G4** | 无 LLM 设置命名空间映射：Qt 无 `models` section，schema 无 LLM 键 | `schema.ts` BUILTIN_SETTINGS 7 项 | 本任务 |
| **G5** | 无凭据 UI（密码框/徽标），无「已配置」只读语义 | `FormControl.qml` 只有 6 类 | 本任务 |
| **G6** | 无 revision/冲突处理：`settings.set` 单值无 `expectedRevision` | `qml-bridge.ts:613-624` | 本任务 |
| **G7** | theme/font 三写两文件、`auto` 语义分叉 | 见 §7 | 本任务（与 t1 协商） |
| **G8** | 加载/错误/冲突三态缺失 | `SettingsForm.qml` 仅 `settingsFormEmpty` | 本任务 |
| **G9** | 生产路径无 `load()` → 普通设置重启不回读 | `load()` 仅 `qml-bridge.ts:206`（in-memory bridge） | 本任务 |
| **G10** | macOS 无 Qt 构建/运行验证 | `build.yml` 矩阵仅 ubuntu-22.04 + windows-2022 | 全员，如实上报 |

---

## 6. 文件范围

### 6.1 新增（TS）

| 文件 | 职责 |
| --- | --- |
| `src/settings/official.ts` | 官方 `ctx.settings` 命名空间 → 现有 `SettingsFieldDescriptor` 的投影（schemastery JSON → `uiType/options/min/max/step`）；只读，不含写逻辑 |
| `src/llm/directory.ts` | `joinProviderDirectory` 的 Qt 侧等价实现 + `deriveKeyRef` |
| `src/llm/operations.ts` | `storeCredential` / `removeCredential` / `writeSettings` / `discoverModels` 四个操作的 Node 侧实现（对齐官方 `ModelsOperations`，含 `written/conflict/refused` 三态） |
| `src/bridge/settings-rpc.ts` | 新增 RPC 方法注册（`settings.describe`、`settings.mutate`、`settings.save`、`llm.directory`、`llm.discoverModels`、`llm.defaultModel.*`、`credentials.describe/set/unset`），参数校验与错误码映射 |
| `src/settings/migrate-v2.ts` | `theme`/`fontSize` 从 `settings.json` 迁出到 `theme.json`（§7） |

### 6.2 修改（TS）

| 文件 | 改动 |
| --- | --- |
| `src/bridge/qml-bridge.ts` | 白名单与 dispatch 扩展（保持「不抛过边界」的既有约定） |
| `src/index.ts` | `apply()` 内挂载：创建/加载本地 store、`createContextBridge()`、把 sink 接到宿主 stdio（依赖 G0 的宿主入口） |
| `src/bridge/services.ts` | 新增 `settingsOfficialFromCtx` / `llmFromCtx` / `credentialsFromCtx` 适配器（沿用「无能力报 unavailable」规则） |
| `src/settings/schema.ts` | schema v2：`theme`/`fontSize` 移除或标 `transient` 只读镜像（见 §7 决策） |
| `src/settings/paths.ts` | `SETTINGS_FILE_VERSION = 2` + 迁移分支 |

### 6.3 新增（QML）

`qml/views/settings/ModelsSettings.qml`、`ModelForm.qml`、`ProviderCard.qml`、`ApiKeyField.qml`、`ModelListEditor.qml`、`StatusBadge.qml`。

### 6.4 修改（QML / C++）

| 文件 | 改动 |
| --- | --- |
| `qml/main.qml` | `settingsBridge: null` → 内联 `SettingsBridgeQml`（属性读 `dshQt.settingsSnapshot` + `settingsChanged` 信号重算）；`saveSetting` 增 `ns`/`expectedRevision` 形参 |
| `qml/views/settings/SettingsPanel.qml` | 新增 `models` tab（`builtinTabs` 追加）+ 三态渲染 |
| `qml/views/settings/SettingsForm.qml` | `loading/error/conflict` 三态 + 新控件分派 |
| `qml/views/settings/ThemeForm.qml` | 移除 `theme`/`fontSize` 描述符（改由 `ctx.theme` 单一来源），保留 `ThemeSettings.qml` 现路径 |
| `native/main.cpp` | 新增 `Q_PROPERTY(QVariantMap settingsSnapshot ... NOTIFY settingsChanged)`、`settings.describe` / `settings.mutate` / `credentials.*` / `llm.*` 的 submit 包装与信号；`saveSetting` 增加 `ns`、`expectedRevision` |
| `qml/views/SessionHeader`（现 `components/SessionHeader.qml`） | 会话模型只读标签（若尚无） |

### 6.5 测试

`tests/settings-official.test.ts`、`tests/llm-operations.test.ts`、`tests/settings-migrate-v2.test.ts`、`tests/qml/tst_modelsSettings.qml`、`tests/qml/tst_apiKeyField.qml`。

---

## 7. theme / font 唯一来源（决策）

现状：`theme.json{themeId,fontScale}` 与 `settings.json{theme,fontSize}` 并存；写者有 3 个 —— native `ThemeBridge::persist()`、Node `theme/manager.ts` `persist_()`、Node `SettingsStore.persist_()`；且 native 在 `applyTheme()` 里把 `"auto"` 解析成具体 scheme 后写盘，`settings.json` 仍可存 `"auto"`，**同一意图两种持久化语义**。

**决策：`theme.json` 为唯一权威，单一写者。**

1. 唯一写者 = native `ThemeBridge`（`QSaveFile` 原子写，已有）。理由：QML 重绘必须同步读 `themeId`/`fontScale`，跨进程 RPC 往返会闪一帧；native 已经负责系统配色解析。
2. Node `ThemeManager` 在检测到 native bridge 存在时降级为**只读镜像**：`applyTheme` 走 `theme.apply` RPC，不再 `persist_()`；仅在无 native 宿主（headless 测试）时保留写权限。
3. `settings.json` 的 `theme` / `fontSize` **移出 schema（v2）**，迁移规则：若 `theme.json` 不存在且 `settings.json` 有值 → 用 settings 的值初始化 `theme.json`，然后从 `settings.json` 删除这两个键；两者都有 → `theme.json` 胜（它是 live 值），`settings.json` 的键静默删除并记一条 `migrated` 日志（不含值以外信息）。
4. `ThemeForm.qml` 的两个描述符随之移除，主题面板只经 `ThemeSettings.qml` → `ctx.theme` 一条路径。
5. 防双写测试：写 `theme.json` 后断言 `settings.json` 字节不变；反向亦然；断言 `theme.json` 的 `mtime` 只被 native 路径改变。

---

## 8. 秘密处理与日志脱敏

| 规则 | 落地 |
| --- | --- |
| 明文 key 只走 `ctx.credentials.set` / `remote.credentials.set` | 落在 `$DSH_HOME/.credentials.yaml`（官方托管文件，带写锁与热发布） |
| 绝不写 `settings.json` / `theme.json` / 任何 QML 属性 | QML 侧 key 只存在于 `ApiKeyField.draft` 局部属性，提交后清空；`ApiKeyField` 的 `objectName` 不得被日志打印 |
| 设置里只存**引用名** | `apiKeyEnv`（pi-ai 族）或 `deriveKeyRef(provider)` 派生的引用；`credentials.describe([ref])` 只回 `{configured, kind, writable}` |
| 日志准则 | 只记 `ref` 名与拒绝码，形如 `[dsh-qt settings] credentials.set refused: credential/rejected ref=FAKE_API_KEY`；任何 `sk-` 前缀、`Bearer`、值片段一律不得出现在日志 |
| 错误文案 | 直接透传宿主诊断（宿主诊断本身已按 `assertUsableApiKey` 设计为「点名 ref，不回显值」） |
| 前端判定 | 复刻 `apiKeyFailure`：空 = 保持已存；纯空白 = `keyBlank`；非法字符 = `keyIllegalCharacters` |
| 快照脱敏 | 一律 `describe({redactSecrets: true})`；`secrets: SettingsSecretView[]` 只用于渲染「已配置」徽标 |

---

## 9. 验证方案

前置：`DSH_HOME` 与 `DSH_QT_CONFIG_DIR` 均指向 `mktemp -d` 临时目录；所有凭据值为**虚构值**（如 `sk-fake-0000-not-a-real-key`、ref `FAKE_PROVIDER_API_KEY`）；供应商 id 用 `fake-provider`；模型发现用注册的 stub 适配器（`registerAdapter(['fake-provider'], stub)`），**零网络**。

| # | 用例 | 期望 |
| --- | --- | --- |
| V1 | 非法 `baseURL`（`""`、`"not a url"`、`"ftp://x"`） | 前端拒绝提交；若强写，`mutate` 返回 `refused`，`accepted=false`，文件不变 |
| V2 | 非法 `maxTokens`（`-1`、`0`、`1e400`、`"abc"`） | 同上；`NaN/Infinity` 必须被拦（复用 `not-finite` 校验路径） |
| V3 | 非法 `reasoningEffort`（`"turbo"`） | select 无该选项；绕过 UI 写入时宿主拒绝 |
| V4 | 非法 key（纯空白 `"   "`、含换行、含空格） | `keyBlank` / `keyIllegalCharacters`，不发起 `credentials.set` |
| V5 | 持久化 | 写入后读回：`settings.json` 有 `baseURL`/模型列表；`.credentials.yaml` 有 ref→值；`settings.json` 与任何日志中**均无** `sk-fake-` 子串 |
| V6 | 重启回读 | 新进程/新 store 实例读同一临时目录，`describe()` 值与写入一致；凭据仅「已配置」状态一致 |
| V7 | 保存失败反馈 | storage 抛错 → `lastError` 非空 + `settingSaved(accepted=false)` + QML 回滚到快照值 + 行内错误可见 |
| V8 | 冲突 | 用过期 `expectedRevision` 提交 → `kind:'conflict'` → 横幅出现 + 「重新加载」后值更新 |
| V9 | 只读配置 | `describe().writable === false` 时所有输入禁用 + 顶部提示，不静默失败 |
| V10 | 日志无秘密 | logger spy 断言：调用序列中不含 `sk-fake-`、不含 key 值任意 8 字符片段、不含 `Bearer` |
| V11 | theme 单写 | 见 §7.5 |
| V12 | 空态 | 无任何可配置供应商时显示空态文案，不显示空白卡片 |
| V13 | 卸载/重载 | 面板关闭重开不泄漏 draft；`dispose` 后无残留监听 |

命令（均在 `dsh-qt-app` 内、串行执行以符合共享 CPU 预算）：

```bash
pnpm -C dsh-qt-app typecheck
pnpm -C dsh-qt-app test
cmake --build build --target qml-tests          # qmltestrunner -input tests/qml -import qml，QT_QPA_PLATFORM=offscreen
```

Windows 优先：路径断言用 `%APPDATA%\dsh-qt`、`%USERPROFILE%\.dsh`，文件比较不假设大小写敏感，原子写断言用 `QSaveFile` 语义（rename 后目标存在且临时文件消失）。

---

## 10. 平台差异（如实）

| 平台 | 状态 |
| --- | --- |
| Windows | 优先目标；`%APPDATA%\dsh-qt` + `QSaveFile` 原子写；CI `windows-2022` 有 Qt 构建与 TS 测试 |
| Linux | 支持；`$XDG_CONFIG_HOME/dsh-qt`；CI `ubuntu-22.04` 有 Qt 构建、QML 套件、TS 测试 |
| macOS | **缺口**：`typescript` job 覆盖 `macos-14`（仅 TS），`build.yml` 的 Qt 构建矩阵**不含 macOS**，`native/main.cpp` 的 darwin 配置分支未经 CI 验证。本任务不对 macOS 做任何「已验证」声明 |

---

## 11. 对 t6 / t9 / t10 的冻结请求

1. **RPC 契约冻结**（t9）：`settings.describe` / `settings.mutate` / `credentials.describe|set|unset` / `llm.directory` / `llm.discoverModels` / `llm.defaultModel.get|set` 的入参与返回形状，以及错误码（`settings/conflict`、`settings/rejected`、`credential/rejected`、`llm/model-discovery-rejected`、`unavailable`）。
2. **来源唯一性规则**（t9）：一个设置键只属于一个来源；`models` 全部来自官方命名空间，本地 schema 不得出现同名键。
3. **theme 单一写者**（t9/t1）：`theme.json` 唯一权威 + native 唯一写者，Node 在有 native 时只读。
4. **G0 前置**（t6）：宿主 stdio 入口不存在，所有 RPC 类工作（本任务、工具可视化、插件管理、WebUI 回退）都卡在它上面，建议作为 Phase 3 第一优先级串行完成。
5. **测试门禁**（t10）：把 V5/V10/V11 三条（无明文 key、日志无秘密、theme 单写）设为必须通过的 CI 断言，其余作为回归集。
