// P0.5 Stage B1：Session Unit Ledger / Global Unit Index 的纯函数物化层。
// 这里不负责文件 I/O；调用方可以把结果写入自己的单写者存储，保证 Raw Capture
// 热路径与 Unit materializer 解耦。所有 upsert/delete/merge 都是幂等且可重放的。
import {
  materializeUnitVersions,
  type CanonicalUnit,
  type DerivedMetadata,
  type EvidenceBlob,
  type EvidenceBlock,
  type UnitObservation,
  type UnitObservationSourceLink,
  type UnitVersion,
  type UnitVersionEvidenceLink,
  type UnitVersionObservationLink,
} from './model'

export interface UnitLedgerState {
  readonly observations: readonly UnitObservation[]
  readonly sourceLinks: readonly UnitObservationSourceLink[]
  readonly canonicalUnits: readonly CanonicalUnit[]
  readonly derivedMetadata: readonly DerivedMetadata[]
  readonly evidenceBlocks: readonly EvidenceBlock[]
  readonly evidenceBlobs: readonly EvidenceBlob[]
  readonly versions: readonly UnitVersion[]
  readonly versionObservationLinks: readonly UnitVersionObservationLink[]
  readonly versionEvidenceLinks: readonly UnitVersionEvidenceLink[]
}

export type LedgerUpsertResult =
  | { readonly status: 'ok'; readonly state: UnitLedgerState; readonly addedObservationIds: readonly string[]; readonly addedSourceLinkCount: number }
  | { readonly status: 'conflict'; readonly observationId: string; readonly reason: 'immutable_observation_changed' | 'evidence_changed' }

export function emptyUnitLedger(): UnitLedgerState {
  return { observations: [], sourceLinks: [], canonicalUnits: [], derivedMetadata: [], evidenceBlocks: [], evidenceBlobs: [], versions: [], versionObservationLinks: [], versionEvidenceLinks: [] }
}

function sortState(state: Omit<UnitLedgerState, 'versions' | 'versionObservationLinks' | 'versionEvidenceLinks'>): UnitLedgerState {
  const observations = [...state.observations].sort((a, b) => a.id.localeCompare(b.id))
  const canonicalUnits = [...state.canonicalUnits].sort((a, b) => a.id.localeCompare(b.id))
  const evidenceBlocks = [...state.evidenceBlocks].sort((a, b) => a.id.localeCompare(b.id))
  const sourceLinks = [...state.sourceLinks].sort((a, b) => `${a.unitObservationId}|${a.sourceObservationId}`.localeCompare(`${b.unitObservationId}|${b.sourceObservationId}`))
  const derivedMetadata = [...state.derivedMetadata].sort((a, b) => `${a.canonicalUnitId}|${a.parserVersion}`.localeCompare(`${b.canonicalUnitId}|${b.parserVersion}`))
  const evidenceBlobs = [...state.evidenceBlobs].sort((a, b) => a.id.localeCompare(b.id))
  const materialization = materializeUnitVersions(observations, canonicalUnits)
  return {
    observations, canonicalUnits, evidenceBlocks, sourceLinks, derivedMetadata, evidenceBlobs,
    versions: materialization.versions,
    versionObservationLinks: materialization.versionObservationLinks,
    versionEvidenceLinks: materialization.versionEvidenceLinks,
  }
}

function observationEqual(a: UnitObservation, b: UnitObservation): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function upsertUnitMaterialization(
  state: UnitLedgerState,
  materialization: Pick<UnitLedgerState, 'observations' | 'sourceLinks' | 'canonicalUnits' | 'derivedMetadata' | 'evidenceBlocks' | 'evidenceBlobs'>,
): LedgerUpsertResult {
  const observations = new Map(state.observations.map(item => [item.id, item]))
  for (const item of materialization.observations) {
    const existing = observations.get(item.id)
    if (existing !== undefined && !observationEqual(existing, item)) return { status: 'conflict', observationId: item.id, reason: 'immutable_observation_changed' }
    observations.set(item.id, item)
  }
  const evidenceBlocks = new Map(state.evidenceBlocks.map(item => [item.id, item]))
  for (const item of materialization.evidenceBlocks) {
    const existing = evidenceBlocks.get(item.id)
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(item)) return { status: 'conflict', observationId: item.unitObservationId, reason: 'evidence_changed' }
    evidenceBlocks.set(item.id, item)
  }
  const canonicalUnits = new Map(state.canonicalUnits.map(item => [item.id, item]))
  for (const item of materialization.canonicalUnits) if (!canonicalUnits.has(item.id)) canonicalUnits.set(item.id, item)
  const sourceLinks = new Map(state.sourceLinks.map(item => [`${item.unitObservationId}|${item.sourceObservationId}`, item]))
  for (const item of materialization.sourceLinks) sourceLinks.set(`${item.unitObservationId}|${item.sourceObservationId}`, item)
  const metadata = new Map(state.derivedMetadata.map(item => [`${item.canonicalUnitId}|${item.parserVersion}|${item.type}`, item]))
  for (const item of materialization.derivedMetadata) metadata.set(`${item.canonicalUnitId}|${item.parserVersion}|${item.type}`, item)
  const blobs = new Map(state.evidenceBlobs.map(item => [item.id, item]))
  for (const item of materialization.evidenceBlobs) if (!blobs.has(item.id)) blobs.set(item.id, item)
  const next = sortState({ observations: [...observations.values()], sourceLinks: [...sourceLinks.values()], canonicalUnits: [...canonicalUnits.values()], derivedMetadata: [...metadata.values()], evidenceBlocks: [...evidenceBlocks.values()], evidenceBlobs: [...blobs.values()] })
  const addedObservationIds = materialization.observations.filter(item => !state.observations.some(existing => existing.id === item.id)).map(item => item.id)
  const addedSourceLinkCount = materialization.sourceLinks.filter(item => !state.sourceLinks.some(existing => existing.unitObservationId === item.unitObservationId && existing.sourceObservationId === item.sourceObservationId)).length
  return { status: 'ok', state: next, addedObservationIds, addedSourceLinkCount }
}

export function resolveCanonicalId(state: UnitLedgerState, id: string): string | null {
  const byId = new Map(state.canonicalUnits.map(unit => [unit.id, unit]))
  let current = id
  const visited = new Set<string>()
  while (true) {
    if (visited.has(current)) return null
    visited.add(current)
    const unit = byId.get(current)
    if (unit === undefined) return null
    if (unit.mergedInto === undefined) return current
    current = unit.mergedInto
  }
}

/** 合并总是指向更早创建的 CanonicalUnit，且拒绝未知对象/环。 */
export function mergeCanonicalUnits(state: UnitLedgerState, firstId: string, secondId: string): UnitLedgerState | null {
  const first = state.canonicalUnits.find(unit => unit.id === firstId)
  const second = state.canonicalUnits.find(unit => unit.id === secondId)
  if (first === undefined || second === undefined) return null
  const firstRoot = resolveCanonicalId(state, first.id)
  const secondRoot = resolveCanonicalId(state, second.id)
  if (firstRoot === null || secondRoot === null) return null
  if (firstRoot === secondRoot) return state
  const older = (state.canonicalUnits.find(unit => unit.id === firstRoot)!.createdAt <= state.canonicalUnits.find(unit => unit.id === secondRoot)!.createdAt) ? firstRoot : secondRoot
  const newer = older === firstRoot ? secondRoot : firstRoot
  const canonicalUnits = state.canonicalUnits.map(unit => unit.id === newer ? { ...unit, mergedInto: older } : unit)
  return sortState({ ...state, canonicalUnits, observations: state.observations.map(observation => observation) })
}

/** 删除只接受 observation ids；其余对象按可达性回收，不做 page 级 cascade 假设。 */
export function deleteUnitObservations(state: UnitLedgerState, observationIds: readonly string[]): UnitLedgerState {
  const removed = new Set(observationIds)
  const observations = state.observations.filter(item => !removed.has(item.id))
  const evidenceBlocks = state.evidenceBlocks.filter(item => !removed.has(item.unitObservationId))
  const liveCanonical = new Set(observations.map(item => item.canonicalUnitId))
  const canonicalUnits = state.canonicalUnits.filter(item => liveCanonical.has(item.id))
  const sourceLinks = state.sourceLinks.filter(item => !removed.has(item.unitObservationId))
  const liveBlobIds = new Set(evidenceBlocks.map(item => item.evidenceBlobId))
  const evidenceBlobs = state.evidenceBlobs.filter(item => liveBlobIds.has(item.id))
  const derivedMetadata = state.derivedMetadata.filter(item => liveCanonical.has(item.canonicalUnitId))
  return sortState({ observations, sourceLinks, canonicalUnits, derivedMetadata, evidenceBlocks, evidenceBlobs })
}

export function observationsForSession(state: UnitLedgerState, sessionId: string): readonly UnitObservation[] {
  return state.observations.filter(item => item.sessionId === sessionId).sort((a, b) => `${a.observedAt}|${a.id}`.localeCompare(`${b.observedAt}|${b.id}`))
}
