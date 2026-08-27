// Capture 线协议 schema 正反例 + wire 纯工具（base64/chunk 数学）单元测试。
import { describe, expect, it } from 'vitest'
import {
  CONTROL_PAYLOAD_MAX_BYTES,
  SHA256_HASH_PATTERN,
  base64ToBytes,
  bytesToBase64,
  chunkCountFor,
  payloadMaxBytesFor,
} from '../src/wire'
import {
  authorizationGrantedPayloadSchema,
  domSnapshotPayloadSchema,
  extensionMessageSchema,
  hostMessageSchema,
  payloadSchemaFor,
} from '../src/index'

const HASH = `sha256:${'a'.repeat(64)}`

const validEnvelope = {
  schemaVersion: 1,
  id: 'obs-1',
  sessionId: 'sess-1',
  tabId: 'tab-1',
  pageInstanceId: 'page-inst-1',
  contentEpoch: 0,
  sequence: 0,
  receivedAt: '2026-08-27T00:00:00.000Z',
  url: 'https://example.com/articles/1',
  source: 'extension',
  type: 'document_started',
  payloadRef: HASH,
  payloadHash: HASH,
  redactionPolicy: 'sensitive-v1',
  captureVersion: 'capture-v1',
}

const validAnnounce = {
  type: 'announce',
  transferId: 'tr-1',
  envelope: validEnvelope,
  payloadBytes: 100,
  payloadHash: HASH,
  chunkSize: 64,
  chunkCount: 2,
}

describe('extensionMessageSchema 正例', () => {
  it('hello / announce / chunk / commit 均通过', () => {
    expect(extensionMessageSchema.parse({ type: 'hello', protocolVersion: 1, client: 'sift-extension' })).toBeTruthy()
    expect(extensionMessageSchema.parse(validAnnounce)).toBeTruthy()
    expect(
      extensionMessageSchema.parse({
        type: 'chunk',
        transferId: 'tr-1',
        index: 0,
        chunkCount: 2,
        payloadHash: HASH,
        dataB64: 'QUJDREVG', // "ABCDEF"
      }),
    ).toBeTruthy()
    expect(extensionMessageSchema.parse({ type: 'commit', transferId: 'tr-1', payloadHash: HASH })).toBeTruthy()
  })
})

describe('extensionMessageSchema 反例', () => {
  it('未知 type 拒绝', () => {
    expect(extensionMessageSchema.safeParse({ type: 'shout' }).success).toBe(false)
  })

  it('hello 携带未知键拒绝（strict）', () => {
    expect(
      extensionMessageSchema.safeParse({ type: 'hello', protocolVersion: 1, client: 'sift-extension', extra: 1 }).success,
    ).toBe(false)
  })

  it('announce.payloadHash 与 envelope.payloadHash 不一致拒绝（三处一致）', () => {
    const other = `sha256:${'b'.repeat(64)}`
    const bad = { ...validAnnounce, payloadHash: other }
    expect(extensionMessageSchema.safeParse(bad).success).toBe(false)
  })

  it('envelope.payloadRef ≠ payloadHash 拒绝', () => {
    const other = `sha256:${'b'.repeat(64)}`
    const bad = { ...validAnnounce, envelope: { ...validEnvelope, payloadRef: other } }
    expect(extensionMessageSchema.safeParse(bad).success).toBe(false)
  })

  it('chunkCount 与 ceil(payloadBytes/chunkSize) 不一致拒绝', () => {
    const bad = { ...validAnnounce, chunkCount: 3 }
    expect(extensionMessageSchema.safeParse(bad).success).toBe(false)
  })

  it('chunkSize 超过 NATIVE_MAX_CHUNK_BYTES 拒绝', () => {
    const bad = { ...validAnnounce, chunkSize: 256 * 1024 + 1, chunkCount: 1 }
    expect(extensionMessageSchema.safeParse(bad).success).toBe(false)
  })

  it('非 snapshot 观察的 payloadBytes 超过控制事件上限拒绝', () => {
    const bad = { ...validAnnounce, payloadBytes: CONTROL_PAYLOAD_MAX_BYTES + 1, chunkSize: 64 * 1024, chunkCount: 2 }
    expect(extensionMessageSchema.safeParse(bad).success).toBe(false)
  })

  it('dom_snapshot 的 payloadBytes 允许到 SNAPSHOT_MAX_BYTES', () => {
    const ok = {
      ...validAnnounce,
      envelope: { ...validEnvelope, type: 'dom_snapshot', source: 'dom' },
      payloadBytes: 5 * 1024 * 1024,
      chunkSize: 256 * 1024,
      chunkCount: 20,
    }
    expect(extensionMessageSchema.safeParse(ok).success).toBe(true)
  })

  it('chunk.index ≥ chunkCount 拒绝', () => {
    const bad = { type: 'chunk', transferId: 'tr-1', index: 2, chunkCount: 2, payloadHash: HASH, dataB64: 'QUJD' }
    expect(extensionMessageSchema.safeParse(bad).success).toBe(false)
  })

  it('dataB64 非规范 base64 拒绝（URL-safe 变体 / 空白 / 长度非 4 倍数）', () => {
    for (const dataB64 of ['QUJD REVG', 'QUJDRE', 'A===', 'AB-CD']) {
      const bad = { type: 'chunk', transferId: 'tr-1', index: 0, chunkCount: 1, payloadHash: HASH, dataB64 }
      expect(extensionMessageSchema.safeParse(bad).success, dataB64).toBe(false)
    }
  })

  it('pageInstanceId 含路径穿越字符拒绝（落盘路径防御）', () => {
    for (const pageInstanceId of ['../..', 'a/b', 'a\\b', 'x'.repeat(65), '']) {
      const bad = { ...validAnnounce, envelope: { ...validEnvelope, pageInstanceId } }
      expect(extensionMessageSchema.safeParse(bad).success, JSON.stringify(pageInstanceId)).toBe(false)
    }
  })

  it('payloadHash 非 sha256 形状拒绝', () => {
    const bad = { ...validAnnounce, payloadHash: 'sha256:abc', envelope: { ...validEnvelope, payloadRef: 'sha256:abc' } }
    expect(extensionMessageSchema.safeParse(bad).success).toBe(false)
  })

  it('redactionPolicy / captureVersion 非冻结字面量拒绝', () => {
    for (const [key, value] of [['redactionPolicy', 'loose-v0'], ['captureVersion', 'capture-v2']] as const) {
      const bad = { ...validAnnounce, envelope: { ...validEnvelope, [key]: value } }
      expect(extensionMessageSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('负数 sequence / 未来数据平面 source 拒绝（envelope 基础约束透传）', () => {
    expect(extensionMessageSchema.safeParse({ ...validAnnounce, envelope: { ...validEnvelope, sequence: -1 } }).success).toBe(false)
    expect(extensionMessageSchema.safeParse({ ...validAnnounce, envelope: { ...validEnvelope, source: 'network' } }).success).toBe(false)
  })
})

describe('hostMessageSchema', () => {
  it('welcome / transfer_ack / chunk_ack / commit_ack / error 均通过', () => {
    expect(hostMessageSchema.parse({ type: 'welcome', protocolVersion: 1, host: 'sift-demo-host', storeReady: true })).toBeTruthy()
    expect(hostMessageSchema.parse({ type: 'transfer_ack', transferId: 'tr-1', status: 'ok' })).toBeTruthy()
    expect(hostMessageSchema.parse({ type: 'chunk_ack', transferId: 'tr-1', index: 0, receivedBytes: 64 })).toBeTruthy()
    expect(
      hostMessageSchema.parse({ type: 'commit_ack', transferId: 'tr-1', deduplicated: false, payloadHash: HASH, stateVersion: 1, lastAppliedSequence: 0 }),
    ).toBeTruthy()
    expect(hostMessageSchema.parse({ type: 'error', code: 'hash_mismatch', message: 'x', fatal: true })).toBeTruthy()
  })

  it('error.message 超过 256 字符拒绝（防泄漏截断契约）', () => {
    const bad = { type: 'error', code: 'storage_error', message: 'x'.repeat(257), fatal: true }
    expect(hostMessageSchema.safeParse(bad).success).toBe(false)
  })

  it('未知错误码拒绝', () => {
    const bad = { type: 'error', code: 'meh', message: 'x', fatal: true }
    expect(hostMessageSchema.safeParse(bad).success).toBe(false)
  })
})

describe('payload schema', () => {
  const validSnapshot = {
    schemaVersion: 1,
    kind: 'dom_snapshot',
    captureVersion: 'capture-v1',
    reason: 'initial_readable',
    url: 'https://example.com/a',
    title: '示例',
    contentEpoch: 0,
    html: '<html><body><p>hello</p></body></html>',
    stats: { nodeCount: 5, maxDepth: 3, htmlUtf8Bytes: 40 },
  }

  it('合法 dom_snapshot payload 通过；未知键拒绝（确定性序列化防线）', () => {
    expect(domSnapshotPayloadSchema.parse(validSnapshot)).toBeTruthy()
    expect(domSnapshotPayloadSchema.safeParse({ ...validSnapshot, extra: 1 }).success).toBe(false)
    expect(domSnapshotPayloadSchema.safeParse({ ...validSnapshot, stats: { ...validSnapshot.stats, extra: 1 } }).success).toBe(false)
  })

  it('reason 枚举外拒绝', () => {
    expect(domSnapshotPayloadSchema.safeParse({ ...validSnapshot, reason: 'manual' }).success).toBe(false)
  })

  it('authorization_granted payload：origin 必填、reason 冻结为 user_gesture', () => {
    expect(
      authorizationGrantedPayloadSchema.parse({
        schemaVersion: 1, kind: 'authorization_granted', captureVersion: 'capture-v1',
        url: 'https://example.com/', origin: 'https://example.com', reason: 'user_gesture',
      }),
    ).toBeTruthy()
    expect(
      authorizationGrantedPayloadSchema.safeParse({
        schemaVersion: 1, kind: 'authorization_granted', captureVersion: 'capture-v1',
        url: 'https://example.com/', reason: 'user_gesture',
      }).success,
    ).toBe(false)
  })

  it('payloadSchemaFor：4 种首期事件有 schema，其余返回 null（fail-closed）', () => {
    expect(payloadSchemaFor('dom_snapshot')).toBe(domSnapshotPayloadSchema)
    expect(payloadSchemaFor('authorization_granted')).toBe(authorizationGrantedPayloadSchema)
    expect(payloadSchemaFor('authorization_revoked')).not.toBeNull()
    expect(payloadSchemaFor('document_started')).not.toBeNull()
    expect(payloadSchemaFor('navigation_metadata_changed')).toBeNull()
    expect(payloadSchemaFor('dom_mutation_trigger')).toBeNull()
    expect(payloadSchemaFor('capture_paused')).toBeNull()
  })
})

describe('wire 纯工具', () => {
  it('base64 往返：空 / 1 / 2 / 3 / 跨块字节数', () => {
    for (const len of [0, 1, 2, 3, 4, 255, 256, 1000, 70000]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 7 + 13) % 256)
      const encoded = bytesToBase64(bytes)
      expect(encoded.length % 4).toBe(0)
      const decoded = base64ToBytes(encoded)
      expect(Array.from(decoded)).toEqual(Array.from(bytes))
    }
  })

  it('base64ToBytes 对非法输入抛错', () => {
    expect(() => base64ToBytes('A')).toThrow()
    expect(() => base64ToBytes('====')).toThrow()
    expect(() => base64ToBytes('AB CD')).toThrow()
    expect(() => base64ToBytes('AB-CD')).toThrow()
  })

  it('chunkCountFor = max(1, ceil(bytes/size))', () => {
    expect(chunkCountFor(1, 256 * 1024)).toBe(1)
    expect(chunkCountFor(256 * 1024, 256 * 1024)).toBe(1)
    expect(chunkCountFor(256 * 1024 + 1, 256 * 1024)).toBe(2)
  })

  it('payloadMaxBytesFor：dom_snapshot 用 SNAPSHOT_MAX_BYTES，其余用控制事件上限', () => {
    expect(payloadMaxBytesFor('dom_snapshot')).toBe(5 * 1024 * 1024)
    expect(payloadMaxBytesFor('document_started')).toBe(CONTROL_PAYLOAD_MAX_BYTES)
  })

  it('SHA256_HASH_PATTERN 形状', () => {
    expect(SHA256_HASH_PATTERN.test(HASH)).toBe(true)
    expect(SHA256_HASH_PATTERN.test('sha256:ABC')).toBe(false)
    expect(SHA256_HASH_PATTERN.test('blake3:abc')).toBe(false)
  })
})
