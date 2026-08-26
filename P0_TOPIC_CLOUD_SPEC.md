# Sift AI P0.5：Topic Cloud 第二界面规范

> 状态：P0.5 规范性产品与数据契约，不属于当前 P0 Demo。当前 Demo 只有有界问答与 Sources；只有 Demo 价值通过后才进入本文件定义的第二界面。输入单位与证据契约以 `P0_ANALYSIS_UNIT_SPEC.md` 为准。若其他文档把 P0.5 主题云描述为后台自动聚类、趋势雷达、传统高频词云或 Page 计票，以本文件为准并修订冲突。

## 1. 产品定位

P0.5 有两个并列入口：

```text
桌宠
├── 问 AI：预设问题 + 自由提问 + Answer/Sources
└── 主题地图：Topic Cloud + Topic Sources
```

主题云回答：

> 在我选择的本地捕获范围内，我最近主要接触了哪些主题？

它不回答“整个互联网最近在讨论什么”，也不证明某个主题正在升温。所有标题、计数和范围说明都必须带有“我的捕获内容 / 当前所选范围”的语义边界。

Topic Cloud 不是传统词频词云。不得把 `AI`、`用户`、`代码`、`开发`、`模型` 等高频通用词直接放大；节点必须是能区分一组来源、可以被人理解和追溯的主题，例如：

```text
Vibe Coding
大型项目维护
Agent Memory
MCP 生态
AI 产品获客
Context Engineering
```

## 2. P0.5 成本与触发边界

捕获链路和桌宠气泡继续保持零 AI 成本。主题云是用户主动发起的语义分析，不是后台能力。

```text
自动 DOM Capture                 -> 不调用 AI
预设问题选择与轮播                 -> 不调用 AI
用户点击“主题地图 / 生成主题图”      -> 允许一次按需 Projection + LLM
主题图已生成但 Capture Store 有变化  -> 只标记“有新内容待更新”
用户点击“更新主题图”                -> 才再次调用 AI
```

P0.5 允许：

- 用户选择 `今天 / 7 天 / 30 天` 后主动生成主题云；
- 对选定范围做一次有界、结构化的主题归纳；
- 缓存生成结果并在输入没有变化时直接复用；
- 点击主题查看摘要和来源；
- 用户继续从主题详情进入自由提问。

P0.5 禁止：

- 定时或每次 DOM mutation 后自动调用 LLM；
- 后台自动 Embedding、持续聚类或无感刷新；
- 把主题云节点描述成“热点”“趋势”“异常”“正在升温”；
- 在没有历史基线和稳定主题身份时显示 `NEW`、上涨或下跌；
- 因打开桌宠、轮播气泡或普通捕获而生成主题云；
- 为主题云引入 RAG、向量数据库或浏览器新权限。

若远程模型会接收内容，生成前必须显示范围、页面数量、域名数量和远程处理提示，并沿用全局的最小化、预览、取消和审计策略。

`今天 / 7 天 / 30 天` 只是时间过滤器，不保证内容一定能放进模型上下文。生成前必须计算去重后的 Unit 数、页面数、字节数和预计 Token；超过 P0.5 上限时要求用户缩短范围或排除来源，不得静默截断、随机采样或把缺失内容仍描述为完整范围。P0.5 默认只执行一个有界主题分析请求；多阶段 map-reduce 属于后续单独验证的成本/质量决策。

## 3. 用户流程

```text
点击桌宠
  ↓
[问 AI] [主题地图]
          ↓
选择 今天 / 7 天 / 30 天
          ↓
显示范围：Unit 数、页面数、域名数、排除项、模型/本地处理状态
          ↓
点击“生成主题图”
          ↓
读取选定范围的 Global Unit Index（时间范围内存在观察的 CanonicalUnit）
          ↓
Normalize / Deduplicate / Bound Context
          ↓
LLM 输出结构化 TopicProjection
          ↓
验证 CanonicalUnit / EvidenceBlock References
          ↓
确定性计算大小、关系权重与布局
          ↓
Topic Cloud
          ↓ 点击主题
Topic Detail + Sources + 自由提问
```

第一次没有投影时显示明确的“生成主题图”动作。已有缓存时立即展示缓存；若捕获范围后来发生变化，只显示例如“新增 8 个页面，更新主题图”，不得静默花费 Token 或悄悄改变布局。

数据不足时不凑主题：

- 没有可用页面：显示空状态和如何开始捕获；
- 只有极少内容：允许展示来源列表，但提示“内容不足，暂不生成可靠主题图”；
- 清洗或模型失败：保留原 Capture，显示可重试错误，不伪造主题。

主题地图属于桌面应用窗口，不注入网页 DOM，也不占用浏览器固定侧边栏。

## 4. TopicProjection 数据契约

主题云是可删除、可重建的 derived artifact，不是 Observation Store 的事实源。

```json
{
  "projectionId": "uuid",
  "projectionVersion": 1,
  "createdAt": "2026-08-26T10:00:00+08:00",
  "scope": {
    "from": "2026-08-19T00:00:00+08:00",
    "to": "2026-08-26T10:00:00+08:00",
    "canonicalUnitRefs": ["canonical-1", "canonical-2"],
    "evidenceBlockRefs": ["block-1", "block-2", "block-3"]
  },
  "analyzer": {
    "provider": "...",
    "model": "...",
    "promptVersion": "topic-v1"
  },
  "topics": [
    {
      "topicId": "projection-local-id",
      "label": "大型项目维护",
      "aliases": ["large-codebase maintenance"],
      "summary": "多份内容共同讨论 AI Coding 在大型代码库中的维护成本。",
      "canonicalUnitRefs": ["canonical-1", "canonical-2"],
      "evidenceBlockRefs": ["block-1", "block-3"]
    }
  ]
}
```

约束：

- `topicId` 在 P0.5 只保证当前 projection 内唯一，不伪装成跨时间稳定身份；
- `label`、`aliases` 和 `summary` 属于 `inferred`，不是网页原文；
- 每个主题必须引用真实存在且属于当前 scope 的 CanonicalUnit ID 和 EvidenceBlock occurrence ID；EvidenceBlob ID 只能用于正文去重，不能直接充当来源；
- 每个 EvidenceBlock 必须属于该主题引用的某个 CanonicalUnit 的观察（或其 UnitVersion 引用的 block）；
- 不存在的、越界的、关系不匹配或已删除的 Unit/Block 引用必须导致该主题被拒绝或整次投影失败；
- AI 只输出受 schema 约束的 JSON，不输出可执行代码、HTML、CSS、SVG 或任意 UI 配置；
- 所有文本按不可信输入转义，并限制标签、摘要、数组和总响应大小；
- 删除 Unit/EvidenceBlock 或改变 Session Unit Ledger 后，旧投影必须标记 stale；不能继续把已删除证据显示为有效来源。

输入集合必须冻结为确定的 CanonicalUnit/EvidenceBlock ID 与内容 hash 集合。同一 CanonicalUnit 的重复观察、重复访问或多个 UnitVersion 只能进入一次；Page 不直接进入 Topic 计数。只有 partial 观察的 CanonicalUnit 是合法计数与引用对象，其证据必须标注 partial。分析文本按 extent-aware 规则选取（见 `P0_ANALYSIS_UNIT_SPEC.md`）：scope 内有 Version 支撑取最新 Version 稳定内容，否则取最新 partial 观察内容。

## 5. 主题质量规则

一个主题进入主云至少要满足：

1. 标签具体，能让用户预测点开后会看到什么；
2. 至少绑定一个可回查 CanonicalUnit 和 EvidenceBlock；默认优先展示由两个及以上去重 CanonicalUnit 支持的主题；
3. 能与同一投影中的其他主题区分，不是同义词换写；
4. 摘要只概括证据范围，不扩大成行业或互联网总体判断；
5. 不把网站导航、登录、Cookie、版权声明、按钮文本等页面噪声当成主题。

默认生成 5-12 个主题。内容不足时可以少于 5 个，不得为了填满数量制造空泛节点。

需要合并：

```text
Agent Memory / 智能体记忆 / Agent 记忆
```

不应单独成为主题：

```text
AI / 用户 / 代码 / 开发 / 模型 / 问题 / 内容
```

除非这些词在当前证据中拥有更具体且可解释的限定语。

## 6. 视觉编码的真实含义

### 6.1 大小

节点大小表示去重后的 CanonicalUnit 数，不是观察次数、Session 数、Page 数、Domain 数、原始词频、字符数、DOM mutation 次数、EvidenceBlock 数、UnitVersion 数或页面版本数。

```text
unitCount(topic) = count(distinct canonicalUnitRef)
displaySize = boundedSqrtScale(unitCount)
```

使用开方或对数压缩并设置最小/最大字号，避免一个大主题吞掉全部画面。同一个 CanonicalUnit 的重复观察、重复访问、多个 UnitVersion 与多个 EvidenceBlock 都只计一次。Page 数和 Domain 数可以作为附加分布展示，但不得参与未解释的“热度”计算。

### 6.2 距离

只有存在可解释的关系度量时，距离才能表达“相关”。P0.5 默认使用两个主题共同引用 CanonicalUnit 的 Jaccard overlap：

```text
relation(A, B) = |units(A) ∩ units(B)| / |units(A) ∪ units(B)|    # units(X) = X 引用的 CanonicalUnit 集合
```

布局算法读取这个确定性权重；同一 `TopicProjection + layoutVersion + viewport class` 必须得到稳定布局。界面图例必须说明距离表示“共同涉及相同 CanonicalUnit”，不能暗示因果关系、属于关系或更广泛的语义事实。

如果没有可靠关系权重，则退化为普通 packed cloud，并明确说明位置仅用于排版；不得仍声称“越靠近越相关”。

### 6.3 新旧与趋势

P0.5 默认不显示 `NEW`、上涨、下降、升温或消退。它们需要：

- 可跨投影对齐的稳定主题身份；
- 明确的历史保留范围；
- 可重复的基线、时间窗口和阈值；
- 对新增来源、重复来源和缺失数据的处理。

未来即使加入 `NEW`，它也只能表示“首次出现在 Sift 保留的本地捕获历史中”，不能表示“互联网上首次出现”。

### 6.4 可访问性

- 颜色不能作为大小、新旧或关系的唯一载体；
- 所有节点支持键盘聚焦、可读标签和屏幕阅读器名称；
- 提供与主题云等价的列表视图，按 Unit 数排序；
- 支持减少动态效果，布局完成后不得持续漂浮；
- 缩放和小窗口下不得隐藏 Sources 入口。

## 7. Topic Detail 与来源

点击主题后，P0.5 打开详情抽屉或页面：

```text
主题标签
一句话摘要（明确标为 AI 归纳）
Unit 数 / Page 数 / Domain 数 / 时间范围
来源卡片：Unit 标题/类型、页面、域名、捕获时间、EvidenceBlock 片段、打开原网页
基于这个主题自由提问
```

来源排序首先考虑 Unit 代表性和去重，再考虑时间；不得只按网站自身热度排序。每个摘要和来源卡片必须能回到 CanonicalUnit 与 EvidenceBlock ID，打开原网页仍由用户主动完成。

P0.5 不显示没有真实实现的 `[关系] [脑图]` 空标签。后续能力成熟后再依次加入：

```text
Topic Cloud：我最近主要看了什么？
Relationship Graph：这些主题、人物、产品之间有什么有证据的联系？
Mind Map：选定主题下包含哪些便于理解的分支？
Timeline：本地历史中哪些主题出现、变化或消退？
```

关系图适合发现网络模式，脑图是选中主题后的树形理解投影；不得为了画树而把多父关系伪造成唯一父子关系。

## 8. 缓存与失效

TopicProjection 的缓存键至少包含：

```text
selected scope
+ ordered canonicalUnitId/evidenceBlockId/textHash set
+ normalization version
+ topic prompt/schema version
+ model identity
+ projection settings
```

- 键完全相同则直接复用，不再次调用 AI；
- Session Unit Ledger / Global Unit Index 新增观察、Canonical merge、UnitVersion 变化、Unit/Block 变化或删除时，旧投影只标记 stale；
- 只有用户点击更新才生成新投影；
- 旧投影可保留为审计记录，但必须与当前结果明确区分；
- 用户删除 Page/Unit/EvidenceBlock 时，相关投影和缓存必须同步失效或清除；
- 投影不反向修改 Observation Log、Page State 或 Markdown。

## 9. P0.5 验收测试

至少验证：

1. 未点击“生成/更新主题图”时，主题相关 LLM、Embedding 和聚类调用次数为零；
2. 时间范围、Unit/Page/Domain 排除准确改变输入 scope；
3. 所有 `canonicalUnitRefs/evidenceBlockRefs` 真实存在、属于 scope 且 Unit/Block 关系匹配；
4. 同一 CanonicalUnit 的重复观察、重复访问与多版本不会膨胀节点；Page 本身不投票；
5. 大小只由去重 CanonicalUnit 数决定并经过有界缩放；Page/Domain 只作附加统计；
6. 距离有可解释 overlap 权重；无权重时 UI 不宣称相关性；
7. 相同 projection 和布局版本产生稳定结果；
8. 空数据、少量数据、模型失败、非法 JSON 和悬空来源均有明确状态；
9. 网页中的 prompt injection、HTML、超长标签和伪造 source ID 不能突破 schema 或 UI；
10. 删除 Page/Unit/EvidenceBlock 后，相关主题缓存立即 stale 或被清除；
11. P0.5 不显示 `NEW`、趋势、升温、异常 Signal 或互联网总体结论；
12. 主题云、等价列表、Topic Detail 和 Sources 可键盘操作并支持减少动态效果；
13. 自由提问仍然可达，Topic Cloud 不取代 Chat；
14. 已有有效缓存打开即显示；有新 Capture 时只提示更新，不自动调用 AI。
15. 输入超过 Unit、页面、字节或 Token 上限时要求缩小 scope；不得静默采样后声称覆盖完整时间范围。
16. Feed 卡片与详情页归并为同一 CanonicalUnit 后只计一票；只有 partial 观察的 CanonicalUnit 可被计数且证据标注 partial。

## 10. 对 AI 编码代理的硬约束

- 不得实现传统词频词云并把它命名为 Topic Cloud。
- 不得在 Capture 热路径或后台定时生成、刷新主题。
- 不得把进入桌宠、打开普通面板或 DOM mutation 当成 AI 调用授权。
- 只有明确的“生成/更新主题图”用户动作可以触发主题分析。
- 不得为了主题云引入 Embedding、向量数据库、RAG 或新的浏览器权限。
- 不得使用观察次数、Page/Domain 数、mutation 数、词频、字符数、EvidenceBlock 数、UnitVersion 数或重复 Snapshot/重访直接决定节点大小。
- 不得让模型输出决定坐标、字体、HTML、SVG 或可执行 UI；视觉值由经过验证的数据确定性计算。
- 不得显示没有有效 CanonicalUnit/EvidenceBlock reference 的主题、摘要或关系。
- 不得用空间距离暗示未被当前度量支持的因果、从属或语义关系。
- 不得在 P0.5 标注 `NEW`、升温、下降或趋势。
- 不得把“用户本地捕获范围”扩大描述成“互联网”“社区整体”或“行业共识”。
- 不得因新增 Topic Cloud 而移除、隐藏或限制自由提问。
