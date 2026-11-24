# t36 repair round 2 — 远程 CI 六项发现

- 基线：`2cc080757ac497577aae88ed09f97fd2e0fd9221`（t34 交付）+ `edac359b70d7a47f7012a4dbd1c31d29b0435de7`（t29 CI 记录）。
- 分支：`phase3/integration`（未推送；审查后由后续任务推送触发远程 CI）。
- 远程失败来源：t29 在 `dev/phase3-i9` 推送 `2cc0807` 后的 test run
  [45408926248](https://github.com/lbn2011/dsh-qt-app/actions/runs/45408926248)（failure）与
  build run [45408926079](https://github.com/lbn2011/dsh-qt-app/actions/runs/45408926079)（cancelled）。
- 本文件只记录本机证据；远程复验必须等独立审查放行后重跑，不能据本文件声称 CI 已绿。

## 1. 六项发现与修复

### T29-1 packaging 归档断言截断 tar（high）

- 现象：`packaging (ubuntu-22.04)` 在 `Assert archive ships LICENSE + notices + SHA-256`
  退出 2，`tar: stdout: write error`。
- 根因：`root=$(tar -tzf "$archive" | head -1 | cut -d/ -f1)` 让 `head` 先关管道；
  `set -o pipefail` 下 tar 的 SIGPIPE 变成真实失败。归档本身健康、`sha256sum -c` 已 OK。
- 修复：新增 `scripts/check-archive.sh`（755）：先校验同名 `.sha256`，再把完整 listing
  落到临时文件（`tar -tzf > listing`，不截断、不 `|| true`），用 `sed` 取根目录并 grep
  `LICENSE`/`THIRD-PARTY-NOTICES.md`；缺失时打印前 20 行并 exit 1，参数错误 exit 2。
  `.github/workflows/test.yml` 的 packaging 步骤改为 `mapfile` 选唯一归档并调用该脚本。
- 回归：`tests/archive.test.ts` 4 例（真实 tar.gz + 校验和通过；缺 notices 失败；
  坏校验和失败；无参数 exit 2）。

### T29-2 gate 在 Windows 无法启动 pnpm（high）

- 现象：`node scripts/gate.mjs -- pnpm build/typecheck/package` 在 windows-2022 报
  `[gate] spawn-error spawn pnpm ENOENT`、`[gate] exit=127`；typescript (windows) 与
  qt build (windows) 均因此失败。
- 根因：`scripts/gate.mjs` 直接 `spawn(command[0], …)`；Windows 的 pnpm 是 `pnpm.cmd`，
  `CreateProcess` 不能直接执行。
- 修复：新增 `scripts/gate-lib.mjs`（纯函数）：
  `resolveExecutable` 按 `PATH`+`PATHEXT` 解析（`pnpm` → `pnpm.CMD`）；
  `launcherFor` 仅对 `.cmd`/`.bat` 用 `%ComSpec% /d /s /c` + `windowsVerbatimArguments`，
  `.exe`/POSIX 直接 spawn（没有无条件 `shell: true`）；`quoteForCmd` 按
  CommandLineToArgvW 规则引用参数；`signalExitCode` 映射 128+n。`gate.mjs` 保留
  子进程退出码、ENOENT 127、以及新增 `[gate] signal=…`。
- 回归：`tests/gate.test.ts` 6 例（0/7 透传、无命令 2、空格/引号/反斜杠参数逐字到达、
  ENOENT→127、SIGTERM→143）；`tests/gate-lib.test.ts` 6 例覆盖 Windows 解析/引用/launcher
  的纯逻辑（Linux 上也能跑）。Windows 真实执行留给远程 CI，本机不能替代。

### T29-3 WebEngine CI 缺 qtwebchannel（high）

- 现象：qt webengine job 的 configure 输出
  `DSH_QT_WEBENGINE=ON but Qt6::WebEngineQuick is not installed — embedding disabled`，
  断言失败；CMake 没有编到 `DSH_QT_HAS_WEBENGINE=1`。
- 根因：`find_package(Qt6 QUIET OPTIONAL_COMPONENTS WebEngineQuick)` 吞掉了依赖错误。
  aqt 只安装了 `qtwebengine` 一个模块；WebEngineQuick 的 CMake 依赖包含
  `Qt6::WebChannelQuick`（本机 Qt 6.8
  `Qt6WebEngineQuickTargets.cmake:75` 的 `INTERFACE_LINK_LIBRARIES` 可证），而
  `qtwebchannel` 是独立模块归档，`modules: qtwebengine` 不会带进来。
- 修复：CI 改为 `modules: qtwebengine qtwebchannel`；`CMakeLists.txt` 的 else 分支打印
  `Qt6_DIR`，并在 `NOT TARGET Qt6::WebChannelQuick` 时明确提示安装 qtwebchannel。
  仍保留 OFF 降级与 ON 构建的 compile-time 断言。
- 边界：本机 Qt 6.8.2 已带 WebEngine，无法复现“缺模块”的 CI 组合；该修复的远程验证
  必须由审查后的 CI 首跑确认（t34 的 ON 本机构建与真实 Chromium e2e 仍是既有证据）。

### T29-4 Qt 6.7.3 qmllint 以 warning 返回 255（high）

- 现象：`qml-lint` 的 `find … | xargs qmllint` 以 `qmllint: exited with status 255`
  中止，step exit 124；同一棵树在 Qt 6.8.2 下 exit 0。
- 诊断：用 aqt 安装 Qt 6.7.3（`/data/qt-phase3/qt673`，qtbase/qtdeclarative/icu）逐文件复跑：
  只有含 warning 的文件返回 255，仅 Info 的文件返回 0；一次跑完全部 54 个文件后返回 255
  且停在 GeneratedView，**不是崩溃、也不是单个文件 fatal**。即 Qt 6.7.3 把 warning 当失败
  （6.8 起返回 0）。
- 逐条 warning 与修复（均按语义修，不全局关闭）：
  - `qml/views/ChatView.qml:320` `theme.spacingSmall` → `theme.spacing`（Theme 没有
    spacingSmall）；`toolModel` 由 `ListModel` 改为 `var`（实际类型是带 `watermark` 的
    ToolCallModel）；delegate 声明 `required property int index`。
  - `qml/components/GeneratedView.qml`：`pragma ComponentBehavior: Bound` 移到文件级；
    Loader 高度改用 `treeLoader.implicitHeight`；`treeLoader.item.action` 是动态加载的
    GeneratedNode 信号，Loader.item 静态类型仅为 QObject，用**局部**
    `// qmllint disable missing-property` / `enable` 包裹并写明原因。
  - `qml/components/GeneratedNode.qml`：文件级 `pragma ComponentBehavior: Bound`（消除
    7 处 unqualified）；两个 Loader 的 `item.implicitHeight` 改为
    `childLoader.implicitHeight` / `rowChild.implicitHeight`（Loader 会转发被加载项的
    implicit size）。
- 验证：`LD_LIBRARY_PATH=… /data/qt-phase3/qt673/6.7.3/gcc_64/bin/qmllint $(find qml -name '*.qml')`
  → `ALL_RC=0`，0 warning / 0 error（日志 `logs/t36-lint673.log`）。没有整文件或整目录
  关闭 lint，也没有吞退出码。

### T29-5 单元套件依赖开发机全局 DSH / 绝对断言 / 失败后挂起（high）

- 现象：CI 的 `typescript (ubuntu)` 与 `napi integration` 在 467–469 失败后无输出约 20 分钟，
  最后被 job 20 分钟超时取消。
- 根因三项：
  1. 467 用绝对 `childPidsOf(process.pid) === []`，CI runner 自带子进程时报假失败；
  2. 468/469 需要本机安装的官方 DSH 与 `dsh` 可执行文件，CI 没有；
  3. 断言失败时跳过 `close()/dispose()`，遗留句柄/子进程让测试进程不退出。
- 修复：
  - 467 改为“打开前后子进程集合相等”的基线比较（仍验证 mount 不新增进程/端口）；
  - 468/469 用 `defaultHostRoot()` 判断宿主，没有时**显式 skip** 并给出准备方式，不再
    伪装成通过；`DSH_REQUIRE_REAL_HOST=1` 时缺宿主直接抛错（供真实宿主门使用）；
  - 两个宿主测试整体包进 `try/finally`，失败也执行 `close()`+`dispose()`，463 的外部
    listener 也关闭；
  - `package.json` 的 test 脚本加 `--test-timeout=120000`，单个测试挂起最多 2 分钟而不是
    吃满 job 超时；
  - 新增独立 CI job `webui-real-host`：`npm install --prefix "$RUNNER_TEMP/dsh-host"
    @deepseek-ai/dsh@0.2.2-rc.1`，设 `DSH_HOST_ROOT`+`DSH_REQUIRE_REAL_HOST=1`，跑
    `tests/webui-default-off.test.ts`，并断言摘要为 `skipped 0`。真实宿主测试没被删，
    只是移到显式准备固定版本的独立门。
- 本机证据：`pnpm test` 497/497、skipped 0（`logs/t36-test.log`）；`webui-default-off`
  3/3 在本机（有 DSH 0.2.2-rc.1）实跑。

### T29-6 build run 总体 cancelled（medium，未证实）

- 证据（GitHub API，run 45408926079）：`conclusion=cancelled`，`run_attempt=1`，
  `created_at=13:58:12Z`，`updated_at=14:01:34Z`；jobs：
  napi ubuntu 13:58:15–13:58:45 success，napi windows 13:58:15–14:00:05 success，
  qt build macos 14:00:06–14:00:07 **cancelled（1 秒、无 step）**，
  qt build ubuntu 14:00:08–14:01:33 success，qt build windows 14:00:08–14:00:44 failure。
- 排除：同一 SHA 只有这一个 build run（无 run_attempt 2），`dev/phase3-i9` 的
  `ls-remote` 仍是 `2cc0807`，因此不是 concurrency cancel-in-progress 造成的新 run 覆盖。
- 结论：macOS job 在启动 1 秒内被取消（与仓库已知的 macOS runner 不可用一致）；run 级
  `cancelled` 的具体触发者 GitHub API 不暴露，**明确记为未知**。复验方式：审查后重跑
  同一 workflow，若 macOS 仍取消而 Ubuntu/Windows 正常，则 run 级结论以非 macOS job 为准
  单独记录；若再次整体 cancelled，再查 runner 配额/组织策略。

## 2. 本机验证（flock verify.lock + systemd-run CPUQuota=200% MemoryMax=4G）

| 命令 | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- |
| `pnpm typecheck` | 0 | tsc 无输出 | `logs/t36-typecheck.log` |
| `pnpm test` | 0 | 497 passed / 0 failed / 0 skipped | `logs/t36-test.log` |
| `pnpm build` | 0 | tsc 无输出 | `logs/t36-build.log` |
| `cmake -S . -B build -DDSH_QT_WEBENGINE=OFF` | 0 | configure 成功 | `logs/t36-configure.log` |
| `cmake --build build` | 0 | 链接 `build/dsh-qt-app` | `logs/t36-cmake-build.log` |
| `cmake --build build --target qml-tests` | 0 | 229 passed / 0 failed | `logs/t36-qml-tests.log` |
| Qt 6.7.3 `qmllint $(find qml -name '*.qml')` | 0 | 0 warning / 0 error | `logs/t36-lint673.log` |

## 3. 失败史（本轮真实踩过）

1. 先假设 qmllint 6.7.3 在某个文件崩溃；逐文件复跑后推翻——warning 即 255，输出停在
   GeneratedView 只是最后一条。差点用“跳过 lint”掩盖，改为逐条修 warning。
2. `tests/gate-lib.test.ts` 首跑 typecheck 失败（`.mjs` 无声明）→ 增加
   `scripts/gate-lib.d.mts` 类型声明，保留纯 ESM 运行。
3. `webui-default-off` 的 child 测试仍假设“恰好 1 个子进程”；本机实际有 2 个（runner/工具
   进程）→ 改为“相对基线的**新增**子进程恰好 1 个”，并等待该 pid 退出。
4. 首次给 468 包 `try/finally` 时脚本缩进错误但语法仍通过，靠实跑发现并修正；最终
   3/3 通过。

## 4. 边界（不扩大结论）

- 本文件所有结果均为 Linux 本机；Windows 的 gate `.cmd` 真实路径、WebEngine CI 的
  qtwebchannel 组合、macOS 取消原因都要等远程 CI 首跑确认。
- 未推送任何提交；远程 CI 仍是 t29 的失败基线。
- 没有修改官方 DSH、EAC、addon 或生产默认浏览器配置；`native/` 与
  `THIRD-PARTY-NOTICES.md` 不在本轮范围。
