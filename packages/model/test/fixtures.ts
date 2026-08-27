// 测试夹具：证据块 / CoverageManifest / 合法模型输出 / adapter 配置。
import type { CoverageManifest, DemoEvidenceBlock } from '@sift/shared'
import type { ModelConfig } from '../src/config'

const SOURCE = {
  pageInstanceId: 'p-1',
  stateVersion: 1,
  ordinal: 0,
  safeUrl: 'https://example.com/article',
  capturedAt: '2026-08-27T00:01:00.000Z',
}

export const BLOCKS: readonly DemoEvidenceBlock[] = [
  { id: 'b-0001', kind: 'heading', text: '观察者架构一文的核心主张', textHash: 'sha256:aa', sources: [SOURCE] },
  { id: 'b-0002', kind: 'paragraph', text: '这篇文章认为本地只读观察是产品原则，且不该用 CDP。', textHash: 'sha256:bb', sources: [SOURCE] },
]

export const COVERAGE: CoverageManifest = {
  schemaVersion: 1,
  requestedScope: { kind: 'demo_session', sessionId: 'sess-1' },
  capturedFrom: '2026-08-27T00:01:00.000Z',
  capturedTo: '2026-08-27T00:02:00.000Z',
  sessionCount: 1,
  pageCount: 1,
  unitCount: 2,
  unitCountBasis: 'deduped_text_blocks',
  domains: ['https://example.com'],
  visitedPagination: [
    { origin: 'https://example.com', path: '/article', observedSelectors: ['page=1', 'page=2'], observedCount: 2, exhausted: false },
  ],
  partialExtractionCount: 0,
  authorizationGaps: [],
  knownMissingReasons: ['unvisited_pagination', 'unmounted_infinite_scroll', 'cross_origin_iframe', 'hidden_or_lazy_content', 'indistinguishable_absence'],
  inputBounds: {
    sessions: ['sess-1'],
    pageStateWatermarks: [{ pageInstanceId: 'p-1', stateVersion: 1, lastAppliedSequence: 3 }],
  },
}

/** 合法模型输出（analyzer 任意——adapter 会本地盖章）。 */
export function validModelOutput(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    answer: '两份材料都在讨论只读观察的边界：本地处理优先，CDP 不进入产品。',
    claims: [
      { claimId: 'c-1', text: '核心主张是本地只读观察。', evidenceBlockRefs: ['b-0001'] },
      { claimId: 'c-2', text: '文章明确排除 CDP。', evidenceBlockRefs: ['b-0002', 'b-0001'] },
    ],
    limitations: ['分页 1～2 未穷尽，结论不代表站点整体。'],
    sources: [{ evidenceBlockRef: 'b-0001' }, { evidenceBlockRef: 'b-0002' }],
    analyzer: { provider: 'whatever', model: 'whatever', promptVersion: 'x' },
  }
}

export const CONFIG: ModelConfig = {
  baseUrl: 'https://api.example.com',
  origin: 'https://api.example.com',
  apiKey: 'sk-test-key-1234567890',
  model: 'gpt-x',
  contextWindow: 128_000,
}
