# t34 — repair round 2（T28-1…T28-4）实测记录

任务：t34 repair-round-2，修复 t28 审查的 4 条 high findings。实现 + 复审闭环，
不留待后续 integration 自改。所有重型命令在
`flock -w 900 -x /data/qt-phase3/logs/verify.lock` +
`systemd-run --scope -p CPUQuota=200% -p MemoryMax=4G --quiet` 内串行执行。

本机环境：Linux x86_64（2 核，内存 3G + swap 4G），系统 Qt 6.8.2（/usr），
WebEngine 包 `qt6-webengine-dev 6.8.2+dfsg-4` 于本轮安装
（日志 `logs/t34-apt-webengine.log`，EXIT=0）。Windows/macOS 无本机运行证据。

## 1. T28-1：CI 增加 qtwebengine job

`.github/workflows/test.yml` 新增 `qt-webengine` job（ubuntu-22.04，timeout 45）：

- `jurplel/install-qt-action@v4` 带 `modules: qtwebengine`；
- 容器/运行环境变量 `QT_QPA_PLATFORM=offscreen`、
  `QTWEBENGINE_CHROMIUM_FLAGS=--no-sandbox --disable-gpu --disable-dev-shm-usage`、
  `QTWEBENGINE_DISABLE_SANDBOX=1`；
- configure `cmake -S . -B build-webengine -DDSH_QT_WEBENGINE=ON -DCMAKE_BUILD_TYPE=Release`；
- 编译期断言两条：configure 日志含 `Qt WebEngine embedding enabled`，且
  `build-webengine/CMakeFiles/dsh-qt-app.dir/flags.make` 含
  `-DDSH_QT_HAS_WEBENGINE=1`（`grep -R -- '-DDSH_QT_HAS_WEBENGINE=1'`，同时断言二进制存在）；
- `cmake --build build-webengine --parallel 2`；
- apt 增加 `xvfb procps`；`browser-actions/setup-chrome@v1` 安装外部浏览器 e2e 用的 Chrome
  （`DSH_E2E_BROWSER=google-chrome`）；
- `DSH_QT_APP_BINARY=$PWD/build-webengine/dsh-qt-app pnpm exec tsx --test tests/webengine-chromium.e2e.ts`；
- 失败也上传 `configure-webengine.log` 与 e2e 输出。

`.github/workflows/test.yml` 的 `packaging` job 增加 Linux 步骤
`Assert archive ships LICENSE + notices + SHA-256`：`sha256sum -c` 校验同名 `.sha256`，
从 tar 首条目取根目录并断言 `LICENSE`、`THIRD-PARTY-NOTICES.md` 存在。

YAML 校验（本机）：`ruby -ryaml -e 'YAML.load_file(...)'` → jobs 顺序
`napi, typescript, napi-integration, qml-lint, qml-tests, qt-webengine, packaging`；
qt-webengine 13 个 step、packaging 10 个 step 均可解析。CI 尚未真正触发（无远程 runner），
此限制见 §6。

## 2. T28-2：WebEngine 真实加载/关闭 e2e

产品侧最小挂钩（不改认证）：

- `native/webview_host.h/.cc`：WebEngineView 包在 QML `Item` 内，转发
  `loadFinished(ok,title,url)`；新增只读 `loadState`（idle/loading/loaded/failed/closed）、
  `pageTitle`、`Q_INVOKABLE currentUrlMasked()` 与 `loadStateChanged`。原始 URL 仍只存
  `Private::authenticatedUrl`，QML 侧只见 masked URL。`close()` 在 about:blank 提交后
  才置 closed（`closing` 标志），因此“关闭完成”可被外部观察。
- `native/main.cpp`：`WebviewHost` 提前到 selftest 之前创建（原先在 selftest 提前返回之后，
  selftest 永远 canEmbed=0，这也是 t32 未跑嵌入分支的直接原因之一）。selftest 新增
  `webui-chromium` 模式：连接 `webui.state` → `openWebuiEmbedded`，连接
  `loadStateChanged` 播报
  `[selftest] webview.load state=<state> title=<title> url=<masked>`，loaded/failed 后
  调用 `closeWebui()`，closed 后播报 `[selftest] webview.close visible=%d url=%s`
  并退出（失败 6，未嵌入 5，超时 3 / 60s）。
- `qml/views/WebFallbackPanel.qml`：`syncEmbedContainer()` 把 `embedSlot` 交给
  `webviewHost.setContainer()`（生产原本没有任何 container 注入点，嵌入必然拒绝）。

新增 `tests/webengine-chromium.e2e.ts`（2 例；`pnpm test` 的 `tests/*.test.ts` 不匹配它，
由 CI job 与本机命令显式运行）：

1. 本地 Node HTTP server：缺/错 `?token=` → 401，正确 token → 200 且
   `<title>DSH-WEBUI-MARKER-7419</title>`；假 HostBridgeService 提供
   `webui.open`（发 `webui.state Ready`）、`webui.token`（返回真实
   `http://127.0.0.1:PORT/?token=chromium-e2e-secret-7419`）、`webui.close`；
   真实 Qt 进程 `DSH_QT_HOST_SELFTEST=webui-chromium`（offscreen）。
   断言：exit 0、`webview.available=1`、`webview.container=1`、
   `webui.token intent=embed outcome=embedded` 且 masked 含 `token=***`、
   `webview.load state=loaded title=DSH-WEBUI-MARKER-7419`、server 记录到授权命中且无 401、
   `state=closed` + `webview.close visible=0 url=about:blank`、stderr 不含原始 secret。
2. 外部浏览器：隔离 HOME/XDG profile + Xvfb/xcb，`QDesktopServices` → `xdg-open` → 真实 Chromium headless 执行页面 JS（见 §3）。

本机实测：`logs/t34-chromium-final.log` → 2/2 pass，0 fail，exit 0（见最终 R2 日志）；构建日志 `logs/t34-webengine-build-r2b.log` EXIT=0。

## 3. T28-3：真实外部浏览器（隔离 profile，无 URL 落盘）

针对合同更正，**已删除** `DSH_QT_OPEN_URL_LOG` 与 `recordOpenUrlForTest()` 写盘路径：
认证 URL 不再被任何日志、文件或 QML 观察。

`native/main.cpp`：

- `desktopHandOffEnabled()`：生产（`DSH_QT_HOST_SELFTEST` 为空）总是 `QDesktopServices`；
  `DSH_QT_SELFTEST_REAL_BROWSER=1` 让专用 e2e 走完全相同的分派；
- `offscreen`/`minimal` QPA 平台在调用前拒绝（Qt 的 “does not support openUrl” 警告会打印
  含 token 的完整 URL，必须避免）；
- `resolveWebuiToken_` 的 external 分支只有 `QDesktopServices::openUrl` 成功才置
  `external`，失败为 `failed/open-failed`；没有旁路 outcome。

e2e 第 2 例（`tests/webengine-chromium.e2e.ts`）：

- 启动临时 Xvfb（`:90`–`:99`，`-screen 0 1024x768x24`），制品进程用 `QT_QPA_PLATFORM=xcb`；
- 隔离 `HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME`，写
  `data/applications/dsh-e2e-browser.desktop`（`Exec=<repo>/tests/fixtures/controlled-browser.sh %u`）
  与 `config/mimeapps.list` 默认 handler；**不触碰生产默认浏览器配置**；
- `QDesktopServices` 真实分派到 `xdg-open`，后者启动真实 Chromium（headless、独立
  `--user-data-dir`）；fixture 用 `--dump-dom` 输出执行 JS 后的 DOM，URL 只作为 argv，
  不写日志；
- 断言：DOM 含 `<title>DSH-WEBUI-MARKER-7419</title>`、`id="marker"` 与
  `<div id="js-executed">ran-7419</div>`（证明页面 JS 在真实浏览器执行）；server 只收到
  正确 token 的授权请求、无 401；DOM 与 stderr 均不含 raw secret；浏览器自行退出后
  `pgrep` 无该 profile 进程，临时 profile 目录删除；
- 关闭清理证据 = 浏览器进程退出 + profile 目录移除 + `webui.close` 生命周期由第 1 例覆盖。

本机实测：`logs/t34-browser-r2.log` → 1/1 pass，exit 0（Xvfb + Chromium 148，
`/usr/bin/chromium`）。

## 4. T28-4：CPack 归档解包与负例

`tests/packaging.test.ts` 重写（保留 package.json 与 install 两条）：

- `cpack -G TGZ` 从 `build/` 运行（preinstall 在该目录执行 `cmake --build .`）；
  `-B` 与 `-D CPACK_PACKAGE_DIRECTORY` 都会被 `CPackConfig.cmake` 里的
  `CPACK_OUTPUT_FILE_PREFIX` 覆盖，故测试生成私有 config 副本，仅替换该行到临时目录。
- 正向：包名 `dsh-qt-app-*-Linux-*.tar.gz`；同名 `.sha256` 存在且 SHA-256 描述归档字节；
  `tar -xzf` 后唯一根目录含 `LICENSE`、`THIRD-PARTY-NOTICES.md`（notices 含 cmark-gfm 与
  pinned addon commit）与 `bin/dsh-qt-app`。
- 负例：手工打包缺 notices → 拒绝；写入错误 `.sha256` → 拒绝。

实测：`logs/t34-packaging-test2.log` → 5/5 pass，exit 0。本机只跑 TGZ；
NSIS 与 macOS DragNDrop 留给 CI 平台 leg（未在本机声称）。

## 5. 验证命令（逐条退出码）

命令序列 `/data/qt-phase3/logs/t34-verify.sh`，汇总
`logs/t34-verify-summary.log`（CHAIN_EXIT=0）：

| 命令 | 退出码 | 日志 | 摘要 |
| --- | --- | --- | --- |
| `pnpm typecheck` | 0 | `logs/t34-r2-typecheck.log` | 无错误输出 |
| `pnpm test` | 0 | `logs/t34-r2-test.log` | **484/484 pass, 0 fail, 0 skipped**（含 packaging 5/5） |
| `pnpm build` | 0 | `logs/t34-r2-build.log` | `tsc -p tsconfig.json` |
| `cmake -S . -B build -DDSH_QT_WEBENGINE=OFF` | 0 | `logs/t34-r2-configure.log` | WebEngine 关闭 |
| `cmake --build build --parallel 2` | 0 | `logs/t34-r2-build-qt.log` | 含 webview_host/main.cpp |
| `cmake --build build --target qml-tests` | 0 | `logs/t34-r2-qml-tests.log` | 全部 QML 套件通过 |
| `qmllint qml/**/*.qml`（绝对路径） | 0 | `logs/t34-r2-qmllint.log` | 既有 14 条 Warning，本任务文件 0 |
| `cmake --build build-webengine`（ON） | 0 | `logs/t34-r2-webengine-build.log` | 链接 build-webengine/dsh-qt-app |
| `tsx --test tests/webengine-chromium.e2e.ts`（ON 二进制） | 0 | `logs/t34-r2-chromium-e2e.log` | **2/2 pass**（嵌入 + 真实外部浏览器） |

注：`qmllint` 首次经 systemd-run 运行返回 127（PATH 无 Qt bin，记录于
`logs/t34-verify-summary.log`），改用绝对路径重跑后 exit 0；`logs/t34-qmllint.log` 保存的是
成功的重跑结果。

## 6. 失败史（真实缺陷，非改测试凑绿）

1. **容器从未注入**：`loadAuthenticated` 因 `container == nullptr` 返回 false，selftest
   落到 external（outcome=external、exit 5）。生产 QML 也没有注入点 → 新增
   `setContainer()` 与 `WebFallbackPanel.syncEmbedContainer()`。
2. **QML engine 生命周期**：诊断显示 `container has no QML engine`；原因是 selftest 的
   `QQmlEngine`/`QQuickWindow` 为 `if` 块内栈对象，在 `app.exec()` 前析构。改为堆分配
   （`new QQmlEngine(&app)`、`new QQuickWindow`）后真实加载成功。
3. **connect 旧式信号**：Qt 6 无 4 参 lambda connect 重载，先改为
   `SLOT(handleViewLoadFinished(bool,QString,QString))`。
4. **e2e 正则**：load 行末尾无空格，原正则要求 `*** ` 后空格；改为 `(?:\n|$)`。
   token 行的 ` error=` 保留。
5. **packaging 负例**：校验和负例在 `assert.throws` 外先调了一次 `verifyChecksum(archive,
   '0'*64)`，测试自己抛出；删除该行后 5/5。
6. **qmllint PATH**：见 §5 注。
7. `build`（OFF）曾因 `setContainer` 未加 `#if DSH_QT_HAS_WEBENGINE` 保护而绕过
   `d->view` 类型，导致 cpack preinstall 失败；已加宏保护。
8. **offscreen 无法分派且 Qt 打印带 token 的 URL**：首版外部浏览器 e2e 用
   `QT_QPA_PLATFORM=offscreen`，`QPlatformServices::openUrl` 不支持并在 warning 中打印
   `http://…?token=<secret>`；这不是测试问题而是真实泄漏路径。修复：`desktopHandOffEnabled()`
   在 offscreen/minimal 平台调用前拒绝，外部 e2e 改用 Xvfb + xcb，token 不再进入 stderr。

## 7. 边界与未验证项（不外推）

- CI job 只做了本机 YAML 解析与命令等价性核对，**未在 GitHub runner 真正运行**；
  `install-qt-action` 的 `qtwebengine` 模块名与 Chromium 运行库清单需首次 CI 运行确认。
- WebEngine 只在 Linux x86_64 + offscreen + 本机 Qt 6.8.2 验证；Windows/macOS、
  真实桌面窗口、真实 303+cookie 认证链（官方 `dsh web`）仍由既有
  `tests/webui-external.e2e.ts` 单独覆盖，本轮未重跑真实浏览器窗口。
- e2e 使用假 HostBridgeService（不发真实 `webui.open` 到官方 WebuiService）；
  真实 `WebuiService` + 嵌入组合仍由 `tests/webui-live.e2e.ts` 在 OFF 构建下验证
  external 降级，ON 组合的“服务端真启动 + Chromium 加载”并未合在同一条用例里。
- `DSH_QT_OPEN_URL_LOG` 与 `recordOpenUrlForTest()` 已在本修复提交中删除；认证 URL
  不再写任何日志/文件。外部浏览器用隔离 profile + Xvfb/xcb + 真实 Chromium 验证
  DOM/JS，不修改生产默认浏览器配置，但有隔离 profile 仍依赖 Linux 桌面工具链
  （xdg-open、desktop entry、Xvfb），Windows/macOS 未有对应证据。
- 范围声明：本提交涉及 `tests/fixtures/controlled-browser.sh`（新增受控浏览器启动
  fixture），属于合同 `tests/fixtures/`；`native/webview_host.h` 与
  `qml/views/WebFallbackPanel.qml` 已在合同扩围后覆盖。