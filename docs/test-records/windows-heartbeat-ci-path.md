# Windows 心跳 CI：多配置生成器的 Release 路径修正（t117）

日期：2026-11-26（+08:00）
基线：`a6fa4141143206887426afd5207942ecaf76cf5f`（分支 `phase3/t95-win-pipe`，父 `303829d`）
范围：只改 `.github/workflows/test.yml` 的 `qt-gui-heartbeat` 作业；应用代码、测试用例、其余作业未动。
状态：**本地已改并静态验证，未推送、未远程重跑**。

## 1. 旧 run 的失败事实（T110-1）

| 项 | 值 |
| --- | --- |
| run | test `45691052686`（head `a6fa414`） |
| 作业 | `qt gui heartbeat (windows-2022)` = `139476284625`，conclusion **failure** |
| 失败步骤 | `Resolve the binary under test` |
| 逐字报错 | `##[error]no dsh-qt-app binary was built; build/ contains:` 后接 `build:` 列表，其中只有 `Debug`（以及 `ALL_BUILD.vcxproj`、`CMakeCache.txt`、`CPackConfig.cmake`、`INSTALL`、`PACKAGE`、`ZERO_CHECK` 等） |
| 同作业 Build 步骤 | 实际成功：`dsh-qt-app.vcxproj -> D:\a\dsh-qt-app\dsh-qt-app\build\Debug\dsh-qt-app.exe` |
| 后果 | `Run the GUI heartbeat regression` 与 `Assert the regression really ran` **从未执行**；工件 `gui-heartbeat-log-windows-2022` 不存在（Linux 侧有） |

对照：同 run 的 `qt gui heartbeat (ubuntu-22.04)` = `139476284476` 通过，`# tests 13 / # pass 13 / # fail 0 / # cancelled 0 / # skipped 0`。

## 2. 根因

Visual Studio 是**多配置生成器**：`-DCMAKE_BUILD_TYPE=Release` 只对单配置生成器（Linux 上的 Makefiles/Ninja）生效，
MSVC 忽略该缓存变量、按配置写进 `build/<Config>/`。而旧 Build 步骤是 `cmake --build build --parallel 2`，
没有 `--config`，于是落在默认的 `Debug/`；旧 Resolve 步骤在 `build/Release/dsh-qt-app.exe` 不存在时**回退**到
`build/dsh-qt-app.exe`（也不存在）→ 硬失败。

即：构建配置与解析路径各自独立地「以为对方是 Release」，两者都没错到能报警，最终表现为「构建成功、测试从未运行」。

## 3. 修改（两个步骤）

```yaml
      - name: Build
        shell: bash
        run: |
          set -euo pipefail
          if [ "$RUNNER_OS" = "Windows" ]; then
            cmake --build build --config Release --parallel 2
          else
            cmake --build build --parallel 2
          fi

      - name: Resolve the binary under test
        shell: bash
        run: |
          set -euo pipefail
          if [ "$RUNNER_OS" = "Windows" ]; then
            candidate="build/Release/dsh-qt-app.exe"
          else
            candidate="build/dsh-qt-app"
          fi
          if [ ! -f "$candidate" ]; then
            echo "::error::the Release binary was not produced at $candidate; build/ contains:"
            ls -R build | head -80 || true
            exit 1
          fi
          # Echo the path so a failure and a pass both say which file was used.
          # DSH_QT_APP_BINARY stays rooted at GITHUB_WORKSPACE: Git Bash would
          # print a /d/a/... MSYS path that native Node on Windows cannot open.
          echo "binary under test: $GITHUB_WORKSPACE/$candidate"
          echo "DSH_QT_APP_BINARY=$GITHUB_WORKSPACE/$candidate" >> "$GITHUB_ENV"
```

要点：
- Windows **明确** `--config Release`；Linux 命令与旧版逐字一致（`cmake --build build --parallel 2`）。
- Windows **只**解析 `build/Release/dsh-qt-app.exe`，**删除了 Debug/根目录兜底** —— 按任务要求「不接受 Debug 兜底」。
- 成功与失败都打印实际使用的路径（`binary under test: …` / `::error::the Release binary was not produced at …`）。
- `DSH_QT_APP_BINARY` 仍以 `$GITHUB_WORKSPACE` 为根：Git Bash 的 `pwd` 会给出 `/d/a/...` 这类 MSYS 路径，原生 Node 打不开。
- 失败时的目录列表由 `head -50` 放宽到 `head -80`，便于一眼看到 `Release/` 是否存在。

## 4. 负例与正例（本地执行，非 CI）

用 `ruby -ryaml` 从 workflow 里**原样抽出**两个步骤的 `run` 体到 `/tmp/t117-{build,resolve}.sh`，再以桩环境执行，
避免「测试的脚本」与「workflow 里的脚本」不一致。

| 用例 | 环境 | 夹具 | 结果 |
| --- | --- | --- | --- |
| N1 负例 | `RUNNER_OS=Windows` | 只有 `build/Debug/dsh-qt-app.exe`（即 T110-1 的真实形状） | **exit 1**，`::error::the Release binary was not produced at build/Release/dsh-qt-app.exe; build/ contains:` + 目录树；`GITHUB_ENV` 未被写入 |
| P1 正例 | `RUNNER_OS=Windows` | 有 `build/Release/dsh-qt-app.exe` | exit 0，打印 `binary under test: D:\a\dsh-qt-app\dsh-qt-app/build/Release/dsh-qt-app.exe`，`GITHUB_ENV` 写入同一路径 |
| P2 正例 | `RUNNER_OS=Linux` | 有 `build/dsh-qt-app` | exit 0，路径与 `GITHUB_ENV` 均指向 `build/dsh-qt-app` |

Build 步骤（`cmake` 用记录 argv 的桩替换）：

| 环境 | 实际 argv |
| --- | --- |
| Windows | `--build build --config Release --parallel 2` |
| Linux | `--build build --parallel 2` |

N1 是这次修复的核心负例：在旧代码下同一夹具会回退到 `build/dsh-qt-app.exe` 并同样失败，但报错不指向 Release；
在新代码下失败信息直接点名 `build/Release`，且**不会**因为存在 `Debug/` 就放行。

## 5. 13 项回归与日志归档保持不变

用 YAML 解析逐步骤比对 HEAD 与工作树（`qt-gui-heartbeat` 共 14 步）：

```
step counts: old=14 new=14
Checkout                                       identical
Install Qt                                     identical
Build TypeScript                               identical
Configure                                      identical
Run the GUI heartbeat regression               identical
Assert the regression really ran               identical
Record whether window exposure was asserted    identical
Upload the GUI heartbeat log                   identical
```

即：13 例回归、`pass 13` / `fail 0` / 拒绝 skip 的三重断言、`DSH_QT_EXPECT_NO_DESKTOP` 的曝光口径、以及
`gui-heartbeat-log-${{ matrix.os }}` 的日志归档全部原样保留；改动只落在 `Build` 与 `Resolve` 两步。

## 6. 静态验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| workflow 语法与表达式 | `actionlint .github/workflows/test.yml` | exit 0，**无任何告警** |
| 基线是否有既有噪音 | 对 `git show HEAD:.github/workflows/test.yml` 同样跑 actionlint | exit 0，无告警 —— 本文件在本轮之前就是干净的，没有既有噪音需要豁免 |
| YAML 可解析 | `ruby -ryaml -e 'YAML.load_file(...)'` | 通过，`qt-gui-heartbeat` 14 步 |
| 空白错误 | `git diff --check` | exit 0 |
| 改动面 | `git diff --stat` | 仅 `.github/workflows/test.yml`（+21/−8） |

`actionlint` 本机原先未安装，为本次验证下载 1.7.7（linux_amd64 release）到 `/tmp/t117/bin`，未加入仓库、未改系统包。

## 7. 未验证边界（如实）

- **未推送、未远程重跑**：本轮不推 `dev/phase3-i9`，因此「Windows leg 真的产出 Release 并跑完 13 例」仍**没有**运行证据。
- Windows 上的 Git Bash 行为（`$GITHUB_WORKSPACE` 与 `RUNNER_OS` 的取值、`[ -f ]` 对 `D:\...` 路径的处理）在本机 Linux 上只能模拟，
  真实语义由下一次远程 run 裁决。
- `cmake --build build --config Release` 对 MSVC 的实际输出目录未在本机验证（本机无 Windows 工具链），依据是 CMake 多配置生成器的既有行为。
- 删除 Debug 兜底是有意为之：若将来 Windows 构建因其它原因落在 `Debug/`，该作业会**硬失败**而不是拿 Debug 二进制冒充 Release —— 这正是期望行为，但会让此类回归以「job 红」的形式出现。
- 同 run 的 macOS 两个作业仍为 `cancelled`（runner 池不可用），macOS 一律 not-validated。
