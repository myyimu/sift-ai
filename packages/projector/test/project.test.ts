// projectQuestion 组装规则测试（步骤 5–6 + 限额 + inputHash；验收门 10 确定性）。
import { describe, expect, it } from 'vitest'
import { questionProjectionSchema } from '@sift/shared'
import { projectQuestion, type ProjectQuestionParams } from '../src/project'
import type { ManifestObservation } from '../src/manifest'

const LONG = '这是一段超过二十个非空白字符的正文内容，用于通过普通块的最低门槛检查。'
const CTX = 128_000

function htmlOf(bodyInner: string): string {
  return `<html><head><title>t</title></head><body><main>${bodyInner}</main></body></html>`
}

interface PageSpec {
  pid: string
  capturedAt: string
  body: string
  stateVersion?: number
  title?: string
}

function buildParams(pages: readonly PageSpec[], over: Partial<ProjectQuestionParams> = {}): ProjectQuestionParams {
  return {
    question: '这篇文章的结论是什么？',
    scope: 'demo_session',
    pages: pages.map(p => ({
      sanitizedHtml: htmlOf(p.body),
      source: {
        pageInstanceId: p.pid,
        stateVersion: p.stateVersion ?? 1,
        ordinal: 0,
        ...(p.title !== undefined ? { title: p.title } : {}),
        safeUrl: `https://example.com/${p.pid}`,
        capturedAt: p.capturedAt,
      },
    })),
    manifestFacts: {
      scope: { kind: 'demo_session', sessionId: 'sess-1' },
      observations: pages.flatMap((p, i) => [
        {
          id: `obs-${p.pid}-${i}`, sessionId: 'sess-1', tabId: 'tab-1', pageInstanceId: p.pid,
          sequence: i, receivedAt: p.capturedAt, url: `https://example.com/${p.pid}`,
          type: 'document_started' as const, controlPayload: null,
        },
      ]),
      pageStates: pages.map(p => ({
        pageInstanceId: p.pid, stateVersion: p.stateVersion ?? 1, lastAppliedSequence: 10,
        canonicalUrl: `https://example.com/${p.pid}`,
      })),
    },
    modelContextWindow: CTX,
    ...over,
  }
}

const TWO_PAGES: readonly PageSpec[] = [
  { pid: 'page-b', capturedAt: '2026-08-27T00:02:00.000Z', body: `<h1>乙文标题</h1><p>${LONG}（乙一）</p>` },
  { pid: 'page-a', capturedAt: '2026-08-27T00:01:00.000Z', body: `<h1>甲文标题</h1><p>${LONG}（甲一）</p><p>${LONG}（甲二）</p>`, title: '甲文' },
]

describe('确定性（验收门 10）', () => {
  it('同输入两次投影 → JSON 逐字节相同（含 inputHash）', () => {
    const a = projectQuestion(buildParams(TWO_PAGES))
    const b = projectQuestion(buildParams(TWO_PAGES))
    expect(a.status).toBe('ok')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('pages 乱序输入 → 相同投影（预排序后输入序无关）', () => {
    const ordered = projectQuestion(buildParams(TWO_PAGES))
    const shuffled = projectQuestion(buildParams([TWO_PAGES[1]!, TWO_PAGES[0]!]))
    expect(JSON.stringify(ordered)).toBe(JSON.stringify(shuffled))
  })

  it('投影通过 questionProjectionSchema 校验', () => {
    const r = projectQuestion(buildParams(TWO_PAGES))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(questionProjectionSchema.safeParse(r.projection).success).toBe(true)
    expect(r.projection.truncation).toBe('none')
  })
})

describe('块序与去重（步骤 5）', () => {
  it('终序按第一 source (capturedAt, pageInstanceId, ordinal)；id 排序后编', () => {
    const r = projectQuestion(buildParams(TWO_PAGES))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    const { blocks } = r.projection
    expect(blocks.map(b => b.id)).toEqual(['b-0001', 'b-0002', 'b-0003', 'b-0004', 'b-0005'])
    // capturedAt 早的 page-a 在前（尽管输入序在后）
    expect(blocks[0]!.sources[0]!.pageInstanceId).toBe('page-a')
    expect(blocks[0]!.kind).toBe('heading')
    expect(blocks[4]!.sources[0]!.pageInstanceId).toBe('page-b')
  })

  it('跨页同文本：合并 sources、只保留一块', () => {
    const r = projectQuestion(buildParams([
      { pid: 'page-a', capturedAt: '2026-08-27T00:01:00.000Z', body: `<p>${LONG}</p>` },
      { pid: 'page-b', capturedAt: '2026-08-27T00:02:00.000Z', body: `<p>${LONG}</p><p>${LONG}（独有）</p>` },
    ]))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    const { blocks, coverage } = r.projection
    const dup = blocks.find(b => b.text === LONG)!
    expect(dup).toBeDefined()
    expect(dup.sources.map(s => s.pageInstanceId)).toEqual(['page-a', 'page-b'])
    expect(blocks).toHaveLength(2)
    expect(coverage.unitCount).toBe(2) // 去重后块数
  })

  it('source 带 title（可选字段）；watermark 按 pageInstanceId 排序', () => {
    const r = projectQuestion(buildParams(TWO_PAGES))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.projection.blocks.find(b => b.sources[0]!.title === '甲文')).toBeDefined()
    expect(r.projection.pageStateWatermarks.map(w => w.pageInstanceId)).toEqual(['page-a', 'page-b'])
  })
})

describe('限额（全量或不发送）', () => {
  function pageN(i: number): PageSpec {
    return { pid: `p-${String(i).padStart(3, '0')}`, capturedAt: '2026-08-27T00:00:00.000Z', body: `<p>${LONG}（页 ${i}）</p>` }
  }

  it('21 页 → projection_limit_exceeded 携精确 usage 与冻结 limits', () => {
    const r = projectQuestion(buildParams(Array.from({ length: 21 }, (_, i) => pageN(i))))
    expect(r).toMatchObject({
      status: 'projection_limit_exceeded',
      usage: { pages: 21 },
      limits: { maxPages: 20, maxBlocks: 600, maxUtf8Bytes: 512 * 1024, maxEstimatedTokens: 32_000 },
    })
  })

  it('同一页 25 张快照不占 pages 限额（usage = distinct 页数；块级合并投影）', () => {
    const r = projectQuestion(buildParams(Array.from({ length: 25 }, (_, i) => ({
      pid: 'p-001',
      capturedAt: `2026-08-27T00:00:${String(i).padStart(2, '0')}.000Z`,
      body: `<p>${LONG}（快照 ${i}）</p>`,
      stateVersion: i + 1,
    }))))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.projection.pageStateWatermarks).toHaveLength(1) // 仍是一页
    expect(r.projection.blocks).toHaveLength(25)
    // 块序 = 首见顺序（capturedAt 升序）；快照份数不改变 id 编号语义
    expect(r.projection.blocks[0]!.sources[0]!.stateVersion).toBe(1)
    expect(r.projection.blocks[24]!.sources[0]!.stateVersion).toBe(25)
  })

  it('21 页 × 各 2 快照 → usage.pages 按distinct 页数计 = 21（输入份数 42 不是页数）', () => {
    const specs = Array.from({ length: 21 }, (_, i) => [
      { pid: `p-${String(i).padStart(3, '0')}`, capturedAt: '2026-08-27T00:00:00.000Z', body: `<p>${LONG}（页 ${i}）</p>`, stateVersion: 1 },
      { pid: `p-${String(i).padStart(3, '0')}`, capturedAt: '2026-08-27T00:00:01.000Z', body: `<p>${LONG}（页 ${i} 补充）</p>`, stateVersion: 2 },
    ]).flat()
    const r = projectQuestion(buildParams(specs))
    expect(r).toMatchObject({ status: 'projection_limit_exceeded', usage: { pages: 21 } })
  })

  it('601 块 → limit_exceeded（2026-08-28 修订：上限 200→600）', () => {
    const paras = Array.from({ length: 601 }, (_, i) => `<p>${LONG}（块 ${i}）</p>`).join('')
    const r = projectQuestion(buildParams([{ pid: 'p-001', capturedAt: '2026-08-27T00:00:00.000Z', body: paras }]))
    expect(r).toMatchObject({ status: 'projection_limit_exceeded', usage: { blocks: 601 } })
  })

  it('utf8 字节超 512KiB → limit_exceeded', () => {
    // 块数 600 限额内单块超长：200 块 × 3KiB/块 = 600KiB > 512KiB（字节先于块数触发）
    const big = '长'.repeat(1000) // 3 KiB/块
    const paras = Array.from({ length: 200 }, (_, i) => `<p>${big}（块 ${i}）</p>`).join('')
    const r = projectQuestion(buildParams([{ pid: 'p-001', capturedAt: '2026-08-27T00:00:00.000Z', body: paras }]))
    expect(r).toMatchObject({ status: 'projection_limit_exceeded' })
    if (r.status === 'projection_limit_exceeded') expect(r.usage.utf8Bytes).toBeGreaterThan(512 * 1024)
  })

  it('token 超 min(32000, ctx-8000) → limit_exceeded', () => {
    const big = '字'.repeat(1000) // 1000 token/块
    const paras = Array.from({ length: 40 }, (_, i) => `<p>${big}（块 ${i}）</p>`).join('')
    const r = projectQuestion(buildParams([{ pid: 'p-001', capturedAt: '2026-08-27T00:00:00.000Z', body: paras }]))
    expect(r).toMatchObject({ status: 'projection_limit_exceeded' })
    if (r.status === 'projection_limit_exceeded') expect(r.usage.estimatedTokens).toBeGreaterThan(32_000)
  })

  it('小 ctx：上限 = ctx − 8000，先于 32000 触发', () => {
    const big = '字'.repeat(900) // 900 token/块 × 25 个互异块 = 22500 > ctx(28000)−8000 = 20000
    const paras = Array.from({ length: 25 }, (_, i) => `<p>${big}（${i}）</p>`).join('')
    const r = projectQuestion(buildParams(
      [{ pid: 'p-001', capturedAt: '2026-08-27T00:00:00.000Z', body: paras }],
      { modelContextWindow: 28_000 },
    ))
    expect(r).toMatchObject({ status: 'projection_limit_exceeded', limits: { maxEstimatedTokens: 20_000 } })
  })
})

describe('空结果与非法输入', () => {
  it('无可收块 → projection_empty（raw outerHTML 永不外发）', () => {
    const r = projectQuestion(buildParams([
      { pid: 'p-001', capturedAt: '2026-08-27T00:00:00.000Z', body: '<p>太短</p>' },
    ]))
    expect(r).toEqual({ status: 'projection_empty' })
  })

  it('input_invalid 族：空 question / 空 pages / 小 ctx / scope 不一致 / 缺 watermark / scope 外页', () => {
    expect(projectQuestion(buildParams(TWO_PAGES, { question: '   ' }))).toMatchObject({ status: 'projection_input_invalid' })
    expect(projectQuestion(buildParams([], {}))).toMatchObject({ status: 'projection_input_invalid' })
    expect(projectQuestion(buildParams(TWO_PAGES, { modelContextWindow: 8_000 }))).toMatchObject({ status: 'projection_input_invalid' })
    const wrongFacts = buildParams(TWO_PAGES)
    expect(projectQuestion({
      ...wrongFacts,
      manifestFacts: { ...wrongFacts.manifestFacts, scope: { kind: 'current_page', pageInstanceId: 'page-a' } },
    })).toMatchObject({ status: 'projection_input_invalid', reason: expect.stringContaining('不一致') })
    expect(projectQuestion({
      ...buildParams([{ pid: 'page-a', capturedAt: '2026-08-27T00:01:00.000Z', body: `<p>${LONG}</p>` }]),
      scope: 'current_page',
      manifestFacts: {
        scope: { kind: 'current_page', pageInstanceId: 'page-other' },
        observations: [] as ManifestObservation[],
        pageStates: [{ pageInstanceId: 'page-other', stateVersion: 1, lastAppliedSequence: 1, canonicalUrl: 'https://example.com/other' }],
      },
    })).toMatchObject({ status: 'projection_input_invalid' })
    const noWatermark = buildParams(TWO_PAGES)
    expect(projectQuestion({
      ...noWatermark,
      manifestFacts: {
        ...noWatermark.manifestFacts,
        pageStates: noWatermark.manifestFacts.pageStates.slice(0, 1), // page-b 无 watermark
      },
    })).toMatchObject({ status: 'projection_input_invalid', reason: expect.stringContaining('watermark') })
  })
})

describe('coverage 接线（工作流 D→E）', () => {
  it('投影内 coverage 来自 deriveCoverageManifest（unitCount = 去重块数）', () => {
    const r = projectQuestion(buildParams([
      { pid: 'page-a', capturedAt: '2026-08-27T00:01:00.000Z', body: `<p>${LONG}</p>` },
      { pid: 'page-b', capturedAt: '2026-08-27T00:02:00.000Z', body: `<p>${LONG}</p>` },
    ]))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.projection.coverage).toMatchObject({
      sessionCount: 1,
      pageCount: 2,
      unitCount: 1,
      unitCountBasis: 'deduped_text_blocks',
      domains: ['https://example.com'],
    })
    expect(r.projection.coverage.requestedScope).toEqual({ kind: 'demo_session', sessionId: 'sess-1' })
  })
})
