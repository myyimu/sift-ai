// DemoEvidenceBlock 的 zod 契约（P0_DEMO_SCOPE §2.4）。
import { z } from 'zod'

export const evidenceBlockKinds = [
  'heading',
  'paragraph',
  'list_item',
  'quote',
  'code',
  'table',
  'unknown',
] as const

export const evidenceSourceRefSchema = z.object({
  pageInstanceId: z.string().min(1),
  stateVersion: z.number().int().nonnegative(),
  ordinal: z.number().int().nonnegative(),
  title: z.string().optional(),
  /** sensitive-v1 清洗后的 URL。 */
  safeUrl: z.string().min(1),
  /** ISO 8601。 */
  capturedAt: z.string().min(1),
})

export type EvidenceSourceRef = z.infer<typeof evidenceSourceRefSchema>

export const demoEvidenceBlockSchema = z.object({
  /** projection 内不透明 ID（AnswerProjection.claims 只允许引用这些 ID）。 */
  id: z.string().min(1),
  kind: z.enum(evidenceBlockKinds),
  /** 已脱敏、确定性归一的原文；不做摘要、翻译或语义改写。 */
  text: z.string(),
  textHash: z.string().min(1),
  /** 去重合并后的全部来源；至少一条。 */
  sources: z.array(evidenceSourceRefSchema).min(1),
})

export type DemoEvidenceBlock = z.infer<typeof demoEvidenceBlockSchema>
