// 步骤 5–6：去重/排序/限额/组装（P0_DEMO_SCOPE §2.4；ADR-001 E-05/E-07）。
//
// 确定性（验收门 10）：pages 预排序 (capturedAt, pageInstanceId) → 输入序无关；
// 全局 textHash 去重合并 sources；终序按第一 source (capturedAt, pageInstanceId, ordinal)；
// id 排序后编（b-0001…）；inputHash = 固定键序 canonical JSON 的 sha256，
// 覆盖 question + watermarks + coverage + blockDigests + limits + estimatedTokens（E-07）。
// 全量或不发送：任一限额超出 → projection_limit_exceeded 携精确 usage，绝不截断。
// 全程零墙钟：时间全部来自输入（capturedAt/receivedAt），无 Date.now。
import { createHash } from 'node:crypto'
import type { DemoEvidenceBlock, EvidenceSourceRef, QuestionProjection, RequestedScope } from '@sift/shared'
import {
  TOKEN_CTX_RESERVE,
  projectionLimits,
} from '@sift/shared/limits'
import { estimateTokens, utf8Bytes } from '@sift/shared/tokens'
import { extractBlocks } from './extract'
import { deriveCoverageManifest, type ManifestInput, type ManifestObservation, type ManifestPageState } from './manifest'

/** 投影器页面输入：冻结 Page State 的脱敏 HTML + 来源元数据。 */
export interface ProjectorPageInput {
  /** 调用方保证已脱敏（sensitive-v1）的离线 HTML（dom_snapshot payload.html）。 */
  readonly sanitizedHtml: string
  readonly source: {
    readonly pageInstanceId: string
    readonly stateVersion: number
    readonly ordinal: number
    readonly title?: string
    readonly safeUrl: string
    readonly capturedAt: string
  }
}

/** manifest 派生事实（= ManifestInput 去掉 unitCount 环，unitCount 由去重块数填入）。 */
export interface ManifestFacts {
  readonly scope: RequestedScope
  readonly observations: readonly ManifestObservation[]
  readonly pageStates: readonly ManifestPageState[]
}

export interface ProjectQuestionParams {
  readonly question: string
  readonly scope: 'current_page' | 'demo_session'
  readonly pages: readonly ProjectorPageInput[]
  readonly manifestFacts: ManifestFacts
  readonly modelContextWindow: number
}

export type ProjectorResult =
  | { readonly status: 'ok'; readonly projection: QuestionProjection }
  | { readonly status: 'projection_empty' }
  | { readonly status: 'projection_input_invalid'; readonly reason: string }
  | {
      readonly status: 'projection_limit_exceeded'
      readonly usage: { readonly pages: number; readonly blocks: number; readonly utf8Bytes: number; readonly estimatedTokens: number }
      readonly limits: ReturnType<typeof projectionLimits>
    }

// —— 排序键 ——

function byPageOrder(a: ProjectorPageInput, b: ProjectorPageInput): number {
  if (a.source.capturedAt !== b.source.capturedAt) return a.source.capturedAt < b.source.capturedAt ? -1 : 1
  if (a.source.pageInstanceId !== b.source.pageInstanceId) return a.source.pageInstanceId < b.source.pageInstanceId ? -1 : 1
  return a.source.ordinal - b.source.ordinal
}

function bySourceRef(a: EvidenceSourceRef, b: EvidenceSourceRef): number {
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? -1 : 1
  if (a.pageInstanceId !== b.pageInstanceId) return a.pageInstanceId < b.pageInstanceId ? -1 : 1
  return a.ordinal - b.ordinal
}

// —— 入参校验 ——

function validate(params: ProjectQuestionParams): string | null {
  if (params.question.trim() === '') return 'question 为空'
  if (params.pages.length === 0) return 'pages 为空'
  if (params.modelContextWindow <= TOKEN_CTX_RESERVE) {
    return `modelContextWindow ${params.modelContextWindow} ≤ TOKEN_CTX_RESERVE ${TOKEN_CTX_RESERVE}（token 上限非正）`
  }
  // 同页多快照合法（不同 stateVersion/ordinal）；校验的是 scope 一致性与 watermark 可归属性
  const facts = params.manifestFacts
  const factsScope = facts.scope
  if (params.scope === 'current_page') {
    if (factsScope.kind !== 'current_page') return 'manifestFacts.scope 与 scope 不一致（需 current_page）'
    if (!params.pages.every(p => p.source.pageInstanceId === factsScope.pageInstanceId)) {
      return 'current_page scope 下存在 scope 外的 pageInstanceId'
    }
  } else if (factsScope.kind !== 'demo_session') {
    return 'manifestFacts.scope 与 scope 不一致（需 demo_session）'
  }
  const watermarkIds = new Set(facts.pageStates.map(ps => ps.pageInstanceId))
  for (const page of params.pages) {
    if (!watermarkIds.has(page.source.pageInstanceId)) {
      return `pageInstanceId ${page.source.pageInstanceId} 无对应 Page State watermark`
    }
  }
  return null
}

// —— 主入口 ——

export function projectQuestion(params: ProjectQuestionParams): ProjectorResult {
  const invalid = validate(params)
  if (invalid !== null) return { status: 'projection_input_invalid', reason: invalid }

  const limits = projectionLimits(params.modelContextWindow)

  // pages 预排序 → 之后一切派生与输入序无关
  const pages = [...params.pages].sort(byPageOrder)

  // 步骤 5 前半：逐页抽取（块带页内 ordinal），全局 textHash 去重合并 sources
  const byHash = new Map<string, { kind: DemoEvidenceBlock['kind']; text: string; sources: EvidenceSourceRef[] }>()
  for (const page of pages) {
    for (const block of extractBlocks(page.sanitizedHtml)) {
      const source: EvidenceSourceRef = {
        pageInstanceId: page.source.pageInstanceId,
        stateVersion: page.source.stateVersion,
        ordinal: block.ordinal,
        ...(page.source.title !== undefined ? { title: page.source.title } : {}),
        safeUrl: page.source.safeUrl,
        capturedAt: page.source.capturedAt,
      }
      const existing = byHash.get(block.textHash)
      if (existing === undefined) {
        byHash.set(block.textHash, { kind: block.kind, text: block.text, sources: [source] })
      } else {
        existing.sources.push(source) // 合并去重前全部来源
      }
    }
  }

  // 终序：第一 source (capturedAt, pageInstanceId, ordinal)；合并 sources 同序；id 排序后编
  const merged = [...byHash.entries()]
  for (const [, block] of merged) block.sources.sort(bySourceRef)
  merged.sort(([, a], [, b]) => bySourceRef(a.sources[0]!, b.sources[0]!))
  const blocks: DemoEvidenceBlock[] = merged.map(([textHash, block], index) => ({
    id: `b-${String(index + 1).padStart(4, '0')}`,
    kind: block.kind,
    text: block.text,
    textHash,
    sources: block.sources,
  }))

  // 限额（全量或不发送）：超限即整体拒绝，绝不截断——用户应缩小 scope
  const totalUtf8Bytes = blocks.reduce((sum, b) => sum + utf8Bytes(b.text), 0)
  const estimatedTokens = estimateTokens(params.question) + blocks.reduce((sum, b) => sum + estimateTokens(b.text), 0)
  if (
    pages.length > limits.maxPages ||
    blocks.length > limits.maxBlocks ||
    totalUtf8Bytes > limits.maxUtf8Bytes ||
    estimatedTokens > limits.maxEstimatedTokens
  ) {
    return {
      status: 'projection_limit_exceeded',
      usage: { pages: pages.length, blocks: blocks.length, utf8Bytes: totalUtf8Bytes, estimatedTokens },
      limits,
    }
  }

  // 步骤 6：空结果不外发原文（raw outerHTML 永不进模型请求）
  if (blocks.length === 0) return { status: 'projection_empty' }

  // coverage（工作流 D）：unitCount = 去重后块数
  const manifestInput: ManifestInput = { ...params.manifestFacts, unitCount: blocks.length }
  const coverage = deriveCoverageManifest(manifestInput)

  // pageStateWatermarks：pages 覆盖的 pageInstanceId，按 id 排序（确定性）
  const factsStates = new Map(params.manifestFacts.pageStates.map(ps => [ps.pageInstanceId, ps]))
  const pageStateWatermarks = [...new Set(pages.map(p => p.source.pageInstanceId))]
    .sort((a, b) => (a < b ? -1 : 1))
    .map(pid => {
      const ps = factsStates.get(pid)!
      return { pageInstanceId: ps.pageInstanceId, stateVersion: ps.stateVersion, lastAppliedSequence: ps.lastAppliedSequence }
    })

  // inputHash（E-07）：固定键序 canonical JSON 的 sha256；blockDigests 只含稳定字段
  const canonical = JSON.stringify({
    schemaVersion: 1,
    projectionVersion: 1,
    question: params.question,
    scope: params.scope,
    pageStateWatermarks,
    coverage,
    blockDigests: blocks.map(b => ({ id: b.id, kind: b.kind, textHash: b.textHash, sources: b.sources })),
    limits,
    estimatedTokens,
  })
  const inputHash = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`

  const projection: QuestionProjection = {
    schemaVersion: 1,
    projectionVersion: 1,
    question: params.question,
    scope: params.scope,
    pageStateWatermarks,
    coverage,
    blocks,
    inputHash,
    limits,
    truncation: 'none',
  }
  return { status: 'ok', projection }
}
