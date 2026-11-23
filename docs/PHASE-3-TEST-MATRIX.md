# Phase 3 分层测试矩阵与 CI 证据门禁（t10，设计文档）

状态：**设计矩阵（实施现状见独立文件）**。已跑的入口与真实退出码记录在 `docs/PHASE-3-STATUS.md` §3（t26 实测：TS 473/473、QML 215/215、真实 Qt 子进程 e2e 通过）。下表标记 I-xx 的入口只有在代码里存在并可执行时才算「已实现」；未实现的仍是缺口，不伪造命令。

版本锚（引用 t1 报告 §0）：已安装宿主 @deepseek-ai/dsh **0.2.2-rc.1**；官方源码参考 0.2.3-alpha.2 仅作能力面；dsh-qt-app 0.1.0 / dsh-qt-napi 0.1.0；本机 Qt 6.8.2（qmltestrunner/qmllint 在 /usr/lib/qt6/bin，不在 PATH）；Node v26.13.1。CI 矩阵 pin Qt 6.7.3 / Node 22.19.0。

---

## 1. 仓库真实测试入口盘点（现状，逐条核实过）

### 1.1 已存在、可执行（CI 已消费或本地可跑）

| 层 | 命令 | 位置 / 说明 | 现状 |
|---|---|---|---|
| TS typecheck | `pnpm typecheck`（= `tsc -p tsconfig.test.json`） | dsh-qt-app/package.json scripts | test.yml `typescript` job 已跑；t3 报告 319/319 通过 |
| TS 单元 | `pnpm test`（= `tsx --test tests/*.test.ts`） | 同上 | tests/ 下 11 个 .test.ts（index/qml-bridge/settings/settings-forms/settings-slots/theme/timer/markdown*/highlight/napi-loader/skeleton） |
| QML lint | `cmake --build build --target qmllint`（CMakeLists find_program QMLLINT_EXECUTABLE） | 需 Qt 构建树 | test.yml `qml-lint` job |
| QML 测试 | `cmake --build build --target qml-tests`（= offscreen qmltestrunner -input tests/qml -import qml） | 同上 | tests/qml/ 下 **14** 个 fixture；本机可绝对路径补跑（/usr/lib/qt6/bin/qmltestrunner） |
| addon 测试 | `npm test`（= `node --test test/*.test.mjs`）、`npm run verify` | dsh-qt-napi | test.yml `napi` job |
| 打包证明 | `pnpm package`（CMake configure+build+package-app target） | dsh-qt-app | build.yml `qt-build` + `packaging` jobs，artifact 上传即证据 |
| CI 矩阵 | `.github/workflows/test.yml`、`build.yml` | 仓库根=dsh-qt-app（mirror 运行） | 现存，Phase 3 只扩展不重写 |

### 1.2 Phase 3 需要、但目前**不存在**的测试入口（→ 实施任务，不是命令）

| ID | 缺口 | 对应需求组 | 实施要求（交付时才算"存在"） |
|---|---|---|---|
| I-G0 | **stdio 端到端 harness**：Node↔Qt 双进程真实 stdio JSON-RPC 驱动（tests/e2e/ 或 scripts/e2e-*.mjs） | R-TOOL / R-SET / R-WEBUI / R-NO-DEFAULT | 一个真实子进程对（隔离 $DSH_HOME 的测试 profile），无则所有"真实宿主"层全是模拟，不得宣称端到端 |
| I-TOOL1 | ToolCallModel QML fixture（tests/qml/tst_toolcallmodel.qml）+ 乱序/取消注入用例 | R-TOOL | t2 §9.3 A/B 组 fixture 落地 |
| I-PLUGIN1 | 插件管理单测（PluginManager 投影层，mock host ctx；tests/plugin-manager.test.ts） | R-PLUGIN | 覆盖启停/失败收敛 |
| I-PLUGIN2 | React 子集拒绝用例（schema 6 控件词表之外的 R1–R7 拒绝） | R-PLUGIN | 契约测试，纯 TS |
| I-WEBUI1 | WebuiService 状态机单测（Idle→…→Failed 退避；mock ChildProcess） | R-WEBUI | 纯 TS，不 spawn 真实 dsh |
| I-WEBUI2 | 真实 `dsh web --port 0 --no-open` 探测用例（隔离 profile，CI 内运行） | R-WEBUI | 就绪正则用官方 `dsh web: <url>`（t5 纠偏） |
| I-SET1 | SettingsStore 持久化/回读用例（临时目录 profile） | R-SET | 复用 tests/settings.test.ts 扩展 |
| I-SET2 | 凭据安全用例（V5/V10：日志无明文 key） | R-CRED | logger spy + 断言无 `sk-fake-` |
| I-GATE1 | **门禁脚本**（见 §4）：exit-code 保真包装器 | 全部 | scripts/gate.mjs，CI 每步经它运行 |
| I-DOC1 | macOS 缺口豁免清单（docs/ci.md 已有 Known gaps，Phase 3 需扩到新 job） | 全部 | 显式列出，不静默 |

---

### 1.3 实施状态（t26 实测，随代码更新）

| 缺口 ID | 现状 | 入口（存在才列） |
|---|---|---|
| I-G0 | **部分实现**：真实 Qt 子进程握手 + `host.ping` 往返 + 干净退出；尚未在隔离 profile 中跑完整会话/工具流 | `tests/host-e2e.e2e.ts` |
| I-TOOL1 | **已实现** | `tests/qml/tst_toolcallmodel.qml`、`tests/tools-projection.test.ts` |
| I-PLUGIN1 | **已实现**（官方 manager fake） | `tests/plugins-service.test.ts`、`tests/integration-wiring.test.ts` |
| I-PLUGIN2 | **已实现**（受限 React 子集/拒绝） | `tests/ui-converter.test.ts` |
| I-WEBUI1 | **已实现**（状态机，不 spawn） | `tests/webui-service.test.ts`、`tests/webui-default-off.test.ts` |
| I-WEBUI2 | **未实现**：未在 CI 内真实 spawn `dsh web --port 0 --no-open` | — |
| I-SET1 | **已实现** | `tests/settings-rpc.test.ts`、`tests/settings-forms.test.ts`、`tests/qml/tst_settingsbridge.qml` |
| I-SET2 | **部分实现**：帧/回复 JSON 断言无 sentinel secret；日志 spy 级断言未单列 | `tests/integration-wiring.test.ts` |
| I-GATE1 | **未实现**：门禁包装器脚本不存在；当前直接记录命令退出码与日志路径 | — |
| I-DOC1 | **部分实现**：`docs/ci.md` Known gaps + `docs/PHASE-3-STATUS.md` §4 | — |


## 2. 需求 → 分层测试 → 证据 映射（验收矩阵）

层代码：**U**=单元(TS)、**C**=契约(桥/DTO 形状)、**Q**=QML fixture、**E**=真实宿主端到端(隔离 profile)、**P**=Windows/Linux 打包、**M**=macOS（缺口，如实标注）。证据锚：CI job/step 名 + 日志文件路径（§5 格式）。

| ReqID | 需求（来自任务书/依赖报告） | U | C | Q | E | P | 正例 | 负例 | 证据锚 | 实施 |
|---|---|---|---|---|---|---|---|---|---|---|
| R-BRIDGE-H1 | 真实双进程握手：Qt 启动→stdio 连接→Node 侧 connected；每帧换行分隔 JSON-RPC envelope（协议 v1 信封：`kind=hello|hello.ack|req|res|evt`，帧定义见 `src/bridge/protocol.ts`；**不存在** Phase 2 的 `qml.request/qml.reply` 双形状兼容层） | U | C(envelope 形状冻结) | — | E(I-G0：真实 spawn，抓帧存盘) | — | 握手后 request/reply 往返 | 断连、半行帧、非 JSON 帧→显式错误非挂死 | e2e（帧日志 artifacts） | I-G0 |
| R-BRIDGE-T1 | 请求/回复与超时：request 有 replyId；无 reply 超时→rejected+超时码；进程退出→pending 全部 rejected | U | C | — | E（kill 一端观察） | — | 正常往返 | replyId 重复/超时/exit 三负例 | e2e | I-G0 |
| R-BRIDGE-E1 | 事件流：qml.event 推通道不占 request 槽位；乱序/重复事件幂等到达（与 R-TOOL-O1 共用 fixture） | U | C | Q | E | — | 推送顺序保序 | 同帧多事件、事件先于握手 | qml-tests / e2e | I-TOOL1,I-G0 |
| R-TOOL-O1 | 工具事件乱序到达仍收敛到正确五态（queued/running/succeeded/failed/cancelled） | U(模型状态机) | C(ToolEventDTO/ToolRowDTO 形状、tool.snapshot 拉通道) | Q(I-TOOL1) | E(I-G0：jsonl 注入 4 行) | — | ok/error 序列正常收敛 | delta 先于 start、error 后又 ok、重复 callId | test.yml `typescript`；qml-tests；e2e job | I-TOOL1,I-G0 |
| R-TOOL-O2 | 取消路径：cancelled 状态不可被迟到 ok/error 覆盖；终止事件后不再渲染新 delta | U | C | Q | E | — | cancel→终态冻结 | 终态后事件被丢弃且记一条 warn | 同上 | I-TOOL1 |
| R-TOOL-P1 | 流式裸 JSON 参数不按字段猜（R-JSON1..4）：PartialArguments 累积、截断三层（8/9 行、2000 行、200KB） | U(累积器) | C | Q(截断/复制) | — | — | 合法增量拼接 | 语义不合法 JSON 只显示原文不解析 | qml-tests + typescript | I-TOOL1 |
| R-PLUGIN-L1 | 插件启停：enable/disable 后 listPlugins 状态翻转、QML 按钮从 enabled:false 接线 | U(I-PLUGIN1 mock) | C(槽位名 settings.section，非 conversation.settings.*) | Q(SettingsPanel slot 渲染) | E(隔离 profile，装**测试用**示例插件) | P(插件目录随包) | 启停成功 | 宿主不可用→降级只读+诊断信息 | typescript / e2e | I-PLUGIN1,I-G0 |
| R-PLUGIN-F1 | 安装失败收敛：事务回滚、application='failed'、诊断失败不影响结果；不触碰用户插件 | U | C | — | E(只装 fixtures/plugin-bad-*，坏 manifest/坏版本/锁竞争三例) | — | 失败后列表回到安装前 | 半安装状态残留=失败 | e2e job | I-PLUGIN1,I-G0 |
| R-PLUGIN-R1 | React 子集拒绝：6 种控件词表之外的意图按 R1–R7 拒绝或转 WebView，不静默降维 | U(I-PLUGIN2) | C | — | — | — | 合法 schema 通过 | 含 ReactNode/函数体/嵌套图等拒绝并给原因码 | typescript | I-PLUGIN2 |
| R-WEB-FB1 | React 子集兜底：被拒槽位可走 WebView 回退（t3 §7/t5 协议），QML 仅见 URL/脱敏载荷 | U | C(协议形状) | Q(SlotHost Loader 加载) | E | — | WebView 加载成功 | 无 WebEngine→QDesktopServices 降级路径 | qml-tests / e2e | I-PLUGIN2,I-WEBUI1 |
| R-SET-D1 | Settings 描述符投影：官方 ctx.settings describe/update/replace/mutate+revision，Qt 侧只投影不建第二套；只发 mutate 禁 replace | U(I-SET1) | C(SETTINGS_CONFLICT、redactSecrets 形状) | Q(表单/禁用态 V8/V9) | E(隔离 profile describe 与磁盘一致) | — | 冲突→横幅+重载 | 过期 revision 提交被拒 | typescript / e2e | I-SET1,I-G0 |
| R-SET-R1 | 重启回读：新实例 load() 后 describe() 与写入一致；theme.json 唯一权威、native 唯一写者（schema v2 迁出） | U | C | Q(tst_themesettings 扩展) | E(两个进程读同一临时目录) | — | 写→新进程读回一致 | 三写两文件分叉=失败（V11 theme 单写） | typescript / e2e | I-SET1 |
| R-CRED-L1 | LLM 凭据不入日志：明文 key 只活在 draft，提交后清空；日志只记 ref 名与拒绝码 | U(V5/V10 logger spy) | C(credentials.set 形状) | Q(ApiKeyField.draft 清空) | E(端到端跑完 grep 全部日志无 `sk-fake-`、无 Bearer、无 8 字符片段) | P(打包产物内也不含) | 合法 key 提交成功 | 空白/含换行 key 被拦（V4） | e2e job + 日志断言步 | I-SET2,I-G0 |
| R-WEB-O1 | Web 进程所有权：只认 ChildProcess 句柄；单子进程不变量；dispose 先 Stopping；不扫进程表、不误杀端口占用者（转 external） | U(I-WEBUI1 mock) | C(状态机签名) | — | E(I-WEBUI2：真实 spawn+kill，断言子进程随之退出) | — | close 后 pid 消失 | 双 spawn 被拒；句柄丢失不清理外部进程 | typescript / e2e | I-WEBUI1,I-WEBUI2 |
| R-WEB-A1 | 认证链：token→303+cookie→Host/Origin 栅栏；token 不进 QML/settings/日志；QML 仅见 maskedUrl；token 只经一次 C++ load() | U(脱敏器) | C | Q(URL 脱敏显示) | E(无 token 请求被拒 401/403；日志 grep 无 token) | — | 带 token 建立会话 | 无 token/伪造 Host 被拒；日志含 token=失败 | e2e | I-WEBUI2,I-G0 |
| R-NO-DEF1 | 默认不启动 WebUI：Qt profile 无 webserver/web-app 依赖、Qt 进程零监听、Node 侧零 spawn | U(静态断言：包依赖/代码 grep 测试) | — | — | E(启动 Qt profile 后 netstat/ss 无监听、无 web 子进程) | P(安装包不捆绑 webserver) | 静态测试绿 | 任何 .listen( 出现在 qt-app 生产代码=失败 | typescript(新增静态守卫测试，I-NO-DEF) + e2e | I-NO-DEF(新增，见表 1.2 补注) |
| R-PLAT-1 | Windows 优先：全矩阵 Windows 腿绿；Linux 支持绿 | — | — | Q | E | P | 两平台 artifact 产出 | 任何平台 leg 失败→整体失败 | build.yml qt-build/packaging | 现有 CI |
| R-PLAT-2 | macOS：**缺口，如实报告**。macos-14 leg 取消不算通过，矩阵中显式 `outcome=cancelled` 并列入 docs/ci.md Known gaps | — | — | — | — | — | — | macOS 缺失不得计入"全平台绿" | build.yml 矩阵 + ci.md | I-DOC1 |

补充 I-NO-DEF 说明：表 1.2 漏列，补正——静态守卫测试（断言 package.json 无 webserver/web-app、src/ 与 native/ grep 无 child_process/listen）加入 `pnpm test` 既有套件，属低成本必做项。

---

## 3. 分层含义与"不得互充"规则

1. **U/C/Q 全绿 ≠ 端到端可用**（t2 §11.8 原则）。E 层存在且运行的需求才能标"真实验证"；只有 U/Q 的需求标"契约验证"。
2. **模拟与真实分开标注**：证据格式（§5）的 `level` 字段必须如实写 U/C/Q/E/P，禁止把 Q 层结果写成 E 层。
3. **跳过不算通过**：`test.skip`/`todo`、CMake `message(STATUS)` 降级（如 qmltestrunner not found）、`if-no-files-found` 以外的 artifact 缺失，一律使 job 失败（见 §4 G3）。
4. **macOS 缺口**：唯一允许的"非绿"形态是矩阵中显式取消 + docs/ci.md Known gaps 条目；汇总表必须单列 macOS 行且值固定为 `gap(not-validated)`，禁止与其他平台合并为 "N/A"。

## 4. CI 门禁设计

### 4.1 门禁脚本（I-GATE1，scripts/gate.mjs，实施任务）

包装每条测试命令，强制：

- **G1 进程退出态保真**：以被包装进程的真实 exit code 退出；禁止 `|| true`、`echo "done"` 兜底、捕获后重抛改动语义。CI 每步 `run:` 形如 `node scripts/gate.mjs -- pnpm test`。
- **G2 零测试必须失败**：运行器报告的 test/suite 计数为 0、或 stderr 含 "no tests found"、或 fixture 目录为空 → exit 1。对 `tsx --test`、`node --test`、`qmltestrunner`（解析其 XML/文本输出计数）分别实现计数器，落 evidence JSON。
- **G3 缺套件必须失败**：套件清单（§2 矩阵中标 ✅ 的实施后清单）与运行器报告集合 diff，缺一个即失败——防止"删文件让 CI 变绿"。清单由脚本从本文件 §2 生成（防漂移）。
- **G4 空日志必须失败**：每个 job 结束检查其日志文件 ≥1 条结构化证据行（§5），否则 exit 1。
- **G5 SHA 固定**：CI job 起始 step 记录 `git rev-parse HEAD`（app）与 addon 仓库 checkout 后 `git rev-parse HEAD`（addon）；e2e 与打包证据必须带这两个 SHA；SHA 缺失的证据行视为无效（G4 连带失败）。-addon 仓当前由 `NAPI_REPO: lbn2011/dsh-qt-napi` checkout，Phase 3 若换本地路径需同步更新此处约定（交 t6 裁决）。
- **G6 禁止无条件 echo 兜底**：grep CI yml 中 `|| echo`、`continue-on-error: true`（Known gaps 豁免的 macOS leg 除外，且必须显式注释）——新增脚本步骤 `scripts/gate.mjs --check-yml .github/workflows`，违例即失败。

### 4.2 job 布局（在现有 test.yml/build.yml 上扩展）

| Job（新增） | 平台 | 内容 | 预算占用 |
|---|---|---|---|
| `e2e-host` | ubuntu-22.04（先行） | I-G0 harness：隔离 $DSH_HOME 测试 profile，跑 §2 全部 E 行（工具注入/插件坏包/设置回读/凭据 grep/web spawn/默认不启动） | 重（双进程+Qt），串行，见 §6 |
| `e2e-host-windows` | windows-2022 | 同上 Windows 腿（Windows 优先原则：Windows 失败视为阻塞） | 重 |
| `gate-static` | ubuntu | G6 yml 检查 + 静态守卫测试（R-NO-DEF1）+ SHA 记录 | 轻 |
| `qml-tests` / `qml-lint` / `packaging` | 现有 | 不重写，仅每步改走 gate.mjs 包装 | 现有 |

**Windows 优先落地**：e2e 两腿均必跑，ubuntu 先行探路、windows 为发布门；Linux 腿失败也阻塞合并（t2 明确 Linux 支持非豁免）。macOS 无 e2e，保持缺口。

### 4.3 正负例组织约定

- 正例命名 `tests/e2e/cases/<reqid>-ok.*`，负例 `<reqid>-neg-*`；每个负例必须断言**具体的拒绝码/状态**（如 `refused`、`SETTINGS_CONFLICT`、`application='failed'`、HTTP 401/403），不允许只断言"没成功"。
- 一切真实凭据为假凭据（`sk-fake-…` 固定前缀便于日志断言）；一切宿主写入走隔离 `$DSH_HOME=$(mktemp -d)`；e2e 永不指向用户 profile、不操作用户插件、不依赖 127.0.0.1:3080 生产 webserver（CI runner 上本就不存在，本地开发者运行时必须显式传 `DSH_TEST_HOME` 否则 gate.mjs 拒绝执行 e2e——防误伤本机 0.2.2-rc.1 安装）。

## 5. 原始证据格式

每个测试步骤向 `evidence/<job>/<step>.json` 追加一行 JSON（G4 校验非空）：

```json
{
  "ts": "2026-11-24T02:31:00Z",
  "job": "e2e-host",
  "step": "R-CRED-L1-log-scan",
  "level": "E",
  "reqIds": ["R-CRED-L1"],
  "sha": { "app": "bfc6373…", "addon": "87084a6…" },
  "command": "node scripts/gate.mjs -- pnpm test",
  "exitCode": 0,
  "counts": { "tests": 319, "passed": 319, "failed": 0, "skipped": 0, "todo": 0 },
  "artifacts": ["logs/e2e-host-R-CRED-L1.log"],
  "platform": "ubuntu-22.04"
}
```

硬规则：`skipped>0 || todo>0` → gate 判失败；`counts` 缺失 → 失败；`sha` 缺失 → 证据无效。汇总由脚本聚合为 `evidence/summary.json`，PR 检查以它为准，不以人肉转述为准。

## 6. 共享 CPU 200% / 4G 总预算：串行与恢复规则

（本任务按团队约定执行；以下同时是给 t6 写 CI 的约束。）

- **本机（开发机）**：任何两条重任务（CMake/Qt 编译、addon 编译、e2e 双进程、npm/CI 镜像运行）**不得并行**——串行队列，单任务内存上限 2G（node --max-old-space-size=2048 / cmake -j2）；Qt/C++ 编译按 docs/ci.md 既定原则仍**全部留 CI**，本机只跑 TS/QML 层（TS 套件 + 绝对路径 qmltestrunner offscreen，单进程即可）。
- **CI（每 runner 独占资源）**：`e2e-host` 与 `e2e-host-windows` 不与其他 job 共享 needs-并行；heavy job 设 `timeout-minutes`（e2e 45、qt-build 现值保留）防挂死占用。
- **日志持久化**：所有测试输出 tee 到 `evidence/…` 并 `actions/upload-artifact`（retention ≥ 14 天 for e2e）；stdout 摘要进 gate.mjs 的 evidence JSON；**禁止只写内存不落盘**。
- **后台作业恢复**：长 e2e 用 harness 的后台作业跑时，(1) 启动即记录 job id + 完整命令 + 日志路径到 `.agent-teams/dsh-qt-phase3/e2e-jobs.log`；(2) 会话中断后重入先 `job_list` 对账，未完成者 `job_output` 收尾或 `job_kill` 后重启，**不重复启动同一 case**（幂等锁：evidence 行存在即视为已跑，缺失才重跑）；(3) job 崩溃产生的孤儿子进程由 gate.mjs 在启动时按记录的 pid 文件清理——只清理**自己记录的 pid**，延续 t5「不扫进程表」规则。

## 7. 集成版本复验条件（何时必须整批重跑）

满足任一条，§2 全矩阵（含 P 层）在集成版本上复验一轮并更新 evidence：

1. app 或 addon 的 HEAD SHA 变化且已合入集成分支（G5 证据链随之失效）。
2. 宿主从 0.2.2-rc.1 升级（t1 已警告 0.2.3-alpha.2 行号差异，契约面需重核）。
3. t9 完成版本统一后：所有 C 层契约与 E 层用例按统一版本逐项重核（t3 引用 0.2.3-alpha.2 源码、t4/t5 基线 0.2.2-rc.1、t2 未锁版本——以任务 append-only 更正证据为准）。
4. t2 本轮「TS 319 / QML 168」无落盘完整日志、无已确认退出码、qmllint 仅 3 文件——按本文档标准**不构成正式全量验收**；引用前须按 §5 格式补齐证据。
5. cordis / plugin-kit 版本错位（O4/O5）被 t6 裁决改变（升 cordis 或 pin 降级都算）。
6. 任何 bridge 帧格式、DTO 形状、槽位名变更（C 层契约破坏即全链复验）。
7. G0 stdio 入口（I-G0）落地时：此前所有标"E 未运行"的行升级为"必须 E 复验"。

复验通过的定义：summary.json 中每个 ReqID 至少一条 `exitCode=0` 且 level 达到该行矩阵的最高已实施层；macOS 行永远为 `gap(not-validated)`，不参与通过判定。

## 8. 给 t6/t7 的裁决请求

1. I-G0 harness 放 dsh-qt-app 还是独立仓（影响 G5 SHA 双仓约定与 CI checkout 布局）。
2. addon 仓 checkout 方式（NAPI_REPO 远端 vs 本地路径）——影响 SHA 固定方式。
3. e2e 在 CI 与本机共用同一 gate.mjs；本机 e2e 是否允许（默认禁止，需 `DSH_TEST_HOME` 显式覆盖）。
4. R-NO-DEF1 静态守卫测试加入现有 settings 套件还是独立文件（建议独立 `tests/no-default-webui.test.ts`）。
5. macOS Known gaps 更新措辞（I-DOC1）需在 Phase 3 合并前落 docs/ci.md。

---

*本文为设计，无任何已运行证据；所有「已存在」命令均逐条核对过 package.json / CMakeLists.txt / workflows / docs/ci.md。缺失项以 I-xx 实施任务形式交接，不得在实现前引用为可执行。*
