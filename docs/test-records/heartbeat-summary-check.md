# 心跳 CI 摘要门禁修正（t130）

修正 `qt-gui-heartbeat` 作业末尾「Assert the regression really ran」步骤对测试摘要的误判：改前用无锚点子串匹配，`grep -qE 'pass 17'` 会命中 `pass 170`，且整段检查从不读 `cancelled` 计数，于是「170 项全过」和「17 过 + 1 取消」都会让作业变绿。

## 1. 定位与提交

| 项 | 值 |
| --- | --- |
| 仓库 | 独立 app（`dsh-qt-app`），非 EAC |
| 工作树 | `<worktree>`＝隔离工作树（`phase3/t130-gate`） |
| 基线（父提交） | `42591fb091b57277f3bc91a084ecd3ea2bbba4e7`（t124「measure start-up, observation channel and steady state」） |
| 修复提交（头） | `89d87dc52da0988f0d3f351bd2e30a9e3e4191b6` |
| 记录提交 | 修复提交的直接子提交（本文件） |
| 是否推送 | 未推送，仅本地 |

## 2. 缺陷

改前门禁（`42591fb:.github/workflows/test.yml`，步骤 `Assert the regression really ran`）依赖四条无锚点匹配：`grep -qE '^# SKIP|skipped [1-9]'`、`grep -qE 'pass 17'`、`grep -qE 'fail 0'`、以及 `^# stages `、`^# park: ` 两条证据行。

- `pass 17` 与 `fail 0` 是子串匹配，`pass 170` / `fail 0` 附近的 `cancelled 1` 都不影响判定；
- 步骤不读 `tests`（总数）、不读 `cancelled`、不校验摘要内部自洽；
- 一个作业的 `tee` 日志里若混入两段摘要（例如重跑拼接），前一段的 17 会掩盖后一段的真实结果。

t124 supplemental evidence 已用「把该步骤脚本原样抽出、喂合成日志」的方式实测到两个假阳性（`tests 170 / pass 170 / fail 0 / cancelled 0 / skipped 0` 与 `tests 18 / pass 17 / fail 0 / cancelled 1 / skipped 0` 均 exit 0）。本次以同样方式复现，并在仓库里留下可重跑的测试。

## 3. 修改

`.github/workflows/test.yml`（同一步骤）：

1. 摘要改为**整行分词解析**：`awk` 把 `ℹ <field> <number>` 拆成字段与取值，只接受 `tests` / `pass` / `fail` / `cancelled` / `skipped` 五个字段；
2. 每个字段**必须恰好出现一次**——缺失即拒（缺字段的摘要不算证据），出现两次即拒（一次运行只报一段摘要，重复说明日志不是一次运行的产物）；
3. **自洽校验**：`pass + fail + cancelled + skipped` 必须等于 `tests`，否则拒绝并打印矛盾信息；
4. 通过自洽后强制 `tests = 17`、`pass = 17`、`fail = 0`、`cancelled = 0`、`skipped = 0`；
5. 保留 `# SKIP` 标记检查、`^# stages ` 与 `^# park: ` 两条证据行检查；
6. 运行测试的步骤保持不变，仍带 `set -o pipefail`——真实非零退出自行让作业失败，摘要检查是补充而非替代。

实现细节（踩过一次）：`ℹ` 是 U+2139 INFORMATION SOURCE，在 Unicode 中属于**字母**，所以在 UTF-8 语言环境里 `sed 's/^[^[:alnum:]]*//'` 剥不掉它，整条匹配会静默失效（门禁会对正确日志报「0 条摘要」）。改为按空白分词比较字段名后，C/POSIX 与 UTF-8 语言环境、以及 Windows Git Bash 行为一致。

`tests/gui-heartbeat-gate.test.ts`（新增）：运行时从工作流里**抽取**该步骤的 `run:` 脚本（不是复制一份），在临时目录写入合成 `gui-heartbeat.log` 后原样执行，断言退出码。抽取而非复制的关键在于被测对象是 CI 真正执行的那段文本，复制会漂移。

## 4. 红绿结果

命令（全部在共享锁 + `CPUQuota=200%` / `MemoryMax=4G` 下执行）：

```
flock -w 900 <shared-lock> systemd-run --scope -p CPUQuota=200% -p MemoryMax=4G --collect --quiet \
  bash -lc 'pnpm exec tsx --test tests/gui-heartbeat-gate.test.ts'
```

改前（同一测试，未改工作流）：

```
ℹ tests 15 / ℹ pass 9 / ℹ fail 6   exit 1
✖ a 170-case run is rejected
✖ a run with a cancelled case is rejected
✖ a summary with a missing field is rejected
✖ a summary whose counts do not add up is rejected
✖ two disagreeing summary blocks are rejected
✖ two identical summary blocks are rejected as well
```

即：两个已记录的假阳性在场，另外缺字段、计数不自洽、重复摘要三处也拦不住。

改后：

```
ℹ tests 15 / ℹ pass 15 / ℹ fail 0   exit 0
```

真实日志格式验证（不是合成件）：把 t124 实跑产出的 17 项心跳日志（含 `# stages silent: {...}`、`# park: ...` 与节点报告器摘要）交给抽取出的门禁脚本——exit 0；在其后追加一段摘要 → exit 1；把该日志的 `cancelled 0` 改成 `cancelled 1` → exit 1，报 `summary contradicts itself: tests 17, but pass 17 + fail 0 + cancelled 1 + skipped 0 = 18`。

**证据口径更正（t132）**：上段的「真实日志」是**本机默认 Node（v26.13.1）的 spec 报告器**输出——`ℹ tests 17` 前缀、`# stages` 未转义。CI 装的不是这个组合：工作流用 Node 22.19，且管道 `| tee` 让报告器走 TAP，诊断行会转义成 `# \# stages ...`（见 §8.1）。因此上段只能证明「未转义的 spec 形日志」被正确判定，**不能**作为 CI 形态的证据；CI 形态的证据在 §8.2。

合成日志的字段取值矩阵（当前门禁的判定）：

| tests | pass | fail | cancelled | skipped | 退出 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 17 | 17 | 0 | 0 | 0 | 0 | 正常通过 |
| 170 | 170 | 0 | 0 | 0 | 1 | 原假阳性 1 |
| 18 | 17 | 0 | 1 | 0 | 1 | 原假阳性 2 |
| 18 | 17 | 0 | 0 | 1 | 1 | 跳过 |
| 17 | 16 | 1 | 0 | 0 | 1 | 失败 |
| 16 | 16 | 0 | 0 | 0 | 1 | 少一项 |
| 17 | 17 | 0 | 0 | — | 1 | 缺字段 |
| 17 | 17 | 0 | 1 | 0 | 1 | 自相矛盾 |

## 5. verify

| 命令 | 结果 |
| --- | --- |
| `pnpm exec tsx --test tests/gui-heartbeat-gate.test.ts` | exit 0，15/15 通过（日志 `<log-dir>/t130-verify1.log`） |
| `git diff --check` | exit 0，无空白问题 |

改前的红阶段日志与改后的绿阶段日志分别为 `<log-dir>/t130-red.log`、`<log-dir>/t130-green.log`。

## 6. 未验证 / 边界

- **未在真实 CI runner 上运行**：Windows（`windows-2022`）与 Ubuntu 托管 runner 均未触发；本记录只有本地 Linux + 抽取脚本的合成日志证据，「远程门禁按相同 SHA 运行」仍待集成者在推送后补。
- **Windows 语法面未实测**：门禁用到的 `awk` / `wc` / `tr` 来自 Git Bash，本地只有 Linux 版实测；`shell: bash` 在 Windows 上由 Git Bash 提供，行为差异未测。
- **`cancelled` 的真实产生方式未复现**：node 报告器的 `cancelled` 计数出现在测试被中断的场景，本次只按字段语义构造输入，未制造真实取消运行的日志。
- 新增测试落在 `tests/*.test.ts` 通配范围内，因此 `pnpm test` 也会执行它，该用例依赖 `PATH` 上有 `bash`：本地 Linux 实测 `pnpm test` 536 pass / 2 skipped / 0 fail（跳过项为此前既有）；Windows 与 Windows Git Bash 下的执行未验证。
- 未触碰 EAC，未推送，未修改心跳产品代码与心跳用例本身（`tests/gui-heartbeat.e2e.ts`、`native/main.cpp` 均未变）。

## 7. 变更路径

- `.github/workflows/test.yml`
- `tests/gui-heartbeat-gate.test.ts`
- `docs/test-records/heartbeat-summary-check.md`

## 8. 第二轮修复（t132）：TAP 转义、CRLF、归档目录

上一轮复核报告（团队私有复核材料，未随本仓库提交）在 §3 的门禁上找到四处问题。本节记录修复、证据与口径。

### 8.1 F1（blocker）：TAP 转义让真实绿跑被判红

CI 用 Node 22.19 执行 `node ... --test tests/gui-heartbeat.e2e.ts 2>&1 | tee gui-heartbeat.log`。stdout 是管道、不是 TTY，Node 的 TAP 报告器因此把诊断行的前导 `#` 再转义一次：

```
# \# stages silent: {"connectedMs":434,"firstTickMs":789,...}
# \# park: 1200 ms parked, 0 GUI ticks inside the park, 24 observer ticks meanwhile
```

而门禁只认 `^# stages ` / `^# park: `，于是 `tests 17 / pass 17 / fail 0 / cancelled 0 / skipped 0` 的一次全绿运行被判红，报 `::error::gui-heartbeat.log carries no measured start-up stages`。

修法：**在门禁内归一化**，而不是把工作流钉死到 `--test-reporter=spec`。钉死报告器会让门禁与报告器选择绑在一起，换报告器就得改门禁；归一化让门禁对两种拼写都成立，报告器仍可自由选择。

```sh
normalized=$(mktemp)
trap 'rm -f "$normalized"' EXIT
tr -d '\r' < "$log" | sed 's/^# \\# /# /' > "$normalized"
```

摘要解析、`# SKIP`、`^# stages `、`^# park: ` 四处检查全部改读 `$normalized`。

踩坑：首版只把摘要解析指向归一化副本，两条 `grep` 仍读原日志，于是修复后依旧 exit 1。归一化是整段检查的前置，不是某一处的前置。

### 8.2 F2（medium）：CRLF 日志被拒

日志若经 Windows 落盘或搬运，每行尾带 `\r`，`awk` 拿到的 `$3` 是 `17\r`，任何数值比较都不成立——一次合法的绿跑被判红。修法即上面的 `tr -d '\r'`。

### 8.3 F3（medium）：归档只判 exists，目录路径丢掉整份 summary

`tests/gui-heartbeat.e2e.ts` 的 `archive()` 原先对每个通道只判 `exists` 就 `copyFileSync`。`unopenable` 用例的心跳路径本身是**目录**（存在的意义就是让 open 失败），于是 `copyFileSync` 抛 `EISDIR`，异常被最外层 catch 吞掉，`unopenable-summary.json` 根本没写——而这恰恰是最需要证据的一例。

修法：

1. 新增 `ChannelArchive` 记录 `path / exists / isFile / size / mtimeMs / readError / archived / copyError`；
2. 先 `statSync(source).isFile()` 区分普通文件与目录/特殊文件，非普通文件记 `copyError = 'skipped: the heartbeat path is not a regular file'`，不尝试 copy；
3. 目录创建是唯一的前置失败点（无目录无处写 summary），创建失败才提前返回；
4. **summary 无论 copy 成败都写**，并把两个通道的归档记录写进 summary 的 `heartbeat` / `observerChannel` 字段；
5. copy 失败在 stdout 打 `# archived <path> with no copy: <reason>`。

`unopenable` 用例新增归档断言（仅当 `DSH_QT_HB_ARTIFACT_DIR` 非空时执行）：`unopenable-summary.json` 存在、`heartbeat.exists === true`、`isFile === false`、`archived === false`、`copyError` 匹配 `/not a regular file/`、`unopenable-hb.txt` 不存在。

### 8.4 F4（low）：把本机 Node 26 spec 日志当 CI 证据

已在 §4 就地标注更正：那份日志是本机 Node v26.13.1 的 spec 输出，不是 CI 的 Node 22.19 + TAP 形态；CI 形态证据见本节 §8.5。

### 8.5 真实日志结果（Node 22.19 + tee）

环境：本机 Node **v22.19.0**（独立下载的 Node 22.19 二进制，非系统默认版本），报告器为 Node 内置 **TAP**（未显式指定，管道导致默认转义），入口 `node_modules/tsx/dist/cli.mjs --test`，`QT_QPA_PLATFORM=offscreen`，二进制取 t131 构建产物。

改前（`42591fb` 门禁 + 未改归档）：

```
# \# stages silent: {"connectedMs":434,"firstTickMs":789,"firstWindowMs":789,"firstTickElapsedMs":360,"observerBeforeFirstTick":1}
# tests 17 / # pass 17 / # fail 0 / # cancelled 0 / # skipped 0
PIPE_EXIT=0
门禁（旧）→ exit 1：::error::gui-heartbeat.log carries no measured start-up stages
日志内：# \# could not archive the samples: EISDIR: illegal operation on a directory, copyfile ...
产物目录：有 20+ 个 *-hb.txt / *-observer.txt / *-summary.json，但没有 unopenable-*
```

改后（同一份改前日志喂给新门禁 `gate-fixed.sh`）：

```
新门禁 → exit 0
旧门禁 → exit 1
CRLF 化（121 行每行补 \r）后新门禁 → exit 0；旧门禁 → exit 1
```

改后重跑整套用例（本机 Node 22.19 + tee，`DSH_QT_HB_ARTIFACT_DIR` 指向隔离工作树内的 artifact 目录）：

```
# \# stages silent: {"connectedMs":305,"firstTickMs":558,"firstWindowMs":559,"firstTickElapsedMs":265,"observerBeforeFirstTick":1}
# \# park: 1200 ms parked, 0 GUI ticks inside the park, 24 observer ticks meanwhile
# \# archived <heartbeat path> with no copy: skipped: the heartbeat path is not a regular file
# \# unopenable summary: exists=true isFile=false archived=false, copyError recorded
# tests 17 / # pass 17 / # fail 0 / # cancelled 0 / # skipped 0
PIPE_EXIT=0
新门禁 → exit 0；旧门禁 → exit 1；该日志 CRLF 化后新门禁 → exit 0
```

`fixed-hb/unopenable-summary.json` 实际内容（节选）：

```json
"heartbeat": {
  "exists": true, "isFile": false, "size": 40,
  "readError": "EISDIR: EISDIR: illegal operation on a directory, read",
  "archived": false,
  "copyError": "skipped: the heartbeat path is not a regular file"
},
"observerChannel": { "exists": true, "isFile": true, "archived": true, "copyError": null }
```

即：目录型通道留下 exists/readError/copyError 三项记录，同例的普通文件通道照常归档，summary 本身没有丢。

### 8.6 门禁自测（`tests/gui-heartbeat-gate.test.ts`）

从 15 例扩到 23 例，新增：

- **真实 TAP 输入**：用 `process.execPath --test --test-reporter=tap` 现场生成 TAP 日志（写临时 `.test.mjs` 夹具，打印两条证据行 + N 个通过用例），不用手写仿件。断言夹具确实含 `# \# stages `——若将来的 Node 不再转义，该用例会因为「证明不了什么」而失败，而不是静默变绿。
- 真实 TAP 缺 stages / 缺 park / 带 cancelled 三例仍必须被拒。
- **CRLF**：绿跑日志 CRLF 化后被接受；CRLF + cancelled 被拒；CRLF 缺 park 被拒。
- 脚本常量检查改为子串：`tr -d '\r'` 与 `sed 's/^# \\# /# /'` 必须在步骤脚本里。

踩坑：第一版用正则断言这两条常量，`sed` 的定界符与 TAP 转义自身的反斜杠要双重转义，写出的模式与被测文本并不等价，实测失败。改为 `includes` 子串后语义直白。

踩坑：`spawnSync` 起子 Node 时若不清理环境，被测子进程会继承 `NODE_TEST_CONTEXT=child-v8`（在测试运行器子进程里存在），于是它按「报告器子进程」行事、stdout 被吞，夹具一份 TAP 都不产，用例以「没有转义」的形式失败。修法是在 `env` 里删除 `NODE_TEST_CONTEXT`（同时删 `NODE_OPTIONS`）。

### 8.7 未验证 / 边界（本轮）

- **Windows 与托管 runner 仍未实际跑过**：本轮全部证据来自本地 Linux（Node 22.19 二进制 + offscreen）。`windows-2022` 上 Git Bash 的 `tr` / `sed` / `awk` 行为、以及 CRLF 日志在 Windows 上的真实产生方式，均未实测。
- **报告器版本边界**：结论基于 Node 22.19（TAP，管道下转义）与本机 Node 26.13.1（默认 spec，不转义；显式 `--test-reporter=tap` 时同样转义）。其他 Node 版本是否改变转义策略未测；门禁同时接受两种拼写，因此对该变化不敏感，但「未测」仍是事实。
- **未制造真实的 `cancelled` 运行**：仍按字段语义构造输入。
- `unopenable` 用例的归档断言只在 `DSH_QT_HB_ARTIFACT_DIR` 非空时执行；CI 里该变量由工作流注入，本地不设时该分支跳过（不产生 skip 计数，是条件块而非 skip）。
- 未修改心跳产品代码（`native/main.cpp`）与用例的 17 项判定逻辑；未推送；未触碰 EAC。

### 8.8 本轮变更路径

- `.github/workflows/test.yml`
- `tests/gui-heartbeat.e2e.ts`
- `tests/gui-heartbeat-gate.test.ts`
- `docs/test-records/heartbeat-summary-check.md`

### 8.9 过程偏差记录（attempt 3 → attempt 4）

本轮修复在 attempt 3 里已全部落地（代码提交 `3ef4d1c`，记录提交 `79331cc`），但当次提交 `completed` 时被 validator 拒绝，原因是当时的合同 inScope 未列出 `tests/gui-heartbeat-gate.test.ts`——而 Acceptance 1/2 要求新增的门禁用例（真实 TAP 输入、CRLF 绿/红）只能落在该文件；写进 `tests/gui-heartbeat.e2e.ts` 会改变该文件用例数，与该门禁强制的 `tests=17` 直接冲突。这属于合同自相矛盾，实现本身没有问题。

**偏差**：当时选择先按 acceptance 完成实现与验证，再在提交 `completed` 时才发现 inScope 缺口，导致同一份工作占用两轮 attempt。正确顺序应是动手前先比对 inScope 与 acceptance 的落点文件，发现不一致立即上报 captain 改合同，而不是先改后报。

合同随后修订（基线 `493121e`，inScope 含该四个文件），attempt 4 按修订后的合同重新取证，代码零改动。

attempt 4 重跑结果（本机 Node v22.19.0，日志写入复核日志目录）：

| 命令 | 结果 |
| --- | --- |
| `pnpm exec tsx --test tests/gui-heartbeat-gate.test.ts` | exit 0，`# tests 23 / # pass 23 / # fail 0 / # cancelled 0 / # skipped 0`（复核日志 `verify-a4.log`） |
| `git diff --check` | exit 0，无空白问题 |
| 17 例心跳套件（`node node_modules/tsx/dist/cli.mjs --test` + tee） | `# tests 17 / # pass 17 / # fail 0 / # cancelled 0 / # skipped 0`，PIPE_EXIT=0（复核日志 `heartbeat-e2e-a4.log`） |
| 新门禁对上述日志 | exit 0；旧门禁（`42591fb` 版本）exit 1 |
| `unopenable-summary.json` | `heartbeat.isFile=false / archived=false / readError=EISDIR / copyError="skipped: the heartbeat path is not a regular file"`；`observerChannel.archived=true`；目录无 `unopenable-hb.txt` |

### 8.10 版本核对口径（提交性质与可推送 SHA）

本轮修复的提交按性质分两类，不应混为一谈：

| 提交 | 性质 | 改动 |
| --- | --- | --- |
| `3ef4d1c` | **代码提交**，本轮唯一的代码改动 | `.github/workflows/test.yml`、`tests/gui-heartbeat.e2e.ts`、`tests/gui-heartbeat-gate.test.ts` |
| `79331cc` | 仅记录 | §8.1–§8.8 |
| `0a3fec51f5d7591c6d92a19daa9da5e8c2a055a1` | 仅记录 | §8.9 过程偏差记录 |

**被审版本是 `0a3fec51f5d7591c6d92a19daa9da5e8c2a055a1`**，本轮绿色结论对应它的代码树；外部复核回执即针对该 SHA。上一版记录曾把「代码零改动的重跑 HEAD」写成 `79331cc`，那是把记录提交误当代码提交——代码提交只有 `3ef4d1c`。

被测版本之后若继续修订本文件，只会产生**仅记录**的新提交，代码树不变。因此本文档刻意不写「最后一次记录提交」的 SHA 与「可推送 SHA」：写出哪一个都会随本次提交改变而立即过期，形成自引用。可推送候选的准确 SHA 由复核回执标记，回执与日志本体保存在团队私有目录，不随仓库提交。

可推送候选分支从**已发布的 `094d520`** 起，按顺序重放 `42591fb`、`89d87dc`、`493121e` 与代码提交 `3ef4d1c`（重放后 SHA 会变：`1a7ad53`、`b00fe34`、`f08b796`，代码提交对应 `caa8588`，内容与被审版本逐字节相同），再以最终版记录作为一次提交。其最终树与被审版本 `0a3fec5` 的差异**只限本文件**（`git diff --stat 0a3fec5 <候选分支头>` 只列本文件，`git diff 0a3fec5 <候选分支头> -- .github tests` 为空）。这样公开历史的祖先链里不会出现带私有路径的记录提交。

路径口径：本文档不记录隔离工作树、私有复核材料与内部构建缓存的位置，统一用「本机 Node 22.19」「隔离工作树 artifact 目录」「复核日志目录」等中性描述，日志里的临时心跳路径以 `<heartbeat path>` 占位。
