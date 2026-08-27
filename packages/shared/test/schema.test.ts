import { describe, expect, it } from 'vitest'
import {
  answerProjectionSchema,
  captureFailedPayloadSchema,
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

  it('capture_failed 事件类型接受（P0_COVERAGE_MANIFEST_SPEC §9）', () => {
    const ok = { ...validEnvelope, type: 'capture_failed', source: 'extension' }
    expect(observationEnvelopeSchema.safeParse(ok).success).toBe(true)
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

const validCoverage = {
  schemaVersion: 1,
  requestedScope: { kind: 'current_page', pageInstanceId: 'page-1' },
  capturedFrom: '2026-08-26T00:00:00.000Z',
  capturedTo: '2026-08-26T00:05:00.000Z',
  sessionCount: 1,
  pageCount: 1,
  unitCount: 1,
  unitCountBasis: 'deduped_text_blocks',
  domains: ['https://example.com'],
  visitedPagination: [
    {
      origin: 'https://example.com',
      path: '/list',
      observedSelectors: ['page=1', 'page=2'],
      observedCount: 2,
      exhausted: false,
    },
  ],
  partialExtractionCount: 0,
  authorizationGaps: [],
  knownMissingReasons: [
    'unvisited_pagination',
    'unmounted_infinite_scroll',
    'cross_origin_iframe',
    'hidden_or_lazy_content',
    'indistinguishable_absence',
  ],
  inputBounds: {
    sessions: ['sess-1'],
    pageStateWatermarks: [{ pageInstanceId: 'page-1', stateVersion: 3, lastAppliedSequence: 12 }],
  },
}

const validQuestionProjection = {
  schemaVersion: 1,
  projectionVersion: 1,
  question: '这篇文章的结论是什么？',
  scope: 'current_page',
  pageStateWatermarks: [{ pageInstanceId: 'page-1', stateVersion: 3, lastAppliedSequence: 12 }],
  coverage: validCoverage,
  blocks: [validBlock],
  inputHash: 'sha256:proj1',
  limits: { maxPages: 20, maxBlocks: 200, maxUtf8Bytes: 524288, maxEstimatedTokens: 32000 },
  truncation: 'none',
}

describe('questionProjectionSchema', () => {
  it('接受合法投影', () => {
    expect(questionProjectionSchema.parse(validQuestionProjection)).toBeTruthy()
  })

  it('缺失 coverage 拒绝（无 manifest 的分析输出是无效输出，spec §10.2）', () => {
    const bad: Record<string, unknown> = { ...validQuestionProjection }
    delete bad.coverage
    expect(questionProjectionSchema.safeParse(bad).success).toBe(false)
  })

  it('coverage.exhausted 非 false 字面量拒绝（观察者永不声明穷尽）', () => {
    const bad = {
      ...validQuestionProjection,
      coverage: {
        ...validCoverage,
        visitedPagination: [
          { ...validCoverage.visitedPagination[0], exhausted: true },
        ],
      },
    }
    expect(questionProjectionSchema.safeParse(bad).success).toBe(false)
  })

  it('coverage 词表之外的盲区 reason 拒绝（词表冻结）', () => {
    const bad = {
      ...validQuestionProjection,
      coverage: { ...validCoverage, knownMissingReasons: ['site_wide_crawl_done'] },
    }
    expect(questionProjectionSchema.safeParse(bad).success).toBe(false)
  })

  it('partialExtractionCount 为 null 合法（capture_failed 持久化前的历史语义）', () => {
    const legacy = {
      ...validQuestionProjection,
      coverage: { ...validCoverage, partialExtractionCount: null },
    }
    expect(questionProjectionSchema.safeParse(legacy).success).toBe(true)
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

const validCaptureFailedPayload = {
  schemaVersion: 1,
  kind: 'capture_failed',
  captureVersion: 'capture-v1',
  code: 'capture_too_little_content',
  instanceNonce: 'nonce-abc',
  contentEpoch: 2,
}

describe('captureFailedPayloadSchema', () => {
  it('接受合法 payload（spec §9：只含 kind/code/instanceNonce/contentEpoch）', () => {
    expect(captureFailedPayloadSchema.parse(validCaptureFailedPayload)).toBeTruthy()
  })

  it('contentEpoch 可省略', () => {
    const ok: Partial<typeof validCaptureFailedPayload> = { ...validCaptureFailedPayload }
    delete ok.contentEpoch
    expect(captureFailedPayloadSchema.safeParse(ok).success).toBe(true)
  })

  it('未知键拒绝（detail 不得混入持久 payload）', () => {
    const bad = { ...validCaptureFailedPayload, detail: 'readable-v1 未在 5000ms 内满足' }
    expect(captureFailedPayloadSchema.safeParse(bad).success).toBe(false)
  })

  it('词表之外的 code 拒绝', () => {
    const bad = { ...validCaptureFailedPayload, code: 'capture_crashed' }
    expect(captureFailedPayloadSchema.safeParse(bad).success).toBe(false)
  })

  it('缺失 instanceNonce 拒绝', () => {
    const bad: Partial<typeof validCaptureFailedPayload> = { ...validCaptureFailedPayload }
    delete bad.instanceNonce
    expect(captureFailedPayloadSchema.safeParse(bad).success).toBe(false)
  })

  it('非整数 contentEpoch 拒绝', () => {
    const bad = { ...validCaptureFailedPayload, contentEpoch: 1.5 }
    expect(captureFailedPayloadSchema.safeParse(bad).success).toBe(false)
  })
})
