// Capture 线协议与 payload 的严格 zod 校验（Host 侧终审；ADR-001 §1 分层的桌面/Host 侧）。
//
// 与 wire.ts（纯类型层）的关系：本文件只导出 schema 与校验工具，**不重复导出
// 推断类型**——TS 类型唯一来源是 wire.ts，运行时校验唯一来源是本文件；
// test/wire.test.ts 同时对拍两侧（schema 解析结果与 wire 类型结构兼容）。
//
// 设计要点：
//  - announce 携带完整 ObservationEnvelope，用 strict 版 schema（叠加 pageInstanceId
//    字符集收紧 = 落盘路径穿越防御、payloadRef/payloadHash 的 sha256 形状、
//    redactionPolicy/captureVersion 字面量冻结）；
//  - 联动约束（chunkCount 数学、payloadBytes 上限、hash 三处一致）在联合层
//    superRefine 完成——Host 收到即拒，不需要状态机参与；
//  - payload schema 一律 .strict()（未知键拒绝）：确定性序列化的配套防线，
//    防止多出的键悄悄改变 hash 语义。
import { z } from 'zod'
import { observationEnvelopeSchema } from './envelope'
import { NATIVE_MAX_CHUNK_BYTES } from './limits'
import {
  BASE64_CANONICAL_PATTERN,
  CAPTURE_FAILURE_CODES,
  CAPTURE_VERSION,
  PAGE_INSTANCE_ID_PATTERN,
  REDACTION_POLICY,
  SHA256_HASH_PATTERN,
  base64ToBytes,
  chunkCountFor,
  payloadMaxBytesFor,
} from './wire'

/**
 * 观察之上的 strict envelope：叠加 capture 线协议特有的收紧。
 * （envelope.ts 本体保持 CAPTURE_ARCHITECTURE §4 冻结形状不动。）
 */
export const strictObservationEnvelopeSchema = observationEnvelopeSchema.extend({
  pageInstanceId: z.string().regex(PAGE_INSTANCE_ID_PATTERN),
  payloadRef: z.string().regex(SHA256_HASH_PATTERN),
  payloadHash: z.string().regex(SHA256_HASH_PATTERN),
  redactionPolicy: z.literal(REDACTION_POLICY),
  captureVersion: z.literal(CAPTURE_VERSION),
})

const transferIdSchema = z.string().min(1).max(64)
const payloadHashSchema = z.string().regex(SHA256_HASH_PATTERN)

const helloSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int().nonnegative(),
  client: z.literal('sift-extension'),
}).strict()

const announceSchema = z.object({
  type: z.literal('announce'),
  transferId: transferIdSchema,
  envelope: strictObservationEnvelopeSchema,
  payloadBytes: z.number().int().positive(),
  payloadHash: payloadHashSchema,
  chunkSize: z.number().int().positive(),
  chunkCount: z.number().int().positive(),
}).strict()

const chunkSchema = z.object({
  type: z.literal('chunk'),
  transferId: transferIdSchema,
  index: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive(),
  payloadHash: payloadHashSchema,
  dataB64: z.string().regex(BASE64_CANONICAL_PATTERN).refine(
    (s) => s.length % 4 === 0,
    { message: 'dataB64 长度必须是 4 的倍数' },
  ),
}).strict()

const commitSchema = z.object({
  type: z.literal('commit'),
  transferId: transferIdSchema,
  payloadHash: payloadHashSchema,
}).strict()

/**
 * Extension → Host 联合 + 联动约束。
 * 注意：protocolVersion 不用 literal(PROTOCOL_VERSION)——版本不匹配必须由
 * 协议处理器归类为 protocol_version_mismatch，而不是 schema 的 invalid_message。
 */
export const extensionMessageSchema = z
  .union([helloSchema, announceSchema, chunkSchema, commitSchema])
  .superRefine((msg, ctx) => {
    if (msg.type === 'announce') {
      const { envelope, payloadHash, payloadBytes, chunkSize, chunkCount } = msg
      if (envelope.payloadHash !== payloadHash || envelope.payloadRef !== payloadHash) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payloadHash'], message: 'announce.payloadHash 与 envelope.payloadHash/payloadRef 必须一致' })
      }
      if (chunkCount !== chunkCountFor(payloadBytes, chunkSize)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chunkCount'], message: 'chunkCount 与 ceil(payloadBytes/chunkSize) 不一致' })
      }
      if (chunkSize > NATIVE_MAX_CHUNK_BYTES) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chunkSize'], message: 'chunkSize 超过 NATIVE_MAX_CHUNK_BYTES' })
      }
      if (payloadBytes > payloadMaxBytesFor(envelope.type)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payloadBytes'], message: 'payloadBytes 超过该观察类型的上限' })
      }
      return
    }
    if (msg.type === 'chunk') {
      if (msg.index >= msg.chunkCount) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['index'], message: 'chunk.index 必须 < chunkCount' })
      }
      try {
        const decoded = base64ToBytes(msg.dataB64)
        if (decoded.length > NATIVE_MAX_CHUNK_BYTES) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dataB64'], message: '解码后超过 NATIVE_MAX_CHUNK_BYTES' })
        }
      } catch (error) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dataB64'], message: `dataB64 无法解码: ${String(error)}` })
      }
    }
  })

// —— Host → Extension ——

export const hostMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    protocolVersion: z.number().int().nonnegative(),
    host: z.literal('sift-demo-host'),
    storeReady: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal('transfer_ack'),
    transferId: transferIdSchema,
    status: z.enum(['ok', 'deduplicated']),
  }).strict(),
  z.object({
    type: z.literal('chunk_ack'),
    transferId: transferIdSchema,
    index: z.number().int().nonnegative(),
    receivedBytes: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    type: z.literal('commit_ack'),
    transferId: transferIdSchema,
    deduplicated: z.boolean(),
    payloadHash: payloadHashSchema,
    stateVersion: z.number().int().nonnegative(),
    lastAppliedSequence: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    type: z.literal('error'),
    transferId: transferIdSchema.optional(),
    code: z.enum([
      'protocol_version_mismatch', 'invalid_message', 'hash_mismatch',
      'payload_oversized', 'sequence_violation', 'quota_exceeded',
      'storage_error', 'internal_error',
    ]),
    message: z.string().max(256),
    fatal: z.literal(true),
  }).strict(),
])

// —— payload schema（Host 收到 commit 后对解码 JSON 的终审） ——

const captureVersionLiteral = z.literal(CAPTURE_VERSION)

export const domSnapshotPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('dom_snapshot'),
  captureVersion: captureVersionLiteral,
  reason: z.enum(['initial_readable', 'mutation_merged']),
  url: z.string().min(1),
  title: z.string(),
  contentEpoch: z.number().int().nonnegative(),
  html: z.string().min(1),
  stats: z.object({
    nodeCount: z.number().int().positive(),
    maxDepth: z.number().int().positive(),
    htmlUtf8Bytes: z.number().int().positive(),
  }).strict(),
}).strict()

export const authorizationGrantedPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('authorization_granted'),
  captureVersion: captureVersionLiteral,
  url: z.string().min(1),
  title: z.string().optional(),
  reason: z.literal('user_gesture'),
  origin: z.string().min(1),
}).strict()

export const authorizationRevokedPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('authorization_revoked'),
  captureVersion: captureVersionLiteral,
  url: z.string().min(1),
  reason: z.enum(['cross_origin', 'tab_closed', 'port_error', 'sw_shutdown']),
}).strict()

export const documentStartedPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('document_started'),
  captureVersion: captureVersionLiteral,
  url: z.string().min(1),
  title: z.string().optional(),
  instanceNonce: z.string().min(1).max(64),
  sameOriginReinject: z.boolean(),
}).strict()

/** 捕获失败控制事件（wire.CaptureFailedPayload 的终审；spec §9 词表钉死，无 detail）。 */
export const captureFailedPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('capture_failed'),
  captureVersion: captureVersionLiteral,
  code: z.enum(CAPTURE_FAILURE_CODES),
  instanceNonce: z.string().min(1).max(64),
  contentEpoch: z.number().int().nonnegative().optional(),
}).strict()

/**
 * 按 envelope.type 取 payload schema；P0 落地 5 种事件
 * （dom_snapshot + 4 控制事件，含 capture_failed），
 * 其余类型返回 null（capture-protocol 按 invalid_message 拒绝——fail-closed）。
 */
export function payloadSchemaFor(
  observationType: string,
): z.ZodTypeAny | null {
  switch (observationType) {
    case 'dom_snapshot': return domSnapshotPayloadSchema
    case 'authorization_granted': return authorizationGrantedPayloadSchema
    case 'authorization_revoked': return authorizationRevokedPayloadSchema
    case 'document_started': return documentStartedPayloadSchema
    case 'capture_failed': return captureFailedPayloadSchema
    default: return null
  }
}
