import type { UnitLedgerState } from '@sift/units'

export const TOPIC_PROJECTION_VERSION = 1
export const TOPIC_PROMPT_VERSION = 'topic-v1'
export const TOPIC_LAYOUT_VERSION = 'packed-grid-v1'

export interface TopicProjectionScope {
  readonly from: string
  readonly to: string
  readonly canonicalUnitRefs: readonly string[]
  readonly evidenceBlockRefs: readonly string[]
}

export interface TopicProjectionAnalyzer {
  readonly provider: string
  readonly model: string
  readonly promptVersion: string
}

export interface TopicProjectionTopic {
  readonly topicId: string
  readonly label: string
  readonly aliases: readonly string[]
  readonly summary: string
  readonly canonicalUnitRefs: readonly string[]
  readonly evidenceBlockRefs: readonly string[]
}

export interface TopicProjection {
  readonly projectionId: string
  readonly projectionVersion: number
  readonly createdAt: string
  readonly scope: TopicProjectionScope
  readonly analyzer: TopicProjectionAnalyzer
  readonly topics: readonly TopicProjectionTopic[]
}

export interface TopicStats {
  readonly topicId: string
  readonly unitCount: number
  readonly pageCount: number
  readonly domainCount: number
  readonly displaySize: number
}

export interface TopicRelation {
  readonly fromTopicId: string
  readonly toTopicId: string
  readonly jaccardOverlap: number
}

export interface TopicLayoutNode {
  readonly topicId: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type TopicValidationResult =
  | { readonly status: 'ok'; readonly projection: TopicProjection }
  | { readonly status: 'invalid'; readonly errors: readonly string[] }

function boundedString(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) return false
  for (const char of value) {
    const code = char.charCodeAt(0)
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) return false
  }
  return true
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function canonicalForBlock(state: UnitLedgerState, blockId: string): string | null {
  const block = state.evidenceBlocks.find(item => item.id === blockId)
  if (block === undefined) return null
  return state.observations.find(item => item.id === block.unitObservationId)?.canonicalUnitId ?? null
}

/** 严格验证模型输出：任何悬空或越界引用都拒绝整次投影。 */
export function validateTopicProjection(candidate: unknown, state: UnitLedgerState, scope: TopicProjectionScope): TopicValidationResult {
  const errors: string[] = []
  if (typeof candidate !== 'object' || candidate === null) return { status: 'invalid', errors: ['projection 必须为对象'] }
  const raw = candidate as Record<string, unknown>
  const rawScope = raw.scope
  if (typeof rawScope !== 'object' || rawScope === null) errors.push('scope 无效')
  else {
    const candidateScope = rawScope as Record<string, unknown>
    if (candidateScope.from !== scope.from || candidateScope.to !== scope.to) errors.push('scope 时间范围不匹配')
    if (!Array.isArray(candidateScope.canonicalUnitRefs) || !Array.isArray(candidateScope.evidenceBlockRefs) || !uniqueStrings(candidateScope.canonicalUnitRefs as string[]) || !uniqueStrings(candidateScope.evidenceBlockRefs as string[])) errors.push('scope 引用数组无效')
    if (JSON.stringify(candidateScope.canonicalUnitRefs) !== JSON.stringify(scope.canonicalUnitRefs) || JSON.stringify(candidateScope.evidenceBlockRefs) !== JSON.stringify(scope.evidenceBlockRefs)) errors.push('scope 引用集合不匹配')
  }
  if (raw.projectionVersion !== TOPIC_PROJECTION_VERSION) errors.push('projectionVersion 不匹配')
  if (!boundedString(raw.projectionId, 128) || !boundedString(raw.createdAt, 64)) errors.push('projectionId/createdAt 无效')
  const analyzer = raw.analyzer
  if (typeof analyzer !== 'object' || analyzer === null || !boundedString((analyzer as Record<string, unknown>).provider, 64) || !boundedString((analyzer as Record<string, unknown>).model, 128) || !boundedString((analyzer as Record<string, unknown>).promptVersion, 64)) errors.push('analyzer 无效')
  else if ((analyzer as Record<string, unknown>).promptVersion !== TOPIC_PROMPT_VERSION) errors.push('promptVersion 不匹配')
  if (!Array.isArray(raw.topics) || raw.topics.length > 24) errors.push('topics 数量无效')
  const allowedUnits = new Set(scope.canonicalUnitRefs)
  const allowedBlocks = new Set(scope.evidenceBlockRefs)
  const knownUnits = new Set(state.canonicalUnits.map(unit => unit.id))
  const knownBlocks = new Set(state.evidenceBlocks.map(block => block.id))
  const topicIds = new Set<string>()
  if (Array.isArray(raw.topics)) {
    for (const item of raw.topics) {
      if (typeof item !== 'object' || item === null) { errors.push('topic 必须为对象'); continue }
      const topic = item as Record<string, unknown>
      const topicId = topic.topicId
      if (!boundedString(topicId, 128) || topicIds.has(topicId)) errors.push('topicId 无效或重复')
      else topicIds.add(topicId)
      if (!boundedString(topic.label, 120) || !boundedString(topic.summary, 600)) errors.push('topic label/summary 无效')
      if (!Array.isArray(topic.aliases) || topic.aliases.length > 12 || topic.aliases.some(alias => !boundedString(alias, 80))) errors.push('topic aliases 无效')
      const unitRefs = Array.isArray(topic.canonicalUnitRefs) ? topic.canonicalUnitRefs : []
      const blockRefs = Array.isArray(topic.evidenceBlockRefs) ? topic.evidenceBlockRefs : []
      if (unitRefs.length === 0 || blockRefs.length === 0 || !unitRefs.every(ref => typeof ref === 'string') || !blockRefs.every(ref => typeof ref === 'string') || !uniqueStrings(unitRefs) || !uniqueStrings(blockRefs)) errors.push(`topic ${String(topicId)} 引用数组无效`)
      for (const ref of unitRefs) if (!knownUnits.has(ref) || !allowedUnits.has(ref)) errors.push(`topic ${String(topicId)} 引用越界 Unit`)
      for (const ref of blockRefs) {
        if (!knownBlocks.has(ref) || !allowedBlocks.has(ref)) errors.push(`topic ${String(topicId)} 引用越界 EvidenceBlock`)
        const owner = typeof ref === 'string' ? canonicalForBlock(state, ref) : null
        if (owner === null || !unitRefs.includes(owner)) errors.push(`topic ${String(topicId)} 的 EvidenceBlock 与 Unit 不匹配`)
      }
    }
  }
  if (errors.length > 0) return { status: 'invalid', errors: [...new Set(errors)] }
  return { status: 'ok', projection: candidate as TopicProjection }
}

function domainOfObservation(state: UnitLedgerState, canonicalUnitId: string, scope: TopicProjectionScope): Set<string> {
  const domains = new Set<string>()
  for (const observation of state.observations) {
    if (observation.canonicalUnitId !== canonicalUnitId || observation.observedAt < scope.from || observation.observedAt > scope.to) continue
    const source = state.canonicalUnits.find(unit => unit.id === canonicalUnitId)
    if (source?.url !== undefined) {
      try { domains.add(new URL(source.url).hostname.toLowerCase()) } catch { /* invalid source URLs are ignored */ }
    }
  }
  return domains
}

export function computeTopicStats(projection: TopicProjection, state: UnitLedgerState): readonly TopicStats[] {
  return projection.topics.map(topic => {
    const units = new Set(topic.canonicalUnitRefs)
    const pages = new Set(state.observations.filter(item => units.has(item.canonicalUnitId) && item.observedAt >= projection.scope.from && item.observedAt <= projection.scope.to).map(item => item.pageInstanceId))
    const domains = new Set<string>()
    for (const unit of units) for (const domain of domainOfObservation(state, unit, projection.scope)) domains.add(domain)
    const displaySize = Math.max(18, Math.min(72, Math.round(18 + Math.sqrt(units.size) * 14)))
    return { topicId: topic.topicId, unitCount: units.size, pageCount: pages.size, domainCount: domains.size, displaySize }
  }).sort((a, b) => a.topicId.localeCompare(b.topicId))
}

export function computeTopicRelations(projection: TopicProjection): readonly TopicRelation[] {
  const relations: TopicRelation[] = []
  for (let i = 0; i < projection.topics.length; i += 1) {
    for (let j = i + 1; j < projection.topics.length; j += 1) {
      const a = new Set(projection.topics[i]!.canonicalUnitRefs)
      const b = new Set(projection.topics[j]!.canonicalUnitRefs)
      const union = new Set([...a, ...b]).size
      const intersection = [...a].filter(unit => b.has(unit)).length
      if (union > 0 && intersection > 0) relations.push({ fromTopicId: projection.topics[i]!.topicId, toTopicId: projection.topics[j]!.topicId, jaccardOverlap: intersection / union })
    }
  }
  return relations.sort((a, b) => `${a.fromTopicId}|${a.toTopicId}`.localeCompare(`${b.fromTopicId}|${b.toTopicId}`))
}

/** 确定性排版：同一投影/版本/viewport 得到同一网格，不把位置伪装成语义关系。 */
export function layoutTopicCloud(stats: readonly TopicStats[], width: number, height: number): readonly TopicLayoutNode[] {
  const safeWidth = Math.max(240, Math.floor(width))
  const safeHeight = Math.max(180, Math.floor(height))
  const columns = Math.max(1, Math.floor(Math.sqrt(Math.max(1, stats.length))))
  const cellWidth = safeWidth / columns
  const rows = Math.ceil(stats.length / columns)
  const cellHeight = safeHeight / Math.max(1, rows)
  return [...stats].sort((a, b) => a.topicId.localeCompare(b.topicId)).map((stat, index) => {
    const col = index % columns
    const row = Math.floor(index / columns)
    const nodeWidth = Math.min(cellWidth * 0.86, Math.max(90, stat.displaySize * 2.2))
    const nodeHeight = Math.min(cellHeight * 0.72, Math.max(42, stat.displaySize * 0.9))
    return { topicId: stat.topicId, x: Math.round(col * cellWidth + (cellWidth - nodeWidth) / 2), y: Math.round(row * cellHeight + (cellHeight - nodeHeight) / 2), width: Math.round(nodeWidth), height: Math.round(nodeHeight) }
  })
}
