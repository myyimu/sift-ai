// deriveCoverageManifest 派生规则测试（P0_COVERAGE_MANIFEST_SPEC §3/§4）。
// 全部确定性断言：同输入两次调用逐字节相同；无事实不虚构；观察者永不声明穷尽。
import { describe, expect, it } from 'vitest'
import { deriveCoverageManifest, snapshotGroupKey, type ManifestInput, type ManifestObservation, type ManifestPageState } from '../src/manifest'

const SEQ_WATERMARK = 1000 // 足够大：默认不切（watermark 切面单独测）

function obs(over: Partial<ManifestObservation> = {}): ManifestObservation {
  return {
    id: 'obs-1',
    sessionId: 'sess-1',
    tabId: 'tab-1',
    pageInstanceId: 'page-1',
    sequence: 0,
    receivedAt: '2026-08-27T00:00:00.000Z',
    url: 'https://example.com/article',
    type: 'document_started',
    controlPayload: null,
    ...over,
  }
}

function ps(over: Partial<ManifestPageState> = {}): ManifestPageState {
  return {
    pageInstanceId: 'page-1',
    stateVersion: 1,
    lastAppliedSequence: SEQ_WATERMARK,
    canonicalUrl: 'https://example.com/article',
    ...over,
  }
}

function granted(observedAt: string, over: Partial<ManifestObservation> = {}): ManifestObservation {
  return obs({
    id: `g-${observedAt}`,
    type: 'authorization_granted',
    receivedAt: observedAt,
    controlPayload: { kind: 'authorization_granted', origin: 'https://example.com', reason: 'user_gesture' },
    ...over,
  })
}

function revoked(observedAt: string, reason: string, over: Partial<ManifestObservation> = {}): ManifestObservation {
  return obs({
    id: `r-${observedAt}`,
    type: 'authorization_revoked',
    receivedAt: observedAt,
    controlPayload: { kind: 'authorization_revoked', reason, url: 'https://fallback.example/' },
    ...over,
  })
}

function captureFailed(code: string, over: Partial<ManifestObservation> = {}): ManifestObservation {
  return obs({
    id: `f-${code}-${over.id ?? ''}`,
    type: 'capture_failed',
    controlPayload: { kind: 'capture_failed', code, instanceNonce: 'n' },
    ...over,
  })
}

const BASE_INPUT: ManifestInput = {
  scope: { kind: 'demo_session', sessionId: 'sess-1' },
  observations: [
    granted('2026-08-27T00:00:00.000Z'),
    obs({ id: 'd1', type: 'document_started', sequence: 1, receivedAt: '2026-08-27T00:00:01.000Z' }),
    obs({ id: 'd2', type: 'dom_snapshot', sequence: 2, receivedAt: '2026-08-27T00:00:02.000Z' }),
  ],
  pageStates: [ps({ stateVersion: 3, lastAppliedSequence: 2 })],
  unitCount: 5,
}

describe('确定性', () => {
  it('同输入两次派生 → JSON 逐字节相同（可缓存语义，spec §3）', () => {
    const a = deriveCoverageManifest(BASE_INPUT)
    const b = deriveCoverageManifest(BASE_INPUT)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('scope 过滤与计数', () => {
  it('demo_session：只计本 session；current_page：只计本 page；capturedFrom/To = min/max receivedAt', () => {
    const observations = [
      granted('2026-08-27T00:00:00.000Z'),
      obs({ id: 'x1', sessionId: 'sess-2', pageInstanceId: 'page-2', receivedAt: '2026-08-27T09:00:00.000Z' }),
      obs({ id: 'x2', sequence: 1, receivedAt: '2026-08-27T00:05:00.000Z', pageInstanceId: 'page-1b' }),
    ]
    const m = deriveCoverageManifest({
      scope: { kind: 'demo_session', sessionId: 'sess-1' },
      observations,
      pageStates: [ps(), ps({ pageInstanceId: 'page-1b' }), ps({ pageInstanceId: 'page-2' })],
      unitCount: 0,
    })
    expect(m.capturedFrom).toBe('2026-08-27T00:00:00.000Z')
    expect(m.capturedTo).toBe('2026-08-27T00:05:00.000Z')
    expect(m.sessionCount).toBe(1)
    expect(m.pageCount).toBe(2) // page-1 + page-1b（sess-2 的 page-2 不计）
    expect(m.inputBounds.sessions).toEqual(['sess-1'])
  })

  it('topic_scope：receivedAt ∈ [from,to] 闭区间', () => {
    const m = deriveCoverageManifest({
      scope: { kind: 'topic_scope', from: '2026-08-27T00:00:01.000Z', to: '2026-08-27T00:00:02.000Z' },
      observations: BASE_INPUT.observations,
      pageStates: BASE_INPUT.pageStates,
      unitCount: 0,
    })
    expect(m.capturedFrom).toBe('2026-08-27T00:00:01.000Z')
    expect(m.capturedTo).toBe('2026-08-27T00:00:02.000Z')
    expect(m.sessionCount).toBe(1)
  })

  it('watermark 切面：sequence > lastAppliedSequence 的行不计', () => {
    const m = deriveCoverageManifest({
      scope: { kind: 'demo_session', sessionId: 'sess-1' },
      observations: [
        granted('2026-08-27T00:00:00.000Z'),
        obs({ id: 'after', sequence: 999, receivedAt: '2026-08-27T00:09:00.000Z' }),
      ],
      pageStates: [ps({ lastAppliedSequence: 1 })],
      unitCount: 0,
    })
    expect(m.capturedTo).toBe('2026-08-27T00:00:00.000Z') // sequence 999 > watermark 1 被切
  })

  it('空 scope：capturedFrom/To 为空串、计数为 0、unitCount 透传', () => {
    const m = deriveCoverageManifest({
      scope: { kind: 'demo_session', sessionId: 'sess-none' },
      observations: BASE_INPUT.observations,
      pageStates: BASE_INPUT.pageStates,
      unitCount: 7,
    })
    expect(m.capturedFrom).toBe('')
    expect(m.capturedTo).toBe('')
    expect(m.sessionCount).toBe(0)
    expect(m.pageCount).toBe(0)
    expect(m.unitCount).toBe(7)
    expect(m.unitCountBasis).toBe('deduped_text_blocks')
    expect(m.domains).toEqual([])
  })

  it('domains：origin 首见序去重', () => {
    const m = deriveCoverageManifest({
      scope: { kind: 'demo_session', sessionId: 'sess-1' },
      observations: [
        obs({ id: 'a', url: 'https://b.example/x', receivedAt: '2026-08-27T00:00:01.000Z' }),
        obs({ id: 'b', url: 'https://a.example/y', receivedAt: '2026-08-27T00:00:02.000Z' }),
        obs({ id: 'c', url: 'https://b.example/z', receivedAt: '2026-08-27T00:00:03.000Z' }),
      ],
      pageStates: [ps()],
      unitCount: 0,
    })
    expect(m.domains).toEqual(['https://b.example', 'https://a.example'])
  })
})

describe('authorizationGaps（granted/revoked 按 tab 配对）', () => {
  it('cross_origin / tab_closed 各自成对；origin 取授予 origin 而非 revoke 回退 url', () => {
    const m = deriveCoverageManifest({
      scope: { kind: 'demo_session', sessionId: 'sess-1' },
      observations: [
        granted('2026-08-27T00:00:00.000Z', { tabId: 'tab-1' }),
        revoked('2026-08-27T00:01:00.000Z', 'cross_origin', { tabId: 'tab-1' }),
        granted('2026-08-27T00:02:00.000Z', { tabId: 'tab-2', controlPayload: { kind: 'authorization_granted', origin: 'https://two.example', reason: 'user_gesture' } }),
        revoked('2026-08-27T00:03:00.000Z', 'tab_closed', { tabId: 'tab-2', controlPayload: { kind: 'authorization_revoked', reason: 'tab_closed', url: 'https://fallback.example/' } }),
      ],
      pageStates: [ps()],
      unitCount: 0,
    })
    expect(m.authorizationGaps).toEqual([
      { origin: 'https://example.com', from: '2026-08-27T00:00:00.000Z', to: '2026-08-27T00:01:00.000Z', reason: 'revoked_cross_origin' },
      { origin: 'https://two.example', from: '2026-08-27T00:02:00.000Z', to: '2026-08-27T00:03:00.000Z', reason: 'revoked_tab_closed' },
    ])
    expect(m.knownMissingReasons).toContain('authorization_gap')
  })

  it('未闭合 grant（授权仍活跃）无 gap；孤儿 revoke 无配对跳过', () => {
    const m = deriveCoverageManifest({
      scope: { kind: 'demo_session', sessionId: 'sess-1' },
      observations: [
        granted('2026-08-27T00:00:00.000Z', { tabId: 'tab-1' }), // 未闭合
        revoked('2026-08-27T00:01:00.000Z', 'cross_origin', { tabId: 'tab-9' }), // 无 grant
      ],
      pageStates: [ps()],
      unitCount: 0,
    })
    expect(m.authorizationGaps).toEqual([])
    expect(m.knownMissingReasons).not.toContain('authorization_gap')
  })

  it('同 tab 重授权：先闭旧再开新（异源重点路径的事件序列）', () => {
    const m = deriveCoverageManifest({
      scope: { kind: 'demo_session', sessionId: 'sess-1' },
      observations: [
        granted('2026-08-27T00:00:00.000Z', { tabId: 'tab-1', controlPayload: { kind: 'authorization_granted', origin: 'https://old.example', reason: 'user_gesture' } }),
        revoked('2026-08-27T00:00:30.000Z', 'cross_origin', { tabId: 'tab-1' }),
        granted('2026-08-27T00:01:00.000Z', { tabId: 'tab-1', controlPayload: { kind: 'authorization_granted', origin: 'https://new.example', reason: 'user_gesture' } }),
      ],
      pageStates: [ps()],
      unitCount: 0,
    })
    expect(m.authorizationGaps).toEqual([
      { origin: 'https://old.example', from: '2026-08-27T00:00:00.000Z', to: '2026-08-27T00:00:30.000Z', reason: 'revoked_cross_origin' },
    ])
  })

  it('词表外 revoke reason（如未来 port_error）跳过：闭配对但不虚构盲区', () => {
    const m = deriveCoverageManifest({
      scope: { kind: 'demo_session', sessionId: 'sess-1' },
      observations: [
        granted('2026-08-27T00:00:00.000Z', { tabId: 'tab-1' }),
        revoked('2026-08-27T00:01:00.000Z', 'port_error', { tabId: 'tab-1' }),
      ],
      pageStates: [ps()],
      unitCount: 0,
    })
    expect(m.authorizationGaps).toEqual([])
  })
})

describe('visitedPagination', () => {
  it('?page=1..3 分组：同 path 归组、selector 按观察序去重、非分页参数保留在组键', () => {
    const pages = [1, 3, 2, 1].map((n, i) =>
      ps({ pageInstanceId: `pg-${i}`, canonicalUrl: `https://shop.example/list?page=${n}&sort=hot` }),
    )
    const m = deriveCoverageManifest({
      scope: { kind: 'demo_session', sessionId: 'sess-1' },
      observations: [
        granted('2026-08-27T00:00:00.000Z'),
        ...pages.map((p, i) =>
          obs({ id: `pg-obs-${i}`, pageInstanceId: p.pageInstanceId, sequence: 0, receivedAt: `2026-08-27T00:00:0${i + 1}.000Z`, type: 'dom_snapshot' }),
        ),
      ],
      pageStates: pages,
      unitCount: 0,
    })
    expect(m.visitedPagination).toEqual([
      {
        origin: 'https://shop.example',
        path: '/list?sort=hot',
        observedSelectors: ['page=1', 'page=3', 'page=2'],
        observedCount: 3,
        exhausted: false,
      },
    ])
    expect(m.knownMissingReasons).toContain('unvisited_pagination') // 观察到 1–3，4+ 未访问
  })

  it('/page/N 与 /p/N 路径形态：段剔除归组、selector 规范为 /page/N', () => {
    const m = deriveCoverageManifest({
      scope: { kind: 'demo_session', sessionId: 'sess-1' },
      observations: [
        granted('2026-08-27T00:00:00.000Z'),
        obs({ id: 'pa', pageInstanceId: 'a', sequence: 0, receivedAt: '2026-08-27T00:00:01.000Z', type: 'dom_snapshot' }),
        obs({ id: 'pb', pageInstanceId: 'b', sequence: 0, receivedAt: '2026-08-27T00:00:02.000Z', type: 'dom_snapshot' }),
        obs({ id: 'pc', pageInstanceId: 'c', sequence: 0, receivedAt: '2026-08-27T00:00:03.000Z', type: 'dom_snapshot' }),
      ],
      pageStates: [
        ps({ pageInstanceId: 'a', canonicalUrl: 'https://blog.example/posts/page/2' }),
        ps({ pageInstanceId: 'b', canonicalUrl: 'https://blog.example/posts/p/3' }),
        ps({ pageInstanceId: 'c', canonicalUrl: 'https://blog.example/posts/page/2' }), // 重复 selector 去重
      ],
      unitCount: 0,
    })
    expect(m.visitedPagination).toEqual([
      {
        origin: 'https://blog.example',
        path: '/posts',
        observedSelectors: ['/page/2', '/page/3'],
        observedCount: 2,
        exhausted: false,
      },
    ])
  })

  it('无分页标记的 canonicalUrl 不产生 visitedPagination，也不点亮 unvisited_pagination', () => {
    const m = deriveCoverageManifest({
      scope: { kind: 'demo_session', sessionId: 'sess-1' },
      observations: [granted('2026-08-27T00:00:00.000Z')],
      pageStates: [
        ps({ pageInstanceId: 'a', canonicalUrl: 'https://a.example/article?id=9&page' }), // page 无数值
        ps({ pageInstanceId: 'b', canonicalUrl: 'https://a.example/article?tab=all' }), // 非分页参数
        ps({ pageInstanceId: 'c', canonicalUrl: 'https://a.example/article' }),
      ],
      unitCount: 0,
    })
    expect(m.visitedPagination).toEqual([])
    expect(m.knownMissingReasons).not.toContain('unvisited_pagination')
  })

  it('scope 外 page 的 canonicalUrl 不入组', () => {
    const m = deriveCoverageManifest({
      scope: { kind: 'current_page', pageInstanceId: 'page-1' },
      observations: [granted('2026-08-27T00:00:00.000Z')],
      pageStates: [
        ps({ canonicalUrl: 'https://shop.example/list?page=1' }),
        ps({ pageInstanceId: 'other', canonicalUrl: 'https://shop.example/list?page=9' }),
      ],
      unitCount: 0,
    })
    expect(m.visitedPagination).toEqual([
      { origin: 'https://shop.example', path: '/list', observedSelectors: ['page=1'], observedCount: 1, exhausted: false },
    ])
  })
})

describe('partialExtractionCount 与 knownMissingReasons', () => {
  it('capture_failed 计数；code→盲区映射（limit→oversized / too_little→editor_dropped / denied→denied_sensitive_url；任一→capture_failure）', () => {
    const m = deriveCoverageManifest({
      scope: { kind: 'demo_session', sessionId: 'sess-1' },
      observations: [
        granted('2026-08-27T00:00:00.000Z'),
        captureFailed('capture_limit_exceeded', { id: 'f1', sequence: 1, receivedAt: '2026-08-27T00:00:01.000Z' }),
        captureFailed('capture_too_little_content', { id: 'f2', sequence: 2, receivedAt: '2026-08-27T00:00:02.000Z' }),
        captureFailed('capture_denied', { id: 'f3', sequence: 3, receivedAt: '2026-08-27T00:00:03.000Z' }),
      ],
      pageStates: [ps()],
      unitCount: 0,
    })
    expect(m.partialExtractionCount).toBe(3)
    expect(m.knownMissingReasons).toEqual([
      'unmounted_infinite_scroll', // 结构性恒列（词表序）
      'cross_origin_iframe',
      'hidden_or_lazy_content',
      'editor_page_dropped',
      'oversized_page',
      'denied_sensitive_url',
      'capture_failure',
      'indistinguishable_absence',
    ])
  })

  it('无任何事实：只有 4 个结构性盲区（无事实不虚构）', () => {
    const m = deriveCoverageManifest(BASE_INPUT)
    expect(m.knownMissingReasons).toEqual([
      'unmounted_infinite_scroll',
      'cross_origin_iframe',
      'hidden_or_lazy_content',
      'indistinguishable_absence',
    ])
    expect(m.partialExtractionCount).toBe(0)
  })
})

describe('inputBounds', () => {
  it('sessions 首见序 + scope 内 watermarks 按 pageInstanceId 排序', () => {
    const m = deriveCoverageManifest({
      scope: { kind: 'demo_session', sessionId: 'sess-1' },
      observations: [
        obs({ id: 'b', pageInstanceId: 'page-b', sequence: 0, receivedAt: '2026-08-27T00:00:01.000Z' }),
        obs({ id: 'a', pageInstanceId: 'page-a', sequence: 0, receivedAt: '2026-08-27T00:00:02.000Z' }),
        obs({ id: 'z', pageInstanceId: 'page-z', sequence: 0, receivedAt: '2026-08-27T00:00:03.000Z' }),
      ],
      pageStates: [
        ps({ pageInstanceId: 'page-z', stateVersion: 9, lastAppliedSequence: 90 }),
        ps({ pageInstanceId: 'page-b', stateVersion: 2, lastAppliedSequence: 20 }),
        ps({ pageInstanceId: 'page-a', stateVersion: 1, lastAppliedSequence: 10 }),
        ps({ pageInstanceId: 'page-out', stateVersion: 1, lastAppliedSequence: 1 }), // scope 外不入
      ],
      unitCount: 0,
    })
    expect(m.inputBounds.sessions).toEqual(['sess-1'])
    expect(m.inputBounds.pageStateWatermarks).toEqual([
      { pageInstanceId: 'page-a', stateVersion: 1, lastAppliedSequence: 10 },
      { pageInstanceId: 'page-b', stateVersion: 2, lastAppliedSequence: 20 },
      { pageInstanceId: 'page-z', stateVersion: 9, lastAppliedSequence: 90 },
    ])
  })
})

// —— snapshotGroupKey（2026-08-28 块级合并投影的 URL 分组键） ——
describe('snapshotGroupKey：URL 分组（滚动史同组、跨 URL 分组）', () => {
  it('尾部楼层号剔除：Discourse 滚动 URL 同组', () => {
    const key = snapshotGroupKey('https://linux.do/t/topic-slug/123/45', '帖子甲')
    expect(snapshotGroupKey('https://linux.do/t/topic-slug/123/120', '帖子甲')).toBe(key)
    expect(snapshotGroupKey('https://linux.do/t/topic-slug/123', '帖子甲')).toBe(key) // 无楼层号的主题页
  })

  it('不同 slug / 不同 title 分组；数字章节靠 title 兜底', () => {
    const a = snapshotGroupKey('https://linux.do/t/aaa/1/1', '帖子甲')
    expect(snapshotGroupKey('https://linux.do/t/bbb/2/1', '帖子乙')).not.toBe(a)
    // /guide/2 vs /guide/3 路径归一后会撞——title 区分数字章节
    expect(snapshotGroupKey('https://x.com/guide/2', '第一章')).not.toBe(snapshotGroupKey('https://x.com/guide/3', '第二章'))
    // 非数字尾段（文章 slug）不剔除
    expect(snapshotGroupKey('https://x.com/a/post-1', 'T')).not.toBe(snapshotGroupKey('https://x.com/a/post-2', 'T'))
  })

  it('分页 query 剔除（与 visitedPagination 同词表）；其余 query 保留', () => {
    expect(snapshotGroupKey('https://x.com/list?page=2', '列表')).toBe(snapshotGroupKey('https://x.com/list', '列表'))
    expect(snapshotGroupKey('https://x.com/list?id=9', 'A')).not.toBe(snapshotGroupKey('https://x.com/list?id=8', 'A'))
  })

  it('非法 URL 退化为原文键（不抛异常）', () => {
    expect(snapshotGroupKey('not-a-url', 'T')).toBe('raw|not-a-url|T')
  })
})
