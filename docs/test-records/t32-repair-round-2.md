# t32 修复轮测试记录（webui.token 泄漏 + Phase 3 缺失集成验收）

- 任务：t32（repair-round-2），attempt `4082989b-d4cc-42c4-ba60-5fbded65f8fc`
- 基线：t26 提交 `0dd833d3d32aede690aa86652174961a8dcda1d1`（branch `phase3/integration`）
- 版本锁：安装版 DSH `0.2.2-rc.1`、Qt `6.8.2`、Node `v26.13.1`、协议 v1、addon `87084a6901297a4fe9af997d4b8cdf9d829b0f67`
- 环境：Linux x86_64，`-DDSH_QT_WEBENGINE=OFF`（本机无 WebEngine），所有重型命令经
  `flock /data/qt-phase3/logs/verify.lock` + `systemd-run CPUQuota=200% MemoryMax=4G` 串行

## 1. 需求 → 证据映射

| 验收项 | 需求 | 层级 | 证据（测试） | 结果 |
| --- | --- | --- | --- | --- |
| ① token 不泄漏 | R-WEB-A1 / t27 F1 | E（真实 C++ 路径）+ U | `tests/host-e2e.e2e.ts` 的 5 个 webui 用例：成功、错误、超时、重复回复、关闭后迟到；哨兵 `sk-e2e-THIS-TOKEN-MUST-NOT-REACH-QML-4f19` 不出现在 stderr，也不出现 `LEAK`；`requestReplied` 不再承载 `webui.token` | 通过 |
| ② 原生打开链路 | R-WEBUI / R-WEB-O1 | E | `tests/webui-live.e2e.ts`：真实 `WebuiService` in-process + 真实 Qt，open→Ready→token→close；端口在退出后消失；OFF 构建下 external 是**降级**，不得记 embedded | 通过（嵌入加载见缺口） |
| ③ 真实 profile | I-G0 | E | `tests/official-profile.e2e.ts`：隔离 `DSH_HOME`、真实 headless profile、确定性假模型、真实 Qt 子进程；会话记录、`tool.row` running→ok、运行期无监听端口 | 通过 |
| ④ 槽位/工具 QML e2e | I-PLUGIN2 / R-TOOL | Q + E | `tests/qml/tst_generatedview.qml`（14 例）；`tests/generated-slot-live.e2e.ts`：真实 Qt 渲染 `ui.render` 结果→真实点击→`ui.action`→Node 重渲染→`Count 1` | 通过 |
| ⑤ 真实 pluginManager | I-PLUGIN1 | E | `tests/plugin-manager-live.e2e.ts`：隔离 profile + 本地 fixture 插件，真实 `ctx.pluginManager` 列表/停用/启用与 ChangeResult | 通过 |
| ⑥ 打包与门禁 | I-GATE1 / I-WEBUI2 / I-DOC1 | U + E | `tests/gate.test.ts`（退出码保真、缺命令负例）；`tests/packaging.test.ts`（`cmake --install` 到临时 prefix 含 LICENSE/NOTICES，缺 NOTICES 负例）；`tests/webui-external.e2e.ts`（官方 `dsh web` 303+cookie，无/伪造凭据 401，退出释放端口） | 通过 |

## 2. 失败史（保留，不覆盖）

| 时间点 | 失败 | 根因 | 修正 |
| --- | --- | --- | --- |
| t32 首日 | `tst_generatedview.qml` 217 passed / 12 failed | offscreen 下 `visible` 恒 false；`Loader.source` 误绑定自身 `visible`；`findChild` 找不到 Loader 内节点 | 断言改 `showsNative/…` 布尔；`source: root.showsNative`；`wired` 改按 item 引用；测试用 `deepFind`/`childNamed` 按 kind 过滤 |
| 同上 | 单文件 10 passed / 4 failed | `fire()` 未检查 `node.disabled`；field/select 手势未走统一 `act()` | `act(event,payload)` 统一守卫；`onEditingFinished/onActivated` 改调 `act()` |
| 同上 | 嵌套容器断言偶发失败 | 子 Loader 异步实例化 | `tryVerify(...,2000)` |
| e2e 首跑 | `generated-slot-live` 挂起 19s（`Promise resolution is still pending`） | harness 载入的是编译期 `qrc:/qml/main.qml`，`DSH_QT_QML_ENTRY` 未生效 | `native/main.cpp` 改为 `qEnvironmentVariable("DSH_QT_QML_ENTRY", 宏默认值)` |
| 同上 | 点击后无 `ui.action` | harness 未连 `GeneratedView.onAction`；`QtSlotContribution` 无 `action` 字段 | harness 补 `onAction`；`types.ts`/`slot-bridge` 增加 `action` |
| webui-live 首跑 | 断言 embedded，实际 external | OFF 构建无 WebEngine，降级合法 | 断言改为：`webview.available=1` 必须 embedded，否则禁止 embedded |
| webui-external 首跑 | `401 !== 200` | 官方带 token URL 返回 303+`set-cookie`（cookie 名含 authority），fetch 无 cookie jar 跟随重定向后 401 | 断言 303 与 `getSetCookie()`，再带 cookie 请求 `/` 断言 200 |
| token e2e 首跑 | close 用例 期望 `intent=embed` 实际 `intent=` | `closeWebui()` 已清空意图绑定，迟到回复按 cancelled 丢弃（符合设计） | 断言改为 `intent= outcome=cancelled` |

## 3. 命令与退出码

（由最终验证脚本回填；脚本 `/data/qt-phase3/logs/t32-verify.sh`，
汇总 `/data/qt-phase3/logs/t32-verify-summary.txt`，各步日志 `logs/t32-<step>.log`。）

| 命令 | 退出码 | 摘要 | 日志 |
| --- | --- | --- | --- |
| `pnpm typecheck` | 0 | src + tests 类型检查（首跑 rc=2，见 §2 记录；修正后 0） | `logs/t32-typecheck.log` |
| `pnpm test` | 0 | **482/482 pass**（含 gate 3 例、packaging 3 例、integration-wiring 5 例） | `logs/t32-test.log` |
| `pnpm build` | 0 | `tsc -p tsconfig.json` → lib/ | `logs/t32-build.log` |
| `tsx --test tests/host-e2e.e2e.ts` | 0 | **7/7**：握手顺序、ping/markdown.parse/theme.scale、shipped QML 加载、token 成功/错误/超时/重复/关闭后迟到 | `logs/t32-host-e2e.log` |
| `tsx --test tests/webui-live.e2e.ts` | 0 | **1/1**：真实 `WebuiService` in-process，open→Ready→token→close，退出后端口消失 | `logs/t32-webui-live.log` |
| `tsx --test tests/official-profile.e2e.ts` | 0 | **1/1**：真实 headless profile + 假模型 + 真实 Qt；会话/final、tool.row running→ok、无监听端口 | `logs/t32-official-profile.log` |
| `tsx --test tests/generated-slot-live.e2e.ts` | 0 | **1/1**：真实 Qt 渲染→点击→`ui.action`→重渲染 `Count 1` | `logs/t32-generated-slot.log` |
| `tsx --test tests/plugin-manager-live.e2e.ts` | 0 | **1/1**：真实 `ctx.pluginManager` 列表/停用/启用 + ChangeResult | `logs/t32-plugin-manager.log` |
| `tsx --test tests/webui-external.e2e.ts` | 0 | **1/1**：官方 `dsh web` 303+cookie、无/伪造 token/cookie 401、退出释放端口 | `logs/t32-webui-external.log` |
| `cmake -S . -B build -DDSH_QT_WEBENGINE=OFF` | 0 | WebEngine 关闭仍可配置 | `logs/t32-cmake-configure.log` |
| `cmake --build build -j2` | 0 | 含 `native/webview_host.cc` 与 token 分派 | `logs/t32-cmake-build.log` |
| `cmake --build build --target qml-tests` | 0 | **229 passed / 0 failed / 0 skipped** | `logs/t32-qml-tests.log` |

## 4. 边界声明

- 假模型与隔离 `DSH_HOME`：不接触真实凭据、不调用付费模型；模型行为（一次 `bash`
  tool_use + 一次文本）与标题请求判据固定，属于确定性测试替身。
- OFF 构建：`outcome=external` 只证明分派到浏览器分支（自测不实际拉起桌面浏览器）；
  嵌入加载（WebEngine=1）本机不可验证，已在 STATUS §4 列为缺口。
- 自测模式：`DSH_QT_HOST_SELFTEST` 的 `webui*`/`session-live` 分支只在测试进程内启用，
  产物默认路径不受影响。
