// Derived Ledger 的显式文件边界。Capture Store 仍由 native host 单写；该文件只由
// materializer 在完成一次纯函数重建后原子替换，损坏时 fail-closed，不回写 journal。
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { UnitLedgerState } from './ledger'
import { emptyUnitLedger } from './ledger'

export const UNIT_LEDGER_SCHEMA_VERSION = 1

export function unitLedgerPath(storeRoot: string): string {
  return join(resolve(storeRoot), 'derived', 'unit-ledger-v1.json')
}

export function sessionUnitLedgerPath(storeRoot: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error('sessionId 不适合作为派生文件名')
  return join(resolve(storeRoot), 'derived', 'sessions', sessionId, 'unit-ledger-v1.json')
}

function isArray(value: unknown): value is readonly unknown[] { return Array.isArray(value) }

export async function readUnitLedger(path: string): Promise<UnitLedgerState> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    if (parsed.schemaVersion !== UNIT_LEDGER_SCHEMA_VERSION || !isArray(parsed.observations) || !isArray(parsed.sourceLinks) || !isArray(parsed.canonicalUnits) || !isArray(parsed.derivedMetadata) || !isArray(parsed.evidenceBlocks) || !isArray(parsed.evidenceBlobs) || !isArray(parsed.versions) || !isArray(parsed.versionObservationLinks) || !isArray(parsed.versionEvidenceLinks)) throw new Error('ledger schema invalid')
    return { observations: parsed.observations as UnitLedgerState['observations'], sourceLinks: parsed.sourceLinks as UnitLedgerState['sourceLinks'], canonicalUnits: parsed.canonicalUnits as UnitLedgerState['canonicalUnits'], derivedMetadata: parsed.derivedMetadata as UnitLedgerState['derivedMetadata'], evidenceBlocks: parsed.evidenceBlocks as UnitLedgerState['evidenceBlocks'], evidenceBlobs: parsed.evidenceBlobs as UnitLedgerState['evidenceBlobs'], versions: parsed.versions as UnitLedgerState['versions'], versionObservationLinks: parsed.versionObservationLinks as UnitLedgerState['versionObservationLinks'], versionEvidenceLinks: parsed.versionEvidenceLinks as UnitLedgerState['versionEvidenceLinks'] }
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return emptyUnitLedger()
    throw new Error(`unit ledger 读取失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function writeUnitLedger(path: string, state: UnitLedgerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temp, `${JSON.stringify({ schemaVersion: UNIT_LEDGER_SCHEMA_VERSION, ...state }, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

/**
 * 删除已经不存在的 Session Ledger。只处理由本模块生成的安全目录名，
 * 不触碰 derived 下的其他派生缓存；调用方应在一次成功的全量重建后使用。
 */
export async function pruneSessionUnitLedgers(storeRoot: string, keepSessionIds: ReadonlySet<string>): Promise<void> {
  const sessionsDir = join(resolve(storeRoot), 'derived', 'sessions')
  let entries
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name) || keepSessionIds.has(entry.name)) continue
    await rm(join(sessionsDir, entry.name), { recursive: true, force: true })
  }
}
