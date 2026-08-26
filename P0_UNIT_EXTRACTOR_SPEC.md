# Sift AI P0.5：分级 UnitExtractor 规范

> 状态：P0.5 规范性抽取策略，不属于当前 P0 Demo。Demo 只构建 observation-scoped DemoEvidenceBlock；只有 Demo 价值通过后才实现本文件的长期 Unit 物化。输入/输出对象以 `P0_ANALYSIS_UNIT_SPEC.md` 为准。核心原则：高置信时拆，低置信时不拆，永远不瞎拆；UnitExtractor 不使用 LLM。

## 1. 目标与非目标

UnitExtractor 的目标不是理解任意网站的业务模型，而是从已经捕获、脱敏的 DOM 中，尽可能稳定地找出“可独立阅读的信息块”。

```text
DOM
  ↓
① Semantic HTML / ARIA / mapped Schema.org
  ↓ 不足
② Repeated Structure Detection
  ↓ 候选统一过滤与嵌套消歧
③ Main Content Extraction fallback
  ↓
UnitObservation / CanonicalUnit / EvidenceBlock
（身份、extent 与版本语义见 P0_ANALYSIS_UNIT_SPEC.md）
```

P0.5 不要求知道某个 Unit 究竟是帖子、Issue、商品或新闻。类型只允许：

```text
article | content | comment | unknown
```

识别不确定时使用 `unknown`。抽取失败必须返回明确状态，不能让 LLM 判断 DOM，也不能用站点特定 Adapter 偷偷补齐。

## 2. 执行位置与输入

```text
Sanitized Raw Snapshot 已持久化
  -> Materialized Page State 更新
  -> 桌面端异步 UnitExtractor
  -> EvidenceBlock[] + 身份消解 + extent 判定
  -> UnitObservation / CanonicalUnit（full 且稳定内容变化时新增 UnitVersion）
  -> Session Unit Ledger / Global Unit Index
```

- UnitExtractor 运行在桌面数据层，不在 content script 或网页主世界中运行。
- 输入是已脱敏、已持久化的离线 HTML/DOM 和 Page metadata。
- 解析 DOM 时禁用脚本执行、外部资源加载、iframe 加载和网络访问。
- 抽取不得阻塞 Raw Capture；失败时保留 Snapshot/Page State，记录 `extraction_failed`。
- 同一输入、extractor version 和配置必须得到确定性候选、分数、Unit 文本与 EvidenceBlock。

离线 DOM 通常没有可靠的 computed style/layout。P0.5 的“可见文本”只表示通过 `hidden`、`aria-hidden`、内联隐藏、不可见标签和噪声规则后的 **eligible text**，不能宣传成已证明进入视口或用户看见。

## 3. 第一级：页面自带语义

### 3.1 高置信候选

优先产生候选：

```text
<article>
[role="article"]
[role="feed"] 内直接拥有的 <article> / [role="article"]
DOM 可映射的 Schema.org Article / DiscussionForumPosting / Comment
```

HTML `<article>` 和 ARIA `article` 表达可独立存在的内容，例如文章、论坛帖子、评论或 feed item。`role="feed"` 是动态 article 列表的容器，不是一个 Unit；只把其 article 子项作为候选。

Schema.org 规则：

- Microdata/RDFa 的 `itemscope/itemtype/typeof` 与具体 DOM 元素绑定时，可以直接成为候选信号；
- JSON-LD 若只有页面级对象、无法无歧义映射回某个 DOM 子树，只能补充 Page/fallback metadata，不能据此创造或切分 Unit；
- Schema 类型可以帮助确定 `article/comment`，但仍必须通过文本有效性和嵌套消歧。

### 3.2 列表候选

```text
[role="list"] > [role="listitem"]
<ul>/<ol> > <li>
```

这些只产生中等置信候选，不能直接全部变成 Unit。导航、菜单、标签、目录和按钮列表也使用相同结构，因此必须同时满足：

- 同一个列表中存在多个内容项；
- 每项有足够 eligible text；
- 不是纯链接、纯按钮或短标签；
- 不位于明确的 navigation/menu/toolbar/banner/contentinfo 区域；
- 通过独立阅读过滤。

## 4. 第二级：重复结构检测

当页面缺少可靠语义标记时，寻找同一父节点下结构高度相似的兄弟子树。

### 4.1 Structure Fingerprint

Fingerprint 可以包含：

```text
根标签与规范 ARIA role
有限深度内的标签/role 序列或多重集
heading / link / time / image / paragraph 的存在形状
子节点数量与深度 bucket
文本长度、链接密度、交互控件数量 bucket
```

Fingerprint 不使用：

```text
正文具体词语
随机/哈希 class 名
DOM Node ID
CSS selector
兄弟数组下标
网页或 AI 提供的脚本结果
```

`id/class/data-*` 最多作为低权重、可丢弃的辅助特征，不能决定身份或高置信拆分。

### 4.2 候选组

P0.5 起始门槛：

```text
同一个父节点
+ 至少 3 个 eligible sibling
+ 结构相似度超过版本化阈值
+ 每项通过最小文本与独立阅读过滤
```

- 相似度算法、深度、文本下限和阈值必须版本化，并通过固定网页夹具校准；
- 不同父节点的相似结构不能因为 fingerprint 相同就自动合并；
- 对最大遍历节点数、深度、候选组数和比较次数设置硬上限，避免 O(n²) 失控；
- 高频动画、骨架屏和占位卡片必须被噪声过滤，不能形成 Unit。

## 5. 独立阅读过滤与置信度

Semantic 和 repeated-structure 只产生 Candidate；所有 Candidate 统一评分：

```text
正向信号
  语义 article / mapped schema
  有 heading 或有意义主链接
  有连续正文、作者、time 等内容形状
  与同组 sibling 结构稳定
  文本长度与信息字符比例合理

负向信号
  位于 nav/menu/toolbar/banner/contentinfo/form
  主要由按钮、图标、短链接、标签组成
  极高链接密度且缺少描述文本
  Cookie、登录、订阅、广告、推荐导航、分页控件
  骨架屏、占位符、重复 boilerplate
```

输出记录：

```ts
confidence: number // 0..1，表示 Unit 边界可靠度
extractionMode: 'semantic' | 'repeated_structure' | 'main_content_fallback'
captureExtent: 'partial' | 'full' | 'unknown' // 覆盖完整度判断，默认 unknown
```

`confidence/extractionMode/captureExtent` 记录在 UnitObservation 上，是本次抽取的事实；`type` 属于 DerivedMetadata（parserVersion 版本化），不是 UnitVersion 的组成部分。

- 只有分数达到版本化 `splitThreshold` 的 Candidate 才能拆成独立 Unit；
- 低于阈值的候选不拆，不允许为了增加 Unit 数降低门槛；
- `confidence` 由确定性程序计算，不能由 LLM 自报；
- fallback 的 `confidence` 表示“主内容作为一个整体”的边界可靠度，不代表细粒度拆分质量。

## 6. 嵌套 Unit 与文本独占

Unit 之间允许存在 DOM 包含关系，但 EvidenceBlock 在一次抽取结果中必须独占：

```text
主帖 Candidate
├── 主帖 ownContent
├── 评论 Unit A
├── 评论 Unit B
└── 评论 Unit C
```

处理规则：

1. 建立 Candidate containment tree；
2. 先确定被接受的子 Unit；
3. 父 Candidate 的 `ownContent` 排除所有已接受子 Unit 子树；
4. 使用剩余 ownContent 重新执行独立阅读过滤；
5. 父 Candidate 仍合格才生成 Unit，否则丢弃父 Candidate；
6. EvidenceBlock 只能归属于一个 Unit；
7. 未被接受的子 Candidate 内容仍可以保留在父 ownContent 中。

因此评论不会既作为 comment Unit 计数，又重复包含在主帖 Unit 文本中。不得通过抽取顺序、DOM 克隆或 fallback 重新引入已经被子 Unit 占用的文本。

## 7. 第三级：Main Content Fallback

当高置信语义/重复结构拆分没有产生可用 Unit，或页面剩余主体内容尚未被任何 Unit 覆盖时，可以对 **排除已接受 Unit 后的离线 DOM 克隆** 运行：

```text
首选：Defuddle main-content extraction
备用：Mozilla Readability
```

成功时生成一个：

```text
extractionMode = main_content_fallback
type 由 DerivedMetadata 判定，通常为 article/content/unknown
```

这修订了此前“不得把 Page fallback 成一个 Unit”的绝对禁令。允许的是：

> 经主内容提取、去噪、文本有效性验证后，产生一个明确标记为 fallback 的粗粒度 Unit。

不允许的是：

> 把整个 Raw Page/outerHTML 无条件包装成一个 Unit。

Fallback 约束：

- 只处理已捕获的离线 HTML，不请求页面 URL或第三方服务；
- Defuddle 禁用异步联网能力；
- Readability `parse()` 会修改传入 DOM，必须使用独立克隆；
- DOM 实现保持脚本、资源和 iframe 加载关闭；
- 输出再次经过 sanitizer、大小限制和 EvidenceBlock 构建；
- fallback 也无法得到有效主内容时返回零 Unit + `extraction_empty`，不得凑结果；
- 若前两级已有 Unit，fallback 只能处理排除这些 Unit 后的剩余主体，不能形成文本重叠。

## 8. EvidenceBlock 构建

候选通过消歧后，再从其 ownContent 生成 EvidenceBlock：

```text
heading
paragraph
blockquote
pre/code
有信息量的 list item
其他连续文本块
```

- 先删除 script/style/template/noscript、控件值和已知噪声；
- 文本只做确定性 Unicode/空白归一，不做摘要、翻译或语义改写，并按 textHash 写入/复用 EvidenceBlob；
- 每个 UnitObservation 中的块都创建独立 EvidenceBlock occurrence 并引用 EvidenceBlob；不得为了正文去重跨 Observation 复用 EvidenceBlock ownership；
- 同一 ownContent 内的空块和精确重复块删除；
- DOM 顺序决定 `ordinal`；
- Unit 文本由 EvidenceBlock 按 ordinal 解引用 EvidenceBlob 后拼接；UnitObservation 不单独持有正文；
- title/author/time/link 获取不到时保持缺失；获取到的 title/author/time 写入本次 Observation 的 SourceMetadataSnapshot，不写成会覆盖历史的 CanonicalUnit 单值；
- 页面 metrics 不进入 P0.5 核心 Unit schema；需要时以后以版本化 metadata 扩展。

## 9. 身份消解与观察合并下限

Unit 身份按 `P0_ANALYSIS_UNIT_SPEC.md` §4 的优先级解析：

```text
1. Unit 自身 permalink（规范化绝对 URL）
2. namespaced anchor：(origin, canonicalPageUrl, stableAnchor)
3. 无安全键 -> 不做跨 Page 合并，宁可重复
```

- **“Unit URL”指 Unit 自身 permalink/anchor URL，绝不是 Page URL。**
- 相同 stableContentFingerprint 不构成合并依据：两条不同用户的“谢谢”必须保持两个 CanonicalUnit；仅有相同短文本同样不能合并。
- URL 相同但稳定内容不同：不静默覆盖，按 `P0_ANALYSIS_UNIT_SPEC.md` §5 的版本规则处理（两次 full 观察稳定化后确实不同才产生 UnitVersion）。
- 同一 Session、同一 Page 实例、稳定指纹与 extent 未变化的重复抽取不新增也不改写 UnitObservation；只追加幂等 UnitObservationSourceLink。跨 Session/Page 或内容/extent 变化产生新观察。
- 合并信号不足时宁可保留重复，不得破坏性地把不同内容合成一个；
- 跨 Page 转载、镜像、无键的列表项/详情页对齐与模糊重复不在 P0.5 保证范围（安全 identity signals 后续单独冻结）。

## 10. 限制与失败状态

至少区分：

```text
extraction_ok
extraction_partial
extraction_empty
extraction_limit_exceeded
extraction_failed
```

P0.5 明确限制：

- 外部 CSS 导致的真实可见性无法仅从离线 outerHTML 完整恢复；
- closed Shadow DOM、跨域 iframe、Canvas 和未挂载虚拟内容不可见；
- 结构完全不重复且无语义标记的 Feed 可能退化为一个粗 Unit；
- 相同短文本、编辑记录和跨页面实体对齐仍可能重复；
- 错误 HTML 可能使 Readability/DOM parser 失败，必须隔离错误并保留 Raw Capture。

## 11. P0.5 验收夹具

至少覆盖：

1. 多个 `<article>` 的论坛/Feed；
2. `role="feed"` + `role="article"` 的无限列表；
3. Schema.org Microdata/RDFa Article、DiscussionForumPosting 和 Comment；
4. 只有页面级 JSON-LD、无法映射 DOM 的文章；
5. `<ul>/<li>` 导航菜单，必须拒绝拆成 Unit；
6. 普通新闻/搜索/商品卡片的重复 sibling；
7. 结构相似但只有按钮/骨架屏的假候选；
8. 主帖包含嵌套评论，父 ownContent 不重复评论文本；
9. 高置信子 Unit + 剩余主内容 fallback，EvidenceBlock 零重叠；
10. 完全陌生文章页退化成一个 main-content Unit；
11. 主内容抽取失败返回零 Unit，不包装 Raw Page；
12. 虚拟列表 Unit 消失后重现，通过高置信 permalink/anchor 归并到同一 CanonicalUnit；
13. 两条相同短评论不能只因 text hash 相同而被合并；
14. Readability 只修改离线克隆，不影响 Page State 或其他 extractor；
15. 超大/深层/恶意 DOM 触发预算限制而非 CPU/内存失控；
16. 同一输入和 extractor version 重复运行得到相同 Unit/EvidenceBlock 与 confidence；
17. Feed 卡片(partial)与详情页(full)同 permalink：归并为同一 CanonicalUnit，不产生 UnitVersion；
18. 点赞数/相对时间变化不产生新 UnitVersion；评论真实编辑（两次 full 稳定内容不同）才产生；
19. 无法判定覆盖完整度时 captureExtent=unknown，不参与版本比较。

## 12. 对 AI 编码代理的硬约束

- 不得在 UnitExtractor 中调用 LLM、Embedding、远程服务或页面 URL。
- 不得把捕获文本差异直接当作内容编辑；UnitVersion 只由两次可比较 full 观察的稳定内容差异产生。
- 不得用 Page URL、text hash 或运行期 node id 合并 CanonicalUnit；身份键按优先级解析并命名空间化。
- captureExtent 判定必须版本化且默认 unknown；不得把 partial 宣称为 full。
- 不得把 Semantic selector 命中直接等同于有效 Unit；仍需过滤和嵌套消歧。
- 不得把 `role="feed"` 容器本身当 Unit；应检查其 article 子项。
- 不得把任意 `<li>` 或 `role="listitem"` 直接当 Unit。
- 不得用无法映射 DOM 的 JSON-LD 凭空创建多个 Unit。
- 不得使用 class 名、Node ID、selector 或正文词语作为唯一 fingerprint/身份。
- 不得让父 Unit 重复包含已接受子 Unit 的 EvidenceBlock。
- 不得因为低置信候选存在而跳过 main-content fallback。
- 不得把整个 Raw Page 无条件包装成 Unit；fallback 必须经过主内容提取和有效性检查。
- 不得在 Readability 上使用共享/活跃 DOM；必须使用离线克隆。
- 不得把 `observed` Unit 宣称成用户实际 `seen`。
- 不得降低置信阈值来满足目标 Unit 数量。

## 13. 依据

- [MDN：HTML article element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/article)
- [MDN：ARIA article role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/article_role)
- [MDN：ARIA feed role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/feed_role)
- [Schema.org：DiscussionForumPosting](https://schema.org/DiscussionForumPosting)
- [Schema.org：Comment](https://schema.org/Comment)
- [Schema.org：Article](https://schema.org/Article)
- [Mozilla Readability README](https://github.com/mozilla/readability/blob/main/README.md)
- [Defuddle](https://github.com/kepano/defuddle)
