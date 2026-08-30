import { describe, expect, it } from 'vitest'
import { extractUnits } from '../src/extractor'

const LONG = '这是一段足够长的正文内容，用于通过 UnitExtractor 的最低文本门槛并保留可回溯证据。'
const inputBase = {
  sourceObservationId: 'obs-1', sessionId: 'session-1', pageInstanceId: 'page-1', stateVersion: 3,
  safeUrl: 'https://example.com/list', observedAt: '2026-08-30T00:00:00.000Z', captureExtent: 'full' as const,
}

describe('UnitExtractor-v1', () => {
  it('extracts semantic units and excludes nested child content from parent ownership', () => {
    const result = extractUnits({ ...inputBase, html: `<main><article id="parent"><h1>父标题</h1><p>${LONG} 父内容</p><article id="child"><p>${LONG} 子内容</p></article></article></main>` })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.diagnostics.semanticCount).toBe(2)
    expect(result.observations).toHaveLength(2)
    const parent = result.observations.find(item => item.evidenceBlocks.some(block => result.evidenceBlobs.find(blob => blob.id === block.evidenceBlobId)?.text.includes('父内容')))
    expect(parent).toBeDefined()
    const parentText = parent!.evidenceBlocks.map(block => result.evidenceBlobs.find(blob => blob.id === block.evidenceBlobId)?.text ?? '').join(' ')
    expect(parentText).not.toContain('子内容')
  })

  it('splits repeated eligible siblings but does not split navigation noise', () => {
    const cards = [1, 2, 3].map(index => `<li><a href="/p/${index}">卡片 ${index}</a><p>${LONG} ${index}</p></li>`).join('')
    const result = extractUnits({ ...inputBase, html: `<nav><ul>${cards}</ul></nav><main><ul>${cards}</ul></main>` })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.diagnostics.repeatedStructureCount).toBeGreaterThanOrEqual(3)
    expect(result.observations.length).toBeGreaterThanOrEqual(3)
    expect(result.observations.every(item => item.extractionMode === 'repeated_structure')).toBe(true)
  })

  it('uses a single deterministic fallback when no semantic or repeated units exist', () => {
    const result = extractUnits({ ...inputBase, html: `<main><h1>普通页面</h1><p>${LONG}</p></main>` })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.diagnostics.fallbackUsed).toBe(true)
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]!.extractionMode).toBe('main_content_fallback')
  })

  it('fails closed on oversized input and returns empty for empty content', () => {
    expect(extractUnits({ ...inputBase, html: 'x'.repeat(100), limits: { maxInputBytes: 10 } }).status).toBe('extraction_failed')
    expect(extractUnits({ ...inputBase, html: '<html><body></body></html>' }).status).toBe('extraction_empty')
    expect(extractUnits({ ...inputBase, html: '<main><h1>只有标题</h1></main>' }).status).toBe('extraction_empty')
  })

  it('fallback 优先选择常见主内容容器，不把侧栏并入正文', () => {
    const result = extractUnits({
      ...inputBase,
      html: '<html><body><div id="content"><h1>主内容</h1><p>这是足够长的主内容正文，用于验证 fallback 会优先选择内容容器并排除页面噪声。</p></div><aside><p>这是推荐卡片中的额外内容，不应被主内容 fallback 选中。</p></aside></body></html>',
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.diagnostics.fallbackUsed).toBe(true)
    expect(result.evidenceBlobs.some(blob => blob.text.includes('推荐卡片'))).toBe(false)
  })

  it('is deterministic for identical input', () => {
    const input = { ...inputBase, html: `<article><h1>标题</h1><p>${LONG}</p></article>` }
    expect(extractUnits(input)).toEqual(extractUnits(input))
  })
})
