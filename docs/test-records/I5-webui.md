# I5 按需 WebUI 测试记录（真实命令、退出码与失败史）

工作树：`/data/qt-phase3/app/wt/web-fallback`（branch `phase3/web-fallback`，基线 `33e516c`，
已合入 `1beba7d` I1b/I1c，HEAD `09b5d4e`）。
环境：Linux，node v26.13.1，Qt 6.8.2，宿主安装版 `@deepseek-ai/dsh` 0.2.2-rc.1
（`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules`）。
共享预算：所有重型命令经
`flock /data/qt-phase3/logs/verify.lock systemd-run --scope -q -p CPUQuota=200% -p MemoryMax=4G -- …`。

## 1. 最终命令与结果

| # | 命令 | exit | 证据 |
|---|---|---|---|
| 1 | `pnpm exec tsx --test tests/webui-service.test.ts tests/webui-default-off.test.ts` | 0 | tests 16 / pass 16 / fail 0，duration 3160 ms（`/tmp/i5-verify1.log`） |
| 2 | `pnpm typecheck`（`tsc -p tsconfig.test.json`） | 0 | 无诊断（`/tmp/i5-verify2.log`） |
| 3 | `qmllint qml/views/WebFallbackPanel.qml`（Qt 6.8.2） | 0 | 无告警 |
| 4 | `g++ -fsyntax-only -std=c++20 -DDSH_QT_HAS_WEBENGINE=0 $(pkg-config --cflags Qt6Core Qt6Quick Qt6Qml) native/webview_host.cc` | 0 | 无 WebEngine 分支编译通过 |

**默认无监听是实测的，不是 mock**：`tests/webui-default-off.test.ts` 用
`/proc/net/tcp{,6}` 的 `state=0A` → `port→inode`，再与 `/proc/<pid>/fd` 的
`socket:[inode]` 求交集，得到「该 pid 真实持有的 LISTEN 端口」；子进程用
`/proc/*/stat` 的 PPid 认定。端口号本身不参与判定，所以「换个端口也算通过」这种作弊不成立。

## 2. 验收点 ↔ 用例

| 验收点 | 用例 | 实测结论 |
|---|---|---|
| ①默认无 Web 监听、按需生命周期不碰外部进程 | `default off: mounting the fallback binds nothing and spawns nothing` | 挂载后 `state=Idle`、无端口增量、无子进程、300 ms 内零状态事件（309 ms） |
| ①（同上）关闭即释放 | `open() binds one loopback listener in this process; close() releases it` | 新增端口恰为 `origin` 端口；`close()` 后端口快照回到基线、请求被拒（681 ms） |
| ①（同上）外部服务不被误杀 | `the child fallback owns only its own process and leaves other listeners alone` | 外部 `createServer` 全程存活并返回 `external`；本进程端口集始终等于基线；`SIGKILL` 子进程后仅自己翻 `Failed{crashed}`（3 645 ms） |
| ②同进程挂载复用 credentials、失败可第二进程兜底 | `auto mode falls back to a child process after two in-process failures`、`open walks Idle → … → Ready`、`repeated open reuses the single listener…` | 同进程两次失败后落 `child` 且带 `SHARED_SESSION_NOTICE`；重复 `open` 复用同一监听、`reused:true` |
| ②第二进程会话不共享必须可见 | 同上 + `qml/views/WebFallbackPanel.qml` 的 `webFallbackNotice` | `status.notice === SHARED_SESSION_NOTICE`，`sharedSession:false` |
| ③token 不进 QML 可读信号或日志 | `the token leaves the process exactly once, through takeAuthenticatedUrl`、`webui.* over the wire…` | `status`/`statuses`/日志无原始 token；`webui.open`/`webui.close` 帧无 token；`webui.token` 只成功一次，第二次 `authenticatedUrl:null` |
| ③信任认证保留 | `open()…`、`probe recognises the official auth challenge and the /api fence` | 无 cookie `GET /` → 401 且 body 为官方提示；`/api/remote.mux` 401；带 `sec-fetch-site: cross-site` → 403；认证后 303 + `dsh-auth-…` cookie + `no-referrer`/`no-store`；带 cookie `GET /` → 200 且含 `<base href="./">` |
| 失败语义 | `open fails with Failed{timeout} when every attempt times out`、`a dead child flips the state to Failed…`、`probe reports an unreachable listener as refused` | `Failed{timeout, attempts:3}`、`Failed{crashed}`、`probe → {reachable:false, reason:'refused'}` |

## 3. 失败史（都是真实缺陷，先失败后修复）

1. **就绪行误判**：`parseAnnouncement()` 原本只看前缀 `dsh web: `，于是
   `dsh web: opening the default browser; pass --no-open to disable` 会被当成「就绪」。
   改为必须能被 `new URL()` 解析且协议为 `http:`/`https:`。这条直接对应 t5 §0 的
   设计稿纠偏（原稿正则 `/Server listening on (.+)/` 永不命中）。
2. **`failureReasonOf()` 退化**：测试 fake 抛普通 `Error` 时，`WebuiError` 判定失败，
   原因码被兜底成 `spawn-failed`，掩盖了真实原因。fake 改为 `extends WebuiError`；
   这也证明该函数对第三方后端抛错是保守的（不会误报成功）。
3. **断言自相矛盾**：「所有帧都不含 token」与 `webui.token` 回复必然含 token 冲突。
   改为排除该 res 帧后断言全流无 token——正是这条断言保证了 token 只走一次性通道。
4. **PATH 只取首个命中（本次最严重）**：`hostRootCandidates()` 原先用
   `findOnPath()` 返回**第一个**含 `dsh` 的目录。直接跑时 `/usr/local/bin` 先命中，
   一切正常；放进 `systemd-run --scope` 后 PATH 顺序变化，先命中的是 pnpm 的 `dsh`
   shim（`/root/.local/share/pnpm/bin`），其推导根里没有 `@deepseek-ai/dsh`，于是
   `defaultHostRoot()` 返回 `null`，同进程后端直接 `unavailable`
   ——`tests/webui-default-off.test.ts:165` 由通过变失败（fail 1 / pass 15）。
   修复：`findAllOnPath()` 收集**全部**命中目录，逐个推导候选根。修复后同一作用域下
   16/16 通过。
5. **类型检查（tsconfig.test.json 覆盖 tests/）**：`WebuiBackendStartOptions.slotId`
   为必填但 `in-process.ts` 未传 → 改为可选；`replyTo()` 返回 `ResFrame` 联合类型，
   直接读 `.result` 报 TS2339 → 用 `assert.fail()`（返回 `never`）收窄为 `ResOkFrame`。

## 4. 未验证（不得据此声称已完成）

| 项 | 原因 |
|---|---|
| `DSH_QT_HAS_WEBENGINE=1` 分支的真实编译与运行 | 本机无 QtWebEngine 开发包；只做了 `=0` 分支的 `-fsyntax-only` |
| CMake 接线、`native/main.cpp` 事件转发、`src/index.ts` 挂载 | 这三个文件归 host-integration 任务（单写），已写在 `docs/handoff/I5-webui.md` |
| `webui.state` 事件 → QML 面板的端到端联动 | 需要 `main.cpp` 转发 `evt`；当前 `handleEvent_()` 只处理 `theme.reload` |
| Windows 打包依赖与 `%APPDATA%` 路径 | 本机为 Linux；`findAllOnPath()` 的 `;`/`dsh.cmd` 分支只做了代码路径覆盖，未实跑 |
| WebEngine 内存测量（G0/G1/G2） | 需先有 `HAS_WEBENGINE=1` 构建，属打包任务 |
