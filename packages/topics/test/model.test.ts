import { describe, expect, it } from 'vitest'
import { computeTopicRelations, computeTopicStats, layoutTopicCloud, validateTopicProjection, type TopicProjection } from '../src/model'
import { emptyUnitLedger, upsertUnitMaterialization } from '@sift/units'

function ledger() {
  const base = {
    observations: [
      { id: 'obs-a', canonicalUnitId: 'unit-a', captureExtent: 'unknown' as const, observedAt: '2026-08-30T00:00:00.000Z', sessionId: 's1', pageInstanceId: 'page-1', extractionMode: 'semantic' as const, confidence: 0.9, rawFingerprint: 'sha256:a', stableContentFingerprint: 'sha256:a', normalizerVersion: 'stable-content-v1', evidenceBlocks: [{ id: 'block-a', unitObservationId: 'obs-a', evidenceBlobId: 'sha256:text-a', textHash: 'sha256:text-a', stateVersion: 1, ordinal: 0 }] },
      { id: 'obs-b', canonicalUnitId: 'unit-b', captureExtent: 'unknown' as const, observedAt: '2026-08-30T00:00:01.000Z', sessionId: 's1', pageInstanceId: 'page-2', extractionMode: 'semantic' as const, confidence: 0.9, rawFingerprint: 'sha256:b', stableContentFingerprint: 'sha256:b', normalizerVersion: 'stable-content-v1', evidenceBlocks: [{ id: 'block-b', unitObservationId: 'obs-b', evidenceBlobId: 'sha256:text-b', textHash: 'sha256:text-b', stateVersion: 1, ordinal: 0 }] },
    ],
    sourceLinks: [],
    canonicalUnits: [
      { id: 'unit-a', identityKey: { kind: 'permalink' as const, url: 'https://example.com/a' }, createdAt: '2026-08-30T00:00:00.000Z', url: 'https://example.com/a' },
      { id: 'unit-b', identityKey: { kind: 'permalink' as const, url: 'https://other.example/b' }, createdAt: '2026-08-30T00:00:00.000Z', url: 'https://other.example/b' },
    ],
    derivedMetadata: [],
    evidenceBlocks: [
      { id: 'block-a', unitObservationId: 'obs-a', evidenceBlobId: 'sha256:text-a', textHash: 'sha256:text-a', stateVersion: 1, ordinal: 0 },
      { id: 'block-b', unitObservationId: 'obs-b', evidenceBlobId: 'sha256:text-b', textHash: 'sha256:text-b', stateVersion: 1, ordinal: 0 },
    ],
    evidenceBlobs: [{ id: 'sha256:text-a', text: '证据 A', textHash: 'sha256:text-a' }, { id: 'sha256:text-b', text: '证据 B', textHash: 'sha256:text-b' }],
  }
  const result = upsertUnitMaterialization(emptyUnitLedger(), base)
  if (result.status !== 'ok') throw new Error(result.reason)
  return result.state
}

function projection(): TopicProjection {
  return {
    projectionId: 'projection-1', projectionVersion: 1, createdAt: '2026-08-30T01:00:00.000Z',
    scope: { from: '2026-08-29T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z', canonicalUnitRefs: ['unit-a', 'unit-b'], evidenceBlockRefs: ['block-a', 'block-b'] },
    analyzer: { provider: 'test', model: 'test', promptVersion: 'topic-v1' },
    topics: [
      { topicId: 'topic-a', label: '本地优先', aliases: [], summary: '讨论本地优先处理。', canonicalUnitRefs: ['unit-a', 'unit-b'], evidenceBlockRefs: ['block-a', 'block-b'] },
      { topicId: 'topic-b', label: '页面证据', aliases: [], summary: '讨论页面证据。', canonicalUnitRefs: ['unit-a'], evidenceBlockRefs: ['block-a'] },
    ],
  }
}

describe('TopicProjection validation and deterministic metrics', () => {
  it('accepts in-scope references and rejects dangling/mismatched evidence', () => {
    const state = ledger()
    const valid = validateTopicProjection(projection(), state, projection().scope)
    expect(valid.status).toBe('ok')
    const invalid = validateTopicProjection({ ...projection(), topics: [{ ...projection().topics[0]!, evidenceBlockRefs: ['block-b'], canonicalUnitRefs: ['unit-a'] }] }, state, projection().scope)
    expect(invalid.status).toBe('invalid')
  })

  it('拒绝使用旧 Prompt 版本的主题投影', () => {
    const state = ledger()
    const invalid = validateTopicProjection({ ...projection(), analyzer: { ...projection().analyzer, promptVersion: 'topic-v0' } }, state, projection().scope)
    expect(invalid.status).toBe('invalid')
  })

  it('counts distinct units, pages and domains; repeated refs do not inflate size', () => {
    const stats = computeTopicStats(projection(), ledger())
    expect(stats.find(item => item.topicId === 'topic-a')).toMatchObject({ unitCount: 2, pageCount: 2, domainCount: 2 })
    expect(stats.find(item => item.topicId === 'topic-b')?.unitCount).toBe(1)
  })

  it('统计只计算投影时间范围内的观察', () => {
    const current = ledger()
    const old = { ...current.observations[0]!, id: 'obs-old', pageInstanceId: 'page-old', observedAt: '2026-08-01T00:00:00.000Z', evidenceBlocks: [] }
    const state = { ...current, observations: [...current.observations, old] }
    const stats = computeTopicStats(projection(), state)
    expect(stats.find(item => item.topicId === 'topic-b')).toMatchObject({ unitCount: 1, pageCount: 1 })
  })

  it('computes explainable Jaccard relations and stable layout', () => {
    expect(computeTopicRelations(projection())).toEqual([{ fromTopicId: 'topic-a', toTopicId: 'topic-b', jaccardOverlap: 0.5 }])
    const stats = computeTopicStats(projection(), ledger())
    expect(layoutTopicCloud(stats, 800, 500)).toEqual(layoutTopicCloud(stats, 800, 500))
  })
})
