// 问答编排服务（路线图步骤 4/5 的编排层；Electron 无关）。
//
// UI 主进程（main.ts IPC）与 qa-cli（node 直跑）都是本模块的薄壳——产品路径只有
// 一条：readOnly 打开 store（与 host 写者共存，ADR-003）→ 从 journal/page-state
// 组装投影事实 → projectQuestion（全量或不发送）→ ModelAdapter（确认后才发生，
// 验收门 9：确认前模型调用次数为零）→ 本地 zod+跨对象校验 → 答案落盘。
//
// 纪律：
//  - Raw DOM/outerHTML 永不进入日志与 AI 请求——发出去的只有投影 blocks（脱敏+
//    去噪后的文本）；本模块不 console 任何页面内容；
//  - API key 只进内存 config，任何摘要/答案/日志都不含它（D-051）；
//  - 答案持久化 = <storeRoot>/../answers/<inputHash>.json（自包含 QuestionProjection
//    + AnswerProjection；同 inputHash 覆盖 = spec §2.3 "可删除、可重建"）。
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AnswerProjection, ObservationEnvelope, QuestionProjection } from '@sift/shared'
import { TTL_DAYS } from '@sift/shared/limits'
import { estimateTokens, utf8Bytes } from '@sift/shared/tokens'
import { openSiftStore, defaultStoreRoot, type StorePageSummary, type StoreSessionSummary } from '@sift/store'
import { deleteAllData, deletePageData, deleteSessionData, type SessionDeleteReport } from '@sift/store'
import {
  projectQuestion,
  type ManifestFacts,
  type ManifestObservation,
  type ManifestPageState,
  type ProjectorPageInput,
} from '@sift/projector'
import {
  createModelAdapter,
  loadModelConfig,
  modelConfigSummary,
  type FetchLike,
  type ModelConfig,
  type ModelConfigSummary,
  type ModelResult,
} from '@sift/model'

// —— scope ——

export type QaScope =
  | { readonly kind: 'current_page'; readonly pageInstanceId: string }
  | { readonly kind: 'demo_session'; readonly sessionId: string }

/** CLI/UI 用的 scope 字符串形（page:<pid> / session:<sid> / latest-session）。 */
export function parseScope(raw: string, latestSessionId: string | undefined): QaScope | { error: string } {
  if (raw === 'latest-session') {
    return latestSessionId === undefined
      ? { error: 'store 中没有任何 session' }
      : { kind: 'demo_session', sessionId: latestSessionId }
  }
  if (raw.startsWith('page:')) {
    const pid = raw.slice('page:'.length)
    return pid === '' ? { error: 'page: 后缺少 pageInstanceId' } : { kind: 'current_page', pageInstanceId: pid }
  }
  if (raw.startsWith('session:')) {
    const sid = raw.slice('session:'.length)
    return sid === '' ? { error: 'session: 后缺少 sessionId' } : { kind: 'demo_session', sessionId: sid }
  }
  return { error: `无法解析 scope "${raw}"（可用：page:<pid> | session:<sid> | latest-session）` }
}

// —— overview ——

export interface StoreOverview {
  readonly storeRoot: string
  readonly sessions: readonly StoreSessionSummary[]
  readonly pages: readonly StorePageSummary[]
  readonly modelConfig: ModelConfigSummary
}

/** store 只读概览。全程零网络（UI 首屏与轮询即此，模型配置只回无密摘要）。 */
export async function getStoreOverview(rootDir: string, env: Record<string, string | undefined> = process.env): Promise<StoreOverview> {
  const store = await openSiftStore({ rootDir, readOnly: true })
  try {
    const [sessions, pages] = [await store.listSessions(), await store.listPages()]
    return { storeRoot: resolve(rootDir), sessions, pages, modelConfig: modelConfigSummary(loadModelConfig(env)) }
  } finally {
    await store.close()
  }
}

// —— 投影 ——

export interface ProjectionPreview {
  readonly pages: number
  /** 参与合并的快照份数（distinct payload；同一页滚动历史的多张快照都在内）。 */
  readonly snapshots: number
  readonly blocks: number
  readonly utf8Bytes: number
  readonly estimatedTokens: number
}

export type BuildProjectionResult =
  | { readonly status: 'ok'; readonly projection: QuestionProjection; readonly preview: ProjectionPreview }
  | { readonly status: 'scope_not_found'; readonly message: string }
  | { readonly status: 'projection_empty' }
  | { readonly status: 'projection_input_invalid'; readonly reason: string }
  | {
      readonly status: 'projection_limit_exceeded'
      readonly usage: { readonly pages: number; readonly blocks: number; readonly utf8Bytes: number; readonly estimatedTokens: number }
      readonly limits: { readonly maxPages: number; readonly maxBlocks: number; readonly maxUtf8Bytes: number; readonly maxEstimatedTokens: number }
    }

/**
 * 组装 scope 内的投影事实并调用 projectQuestion。全程零网络、零模型调用——
 * 确认屏展示的正是返回的 preview + projection.blocks 文本预览。
 */
export async function buildProjectionForScope(
  rootDir: string,
  scope: QaScope,
  question: string,
  modelContextWindow: number,
): Promise<BuildProjectionResult> {
  const store = await openSiftStore({ rootDir, readOnly: true })
  try {
    const allPages = await store.listPages()
    const pages =
      scope.kind === 'current_page'
        ? allPages.filter(p => p.pageInstanceId === scope.pageInstanceId)
        : allPages.filter(p => p.sessionId === scope.sessionId)
    if (pages.length === 0) {
      return {
        status: 'scope_not_found',
        message: scope.kind === 'current_page' ? `store 中没有 pageInstanceId ${scope.pageInstanceId}` : `store 中没有 session ${scope.sessionId}`,
      }
    }

    const journal = await store.readJournal(
      scope.kind === 'current_page' ? { pageInstanceId: scope.pageInstanceId } : { sessionId: scope.sessionId },
    )

    // manifest 事实：控制事件 payload 解码（授权缺口/盲区判定需要）；快照行正文不进 manifest
    const observations: ManifestObservation[] = []
    for (const row of journal) {
      const controlPayload =
        row.type === 'dom_snapshot'
          ? null
          : (JSON.parse(Buffer.from(await store.readBlob(row.payloadHash)).toString('utf8')) as unknown)
      observations.push({
        id: row.id,
        sessionId: row.sessionId,
        tabId: row.tabId,
        pageInstanceId: row.pageInstanceId,
        sequence: row.sequence,
        receivedAt: row.receivedAt,
        url: row.url,
        type: row.type,
        controlPayload,
      })
    }

    const pageStates: ManifestPageState[] = pages.map(p => ({
      pageInstanceId: p.pageInstanceId,
      stateVersion: p.watermark.stateVersion,
      lastAppliedSequence: p.watermark.lastAppliedSequence,
      canonicalUrl: p.canonicalUrl,
    }))

    // 页面输入：块级合并投影（2026-08-28，P0_DEMO_SCOPE §2.4 批注）。每页不再只喂
    // Page State 的最新一张快照，而是喂该页 journal 里全部已 commit 快照的首见序列
    //（相同 payloadHash 只取第一次出现——内容寻址 blob 天然去重）。projector 内全局
    // textHash 去重合并 sources、块序按首见 capturedAt——效果 = 用户实际看过的内容
    // 并集（滚动历史不丢），而非提问瞬间的最后一屏。逐快照 stateVersion 按 page-state
    // reducer 同款语义走一遍 journal 推导（每应用一条 observation 自增，重放不增）。
    const rowsByPage = new Map<string, ObservationEnvelope[]>()
    for (const row of journal) {
      const list = rowsByPage.get(row.pageInstanceId)
      if (list !== undefined) list.push(row)
      else rowsByPage.set(row.pageInstanceId, [row])
    }
    const pageInputs: ProjectorPageInput[] = []
    for (const page of pages) {
      if (page.snapshotBlobRef === '') continue // 尚无快照的页：无证据可投影
      let lastApplied = -1 // 首行无条件应用（reducePageState 的 prev===null 分支）
      let version = 0
      const firstSeen = new Map<string, { stateVersion: number; receivedAt: string }>()
      for (const row of rowsByPage.get(page.pageInstanceId) ?? []) {
        if (row.sequence <= lastApplied) continue // 幂等重放不增版本（reducePageState 同款）
        version += 1
        lastApplied = row.sequence
        if (row.type === 'dom_snapshot' && !firstSeen.has(row.payloadHash)) {
          firstSeen.set(row.payloadHash, { stateVersion: version, receivedAt: row.receivedAt })
        }
      }
      for (const [payloadHash, seen] of firstSeen) {
        const payload = await store.readSnapshotPayload(payloadHash)
        pageInputs.push({
          sanitizedHtml: payload.html,
          source: {
            pageInstanceId: page.pageInstanceId,
            stateVersion: seen.stateVersion,
            ordinal: 0,
            ...(payload.title !== '' ? { title: payload.title } : {}),
            safeUrl: payload.url,
            capturedAt: seen.receivedAt,
          },
        })
      }
    }
    if (pageInputs.length === 0) return { status: 'projection_empty' }

    const facts: ManifestFacts = { scope, observations, pageStates }
    const result = projectQuestion({ question, scope: scope.kind, pages: pageInputs, manifestFacts: facts, modelContextWindow })
    if (result.status === 'ok') {
      const totalUtf8Bytes = result.projection.blocks.reduce((sum, b) => sum + utf8Bytes(b.text), 0)
      const estimatedTokens =
        estimateTokens(question) + result.projection.blocks.reduce((sum, b) => sum + estimateTokens(b.text), 0)
      return {
        status: 'ok',
        projection: result.projection,
        preview: {
          pages: new Set(pageInputs.map(p => p.source.pageInstanceId)).size,
          snapshots: pageInputs.length,
          blocks: result.projection.blocks.length,
          utf8Bytes: totalUtf8Bytes,
          estimatedTokens,
        },
      }
    }
    return result
  } finally {
    await store.close()
  }
}

// —— 问答与答案持久化 ——

/** 答案目录：storeRoot 的姊妹目录（删除数据时连带清空，见 deleteAllStoreData）。 */
export function answersDirOf(rootDir: string): string {
  return join(dirname(resolve(rootDir)), 'answers')
}

export interface StoredAnswer {
  readonly schemaVersion: 1
  readonly questionProjection: QuestionProjection
  readonly answer: AnswerProjection
  readonly completedAt: string
}

/** ModelResult 的失败分支（askModel 失败时必属此形；收窄给 CLI/UI 直接取 code/message）。 */
export type ModelFailed = Extract<ModelResult, { readonly status: 'failed' }>

export type AskResult = { readonly status: 'ok'; readonly answer: StoredAnswer; readonly answerPath: string } | { readonly status: 'failed'; readonly result: ModelFailed }

/**
 * 唯一的模型调用入口（确认屏之后才允许到达这里）。adapter 内部完成 zod+跨对象
 * 校验；只有校验通过才落盘。fetchImpl 仅供测试注入，产品路径用 globalThis.fetch。
 */
export async function askModel(
  rootDir: string,
  projection: QuestionProjection,
  config: ModelConfig,
  fetchImpl?: FetchLike,
): Promise<AskResult> {
  const adapter = createModelAdapter({ config, ...(fetchImpl !== undefined ? { fetchImpl } : {}) })
  const result = await adapter.completeAnswer({
    question: projection.question,
    blocks: projection.blocks,
    coverage: projection.coverage,
  })
  if (result.status !== 'ok') return { status: 'failed', result }

  const answer: StoredAnswer = {
    schemaVersion: 1,
    questionProjection: projection,
    answer: result.answer,
    completedAt: new Date().toISOString(),
  }
  const dir = answersDirOf(rootDir)
  await mkdir(dir, { recursive: true })
  const answerPath = join(dir, `${projection.inputHash.slice('sha256:'.length)}.json`)
  await writeFile(answerPath, `${JSON.stringify(answer, null, 2)}\n`, 'utf8')
  return { status: 'ok', answer, answerPath }
}

// —— 答案列表 ——

export interface StoredAnswerSummary {
  readonly inputHash: string
  readonly question: string
  readonly completedAt: string
  readonly answerPreview: string
  readonly analyzer: { readonly provider: string; readonly model: string; readonly promptVersion: string }
}

export async function listAnswers(rootDir: string): Promise<readonly StoredAnswerSummary[]> {
  const dir = answersDirOf(rootDir)
  let names: readonly string[]
  try {
    names = await readdir(dir)
  } catch {
    return [] // answers 目录不存在 = 还没有答案
  }
  const summaries: StoredAnswerSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const doc = JSON.parse(await readFile(join(dir, name), 'utf8')) as StoredAnswer
      summaries.push({
        inputHash: doc.questionProjection.inputHash,
        question: doc.questionProjection.question,
        completedAt: doc.completedAt,
        answerPreview: doc.answer.answer.slice(0, 120),
        analyzer: doc.answer.analyzer,
      })
    } catch {
      // 单个答案文件损坏：跳过（列表不因一份坏文件整体失败）
    }
  }
  return summaries.sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1))
}

/** UI 启动时清理过期派生答案；损坏文件保守保留，避免删除无法验证归属的数据。 */
export async function pruneExpiredAnswerFiles(rootDir: string, now = new Date()): Promise<void> {
  const dir = answersDirOf(rootDir)
  const cutoff = now.getTime() - TTL_DAYS * 24 * 60 * 60 * 1000
  let names: readonly string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const path = join(dir, name)
      const doc = JSON.parse(await readFile(path, 'utf8')) as StoredAnswer
      const completedAt = Date.parse(doc.completedAt)
      if (Number.isFinite(completedAt) && completedAt < cutoff) await unlink(path)
    } catch {
      // 保守保留损坏文件，交由用户一键删除。
    }
  }
}

// —— 维护性删除（转发 @sift/store/maintenance；验收门 14） ——

async function deleteAnswerFiles(rootDir: string, pageIds: ReadonlySet<string>): Promise<void> {
  const dir = answersDirOf(rootDir)
  let names: readonly string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const doc = JSON.parse(await readFile(join(dir, name), 'utf8')) as StoredAnswer
      const touchesDeletedPage = doc.questionProjection.pageStateWatermarks.some(w => pageIds.has(w.pageInstanceId))
      if (touchesDeletedPage) await unlink(join(dir, name))
    } catch {
      // 损坏答案不阻塞本地数据删除；delete-all 仍会清理整个目录。
    }
  }
}

export async function deleteSessionStoreData(rootDir: string, sessionId: string): Promise<SessionDeleteReport> {
  const store = await openSiftStore({ rootDir, readOnly: true })
  let pageIds: readonly string[]
  try {
    pageIds = (await store.listPages({ sessionId })).map(page => page.pageInstanceId)
  } finally {
    await store.close()
  }
  const report = await deleteSessionData(rootDir, sessionId)
  await deleteAnswerFiles(rootDir, new Set(pageIds))
  return report
}

export async function deletePageStoreData(rootDir: string, pageInstanceId: string): Promise<SessionDeleteReport> {
  const report = await deletePageData(rootDir, pageInstanceId)
  await deleteAnswerFiles(rootDir, new Set([pageInstanceId]))
  return report
}

export async function deleteAllStoreData(rootDir: string): Promise<void> {
  await deleteAllData(rootDir, { answersDir: answersDirOf(rootDir) })
}

// —— root 解析 ——

export function resolveStoreRoot(explicit?: string): string {
  return explicit !== undefined && explicit !== '' ? resolve(explicit) : defaultStoreRoot()
}
