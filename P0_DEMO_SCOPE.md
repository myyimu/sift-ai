# Sift AI P0 Demo：可运行纵向切片

> 状态：当前工程里程碑与唯一 P0 实现范围。原 `P0_ANALYSIS_UNIT_SPEC.md`、`P0_UNIT_EXTRACTOR_SPEC.md` 和 `P0_TOPIC_CLOUD_SPEC.md` 中的完整身份、抽取与主题能力自本版起属于 P0.5。若其他文档仍把桌宠、Topic Cloud、Global Unit Index、Canonical merge、UnitVersion 或登录态捕获列为当前 P0，均以本文件为准并同步修订。

## 1. Demo 要验证的唯一命题

> 用户主动授权一个文本型网页后，Sift 能否在不操作浏览器、不读取表单秘密、不调用后台 AI 的前提下，把当前页面或一个小型手动 Session 转成有来源的证据块，并在用户提交问题后给出可回查的回答？

Demo 只验证这条纵向链路：

```text
用户在自己的 Chrome 中点击 Extension action
  -> activeTab + 固定 ISOLATED content script
  -> 初始脱敏 DOM Snapshot + MutationObserver
  -> service worker -> Native Messaging
  -> 本地 Observation Log + 当前 Page State
  -> 用户选择“当前页面”或小型 Session
  -> 确定性 DemoEvidenceProjection
  -> 用户确认远程处理范围并提交问题
  -> LLM 输出 AnswerProjection
  -> 本地验证引用 -> Answer + Sources
```

价值判断只看两件事：

1. 用户是否比逐条阅读更快得到可信答案；
2. 用户是否愿意点击来源回到原网页核验。

## 2. 当前 P0 包含

### 2.1 运行范围

- Windows-only 内部 Demo；
- 开发者模式加载的 unpacked MV3 Extension；
- 使用固定 demo key 得到稳定的 Demo Extension ID，Native Host 只允许该 ID；
- Native Host 由开发脚本手动注册，不提供正式安装器、自动升级或 Chrome Web Store 分发；
- 简单桌面窗口或托盘面板，不实现桌宠、Always-on-top、跨显示器停靠和动画；
- 只支持用户明确选择的公开、非敏感、文本型主 frame 页面；
- 默认 scope 为当前页面，可手动把已授权页面加入当前 Demo Session。

### 2.2 捕获范围

- manifest 权限只允许 `activeTab`、`scripting`、`nativeMessaging`、`storage`；
- 仅在 Chrome 认可的用户手势后注入扩展包内固定文件；
- 固定 `world: "ISOLATED"`，只观察主 frame；
- 页面达到最低可读条件即生成首个 Snapshot；
- MutationObserver 只记录 dirty trigger；默认 `debounce=200ms`、`maxWait=2000ms`；
- 每个页面只保留一个待提交的 latest-wins Snapshot；已 commit 的 Observation 不丢弃；
- 源端先克隆并脱敏，再序列化和 hash；不得读取 live form property；
- Snapshot 超过 5 MiB、DOM 节点超过 50,000 或深度超过 128 时失败关闭并显示 `capture_limit_exceeded`；
- Native Messaging 默认 256 KiB 分块，host 完成原子写入后才返回 commit ack；
- 相同 payload hash 复用 blob，Page State 采用 replace snapshot，不做 DOM patch。

这些值是版本化 Demo 默认值，不是长期产品承诺；真实基准可以通过 ADR 调整，但不得静默放宽。

Demo 的 `readable-v1` 条件为：存在非空 body，删除 script/style/template/noscript/控件和明确 loading/骨架节点后至少有 80 个非空白文本字符。授权后最多等待 5 秒；仍不足时返回 `capture_too_little_content`，不包装空页面。

> **批注（2026-08-28，实测修正）**：源端去噪的广告 token 规则（class/id 按
> `[-_\s]` 切分后与词表精确匹配、命中整树移除）补充两道防线：**html/body 等
> 结构性根元素永不参与广告判定**；**命中 token 但子树超过 64 个元素的不剥**
> （继续向下递归，叶子广告块仍会被各自命中）。起因：linux.do（Discourse
> welcome-banner 主题）在 `<body>` 上挂含 `banner` token 的类，旧规则把整棵
> body 删除，页面可见内容满屏却报 `capture_too_little_content: 0 < 80`——
> 经三轮线上 DOM 诊断（仅计数/标签级输出，未取页面内容）定位。这是对规则
> 原意（剥广告单元，非剥结构容器）的缺陷修复，非放宽；回归测试见
> `apps/extension/test/capture.test.ts`（body 误杀/大容器误杀/小广告仍剥三例）。

### 2.3 本地数据

Demo 只需要：

```text
ObservationEnvelope
SanitizedSnapshotBlob
PageMaterializedState
DemoEvidenceProjection（可删除、可重建）
AnswerProjection（可删除、可重建）
```

Demo 不实现 CanonicalUnit、UnitVersion、DerivedMetadata、Global Unit Index、Canonical merge 或可达性 GC。删除 Page/Session 时，使用引用计数删除不再可达的 blob 和对应派生投影；这只是 Demo Store 生命周期，不宣称实现 P0.5 内容身份语义。

Demo 默认使用 SQLite 保存结构化索引和状态，压缩后的内容寻址 Snapshot blob 放在应用数据目录的独立 blob 目录；数据库事务提交索引和 blob 引用，blob 使用同目录临时文件 + 原子 rename。默认 TTL 为 7 天、单 Session 250 MiB、全局 1 GiB；达到配额时暂停新捕获并要求用户删除数据，不自动删除尚未过期的 Session。

> **批注（2026-08-27，用户批准）**：P0 最小捕获闭环阶段，存储引擎由
> [ADR-003](ADR-003_STORE_FILE_SYSTEM.md) 取代为纯文件系统实现（blob 目录 +
> JSONL journal + page-state JSON）。TTL/配额/幂等/原子性等**行为语义不变**；
> SQLite 引擎在出现第二个写者或投影查询需求时按 ADR-003 §5 退出条件另行决策；Host 启动和 UI 启动分别执行 7 天 TTL 回收。

### 2.4 Demo Evidence 投影

用户提交问题前，从冻结 Page State 生成确定性投影：

`demo-projector-v1` 不使用 Defuddle/Readability、LLM 或站点 Adapter：

1. 对已脱敏的离线 DOM 克隆删除 `script/style/template/noscript/nav/header/footer/aside/form/dialog`、交互控件、hidden/aria-hidden 和已知噪声；
2. 优先选择 eligible text 最多的 `main`；没有 main 时选择全部通过最低文本检查的顶层 `article/[role=article]`；仍没有时使用去噪 body；
3. 按 DOM 顺序从 heading、paragraph、blockquote、pre/code、table row、信息量 list item 和剩余连续文本生成块；
4. heading 只要求非空；其他普通文本块默认至少 20 个非空白字符；
5. 同一 Page State 内按规范化 textHash 去除精确重复块，同时保留所有来源 page refs；
6. 空结果返回 `projection_empty`，不得把 Raw outerHTML 直接送给模型。

完整 Semantic/Repeated/Main Content UnitExtractor 和 Defuddle/Readability 质量调优属于 P0.5。

```ts
type DemoEvidenceBlock = {
  id: string                    // projection 内不透明 ID
  kind: 'heading' | 'paragraph' | 'list_item' | 'quote' | 'code' | 'table' | 'unknown'
  text: string                  // 已脱敏、确定性归一的原文
  textHash: string
  sources: Array<{
    pageInstanceId: string
    stateVersion: number
    ordinal: number
    title?: string
    safeUrl: string
    capturedAt: string
  }>
}

type QuestionProjection = {
  schemaVersion: 1
  projectionVersion: 1
  question: string
  scope: 'current_page' | 'demo_session'
  pageStateWatermarks: Array<{
    pageInstanceId: string
    stateVersion: number
    lastAppliedSequence: number
  }>
  coverage: CoverageManifest    // 见 P0_COVERAGE_MANIFEST_SPEC.md；摘要必须进入模型上下文
  blocks: DemoEvidenceBlock[]
  inputHash: string
  limits: {
    maxPages: number
    maxBlocks: number
    maxUtf8Bytes: number
    maxEstimatedTokens: number
  }
  truncation: 'none'
}
```

Demo 不做语义 Retrieval。选择算法固定为：

1. 用户明确选择当前页面或 Demo Session；
2. 按每个 block 第一条 source 的 `capturedAt, pageInstanceId, ordinal` 确定性排列全部 eligible block；
3. 去除精确重复 textHash，把所有去重前来源合并进排序后的 `sources[]`；
4. 整体必须落在所有上限内；
5. 任一上限超出就要求用户减少页面，不静默截断、不抽样、不伪装成完整 scope。

默认上限：20 Pages、600 Blocks（2026-08-28 修订，原 200——见下批注）、512 KiB UTF-8、预计输入 Token 不超过 `min(32,000, modelContextWindow - 8,000)`。

> **批注（2026-08-28，用户授权：块级合并投影）**：用户实测后提出核心诉求——"提问的对象
> 应该是我一段时间看的内容，不是提问瞬间的最后一屏"。据此投影输入从"每页冻结 Page State
> 的最新一张快照"改为"**该页 journal 内全部已 commit 快照（distinct payload 首见序列）的
> 块级合并**"：同文本跨快照按 textHash 去重并合并 sources，块终序按首见 capturedAt
> （= 阅读顺序）。页内滚动历史自此不丢——虚拟化列表（如 Discourse）滚过的楼层重新成为
> 可提问的证据；数据全部来自本就全量保留的 journal，捕获侧零改动。`maxPages` 计数单位
> 澄清为 distinct pageInstanceId（同页多快照是多个投影输入但仍是 1 页）。全部预算与
> "全量或不发送"不变：长帖累积并集超限仍整体拒绝并要求缩小 scope。实现：
> `apps/desktop/src/qa-service.ts` buildProjectionForScope（逐快照 stateVersion 按
> page-state reducer 同款重放推导）；回归见 `apps/desktop/test/qa-service.test.ts`
> "滚动历史块级合并"用例与 `packages/projector/test/project.test.ts` 快照数/页数用例。
>
> **同日修订（用户授权：MAX_BLOCKS 200 → 600）**：合并投影落地当天实测即触界——单页
> 阅读历史 320 块（39KB/12.7k token，字节 7%、token 40%）被 200 块计数上限拒绝，且
> current_page 已是最小 scope、"缩小 scope"无从下手。200 标定于"每页最新一张快照"
> 时代（20 页 × ~10 块），合并语义下成为与字节/token 无关的人为瓶颈。600 的锚点：
> 每块 prompt 头部（`[b-0123|kind]` ≈ 10-12 token）不计入 estimateTokens，由
> TOKEN_CTX_RESERVE=8k 兜底，600 × 12 ≈ 7.2k < 8k——估算保持诚实；此后 token 预算
> `min(32,000, ctx−8,000)` 成为真正的物理约束（CJK 内容 ~800 块时先于块数触发）。
> 防漂移守卫 `packages/shared/test/limits.test.ts` 同步。
>
> **再修订（同日，用户实测纠偏：合并按 URL 分组，不跨 URL 合并）**：合并投影落地后
> 用户发现不同 URL 的快照被并进同一 current_page 投影。根因：**SPA 软导航
> （pushState，无新 document）不换 pageInstanceId**（硬导航换 pid，见
> P0_EXTENSION_ARCHITECTURE / SW `document_started` 分支），linux.do（Discourse）这类
> SPA 从帖子 A 点进帖子 B，两帖楼层同 pid 落盘。修正：快照按 **分组键
> `origin + 路径(剔尾部纯数字段) + query(剔分页参数) + title`**（`@sift/projector`
> `snapshotGroupKey`）切组——尾部数字段是滚动楼层号（Discourse `/t/slug/123/45` →
> `/t/slug/123/120`），剔除后单帖滚动史不碎裂；非数字尾段（不同文章 slug）与 title
> 差异保持区分。**current_page 只取最新快照所在的组**（"现在看的这个帖子，含滚动
> 史"）；同 pid 其他 URL 组只进 demo_session scope（"这段时间看过的所有内容"）。
> 回归见 qa-service.test.ts "SPA 软导航不跨 URL 合并" 与 manifest.test.ts
> snapshotGroupKey 用例。

### 2.5 AnswerProjection

模型只能返回受 schema 约束的 JSON：

```ts
type AnswerProjection = {
  schemaVersion: 1
  answer: string
  claims: Array<{
    claimId: string
    text: string
    evidenceBlockRefs: string[] // 至少一个，必须属于 QuestionProjection
  }>
  limitations: string[]
  sources: Array<{
    evidenceBlockRef: string
  }>
  analyzer: {
    provider: string
    model: string
    promptVersion: string
  }
}
```

本地验证器必须拒绝非法 JSON、未知 block ID、空引用、重复 ID、超长字段和 HTML/脚本输出。引用存在只证明结构有效，不自动证明语义蕴含；UI 必须标记回答为 AI 归纳，并提供原始 EvidenceBlock。Demo 通过人工夹具评估 claim 是否被引用证据支持。

> **批注（2026-08-28，已落地）**：ModelAdapter 与本地验证器实现于 `packages/model`
> （`@sift/model`，依赖仅 @sift/shared + Node 内建）。adapter 按 ADR-001 E-06 冻结语义：
> OpenAI 兼容 Chat Completions 非流式单次调用；`response_format` 两级
> （`json_schema strict` → 端点 400 且报文提及 response_format/json_schema 时降级
> `json_object` + schema 注入 system prompt，属协议分支不算重试）；网络/非 2xx/校验失败
> 恰好一次确定性重试；超时 90s（`MODEL_TIMEOUT_MS`，demo 默认值放 @sift/model，
> 不触碰冻结的 limits.ts）。验证器 `validateAnswerProjection` 实现上述全部拒绝规则
> （zod 复用 shared schema → 跨对象不变式 → demo 版本化长度上限 → HTML/脚本启发式）。
> **analyzer 三元组由本地盖章**（provider=baseUrl host、model=config.model、
> promptVersion='answer-v1'），模型自报值一律覆盖——已在单测与全链 E2E 双重断言。

每次回答顶部必须渲染 CoverageManifest 摘要（`P0_COVERAGE_MANIFEST_SPEC.md` §5 的固定块）；`limitations` 不得与 manifest 矛盾。absent 语义（"最近一次观察中未见"）不得展示为"已删除"。

问题超出 scope 时，模型必须返回 limitation；不得联网补充、调用浏览器或把预设问题当白名单。

## 3. 隐私与远程模型边界

Demo 尚未完成真实登录态数据的本地加密与密钥管理，因此：

- 不支持登录后台、支付、身份认证、医疗、金融、邮箱、私信、编辑器和其他敏感页面；
- 默认拒绝无痕、`file:`、浏览器内部页和非 `http/https` scheme；
- 对 URL/path/title 命中 `login/signin/auth/oauth/account/billing/payment/checkout` 等版本化规则时默认拒绝，并允许用户继续扩大拒绝列表；
- 规则没有命中不代表页面安全；Demo UI 必须明确要求用户只选择公开、非敏感页面；
- clone sanitizer 必须清除 `input`、`textarea`、`select`、`option[selected]`、`contenteditable`、`value`、token/signature/session 参数和已知密钥模式；
- Raw DOM 不进入日志、telemetry、AI 请求或版本控制；
- Demo 不持久化模型 API Key；开发时只从进程环境读取；
- Demo 只实现一个可替换的 `ModelAdapter` 接口和一个开发期 provider 配置，不做 provider 切换 UI；所选模型必须支持受 schema 约束的 JSON 输出；
- 每次远程调用前展示 Page/Block/字节/预计 Token、provider/model 和将发送的文本预览；用户确认后才发送；
- 取消或模型失败不影响本地 Capture。

真实登录态页面、本地加密、系统凭据库、正式删除承诺和远程处理长期授权属于 P0.5 的发布前阶段门。

> **批注（2026-08-28，已落地）**：本节模型边界由 `@sift/model` + `apps/desktop`
> qa-service/UI 落地：API Key 只从进程环境 `SIFT_MODEL_API_KEY` 读取（qa-cli 亦不接收
> key 参数），不持久化、不进日志、不进答案投影与 store（E2E 断言答案文件无 key）；
> 确认屏（UI preview / qa-cli `--out` 前）展示 Page/Block/字节/预计 Token、provider
> origin 与 model；用户确认前模型调用次数为零（全链 E2E 断言 mock 恰好 1 次请求，
> degrade 恰好 2 次）；coverage 摘要（`renderCoverageSummary`）同时进入 system prompt
> 与 UI 回答顶部。真实 provider 冒烟留给用户手动（RUNBOOK §1/§5.6 记录 env 配置法）。
>
> **批注补充（2026-08-28，用户授权放宽）**：E-06 原"baseUrl 必须纯 origin"规则
> 挡住了国内 OpenAI 兼容端点（阿里百炼等普遍要求固定 basePath），用户明确提出
> 接百炼需求后放宽为：允许**固定静态 basePath**（段仅限字母/数字/`._~-`，禁
> query/fragment/userinfo/`..`，尾斜杠规范化）。透明性不降级：完整 baseUrl
> （origin+path）必须显示在 UI 确认屏与顶栏摘要（`ModelConfigSummary.baseUrl`
> 携带完整地址），与"防 Key 发往未预览位置"的原意图一致——见
> `packages/model/src/config.ts` 头注与 config.test.ts。

## 4. 明确降级到 P0.5

以下能力不进入当前 Demo：

- 桌宠、气泡轮播、Always-on-top、跨显示器和减少动态效果完整交互；
- Topic Cloud、TopicProjection、主题缓存、关系距离和 Topic Detail；
- Semantic -> Repeated Structure -> Main Content 完整 UnitExtractor；
- UnitObservation / CanonicalUnit / UnitVersion / DerivedMetadata；
- Session Unit Ledger / Global Unit Index、跨 Session 去重、partial/full 版本语义；
- Canonical merge、可达性 GC 和历史主题身份；
- FTS、Embedding、RAG、MCP、趋势、热点、Signal；
- 登录态/敏感页面捕获和本地加密；
- optional host permission、正式安装器、Chrome Web Store、自动更新和多平台支持。

这些能力不是取消，而是在 Demo 证明“有来源问答确实节省时间”后进入 P0.5。

## 5. Demo 状态与失败

至少显示：

```text
未授权当前页面
正在捕获
已保存到本地
观察已暂停
跨域后需要重新授权
Native Host 未连接
页面不受支持
页面超过 Demo 上限
正在生成问题投影
等待远程处理确认
正在回答
回答或引用校验失败
```

不得显示 Topic、Signal、趋势或“已经发现”的事实性文案。

## 6. Demo 验收门

开始内部演示前必须通过：

1. 仓库有可复现的安装、构建、测试和卸载说明；
2. Manifest 只含四项允许权限，且没有 host permission；
3. 未经用户手势不能读取页面；跨 origin 后停止并要求重新授权；
4. 只注入固定 ISOLATED 文件，静态扫描和 mutation canary 证明没有 DOM/focus/scroll/navigation 写入；
5. 初始 Snapshot、debounce/maxWait、latest-wins、hash 去重和 replace Page State 行为通过测试；
6. 表单、contenteditable、敏感 URL、恶意 YAML/HTML、路径穿越标题在 Native Host 前已脱敏或拒绝；
7. Native Messaging 分块、origin、schema、顺序、hash、重复 commit、断线和背压失败关闭且幂等；
8. 相同 Page State 和 projectionVersion 产生相同 DemoEvidenceProjection 与 inputHash；
9. 用户未提交问题并确认远程发送前，模型调用次数为零；
10. QuestionProjection 超限时明确要求缩小 scope，绝不静默截断；
11. AnswerProjection 的所有 claim 都有 scope 内有效 DemoEvidenceBlock reference；非法或悬空引用整次失败；
12. 至少使用文章、列表、评论、代码、表格、SPA、恶意 prompt、表单和超大 DOM 夹具回归；
13. Native Host 未运行、写盘失败、模型失败和空正文均显示真实错误，不伪造成功；
14. 用户可以预览、暂停并删除当前 Page/Session 的本地数据和派生回答；
15. 记录内部演示的回答耗时、来源点击率、引用支持率和用户主观节省时间；
16. 每次分析输出顶部渲染 CoverageManifest 摘要；无 manifest 的输出视为无效；任何输出不得把 scope 内样本表述为站点整体，不得把"最近观察中未见"表述为"已删除"（`P0_COVERAGE_MANIFEST_SPEC.md`）。

通过这些门后，Demo 可以用于内部或少量受控用户验证；它仍不能作为支持登录态内容的公开产品发布。
