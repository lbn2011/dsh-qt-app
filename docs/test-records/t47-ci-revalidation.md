# t47 远程 CI 复验：候选 55a0e9d（FAILED）

## 1. 身份与推送

| 项 | 值 |
| --- | --- |
| 仓库根 | `/data/qt-phase3/app/wt/ci-hosted-fix` |
| origin | `https://github.com/lbn2011/dsh-qt-app.git` |
| 分支 | `phase3/ci-hosted-fix` |
| 候选 SHA（被测） | `55a0e9d2d36178fab6dd29d8199426ce1cc91463` |
| 父提交 | `78d9d84748af5b0b7bf9318a1342499766ed215e` |
| 目标远端 | `refs/heads/dev/phase3-i9` |
| 推送 | `git push origin 55a0e9d2…:refs/heads/dev/phase3-i9`，非 force，`78d9d84..55a0e9d`，exit 0 |
| 推送后远端 | `55a0e9d2d36178fab6dd29d8199426ce1cc91463`（`git ls-remote` 复核） |
| addon 锁 | `87084a6901297a4fe9af997d4b8cdf9d829b0f67`（CI env `NAPI_SHA` 实读一致） |
| 独立审查 | t46 review pass，START=END=55a0e9d，8 文件 +420/-17 |

推送日志：`/data/qt-phase3/logs/t47-push.log`。本次只推送 app 独立仓；未推送 EAC，未发布/部署。

## 2. 远程运行结果

| 运行 | ID | 创建 | 完成 | conclusion |
| --- | --- | --- | --- | --- |
| test | `45428635227` | 2026-11-24T15:42:35Z | 2026-11-24T15:45:43Z | **cancelled** |
| build | `45428635641` | 2026-11-24T15:42:35Z | 2026-11-24T15:46:22Z | **cancelled** |

运行链接：

- test: https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635227
- build: https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635641

两个 run 的 `conclusion=cancelled` 均只因 macOS job 在启动时被取消（无步骤执行）。
GitHub 只要存在 cancelled job，run 级结论即为 cancelled；这不是人工取消，也不是
`fail-fast`（两处 matrix 均为 `fail-fast: false`）。

### 2.1 test run jobs

| job | ID | 结论 | 链接 |
| --- | --- | --- | --- |
| typescript (ubuntu-22.04) | 138567465453 | success | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635227/job/138567465453 |
| typescript (windows-2022) | 138567465428 | **failure** | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635227/job/138567465428 |
| typescript (macos-14) | 138567465297 | cancelled | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635227/job/138567465297 |
| napi (ubuntu-22.04) | 138567465614 | success | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635227/job/138567465614 |
| napi (windows-2022) | 138567465603 | success | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635227/job/138567465603 |
| napi integration | 138568699263 | success | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635227/job/138568699263 |
| qml tests | 138567465482 | success | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635227/job/138567465482 |
| qml lint | 138567465514 | success | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635227/job/138567465514 |
| packaging (ubuntu-22.04) | 138567465457 | success | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635227/job/138567465457 |
| packaging (windows-2022) | 138567465783 | success | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635227/job/138567465783 |
| webui real host (pinned dsh host) | 138567465547 | success | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635227/job/138567465547 |
| qt webengine (ubuntu-22.04) | 138567465006 | **failure** | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635227/job/138567465006 |

### 2.2 build run jobs

| job | ID | 结论 | 链接 |
| --- | --- | --- | --- |
| napi (ubuntu-22.04) | 138567465311 | success | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635641/job/138567465311 |
| napi (windows-2022) | 138567465836 | success | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635641/job/138567465836 |
| qt build (ubuntu-22.04) | 138568477787 | success | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635641/job/138568477787 |
| qt build (windows-2022) | 138568476836 | success | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635641/job/138568476836 |
| qt build (macos-14) | 138568476647 | cancelled | https://github.com/lbn2011/dsh-qt-app/actions/runs/45428635641/job/138568476647 |

## 3. 失败详情

### T47-1 Windows TypeScript 单测仍 1 红（blocker）

`typescript (windows-2022)`：Typecheck exit 0；Unit tests exit 1。

TAP 摘要（job 日志 `/data/qt-phase3/logs/t47-job-138567465428.log`）：

```
# tests 500
# pass 493
# fail 1
# cancelled 0
# skipped 6
```

唯一失败：

```
not ok 201 - a checksum that does not describe the archive is rejected
location: 'D:\a\dsh-qt-app\dsh-qt-app\tests\packaging.test.ts:153:1'
error: The input did not match the regular expression
  /SHA-256 does not describe the archive bytes/u
  AssertionError [ERR_ASSERTION]: checksum file names a different archive
  + 'bad.tar.gz'
  - 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\dsh-qt-badsum-XousvQ\\bad.tar.gz'
```

根因：`tests/packaging.test.ts:88` 用 `archive.split('/').pop()` 取 basename；Windows
路径用 `\`，`split('/')` 得到整条绝对路径，与 sha 文件里的 `bad.tar.gz` 不等，测试在
进入“哈希不匹配”断言前就抛 `checksum file names a different archive`。不是产物哈希
计算错误；Linux 同测试通过。修复需使用 `path.basename(archive)` 或平台无关拆分，属新
修复复审范围。

`cancelled: 0` 说明 t45 的请求超时 timer 修复在 Windows 同样生效；Ubuntu 同套件
`500 tests / 496 pass / 0 fail / 0 cancelled / 4 skipped`（`/data/qt-phase3/logs/t47-typescript-ubuntu.log`）。

### T47-2 qt-webengine job 在构建前断言二进制（blocker）

`qt webengine (ubuntu-22.04)` 步骤顺序：

1. `Assert the WebEngine CMake packages are installed`：通过（`qtwebengine qtwebchannel
   qtpositioning` 均已安装，`$QT_ROOT_DIR/lib/cmake/{Qt6WebEngineQuick,Qt6WebChannelQuick,
   Qt6Positioning}` 存在）。
2. `Configure with WebEngine ON`：配置成功，日志明确
   `-- dsh-qt-app: Qt WebEngine embedding enabled`。
3. `Assert the WebEngine branch is compiled in`：
   - `grep 'Qt WebEngine embedding enabled'` 通过；
   - `grep -R -- '-DDSH_QT_HAS_WEBENGINE=1' build-webengine/CMakeFiles/dsh-qt-app.dir/flags.make`
     通过（实测 `CXX_DEFINES = -DDSH_QT_HAS_WEBENGINE=1 ...`）；
   - 最后一行 `test -x build-webengine/dsh-qt-app` **失败**，因为此时只 configure、
     尚未编译，二进制还不存在。job 以 exit 1 结束。
4. 其后的 `Build`、`Install Chrome`、`Real Chromium auth load/close and external
   browser e2e` 均未执行；`webengine-e2e` artifact 只有 `configure-webengine.log`。

根因：`.github/workflows/test.yml` 的 `Assert the WebEngine branch is compiled in` 步骤位于
`Build` 之前，却检查 `build-webengine/dsh-qt-app` 可执行文件；步骤顺序与断言内容矛盾。
该问题不是产品构建失败——Windows 与 Ubuntu 的 `qt build` job 均 success，Linux job 的
CMake 配置也确认 WebEngine enabled。修复应把二进制/编译期断言移到 Build 之后，或拆成
configure 后断言 + build 后断言。

### T47-3 macOS 未验证（不计绿）

`typescript (macos-14)` 与 `qt build (macos-14)` 均在开始后 1 秒内 cancelled，未执行
任何步骤。仓库无 macOS runner 可用证据；本记录不把 macOS 计入通过。

## 4. 通过项与产物校验

- Ubuntu TypeScript：`500 tests / 496 pass / 0 fail / 0 cancelled / 4 skipped`，typecheck/test exit 0。
- NAPI：Linux/Windows build 与 integration 均 success；
  `napi-prebuild-Linux-X64`、`napi-prebuild-Windows-X64` 已上传。
- qml tests：`Totals: 229 passed, 0 failed, 0 skipped, 0 blacklisted, 859ms`
  （artifact `qmltest-log`）。
- qml lint：Qt 6.7.3 `qmllint`，job success。
- 真实宿主门：artifact `webui-real-host-log` 的 TAP 为 `1..3`，`# pass 3 / # fail 0 /
  # cancelled 0 / # skipped 0`；三条测试（default off 无监听、单 loopback listener、
  child fallback 隔离）全 ok。t45 的 pipeline/断言修复在远程生效。
- packaging 两平台 success。产物 SHA-256（对上传后的实际文件计算）：

| 文件 | SHA-256 |
| --- | --- |
| `dsh-qt-app-0.1.0-Linux-x86_64.tar.gz` | `66738c0676ad28ac4dc8fd3f8f9675eb8369d51d413f047c05f8104fd5564558` |
| `dsh-qt-app-0.1.0-Linux-x86_64.zip` | `1acda7a10c6bdb7d490f84b7a89a00b309587a4a0908c7c7f84e1216be302355` |
| `dsh-qt-app-0.1.0-Windows-AMD64.zip` | `3846988ced94f8a97d459fdd0a0eff49a0c3355de0f42e8651810dc46e8eb103` |
| `dsh-qt-app-0.1.0-Windows-AMD64.exe` | `dc8d4d6054d81f429ed5613b82b194b49f995d441a6f4bbbb0c797ce6b074e66` |

`sha256sum -c *.sha256` 在各自目录内四个文件全部 OK。`scripts/check-archive.sh` 对 Linux
TGZ exit 0，输出 `carries LICENSE and THIRD-PARTY-NOTICES.md`；Windows ZIP 根目录含
`bin/dsh-qt-app.exe`、`LICENSE`、`THIRD-PARTY-NOTICES.md`。Linux ZIP 与 Windows NSIS
`.exe` 的根内容已由 packaging 测试覆盖；`check-archive.sh` 只接受 `.tar.gz`，对 `.zip`
按用法拒绝（exit 2），不是失败。

## 5. 验收对照

| 验收项 | 结论 | 依据 |
| --- | --- | --- |
| ① 全部门通过 | **failed** | Windows TS 1 红；qt-webengine 在 build 前断言二进制失败；macOS cancelled |
| ② 产物哈希与许可 | 部分满足 | 四个产物 SHA-256 与 `sha256sum -c` 通过，归档含 LICENSE/NOTICES；WebEngine 真实 Chromium e2e 未执行，无浏览器证据 |
| ③ 失败史/固定 SHA/EAC 隔离 | passed | 本记录绑定 55a0e9d；失败 job 链接与日志路径完整；未推送 EAC、未改产品 |

结论：**FAILED**。远程 Windows/Linux 的构建、NAPI、QML、lint、packaging、真实宿主均已
转绿，但 Windows 单测仍有 1 个平台路径断言失败，WebEngine job 的步骤顺序使其在编译前
检查二进制，真实 Chromium 加载/关闭未运行。需新修复复审后再推送复验。

## 6. 复验方法

1. 固定本次被测 SHA：`git rev-parse HEAD` 应为 `55a0e9d2d36178fab6dd29d8199426ce1cc91463`。
2. 查看 runs：`gh run view 45428635227 --repo lbn2011/dsh-qt-app --json jobs` 与
   `45428635641` 同命令。
3. 失败日志：
   - Windows TS：`gh api /repos/lbn2011/dsh-qt-app/actions/jobs/138567465428/logs`
   - WebEngine：`gh api /repos/lbn2011/dsh-qt-app/actions/jobs/138567465006/logs`
4. 产物：`gh run download 45428635227 --repo lbn2011/dsh-qt-app --dir /tmp/t47-art`，
   再在各包目录执行 `sha256sum -c *.sha256`；Linux TGZ 另跑
   `scripts/check-archive.sh <tgz>`。
5. macOS job 无步骤执行；任何后续 run 若仍 cancelled，继续按未验证记录。

## 7. 失败史接续

- t44：候选 78d9d84，test/build 均 cancelled，5 红（Windows/Ubuntu TS、napi integration、
  qt webengine、webui real-host 误报）；packaging/QML/lint/NAPI 与两平台 Qt build 绿。
- t45：候选 55a0e9d，修复请求超时 timer、real-host 断言、qtpositioning 依赖、Windows
  路径可移植性；本地 Node 22/26 全量 500/498/0/0/2。
- t46：独立复核 55a0e9d，verdict pass（仅批准推送远程复验）。
- t47（本记录）：远程复验仍红，失败收敛为 T47-1（Windows 测试 basename）与
  T47-2（WebEngine 断言顺序），macOS 未验证。t45 修复的超时 timer、real-host、NAPI、
  Ubuntu TS、打包均已在远程转绿。