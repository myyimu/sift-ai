# Sift AI：只读浏览器观察器产品与工程规范

> 状态：产品/工程基线草案  
> 日期：2026-08-26  
> 工作名：Sift AI（可更名；产品语义优先表达“筛选信号”，AI 是实现方式）
> 当前里程碑：P0 内部 Demo，以 `P0_DEMO_SCOPE.md` 为唯一范围；桌宠、完整 Unit 身份和 Topic Cloud 已降级到 P0.5。

## 1. 文档目的

本文总结“设计只读浏览器观察器”会话中的共识，并把讨论补全为可供人和 AI 共同执行的产品与工程基线。

本文回答四个问题：

1. 产品究竟解决什么问题；
2. 哪些原则不能因实现方便而改变；
3. 当前 P0 做什么、不做什么；
4. 后续能力按什么顺序演化和验证。

根目录 `AGENTS.md` 是精简编码约束；`P0_DEMO_SCOPE.md` 定义当前纵向 Demo；`P0_EXTENSION_ARCHITECTURE.md` 定义当前浏览器接入；`CAPTURE_ARCHITECTURE.md` 定义 Store 与投影；`P0_ANALYSIS_UNIT_SPEC.md`、`P0_UNIT_EXTRACTOR_SPEC.md`、`P0_TOPIC_CLOUD_SPEC.md` 定义 P0.5 的长期 Unit 和主题能力；本文提供完整产品背景。如果表述不同，以 `P0_DEMO_SCOPE.md`、更严格的安全边界和较新的冻结决策为准。

## 2. 会话结论摘要

### 2.1 起点：只读 Browser Observer

最初设想是一套本地桌面应用，通过 CDP 连接 Chromium：

- 用户负责所有浏览、点击、滚动、搜索和翻页；
- 工具读取 DOM、AX 和浏览过程中已经发生的 XHR/Fetch；
- 工具不截图 OCR，不主动请求网站，不操控浏览器；
- 本地 MCP 把结构化内容提供给 AI；
- 定位不是爬虫或 Browser Agent，而是“人上网，AI 消化人已带到面前的信息”。

### 2.2 产品价值重新校准

讨论一度把重点放在 Personal Web Repository 和历史召回，随后明确修正：

1. **第一价值：阅读带宽放大**——一批内容快速压缩成主题、观点和少数值得亲自看的原文；
2. **第二价值：变化与弱信号**——依靠历史基线判断什么正在升温、首次出现或跨来源扩散；
3. **第三价值：历史召回**——找回用户曾看过的内容，是本地 Repository 的附加价值，不是首个产品卖点。

因此产品核心不是“更强的浏览历史”，而是：

> 把用户能访问但来不及读完的互联网，变成持续更新、可追溯的信息雷达。

### 2.3 最终分工

```text
人：选择信息源、登录、搜索、筛选、翻页、判断结论
浏览器：完成真实网站兼容并获得页面数据
数据平面：只读捕获、确定性清洗、标准化、存储、检索
AI：在用户选择的证据范围内聚类、比较、提炼和解释
```

一句话：

> 人负责 Access，AI 负责 Comprehension。

### 2.4 当前落地决定

讨论最终主动收敛到第一件可验证的小事：

> 用户在自己的 Chrome 中主动授权公开、非敏感的当前 Tab；轻量 Extension 读取并脱敏 DOM，通过 Native Messaging 保存到本地。用户选择当前页面或小型 Demo Session，预览 QuestionProjection 并确认远程处理后，才调用 AI 生成带 claim-level Sources 的回答。

P0 不使用专用 Chromium、remote debugging port、CDP 或 `chrome.debugger`，也不做 XHR response、RAG、Embedding、后台总结/自动聚类、趋势或主动 Signal。当前只包含 Windows 内部 Demo、简单窗口/托盘面板、自由提问、Answer 与 Sources。桌宠、完整 Unit 身份/版本、Global Unit Index 和 Topic Cloud 属于 P0.5。

### 2.5 产品交互形态补充

P0.5 的产品界面从“固定侧边栏”收敛成桌宠式信息雷达：

- 桌宠以极低存在感停靠在屏幕边缘；
- 头顶气泡展示当前条件下适合询问的问题；
- 点击后展开约 380px 的回答面板，显示回答与 Sources；
- 桌宠平时是 Question Launcher，存在真实信号时是 Signal Notifier，展开后是 AI Reader；
- 它采用桌宠的交互形式，但视觉上必须克制、专业，不能做成高频打扰的陪伴型宠物。

这里同时冻结一个重要机制：气泡使用 **预设问题池 + 廉价规则选择**，而不是让 LLM 实时阅读全部内容后生成问题。气泡只是推荐入口，展开面板必须始终允许用户自由提问；预设规则不得成为问题白名单。

P0.5 的第二个界面是 **Topic Cloud（主题云）**，而不是传统高频词词云：

```text
桌宠
├── 问 AI：预设问题 + 自由提问
└── 主题地图：今天 / 7 天 / 30 天的 Topic Cloud
```

主题云回答“我在所选本地捕获范围内最近主要接触了什么”。节点是 `Vibe Coding`、`大型项目维护`、`Agent Memory` 这类可追溯主题，而不是 `AI`、`用户`、`代码` 等通用高频词。用户明确点击生成/更新后才进行一次主题归纳；点击节点进入 Topic Detail 和 Sources。P0.5 不在后台刷新，也不显示 `NEW`、升温、下降或趋势。

## 3. 问题与目标用户

### 3.1 要解决的问题

- 人的阅读速度慢，面对论坛热榜、评论、Issue、垂直社区时只能逐条扫读；
- AI 读取和跨内容归纳很快，但常受 API 缺失、登录、JavaScript 渲染、长尾网站和爬虫限制影响；
- 用户本来可以正常进入这些信息空间，Chromium 也已经完成了页面兼容和数据获取；
- 缺少的是一层把“用户已进入的信息空间”转成可审计、可检索、可供 AI 理解的本地数据层。

### 3.2 优先用户

- 研究人员、创业者、产品经理、开发者；
- 投资、咨询、分析、市场与竞争情报人员；
- 内容创作者、SEO 与需要跨社区查找信号的人；
- 需要在复杂后台中只读分析、但不允许 AI 操作生产系统的团队。

普通“总结当前文章”不是主战场，现有替代方案太多。

## 4. 产品定义与非目标

### 4.1 产品定义

Sift AI 是一个 local-first、human-guided 的 Web Intelligence Layer：

- 用户决定信息来源和分析范围；
- 应用只消费浏览器已经获得的数据；
- 本地 Repository 保存规范内容与证据；
- AI 只读取当前问题必要的最小证据；
- 输出结论时保留来源、时间、链接与可回查证据。

### 4.2 北极星体验

```text
用户进入一个社区并手动翻若干页
  -> 系统记录这一批允许分析的内容
  -> 用户打开主题地图，看到当前范围的主要主题
  -> 用户点击主题查看对应来源，或继续向 AI 提问
  -> AI 输出主题、争议与少数值得亲自阅读的原文
  -> 每条给出原因和证据链接
```

推荐不应只是“热度最高 5 条”，而应覆盖不同价值：代表性、新颖性、信息密度、反方观点、正在升温、与用户当前研究目标相关。

### 4.3 明确非目标

- 不替用户决定访问哪里；
- 不自动点击、翻页、滚动、搜索、输入或提交；
- 不做伪装成人类浏览器的批量爬虫；
- 不绕过权限、验证码、付费墙或站点限制；
- 不把 CDP、MCP、RAG 当成面向用户的价值描述；
- 不承诺覆盖整个互联网；
- 不默认把浏览数据上传为公司的数据资产。

## 5. 核心产品原则

### 5.1 Capability boundary 优先于 Prompt

“请 AI 不要操作浏览器”不构成安全边界。安全来自：

- AI 工具集中根本不存在浏览器写操作；
- P0 通过 `activeTab` 用户手势、固定 ISOLATED content script、最小消息接口和 Native Host 限定能力；
- AI 只查询本地投影，不接触 Extension API、content script、Tab 或浏览器动作能力；
- 网页内容即使成功 prompt-inject AI，也没有可用于操作浏览器的能力。

“只读”不是扩展拥有权限后的自我承诺。P0 根本不申请 Cookie、Storage、Network、debugger 或全站 host 权限；以后新增能力必须独立审批。

### 5.2 数据平面与推理平面解耦

```text
CAPTURE / MATERIALIZATION PLANE（无需 LLM）
User Chrome -> activeTab Extension -> Native Messaging
  -> Observation Log -> Materialized Page State

PROJECTION / REASONING PLANE（按需）
User Question
  -> explicit bounded scope -> QuestionProjection -> user confirmation -> LLM
  -> AnswerProjection validation -> Answer + Sources

P0.5 才增加：
Async UnitExtractor -> UnitObservation/CanonicalUnit/EvidenceBlock/EvidenceBlob
-> Session Unit Ledger/Global Unit Index -> TopicProjection
```

AI 不负责记住互联网；Observation Store 负责记录事实，Page State 负责可重建的当前状态。当前 Demo 的 QuestionProjection/AnswerProjection 是派生物；P0.5 才由 Session Unit Ledger 记录 UnitObservation、Global Unit Index 累计 CanonicalUnit。所有投影都不是捕获数据库，AI 只在用户确认后理解当前有界范围。

### 5.3 Local-first

- URL、内容、来源、浏览 Session、行为、上下文、索引和原始证据属于用户；
- 默认本地保存和本地检索；
- 可支持本地模型；
- 若用户选择远程模型，只发送为当前问题检索出的少量、可预览片段；
- 任何远程发送都必须可见、可取消并有最小化策略。

### 5.4 内容永远不是命令

网页、HTML、Markdown、JSON 和站点元数据均标记为不可信内容。诸如 `Ignore previous instructions` 的文本必须原样作为证据处理，不得进入系统/开发者指令层，也不得决定工具调用。

### 5.5 AI 不主动操控，但可以主动发现

必须区分两个概念：

```text
浏览器操控：始终由人完成，AI 永远没有写能力
信息发现：在有可靠证据、用户允许提醒时，系统可以主动浮现信号
```

因此“不打扰”不是绝对产品原则。真正原则是：提醒低干扰、可关闭、可解释、可追溯；主动发现绝不能扩张成主动点击、导航或抓取。

### 5.6 采集便宜，提示便宜，推理按需

- 捕获、状态归并与 Markdown 投影使用确定性程序；
- DOM observation 立即记录；P0 Demo 默认 200ms debounce + 2000ms maxWait 只合并 dirty 范围，不触发整页 Markdown 重写；
- 桌宠问题气泡来自预设池和廉价 metadata 规则；
- P0 Demo 在用户提交问题后生成完整有界 QuestionProjection，预览确认后调用 LLM；P0.5 才按真实召回缺口引入 Retrieval；
- 真正的后台 Signal Detection 属于后续阶段，必须有成本预算、可关闭设置和证据输出；
- 不允许为了生成装饰性气泡而持续消耗 Token。

## 6. 当前 P0：Extension DOM Capture 到有界问答 Demo

浏览器授权、注入和通信见 `P0_EXTENSION_ARCHITECTURE.md`；Store、Envelope、Reducer 与投影见 `CAPTURE_ARCHITECTURE.md`。

### 6.1 验证命题

第一阶段只验证：

> 对公开、非敏感文本型网页，能否仅凭用户手势授予的 `activeTab` 权限和固定 ISOLATED content script，在不主动访问网站、不执行页面/AI 提供的任意代码、不使用 OCR 或后台 LLM 的情况下，形成可重建 Page State，并对用户明确选择的当前页面或小型 Demo Session 产生有 claim-level Sources 的回答？

这里的“当前页面”是被用户明确选择观察的 Tab 中、浏览器已经渲染的 DOM，不等同于“用户实际看进视口的节点”，也不保证覆盖 Canvas、关闭的 Shadow DOM、跨域 iframe 或未挂载的虚拟列表内容。产品不得把这一阶段的数据宣传成精确注意力记录。

### 6.2 用户流程

1. 用户继续使用自己的 Chrome，但 Demo 只选择公开、非敏感文本页面；
2. 用户在目标 Tab 点击 Extension action 或使用快捷键，Chrome 授予临时 `activeTab`；
3. Extension 注入固定 ISOLATED content script，建立授权/document/page identity；
4. DOM 达到最低可读条件即产生初始 Snapshot；
5. MutationObserver 只记录 trigger，短 debounce + maxWait 后生成脱敏的全 document Raw Snapshot；
6. service worker 通过 Native Messaging 分块传给桌面 Capture Store；相同 hash 复用 blob并更新 Page State；
7. 用户在简单桌面窗口选择当前页面或最多 20 个页面的小型 Demo Session；
8. 桌面端从冻结 Page State 生成确定性 DemoEvidenceProjection/QuestionProjection；超过 Page/Block/字节/Token 上限时要求缩小 scope；
9. 用户预览正文、provider/model 和预计 Token，确认后才调用 AI；
10. 本地校验 AnswerProjection，每个 claim 必须引用 scope 内 EvidenceBlock，并显示 Sources；
11. 跨 origin 后授权失效、观察停止，窗口明确要求重新授权。

### 6.3 处理链路

```text
Chrome user gesture -> activeTab
  -> chrome.scripting.executeScript(fixed ISOLATED file)
  -> initial DOM snapshot
  -> MutationObserver -> trigger observation + document dirty
  -> 200ms debounce + 2000ms maxWait
  -> sanitize + serialize + hash
  -> runtime message -> service worker -> Native Messaging
  -> content-addressed Raw Snapshot
  -> Materialized Page State(stateVersion)
  -> 用户选择 current page / Demo Session
  -> deterministic DemoEvidenceProjection / QuestionProjection
  -> 用户预览并确认远程处理
  -> AI JSON
  -> AnswerProjection 引用校验
  -> Answer + Sources
```

### 6.4 为什么捕获热路径不清洗 HTML

- 捕获必须低延迟，不能等待页面“完全稳定”；
- DOM 高频变化时同步清洗会造成 CPU 抖动和反复整页工作；
- LLM 输出不确定、浪费 Token，隐私边界也更差；
- 保留有版本的 observation/state 后，解析器升级可以重新投影；
- 正文提取和 HTML 到 Markdown 仍属于确定性 ETL，但只在用户需要上下文或导出时运行。

LLM 只能在确定的投影版本之后出现。

### 6.5 Markdown 投影的保留与去除

保留：

- H1-H6 的相对层级；
- 段落、列表、链接、引用、表格、代码块；
- 图片 alt 和解析后的 URL；
- 页面标题、来源 URL、站点、捕获时间和哈希。

去除：

- CSS、JavaScript、导航、广告、按钮噪声、footer；
- 隐藏/跟踪元素（在纯 HTML 能可靠判断的范围内）；
- Cookie、Authorization、LocalStorage、密码和表单秘密；
- 危险 URL 凭证与常见令牌参数。

### 6.6 Frontmatter 与哈希

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
extractor: "demo-projector-v1"
---
```

- 作者、发布时间等只能在确定提取到时作为可选字段写入；
- `content_hash` 对规范化正文计算，排除捕获时间等易变字段；
- 投影同时记录输入 state/sequence 范围和 `projectionVersion`；
- 完全相同正文可识别为重复，但保留不同 URL/时间的证据关系；
- 文件名不可直接信任页面标题，必须经过长度限制与路径字符清理。

### 6.7 Observation Store 与原始 payload 策略

捕获事实源是版本化 Observation Log，查询效率来自 Materialized Page State；Markdown 只是可删除、可重建的派生投影：

- Envelope 稳定，至少含 session/tab/page/frame 身份、sequence、时间、类型、payload hash、脱敏策略和 schema/capture 版本；
- 大 payload 压缩后进入内容寻址 blob，索引只保存引用和必要元数据；
- P0 Demo 使用周期全量 snapshot；相同 hash 复用 blob，并通过 Demo TTL/配额控制保留，崩溃后可恢复；长期 compaction 属于 P0.5；
- MutationRecord 只作为 dirty trigger 和 provenance，不伪装成精确 patch；下一份 snapshot 替换当前状态并反映新增、修改、删除、移动和新 document；
- 原始事件受 TTL 和配额约束，不得永久无界增长；
- 原始 DOM 在持久化前清除表单值、token、凭证和已知密钥模式；
- 原始 payload 不直接进入 LLM、Embedding 或版本控制。

### 6.8 P0 成功标准

- 文本型页面达到可读阈值后能低延迟产生首个 checkpoint；
- 无限滚动、评论加载、删除、替换和 SPA 路由能正确 replace Page State；
- 当前页面或小型 Demo Session 能生成完整、有界的 QuestionProjection；超限时明确要求缩小 scope；
- 同一 `stateVersion` 和投影版本重复解析得到相同 DemoEvidenceBlock、顺序和 inputHash；
- 高频变化页面不会造成无限 CPU、内存或磁盘增长；
- 表单值和敏感字段在任何持久化之前完成脱敏；
- 失败会显式说明，不触发联网、AI、OCR 或自动导航回退；
- 安全审计证明未申请 P0 禁止权限，未使用 MAIN world、CDP、debugger 或外部调试端口；
- 捕获/提取链路没有站点出站请求；Native Messaging 只连接注册的本地宿主；
- 用户随时能看到、暂停和删除捕获结果；
- AnswerProjection 中每个 claim 均有 scope 内真实 DemoEvidenceBlock；悬空或非法引用失败关闭；
- 用户未提交问题、预览并确认远程处理时，AI 调用次数为零。

## 7. P0.5 产品交互基线：克制的桌宠 + Topic Cloud

本节不属于当前 Demo。它定义 P0.5 桌宠外壳；只有当前 P0 Demo 证明有来源问答能节省时间后才进入实现。

### 7.1 运行与界面形态

底层是 Chrome Extension + Native Messaging host + 本地桌面应用。界面默认是：

```text
收起：屏幕边缘的极简桌宠 + 头顶气泡
问 AI：展开约 380px 的本地 AI 面板
主题地图：打开桌面端 Topic Cloud
Chat 展开：回答 + Sources + 自由输入
Topic 展开：今天/7天/30天 + Topic Cloud + Topic Detail/Sources
```

桌宠可以吸附在浏览器旁边，但不属于网页 DOM。Extension 只注入用于捕获的固定 ISOLATED content script，绝不把桌宠/UI 注入页面。Always-on-top 是用户可选项。

### 7.2 P0.5 状态

```text
未授权当前页面
正在观察当前页面
已记录当前页面
观察已暂停
页面已跨域，需要重新授权
本地存储未连接
正在分析你的问题
正在生成主题地图
主题地图有新内容待更新
```

P0.5 只能展示这些状态和可询问的问题，不能显示“发现一个新话题”“趋势正在升温”“检测到异常信号”等事实性文案。

### 7.3 Question 气泡

P0.5 维护 6-10 个版本化预设问题，例如：

- 最近大家在讨论什么？
- 有什么值得我亲自看的？
- 有没有出现新的话题？
- 大家的主要争议是什么？
- 有哪些反常识观点？
- 有没有重复出现的痛点？
- 这批内容里有什么新产品或新项目？
- 帮我快速了解刚才浏览的内容。

桌宠头顶一次只轮换 2-3 个。第一版可以随机或顺序轮换；加入 Session metadata 后，再用确定性规则筛选。

### 7.4 预设问题不限制自主提问

这是硬性交互契约：

- 气泡问题是建议，不是白名单；
- 用户可以不点击任何气泡，直接打开面板输入问题；
- 面板中的自由输入框始终可见、可聚焦、可通过键盘操作；
- 用户问题不得被强行改写成最近的预设问题；
- 预设问题与自主问题使用同一检索、权限、证据和回答链路；
- 系统只允许依据已捕获、已选择的内容回答，但不能因为问题不在预设池中就拒绝。

若问题超出已捕获证据，正确行为是说明证据不足并列出可用范围，而不是把用户限制回预设问题。

### 7.5 廉价规则选择

候选规则：

```text
捕获内容 < 5
  -> 暂不推荐需要批量分析的问题

捕获内容 > 20
  -> 最近大家在讨论什么？

内容主要来自同一网站
  -> 这个社区最近在聊什么？

存在大量评论
  -> 大家的主要争议是什么？

存在多个不同页面
  -> 有什么重复出现的问题？

Session 时间 > 20min
  -> 有什么值得我亲自看的？
```

输入只能使用廉价 metadata，例如计数、来源分布、内容类型和 Session 时长。规则选择过程不读取正文、不调用 Embedding、不调用 LLM。

### 7.6 Question 与 Signal 必须分开

```text
Question：建议用户可以分析什么，不主张某件事已经发生
Signal：系统已经完成分析并有证据支持的事实性提醒
```

Question 可以由预设规则产生；Signal 必须包含：

- 触发时间；
- 证据数量与来源分布；
- 计算/分析版本；
- 可点击的证据 ID；
- 置信或限制说明。

不得用“当前最值得问”“发现新话题”等模糊文案掩盖实现机制。产品可以有上下文感，但不能误导用户相信 LLM 已经实时分析了尚未分析的数据。

### 7.7 视觉与打扰约束

- 不到处跑、不频繁动画、不连续弹窗；
- 不使用过度拟人、卖萌或游戏化反馈；
- 气泡采用平静、低频轮换，并允许关闭和静音；
- 支持减少动态效果、键盘操作和清晰焦点；
- 桌宠可拖动、收起，不遮挡浏览器关键内容；
- 捕获、AI 分析和 Signal 通知分别可暂停；
- 任何主动 Signal 都可直接查看来源和“为什么出现”。

### 7.8 第二界面：Topic Cloud

Topic Cloud 是用户主动生成的主题总览，不是持续运行的后台 Radar，也不是高频词词云：

- 用户选择 `今天 / 7 天 / 30 天`，确认范围后点击生成；
- 默认输出 5-12 个具体、有来源的主题，内容不足时宁可少显示；
- 节点大小表示去重后的 CanonicalUnit 数；Page/Domain 只作附加分布；
- 距离仅在存在共同 CanonicalUnit overlap 时表达相关，并显示图例；
- 点击主题进入 Topic Detail、Sources 和基于该主题的自由提问；
- Capture Store 变化只显示“有新内容待更新”，不自动调用 AI；
- P0.5 不显示 `NEW`、升温、下降、趋势或互联网总体判断；
- 等价列表、键盘操作和减少动态效果必须与云视图同时可用。

完整 schema、缓存键、输入上限和测试要求见 `P0_TOPIC_CLOUD_SPEC.md`。

## 8. 安全架构

### 8.1 用户 Chrome + 临时 Tab 授权

P0 不启动第二套 Chromium，也不开放 remote debugging port/pipe。用户通过 Extension action/快捷键主动授予当前 Tab 的 `activeTab` 临时权限；同源导航可继续，跨 origin 后权限撤销并要求再次授权。虽然使用用户现有 Chrome，Demo 仍只支持公开、非敏感页面，不支持登录后台或敏感内容。

P0 manifest 只包含：

```text
activeTab
scripting
nativeMessaging
storage
```

不包含 `debugger`、`tabs`、`history`、`webNavigation`、`webRequest`、`<all_urls>` 或必选 host permission。若未来需要站点级持续观察，只能按具体 origin 申请 optional host permission。

### 8.2 固定 ISOLATED content script

推荐结构：

```text
Chrome user gesture
  -> activeTab
  -> chrome.scripting.executeScript(fixed file, ISOLATED)
  -> DOM snapshot + MutationObserver
  -> runtime message
```

content script 只读共享 DOM，不读取页面 JavaScript 变量，不使用 MAIN world，不修改页面，不读取 Cookie/Storage/表单值，不监听键盘，也不发网站请求。网页 DOM 和所有 content-script 消息均按不可信输入处理。

Chrome 并没有为 content script 提供浏览器级只读沙箱；该权限技术上允许扩展代码修改共享 DOM。因此只允许固定文件注入，AI/网页/桌面端没有代码入口，并用依赖审计、AST 禁止规则和页面 mutation canary 验证 Extension 没有写行为。

P0 只观察主 frame。iframe、Shadow DOM、Canvas、虚拟列表和浏览器限制页必须明确报告覆盖限制。

### 8.3 Native Messaging 与出站隔离

```text
content script
  -> extension service worker
  -> runtime.connectNative()
  -> registered Desktop Host
  -> Local Capture Store
```

- Demo native host manifest 的 `allowed_origins` 固定为 demo key 产生的稳定 Extension ID；P0.5 正式分发时替换为 Store/正式签名 ID；
- 消息分块并验证 origin、schema、版本、大小、顺序和 hash；
- content script 不能直接调用 native host；
- Raw DOM 不写入 `chrome.storage`，只在桌面 Store 按 TTL/配额持久化；
- P0 不开放 localhost HTTP/WebSocket 采集端口；
- P0 Demo 使用本地 `demo-projector-v1`；P0.5 的 Defuddle 只接受已捕获 HTML并显式 `useAsync: false`；
- 不使用 Defuddle URL CLI，也不允许空结果时调用第三方提取服务；
- 远程模型只在用户提交问题、预览完整 QuestionProjection 并确认后，由独立 Reasoning 路径发送；当前 Demo 没有主题图调用路径。

### 8.4 P1 高权限阶段门

只有 DOM Capture 价值验证完成且 AX/XHR 需求有真实证据时，才评估 `chrome.debugger`。它不能声明为 optional permission，因此不得预埋进 P0；优先考虑独立 Advanced Capture 伴生 Extension。即使进入 P1，也必须保留精确只读 gateway，且不恢复 external debugging port。

### 8.5 隐私控制

从第一天提供：

- 暂停/恢复捕获；
- 域名黑名单和隐私模式；
- “刚才记录了什么”的可见预览；
- 删除单条、Session 或全部数据；
- URL 敏感参数、输入字段和日志脱敏；
- 输入大小、解析时间、递归深度、事件速率、磁盘配额和 TTL 上限；
- 登录后台、支付、身份认证、医疗、金融、邮箱、私信、编辑器、无痕和用户配置敏感域在 Demo 中明确不支持；
- 不记录键盘输入，click/scroll/XHR response body 默认不进入 P0。

## 9. P0.5 数据模型：概念冻结，当前 Demo 暂缓

未来扩展时必须区分四种概念，不能混为“用户所见”：

### 9.1 证据可见性

- `seen`：有证据表明内容实际进入用户视口；
- `observed`：浏览器在用户浏览期间获得，但不能证明用户看到，例如同页 XHR 中未渲染字段。

### 9.2 产生关系

- `direct`：协议明确标记为用户手势直接触发；
- `related`：用户操作后的短窗口内产生，有合理关联；
- `ambient`：浏览期间出现，无法归因到用户动作。

`hasUserGesture=false` 不能反推“不是用户导致”，尤其在 Promise、定时器、组件链或无限滚动中。

### 9.3 选择范围

`selected` 表示用户明确要求 AI 分析的证据集合。它与 `seen/observed` 是不同维度。默认分析范围必须在 UI 中透明显示，例如：

```text
本次捕获 127 条
其中 seen 42 条
用户选择分析 60 条
```

### 9.4 推断结果

`inferred` 是 AI 从证据得到的主题、摘要、趋势或推荐。它必须指回证据 ID，不能伪装成网页原文。

### 9.5 内容身份模型：Page / UnitObservation / CanonicalUnit / UnitVersion / EvidenceBlock

P0.5 冻结内容身份的四分模型（Observation ≠ Entity ≠ Source Version ≠ Interpretation）：

```text
Page：页面/document 容器，不参与 Topic 计票
UnitObservation：一次不可变的捕获事实，含 captureExtent（partial/full/unknown）
CanonicalUnit：互联网中的逻辑内容对象，可独立阅读和归入主题的最小统计单位，可 mergedInto
UnitVersion：源内容的版本，只由两次可比较 full 观察的稳定内容差异产生
DerivedMetadata：type + parserVersion，解释层，懒重算、不回写历史
UnitObservationSourceLink：追加 capture 来源关系，不改写 UnitObservation
EvidenceBlock：属于单个 Observation 的证据 occurrence；不能跨 Observation 复用 ownership
EvidenceBlob：按 textHash 内容寻址的正文；可以被多个 EvidenceBlock 引用
UnitVersionObservationLink：`supports_full` 表示 full Observation 对版本的支撑，`pins_partial` 表示可后加的安全钉住关系；Version 生命周期只由 full 支撑决定
SourceMetadataSnapshot：本次观察到的 title/author/publishedAt，不覆盖历史
```

身份优先级：Unit 自身 permalink -> namespaced anchor `(origin, canonicalPageUrl, stableAnchor)` -> 不强行合并。Feed 卡片（partial）到详情页（full）是 extent 变化，不是内容编辑；点赞数、相对时间等易变噪声不产生新 Version。

Page State 只表达当前 DOM；Session Unit Ledger 记录本 Session 的 UnitObservation；Global Unit Index 累计历史 CanonicalUnit 与聚合统计。虚拟列表滚走只从当前集合移除，不从观察历史删除。Ledger 中的 `observed` 不代表用户实际 `seen`。删除按可达性 GC：Observation/source links -> EvidenceBlock occurrence -> 无引用 EvidenceBlob -> 无 full 支撑 Version -> 无支撑 CanonicalUnit，逐层判定，不是 cascade delete。

Topic 必须引用 CanonicalUnit/EvidenceBlock；节点大小按去重 CanonicalUnit 数计算，Page/Domain 只作附加分布。完整契约见 `P0_ANALYSIS_UNIT_SPEC.md`。

### 9.6 P0.5 分级 UnitExtractor

```text
① Semantic HTML / ARIA / DOM-mapped Schema.org
  ↓ 低置信或不足
② Repeated Structure Detection
  ↓ 候选过滤与嵌套 ownContent 消歧
③ Defuddle / Readability Main Content fallback
```

- `<article>`/`role=article` 是高置信候选；`role=feed` 是 article 容器；list/listitem 仍需过滤导航和控件列表。
- 重复结构要求同父级至少 3 个相似 sibling，并使用版本化 fingerprint、阈值和资源预算。
- 只有达到阈值才拆；低置信不拆，不使用 LLM 判断 DOM。
- 父 Unit 必须排除已接受子 Unit 文本；EvidenceBlock 在一次结果中独占。
- 主内容 fallback 允许生成一个明确标记的粗 Unit，但不能无条件包装整个 Raw Page。
- JSON-LD 无法映射具体 DOM 时只补充 metadata，不凭空切块。
- UnitExtractor 只处理脱敏的离线 DOM，不联网、不阻塞 Capture；Readability 必须使用克隆，因为 `parse()` 会修改传入 DOM。
- UnitObservation 记录 captureExtent（partial/full/unknown）；Feed 卡片到详情页是 extent 变化，不是内容编辑；UnitVersion 只由两次 full 观察的稳定内容差异产生。

完整算法边界见 `P0_UNIT_EXTRACTOR_SPEC.md`。站点 Adapter 只能作为未来可选增强，通用解析始终是底座；不得把产品拖成逐站维护的爬虫集合。

## 10. 后续 MCP 与 AI 边界

MCP 面向 Local Repository，不面向 Chromium。候选只读接口：

```text
search_content(query, filters)
get_content(id)
get_session(id)
get_sources(ids)
```

永远不暴露：

```text
browser_click
browser_navigate
browser_execute
browser_type
browser_scroll
raw_cdp
```

未来 AI 的职责：语义归一、主题发现、聚类、观点提取、证据压缩和自然语言解释。

确定性程序的职责：计数、时间衰减、增长率、来源分布、去重、排序特征、权限、审计和数据生命周期。

热点/趋势不能只让 LLM “凭感觉”判断：

```text
热点 ~= 讨论量 x 互动强度 x 时间衰减
趋势 ~= 当前周期频率 / 历史基线频率
弱信号 ~= 低绝对量 + 高增速 + 多来源 + 新颖性 + 来源质量
```

LLM 可以判断哪些文本语义相同，程序必须负责可重复的量化计算。

## 11. 路线图与阶段门

### P0：Extension DOM Capture + Bounded Question Demo（当前）

Windows-only 内部 Demo：验证 `activeTab`、固定 ISOLATED content script、MutationObserver、Native Messaging、本地 Observation/Page State、当前页面或小型 Demo Session 的 QuestionProjection、用户确认后的 AnswerProjection 与 claim-level Sources。只支持公开、非敏感文本页面；不实现桌宠、完整 Unit 身份、Topic Cloud、登录态安全或正式分发。完整范围见 `P0_DEMO_SCOPE.md`。

### P0.5：Product MVP（由 P0 降级而来）

只有 P0 Demo 证明有来源问答能显著节省时间后，才按以下顺序进入：

1. 修复后的 UnitObservation/CanonicalUnit/UnitVersion/EvidenceBlock/EvidenceBlob 数据模型与完整 UnitExtractor；
2. Session Unit Ledger、Global Unit Index、跨 Session 身份、版本和可达性 GC；
3. 用户主动生成的 TopicProjection、Topic Cloud、Topic Detail 与 Sources；
4. 克制桌宠、Prompt Pool、自由 Chat 和 Topic 两入口；
5. 本地加密、系统凭据库、登录态威胁模型、正式安装器、稳定 Extension ID、升级/卸载和 Chrome Web Store 合规。

P0.5 仍不做后台主题刷新、稳定历史主题身份、趋势或主动 Signal。

### P0.6：Permission/Coverage Optimization

只有使用数据证明重复授权或覆盖不足时，才按 origin 增加 optional host permission、改进同源导航重注入或扩展 DOM 覆盖；不默认请求全站权限。

### P1：Advanced Capture 阶段门

只有 DOM Capture 无法满足已验证的 AX/XHR 需求时，才通过独立 ADR 评估 `chrome.debugger` 和 Advanced Capture 伴生 Extension；不恢复外部 CDP 端口。

### Phase 2：Unit Extraction Quality + Identity

P0.5 已有分级 UnitExtractor 后，本阶段再提升跨 Page 列表项/详情页对齐、编辑版本、近重复、复杂嵌套和可见性质量；只有通用抽取被真实夹具证明不足时再做 Adapter。AX/DOMSnapshot 只能在 P1 权限阶段门通过后使用。

### Phase 3：Research Session

记录一次明确研究任务中的页面、证据与用户选择范围，验证“一次浏览产生的一批信息”是否完整。

### Phase 4：Relationship Graph + Stable Semantic Aggregation

P0.5 先验证用户主动生成的当前范围主题云。本阶段再验证更大批量中主题身份能否跨投影稳定，以及主题、人物、产品、项目和问题之间能否形成有类型、有证据的关系图；不得把共同出现直接伪装成因果或从属。

### Phase 5：Signal Ranking

验证系统是否能推荐真正值得亲自看的少数原文，而非重复站点排行榜；只有达到证据要求后才启用 Signal Notifier。

### Phase 6：Historical Baseline

积累跨时间数据后再做变化、趋势、新概念和弱信号。

### Phase 7：Personal Repository + Hybrid Retrieval

先 SQLite + FTS5 + Metadata，再基于真实召回缺口决定是否加入 Embedding、Hybrid Search 和 Rerank。

每个阶段必须先证明上一阶段的用户/质量指标，不得只因技术上可做而向下推进。

## 12. 评估方法

### 12.1 Capture/Markdown 基准

维护版本化网页夹具集，覆盖：文章、论坛列表、帖子、评论、GitHub Issue、表格、代码、引用、图片、SPA 渲染 HTML 和恶意输入。

评价：

- 主体文本召回；
- 导航/广告噪声比例；
- 标题、表格、代码和链接结构保真；
- 确定性与哈希稳定性；
- 失败可解释性；
- 零禁止 Extension 权限/API、零 MAIN-world/动态代码、零捕获链路网站请求。

### 12.2 产品基准（进入 Session/AI 后）

对同一批内容比较人工阅读组与产品组：

- 完成理解所需时间；
- 主要主题遗漏率；
- 新信息/弱信号命中率；
- 推荐内容满意度；
- 推荐 5 条中用户实际愿意打开几条。

最重要的两个问题：

> 省了多少时间？  
> 推荐的少数原文中，用户真正想打开多少？

### 12.3 桌宠交互基准

- 推荐问题点击率与自主提问使用率；
- 从气泡到看到回答的完成率与延迟；
- 气泡关闭、静音和误触率；
- Signal 提醒后查看证据的比例；
- 用户主观打扰度；
- 自主问题被错误限制或改写的次数必须为零。

### 12.4 Topic Cloud 基准

- 用户能否在 10 秒内说出自己所选范围的 3 个主要主题；
- 主题标签的具体性、重复率、空泛主题率与人工主要主题遗漏率；
- 每个主题来源引用有效率必须为 100%；
- 节点大小与去重 CanonicalUnit 数一致，重复观察、多 Block、多版本和 Page/Domain 数不增加权重；
- 主题点击后查看来源和继续提问的比例；
- 用户把 Topic Cloud 误解为互联网趋势或行业共识的比例；
- 缓存命中率、主动更新率、单次生成成本和生成延迟。

## 13. 主要风险与应对

| 风险 | 应对 |
|---|---|
| 产品膨胀为 Browser Agent + RAG 平台 | 阶段门；P0 只做授权 DOM Capture、简单窗口、有界问答与 Sources；桌宠/Topic Cloud/长期身份进入 P0.5 |
| “只读”只停留在文案 | activeTab、固定 ISOLATED script、最小消息接口、负向测试 |
| 把 activeTab 误认为浏览器级只读权限 | 承认 content script 可写 DOM；固定 bundle、AI 隔离、AST 规则、mutation canary |
| Defuddle 或解析器主动联网 | 仅传本地 HTML，`useAsync: false`，进程 egress 限制 |
| 把 XHR 当作用户所见 | `seen/observed` 和 provenance 分层 |
| Prompt Injection | 内容/指令分层；AI 无浏览器能力 |
| 捕获登录后敏感数据 | P0 Demo 直接不支持敏感/登录后台；源端脱敏、预览/删除；P0.5 完成本地加密与威胁模型后再扩大范围 |
| Observation 不可变却追加 source 引用 | UnitObservationSourceLink 追加关系，UnitObservation 本身不改写 |
| Evidence 正文去重与单一所有权冲突 | EvidenceBlock occurrence 属于 Observation；EvidenceBlob 才按 textHash 复用 |
| 自由提问缺少 Retrieval 定义 | P0 不做语义 Retrieval；用户显式 scope 全量进入有界 QuestionProjection，超限要求缩小 |
| 宣称通用但复杂站点失败 | 明确支持文本型 Web；对 iframe/Canvas/虚拟列表报告限制 |
| Repository 变成昂贵浏览历史 | 先验证 Session 压缩与推荐，再做长期积累 |
| 趋势输出不可重复 | LLM 做语义，程序做量化与基线 |
| 桌宠变得吵闹或幼稚 | 克制视觉、低频轮换、可收起/静音、减少动态效果 |
| 预设问题限制用户表达 | 自由输入始终可用；预设只做推荐入口 |
| 把问题推荐伪装成真实发现 | Question/Signal 分型；Signal 强制绑定证据 |
| 为气泡持续调用 LLM 导致成本失控 | Prompt Pool + 廉价 metadata 规则；提交后才推理 |
| MutationObserver 事件风暴拖垮本机 | debounce、max-wait、backpressure、hash 去重、TTL 与配额 |
| 只追加导致已删除内容仍被 AI 看见 | Reducer 支持 remove/replace/reset；状态版本固定后再投影 |
| URL/content-script instance 被误作稳定身份 | `pageInstanceId + contentEpoch + sequence`；新 document/授权后重建 observer |
| Raw Observation 比 Markdown 更敏感 | 持久化前脱敏、短 TTL、压缩清理、域名排除和彻底删除 |
| 把所有“读取”误认为同一风险级别 | P0 不申请 debugger/Network/Cookie/Storage；后续分 capability 审批 |
| 每个 mutation 保存重复全量 HTML | P0 Demo 200ms/2000ms 合并、内容 hash/blob 复用、latest-wins、TTL；P0.5 再做长期 compaction |
| 跨 origin 后仍显示正在观察 | activeTab 状态机；注入失败/权限撤销立即变为需重新授权 |
| Native Messaging 伪造、截断或重放 | pin Extension ID；schema、分块、hash、顺序和幂等 commit |
| 为 SPA 导航申请 webNavigation 造成浏览历史警告 | P0 使用 tabs/content-script 信号；不足时先验证再单独决策 |
| 把 `chrome.debugger` 当作可选小升级 | debugger 不可 optional；优先独立 Advanced Capture Extension |
| 把 Topic Cloud 做成无价值高频词云 | 主题具体性规则、通用词拒绝、5-12 个有证据主题、人工夹具评测 |
| 节点视觉编码夸大证据 | 大小只使用去重 CanonicalUnit 数；距离只使用有说明的共同 CanonicalUnit overlap |
| 把本地主题误报成互联网趋势 | 所有文案限定本地 scope；P0.5 禁止 NEW/升温/下降/趋势 |
| Capture 变化触发后台 Token 消耗 | 只标记 TopicProjection stale；必须由用户点击更新 |
| AI 伪造主题来源或 UI 内容 | TopicProjection schema、CanonicalUnit/EvidenceBlock 关系校验、文本转义、模型不控制坐标/HTML |
| Page 被直接当成 Topic 统计票 | Topic 只引用 CanonicalUnit；大小按 distinct CanonicalUnit，Page/Domain 只展示分布 |
| 虚拟列表 DOM removal 导致已捕获内容丢失 | Page State 与 Session Unit Ledger 分离；removal 不删除 Ledger Unit |
| 低置信 DOM 被错误拆碎 | 分级抽取、splitThreshold、低置信不拆、main-content fallback |
| 父子 Unit 重复计算评论/正文 | containment tree + parent ownContent 排除已接受子 Unit + EvidenceBlock 独占 |
| 导航列表/JSON-LD 产生虚假 Unit | listitem 继续过滤；无法映射 DOM 的 JSON-LD 只补 metadata |
| fallback 把整页噪声算成一个 Unit | 只接受 Defuddle/Readability 去噪后的有效主内容；空结果返回 extraction_empty |
| 把 DOM observed 宣称成用户 seen | Ledger 使用 observed 语义；seen 必须另有视口证据 |
| Feed 卡片与详情页被误判为内容编辑 | captureExtent 区分 partial/full；Version 只由两次 full 观察的稳定差异产生 |
| 重复访问同一页面导致主题通胀 | CanonicalUnit 身份消解；Topic 只按去重 Canonical 计数 |
| 删除 Session 误删共享内容 | 删除按可达性 GC，Observation/引用完整性判定 |

## 14. 已冻结的设计决策

| ID | 决策 | 状态 |
|---|---|---|
| D-001 | 人操作浏览器，系统只观察 | 冻结 |
| D-002 | P0 使用 activeTab 最小临时权限，不开放外部 CDP | 冻结（修订） |
| D-003 | AI/MCP 永不接触 Extension API、Tab、content script 或浏览器动作能力 | 冻结（修订） |
| D-004 | Data Plane 不依赖 LLM | 冻结 |
| D-005 | 数据默认本地，用户拥有 Repository | 冻结 |
| D-006 | 当前 P0 做 Extension DOM Capture -> Local Store -> 有界 QuestionProjection -> 用户确认 -> AnswerProjection/Sources | 冻结（修订） |
| D-007 | P0 不使用 `chrome-remote-interface`、专用 Chromium 或 remote debugging port/pipe | 冻结（修订） |
| D-008 | P0.5 使用 `defuddle/node` 作为候选 main-content 提取器，强制 `useAsync:false`；P0 Demo 使用 demo-projector-v1 | 待 P0.5 夹具验证（阶段修订） |
| D-009 | Observation Log 是捕获事实源，Page State 可重建；Markdown/QuestionProjection/AnswerProjection 是派生投影 | 冻结（修订） |
| D-010 | SQLite/FTS 先于 Embedding/RAG | 后续阶段 |
| D-011 | 工作名为 Sift AI，品牌最终决定未冻结 | 临时 |
| D-012 | P0.5 产品交互外壳采用克制的桌宠，点击后展开约 380px 面板；P0 Demo 使用简单窗口/托盘 | 冻结（阶段修订） |
| D-013 | P0.5 气泡问题来自预设 Prompt Pool + 廉价 metadata 规则，不实时调用 LLM | 冻结（阶段修订） |
| D-014 | 预设问题不限制自主提问；自由输入始终存在 | 冻结 |
| D-015 | Question Launcher 与 Signal Notifier 在数据和文案上严格分型 | 冻结 |
| D-016 | AI 可以主动发现和低干扰提醒，但永远不能主动操控浏览器 | 冻结 |
| D-017 | 页面可读即捕获，内容变化即增量补充，不等待页面完全稳定 | 冻结 |
| D-018 | MutationObserver trigger 立即记录；P0 Demo 默认 200ms debounce + 2000ms maxWait 生成脱敏 Snapshot | 冻结（修订） |
| D-019 | 页面身份使用 page instance/content epoch/sequence，不以 URL 或 content-script instance 代替 | 冻结（修订） |
| D-020 | P0 Demo 原始事件受 TTL、配额和持久化前脱敏约束；长期 checkpoint/compaction 属于 P0.5 | 冻结（阶段修订） |
| D-021 | P0 Read/Observe 由 Chrome permission + 固定 content script + 消息 schema 约束；CDP 双白名单仅属于未来 P1 | 冻结（修订） |
| D-022 | P0 不轮询；固定 ISOLATED MutationObserver 触发 debounce 后的全 document Raw Snapshot | 冻结（修订） |
| D-023 | Network、Cookie、Storage、请求/响应体属于独立高敏读取能力，不随“只读”自动开放 | 冻结 |
| D-024 | P0 使用用户自己的 Chrome但只支持公开、非敏感页面；跨 origin 后重新授权；登录态敏感内容属于 P0.5 安全阶段门 | 冻结（修订） |
| D-025 | Extension 与桌面端通过 Native Messaging 通信，不开放本地采集端口 | 冻结 |
| D-026 | P0 只在用户提交问题、预览 QuestionProjection 并确认远程处理后调用 AI；Topic 分析属于 P0.5 | 冻结（修订） |
| D-027 | `chrome.debugger` 不进入 P0；需要时优先独立 Advanced Capture 伴生 Extension | 冻结 |
| D-028 | 长期站点观察使用按 origin 的 optional host permission，不默认请求全站权限 | 冻结 |
| D-029 | P0.5 第二界面是用户主动生成的 Topic Cloud；P0 Demo 不显示 Topic 入口 | 冻结（阶段修订） |
| D-030 | Topic Cloud 大小表示去重 CanonicalUnit 数；距离只表示明确的共同 CanonicalUnit overlap | 冻结（修订） |
| D-031 | P0.5 不显示 NEW/升温/下降/趋势；主题只描述所选本地捕获范围 | 冻结（阶段修订） |
| D-032 | TopicProjection 是带证据的派生缓存；Store 变化只标记 stale，用户点击后才更新 | 冻结 |
| D-033 | P0.5 中 Page 只是容器；CanonicalUnit 是 Topic 最小统计单位；EvidenceBlock occurrence 是精确来源 | 冻结（阶段修订） |
| D-034 | P0.5 中 Page State 表示当前 DOM；Session Unit Ledger 记录 UnitObservation、Global Unit Index 累计 CanonicalUnit | 冻结（阶段修订） |
| D-035 | P0.5 UnitExtractor 使用 Semantic -> Repeated Structure -> Main Content fallback，不使用 LLM | 冻结（阶段修订） |
| D-036 | 高置信才拆、低置信不拆；`unknown` 是合法类型，不强行业务分类 | 冻结 |
| D-037 | 父 Unit ownContent 排除已接受子 Unit；EvidenceBlock 在一次抽取结果中独占 | 冻结 |
| D-038 | 主内容 fallback 可生成一个粗 Unit，但不得无条件包装 Raw Page | 冻结（修订） |
| D-039 | DOM 出现只证明 observed；没有视口证据不得标记 seen | 冻结 |
| D-040 | 内容身份四分模型：UnitObservation（不可变）/ CanonicalUnit（可 merge）/ UnitVersion / DerivedMetadata；Observation ≠ Entity ≠ Source Version ≠ Interpretation | 冻结 |
| D-041 | 身份键优先级：Unit permalink -> namespaced anchor (origin, canonicalPageUrl, stableAnchor) -> 无安全键不强行合并；Unit URL 不是 Page URL | 冻结 |
| D-042 | UnitObservation 记录 captureExtent（partial/full/unknown）；partial/unknown 不参与版本比较 | 冻结 |
| D-043 | UnitVersion 只由两次可比较 full 观察经 normalizeStableContent 稳定化后的真实差异产生；易变噪声进 volatileMetadata | 冻结 |
| D-044 | EvidenceBlock occurrence 挂 UnitObservation；正文由 EvidenceBlob 去重；UnitVersion 通过关联表引用 full Observation/EvidenceBlock | 冻结（修复） |
| D-045 | type 属于 DerivedMetadata（parserVersion 版本化），懒重算、不回写历史；P0.5 DerivedMetadata 不含 topics | 冻结 |
| D-046 | Canonical merge 使用 mergedInto 墓碑、方向确定（并入先创建者）、幂等；Observation 保留原 id；merge 后旧投影标记 stale | 冻结 |
| D-047 | P0.5 删除按可达性 GC：Observation/source links -> EvidenceBlock occurrence -> EvidenceBlob -> full-supported Version -> CanonicalUnit | 冻结（修复） |
| D-048 | Topic 计数只按去重 CanonicalUnit（聚合用 observation_count）；重复观察/重访/多版本不重复计票 | 冻结 |
| D-049 | 当前 P0 是 Windows-only 内部 Demo；unpacked Extension、手动 Native Host、简单窗口，不承诺公开分发 | 冻结（新增） |
| D-050 | P0 不做语义 Retrieval；用户显式 scope 全量进入有界 QuestionProjection，超限要求缩小 | 冻结（新增） |
| D-051 | P0 不支持登录/敏感页面，不持久化 API Key；每次远程处理先预览并确认 | 冻结（新增） |
| D-052 | UnitObservation 不改写；重复 source 用 UnitObservationSourceLink；Source metadata 保存于每次 Observation | 冻结（新增） |
| D-053 | AnswerProjection 每个 claim 必须引用 scope 内 DemoEvidenceBlock；结构校验不等于语义蕴含，后者用人工夹具评估 | 冻结（新增） |

## 15. 实施时的开放问题

当前 P0 Demo 的产品边界、默认预算、SQLite + blob Store、手动 Native Host 注册和远程确认已经由 `P0_DEMO_SCOPE.md` 冻结。桌面壳（Electron/TypeScript monorepo）、Native Host 打包（单 exe 双模式，带限时 spike 验证门，失败则另开替代 ADR）、ModelAdapter 传输与 Token 估算、敏感词表 v1 以及静态扫描/canary 工具已由 `ADR-001_DEMO_ENGINEERING.md` 决定。以下实现型选择在开发过程中完成，不构成扩大产品范围：

- 同源新 document 重注入、BFCache 与复杂 SPA 的具体状态机实现；
- `readable-v1`、200ms/2000ms、5 MiB/50k nodes/128 depth、256 KiB chunks 和 backpressure 默认值的首轮真实页面基准。

以下问题只在 P0.5 或更后阶段进入 ADR：

- 正式 Extension 分发、Chrome Web Store ID、Native Messaging host 安装/升级/卸载策略；
- activeTab 跨 origin 重新授权的桌宠 UX；
- optional host permission 的启用时机、按 origin 管理和撤销 UX；
- 长期 Observation/Blob/Page State checkpoint/compaction、加密、系统凭据库和删除承诺；
- Defuddle/Readability main-content fallback 的参数、失败切换与输出质量阈值；
- UnitExtractor 的 splitThreshold、structure fingerprint、文本下限、资源预算和 confidence 校准集；
- 无 permalink 的 Feed 卡片/详情页对齐与跨 Page 转载去重的安全 identity signals（如稳定化前缀包含）；
- eligible text 与真实 computed visibility 的差距是否值得新增低风险布局元数据；
- P1 是否需要独立 Advanced Capture Extension，以及 `chrome.debugger` 的精确白名单；
- 长期 Research Session 的开始/停止、研究问题和复杂 Selected Scope 交互；Demo 只有手动加入/移除页面；
- 远程模型长期授权、provider 切换、系统凭据库和审计历史 UX；Demo 每次预览确认且不持久化 Key；
- 项目最终名称与仓库名。
- 桌宠最终视觉符号、停靠规则、气泡轮换节奏和跨显示器行为；
- Signal Detection 的默认开关、成本预算和提醒阈值。
- Topic Cloud 的最低输入量、默认主题数、视觉布局算法和小屏降级参数；
- 远程主题生成前的 scope 预览与 Token 成本提示；
- Phase 4 关系图的节点/边类型、证据阈值，以及何时增加 Mind Map；

## 16. 参考资料

- [OpenAI：Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Chrome Extensions：activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome Extensions：chrome.scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome Extensions：Content scripts / isolated world](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome Extensions：Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome Extensions：Permissions](https://developer.chrome.com/docs/extensions/reference/permissions-list)
- [Chrome Extensions：Optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Chrome Extensions：chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome DevTools Protocol：DOM.getOuterHTML](https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-getOuterHTML)
- [Chrome DevTools Protocol：DOMSnapshot.captureSnapshot](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/#method-captureSnapshot)
- [Chrome DevTools Protocol：Accessibility.getFullAXTree](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/#method-getFullAXTree)
- [Chrome DevTools Protocol：Network.getResponseBody](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-getResponseBody)
- [Chrome for Developers：remote debugging switches security change](https://developer.chrome.com/blog/remote-debugging-port)
- [Defuddle 官方仓库](https://github.com/kepano/defuddle)
- [MDN：HTML article element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/article)
- [MDN：ARIA article role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/article_role)
- [MDN：ARIA feed role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/feed_role)
- [Schema.org：DiscussionForumPosting](https://schema.org/DiscussionForumPosting)
- [Schema.org：Comment](https://schema.org/Comment)
- [Schema.org：Article](https://schema.org/Article)
- [Mozilla Readability README](https://github.com/mozilla/readability/blob/main/README.md)
