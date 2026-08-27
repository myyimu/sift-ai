# Sift AI：覆盖声明与观察指标规范（CoverageManifest / UnitPresence / ObservedMetric）

> 状态：规范性契约。实现随 Evidence/Question Projection 阶段落地（P0 Demo 的
> QuestionProjection 自该阶段起必须携带）；本文件冻结语义与词表，先于实现存在。
> 适用范围：QuestionProjection / AnswerProjection / TopicProjection 及一切面向用户的分析输出。

## 1. 冻结结论：观察者不是爬虫

Sift 是**用户浏览时的本地只读观察者**。它看到的永远是"用户挂载过、授权过、渲染过的
内容样本"，不是站点全量。因此：

1. 每次分析输出必须携带结构化的 `CoverageManifest`（覆盖声明），并在结果顶部渲染摘要；
   **无 manifest 的分析输出是无效输出**，本地验证器直接拒绝。
2. 覆盖表述以 manifest 为界："你浏览到的热门帖子"不得被表述成"这个论坛整体的情况"。
   样本 → 整体的越界表述属于产品缺陷，不是措辞问题。
3. 本产品不是论坛爬虫、数据库统计工具或无人值守趋势监控器；这三类能力被架构排除，
   不通过"加个开关"获得。

## 2. CoverageManifest 契约

```ts
type RequestedScope =
  | { kind: 'current_page'; pageInstanceId: string }
  | { kind: 'demo_session'; sessionId: string }
  | { kind: 'topic_scope'; from: string; to: string }

type VisitedPagination = {
  origin: string
  path: string                 // 规范化路径（剔除分页参数）
  observedSelectors: string[]  // 按观察顺序去重的分页标记原文（'page=2'、'?p=3'）
  observedCount: number
  exhausted: false             // 恒为 false：观察者永不声明穷尽
}

type CoverageManifest = {
  schemaVersion: 1
  requestedScope: RequestedScope
  capturedFrom: string          // scope 内最早 observation 的 envelope.receivedAt
  capturedTo: string            // 最晚
  sessionCount: number
  pageCount: number             // 去重 pageInstanceId
  unitCount: number
  unitCountBasis: 'deduped_text_blocks' | 'canonical_units'  // 计数口径必须随结果输出
  domains: string[]             // origin 列表（不含路径与 query）
  visitedPagination: VisitedPagination[]
  partialExtractionCount: number | null  // null = capture_failed 事件尚未持久化（见 §9）
  // 批注（2026-08-27）：capture_failed 已持久化（§9 批注），Phase 3 起派生恒出 number；
  // null 仅保留给历史语义（事件落地前的旧 journal）。
  authorizationGaps: Array<{
    origin: string
    from: string
    to: string
    reason: 'revoked_cross_origin' | 'revoked_tab_closed'
  }>
  knownMissingReasons: CoverageKnownMissingReason[]
  inputBounds: {                // 派生输入边界，纳入投影缓存键
    sessions: string[]
    pageStateWatermarks: Array<{
      pageInstanceId: string
      stateVersion: number
      lastAppliedSequence: number
    }>
  }
}
```

## 3. 派生规则

manifest 是**投影时从本地 Observation Log 与 Page State 确定性派生的值**：

- 只从冻结的 page-state watermarks 对应的 journal 区间计算；同一 watermarks +
  同一 manifestVersion 产生相同 manifest（可缓存、可删除重建，与投影同生命周期）。
- 绝不由 LLM 生成或改写；绝不被页面内容断言（页面自称"共 999 条回复"不是覆盖事实）。
- `authorizationGaps` 从 `authorization_granted`/`authorization_revoked` 事件对派生
  （Phase 2 起已持久化，现在即可计算）。
- `visitedPagination` 从 scope 内 page-state 的 `canonicalUrl` 分页标记派生；它声明
  "观察到"，不声明"穷尽"，也不声明"按顺序"。
- `unitCount` 口径冻结：P0 按 textHash 去重 DemoEvidenceBlock；P0.5 起按去重
  CanonicalUnit。口径变更 = manifestVersion 变更，两种口径的结果不得混排。

## 4. 已知盲区词表（CoverageKnownMissingReason）

```ts
type CoverageKnownMissingReason =
  | 'unvisited_pagination'       // 快照中存在分页链接但用户从未导航
  | 'unmounted_infinite_scroll'  // 只有挂载过的内容被捕获（结构性盲区）
  | 'cross_origin_iframe'        // iframe 被 sanitizer 整树丢弃（结构性）
  | 'hidden_or_lazy_content'     // hidden/aria-hidden/未渲染内容
  | 'editor_page_dropped'        // contenteditable 页整树丢弃（capture_too_little_content）
  | 'oversized_page'             // capture_limit_exceeded
  | 'denied_sensitive_url'       // sanitizeUrl 拒绝
  | 'authorization_gap'          // §2 authorizationGaps 非空
  | 'capture_failure'            // capture_failed 事件（§9 落地后可用）
  | 'indistinguishable_absence'  // 隐藏/删除/无权限在观察上不可区分（见 §6）
```

分两类：

- **结构性盲区**（`unmounted_infinite_scroll`、`cross_origin_iframe`、
  `hidden_or_lazy_content`、`indistinguishable_absence`）：由观察方式决定、恒为真；
  scope 含对应页面类型即列出，不依赖任何事件。
- **事件派生盲区**（`oversized_page`、`editor_page_dropped`、`denied_sensitive_url`、
  `capture_failure`、`authorization_gap`）：需要持久化的失败/授权事实；在 `capture_failed`
  事件落地前，相关计数按"未知下界"呈现，不得伪装为零。

## 5. 展示与提示词强制

每次分析结果顶部必须渲染（文案可调，信息不得减）：

```text
基于当前选择的本地捕获范围：
  127 个信息单元（按内容去重块计）
  9 个页面 · 2 个站点
  覆盖分页：1～3（未穷尽）
  观察时段：<capturedFrom> ～ <capturedTo>
未覆盖：
  - 没有访问的分页
  - 未挂载的无限滚动内容
  - 跨域 iframe
  - 隐藏、删除或无权限内容（观察上不可区分）
```

- manifest 摘要必须进入 QuestionProjection 上下文（模型可见），使 `limitations` 有据可写；
  AnswerProjection 的 limitations 不得与 manifest 矛盾（如 manifest 声明未穷尽分页，
  回答却断言"全部帖子"）。
- 越界表述（样本 → 站点整体）无法由验证器自动判定语义，纳入人工夹具评估，
  与 claim 引用支持率同权重。

## 6. UnitPresence：在场语义（absent ≠ 删除）

`CanonicalUnit` 的在场状态是 Global Unit Index 的派生值（对象上不落字段，见
`P0_ANALYSIS_UNIT_SPEC.md` §7.1）：

```ts
type UnitPresence =
  | { status: 'present'; asOf: string }              // 最近已应用快照中存在
  | { status: 'absent_last_snapshot'; asOf: string } // 最近已应用快照中不存在
  | { status: 'unobserved'; reason: 'grant_revoked' | 'page_closed' | 'session_ended'; since: string }
```

规则：

1. **禁止布尔 `currentlyPresent`**。布尔必然丢失"哪次快照"与"是否仍在观察"两个维度。
2. `absent_last_snapshot` 只表示"最近一次已应用快照中不存在"：内容可能被删除、被折叠、
   虚拟列表滚出、权限变化或懒加载卸载——**架构上不存在把它们区分开的信息**，一律不得
   解读为"已删除"。展示层措辞用"最近一次观察中未见"，禁用"已删除/已消失"。
3. 授权已撤销、页面已关闭或会话已结束后，DOM 的后续变化不可见：presence 只能输出
   `unobserved`，不得输出 present/absent。
4. presence 不产生 UnitVersion（在场变化不是源内容变化），不参与 Topic 计数。

## 7. ObservedMetric 契约

回复量/浏览量/点赞数在页面上是**渲染文本**，不是结构化真值。要严谨聚合必须先物化为：

```ts
type MetricName = 'reply_count' | 'view_count' | 'like_count' | 'upvote_count' | `site:${string}`

type ObservedMetric = {
  id: string
  name: MetricName
  rawText: string               // 页面原样文本（'1.2k'、'刚刚'、'--'）
  parsedValue?: number          // 仅当 parsePolicy 给出确定解
  parsePolicy: string           // 版本化解析策略 id；'none' = 无确定解析
  capturedAt: string            // 所属 observation 的 envelope.receivedAt
  evidenceBlockRef: string      // 追溯到具体块
  sourceObservationId: string
  unitRef: { pageInstanceId: string; textHash: string } | { canonicalUnitId: string }
}
```

- `rawText` 必存；`parsedValue` 是解释，不是事实。'1.2k' → 1200 依赖版本化解析策略，
  策略变更是解释层变更，不回写历史（与 DerivedMetadata 同纪律）。
- ObservedMetric 是 `UnitObservation.volatileMetadata` 的结构化形式：**绝不参与
  stableContentFingerprint**（点赞数变化不产生 UnitVersion，与现行规则一致）。
- 相对时间（"3 小时前"）不解析为绝对时间；缺失保持缺失。

## 8. 聚合与比较规则

1. 数值聚合只允许同名 `name`、同 `parsePolicy` 且 `parsedValue` 非空的子集；聚合结果
   必须同时报告 `parsed/total` 覆盖率（"42/50 条解析成功"），禁止把 rawText 直接当数值。
2. 跨时间比较（"点赞从 A 涨到 B"）两端都必须有 parsedValue，并各自引用 capturedAt
   与 evidenceBlockRef；单端未解析则只能报告 rawText 差异描述，不得给数值。
3. 聚合结果是"页面渲染值的统计"，不是站点真值的统计；输出必须携带对应 manifest。
4. 不做无人值守时序采集：没有观察就没有数据点，禁止插值、外推或按时间均匀化。

## 9. 捕获侧唯一前置改动：capture_failed 控制事件

当前 `capture_failed`（capture_denied / capture_limit_exceeded /
capture_too_little_content）只是 SW console 诊断，不落盘——`partialExtractionCount`
与事件派生盲区因此不可计算。落地 manifest 需要且仅需要这一件捕获侧改动：

- 新增控制事件 `capture_failed`：payload 只含 `{ kind, code, instanceNonce,
  contentEpoch? }`，**不含任何页面内容**；走现有 blob 传输管道与 journal 幂等。
- 失败关闭语义不变：不包装、不降级、不产出部分快照；只是把"失败这一事实"入账。
- 实现时序：与 Evidence/Question Projection 同阶段；先于 TopicProjection。

## 10. 验收

1. 相同 pageStateWatermarks + manifestVersion 产生逐字节相同 manifest（确定性、可缓存）；
2. 无 manifest 的分析输出被本地验证器拒绝（schema 层强制）；
3. manifest 只含 origin/计数/时间，不含页面正文；
4. 夹具：虚拟列表滚出再滚回 → presence 经 absent_last_snapshot 回到 present，
   且全程不得出现"已删除"表述；
5. 夹具：'1.2k'/'--'/'刚刚' 混合的计数列 → 聚合报告 parsed/total，未解析项保持 rawText；
6. 夹具：分页 1～3 已访问、4+ 未访问 → 摘要显示"覆盖分页：1～3（未穷尽）"，
   任何输出不得出现"全部/整体"表述（人工夹具评估项）。

## 11. 对 AI 编码代理的硬约束

- 不得让 LLM 生成或改写 CoverageManifest 的任何字段。
- 不得用布尔字段表达 Unit 在场状态；不得把 absent_last_snapshot 解读、暗示或展示为"已删除"。
- 不得声明分页穷尽、站点整体或"全部内容"；覆盖表述以 manifest 为界。
- 不得聚合不同 parsePolicy 的 parsedValue；不得把 rawText 当数值参与运算。
- 不得在 manifest 词表之外发明新的覆盖口径或盲区_reasons（扩充词表 = 修改判定语义，
  需同步本文件与夹具）。
- 不得为凑 coverage 数字而捕获更多内容；manifest 只陈述已观察的事实，绝不驱动采集。
- TopicProjection、QuestionProjection、AnswerProjection 与未来任何投影一律携带 manifest，
  没有豁免类型。
