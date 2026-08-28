// qa-service 测试（Electron 无关，node 直跑）：真 FsStore 夹具 + 真 projectQuestion +
// mock fetch 的 ModelAdapter。重点门槛：
//  - overview/buildProjection 全程 fetch 计数 0（验收门 9：确认前模型调用为零）；
//  - askModel 只有校验通过才落盘（answers 目录 = storeRoot 姊妹目录）；
//  - 任何摘要/答案不含 apiKey（D-051）。
// 夹具布局：root = <mkdtemp>/store（answers 姊妹目录天然隔离于其他测试文件）。
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObservationEnvelope } from '@sift/shared'
import { CAPTURE_VERSION, REDACTION_POLICY } from '@sift/shared/wire'
import { openSiftStore, type SiftFsStore } from '@sift/store'
import {
  answersDirOf,
  askModel,
  buildProjectionForScope,
  deletePageStoreData,
  getStoreOverview,
  listAnswers,
  parseScope,
  deleteAllStoreData,
} from '../src/qa-service'
import type { ModelConfig } from '@sift/model'

// —— 夹具 ——

function sha256Of(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function envelopeOf(over: Partial<ObservationEnvelope>): ObservationEnvelope {
  const hash = sha256Of(new TextEncoder().encode(`placeholder-${over.id ?? 'x'}`))
  return {
    schemaVersion: 1,
    id: 'obs-1',
    sessionId: 'sess-1',
    tabId: 'tab-1',
    pageInstanceId: 'page-a',
    contentEpoch: 0,
    sequence: 0,
    receivedAt: '2026-08-27T00:00:00.000Z',
    url: 'https://example.com/article',
    source: 'extension',
    type: 'dom_snapshot',
    payloadRef: hash,
    payloadHash: hash,
    redactionPolicy: REDACTION_POLICY,
    captureVersion: CAPTURE_VERSION,
    ...over,
  }
}

function snapPayload(html: string, url: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    kind: 'dom_snapshot',
    captureVersion: CAPTURE_VERSION,
    reason: 'initial_readable',
    url,
    title: '示例文章',
    contentEpoch: 0,
    html,
    stats: { nodeCount: 9, maxDepth: 5, htmlUtf8Bytes: html.length },
  }))
}

/** dom_snapshot 的 html 是完整文档（CS 捕获形态）；抽取器按 html/body/main 语境剥离。 */
function doc(bodyInner: string): string {
  return `<html><head><title>示例文章</title></head><body>${bodyInner}</body></html>`
}

const PAGE_A_HTML = doc(
  '<main><h1>本地优先的数据观察</h1><p>这篇文章讨论了本地优先软件在数据主权上的取舍，作者主张把观察数据留在本机处理。</p><p>文章还比较了云端同步与本地存储的边界，认为演示场景应优先保证可审计性与可删除性。</p></main>',
)
const PAGE_B_HTML = doc(
  '<main><h2>第二页：覆盖声明的意义</h2><p>覆盖声明用于如实描述观察范围的边界，观察者永远不声明自己已经看尽了全部内容。</p></main>',
)

const QUESTION = '这篇文章主张什么？'

let baseDir: string
let root: string
let writer: SiftFsStore | null = null

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'sift-qa-'))
  root = join(baseDir, 'store')
  writer = await openSiftStore({ rootDir: root })
})

afterEach(async () => {
  await writer?.close()
  writer = null
  await rm(baseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
})

async function append(envelope: Partial<ObservationEnvelope>, payload: Uint8Array): Promise<void> {
  const hash = sha256Of(payload)
  await writer!.appendObservation(envelopeOf({ payloadRef: hash, payloadHash: hash, ...envelope }), payload)
}

function grantedPayload(origin: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1, kind: 'authorization_granted', captureVersion: CAPTURE_VERSION,
    url: `${origin}/a`, reason: 'user_gesture', origin,
  }))
}

async function seedTwoPages(): Promise<void> {
  await append({ id: 'a-0', pageInstanceId: 'page-a', sequence: 0, type: 'authorization_granted' }, grantedPayload('https://example.com'))
  await append({ id: 'a-1', pageInstanceId: 'page-a', sequence: 1 }, snapPayload(PAGE_A_HTML, 'https://example.com/a'))
  await append({ id: 'b-0', pageInstanceId: 'page-b', sequence: 0, type: 'authorization_granted' }, grantedPayload('https://example.com'))
  await append({ id: 'b-1', pageInstanceId: 'page-b', sequence: 1 }, snapPayload(PAGE_B_HTML, 'https://example.com/b?page=2'))
}

const CONFIG: ModelConfig = {
  baseUrl: 'http://127.0.0.1:9',
  origin: 'http://127.0.0.1:9',
  apiKey: 'sk-secret-key-DO-NOT-LEAK',
  model: 'mock-model',
  contextWindow: 128000,
}

/** OpenAI 兼容 chat completion 应答（content 里带模型输出 JSON）。 */
function completionResponse(answerJson: string): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    json: async () => ({ choices: [{ message: { content: answerJson } }] }),
    text: async () => '',
  } as unknown as Response
}

function modelOutputJson(blockRefs: string[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    answer: '文章主张把观察数据留在本机处理，并优先保证可审计性与可删除性。',
    claims: blockRefs.map((ref, i) => ({ claimId: `c-${i + 1}`, text: `论断 ${i + 1}：来自证据块 ${ref}。`, evidenceBlockRefs: [ref] })),
    limitations: [],
    sources: blockRefs.map(ref => ({ evidenceBlockRef: ref })),
    analyzer: { provider: 'self-reported', model: 'self-reported', promptVersion: 'self-reported' },
  })
}

// —— 用例 ——

describe('getStoreOverview', () => {
  it('形状正确且零网络；摘要永不包含 apiKey', async () => {
    await seedTwoPages()
    await writer!.close()
    writer = null
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('不许网络')))

    const overview = await getStoreOverview(root, {
      SIFT_MODEL_BASE_URL: 'https://api.example.com',
      SIFT_MODEL_API_KEY: 'sk-secret-key-DO-NOT-LEAK',
      SIFT_MODEL_ID: 'gpt-x',
      SIFT_MODEL_CTX: '128000',
    })

    expect(overview.sessions).toHaveLength(1)
    expect(overview.pages).toHaveLength(2)
    expect(overview.pages.map(p => p.canonicalUrl).sort()).toEqual(['https://example.com/a', 'https://example.com/b?page=2'])
    expect(overview.modelConfig).toEqual({ configured: true, baseUrl: 'https://api.example.com', model: 'gpt-x', contextWindow: 128000 })
    expect(JSON.stringify(overview)).not.toContain('sk-secret-key')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('buildProjectionForScope', () => {
  it('current_page：投影 ok、blocks ≥1、全程零 fetch', async () => {
    await seedTwoPages()
    await writer!.close()
    writer = null
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('不许网络')))

    const result = await buildProjectionForScope(root, { kind: 'current_page', pageInstanceId: 'page-a' }, QUESTION, 128000)

    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.preview.pages).toBe(1)
    expect(result.preview.blocks).toBeGreaterThanOrEqual(3) // h1 + 两个段落
    expect(result.projection.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.projection.blocks.every(b => b.sources.every(s => s.pageInstanceId === 'page-a'))).toBe(true)
    expect(result.projection.coverage.requestedScope).toEqual({ kind: 'current_page', pageInstanceId: 'page-a' })
    // 原始 HTML 永不进投影：块文本是抽取后的纯文本
    expect(JSON.stringify(result.projection.blocks)).not.toContain('<main>')
  })

  it('demo_session：跨两页聚合；scope_not_found / projection_empty 语义正确', async () => {
    await seedTwoPages()
    // 再造一个只有授权、没有快照的页（projection_empty 路径）
    await append({ id: 'c-0', pageInstanceId: 'page-c', sequence: 0, type: 'authorization_granted' }, grantedPayload('https://example.com'))
    await writer!.close()
    writer = null

    const session = (await getStoreOverview(root)).sessions[0]!.sessionId
    const scoped = await buildProjectionForScope(root, { kind: 'demo_session', sessionId: session }, QUESTION, 128000)
    expect(scoped.status).toBe('ok')
    if (scoped.status === 'ok') {
      expect(scoped.preview.pages).toBe(2)
      const origins = new Set(scoped.projection.blocks.flatMap(b => b.sources.map(s => s.pageInstanceId)))
      expect(origins).toEqual(new Set(['page-a', 'page-b']))
    }

    const unknown = await buildProjectionForScope(root, { kind: 'current_page', pageInstanceId: 'page-zzz' }, QUESTION, 128000)
    expect(unknown).toMatchObject({ status: 'scope_not_found' })

    const empty = await buildProjectionForScope(root, { kind: 'current_page', pageInstanceId: 'page-c' }, QUESTION, 128000)
    expect(empty).toMatchObject({ status: 'projection_empty' })
  })

  it('滚动历史块级合并（2026-08-28）：三张快照的并集去重、sources 合并、首见排序；同 payload 重捕不增快照数', async () => {
    const FLOOR1 = '一楼：楼主提出了一个关于本地优先架构的问题，并给出了自己的初步方案。'
    const FLOOR2 = '二楼：回复者指出方案在多设备同步上的缺陷，建议引入 CRDT。'
    const FLOOR3 = '三楼：楼主补充说明了离线场景的取舍，认为冲突解决可以延后。'
    const FLOOR4 = '四楼：新回复引用了二楼的观点，认为 CRDT 对演示场景过重。'
    const snap = (floors: string): string => doc(`<main><h1>长帖标题</h1>${floors}</main>`)
    await append({ id: 's-0', pageInstanceId: 'page-scroll', sequence: 0, type: 'authorization_granted' }, grantedPayload('https://example.com'))
    // 视口 1（F1+F2）→ 视口 2（F1~F3，虚拟化下仍是部分 DOM）→ 视口 3（F3+F4）
    await append({ id: 's-1', pageInstanceId: 'page-scroll', sequence: 1, receivedAt: '2026-08-27T00:00:01.000Z' }, snapPayload(snap(`<p>${FLOOR1}</p><p>${FLOOR2}</p>`), 'https://example.com/thread'))
    await append({ id: 's-2', pageInstanceId: 'page-scroll', sequence: 2, receivedAt: '2026-08-27T00:00:02.000Z' }, snapPayload(snap(`<p>${FLOOR1}</p><p>${FLOOR2}</p><p>${FLOOR3}</p>`), 'https://example.com/thread'))
    await append({ id: 's-3', pageInstanceId: 'page-scroll', sequence: 3, receivedAt: '2026-08-27T00:00:03.000Z' }, snapPayload(snap(`<p>${FLOOR3}</p><p>${FLOOR4}</p>`), 'https://example.com/thread'))
    // 内容与 s-2 逐字节相同的重捕（相同 payload → 相同 hash）：distinct 快照数不增
    await append({ id: 's-4', pageInstanceId: 'page-scroll', sequence: 4, receivedAt: '2026-08-27T00:00:04.000Z' }, snapPayload(snap(`<p>${FLOOR1}</p><p>${FLOOR2}</p><p>${FLOOR3}</p>`), 'https://example.com/thread'))
    await writer!.close()
    writer = null

    const result = await buildProjectionForScope(root, { kind: 'current_page', pageInstanceId: 'page-scroll' }, QUESTION, 128000)

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.preview.pages).toBe(1)
    expect(result.preview.snapshots).toBe(3) // s-4 与 s-2 同 payload，首见去重
    // 块 = 标题 + 四层楼的并集，顺序 = 首见（阅读）顺序——旧语义下只会剩视口 3 的 F3+F4
    expect(result.projection.blocks.map(b => b.text)).toEqual(['长帖标题', FLOOR1, FLOOR2, FLOOR3, FLOOR4])
    // stateVersion 按 journal 重放推导（授权=1，s-1=2，s-2=3，s-3=4）；同块跨快照合并 sources
    expect(result.projection.blocks[1]!.sources.map(s => s.stateVersion)).toEqual([2, 3]) // F1 见于 s-1/s-2
    expect(result.projection.blocks[3]!.sources.map(s => s.stateVersion)).toEqual([3, 4]) // F3 见于 s-2/s-3
    expect(result.projection.blocks[4]!.sources.map(s => s.stateVersion)).toEqual([4]) // F4 仅 s-3
  })

  it('parseScope：page:/session:/latest-session 与错误分支', async () => {
    expect(parseScope('page:p-1', undefined)).toEqual({ kind: 'current_page', pageInstanceId: 'p-1' })
    expect(parseScope('session:s-1', undefined)).toEqual({ kind: 'demo_session', sessionId: 's-1' })
    expect(parseScope('latest-session', 's-9')).toEqual({ kind: 'demo_session', sessionId: 's-9' })
    expect(parseScope('latest-session', undefined)).toMatchObject({ error: expect.stringContaining('session') })
    expect(parseScope('page:', undefined)).toMatchObject({ error: expect.stringContaining('pageInstanceId') })
    expect(parseScope('whatever', 's-1')).toMatchObject({ error: expect.stringContaining('scope') })
  })
})

describe('askModel + 答案持久化', () => {
  async function projectionOf(): Promise<Parameters<typeof askModel>[1]> {
    const built = await buildProjectionForScope(root, { kind: 'current_page', pageInstanceId: 'page-a' }, QUESTION, 128000)
    if (built.status !== 'ok') throw new Error(`夹具投影失败：${built.status}`)
    return built.projection
  }

  it('校验通过 → 答案落盘 answers/<inputHash>.json，analyzer 本地盖章，请求恰好 1 次', async () => {
    await seedTwoPages()
    await writer!.close()
    writer = null
    const projection = await projectionOf()
    const firstBlock = projection.blocks[0]!.id

    const calls: string[] = []
    const result = await askModel(root, projection, CONFIG, async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      return completionResponse(modelOutputJson([firstBlock]))
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(calls).toEqual([`POST ${CONFIG.baseUrl}/chat/completions`]) // 恰好 1 次模型调用
    expect(result.answer.answer.analyzer).toEqual({ provider: '127.0.0.1', model: 'mock-model', promptVersion: 'answer-v1' }) // 本地盖章覆盖模型自报（provider=baseUrl host）

    const dir = answersDirOf(root)
    expect(dir).toBe(join(baseDir, 'answers'))
    const files = await readdir(dir)
    expect(files).toEqual([`${projection.inputHash.slice('sha256:'.length)}.json`])
    const doc = JSON.parse(await readFile(join(dir, files[0]!), 'utf8')) as { questionProjection: { question: string }; answer: { answer: string } }
    expect(doc.questionProjection.question).toBe(QUESTION)
    expect(doc.answer.answer).toContain('本机')
    expect(JSON.stringify(doc)).not.toContain('sk-secret')
  })

  it('校验失败（悬空引用）→ 不落盘，失败 code 为 model_validation_failed', async () => {
    await seedTwoPages()
    await writer!.close()
    writer = null
    const projection = await projectionOf()

    const result = await askModel(root, projection, CONFIG, async () => completionResponse(modelOutputJson(['b-9999'])))
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.result.code).toBe('model_validation_failed')
    await expect(readdir(answersDirOf(root))).rejects.toMatchObject({ code: 'ENOENT' }) // 一个答案都没写
  })

  it('listAnswers 列出已存答案；deleteAllStoreData 连带清空 answers', async () => {
    await seedTwoPages()
    await writer!.close()
    writer = null
    const projection = await projectionOf()
    const asked = await askModel(root, projection, CONFIG, async () => completionResponse(modelOutputJson([projection.blocks[0]!.id])))
    expect(asked.status).toBe('ok')

    const answers = await listAnswers(root)
    expect(answers).toHaveLength(1)
    expect(answers[0]!.question).toBe(QUESTION)
    expect(answers[0]!.analyzer.model).toBe('mock-model')

    await deleteAllStoreData(root)
    await expect(listAnswers(root)).resolves.toEqual([])
  })

  it('删除 Page 时同步删除引用该 Page 的派生答案', async () => {
    await seedTwoPages()
    await writer!.close()
    writer = null
    const projection = await projectionOf()
    const asked = await askModel(root, projection, CONFIG, async () => completionResponse(modelOutputJson([projection.blocks[0]!.id])))
    expect(asked.status).toBe('ok')
    await expect(listAnswers(root)).resolves.toHaveLength(1)

    const report = await deletePageStoreData(root, 'page-a')
    expect(report.removedObservations).toBeGreaterThan(0)
    await expect(listAnswers(root)).resolves.toEqual([])
  })
})
