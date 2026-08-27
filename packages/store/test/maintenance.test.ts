// 维护性删除测试（P0_DEMO_SCOPE §6 门 14）：session 分区删除 + blob 引用计数 GC +
// 幂等 + host 句柄占用时诚实 store_busy（不伪造成功）。
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ObservationEnvelope } from '@sift/shared'
import { CAPTURE_VERSION, REDACTION_POLICY } from '@sift/shared/wire'
import { openSiftStore, SiftStoreError, type SiftFsStore } from '../src/fs-store'
import { deleteAllData, deleteSessionData } from '../src/maintenance'

function sha256Of(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function envelopeOf(over: Partial<ObservationEnvelope>): ObservationEnvelope {
  const hash = sha256Of(new TextEncoder().encode(`placeholder-${over.id ?? 'x'}`))
  return {
    schemaVersion: 1,
    id: 'obs-1',
    sessionId: 'sess-1',
    tabId: 'tab-1',
    pageInstanceId: 'page-a',
    contentEpoch: 0,
    sequence: 0,
    receivedAt: '2026-08-27T00:00:00.000Z',
    url: 'https://example.com/article',
    source: 'extension',
    type: 'dom_snapshot',
    payloadRef: hash,
    payloadHash: hash,
    redactionPolicy: REDACTION_POLICY,
    captureVersion: CAPTURE_VERSION,
    ...over,
  }
}

function grantedPayload(origin: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1, kind: 'authorization_granted', captureVersion: CAPTURE_VERSION,
    url: `${origin}/`, reason: 'user_gesture', origin,
  }))
}

function domPayload(html: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1, kind: 'dom_snapshot', captureVersion: CAPTURE_VERSION,
    reason: 'initial_readable', url: 'https://example.com/a', title: 'T', contentEpoch: 0,
    html, stats: { nodeCount: 3, maxDepth: 3, htmlUtf8Bytes: html.length },
  }))
}

async function append(store: SiftFsStore, envelope: Partial<ObservationEnvelope>, payload: Uint8Array): Promise<void> {
  const hash = sha256Of(payload)
  await store.appendObservation(
    envelopeOf({ payloadRef: hash, payloadHash: hash, ...envelope }),
    payload,
  )
}

/** 标准两 session 布局：sess-1(page-a) 与 sess-2(page-b)。 */
const A_SNAP_HTML = '<main><p>page-a 独有快照正文，长度足够通过校验。</p></main>'

let root: string
let writer: SiftFsStore | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sift-maint-'))
})

afterEach(async () => {
  await writer?.close()
  writer = null
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
})

async function seed(): Promise<void> {
  writer = await openSiftStore({ rootDir: root })
  const aGrant = grantedPayload('https://aaa.example')
  const bGrant = grantedPayload('https://bbb.example')
  const aSnap = domPayload(A_SNAP_HTML)
  const bSnap = domPayload('<main><p>page-b 独有快照正文，长度足够通过校验。</p></main>')

  await append(writer, { id: 'a-0', sessionId: 'sess-1', pageInstanceId: 'page-a', sequence: 0, type: 'authorization_granted' }, aGrant)
  await append(writer, { id: 'a-1', sessionId: 'sess-1', pageInstanceId: 'page-a', sequence: 1 }, aSnap)
  await append(writer, { id: 'b-0', sessionId: 'sess-2', pageInstanceId: 'page-b', sequence: 0, type: 'authorization_granted' }, bGrant)
  await append(writer, { id: 'b-1', sessionId: 'sess-2', pageInstanceId: 'page-b', sequence: 1 }, bSnap)
  await append(writer, { id: 'b-2', sessionId: 'sess-2', pageInstanceId: 'page-b', sequence: 2, contentEpoch: 1 }, aSnap)
  // ^ b-2 复用 page-a 的快照字节（相同 payload → 相同 hash → blob 复用）：删 sess-1 后该 blob 仍被 sess-2 引用
}

describe('deleteSessionData', () => {
  it('删除 session：journal 分区重写 + page-state 清理 + blob 引用计数 GC（共享 blob 保留）', async () => {
    await seed()
    await writer!.close()
    writer = null

    const report = await deleteSessionData(root, 'sess-1')
    expect(report.removedObservations).toBe(2)
    expect(report.removedPages).toBe(1)
    expect(report.removedBlobs).toBe(1) // 只有 sess-1 的 granted blob 归零

    // journal 只剩 sess-2
    const text = await readFile(join(root, 'observations.jsonl'), 'utf8')
    const rows = text.split('\n').filter(l => l !== '').map(l => JSON.parse(l) as { sessionId: string })
    expect(rows).toHaveLength(3)
    expect(rows.every(r => r.sessionId === 'sess-2')).toBe(true)

    // page-states：page-a 删除、page-b 保留
    const states = await readdir(join(root, 'page-states'))
    expect(states.filter(n => n.endsWith('.json'))).toEqual(['page-b.json'])

    // blob：a-grant 删除；a 快照 blob 因 sess-2 引用而保留；b 的全部保留
    const blobs = new Set<string>()
    for (const shard of await readdir(join(root, 'blobs'))) {
      for (const name of await readdir(join(root, 'blobs', shard))) blobs.add(name)
    }
    expect(blobs.size).toBe(3) // b-grant + b-snap + a-snap(被 b-2 引用)

    // 删除后 readOnly 打开健康：只剩 sess-2/page-b
    const reader = await openSiftStore({ rootDir: root, readOnly: true })
    try {
      expect((await reader.listSessions()).map(s => s.sessionId)).toEqual(['sess-2'])
      expect((await reader.listPages()).map(p => p.pageInstanceId)).toEqual(['page-b'])
    } finally {
      await reader.close()
    }
  })

  it('幂等：对同一 session 删两次，第二次是空操作', async () => {
    await seed()
    await writer!.close()
    writer = null
    await deleteSessionData(root, 'sess-1')
    const again = await deleteSessionData(root, 'sess-1')
    expect(again).toEqual({ removedObservations: 0, removedPages: 0, removedBlobs: 0 })
  })

  it('host 持有 journal 句柄 → 诚实 store_busy，journal 字节不被破坏', async () => {
    await seed()
    const before = await readFile(join(root, 'observations.jsonl'), 'utf8')
    let busy: unknown
    try {
      await deleteSessionData(root, 'sess-1')
    } catch (error) {
      busy = error
    }
    expect(busy).toBeInstanceOf(SiftStoreError)
    expect((busy as SiftStoreError).siftStoreError).toBe('storage_error')
    expect((busy as SiftStoreError).message).toContain('store_busy')

    const after = await readFile(join(root, 'observations.jsonl'), 'utf8')
    expect(after).toBe(before) // 失败不留半文件
  })
})

async function pathExists(path: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises')
  return stat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? false : Promise.reject(error))
}

describe('deleteAllData', () => {
  it('清空 store 内容与可选 answers 目录；根目录保留、子目录整体移除', async () => {
    await seed()
    await writer!.close()
    writer = null
    const answersDir = join(root, '..', 'sift-answers-test')
    const { mkdir, writeFile: wf } = await import('node:fs/promises')
    await mkdir(answersDir, { recursive: true })
    await wf(join(answersDir, 'answer-x.json'), '{}', 'utf8')

    await deleteAllData(root, { answersDir })

    // rm(recursive) 把子目录整体删除（下次写者打开时重建）——只断言根目录仍在、内容全无
    expect(await pathExists(root)).toBe(true)
    expect(await pathExists(join(root, 'observations.jsonl'))).toBe(false)
    expect(await pathExists(join(root, 'meta.json'))).toBe(false)
    expect(await pathExists(join(root, 'blobs'))).toBe(false)
    expect(await pathExists(join(root, 'page-states'))).toBe(false)
    expect(await pathExists(answersDir)).toBe(false)
    await rm(answersDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('写者句柄占用 → store_busy', async () => {
    await seed()
    const handle = await open(join(root, 'observations.jsonl'), 'a')
    try {
      let busy: unknown
      try {
        await deleteAllData(root)
      } catch (error) {
        busy = error
      }
      expect(busy).toBeInstanceOf(SiftStoreError)
      expect((busy as SiftStoreError).message).toContain('store_busy')
    } finally {
      await handle.close()
    }
  })
})
