# I1b/I1c 测试记录（真实命令、退出码与失败史）

工作树：`/data/qt-phase3/app/wt/qiu-host`（branch `phase3/host-qiu`，基线 `33e516c`）。
环境：Linux，node v26.13.1，Qt 6.8.2，`/usr/lib/qt6/bin/qmltestrunner`，Qt Test 模块 6.8.2。
共享预算：所有重型命令经
`flock -w 900 -x /data/qt-phase3/logs/verify.lock -c 'systemd-run --scope -p CPUQuota=200% -p MemoryMax=4G --quiet …'`。
日志：`docs/test-records/i1b-*.log`（被 `.gitignore` 忽略，仅本工作树留证；下表记录其退出码与计数）。

## 1. 最终命令与结果

| # | 命令 | exit | 证据 |
|---|---|---|---|
| 1 | `pnpm typecheck` | 0 | 无诊断 |
| 2 | `pnpm test`（`tsx --test tests/*.test.ts`） | 0 | tests 347 / pass 347 / fail 0（`i1b-pnpm-test.log`） |
| 3 | `cmake -S . -B build -DDSH_QT_WEBENGINE=OFF` | 0 | 生成 `build/`，警告该变量未使用（见缺口） |
| 4 | `cmake --build build -j2` | 0 | `build/dsh-qt-app` 515 488 B |
| 5 | `cmake --build build --target qml-tests` | 0 | Totals: 168 passed, 0 failed, 0 skipped（`i1c-qml-tests.log`） |

补充（真实双进程，非 mock）：

| 命令 | exit | 结果 |
|---|---|---|
| `pnpm exec tsx --test tests/host-launcher.test.ts` | 0 | 10/10 pass，0 fail |
| `pnpm exec tsx --test tests/host-e2e.e2e.ts` | 0 | 1/1 pass，291 ms（首次）/ 63 ms（复跑），无残留 `dsh-qt-app` 进程 |

**e2e 证明了什么**：真实 spawn 的 Qt 子进程发出 `hello`，Node 回 `hello.ack` 后才 connected；
Qt 侧 `host.ping` 得到 `{pong:true}`；stderr 依次为
`[selftest] state=connecting`、`[selftest] state=connected`、`[selftest] ping=ok pong=1 error=`；
子进程 exit code 0、signal null；服务侧 `stats.handled≥1`、`protocolErrors=0`、状态回 `disconnected`。

## 2. 失败史（全部已修复，按发现顺序）

1. **握手 ack 被误判为写失败**（真实实现 bug）。`const error = transport.send(ack) ?? makeError(...)`：
   `send()` 成功返回 `null`，`??` 把成功当失败 → 首测 hello.ack 已写出却立即 `fail_('could not write hello.ack: transport is gone')`。
   修正：先判 `transport === null`，再取其返回值；`invoke` 中同一写法一并改。
2. **`TS6133` 未使用导入**：`src/host/transport.ts` 的 `MAX_INBOUND_FRAME_BYTES` 仅用于类型上限，删除。
3. **测试类型不严谨**：`encodeFrame` 返回 `EncodeResult` 判别联合，需先判 `ok` 才能取 `line`；
   `framesOf` 改为泛型 `K extends Envelope['kind']` → `Extract<Envelope,{kind:K}>[]`，`ResFrame.error` 只在 `ok:false` 分支存在。
4. **`markdown.parse` 返回 unavailable**：`createQmlBridge` 不带 parser；`src/index.ts` 改用 `createServiceBridge`（内部默认 `fallbackParserAdapter`）。
5. **测试 harness 方向错误**：最初从 `frames`（Node→Qt）里找 Qt 发来的 `req`，永远找不到；
   harness 增加 `sent: Envelope[]` 记录 Qt→host 帧，host→Qt 的 req 仍在 `frames`。
6. **断言时序**：重复 id 场景实际产生 3 条 res（1 条成功 + `duplicate-id` + `unknown-method`），
   在只等到 2 条时断言 `handled` 必然为 0；改为等到 3 条并等 `handled===1`。
7. **高亮形状**：`code.highlight` 走 TypeScript 高亮，返回 `<font color="#…">let</font>`，不是 `data-lang="ts"`；按真实输出断言。
8. **未知 kind 的归属**：`{kind:'mystery'}` 在 **decoder** 层被标为 `ignored`，不会到达服务；
   因此改为断言“服务仍 connected、事件只投递一次”，不再断言服务计数。
9. **显式二进制路径被忽略**（真实实现 bug，构建出二进制后才暴露）：`launchQtHost` 调 `resolveQtBinary` 时
   未传 `binaryPath`/`env`，显式 `/nonexistent/dsh-qt-app` 会回退到刚构建的 `build/dsh-qt-app` 并“成功”启动。
   修正：显式 `binaryPath` 或 `DSH_QT_APP_BINARY` 为权威，命中不存在即 `QtLaunchError('unavailable')`，不回退。
10. **`qml-tests` 目标不存在**：`find_program(qmltestrunner HINTS ${QT6_INSTALL_PREFIX}/bin)` 在 Debian 布局下
    找不到 `/usr/lib/qt6/bin/qmltestrunner`（`QT6_INSTALL_PREFIX=/usr`）。修正：用 `qmake6 -query QT_HOST_BINS`
    补 HINT；重新配置后 `QMLTESTRUNNER_EXECUTABLE=/usr/lib/qt6/bin/qmltestrunner`，目标可构建。

## 3. 覆盖矩阵（10 个 host 单测 + 1 个真实 e2e）

- 握手门控：ack 前 `connecting`、ack 后 `connected`、epoch 不匹配拒绝、5 s 握手超时。
- 请求：正常往返、超时 reject + 迟到回复按 id 丢弃、重复 id 只回一条 `duplicate-id`、未知方法 `unknown-method`。
- 事件：`epoch+seq` 去重、重复事件只投递一次、未知 kind 不破坏连接。
- 断连：EOF 拒绝在飞请求、状态 `disconnected`、`lastError` 有原因。
- 生命周期：dispose 先摘 sink 再以 `cancelled` 拒绝、二次 dispose 安全、缺失二进制 `unavailable`、handler 抛错转错误码。
- 旧 11 方法：逐一经 `host.register` → `QmlBridge.dispatch` 路由，返回形状与 `qml-bridge.ts` 一致。
- 真实进程：见上节 e2e。

## 4. 未测 / 已知缺口

- Windows：仅代码分支（`.exe`、`windowsHide`、`QT_QPA_PLATFORM=windows`），未在 Windows 构建或运行。
- macOS：未验证（团队既定缺口，如实记录，不计入通过项）。
- `DSH_QT_WEBENGINE` 尚未被 CMakeLists 消费（WebUI 属 I5）；配置警告属预期。
- no-`DSH_QT_HOST_SELFTEST` 的完整 GUI 启动未自动化（需要显示服务器）；其连接语义由同一 `DshQtBridge` 代码路径覆盖。
- 无 QML 协议套件：`qmltestrunner` 是独立进程，构造不出 C++ 单例，故协议由 C++ 自测与 Node 测试覆盖（交接文档 §5.3）。