import { describe, expect, it } from 'vitest'
import {
  answerProjectionSchema,
  observationEnvelopeSchema,
  questionProjectionSchema,
} from '../src/index'

const validEnvelope = {
  schemaVersion: 1,
  id: 'obs-1',
  sessionId: 'sess-1',
  tabId: 'tab-1',
  pageInstanceId: 'page-1',
  contentEpoch: 0,
  sequence: 0,
  receivedAt: '2026-08-26T00:00:00.000Z',
  url: 'https://example.com/articles/1',
  source: 'dom',
  type: 'dom_snapshot',
  payloadRef: 'sha256:abc',
  payloadHash: 'sha256:abc',
  redactionPolicy: 'sensitive-v1',
  captureVersion: 'capture-v1',
}

describe('observationEnvelopeSchema', () => {
  it('接受合法 envelope', () => {
    expect(observationEnvelopeSchema.parse(validEnvelope)).toBeTruthy()
  })

  it('缺失不可省略字段（schemaVersion/captureVersion/redactionPolicy）时拒绝', () => {
    for (const key of ['schemaVersion', 'captureVersion', 'redactionPolicy'] as const) {
      const bad = { ...validEnvelope }
      delete bad[key]
      expect(observationEnvelopeSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('未知事件类型拒绝（P0 事件表冻结）', () => {
    const bad = { ...validEnvelope, type: 'xhr_response' }
    expect(observationEnvelopeSchema.safeParse(bad).success).toBe(false)
  })

  it('未来数据平面来源（ax/network/interaction）拒绝（P0 只接受 extension/navigation/dom）', () => {
    for (const source of ['ax', 'network', 'interaction']) {
      const bad = { ...validEnvelope, source }
      expect(observationEnvelopeSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('负数 sequence 拒绝', () => {
    const bad = { ...validEnvelope, sequence: -1 }
    expect(observationEnvelopeSchema.safeParse(bad).success).toBe(false)
  })
})

const validBlock = {
  id: 'blk-1',
  kind: 'paragraph',
  text: '这是一段足够长的正文内容，用来充当合法的 DemoEvidenceBlock。',
  textHash: 'sha256:blk1',
  sources: [
    {
      pageInstanceId: 'page-1',
      stateVersion: 3,
      ordinal: 2,
      title: '示例文章',
      safeUrl: 'https://example.com/articles/1',
      capturedAt: '2026-08-26T00:00:00.000Z',
    },
  ],
}

const validQuestionProjection = {
  schemaVersion: 1,
  projectionVersion: 1,
  question: '这篇文章的结论是什么？',
  scope: 'current_page',
  pageStateWatermarks: [{ pageInstanceId: 'page-1', stateVersion: 3, lastAppliedSequence: 12 }],
  blocks: [validBlock],
  inputHash: 'sha256:proj1',
  limits: { maxPages: 20, maxBlocks: 200, maxUtf8Bytes: 524288, maxEstimatedTokens: 32000 },
  truncation: 'none',
}

describe('questionProjectionSchema', () => {
  it('接受合法投影', () => {
    expect(questionProjectionSchema.parse(validQuestionProjection)).toBeTruthy()
  })

  it('truncation 只允许字面量 none（全量或不发送）', () => {
    const bad = { ...validQuestionProjection, truncation: 'tail' }
    expect(questionProjectionSchema.safeParse(bad).success).toBe(false)
  })

  it('空 sources 的 block 拒绝', () => {
    const bad = {
      ...validQuestionProjection,
      blocks: [{ ...validBlock, sources: [] }],
    }
    expect(questionProjectionSchema.safeParse(bad).success).toBe(false)
  })

  it('空 watermarks 拒绝（必须声明所依据的 Page State）', () => {
    const bad = { ...validQuestionProjection, pageStateWatermarks: [] }
    expect(questionProjectionSchema.safeParse(bad).success).toBe(false)
  })
})

describe('answerProjectionSchema', () => {
  const validAnswer = {
    schemaVersion: 1,
    answer: '结论是 A。',
    claims: [{ claimId: 'c1', text: '结论是 A。', evidenceBlockRefs: ['blk-1'] }],
    limitations: [],
    sources: [{ evidenceBlockRef: 'blk-1' }],
    analyzer: { provider: 'openai-compatible', model: 'demo-model', promptVersion: 'prompt-v1' },
  }

  it('接受合法回答', () => {
    expect(answerProjectionSchema.parse(validAnswer)).toBeTruthy()
  })

  it('claims 与 limitations 同时为空拒绝（既无证据也无解释）', () => {
    const bad = { ...validAnswer, claims: [], limitations: [] }
    expect(answerProjectionSchema.safeParse(bad).success).toBe(false)
  })

  it('limitation-only 回答合法：claims 为空但 limitations 非空（问题超出 scope，P0_DEMO_SCOPE §2.5）', () => {
    const outOfScope = {
      ...validAnswer,
      answer: '当前 scope 内的证据不足以回答该问题。',
      claims: [],
      sources: [],
      limitations: ['问题超出所选 Page/Session 的证据范围，未远程补充任何信息。'],
    }
    expect(answerProjectionSchema.safeParse(outOfScope).success).toBe(true)
  })

  it('evidenceBlockRefs 为空数组拒绝（至少一个）', () => {
    const bad = {
      ...validAnswer,
      claims: [{ claimId: 'c1', text: '结论是 A。', evidenceBlockRefs: [] }],
    }
    expect(answerProjectionSchema.safeParse(bad).success).toBe(false)
  })

  it('未知 kind 的 block 拒绝', () => {
    const bad = {
      ...validQuestionProjection,
      blocks: [{ ...validBlock, kind: 'tweet' }],
    }
    expect(questionProjectionSchema.safeParse(bad).success).toBe(false)
  })
})
