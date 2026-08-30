import { describe, expect, it } from 'vitest'
import { deleteUnitObservations, emptyUnitLedger, mergeCanonicalUnits, resolveCanonicalId, upsertUnitMaterialization } from '../src/ledger'
import { stableContentFingerprint, type UnitObservation } from '../src/model'

function materialization(overrides: Partial<UnitObservation> = {}) {
  const text = '一段可独立阅读且足够长的正文，用于验证 Ledger 的幂等写入和删除可达性。'
  const observation: UnitObservation = {
    id: 'uobs-a', canonicalUnitId: 'unit-a', captureExtent: 'full', observedAt: '2026-08-30T00:00:00.000Z', sessionId: 's1', pageInstanceId: 'p1', extractionMode: 'semantic', confidence: 0.9, rawFingerprint: 'sha256:raw-a', stableContentFingerprint: stableContentFingerprint(text), normalizerVersion: 'stable-content-v1', evidenceBlocks: [{ id: 'block-a', unitObservationId: 'uobs-a', evidenceBlobId: 'sha256:text-a', textHash: 'sha256:text-a', stateVersion: 1, ordinal: 0 }], ...overrides,
  }
  return {
    observations: [observation],
    sourceLinks: [{ unitObservationId: observation.id, sourceObservationId: 'capture-a', linkedAt: observation.observedAt }],
    canonicalUnits: [{ id: 'unit-a', identityKey: { kind: 'permalink' as const, url: 'https://example.com/a' }, createdAt: observation.observedAt }],
    derivedMetadata: [{ canonicalUnitId: 'unit-a', parserVersion: 'unit-extractor-v1', type: 'article' as const }],
    evidenceBlocks: observation.evidenceBlocks,
    evidenceBlobs: [{ id: 'sha256:text-a', text, textHash: 'sha256:text-a' }],
  }
}

describe('Session Unit Ledger', () => {
  it('重复 upsert 只增加一次 Observation，并保持 source link 幂等', () => {
    const first = materialization()
    const a = upsertUnitMaterialization(emptyUnitLedger(), first)
    expect(a.status).toBe('ok')
    if (a.status !== 'ok') return
    const b = upsertUnitMaterialization(a.state, first)
    expect(b.status).toBe('ok')
    if (b.status !== 'ok') return
    expect(b.addedObservationIds).toEqual([])
    expect(b.addedSourceLinkCount).toBe(0)
    expect(b.state.observations).toHaveLength(1)
    expect(b.state.versions).toHaveLength(1)
  })

  it('拒绝同一 Observation ID 的事实改写', () => {
    const first = materialization()
    const a = upsertUnitMaterialization(emptyUnitLedger(), first)
    if (a.status !== 'ok') throw new Error('fixture')
    const conflict = upsertUnitMaterialization(a.state, materialization({ rawFingerprint: 'sha256:changed' }))
    expect(conflict).toMatchObject({ status: 'conflict', reason: 'immutable_observation_changed' })
  })

  it('merge 指向较早对象，resolve 收敛且幂等', () => {
    const a = upsertUnitMaterialization(emptyUnitLedger(), materialization())
    if (a.status !== 'ok') throw new Error('fixture')
    const second = materialization({
      id: 'uobs-b',
      canonicalUnitId: 'unit-b',
      observedAt: '2026-08-31T00:00:00.000Z',
      evidenceBlocks: [{ ...materialization().evidenceBlocks[0]!, id: 'block-b', unitObservationId: 'uobs-b' }],
    })
    const b = upsertUnitMaterialization(a.state, {
      ...second,
      canonicalUnits: [{ id: 'unit-b', identityKey: { kind: 'anchor', origin: 'https://example.com', canonicalPageUrl: 'https://example.com/b', stableAnchor: 'b' } as const, createdAt: '2026-08-31T00:00:00.000Z' }],
    })
    if (b.status !== 'ok') throw new Error('fixture')
    const merged = mergeCanonicalUnits(b.state, 'unit-a', 'unit-b')
    expect(merged).not.toBeNull()
    expect(resolveCanonicalId(merged!, 'unit-b')).toBe('unit-a')
    expect(mergeCanonicalUnits(merged!, 'unit-a', 'unit-b')).toEqual(merged)
  })

  it('删除最后一个 Observation 时按可达性回收 block/blob/version/unit', () => {
    const a = upsertUnitMaterialization(emptyUnitLedger(), materialization())
    if (a.status !== 'ok') throw new Error('fixture')
    const deleted = deleteUnitObservations(a.state, ['uobs-a'])
    expect(deleted.observations).toHaveLength(0)
    expect(deleted.evidenceBlocks).toHaveLength(0)
    expect(deleted.evidenceBlobs).toHaveLength(0)
    expect(deleted.versions).toHaveLength(0)
    expect(deleted.canonicalUnits).toHaveLength(0)
  })
})
