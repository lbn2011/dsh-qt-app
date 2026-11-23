# I2 测试记录（真实命令、退出码与失败史）

工作树：`/data/qt-phase3/app/wt/tools-cn`（分支 `phase3/tools-cn`）。
基线：`de1c1b1` = `33e516c` 合入 I1a `9a198da05059eb013e06678d3b5c1c1698644aa5` 与 I1b/I1c `1beba7de40e4957b08e1b45107f12998918d1c25`。
环境：Linux（debian 13），Qt **6.8.2**，`/usr/lib/qt6/bin/qmltestrunner`、`/usr/lib/qt6/bin/qmllint`（宿主工具不在 `PATH`），
Node 侧 `pnpm exec tsx`（`tsx ^4.23.15`，`typescript ^5.9.3`，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）。

共享预算：所有命令统一经

```
flock -w 900 -x /data/qt-phase3/logs/verify.lock -c \
  'systemd-run --scope -p CPUQuota=200% -p MemoryMax=4G --quiet <cmd>'
```

串行执行，峰值为 200% CPU / 4G 内存。日志落 `/data/qt-phase3/logs/t18-*.log`（在仓库外，避免脏工作树）。

## 1. 最终命令与结果

| # | 命令（经上面的 flock + systemd-run 包装） | exit | 证据 | 日志 |
|---|---|---|---|---|
| 1 | `cmake -S . -B build -DDSH_QT_WEBENGINE=OFF` | **0** | 生成 `build/`；警告 `DSH_QT_WEBENGINE` 未使用（见 §5-注1） | `t18-configure.log` |
| 2 | `cmake --build build --target qml-tests` | **0** | `Totals: 195 passed, 0 failed, 0 skipped, 0 blacklisted, 476ms` | `t18-qml-tests.log` |
| 3 | `pnpm exec tsx --test tests/tools-projection.test.ts` | **0** | `tests 28 / pass 28 / fail 0`，`duration_ms 243.34` | `t18-tools-projection.log` |
| 4 | `pnpm exec tsc -p tsconfig.json --noEmit && pnpm exec tsc -p tsconfig.test.json --noEmit` | **0** | 无诊断（两份 tsconfig 都过） | `t18-typecheck.log` |
| 5 | `/usr/lib/qt6/bin/qmllint $(find qml -name '*.qml' \| sort)` | **0** | 27 行输出，全部为既有文件的 `Info:`（如 `ThemeForm.qml:15 unused-imports`），无 `Warning:` | `t18-qmllint.log` |

其中命令 2 是契约要求的 verify 命令：**195 = 既有 168 套件通过 + 本次新增 27 个工具用例**，
说明 `qml` 目录式发现已自动纳入新文件（`CMakeLists.txt` 的 `GLOB_RECURSE qml/*.qml`），且未破坏任何既有套件。

命令 3 是契约要求的 Node 侧 verify 命令：覆盖 §3.7 图表子集、五态迁移、去重与快照对账。

## 2. 覆盖矩阵

### RQ-03（Node，`tests/tools-projection.test.ts`，28 例）

| 验收点 | 用例（节选） |
|---|---|
| `tool/call` → running → `tool/result` → ok | `a call becomes a running row and settles to ok` |
| 参数先到：未闭合 JSON 形成 preparing，不修复原文 | `a partial argument stream forms a preparing row` — 断言 `variant==='others'`、`argsComplete===false`、`argsRaw` 原样 |
| `error.code==='interrupted'` → stopped | `an interrupted result settles as stopped` |
| `meta.stopped===true` + isError → error | `a stopped marker or isError settles as error` |
| **终态不回退** | `a settled row never moves again` — 重复 call 与第二次 result 都被拒，`rejectedTransitions===2`；`tool.args` 也不能重开（返回 `null`） |
| 重复 seq | `a duplicate seq is dropped` — `duplicates===1`，行不变 |
| 乱序 seq | `a late seq is dropped` — `outOfOrder===1` |
| 会话切换快照重建 | `a snapshot rebuild replaces the session` — 旧行清零，仅新会话行 |
| 他会话事件丢弃 | `events from another session are ignored` — `foreignSession` 计数 |
| epoch 变化 → 需对账 | `an epoch change demands a resync` — `needsResync()===true`，其后事件计 `droppedWhileResyncing` |
| 历史 + 实时同一有序列表 | `history and live events land in one ordered list` |
| 不完整 JSON 显示原始片段 | `incomplete arguments keep their raw text` |
| 完整 JSON 只读白名单字段 | `a complete argument set yields a whitelisted summary` — `summary==='src/a.ts'`、`titleKey==='tool.title.read'` |
| >200KB 截断 | `a huge result is truncated with a marker` — `resultTruncated===true`，含 `[truncated]` |
| >2000 行截断、预览 8 行 | `a long result is capped by lines` / `the preview keeps the first lines` |
| 非 text 块 pretty JSON | `non-text blocks are shown as pretty JSON` |
| 显式图表 | `an explicit bar chart is projected` / `an explicit line chart is projected` |
| 非法图表五类降级 | `an invalid chart degrades with a reason` — `type-mismatch` / `empty-series` / `non-numeric` / `too-many-points` |
| 结果文本里的图表 JSON 不被当图表 | `chart-like JSON inside the output is never guessed into a chart` — `chart===null && chartRejected===null` |
| `args` 里的图表字段不读 | `a chart field inside the arguments is ignored` |
| 显式表格透传 | `an explicit table is passed through with its headers` |
| 嵌套 subagent | `a nested subagent call keeps its parent link and sorts after the parent` |
| 未知事件不推水印 | `unknown event types are ignored without touching the watermark` |
| 畸形事件不抛 | `malformed tool events are dropped and counted, never thrown` |
| 快照水印取最大 seq | `the snapshot watermark is the highest applied seq, not the last call time` |

### RQ-04（QML，`tests/qml/tst_toolcallmodel.qml`，27 例）

模型：插入/就地更新（不重建）、26 角色齐全、终态守卫（`ignoredRegressions`）、`applySnapshot` 是唯一 clear 路径、
展开态跨流式更新保持、`rowAt` 还原 `null`/数字/图表对象。
行：五态色与文案（preparing/running/ok/error/stopped）、`headerText` 拼接（preparing 才追加 KB）、
空行外壳（`hasRow===false`）、空输出显式提示、错误文案 `name (code): reason`、
复制发 `copyRequested(text,label)`（无输出时复制参数）、展开发 `expansionChanged`、
图表仅在显式载荷时渲染、被拒绝载荷显示 `toolRowChartNotice`、表格复用 `Table.qml`、
结果里的图表 JSON 不渲染图表、未知工具回退原始名。
图表：合法数据 `valid===true`、超 1000 点 `overBudget`、非法数据 `valid===false`。

## 3. 失败史（红灯 → 绿，如实记录）

1. **TS 红灯先行**：`tsx --test tests/tools-projection.test.ts` → `ERR_MODULE_NOT_FOUND: …/src/tools/dto.js`，exit 1（实现文件尚不存在，TDD 预期红灯）。
2. **QML 首轮 16 失败**，逐个定位（全部是**真实缺陷**，不是测试写错）：
   - `Item.visible` 在 qmltestrunner 下恒为 `false`（父链隐藏，Qt 6 语义返回有效可见性）→ 套件加 `visible: true`（同 `tst_formcontrol.qml` 既有做法）。
   - `ToolCallRow` 里 `readonly property var data` 与 `Item::data` 只读列表属性冲突 → 改名 `fields`。
   - **`ListModel` 无法从 `null` 建角色**（`QWARN: … is null. Adding an object with a null member does not create a role`）：`parentCallId/exitCode/chart/table` 首行为 `null` 时角色根本没创建 → 模型内部改存 `""`/字符串/JSON 文本，`rowAt()` 的 `decode()` 还原。
   - 复用同一个 `SignalSpy` 换 `target/signalName` 会打「Signal 'X' not found」且计数恒 0 → 改为声明式固定 spy（`rowAddedSpy/rowChangedSpy/resetSpy/copySpy/expandSpy`）。
   - `ToolCallRow` 只读扁平 `errorName/errorCode/errorReason`，而 DTO 是嵌套 `error:{name,code,reason}` → 加 `errorPayload`/`payloadText()` 双形状兼容。
   - `headerText` 在 running 态把 20 B 参数渲染成「· 0.0 KB」→ 仅在 `preparing` 态显示字节后缀。
3. **TS 二次红灯（类型检查）**：`tsc` 报 `TS6196 'ParsedError' is declared but never used`（未使用的接口）与
   `TS18047 'child' is possibly 'null'`（`noUncheckedIndexedAccess`/strict 下 `row()` 可能为 `null`）→ 删除死类型、显式收窄，
   `tsc` 两份配置均 exit 0。
4. **最终**：QML 工具套件 27/27，全量 195/195，TS 28/28，lint 与类型检查全 0。

## 4. 平台矩阵

| 平台 | QML 套件 | Node 套件 | 说明 |
|---|---|---|---|
| Linux（本机 Qt 6.8.2，`QT_QPA_PLATFORM=offscreen`） | ✅ 27/27 | ✅ 28/28 | 本记录全部证据 |
| Windows | ❌ 未运行 | ❌ 未运行 | 缺口。`Canvas` 与 `"monospace"` 回退需真机复验；CI 曾有 `npx.cmd EINVAL` 前科 |
| macOS | ❌ 未运行 | ❌ 未运行 | 缺口，项目整体无 macOS 支持证据 |

「未运行」不等于「通过」。集成阶段（I8）必须在 Windows 上复跑 §1 的命令 2、3 并把日志纳入 `phase-3` 记录。

## 5. 复现说明与已知环境坑

1. **`DSH_QT_WEBENGINE` 未被使用**：`CMakeLists.txt` 尚无该选项，configure 会警告但不影响结果（与 I1b/I1c 记录一致）。
2. **`cmake --build build --target qmllint` 在本机不存在**：该 target 只在 configure 时 `find_program(qmllint)` 成功才生成，
   而 `/usr/lib/qt6/bin` 不在 `PATH`。若要使用该 target：`PATH=/usr/lib/qt6/bin:$PATH cmake -S . -B build` 重新 configure。
   本记录改用直接调用同一二进制 lint 全部 `qml/**/*.qml`（§1 命令 5），语义等价。
3. **build 目录不随 merge 带来**：本工作树的 `build/` 是本次自建（§1 命令 1），非 git 产物。
4. **QML 测试须用相对 import**：`qmltestrunner` 不支持绝对路径 `import`，临时调试套件必须放在 `tests/qml/` 下（本次调试文件已删除）。
5. **视图断言要断言意图**：任何 `visible` 断言都要求 `TestCase { visible: true }`，否则读到的是父链隐藏后的 `false`。

## 6. 与验收标准对照

| 验收标准 | 状态 | 证据 |
|---|---|---|
| ① 终态不回退；乱序/重复与会话切换快照正确；结果截断符合计划 | ✅ passed | §2 RQ-03 表：`a settled row never moves again`、`a duplicate seq is dropped`、`a late seq is dropped`、`a snapshot rebuild replaces the session`、三层截断用例 |
| ② 显式合法图表渲染、非法数据降级；禁止从任意 JSON 猜图表 | ✅ passed | `an explicit bar/line chart is projected`、`an invalid chart degrades with a reason`（4 类）、`chart-like JSON inside the output is never guessed into a chart`、QML `ToolChart` 用例 |
| ③ 固定 SHA 测试记录与共享文件接入说明齐备 | ✅ passed | 本记录（基线 `de1c1b1`、I1a `9a198da`、I1b/I1c `1beba7de`）+ `docs/handoff/I2-tools.md` §6 接线说明 |
