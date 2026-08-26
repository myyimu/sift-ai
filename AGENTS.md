# Sift AI / 只读浏览器观察器：AI 编码契约

## 适用范围

- 本文件只约束 **Sift AI / 只读浏览器观察器** 相关工作。
- 项目根目录是 `E:\sift-ai`。父目录 `E:\` 含有其他既有项目；除非用户明确指定，绝不修改、移动或删除这些兄弟目录中的内容。
- 当前 P0 Demo 的唯一范围见 `P0_DEMO_SCOPE.md`；Extension 架构见 `P0_EXTENSION_ARCHITECTURE.md`；连续捕获的数据模型见 `CAPTURE_ARCHITECTURE.md`；P0.5 内容身份模型见 `P0_ANALYSIS_UNIT_SPEC.md`；P0.5 分级抽取器见 `P0_UNIT_EXTRACTOR_SPEC.md`；P0.5 第二界面主题云见 `P0_TOPIC_CLOUD_SPEC.md`；完整产品背景见 `READ_ONLY_BROWSER_OBSERVER_SPEC.md`；Demo 工程选型见 `ADR-001_DEMO_ENGINEERING.md`。实现前依次阅读本文件和这八份文档。
- 若需求与本文冲突，不得静默折中；应指出冲突并等待用户确认。任何产品边界变更都要同步修改相关文档。

## 产品北极星

> 人负责访问互联网，AI 负责高速阅读、聚合和发现信号；人拥有浏览器、访问权与数据，AI 只有被授予的最小读取权。

产品最终希望把用户已进入但来不及逐条阅读的信息，从“1000 条内容”压缩成“真正值得亲自看的少数内容”，并提供可回到原网页的证据。

它不是浏览器 Agent、爬虫、自动化工具、截图 OCR 工具，也不是第一天就建设的通用 RAG 平台。

## 已冻结的产品交互形态

以下是 P0.5 及后续产品形态，不是当前 Demo 的交付范围。当前 P0 只提供简单桌面窗口/托盘面板、当前页面或小型 Session 选择、自由提问、回答与 Sources；不得为了展示最终形态提前实现桌宠或 Topic Cloud。

产品最终形态是一个克制的桌宠式 AI 信息雷达入口，而不是永久占据浏览器空间的固定侧边栏：

- 平时以低存在感的小眼睛、光球、信号接收器或极简机器人停靠在屏幕边缘；
- 头顶对话气泡轮换展示 2-3 个推荐问题；
- 点击气泡或桌宠后展开约 380px 的本地 Chat 面板；
- Chat 面板显示回答、来源卡片和自由提问输入框；
- 第二入口“主题地图”打开桌面端 Topic Cloud，用于查看所选时间范围内的主题总览；
- 收起后浏览器继续是主角，桌宠不得遮挡关键页面内容。

桌宠承担三种职责，但必须在语义和视觉上区分：

```text
Question Launcher：展示可以问的问题
Signal Notifier：展示已有证据支持的真实信号
AI Reader：用户点击或自主提问后展示回答与来源
Topic Overview：用户主动生成主题云后展示当前本地捕获范围的主题与来源
```

### 气泡问题不是提问白名单

- 气泡问题来自一个版本化的预设 Prompt Pool，P0.5 可包含 6-10 个问题。
- 预设问题只负责降低“我可以问什么”的认知成本，绝不限制用户自主提问。
- 展开面板必须始终提供自由文本输入；用户可提出任何基于已捕获内容的问题。
- P0.5 点击预设问题与提交自主问题走同一条 Retrieval + LLM 分析链路；当前 Demo 走显式 scope + bounded QuestionProjection，不做语义 Retrieval。
- 不得把预设问题做成唯一入口、分类白名单、意图过滤器或功能权限边界。

### 问题选择不使用实时 LLM

- P0.5 可随机、轮换或按廉价 Session metadata 规则选择气泡问题。
- 选择条件可使用捕获数量、同站点比例、评论数量、页面数量和 Session 时长。
- 生成/选择气泡不得为了“看起来有上下文”而把全部捕获内容实时交给 LLM。
- P0.5 只有用户点击预设问题或提交自主问题后，才允许按需运行 Retrieval + LLM；当前 Demo 还必须先预览并确认远程处理。
- 预设问题不得伪装为系统已经发现的事实；“发现新话题”等 Signal 文案必须有真实分析结果和证据 ID 支持。

### 第二界面是 Topic Cloud，不是词频词云

- 桌宠提供 `[问 AI] [主题地图]` 两个并列入口，自由提问始终保留。
- Topic Cloud 只描述用户选择的本地捕获范围，不得扩大成“互联网/社区整体正在讨论什么”。
- 节点必须是可理解、可区分并绑定来源的主题，不得直接放大 `AI/用户/代码/开发/模型` 等通用高频词。
- P0.5 只有用户点击“生成/更新主题图”后才允许运行一次按需主题归纳；后台捕获、打开桌宠和气泡轮播不能触发。
- 节点大小只表示去重后的 CanonicalUnit 数；重复观察/重访、多版本、Page/Domain、EvidenceBlock 数、mutation 数、字符数和原始词频不得增加大小。
- 距离只有在存在明确关系度量时才表示相关；P0.5 默认使用共同 CanonicalUnit 的 Jaccard overlap，并在 UI 解释其含义。
- P0.5 不显示 `NEW`、升温、下降或趋势；这些需要稳定主题身份与历史基线。
- 点击主题必须展示 Topic Detail 与 Sources；没有有效 CanonicalUnit/EvidenceBlock reference 的主题不得显示。
- 生成前计算去重 Unit、页面、字节和预计 Token；超过 P0.5 上限时要求缩小范围，不得静默截断或抽样后声称覆盖完整范围。
- 完整数据契约、缓存、布局与测试以 `P0_TOPIC_CLOUD_SPEC.md` 为准。

### 桌宠必须克制

- 不到处移动、不高频动画、不连续弹窗、不拟人卖萌过度；
- 气泡切换使用低频、平静节奏，并支持暂停、关闭、减少动态效果；
- Always-on-top 必须可选，桌宠必须可拖动、收起和静音；
- 最终产品状态可区分空闲、正在捕获和已验证信号；P0.5 仍只能显示授权、捕获、存储、分析和错误状态，不得显示主动 Signal；
- “AI 不主动操控浏览器”不等于“AI 永不主动发现”，但主动提醒必须低打扰、可关闭、可追溯。

该交互形态是产品基线，不改变下面的工程阶段门。不得以“先做桌宠”为由跳过可靠捕获与 Markdown 数据层。

## 当前工程里程碑 P0：Extension DOM Capture + 有界问答 Demo

只实现下面这条纵向链路：

```text
用户在自己的 Chrome 中主动授权当前 Tab
  -> MV3 Extension 注入固定 ISOLATED content script
  -> 初始 DOM Snapshot + MutationObserver
  -> 200ms debounce + 2000ms maxWait 合并变化
  -> Native Messaging
  -> 本地 Observation Store / Page State
  -> 用户选择当前页面或小型 Demo Session
  -> 确定性 DemoEvidenceProjection / QuestionProjection
  -> 用户预览并确认远程处理范围
  -> AI -> AnswerProjection 校验 -> Answer + Sources
```

当前阶段包含：

- Windows-only 内部 Demo；unpacked Extension + 手动注册 Native Host；
- 用户继续使用自己的 Chrome，不启动新 Profile；但 Demo 只允许公开、非敏感页面，不支持登录后台或敏感内容；
- Manifest V3 Extension 使用 `activeTab + scripting`，仅在用户手势后读取当前主 frame；
- 固定 content script 在 `ISOLATED` world 中读取 DOM，并用 `MutationObserver` 被动检测变化；
- 页面可读即产生初始 Snapshot，不等待网络空闲或“页面完全稳定”；
- mutation trigger 立即记录；200ms debounce + 2000ms maxWait 后生成新的全 document Raw Snapshot；
- Snapshot 在发送前脱敏、hash，相同内容复用 blob；
- content script 通过 service worker 与 Native Messaging 把数据交给桌面 Capture Store；
- 本地 Observation Log、内容寻址 Snapshot blob、replace 型 Page State；
- 用户明确选择当前页面或最多 20 个页面的小型 Demo Session；
- 确定性构建最多 200 个、512 KiB、预计最多 32k Token 的 DemoEvidenceBlock；任一上限超出就要求缩小 scope；
- 简单桌面窗口/托盘面板显示授权、捕获、预览、暂停、删除、自由输入、Answer 与 Sources；
- 只有用户提交问题、预览投影并确认远程处理后才调用 AI；
- AnswerProjection 的每个 claim 必须引用当前 QuestionProjection 内至少一个 DemoEvidenceBlock；
- 明确错误、诊断信息、隐私过滤与安全测试。

当前阶段不包含：

- CDP、`chrome.debugger`、remote debugging port/pipe、专用 Chromium；
- AX Tree、DOMSnapshot、viewport/注意力判定；
- XHR/Fetch 监听与响应体保存；
- FTS、Embedding、RAG、MCP；
- 后台 LLM 清洗、总结、Embedding、聚类、热点、趋势或弱信号分析；
- 站点 Adapter、自动翻页、自动滚动、自动点击或自动访问 URL。
- UnitObservation / CanonicalUnit / UnitVersion / DerivedMetadata、Session Unit Ledger、Global Unit Index、Canonical merge 和可达性 GC；
- Semantic -> Repeated Structure -> Main Content 完整 UnitExtractor；
- TopicProjection、Topic Cloud、Topic Detail、主题缓存和关系布局；
- 桌宠、气泡轮播、Always-on-top、跨显示器停靠和完整动效；
- 登录后台、支付、身份认证、医疗、金融、邮箱、私信、编辑器等敏感页面；
- 正式安装器、Chrome Web Store、自动更新、多平台和 optional host permission。

完整范围、预算、QuestionProjection/AnswerProjection 和验收门以 `P0_DEMO_SCOPE.md` 为准。不要因为 P0.5 架构已经写在设计规范中，就提前实现未来阶段。

## P0.5 内容身份模型与 UnitExtractor 契约

本节不属于当前 Demo 实现范围。进入 P0.5 前必须遵守下面的长期契约，并先解决 Observation、Evidence 与 Version 的所有权关系。

```text
Page（页面容器）
└── UnitObservation[]（不可变捕获事实，含 captureExtent）
    ├── UnitObservationSourceLink[]（追加来源，不改写 Observation）
    ├── SourceMetadataSnapshot（每次观察的 title/author/time）
    └── EvidenceBlock[]（Observation-owned occurrence）
        └── EvidenceBlob（正文按 textHash 去重）
        ↓ 身份消解
CanonicalUnit（Topic 最小统计单位，可 mergedInto）
├── UnitVersion[]（由 full Observation link 支撑，引用而非持有正文）
└── DerivedMetadata（type + parserVersion，解释层）
```

- Observation ≠ Entity ≠ Source Version ≠ Interpretation；四个概念不得混用。
- `DerivedMetadata.type` 只允许 `article | content | comment | unknown`；低置信分类必须使用 `unknown`。
- UnitExtractor 只在桌面端对已脱敏离线 DOM 异步运行，不能阻塞 Raw Capture。
- 拆分顺序固定为：Semantic HTML/ARIA/mapped Schema.org -> Repeated Structure -> Main Content fallback。
- `<article>`/`role=article` 是高置信候选；`role=feed` 是容器；`li/listitem` 必须继续通过列表和独立阅读过滤。
- 无法映射回 DOM 的 JSON-LD 只能补充 metadata，不能凭空拆出 Unit。
- 重复结构至少要求同父级 3 个 eligible sibling，fingerprint 和置信阈值必须版本化、确定性并受资源上限约束。
- 只有达到 `splitThreshold` 才拆；低置信不拆，不得为了数量降低门槛。
- 接受嵌套子 Unit 后，父 Unit ownContent 必须剔除子 Unit；一个 EvidenceBlock 在一次结果中只能属于一个 Unit。
- Semantic/Repeated 拆分失败时，允许 Defuddle/Readability 对离线克隆、去噪主内容生成一个 `main_content_fallback` Unit；不得无条件包装整个 Raw Page。
- Readability 会修改传入 DOM，只能处理独立离线克隆；DOM 脚本和资源加载保持关闭。
- 身份优先级：Unit 自身 permalink -> namespaced anchor `(origin, canonicalPageUrl, stableAnchor)` -> 不强行合并；相同稳定文本不构成合并依据，相同短文本必须保持两个对象。
- `captureExtent` 区分 partial/full/unknown，默认 unknown；partial 不产生 UnitVersion；Feed 卡片到详情页是 extent 变化，不是内容编辑。
- UnitVersion 只由两次可比较 full 观察经稳定化后确实不同产生；点赞数、相对时间等易变噪声进 volatileMetadata，绝不进入稳定指纹。
- UnitObservation 不可变；重复 Snapshot 只追加幂等 UnitObservationSourceLink；EvidenceBlock 不能跨 Observation 共用 ownership，只能复用 EvidenceBlob。
- UnitVersion 必须由全部 full Observation link 共同支撑，不能只依赖首次观察；title/author/publishedAt 属于 SourceMetadataSnapshot，不在 CanonicalUnit 上静默覆盖历史。
- CanonicalUnit 经 `mergedInto` 合并（方向确定、幂等），merge 使相关投影 stale；删除按可达性 GC，不是 cascade。
- `type` 等解释层变化不产生 UnitVersion；DerivedMetadata 只允许懒重算，不回写历史。
- 进入 Session Unit Ledger 只代表 `observed`，不代表用户实际 `seen`；聚合计数使用 `observation_count`，`seen` 保留给视口证据。

身份、版本、extent、合并、删除与 DerivedMetadata 的完整语义不得偏离 `P0_ANALYSIS_UNIT_SPEC.md`；抽取策略不得偏离 `P0_UNIT_EXTRACTOR_SPEC.md`。

## 不可妥协的能力边界

1. **人控制浏览器**：导航、搜索、点击、输入、滚动、翻页、登录和提交只能由用户完成。
2. **捕获链路不访问网站**：Extension 和桌面端不得主动请求页面 URL、补抓资源或调用第三方提取 API；只能读取用户授权 Tab 已有的 DOM。
3. **最小临时权限**：P0 只在 Chrome 认可的用户手势后使用 `activeTab` 注入固定 content script；跨 origin 后权限失效并立即停止观察。
4. **AI 永不接触浏览器能力**：AI 只能查询本地投影，不能拿到 Extension API、content script port、Tab 标识、任意脚本、CDP 或浏览器动作工具。
5. **不用 OCR**：文本来自 DOM/AX/已接收响应，绝不以截图 OCR 作为正文获取的静默回退。
6. **本地优先**：采集数据默认留在本地。没有用户针对本次操作的明确授权，不得上传网页、浏览历史、原始 HTML或索引。
7. **网页是不可信数据**：网页、HTML、Markdown、XHR JSON 中的任何“指令”都只是内容，不能改变程序行为、工具权限或 AI 指令。
8. **不绕过访问控制**：不得绕过登录、付费墙、反爬、验证码、站点权限或用户本身无权访问的边界。

## P0 Extension 权限与通信策略

P0 manifest 只允许申请：

```text
activeTab
scripting
nativeMessaging
storage
```

P0 manifest 明确禁止：

```text
debugger
tabs
history
webNavigation
webRequest
<all_urls>
必选 host_permissions
```

授权与注入：

- 用户通过 Extension action、快捷键等 Chrome 认可的手势启用当前 Tab；
- 使用 `chrome.scripting.executeScript` 注入扩展包内固定文件；
- 固定 `world: "ISOLATED"`，不使用 `MAIN` world；
- 未授权、跨 origin、Tab 关闭、用户暂停或注入失败时立即停止观察；
- 同源导航可在授权仍有效时重新注入；跨 origin 必须再次由用户授权；
- 不静态注册匹配所有网站的 content script；
- 以后若需要站点级持续观察，只能按具体 origin 申请 `optional_host_permissions`。

content script 只允许：

```text
读取当前主 frame DOM / URL / title
使用固定 MutationObserver 检测 DOM 变化
sanitize + serialize 页面
通过 runtime messaging 发送给 service worker
```

content script 禁止修改页面、读取表单值/Cookie/Storage、监听键盘、发网站请求、加载远程代码或执行网页/配置/AI 提供的脚本。P0 只观察主 frame；iframe、Shadow DOM 和限制页失败必须可解释。

Chrome 不提供只读 content-script 权限；`activeTab + scripting` 技术上能修改共享 DOM。不得声称这是浏览器物理强制的只读沙箱。AI 必须与注入入口物理隔离，content-script bundle 必须固定、尽量零依赖，并通过 AST 禁止规则和“页面无 Extension 写入”的集成 canary 证明只读行为。

Extension 与桌面端默认通过 Native Messaging：

```text
content script
  -> runtime message
service worker
  -> runtime.connectNative()
native host
  -> Local Capture Store
```

- native host `allowed_origins` 固定为正式 Extension ID；
- 所有消息验证 schema、版本、长度、hash、顺序和调用 origin；
- Raw Snapshot 分块传输，重复提交幂等并支持背压/断线恢复；
- `chrome.storage` 只保存最小授权/重连状态，不保存 Raw DOM；
- P0 不开放 localhost HTTP/WebSocket 采集端口。

未来只有 AX/XHR 等价值被真实验证后才可评估 `chrome.debugger`。它不能声明为 optional permission，因此不得预埋进 P0；优先评估单独的 Advanced Capture 伴生扩展。即使进入 P1，仍需精确只读 CDP gateway，且不得恢复外部调试端口。

完整 P0 约束见 `P0_EXTENSION_ARCHITECTURE.md`。

## 实现边界

- P0 由 Manifest V3 Extension、Native Messaging host、桌面服务/UI 组成；捕获接口必须与具体 transport 解耦。
- Extension 只注入扩展包内固定的 ISOLATED content script；页面、配置、桌面端和 AI 均不能提供可执行代码。
- content script 只采集和脱敏；service worker 只做授权状态、消息验证与转发；长期存储、投影和 AI 调用只在桌面端。
- 当前 Demo 使用 `P0_DEMO_SCOPE.md` 的 `demo-projector-v1`，不依赖 Defuddle/Readability。P0.5 候选正文提取器是 `defuddle/node`，只接收已经捕获的 HTML/DOM：
  - 必须显式设置 `markdown: true`；
  - 必须显式设置 `useAsync: false`；
  - 不得把 URL 交给 CLI 或任何会自行下载页面的 API；
  - 空结果返回明确的 `EXTRACTION_EMPTY`，不得偷偷联网、调用 LLM 或 OCR 回退。
- 数据平面必须确定、可重放、无需 LLM：捕获、归并、清洗、投影、元数据、哈希和保存都由程序完成。
- Demo 数据模型是版本化 Observation Log + 可重建的 Materialized Page State；不得把 Markdown、QuestionProjection 或 AnswerProjection 当作捕获数据库或唯一事实源。
- 原始 payload 可以短期保留，但必须有 TTL、配额、压缩、脱敏和一键删除；P0.5 再引入长期 checkpoint/compaction 与完整可达性 GC。
- DemoEvidenceProjection、QuestionProjection 和 AnswerProjection 都是可删除、可重建的派生物，必须记录输入 `stateVersion`/sequence 范围、投影版本和来源引用。
- `200ms` debounce + `2000ms` maxWait 只用于合并 MutationObserver trigger 和安排 Raw Snapshot，捕获热路径不得运行 Defuddle、Embedding 或 LLM。
- MutationRecord 是 dirty trigger/provenance，不是精确 DOM patch；新 snapshot 必须替换当前状态，使新增、修改、删除、移动和新 document 都能正确反映。
- URL 不能作为页面实例主键；至少使用 `sessionId + tabId + pageInstanceId + contentEpoch + sequence` 建立身份和顺序。
- 保存采用安全文件名和原子写入；失败时不留下看似成功的半文件。
- 不声称“支持所有网站”。iframe、Shadow DOM、Canvas、虚拟列表和复杂 SPA 无法可靠提取时，应返回可解释的限制。

## Demo Evidence / Markdown 投影契约

必须保留：

- 标题层级、段落、列表、链接、引用、表格、代码块；
- 图片的 `alt` 与解析后的来源 URL；
- 页面标题与可追溯的安全 URL。

必须去除或不保存：

- 脚本、样式、导航、广告、按钮噪声、页脚与跟踪像素；
- Cookie、Authorization、LocalStorage、密码字段、请求头和表单秘密；
- URL 中已知的令牌、签名、会话和授权参数。

P0 Demo 的规范 AI 输入以 `P0_DEMO_SCOPE.md` 的 `QuestionProjection` 为准。若为调试导出 `page.md`，最小 frontmatter 为：

```yaml
---
schema_version: 1
id: "capture-id"
page_instance_id: "page-instance-id"
state_version: 7
projection_version: 1
title: "页面标题"
url: "https://example.com/safe-url"
site: "example.com"
captured_at: "2026-08-26T09:30:00+08:00"
content_hash: "sha256:..."
extractor: "defuddle"
---
```

- `captured_at` 使用带时区的 ISO 8601。
- `content_hash` 对规范化后的 Markdown 正文计算，不包含会变化的捕获时间。
- 未知元数据保持缺失，不编造作者、发布时间或站点字段。
- 同一输入状态与投影版本必须生成稳定正文和哈希；重复投影应能被识别，但不得在未告知用户的情况下覆盖既有证据。
- Markdown 不得反向覆盖 Observation Log 或 Page State。

## 隐私与不可信输入

- P0 使用用户自己的 Chrome，不启动专用 Chromium，也不开放 remote debugging port/pipe；但 Demo 只允许用户选择公开、非敏感页面，不支持登录后台或其他敏感内容。
- 默认不在无痕窗口运行或保存；file、浏览器内部页和其他限制 scheme 未获明确支持时直接拒绝。
- activeTab 授权、观察中、跨域撤销、暂停和 Native Host 断线必须是不同 UI 状态。
- 默认提供暂停观察、域名排除、最近捕获预览、删除单条/全部数据。
- HTML 解析、YAML、文件名与日志都按敌对输入处理，防止路径穿越、YAML 注入、日志注入和超大输入耗尽资源。
- 对 HTML、Markdown 和未来的网络响应设置大小、深度、时间与并发上限。
- 日志不得记录网页正文、令牌、Cookie、Authorization 或完整敏感 URL。

## 测试要求

当前 P0 Demo 只有通过 `P0_DEMO_SCOPE.md` §6 的 15 项验收门才算完成，至少包括：

1. Manifest 测试：P0 只含 `activeTab`、`scripting`、`nativeMessaging`、`storage`；禁止 `debugger`、`tabs`、`history`、`webNavigation`、`webRequest`、`<all_urls>` 和必选 host permission。
2. 授权测试：未发生用户手势不能读取页面；同源导航可继续，跨 origin、Tab 关闭和权限撤销后立即停止并更新 UI。
3. 注入测试：只注入固定 ISOLATED content script；不存在 MAIN world、远程代码、动态代码字符串或页面 DOM 修改。
4. 捕获测试：首屏达到可读阈值后立即 Snapshot；后续 MutationObserver trigger 经 debounce/maxWait 归并且相同 hash 不重复保存 blob。
5. Native Messaging 测试：origin、schema、分块、hash、顺序、重复提交、断线、重连和背压均失败关闭且幂等。
6. 投影夹具：文章、列表、表格、代码块、引用、图片、噪声区块和恶意 prompt 文本均有固定输入与期望 DemoEvidenceProjection。
7. 确定性测试：同一 `stateVersion` 与投影版本多次生成相同 blocks、顺序和 `inputHash`。
8. 安全测试：表单/contenteditable、路径穿越标题、恶意 YAML、超大 DOM、敏感 URL 参数和网页内指令不会突破边界。
9. 资源测试：高频变化页面和超大消息受 backpressure、TTL、分块和配额限制。
10. AI 成本测试：用户未提交自由问题、预览范围并确认远程处理时，AI 调用次数为零；Capture 始终为零。
11. 问答测试：QuestionProjection 超限时要求缩小 scope；AnswerProjection 每个 claim 都引用 scope 内有效 DemoEvidenceBlock；非法 JSON、悬空引用和 HTML/脚本输出失败关闭。
12. 失败测试：Native Host 未运行、注入失败、权限失效、空正文、写盘失败和模型失败均返回明确状态，不伪造成功。

进入 P0.5 后还必须恢复并通过以下测试；它们不得提前扩入 Demo：

13. Prompt Pool、自主提问、Question/Signal 分型和桌宠交互测试。
14. TopicProjection、Topic Cloud 视觉语义、范围、缓存、Sources 和可访问性测试。
15. CanonicalUnit、完整 UnitExtractor、嵌套、fallback、Ledger/GC、身份、版本和 DerivedMetadata 测试。

不得为了让测试通过而放宽允许列表或删除安全断言。

## 变更完成标准

交付前必须：

- 说明本次变更是否触及产品/安全边界；
- 运行与改动匹配的测试、类型检查和 lint；若项目尚无命令，不得编造成功记录；
- 报告未覆盖的网页类型与已知限制；
- 确认没有无关文件、秘密、网页正文或浏览数据进入版本控制；
- 若引入生产依赖，记录用途、许可证、联网行为和为何现有代码不足。

## 必须暂停并请求用户决定的情况

- 需求要求自动点击、滚动、翻页、导航、输入、提交、下载或主动抓取；
- 需要新增 Extension permission、host permission、跨 frame 访问、MAIN world 或远程代码；
- 需要引入 `chrome.debugger`、CDP、外部调试端口、Fetch/Network 观察；
- 需要读取 Cookie、Authorization、LocalStorage、表单值、密码或完整请求体；
- 需要上传或远程处理捕获数据；
- 需要把 XHR 中“浏览器获得但用户未看到”的数据描述为“用户所见”；
- 需要把当前 P0 扩展为桌宠、完整 Unit 身份、Topic Cloud、MCP、RAG、Embedding、后台总结/聚类、热点、趋势或弱信号分析；这些都属于 P0.5 或更后阶段。
- 需要把预设气泡问题改成实时 LLM 生成，或把它们用作限制用户自主提问的白名单。
- 需要在 UnitExtractor 中加入 LLM/Embedding、站点 Adapter、页面联网、未版本化启发式，或改变 type/split/fallback/嵌套/合并规则。
- 需要变更身份键优先级、UnitVersion 判定、captureExtent、Canonical merge 或删除 GC 语义。
