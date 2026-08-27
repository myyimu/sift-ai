// transport.test.ts —— SW 传输状态机（fake port + 假时钟 + 即时 sha256，零 Chrome）。
// 覆盖：hello/welcome、stop-and-wait 分块、超时重发、断线重连（transferId 不变）、
// 永久错误停机、背压合并、队列满淘汰、闲置断开。
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObservationEnvelope } from '@sift/shared'
import { CAPTURE_VERSION, PROTOCOL_VERSION, REDACTION_POLICY } from '@sift/shared/wire'
import {
  createCaptureTransport,
  type CaptureTransport,
  type NativePortLike,
  type PendingObservation,
} from '../src/transport'

class FakePort {
  readonly sent: unknown[] = []
  disconnectCount = 0
  private messageListeners: ((message: unknown) => void)[] = []
  private disconnectListeners: (() => void)[] = []
  readonly onMessage = { addListener: (cb: (message: unknown) => void) => { this.messageListeners.push(cb) } }
  readonly onDisconnect = { addListener: (cb: () => void) => { this.disconnectListeners.push(cb) } }
  send(message: unknown): void {
    this.sent.push(message)
  }
  disconnect(): void {
    this.disconnectCount += 1
    for (const cb of this.disconnectListeners) cb()
  }
  receive(message: unknown): void {
    for (const cb of this.messageListeners) cb(message)
  }
}

let ports: FakePort[]
let seqCounter: number

const currentPort = (): FakePort => ports[ports.length - 1]!

const connectNative = (): NativePortLike => {
  const port = new FakePort()
  ports.push(port)
  return port
}

const sha256Hex = (bytes: Uint8Array): Promise<string> =>
  Promise.resolve(createHash('sha256').update(bytes).digest('hex'))

const hashOf = (text: string): string => `sha256:${createHash('sha256').update(new TextEncoder().encode(text)).digest('hex')}`

function envelope(pageInstanceId = 'p-test'): ObservationEnvelope {
  seqCounter += 1
  return {
    schemaVersion: 1,
    id: `obs-${seqCounter}`,
    sessionId: 's-test',
    tabId: '1',
    pageInstanceId,
    contentEpoch: 0,
    sequence: seqCounter,
    receivedAt: '2026-01-01T00:00:00.000Z',
    url: 'https://example.com/a',
    source: 'dom',
    type: 'dom_snapshot',
    payloadRef: `sha256:${'0'.repeat(64)}`,
    payloadHash: `sha256:${'0'.repeat(64)}`,
    redactionPolicy: REDACTION_POLICY,
    captureVersion: CAPTURE_VERSION,
  }
}

function observation(payloadJson = '{"k":"v"}', pageInstanceId = 'p-test'): PendingObservation {
  return {
    envelope: envelope(pageInstanceId),
    payloadJson,
    transferId: `t-${seqCounter}`,
    kind: 'dom_snapshot',
  }
}

function controlObservation(): PendingObservation {
  const obs = observation('{"kind":"document_started"}')
  return { ...obs, kind: 'control' }
}

/** 推进到 announce 完成（hello → welcome → announce 已发出）。 */
async function driveToAnnounce(t: CaptureTransport, obs: PendingObservation): Promise<FakePort> {
  t.enqueue(obs)
  const port = currentPort()
  expect(port.sent[0]).toMatchObject({ type: 'hello', protocolVersion: PROTOCOL_VERSION, client: 'sift-extension' })
  port.receive({ type: 'welcome', protocolVersion: PROTOCOL_VERSION, host: 'sift-demo-host', storeReady: true })
  await vi.advanceTimersByTimeAsync(0)
  expect(port.sent[1]).toMatchObject({ type: 'announce', transferId: obs.transferId })
  return port
}

beforeEach(() => {
  vi.useFakeTimers()
  ports = []
  seqCounter = 0
})
afterEach(() => {
  vi.useRealTimers()
})

const makeTransport = (): CaptureTransport => createCaptureTransport({ connectNative, sha256Hex })

describe('transport：happy path', () => {
  it('多分块 stop-and-wait 全链路 → commit_ack 出队', async () => {
    const payloadJson = `{"data":"${'x'.repeat(300_000)}"}`
    const obs = observation(payloadJson)
    const t = makeTransport()
    const port = await driveToAnnounce(t, obs)

    const announce = port.sent[1] as {
      payloadBytes: number; payloadHash: string; chunkCount: number; chunkSize: number
      envelope: { payloadHash: string; payloadRef: string }
    }
    const bytes = new TextEncoder().encode(payloadJson)
    expect(announce.payloadBytes).toBe(bytes.length)
    expect(announce.payloadHash).toBe(hashOf(payloadJson))
    expect(announce.envelope.payloadHash).toBe(announce.payloadHash) // 占位 hash 回填
    expect(announce.envelope.payloadRef).toBe(announce.payloadHash)
    expect(announce.chunkSize).toBe(256 * 1024)
    expect(announce.chunkCount).toBe(2)

    // stop-and-wait：transfer_ack 前不发任何 chunk
    expect(port.sent.length).toBe(2)

    port.receive({ type: 'transfer_ack', transferId: obs.transferId, status: 'ok' })
    expect(port.sent[2]).toMatchObject({ type: 'chunk', index: 0, chunkCount: 2 })
    expect(port.sent.length).toBe(3) // 未 ack 不发下一块

    port.receive({ type: 'chunk_ack', transferId: obs.transferId, index: 0, receivedBytes: 256 * 1024 })
    expect(port.sent[3]).toMatchObject({ type: 'chunk', index: 1 })

    port.receive({ type: 'chunk_ack', transferId: obs.transferId, index: 1, receivedBytes: bytes.length })
    expect(port.sent[4]).toMatchObject({ type: 'commit', transferId: obs.transferId, payloadHash: announce.payloadHash })

    port.receive({
      type: 'commit_ack', transferId: obs.transferId, deduplicated: false,
      payloadHash: announce.payloadHash, stateVersion: 1, lastAppliedSequence: 1,
    })
    expect(t.queueSize).toBe(0)
  })

  it('transfer_ack(deduplicated) → 免发 chunk 直接出队', async () => {
    const obs = observation()
    const t = makeTransport()
    const port = await driveToAnnounce(t, obs)
    const sentBefore = port.sent.length
    port.receive({ type: 'transfer_ack', transferId: obs.transferId, status: 'deduplicated' })
    expect(t.queueSize).toBe(0)
    expect(port.sent.length).toBe(sentBefore) // 无 chunk、无 commit
  })

  it('多条观察排队：commit_ack 后必须继续 announce 下一条（回归：state 未复位死锁）', async () => {
    const first = observation('{"n":1}', 'p-a')
    const second = observation('{"n":2}', 'p-b')
    const t = makeTransport()
    t.enqueue(first)
    t.enqueue(second)
    const port = currentPort()
    port.receive({ type: 'welcome', protocolVersion: PROTOCOL_VERSION, host: 'sift-demo-host', storeReady: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(port.sent[1]).toMatchObject({ type: 'announce', transferId: first.transferId })
    port.receive({ type: 'transfer_ack', transferId: first.transferId, status: 'ok' })
    port.receive({ type: 'chunk_ack', transferId: first.transferId, index: 0, receivedBytes: 7 })
    expect(port.sent.at(-1)).toMatchObject({ type: 'commit' })
    port.receive({
      type: 'commit_ack', transferId: first.transferId, deduplicated: false,
      payloadHash: hashOf(first.payloadJson), stateVersion: 1, lastAppliedSequence: 1,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(port.sent.at(-1)).toMatchObject({ type: 'announce', transferId: second.transferId })
    expect(t.state).toBe('announce')
  })

  it('多条观察排队：deduplicated 后必须继续 announce 下一条', async () => {
    const first = observation('{"n":1}', 'p-a')
    const second = observation('{"n":2}', 'p-b')
    const t = makeTransport()
    t.enqueue(first)
    t.enqueue(second)
    const port = currentPort()
    port.receive({ type: 'welcome', protocolVersion: PROTOCOL_VERSION, host: 'sift-demo-host', storeReady: true })
    await vi.advanceTimersByTimeAsync(0)
    port.receive({ type: 'transfer_ack', transferId: first.transferId, status: 'deduplicated' })
    await vi.advanceTimersByTimeAsync(0)
    expect(port.sent.filter(m => (m as { type?: string }).type === 'announce').length).toBe(2)
    expect(t.queueSize).toBe(1)
  })
})

describe('transport：超时与重试', () => {
  it('welcome 超时 → 断开重连，hello 重发', async () => {
    const obs = observation()
    const t = makeTransport()
    t.enqueue(obs)
    const p1 = currentPort()
    await vi.advanceTimersByTimeAsync(3000)
    expect(p1.disconnectCount).toBe(1)
    expect(ports.length).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    const p2 = currentPort()
    expect(p2).not.toBe(p1)
    expect(p2.sent[0]).toMatchObject({ type: 'hello' })
  })

  it('chunk ack 超时重发同 index，超限后重连且 transferId 不变', async () => {
    const obs = observation()
    const t = makeTransport()
    const port = await driveToAnnounce(t, obs)
    port.receive({ type: 'transfer_ack', transferId: obs.transferId, status: 'ok' })
    expect(port.sent.filter(m => (m as { type: string }).type === 'chunk').length).toBe(1)

    await vi.advanceTimersByTimeAsync(2000) // 重发 #1
    expect(port.sent.filter(m => (m as { type: string }).type === 'chunk').length).toBe(2)
    await vi.advanceTimersByTimeAsync(2000) // 重发 #2
    expect(port.sent.filter(m => (m as { type: string }).type === 'chunk').length).toBe(3)
    await vi.advanceTimersByTimeAsync(2000) // 超限 → teardown
    expect(port.disconnectCount).toBe(1)
    expect(t.queueSize).toBe(1) // 观察留队

    await vi.advanceTimersByTimeAsync(1000)
    const p2 = currentPort()
    p2.receive({ type: 'welcome', protocolVersion: PROTOCOL_VERSION, host: 'sift-demo-host', storeReady: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(p2.sent[1]).toMatchObject({ type: 'announce', transferId: obs.transferId }) // 同 transferId 重发
  })

  it('commit_ack 超时 → 同 transferId 重新 announce 并最终完成', async () => {
    const obs = observation()
    const t = makeTransport()
    const port = await driveToAnnounce(t, obs)
    port.receive({ type: 'transfer_ack', transferId: obs.transferId, status: 'ok' })
    port.receive({ type: 'chunk_ack', transferId: obs.transferId, index: 0, receivedBytes: 9 })
    expect(port.sent.at(-1)).toMatchObject({ type: 'commit' })

    await vi.advanceTimersByTimeAsync(5000)
    expect(port.sent.at(-1)).toMatchObject({ type: 'announce', transferId: obs.transferId })

    // 第二轮走完
    port.receive({ type: 'transfer_ack', transferId: obs.transferId, status: 'ok' })
    port.receive({ type: 'chunk_ack', transferId: obs.transferId, index: 0, receivedBytes: 9 })
    expect(port.sent.at(-1)).toMatchObject({ type: 'commit' })
    port.receive({
      type: 'commit_ack', transferId: obs.transferId, deduplicated: false,
      payloadHash: hashOf(obs.payloadJson), stateVersion: 1, lastAppliedSequence: 1,
    })
    expect(t.queueSize).toBe(0)
  })
})

describe('transport：断线与错误', () => {
  it('传输中断线 → 观察留队，重连后同 transferId 重发', async () => {
    const obs = observation()
    const t = makeTransport()
    const port = await driveToAnnounce(t, obs)
    port.receive({ type: 'transfer_ack', transferId: obs.transferId, status: 'ok' })
    expect(t.queueSize).toBe(1)
    port.disconnect() // 外部 kill（host 进程退出）

    await vi.advanceTimersByTimeAsync(1000)
    const p2 = currentPort()
    expect(p2.sent[0]).toMatchObject({ type: 'hello' })
    p2.receive({ type: 'welcome', protocolVersion: PROTOCOL_VERSION, host: 'sift-demo-host', storeReady: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(p2.sent[1]).toMatchObject({ type: 'announce', transferId: obs.transferId })
    expect(t.queueSize).toBe(1)
  })

  it('永久性错误（quota_exceeded）→ 停止传输，后续 enqueue 静默丢弃', async () => {
    const obs = observation()
    const t = makeTransport()
    const port = await driveToAnnounce(t, obs)
    port.receive({ type: 'transfer_ack', transferId: obs.transferId, status: 'ok' })
    port.receive({ type: 'error', transferId: obs.transferId, code: 'quota_exceeded', message: 'commit：配额超限', fatal: true })

    expect(t.queueSize).toBe(0)
    t.enqueue(observation('{"k":"after"}'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ports.length).toBe(1) // 不再重连
    expect(t.queueSize).toBe(0)
  })

  it('可恢复错误（hash_mismatch）→ 1s 后重连重试', async () => {
    const obs = observation()
    const t = makeTransport()
    const port = await driveToAnnounce(t, obs)
    port.receive({ type: 'error', transferId: obs.transferId, code: 'hash_mismatch', message: 'chunk：hash 不符', fatal: true })
    expect(t.queueSize).toBe(1)

    await vi.advanceTimersByTimeAsync(1000)
    const p2 = currentPort()
    expect(p2.sent[0]).toMatchObject({ type: 'hello' })
  })
})

describe('transport：背压', () => {
  it('同 pageInstanceId 的 pending 快照 latest-wins 合并', () => {
    const t = makeTransport()
    t.enqueue(observation('{"v":1}'))
    t.enqueue(observation('{"v":2}'))
    t.enqueue(observation('{"v":3}'))
    expect(t.queueSize).toBe(1) // 全部同 pid → 只剩最新
  })

  it('在途（announce 后）队头不可被合并替换', async () => {
    const obs = observation('{"v":1}')
    const t = makeTransport()
    const port = await driveToAnnounce(t, obs)
    port.receive({ type: 'transfer_ack', transferId: obs.transferId, status: 'ok' })
    expect(t.state).toBe('chunk')

    t.enqueue(observation('{"v":2}')) // 同 pid 也不可替换队头
    expect(t.queueSize).toBe(2)
    expect(port.sent.filter(m => (m as { index?: number }).index === 0).length).toBeGreaterThan(0)
  })

  it('队列满 8：不同 pid 的快照合并最旧一条', () => {
    const t = makeTransport()
    for (let i = 0; i < 8; i += 1) t.enqueue(observation(`{"v":${i}}`, `p-${i}`))
    expect(t.queueSize).toBe(8)
    t.enqueue(observation('{"v":9}', 'p-new'))
    expect(t.queueSize).toBe(8) // 淘汰最旧 dom，非丢弃新快照
  })

  it('队列满 8：控制事件挤掉最旧控制事件', () => {
    const t = makeTransport()
    t.enqueue(controlObservation())
    for (let i = 0; i < 7; i += 1) t.enqueue(controlObservation())
    expect(t.queueSize).toBe(8)
    t.enqueue(controlObservation())
    expect(t.queueSize).toBe(8)
  })
})

describe('transport：闲置断开', () => {
  it('队列清空 5s 后断开 port，新观察重新连接', async () => {
    const obs = observation()
    const t = makeTransport()
    const port = await driveToAnnounce(t, obs)
    port.receive({ type: 'transfer_ack', transferId: obs.transferId, status: 'deduplicated' })
    expect(t.queueSize).toBe(0)

    await vi.advanceTimersByTimeAsync(5000)
    expect(port.disconnectCount).toBe(1)

    t.enqueue(observation('{"v":2}'))
    const p2 = currentPort()
    expect(p2.sent[0]).toMatchObject({ type: 'hello' })
  })
})
