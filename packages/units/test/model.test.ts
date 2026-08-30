import { describe, expect, it } from 'vitest'
import {
  canonicalUnitIdFor,
  materializeUnitVersions,
  stableContentFingerprint,
  type CanonicalUnit,
  type UnitObservation,
} from '../src/model'

function observation(overrides: Partial<UnitObservation> = {}): UnitObservation {
  const text = '一段足够长的稳定正文，用于验证内容身份和版本物化规则。'
  return {
    id: 'uobs-1',
    canonicalUnitId: 'unit-1',
    captureExtent: 'full',
    observedAt: '2026-08-30T00:00:00.000Z',
    sessionId: 'session-1',
    pageInstanceId: 'page-1',
    extractionMode: 'semantic',
    confidence: 0.95,
    rawFingerprint: 'sha256:raw',
    stableContentFingerprint: stableContentFingerprint(text),
    normalizerVersion: 'stable-content-v1',
    evidenceBlocks: [{ id: 'ueb-1', unitObservationId: 'uobs-1', evidenceBlobId: 'sha256:text', textHash: 'sha256:text', stateVersion: 1, ordinal: 0 }],
    ...overrides,
  }
}

const canonical: CanonicalUnit = { id: 'unit-1', identityKey: { kind: 'permalink', url: 'https://example.com/post/1' }, createdAt: '2026-08-30T00:00:00.000Z' }

describe('content identity and version materialization', () => {
  it('keeps permalink identity stable but separates unkeyed occurrences', () => {
    expect(canonicalUnitIdFor({ kind: 'permalink', url: 'https://example.com/post/1' })).toBe(canonicalUnitIdFor({ kind: 'permalink', url: 'https://example.com/post/1' }))
    expect(canonicalUnitIdFor({ kind: 'unkeyed' }, 'occurrence-a')).not.toBe(canonicalUnitIdFor({ kind: 'unkeyed' }, 'occurrence-b'))
  })

  it('only creates versions for full observations and reuses fingerprints on revert', () => {
    const first = observation()
    const partial = observation({ id: 'uobs-2', captureExtent: 'partial', stableContentFingerprint: 'sha256:partial' })
    const changed = observation({ id: 'uobs-3', stableContentFingerprint: stableContentFingerprint('一段完全不同的正文内容，用于验证新版本。'), evidenceBlocks: [{ ...first.evidenceBlocks[0]!, id: 'ueb-3', unitObservationId: 'uobs-3' }] })
    const reverted = observation({ id: 'uobs-4', observedAt: '2026-08-31T00:00:00.000Z' })
    const result = materializeUnitVersions([first, partial, changed, reverted], [canonical])
    expect(result.versions).toHaveLength(2)
    expect(result.versionObservationLinks.map(link => link.relation)).toEqual(['supports_full', 'supports_full', 'supports_full'])
    expect(result.versionObservationLinks.some(link => link.unitObservationId === 'uobs-2')).toBe(false)
    expect(result.versionObservationLinks.filter(link => link.unitObservationId === 'uobs-1' || link.unitObservationId === 'uobs-4')).toHaveLength(2)
  })
})
