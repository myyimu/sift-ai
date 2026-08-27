// renderCoverageSummary 固定块测试（P0_COVERAGE_MANIFEST_SPEC §5：信息不得减；
// 结构性盲区四行用模板原文；分页恒标“未穷尽”）。
import { describe, expect, it } from 'vitest'
import { renderCoverageSummary, type CoverageManifest } from '../src/coverage'

function makeManifest(over: Partial<CoverageManifest> = {}): CoverageManifest {
  return {
    schemaVersion: 1,
    requestedScope: { kind: 'demo_session', sessionId: 'sess-1' },
    capturedFrom: '2026-08-27T01:00:00.000Z',
    capturedTo: '2026-08-27T02:30:00.000Z',
    sessionCount: 1,
    pageCount: 9,
    unitCount: 127,
    unitCountBasis: 'deduped_text_blocks',
    domains: ['https://example.com', 'https://other.example'],
    visitedPagination: [],
    partialExtractionCount: 0,
    authorizationGaps: [],
    knownMissingReasons: ['unmounted_infinite_scroll', 'cross_origin_iframe', 'hidden_or_lazy_content', 'indistinguishable_absence'],
    inputBounds: {
      sessions: ['sess-1'],
      pageStateWatermarks: [{ pageInstanceId: 'p-1', stateVersion: 3, lastAppliedSequence: 12 }],
    },
    ...over,
  }
}

describe('renderCoverageSummary（spec §5 固定块）', () => {
  it('全字段：单元/页面/站点/时段 + 结构性盲区四行模板原文', () => {
    const text = renderCoverageSummary(makeManifest())
    expect(text).toBe([
      '基于当前选择的本地捕获范围：',
      '  127 个信息单元（按内容去重块计）',
      '  9 个页面 · 2 个站点',
      '  观察时段：2026-08-27T01:00:00.000Z ～ 2026-08-27T02:30:00.000Z',
      '未覆盖：',
      '  - 未挂载的无限滚动内容',
      '  - 跨域 iframe',
      '  - 隐藏或未渲染的内容',
      '  - 隐藏、删除或无权限内容（观察上不可区分）',
    ].join('\n'))
  })

  it('数字分页 1～3 → 压缩区间并恒标（未穷尽）；口径标签随 basis', () => {
    const text = renderCoverageSummary(makeManifest({
      unitCountBasis: 'canonical_units',
      visitedPagination: [
        { origin: 'https://example.com', path: '/posts', observedSelectors: ['page=1', 'page=2', 'page=3'], observedCount: 3, exhausted: false },
      ],
    }))
    expect(text).toContain('  覆盖分页 /posts：1～3（未穷尽）')
    expect(text).toContain('（按内容单元计）')
  })

  it('单个数字 selector 不渲染区间；非数字 selector 按观察序原文并列', () => {
    const single = renderCoverageSummary(makeManifest({
      visitedPagination: [
        { origin: 'https://example.com', path: '/a', observedSelectors: ['page=2'], observedCount: 1, exhausted: false },
      ],
    }))
    expect(single).toContain('  覆盖分页 /a：2（未穷尽）')

    const mixed = renderCoverageSummary(makeManifest({
      visitedPagination: [
        { origin: 'https://example.com', path: '/b', observedSelectors: ['?p=next', '?p=prev'], observedCount: 2, exhausted: false },
      ],
    }))
    expect(mixed).toContain('  覆盖分页 /b：?p=next、?p=prev（未穷尽）')
  })

  it('空 scope：无覆盖分页行 + 观察时段显示“无观察”', () => {
    const text = renderCoverageSummary(makeManifest({ capturedFrom: '', capturedTo: '', pageCount: 0, unitCount: 0, domains: [] }))
    expect(text).toContain('  0 个页面 · 0 个站点')
    expect(text).toContain('  观察时段：无观察')
    expect(text).not.toContain('覆盖分页')
  })

  it('事件派生盲区逐条列出（信息不得减）', () => {
    const text = renderCoverageSummary(makeManifest({
      knownMissingReasons: [
        'unmounted_infinite_scroll', 'cross_origin_iframe', 'hidden_or_lazy_content',
        'editor_page_dropped', 'oversized_page', 'authorization_gap', 'capture_failure',
        'unvisited_pagination', 'indistinguishable_absence',
      ],
    }))
    expect(text).toContain('  - 存在被丢弃的编辑器/低内容页面')
    expect(text).toContain('  - 存在超过捕获上限的页面')
    expect(text).toContain('  - 观察时段内存在授权中断')
    expect(text).toContain('  - 存在捕获失败的页面（计数为下界）')
    expect(text).toContain('  - 没有访问的分页')
  })
})
