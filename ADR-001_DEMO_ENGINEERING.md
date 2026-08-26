# ADR-001：P0 Demo 工程基础选型

> 状态：已接受（2026-08-26）。本 ADR 完成 `READ_ONLY_BROWSER_OBSERVER_SPEC.md` §15 授权的"第一个工程 ADR"四项实现型选择：桌面壳与语言、Native Host 打包、ModelAdapter provider、敏感词表 v1 与静态扫描/canary 工具。所有决策不扩大 `P0_DEMO_SCOPE.md` 的产品边界；若与规范冲突，以规范为准并回改本文件。

## 0. 决策总表

| ID | 决策 | 状态 |
|---|---|---|
| E-01 | TypeScript 单语 monorepo（pnpm workspace），Extension 与桌面端共享契约包 | 接受 |
| E-02 | 桌面壳采用 Electron；Demo 阶段 Windows x64 单目标 | 接受 |
| E-03 | Native Host 复用主 Electron exe（单 exe 双模式，Bitwarden 模式）；host 逻辑独立成包、无状态、幂等 | 接受 |
| E-04 | 存储：better-sqlite3 + WAL + 应用数据目录下的 blob 目录；事务包索引与 blob 引用，blob 走临时文件 + 原子 rename | 接受 |
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
  2. Native Host 可以复用主 exe（见 E-03），不需要第二条可执行构建链；
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

### 约束回顾

Chrome 在 Windows 上的 Native Messaging host manifest `path` 只能指向一个可执行文件，**不能携带命令行参数**；host manifest 放在 `HKCU\Software\Google\Chrome\NativeMessagingHosts\` 下，`allowed_origins` 固定为 demo key 推导的 Extension ID（规范 D-049 已冻结）。

### 决策

- host manifest 的 `path` 指向打包产物 `Sift.exe`。main 进程启动时判定运行模式：

```text
若检测到 native messaging 环境（stdin 为管道而非 TTY）
  -> 进入 host headless 模式：不创建 BrowserWindow、不初始化 UI、
     只挂载 packages/host 协议层 + packages/store
否则
  -> 正常桌面应用（单实例锁）
```

这是 Bitwarden 桌面版大规模验证过的架构（Electron 桌面应用同时充当浏览器扩展的 native messaging host）。

- **host 必须无状态、幂等**：MV3 service worker 休眠会断开 native port，Chrome 随之终止 host 进程；`connectNative` 重连会重新拉起 exe。所有状态只存在于 SQLite，commit 协议按规范幂等（重复 chunk/commit 不产生副作用）。
- 开发期迭代：`electron-builder --dir` 产物注册给 Chrome；断开重连即重启 host，代码改动后重新 `--dir` 构建（秒级）。不追求热替换。

### 风险与注意

| 风险 | 处理 |
|---|---|
| host 模式误判（stdin 检测失败） | 兜底：单实例锁冲突时也尝试 host 模式；canary 测试覆盖"主 app 运行中 + 页面授权"场景 |
| 每个 connectNative 拉起一个完整 Electron 进程（约 100-200 MiB） | Demo 可接受；host 模式禁止加载渲染进程与 UI 资源 |
| 与 UI 模式同时写 SQLite | WAL + 立即事务；host 只追加 Observation，UI 读写投影 |

### 被否决的备选

| 备选 | 否决原因 |
|---|---|
| Node SEA / pkg 打包独立 host exe | 多一条可执行构建链；Node SEA 对原生模块（better-sqlite3）支持不成熟 |
| `.bat` wrapper 启动 node 脚本 | Chrome 对 bat wrapper 的引号/编码行为不可靠，社区坑多 |

## 3. E-04：存储实现

规范已冻结 SQLite + blob 目录 + 事务 + 原子 rename（`P0_DEMO_SCOPE.md` §2.3）。本 ADR 补实现选择：

- **better-sqlite3**（同步 API，无驱动进程），Electron 侧用 `electron-rebuild` 对齐 ABI；host 模式与 UI 模式共用同一 native module。
- `PRAGMA journal_mode=WAL`；单写多读。
- 表（v1，均带 `schemaVersion`）：

```text
observations     Envelope 全字段 + payloadRef/payloadHash（dom_snapshot 等）
page_states      pageInstanceId PK, stateVersion, lastAppliedSequence, blobRef, title, safeUrl, ...
sessions         sessionId PK, createdAt, pageRefs（Demo 手动加入/移除）
blobs            hash PK, bytes, refCount, createdAt     # refCount 支撑删除时引用计数回收
projections      kind(demo_evidence|question|answer), inputHash PK, payload, createdAt
```

- 写入事务：`INSERT observation + upsert blob refCount` 单事务；blob 文件先写 `blob-dir/tmp-<uuid>` 再 `rename` 到 `blob-dir/<hash[0:2]>/<hash>`，事务提交失败时删除孤儿 tmp。
- TTL（7 天）/配额（Session 250 MiB、全局 1 GiB）在事务前检查；超限按规范暂停新捕获并要求用户删除，不自动删未过期 Session。
- 删除 Page/Session：事务内减 `refCount`，归零的 blob 物理删除——即规范允许的"Demo Store 引用计数生命周期"，不宣称实现 P0.5 可达性 GC。

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
- JSON 约束两级：优先 `response_format: { type: 'json_schema', strict: true }`；端点不支持时降级 `{ type: 'json_object' }` 并把 schema 注入 system prompt。`promptVersion = answer-v1` 版本化。
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
- 匹配大小写不敏感；段做百分号解码后再比对。

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
ghp_|gho_|ghu_[A-Za-z0-9]{30,}            GitHub token
xox[baprs]-[A-Za-z0-9-]+                  Slack token
AIza[0-9A-Za-z_-]{35}                     Google API key
eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.?      JWT
-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----
Bearer\s+[A-Za-z0-9._-]{20,}
```

### 6.5 夹具（进入 `fixtures/sensitive/`）

正例：`/blog/authors` 通过、`?utm_source=x` 保留、正文含 `sk-xxxx` 被替换、`?token=abc` 清洗。
反例：`/auth/login` 拒、`/payments/history` 拒、`mail.google.com` 拒、`?code=oauthgrant` 清洗后仍因 path 规则拒绝的组合场景。

## 7. E-09：静态扫描与 mutation canary

### 7.1 eslint `sift-readonly` 规则集（`tools/eslint-sift-readonly`）

用 `@typescript-eslint` + `no-restricted-syntax`/`no-restricted-globals` 声明黑名单，对 content script **源码与 esbuild 产物**都运行：

```text
禁止（写/副作用/网络/动态代码）：
  document.write / writeln                 element.innerHTML|outerHTML 赋值
  insertAdjacentHTML                       appendChild / insertBefore / replaceChild /
                                           append / prepend / before / after / replaceWith /
                                           remove / removeChild          # 接入或改动共享 DOM
  setAttribute / removeAttribute           classlist.add|remove|toggle
  element.style.* 赋值                     scrollTo / scrollBy / scrollIntoView / focus / blur
  window.open                              location 赋值 / location.assign|replace
  history.pushState / replaceState         fetch / XMLHttpRequest / WebSocket / EventSource /
                                           navigator.sendBeacon
  eval / new Function                      页面 postMessage

允许（只读与离屏准备）：
  cloneNode / importNode / createDocumentFragment   # 离屏克隆，不接入 document
  getElementBy* / querySelector(All) / textContent / innerText 读取
  MutationObserver 构造与 observe / disconnect
  chrome.runtime.sendMessage / connect
  chrome.storage 读写（仅最小授权/重连状态）
```

AST 无法判断"节点是否已连接到 document"，因此接入类 API 一律禁止（含对离屏节点的接入），clone 类只读操作放行；剩余盲区由 canary 兜底。规则命名导出为可复用 shareable config，`pnpm lint:ast` 失败即 CI 失败。

### 7.2 Playwright mutation canary（`tools/canary`）

- `chromium.launchPersistentContext` + `--disable-extensions-except` + `--load-extension` 加载打包后的扩展。
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
