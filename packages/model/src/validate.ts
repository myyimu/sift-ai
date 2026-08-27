// AnswerProjection 本地验证器（ADR-001 §9 步骤 5 / E-06“本地 zod 终关卡”）。
//
// 分两层：shared 的 answerProjectionSchema（形状 + claims/limitations 非双空）在前；
// 本文件补 zod 表达不了的跨对象不变式与内容门槛（P0_DEMO_SCOPE §2.5）：
//   引用完整性：claims/sources 的 evidenceBlockRef 必须属于同一 QuestionProjection 的块 ID；
//   claimId 唯一；超长字段拒绝；HTML/脚本输出拒绝。
// 引用存在只证明结构有效，不证明语义蕴含——语义支持率由人工夹具评估（spec §2.5），
// 本验证器永不尝试自动判定。
import { answerProjectionSchema } from '@sift/shared'
import type { AnswerProjection, DemoEvidenceBlock } from '@sift/shared'

// 版本化 Demo 默认值（非冻结规范值；调整时应连同 promptVersion 评估）。
export const MAX_ANSWER_CHARS = 20_000
export const MAX_CLAIMS = 100
export const MAX_CLAIM_TEXT_CHARS = 2_000
export const MAX_LIMITATIONS = 20
export const MAX_LIMITATION_CHARS = 1_000

/** HTML/脚本启发式（spec §2.5“HTML/脚本输出”整次失败；版本化 demo 启发式）。 */
const HTML_OR_SCRIPT = /<\s*\/?\s*(script|iframe|object|embed|svg|style|img|a|div|span|p|h[1-6]|br|ul|ol|li|table|form|input|button|link|meta)\b|javascript:/i

export type AnswerValidation =
  | { readonly ok: true; readonly answer: AnswerProjection }
  | { readonly ok: false; readonly reasons: readonly string[] }

/** 校验模型输出（analyzer 已由 adapter 本地盖章后再进来）。 */
export function validateAnswerProjection(
  answer: unknown,
  blocks: readonly DemoEvidenceBlock[],
): AnswerValidation {
  const parsed = answerProjectionSchema.safeParse(answer)
  if (!parsed.success) {
    return { ok: false, reasons: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) }
  }
  const candidate = parsed.data
  const reasons: string[] = []
  const blockIds = new Set(blocks.map(b => b.id))

  const claimIds = new Set<string>()
  for (const claim of candidate.claims) {
    if (claimIds.has(claim.claimId)) reasons.push(`claimId 重复：${claim.claimId}`)
    claimIds.add(claim.claimId)
    for (const ref of claim.evidenceBlockRefs) {
      if (!blockIds.has(ref)) reasons.push(`claim ${claim.claimId} 引用了不存在的证据块：${ref}`)
    }
  }
  for (const source of candidate.sources) {
    if (!blockIds.has(source.evidenceBlockRef)) {
      reasons.push(`sources 引用了不存在的证据块：${source.evidenceBlockRef}`)
    }
  }

  if (candidate.answer.length > MAX_ANSWER_CHARS) reasons.push(`answer 超长（${candidate.answer.length} > ${MAX_ANSWER_CHARS}）`)
  if (candidate.claims.length > MAX_CLAIMS) reasons.push(`claims 超数（${candidate.claims.length} > ${MAX_CLAIMS}）`)
  for (const claim of candidate.claims) {
    if (claim.text.length > MAX_CLAIM_TEXT_CHARS) reasons.push(`claim ${claim.claimId} 文本超长`)
  }
  if (candidate.limitations.length > MAX_LIMITATIONS) reasons.push(`limitations 超数（${candidate.limitations.length} > ${MAX_LIMITATIONS}）`)
  candidate.limitations.forEach((text, i) => {
    if (text.length > MAX_LIMITATION_CHARS) reasons.push(`limitations[${i}] 超长`)
  })
  if (candidate.sources.length > blocks.length) reasons.push(`sources 条数超过证据块数`)

  for (const text of [candidate.answer, ...candidate.claims.map(c => c.text), ...candidate.limitations]) {
    if (HTML_OR_SCRIPT.test(text)) {
      reasons.push('输出包含 HTML/脚本内容（回答必须是纯文本 JSON，不得输出标记）')
      break
    }
  }

  if (reasons.length > 0) return { ok: false, reasons }
  return { ok: true, answer: candidate }
}
