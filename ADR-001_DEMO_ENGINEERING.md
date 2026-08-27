# ADR-001：P0 Demo 工程基础选型

> 状态：已接受（2026-08-26；同日修订：E-04 projections 复合主键与 reconciliation 执行者、E-06 重定向实现约束、E-08 path 解码顺序、E-09 离屏写规则与 clone 脱敏的冲突修复）。本 ADR 完成 `READ_ONLY_BROWSER_OBSERVER_SPEC.md` §15 授权的"第一个工程 ADR"四项实现型选择：桌面壳与语言、Native Host 打包、ModelAdapter provider、敏感词表 v1 与静态扫描/canary 工具。所有决策不扩大 `P0_DEMO_SCOPE.md` 的产品边界；若与规范冲突，以规范为准并回改本文件。

## 0. 决策总表

| ID | 决策 | 状态 |
|---|---|---|
| E-01 | TypeScript 单语 monorepo（pnpm workspace），Extension 与桌面端共享契约包 | 接受 |
| E-02 | 桌面壳采用 Electron；Demo 阶段 Windows x64 单目标 | 接受 |
| E-03 | Native Host 先验证复用主 Electron exe 的单 exe 双模式；使用 Chrome 启动参数 + stdio 管道联合识别，失败则进入独立 host 可执行文件的替代 ADR；host 逻辑独立成包、无状态、幂等 | 接受（带验证门）→ **验证门未通过，已由 [ADR-002](ADR-002_NATIVE_HOST_REPLACEMENT_DRAFT.md) 取代（2026-08-26 批注，用户授权）** |
| E-04 | 存储：better-sqlite3 + WAL + 应用数据目录下的 blob 目录；SQLite 事务维护索引与引用，blob 走同卷暂存 + 原子 rename，并用启动 reconciliation 收敛文件系统与数据库的不原子窗口 | 接受 → **引擎由 [ADR-003](ADR-003_STORE_FILE_SYSTEM.md) 取代为纯文件系统（2026-08-27 批注，用户批准）：行为语义不变，better-sqlite3 因 Electron-as-Node 与纯 Node 双 ABI 打包风险后置** |
| E-05 | demo-projector-v1 的 DOM 解析用 linkedom，离线、禁网络；夹具证明不足时回退 jsdom | 接受 |
| E-06 | ModelAdapter 按 OpenAI-compatible Chat Completions 设计；baseUrl/apiKey/model 全部来自环境变量；优先 `response_format=json_schema`，降级 `json_object`；本地 zod 二次校验失败关闭 | 接受 |
| E-07 | Token 估算确定性公式：`ceil(ASCII 码点数 / 4) + 非 ASCII 码点数`；四个上限独立生效，任一超限要求缩小 scope | 接受 |
| E-08 | 敏感拦截词表 `sensitive-v1`：path 按 URL 段精确匹配（非子串）、域名种子 denylist、query 凭证参数清洗、内容密钥模式替换；fail-closed | 接受 |
| E-09 | 静态扫描用 eslint `no-restricted-syntax` 规则集 `sift-readonly`；mutation canary 用 Playwright persistent context 加载扩展 | 接受 |

## 1. E-01/E-02：技术栈与桌面壳

### 决策

- 全栈 TypeScript。Extension、service worker、Native Host、桌面 UI、Store、projector 共享 `packages/shared` 中的消息契约与常量，消除两套语言间的 schema 漂移。
- 桌面壳 Electron。理由：
  1. content script 无论如何需要 JS/TS 工具链，单语栈最小化 Demo 摩擦；
  2. Native Host 优先验证复用主 exe（见 E-03），验证通过时不需要第二条可执行构建链；
  3. `demo-projector-v1` 依赖成熟的离线 DOM 解析生态（linkedom/jsdom）；
  4. "简单桌面窗口/托盘面板"是 Electron 默认能力，不需要原生 UI 投入。
- Demo 只面向 Windows x64，不做签名、安装器与自动更新（D-049）。

### 被否决的备选

| 备选 | 否决原因 |
|---|---|
| Wails (Go) | 双语言栈；Go 的离线 DOM 解析生态弱；Native Host 需要独立 exe 构建链 |
| Tauri (Rust) | Demo 阶段 Rust 学习/调试成本高，收益为零 |
| 纯 Node CLI（无桌面壳） | 规范要求预览确认 UI、状态显示与 Sources 展示，不可省 |

### Repo 结构

```text
e:\sift-ai
├── AGENTS.md / P0_DEMO_SCOPE.md / *.md     # 现有规范保留在根目录
├── ADR-001_DEMO_ENGINEERING.md
├── apps/
│   ├── extension/        # MV3：content script、service worker、manifest、demo key
│   └── desktop/         # Electron main（含 native-host 模式分支）+ 窗口/托盘 UI
├── packages/
│   ├── shared/          # Envelope/消息 zod schema、limits 常量、Token 估算
│   ├── host/            # Native Messaging 协议：分块、hash、幂等 commit（纯逻辑，不依赖 Electron UI）
│   ├── store/           # better-sqlite3 + blob 目录、TTL/配额、Page State reducer
│   └── projector/       # demo-projector-v1（linkedom，离线）
├── fixtures/            # 固定网页夹具 + 期望 DemoEvidenceProjection + 敏感词正反例
├── tools/               # eslint sift-readonly 规则、canary 脚本、开发脚本（注册 host 等）
└── pnpm-workspace.yaml
```

构建：Extension 用 esbuild 产出固定 bundle（content script 零运行时依赖）；桌面端开发期 `electron .`，产出期 `electron-builder --dir` 得到未安装的 `win-unpacked/Sift.exe`。

## 2. E-03：Native Host = 主 exe 双模式

> **[2026-08-26 批注]** 本节双模式方案已被 [ADR-002](ADR-002_NATIVE_HOST_REPLACEMENT_DRAFT.md) 取代：spike 实测打包 exe 的 GUI 引导在任何用户代码之前向 stdout 无条件写入 2 字节垃圾（`0d 0a`），且主进程 Node 层 stdio 与 fd 重定向均不可用——按本节预设的失败出口，host 改为 `SiftHost.cmd → ELECTRON_RUN_AS_NODE=1 → Sift.exe resources\host-main.js`（同一发布物、同一二进制，`packages/host` 契约不变）。三条件联合判定、失败关闭、无状态幂等、canary 覆盖等约束全部由 ADR-002 继承。以下原文保留作为决策历史。

### 约束回顾

Chrome 在 Windows 上的 Native Messaging host manifest `path` 只能指向一个可执行文件，**不能携带命令行参数**；host manifest 放在 `HKCU\Software\Google\Chrome\NativeMessagingHosts\` 下，`allowed_origins` 固定为 demo key 推导的 Extension ID（规范 D-049 已冻结）。

### 决策与验证门

- host manifest 的 `path` 在验证阶段指向打包产物 `Sift.exe`。Chrome Native Messaging 会把调用方 origin 作为 host 的第一个应用参数，并在 Windows 追加十进制 `--parent-window=<handle>`；这两个参数是 host 模式的主要身份信号，stdio 只作为联合校验，不能单独决定模式。main 进程必须在获取 Electron 单实例锁之前判定运行模式：

```text
若且仅若同时满足：
  1. 第一个应用参数严格等于 demo key 推导出的唯一 allowed origin；
  2. 存在格式合法的 --parent-window=<非负十进制整数>；
  3. stdin/stdout 可用、均为非 TTY 的管道；
  -> 进入 host headless 模式：不创建 BrowserWindow、不初始化 UI、
     不获取单实例锁，只挂载 packages/host 协议层 + packages/store
否则
  -> 正常桌面应用（单实例锁）
```

任一 host 条件不满足时必须失败关闭或按正常桌面应用启动，不能因为单实例锁冲突而回退到 host 模式。host 模式的 stdout 只允许写 Native Messaging 的长度前缀帧；诊断输出只能进入 stderr 或经过脱敏的本地日志，禁止 `console.log` 污染协议流。

Bitwarden 只能作为“桌面应用与浏览器扩展通过 Native Messaging 集成”的产品级先例，不能作为本方案“主 Electron exe 直接承载 stdio host”的实现证明；其当前实现使用独立 `desktop_proxy`。Chrome 的参数约定见 [Native Messaging protocol](https://chromium.googlesource.com/chromium/src.git/+/HEAD/chrome/common/extensions/docs/templates/articles/nativeMessaging.html)，Bitwarden 当前代理路径见 [native-messaging.main.ts](https://github.com/bitwarden/clients/blob/main/apps/desktop/src/main/native-messaging.main.ts)。

- **host 必须无状态、幂等**：MV3 service worker 休眠会断开 native port，Chrome 随之终止 host 进程；`connectNative` 重连会重新拉起 exe。所有状态只存在于 SQLite，commit 协议按规范幂等（重复 chunk/commit 不产生副作用）。
- 开发期迭代：`electron-builder --dir` 产物注册给 Chrome；断开重连即重启 host，代码改动后重新 `--dir` 构建（秒级）。不追求热替换。

### 风险与注意

| 风险 | 处理 |
|---|---|
| host 模式误判 | origin + `--parent-window` + stdio 三条件联合且失败关闭；canary 覆盖正常启动、二次启动、重定向启动、伪造 origin、主 app 运行中授权和断线重连 |
| 每个 connectNative 拉起一个完整 Electron 进程（约 100-200 MiB） | Demo 可接受；host 模式禁止加载渲染进程与 UI 资源 |
| 与 UI 模式同时写 SQLite | WAL + `busy_timeout` + `BEGIN IMMEDIATE`；host 只追加 Observation，UI 读写投影，所有写入仍通过同一 Store 事务约束 |

步骤 1 必须先用打包后的 `Sift.exe` 完成一个限时 spike：在桌面 UI 已运行和未运行两种状态下，连续完成至少 100 次 connect/disconnect 与 framed message round-trip，证明无窗口、无 stdout 污染、模式无误判且内存可接受。若未通过，E-03 自动停止，不继续为单 exe 增加启发式；另开替代 ADR 选择独立轻量 host 可执行文件，`packages/host` 协议和 Store 契约保持不变。

### 被否决的备选

| 备选 | 否决原因 |
|---|---|
| Node SEA / pkg 打包独立 host exe | 多一条可执行构建链；Node SEA 对原生模块（better-sqlite3）支持不成熟 |
| `.bat` wrapper 启动 node 脚本 | Chrome 对 bat wrapper 的引号/编码行为不可靠，社区坑多 |

## 3. E-04：存储实现

> **批注（2026-08-27）**：本节描述的 SQLite 实现由
> [ADR-003](ADR-003_STORE_FILE_SYSTEM.md) 在 P0 阶段取代为纯文件系统实现
> （host 是唯一写者，无需 SQLite writer lock 串行化）；下述表结构与事务语义
> 作为后续替换引擎时的目标设计保留。

规范已冻结 SQLite + blob 目录 + 事务 + 原子 rename（`P0_DEMO_SCOPE.md` §2.3）。本 ADR 补实现选择：

- **better-sqlite3**（同步 API，无驱动进程），Electron 侧用 `electron-rebuild` 对齐 ABI；host 模式与 UI 模式共用同一 native module。打包时必须 `asarUnpack` 该原生模块——native module 不能从 asar 内加载，且 Chrome 启动 host 时的工作目录不受控，模块路径必须按 app 根解析为绝对路径。
- `PRAGMA journal_mode=WAL`、`PRAGMA busy_timeout=5000`；所有会改变引用、配额或 Page State 的写入使用 `BEGIN IMMEDIATE`，让多个 Electron 进程按 SQLite writer lock 串行化。
- 表（v1，均带 `schemaVersion`）：

```text
observations     Envelope 全字段 + payloadRef/payloadHash（dom_snapshot 等）
page_states      pageInstanceId PK, stateVersion, lastAppliedSequence, blobRef, title, safeUrl, ...
sessions         sessionId PK, createdAt, pageRefs（Demo 手动加入/移除）
blobs            hash PK, bytes, refCount, createdAt     # refCount 支撑删除时引用计数回收
blob_refs        ownerType, ownerId, hash, UNIQUE(ownerType, ownerId, hash)
projections      (kind, inputHash) 复合 PK；kind ∈ demo_evidence|question|answer
```

- `blobs.refCount` 是 `blob_refs` 中实际 ownership edge 数量的事务内缓存；每个引用插入/删除必须与 Observation/Page State 变更处于同一事务，并用唯一约束保证幂等。启动审计发现计数不一致时，从 `blob_refs` 安全重算，不能信任漂移的缓存值继续删除。
- `projections` 的唯一键是 `(kind, inputHash)`：同键命中即幂等复用（对应规范"键完全相同则直接复用"）；demo_evidence/question/answer 的输入哈希即使数值相同也互不覆盖，不能用裸 `inputHash` 做主键。
- 写入顺序：先把完整 payload 写到最终 blob 目录同一卷内的 `.staging/<uuid>`，校验长度与 hash 并 flush；随后 `BEGIN IMMEDIATE`，在事务内完成幂等检查和 TTL/配额复核。若目标 hash 尚不存在，原子 rename 到 `blob-dir/<hash[0:2]>/<hash>`；若已存在，则验证现有文件并删除 staging。然后插入 blob/ref、Observation 并 replace Page State，最后 commit。
- 文件系统 rename 与 SQLite commit 不能伪装成同一个原子事务。进程若在 rename 后、commit 前退出，只会留下无数据库引用的最终 blob；启动 reconciliation 在宽限期后删除“文件存在但无 blob/ref 记录”的孤儿文件。若数据库引用的文件缺失或 hash 不符，则标记 `store_corrupt` 并失败关闭，不能把该 Page State 提供给 projector。reconciliation 只在桌面 UI 模式启动时执行；host 模式跳过，保持轻量并避免与并发捕获事务竞争。
- TTL（7 天）/配额（Session 250 MiB、全局 1 GiB）的最终判定在同一个 `BEGIN IMMEDIATE` 事务中完成；超限按规范回滚、清理 staging、暂停新捕获并要求用户删除，不自动删未过期 Session。
- 删除 Page/Session：事务内删除 ownership edge、更新 `refCount` 并 commit；归零 blob 的物理文件只在 commit 后删除。崩溃最多留下无引用文件，由同一 reconciliation 收敛——即规范允许的“Demo Store 引用计数生命周期”，不宣称实现 P0.5 可达性 GC。

## 4. E-05：demo-projector-v1 的 DOM 解析

- **linkedom**：轻量、快、无网络能力，满足 `demo-projector-v1` 用到的选择器集（`main`、`article`、`[role=article]`、`hidden/aria-hidden` 属性、tag 遍历、cloneNode）。
- 解析前按规范禁用一切外部资源加载（linkedom 本身不发起网络）；输入永远是已脱敏的持久化 HTML。
- 夹具回归若发现选择器/解析缺口（linkedom 的 CSS 支持弱于浏览器），回退 **jsdom**（更重但完整）；两者都只允许作为离线依赖出现在 `packages/projector`。
- 输出严格按 `P0_DEMO_SCOPE.md` §2.4 的六步规则与 `DemoEvidenceBlock` schema；`projection_empty` 不包装 Raw outerHTML。

## 5. E-06/E-07：ModelAdapter 与 Token 估算

### ModelAdapter

- 接口唯一，实现可替换：

```ts
completeAnswer(input: {
  question: string
  blocks: DemoEvidenceBlock[]      // 已按 E-07 上限整体通过
  schema: AnswerProjectionSchema
}): Promise<AnswerProjection>
```

- 传输：**OpenAI-compatible Chat Completions**（`baseUrl + apiKey + model` 全部来自进程环境变量：`SIFT_MODEL_BASE_URL` / `SIFT_MODEL_API_KEY` / `SIFT_MODEL_ID` / `SIFT_MODEL_CTX`）。不在本 ADR 押注单一厂商；任何兼容端点（OpenAI/DeepSeek/GLM/Moonshot/本地网关均可）只要支持结构化 JSON 输出即可作为开发期 provider。
- JSON 约束两级：优先 `response_format: { type: 'json_schema', json_schema: { name: 'answer_projection', strict: true, schema: <AnswerProjection JSON Schema> } }`；端点明确不支持时降级 `{ type: 'json_object' }` 并把 schema 注入 system prompt。`promptVersion = answer-v1` 版本化。
- `SIFT_MODEL_BASE_URL` 必须解析成固定 origin；远程端点只允许 `https:`，仅 `localhost`、`127.0.0.1`、`[::1]` 本地网关允许 `http:`。HTTP redirect 一律拒绝，避免 API Key 或投影被转发到未预览的 origin；实现上必须关闭 SDK 的自动重定向跟随（如 fetch `redirect: 'manual'`），任何 3xx 按失败处理。确认 UI 展示最终 provider origin、model 和数据范围。
- 本地 zod 校验为最终关卡：非法 JSON、未知 blockId、空引用、重复 ID、超长字段、HTML/脚本输出 → 整次失败，允许一次确定性重试，仍失败按规范显示真实错误。**API Key 永不持久化、永不出现在日志与投影**（D-051）。

### Token 估算（确定性，进入 inputHash 语义）

```text
estimateTokens(text) = ceil(ASCII 码点数 / 4) + 非 ASCII 码点数
```

- CJK 每码点按 1 token 计（UTF-8 下 3 字节 ≈ 1 token，为保守上界）；ASCII 按 4 字符/token。纯函数、无 tokenizer 依赖、跨机器一致。
- 四上限独立生效、全量或不发送：`20 Pages / 200 Blocks / 512 KiB UTF-8 / min(32,000, modelContextWindow − 8,000)`。任一超出 → `scope_too_large`，UI 要求用户减少页面；不截断、不抽样。

## 6. E-08：敏感拦截词表 sensitive-v1

fail-closed 原则：命中即拒绝并提示；未命中不代表安全，UI 仍要求用户只选公开非敏感页面（规范原文语义）。规则版本化，配正反例夹具。

### 6.1 URL path 段匹配（非子串）

按 `/` 切段，段值与词表**精确匹配**（避免 `auth` 误伤 `authors`、`sign` 误伤 `design`）：

```text
login  signin  sign-in  sign_in  signup  register  auth  authenticate
authorization  authorize  oauth  oauth2  sso  sessions  session
password  forgot-password  reset  verify  verification  2fa  mfa
account  accounts  settings  security  credentials
billing  payment  payments  pay  checkout  cart  order  orders
invoice  invoices  wallet  subscription  subscribe  transactions
```

- `settings/account` 有误伤（如博客 `/settings/appearance`）；Demo 选择宁可拒绝（误伤代价 = 换个页面，漏报代价 = 隐私事件）。
- 匹配大小写不敏感；必须**先对整个 path 做一次百分号解码、再按 `/` 切段比对**——先切分后解码会漏掉 `%2F` 编码的敏感段（如 `/auth%2Flogin`）。

### 6.2 域名种子 denylist（后缀/子域匹配）

```text
mail.google.com  mail.qq.com  mail.163.com  mail.sina.com.cn  mail.126.com
outlook.live.com  outlook.office.com  proton.me  protonmail.com  mail.proton.me
gmail.com  icloud.com  mail.icloud.com
drive.google.com  docs.google.com          # 登录态文档，保守拒绝
pay.weixin.qq.com  alipay.com  paypal.com
```

无法枚举网银/医疗站；由 path 规则 + UI 明示边界兜底。用户可在 Demo 中追加（追加项持久化在本地配置，不回写词表版本）。

### 6.3 query 参数清洗（保存前从 URL 移除参数名）

```text
token  access_token  refresh_token  id_token  auth  authorization
sig  signature  session  sessionid  session_id  sid  code   # code: OAuth 授权码
api_key  apikey  key  secret  password  passwd  pwd  jwt
```

`utm_*` 等追踪参数不属于凭证，保留（来源分析可用）。清洗后的 URL 即 `safeUrl`。

### 6.4 内容密钥模式（clone sanitizer 内文本替换为 `[REDACTED:secret]`）

```text
AKIA[0-9A-Z]{16}                          AWS access key
sk-[A-Za-z0-9_-]{20,}                     OpenAI/DeepSeek 风格 key
(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}   GitHub legacy token
github_pat_[A-Za-z0-9_]{20,}                GitHub fine-grained token
xox[baprs]-[A-Za-z0-9-]+                  Slack token
AIza[0-9A-Za-z_-]{35}                     Google API key
eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+  JWT（完整三段）
-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----
Bearer\s+[A-Za-z0-9._-]{20,}
```

### 6.5 夹具（进入 `fixtures/sensitive/`）

正例：`/blog/authors` 通过、`?utm_source=x` 保留、正文含满足最小长度的 `sk-...` 被替换、完整三段 JWT 被整体替换、`?token=abc` 清洗。
反例：`/auth/login` 拒、`/payments/history` 拒、`mail.google.com` 拒、`?code=oauthgrant` 清洗后仍因 path 规则拒绝的组合场景。

## 7. E-09：静态扫描与 mutation canary

### 7.1 eslint `sift-readonly` 规则集（`tools/eslint-sift-readonly`）

用 `@typescript-eslint` + `no-restricted-syntax`/`no-restricted-globals` 声明规则，对 content script **源码与 esbuild 产物**都运行。规则分两层，因为"按 API 名称一律禁止 DOM 写"会让 `P0_DEMO_SCOPE.md` §2.2 要求的"先克隆并脱敏"（对 clone 删除 script、表单值、敏感属性）在静态规则下不可实现：

```text
第一层：全局副作用与网络能力——任何接收者一律禁止：
  document.write / writeln                 window.open
  eval / new Function                      fetch / XMLHttpRequest / WebSocket / EventSource /
                                           navigator.sendBeacon
  页面 postMessage                         chrome.storage 之外的 chrome.* 能力

第二层：DOM 写按接收者判定——
  接收者或根是 document / documentElement / body / head / window 全局时禁止：
    appendChild / insertBefore / replaceChild / append / prepend / before / after /
    replaceWith / remove / removeChild / setAttribute / removeAttribute /
    classList.add|remove|toggle / element.style.* 赋值 / insertAdjacentHTML /
    element.innerHTML|outerHTML 赋值 / scrollTo / scrollBy / scrollIntoView /
    focus / blur / location 赋值 / location.assign|replace /
    history.pushState|replaceState
  允许的离屏写：接收者是 cloneNode / importNode / createDocumentFragment 返回值
  （或其作用域内可追踪别名）的子树操作——这是 sanitize 清洗克隆树的唯一合法写路径。

放行的读取：getElementBy* / querySelector(All) / textContent / innerText 读取、
MutationObserver 构造与 observe / disconnect、chrome.runtime.sendMessage / connect、
chrome.storage（仅最小授权/重连状态）。
```

AST 无法完全判断节点连接性，因此划界标准是"接收者是否为 document 系全局或可追踪的 clone 子树"，而不是 API 名称本身；clone 引用一旦逃逸出可追踪作用域（存入全局、作为消息 payload 回传后再写）即超出静态规则能力，由 canary 的页面 subtree hash 断言兜底。规则命名导出为可复用 shareable config，`pnpm lint:ast` 失败即 CI 失败。

### 7.2 Playwright mutation canary（`tools/canary`）

- `chromium.launchPersistentContext` + `--disable-extensions-except` + `--load-extension` 加载打包后的扩展；MV3 service worker 需要 headed 或 Chrome 109+ 的 new headless 模式（旧 headless 不加载扩展）。
- 受控夹具页自带观察脚本：页面侧 MutationObserver 记录一切 DOM 变化并维护 subtree hash；测试另采样 `document.activeElement`、`scrollX/Y`、`document.hasFocus()`。
- 流程：加载页面 → 采样基线 → 触发扩展授权（action 点击）→ 捕获若干 snapshot → 断言：
  1. 页面 subtree hash 与基线一致（content script 不得在页面 DOM 留任何标记）；
  2. 焦点、滚动位置、焦点状态不变；
  3. 无页面 console error；
  4. 断开授权/关闭 Tab 后 observer 与 port 清理（无泄漏定时器导致的后续 mutation）。
- `pnpm test:canary` 映射验收门 #4；静态扫描映射验收门 #2/#3 的机器可查部分。

## 8. 验收门落点对照

| `P0_DEMO_SCOPE.md` §6 | 支撑决策 |
|---|---|
| #1 可复现安装/构建/测试/卸载 | E-01 repo 结构 + `tools/` 开发脚本（注册/注销 host manifest） |
| #2/#3 manifest 与注入边界 | E-09 eslint 规则集 |
| #4 静态扫描 + canary | E-09 |
| #5 捕获行为（debounce/latest-wins/hash） | E-03 host 幂等 + E-04 blob 复用 |
| #6 敏感脱敏 | E-08 |
| #7 Native Messaging 失败关闭 | E-03 host 协议包 |
| #8 投影确定性 | E-05 + E-07 估算公式 |
| #9/#10 零 AI 调用与超限 | E-06/E-07 |
| #11 AnswerProjection 校验 | E-06 zod 终关卡 |
| #12 夹具回归 | `fixtures/`（projector + sensitive） |

## 9. 交付顺序（映射先前建议的六步）

1. repo 骨架 + 构建 + `tools/` 注册脚本（本 ADR 全部落地物）；
2. Extension：manifest/demo key + content script（sanitize/serialize/readable-v1）+ eslint 规则就位；
3. host 模式 + 分块协议 + SQLite Store：端到端冒烟 = 静态页 → 落盘 → 读回 → 幂等重放；
4. demo-projector-v1 + QuestionProjection + 预览 UI + Token 预算；
5. ModelAdapter + AnswerProjection 验证器 + Sources；
6. 15 项验收门 + 夹具全量回归 → 内部演示。

步骤 3 是风险最高的结合部（MV3 service worker 休眠 × native port 生命周期 × SQLite 并发），最先打通且最先写 canary。

## 10. 本 ADR 未决定的事项（保持开放）

- 开发期具体接哪家模型端点（E-06 的环境变量方案使其无需在此冻结）；
- 正式分发、签名、安装器（P0.5）；
- linkedom → jsdom 是否需要回退（由夹具回归结果触发，触发时以修订记录形式更新本节）。
