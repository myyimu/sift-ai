# Sift AI P0.5：内容身份模型规范（UnitObservation / CanonicalUnit / UnitVersion / EvidenceBlock）

> 状态：P0.5 规范性数据契约，不属于当前 P0 Demo。当前 Demo 使用 `P0_DEMO_SCOPE.md` 的 DemoEvidenceBlock/QuestionProjection。本文件冻结下一阶段内容身份模型：UnitObservation、CanonicalUnit、UnitVersion、DerivedMetadata、EvidenceBlock、EvidenceBlob 及关联表的语义、身份消解、版本判定、合并与删除生命周期；具体抽取策略以 `P0_UNIT_EXTRACTOR_SPEC.md` 为准。
>
> 本版取代此前以单一 `AnalysisUnit` 对象同时承担"捕获记录"与"长期内容身份"的旧模型。术语 `AnalysisUnit` 自本版退役；`Session Unit Ledger` 的双重职责拆分为 Session Unit Ledger 与 Global Unit Index。

## 1. 冻结结论：四个必须分开的概念

```text
Observation      我这次看到了什么、看到了多少（捕获事实，不可变）
Entity           互联网中的一个逻辑内容对象（可合并、可解析）
Source Version   这个对象本身发生过什么变化（只由可比较的完整观察判定）
Interpretation   我们对 source 的理解（DerivedMetadata，可懒重算，永不回写历史）
```

Observation ≠ Entity ≠ Source Version ≠ Interpretation。这四个概念一旦混用，"Feed 卡片摘要 vs 详情全文"和"作者编辑了内容"就会互相污染。

对象模型：

```text
Session
  └── PageInstance                      # 捕获时的容器
        └── UnitObservation             # 不可变
              ├── UnitObservationSourceLink[] # 追加来源关系，不修改 Observation
              ├── captureExtent: partial | full | unknown
              ├── SourceMetadataSnapshot      # 本次观察到的 title/author/time
              └── EvidenceBlock[]             # 本次观察中的位置/归属，不可变
                    └── EvidenceBlob           # 正文按 textHash 内容寻址、可复用
                    ↓ 身份消解
CanonicalUnit                          # 逻辑内容对象；Topic 最小统计单位；可 mergedInto
  ├── UnitVersion[]                    # 源内容版本；按稳定指纹内容寻址
  │      ├── UnitVersionObservationLink[] # full 支撑或 partial 安全钉住关系
  │      └── UnitVersionEvidenceLink[]    # 引用 EvidenceBlock，不持有正文
  └── DerivedMetadata                  # type + parserVersion（解释层）
```

一句话：

> Topic 建立在 CanonicalUnit 上；Source/Evidence 建立在 EvidenceBlock 上；Page 与 UnitObservation 都只是容器/事件，不参与主题计数。

P0.5 不要求准确识别网站业务对象。重点不是判断"这是 V2EX 帖子还是 GitHub 评论"，而是判断"一段内容能否作为一个相对独立的信息块被阅读和分析"，以及"多次看到的内容是否是同一个逻辑对象"。

## 2. 对象契约

```ts
type CaptureExtent = 'partial' | 'full' | 'unknown'

type UnitType = 'article' | 'content' | 'comment' | 'unknown'

type IdentityKey =
  | { kind: 'permalink'; url: string } // 规范化绝对 URL
  | { kind: 'anchor'; origin: string; canonicalPageUrl: string; stableAnchor: string }
  | { kind: 'unkeyed' }                // 无安全键：不跨 Page 合并

type UnitObservation = {
  id: string
  canonicalUnitId: string
  captureExtent: CaptureExtent    // 默认 unknown
  observedAt: string              // 带时区 ISO 8601
  sessionId: string
  pageInstanceId: string
  extractionMode: 'semantic' | 'repeated_structure' | 'main_content_fallback'
  confidence: number              // 0..1，本次抽取对 Unit 边界的可靠度
  rawFingerprint: string
  stableContentFingerprint: string // normalizeStableContent(text, normalizerVersion)
  normalizerVersion: string
  volatileMetadata?: object       // 计数/相对时间等易变区域，绝不参与稳定指纹
  sourceMetadata?: SourceMetadataSnapshot
  evidenceBlocks: EvidenceBlock[] // 至少一个有效块
}

type UnitObservationSourceLink = {
  unitObservationId: string
  sourceObservationId: string     // capture 层 dom_snapshot 等 Observation
  linkedAt: string
}

type SourceMetadataSnapshot = {
  title?: string
  author?: string
  publishedAt?: string            // 带时区 ISO 8601；缺失保持缺失
}

type CanonicalUnit = {
  id: string
  identityKey: IdentityKey
  createdAt: string
  mergedInto?: string              # 墓碑；查询时经 resolveCanonical 收敛
  url?: string                     # Unit 自身 permalink；绝不是 Page URL
}

type UnitVersion = {
  id: string                       # 由 canonicalUnitId + normalizerVersion + stableContentFingerprint 命名空间化寻址
  canonicalUnitId: string
  stableContentFingerprint: string
  normalizerVersion: string
}

type UnitVersionObservationLink = {
  unitVersionId: string
  unitObservationId: string
  relation: 'supports_full' | 'pins_partial'
  linkedAt: string
}

type UnitVersionEvidenceLink = {
  unitVersionId: string
  evidenceBlockId: string
}

type DerivedMetadata = {
  canonicalUnitId: string
  parserVersion: string
  type: UnitType                   # 识别不确定时必须 unknown
}

type EvidenceBlock = {
  id: string
  unitObservationId: string        # 所属 UnitObservation
  evidenceBlobId: string
  textHash: string
  stateVersion: number
  ordinal: number
}

type EvidenceBlob = {
  id: string                       # sha256:<normalized-text-hash>
  text: string
  textHash: string
}
```

约束：

- 所有 `id` 均为本地不透明 ID。禁止使用浏览器/框架运行期生成或自增的 DOM Node ID、数组下标、CSS selector 作为唯一身份；允许站点为内容实体提供的稳定、内容寻址 identifier（如评论锚点 id）作为 identity signal（见 §4）。
- `UnitObservation` 是由 capture 层 Observation（`CAPTURE_ARCHITECTURE.md` §4 的 dom_snapshot 等事件）物化出的不可变索引行；它通过追加式 `UnitObservationSourceLink` 回溯一个或多个 source Observation，不在原对象数组上追加引用，也不构成第二条捕获写入路径。
- `type` 由确定性程序判定，不由 LLM 生成；识别不确定时必须 `unknown`。
- `url/title/author/publishedAt` 缺失时保持缺失，不由 AI 编造；title/author/publishedAt 属于每次 Observation 的 `SourceMetadataSnapshot`，不得用 CanonicalUnit 上的单值静默覆盖历史。页面只显示相对时间时保留原文或置信信息，不擅自推断绝对时间。
- `confidence/extractionMode/captureExtent` 是本次抽取的事实，随 Observation 不可变；重算产生新观察，不改写旧的。
- 聚合统计（observationCount、sessionCount、firstObservedAt、lastObservedAt）属于 Global Unit Index 的派生值，不是对象字段，不随观察冗余存储。
- `evidenceBlocks` 至少包含一个有效块；空文本、纯导航和纯控件不构成 Unit。
- "Unit 文本"不是存储字段，而是按 §11 的 extent-aware 规则从 EvidenceBlock 解引用 EvidenceBlob 后派生。

## 3. CaptureExtent：partial / full / unknown

```text
partial   只捕获到该逻辑对象的一部分，例如 feed 卡片摘要、截断列表项
full      extractor 判定已覆盖该对象的完整可读主体
unknown   无法判定；P0.5 默认值
```

- `captureExtent` 是 extractor 的版本化判断（随 parserVersion），不是页面事实；P0.5 默认 `unknown`，禁止把 partial 宣称为 full。
- Feed 卡片到详情页的正解：

```text
CanonicalUnit: /post/123
├── Observation #1 · partial · 卡片摘要 · 可选 pins_partial link
└── Observation #2 · full    · 详情全文 -> 建立/钉住 Version
```

用户后来点开详情页，绝不能被系统解释为"帖子被作者编辑了"。extent 差异落在 Observation 层，不落在 Version 层。
- 只有 partial 观察的 CanonicalUnit 是一等公民：它们拥有 EvidenceBlock、可进主题、可回查；UI 必须把其证据标注为 partial。

## 4. 身份消解（Identity Resolution）

优先级冻结：

```text
1. Unit 自身 permalink（规范化绝对 URL，自带命名空间）
2. 页面内稳定 anchor：key = (origin, canonicalPageUrl, stableAnchor)
3. 无安全键 -> P0.5 不做跨 Page 强行合并；宁可重复，不得误合
```

- **"Unit URL"指 Unit 自己的 permalink/anchor URL，绝对不是 Page URL。**
- anchor 键必须命名空间化：裸 `comment-123` 跨站必撞，绝不能作为键。
- canonical URL 作为键料/命名空间，与"URL 不是页面实例主键"（`CAPTURE_ARCHITECTURE.md` §3）不冲突：实例身份（pageInstanceId）与身份消解键料是两层。
- 相同 `stableContentFingerprint` 本身不构成合并依据：两条不同用户的"谢谢"必须保持两个 CanonicalUnit。
- 合并信号不足时宁可保留重复，不得破坏性地把不同内容合成一个。

## 5. 版本判定（UnitVersion）

新 Version 只在同时满足以下条件时产生：

```text
两次可比较的完整观察（双方 captureExtent = full）
+ 各自经 normalizeStableContent(text, normalizerVersion) 稳定化
+ 稳定内容确实不同
```

- 易变噪声必须进入 `volatileMetadata`，绝不进入 `stableContentFingerprint`：投票/点赞计数、相对时间戳（"2 hours ago"）、在线人数、展开/折叠状态、编辑标记。
- 首个 full 观察建立基线 Version；`captureExtent = unknown` 不参与版本比较；partial 永远不创建 Version。
- Version 在单个 CanonicalUnit 命名空间内按 `(canonicalUnitId, normalizerVersion, stableContentFingerprint)` 寻址；两个不同 CanonicalUnit 即使正文相同也不能共享 UnitVersion。edit 后 revert（v1 -> v2 -> 内容回到 v1）重新指向 v1，不新增版本记录。
- partial 观察可通过 `UnitVersionObservationLink(relation=pins_partial)` 钉住已有 Version，当且仅当存在安全判据（如稳定化前缀包含）；无判据时不建 link。关联可以在 Version 后来出现时追加，不需要改写历史 UnitObservation，也不得为满足数据结构强行制造 Version。
- UnitVersion 不持有正文，也不把可变 `blockRefs/firstObservedAt/lastObservedAt` 数组或聚合值塞进版本行。每个 full Observation 通过 `UnitVersionObservationLink(relation=supports_full)` 支撑版本，其 EvidenceBlock 通过 `UnitVersionEvidenceLink` 引用；首次/末次观察时间由关联表派生。
- UnitVersionEvidenceLink 只能引用 `supports_full` Observation 拥有的 EvidenceBlock；`pins_partial` 的摘要块不能混入完整 Version 正文。

## 6. EvidenceBlock 挂载与语义

EvidenceBlock 挂载在 UnitObservation 上，是 Topic、摘要和回答可追溯性的最小证据单位：

- EvidenceBlock 表示某个 UnitObservation 内的一次证据出现，拥有唯一 `unitObservationId + ordinal`，不能跨 Observation 共用所有权。
- 正文来自已经脱敏的 Snapshot，经确定性空白归一后存入 EvidenceBlob；不得由 LLM 改写、补全或翻译。
- `textHash` 对规范化文本计算；相同文本只复用 EvidenceBlob，不复用 EvidenceBlock。这样既能内容寻址去重，又不会丢失每次出现的来源和删除语义。
- `evidenceBlockId -> unitObservationId -> UnitObservationSourceLink -> sourceObservationId/stateVersion` 必须能回到产生该文本的本地证据状态。
- `ordinal` 只表示块在其 Observation 中的稳定展示顺序，不是跨 Snapshot 身份。
- DOM path、selector 或 node ID 可以作为可选诊断信息，但不能成为唯一来源证明。
- 同一个 EvidenceBlock 可以支持多个 Topic/Claim；每个 Topic/Claim 必须显式列出它使用的 block ID。
- 嵌套 Unit 的独占规则以 `P0_UNIT_EXTRACTOR_SPEC.md` 为准：一次抽取结果中每个 block 只属于一个 Unit，父 Unit ownContent 排除已接受子 Unit。

"原始文本证据"指经过隐私脱敏和确定性文本归一后的证据，不代表保存未脱敏 DOM。密码、表单草稿、token 和其他被策略删除的数据不得为了"原始"而恢复。

## 7. Session Unit Ledger 与 Global Unit Index

Ledger 的双重职责拆分为两层：

```text
Session Unit Ledger
└── 本 Session 的 UnitObservation      回答："这次浏览捕获到了什么？"

Global Unit Index
└── 全部 CanonicalUnit + 聚合统计      回答："我历史上一共积累了哪些逻辑内容对象？"
```

- Topic Cloud 读取：时间范围内存在至少一条 Observation 的 CanonicalUnit 集合。
- 同一 Session、同一 Page 实例上稳定指纹与 extent 未变化的重复抽取，不新增 UnitObservation；只追加一条幂等的 `UnitObservationSourceLink`。UnitObservation 本身永不改写。跨 Session/Page 或内容/extent 变化产生新观察。
- DOM 出现只证明 `observed`；没有视口证据不得标记 `seen`。
- 词表冻结：聚合计数使用 `observation_count`；`seen` 专指有真实 viewport exposure 证据，禁止 `seen_count` 之类的混用命名。

## 8. CanonicalUnit Merge

- UnitObservation 不可变，永不改写。
- CanonicalUnit 通过 `mergedInto` 合并（墓碑，不硬删）。
- 合并方向确定：总是并入先创建的 CanonicalUnit；操作幂等；解析链做路径压缩并防环。
- 查询经 `resolveCanonical(id)` 收敛；历史 Observation 保留原 `canonicalUnitId`——历史必须仍能回答"当时系统为什么认为它们是两个对象"，不得洗掉。
- Canonical merge 发生后，受影响 TopicProjection 全部标记 stale。

## 9. 删除：可达性 GC

```text
删除 Session/Page -> 删除对应 UnitObservation
  -> 删除其 UnitObservationSourceLink / EvidenceBlock occurrence
  -> 没有任何 EvidenceBlock 引用的 EvidenceBlob 消亡
  -> 删除对应 UnitVersionObservationLink / UnitVersionEvidenceLink
  -> 失去全部 full Observation 支撑的 UnitVersion 消亡
  -> 不再有任何 Version/Observation 的 CanonicalUnit 消亡
  -> 相关投影/缓存同步失效
```

- 这不是传统 cascade delete，而是引用完整性/可达性判定。Session A 与 Session B 都观察过同一帖子时，删除 Session A 不得影响 Session B 依赖的 CanonicalUnit/Version/EvidenceBlock/EvidenceBlob。
- EvidenceBlob 可以跨 Observation 复用，但 EvidenceBlock occurrence 永不跨 Observation 复用；GC 必须先删除 occurrence，再按剩余引用决定是否删除 blob。
- UnitVersion 只由 `relation=supports_full` 的 UnitVersionObservationLink 支撑；`pins_partial` 不延长 Version 生命周期。删除首次观察但仍有另一个 full Observation 支撑时，Version 必须保留。
- 用户删除是 Observation 不可变性的唯一例外（隐私承诺优先）；删除必须留下可审计的生命周期记录。
- TTL/compaction 走同一套可达性规则。

## 10. DerivedMetadata：解释与源分离

- Source Version ≠ Interpretation Version：Extractor 升级改变 `type` 判定时，源内容没有变化，不得产生 UnitVersion，也不得改写历史观察。
- P0.5 的 DerivedMetadata 只含 `type + parserVersion`；不得在 CanonicalUnit 上常驻 topics——主题归属只存在于 TopicProjection，防止出现第二套主题真相。
- parserVersion 升级后只允许对新读取懒重算，禁止批量回写历史记录。

## 11. 投影取文规则（extent-aware）

时间范围内为某 CanonicalUnit 取分析文本时：

```text
scope 内有 Version 支撑 -> 取最新被观察 Version 的稳定内容
否则                     -> 取最新 partial 观察内容，并标注 partial
```

- 这是 `(scope, Observation Log)` 的纯函数，满足确定性投影要求。
- 不得机械取"最新 Observation"：用户先读全文、后又扫到卡片的场景不得让主题分析退化回摘要。

## 12. Topic Cloud 计数契约

TopicProjection 必须直接引用 CanonicalUnit 和 EvidenceBlock occurrence；不得引用 EvidenceBlob 充当来源：

```ts
type Topic = {
  topicId: string
  label: string
  summary: string
  canonicalUnitRefs: string[]
  evidenceBlockRefs: string[]
}
```

计数：

```text
unitCount(topic)   = count(distinct canonicalUnitRef)
pageCount(topic)   = count(distinct pageInstanceId of referenced units' observations)
domainCount(topic) = count(distinct normalized domain of referenced units' observations)
```

- Topic Cloud 节点大小只由 `unitCount` 经过有界缩放得到。
- 同一 CanonicalUnit 的重复观察、重复访问、多个 UnitVersion、多个 EvidenceBlock，在同一 Topic 中都只计一次。
- Page 不投票；Page 数和 Domain 数只作为附加分布展示。
- 一个 CanonicalUnit 可以同时属于多个 Topic，但每个归类都必须有对应 EvidenceBlock 支持。
- `unknown` Unit 与其他类型同等计数。
- Topic 不得只引用 Page、URL、标题或模型解释；至少一个 `canonicalUnitRef` 和一个与之匹配的 `evidenceBlockRef` 才有效。evidenceBlock 必须属于被引用 CanonicalUnit 的某个 Observation（或其 Version 引用的 block），否则该主题被拒绝或整次投影失败。

关系距离若在 P0.5 启用，计算集合为 CanonicalUnit：

```text
relation(A, B) = |units(A) ∩ units(B)| / |units(A) ∪ units(B)|    # units(X) = X 引用的 CanonicalUnit 集合
```

它只能解释为"共同涉及相同 CanonicalUnit"，不能自动解释成因果、从属或更宽泛的语义关系。

界面可以同时展示：

```text
大型项目维护
13 Units · 7 Pages · 3 Domains
```

不得把三者合并成没有可解释公式的"热度"。

## 13. 与捕获热路径及 UnitExtractor 的边界

```text
Raw Snapshot 持久化完成
  -> 更新 Page State
  -> 异步、确定性的 UnitExtractor
       分级抽取候选 -> 独立阅读过滤 -> 嵌套消歧
  -> EvidenceBlock[]（挂 UnitObservation）
  -> 身份消解（permalink -> namespaced anchor -> 不强行合并）
  -> UnitObservation(partial/full/unknown) + CanonicalUnit upsert
  -> full 且稳定内容变化时新增 UnitVersion
  -> 更新当前 Page 的 Unit 集合
  -> upsert Session Unit Ledger / Global Unit Index
```

- Unit Materializer 在桌面数据层运行，不进入 content script。
- 它不能阻塞 Raw Snapshot 持久化，也不能导致 Capture 丢失。
- P0.5 Unit Materializer 不调用 LLM、Embedding、网络服务或站点 API。
- 物化失败时保留 Raw Snapshot/Page State，并记录失败；允许按 `P0_UNIT_EXTRACTOR_SPEC.md` 对去噪后的 main content 生成一个明确标记的 fallback Unit，但不能把整个 Raw Page 无条件包装成 `1 Page = 1 Unit`。
- Unit 边界识别、嵌套文本独占和 extent 判定以 `P0_UNIT_EXTRACTOR_SPEC.md` 为准。

## 14. P0.5 验收测试

至少验证：

1. 一个包含 50 个独立列表项的 Page 物化为 50 个 CanonicalUnit（各有 UnitObservation），而不是 1 个 Page 票数；
2. 一个帖子详情可以同时表达主帖 Unit 和多条评论 Unit；
3. 无法分类但可独立阅读的内容 `type = unknown`，与其他类型同等计数；
4. 一个 Observation 包含多个 EvidenceBlock 时，在同一 Topic 中仍只计一票；
5. 一个 CanonicalUnit 可以进入多个 Topic，且每个 Topic 均引用有效 EvidenceBlock；
6. 同一 Session 内重复 Snapshot 不新增 UnitObservation、不增加 Unit 数；
7. 跨 Session 三次访问同一帖子：`observation_count = 3`、`sessionCount = 3`，Topic Cloud 只计 1 个 CanonicalUnit；
8. Feed 卡片（partial）与详情页（full）共享 permalink：归并为同一 CanonicalUnit，extent 差异不产生 UnitVersion；
9. 只有 partial 观察的 CanonicalUnit：可计数、可引用 EvidenceBlock，UI 标注 partial；
10. 点赞数 42 -> 43、"2 hours ago" -> "3 hours ago"：不产生新 UnitVersion；
11. 两次 full 观察稳定内容不同：产生新 UnitVersion；投影取 scope 内最新 Version；
12. edit 后 revert：稳定指纹回到 v1，不新增版本记录；
13. 虚拟滚动移除 DOM 后，Unit 离开当前 Page State，但 UnitObservation/CanonicalUnit 保留；
14. 新 document/刷新创建新 Page 实例，不把 URL 当 Page ID；重访同 URL（有键时）归并到同一 CanonicalUnit；
15. EvidenceBlock occurrence 可回到有效 observation/stateVersion，并解引用 textHash 匹配的 EvidenceBlob；
16. 相同正文跨两个 Observation 复用 EvidenceBlob，但产生两个不同 EvidenceBlock occurrence；删除其中一个 Observation 不影响另一个；
17. Canonical merge：Observation 保留原 id，`resolveCanonical` 收敛，投影 stale，方向确定且幂等；
18. 重复 Snapshot 只追加幂等 UnitObservationSourceLink，不改写 UnitObservation；
19. 删除 Session A（与 Session B 共同观察同一帖子）：A 的观察消失，B 依赖的 CanonicalUnit/Version/EvidenceBlock/EvidenceBlob 完好；
20. 删除首次 full Observation 但仍有另一 `supports_full` 关系支撑相同 Version 时，Version 保留；最后一个 full 支撑删除后才可 GC；
21. partial Observation 在 Version 后来出现时可追加 `pins_partial` link 而不改写 UnitObservation；仅有 `pins_partial` 不得阻止 Version GC；
22. title/author/publishedAt 变化保存在 SourceMetadataSnapshot，不静默覆盖历史 CanonicalUnit 元数据；
23. 删除后无任何支撑的 Version/CanonicalUnit 依可达性消亡，投影级联失效；
24. parserVersion 升级只懒重算 `type`：不产生 UnitVersion、不回写历史观察；
25. Topic 大小严格等于去重 `canonicalUnitRefs` 数的有界缩放，Page/Domain 只作辅助统计；
26. Unit Materializer 失败不会阻塞或破坏 Raw Capture/Page State；
27. DOM 出现只标记 `observed`；没有视口证据时不得标记为 `seen`。

## 15. 对 AI 编码代理的硬约束

- 不得把捕获文本差异直接等同于内容编辑；UnitVersion 只由两次可比较 full 观察的稳定内容差异产生。
- 不得让 partial/unknown 观察创建 UnitVersion；不得把 partial 宣称为 full。
- 不得把易变噪声（计数、相对时间、在线人数、展开状态）计入 stableContentFingerprint。
- 不得用 text hash、Page URL 或运行期 node id 合并 CanonicalUnit；身份键必须按 §4 优先级解析并命名空间化。
- 不得把 DerivedMetadata（type 等）变化写成 UnitVersion 或回写历史观察。
- 不得改写既有 UnitObservation；用户删除是唯一例外，且必须按可达性 GC 级联。
- 不得在 UnitObservation 的数组字段上追加 source 引用；必须写入幂等的 UnitObservationSourceLink。
- 不得让 EvidenceBlock 跨 Observation 共享所有权；只能复用 EvidenceBlob。
- 不得让 UnitVersion 只依赖首次 full Observation；版本支撑必须通过 UnitVersionObservationLink 表达。
- 不得为 later pin 改写 partial UnitObservation；使用 `pins_partial` link，且它不构成 Version 生命周期支撑。
- 不得把可能变化的 title/author/publishedAt 作为 CanonicalUnit 单值静默覆盖历史；它们属于 SourceMetadataSnapshot。
- 不得在 CanonicalUnit 上常驻 topics；主题归属只存在于 TopicProjection。
- 不得把 Page 当作 Topic 计数单位；不得让同一 CanonicalUnit 因观察次数、Snapshot 数、版本数、词频或 EvidenceBlock 数量重复投票。
- 不得把整个 Raw Page 自动包装成 Unit；只允许经过主内容抽取与有效性检查的单 Unit fallback。
- 不得把 DOM 节点、CSS selector、数组下标、URL 或标题作为对象的唯一身份；运行期生成 node id 禁止，站点内容寻址稳定 id 允许作为 identity signal。
- 不得扩展 P0.5 type 枚举；识别不确定时使用 `unknown`。
- 不得编造可选元数据，或让 LLM 改写 EvidenceBlob 正文。
- 不得因 DOM removal 删除 UnitObservation/CanonicalUnit。
- 不得把进入 Ledger 描述成用户实际看见；聚合计数使用 `observation_count`，`seen` 保留给视口证据。
- 不得让 Unit Materializer 阻塞 Capture 热路径或调用 LLM/Embedding/网络。
- 不得超出 `P0_UNIT_EXTRACTOR_SPEC.md` 自行加入站点 Adapter 或 AI 拆块；启发式必须版本化、可解释并通过夹具。
