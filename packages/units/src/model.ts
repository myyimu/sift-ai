// P0.5 内容身份模型：事实（UnitObservation/Evidence）与解释（DerivedMetadata）分离。
// 本文件只提供确定性类型、指纹和版本物化，不执行网络、LLM 或站点逻辑。
import { createHash } from 'node:crypto'

export const UNIT_EXTRACTOR_VERSION = 'unit-extractor-v1.1'
export const UNIT_NORMALIZER_VERSION = 'stable-content-v1'

export type CaptureExtent = 'partial' | 'full' | 'unknown'
export type UnitType = 'article' | 'content' | 'comment' | 'unknown'
export type ExtractionMode = 'semantic' | 'repeated_structure' | 'main_content_fallback'

export type IdentityKey =
  | { readonly kind: 'permalink'; readonly url: string }
  | { readonly kind: 'anchor'; readonly origin: string; readonly canonicalPageUrl: string; readonly stableAnchor: string }
  | { readonly kind: 'unkeyed' }

export interface SourceMetadataSnapshot {
  readonly title?: string
  readonly author?: string
  readonly publishedAt?: string
}

export interface EvidenceBlob {
  readonly id: string
  readonly text: string
  readonly textHash: string
}

export interface EvidenceBlock {
  readonly id: string
  readonly unitObservationId: string
  readonly evidenceBlobId: string
  readonly textHash: string
  readonly stateVersion: number
  readonly ordinal: number
}

export interface UnitObservation {
  readonly id: string
  readonly canonicalUnitId: string
  readonly captureExtent: CaptureExtent
  readonly observedAt: string
  readonly sessionId: string
  readonly pageInstanceId: string
  readonly extractionMode: ExtractionMode
  readonly confidence: number
  readonly rawFingerprint: string
  readonly stableContentFingerprint: string
  readonly normalizerVersion: string
  readonly volatileMetadata?: Readonly<Record<string, unknown>>
  readonly sourceMetadata?: SourceMetadataSnapshot
  readonly evidenceBlocks: readonly EvidenceBlock[]
}

export interface UnitObservationSourceLink {
  readonly unitObservationId: string
  readonly sourceObservationId: string
  readonly linkedAt: string
}

export interface CanonicalUnit {
  readonly id: string
  readonly identityKey: IdentityKey
  readonly createdAt: string
  readonly mergedInto?: string
  readonly url?: string
}

export interface UnitVersion {
  readonly id: string
  readonly canonicalUnitId: string
  readonly stableContentFingerprint: string
  readonly normalizerVersion: string
}

export interface UnitVersionObservationLink {
  readonly unitVersionId: string
  readonly unitObservationId: string
  readonly relation: 'supports_full' | 'pins_partial'
  readonly linkedAt: string
}

export interface UnitVersionEvidenceLink {
  readonly unitVersionId: string
  readonly evidenceBlockId: string
}

export interface DerivedMetadata {
  readonly canonicalUnitId: string
  readonly parserVersion: string
  readonly type: UnitType
}

export interface UnitMaterialization {
  readonly canonicalUnits: readonly CanonicalUnit[]
  readonly versions: readonly UnitVersion[]
  readonly versionObservationLinks: readonly UnitVersionObservationLink[]
  readonly versionEvidenceLinks: readonly UnitVersionEvidenceLink[]
}

export function sha256Of(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

/** 稳定正文归一：不做摘要/翻译；去除已知易变计数、相对时间和编辑标记。 */
export function normalizeStableContent(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\b\d[\d,]*(?:\.\d+)?\s*(?:likes?|赞|点赞|replies?|回复|views?|浏览|在线|online)\b/gi, '[volatile]')
    .replace(/\b(?:just now|\d+\s*(?:seconds?|minutes?|hours?|days?)\s*ago)\b/gi, '[volatile]')
    .replace(/\b\d+\s*(?:秒|分钟|小时|天)前\b/g, '[volatile]')
    .replace(/\b(?:edited|已编辑|编辑于)\b/gi, '[volatile]')
    .replace(/\s+/g, ' ')
    .trim()
}

export function stableContentFingerprint(text: string): string {
  return sha256Of(normalizeStableContent(text))
}

function identityKeyString(key: IdentityKey): string {
  switch (key.kind) {
    case 'permalink': return `permalink|${key.url}`
    case 'anchor': return `anchor|${key.origin}|${key.canonicalPageUrl}|${key.stableAnchor}`
    case 'unkeyed': return 'unkeyed'
  }
}

/** ID 是内容寻址的不透明字符串；unkeyed 的 occurrence 仅用于同页同文本的安全区分。 */
export function canonicalUnitIdFor(key: IdentityKey, occurrenceDiscriminator = ''): string {
  return `unit-${sha256Of(`${identityKeyString(key)}|${occurrenceDiscriminator}`).slice('sha256:'.length, 24)}`
}

export function unitObservationIdFor(sourceObservationId: string, canonicalUnitId: string, rawFingerprint: string): string {
  return `uobs-${sha256Of(`${sourceObservationId}|${canonicalUnitId}|${rawFingerprint}`).slice('sha256:'.length, 24)}`
}

export function evidenceBlockIdFor(unitObservationId: string, textHash: string, ordinal: number): string {
  return `ueb-${sha256Of(`${unitObservationId}|${textHash}|${ordinal}`).slice('sha256:'.length, 24)}`
}

export function unitVersionIdFor(canonicalUnitId: string, normalizerVersion: string, fingerprint: string): string {
  return `uver-${sha256Of(`${canonicalUnitId}|${normalizerVersion}|${fingerprint}`).slice('sha256:'.length, 24)}`
}

/**
 * 物化版本只接受 full Observation。unknown/partial 不产生版本；同一 fingerprint
 * 在同一 CanonicalUnit 命名空间内复用，revert 会重新引用旧版本。
 */
export function materializeUnitVersions(
  observations: readonly UnitObservation[],
  canonicalUnits: readonly CanonicalUnit[],
): UnitMaterialization {
  const versions = new Map<string, UnitVersion>()
  const versionObservationLinks: UnitVersionObservationLink[] = []
  const versionEvidenceLinks: UnitVersionEvidenceLink[] = []
  const byCanonical = new Map(canonicalUnits.map(unit => [unit.id, unit]))

  for (const observation of observations) {
    if (observation.captureExtent !== 'full') continue
    if (!byCanonical.has(observation.canonicalUnitId)) continue
    const id = unitVersionIdFor(observation.canonicalUnitId, observation.normalizerVersion, observation.stableContentFingerprint)
    if (!versions.has(id)) {
      versions.set(id, {
        id,
        canonicalUnitId: observation.canonicalUnitId,
        stableContentFingerprint: observation.stableContentFingerprint,
        normalizerVersion: observation.normalizerVersion,
      })
    }
    versionObservationLinks.push({ unitVersionId: id, unitObservationId: observation.id, relation: 'supports_full', linkedAt: observation.observedAt })
    for (const block of observation.evidenceBlocks) versionEvidenceLinks.push({ unitVersionId: id, evidenceBlockId: block.id })
  }

  return {
    canonicalUnits: [...canonicalUnits].sort((a, b) => a.id.localeCompare(b.id)),
    versions: [...versions.values()].sort((a, b) => a.id.localeCompare(b.id)),
    versionObservationLinks: versionObservationLinks.sort((a, b) => `${a.unitVersionId}|${a.unitObservationId}`.localeCompare(`${b.unitVersionId}|${b.unitObservationId}`)),
    versionEvidenceLinks: versionEvidenceLinks.sort((a, b) => `${a.unitVersionId}|${a.evidenceBlockId}`.localeCompare(`${b.unitVersionId}|${b.evidenceBlockId}`)),
  }
}
