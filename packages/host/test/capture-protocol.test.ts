// capture 协议状态机测试：注入 fake store 覆盖 happy path、三层去重、
// hash/sequence/limit fail-closed、chunk 乱序与幂等重发、quota 分类、ping 回归。
// （真实 FsStore 的落盘语义在 packages/store/test/fs-store.test.ts 覆盖。）
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ObservationEnvelope } from '@sift/shared'
import {
  CAPTURE_VERSION,
  PROTOCOL_VERSION,
  REDACTION_POLICY,
  bytesToBase64,
  chunkCountFor,
  type ErrorMsg,
  type HostErrorCode,
} from '@sift/shared/wire'
import {
  createCaptureProtocolHandler,
  type CaptureCommitResult,
  type CaptureObservationRef,
  type CapturePageWatermark,
  type CaptureStore,
} from '../src/capture-protocol'
import { FailClosed } from '../src/host-loop'

// —— fake store（内存版；形状与 FsStore 相同） ——

class FakeStore implements CaptureStore {
  readonly appended: { envelope: ObservationEnvelope; payload: Uint8Array }[] = []
  /** 模拟 appendObservation 抛错（带 siftStoreError 分类字段）。 */
  failWith: (Error & { siftStoreError?: string }) | null = null
  private readonly byId = new Map<string, string>()
  private readonly bySeq = new Map<string, string>()
  private readonly high = new Map<string, number>()

  async appendObservation(envelope: ObservationEnvelope, payload: Uint8Array): Promise<CaptureCommitResult> {
    if (this.failWith !== null) throw this.failWith
    const existing = this.byId.get(envelope.id)
    if (existing !== undefined) {
      return { deduplicated: true, payloadHash: existing, stateVersion: 1, lastAppliedSequence: envelope.sequence }
    }
    this.appended.push({ envelope, payload: payload.slice() })
    this.byId.set(envelope.id, envelope.payloadHash)
    this.bySeq.set(`${envelope.pageInstanceId}#${envelope.sequence}`, envelope.payloadHash)
    const prev = this.high.get(envelope.pageInstanceId) ?? -1
    this.high.set(envelope.pageInstanceId, Math.max(prev, envelope.sequence))
    return {
      deduplicated: false,
      payloadHash: envelope.payloadHash,
      stateVersion: 1,
      lastAppliedSequence: envelope.sequence,
    }
  }

  async findObservationById(id: string): Promise<CaptureObservationRef | null> {
    const h = this.byId.get(id)
    return h === undefined ? null : { payloadHash: h }
  }

  async findObservationBySequence(pageInstanceId: string, sequence: number): Promise<CaptureObservationRef | null> {
    const h = this.bySeq.get(`${pageInstanceId}#${sequence}`)
    return h === undefined ? null : { payloadHash: h }
  }

  async getSequenceHighWater(pageInstanceId: string): Promise<number | null> {
    return this.high.get(pageInstanceId) ?? null
  }

  async getPageWatermark(pageInstanceId: string): Promise<CapturePageWatermark | null> {
    const last = this.high.get(pageInstanceId)
    return last === undefined ? null : { stateVersion: 1, lastAppliedSequence: last }
  }
}

// —— 消息构造 ——

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

const domPayload = {
  schemaVersion: 1,
  kind: 'dom_snapshot',
  captureVersion: CAPTURE_VERSION,
  reason: 'initial_readable',
  url: 'https://example.com/article',
  title: 'Example Article',
  contentEpoch: 0,
  html: '<html><body><main><p>hello capture</p></main></body></html>',
  stats: { nodeCount: 6, maxDepth: 4, htmlUtf8Bytes: 64 },
}

const grantedPayload = {
  schemaVersion: 1,
  kind: 'authorization_granted',
  captureVersion: CAPTURE_VERSION,
  url: 'https://example.com/',
  reason: 'user_gesture',
  origin: 'https://example.com',
}

interface BuiltTransfer {
  readonly envelope: ObservationEnvelope
  readonly payloadText: string
  readonly bytes: Uint8Array
  readonly payloadHash: string
  readonly announce: Record<string, unknown>
  readonly chunks: Record<string, unknown>[]
  readonly commit: Record<string, unknown>
}

/** 从 payload 对象构造完整合法传输序列（hash/chunkCount/字节数全部自洽）。 */
function buildTransfer(opts: {
  payload: unknown
  envelope?: Partial<ObservationEnvelope>
  chunkSize?: number
  transferId?: string
}): BuiltTransfer {
  const chunkSize = opts.chunkSize ?? 64
  const transferId = opts.transferId ?? 't-1'
  const payloadText = typeof opts.payload === 'string' ? opts.payload : JSON.stringify(opts.payload)
  const bytes = new TextEncoder().encode(payloadText)
  const payloadHash = sha256Of(bytes)
  const chunkCount = chunkCountFor(bytes.length, chunkSize)
  const envelope = envelopeOf({ payloadRef: payloadHash, payloadHash, ...opts.envelope })
  const announce = {
    type: 'announce',
    transferId,
    envelope,
    payloadBytes: bytes.length,
    payloadHash,
    chunkSize,
    chunkCount,
  }
  const chunks = Array.from({ length: chunkCount }, (_, index) => ({
    type: 'chunk',
    transferId,
    index,
    chunkCount,
    payloadHash,
    dataB64: bytesToBase64(bytes.slice(index * chunkSize, (index + 1) * chunkSize)),
  }))
  return {
    envelope,
    payloadText,
    bytes,
    payloadHash,
    announce,
    chunks,
    commit: { type: 'commit', transferId, payloadHash },
  }
}

async function expectFail(promise: Promise<unknown>, code: HostErrorCode): Promise<ErrorMsg> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(FailClosed)
  const response = (caught as FailClosed).response as ErrorMsg
  expect(response.type).toBe('error')
  expect(response.code).toBe(code)
  expect(response.fatal).toBe(true)
  expect(response.message.length).toBeLessThanOrEqual(256)
  return response
}

function makeHandler(store: FakeStore) {
  return createCaptureProtocolHandler({ store }).onMessage
}

// —— 测试 ——

describe('capture-protocol：hello / spike 兼容', () => {
  it('hello → welcome（协议常量一致）', async () => {
    const onMessage = makeHandler(new FakeStore())
    await expect(onMessage({ type: 'hello', protocolVersion: 1, client: 'sift-extension' })).resolves.toEqual({
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      host: 'sift-demo-host',
      storeReady: true,
    })
  })

  it('协议版本不匹配 → protocol_version_mismatch（fail-closed）', async () => {
    const onMessage = makeHandler(new FakeStore())
    await expectFail(onMessage({ type: 'hello', protocolVersion: 2, client: 'sift-extension' }), 'protocol_version_mismatch')
  })

  it('ping → pong 回归（E-03 spike 兼容，E2E harness 依赖）', async () => {
    const onMessage = makeHandler(new FakeStore())
    await expect(onMessage({ type: 'ping', id: 7, nonce: 'abc123' })).resolves.toEqual({
      type: 'pong',
      id: 7,
      nonce: 'abc123',
    })
  })

  it('schema 校验失败 → invalid_message', async () => {
    const onMessage = makeHandler(new FakeStore())
    await expectFail(onMessage({ type: 'mystery' }), 'invalid_message')
    await expectFail(onMessage({ type: 'announce' }), 'invalid_message')
  })

  it('hello 之前的 announce/chunk/commit → invalid_message', async () => {
    const onMessage = makeHandler(new FakeStore())
    const t = buildTransfer({ payload: grantedPayload })
    await expectFail(onMessage(t.announce), 'invalid_message')
  })
})

describe('capture-protocol：happy path', () => {
  it('announce → transfer_ack(ok) → stop-and-wait chunk_ack 累计字节 → commit → commit_ack；store 收到原始字节', async () => {
    const store = new FakeStore()
    const onMessage = makeHandler(store)
    await onMessage({ type: 'hello', protocolVersion: 1, client: 'sift-extension' })

    const t = buildTransfer({ payload: domPayload, chunkSize: 32 }) // html 较长 → 多 chunk
    expect(t.chunks.length).toBeGreaterThan(2)

    await expect(onMessage(t.announce)).resolves.toMatchObject({ type: 'transfer_ack', status: 'ok' })

    let cumulative = 0
    for (const chunk of t.chunks) {
      const decoded = t.bytes.subarray(cumulative, cumulative + 32).length
      cumulative += decoded
      await expect(onMessage(chunk)).resolves.toMatchObject({
        type: 'chunk_ack',
        index: chunk.index,
        receivedBytes: Math.min(cumulative, t.bytes.length),
      })
    }

    const ack = await onMessage(t.commit)
    expect(ack).toMatchObject({
      type: 'commit_ack',
      deduplicated: false,
      payloadHash: t.payloadHash,
      stateVersion: 1,
      lastAppliedSequence: t.envelope.sequence,
    })
    expect(store.appended).toHaveLength(1)
    expect(store.appended[0]?.envelope.id).toBe('obs-1')
    expect(Buffer.from(store.appended[0]?.payload ?? []).toString('utf8')).toBe(t.payloadText)
  })

  it('控制事件（authorization_granted）同样走完整 blob 管道', async () => {
    const store = new FakeStore()
    const onMessage = makeHandler(store)
    await onMessage({ type: 'hello', protocolVersion: 1, client: 'sift-extension' })

    const t = buildTransfer({
      payload: grantedPayload,
      envelope: { type: 'authorization_granted', id: 'obs-grant' },
    })
    await expect(onMessage(t.announce)).resolves.toMatchObject({ type: 'transfer_ack', status: 'ok' })
    for (const chunk of t.chunks) {
      await expect(onMessage(chunk)).resolves.toMatchObject({ type: 'chunk_ack' })
    }
    await expect(onMessage(t.commit)).resolves.toMatchObject({ type: 'commit_ack', deduplicated: false })
    expect(store.appended).toHaveLength(1)
  })

  it('capture_failed 控制事件走完整 blob 管道并落盘（P0_COVERAGE_MANIFEST_SPEC §9）', async () => {
    const store = new FakeStore()
    const onMessage = makeHandler(store)
    await onMessage({ type: 'hello', protocolVersion: 1, client: 'sift-extension' })

    const failedPayload = {
      schemaVersion: 1,
      kind: 'capture_failed',
      captureVersion: CAPTURE_VERSION,
      code: 'capture_too_little_content',
      instanceNonce: 'nonce-1',
      contentEpoch: 0,
    }
    const t = buildTransfer({
      payload: failedPayload,
      envelope: { type: 'capture_failed', id: 'obs-fail', sequence: 3 },
    })
    await expect(onMessage(t.announce)).resolves.toMatchObject({ type: 'transfer_ack', status: 'ok' })
    for (const chunk of t.chunks) {
      await expect(onMessage(chunk)).resolves.toMatchObject({ type: 'chunk_ack' })
    }
    await expect(onMessage(t.commit)).resolves.toMatchObject({
      type: 'commit_ack',
      deduplicated: false,
      lastAppliedSequence: 3,
    })
    expect(store.appended).toHaveLength(1)
    expect(store.appended[0]?.envelope.type).toBe('capture_failed')
    expect(JSON.parse(Buffer.from(store.appended[0]?.payload ?? []).toString('utf8'))).toEqual(failedPayload)
  })

  it('capture_failed payload 混入 detail（未知键）→ invalid_message，零写入（确定性防线）', async () => {
    const store = new FakeStore()
    const onMessage = makeHandler(store)
    await onMessage({ type: 'hello', protocolVersion: 1, client: 'sift-extension' })

    const t = buildTransfer({
      payload: {
        schemaVersion: 1,
        kind: 'capture_failed',
        captureVersion: CAPTURE_VERSION,
        code: 'capture_denied',
        instanceNonce: 'nonce-1',
        detail: 'readable-v1 未在 5000ms 内满足',
      },
      envelope: { type: 'capture_failed', id: 'obs-fail-detail' },
      transferId: 't-fail-detail',
    })
    await onMessage(t.announce)
    for (const c of t.chunks) await onMessage(c)
    await expectFail(onMessage(t.commit), 'invalid_message')
    expect(store.appended).toHaveLength(0)
  })

  it('同 transferId 重新 announce（SW commit_ack 超时重试）重置传输，chunk 从头可用', async () => {
    const store = new FakeStore()
    const onMessage = makeHandler(store)
    await onMessage({ type: 'hello', protocolVersion: 1, client: 'sift-extension' })

    const t = buildTransfer({
      payload: grantedPayload,
      envelope: { type: 'authorization_granted' },
      chunkSize: 1024, // 单 chunk
    })
    await expect(onMessage(t.announce)).resolves.toMatchObject({ status: 'ok' })
    await expect(onMessage(t.chunks[0])).resolves.toMatchObject({ type: 'chunk_ack', index: 0 })
    // 重试：重新 announce 同 transferId → 重置 → chunk 0 重新有效
    await expect(onMessage(t.announce)).resolves.toMatchObject({ status: 'ok' })
    await expect(onMessage(t.chunks[0])).resolves.toMatchObject({ type: 'chunk_ack', index: 0, receivedBytes: t.bytes.length })
    await expect(onMessage(t.commit)).resolves.toMatchObject({ type: 'commit_ack' })
    expect(store.appended).toHaveLength(1)
  })
})

describe('capture-protocol：三层去重', () => {
  async function committedOnMessage(): Promise<{ store: FakeStore; onMessage: (m: unknown) => Promise<unknown> }> {
    const store = new FakeStore()
    const onMessage = makeHandler(store)
    await onMessage({ type: 'hello', protocolVersion: 1, client: 'sift-extension' })
    return { store, onMessage }
  }

  async function runTransfer(onMessage: (m: unknown) => Promise<unknown>, t: BuiltTransfer): Promise<void> {
    await onMessage(t.announce)
    for (const chunk of t.chunks) await onMessage(chunk)
    await onMessage(t.commit)
  }

  it('层一：同 envelope.id 重复 announce → transfer_ack(deduplicated)，不再走 chunk', async () => {
    const { store, onMessage } = await committedOnMessage()
    const t = buildTransfer({ payload: domPayload })
    await runTransfer(onMessage, t)
    expect(store.appended).toHaveLength(1)

    const again = buildTransfer({ payload: domPayload }) // 同 id 同 payload → 同 hash
    await expect(onMessage(again.announce)).resolves.toMatchObject({ type: 'transfer_ack', status: 'deduplicated' })
    expect(store.appended).toHaveLength(1)
  })

  it('层一：同 id 异 hash → hash_mismatch（fail-closed）', async () => {
    const { onMessage } = await committedOnMessage()
    const first = buildTransfer({ payload: domPayload })
    await runTransfer(onMessage, first)

    const second = buildTransfer({
      payload: { ...domPayload, title: 'Changed' },
      envelope: { id: first.envelope.id },
    })
    await expectFail(onMessage(second.announce), 'hash_mismatch')
  })

  it('层二：同 (pageInstanceId, sequence) 同 hash → deduplicated；异 hash → sequence_violation', async () => {
    const { store, onMessage } = await committedOnMessage()
    const first = buildTransfer({ payload: domPayload, envelope: { sequence: 5 } })
    await runTransfer(onMessage, first)

    const sameSeqSameHash = buildTransfer({
      payload: domPayload,
      envelope: { id: 'obs-2', sequence: 5 },
    })
    await expect(onMessage(sameSeqSameHash.announce)).resolves.toMatchObject({ status: 'deduplicated' })
    expect(store.appended).toHaveLength(1)

    const sameSeqDiffHash = buildTransfer({
      payload: { ...domPayload, title: 'Also changed' },
      envelope: { id: 'obs-3', sequence: 5 },
    })
    await expectFail(onMessage(sameSeqDiffHash.announce), 'sequence_violation')
  })

  it('sequence 下降且未见 → sequence_violation；gap 接受', async () => {
    const { store, onMessage } = await committedOnMessage()
    const seq5 = buildTransfer({ payload: domPayload, envelope: { sequence: 5, id: 'obs-5' } })
    await runTransfer(onMessage, seq5)

    const seq3 = buildTransfer({
      payload: { ...domPayload, title: 'Older' },
      envelope: { sequence: 3, id: 'obs-3' },
    })
    await expectFail(onMessage(seq3.announce), 'sequence_violation')

    const seq9 = buildTransfer({
      payload: { ...domPayload, title: 'Newer' },
      envelope: { sequence: 9, id: 'obs-9' },
    })
    await expect(onMessage(seq9.announce)).resolves.toMatchObject({ status: 'ok' })
    for (const chunk of seq9.chunks) await onMessage(chunk)
    await expect(onMessage(seq9.commit)).resolves.toMatchObject({ type: 'commit_ack' })
    expect(store.appended).toHaveLength(2)
  })
})

describe('capture-protocol：chunk 状态机', () => {
  async function prepared(): Promise<(m: unknown) => Promise<unknown>> {
    const store = new FakeStore()
    const onMessage = makeHandler(store)
    await onMessage({ type: 'hello', protocolVersion: 1, client: 'sift-extension' })
    return onMessage
  }

  it('无在途 transfer 的 chunk → invalid_message', async () => {
    const onMessage = await prepared()
    const t = buildTransfer({ payload: grantedPayload })
    await expectFail(onMessage(t.chunks[0]), 'invalid_message')
  })

  it('index 乱序（跳块）→ invalid_message', async () => {
    const onMessage = await prepared()
    const t = buildTransfer({ payload: domPayload, chunkSize: 32 })
    await onMessage(t.announce)
    await expectFail(onMessage(t.chunks[1]), 'invalid_message')
  })

  it('陈旧重复块（index < expected-1）→ invalid_message', async () => {
    const onMessage = await prepared()
    const t = buildTransfer({ payload: domPayload, chunkSize: 32 })
    await onMessage(t.announce)
    await onMessage(t.chunks[0])
    await onMessage(t.chunks[1])
    await expectFail(onMessage(t.chunks[0]), 'invalid_message')
  })

  it('最近一块重发（ack 丢失）→ 幂等 chunk_ack（同累计字节，不重复缓存）', async () => {
    const onMessage = await prepared()
    const t = buildTransfer({ payload: domPayload, chunkSize: 32 })
    await onMessage(t.announce)
    const first = await onMessage(t.chunks[0])
    const resend = await onMessage(t.chunks[0])
    expect(resend).toEqual(first)
    // 后续 chunk 仍可正常推进并 commit
    for (const chunk of t.chunks.slice(1)) await onMessage(chunk)
    await expect(onMessage(t.commit)).resolves.toMatchObject({ type: 'commit_ack', deduplicated: false })
  })

  it('chunk 四要素与 announce 不一致（transferId/hash/chunkCount）→ invalid_message', async () => {
    const onMessage = await prepared()
    const t = buildTransfer({ payload: domPayload, chunkSize: 32, transferId: 't-a' })
    await onMessage(t.announce)
    await expectFail(onMessage({ ...t.chunks[0], transferId: 't-b' }), 'invalid_message')
    await expectFail(onMessage({ ...t.chunks[0], payloadHash: `sha256:${'1'.repeat(64)}` }), 'invalid_message')
    await expectFail(onMessage({ ...t.chunks[0], chunkCount: t.chunks.length + 1 }), 'invalid_message')
  })

  it('在途 transfer 时 announce 不同 transferId → invalid_message', async () => {
    const onMessage = await prepared()
    const t = buildTransfer({ payload: domPayload, transferId: 't-a' })
    await onMessage(t.announce)
    const other = buildTransfer({ payload: grantedPayload, envelope: { id: 'obs-2', sequence: 1 }, transferId: 't-b' })
    await expectFail(onMessage(other.announce), 'invalid_message')
  })

  it('累计字节超过 payloadBytes → payload_oversized', async () => {
    const onMessage = await prepared()
    const t = buildTransfer({ payload: grantedPayload, chunkSize: 16 })
    await onMessage(t.announce)
    for (const c of t.chunks.slice(0, -1)) await onMessage(c)
    // 篡改最后一块数据使其超长：累计字节超过 announce 声明的 payloadBytes
    const fat = new Uint8Array(64)
    await expectFail(
      onMessage({ ...t.chunks[t.chunks.length - 1], dataB64: bytesToBase64(fat) }),
      'payload_oversized',
    )
  })

  it('chunk 未收齐就 commit → invalid_message', async () => {
    const onMessage = await prepared()
    const t = buildTransfer({ payload: domPayload, chunkSize: 32 })
    await onMessage(t.announce)
    await onMessage(t.chunks[0])
    await expectFail(onMessage(t.commit), 'invalid_message')
  })

  it('无在途 transfer 的 commit → invalid_message；hash 与 announce 不一致 → invalid_message', async () => {
    const onMessage = await prepared()
    const t = buildTransfer({
      payload: grantedPayload,
      envelope: { type: 'authorization_granted' },
      chunkSize: 1024, // 单 chunk
    })
    await expectFail(onMessage(t.commit), 'invalid_message')
    await onMessage(t.announce)
    await onMessage(t.chunks[0])
    await expectFail(onMessage({ ...t.commit, payloadHash: `sha256:${'2'.repeat(64)}` }), 'invalid_message')
  })
})

describe('capture-protocol：commit 终审（fail-closed，store 零部分写入）', () => {
  async function prepared(): Promise<{ store: FakeStore; onMessage: (m: unknown) => Promise<unknown> }> {
    const store = new FakeStore()
    const onMessage = makeHandler(store)
    await onMessage({ type: 'hello', protocolVersion: 1, client: 'sift-extension' })
    return { store, onMessage }
  }

  it('chunk 数据被篡改 → sha256 不符 → hash_mismatch，store 未写入', async () => {
    const { store, onMessage } = await prepared()
    const t = buildTransfer({ payload: domPayload, chunkSize: 32 })
    await onMessage(t.announce)
    for (const chunk of t.chunks) {
      const tampered = chunk.index === 0
        ? { ...chunk, dataB64: bytesToBase64(new Uint8Array([0x41, 0x41, 0x41, 0x41])) }
        : chunk
      await onMessage(tampered)
    }
    await expectFail(onMessage(t.commit), 'hash_mismatch')
    expect(store.appended).toHaveLength(0)
  })

  it('重组长度与 payloadBytes 不符 → hash_mismatch，store 未写入', async () => {
    const { store, onMessage } = await prepared()
    // 真实 20 字节；声明 payloadBytes=26、chunkSize=64 → chunkCount=1 自洽，但重组只得 20
    const bytes = new TextEncoder().encode('short payload str!')
    const declared = bytes.length + 6
    const payloadHash = sha256Of(bytes)
    const envelope = envelopeOf({ payloadRef: payloadHash, payloadHash })
    await onMessage({
      type: 'announce',
      transferId: 't-short',
      envelope,
      payloadBytes: declared,
      payloadHash,
      chunkSize: 64,
      chunkCount: chunkCountFor(declared, 64),
    })
    await onMessage({
      type: 'chunk', transferId: 't-short', index: 0, chunkCount: 1, payloadHash,
      dataB64: bytesToBase64(bytes),
    })
    await expectFail(onMessage({ type: 'commit', transferId: 't-short', payloadHash }), 'hash_mismatch')
    expect(store.appended).toHaveLength(0)
  })

  it('payload 非合法 UTF-8 / 非合法 JSON / schema 不符 / 类型未开放 → invalid_message', async () => {
    // 每个 fail-closed 用例独立开 handler：生产中 fatal 即进程退出，状态机不复用
    // ——测试同理，每例全新 store + handler，最后统一断言零写入。

    // 非法 UTF-8（hash 自洽，长度自洽）
    {
      const { store, onMessage } = await prepared()
      const badBytes = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc])
      const badHash = sha256Of(badBytes)
      await onMessage({
        type: 'announce', transferId: 't-utf8', envelope: envelopeOf({ payloadRef: badHash, payloadHash: badHash }),
        payloadBytes: 4, payloadHash: badHash, chunkSize: 64, chunkCount: 1,
      })
      await onMessage({
        type: 'chunk', transferId: 't-utf8', index: 0, chunkCount: 1, payloadHash: badHash,
        dataB64: bytesToBase64(badBytes),
      })
      await expectFail(onMessage({ type: 'commit', transferId: 't-utf8', payloadHash: badHash }), 'invalid_message')
      expect(store.appended).toHaveLength(0)
    }

    // 非合法 JSON
    {
      const { store, onMessage } = await prepared()
      const notJson = buildTransfer({ payload: 'not json at all', transferId: 't-json' })
      await onMessage(notJson.announce)
      for (const c of notJson.chunks) await onMessage(c)
      await expectFail(onMessage(notJson.commit), 'invalid_message')
      expect(store.appended).toHaveLength(0)
    }

    // schema 不符（dom_snapshot 缺 stats）
    {
      const { store, onMessage } = await prepared()
      const badSchema = buildTransfer({
        payload: { schemaVersion: 1, kind: 'dom_snapshot', captureVersion: CAPTURE_VERSION, reason: 'initial_readable', url: 'https://example.com/a', title: 'x', contentEpoch: 0, html: '<p/>' },
        transferId: 't-schema',
      })
      await onMessage(badSchema.announce)
      for (const c of badSchema.chunks) await onMessage(c)
      await expectFail(onMessage(badSchema.commit), 'invalid_message')
      expect(store.appended).toHaveLength(0)
    }

    // P0 未开放的观察类型（payloadSchemaFor → null）
    {
      const { store, onMessage } = await prepared()
      const unopened = buildTransfer({
        payload: '{}',
        envelope: { type: 'navigation_metadata_changed' },
        transferId: 't-unopened',
      })
      await onMessage(unopened.announce)
      for (const c of unopened.chunks) await onMessage(c)
      await expectFail(onMessage(unopened.commit), 'invalid_message')
      expect(store.appended).toHaveLength(0)
    }
  })

  it('store 抛 quota_exceeded → error 帧 quota_exceeded；其它异常 → storage_error', async () => {
    {
      const { store, onMessage } = await prepared()
      const t = buildTransfer({
        payload: grantedPayload,
        envelope: { type: 'authorization_granted' },
        transferId: 't-quota',
      })
      await onMessage(t.announce)
      for (const c of t.chunks) await onMessage(c)

      store.failWith = Object.assign(new Error('disk quota'), { siftStoreError: 'quota_exceeded' })
      await expectFail(onMessage(t.commit), 'quota_exceeded')
      expect(store.appended).toHaveLength(0)
    }
    {
      const { store, onMessage } = await prepared()
      const t = buildTransfer({
        payload: grantedPayload,
        envelope: { type: 'authorization_granted' },
        transferId: 't-eio',
      })
      await onMessage(t.announce)
      for (const c of t.chunks) await onMessage(c)

      store.failWith = new Error('EIO')
      const response = await expectFail(onMessage(t.commit), 'storage_error')
      expect(response.message.includes('EIO')).toBe(false) // 固定文案：原始错误细节只走 stderr
      expect(store.appended).toHaveLength(0)
    }
  })
})
