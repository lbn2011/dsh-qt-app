# Phase 3 · 工具调用可视化（t2 交付）：事件 → 模型 → 组件边界与验收契约

- 任务：t2 [tools] — 界定工具调用可视化实现与测试范围
- 执行者：tools-ui-cn（attempt 3，attempt_id `0cd6a30e-3f0c-4ea2-81f8-03649943f8d2`）
- 日期：2026-11-24（Asia/Shanghai）
- 性质：**只读核验 + 方案界定**。本文只写这一个文件，未修改 `qml/main.qml`、未修改任何桥代码、未改动任何测试。
- 上游依赖：`docs/PHASE-3-PLUGIN-SDK.md`（t3）、`docs/PHASE-3-WEB-FALLBACK.md`（t5）；本文与二者不重叠——那两份讲**插件/SDK 与回退**，本文讲**聊天流里的工具调用行**。

---

## 0. 取证范围与结论等级

### 0.1 任务书路径核对

任务书给的三处输入**全部存在**，无路径偏差：

| 任务书说的 | 实际路径 | 状态 |
|---|---|---|
| 现有 MessageModel | `dsh-qt-app/qml/models/MessageModel.qml`（213 行） | 存在 |
| 现有 MessageDelegate | `dsh-qt-app/qml/components/MessageDelegate.qml`（222 行） | 存在 |
| 现有 ChatView | `dsh-qt-app/qml/views/ChatView.qml`（302 行） | 存在 |
| 官方工具事件源码 | `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*` | 存在（**只有 lib/ 与 .d.ts，无 src/**） |

### 0.2 实际读取位置

| # | 位置 | 读它为了回答什么 |
|---|---|---|
| 1 | `dsh-qt-app/qml/models/MessageModel.qml` | 现有模型能承载什么角色/字段 |
| 2 | `dsh-qt-app/qml/components/MessageDelegate.qml` | 一行消息怎么画、主题怎么拿 |
| 3 | `dsh-qt-app/qml/views/ChatView.qml` | 桥请求/应答怎么对账、流式怎么进模型 |
| 4 | `dsh-qt-app/src/bridge/qml-bridge.ts`（696 行） | QML→Node 的方法白名单与不变量 |
| 5 | `dsh-qt-app/native/main.cpp` | `dshQt` 暴露哪些 `Q_INVOKABLE`/信号 |
| 6 | `dsh-qt-app/src/constants.ts` | 原生槽面清单里有没有"工具" |
| 7 | `dsh-qt-app/qml/components/Theme.qml`、`qml/markdown/CodeBlock.qml` | 主题/字体令牌够不够用 |
| 8 | `dsh-llm/lib/types/types.d.ts`、`message.d.ts`、`brand.d.ts` | 线上工具块与流式增量的真实形状 |
| 9 | `dsh-client-ui-conversation/lib/types/client/contract/records.d.ts` | `ToolCallBlock` / `ToolResultNode` / `ToolArgs` |
| 10 | `dsh-util-values/lib/types/partial-json.d.ts` | 参数半成品 JSON 的官方处理面 |
| 11 | `dsh-client-ui-chat/lib/types/client/contract/chat-nodes.d.ts`、`turn-process.d.ts` | 官方"运行中/已结算"判定 |
| 12 | `dsh-client-ui-tool/lib/types/client/tool/**`、`locale/*.json` | 官方行的状态枚举、变体、标题文案、截断常量 |
| 13 | `dsh-qt-app/docs/ci.md`、`CMakeLists.txt`、`package.json` | 测试命令的权威来源 |
| 14 | `dsh-qt-app/tests/qml/tst_chatview.qml`、`tst_messagemodel.qml` | 现有 fixture 的写法与锁定面 |

### 0.3 本文档的结论等级

沿用兄弟文档的三档，并额外增加一档**本次实测**（因为本文确实跑了命令，必须与"设计推断"区分开）：

- **【源码实证】**：在源码中读到，附文件与行号，可复现。
- **【fixture 实证】**：仓库内已有测试/fixture 覆盖该行为。
- **【实测运行】**：本次实际执行的命令与真实输出（见 §9.2）。
- **【未验证】**：设计推断，或依赖缺失（无 Qt 窗口、未构建宿主、未接真桥），明确标注。

---

## 1. 现状取证：工具可视化在 dsh-qt-app 是**零接线**

### 1.1 现有消息管线的四个事实

**MessageModel.qml —— 只有五列，工具只是其中一种"角色字符串"**

- `role` 取值：`"user" | "assistant" | "system" | "tool"`（`roleTool` 定义在 `MessageModel.qml:32`）。
- 列：`role / text / timestamp / pending / markdown`（`appendMessage` 在 `:76`）。
- 流式入口：`appendChunk(index, delta)` `:165`、`beginStream(role)` `:189`、`endStream(index)` `:200`，配 `signal chunk(int,string,string)` `:41`、`signal partialMarkdown(int,var)` `:49`、`property var parser` `:59`。

**结论（关键）**：`role === "tool"` 只是一个**粗粒度文本气泡**——没有调用 id、没有工具名、没有参数、没有状态、没有输出/错误字段。**工具可视化不能靠"给这个 role 再加一个值"实现**，必须新增结构化模型（§4.2）。

**MessageDelegate.qml —— `role==="tool"` 仅换来一个边框**

- `fromTool` `:55`（`delegate.role === "tool"`），`border.width: delegate.fromTool ? 1 : 0` `:111`；左对齐 + `theme.surfaceAlt` 底色（`:70` 附近的 `bubbleColor` 分支）。
- 渲染只有两条路：`Markdown{ objectName:"messageMarkdownBody" }` `:143` 与 `Label{ objectName:"messagePlainBody"; textFormat: Text.PlainText }` `:153`。
- 就地流式覆盖：`property var streamDocument` `:37` + `replace/applyStreamSnapshot/replaceNode/appendNode/removeNode/clearStream`。

**结论**：现在的"工具气泡"就是一个圆角矩形里塞纯文本，不是"行"，没有折叠、没有状态、没有复制、没有截断。

**ChatView.qml —— 只有一条 request/reply 对账通道**

- `property ListModel messageModel: null` `:43`（null = 空态）；`messageCount` `:81`。
- 桥回包漏斗：`Connections { function onRequestReplied(id, method, ok, result, error) }` `:177`，按 `method` 分派到 `internal.pendingParses` `:163` / `pendingRenders` / `pendingHighlights`，**每个请求 id 一张待办表**。
- 流式记录：`property var streamBlockIds: ({})` `:72`，`recordSnapshot` `:148` 把块 id 数组按行存起来，供 `replaceNode/removeNode` 复用行身份。

**结论**：桥是"一个请求 → 一个应答"的对账模型，**没有任何"服务端主动推送"的通路**（§1.3 C2）。

### 1.2 零接线的证据（全文检索）

```
$ cd dsh-qt-app && grep -rn "tool" --include="*.qml" --include="*.ts" src qml | grep -vi "toolbar|tooltip|qtool"
src/theme/types.ts:60                        注释：Assistant / tool message bubbles.
qml/components/Theme.qml:143                 注释：Assistant / tool message bubbles.
qml/models/MessageModel.qml:7,32             注释 + readonly roleTool: "tool"
qml/components/MessageDelegate.qml:55        readonly fromTool = role === "tool"
```

**全仓对工具调用的结构化处理命中数为 0**：没有 `callId`、没有 `argsRaw`、没有 `toolCallCount`、没有工具行组件。这与 t3 对插件管理的判断同构——本阶段的工具可视化是**从零开始**，不是补几行。

### 1.3 五条硬约束（后文所有设计都必须绕开它们）

| # | 约束 | 证据 | 影响 |
|---|---|---|---|
| **C1** | `role` 枚举不能承载工具语义 | `MessageModel.qml:7,32`；`tests/qml/tst_messagemodel.qml:5` 明确"锁定四个角色"（role/text/timestamp/pending） | 工具字段不得塞进 `MessageModel` 的角色表，否则破坏已锁 fixture；必须独立模型 |
| **C2** | 桥**只有** request/reply，无 push | `qml-bridge.ts:39-50` 方法白名单；`:88-90` `QmlBridgeOutbound { type: 'qml.reply' }` 是**唯一**出站类型；`:31` 不变量 4 | 流式工具更新没法"顺便推过去"，必须新增出站类型或退化为轮询 |
| **C3** | 原生槽面里**没有**工具槽 | `constants.ts:67-75` `NATIVE_SLOT_SURFACES` 只有 `conversation.chat.flow / input.composer / session.header / sidebar.left.panel / settings.general / session.panel.section / settings.*` | 工具行属于 `conversation.chat.flow` 内部实现，**不新增槽名**（否则与 t9 的槽位对齐工作冲突） |
| **C4** | 主题**没有等宽字体令牌** | `Theme.qml:22` 明确"只有 Phase 1 声明的 27 个 token"，`:165-170` 只有 `fontSmall/Normal/Large/Title` + `fontFamily`；`qml/markdown/CodeBlock.qml:162` 用的是硬编码 `font.family: "monospace"` | 工具输出要用等宽字体，只能"沿用 CodeBlock 的硬编码先例"或"加 token（跨主题模块改动）"，见 §7.4 决策 D1 |
| **C5** | QML `MessageModel` 有 C++ 镜像义务 | `MessageModel.qml:4` 注释指向 `MessageListModel : QAbstractListModel`（native/）；`ChatView.qml:6` 同 | 新增模型若走 ListModel，必须同时决定 C++ 侧是"暂不镜像"还是"同步镜像"，见 §11 O2 |

---

## 2. 官方工具事件：真实字段与生命周期

### 2.1 调用标识：`ToolCallId` 是三处同源的键

【源码实证】`dsh-llm/lib/types/brand.d.ts`：

```ts
/** Correlates a model-issued tool call with its result.
 *  Provider-issued for real adapters; synthesized by mocks/assembler fallbacks. */
type ToolCallId = Branded<'ToolCallId'>
```

同一个 `ToolCallId` 出现在三个地方，**必须用它做主键，不能用数组下标**：

1. 模型输出块：`ToolCallBlock { type:'tool-call'; id; name; arguments }`（`dsh-llm/lib/types/types.d.ts:93`）。
2. 流式增量：`{ type:'tool-call-delta'; index; id: ToolCallId; name?; argumentsDelta: string }`（`:471-475`）。
3. 会话快照节点：`ToolResultNode{ ... callId ... }`（`records.d.ts:159-187`）。

**会话 id**：工具事件本身**不带** sessionId；会话归属由外层容器给出（`ConversationLocation` 的 `'session'|'turn'|'step'|'unresolved'` 与 `conversationContextKey(kind,id)`）。QML 侧**不要**发明 sessionId 角色——一个 ChatView 只显示一个会话，跨会话混淆由"切换时整表清空"解决（§3.3 R6）。

**turn/step**：`ToolResultNode` / `ToolCallHead` 都带 `turn`、`step`，`TurnProcessSpec` 还有 `toolCallCount`、`subagentCount`、`messageCount`（`chat-nodes.d.ts`）。这三个是**折叠条**的计数来源（"5 个工具调用"）。

### 2.2 一个工具调用的两相形状

【源码实证】`records.d.ts:260-297`：

```ts
interface ToolCallHead {            // :260
  // callId / parentCallId? / name / turn / step / time / subCalls / args
}
interface PreparingToolCall extends ToolCallHead { phase: 'preparing' }   // :286
interface StartedToolCall   extends ToolCallHead { phase: 'start'; argsRaw: string } // :290
type RunningToolCall = PreparingToolCall | StartedToolCall                // :295
type ToolCallBlock   = RunningToolCall | ToolResultNode                   // :297
```

`ToolResultNode`（`:159-187`）：

```ts
kind: 'tool-result'; callId; parentCallId?: string; isError: boolean;
error?: { name: string; code: string; reason?: string };
subCalls: readonly ToolCallBlock[];      // ← 嵌套
// 以及 name / args / call / callTime / content / time / meta?
```

判定函数是官方的，不要自己写：`isSettledTool(block)`（`chat-nodes.d.ts:107`）、`isRunningTool(block)`（`:115`）。

### 2.3 参数是流式的裸 JSON —— 这是"不能随便解析"的根源

【源码实证】

- 线上参数是**字符串**：`ToolCallBlock.arguments: string`（"Raw JSON string as produced by the model"，`types.d.ts:92-100`）。
- 增量按 delta 到达：`argumentsDelta: string`（`:475`），也就是**中途一定是非法 JSON**（`{"path": "src/ma`）。
- 官方为此专门有这个类：`PartialArguments`（`dsh-util-values/lib/types/partial-json.d.ts:24`），公开面包括 `EMPTY`、`fromText`、`fromObject`、`append(fragment)`、`settle(text)`、`isSealed`、`invalid`、`refresh`、`closed()`、`keys()`、`has(key)`、`complete(key)`、`stringLength(key,{step,offset})`、`stringExceeds(key,max)`、`text(key)`、`textPrefix(key,max)`、`value(key)`。
- `ToolArgs = PartialArguments`（`records.d.ts:284`）——**参数读取只有这套 API 是合法的**。

**结论（硬规则）**：QML 侧永远不要 `JSON.parse(argsRaw)` 来"猜字段"。要么用 Node 侧已经用 `PartialArguments` 结算好的字段，要么把 `argsRaw` 当**不透明字符串**显示/复制。

### 2.4 嵌套子调用

`subCalls: readonly ToolCallBlock[]` + `parentCallId`（`records.d.ts:187`、`:166`、`:270`）。官方行按 `ToolCallTree` 递归渲染；`isSubagentDelegationTool(name)`（`turn-process.d.ts`）用来判断"这是子智能体委派"，且 **turn 的折叠规则是"活的、停的、失败的都保持展开"**（`turnProcessAlwaysOpen`）。

### 2.5 错误、取消、失败的真实来源

| 现象 | 官方字段 | 位置 |
|---|---|---|
| 工具执行失败 | `ToolResultNode.isError === true` + `error{ name, code, reason? }` | `records.d.ts:179-180` |
| 失败且 content 为空 | 官方回退显示 `name: code` 一行 | `tool-call-model.d.ts` 中 `resultText()` 文档 |
| 会话被中断 | `AssistantChatData.status: 'running' \| 'settled' \| 'interrupted'` | `chat-nodes.d.ts` |
| 模型侧中止 | `FinishReason` 含 `'aborted'` / `'error'`（均标 failure） | `dsh-llm/lib/types/types.d.ts`（`tool-calls` 与 `stop` 是正常收尾） |
| 用户取消工具 | 官方 UI 归一为 `ToolRowState = 'stopped'` | `tool-call-model.d.ts:20` |
| 自动审查拒绝 | `AutoReviewDenial{ reason }` + 文案键 `tool.autoReviewRejected` / `tool.autoReviewNotExecuted` | `tool-call-model.d.ts`、`locale`（见下） |

### 2.6 官方状态的**权威枚举**：五态、七变体

【源码实证】`dsh-client-ui-tool/lib/types/client/tool/models/tool-call-model.d.ts`：

```ts
export type ToolRowVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others'; // :16
export type ToolRowState   = 'preparing' | 'running' | 'ok' | 'error' | 'stopped';             // :20
```

配套事实（同一文件）：

- `classifyTool(toolName)` → 变体；`toolTitleKey(toolName)` → 本地化键（**"不读参数"就能定标题**，这是可移植的设计）。
- `toolRowModel(toolName, block, cwd?, home?)` → 一次算出 `{variant, titleKey, summary, filePath, bodyRaw, output, errorSummary, autoReviewDenial, state}`。
- `VARIANT_TITLE_KEYS`：`search/read/bash/write/edit/code` → `tool.title.*`，其余 → `tool.title.generic`。
- 标题键表（zh）：`bash 运行命令`、`read 读取`、`write 写入`、`edit 编辑`、`applyPatch 应用补丁`、`code 代码`、`generic 工具调用`、`grep 搜索文件内容`、`glob 查找文件`、`webSearch 网页搜索`、`webFetch 网页获取`、`subagent 创建子智能体`、`killJob 取消后台任务`、`lsp 查询代码符号`…… 共 60+ 键，`locale/*.json` 里只有 meta，字符串实际内嵌在 `dsh-client-ui-conversation/lib/client.js`。
- `tool.preparing.content = "{kilobytes}KB"`：**preparing 行右侧显示已收字节数**——这就是官方"进度"的做法。
- 截断常量（有据可依的经验值）：`CHAT_DIFF_MAX_LINES = 9`、`CHAT_READ_MAX_LINES = 8`、`CHAT_SEARCH_MAX_LINES = 8`（各自 `models/*-card-model.d.ts`）。

`ToolRow` 的 props 已经把**可视化职责**划得很干净（`components/ToolRow.d.ts`）：`title` / `summary`（单行、可省略号） / `summarySuffix`（在省略号**之外**，窄行先剪 summary） / `bodyRaw`（**仅展开时**格式化原始参数 JSON） / `output`（扁平化结果文本，null = 不显示 Output 段） / `errorSummary`（无退出码胶囊时的首行错误） / `state` / `filePath` + `onOpenFile` / `useDisclosure`（行的展开状态由行自己拥有）。

**结论**：官方已经把"折叠 = 单行 title + summary + suffix；展开 = bodyRaw + output + details"这套词汇固化。Qt 侧**照抄词汇表**，不另发明一套，是最省事且最不会跑偏的做法。

---

## 3. 状态机：queued / running / succeeded / failed / cancelled

### 3.1 五态与官方坐标

任务书要求的五个状态**不是**官方枚举，需要一次显式映射（这张表就是本节的产出）：

| 本方案状态 | 官方坐标 | 判定条件 | UI 文案（zh） |
|---|---|---|---|
| `queued` | `RunningToolCall.phase === 'preparing'` 且参数未封闭 | 已见 `tool-call-delta`（有 callId），参数仍在流；或已入队未派发 | 准备中 · 已收 {n}KB |
| `running` | `RunningToolCall.phase === 'start'`（有 `argsRaw`）或结果尚未到达 | 有 callId、有结果之前的一切 | 运行中 · {elapsed}s |
| `succeeded` | `ToolResultNode{ isError: false }` | 结算且非错误 | ✓ 完成 · {elapsed}s |
| `failed` | `ToolResultNode{ isError: true }` | 结算且 `isError` | ✗ 失败 · {errorSummary} |
| `cancelled` | `ToolRowState 'stopped'` / turn `interrupted` / `FinishReason 'aborted'` / 桥断连收尾 | 无结果但 turn 已终止，或收到显式取消 | ⊘ 已取消 |

**为什么不是把 `preparing` 直接叫 `queued`**：`preparing` 的语义是"参数还没收全"（`chat-nodes.d.ts` 的 `isRunningTool` 把它和 `start` 一起算运行中），而 `queued` 是"参数齐了但还没轮到执行"。本方案**保留两者的区分**在内部 `phase` 字段（`queued-args` / `queued-dispatch`），对外统一显示"准备中"，因为 Qt 侧拿不到调度队列的真实可见性——**不要把没有的信号假装成有**。

### 3.2 迁移矩阵（终态不可回退）

| 当前 \ 收到 | call 事件 | delta | result(ok) | result(error) | cancel | 断连 |
|---|---|---|---|---|---|---|
| （无行） | → `queued` | 建行 → `queued` | 建行 → `succeeded`* | 建行 → `failed`* | 建行 → `cancelled` | 无操作 |
| `queued` | 更新 name/args | 更新 args/字节数 | → `succeeded` | → `failed` | → `cancelled` | → `cancelled(disconnected)` |
| `running` | 更新 name | 忽略（参数已封） | → `succeeded` | → `failed` | → `cancelled` | → `cancelled(disconnected)` |
| `succeeded` / `failed` / `cancelled` | **丢弃+记日志** | **丢弃** | **丢弃**（重复结果） | **丢弃** | **丢弃** | 不变 |

\* 结果先到（乱序）时**允许建行**：官方 `ToolResultNode` 自带 `name`、`args`、`call`、`callTime`、`time`，所以"只有结果没有 call"是可渲染的完整行。这是 R2 的依据。

### 3.3 六条处理规则（乱序 / 重复 / 断连 / 后续更新）

| 规则 | 内容 | 为什么 |
|---|---|---|
| **R1 主键去重** | 一切写入按 `callId` **upsert**；同 `callId` 第二次出现只更新字段，不新增行 | `ToolCallId` 是官方唯一键（§2.1）；用下标做键在乱序时必然错行 |
| **R2 乱序兜底** | 结果先于 call 到达 → 用结果自带的 `name/args/time` 建行并直达终态；随后迟到的 `preparing/start` **只补字段不改状态** | 官方节点自足；用户看到的是"结果来得快"，而不是"少了一行" |
| **R3 终态吸收** | 进入 `succeeded/failed/cancelled` 后，任何非终态更新丢弃并 `console.warn`（或宿主日志）一次 | 终态是事实，回退会造成"闪回" |
| **R4 重复结果** | 同 `callId` 的第二个 `result` **不覆盖**第一个，只累加一次 `dupResult` 计数（诊断用） | QML 侧"重复回包"是典型 bug 温床（`qml-bridge.ts:22-24` 的"恰好一个应答"不变量同源） |
| **R5 断连收尾** | 桥 `stateChanged`→断开时，所有非终态行批量改 `cancelled` 且 `reason="连接中断"`；重连后**必须**用全量快照对账（§4.1 的 `tool.snapshot`） | 不断连的话 `running` 会永久转圈；对账避免"断连期间的完成"丢失 |
| **R6 后续更新 / 换会话** | 同一 `callId` 的后续更新（后台任务二次读数、流式输出增长）走"同键 upsert + `revision++`"，**行对象不重建**（折叠状态与滚动位置保留）；切换会话时整表 `clear()`，不复用旧键 | 对应 `ChatView.streamBlockIds` 的就地更新思路（`ChatView.qml:72,148`） |
| **R7 空输出≠失败** | `succeeded` 且 `output` 为空 → 显示"（无输出）"占位，`failed` 且 content 空 → 显示 `name: code` 一行 | 官方 `output: null` 就是"没有 Output 段"，`resultText()` 对空失败内容回退 `name: code`——照抄，不发明 |

---

## 4. 事件 → 模型 → 组件映射

### 4.1 Node → QML 传输契约（两条通道，缺一不可）

**现状**：`QmlBridgeMethod`（`qml-bridge.ts:39-50`）只列了 `markdown.parse/render`、`code.highlight`、`theme.*`、`settings.*`、`composer.submit`、`ping`；出站只有 `qml.reply`（`:88-90`）。**因此工具事件必须有新通道，且这是集成者的改动，不是我的**（任务书：不改桥代码）。

| 通道 | 方法 / 类型 | 方向 | 用途 | 必须字段 |
|---|---|---|---|---|
| **A. 快照（拉）** | `QmlBridgeMethod += 'tool.snapshot'`，走既有 `request()`→`requestReplied` 漏斗（`native/main.cpp:715`、`:752`） | QML→Node 请求，Node 回一个 reply | 首屏、重连、切换会话后的**全量对账** | `sessionKey`, `turns[{turn, step, calls: ToolRowDTO[]}]`, `seq`（单调水位） |
| **B. 增量（推）** | `QmlBridgeOutbound` 增加 `{ type:'qml.event'; payload:{ name:'tool.event'; seq; body: ToolEventDTO } }`，`native/main.cpp` 的 `handleLine_`（`:530`）分派到新信号 `toolEvented(QVariantMap)` | Node→QML 单向推送 | 流式：参数 delta、状态迁移、输出增长 | `seq`, `callId`, `kind`, `patch` |

**选 B 不选"轮询 `tool.snapshot`"的理由**：轮询要么太慢（>200ms 才像流式），要么太贵（每 50ms 全量拉一遍）。而 push 通道的改动面是可控的三处：TS 出站联合类型、C++ `handleLine_` 一个分支 + 一个信号、QML 一个 `Connections`。

**`ToolRowDTO`（跨边界唯一形状，字段全部可选除 `callId/state`）**

```ts
interface ToolRowDTO {
  callId: string            // 官方 ToolCallId 的字符串形式
  parentCallId?: string     // 嵌套
  name: string              // 线上工具名（bash/read/subagent/…）
  state: 'queued'|'running'|'succeeded'|'failed'|'cancelled'
  turn?: number; step?: number
  titleKey?: string         // 官方 tool.title.* 键；QML 无翻译时回退 name
  title?: string            // Node 侧已本地化的标题（可缺）
  summary?: string          // 单行摘要（不含标题）
  summarySuffix?: string    // 省略号之外的后缀（如 +12 −3 / 8 行）
  argsRaw?: string          // 原始参数 JSON，**不透明**
  output?: string           // 扁平化结果文本；null/缺 = 无输出段
  errorSummary?: string     // 首行错误（failed 时）
  errorCode?: string        // 结构化 error.code
  progress?: { bytes?: number; step?: string }   // preparing 的 KB / 自报进度
  startedAt?: number; endedAt?: number           // ms epoch
  outputLines?: number; outputBytes?: number; truncated?: boolean
  revision?: number         // 同键更新序号（R6）
  seq: number               // 全局单调水位（乱序判定）
}
```

**`ToolEventDTO`（增量，四种 `kind`）**：`tool.started{ callId, name, argsRaw? }`、`tool.args{ callId, delta }`、`tool.progress{ callId, bytes?, step? }`、`tool.settled{ callId, state, output?, errorSummary?, errorCode?, endedAt }`。**没有第五种**——任何"新想法"先落到这四种里，落不进去就说明协议没想清楚。

### 4.2 `ToolCallModel.qml`（新增）：角色表

独立 ListModel，**不进入 `MessageModel`**（C1），键是 `callId`（R1）。

| 角色 | 类型 | 来源字段 | 谁用 |
|---|---|---|---|
| `callId` | string | `callId` | 去重键、展开状态记忆 |
| `parentCallId` | string | `parentCallId ?? ""` | 树形缩进 |
| `depth` | int | 由 parent 链算出（0 = 根） | 缩进宽度 |
| `name` | string | `name` | 变体分类、无翻译时兜底 |
| `titleKey` | string | `titleKey` | `qsTr` 查表 |
| `title` | string | `title`（缺则用 name/变体默认） | 行首文本 |
| `summary` | string | `summary` | 单行摘要（**参数不在这里拼**） |
| `suffix` | string | `summarySuffix` | 省略号外侧 |
| `argsRaw` | string | `argsRaw` | **仅展开时**取用，从不当 JSON 解析 |
| `output` | string | `output` | 展开体的 Output 段 |
| `errorSummary` | string | `errorSummary` | 折叠态错误行 |
| `errorCode` | string | `errorCode` | 空错误内容回退 `name: code` |
| `state` | string | 五态之一 | 徽标、配色、无障碍文案 |
| `progressText` | string | `progress.bytes` → `"{n}KB"` | preparing 期 |
| `elapsedText` | string | `startedAt/endedAt` 现算 | running / 终态 |
| `outputLines` | int | `outputLines` | 截断判定 |
| `outputBytes` | int | `outputBytes` | 硬顶判定 |
| `truncated` | bool | `truncated` | 显示"已截断"提示 |
| `revision` | int | `revision` | 就地更新序号 |
| `seq` | int | `seq` | 乱序判定水位 |
| `hasChildren` | bool | 由 model 内扫 | 是否画展开箭头 |
| `expanded` | bool | UI 侧写回 | 折叠状态（跨更新保留） |

**API（QML 内部约定，全部同步、幂等）**：`upsert(row)` / `applyEvent(event)` / `setExpanded(callId, bool)` / `expandedFor(callId)` / `clear()` / `row(callId)` / `childCount(callId)`。`upsert` 是**唯一**写入口（R1/R3 都落在它里面），这样规则只有一处实现、一处测试。

### 4.3 组件清单与职责

| 组件（新增，`qml/components/tool/`） | 职责 | 不做什么 |
|---|---|---|
| `ToolCallList.qml` | 工具行容器：接 `ToolCallModel`，纵向排布 + 树形缩进；`objectName: "toolCallList"` | 不解析参数、不做本地化表 |
| `ToolCallRow.qml` | **折叠态一行**：状态徽标 + 标题 + 摘要 + 后缀 + 展开箭头；点击切换展开；右键菜单（复制输出 / 复制参数） | 不渲染大段文本 |
| `ToolStatusBadge.qml` | 五态视觉（色 + 字符 + 无障碍文案），色取 `theme.textMuted/success/danger/warning` | 不决定状态（只显示给定状态） |
| `ToolCallDetails.qml` | **展开体**：`Loader` 惰性加载；含 参数段 / 输出段 / 错误段 | 不自己请求数据 |
| `ToolArgsView.qml` | 参数：等宽文本，`argsRaw` **原样 + 软换行**；`JSON.parse` 成功且紧凑时用 `Text.PlainText` 展示缩进版 → 见 §6.3（**唯一允许的解析点**，且有 try/catch 兜底） | 不猜字段、不画图 |
| `ToolOutputView.qml` | 输出：等宽、行数上限、超限折叠、`复制全文` | 不重新解析 markdown 之外的语义 |
| `ToolErrorView.qml` | 失败：`errorSummary`（首行）+ `errorCode`；空内容回退 `name: code` | 不把错误当普通输出 |

**挂载点（明确到"谁改哪一行"）**：`conversation.chat.flow`（`constants.ts:67`）内部、`ChatView` 的消息流里。t2 **不**改 `ChatView.qml`；由集成者做**一处**改动：在 `ChatView.qml` 的流容器里加 `ToolCallList { model: toolCallModel; theme: chatView.theme }`（约 2–4 行）并把 `qml/main.qml` 的 `tool.event` 信号接入同一个 `Connections`。**理由**：`ChatView.qml`/`main.qml` 是共享文件，多任务并行改必然冲突，任务书也把这两处划给集成者。

### 4.4 完整映射表（事件 → 模型 → 组件 → 断言点）

| 官方事件/字段 | 模型写入 | 组件表现 | 测试断言 objectName |
|---|---|---|---|
| `StreamChunk{tool-call-delta, id, name, argumentsDelta}` | `upsert{callId:id, name, state:'queued'}`, `args += delta`, `progressText` | 准备中徽标 + 已收 KB | `toolRow_<callId>` / `toolBadge` |
| `StartedToolCall{phase:'start', argsRaw}` | `state:'running'`, `argsRaw`, `startedAt` | 运行中徽标 + 秒数 | `toolBadge`, `toolElapsed` |
| `ToolResultNode{isError:false, content}` | `state:'succeeded'`, `output=resultText()`, `endedAt` | 完成徽标 + Output 段（展开） | `toolOutput` |
| `ToolResultNode{isError:true, error{name,code,reason}}` | `state:'failed'`, `errorSummary=首行` / `errorCode` | 失败徽标 + 红色错误段 | `toolError` |
| turn `interrupted` / `FinishReason 'aborted'` | `state:'cancelled'` | 已取消徽标，保留已收到的输出 | `toolBadge` |
| 桥 `stateChanged`=断开 | 批量 `cancelled(reason=连接中断)` | 同上 + 顶部一次性提示 | `toolRow_*` |
| `ToolResultNode.subCalls[]` | 逐条 `upsert` 带 `parentCallId`、`depth+1` | 缩进 + 父行 `hasChildren` | `toolChild_<callId>` |
| `ToolRowModel.summarySuffix` / `diff totals` | `suffix` | 省略号外右侧 | `toolSuffix` |

---

## 5. UI 文字草图

> 记号：`▸/▾` 折叠箭头，`[✓][✗][⊘][·][▹]` 五态徽标，`…` 省略号，`⧉` 复制按钮。行宽按 `width*0.86` 左对齐（沿用 `MessageDelegate` 气泡宽度策略，但**工具行不画气泡**，只画一条细分割线，视觉上与大段回答区分）。

**1) queued（参数流式收集中）**

```
▸ [·] 运行命令  bash                    准备中 · 已收 2KB
```

**2) running（已派发）**

```
▾ [▹] 运行命令  bash · pnpm -C dsh-qt-app test        运行中 · 3.2s
   ├ 参数                                                      ⧉
   │  {"command":"pnpm -C dsh-qt-app test","timeout":…}
   └ 输出（实时，最多 8 行可见）
      > tsx --test tests/*.test.ts
      ✔ listener errors are isolated …
```

**3) succeeded（折叠，默认态）**

```
▸ [✓] 运行命令  bash · pnpm -C dsh-qt-app test        ✓ 319 通过 · 2.5s
```

**4) succeeded（展开，输出被截断）**

```
▾ [✓] 运行命令  bash · pnpm -C dsh-qt-app test        ✓ 319 通过 · 2.5s
   ├ 参数                                                      ⧉
   │  {"command":"pnpm -C dsh-qt-app test"}
   ├ 输出                                            显示前 8/319 行 ▾
   │  > tsx --test tests/*.test.ts
   │  ✔ listener errors are isolated and routed to onError
   │  …（311 行未显示）         [显示全部]  [复制全文]
   └
```

**5) failed**

```
▸ [✗] 运行命令  bash · node-gyp rebuild             ✗ spawnSync EINVAL · 1.4s
   └ 错误
      Error: spawnSync npx.cmd EINVAL
      code: EINVAL
```

**6) cancelled（断连 / turn 中断）**

```
▸ [⊘] 读取  read · src/markdown/renderer.ts         已取消 · 连接中断
```

**7) 嵌套（子智能体 / 批量调用）**

```
▾ [✓] 创建子智能体  subagent · 审查 qml/components       ✓ 完成 · 12.4s
   ├ ▸ [✓] 读取  read · qml/models/MessageModel.qml     ✓ 0.3s
   ├ ▸ [✓] 搜索文件内容  grep · ToolCallId              ✓ 0.2s
   └ ▸ [✗] 运行命令  bash · tsc --noEmit               ✗ 2 errors
```

**8) 空输出（succeeded 但无 output）**

```
▾ [✓] 发送消息  sendMessage · teammate:plugin-sdk       ✓ 完成 · 0.1s
   ├ 参数                                                      ⧉
   └ 输出
      （无输出）
```

**9) 折叠加总（turn 级，`toolCallCount`）**

```
  ▾ 5 个工具调用 · 12.8s · 全部完成
```

---

## 6. 内容协议：文本 / JSON / 表格 / 图表 —— 能到哪，到哪必须拒绝

### 6.1 一页结论表

| 内容类型 | 协议来源 | 渲染方式 | 判定 |
|---|---|---|---|
| **纯文本 / 日志** | `ToolResultNode.content` 的 text 块（`resultText()` 扁平化） | `ToolOutputView`：等宽 + 行上限 + 复制全文 | **做** |
| **Markdown** | 同一 text 内容里出现 markdown 语法 | 复用既有 `markdown.parse`（`qml-bridge.ts:39`）→ `Markdown{}`（`qml/markdown/Markdown.qml`），`Table.qml` 已在其中 | **做（复用，零新代码）** |
| **表格** | 只认 **markdown 表格**（`|a|b|`）或 **等宽定宽文本** | 前者走 `Markdown`→`Table.qml`；后者等宽显示 | **做，但不新增表格解析器** |
| **JSON** | `argsRaw` 与"结果里形如 `{…}`/`[…]` 的文本块" | 仅**缩进美化**（`JSON.parse` 成功 → 缩进；失败 → 原样），不做字段级语义 | **有限做**（§6.3） |
| **图表** | **无任何官方数据契约** | 不做。降级为原文 + 复制 | **拒绝** |
| **图片** | `image` 内容块 | 本期不做（`readImage` 走 `tool.call.images` 槽，Qt 无该槽） | **拒绝 + 记录** |

### 6.2 表格：为什么"不新增解析器"

`qml/markdown/Table.qml` 已存在且被 `tst_markdown.qml` 覆盖；工具输出里的表格绝大多数是 markdown 表格（agent 自己写的），天然能被既有 AST 渲染器吃掉。再写一个"工具结果表格解析器"等于**同一件事做两遍**，且会与 `Table.qml` 的样式分叉。

### 6.3 JSON：唯一允许的解析点，与四条硬规则

- **R-JSON1**：`argsRaw` 在**折叠态完全不碰**（官方也是这个策略：`bodyRaw` "formatted only while the row is expanded"）。
- **R-JSON2**：展开时只做**形状保真**美化：`JSON.parse` 成功 → 两空格缩进；抛错 → **原样显示**（大概率是流式半成品）。绝不因为解析失败而隐藏或报错。
- **R-JSON3**：**不按字段渲染**。不写"如果 args 有 `path` 就画文件链接"这类逻辑——那需要"猜任意 JSON"，正是任务书禁止的。文件路径只在 `ToolRowDTO` 显式给了 `summarySuffix`/`filePath` 时才展示（由 Node 侧用 `PartialArguments` 结算后给出）。
- **R-JSON4**：输出里"看起来像 JSON"的文本，默认**当纯文本**（`Text.PlainText`）；只有 `ToolOutputView` 的"美化 JSON"开关被用户点开才缩进。开关状态按 `callId` 记忆。

### 6.4 图表：为什么必须拒绝，而不是"尽力渲染"

官方 `dsh-client-ui-tool` 里**没有任何图表模型**（`components/` 只有 `ToolRow / ToolDetails / ExitCodeBadge / AskQuestionCard / QuestionToolRow`；`models/` 全是 diff/read/search/terminal/web/image 卡片）。也就是说**连官方 Web 客户端都不把工具结果画成图**。Qt 侧若"看到数字就画折线"，等于凭空发明数据契约，一旦字段名变化就是静默错图。**结论：拒绝，并在 UI 上给出"该结果为纯文本，已按原文显示"+ 复制按钮。**

---

## 7. 流式更新 / 大输出性能 / 主题字体

### 7.1 流式：合并 + 就地更新

| 层 | 做法 | 依据 |
|---|---|---|
| Node | 增量**按 50ms 合并**（10ms tick 的 5 倍）再发 `qml.event`；同 `callId` 同 `kind` 合并成一次 | 桥本身 10ms 泵（`constants.ts:EVENT_LOOP_TICK_MS`）已在；合并把"每 delta 一次跨进程"降到"每帧一次" |
| QML | `upsert` 走 `ListModel.setProperty`（**不** `clear()+append`） | `ChatView.qml:72,148` 的 `streamBlockIds` 与 `Markdown.qml` 的块内就地更新是同一思路 |
| 视觉 | 输出文本变化时**不重建** `ToolCallRow`；只更新 `ToolOutputView` 的文本与计数 | 重建会丢折叠状态、选中、滚动位置（`Markdown.qml` 头注释明确写了这个坑） |
| 背压 | 单行 `output` 超过 200KB 时**停止推**，改推 `truncated:true` + `outputBytes`，UI 提示"输出过大（{n} MB），已截断显示 / 可复制前 200KB" | 与设置侧 `maxHighlightChars`（默认 20 000，上限 1 000 000，`src/settings/schema.ts`）同族思路：**有明确上限并报数** |

### 7.2 大输出：三层截断（全部要有可见提示）

| 层 | 阈值 | 行为 | 依据 |
|---|---|---|---|
| L1 折叠态 | 8 行（read/search）9 行（diff） | 默认只显示这些行，"显示全部"展开 | 官方常量 `CHAT_READ_MAX_LINES=8`、`CHAT_SEARCH_MAX_LINES=8`、`CHAT_DIFF_MAX_LINES=9` |
| L2 展开态 | 2000 行 | 超过则只渲染前 2000 行 + "（其余 {n} 行未显示）" | 经验值，需在 §9.3 fixture 里定死以免漂移 |
| L3 传输 | 200KB | Node 侧截断（§7.1） | 与 L2 解耦：一个管"推多少"，一个管"画多少" |

**复制永远取模型里的全文（截断前）**，不受 L1/L2 影响；只有 L3 截断后复制的是"已截断的 200KB"且必须提示。**这条必须在测试里断言**——"复制到的和看到的不一样"是最容易出的事故。

### 7.3 组件级性能纪律

- `ToolCallDetails` 用 `Loader { active: row.expanded }`，**未展开的行不创建**输出 Text 对象。
- `ToolCallList` 的 delegate 必须设 `height`（避免 ListView 反复测量）；`cacheBuffer` 保持默认，不为工具行开大缓存。
- 输出 Text 用 `Text.PlainText`（**不要 `TextEdit`/RichText**），`wrapMode: Text.WrapAnywhere` 对超长单行（JSON 一行 50KB）必须生效，`clip: true` 兜底。

### 7.4 主题与字体适配

可用令牌（`Theme.qml:140-186`，全部已乘 `fontScale` 的会注明）：`text` / `textMuted` / `border` / `surface` / `surfaceAlt` / `surfaceAccent` / `accent` / `danger` / `warning` / `success` / `fontSmall`(×) / `fontNormal`(×) / `spacing` / `spacingLarge` / `radius` / `radiusLarge`。

| 元素 | 令牌 | 说明 |
|---|---|---|
| 行背景（hover） | `surfaceAlt` | 不画气泡边框（气泡留给消息），只用 1px `border` 分割线 |
| 标题/摘要 | `text` / `fontNormal` | 摘要用 `textMuted` + `fontSmall` |
| 错误 | `danger` | 徽标 + 错误段文字；不用底色块（暗色主题下底色块对比不足） |
| 成功/取消 | `success` / `warning` | 取消用 `warning` 而非 `danger`（取消失败 ≠ 失败） |
| 输出正文 | **等宽**——见 D1 | 行高 `fontSmall*1.35` 之类的派生值必须由 `fontNormal` 派生，**不新增绝对像素** |

**D1（需裁决）：等宽字体从哪来**

| 选项 | 做法 | 代价 | 建议 |
|---|---|---|---|
| D1-a | 沿用 `CodeBlock.qml:162` 的 `font.family: "monospace"` | 零改动，但它是**硬编码字面量**（已知债），且在 Windows 上 `"monospace"` 会回落到 Qt 默认等宽（Consolas/Courier New 之一，不可控） | 本期**先用**，注释标注 TODO |
| D1-b | 主题新增 `fontMono` 令牌 | 动 `src/theme/types.ts` + `validate.ts` + `builtins.ts` + `themes/dark.json`/`light.json` + `tst_theme.qml`（**"27 个 token"断言会被打破**，`Theme.qml:22`） | **推荐下一阶段做**，但必须与主题模块所有者一起改，**不要在本任务里偷偷加** |

- **字体缩放**：字号统一走 `theme.fontSmall/fontNormal`（已乘 `fontScale`），间距/圆角**不缩放**——与 `tst_theme.qml::test_layoutRhythmIsNotScaled` 的既有断言一致，违反会让那个测试红。
- **暗色主题**：错误/成功色已由主题提供，不要在组件里写 `"#ff0000"`；`qmllint` 会把未限定访问当警告（CI 视为失败，见 §9.1）。

---

## 8. 精确文件边界

### 8.1 本任务（t2）只写了一个文件

```
dsh-qt-app/docs/PHASE-3-TOOL-VIZ.md      # 本文件
```

**未修改任何其他文件**：`git status` 应只有这一个新增文件（见 §9.2 末条）。未改 `qml/main.qml`、未改 `src/bridge/*`、未改 `native/main.cpp`、未改任何测试。

### 8.2 实现阶段建议的写入边界（按"谁能改"分组）

| 文件 | 变更性质 | 归属 | 风险 |
|---|---|---|---|
| `qml/components/tool/ToolCallRow.qml` | 新增 | **工具可视化实现者** | 低 |
| `qml/components/tool/ToolStatusBadge.qml` | 新增 | 同上 | 低 |
| `qml/components/tool/ToolCallDetails.qml` | 新增 | 同上 | 低 |
| `qml/components/tool/ToolArgsView.qml` | 新增 | 同上 | 中：唯一 JSON 解析点，必须 try/catch |
| `qml/components/tool/ToolOutputView.qml` | 新增 | 同上 | 中：L1/L2 截断与"复制全文"必须一致 |
| `qml/components/tool/ToolErrorView.qml` | 新增 | 同上 | 低 |
| `qml/components/tool/ToolCallList.qml` | 新增 | 同上 | 低 |
| `qml/models/ToolCallModel.qml` | 新增 | 同上 | **中高**：R1–R7 全在这里，必须逐条测试 |
| `tests/qml/tst_toolcallmodel.qml` | 新增（§9.3） | 同上 | 无 |
| `tests/qml/tst_toolcallrow.qml` | 新增（§9.3） | 同上 | 无 |
| `qml/views/ChatView.qml` | **加 2–4 行**挂载 `ToolCallList` | **集成者** | 中：共享文件，多任务并行必冲突 |
| `qml/main.qml` | 接 `tool.event` 信号 + 传入 model | **集成者** | 中：同上 |
| `src/bridge/qml-bridge.ts` | 白名单加 `tool.snapshot`；`QmlBridgeOutbound` 加 `qml.event`；守 `:9-19` 四条不变量 | **集成者** | **高**：改出站类型影响所有既有 reply 路径，`tests/qml-bridge.test.ts` 必须同步扩 |
| `native/main.cpp` | `handleLine_`(`:530`) 加 `qml.event` 分支 + 新信号 `toolEvented(QVariantMap)`；`request()`(`:715`) 已支持任意方法 | **集成者** | 高：C++ 侧本机无 Qt 构建环境验证（§9.2），只能静态审查 |
| `src/constants.ts` | （可选）`NATIVE_SLOT_SURFACES` **不加**工具槽 | — | **建议不动**（C3） |
| `src/theme/*` | （可选）D1-b 的 `fontMono` | **主题所有者** | 中：破坏"27 token"断言 |
| `tests/qml-bridge.test.ts` | 新增 `tool.snapshot` + `qml.event` 用例 | 集成者 | 无 |

**不得触碰**：`/usr/local/lib/node_modules/@deepseek-ai/dsh/**`（官方源码）、`dsh-qt-napi/vendor/cmark-gfm/**`（第三方，许可证原样）、EAC 部分（不合入）、`qml/markdown/*`（复用而非修改）。

### 8.3 与兄弟任务的重叠检查

| 任务 | 重叠点 | 处理 |
|---|---|---|
| t3 插件 SDK | 槽位名 `conversation.settings.*` 的对齐工作 | 本文**不新增槽名**（C3），零重叠 |
| t5 WebUI 回退 | 复杂插件卡片该不该回退成 WebView | 工具行是**原生行**，不进回退名单；若将来 `tool.call.images` 需要，那是 WebView 的候选 |
| 主题/设置 | `fontMono` 令牌、`maxToolOutputChars` 设置项 | 只提需求（D1、§7.1），不代改 |

---

## 9. 测试：命令来源、基线、fixture 清单

### 9.1 测试命令的**权威来源**（三处，互相印证）

| 来源 | 内容 |
|---|---|
| `dsh-qt-app/package.json` `scripts` | `typecheck`: `tsc -p tsconfig.test.json`；`test`: `tsx --test tests/*.test.ts`；`build`: `tsc -p tsconfig.json` |
| `dsh-qt-app/docs/ci.md:82-85` | `qml-tests` 在**无头**下跑：`QT_QPA_PLATFORM=offscreen qmltestrunner -input tests/qml -import qml`；`:90-95` 发现是**目录式**（任何 `tests/qml/tst_*.qml` 自动纳入，无清单要改），且 **CI 会核对"跑的套件数 ≥ 磁盘上 tst_*.qml 文件数"** |
| `dsh-qt-app/CMakeLists.txt:115-123` | `cmake --build build --target qml-tests` = 同一条 `qmltestrunner -input … -import …`（本地等价入口） |
| `docs/ci.md:104` | `qmllint` job **把警告当失败**；上下文属性 `ctx` 对 qmllint 不可见，已有 `// qmllint disable unqualified` 作用域包裹，**不得扩大该作用域** |

**对兄弟文档的一处更正（重要）**：`PHASE-3-PLUGIN-SDK.md` §9 写"QML fixture 需要 Qt 构建环境与 `qmltestrunner`，本次未运行"。实际情况是**本机有 Qt 6.8.2，`qmltestrunner` 与 `qmllint` 都在 `/usr/lib/qt6/bin/`，只是不在 `PATH` 里**（`qmake6 -query QT_VERSION` → `6.8.2`，`QT_INSTALL_BINS` → `/usr/lib/qt6/bin`）。**用绝对路径就能跑**，见 §9.2。那份文档里标"fixture 存在，本次未运行"的 QML 行，现在**可以补跑**（建议交给 t3 的负责人或集成者复核）。

### 9.2 本次实际执行的基线（【实测运行】，2026-11-24）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `cd dsh-qt-app && npx --no-install tsx --test tests/*.test.ts` | **tests 319 / pass 319 / fail 0**，duration 2510ms |
| 2 | `cd dsh-qt-app && QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input tests/qml -import qml` | **Totals: 168 passed, 0 failed, 0 skipped, 0 blacklisted, 484ms**（15 个套件全绿） |
| 3 | `cd dsh-qt-app && /usr/lib/qt6/bin/qmllint qml/components/MessageDelegate.qml qml/views/ChatView.qml qml/models/MessageModel.qml` | **静默，exit 0**（无警告，符合 CI"警告即失败"的门槛） |

这三条是**"改动前的地板"**：新组件合入后，命令不变，数字只能涨不能跌（`qmllint` 必须仍然 exit 0）。

**未执行**（原因见括号）：`cmake` 配置/构建（重，且 C++ 侧改动不在本任务）、真实宿主窗口（无显示器；见 §10）、`dsh-qt-napi` 的 `verify`（不在本任务范围）。

### 9.3 必补 fixture 清单（每条对应一个可执行断言）

**A. 模型层 —— `tests/qml/tst_toolcallmodel.qml`（新，纯 QML，无需桥）**

| # | 场景 | 断言 |
|---|---|---|
| A1 | **queued**：一次 `tool.args` 增量 | 新增 1 行，`state==="queued"`，`argsRaw` 累加 |
| A2 | **running**：`tool.started` | 同 `callId` **不新增行**，`state==="running"`，`count===1` |
| A3 | **succeeded**：`tool.settled(ok)` | `state==="succeeded"`，`output` 写入，`endedAt` 非 0 |
| A4 | **failed**：`isError` | `state==="failed"`，`errorSummary`/`errorCode` 就位 |
| A5 | **cancelled** | `state==="cancelled"`，已收到的 `output` **不被清空** |
| A6 | **空输出** | `output===""` 且 `state==="succeeded"` 时不判失败，"无输出"占位可由组件测 |
| A7 | **重复（同 callId 两次 append）** | `count` 恒为 1；`revision` 递增；无重复行 |
| A8 | **重复结果** | 第二个 `tool.settled` 不覆盖首个 `output` |
| A9 | **乱序（result 先到）** | 建行且直接终态；随后迟到的 `tool.started` **不改状态**、只补 `argsRaw` |
| A10 | **终态吸收** | 终态后 `tool.args`/`tool.started` 被丢弃（`state`、`output` 不变） |
| A11 | **断连收尾** | `handleDisconnect()` 后所有非终态 → `cancelled`，`reason` 含"连接中断" |
| A12 | **嵌套** | 父 + 2 子（`parentCallId`）→ `depth` 分别为 0/1/1，`hasChildren(parent)===true` |
| A13 | **后续更新（R6）** | 同 `callId` 的二次 `output` 更新：`expanded` 状态**保留**、行对象不重建（用 `revision` + `expanded` 断言） |
| A14 | **清空** | `clear()` 后 `count===0`，旧 `callId` 不复用 |

**B. 组件层 —— `tests/qml/tst_toolcallrow.qml`（新）**

| # | 场景 | 断言 |
|---|---|---|
| B1 | 折叠态只显示一行 | `ToolCallRow` 的 `height` ≈ 单行；`ToolCallDetails` **未被创建**（`findChild` 为 null） |
| B2 | 展开 | 点击后 `ToolCallDetails` 存在；`ToolArgsView` 拿到 `argsRaw` 原文 |
| B3 | 大输出 L1 | 8 行常量：`visibleLines<=8`，且存在"显示全部"控件 |
| B4 | 大输出 L2 | 2000 行上限：超限时出现"其余 n 行未显示" |
| B5 | **复制全文** | 复制内容长度 === 模型 `output` 长度（与可见行数**无关**） |
| B6 | 主题适配 | 传 `Theme{bridge:null}` 与自定义 palette，颜色来自令牌而非字面量（比较两次不同主题下的 `color` 不同） |
| B7 | 字体缩放 | `fontScale=1.5` 时字号变大，**间距/圆角不变**（对齐 `tst_theme` 语义） |
| B8 | 五态徽标 | 五个状态各渲染出不同 `toolBadge.text`/`color` |

**C. 桥层 —— `tests/qml-bridge.test.ts` 扩展（集成者）**

| # | 场景 | 断言 |
|---|---|---|
| C1 | `tool.snapshot` 请求 | 恰好一个 reply，`ok:true`，`result.turns` 形状符合 §4.1 |
| C2 | `tool.snapshot` 参数非法 | `ok:false`，`error.code==="bad-params"`（沿用 `qml-bridge.ts` 既有错误码表） |
| C3 | 出站 `qml.event` | 出站消息 `type==="qml.event"`，且仍满足"每请求恰一 reply"不变量 |
| C4 | 混合顺序 | reply 与 event 交错时，两者**互不吞并**（既有 `tests/qml-bridge.test.ts` 的对账逻辑不被破坏） |

### 9.4 模拟验证 vs 真实验证（**不得混写**）

| 层 | 手段 | 能证明什么 | **不能**证明什么 |
|---|---|---|---|
| 模拟（QML fixture） | `ToolCallModel.qml` + 组件**直接实例化**，事件用手写 JS 对象喂（现有 `tst_chatview.qml` 就是这种风格：直接 `model.appendUserMessage(...)`） | 状态机分支、渲染结构、截断/复制一致性、主题令牌 | 桥真的会推 `qml.event`；C++ 信号真的会到 QML |
| 模拟（TS 单测） | `qml-bridge.ts` 用假 sink + 假 renderer（既有 `tests/qml-bridge.test.ts` 手法） | 方法白名单、reply/event 对账、错误码 | 真 N-API / 真 sidecar |
| **真实** | 构建 Qt 宿主 + Node 驱动经 stdio 注入（§10） | 端到端：真实 `tool-call-delta` → 行出现 → 结算 | 视觉手感（需要人眼） |

**硬规则**：A/B 全绿只能说"**组件与模型契约成立**"，**不得**说"工具可视化可用"。只有 §10 的真实宿主步骤跑通才能说可用。

### 9.5 CI 门禁（新加文件后必须仍然满足）

1. `tests/qml/tst_*.qml` **文件数 +2**，`qmltestrunner` 输出的套件数必须 ≥ 文件数（`ci.md:90-95` 会核）。
2. `qmllint qml/**` 必须 **0 警告**（新组件里访问 `ctx` 必须沿用既有的 `// qmllint disable unqualified` 包裹写法，不得扩大作用域）。
3. `tsc -p tsconfig.test.json` 无错；`tsx --test tests/*.test.ts` 319+N 全绿。

---

## 10. 真实宿主验收步骤

### 10.1 为什么这件事"必须真机"，以及本机现状

Qt 宿主的形态是**stdio 对端**：`native/main.cpp` 里 `StdioTransport`（`:326`）通过 `QSocketNotifier`（POSIX）/ `QTimer`（Windows）读 stdin，把每行 JSON 交给 `DshQtBridge::handleMessage_`（`:530`）；出站走 `send()`（`:403`）。因此"真实宿主验收"= **构建宿主 + 用 Node 脚本往它的 stdin 灌 `qml.event`**。

- 本机有 Qt 6.8.2 + `QuickControls2` 的 CMake 配置（`/usr/lib/x86_64-linux-gnu/cmake/Qt6QuickControls2*` 存在），**理论上可构建**。
- `dsh-qt-app/build/` 目前只有 `CMakeCache.txt`（配过、没构建过）。
- 无显示器 → 只能用 `QT_QPA_PLATFORM=offscreen`（`qmltestrunner` 已证明该平台可用）。
- **本次未执行**（任务为只读、且构建属重型工作须串行共享 CPU 预算）。

### 10.2 步骤（Windows 优先，Linux 等价）

**Step 1 — 构建（重型，串行）**

```powershell
cd dsh-qt-app
pnpm build                                   # TS → lib/
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release --target dsh-qt-app
```

Linux 同上，把 `--config Release` 去掉即可。**通过判据**：产出 `dsh-qt-app`（或 `.exe`）可执行文件；configure 阶段 `message(STATUS "bundling N QML sources")` 的 N **比改动前多 8**（新增 8 个 `qml/components/tool/*.qml` 会被 `CMakeLists.txt:53` 的 `GLOB_RECURSE` 自动纳入）。

**Step 2 — 注入（模拟 Node 侧，但走真桥）**

写一个一次性脚本（不进仓库，或放 `tests/manual/`），把下面四行按 100ms 间隔写进宿主的 stdin，覆盖"流式 → 结算 → 迟到更新 → 断连"：

```jsonl
{"type":"qml.event","payload":{"name":"tool.event","seq":1,"body":{"kind":"tool.started","callId":"c1","name":"bash","argsRaw":"{\"command\":\"ls\"}"}}}
{"type":"qml.event","payload":{"name":"tool.event","seq":2,"body":{"kind":"tool.progress","callId":"c1","bytes":2048}}}
{"type":"qml.event","payload":{"name":"tool.event","seq":3,"body":{"kind":"tool.settled","callId":"c1","state":"succeeded","output":"file1\nfile2\n","outputLines":2}}}
{"type":"qml.event","payload":{"name":"tool.event","seq":4,"body":{"kind":"tool.started","callId":"c1","name":"bash"}}}
```

**Step 3 — 断言点（无需人眼，看日志/回包）**

| # | 期望 | 观测手段 |
|---|---|---|
| 1 | 宿主不崩，`qml.event` 被识别为已知出站类型 | 宿主 stdout 无 "unknown message type" |
| 2 | QML 侧 `ToolCallModel.count` 从 0→1，且**始终不为 2**（第 4 行不应新增行） | 在 `main.qml` 的调试开关下打印 `model.count`（集成者加，勿常开） |
| 3 | 第 4 行（终态后的 `started`）不改状态 | 同上，打印 `state` 仍为 `succeeded` |
| 4 | 反方向：`tool.snapshot` 请求得到**恰好一个** reply | 宿主 stdout 出现一行 `{"type":"qml.reply",…}` |
| 5 | 关闭 stdin（模拟断连）→ 非终态行转 `cancelled` | 打印 `state` |

**Step 4 — 平台差异（如实报告）**

| 平台 | 状态 | 说明 |
|---|---|---|
| Windows | **优先**，但**本次未验证** | `StdioTransport` 在 Windows 用 `QTimer` 轮询（`main.cpp:355`），路径分支与 POSIX 不同；中文/GBK 控制台可能与 UTF-8 JSON 冲突（既有 `docs/ci.md` 已记录 Windows 侧 `spawnSync npx.cmd EINVAL` 类问题）。**必须由 Windows 机器跑 Step 1–3** |
| Linux | 支持；本次**只验证了 QML 层**（168 通过），未构建宿主 | `QT_QPA_PLATFORM=offscreen` 可用 |
| macOS | **缺口，如实报告** | 无 macOS 构建环境；`dsh-qt-napi` 的 prebuild 三元组里有无 darwin 产物需单独核（不在本任务） |

---

## 11. 开放问题（需他人裁决，不阻塞 A/B fixture 开工）

| # | 问题 | 影响 | 建议归属 |
|---|---|---|---|
| O1 | `qml.event` 出站类型谁来加、什么形状？本文给的是 `{type:'qml.event', payload:{name,seq,body}}` | 阻塞真机验收（Step 2） | **集成者**（任务书已把桥划给他） |
| O2 | `ToolCallModel` 要不要 C++ 镜像（`ToolCallListModel : QAbstractListModel`）？现在 `MessageModel` 的注释里已经预留了镜像义务（C5） | 决定"纯 QML ListModel"还是"等 C++ 一起做完" | **集成者 + t6**（C++ 边界归属未定） |
| O3 | 工具行**挂在 ChatView 里**还是**独立视图段**？（本文建议挂 `conversation.chat.flow` 内部，不新增槽名，C3） | 决定 `ChatView.qml` 改动量 | 集成者 |
| O4 | `fontMono` 令牌加不加（D1） | 影响主题模块的"27 token"断言与 `CodeBlock.qml` 的硬编码债 | **主题所有者** |
| O5 | 输出硬顶（200KB 传输 / 2000 行渲染）要不要做成设置项（`maxToolOutputChars`） | 与设置 schema 所有者耦合 | 设置模块所有者 |
| O6 | 官方 `tool.title.*` 60+ 键要不要在 Qt 侧**全量**翻译，还是只翻变体 7 类 + generic | 决定本地化工作量；本文建议**先做 7+1**，其余回退显示线上工具名 | t9 / 本地化负责人 |
| O7 | `subagent` 子调用树要不要"默认展开"（官方 `turnProcessAlwaysOpen` 对活/停/失败的 turn 恒开） | 影响 §5-7 草图与 B 组断言 | 集成者（体验决策） |

---

## 12. 一页结论

1. **工具可视化在 dsh-qt-app 是从零开始，不是补丁**：`role==="tool"` 只换来一个边框（`MessageDelegate.qml:55,111`），全仓对 `callId/argsRaw/toolCallCount` 的命中数为 0。
2. **不能塞进 `MessageModel`**：那个模型的角色表被 `tests/qml/tst_messagemodel.qml:5` 显式锁定，且它没有承载工具语义的字段。**必须新增独立 `ToolCallModel.qml`**，键用官方 `ToolCallId`。
3. **五态有官方坐标，照抄即可**：`ToolRowState = preparing | running | ok | error | stopped`（`tool-call-model.d.ts:20`）→ 本方案 `queued/running/succeeded/failed/cancelled`。`queued` 与 `running` 的区分只用于内部 `phase`，对外显示"准备中/运行中"，**不假装有调度队列的可见性**。
4. **参数是流式裸 JSON，绝对不猜字段**：线上是 `argumentsDelta: string`（`types.d.ts:475`），官方为此专门有 `PartialArguments`；QML 侧只做"原样显示/缩进美化（try/catch 兜底）"，字段级语义一律由 Node 侧结算后以 `ToolRowDTO` 显式字段给出（R-JSON1..4）。
5. **图表必须拒绝**：官方工具 UI **没有任何图表模型**（`components/` 只有 Row/Details/Badge/AskQuestion 卡），凭空画图等于发明数据契约。文本/Markdown/表格可做——且**表格复用既有 `qml/markdown/Table.qml`，不新增解析器**。
6. **桥缺一条 push 通道**：`QmlBridgeOutbound` 只有 `qml.reply`（`qml-bridge.ts:88-90`），流式工具更新需要新增 `qml.event`（TS 出站类型 + `main.cpp` `handleLine_` 分支 + 一个 QML `Connections`）。这是**集成者的三处改动**，本文只给契约。
7. **本机可实测，且地板是绿的**：TS `319/319`（2510ms）、QML `168/168`（484ms）、`qmllint` exit 0——顺带更正兄弟文档：**`qmltestrunner`/`qmllint` 在 `/usr/lib/qt6/bin/`，不是没有，只是不在 PATH**。
8. **验收必须模拟与真实分开**：A 组 14 条模型 fixture + B 组 8 条组件 fixture 全绿只能证明**契约成立**；"可用"要等 §10 的真机 stdio 注入跑通。Windows 优先但本次未构建，Linux 仅验证 QML 层，**macOS 是缺口**。
9. **文件边界**：本任务只写本文档一个文件；实现阶段新增 8 个 QML 组件 + 1 个模型 + 2 个 fixture，`ChatView.qml`/`main.qml`/桥/C++ 全部由**集成者**统一拥有。
