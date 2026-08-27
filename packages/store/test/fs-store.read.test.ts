// FS Store 读侧 API + readOnly 打开模式测试（Phase 3 步骤 1）：
//  - readOnly：断尾容忍且**文件字节不动**、中段坏行仍 store_corrupt、写抛错、
//    staging 孤儿不动、落后 page-state 不补写、与写者进程共存、root 不存在即拒；
//  - 读 API（两种模式）：listSessions/listPages/readJournal 过滤与形状、
//    readBlob 重验 hash、readSnapshotPayload 严校验。
// 语义边界：readOnly 打开是 journal 的内存快照——写者之后的追加不自动可见，
// 需重开读者（UI 轮询即重开，P0 接受）。
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ObservationEnvelope } from '@sift/shared'
import { CAPTURE_VERSION, REDACTION_POLICY } from '@sift/shared/wire'
import { openSiftStore, SiftStoreError, type SiftFsStore } from '../src/fs-store'

// —— 构造（与 fs-store.test.ts 同款） ——

function sha256Of(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function envelopeOf(over: Partial<ObservationEnvelope> = {}): ObservationEnvelope {
  return {
    schemaVersion: 1,
    id: 'obs-1',
    sessionId: 'sess-1',
    tabId: 'tab-1',
    pageInstanceId: 'page-alpha',
    contentEpoch: 0,
    sequence: 0,
    receivedAt: '2026-08-27T00:00:00.000Z',
    url: 'https://example.com/article',
    source: 'extension',
    type: 'dom_snapshot',
    payloadRef: `sha256:${'0'.repeat(64)}`,
    payloadHash: `sha256:${'0'.repeat(64)}`,
    redactionPolicy: REDACTION_POLICY,
    captureVersion: CAPTURE_VERSION,
    ...over,
  }
}

function domPayload(url: string, title: string, html: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    kind: 'dom_snapshot',
    captureVersion: CAPTURE_VERSION,
    reason: 'initial_readable',
    url,
    title,
    contentEpoch: 0,
    html,
    stats: { nodeCount: 3, maxDepth: 3, htmlUtf8Bytes: html.length },
  }))
}

const grantedPayload = new TextEncoder().encode(JSON.stringify({
  schemaVersion: 1,
  kind: 'authorization_granted',
  captureVersion: CAPTURE_VERSION,
  url: 'https://example.com/',
  reason: 'user_gesture',
  origin: 'https://example.com',
}))

function observation(over: Partial<ObservationEnvelope> & { payload?: Uint8Array } = {}) {
  const { payload = domPayload('https://example.com/a', 'Title A', '<main><p>hello</p></main>'), ...env } = over
  const hash = sha256Of(payload)
  const envelope = envelopeOf({ payloadRef: hash, payloadHash: hash, ...env })
  return { envelope, payload }
}

// —— 环境 ——

let root: string
const openStores: SiftFsStore[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sift-store-read-'))
})

afterEach(async () => {
  for (const s of openStores.splice(0)) await s.close()
  await rm(root, { recursive: true, force: true })
})

async function openWriter(): Promise<SiftFsStore> {
  const s = await openSiftStore({ rootDir: root })
  openStores.push(s)
  return s
}

async function openReader(onRecover?: (m: string) => void): Promise<SiftFsStore> {
  const s = await openSiftStore({ rootDir: root, ...(onRecover !== undefined ? { onRecover } : {}), readOnly: true })
  openStores.push(s)
  return s
}

/** 写入一组观察（granted → document_started → dom_snapshot，跨 2 页 2 session 的默认布景）。 */
async function seedStore(): Promise<void> {
  const writer = await openWriter()
  const grant = observation({
    id: 'obs-grant', sessionId: 'sess-1', pageInstanceId: 'page-alpha', sequence: 0,
    type: 'authorization_granted', url: 'https://example.com/', payload: grantedPayload,
  })
  await writer.appendObservation(grant.envelope, grant.payload)

  const doc = observation({
    id: 'obs-doc', sessionId: 'sess-1', pageInstanceId: 'page-alpha', sequence: 1,
    type: 'document_started', url: 'https://example.com/a',
    payload: new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1, kind: 'document_started', captureVersion: CAPTURE_VERSION,
      url: 'https://example.com/a', instanceNonce: 'n1', sameOriginReinject: false,
    })),
  })
  await writer.appendObservation(doc.envelope, doc.payload)

  const snap = observation({
    id: 'obs-snap', sessionId: 'sess-1', pageInstanceId: 'page-alpha', sequence: 2,
    receivedAt: '2026-08-27T00:01:00.000Z',
    url: 'https://example.com/a', type: 'dom_snapshot', source: 'dom',
    payload: domPayload('https://example.com/a', 'Article A', '<main><p>hello world</p></main>'),
  })
  await writer.appendObservation(snap.envelope, snap.payload)

  const other = observation({
    id: 'obs-beta', sessionId: 'sess-2', tabId: 'tab-2', pageInstanceId: 'page-beta', sequence: 0,
    receivedAt: '2026-08-27T00:02:00.000Z',
    url: 'https://other.example/b', type: 'dom_snapshot', source: 'dom',
    payload: domPayload('https://other.example/b', 'Page B', '<main><p>beta page</p></main>'),
  })
  await writer.appendObservation(other.envelope, other.payload)
}

// —— readOnly 打开语义 ——

describe('readOnly 打开', () => {
  it('断尾容忍：忽略不完整尾部且文件字节不动（写者可能正在写）', async () => {
    await seedStore()
    const tornText = '{"schemaVersion":1,"id":"torn"'
    await appendFile(join(root, 'observations.jsonl'), tornText) // 模拟写一半
    const afterAppend = await readFile(join(root, 'observations.jsonl'))

    const recovered: string[] = []
    const reader = await openReader(m => recovered.push(m))
    const afterOpen = await readFile(join(root, 'observations.jsonl'))
    expect(afterOpen.equals(afterAppend)).toBe(true) // 打开前后字节完全一致
    expect(afterOpen.length).toBe(afterAppend.length) // 断尾字节原样保留
    await expect(reader.readJournal()).resolves.toHaveLength(4) // 只见 4 条完整行
    expect(recovered.some(m => m.includes('断尾容忍'))).toBe(true)
  })

  it('中段坏 JSON 仍 store_corrupt（与写者一致失败关闭）', async () => {
    await seedStore()
    const writer = openStores[0]!
    await writer.close()
    const lines = (await readFile(join(root, 'observations.jsonl'), 'utf8')).split('\n').filter(l => l !== '')
    lines.splice(2, 0, 'not json')
    await writeFile(join(root, 'observations.jsonl'), `${lines.join('\n')}\n`, 'utf8')
    await expect(openReader()).rejects.toMatchObject({ siftStoreError: 'store_corrupt' })
    openStores.pop() // openReader 失败不会入列；防御性清理
  })

  it('appendObservation 抛 storage_error（readOnly 不支持写入）', async () => {
    await seedStore()
    const reader = await openReader()
    const obs = observation({ id: 'obs-x', sequence: 99 })
    await expect(reader.appendObservation(obs.envelope, obs.payload)).rejects.toMatchObject({
      siftStoreError: 'storage_error',
    })
  })

  it('staging 孤儿不动、meta 不刷新（零写入打开）', async () => {
    await seedStore()
    const writer = openStores[0]!
    await writer.close()
    await writeFile(join(root, 'staging', 'orphan-uuid'), 'leftover')
    const metaBefore = await readFile(join(root, 'meta.json'), 'utf8')
    const filesBefore = new Set((await readdir(root)).sort())

    const reader = await openReader()
    await expect(readdir(join(root, 'staging'))).resolves.toEqual(['orphan-uuid'])
    await expect(readFile(join(root, 'meta.json'), 'utf8')).resolves.toBe(metaBefore)
    await reader.close()
    expect(new Set((await readdir(root)).sort())).toEqual(filesBefore)
  })

  it('落后的 page-state 文件不被补写（重放只在内存）', async () => {
    await seedStore()
    const writer = openStores[0]!
    await writer.close()
    const psPath = join(root, 'page-states', 'page-alpha.json')
    await rm(psPath) // 模拟 journal 已写、page-state 未写的崩溃窗口

    const reader = await openReader()
    const pages = await reader.listPages()
    const alpha = pages.find(p => p.pageInstanceId === 'page-alpha')
    expect(alpha?.watermark.lastAppliedSequence).toBe(2) // 重放结果可见
    await expect(readdir(join(root, 'page-states'))).resolves.not.toContain('page-alpha.json') // 文件仍缺
  })

  it('与写者共存：写者 append 后开读者可见新行；读者是打开时刻的快照', async () => {
    const writer = await openWriter()
    const first = observation({ id: 'obs-1' })
    await writer.appendObservation(first.envelope, first.payload)

    const reader = await openReader()
    await expect(reader.readJournal()).resolves.toHaveLength(1)

    const second = observation({ id: 'obs-2', sequence: 1, payload: domPayload('https://example.com/a2', 'T2', '<p>x</p>') })
    await writer.appendObservation(second.envelope, second.payload)

    await expect(reader.readJournal()).resolves.toHaveLength(1) // 快照语义
    await reader.close()
    const reopened = await openReader()
    await expect(reopened.readJournal()).resolves.toHaveLength(2)
  })

  it('rootDir 不存在 → storage_error（不创建目录）', async () => {
    await expect(openSiftStore({ rootDir: join(root, 'nope'), readOnly: true })).rejects.toMatchObject({
      siftStoreError: 'storage_error',
    })
  })
})

// —— 读 API ——

describe('listSessions / listPages / readJournal', () => {
  it('listSessions：首见序、first/last receivedAt、page 归属、observationCount', async () => {
    await seedStore()
    const reader = await openReader()
    const sessions = await reader.listSessions()
    expect(sessions.map(s => s.sessionId)).toEqual(['sess-1', 'sess-2'])
    expect(sessions[0]).toMatchObject({
      firstReceivedAt: '2026-08-27T00:00:00.000Z',
      lastReceivedAt: '2026-08-27T00:01:00.000Z',
      pageInstanceIds: ['page-alpha'],
      observationCount: 3,
    })
    expect(sessions[1]).toMatchObject({
      pageInstanceIds: ['page-beta'],
      observationCount: 1,
    })
  })

  it('listPages：形状（watermark/canonicalUrl/title/snapshotBlobRef/lastEventType）+ sessionId 过滤', async () => {
    await seedStore()
    const reader = await openReader()
    const all = await reader.listPages()
    expect(all.map(p => p.pageInstanceId)).toEqual(['page-alpha', 'page-beta'])

    const alpha = all[0]!
    expect(alpha.sessionId).toBe('sess-1')
    expect(alpha.tabId).toBe('tab-1')
    expect(alpha.canonicalUrl).toBe('https://example.com/a')
    expect(alpha.title).toBe('Article A')
    expect(alpha.snapshotBlobRef).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(alpha.lastEventType).toBe('dom_snapshot')
    expect(alpha.lastEventReceivedAt).toBe('2026-08-27T00:01:00.000Z')

    const only1 = await reader.listPages({ sessionId: 'sess-1' })
    expect(only1.map(p => p.pageInstanceId)).toEqual(['page-alpha'])
    const only2 = await reader.listPages({ sessionId: 'sess-2' })
    expect(only2.map(p => p.pageInstanceId)).toEqual(['page-beta'])
  })

  it('readJournal：journal 序 + sessionId/pageInstanceId/types 三种过滤', async () => {
    await seedStore()
    const reader = await openReader()
    const all = await reader.readJournal()
    expect(all.map(r => r.id)).toEqual(['obs-grant', 'obs-doc', 'obs-snap', 'obs-beta'])

    expect((await reader.readJournal({ sessionId: 'sess-2' })).map(r => r.id)).toEqual(['obs-beta'])
    expect((await reader.readJournal({ pageInstanceId: 'page-alpha' })).map(r => r.id))
      .toEqual(['obs-grant', 'obs-doc', 'obs-snap'])
    expect((await reader.readJournal({ types: ['dom_snapshot'] })).map(r => r.id))
      .toEqual(['obs-snap', 'obs-beta'])
    expect((await reader.readJournal({ sessionId: 'sess-1', types: ['document_started'] })).map(r => r.id))
      .toEqual(['obs-doc'])
  })

  it('写者模式同样可读（host 内自检/下一轮 UI 消费同一接口）', async () => {
    await seedStore()
    const writer = openStores[0]!
    await expect(writer.listSessions()).resolves.toHaveLength(2)
    await expect(writer.readJournal({ types: ['authorization_granted'] })).resolves.toHaveLength(1)
  })
})

describe('readBlob / readSnapshotPayload', () => {
  it('readBlob 返回精确字节；篡改控制事件 blob → 读时 store_corrupt；缺失/坏形状 → store_corrupt', async () => {
    await seedStore()
    const writer = openStores[0]!
    const snap = (await writer.readJournal({ types: ['dom_snapshot'] }))[0]!
    const good = await writer.readBlob(snap.payloadHash)
    expect(sha256Of(good)).toBe(snap.payloadHash)

    // 篡改控制事件（非 snapshot）blob：不破坏 readOnly 打开的 replay（replay 只读 snapshot），
    // 由 readBlob 的惰性重验抓住。
    const grant = (await writer.readJournal({ types: ['authorization_granted'] }))[0]!
    await writer.close()
    const grantHex = grant.payloadHash.slice('sha256:'.length)
    await writeFile(join(root, 'blobs', grantHex.slice(0, 2), grantHex), 'tampered bytes')

    const reader = await openReader()
    await expect(reader.readBlob(grant.payloadHash)).rejects.toMatchObject({ siftStoreError: 'store_corrupt' })
    await expect(reader.readBlob(`sha256:${'f'.repeat(64)}`)).rejects.toMatchObject({ siftStoreError: 'store_corrupt' })
    await expect(reader.readBlob('not-a-hash')).rejects.toMatchObject({ siftStoreError: 'store_corrupt' })
  })

  it('篡改 snapshot blob → readOnly 打开即 store_corrupt（replay 读取时发现）', async () => {
    await seedStore()
    const writer = openStores[0]!
    const snap = (await writer.readJournal({ types: ['dom_snapshot'] }))[0]!
    await writer.close()
    const hex = snap.payloadHash.slice('sha256:'.length)
    await writeFile(join(root, 'blobs', hex.slice(0, 2), hex), 'tampered bytes')
    await expect(openReader()).rejects.toMatchObject({ siftStoreError: 'store_corrupt' })
  })

  it('readSnapshotPayload 返回 schema 合法的 payload；控制事件 hash → store_corrupt', async () => {
    await seedStore()
    const writer = openStores[0]!
    const snap = (await writer.readJournal({ types: ['dom_snapshot'] }))[0]!
    const payload = await writer.readSnapshotPayload(snap.payloadHash)
    expect(payload.kind).toBe('dom_snapshot')
    expect(payload.url).toBe('https://example.com/a')
    expect(payload.html).toContain('hello world')

    const grant = (await writer.readJournal({ types: ['authorization_granted'] }))[0]!
    await expect(writer.readSnapshotPayload(grant.payloadHash)).rejects.toMatchObject({
      siftStoreError: 'store_corrupt',
    })
  })
})

describe('SiftStoreError 形状回归', () => {
  it('错误带 siftStoreError 分类字段（capture-protocol 结构化识别依赖）', async () => {
    await seedStore()
    const reader = await openReader()
    const obs = observation({ id: 'obs-w', sequence: 7 })
    const err = await reader.appendObservation(obs.envelope, obs.payload).catch(e => e as SiftStoreError)
    expect(err).toBeInstanceOf(SiftStoreError)
    expect(err.siftStoreError).toBe('storage_error')
  })
})
