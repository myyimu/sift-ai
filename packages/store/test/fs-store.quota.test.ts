// 配额语义测试：mock @sift/shared/limits 把 Session/全局限额降到字节级，
// 验证 append 前复核 → quota_exceeded（错误带 siftStoreError 字段，host 失败关闭）。
// 限额真实值由 packages/shared/test/limits.test.ts 对照规范防漂移，此处不重复。
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObservationEnvelope } from '@sift/shared'
import { CAPTURE_VERSION, REDACTION_POLICY } from '@sift/shared/wire'

vi.mock('@sift/shared/limits', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@sift/shared/limits')>()
  return { ...orig, SESSION_QUOTA_BYTES: 64, GLOBAL_QUOTA_BYTES: 128 }
})

// mock 之后引入被测模块（vi.mock 提升，import 顺序无关，但保持显式）
const { openSiftStore } = await import('../src/fs-store')
type SiftFsStore = import('../src/fs-store').SiftFsStore

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
    url: 'https://example.com/a',
    source: 'extension',
    type: 'dom_snapshot',
    payloadRef: `sha256:${'0'.repeat(64)}`,
    payloadHash: `sha256:${'0'.repeat(64)}`,
    redactionPolicy: REDACTION_POLICY,
    captureVersion: CAPTURE_VERSION,
    ...over,
  }
}

function observation(id: string, sequence: number, sizeBytes: number, sessionId = 'sess-1') {
  // 内容含 id：每次调用产生唯一 blob（配额按去重后字节计）
  const payload = new TextEncoder().encode(`${id}:${'x'.repeat(Math.max(1, sizeBytes - id.length - 1))}`)
  const hash = sha256Of(payload)
  return {
    // 控制事件：store 不解析其 payload，配额测试可用任意字节
    envelope: envelopeOf({
      id, sequence, sessionId, payloadRef: hash, payloadHash: hash,
      type: 'authorization_granted' as const,
    }),
    payload,
  }
}

let root: string
let store: SiftFsStore | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sift-quota-'))
})

afterEach(async () => {
  await store?.close()
  store = null
  await rm(root, { recursive: true, force: true })
})

describe('SiftFsStore：配额复核（mock 限额：session=64 / global=128 字节）', () => {
  it('Session 配额超限 → quota_exceeded，journal 零写入', async () => {
    store = await openSiftStore({ rootDir: root })
    const first = observation('obs-1', 0, 40) // 实际 38B < 64B session 限额
    await store.appendObservation(first.envelope, first.payload)

    const second = observation('obs-2', 1, 40) // 累计 76B > 64B
    await expect(store.appendObservation(second.envelope, second.payload))
      .rejects.toMatchObject({ siftStoreError: 'quota_exceeded' })
    const journal = await readFile(join(root, 'observations.jsonl'), 'utf8')
    expect(journal.trim().split('\n')).toHaveLength(1)
  })

  it('跨 Session 计全局：两 session 各 48B（96B 全局）后，第三个新 blob 144B > 128B 超限', async () => {
    store = await openSiftStore({ rootDir: root })
    const a = observation('obs-1', 0, 50, 'sess-a')
    await store.appendObservation(a.envelope, a.payload)
    const b = observation('obs-2', 0, 50, 'sess-b')
    await store.appendObservation(b.envelope, b.payload)

    const third = observation('obs-3', 0, 50, 'sess-c') // 单 session 48B ≤ 64B，但全局超
    await expect(store.appendObservation(third.envelope, third.payload))
      .rejects.toMatchObject({ siftStoreError: 'quota_exceeded' })
  })

  it('blob 复用不计新字节：同内容重复观察不消耗配额', async () => {
    store = await openSiftStore({ rootDir: root })
    const first = observation('obs-1', 0, 40)
    await store.appendObservation(first.envelope, first.payload)
    // 同 payload 不同 id → blob 复用，session 计数不变（38B 仍 < 64B）
    const dup = { envelope: { ...first.envelope, id: 'obs-2', sequence: 1 }, payload: first.payload }
    const result = await store.appendObservation(dup.envelope, dup.payload)
    expect(result.deduplicated).toBe(false)
    expect(result.stateVersion).toBe(2)
  })
})
