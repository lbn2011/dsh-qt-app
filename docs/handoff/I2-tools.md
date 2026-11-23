# I2 交接：工具调用投影、五态行与显式图表

工作树：`/data/qt-phase3/app/wt/tools-cn`（分支 `phase3/tools-cn`）。
基线：`de1c1b1`（= `33e516c` 合入 I1a `9a198da` 与 I1b/I1c `1beba7de` 后的合并提交）。
本文只描述 I2 新增的公共面与**接线**要求；实现细节以源码为准。

I2 只增不改：新增 `src/tools/`、`qml/models/ToolCallModel.qml`、`qml/views/ToolCallRow.qml`、
`qml/components/ToolChart.qml` 与两份测试。**未触碰任何共享文件**（`qml/main.qml`、`qml/views/ChatView.qml`、
`qml/views/MessageDelegate.qml`、`src/index.ts`、`native/`），接线由 I8（qiu-host）统一落实，见 §6。

## 1. 交付物

| 文件 | 职责 | 层 |
|---|---|---|
| `src/tools/dto.ts` | 行 DTO、快照、统计与全部上限常量 | Node |
| `src/tools/projection.ts` | 纯同步投影：官方 `tool/call`、`tool/result` → `ToolRowDTO` | Node |
| `src/tools/index.ts` | barrel，便于 `import { ToolProjection } from './tools/index.js'` | Node |
| `qml/models/ToolCallModel.qml` | `ListModel`：行集合、就地更新、终态守卫、快照重建 | QML |
| `qml/views/ToolCallRow.qml` | 单行渲染：标题/摘要/五态/参数折叠/结果/错误/图表/表格/复制 | QML |
| `qml/components/ToolChart.qml` | 原生 `Canvas` 条形/折线（无第三方库） | QML |
| `tests/tools-projection.test.ts` | 28 个投影用例（含五态、乱序重复、快照、截断、图表负例） | Node |
| `tests/qml/tst_toolcallmodel.qml` | 27 个 QML 用例（模型 + 行 + 图表） | QML |

## 2. 数据流

```
dsh-session 事件流                      Node（ctx.hostBridge）
  tool/call   ─┐
  tool/result ─┴─► ToolProjection ──► ToolRowDTO[] ──► tool.snapshot 回包（req/res）
                        ▲                    └─────► tool.row / tool.args（evt，见 §10-G1）
                        │
                 session/event 订阅（I8 接线）
QML
  qtBridge.request("tool.snapshot", {sessionKey})
        └─► ChatView.onRequestReplied(method==="tool.snapshot") ──► ToolCallModel.applySnapshot()
                                                                      │
                                                    ListView delegate ──► ToolCallRow ──► ToolChart / Table
```

投影是**纯函数式**的：不读时钟、不开定时器、不做 IO。喂它事件，它给你行；同一串事件在任何时刻重放都得到同一结果。

## 3. Node 侧公共面（`src/tools`）

```ts
class ToolProjection {
  constructor(options?: ToolProjectionOptions)
  get sessionKey(): string | null
  get epoch(): string | null
  get watermark(): number                 // 已消费的最高 seq，初值 -1
  get stats(): ToolProjectionStats
  needsResync(): boolean                  // epoch 变化后、快照重建前为 true
  beginSession(sessionKey: string, epoch: string): void
  applySnapshot(input: { sessionKey: string; epoch: string; seq: number;
                         events: readonly SessionEventLike[] }): ToolSnapshot
  applyEvent(event: SessionEventLike, context?: ToolEventContext): ToolRowDTO[]
  applyArgsDelta(input: ToolArgsDeltaInput): ToolRowDTO | null
  rows(): ToolRowDTO[]
  row(callId: string): ToolRowDTO | null
  snapshot(sessionKey?: string): ToolSnapshot
  clear(): void
}
```

`SessionEventLike` 就是官方事件的最小投影：`{ type: string; seq: number; time?: number; data?: unknown }`。
`type` 只识别 `'tool/call'` 与 `'tool/result'`，其余一律计 `unknownEvents` 且**不推进 watermark**。

`ToolRowDTO` 字段（全部非可选，缺省一律 `null`，避免下游出现 `undefined` 分支）：

| 字段 | 含义 |
|---|---|
| `callId` / `parentCallId` | 调用 id；嵌套（subagent）时指向父调用 |
| `name` / `titleKey` / `variant` | 原始工具名、本地化键、渲染变体（`search|read|bash|write|edit|code|others`） |
| `state` | `preparing|running|ok|error|stopped`（官方五态，不加第六态） |
| `turn` / `step` | 归属的轮次与步 |
| `argsRaw` / `argsComplete` / `argsBytes` | 模型原始 JSON 文本（**永不修复**）、是否已可解析、字节数 |
| `summary` | 从白名单字段取的一条摘要（见 §5），取不到为 `null` |
| `resultText` / `resultPreview` / `resultLines` / `resultBytes` / `resultTruncated` | 结果全文（已截断）、折叠态预览、行数字节数与截断标记 |
| `exitCode` / `error` / `chart` / `chartRejected` / `table` | 退出码、结构化错误、显式图表、图表拒绝原因、显式表格 |
| `seq` / `time` | 最后一次改动该行的事件 seq 与时间 |

`ToolSnapshot = { sessionKey, epoch, seq, rows, truncated }`；`seq` 是水印，客户端断连续传的依据。

上限常量（`dto.ts`）：`TOOL_PREVIEW_LINES=8`、`TOOL_DIFF_PREVIEW_LINES=9`、`TOOL_RESULT_MAX_LINES=2000`、
`TOOL_RESULT_MAX_BYTES=200000`、`TOOL_CHART_MAX_POINTS=1000`、`TOOL_MAX_ROWS=500`、`TERMINAL_TOOL_STATES=['ok','error','stopped']`。

## 4. QML 侧公共面

### `ToolCallModel`（`qml/models/ToolCallModel.qml`）

```qml
信号：rowAdded(string callId)、rowChanged(string callId)、reset()
属性：sessionKey、epoch、watermark、snapshotTruncated、ignoredRegressions
函数：indexOfCall(callId) / applyRow(row) -> int / applyRows(rows) /
      applySnapshot(snapshot) -> bool / rowAt(index) / rowFor(callId) /
      setExpanded(callId, expanded) / toggleExpanded(callId) / clearRows()
常量：statePreparing/stateRunning/stateOk/stateError/stateStopped、terminalStates
```

行角色 26 个：`callId, parentCallId, name, titleKey, variant, state, turn, step, argsRaw,
argsComplete, argsBytes, summary, resultText, resultPreview, resultLines, resultBytes,
resultTruncated, exitCode, errorName, errorCode, errorReason, chart, chartRejected, table, seq, time, expanded`。

两条必须知道的实现约束（都踩过坑）：

1. **`ListModel` 无法从 `null` 建角色**。首次 `append` 时值为 `null` 的角色根本不会被创建，之后 `setProperty` 静默失败。
   因此模型内部把 `parentCallId/summary` 存成 `""`、`exitCode` 存成字符串、`chart/table` 存成 JSON 文本，
   `rowAt()/rowFor()` 出口处再由 `decode()` 还原成 DTO 形状（`"" → null`、`JSON.parse` 失败 → `null`）。
   **读行一律走 `rowAt()`，不要直接读 `ListModel.get()`。**
2. **终态不可回退**：`applyRow` 发现行已处于终态又被非终态覆盖时丢弃并递增 `ignoredRegressions`，
   不重建 delegate（就地 `setProperty`），因此展开态与滚动位置在流式更新中不丢。

### `ToolCallRow`（`qml/views/ToolCallRow.qml`）

两种喂法，任选其一：

```qml
// A. 直接给 DTO（简单，不做就地更新）
ToolCallRow { row: dto }
// B. 绑模型行（推荐，配合 ListView）
ToolCallRow { rowModel: toolModel; rowIndex: index; revision: toolModel.revision; row: toolModel.rowAt(index) }
```

关键属性：`row`、`rowModel`/`rowIndex`、`expanded`、只读 `hasRow`、`settled/failed/stopped/running`、
`stateColor/stateLabel`、`title/headerText`、`bodyText`、`showPreview`、`showEmptyNotice`、`errorText`、
`copyPayload/copyLabel`、`hasChart`、`tableNode`。
信号：`copyRequested(string text, string label)`、`expansionChanged(string callId, bool expanded)`。
主题：与 `MessageDelegate` 同法注入（`ctx.theme` → `Theme`）；等宽字体目前是 `monoFamily: "monospace"`（C4 未决项，见 §10-G2）。

复制**不自己写剪贴板**：它发 `copyRequested(text, label)`，由宿主决定 `TextEdit.copy()` / 系统剪贴板 / 提示文案，
这样 QML 层不依赖平台 API，也便于 I8 统一做「已复制」反馈。

objectName（供测试与集成定位，勿改名）：
`toolRowCard, toolRowStateDot, toolRowTitle, toolRowStateText, toolRowCopyButton, toolRowToggleButton,
toolRowPreview, toolRowError, toolRowArgsSection, toolRowArgsLabel, toolRowArgsBody, toolRowArgsStreaming,
toolRowResultSection, toolRowResultLabel, toolRowResultBody, toolRowTruncationNotice, toolRowEmptyNotice,
toolRowChartSection, toolRowChart, toolRowChartNotice, toolRowTableSection, toolRowTable`。

### `ToolChart`（`qml/components/ToolChart.qml`）

```qml
ToolChart { chart: dto.chart; theme: ... }   // chart 必须已是 §3.7 显式形状
```

只读：`valid`、`chartType`、`title`、`pointCount`、`overBudget`、`minX/maxX/minY/maxY`、`series`。
`valid === false` 时 `ToolCallRow` 显示 `toolRowChartNotice`（"This data cannot be plotted (原因)"）而不是画布。
渲染用 `Canvas`：网格线 + 图例 + `fillRect`（bar，分槽偏移）或 `moveTo/lineTo + stroke`（line）。

## 5. 事件 → 模型 → 组件映射

| 官方事件 / 字段 | 投影（`projection.ts`） | 模型角色 | 组件落点 |
|---|---|---|---|
| `tool/call.data.{callId,name,arguments,turn,step}` | 建行；`state=running`；`argsRaw=arguments` 原样保存 | `callId,name,argsRaw,argsComplete,turn,step,state` | `toolRowTitle`（标题=本地化 `titleKey`，值=原始 `name` 兜底）+ `toolRowSummary` |
| `state`（官方推导：`!done && phase==='preparing'` → preparing，否则 running；`error.code==='interrupted'` → stopped；`isError||meta.stopped` → error；否则 ok） | 唯一状态源 | `state` | `toolRowStateDot`（色）+ `toolRowStateText`（文案） |
| `arguments` 片段（`tool.args` evt / 未闭合 JSON） | 不解析、不修复；`argsComplete=false`，`argsBytes` 计数，摘要尝试取白名单字段 | `argsRaw,argsComplete,argsBytes,summary` | `toolRowPreview` 折叠预览（未结算时显示原始片段） |
| `tool/result.data.message.content`（text 块原文；非 text 块 → 2 空格 pretty JSON；空内容 + error → `name: code`） | `flattenResultContent` → 截断 | `resultText,resultPreview,resultLines,resultBytes,resultTruncated` | `toolRowResultBody`；超限 → `toolRowTruncationNotice`；空 → `toolRowEmptyNotice`（"No output"，明确写出来而不是留白） |
| `tool/result.data.error{name,code,reason}` | `error` DTO | `errorName,errorCode,errorReason` | `toolRowError`（`name (code): reason`） |
| `tool/result.data.meta.exitCode` | 仅从 `meta` 读 | `exitCode` | 行头条追加 `· exit N`（非 0 才显示） |
| `tool/result.data.meta.chart` | `projectChart()`：合法 → `chart`，非法 → `chartRejected` | `chart,chartRejected` | `toolRowChart` / `toolRowChartNotice` |
| `tool/result.data.meta.table` | `projectTable()` | `table` | `toolRowTable`（复用 `qml/markdown/Table.qml`） |
| `tool/result.data.meta.parentCallId` | 仅从 `meta` 读 | `parentCallId` | 行头缩进 / 父行在前（顺序由 `order_` 保证） |
| 事件 `seq`/`time` | 单调过滤 + 记录 | `seq,time` | 不直接渲染，供对账与调试 |
| `expanded` | —（模型本地态） | `expanded` | 折叠区显隐（`toolRowArgsSection` / `toolRowResultSection`） |

摘要白名单（`TOOL_SUMMARY_KEYS`，只取第一个非空字符串，**不猜测其它键**）：
`bash/pwsh=[description,command]`、`read=[path,file_path,url]`、`search=[query,pattern,url]`、
`write/edit=[path,file_path]`、`code=[description]`；未命中的工具没有摘要，显示标题即可。

变体映射（`TOOL_VARIANTS`）与标题键（`TOOL_TITLE_KEYS`）与官方 `dsh-client-ui-tool` 0.2.2-rc.1 逐条对齐，
含 `pwsh→bash`、`read_image→read`、`web_search/grep/glob→search`、`apply_patch→edit`、`run_code→code`、`cordis_*` 等。

## 6. 接线要求（**共享文件，I2 未改，由 I8 落实**）

三处改动都很小，但都必须由同一个 owner 落地，避免 main.qml/桥代码出现并行冲突。

### 6.1 `src/index.ts`（Node）：注册 `tool.snapshot` + 生成 `tool.row`

```ts
import { ToolProjection } from './tools/index.js'

const toolProjection = new ToolProjection()
// 1) 会话切换 / 首次 attach：从会话事件流取历史切片重建
toolProjection.applySnapshot({ sessionKey, epoch, seq: historyWatermark, events: historyEvents })
// 2) 实时：把 session/event 原样喂进来（tool/call、tool/result 之外的会被计为 unknownEvents）
toolProjection.applyEvent({ type, seq, time, data })
// 3) 暴露给 Qt
ctx.hostBridge.register('tool.snapshot', (params) => {
  const sessionKey = (params as { sessionKey?: unknown }).sessionKey
  if (typeof sessionKey !== 'string' || sessionKey === '')
    throw new HostBridgeError('bad-params', 'tool.snapshot requires sessionKey')
  if (toolProjection.sessionKey !== null && toolProjection.sessionKey !== sessionKey) {
    // 当前投影属于别的会话：先重建再回答，绝不拼接（P6）
    return rebuildFor(sessionKey)
  }
  return toolProjection.snapshot(sessionKey)
})
```

`tool.snapshot` 的时间复杂度是 O(行数)，500 行上限内单次 <1ms，5s 超时足够。
若同时实现 §10-G1 的推送，则在 `applyEvent` 之后 `ctx.hostBridge.emitEvent('tool.row', dto, { session: sessionKey })`。

### 6.2 `qml/views/ChatView.qml`（QML）：拉取快照并喂模型

```qml
property ToolCallModel toolModel: ToolCallModel {}          // 或由 main.qml 注入
readonly property string toolSessionKey: ""                 // I8 从会话头/桥取

function refreshToolSnapshot() {
    if (qtBridge === null || toolSessionKey === "")
        return
    internal.pendingToolSnapshot = qtBridge.request("tool.snapshot", { sessionKey: toolSessionKey })
}

Component.onCompleted: refreshToolSnapshot()
```

并在既有的 `onRequestReplied(id, method, ok, result, error)` 单一漏斗里加一支：

```qml
if (method === "tool.snapshot") {
    delete internal.pendingToolSnapshot
    if (ok)
        toolModel.applySnapshot(result)   // 唯一 clear 路径：跨会话不会串行
    return
}
```

会话切换（`sessionChanged` / 新会话）时：**先清空再请求** —— `toolModel.clearRows(); refreshToolSnapshot()`
（`applySnapshot` 自身也会 clear，但先清可以避免旧行在请求往返期间被看到）。

### 6.3 `qml/views/MessageDelegate.qml`（QML）：把工具行挂进消息流

在消息体之后追加一行（`role === "tool"` 的粗粒度气泡仍保留，工具行的数据来自 `ToolCallModel`，两者不互相替代）：

```qml
Loader {
    objectName: "messageToolRow"
    width: parent.width
    visible: active && root.role === "tool"
    sourceComponent: Component {
        ToolCallRow {
            rowModel: toolModel
            rowIndex: toolRowIndex
            row: toolModel.rowAt(toolRowIndex)
            onCopyRequested: (text, label) => toolHost.copyRequested(text, label)
        }
    }
}
```

`copyRequested` 的落地方式（剪贴板 API 跨平台差异）由 I8 决定：可接 `TextEdit { visible: false }` + `selectAll(); copy()`，
或交给原生侧。**QML 侧不直接调 `Qt.application.clipboard`（Qt6 无此属性）**。

## 7. 生命周期、去重与对账（已实现，勿在接线层重做）

| 规则 | 实现位置 | 行为 |
|---|---|---|
| 当前会话 only（P6） | `applyEvent` 的 `context.sessionKey` / `applySnapshot` | 他会话事件计 `foreignSession` 并丢弃；`applySnapshot` 是唯一 clear 路径 |
| 重复投递 | `seq === watermark` | 计 `duplicates` 并丢弃，绝不重放 |
| 乱序/迟到 | `seq < watermark` | 计 `outOfOrder` 并丢弃 |
| 未知事件类型 | `type` 不在两者之内 | 计 `unknownEvents`，**不推进 watermark**（否则会把后续真事件误判为重复） |
| 纪元变化 | `context.epoch !== epoch` | `needsResync()=true`，期间事件计 `droppedWhileResyncing`，直到下一次 `applySnapshot` |
| 终态不回退 | `TERMINAL_TOOL_STATES` 守卫 | 计 `rejectedTransitions`；`tool.args` 也不能重开终态（返回 `null`） |
| 孤儿结果 | 只有 `tool/result` 没有 `tool/call` | 仍建行并计 `orphanResults`（历史切片从中间开始也比丢一条已完成调用好） |
| 畸形事件 | 结构不符 | 计 `malformed` 并丢弃，**永不抛异常**（桥 handler 抛错会变成 internal 错误打断事件流） |

`stats` 是排障入口：任何「丢」都被计数。接线上线后若 `duplicates`/`outOfOrder` 持续增长，说明 Node 侧有重复订阅，
而不是投影 bug。

## 8. 图表协议（§3.7 显式子集，逐字对齐计划）

只认两种显式形状：

```jsonc
// 1) 结构化图表
{ "chart": { "type": "bar" | "line", "title": "…",
             "series": [ { "name": "…", "points": [ { "x": 0, "y": 1 } ] } ] } }
// 2) 与表头一致的二维表格数组
{ "table": { "headers": ["a","b"], "rows": [[1,2],[3,4]] } }
```

拒绝（且**只在显式载荷上**判定，绝不从任意 JSON/文本里猜图表）：
`type-mismatch`（`type` 不是 bar/line、`points` 不是数组等）、`empty-series`（无 series 或无点）、
`non-numeric`（`x`/`y` 非有限数）、`too-many-points`（>1000）。
被拒绝时 `chart=null, chartRejected=原因`，行内显示原文 + 复制按钮 + "该数据无法绘图"。
**结果文本里出现的 JSON 即使长得像图表也不渲染**（有用例钉住）。
禁止：解析任意 SVG/HTML、外链脚本、第三方图表库。

## 9. 截断与性能

| 位置 | 上限 | 行为 |
|---|---|---|
| 折叠预览 | 8 行（write/edit 9 行，diff 风格） | `resultPreview`，展开看全文 |
| 结果主体 | 2000 行 | 只保留头部，追加 `…[truncated]`，`resultTruncated=true` |
| 结果字节 | 200 000 B（按 UTF-8 码点安全切，不产生半个字符） | 同上 |
| 行数 | 500 行 | 快照超出时保留**最后** 500 行，`truncated=true` |
| 参数摘要 | 200 字符 | `summarizeArguments` |
| 图表点 | 1000 | 超出整张图拒绝（不抽样，避免「看起来对但其实是猜的」） |

流式更新：`applyRow` 就地 `setProperty`，不重建 delegate；`ToolCallRow` 只在 `revision` 变化时 `refresh()`，
因此展开态、滚动位置、选中态都在流式过程中保持。`ToolChart` 仅在 `chart/width/height/theme` 变化时 `requestPaint()`，
不做每帧重绘。大输出（200KB）只在展开时才交给 `Text`（折叠态用预览），避免长文本布局拖慢滚动。

## 10. 缺口与未覆盖（如实记录）

- **G1（阻塞推送路径）**：`native/main.cpp` 的 `handleEvent_()` 目前只处理 `theme.reload`，
  **没有任何「事件 → QML」信号**。因此计划 §3.2 的 `tool.row` / `tool.args` 推送，QML 今天收不到。
  两条路径：
  (a) **零 C++ 改动（已可用）**：QML 轮询 `tool.snapshot`（§6.2），在 composer 提交后与流式期间以 500–1000ms 节奏刷新；
  (b) **计划一致（需授权改 C++）**：给 `DshQtBridge` 加 `void eventReceived(QString name, QVariant topic, QVariant payload)`，
      在 `handleEvent_` 里对 `tool.row|tool.args|tool.cleared` 转发。属原生/桥代码，**I2 未改**，由 I8 决策与实施。
- **G2（等宽字体）**：`Theme.qml` 无等宽度 token，`CodeBlock.qml` 硬编码 `"monospace"`，
  `ToolCallRow.monoFamily` 同样硬编码。接 token 时只改一行。
- **G3（平台矩阵）**：本轮验证只在 Linux（Qt 6.8.2 / offscreen）完成。**Windows 未运行、macOS 未运行**，
  两者均为缺口而非「通过」。`Canvas` 与等宽字体回退在 Windows 上需真机复验（I8 的 Windows 优先验收步骤）。
- **G4（未做）**：工具行搜索/过滤、跨会话聚合（计划明确 outOfScope）、结果内链接跳转 `onOpenFile`、
  终止按钮（取消进行中的工具不在 I2 范围）、`tool.cleared` 的 QML 侧消费（有协议无消费方）。

## 11. 验证

命令、退出码、日志路径与失败史见 `docs/test-records/I2-tools.md`。摘要：
`pnpm exec tsx --test tests/tools-projection.test.ts` → 28/28 pass，exit 0；
`cmake --build build --target qml-tests` → Totals 195 passed / 0 failed，exit 0（其中工具套件 27 个）。
