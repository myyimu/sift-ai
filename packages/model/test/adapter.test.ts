// ModelAdapter 测试：全部走注入的 mock fetch，零真网络。
// 断言重点：最多两次 HTTP；redirect 拒绝且不重试；降级分支请求体形状；
// analyzer 本地盖章；API Key 剥离；json_schema↔zod 双向一致性（ajv）。
import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { ANSWER_PROJECTION_JSON_SCHEMA } from '../src/json-schema'
import { createModelAdapter, type FetchLike } from '../src/adapter'
import { answerProjectionSchema } from '@sift/shared'
import { BLOCKS, COVERAGE, CONFIG, validModelOutput } from './fixtures'

interface RecordedCall {
  url: string
  init: RequestInit
  body: any // eslint-disable-line @typescript-eslint/no-explicit-any -- 测试内省请求体
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function chatCompletion(content: string): unknown {
  return { choices: [{ message: { role: 'assistant', content } }] }
}

/** 依序回放脚本化响应的 mock fetch；记录每次调用。 */
function scriptedFetch(responses: Array<() => Promise<Response>>): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let index = 0
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) })
    const responder = responses[index]
    index += 1
    if (responder === undefined) throw new Error(`mock fetch: 未脚本化的第 ${index} 次调用`)
    return responder()
  }
  return { fetch, calls }
}

const okResponse = (): Promise<Response> =>
  Promise.resolve(jsonResponse(chatCompletion(JSON.stringify(validModelOutput()))))

const INPUT = { question: '这两份材料在讨论什么？', blocks: BLOCKS, coverage: COVERAGE }

describe('createModelAdapter.completeAnswer', () => {
  it('strict 正路径：恰好 1 次 HTTP；请求形状与提示词内容正确；analyzer 本地盖章', async () => {
    const { fetch, calls } = scriptedFetch([okResponse])
    const adapter = createModelAdapter({ config: CONFIG, fetchImpl: fetch })

    const result = await adapter.completeAnswer(INPUT)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe('https://api.example.com/chat/completions')
    expect(call.init.redirect).toBe('manual')
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CONFIG.apiKey}`)
    expect(call.body.model).toBe('gpt-x')
    expect(call.body.temperature).toBe(0)
    expect(call.body.response_format).toMatchObject({ type: 'json_schema' })
    expect(call.body.response_format.json_schema).toMatchObject({ name: 'answer_projection', strict: true })

    const messages = call.body.messages as Array<{ role: string; content: string }>
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toContain('基于当前选择的本地捕获范围：') // coverage 摘要进上下文
    expect(messages[0]!.content).toContain('未穷尽')
    expect(messages[1]!.content).toContain('问题：这两份材料在讨论什么？')
    expect(messages[1]!.content).toContain('[b-0001|heading]')

    expect(result.answer.analyzer).toEqual({ provider: 'api.example.com', model: 'gpt-x', promptVersion: 'answer-v1' })
  })

  it('降级：400 提及 response_format → 第二次 json_object + schema 注入 system；共 2 次 HTTP', async () => {
    const { fetch, calls } = scriptedFetch([
      () => Promise.resolve(jsonResponse({ error: { message: 'response_format json_schema is not supported' } }, 400)),
      okResponse,
    ])
    const result = await createModelAdapter({ config: CONFIG, fetchImpl: fetch }).completeAnswer(INPUT)

    expect(result.status).toBe('ok')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.body.response_format.type).toBe('json_schema')
    expect(calls[1]!.body.response_format.type).toBe('json_object')
    const system = (calls[1]!.body.messages as Array<{ role: string; content: string }>)[0]!.content
    expect(system).toContain('JSON Schema')
  })

  it('非降级失败恰好重试一次：500 → 200 → ok（共 2 次，模式不变）', async () => {
    const { fetch, calls } = scriptedFetch([
      () => Promise.resolve(jsonResponse({ error: 'boom' }, 500)),
      okResponse,
    ])
    const result = await createModelAdapter({ config: CONFIG, fetchImpl: fetch }).completeAnswer(INPUT)
    expect(result.status).toBe('ok')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body.response_format.type).toBe('json_schema')
  })

  it('两次 500 → failed model_http；绝不第三次', async () => {
    const { fetch, calls } = scriptedFetch([
      () => Promise.resolve(jsonResponse({ error: 'boom' }, 500)),
      () => Promise.resolve(jsonResponse({ error: 'boom' }, 500)),
    ])
    const result = await createModelAdapter({ config: CONFIG, fetchImpl: fetch }).completeAnswer(INPUT)
    expect(result).toMatchObject({ status: 'failed', code: 'model_http' })
    expect(calls).toHaveLength(2)
  })

  it('3xx 一律拒绝且不重试（redirect:manual）', async () => {
    const { fetch, calls } = scriptedFetch([
      () => Promise.resolve(new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/v1' } })),
    ])
    const result = await createModelAdapter({ config: CONFIG, fetchImpl: fetch }).completeAnswer(INPUT)
    expect(result).toMatchObject({ status: 'failed', code: 'model_redirect_rejected' })
    expect(calls).toHaveLength(1)
  })

  it('模型输出围栏 JSON 也能解析；两次 invalid JSON → failed', async () => {
    const fenced = (): Promise<Response> =>
      Promise.resolve(jsonResponse(chatCompletion('```json\n' + JSON.stringify(validModelOutput()) + '\n```')))
    const ok = await createModelAdapter({ config: CONFIG, fetchImpl: scriptedFetch([fenced]).fetch }).completeAnswer(INPUT)
    expect(ok.status).toBe('ok')

    const { fetch, calls } = scriptedFetch([
      () => Promise.resolve(jsonResponse({ choices: [] })),
      () => Promise.resolve(jsonResponse(chatCompletion('不是 JSON'))),
    ])
    const result = await createModelAdapter({ config: CONFIG, fetchImpl: fetch }).completeAnswer(INPUT)
    expect(result).toMatchObject({ status: 'failed', code: 'model_invalid_json' })
    expect(calls).toHaveLength(2)
  })

  it('悬空引用两次 → failed model_validation_failed（原因可见）', async () => {
    const dangling = (): Promise<Response> => {
      const bad = validModelOutput() as { claims: Array<{ evidenceBlockRefs: string[] }> }
      bad.claims[0]!.evidenceBlockRefs = ['b-9999']
      return Promise.resolve(jsonResponse(chatCompletion(JSON.stringify(bad))))
    }
    const { fetch, calls } = scriptedFetch([dangling, dangling])
    const result = await createModelAdapter({ config: CONFIG, fetchImpl: fetch }).completeAnswer(INPUT)
    expect(result).toMatchObject({ status: 'failed', code: 'model_validation_failed' })
    if (result.status === 'failed') expect(result.message).toContain('b-9999')
    expect(calls).toHaveLength(2)
  })

  it('超时 → model_timeout（abort 信号驱动，两次后失败）', async () => {
    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    const adapter = createModelAdapter({ config: CONFIG, fetchImpl: hangingFetch, timeoutMs: 30 })
    const result = await adapter.completeAnswer(INPUT)
    expect(result).toMatchObject({ status: 'failed', code: 'model_timeout' })
  })

  it('失败 message 剥离 API Key（端点回显 key 也不外泄）', async () => {
    const echoKey = (): Promise<Response> =>
      Promise.resolve(jsonResponse({ error: `bad key ${CONFIG.apiKey}` }, 401))
    const { fetch } = scriptedFetch([echoKey, echoKey])
    const result = await createModelAdapter({ config: CONFIG, fetchImpl: fetch }).completeAnswer(INPUT)
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.message).toContain('[redacted]')
    expect(result.message).not.toContain(CONFIG.apiKey)
  })
})

describe('createModelAdapter.completeJson', () => {
  it('支持 schema 请求与本地校验回调，非法结果按两次上限失败', async () => {
    const { fetch, calls } = scriptedFetch([
      () => Promise.resolve(jsonResponse(chatCompletion(JSON.stringify({ ok: true })))),
    ])
    const result = await createModelAdapter({ config: CONFIG, fetchImpl: fetch }).completeJson({
      system: '只输出 JSON', user: '返回 ok', schemaName: 'demo', schema: { type: 'object' },
      validate: candidate => candidate !== null && typeof candidate === 'object' && (candidate as { ok?: unknown }).ok === true
        ? { ok: true as const, value: 'accepted' }
        : { ok: false as const, reasons: ['invalid'] },
    })
    expect(result).toEqual({ status: 'ok', value: 'accepted' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.response_format.json_schema.name).toBe('demo')
  })
})

describe('ANSWER_PROJECTION_JSON_SCHEMA ↔ zod 一致性', () => {
  const ajv = new Ajv({ strict: false })
  const validateJsonSchema = ajv.compile(ANSWER_PROJECTION_JSON_SCHEMA as object)

  it('合法样本：JSON Schema 与 zod 双双通过', () => {
    const sample = validModelOutput()
    expect(validateJsonSchema(sample)).toBe(true)
    expect(answerProjectionSchema.safeParse(sample).success).toBe(true)
  })

  it('非法样本矩阵：两边一致拒绝', () => {
    const bad: unknown[] = [
      { ...validModelOutput(), answer: '' },
      { ...validModelOutput(), schemaVersion: 2 },
      { ...validModelOutput(), extra: 1 },
      { ...validModelOutput(), claims: [{ claimId: 'c', text: 't', evidenceBlockRefs: [] }] },
      { ...validModelOutput(), sources: [{ evidenceBlockRef: '' }] },
      { ...validModelOutput(), analyzer: { provider: 'x' } },
    ]
    for (const sample of bad) {
      expect(validateJsonSchema(sample)).toBe(false)
      expect(answerProjectionSchema.safeParse(sample).success).toBe(false)
    }
  })
})
