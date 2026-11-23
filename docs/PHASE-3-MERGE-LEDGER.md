# Phase 3 合并台账（t26）

本文件记录 Phase 3 集成树 `phase3/integration` 上**每一个被合入的已审查固定 SHA**。
规则：只合入通过独立审查的固定 SHA；不做跨仓 cherry-pick（EAC 内的
`dsh-qt-app` 子树与本仓库历史无关）；不 `push --force`；新接线与冲突修复由
后续独立审查承接。基线：app `33e516c32856878c37f92ddbbada81f9e437f3ba`
（fork `lbn2011/dsh-qt-app`, `dev/phase-1`），addon 锁
`87084a6901297a4fe9af997d4b8cdf9d829b0f67`。

| 序 | 模块 | 审查通过的 SHA | 审查任务 | 合入提交 | 合入方式 |
| --- | --- | --- | --- | --- | --- |
| 1 | I1a 协议 v1 帧/错误/decode | `9a198da05059eb013e06678d3b5c1c1698644aa5` | t15 pass | `b8a6d97` | `merge --no-ff` |
| 2 | I1b/I1c Node 宿主 + Qt v1 信封 | `1beba7de40e4957b08e1b45107f12998918d1c25` | t17 pass | `0af0359` | `merge --no-ff` |
| 3 | I2 工具投影 | `6f9407010f125138bfaf7f319f78256abfb27308` | t22 pass | `fb1d83d` | `merge --no-ff` |
| 4 | I3 设置/LLM/凭据 | `4219dd2f925fbb85091a7dad5972edb4ce06b129` | t23 pass | `4c52e3b` | `merge --no-ff` |
| 5 | I4 插件管理/SDK/受限 React 转换 | `d44b315ffb53aedeb6f3b8f72a43d687c7afd787` | t24 pass | `d1094fe` | `merge --no-ff` |
| 6 | I5 按需 WebUI 回退 | `7743ed932df2d39240f242591618f6ad2d47ecd7` | t31 pass | `9538627` | `merge --no-ff` |

六个合入全部无冲突（成员分支各自已把 I1 作为基线合入）。`9538627` 是 t26
共享接线工作的起点；t26 之后的提交只做接线/文档/CI 锁/许可分发，不改动
上述模块的已审查语义。逐条 diff 可用
`git log --oneline b8a6d97^..9538627 --first-parent` 与 `git show <merge>` 复核。

## 未合入 / 待独立审查

- Phase 2 的 `qml-bridge` 事件形状兼容层：不引入（v1 单一信封）。
- macOS：CI 矩阵有 `macos-14` 构建，但无真实 macOS 运行证据；WebEngine 回退在
  macOS 未验证（见 `docs/PHASE-3-STATUS.md` § 缺口）。
- 真实 DSH profile 内的完整会话（真实 `session/event` 流）尚未在 CI 中启动；
  当前以 `tests/integration-wiring.test.ts`（注入官方服务 fake + v1 帧）与
  `tests/host-e2e.e2e.ts`（真实 Qt 子进程）覆盖，缺口如实标注。
