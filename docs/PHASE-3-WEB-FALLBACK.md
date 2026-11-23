# Phase 3 · 按需 WebUI 与嵌入兼容路径（t5 交付）

状态：**规划与核验稿，未实现、未启动任何服务器、未安装任何 SDK**。
性质：只读核验。未修改 DSH 官方源码，未改动当前 GUI（`native/main.cpp`、`qml/` 一行未动）。
作者：web-fallback（团队 dsh-qt-phase3）
取证基线：`/usr/local/lib/node_modules/@deepseek-ai/dsh` = `0.2.2-rc.1`；`/data/EAC-Desktop/dsh-qt-app` 工作树当前状态。

本文只回答任务书的六件事，结论全部落到文件与行号：

1. 「默认无 WebUI 监听」是否成立（§2）；
2. 显式启动 / 实例复用 / 就绪 / 失败重试 / 退出清理的状态机（§4、§5）；
3. 自有子进程与外部服务的区分规则（§6）；
4. QWebEngine 嵌入与浏览器兜底的认证、token 保护（§7）；
5. 与 t3 的导航/能力探测约定（§8，直接回答 `PHASE-3-PLUGIN-SDK.md:418-422` 的三问）；
6. Windows/Linux 打包依赖、缺 WebEngine 行为、内存测量（§9），以及验收矩阵（§10）。

---

## 0. 必须先纠正的两个既有假设

### 0.1 设计稿 §6.2 的就绪检测正则匹配不到任何真实输出

`docs/superpowers/specs/2026-11-22-dsh-qt-profile-design.md:618-627` 的草案：

```ts
spawn('dsh', ['web', '--port', port.toString()], { stdio: 'pipe' })
this.process.stdout.on('data', (d) => {
  const match = d.toString().match(/Server listening on (.+)/);   // ← 永不命中
```

官方真实播报只有一处，来自 `@deepseek-ai/dsh-web-app/lib/index.js:156-177`：

- `:160` `const authenticatedUrl = connectionCtx.connection.authenticatedUrl(webUrl)`
- `:162` `console.log(\`dsh web: ${authenticatedUrl}\`)`
- `:164` 若非 `--no-open`，再打印 `dsh web: opening the default browser; pass --no-open to disable`
- `:171-176` **先** `ctx.get("loader")?.await()` 等整棵 Loader 树 settle，**再** `auditStartupEntries`，两者都过了才 `announceReady()`（`ANNOUNCED_ROOTS` WeakSet 去重，`:158-161`）

结论：就绪必须解析 `^dsh web: (\S+)$`（且要跳过 `opening the default browser` 那条），并必须接受「audit 失败 → 永远不打印」这一分支。设计稿里的 `/Server listening on/` 属于臆造输出，不得实现。

### 0.2 进程拓扑在仓库内是自相矛盾的，回退方案的归属取决于它

| 证据 | 内容 |
|---|---|
| `dsh-qt-app/native/main.cpp:326-555` | `StdioTransport` 读 **fd 0**、写 **fd 1**，25ms 定时轮询（Windows）/ `QSocketNotifier`（POSIX）。它假设「父进程给了管道」 |
| `dsh-qt-app/CMakeLists.txt:35-37` | `qt_add_executable(dsh-qt-app native/main.cpp ...)` → 一个**独立可执行文件** |
| `grep -rn "child_process\|spawn(" dsh-qt-app/src dsh-qt-app/native` | **零命中**：仓内没有任何代码 spawn 这个可执行文件 |
| `grep -rln "dsh-qt-app" launcher tauri-shell dsh-desktop` | **零命中**：EAC 侧也没有 |
| `docs/superpowers/specs/2026-11-22-dsh-qt-profile-design.md:26` | 「Qt 窗口与 Node 引擎在**同一进程内**（通过 N-API）」 |
| `dsh-qt-napi/src/` | 只有 `ast-json.cc`、`cmark-binding.cc`、`extension-registry.cc` —— **没有任何创建 Qt 窗口的 N-API 代码** |

即：设计稿写的是「同进程 N-API」，代码写的是「独立进程 + stdio」，而**启动者两边都不存在**。本文不猜，按两种拓扑分别给结论，但两者在回退这一点上答案相同：

> **web 子进程的所有者是 Node 侧服务 `ctx.qtRenderer.webui`，不是 QML，也不是 Qt 侧。**

理由：只有 Node 侧同时具备 `child_process`、`process.env`（`DSH_WEB_URL`）、以及 `ctx.get("loader")` 观测点；QML 侧做进程管理会让「谁 kill 谁」在跨语言边界上失去句柄保证（§6）。

---

## 1. 取证清单（本文引用的全部官方位置）

| 包 | 文件 | 用途 |
|---|---|---|
| `dsh-host-webserver` | `lib/index.js`（663 行） | 唯一的 HTTP 监听者、`getOrigin()`、fallback 座位 |
| `dsh-web-app` | `cordis.patch.yml` | `webserver` 行**只**出现在这里（`:175-184`） |
| `dsh-web-app` | `lib/startup.js`（73 行） | `--host/--port/--no-open/--public-url/--trusted-host/--tls-*` 与 `webStartup` 服务 |
| `dsh-web-app` | `lib/index.js`（180 行） | 就绪播报、`DSH_WEB_URL`、浏览器拉起 |
| `dsh-client-connection` | `lib/index.js`（1072 行） | launch token、cookie、Host/Origin 栅栏、`admit()` |
| `dsh-host-frontend-static` | `lib/index.js`（135 行） | dist 静态服务 + 索引鉴权入口 |
| `dsh-official-bundles` | `lib/index.js:3-9` | `PROFILE_TEMPLATES`（哪个 profile 会挂 web-app） |
| `dsh`（CLI） | `lib/bin.js` | `dsh web` ≡ `dsh --profile web` |

---

## 2. 结论一：「默认无 WebUI 监听」成立（三条独立证据）

### 2.1 结构证据：`webserver` 行只存在于 web bundle

`@deepseek-ai/dsh-web-app/cordis.patch.yml:174-184`：

```yaml
    # This row rejects wildcard binds.
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      inject: [webStartup]
      config:
        host: !!js ctx.webStartup.host ?? '127.0.0.1'
        port: !!js ctx.webStartup.port ?? 3080
```

`grep -rln "@deepseek-ai/dsh-host-webserver"` 全仓只有 5 处命中：`dsh-web-app/cordis.patch.yml`、`dsh-web-app/lib/index.js`、`dsh-web-app/lib/startup.js`、`dsh-official-bundles/lib/index.js`（仅元数据）、`dsh-host-directory-picker-auto/lib/index.js`（只是 `ctx.get` 读取）。**`dsh-base` 里没有任何一行挂载它。**

而 `dsh-official-bundles/lib/index.js:3-9` 的 `PROFILE_TEMPLATES` 中，只有 `web` 含 `@deepseek-ai/dsh-web-app`：

```
acp: base + acp-app        web: base + web-app
headless: base + headless  sdk: base + sdk-app      sdk-minimal: sdk-minimal
```

### 2.2 行为证据：激活即监听，没有懒启动开关

`dsh-host-webserver/lib/index.js`：

- `:298-315` `Config`：`host` 必填且经 `parseIpLiteral` 校验，**通配地址直接抛错**（原文：`is an unspecified (wildcard) address, which is not supported: binding every interface would expose remote code execution to the network`）；`port` 必填，max 65535。
- `:457-571` `[Service.init]`：一进来就 `await this.server.listen(this.config.port, this.config.host, cb)`（`:546`），返回的 disposer（`:555-569`）= `server.close()` + `closeAllConnections()` + 销毁 `upgradedSockets`/`tlsConnections`。
- `:363-368` `getOrigin()` 在未 bind 前抛 `webserver: origin read before the listener bound a port`。

### 2.3 唯一性证据：全仓只有一个 `.listen(`

```
dsh-host-webserver/lib/index.js:546          ← 唯一 Web 监听
dsh-experimental-speech-to-text-sensevoice/lib/worker.js:210   （127.0.0.1:0，语音 worker）
dsh-experimental-inspector/lib/worker.js:5254                  （调试用 worker）
```

### 2.4 对 Qt profile 的推论与诚实边界

- `dsh-qt-app/package.json` 的 dependencies 只有 `@deepseek-ai/cordis`、`cordis-plugin-include`、`cordis-plugin-loader`：**不含 `dsh-host-webserver`，也不含 `dsh-web-app`**；仓内没有 `cordis.patch.yml`。→ 以现状启动 Qt profile **不会**监听任何端口，也不会 `spawn` 任何东西（§0.2 已证明无 spawn 代码）。
- 诚实边界：`~/.dsh/profiles/` 下现有 `dsh-tui`、`headless`、`tui`、`web`，**没有 `qt` profile**，因此本机无法实跑验证；上一条是静态推演，不是运行时观测。运行时验证手段见 §10 的 A1 用例（`ss -ltnp` / `netstat -ano` 差集）。

---

## 3. 结论二：三条启动路径与取舍

### 3.1 路径 A：同进程挂载 web-app 行 —— Phase 3 **不采用**

想「Qt 进程内按需起 Web 服务」需要在运行期挂载 `webserver` 行，但：

1. 行激活即 `listen`（`:457-571`），没有 start/stop 方法暴露给外部；
2. `config.host`/`config.port` 是 `Config` 必填项（`:298-315`），Cordis 的 `disabled: !!js ...` 在加载期求值，运行期改不了；
3. `registerFallback` 只有一个座位，二次注册抛 `webserver: fallback already registered`（`:405` 附近）。

→ 结论：同进程方案等于「重启进程」，与「按需」矛盾。记为 **Phase 4 候选**，前置条件是上游提供 lazy 启动 seam（本文不假设它存在）。

### 3.2 路径 B：子进程 `dsh web --port 0 --no-open` —— **推荐**

- `dsh/lib/bin.js:41`：`dsh web` = `dsh --profile web`（`:22` 的 `dsh <name>` 缩写规则）；`desktop` profile 被 CLI 独占拒绝（`:35-36`），与我们无关。
- `dsh-web-app/lib/startup.js:24-36`：`--port 0` 表示「由 OS 选空闲端口」；`--no-open` 抑制自动开浏览器；`--host` 只接受具体 IP 字面量（通配被 `:48` 拒绝）。
- **必须如实标注的代价**：这是**第二个 DSH 进程**，有自己的 Loader 树与内存态 session。它共享 `$DSH_HOME`（sessions 落盘、credentials 记录共享），所以浏览器里能看到历史会话，但**不是当前宿主进程的实时会话**。UI 必须写清这一点，不能让用户以为是「当前对话的 Web 版」。

### 3.3 路径 C：复用外部既有服务 —— 只读发现，绝不接管

- `dsh-web-app/lib/index.js:149-155` 注册 shellEnv `web-runtime`，变量名 `DSH_WEB_URL`（`:37` 常量）。若宿主环境已有该变量，说明外层已经起了 web，直接复用。
- 用户在设置里手填 URL 亦走此路径。
- **认证现实**：launch token 是**每进程随机、WeakMap 缓存、不落盘**的（`dsh-client-connection/lib/index.js:294-300`），所以外部服务的 URL 只能由用户从它自己的 stdout 里复制（含 `?token=`）。我们**不能**凭空构造，也**不能**复用别人进程的 cookie 去开新会话。

优先级：`C（已有 DSH_WEB_URL）> B（spawn 自有子进程）> A（不实现）`。

---

## 4. 状态机

```
                 ┌──────────────────────────────┐
                 │            Idle              │◄──────────────┐
                 └──────┬───────────────────────┘               │
      openWebui()       │                                       │
                        ▼                                       │
                 ┌──────────────┐  已有 DSH_WEB_URL / 手填 URL    │
                 │  Resolving   ├──────────────────► Ready(kind=external)
                 └──────┬───────┘  (probe 2s)                    │
       需 spawn         │                                       │
                        ▼                                       │
                 ┌──────────────┐  spawn 失败                    │
                 │  Spawning    ├──────────────► Failed(spawn)   │
                 └──────┬───────┘                               │
                        │ 拿到 ChildProcess 句柄                 │
                        ▼                                       │
                 ┌──────────────┐  20s 无 "dsh web:" 行           │
                 │ WaitingReady ├──────────────► Failed(ready-timeout)
                 └──────┬───────┘  子进程 exit≠0                 │
                        │ 解析到 ^dsh web: (\S+)$                │
                        ▼                                       │
                 ┌──────────────┐  closeWebui() / 宿主退出        │
                 │    Ready     ├──────────────► Stopping ───────┤
                 └──────┬───────┘                               │
                        │ 子进程意外 exit                        │
                        └──────────────► Failed(child-exit) ─────┘
```

不变量（每一条都要有测试）：

| # | 不变量 | 违反后果 |
|---|---|---|
| I1 | `Ready` 期间最多存在 1 个自有子进程 | 重复点击炸出 N 个 DSH |
| I2 | 状态转移只发生在 `webui` 服务内，QML 只读快照 | QML 侧并发调用竞态 |
| I3 | `Failed` → 重试最多 3 次，退避 1s/2s/4s，之后停在 `Failed(final)` 等人工 | 崩溃循环烧 CPU（团队预算 200%/4G） |
| I4 | token 只存在于 `Ready` 的内存字段，不进 QML property、不进 settings、不进日志 | token 泄露（§7.3） |
| I5 | 只对**自己 spawn 的句柄**发信号（§6） | 误杀外部服务 |
| I6 | 宿主退出/服务 dispose 必须先 `Stopping` 再退出 | 孤儿 DSH 进程占端口 |

---

## 5. 接口签名（Node 侧，草案）

```ts
// src/webui/index.ts —— 新增，属 t5 范围；不触碰 native/ 与 qml/ 既有文件
export type WebuiKind = 'none' | 'own-child' | 'external';

export type WebuiState =
  | { phase: 'idle' }
  | { phase: 'resolving' }
  | { phase: 'spawning'; attempt: number }
  | { phase: 'waiting-ready'; attempt: number; pid: number }
  | { phase: 'ready'; kind: WebuiKind; origin: string; maskedUrl: string; hasWebEngine: boolean }
  | { phase: 'stopping' }
  | { phase: 'failed'; reason: WebuiFailureReason; attempts: number; stderrTail: string };

export type WebuiFailureReason =
  | 'spawn' | 'ready-timeout' | 'child-exit' | 'auth'
  | 'port-in-use' | 'no-webengine' | 'external-unreachable';

export interface WebuiOptions {
  /** 显式复用；缺省读 process.env.DSH_WEB_URL。 */
  readonly reuseUrl?: string;
  /** 就绪超时，默认 20_000ms（Loader settle + audit 可能慢）。 */
  readonly readyTimeoutMs?: number;
  /** 关停宽限，默认 5_000ms，之后 SIGKILL。 */
  readonly stopGraceMs?: number;
  /** 最大自动重试次数，默认 3。 */
  readonly maxRetries?: number;
  /** 探针超时，默认 2_000ms。 */
  readonly probeTimeoutMs?: number;
}

export class WebuiService {
  /** 只读快照；QML 绑定此对象的唯一入口。 */
  get state(): WebuiState;
  /** 能力探测（§8.4）。不改状态。 */
  probe(): Promise<{ available: boolean; kind: WebuiKind; origin?: string; hasWebEngine: boolean }>;
  /** 打开：复用优先，其次 spawn。幂等：Ready 时直接返回当前快照。 */
  open(options?: WebuiOptions): Promise<WebuiState>;
  /** 关闭：只清自有子进程；external 只清引用。 */
  close(): Promise<void>;
  /** 宿主侧拿到的、可交给 Qt 的**一次性** URL（含 token），只经一次 C++ 调用。 */
  takeAuthenticatedUrlForHost(): string | undefined;
  /** 脱敏 URL，可安全进日志/UI：http://127.0.0.1:PORT/?token=*** */
  get maskedUrl(): string | undefined;
  /** 逐槽位回退（§8.5）：返回该 contribution 的宿主 URL，或 undefined 表示不回退。 */
  openSlot(contributionId: string): Promise<string | undefined>;
}
```

`spawn` 的具体形态（实现时的硬约束）：

```ts
const child = spawn(process.execPath /* 或解析到的 dsh bin */, [
  dshBinPath, 'web', '--port', '0', '--no-open',
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: false,                       // 与宿主同进程组，宿主死则随之收尸
  windowsHide: true,
  env: { ...scrubbedParentEnv(), DSH_QT_WEBUI_OWNER: nonce },
});
```

- 用 `process.execPath` + dsh bin 路径，不用裸 `'dsh'`：Windows 上 `spawn('dsh')` 依赖 PATH 与 `.cmd` shim，`shell:true` 会引入命令注入面。
- `env` 必须 scrubbed：官方自己拉浏览器时就是这么做的（`dsh-web-app/lib/index.js:39-99` 用 `scrubbedParentEnv()`），我们照抄这个原则，避免把 Harness 凭据转给子进程的浏览器启动器。
- `DSH_QT_WEBUI_OWNER=<nonce>` 是我们自己的归属标记（§6）。

---

## 6. 自有子进程 vs 外部服务：四条不得违反的规则

1. **只认句柄，不认端口。** 保存 `ChildProcess` 引用；`kill` 前断言 `handle.exitCode === null && handle.pid === recordedPid`。绝不 `kill(port)`、绝不 `pkill dsh`、绝不 `killall node`。
2. **不按名字扫描进程表来"清理"。** 即使扫到同名进程，也无法证明归属 → 一律不动。
3. **外部服务只清引用。** `kind === 'external'` 时 `close()` 只把 state 置回 `idle`，不发任何信号。
4. **端口被占不是错误，是信息。** `--port 0` 由 OS 分配，天然不冲突；若探测到目标端口已有 DSH web（§8.4 指纹），转 `kind:'external'` 复用，而不是杀掉它再抢。

Windows 差异：`child.kill()` 对 `spawn` 出来的 `node` 进程通常够用；若子进程再派生（web 进程本身不派生，`dsh-web-app` 只在 `openBrowser` 时才 spawn 浏览器，而我们传 `--no-open`），才需要 `taskkill /PID <pid> /T`。**`--no-open` 因此是安全属性，不只是体验选项。**

---

## 7. QWebEngine 嵌入 / 浏览器兜底

### 7.1 官方信任链（嵌入时必须原样保留，不得自建认证）

```
spawn → 子进程 stdout 打印 dsh web: http://127.0.0.1:PORT/?token=<launchToken>
        │  token = randomBytes(32)，每进程、WeakMap 缓存、不落盘   (client-connection:294-300)
        ▼
GET /?token=…  → 303 location: "./" + Set-Cookie: dsh-auth-<hash(authority)>
        │  cookie: HttpOnly; SameSite=Strict; Path=/; Max-Age  (client-connection:347-350, 458-497)
        ▼
之后所有 /api 请求 → cookie 验签 + Host/Origin 栅栏            (client-connection:240-250, 546-570)
```

关键点：**token 只在首次 `GET /` 时用一次**，随后由 cookie 接管；`Set-Cookie` 带 `HttpOnly` + `SameSite=Strict`，所以嵌入端**不需要也不应该**读 cookie。

### 7.2 嵌入实现要点（Qt 侧）

- QML 侧新增 `WebEngineView`（`import QtWebEngine`）**仅当** `hasWebEngine === true`；QML 不持有 URL 里的 token（见 §7.3）。
- 必须使用**专用 `QWebEngineProfile`**（非默认 profile），并 `setPersistentCookiesPolicy(NoPersistentCookies)` + 独立 `cachePath`/`storagePath`：让 cookie 存活于本次 WebView 生命周期、退出即清，避免把 `dsh-auth-*` 落到磁盘上被其它进程复用。
- 初始化顺序硬约束：`QtWebEngineQuick::initialize()` 必须在 `QGuiApplication` 构造**之前**调用（Qt 6 要求）。当前 `native/main.cpp:950-981` 是 `QGuiApplication` 先构造，若走 WebEngine 版必须在 `:950` 之前插入，并用 `#ifdef DSH_QT_HAVE_WEBENGINE` 保护。
- 禁止项：不 `setAttribute(Qt::AA_ShareOpenGLContexts)` 之外的额外全局设置；不关闭 `QWebEngineSettings::JavascriptCanOpenWindows` 之外的默认安全项；不注入任何 preload 脚本去读 cookie/token。

### 7.3 token 不泄露（三条落地规则）

1. **token 不进 QML。** QML 属性只暴露 `maskedUrl`（`http://127.0.0.1:PORT/?token=***`）。真实 URL 由 Node 经一次 C++ 调用直接 `load()`，中间不落地为 QML 字符串（QML 属性可被 QML 插件、`console.log`、以及 Qt 的 QML 调试器读到）。
2. **不进 settings store、不进日志、不进剪贴板（自动）。** 若用户点「复制链接」，明确提示「该链接含一次性凭据」，且只复制到剪贴板、不写日志。
3. **退出即失效。** token 随子进程死亡失效；cookie 随 profile 销毁。重开 = 重新 spawn = 新 token。

### 7.4 浏览器兜底（无 WebEngine 构建）

- `QDesktopServices::openUrl(maskedUrlWithToken)`：**这里必须传真 URL**，所以该路径下 token 会经过系统浏览器地址栏——这是用户可见、可接受的（等同于官方 `dsh web` 自己开浏览器），但要在 UI 上写明「链接含一次性凭据，勿分享」。
- 兜底顺序：WebEngine → 系统浏览器 → 只读展示 `dsh web` 命令与提示（都不可用时）。

---

## 8. 与 t3 的接口约定（回应 `PHASE-3-PLUGIN-SDK.md:418-422`）

t3 在 §7.4 提了三个开放问题，本文给出**可执行答案**；§7.3 的三条回退协议（判定点唯一、逐槽位、回退可见）**全部接受**。

### 8.1 WebView 生命周期归谁

> **归 Node 侧 `ctx.qtRenderer.webui`（`WebuiService`，§5）。** Qt 侧只持有一个 `WebEngineView` 视图对象，其生命周期严格绑定 `webui.state.phase`：`ready` 时创建/显示，离开 `ready` 时销毁。QML 不发起 `open/close`，只调用 `webui.open()` / `webui.close()` 的桥接方法，且不做状态推断。

### 8.2 React 18 从哪来

> **不需要我们打包 React。** 回退页打开的是官方 `@deepseek-ai/dsh-web-frontend` 的 dist（已确认存在于 `node_modules/@deepseek-ai/dsh-web-frontend/dist/`：`index.html`、`assets/`、`manifest.webmanifest`），由 `dsh-web-app/lib/index.js:74-82,148` 经 `FrontendStatic` 挂到 webserver 的 fallback 座位。React 版本因此**天然**等于官方 dist 的版本，t3 担心的「模块表不一致」不成立——因为我们不提供模块表，我们只提供一个 URL。

### 8.3 settings store 如何共享

> **不共享内存。** WebView 是另一个 DSH 进程的 UI；内存真相仍在原生 `SettingsStore`（`src/settings/qml-bridge.ts:72-79` 的「exactly one copy of the truth」）。约定：WebView 关闭时，原生侧调用一次 `settings.reload()` 重新读盘；**禁止**双向内存同步、禁止 WebView 侧直接改原生 store。

### 8.4 能力探测 / 导航契约（给 t3 与 t9 冻结用）

```ts
probe(): Promise<{ available: boolean; kind: 'none'|'own-child'|'external'; origin?: string; hasWebEngine: boolean }>
```

探测序列（全部只读、无副作用、**不携带 token**）：

| 步骤 | 请求 | 判定 |
|---|---|---|
| 1 | `GET {origin}/`（2s 超时，无 cookie） | `401` 且 body 含 `dsh web authentication required` → 是 DSH web（指纹来自 `client-connection:571-577`） |
| 2 | 同上 | `200`/`303` → 也是 DSH web（已有 cookie 的浏览器上下文） |
| 3 | `GET {origin}/api/…` | `403` → Host/Origin 栅栏生效（`client-connection:743`），进一步确认是 DSH web 而非别的服务 |
| 4 | 连接被拒 | `kind:'none'` |
| 5 | TLS 证书错误 | 识别为 DSH web，但标 `insecure`，**不自动信任**（官方 `--tls-cert` 是自签场景，见 `startup.js:55`） |

导航契约：`openSlot(contributionId)` 由宿主构造 `<origin>/?token=…`，QML 只负责显示「此面板由 WebView 渲染」徽标（t3 §7.3 第 3 条：回退必须可见）。

拒绝条件（t3 判定，t5 不兜）：插件没有 Web 产物 → t3 直接拒绝，**不调用** `webui.openSlot()`。

---

## 9. 打包依赖、缺 WebEngine 行为、内存测量

### 9.1 CMake 增量（默认 OFF，不影响现有三平台构建）

```cmake
# CMakeLists.txt 新增，紧跟 L29 的 find_package 之后
option(DSH_QT_WEBENGINE "Build the on-demand WebUI panel with Qt WebEngine" OFF)
if(DSH_QT_WEBENGINE)
  find_package(Qt6 6.5 REQUIRED COMPONENTS WebEngineQuick)
  target_compile_definitions(dsh-qt-app PRIVATE DSH_QT_HAVE_WEBENGINE=1)
  target_link_libraries(dsh-qt-app PRIVATE Qt6::WebEngineQuick)
endif()
```

- 现有 `CMakeLists.txt:29` 的 `find_package(Qt6 6.5 REQUIRED COMPONENTS Core Gui Quick Qml QuickControls2)` **不动**：把 WebEngine 放进必填列表会让缺模块的环境直接配置失败，违反「缺 WebEngine 要能降级」。
- QML 侧文件用 `qt_add_qml_module` 已由 GLOB 收集（`:53-83`），WebEngine QML 文件需**条件加入**源列表，否则 `qmllint` 在无 WebEngine 的 runner 上会因 `import QtWebEngine` 失败。

### 9.2 CI 增量（三处，全部在现有 workflow 内）

| 位置 | 现状 | 需要 |
|---|---|---|
| `.github/workflows/build.yml:153-157` | `install-qt-action@v4` + `version: 6.7.3`，**无 `modules:`** | 加 `modules: qtwebengine`（Windows/Linux/macOS 均有该模块） |
| `.github/workflows/build.yml:146-151` | Linux 只装 `libgl1-mesa-dev libxkbcommon-dev libxcb-cursor0 libfuse2 pigz` | 加 Chromium 运行库：`libnss3 libxcomposite1 libxdamage1 libxrandr2 libxtst6 libasound2 libatk1.0-0 libcups2 libdrm2 libgbm1` |
| `.github/workflows/test.yml:258-264, 292-296, 403-407` | 三处 `install-qt-action` 同样无 `modules:` | 至少「WebEngine 冒烟」job 加 `modules: qtwebengine` |

代价提示：WebEngine 让安装体积增加约 1.5–2GB、CI 时长增加数分钟；建议**只在一个专门的 job** 里开 `-DDSH_QT_WEBENGINE=ON`，主矩阵保持 OFF，避免三平台都付这个成本。

### 9.3 缺 WebEngine 的行为（必须可预测）

| 场景 | 行为 |
|---|---|
| 编译期无 WebEngine | `hasWebEngine=false`；WebUI 按钮存在但文案为「在系统浏览器打开」，点击走 §7.4 兜底 |
| 运行期 WebEngine 初始化失败（如 Linux 缺 libnss3） | 捕获 → `Failed(no-webengine)`，提示缺失库名，**不崩溃**、不静默 |
| root/容器内 Chromium sandbox 失败 | 仅开发/CI 允许 `QTWEBENGINE_DISABLE_SANDBOX=1`；**发布版不得默认设置** |
| 插件要求 WebView 但 `hasWebEngine=false` | `openSlot()` 返回 `undefined`，由 t3 显示「本构建不支持」——不是静默空白 |

### 9.4 内存测量方案（团队预算 200%/4G 下的必测项）

三组采样，单位 RSS，采样 60s 间隔 1s，取峰值与稳定值：

| 组 | 组成 | 采集方式 |
|---|---|---|
| G0 | 宿主 Node + Qt 基线 | Linux `/proc/<pid>/status` 的 `VmRSS`；Windows `GetProcessMemoryInfo` |
| G1 | G0 + `dsh web` 子进程（浏览器用系统浏览器） | 同上，加子进程 pid |
| G2 | G1 + 内嵌 QWebEngine | 需同时统计 `QtWebEngineProcess` 子进程（Chromium 多进程） |

判定阈值（草案，需实测校准）：`web` 子进程常驻 >150MB 或 QWebEngine 合计 >300MB → 在 UI 上提示「WebUI 占用较高」；宿主总内存超 4G 预算 → CI 失败（对齐团队「重型工作共享 CPU200%/4G」的约束）。

---

## 10. 验收矩阵

状态：**全部为待实现用例**（本文只读，未启动任何服务器）。每条给出可观测判据与验证手段。

| ID | 场景 | 期望 | 判据 / 手段 |
|---|---|---|---|
| A1 | 冷启动（未打开 WebUI） | 无监听、无子进程 | 启动前后 `ss -ltnp`（Linux）/ `netstat -ano`（Windows）差集为空；进程树无 `dsh web` |
| A2 | 冷启动首次 `open()` | `idle→resolving→spawning→waiting-ready→ready`，kind=own-child | 状态序列快照；`maskedUrl` 形如 `http://127.0.0.1:<port>/?token=***`；真实 URL 只在 `takeAuthenticatedUrlForHost()` 出现一次 |
| A3 | 重复点击 `open()` ×5 | 仍只有 1 个子进程（I1） | 进程树计数 = 1；状态在首次 `ready` 后不再转移 |
| A4 | 关闭 WebUI | `ready→stopping→idle`，子进程退出 | 进程树无 `dsh web`；端口释放（`ss` 不再列出） |
| A5 | 认证失败 | `Failed(auth)`，不自动重试 | 用错误 token 请求 `/` → 401 + `dsh web authentication required`（`client-connection:571-577`）；UI 提示「重新从宿主启动」 |
| A6 | 保留外部服务 | `kind=external`，关闭后外部服务仍存活 | 预置一个 `dsh web --port 1234`；`open()` 复用；`close()` 后该进程仍在、端口仍在监听 |
| A7 | 端口占用 | 不杀占用者 | 用 `--port <被占端口>` 直接 spawn 的负例：应失败为 `Failed(port-in-use)`，占用进程存活 |
| A8 | 子进程崩溃 | `Failed(child-exit)`，退避重试 ≤3 | 手动 kill 子进程 → 状态与重试计数；第 4 次不再重试 |
| A9 | 就绪超时 | `Failed(ready-timeout)`，子进程被清理 | 注入一个不打印 `dsh web:` 的假子进程 → 20s 后状态与清理 |
| A10 | 无 WebEngine 构建 | 按钮降级为系统浏览器 | `hasWebEngine=false`；点击后 `xdg-open`/`start` 被调用，无崩溃 |
| A11 | 宿主退出 | 子进程随之退出（I6） | 宿主 `SIGTERM` 后 5s 内进程树清空 |
| A12 | token 不泄露 | 日志/设置/QML 无 token | 全量日志 grep `token=` 仅命中脱敏串；QML 属性 dump 无真 token |

---

## 11. 未决与风险（如实记录）

1. **进程拓扑未定（§0.2）**：`native/main.cpp` 独立可执行 vs 设计稿「同进程 N-API」，且仓内无 spawn 者。本文的回退设计在两种拓扑下都成立（owner 在 Node 侧），但「谁启动 Qt 进程」必须由 t1/t8 在宿主接口里定死，否则 A1/A11 无法验收。
2. **本机无 `qt` profile**：无法实跑「默认无监听」，只能静态推演 + A1 用例兜底。
3. **WebEngine 打包成本**：三平台都开会让 CI 时长与体积显著上升；建议单 job 验证（§9.2）。
4. **同进程按需起服务不可行**（§3.1）：若产品上坚持「零外部进程」，需要上游提供 lazy webserver seam，属跨仓库依赖，本文不承诺。
5. **`--port 0` 与 `DSH_WEB_URL` 的播报时序**：URL 只有在 Loader 树 settle + audit 通过后才打印（`dsh-web-app/lib/index.js:171-176`），插件树越大越慢；20s 超时是估计值，需在真实 profile 上校准。
