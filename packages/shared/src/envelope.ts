// ObservationEnvelope 的 zod 契约。
// 字段名与 CAPTURE_ARCHITECTURE.md §4 对应（P0 相对长期规范的收紧处见字段注释）；
// schemaVersion/captureVersion/redactionPolicy 不可省略（旧数据必须可安全重放）。
// URL、标题和 payload 是不可信输入，校验只保证结构与长度，
// 不代表内容安全——内容边界由 sensitive-v1 与 sanitize 层负责（ADR-001 E-08）。
import { z } from 'zod'

/**
 * P0 冻结的事件类型（CAPTURE_ARCHITECTURE §4“建议的 P0 事件类型”）。未知类型一律拒绝。
 * capture_failed（P0_COVERAGE_MANIFEST_SPEC §9）：捕获失败事实入账的控制事件，
 * payload 不含任何页面内容——partialExtractionCount 与事件派生盲区的唯一数据源。
 */
export const OBSERVATION_TYPES = [
  'authorization_granted',
  'authorization_revoked',
  'document_started',
  'navigation_metadata_changed',
  'dom_mutation_trigger',
  'dom_snapshot',
  'capture_paused',
  'capture_resumed',
  'capture_failed',
] as const

export type ObservationType = (typeof OBSERVATION_TYPES)[number]

export const observationEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  tabId: z.string().min(1),
  pageInstanceId: z.string().min(1),
  contentEpoch: z.number().int().nonnegative(),
  frameId: z.string().min(1).optional(),
  /** 本页面实例内单调递增；墙上时间不承担排序。 */
  sequence: z.number().int().nonnegative(),
  /** 协议提供的单调时间（若有）。 */
  observedAt: z.number().optional(),
  /** 本地墙上时间（ISO 8601 字符串）。 */
  receivedAt: z.string().min(1),
  /** 经过敏感清洗的 URL；清洗由 sensitive-v1 负责，schema 只保证非空字符串。 */
  url: z.string().min(1),
  /**
   * P0 只捕获扩展注入与 DOM 观察；ax/network/interaction 属于未来数据平面，
   * 由 schemaVersion 升级后的 schema 引入——P0 Host 对带这些来源标签的 Envelope
   * 一律拒绝（评审修订：CAPTURE_ARCHITECTURE §4 的全量枚举是长期规范，此处按
   * P0_DEMO_SCOPE 收紧）。
   */
  source: z.enum(['extension', 'navigation', 'dom']),
  type: z.enum(OBSERVATION_TYPES),
  /** 大 payload 在 blob store 的内容寻址引用；不内联进索引表。 */
  payloadRef: z.string().min(1),
  payloadHash: z.string().min(1),
  /** 如 "sensitive-v1"；不可省略。 */
  redactionPolicy: z.string().min(1),
  /** 如 "capture-v1"；不可省略。 */
  captureVersion: z.string().min(1),
})

export type ObservationEnvelope = z.infer<typeof observationEnvelopeSchema>
