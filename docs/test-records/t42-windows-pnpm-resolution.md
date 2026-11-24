# t42 — Windows `pnpm` 解析修复（setup-pnpm `.bin` 同目录 shim）

- 任务：t42（repair）。基线：t41 已审固定提交 `bf05de86f7d07420cabb33bc2b056f4fe4123db2`
  （父 `f44cd0f`，含 `.github/workflows/test.yml` 的 job `name` 解析修复）。
- 独立工作树：`/data/qt-phase3/app/wt/gate-pnpm-fix`，分支 `phase3/gate-pnpm-fix`（未 push）。
  integration 工作树 `/data/qt-phase3/app/wt/integration` 未改动，仍停在其文档提交 `7659381`
  并保留两份他任务未跟踪记录。
- 本任务只改 `scripts/gate-lib.mjs`、`tests/gate-lib.test.ts` 与本记录；不改 workflow、产品、
  EAC、addon，不推送。

## 1. 远程症状（t38 复验）

build run `45419603208` 的 `qt build (windows-2022)` 在 `Build TypeScript`（step 7）失败：

```
[gate] spawn-error spawn C:\Users\runneradmin\setup-pnpm\node_modules\.bin\pnpm ENOENT
##[error]Process completed with exit code 1.
```

t36/t41 已让 `.cmd` 走 `%ComSpec% /d /s /c`，但真实的 setup-pnpm 目录同时存在：

```
...\setup-pnpm\node_modules\.bin\pnpm       <- 无扩展名的 POSIX shim（不可被 CreateProcess 执行）
...\setup-pnpm\node_modules\.bin\pnpm.cmd   <- 真正的 Windows 启动项
```

`candidateNames` 原先把裸名放在 PATHEXT 变体之前，`resolveExecutable` 按目录、按名字首个
`statSync(...).isFile()` 命中即返回，于是选中 `pnpm` shim；`launcherFor` 只把 `.cmd/.bat`
交给 cmd.exe，裸 shim 被直接 spawn，最终 ENOENT。根因是**候选名顺序**，不是 cmd.exe 引用
或 `windowsVerbatimArguments`。

## 2. 修复

`scripts/gate-lib.mjs` 的 `candidateNames` 对 Windows 裸命令只返回 PATHEXT 变体，按 PATHEXT
顺序（默认 `.COM;.EXE;.BAT;.CMD`）尝试，不再先返回裸名：

```js
return pathext.map((ext) => `${command}${ext.toLowerCase()}`);
```

这是 shell 的解析语义：cmd.exe 对 `pnpm` 也是按 PATHEXT 找到 `pnpm.CMD`，无扩展名 shim
本来就不是可执行映像。**不做**“先裸名、失败再变体”的回退，因为没有变体时直接 spawn 仍会
ENOENT；解析失败（gate exit 127）比一次注定失败的 spawn 更诚实。`.cmd/.bat` 仍走
`cmd.exe /d /s /c` + 逐参数引用 + `windowsVerbatimArguments: true`；`.exe`/POSIX 仍直接
spawn，没有无条件 `shell: true`。显式带路径/扩展名的命令仍原样使用。

## 3. 先红后绿

新增 `tests/gate-lib.test.ts` 两例：

1. `Windows resolution prefers pnpm.cmd over the extensionless setup-pnpm shim`：同一目录
   放入 `pnpm`、`pnpm.cmd`、`pnpm.ps1`，`platform: 'win32'`，断言解析到 `pnpm.cmd`；
   并断言 `launcherFor` 的文件为 `ComSpec`、前三个参数 `/d /s /c`、verbatim 命令行
   `""<dir>/pnpm.cmd" "build" "a b""`、`windowsVerbatimArguments === true`。
2. `Windows resolution returns null when only an extensionless shim exists`：只有 shim 时
   解析为 `null`（交给 gate 记为 127，而不是 spawn 一个不可执行的 shim）。

测试在 Linux 上以 `/` 路径模拟 runner 的 `.bin` 同目录布局，`platform` 仍是 `win32`；
本机没有 Windows，真实 `cmd.exe` 启动只能由远程 Windows job 验证。

红（修复前实现，用 `git show bf05de8:scripts/gate-lib.mjs` 重建到 /tmp 后跑当前测试）：

```
$ pnpm exec tsx --test tests/gate-lib.test.ts
ℹ tests 8 / pass 5 / fail 3
actual:   '/tmp/setup-pnpm/node_modules/.bin/pnpm'
expected: '/tmp/setup-pnpm/node_modules/.bin/pnpm.cmd'
actual:   '/tmp/setup-pnpm/node_modules/.bin/pnpm'
expected: null
actual:   [ 'pnpm', 'pnpm.com', 'pnpm.exe', 'pnpm.bat', 'pnpm.cmd' ]
expected: [ 'pnpm.com', 'pnpm.exe', 'pnpm.bat', 'pnpm.cmd' ]
```

日志：`/data/qt-phase3/logs/t42-red-before-fix.log`（exit 1）。第三例是 `candidateNames`
的顺序断言，同样在修复前失败。

绿（修复后）：

```
$ node --test tests/gate-lib.test.ts
ℹ tests 8 / pass 8 / fail 0 / skipped 0
```

## 4. 验证（共享锁 + 资源限制）

全部在 `flock -w 900 /data/qt-phase3/logs/verify.lock` +
`systemd-run --scope -p CPUQuota=200% -p MemoryMax=4G` 内串行执行：

| 命令 | 退出码 | 结果 / 日志 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 无输出；`logs/t42-typecheck.log` |
| `pnpm test` | 0 | 499 tests，497 pass，2 skipped，0 fail；`logs/t42-test.log` |
| `node --test tests/gate.test.ts tests/gate-lib.test.ts` | 0 | 14/14 pass（gate 6 + lib 8）；`logs/t42-gate-tests.log` |
| `git diff --check` | 0 | 无空白错误；`logs/t42-diff-check.log` |

`gate.test.ts` 覆盖 POSIX 正常路径与真实子进程：退出码 0/7 原样透传、无命令 2、
空格/引号/反斜杠/空参数逐字到达、缺命令 127、SIGTERM → 143。没有放宽这些断言。
2 个 skipped 是 `tests/webui-default-off.test.ts` 中需要固定版本真实 DSH 宿主的用例
（本工作树未提供 `DSH_HOST_ROOT`），与 gate 无关；它们由独立 `webui-real-host` job
在具备宿主时执行并断言 `skipped 0`。

## 5. 边界与未验证

- **Windows 真实启动未在本机执行**：本机是 Linux；测试验证的是 `win32` 分支的解析与
  启动计划（cmd.exe 参数、引用、verbatim）。真实 `cmd.exe` 执行、Windows PATH 大小写、
  以及 runner 的 `PATHEXT` 实际值，仍需远程 `qt build (windows-2022)` 复验。
- 测试用 `/` 模拟 Windows 目录；产品在 Windows 上走 `path.win32.join`（Node 平台原生），
  候选名顺序与平台无关。
- 无扩展名 Windows 可执行文件（如有）不再被裸命令解析命中；这是有意的安全/诚实边界，
  显式带路径的调用不受影响。
- 代码修复固定提交：`4b5144ffb3f1aa1bb83fd8517e587fba30a57574`（父 `bf05de86f7d07420cabb33bc2b056f4fe4123db2`，2 文件 +47/-3）。本记录是紧随其后的独立文档提交，最终候选 HEAD 以交付报告为准。
- 未推送；远程 `dev/phase3-i9` 仍是 `f44cd0f`。
