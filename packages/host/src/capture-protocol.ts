// Capture 协议处理器（ADR-001 §9 步骤 3 正式协议；E-03 ping/pong 兼容保留）。
//
// 状态机（单 transfer，stop-and-wait）：
//   IDLE --announce--> ANNOUNCED --chunk--> BUFFERED --commit--> COMMITTED --> IDLE
//
// 已冻结的语义（AGENTS 验收门 5 / ADR-001 E-04，全部 fail-closed）：
//  - schema 不符 / 未见 announce 的 chunk / index 乱序 -> invalid_message；
//  - 重组后长度或 sha256 与 announce 不符 -> hash_mismatch；
//  - 累计字节数超过 payloadBytes -> payload_oversized；
//  - sequence（per pageInstanceId）：已见 (seq,hash) -> 幂等去重；
//    同 seq 异 hash 或未见且 ≤ 高水位 -> sequence_violation；gap 接受（store 记诊断）；
//  - 一切协议完整性错误：先回 error 帧（fatal:true），随后 host 进程失败关闭；
//  - 幂等 commit 只有在 store 完成"staging -> 校验 -> rename -> journal -> page-state"
//    全链后才回 commit_ack；重复 commit 在 announce 阶段被 transfer_ack(deduplicated) 短路。
//
// Store 依赖以结构化接口注入（fs-store 实现同一形状），本包不依赖 @sift/store。
import { createHash } from 'node:crypto'
import {
  extensionMessageSchema,
  payloadSchemaFor,
  type ObservationEnvelope,
} from '@sift/shared'
import {
  CAPTURE_VERSION,
  PROTOCOL_VERSION,
  REDACTION_POLICY,
  base64ToBytes,
  type AnnounceMsg,
  type ErrorMsg,
  type HostErrorCode,
  type HostMessage,
} from '@sift/shared/wire'
import { FailClosed } from './host-loop'
import { isSpikePing, spikePongHandler } from './protocol'

// —— Store 注入接口（fs-store / 测试 fake 实现同一形状） ——

export interface CaptureObservationRef {
  readonly payloadHash: string
}

export interface CapturePageWatermark {
  readonly stateVersion: number
  readonly lastAppliedSequence: number
}

export interface CaptureCommitResult {
  readonly deduplicated: boolean
  readonly payloadHash: string
  /** 仅 dom_snapshot 落盘后有值（page-state 替换结果）；控制事件为 null。 */
  readonly stateVersion: number | null
  readonly lastAppliedSequence: number | null
}

/** Store 错误按 `siftStoreError` 字段结构化分类（fs-store 抛出的错误带该字段）。 */
export interface CaptureStore {
  appendObservation(envelope: ObservationEnvelope, payload: Uint8Array): Promise<CaptureCommitResult>
  findObservationById(id: string): Promise<CaptureObservationRef | null>
  findObservationBySequence(pageInstanceId: string, sequence: number): Promise<CaptureObservationRef | null>
  getSequenceHighWater(pageInstanceId: string): Promise<number | null>
  getPageWatermark(pageInstanceId: string): Promise<CapturePageWatermark | null>
}

export interface CaptureProtocolOptions {
  readonly store: CaptureStore
}

interface TransferState {
  readonly transferId: string
  readonly envelope: ObservationEnvelope
  readonly payloadBytes: number
  readonly payloadHash: string
  readonly chunkCount: number
  /** 下一个应接收的 chunk index。 */
  expectedIndex: number
  receivedBytes: number
  readonly chunks: Uint8Array[]
}

// —— 工具 ——

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 错误帧：message 为固定文案（≤256 字符），不插入任何不可信输入（URL/正文防泄漏）。 */
function errorMsg(code: HostErrorCode, message: string, transferId?: string): ErrorMsg {
  return { type: 'error', code, message, fatal: true, ...(transferId !== undefined ? { transferId } : {}) }
}

function fail(code: HostErrorCode, message: string, transferId?: string): never {
  throw new FailClosed(errorMsg(code, message, transferId))
}

function classifyStoreError(error: unknown): HostErrorCode {
  const code = (error as { siftStoreError?: unknown } | null)?.siftStoreError
  if (code === 'quota_exceeded') return 'quota_exceeded'
  return 'storage_error'
}

// —— 处理器 ——

export function createCaptureProtocolHandler(opts: CaptureProtocolOptions) {
  const { store } = opts
  let helloDone = false
  let active: TransferState | null = null

  const onAnnounce = async (msg: AnnounceMsg): Promise<HostMessage> => {
    const { envelope } = msg
    // 同 transferId 重新 announce = SW 侧 commit_ack 超时重试（合法）；
    // 不同 transferId 且仍有在途 transfer = 协议违规
    if (active !== null && active.transferId !== msg.transferId) {
      fail('invalid_message', 'announce：已有在途 transfer', msg.transferId)
    }

    // 幂等预检之一：envelope.id 已 commit
    const byId = await store.findObservationById(envelope.id)
    if (byId !== null) {
      if (byId.payloadHash !== msg.payloadHash) {
        fail('hash_mismatch', 'announce：同 id 异 hash', msg.transferId)
      }
      active = null
      return { type: 'transfer_ack', transferId: msg.transferId, status: 'deduplicated' }
    }

    // 幂等预检之二：同 (pageInstanceId, sequence) 已 commit
    const bySeq = await store.findObservationBySequence(envelope.pageInstanceId, envelope.sequence)
    if (bySeq !== null) {
      if (bySeq.payloadHash !== msg.payloadHash) {
        fail('sequence_violation', 'announce：同 sequence 异 hash', msg.transferId)
      }
      active = null
      return { type: 'transfer_ack', transferId: msg.transferId, status: 'deduplicated' }
    }

    // sequence 单调性：未见过的观察，sequence 必须大于该页面实例已见高水位
    const high = await store.getSequenceHighWater(envelope.pageInstanceId)
    if (high !== null && envelope.sequence <= high) {
      fail('sequence_violation', 'announce：sequence 回落且未见', msg.transferId)
    }

    active = {
      transferId: msg.transferId,
      envelope,
      payloadBytes: msg.payloadBytes,
      payloadHash: msg.payloadHash,
      chunkCount: msg.chunkCount,
      expectedIndex: 0,
      receivedBytes: 0,
      chunks: [],
    }
    return { type: 'transfer_ack', transferId: msg.transferId, status: 'ok' }
  }

  const onChunk = (msg: Extract<import('@sift/shared/wire').ExtensionMessage, { type: 'chunk' }>): HostMessage => {
    if (active === null || active.transferId !== msg.transferId) {
      fail('invalid_message', 'chunk：无在途 transfer', msg.transferId)
    }
    if (msg.payloadHash !== active.payloadHash || msg.chunkCount !== active.chunkCount) {
      fail('invalid_message', 'chunk：与 announce 不一致', msg.transferId)
    }
    if (msg.index === active.expectedIndex - 1) {
      // ack 丢失后的同块重发：幂等重发 ack，不重复缓存
      return { type: 'chunk_ack', transferId: msg.transferId, index: msg.index, receivedBytes: active.receivedBytes }
    }
    if (msg.index !== active.expectedIndex) {
      fail('invalid_message', 'chunk：index 乱序', msg.transferId)
    }
    const bytes = base64ToBytes(msg.dataB64)
    const received = active.receivedBytes + bytes.length
    if (received > active.payloadBytes) {
      fail('payload_oversized', 'chunk：累计字节超过 payloadBytes', msg.transferId)
    }
    active.chunks.push(bytes)
    active.receivedBytes = received
    active.expectedIndex += 1
    return { type: 'chunk_ack', transferId: msg.transferId, index: msg.index, receivedBytes: received }
  }

  const onCommit = async (msg: { transferId: string; payloadHash: string }): Promise<HostMessage> => {
    if (active === null || active.transferId !== msg.transferId) {
      fail('invalid_message', 'commit：无在途 transfer', msg.transferId)
    }
    if (msg.payloadHash !== active.payloadHash) {
      fail('invalid_message', 'commit：与 announce 不一致', msg.transferId)
    }
    if (active.expectedIndex !== active.chunkCount) {
      fail('invalid_message', 'commit：chunk 未收齐', msg.transferId)
    }
    const total = new Uint8Array(active.receivedBytes)
    let offset = 0
    for (const chunk of active.chunks) {
      total.set(chunk, offset)
      offset += chunk.length
    }
    if (total.length !== active.payloadBytes) {
      fail('hash_mismatch', 'commit：重组长度不符', msg.transferId)
    }
    const hashHex = sha256Hex(total)
    if (`sha256:${hashHex}` !== active.payloadHash) {
      fail('hash_mismatch', 'commit：sha256 不符', msg.transferId)
    }

    // payload 终审：UTF-8 -> JSON -> 按 envelope.type 的 zod schema
    let payloadText: string
    try {
      payloadText = new TextDecoder(undefined, { fatal: true }).decode(total)
    } catch {
      fail('invalid_message', 'commit：payload 非合法 UTF-8', msg.transferId)
    }
    let payloadJson: unknown
    try {
      payloadJson = JSON.parse(payloadText)
    } catch {
      fail('invalid_message', 'commit：payload 非合法 JSON', msg.transferId)
    }
    const schema = payloadSchemaFor(active.envelope.type)
    if (schema === null) {
      fail('invalid_message', 'commit：该观察类型无 payload schema', msg.transferId)
    }
    if (!schema.safeParse(payloadJson).success) {
      fail('invalid_message', 'commit：payload schema 校验失败', msg.transferId)
    }

    let result: CaptureCommitResult
    try {
      result = await store.appendObservation(active.envelope, total)
    } catch (error) {
      // message 用固定文案：原始错误的细节（可能含本地路径）只走 stderr/onFatal，不进线协议
      fail(classifyStoreError(error), 'commit：store 写入失败', msg.transferId)
    }
    const ack: HostMessage = {
      type: 'commit_ack',
      transferId: msg.transferId,
      deduplicated: result.deduplicated,
      payloadHash: result.payloadHash,
      stateVersion: result.stateVersion ?? 0,
      lastAppliedSequence: result.lastAppliedSequence ?? active.envelope.sequence,
    }
    active = null
    return ack
  }

  return {
    /** runNativeHostLoop 的 onMessage：返回响应帧，或抛 FailClosed（先响应后失败关闭）。 */
    async onMessage(message: unknown): Promise<unknown | null> {
      // E-03 spike 兼容：真实 Chrome E2E harness 依赖 ping -> pong
      if (isSpikePing(message)) return spikePongHandler(message)

      const parsed = extensionMessageSchema.safeParse(message)
      if (!parsed.success) {
        fail('invalid_message', '消息 schema 校验失败')
      }
      const msg = parsed.data
      switch (msg.type) {
        case 'hello':
          if (msg.protocolVersion !== PROTOCOL_VERSION) {
            fail('protocol_version_mismatch', 'hello：协议版本不匹配')
          }
          helloDone = true
          return { type: 'welcome', protocolVersion: PROTOCOL_VERSION, host: 'sift-demo-host', storeReady: true }
        case 'announce':
          if (!helloDone) fail('invalid_message', 'announce：hello 未完成')
          return await onAnnounce(msg)
        case 'chunk':
          if (!helloDone) fail('invalid_message', 'chunk：hello 未完成')
          return onChunk(msg)
        case 'commit':
          if (!helloDone) fail('invalid_message', 'commit：hello 未完成')
          return await onCommit(msg)
      }
    },
  }
}

/** 供构造端（host-main / 测试）核对协议常量的再导出。 */
export { CAPTURE_VERSION, PROTOCOL_VERSION, REDACTION_POLICY }
