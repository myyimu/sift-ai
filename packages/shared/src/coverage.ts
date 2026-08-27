// CoverageManifest / RequestedScope / VisitedPagination / 盲区词表 的 zod 契约
// （P0_COVERAGE_MANIFEST_SPEC.md §2/§4——规范性契约，词表冻结）。
//
// 与 wire.ts 的分层关系：本文件带 zod，只走主入口导出（桌面/Host/projector 侧）；
// MV3 content script / service worker 不 import 本文件（CS 侧无 manifest 需求）。
//
// 纪律（spec §3/§11）：
//  - manifest 是投影时从 Observation Log 与 Page State **确定性派生**的值，
//    绝不由 LLM 生成或改写；无 manifest 的分析输出是无效输出；
//  - 同一 pageStateWatermarks + COVERAGE_MANIFEST_VERSION 产生逐字节相同 manifest
//    （可缓存、可删除重建，与投影同生命周期）；
//  - 词表之外的覆盖口径/盲区 reason 一律不得发明（扩充 = 修改判定语义，
//    需同步 spec 与夹具）。
import { z } from 'zod'

/**
 * 派生缓存键版本（spec §3：同一 watermarks + 同一 manifestVersion 产生相同 manifest；
 * 口径变更 = 版本变更，两种口径的结果不得混排）。对象形状按 spec §2 冻结，
 * 不在本对象上增设 manifestVersion 字段。
 */
export const COVERAGE_MANIFEST_VERSION = 1

/** 分析请求的 scope 判别（spec §2 RequestedScope）。 */
export const requestedScopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('current_page'),
    pageInstanceId: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('demo_session'),
    sessionId: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('topic_scope'),
    from: z.string().min(1),
    to: z.string().min(1),
  }).strict(),
])

export type RequestedScope = z.infer<typeof requestedScopeSchema>

/**
 * 观察到的分页（spec §2）：只声明“观察到”，不声明“穷尽”，也不声明“按顺序”。
 * exhausted 恒为 false——观察者永不声明穷尽。
 */
export const visitedPaginationSchema = z.object({
  origin: z.string().min(1),
  /** 规范化路径（剔除分页参数/段）。 */
  path: z.string().min(1),
  /** 按观察顺序去重的分页标记原文（'page=2'、'/page/3'）。 */
  observedSelectors: z.array(z.string().min(1)).min(1),
  observedCount: z.number().int().positive(),
  exhausted: z.literal(false),
}).strict()

export type VisitedPagination = z.infer<typeof visitedPaginationSchema>

/** 授权缺口（spec §2）：从 granted/revoked 事件对确定性派生。 */
export const authorizationGapSchema = z.object({
  origin: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.enum(['revoked_cross_origin', 'revoked_tab_closed']),
}).strict()

export type AuthorizationGap = z.infer<typeof authorizationGapSchema>

/**
 * 已知盲区词表（spec §4，冻结 10 值）。
 * 结构性（观察方式决定、恒为真）：unmounted_infinite_scroll / cross_origin_iframe /
 *   hidden_or_lazy_content / indistinguishable_absence；
 * 事件派生（需要持久化的事实）：unvisited_pagination / editor_page_dropped /
 *   oversized_page / denied_sensitive_url / authorization_gap / capture_failure。
 */
export const COVERAGE_KNOWN_MISSING_REASONS = [
  'unvisited_pagination',
  'unmounted_infinite_scroll',
  'cross_origin_iframe',
  'hidden_or_lazy_content',
  'editor_page_dropped',
  'oversized_page',
  'denied_sensitive_url',
  'authorization_gap',
  'capture_failure',
  'indistinguishable_absence',
] as const

export type CoverageKnownMissingReason = (typeof COVERAGE_KNOWN_MISSING_REASONS)[number]

const pageStateWatermarkSchema = z.object({
  pageInstanceId: z.string().min(1),
  stateVersion: z.number().int().nonnegative(),
  lastAppliedSequence: z.number().int().nonnegative(),
}).strict()

/** 派生输入边界（spec §2 inputBounds）：纳入投影缓存键。 */
export const coverageInputBoundsSchema = z.object({
  sessions: z.array(z.string().min(1)),
  pageStateWatermarks: z.array(pageStateWatermarkSchema).min(1),
}).strict()

export type CoverageInputBounds = z.infer<typeof coverageInputBoundsSchema>

/**
 * 覆盖声明（spec §2 CoverageManifest）。只含 origin/计数/时间，不含页面正文。
 * partialExtractionCount：null = capture_failed 事件尚未持久化的历史语义；
 * 自该事件落地（Phase 3 起）派生恒出 number。
 */
export const coverageManifestSchema = z.object({
  schemaVersion: z.literal(1),
  requestedScope: requestedScopeSchema,
  /** scope 内最早 observation 的 envelope.receivedAt；空 scope 为 ''。 */
  capturedFrom: z.string(),
  /** 最晚；空 scope 为 ''。 */
  capturedTo: z.string(),
  sessionCount: z.number().int().nonnegative(),
  /** 去重 pageInstanceId 计数。 */
  pageCount: z.number().int().nonnegative(),
  unitCount: z.number().int().nonnegative(),
  /** 计数口径必须随结果输出（P0 = 按 textHash 去重块）。 */
  unitCountBasis: z.enum(['deduped_text_blocks', 'canonical_units']),
  /** origin 列表（不含路径与 query），首见序。 */
  domains: z.array(z.string().min(1)),
  visitedPagination: z.array(visitedPaginationSchema),
  partialExtractionCount: z.number().int().nonnegative().nullable(),
  authorizationGaps: z.array(authorizationGapSchema),
  knownMissingReasons: z.array(z.enum(COVERAGE_KNOWN_MISSING_REASONS)),
  inputBounds: coverageInputBoundsSchema,
}).strict()

export type CoverageManifest = z.infer<typeof coverageManifestSchema>

/**
 * 盲区 reason → 展示文案（冻结映射；spec §5“文案可调，信息不得减”）。
 * 4 个结构性盲区用 §5 模板原文；事件派生盲区逐条如实列出。
 */
const KNOWN_MISSING_LABELS: Readonly<Record<CoverageKnownMissingReason, string>> = {
  unvisited_pagination: '没有访问的分页',
  unmounted_infinite_scroll: '未挂载的无限滚动内容',
  cross_origin_iframe: '跨域 iframe',
  hidden_or_lazy_content: '隐藏或未渲染的内容',
  editor_page_dropped: '存在被丢弃的编辑器/低内容页面',
  oversized_page: '存在超过捕获上限的页面',
  denied_sensitive_url: '存在被拒绝授权的敏感 URL',
  authorization_gap: '观察时段内存在授权中断',
  capture_failure: '存在捕获失败的页面（计数为下界）',
  indistinguishable_absence: '隐藏、删除或无权限内容（观察上不可区分）',
}

/** 计数口径标签（spec §2 unitCountBasis：口径必须随结果输出）。 */
const UNIT_COUNT_BASIS_LABELS: Readonly<Record<CoverageManifest['unitCountBasis'], string>> = {
  deduped_text_blocks: '按内容去重块计',
  canonical_units: '按内容单元计',
}

/**
 * CoverageManifest 摘要的固定渲染（spec §5）：每次分析结果顶部必须展示，
 * 同一文本进入模型上下文（使 limitations 有据可写）。纯函数、零墙钟；
 * manifest 只含 origin/计数/时间，因此本摘要永不泄漏页面正文。
 */
export function renderCoverageSummary(manifest: CoverageManifest): string {
  const lines: string[] = []
  lines.push('基于当前选择的本地捕获范围：')
  lines.push(`  ${manifest.unitCount} 个信息单元（${UNIT_COUNT_BASIS_LABELS[manifest.unitCountBasis]}）`)
  lines.push(`  ${manifest.pageCount} 个页面 · ${manifest.domains.length} 个站点`)
  for (const group of manifest.visitedPagination) {
    lines.push(`  覆盖分页 ${group.path}：${formatSelectors(group.observedSelectors)}（未穷尽）`)
  }
  const hasTime = manifest.capturedFrom !== '' || manifest.capturedTo !== ''
  lines.push(`  观察时段：${hasTime ? `${manifest.capturedFrom || '…'} ～ ${manifest.capturedTo || '…'}` : '无观察'}`)
  lines.push('未覆盖：')
  for (const reason of manifest.knownMissingReasons) {
    lines.push(`  - ${KNOWN_MISSING_LABELS[reason]}`)
  }
  return lines.join('\n')
}

/** selector 组 → 展示串：全部以数字结尾时压成 min～max，否则按观察序原文并列。 */
function formatSelectors(selectors: readonly string[]): string {
  const numbers = selectors.map(s => /(\d+)$/.exec(s)?.[1])
  if (numbers.every(n => n !== undefined)) {
    const values = numbers.map(n => Number(n!))
    const min = Math.min(...values)
    const max = Math.max(...values)
    return min === max ? String(min) : `${min}～${max}`
  }
  return selectors.join('、')
}
