// 维护性删除（P0_DEMO_SCOPE §6 门 14：用户可删除当前 Page/Session 的本地数据；
// AnswerProjection 等派生物可删除可重建）。
//
// 与 ADR-003 的关系：host 是唯一**捕获**写者；本模块是桌面 UI 侧的维护入口
// （对应 E-04 原设计中"桌面 UI 启动 reconciliation"的维护职责）。删除只在
// host 无打开句柄时可行——Windows 对被占用文件的 rename/unlink 自然失败，
// 我们把它映射为诚实的 store_busy 错误（不伪造成功，也不强抢）。
//
// 删除语义：journal 按 session 分区重写（tmp + 原子 rename）；page-state 只删
// 不再被任何幸存行引用的 pid；blob 只删引用归零的 hash（journal 是引用的
// 事实来源——page-state 的 snapshotBlobRef 恒等于某行 dom_snapshot 的 hash）。
import { readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ObservationEnvelope } from '@sift/shared'
import { openSiftStore, SiftStoreError } from './fs-store'

export interface SessionDeleteReport {
  readonly removedObservations: number
  readonly removedPages: number
  readonly removedBlobs: number
}

/** pid/hash 进路径前的防御性形状校验（敌对输入纪律：journal 理论上可信，仍不放松）。 */
const PID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

function isLockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

function busy(what: string): SiftStoreError {
  return new SiftStoreError('storage_error', `store_busy: ${what} 被 Windows 拒绝——host 可能正持有句柄；关闭已授权页面/断开扩展后重试`)
}

function hexOf(hash: string): string {
  return hash.slice('sha256:'.length)
}

/**
 * 删除一个 session 的全部观察数据。session 不存在 → 幂等空操作（不报错）。
 * store_corrupt 会原样抛出（删除不以牺牲完整性检查为代价）。
 */
export async function deleteSessionData(rootDir: string, sessionId: string): Promise<SessionDeleteReport> {
  const store = await openSiftStore({ rootDir, readOnly: true })
  let rows: readonly ObservationEnvelope[]
  try {
    rows = await store.readJournal()
  } finally {
    await store.close()
  }

  const removed = rows.filter(r => r.sessionId === sessionId)
  if (removed.length === 0) {
    return { removedObservations: 0, removedPages: 0, removedBlobs: 0 }
  }
  const keep = rows.filter(r => r.sessionId !== sessionId)

  // 1) journal 重写：tmp + 原子 rename（被 host 句柄占用 → store_busy）
  const journalPath = join(rootDir, 'observations.jsonl')
  const tmpPath = join(rootDir, '.observations.jsonl.maint-tmp')
  const rewritten = keep.map(row => JSON.stringify(row)).join('\n')
  const journalBytes = rewritten === '' ? '' : `${rewritten}\n`
  try {
    await writeFile(tmpPath, journalBytes, 'utf8')
    await rename(tmpPath, journalPath)
  } catch (error) {
    if (isLockError(error)) throw busy('journal 重写')
    throw error
  }

  // 2) page-states：只删幸存行不再引用的 pid
  const survivingPids = new Set(keep.map(r => r.pageInstanceId))
  const doomedPids = new Set(removed.map(r => r.pageInstanceId).filter(pid => !survivingPids.has(pid)))
  let removedPages = 0
  for (const pid of doomedPids) {
    if (!PID_PATTERN.test(pid)) continue
    for (const name of [`${pid}.json`, `.tmp-${pid}`]) {
      try {
        await unlink(join(rootDir, 'page-states', name))
        if (name.endsWith('.json')) removedPages += 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        if (isLockError(error)) throw busy(`page-state ${pid} 删除`)
        throw error
      }
    }
  }

  // 3) blob GC：引用归零的 hash
  const survivingHashes = new Set(keep.map(r => r.payloadHash))
  const doomedHashes = new Set(removed.map(r => r.payloadHash).filter(hash => !survivingHashes.has(hash)))
  let removedBlobs = 0
  for (const hash of doomedHashes) {
    if (!HASH_PATTERN.test(hash)) continue
    const hex = hexOf(hash)
    const blobPath = join(rootDir, 'blobs', hex.slice(0, 2), hex)
    try {
      await unlink(blobPath)
      removedBlobs += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      if (isLockError(error)) throw busy(`blob ${hash.slice(0, 16)}… 删除`)
      throw error
    }
  }
  // 空分片目录顺手回收：rmdir 只在目录为空时成功，非空（仍有幸存 blob）自动失败——
  // 刻意不用 rm(recursive)，防止误删幸存内容。
  for (const shard of await readdir(join(rootDir, 'blobs')).catch(() => [])) {
    await rmdir(join(rootDir, 'blobs', shard)).catch(() => undefined)
  }
  return { removedObservations: removed.length, removedPages, removedBlobs }
}

/**
 * 占用探测：Windows 的 unlink 带 POSIX 语义（FILE_SHARE_DELETE），host 持有句柄时
 * 直接 rm 仍会"成功"、留下写者写孤儿文件；而 rename 覆盖被占用文件会被诚实拒绝
 * （deleteSessionData 的 journal 重写正是靠这一点）。deleteAllData 在删除前先做一次
 * journal 重命名探测——反正马上要清空，探测本身就是清空的第一步。
 */
async function assertJournalNotLocked(rootDir: string): Promise<void> {
  const journalPath = join(rootDir, 'observations.jsonl')
  const tmpPath = join(rootDir, '.observations.jsonl.maint-tmp')
  try {
    await writeFile(tmpPath, '', 'utf8')
    await rename(tmpPath, journalPath)
  } catch (error) {
    if (isLockError(error)) throw busy('journal 占用探测')
    throw error
  }
}

/**
 * 删除 store 全部内容（journal/page-states/blobs/staging/meta + 维护临时文件），
 * 可选连带 answers 派生目录。根目录保留，子目录由下次写者打开时重建。
 * 同样只在 host 无句柄占用时成功（见 assertJournalNotLocked）。
 */
export async function deleteAllData(rootDir: string, options: { readonly answersDir?: string } = {}): Promise<void> {
  await assertJournalNotLocked(rootDir)
  const targets = ['.observations.jsonl.maint-tmp', 'observations.jsonl', 'meta.json', 'page-states', 'blobs', 'staging']
  for (const name of targets) {
    try {
      await rm(join(rootDir, name), { recursive: true, force: true })
    } catch (error) {
      if (isLockError(error)) throw busy(`${name} 删除`)
      throw error
    }
  }
  if (options.answersDir !== undefined) {
    try {
      await rm(options.answersDir, { recursive: true, force: true })
    } catch (error) {
      if (isLockError(error)) throw busy('answers 目录删除')
      throw error
    }
  }
}
