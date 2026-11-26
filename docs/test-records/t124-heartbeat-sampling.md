# Windows 心跳检测：把采样起点、观测通道与稳态分开（t124）

日期：2026-11-26（+08:00）
工作树：`<worktree>`（分支 `phase3/t124-heartbeat`）
固定版本：`094d520131077b9c65bc12b7eda4399bb3f280af`（"ci: build and resolve the Windows heartbeat binary as Release"）
范围：`native/main.cpp`、`tests/gui-heartbeat.e2e.ts`、`.github/workflows/test.yml`、本记录。不含插件页分支，不含 EAC。
状态：**本地 Linux 实测通过，未推送、未在 Windows 上运行**。

## 0. 结论

1. t119 的 Windows 3/13 失败**无法**用「GUI 被 stdio 阻塞」解释，也无法用它排除该可能——原用例把「握手」当「GUI 就绪」、把 `host.ping` 的 `pending` 当 GUI 活性判据、把「1 秒 ≥15 tick」当稳定性判据，三处都没有基线或负控。本记录把三件事拆开测量：启动分段、独立观测通道、稳态与背压窗口。
2. 现在的套件能在 Linux 上**证明**它自己有能力发现 GUI 停顿：故意停住 GUI 线程 1200 ms 时，GUI 心跳在停顿窗口内为 **0 tick**，而同一进程的观测通道仍推进 **24 tick**；停顿结束后稳态恢复（最长间隔 51 ms）。
3. 仍未验证的是 Windows 本身的行为（本机无 Windows，见 §5）。本次只把「能不能测」修好，不声称「Windows 是否卡顿」已有结论。

## 1. 改了什么

| 文件 | 改动 | 目的 |
| --- | --- | --- |
| `native/main.cpp` | 新增 `GuiHeartbeatObserver`（Qt-free，`std::thread` + C stdio，每 50 ms 写 `ob <seq> <steady-ms>`，每条后 `FlushFileBuffers`）；`flushHeartbeat()` 在 Windows 下把 `file.flush()` 升级为 `::FlushFileBuffers`；新增仅测试用的 `DSH_QT_TEST_BLOCK_GUI_MS`（在首个 `windows>=1` 的 tick 上停住 GUI 线程）；`host.ping` 在 `DSH_QT_TEST_HOOKS` 下追加 `pendingDetails:[{id,method,ageMs,sent}]` | 观测通道与 GUI 解耦；负面控制；让 `pending` 可解释 |
| `tests/gui-heartbeat.e2e.ts` | 采样层重写（文件状态 + 读错误分类、`waitFirstBeat`/`waitFirstWindow`/`measureStartup`/`sampleSteady`/`readPingAnswer`/`describeSample`/`archive`）；原 13 例全部保留并改用有界等待；新增 4 例 | 有界测量 + 可读失败信息 |
| `.github/workflows/test.yml` | `pass 13`→`pass 17`；新增 `^# stages `、`^# park: ` 两条门槛；测试步骤注入 `DSH_QT_HB_ARTIFACT_DIR`；artifact 追加 `gui-heartbeat-samples/` | CI 不因「少跑」而假绿；失败可事后读样本 |

生产路径不受影响：观测通道、阻塞钩子、`pendingDetails` 全部由环境变量开关，未设置时行为与 `094d520` 一致（§4.3 有一条默认启动冒烟，见其限制）。

## 2. 证据口径

三条通道，各有各的用途，**不可互相替代**：

| 通道 | 载体 | 何时写 | 能证明 | 不能证明 |
| --- | --- | --- | --- | --- |
| GUI 心跳 | `hb <seq> <elapsed-ms> <windows> <exposed> <visible>`，50 ms QTimer（GUI 线程） | `app.exec()` 之后 | GUI 事件循环在推进 | 启动阶段是否卡（定时器还没转）、GUI 卡住时（写不出来） |
| 观测通道 | `ob <seq> <steady-ms>`，独立线程 | 进程一启动 | 进程活着、写盘通道可用 | GUI 是否在转 |
| 阻塞标记 | `blk <elapsed> <ms>` / `blk-end <elapsed>` | 测试钩子故意停 GUI 时 | 停顿窗口的确切边界 | 真实场景里有没有这种停顿 |

因此「GUI 停顿」的判据是**两条通道的交叉**：`blk` 窗口内 `hb` 为 0 且 `ob` 仍在增长。单独任一通道都不足以下结论——这正是 t123 诊断里三处缺陷的共同形状。

## 3. 用例与实测（Linux，`QT_QPA_PLATFORM=offscreen`）

命令（逐字，包装见 §4.1）：

```
DSH_QT_APP_BINARY=<worktree>/build/dsh-qt-app DSH_QT_HB_ARTIFACT_DIR=/tmp/hb-samples \
  npx --no-install tsx --test tests/gui-heartbeat.e2e.ts
```

结果：`tests 17 / pass 17 / fail 0 / cancelled 0 / skipped 0`，退出码 `0`（日志 `t124-heartbeat.log`）。

| # | 用例 | 判据（改后） | 实测 |
| --- | --- | --- | --- |
| 1 | polled reads: GUI 在 stdin 静默时持续 tick | `measureStartup()` 三段均非 null 且在上界内；`sampleSteady({minimumBeats:10,windowMs:2000})` 的 `fresh>=20`、`gap<=250` | `# stages silent: {"connectedMs":61,"firstTickMs":112,"firstWindowMs":112,"firstTickElapsedMs":62,"observerBeforeFirstTick":1}`；`# steady: 40 ticks in 2000 ms, longest gap 51 ms, bytes in/out 812/798` |
| 2 | 修复前的读循环会停住 GUI | 先 `waitFirstBeat(3000)`（有界），再断言 `stalled.beats<=3`、观测通道 ≥5 tick 且 500 ms 内仍增长 ≥5、`readPingAnswer` 的 `state/pending` 逐字段 | `# legacy: first tick at 52 ms; beats=1 … observer=2 observerGap=52ms` |
| 3 | 关闭 stdin 后继续 tick 并干净退出 | 1 s 内 `after-before>=8`，退出码 0 | pass（1354 ms） |
| 4 | 读取停顿时不冻结 GUI，大回包完整 | `host.echo 200000` 期间 tick 增量 ≥15、载荷长度 200000、`bytesIn` 增量 ≥200000 | `# back-pressure: 20 ticks during the stalled second, bytes in 200084 / out 82` |
| 5–13 | 原 1 MB 入站吞吐、停顿中退出、出站队列自测、溢出降级、两次溢出分别计数、超大帧丢弃、超大行丢弃（两种形态）、stdin 重定向自文件、解析自测 | 保持原判据；三处 `deepEqual(ping,{pending:0,state:'connected'})` 改为 `readPingAnswer` 逐字段（见 §4.2） | 全部 pass |
| 14 | **新增**：故意停住 GUI，观测通道仍活 | `blk` 完成且 `ms===1200`、时长 ≥1200、`ticksDuringPark.length===0`、窗口内观测通道增长 ≥10、停顿后 `sampleSteady` 恢复（`fresh>=10`、`gap<=250`） | `# park: 1200 ms parked, 0 GUI ticks inside the park, 24 observer ticks meanwhile` |
| 15 | **新增**：观测通道在 GUI 首 tick 之前就已在写 | 握手后立即采样，首 tick 后 `observer.length > beats.length` | `# startup: 2 observer ticks before the first GUI tick (elapsed 62 ms)` |
| 16 | **新增**：心跳文件打不开时报告且不拖停应用 | `stderr` 匹配 `/heartbeat file .* could not be opened/`、`host.ping` 仍正常、进程仍活 | `# unopenable heartbeat path: reported on stderr, app still connected` |
| 17 | **新增**：`ping` 能点名它欠谁 | `details.length===pending`、`id`/`method` 非空、`!method.startsWith('host.')`、`ageMs>=0`，5 s 内排空到 `pending===0` | `# request book: 4 outstanding at the handshake, 0 after settling` |

`# request book: 4 outstanding` 正是 t123 诊断里那个「`pending=4` 被当成 GUI 死掉」的真相：握手瞬间 QML 已发 4 个 `markdown.parse`（`llm.providers.list`/`llm.default.get` 各 2），约 300 ms 内排空。它对 GUI 活性没有任何信息量。

## 4. 命令、失败与限制

### 4.1 资源与包装

所有重型命令都在共享锁与 cgroup 限制下串行执行（占位符脱敏）：

```
flock -w 900 -x <shared-lock> systemd-run --scope -p CPUQuota=200% -p MemoryMax=4G --collect --quiet \
  bash -lc 'cd <worktree> && <cmd> > <log> 2>&1'
```

`CPUQuota=200%` 与 `MemoryMax=4G` 在本机 `2` 核上先验取证（`cpu.max`=`200000 100000`、`memory.max`=`4294967296`），再用于构建与测试。构建：`PATH=<qt6>/bin:$PATH cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSH_QT_WEBENGINE=OFF` → 退出码 0；`cmake --build build --parallel 2` → 退出码 0，产物 `build/dsh-qt-app` 468344 B。

### 4.2 本次修复的四个失败（都是新钩子与旧断言口径不一致，不是产品缺陷）

| 失败 | 实际 | 原因 | 处理 |
| --- | --- | --- | --- |
| 用例 2 `the observer channel never ticked while the GUI was parked` | `observer=2`（握手后立刻采样） | 观测通道 50 ms 一条，握手时只有 2 条 | 改为有界等待 ≥5 tick，再断言「仍增长」 |
| 用例 8/10 `AssertionError: the session did not survive…` | `actual {pending:0,pendingDetails:[],state:'connected'}` vs `expected {pending:0,state:'connected'}` | `deepEqual` 遇上新增的 `pendingDetails` | 改用 `readPingAnswer` 逐字段断言，保持「进程仍活」的鉴别力 |
| 用例 14 `longest gap 0 ms` | `beats=1` | 停顿结束后只写了 1 条心跳，没有相邻两点可算间隔 | 改为窗口判据 `ticksDuringPark.length===0` + 停顿后稳态窗口 |

### 4.3 限制（未验证即限制）

1. **只跑了 Linux。** `QT_QPA_PLATFORM=offscreen`，无真实窗口、无 Windows。Windows 上的 `FlushFileBuffers` 语义、50 ms 定时器精度、`windows/exposed/visible` 取值、CI 作业本身均未在本轮验证。
2. **Windows 的 `DSH_QT_EXPECT_NO_DESKTOP=1` 路径未跑。** 该路径把 `exposed` 记为 unavailable 而不是断言，所以 Windows 上「窗口真的显示」这件事本轮仍无证据。
3. **默认启动冒烟只证到「能起、能发 hello、不死」。** 无任何心跳/测试环境变量、`QT_QPA_PLATFORM=offscreen` 时：进程正常输出 `hello`（caps 11 项、`qt 6.8.2`、`epoch` 有值）与 `transport.state connecting`；但无论是 `stdin=/dev/null` 还是进程启动时 stdin 就是一个已关闭的空管道，20 s 后进程仍存活（`timeout` 退出码 124）。同一条用例集里「关闭 stdin 后干净退出」是通的（用例 3，进程在握手后才 `stdin.end()`）。两者差异的机理本轮**未取证**，本记录不据它下任何结论；读路径的代码行未被本次改动触碰。
4. **CI 的三处改动没有在真实 runner 上跑过**（任务要求留待独立审查后再推送）。本机无 JS/Python 的 YAML 解析器，`.github/workflows/test.yml` 只做了人工审阅；`^# stages `、`^# park: ` 两条门槛依赖用例 1、14 的输出行，未在远端验证。
5. **时序数字是这台机器的，不是 Windows 的。** 本记录归档的那次运行首 tick `elapsed=62 ms`，同一天另一次为 `78 ms`，构建后第一次探测为 `≈894 ms`（QML 加载期事件循环未转）；都在同一个 20 s 上界内，但绝对值不可外推到 Windows。
6. **停顿钩子只在第一个 `windows>=1` 的 tick 生效一次。** 这是有意的（不要影响稳态测量），也意味着它不能用来模拟「随机时刻卡顿」。
7. **观测通道是 std::thread + C stdio。** Linux 上只 `flush`，Windows 上每写一条 `FlushFileBuffers`；后者在 Windows 上的开销未测（可能影响 50 ms 节奏，若影响只会让观测变稀疏，不会让 GUI 假停顿）。

### 4.4 与 t123 诊断（P0–P5）的对照

| 建议 | 本轮 | 证据 |
| --- | --- | --- |
| P0 `waitForFirstBeat`，失败信息带文件状态 | 已做 | `waitFirstBeat`、`describeSample`（exists/size/mtime/readError/beats/blocks/observer/bytes） |
| P1 独立观测通道 + Windows `FlushFileBuffers` | 已做 | 用例 15、14；`GuiHeartbeatObserver` |
| P2 仅测试的故意停顿负控 | 已做 | 用例 14；`# park:` |
| P3 背压对照（先建基线再对比） | 已做 | 用例 4：先 `waitFirstBeat` 基线，记录 `bytesIn/bytesOut` 前后差 |
| P4 让 `pending` 可解释 | 已做 | 用例 17 的 `pendingDetails`；用例 2 不再要求「握手瞬间 pending=0」 |
| P5 四段耗时 | 已做 | `# stages <label>: {connectedMs, firstTickMs, firstWindowMs, firstTickElapsedMs, observerBeforeFirstTick}` |

## 5. Windows 待验证项（交给能跑 Windows 的人）

| 项 | 怎么看 |
| --- | --- |
| CI 作业 `qt gui heartbeat (windows-2022)` 是否 17 例全过、零 skip | 上传的 `gui-heartbeat.log` 里 `# tests 17 / # pass 17 / # fail 0 / # skipped 0` |
| Release 二进制解析、`guisub` 会话下窗口是否起得来 | 同日志里 `DSH_QT_EXPECT_NO_DESKTOP=1` 意味着 `exposed` 记为 unavailable；要看 `# stages … firstWindowMs` 是否非 null |
| `FlushFileBuffers` 后心跳文件是否即时可读 | `gui-heartbeat-samples/*-hb.txt` 的 `mtimeMs` 与 `collectedAt` 的差 |
| 50 ms 定时器在 Windows 上的实际节奏 | `# steady` 的 `ticks in 2000 ms` 与 `longest gap` |
| Windows 上是否真的存在 GUI 停顿 | 若某次失败，看 `# park:` 对照与 `blk` 窗口内是否有 `hb`；不要再用 `pending` 判活性 |

## 6. 复现

```
# 1) 依赖与构建（Qt 6.8.x）
PATH=<qt6>/bin:$PATH cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DDSH_QT_WEBENGINE=OFF
cmake --build build --parallel 2

# 2) 套件（Linux 用 offscreen；Windows 见 §5）
DSH_QT_APP_BINARY=$PWD/build/dsh-qt-app DSH_QT_HB_ARTIFACT_DIR=/tmp/hb-samples \
  npx --no-install tsx --test tests/gui-heartbeat.e2e.ts

# 3) 门禁两件
pnpm typecheck
git diff --check
```
