# Sift AI 捕获与投影架构约束

> 状态：Capture Store 与投影层的 transport-neutral 规范。当前 P0 Demo 范围以 `P0_DEMO_SCOPE.md` 为准，浏览器接入以 `P0_EXTENSION_ARCHITECTURE.md` 为准；Unit 数据/抽取和 TopicProjection 已降级到 P0.5，分别见 `P0_ANALYSIS_UNIT_SPEC.md`、`P0_UNIT_EXTRACTOR_SPEC.md`、`P0_TOPIC_CLOUD_SPEC.md`；CDP 仅属于未来 P1。

## 1. 冻结结论

Sift 的捕获原则是：

> 页面可读即捕获，内容变化即增量补充，不等待“页面完全稳定”。

同时必须区分三类数据：

```text
Browser Capture Adapter
  P0: MV3 Extension DOM Capture
  P1: chrome.debugger（仅在阶段门后）
      ↓
Observation Log（捕获事实）
      ↓
Page Materialized State（可重建的当前页面状态）
      ↓ 当前 P0 Demo
DemoEvidenceProjection / QuestionProjection
      ↓ 用户预览并确认
LLM -> AnswerProjection 校验 -> Sources

P0.5 才增加：
Async UnitExtractor -> UnitObservation/CanonicalUnit/UnitVersion
Session Unit Ledger/Global Unit Index -> TopicProjection
```

- `Observation Log` 是捕获事实的来源。
- `Page Materialized State` 是由快照和变化归并出的当前状态，用于避免每次提问都重放完整日志。
- 当前 Demo 不物化 CanonicalUnit/UnitVersion；DemoEvidenceBlock 只是 QuestionProjection 内可回查的来源块，不承担长期身份。
- P0.5 才实现 UnitObservation/CanonicalUnit/EvidenceBlock occurrence/EvidenceBlob、Session Unit Ledger 与 Global Unit Index，身份模型以 `P0_ANALYSIS_UNIT_SPEC.md` 为准。
- Markdown 只是面向 AI 或导出的投影格式，不是捕获格式，也不是唯一事实源。
- `page.md` 可以作为 Repository 的用户可读视图或缓存，但必须能从存储状态重新生成。
- 捕获路径不得同步等待正文清洗、Markdown 转换、Embedding 或 LLM。

## 2. 捕获时序

### 2.1 初始捕获

1. 用户通过 Extension action/快捷键授权当前 Tab，或已对当前 origin 授予可撤销的 optional host permission。
2. 建立新的 `pageInstanceId` 或新的内容 epoch。
3. 固定 ISOLATED content script 注入后，DOM 达到“最低可读条件”即写入首个 Snapshot。
4. 后续资源、评论、列表和滚动加载内容通过变化事件继续补充。

“最低可读条件”不能只判断 `body` 是否存在。P0 至少应要求：

- 存在非空 `body`；
- 去除 `script`、`style`、`noscript`、模板和纯装饰节点后，有达到阈值的可见候选文本；
- 不是只有 loading、骨架屏或错误占位符；
- 阈值与命中原因可记录、可测试、可调整。

首个 checkpoint 不需要完整。低延迟优先，后续变化负责补齐。

### 2.2 增量更新

P0 不轮询，也不把 MutationRecord 当作完整 DOM patch。固定 content script 的 `MutationObserver` callback 到达时立即记录轻量 trigger observation，并把当前 document 标记为 dirty；随后由一次合并调度在页面内完成脱敏与序列化，形成新的 Raw Snapshot。

```text
Extension MutationObserver trigger
  -> append trigger observation
  -> mark current document dirty
-> debounce 200ms + maxWait 2000ms（Demo 默认值）
  -> sanitize + serialize document
  -> runtime message -> Native Messaging
  -> hash + persist dom_snapshot
  -> replace current Page State version
```

`200ms debounce + 2000ms maxWait` 是 P0 Demo 合并连续触发和安排全量 Raw Snapshot 的版本化默认值，不是轮询周期，不是延迟记录 trigger 的理由，也不是生成整页 Markdown 的周期。

推荐的起始策略：

- leading edge：首个有意义内容立即 checkpoint；
- mutation burst：200ms 内的多个事件只触发一次全 document Raw Snapshot；持续变化最多等待 2000ms；
- content addressing：快照脱敏后计算 hash；内容相同时只增加 observation 引用，不重复保存 blob；
- max wait：持续变化的页面也必须周期性生成状态 checkpoint，避免永远不落定；
- backpressure：动画、计时器和高频属性变化只保留 trigger 计数、最后原因和受控快照，不允许无限堆积；
- query barrier：用户发问时，先在一个有上限的等待时间内归并最新 dirty 状态，然后对明确的状态版本生成投影。

以上时间都是可配置的 P0 初值，必须通过真实页面测试校准，不能写死成产品语义。

### 2.3 变化不是只追加

页面变化可能是新增、修改、删除、移动、替换或整棵文档重置。因此状态模型不得只支持：

```text
V1 + Block A + Block B
```

P0 用新的全 document snapshot 替换当前状态，因此至少要能表达：

```text
replace_snapshot | reset_document
```

MutationRecord 在 P0 中只承担 dirty trigger 和 provenance，不承担精确重放。这样新增、删除、移动和文本修改最终都由下一份完整快照体现，不会因不完整 event payload 产生伪 diff。以后若性能数据证明全量快照成本过高，才允许在不改变外部数据契约的前提下加入 subtree snapshot/delta。

## 3. 页面身份与顺序

URL 不是页面实例主键。相同 URL 可能对应不同导航和内容，同一文档也可能通过 SPA 路由改变 URL。

建议定义：

```text
sessionId
└── tabId
    └── pageInstanceId       # 主 frame 文档实例
        ├── contentEpoch      # 同文档路由/内容阶段
        ├── frameId
        └── sequence          # 本页面实例内的接收顺序
```

- 新 document、主 frame 同源导航后的重新注入、BFCache restore 或授权重新建立必须触发明确的 snapshot/reset 边界。
- 同文档导航应开始新的 `contentEpoch`，但不一定创建新 document。
- 每个 `pageInstanceId` 使用单调递增的 `sequence`；墙上时间只用于展示和跨会话检索，不能单独承担排序。
- content script instance、MutationObserver 和消息 port 只在当前 document/授权 generation 内有效，不得跨导航复用。

## 4. Observation Envelope

Payload 可以因来源而异，Envelope 必须稳定、可版本化、可追踪：

```ts
type ObservationEnvelope = {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  tabId: string;
  pageInstanceId: string;
  contentEpoch: number;
  frameId?: string;
  sequence: number;
  observedAt?: number;   // 协议提供的单调时间（若有）
  receivedAt: string;   // 本地墙上时间
  url: string;          // 经过清洗，不含敏感 fragment/query 时应移除
  source: "extension" | "navigation" | "dom" | "ax" | "network" | "interaction";
  type: string;
  payloadRef: string;   // 大 payload 放到 blob store，不内联到索引表
  payloadHash: string;
  redactionPolicy: string;
  captureVersion: string;
};
```

约束：

- `schemaVersion`、`captureVersion` 和 `redactionPolicy` 不可省略；否则旧数据无法安全重放。
- 大 payload 使用压缩、内容寻址的 blob；索引只保留引用、hash 和必要元数据。
- 事件必须幂等写入；相同 `id` 或 hash 不得重复膨胀存储。
- URL、标题和 payload 都是不可信输入；不得直接成为文件路径、SQL、HTML 或 prompt 指令。

建议的 P0 事件类型：

```text
authorization_granted
authorization_revoked
document_started
navigation_metadata_changed
dom_mutation_trigger
dom_snapshot
capture_paused
capture_resumed
```

`scroll`、`click`、AX snapshot、XHR response 不是首版必需项。新增它们必须先写隐私用途和删除策略。

## 5. P0 Extension Capture 边界

P0 不使用 CDP。浏览器接入是用户手势授权的 Manifest V3 Extension；产品原则仍是 Read/Observe，但安全边界来自 Chrome 权限、固定 content script、隔离世界、消息 schema 和桌面端最小接口。

`activeTab + scripting` 不是浏览器级只读权限，content script 技术上能够修改共享 DOM。AI/网页/桌面端必须与注入入口隔离；Extension 只读行为由固定 bundle、静态禁止规则、依赖审计和页面无写入集成测试保证。

### 5.1 P0 权限

允许：

```text
activeTab
scripting
nativeMessaging
storage
```

禁止在 P0 manifest 中出现：

```text
debugger
tabs
history
webNavigation
webRequest
<all_urls>
必选 host_permissions
```

`activeTab` 必须由 Chrome 认可的用户手势获得。同源导航可继续使用临时授权；跨 origin、Tab 关闭或权限撤销后 Capture Adapter 立即停机并通知桌面端。以后站点级持续观察只能按 origin 请求 `optional_host_permissions`。

### 5.2 固定 content script

- 只注入 Extension 包内固定文件；
- 使用 `chrome.scripting.executeScript` 和 `world: "ISOLATED"`；
- 只观察当前主 frame 的 DOM；
- 使用固定 `MutationObserver` 作为 dirty trigger；
- 只在脱敏后序列化/发送 Snapshot；
- 不使用 MAIN world、`eval`、远程代码或 AI/网页提供的脚本；
- 不修改页面，不访问 Cookie/Storage，不读取表单值，不监听键盘，不发网站请求。

### 5.3 Native Messaging

P0 使用 content script → service worker → registered native host → Local Capture Store。Demo native host 必须 pin demo key 产生的稳定 Extension ID，并验证 origin、schema、版本、分块、hash、顺序和大小；P0.5 正式分发时替换为正式签名/Store ID。Raw DOM 不进入 `chrome.storage`，也不开放 localhost 调试/采集端口。

### 5.4 P1 `chrome.debugger` 阶段门

只有 DOM Capture 被真实证明不足以支持已验证的 AX/XHR 需求后，P1 才能使用 `chrome.debugger`。它是 CDP transport，不是安全边界；必须重新建立精确 command/event allowlist 和审计。`debugger` 不能作为 optional permission，因此不得在 P0 预埋，优先评估独立 Advanced Capture 伴生 Extension。P1 仍不使用 external remote-debugging port/pipe。

Network response、Cookie、Storage、请求体和认证信息仍属于独立高敏 capability；“只读”不构成自动授权。

完整权限、导航、Native Messaging 与 UI 状态规则见 `P0_EXTENSION_ARCHITECTURE.md`。

官方依据：

- [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)

## 6. Materialized Page State

每个页面实例维护一个可重建的状态，至少包含：

```text
pageInstanceId
stateVersion
lastAppliedSequence
canonicalUrl / title
sanitizedSnapshotBlobRef / payloadHash
sourceObservationId
documentDirty / pendingTriggerCount
last checkpoint
```

Reducer 必须满足：

- 同一 observation 重放两次不会改变结果；
- 崩溃后可以从最近 checkpoint + 后续事件恢复；
- 删除和替换会从“当前 Page State”投影中消失；Demo Session 只引用用户明确加入且仍保留的 Page State。P0.5 才允许从 Session Unit Ledger / Global Unit Index 取回曾观察内容；
- Page State 保留来源页面、frame、时间范围和 source Observation 引用；DemoEvidenceBlock 在派生时继承这些 provenance；
- materialize 失败时保留原始 observation，并标记状态不完整，不能静默丢数据。

推荐存储形态是“结构化索引 + 压缩 blob + 周期 checkpoint”，而不是永久保存每一次完整 HTML，也不是永久保存无限 mutation 流。

### 6.1 P0.5 Unit 物化、Session Unit Ledger 与 Global Unit Index

本节不属于当前 Demo。

Page State 更新成功后，桌面端异步执行确定性 UnitExtractor：

```text
Page State(stateVersion)
  -> semantic candidates
  -> repeated-structure candidates
  -> independent-reading filter + nested ownContent exclusion
  -> main-content fallback（必要时）
  -> EvidenceBlock[]（挂 UnitObservation）
  -> identity resolution（permalink -> namespaced anchor -> 不强行合并）
  -> UnitObservation(partial/full/unknown) + CanonicalUnit upsert
  -> full 且稳定内容变化时新增 UnitVersion
  -> currentPageUnitIds replace
  -> Session Unit Ledger / Global Unit Index upsert
```

- Page 只作为容器，不能直接给 Topic 投票；Topic 计数建立在 CanonicalUnit 上。
- Page State 的 `currentPageUnitIds` 反映当前 DOM；Session Unit Ledger 记录本 Session 的 UnitObservation；Global Unit Index 累计全部 CanonicalUnit 与聚合统计（observation_count、sessionCount 等）。
- 虚拟列表从 DOM 移除 Unit，只更新 current set；观察历史与 CanonicalUnit 不受影响。
- 同一 Session、同一 Page 实例上稳定指纹与 extent 未变化的重复抽取不新增或改写 UnitObservation；只追加幂等 UnitObservationSourceLink。跨 Session/Page 或内容/extent 变化产生新观察。
- EvidenceBlock 是 observation-owned occurrence，正文通过 EvidenceBlob 内容寻址复用；不得跨 Observation 复用 EvidenceBlock ownership。
- 删除按可达性 GC：删 Observation/source links -> EvidenceBlock occurrence -> 无引用 EvidenceBlob -> 无 full 支撑 UnitVersion -> 无支撑 CanonicalUnit；不是 cascade delete。
- UnitExtractor 不阻塞 Capture，不使用 LLM/Embedding/网络；具体分级算法见 `P0_UNIT_EXTRACTOR_SPEC.md`；身份/版本/合并/删除语义见 `P0_ANALYSIS_UNIT_SPEC.md`。
- 语义与重复结构均不足时，可以对去噪后的离线 main content 产生一个明确 `main_content_fallback` 的 Unit；不得包装整个 Raw Page。
- EvidenceBlock 在一次抽取结果中独占；父 Unit ownContent 必须排除已接受子 Unit。
- DOM 出现只证明 `observed`；没有视口证据时不得把 Ledger Unit 标记为 `seen`。

## 7. Demo Evidence / Question / Answer Projection

用户主动提问时：

```text
用户明确选择当前页面或小型 Demo Session
  ↓
冻结 Page State watermarks
  ↓
Normalize / Clean / exact-deduplicate
  ↓
生成完整且有界的 QuestionProjection
  ↓ 用户预览 Page/Block/字节/Token 与正文并确认
LLM 输出受 schema 约束的 JSON
  ↓
本地验证 AnswerProjection -> Answer + claim-level Sources
```

投影必须：

- 带 `projectionVersion`、输入 `stateVersion`/sequence 范围和内容 hash；
- 携带 CoverageManifest（覆盖声明：范围、计数口径、分页、授权空窗、已知盲区），
  摘要在结果顶部渲染并进入模型上下文；无 manifest 的分析输出无效
  （`P0_COVERAGE_MANIFEST_SPEC.md`）；
- 保留每个 block 的来源引用，使回答可追溯；
- 同一版本和配置产生确定性结果；
- 可缓存，也可删除后重建；
- 不因生成 Markdown 而修改 Observation Log 或 Page State；
- 将网页文本视为不可信资料，不能把网页中的指令提升为系统指令。
- Demo 不做 FTS/Embedding/RAG 或语义 Retrieval；用户选择的整个 scope 必须落在 20 Pages、600 Blocks（2026-08-28 修订，原 200——块级合并投影后单页阅读历史常态数百块，见 P0_DEMO_SCOPE §2.4 批注）、512 KiB 和预计最多 32k Token 的上限内；超限就要求缩小 scope。
- AnswerProjection 每个 claim 至少引用一个 scope 内 DemoEvidenceBlock；引用存在只证明结构有效，语义支持率必须通过人工夹具评估。

QuestionProjection 与 AnswerProjection 的完整 schema、远程确认和失败规则以 `P0_DEMO_SCOPE.md` 为准。

### 7.1 P0.5 TopicProjection

本节不属于当前 Demo。进入 P0.5 后，TopicProjection 还必须：

- 携带并渲染 CoverageManifest（Topic 结果的覆盖声明同样强制，无豁免类型）；

- 冻结输入 `canonicalUnitId/evidenceBlockId/textHash` 集合，并只使用所选时间范围内存在观察的 CanonicalUnit；
- 缓存键包含输入集合、normalization、schema/prompt、model 和 projection settings 版本；
- 所有 topic、summary 和 relation 都绑定 scope 内真实 CanonicalUnit/EvidenceBlock reference；
- 节点大小由去重 CanonicalUnit 数确定；同一 CanonicalUnit 的重复观察、重复访问、多版本、多个 Block、Page 数和 Domain 数不能增加权重；
- 分析文本按 extent-aware 规则选取：scope 内有 Version 支撑取最新 Version 稳定内容，否则取最新 partial 观察内容并标注 partial；
- Session Unit Ledger / Global Unit Index 变化（含 Canonical merge）只把缓存标记为 stale，不在后台自动重算；
- Page/Unit/EvidenceBlock 删除（可达性 GC）后同步失效或清除相关投影；
- 不反向修改 Observation Log、Page State 或 Markdown。

`page.md` 若落盘，应标注它是 derived artifact，并写入对应状态版本。它不是审计日志。

## 8. 保留、压缩与隐私

“Raw 是事实源”不等于“所有原始 DOM 永久保存”。原始 DOM 往往比 Markdown 更敏感、更大。

当前 Demo 尚未实现登录态数据所需的本地加密和密钥管理，因此只允许公开、非敏感文本页面；登录后台、支付、身份认证、医疗、金融、邮箱、私信和编辑器均为 unsupported。P0.5 只有在完成威胁模型、系统凭据库和本地加密后才能扩大范围。

必须具备：

- 域名级允许/拒绝规则和一键暂停；
- 默认排除密码页、支付页、身份认证页、无痕窗口和用户配置的敏感域；
- 在持久化之前清除 `input`/`textarea`/`select` 值、密码、token、cookie、authorization、表单草稿及已知密钥模式；
- 不记录键盘输入；点击只允许记录不含字段值的语义目标，且默认关闭；
- 每会话/域名/全局大小配额和 TTL；
- checkpoint + delta 压缩；压缩后允许删除被覆盖的低价值原始 mutation，但保留来源范围和压缩记录；
- 用户可以按会话、页面和域名彻底删除捕获数据及其投影/Embedding；
- 本地加密和密钥管理在接入真实登录态页面前完成威胁建模。

## 9. P0 Demo 范围

第一阶段只验证：

1. 主 frame 页面导航能够创建正确的 `pageInstanceId`；
2. 首屏可读内容能低延迟生成首个 `dom_snapshot(reason=initial_readable)`；
3. 无限滚动/评论加载能经 dirty 合并更新 Page State；
4. 删除、替换和 SPA 路由不会污染旧状态；
5. 用户从当前页面或小型 Demo Session 生成确定性、有界的 DemoEvidenceProjection/QuestionProjection；
6. 超过 Page/Block/字节/Token 上限时要求缩小 scope，不做语义检索或静默截断；
7. 用户预览并确认远程处理后才调用模型；未确认时调用次数为零；
8. AnswerProjection 每个 claim 都引用 scope 内有效 DemoEvidenceBlock，并显示 Sources；
9. 高频变化页面不会造成无限 CPU、内存或磁盘增长；
10. 表单值和敏感字段在持久化前被清除，敏感页面明确拒绝。

首版明确不做：

- XHR response body 捕获；
- 键盘输入和表单内容捕获；
- 全量点击追踪；
- 永久保存每条 DOM mutation；
- 每次 mutation 都生成完整 Markdown；
- 为生成问题而实时调用 LLM；
- 因 Capture 变化而后台生成任何 AI 投影；
- UnitExtractor、CanonicalUnit/UnitVersion、Global Unit Index 和 TopicProjection；
- 桌宠、Topic Cloud、登录态敏感页面和正式安装分发。

## 10. 验收场景

至少使用以下页面类型做固定回归样例：

- 服务端渲染文章：首屏立即捕获；
- React/Vue SPA：document 不变但路由变化；
- 无限滚动列表：新增内容合并且去重；
- 评论区：插入、编辑、删除均正确反映；
- 高频动画页面：事件风暴受控；
- iframe/shadow DOM 页面：覆盖范围明确且不崩溃；
- 登录/支付/编辑器页面：Demo 明确拒绝，且任何已构造的表单属性在 Native Host 前被清除；
- 同 URL 刷新两次：产生两个可区分的页面实例。

P0.5 进入完整 Unit/Topic 阶段后再增加：

- article/feed/list/schema 页面：高置信语义候选正确物化 Unit；
- 重复 sibling 页面：达到阈值才拆，导航/按钮/骨架屏不拆；
- 主帖嵌套评论：父 ownContent 与子 Unit EvidenceBlock 零重叠；
- 陌生文章页：主内容 extractor 产生一个 fallback Unit，空结果不包装 Raw Page；
- 虚拟列表：Unit 离开 DOM 后仍留在 Ledger，重现时不重复计票；
- Feed 卡片与详情页：同 permalink 归并为同一 CanonicalUnit，partial/full 不产生 UnitVersion；
- 评论编辑：两次 full 观察稳定内容不同才产生新 UnitVersion；点赞数/相对时间变化不产生；
- 跨 Session 重访：Topic Cloud 对同一帖子只计一个 CanonicalUnit。

## 11. 对 AI 编码代理的硬约束

- 不得把 Markdown 当作捕获层数据库。
- 不得以 `load` 或“网络空闲”作为唯一捕获时机。
- 不得因 debounce 丢弃 trigger observation；debounce 只用于合并触发和安排一次全 document Raw Snapshot。
- 不得把页面状态实现成 Block append；P0 通过 replace snapshot/reset document 反映新增、修改、删除和移动。
- 不得用 URL 作为页面实例主键。
- 不得跨 document/授权 generation 复用 content script、MutationObserver 或消息 port。
- 不得在捕获热路径调用 Defuddle、Embedding 或 LLM。
- 不得永久无界保存完整 DOM 或 mutation。
- P0 不得启动专用 Chromium、连接 CDP、开放调试端口或加入 `chrome.debugger`。
- P0 只允许注入固定 ISOLATED content script；不得使用 MAIN world、远程代码、动态代码字符串或修改页面。
- 不得把点击、网络响应或表单字段偷偷扩入 P0。
- 任何新增 Extension permission、host permission、浏览器 API 或跨 frame 能力必须先更新权限说明、威胁模型和测试。
- P1 若引入 CDP，任何 command/event 必须先更新精确 allowlist，不能按名称模式自动判定安全。
- 任何投影都必须可追溯到确定的输入状态版本和 observation 范围。
- 当前 Demo 不得实现 TopicProjection、CanonicalUnit、UnitVersion、Global Unit Index 或完整 UnitExtractor。
- P0.5 的 TopicProjection 只能由明确用户动作生成；不得把 stale cache 当成后台重算许可。
- P0.5 中 Page 只是容器，不得直接成为 Topic 计数票；Topic 大小只按去重 CanonicalUnit 数。
- P0.5 UnitExtractor 必须异步、确定性、无 LLM/Embedding/网络，并遵守 Semantic -> Repeated Structure -> Main Content fallback 顺序。
- 不得把捕获文本差异直接等同于内容编辑；UnitVersion 只由两次可比较 full 观察的稳定内容差异产生。
- 不得用 text hash、Page URL 或运行期 node id 合并 CanonicalUnit；身份键必须按 `P0_ANALYSIS_UNIT_SPEC.md` 的优先级解析并命名空间化。
- 不得把 DerivedMetadata（type 等）变化写成 UnitVersion；解释版本与源版本必须分离，且不回写历史。
- 不得让 LLM 生成或改写 CoverageManifest；覆盖声明只能从 Observation Log 与 Page State 确定性派生。
- 不得把 scope 内样本表述为站点/版块整体，不得声明分页穷尽；覆盖表述以 CoverageManifest 为界。
- 不得用布尔字段表达 Unit 在场状态；`absent_last_snapshot` 不得解读、暗示或展示为"已删除"。
- 不得聚合不同 parsePolicy 的 ObservedMetric.parsedValue，不得把 rawText 直接当数值；聚合必须报告 parsed/total 覆盖率。
- P0.5 不得改写 UnitObservation 来追加 source；使用 UnitObservationSourceLink。不得跨 Observation 复用 EvidenceBlock ownership；只允许复用 EvidenceBlob。
- 不得把 feed/list 容器、任意 listitem、无法映射的 JSON-LD 或整个 Raw Page 直接包装成 Unit。
- 父 Unit 不得包含已接受子 Unit 的 EvidenceBlock；一次抽取中的 block 必须独占。
- DOM removal 不得删除 UnitObservation/CanonicalUnit；DOM 出现也不得自动标记为用户 `seen`。
