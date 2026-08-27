// FS Store 行为语义测试（ADR-003 §3/§4 的 E-04 映射逐条覆盖）：
// 幂等、blob 复用与路径、page-state 替换与重放恢复、断尾截断、中段损坏、
// 引用缺失/hash 不符、page-state 领先、gap 记录。配额在 fs-store.quota.test.ts（mock 限额）。
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ObservationEnvelope } from '@sift/shared'
import { CAPTURE_VERSION, REDACTION_POLICY } from '@sift/shared/wire'
import { openSiftStore, type SiftFsStore } from '../src/fs-store'
import { parsePageState, serializePageState, type PageStateDoc } from '../src/page-state'

// —— 构造 ——

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

/** envelope + 自洽 payload（hash 由内容计算）。 */
function observation(over: Partial<ObservationEnvelope> & { payload?: Uint8Array } = {}) {
  const { payload = domPayload('https://example.com/a', 'Title A', '<main><p>hello</p></main>'), ...env } = over
  const hash = sha256Of(payload)
  const envelope = envelopeOf({ payloadRef: hash, payloadHash: hash, ...env })
  return { envelope, payload }
}

// —— 环境 ——

let root: string
let store: SiftFsStore | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sift-store-'))
})

afterEach(async () => {
  await store?.close()
  store = null
  await rm(root, { recursive: true, force: true })
})

async function journalLines(): Promise<string[]> {
  const text = await readFile(join(root, 'observations.jsonl'), 'utf8')
  return text.split('\n').filter(line => line !== '')
}

async function blobFiles(): Promise<string[]> {
  const out: string[] = []
  const shards = await readdir(join(root, 'blobs'))
  for (const shard of shards) {
    for (const name of await readdir(join(root, 'blobs', shard))) {
      out.push(join(shard, name))
    }
  }
  return out
}

async function readPageState(pid: string): Promise<PageStateDoc> {
  return parsePageState(await readFile(join(root, 'page-states', `${pid}.json`), 'utf8'))
}

// —— 测试 ——

describe('SiftFsStore：打开与目录布局', () => {
  it('首次打开创建完整目录骨架与空 journal', async () => {
    store = await openSiftStore({ rootDir: root })
    for (const dir of ['blobs', 'page-states', 'staging']) {
      await expect(readdir(join(root, dir))).resolves.toEqual([])
    }
    await expect(journalLines()).resolves.toEqual([])
  })

  it('打开时清空 staging 孤儿（崩溃残留）', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'staging'), { recursive: true })
    await writeFile(join(root, 'staging', 'orphan-bytes'), 'partial')
    store = await openSiftStore({ rootDir: root })
    await expect(readdir(join(root, 'staging'))).resolves.toEqual([])
  })
})

describe('SiftFsStore：appendObservation 写入序与幂等', () => {
  it('dom_snapshot 落盘：blob 按内容寻址分片、journal 追加、page-state 替换、meta 刷新', async () => {
    store = await openSiftStore({ rootDir: root })
    const { envelope, payload } = observation()
    const result = await store.appendObservation(envelope, payload)

    expect(result).toEqual({
      deduplicated: false,
      payloadHash: envelope.payloadHash,
      stateVersion: 1,
      lastAppliedSequence: 0,
    })
    const hex = envelope.payloadHash.slice(7)
    await expect(readdir(join(root, 'blobs'))).resolves.toEqual([hex.slice(0, 2)])
    await expect(readdir(join(root, 'blobs', hex.slice(0, 2)))).resolves.toEqual([hex])
    expect(await journalLines()).toHaveLength(1)

    const doc = await readPageState('page-alpha')
    expect(doc.lastAppliedSequence).toBe(0)
    expect(doc.stateVersion).toBe(1)
    expect(doc.canonicalUrl).toBe('https://example.com/a')
    expect(doc.title).toBe('Title A')
    expect(doc.sanitizedSnapshotBlobRef).toBe(envelope.payloadHash)
    expect(doc.sourceObservationId).toBe('obs-1')
    expect(doc.documentDirty).toBe(false)
    expect(doc.pendingTriggerCount).toBe(0)

    const meta = JSON.parse(await readFile(join(root, 'meta.json'), 'utf8')) as { observationCount: number }
    expect(meta.observationCount).toBe(1)
  })

  it('同 id 同 hash 重复 append → deduplicated，journal/blob/page-state 均不变', async () => {
    store = await openSiftStore({ rootDir: root })
    const { envelope, payload } = observation()
    await store.appendObservation(envelope, payload)

    const again = await store.appendObservation(envelope, payload)
    expect(again.deduplicated).toBe(true)
    expect(await journalLines()).toHaveLength(1)
    expect(await blobFiles()).toHaveLength(1)
  })

  it('同 id 异 hash → store_corrupt（防御纵深，协议层本应拦截）', async () => {
    store = await openSiftStore({ rootDir: root })
    const first = observation()
    await store.appendObservation(first.envelope, first.payload)
    const second = observation({ payload: domPayload('https://example.com/b', 'Title B', '<p>other</p>') })
    await expect(store.appendObservation({ ...second.envelope, id: first.envelope.id }, second.payload))
      .rejects.toMatchObject({ siftStoreError: 'store_corrupt' })
  })

  it('payload 实际 hash 与声明不符 → storage_error，零写入', async () => {
    store = await openSiftStore({ rootDir: root })
    const { envelope } = observation()
    const wrongBytes = new TextEncoder().encode('{"different":"bytes"}')
    await expect(store.appendObservation(envelope, wrongBytes))
      .rejects.toMatchObject({ siftStoreError: 'storage_error' })
    expect(await journalLines()).toEqual([])
    expect(await blobFiles()).toEqual([])
  })

  it('blob 内容寻址复用：两条观察同 payload → 单 blob 双 journal 行', async () => {
    store = await openSiftStore({ rootDir: root })
    const first = observation()
    // 同 payload、不同 id/sequence（重复快照场景）
    const second = observation({ id: 'obs-2', sequence: 1 })
    await store.appendObservation(first.envelope, first.payload)
    await store.appendObservation(second.envelope, second.payload)

    expect(await journalLines()).toHaveLength(2)
    expect(await blobFiles()).toHaveLength(1)
    const doc = await readPageState('page-alpha')
    expect(doc.observationCount).toBe(2)
    expect(doc.stateVersion).toBe(2)
    expect(doc.lastAppliedSequence).toBe(1)
    expect(doc.sanitizedSnapshotBlobRef).toBe(first.envelope.payloadHash)
  })

  it('控制事件（authorization_granted）只前进水位不替换快照', async () => {
    store = await openSiftStore({ rootDir: root })
    const granted = observation({ type: 'authorization_granted', payload: grantedPayload })
    const result = await store.appendObservation(granted.envelope, granted.payload)
    expect(result.stateVersion).toBe(1)
    const doc = await readPageState('page-alpha')
    expect(doc.sanitizedSnapshotBlobRef).toBe('')
    expect(doc.canonicalUrl).toBe(granted.envelope.url)
    expect(doc.lastEventType).toBe('authorization_granted')
  })

  it('gap：seq 0 → seq 5 记录 sequenceGaps [1..4]', async () => {
    store = await openSiftStore({ rootDir: root })
    const first = observation()
    const second = observation({ id: 'obs-5', sequence: 5, payload: domPayload('https://example.com/c', 'Title C', '<p>x</p>') })
    await store.appendObservation(first.envelope, first.payload)
    await store.appendObservation(second.envelope, second.payload)
    const doc = await readPageState('page-alpha')
    expect(doc.sequenceGaps).toEqual([{ start: 1, end: 4 }])
    expect(doc.lastAppliedSequence).toBe(5)
  })
})

describe('SiftFsStore：查询', () => {
  it('byId / bySeq / highWater / pageWatermark', async () => {
    store = await openSiftStore({ rootDir: root })
    const first = observation()
    const second = observation({ id: 'obs-2', sequence: 3, payload: domPayload('https://example.com/d', 'Title D', '<p>y</p>') })
    await store.appendObservation(first.envelope, first.payload)
    await store.appendObservation(second.envelope, second.payload)

    await expect(store.findObservationById('obs-1')).resolves.toEqual({ payloadHash: first.envelope.payloadHash })
    await expect(store.findObservationById('nope')).resolves.toBeNull()
    await expect(store.findObservationBySequence('page-alpha', 3)).resolves.toEqual({ payloadHash: second.envelope.payloadHash })
    await expect(store.getSequenceHighWater('page-alpha')).resolves.toBe(3)
    await expect(store.getPageWatermark('page-alpha')).resolves.toEqual({ stateVersion: 2, lastAppliedSequence: 3 })
    await expect(store.getPageWatermark('unknown')).resolves.toBeNull()
  })
})

describe('SiftFsStore：重开恢复（journal 是事实来源）', () => {
  it('commit_ack 丢失场景：close 后重开，同观察重发 → deduplicated', async () => {
    store = await openSiftStore({ rootDir: root })
    const { envelope, payload } = observation()
    await store.appendObservation(envelope, payload)
    await store.close()
    store = null

    store = await openSiftStore({ rootDir: root })
    const again = await store.appendObservation(envelope, payload)
    expect(again.deduplicated).toBe(true)
    expect(await journalLines()).toHaveLength(1)
  })

  it('page-state 文件缺失/落后 → 按 journal 重放补齐（字节一致）', async () => {
    store = await openSiftStore({ rootDir: root })
    const first = observation()
    const second = observation({ id: 'obs-2', sequence: 1, payload: domPayload('https://example.com/e', 'Title E', '<p>z</p>') })
    await store.appendObservation(first.envelope, first.payload)
    await store.appendObservation(second.envelope, second.payload)
    await store.close()
    store = null

    const expected = await readFile(join(root, 'page-states', 'page-alpha.json'), 'utf8')

    // 场景 1：page-state 整个丢失
    const { unlink } = await import('node:fs/promises')
    await unlink(join(root, 'page-states', 'page-alpha.json'))
    const recovered: string[] = []
    store = await openSiftStore({ rootDir: root, onRecover: m => recovered.push(m) })
    await expect(readFile(join(root, 'page-states', 'page-alpha.json'), 'utf8')).resolves.toBe(expected)
    expect(recovered.join('\n')).toContain('page-alpha')

    // 场景 2：page-state 落后（回写旧版本）
    await store.close()
    store = null
    const stale = parsePageState(expected)
    const older = serializePageState({ ...stale, stateVersion: 1, lastAppliedSequence: 0, observationCount: 1 })
    await writeFile(join(root, 'page-states', 'page-alpha.json'), older)
    store = await openSiftStore({ rootDir: root })
    await expect(readFile(join(root, 'page-states', 'page-alpha.json'), 'utf8')).resolves.toBe(expected)
  })

  it('journal 断尾（末行不完整）→ 截断恢复，onRecover 提示', async () => {
    store = await openSiftStore({ rootDir: root })
    const { envelope, payload } = observation()
    await store.appendObservation(envelope, payload)
    await store.close()
    store = null

    // 模拟下一条写一半崩溃
    const journalPath = join(root, 'observations.jsonl')
    const good = await readFile(journalPath, 'utf8')
    await writeFile(journalPath, `${good}${JSON.stringify(envelopeOf({ id: 'obs-torn' })).slice(0, 40)}`, 'utf8')

    const recovered: string[] = []
    store = await openSiftStore({ rootDir: root, onRecover: m => recovered.push(m) })
    expect(await journalLines()).toHaveLength(1)
    expect(recovered.join('\n')).toContain('断尾')
  })

  it('journal 中段坏行 → store_corrupt 拒绝打开', async () => {
    store = await openSiftStore({ rootDir: root })
    const first = observation()
    await store.appendObservation(first.envelope, first.payload)
    await store.close()
    store = null

    const journalPath = join(root, 'observations.jsonl')
    const lines = await journalLines()
    const poisoned = [lines[0], '{ broken json', lines[0]].join('\n') + '\n'
    await writeFile(journalPath, poisoned, 'utf8')
    await expect(openSiftStore({ rootDir: root })).rejects.toMatchObject({ siftStoreError: 'store_corrupt' })
  })

  it('journal 引用 blob 缺失 → store_corrupt；内容被篡改（hash 不符）→ store_corrupt', async () => {
    store = await openSiftStore({ rootDir: root })
    const { envelope, payload } = observation()
    await store.appendObservation(envelope, payload)
    await store.close()
    store = null

    const hex = envelope.payloadHash.slice(7)
    const blobPath = join(root, 'blobs', hex.slice(0, 2), hex)

    // 缺失
    const { unlink } = await import('node:fs/promises')
    await unlink(blobPath)
    await expect(openSiftStore({ rootDir: root })).rejects.toMatchObject({ siftStoreError: 'store_corrupt' })

    // 篡改（等长替换，保持文件存在）
    await writeFile(blobPath, Buffer.from('t'.repeat(payload.length)), 'utf8')
    await expect(openSiftStore({ rootDir: root })).rejects.toMatchObject({ siftStoreError: 'store_corrupt' })
  })

  it('page-state 领先于 journal → store_corrupt；无 journal 支撑却非空 → store_corrupt', async () => {
    store = await openSiftStore({ rootDir: root })
    const first = observation()
    await store.appendObservation(first.envelope, first.payload)
    await store.close()
    store = null

    // 领先：lastAppliedSequence 超过 journal
    const doc = await readPageState('page-alpha')
    const ahead = serializePageState({ ...doc, lastAppliedSequence: doc.lastAppliedSequence + 5 })
    await writeFile(join(root, 'page-states', 'page-alpha.json'), ahead)
    await expect(openSiftStore({ rootDir: root })).rejects.toMatchObject({ siftStoreError: 'store_corrupt' })

    // 无支撑：journal 为空但 page-state 非空
    const emptyRoot = await mkdtemp(join(tmpdir(), 'sift-store-'))
    try {
      const s = await openSiftStore({ rootDir: emptyRoot })
      await s.close()
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(emptyRoot, 'page-states'), { recursive: true })
      await writeFile(join(emptyRoot, 'page-states', 'page-ghost.json'), serializePageState({ ...doc, pageInstanceId: 'page-ghost' }))
      await expect(openSiftStore({ rootDir: emptyRoot })).rejects.toMatchObject({ siftStoreError: 'store_corrupt' })
    } finally {
      await rm(emptyRoot, { recursive: true, force: true })
    }
  })

  it('reducer 幂等：重放已应用的 sequence 不改变 page-state（重开不增 stateVersion）', async () => {
    store = await openSiftStore({ rootDir: root })
    const first = observation()
    const second = observation({ id: 'obs-2', sequence: 1, payload: domPayload('https://example.com/f', 'Title F', '<p>w</p>') })
    await store.appendObservation(first.envelope, first.payload)
    await store.appendObservation(second.envelope, second.payload)
    await store.close()
    store = null

    store = await openSiftStore({ rootDir: root })
    const doc = await readPageState('page-alpha')
    expect(doc.stateVersion).toBe(2)
    expect(doc.observationCount).toBe(2)
  })
})
