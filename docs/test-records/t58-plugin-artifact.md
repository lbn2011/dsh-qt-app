# t58 — JavaScript 插件 tarball 与代码来源

状态：**PASS（本地 Linux 模拟；远程 CI 未运行）**。

- 应用代码来源：`43d15d59ebea6b6b075f014f93f72b403ff2bbd1`。
- CI 工作流提交：`560eb2dd00c9396ba349f016d0a73cb9b5073b68`（仅 `.github/workflows/build.yml`，父提交 43d15d5）。
- 本记录为独立文档提交；文档 SHA 不改变上述被测代码与工作流代码。

打包步骤要求 `GITHUB_SHA` 与 `git rev-parse HEAD` 严格相等，所以远程运行时
`provenance.source.sourceSha` 就是该次 checkout 的 SHA（包含工作流提交），其应用
代码父提交仍是 43d15d5；`sourceMatchesWorkflow` 为 `true`。本地模拟发生在工作流
提交之前，故样例中 `sourceSha=43d15d5`、`workflowSha=null`。

## 目标与范围

在 `qt-build (ubuntu-22.04)` 的已有 TypeScript 构建之后，把同一工作树、同一提交上的
JavaScript 插件打成 npm tarball，验证包内容、元数据、相对导入闭包与许可，并在临时
宿主闭包中实际挂载插件；最后以 GitHub Actions artifact 保存 tarball、摘要、文件清单
和来源记录。不发布到 npm registry，不提供永久下载 URL，不改变既有 Qt 构建与打包门。

改动仅在 `.github/workflows/build.yml`：`Build TypeScript` 之后新增 4 个
`if: runner.os == 'Linux'` 步骤，位置在 `Install Linux Qt dependencies` 之前。

## 新增步骤

1. `Pack the JavaScript plugin`
   - `npm pack --pack-destination dist/plugin --json > dist/plugin/pack.json`；
   - Node ESM 校验恰一个 tarball、`name`/`version`/文件名、`license=MIT`、
     `main=lib/index.js`、`types=lib/index.d.ts`、`exports` 三项；
   - 校验 `engines.node >=22.19.0` 由 `package.json` 保持不变；
   - 校验 tarball 文件列表含 `package/lib/index.js`、`package/lib/index.d.ts`、
     `package/LICENSE`、`package/THIRD-PARTY-NOTICES.md`；
   - 计算 sha256 并写 `<tarball>.sha256`；
   - 读取 `git rev-parse HEAD` 与 `GITHUB_SHA`，两者不一致即失败；写
     `dist/plugin/provenance.json`（包名/版本/许可/tarball/大小/sha256/入口/类型/
     `dshQtNapi.commit`/source 仓库、workflow、workflowSha、sourceSha、
     sourceMatchesWorkflow、ref、runId、runAttempt/Node 版本/生成时间/download 说明）。

2. `Verify plugin tarball contents and import closure`
   - `mapfile` 找到唯一 `.tgz`，`tar -tzf` 生成 `tarball-files.txt`；
   - 必需条目：`LICENSE`、`THIRD-PARTY-NOTICES.md`、`lib/index.js`、
     `lib/index.d.ts`、`qml/main.qml`、`native/main.cpp`；
   - `LICENSE` 含 `MIT License`，`THIRD-PARTY-NOTICES.md` 含 `third-party`；
   - 解包到 `$RUNNER_TEMP/dsh-qt-plugin-unpack`，Node 遍历 `lib/**/*.js`（本次 56 个）
     并检查每个相对 `import`/`from` 目标（含 `.js`、`.d.ts`、目录 `index.js`）存在。

3. `Activate the packed plugin in a clean host closure`
   - 在 `$RUNNER_TEMP/dsh-qt-plugin-host` 执行 `npm init -y`，用
     `npm install --no-audit --no-fund --ignore-scripts <tarball>` 安装打出的包；
   - Node import `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-qt-app`，断言
     `apply`/`inject=[]`/`plugin.apply`；
   - `new Context()` 后 `ctx.plugin(plugin, {bridge, autoLaunch:false,
     autoStartEventLoop:false, napiPath:'/nonexistent/...'})`；
   - 断言 `ctx.qtRenderer`、`stats.name/version`、`qmlEntry === 'qrc:/qml/main.qml'`、
     `renderMarkdown('artifact') === '<p>artifact</p>'`。

4. `Upload JavaScript plugin`
   - artifact `dsh-qt-app-plugin`，包含 `dist/plugin/*.tgz`、`*.sha256`、
     `provenance.json`、`tarball-files.txt`；`if-no-files-found: error`；保留 7 天。

## 本地验证

在隔离 worktree `/data/qt-phase3/app/wt/plugin-artifact`（branch
`phase3/plugin-artifact`，父 `43d15d5`）执行；Node 22.19.0 由
`npx node@22.19.0` 提供，npm 使用同一 Node。

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile && pnpm build` | exit 0 | `/data/qt-phase3/logs/t58-install-build.log`；14 packages reused，`tsc -p tsconfig.json` 成功 |
| `bash /data/qt-phase3/logs/t58-simulate.sh`（完整 pack → verify → activate） | exit 0 | `/data/qt-phase3/logs/t58-simulation.log` |
| `actionlint .github/workflows/build.yml` | exit 0 | 无输出 |
| `git diff --check` | exit 0 | 无输出 |

本地 tarball：`deepseek-ai-dsh-qt-app-0.1.0.tgz`，600422 bytes，sha256
`9ca9c25cc46f3fc4413d2da04b11917a9af589a8ee25a9687f13920f8623322f`。

本地 provenance 关键字段：

```json
{
  "package": "@deepseek-ai/dsh-qt-app",
  "version": "0.1.0",
  "license": "MIT",
  "tarball": "deepseek-ai-dsh-qt-app-0.1.0.tgz",
  "size": 600422,
  "sha256": "9ca9c25cc46f3fc4413d2da04b11917a9af589a8ee25a9687f13920f8623322f",
  "entry": "lib/index.js",
  "types": "lib/index.d.ts",
  "addonSha": "87084a6901297a4fe9af997d4b8cdf9d829b0f67",
  "source": {
    "sourceSha": "43d15d59ebea6b6b075f014f93f72b403ff2bbd1",
    "workflowSha": null,
    "sourceMatchesWorkflow": null
  },
  "node": "v22.19.0",
  "download": "GitHub Actions artifact dsh-qt-app-plugin; no registry or permanent URL"
}
```

`workflowSha` 为 `null` 仅在本地模拟（没有 `GITHUB_SHA`）；CI 中该步骤要求
`GITHUB_SHA` 与 `git rev-parse HEAD` 完全一致，否则失败，因此远程产物的
`sourceMatchesWorkflow` 必为 `true`，载荷来源与工作流来源都由
`provenance.json` 分别记录。

## 失败史与修正

1. 首个 pack 断言把 scoped 包的文件名写成 `dsh-qt-app-0.1.0.tgz`；`npm pack` 实际
   生成 `deepseek-ai-dsh-qt-app-0.1.0.tgz`（去掉 `@`、`/` 变 `-`）。改为
   `pkg.name.replace(/^@/, '').replace(/\//g, '-')` 后通过。
2. 初稿 heredoc 与 YAML 缩进混合导致 `actionlint` 报错；拆分为独立步骤的
   `node --input-type=module` 后 `actionlint` exit 0。
3. 本地模拟脚本第一次在 `cd "$HOST"` 后才 `realpath "$TARBALL"`，相对路径失效，
   安装为空导致激活报 `ERR_MODULE_NOT_FOUND`。修正为 `cd` 前取绝对路径；脚本为
   本地复现工具，未提交。CI 步骤本身在 `cd` 前已取 `realpath`。

## 边界与未验证项

- 只覆盖 Linux 的 `qt-build (ubuntu-22.04)`；Windows/macOS 不上传 JS 插件 artifact，
  也不声称这些平台验证。
- 本次是本地 Node 22.19.0 + npm 模拟；远程 GitHub Actions 尚未运行，固定 SHA
  与 artifact 下载链接待远程执行后补。
- tarball 只包含 npm `files` 白名单中的 JS/声明/QML/native 源码与许可，不含编译后的
  Qt 可执行文件、Qt 运行库或 N-API `.node`；N-API 二进制仍由既有 artifact 单独发布。
- 不发布 registry，不生成永久 URL；artifact 保留 7 天，来源只能由
  `provenance.json` 与 CI run 追溯。
- 相对导入闭包是静态扫描（正则 + 文件存在性），不执行每个模块；动态 `import()`
  仅覆盖相对路径字面量，裸包导入由 npm 安装闭包负责。
