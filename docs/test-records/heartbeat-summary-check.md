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
