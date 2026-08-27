// AnswerProjection 跨对象验证器测试（P0_DEMO_SCOPE §2.5：悬空引用/重复 ID/
// 超长字段/HTML 输出整次失败；引用有效 ≠ 语义蕴含——后者人工夹具评估）。
import { describe, expect, it } from 'vitest'
import { MAX_ANSWER_CHARS, MAX_CLAIMS, MAX_LIMITATIONS, validateAnswerProjection } from '../src/validate'
import { BLOCKS, validModelOutput } from './fixtures'

describe('validateAnswerProjection', () => {
  it('合法输出 → ok', () => {
    const r = validateAnswerProjection(validModelOutput(), BLOCKS)
    expect(r.ok).toBe(true)
  })

  it('zod 层：schemaVersion 错 / answer 空 / claims 与 limitations 双空 → 拒绝', () => {
    expect(validateAnswerProjection({ ...validModelOutput(), schemaVersion: 2 }, BLOCKS).ok).toBe(false)
    expect(validateAnswerProjection({ ...validModelOutput(), answer: '' }, BLOCKS).ok).toBe(false)
    expect(validateAnswerProjection({ ...validModelOutput(), claims: [], limitations: [] }, BLOCKS).ok).toBe(false)
  })

  it('claimId 重复 → 拒绝', () => {
    const bad = validModelOutput() as { claims: Array<{ claimId: string }> }
    bad.claims[1]!.claimId = bad.claims[0]!.claimId
    const r = validateAnswerProjection(bad, BLOCKS)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reasons.join()).toContain('重复')
  })

  it('悬空引用（claim / sources）→ 拒绝', () => {
    const badClaim = validModelOutput() as { claims: Array<{ evidenceBlockRefs: string[] }> }
    badClaim.claims[0]!.evidenceBlockRefs = ['b-9999']
    expect(validateAnswerProjection(badClaim, BLOCKS).ok).toBe(false)

    const badSource = validModelOutput() as { sources: Array<{ evidenceBlockRef: string }> }
    badSource.sources[0]!.evidenceBlockRef = 'b-9999'
    const r = validateAnswerProjection(badSource, BLOCKS)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reasons.join()).toContain('sources')
  })

  it('HTML/脚本输出 → 拒绝（answer / claim / limitation 任一命中）', () => {
    const withScript = validModelOutput() as { answer: string }
    withScript.answer = '结论 <script>alert(1)</script>'
    expect(validateAnswerProjection(withScript, BLOCKS).ok).toBe(false)

    const withDiv = validModelOutput() as { claims: Array<{ text: string }> }
    withDiv.claims[0]!.text = '<div>结构化</div>输出'
    expect(validateAnswerProjection(withDiv, BLOCKS).ok).toBe(false)

    const withJs = validModelOutput() as { limitations: string[] }
    withJs.limitations[0] = 'javascript:alert(1) 不能执行'
    expect(validateAnswerProjection(withJs, BLOCKS).ok).toBe(false)

    // 普通文本中的孤立 < 不误伤
    const plain = validModelOutput() as { answer: string }
    plain.answer = '若 a<3 且 b>2 则成立'
    expect(validateAnswerProjection(plain, BLOCKS).ok).toBe(true)
  })

  it('超长字段与超数数组 → 拒绝', () => {
    const longAnswer = validModelOutput() as { answer: string }
    longAnswer.answer = '长'.repeat(MAX_ANSWER_CHARS + 1)
    expect(validateAnswerProjection(longAnswer, BLOCKS).ok).toBe(false)

    const manyClaims = validModelOutput() as { claims: unknown[] }
    const one = (validModelOutput() as { claims: Array<Record<string, unknown>> }).claims[0]!
    manyClaims.claims = Array.from({ length: MAX_CLAIMS + 1 }, () => ({ ...one, claimId: `c-${Math.random()}` }))
    expect(validateAnswerProjection(manyClaims, BLOCKS).ok).toBe(false)

    const manyLimitations = validModelOutput() as { limitations: string[] }
    manyLimitations.limitations = Array.from({ length: MAX_LIMITATIONS + 1 }, (_, i) => `限制${i}`)
    expect(validateAnswerProjection(manyLimitations, BLOCKS).ok).toBe(false)
  })

  it('sources 条数超过证据块数 → 拒绝', () => {
    const bad = validModelOutput() as { sources: Array<{ evidenceBlockRef: string }> }
    bad.sources = [
      { evidenceBlockRef: 'b-0001' }, { evidenceBlockRef: 'b-0001' }, { evidenceBlockRef: 'b-0002' },
    ]
    expect(validateAnswerProjection(bad, BLOCKS).ok).toBe(false)
  })
})
