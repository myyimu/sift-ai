// QuestionProjection / AnswerProjection 的 zod 契约（P0_DEMO_SCOPE §2.4 / §2.5）。
// 结构校验之外还有一层“引用完整性”校验（AnswerProjection 的 evidenceBlockRef 必须属于
// 对应 QuestionProjection、claimId 不得重复等）——那是 zod 无法表达的跨对象不变式，
// 属于 ADR-001 §9 步骤 5 的 AnswerProjection 验证器，不在本文件实现。
import { z } from 'zod'
import { coverageManifestSchema } from './coverage'
import { demoEvidenceBlockSchema } from './evidence'

export const questionProjectionSchema = z.object({
  schemaVersion: z.literal(1),
  projectionVersion: z.literal(1),
  question: z.string().min(1),
  scope: z.enum(['current_page', 'demo_session']),
  pageStateWatermarks: z
    .array(
      z.object({
        pageInstanceId: z.string().min(1),
        stateVersion: z.number().int().nonnegative(),
        lastAppliedSequence: z.number().int().nonnegative(),
      }),
    )
    .min(1),
  /** 覆盖声明（P0_COVERAGE_MANIFEST_SPEC §2）：无 manifest 的分析输出是无效输出。 */
  coverage: coverageManifestSchema,
  blocks: z.array(demoEvidenceBlockSchema),
  inputHash: z.string().min(1),
  limits: z.object({
    maxPages: z.number().int().positive(),
    maxBlocks: z.number().int().positive(),
    maxUtf8Bytes: z.number().int().positive(),
    maxEstimatedTokens: z.number().int().positive(),
  }),
  /** Demo 承诺：全量或不发送。任何超限都要求用户缩小 scope，绝不截断。 */
  truncation: z.literal('none'),
})

export type QuestionProjection = z.infer<typeof questionProjectionSchema>

export const answerProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    answer: z.string().min(1),
    claims: z.array(
      z.object({
        claimId: z.string().min(1),
        text: z.string().min(1),
        /** 至少一个，且必须属于对应 QuestionProjection（跨对象校验见步骤 5 验证器）。 */
        evidenceBlockRefs: z.array(z.string().min(1)).min(1),
      }),
    ),
    limitations: z.array(z.string()),
    sources: z.array(
      z.object({
        evidenceBlockRef: z.string().min(1),
      }),
    ),
    analyzer: z.object({
      provider: z.string().min(1),
      model: z.string().min(1),
      promptVersion: z.string().min(1),
    }),
  })
  .strict()
  .superRefine((val, ctx) => {
    // P0_DEMO_SCOPE §2.5：问题超出 scope 时，模型必须返回 limitation——允许
    // claims 为空的 limitation-only 回答；但 claims 与 limitations 同时为空
    // 则既无可归因证据也无解释，整次失败。
    // .strict()：本 schema 解析的是模型输出的不可信 JSON，未知键一律拒绝
    // （与 @sift/model 手写 JSON Schema 的 additionalProperties:false 对齐）。
    if (val.claims.length === 0 && val.limitations.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claims'],
        message: 'claims 为空时 limitations 必须非空（limitation-only 回答需说明无法回答的原因）',
      })
    }
  })

export type AnswerProjection = z.infer<typeof answerProjectionSchema>
