// Capture 线协议（Extension service worker ↔ Native Host）——纯类型与纯函数层。
//
// 分层约束（ADR-001 §1）：本模块与 limits/tokens 一样，允许被 MV3 content script /
// service worker import，因此**只允许纯 JS**：零运行时依赖、零 node:/浏览器专属 API、
// 零副作用（esbuild 直接入 bundle）。严格 zod 校验在主入口 capture.ts（仅桌面/Host 侧）。
//
// 协议语义（P0_EXTENSION_ARCHITECTURE §5 / CAPTURE_ARCHITECTURE）：
//  - 每次传输突发：hello → welcome →（每条观察）announce → transfer_ack →
//    chunk×N（stop-and-wait，每个 chunk 等 chunk_ack）→ commit → commit_ack；
//  - Host 端错误一律 fail-closed：先回 error 帧（fatal:true），随后 host 进程退出；
//  - sequence 由生产端（SW）保证严格递增；Host 端容忍非减（幂等重发去重）与 gap
//    （记入 page-state 诊断），严格下降且未见 → sequence_violation（CAPTURE §3 的
//    单调性约束作用于生产者，Host 侧宽容是断线重连幂等的必要条件）；
//  - chunk 四要素 transferId/index/chunkCount/payloadHash 逐字段齐全
//    （P0_EXTENSION_ARCHITECTURE §5 字面要求）。
import { NATIVE_MAX_CHUNK_BYTES, SNAPSHOT_MAX_BYTES } from './limits'
import type { ObservationEnvelope } from './envelope'

/** 线协议版本；hello/welcome 双方必须一致，不一致即 protocol_version_mismatch。 */
export const PROTOCOL_VERSION = 1

/** 冻结的捕获/脱敏版本标识（写入 envelope 的 captureVersion / redactionPolicy）。 */
export const CAPTURE_VERSION = 'capture-v1'
export const REDACTION_POLICY = 'sensitive-v1'

/** 控制事件（非 dom_snapshot）payload 的字节上限。 */
export const CONTROL_PAYLOAD_MAX_BYTES = 64 * 1024

/**
 * pageInstanceId 是唯一参与落盘路径的不可信字段（page-states/&lt;pageInstanceId&gt;.json），
 * 字符集收紧即路径穿越防御；envelope.ts 冻结 schema 只保证 min(1)，此处叠加。
 */
export const PAGE_INSTANCE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/

/** payload 内容寻址引用格式：sha256 + 小写 hex（envelope.payloadRef === payloadHash）。 */
export const SHA256_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

/** SW 生成的 transferId（crypto.randomUUID，跨重试保持不变——幂等键之一）。 */
export type TransferId = string

/** Host 错误码（全部按 fatal 处理：回 error 帧后 fail-closed 退出）。 */
export type HostErrorCode =
  | 'protocol_version_mismatch'
  | 'invalid_message'
  | 'hash_mismatch'
  | 'payload_oversized'
  | 'sequence_violation'
  | 'quota_exceeded'
  | 'storage_error'
  | 'internal_error'

// —— Extension → Host ——

export interface HelloMsg {
  readonly type: 'hello'
  readonly protocolVersion: number
  readonly client: 'sift-extension'
}

export interface AnnounceMsg {
  readonly type: 'announce'
  readonly transferId: TransferId
  /** 完整 ObservationEnvelope；receivedAt 由 SW 填写，Host 侧 strict schema 严校验。 */
  readonly envelope: ObservationEnvelope
  /** 解码后的 payload 字节数。 */
  readonly payloadBytes: number
  readonly payloadHash: string
  /** 每块解码后字节上限（≤ NATIVE_MAX_CHUNK_BYTES）。 */
  readonly chunkSize: number
  readonly chunkCount: number
}

export interface ChunkMsg {
  readonly type: 'chunk'
  readonly transferId: TransferId
  /** 0-based。 */
  readonly index: number
  readonly chunkCount: number
  readonly payloadHash: string
  /** base64(≤256KiB 解码后字节)。 */
  readonly dataB64: string
}

export interface CommitMsg {
  readonly type: 'commit'
  readonly transferId: TransferId
  readonly payloadHash: string
}

export type ExtensionMessage = HelloMsg | AnnounceMsg | ChunkMsg | CommitMsg

// —— Host → Extension（全部小消息）——

export interface WelcomeMsg {
  readonly type: 'welcome'
  readonly protocolVersion: number
  readonly host: 'sift-demo-host'
  readonly storeReady: boolean
}

export interface TransferAckMsg {
  readonly type: 'transfer_ack'
  readonly transferId: TransferId
  /** deduplicated = envelope.id 已 commit，SW 免发后续 chunk。 */
  readonly status: 'ok' | 'deduplicated'
}

export interface ChunkAckMsg {
  readonly type: 'chunk_ack'
  readonly transferId: TransferId
  readonly index: number
  /** 累计已收解码字节数（SW 校验进度）。 */
  readonly receivedBytes: number
}

export interface CommitAckMsg {
  readonly type: 'commit_ack'
  readonly transferId: TransferId
  readonly deduplicated: boolean
  readonly payloadHash: string
  /** 落盘后的 page state 版本（诊断用）。 */
  readonly stateVersion: number
  readonly lastAppliedSequence: number
}

export interface ErrorMsg {
  readonly type: 'error'
  readonly transferId?: TransferId
  readonly code: HostErrorCode
  /** ≤256 字符；不含 URL 原文与正文（防泄漏）。 */
  readonly message: string
  readonly fatal: true
}

export type HostMessage =
  | WelcomeMsg
  | TransferAckMsg
  | ChunkAckMsg
  | CommitAckMsg
  | ErrorMsg

// —— payload（CS 构造、SW 组包、Host 校验）——
//
// 确定性要求（CAPTURE_ARCHITECTURE：同 DOM → 同 payload 字节 → 同 hash）：
// payload JSON 由固定字面量键序构造、无缩进；**payload 内零时间戳、零随机数**
// （时间只在 envelope.receivedAt、身份只在 envelope.id——hash 只覆盖 payload 字节）。
// 注意 reason 不同 → hash 不同（诊断优先，可接受的 blob 重复）。

export interface DomSnapshotStats {
  readonly nodeCount: number
  readonly maxDepth: number
  readonly htmlUtf8Bytes: number
}

export interface DomSnapshotPayload {
  readonly schemaVersion: 1
  readonly kind: 'dom_snapshot'
  readonly captureVersion: 'capture-v1'
  readonly reason: 'initial_readable' | 'mutation_merged'
  /** sanitizeUrl 后的 safeUrl。 */
  readonly url: string
  /** sanitizeTitle 后的标题。 */
  readonly title: string
  readonly contentEpoch: number
  /** 脱敏克隆的 documentElement.outerHTML。 */
  readonly html: string
  readonly stats: DomSnapshotStats
}

export interface AuthorizationGrantedPayload {
  readonly schemaVersion: 1
  readonly kind: 'authorization_granted'
  readonly captureVersion: 'capture-v1'
  readonly url: string
  readonly title?: string
  readonly reason: 'user_gesture'
  /** 授权时刻的 origin（activeTab 授予面）。 */
  readonly origin: string
}

export interface AuthorizationRevokedPayload {
  readonly schemaVersion: 1
  readonly kind: 'authorization_revoked'
  readonly captureVersion: 'capture-v1'
  readonly url: string
  readonly reason: 'cross_origin' | 'tab_closed' | 'port_error' | 'sw_shutdown'
}

export interface DocumentStartedPayload {
  readonly schemaVersion: 1
  readonly kind: 'document_started'
  readonly captureVersion: 'capture-v1'
  readonly url: string
  readonly title?: string
  /** CS 实例标识（SW 据此识别 CS 换代/同源重注入）。 */
  readonly instanceNonce: string
  readonly sameOriginReinject: boolean
}

export type CapturePayload =
  | DomSnapshotPayload
  | AuthorizationGrantedPayload
  | AuthorizationRevokedPayload
  | DocumentStartedPayload

// —— 纯工具 ——

/** 分块数 = max(1, ceil(payloadBytes / chunkSize))。 */
export function chunkCountFor(payloadBytes: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(payloadBytes / chunkSize))
}

/** payload 字节上限按 envelope.type 区分（dom_snapshot 用冻结的 SNAPSHOT_MAX_BYTES）。 */
export function payloadMaxBytesFor(observationType: ObservationEnvelope['type']): number {
  return observationType === 'dom_snapshot' ? SNAPSHOT_MAX_BYTES : CONTROL_PAYLOAD_MAX_BYTES
}

export function chunkMaxBytes(): number {
  return NATIVE_MAX_CHUNK_BYTES
}

// —— base64（SW 无 Node Buffer；schema refine 与 transport 共用同一实现）——

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 规范 base64（含 padding；无 whitespace/URL-safe 变体）。 */
export const BASE64_CANONICAL_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const has1 = i + 1 < bytes.length
    const has2 = i + 2 < bytes.length
    const b1 = has1 ? (bytes[i + 1] ?? 0) : 0
    const b2 = has2 ? (bytes[i + 2] ?? 0) : 0
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += has1 ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '='
    out += has2 ? B64_ALPHABET[b2 & 0x3f] : '='
  }
  return out
}

/** 非法输入抛 Error（schema refine 与 Host 侧共用：抛错即校验失败）。 */
export function base64ToBytes(text: string): Uint8Array {
  if (text.length % 4 !== 0 || !BASE64_CANONICAL_PATTERN.test(text)) {
    throw new Error('wire: invalid base64 (canonical form required)')
  }
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const out = new Uint8Array((text.length >> 2) * 3 - padding)
  const sextet = (ch: string): number => {
    if (ch === '=') return 0
    const v = B64_ALPHABET.indexOf(ch)
    if (v < 0) throw new Error('wire: invalid base64 character')
    return v
  }
  let o = 0
  for (let i = 0; i < text.length; i += 4) {
    const v0 = sextet(text[i] ?? '')
    const v1 = sextet(text[i + 1] ?? '')
    const v2 = sextet(text[i + 2] ?? '')
    const v3 = sextet(text[i + 3] ?? '')
    out[o] = (v0 << 2) | (v1 >> 4)
    o += 1
    if (o < out.length) {
      out[o] = ((v1 & 0x0f) << 4) | (v2 >> 2)
      o += 1
    }
    if (o < out.length) {
      out[o] = ((v2 & 0x03) << 6) | v3
      o += 1
    }
  }
  return out
}
