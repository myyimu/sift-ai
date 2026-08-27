// CoverageManifest 确定性派生（P0_COVERAGE_MANIFEST_SPEC §3/§4；工作流 D）。
//
// 纪律：
//  - 纯函数：全部事实来自入参（journal 行 + Page State watermarks），零墙钟、零随机、
//    零网络/LLM——同一输入逐字节相同输出（spec §3 可缓存语义的根基）；
//  - 词表冻结：knownMissingReasons 只从 COVERAGE_KNOWN_MISSING_REASONS 里按事实点亮，
//    输出按词表序排列（确定性），无事实不虚构；
//  - 观察者永不声明穷尽：visitedPagination.exhausted 恒 false。
//
// 事件→盲区映射（spec §4）：capture_limit_exceeded→oversized_page；
// capture_too_little_content→editor_page_dropped；capture_denied→denied_sensitive_url；
// 任一 capture_failed→capture_failure；authorizationGaps 非空→authorization_gap。
// unitCount 环（块数要在投影去重后才知道）经 ManifestInput.unitCount 入参解决。
import type { ObservationType } from '@sift/shared'
import {
  COVERAGE_KNOWN_MISSING_REASONS,
  type AuthorizationGap,
  type CoverageKnownMissingReason,
  type CoverageManifest,
  type RequestedScope,
  type VisitedPagination,
} from '@sift/shared'

/** journal 行的派生视角（dom_snapshot 的 controlPayload 为 null——正文不进 manifest）。 */
export interface ManifestObservation {
  readonly id: string
  readonly sessionId: string
  readonly tabId: string
  readonly pageInstanceId: string
  readonly sequence: number
  readonly receivedAt: string
  readonly url: string
  readonly type: ObservationType
  /** 控制事件已解码的 payload；dom_snapshot 为 null。 */
  readonly controlPayload: unknown
}

export interface ManifestPageState {
  readonly pageInstanceId: string
  readonly stateVersion: number
  readonly lastAppliedSequence: number
  readonly canonicalUrl: string
}

export interface ManifestInput {
  readonly scope: RequestedScope
  /** journal 序（调用方保证；本模块不排序，只按序消费首见语义）。 */
  readonly observations: readonly ManifestObservation[]
  readonly pageStates: readonly ManifestPageState[]
  /** 投影去重后的块数（unitCount 环：由 projectQuestion 填入）。 */
  readonly unitCount: number
}

// —— scope 过滤 ——

function inScope(obs: ManifestObservation, scope: RequestedScope): boolean {
  switch (scope.kind) {
    case 'current_page':
      return obs.pageInstanceId === scope.pageInstanceId
    case 'demo_session':
      return obs.sessionId === scope.sessionId
    case 'topic_scope':
      // ISO 8601 同格式下字典序即时间序（envelope.receivedAt 由 host 盖章，格式统一）
      return obs.receivedAt >= scope.from && obs.receivedAt <= scope.to
  }
}

// —— 分页识别（spec §2 visitedPagination） ——

/** 分页 query 参数名（小写精确匹配；数值型值才认）。 */
const PAGINATION_QUERY_KEYS = new Set(['page', 'p', 'pg'])

interface PaginationFacts {
  readonly origin: string
  /** 剔除分页参数/段后的规范化路径（保留其余 query 原序）。 */
  readonly path: string
  /** 观察到的分页标记原文（'page=2' / '/page/3'）。 */
  readonly selector: string
}

function paginationFactsOf(url: string): PaginationFacts | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // query 形态：?page=2 / ?p=3 / ?pg=4（数值型）
  const kept: string[] = []
  let selector: string | null = null
  for (const [key, value] of parsed.searchParams.entries()) {
    if (selector === null && PAGINATION_QUERY_KEYS.has(key.toLowerCase()) && /^\d+$/.test(value)) {
      selector = `${key.toLowerCase()}=${value}`
      continue // 分页参数不入组键
    }
    kept.push(`${key}=${value}`)
  }
  if (selector !== null) {
    const path = kept.length > 0 ? `${parsed.pathname}?${kept.join('&')}` : parsed.pathname
    return { origin: parsed.origin, path: path === '' ? '/' : path, selector }
  }
  // 路径段形态：/page/3、/p/3（数值段；剔除该段，尾斜杠归一去掉）
  const m = parsed.pathname.match(/^(.*?\/)(?:page|p)\/(\d+)(\/.*)?$/)
  if (m !== null) {
    const head = m[1]!
    const tail = m[3] ?? ''
    const joined = `${head}${tail}`.replace(/\/\/+/g, '/')
    const path = joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined === '' ? '/' : joined
    return { origin: parsed.origin, path, selector: `/page/${m[2]}` }
  }
  return null
}

// —— 授权缺口（granted/revoked 按 tab 在 journal 序上配对） ——

function reasonForGap(revokeReason: string): AuthorizationGap['reason'] | null {
  if (revokeReason === 'cross_origin') return 'revoked_cross_origin'
  if (revokeReason === 'tab_closed') return 'revoked_tab_closed'
  // 词表外的撤销原因（未来 port_error/sw_shutdown 等）无映射：跳过（spec §4），不虚构盲区
  return null
}

function payloadField(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined
  return (payload as Record<string, unknown>)[key]
}

// —— 派生主入口 ——

export function deriveCoverageManifest(input: ManifestInput): CoverageManifest {
  const { scope, observations, pageStates, unitCount } = input

  // watermark 切面：sequence ≤ 对应 page 的 lastAppliedSequence（无 page-state 的页不切）
  const watermarkOf = new Map<string, ManifestPageState>()
  for (const ps of pageStates) watermarkOf.set(ps.pageInstanceId, ps)

  const scoped = observations.filter(
    obs => inScope(obs, scope) && obs.sequence <= (watermarkOf.get(obs.pageInstanceId)?.lastAppliedSequence ?? Number.MAX_SAFE_INTEGER),
  )

  // capturedFrom/To + 首见序集合
  let capturedFrom = ''
  let capturedTo = ''
  const sessionIds: string[] = []
  const pageIds: string[] = []
  const domains: string[] = []
  for (const obs of scoped) {
    if (capturedFrom === '' || obs.receivedAt < capturedFrom) capturedFrom = obs.receivedAt
    if (obs.receivedAt > capturedTo) capturedTo = obs.receivedAt
    if (!sessionIds.includes(obs.sessionId)) sessionIds.push(obs.sessionId)
    if (!pageIds.includes(obs.pageInstanceId)) pageIds.push(obs.pageInstanceId)
    try {
      const origin = new URL(obs.url).origin
      if (origin !== '' && !domains.includes(origin)) domains.push(origin)
    } catch {
      // 非 URL 的 envelope.url：不进 domains（不虚构）
    }
  }

  // authorizationGaps：per-tab 开合配对（journal 序）
  const gaps: AuthorizationGap[] = []
  const openGrants = new Map<string, { origin: string; receivedAt: string }>()
  for (const obs of scoped) {
    if (obs.type === 'authorization_granted') {
      const origin = payloadField(obs.controlPayload, 'origin')
      openGrants.set(obs.tabId, {
        origin: typeof origin === 'string' && origin !== '' ? origin : safeOriginOf(obs.url),
        receivedAt: obs.receivedAt,
      })
    } else if (obs.type === 'authorization_revoked') {
      const open = openGrants.get(obs.tabId)
      openGrants.delete(obs.tabId)
      if (open === undefined) continue // 重放/崩溃窗口的孤儿 revoke：无配对来源，跳过
      const reason = payloadField(obs.controlPayload, 'reason')
      const mapped = typeof reason === 'string' ? reasonForGap(reason) : null
      if (mapped !== null) {
        // origin 取授予时的 origin（revoke 的 url 可能是回退值，非判定事实）
        gaps.push({ origin: open.origin, from: open.receivedAt, to: obs.receivedAt, reason: mapped })
      }
    }
  }
  // 未闭合的 grant = 授权仍活跃：无 gap（不虚构结束时间）

  // visitedPagination：scope 内 page-state 的 canonicalUrl 按观察序（pageStates 入序）分组
  const paginationGroups = new Map<string, VisitedPagination>()
  const scopedPages = new Set(scoped.map(obs => obs.pageInstanceId))
  for (const ps of pageStates) {
    if (!scopedPages.has(ps.pageInstanceId)) continue
    const facts = paginationFactsOf(ps.canonicalUrl)
    if (facts === null) continue
    const key = `${facts.origin}${facts.path}`
    const group = paginationGroups.get(key)
    if (group === undefined) {
      paginationGroups.set(key, {
        origin: facts.origin,
        path: facts.path,
        observedSelectors: [facts.selector],
        observedCount: 1,
        exhausted: false, // 观察者永不声明穷尽（spec §2）
      })
    } else if (!group.observedSelectors.includes(facts.selector)) {
      group.observedSelectors.push(facts.selector)
      group.observedCount = group.observedSelectors.length
    }
  }
  const visitedPagination = [...paginationGroups.values()]

  // partialExtractionCount：scope 内 capture_failed 行数（背压下可被逐出 → 下界）
  const partialExtractionCount = scoped.filter(obs => obs.type === 'capture_failed').length

  // knownMissingReasons：按冻结词表序点亮（结构性 4 值恒列；事件派生按事实）
  const facts = new Set<CoverageKnownMissingReason>()
  facts.add('unmounted_infinite_scroll')
  facts.add('cross_origin_iframe')
  facts.add('hidden_or_lazy_content')
  facts.add('indistinguishable_absence')
  if (visitedPagination.length > 0) facts.add('unvisited_pagination')
  for (const obs of scoped) {
    if (obs.type !== 'capture_failed') continue
    const code = payloadField(obs.controlPayload, 'code')
    if (code === 'capture_limit_exceeded') facts.add('oversized_page')
    else if (code === 'capture_too_little_content') facts.add('editor_page_dropped')
    else if (code === 'capture_denied') facts.add('denied_sensitive_url')
    facts.add('capture_failure')
  }
  if (gaps.length > 0) facts.add('authorization_gap')
  const knownMissingReasons = COVERAGE_KNOWN_MISSING_REASONS.filter(r => facts.has(r))

  // inputBounds：sessions 首见序 + scope 内 watermarks 按 pageInstanceId 排序
  const scopedWatermarks = pageStates
    .filter(ps => scopedPages.has(ps.pageInstanceId))
    .map(ps => ({ pageInstanceId: ps.pageInstanceId, stateVersion: ps.stateVersion, lastAppliedSequence: ps.lastAppliedSequence }))
    .sort((a, b) => (a.pageInstanceId < b.pageInstanceId ? -1 : a.pageInstanceId > b.pageInstanceId ? 1 : 0))

  return {
    schemaVersion: 1,
    requestedScope: scope,
    capturedFrom,
    capturedTo,
    sessionCount: sessionIds.length,
    pageCount: pageIds.length,
    unitCount,
    unitCountBasis: 'deduped_text_blocks',
    domains,
    visitedPagination,
    partialExtractionCount,
    authorizationGaps: gaps,
    knownMissingReasons,
    inputBounds: {
      sessions: sessionIds,
      pageStateWatermarks: scopedWatermarks,
    },
  }
}

function safeOriginOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url // 已是 sanitize 过的 origin 形态或退化为原文（不虚构）
  }
}
