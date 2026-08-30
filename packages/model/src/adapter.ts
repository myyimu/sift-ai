// ModelAdapter：OpenAI-compatible Chat Completions（ADR-001 E-06 冻结实现）。
//
// 边界纪律：
//  - 非流式单次调用；最多两次 HTTP（“恰好一次确定性重试”与 json_schema→json_object
//    降级共用第二次调用位，绝不第三次）；
//  - redirect:'manual'，任何 3xx 一律失败（不自动跟随，防止 Key/投影被转发到未预览
//    origin）；重定向是确定性同结果，不消耗重试；
//  - 失败分类走结果联合，不抛异常；任何失败 message 都先剥离 API Key 再返回；
//  - analyzer 三元组由本地盖章（provider=baseUrl host / model=config.model /
//    promptVersion=answer-v1），模型自报值不采信；
//  - 本模块不 console 任何请求/响应内容（Raw DOM 与投影正文不进日志）。
import type { AnswerProjection, CoverageManifest, DemoEvidenceBlock } from '@sift/shared'
import type { ModelConfig } from './config'
import { ANSWER_PROJECTION_JSON_SCHEMA } from './json-schema'
import { PROMPT_VERSION, buildAnswerMessages, withSchemaInstruction } from './prompt'
import { validateAnswerProjection } from './validate'

/** 版本化 Demo 默认值（规范未冻结超时；调整属实现变更，随 README/RUNBOOK 记录）。 */
export const MODEL_TIMEOUT_MS = 90_000

export type ModelFailureCode =
  | 'model_config_missing'
  | 'model_origin_rejected'
  | 'model_redirect_rejected'
  | 'model_http'
  | 'model_timeout'
  | 'model_invalid_json'
  | 'model_validation_failed'
  | 'model_transport'

export type ModelResult =
  | { readonly status: 'ok'; readonly answer: AnswerProjection }
  | { readonly status: 'failed'; readonly code: ModelFailureCode; readonly message: string }

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface CompleteAnswerInput {
  readonly question: string
  readonly blocks: readonly DemoEvidenceBlock[]
  readonly coverage: CoverageManifest
}

export interface CompleteJsonInput<T> {
  readonly system: string
  readonly user: string
  readonly schemaName: string
  readonly schema: unknown
  readonly validate: (candidate: unknown) => { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reasons: readonly string[] }
}

export type JsonModelResult<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'failed'; readonly code: ModelFailureCode; readonly message: string }

interface ChatMessage {
  readonly role: 'system' | 'user'
  readonly content: string
}

type CallOutcome =
  | { readonly kind: 'ok'; readonly answer: AnswerProjection }
  | { readonly kind: 'degrade' }
  | { readonly kind: 'fail'; readonly code: ModelFailureCode; readonly message: string; readonly retryable: boolean }

/** 剥掉 ```json 围栏（部分端点在 json_object 模式仍会包一层）。 */
function stripFences(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n')
    const lastFence = trimmed.lastIndexOf('```')
    if (firstNewline !== -1 && lastFence > firstNewline) {
      return trimmed.slice(firstNewline + 1, lastFence).trim()
    }
  }
  return trimmed
}

export interface ModelAdapter {
  completeAnswer(input: CompleteAnswerInput): Promise<ModelResult>
  completeJson<T>(input: CompleteJsonInput<T>): Promise<JsonModelResult<T>>
}

export function createModelAdapter(options: {
  readonly config: ModelConfig
  readonly fetchImpl?: FetchLike
  readonly timeoutMs?: number
}): ModelAdapter {
  const { config } = options
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const timeoutMs = options.timeoutMs ?? MODEL_TIMEOUT_MS

  const redact = (message: string): string =>
    config.apiKey === '' ? message : message.split(config.apiKey).join('[redacted]')

  async function callOnce(input: CompleteAnswerInput, useStrict: boolean): Promise<CallOutcome> {
    const base = buildAnswerMessages({ question: input.question, blocks: input.blocks, coverage: input.coverage })
    const messages: ChatMessage[] = [
      { role: 'system', content: useStrict ? base.system : withSchemaInstruction(base.system) },
      { role: 'user', content: base.user },
    ]
    const responseFormat = useStrict
      ? { type: 'json_schema', json_schema: { name: 'answer_projection', strict: true, schema: ANSWER_PROJECTION_JSON_SCHEMA } }
      : { type: 'json_object' }
    const body = JSON.stringify({ model: config.model, messages, temperature: 0, response_format: responseFormat })

    let response: Response
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (error) {
      const code: ModelFailureCode = controller.signal.aborted ? 'model_timeout' : 'model_transport'
      return { kind: 'fail', code, message: redact(`${code}: ${String(error)}`), retryable: true }
    } finally {
      clearTimeout(timer)
    }

    if (response.status >= 300 && response.status < 400) {
      return {
        kind: 'fail',
        code: 'model_redirect_rejected',
        message: redact(`model_redirect_rejected: 端点返回 ${response.status}（禁止自动跟随重定向）`),
        retryable: false,
      }
    }

    if (!response.ok) {
      const text = redact((await response.text()).slice(0, 500))
      if (useStrict && response.status === 400 && /response_format|json_schema/i.test(text)) {
        return { kind: 'degrade' }
      }
      return {
        kind: 'fail',
        code: 'model_http',
        message: `model_http ${response.status}: ${text}`,
        retryable: true,
      }
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      return { kind: 'fail', code: 'model_invalid_json', message: `model_invalid_json: ${String(error)}`, retryable: true }
    }
    const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim() === '') {
      return { kind: 'fail', code: 'model_invalid_json', message: 'model_invalid_json: 响应缺少 choices[0].message.content', retryable: true }
    }
    let candidate: unknown
    try {
      candidate = JSON.parse(stripFences(content))
    } catch (error) {
      return { kind: 'fail', code: 'model_invalid_json', message: `model_invalid_json: ${String(error)}`, retryable: true }
    }

    const stamped = { ...(candidate as object), analyzer: { provider: hostOf(config.baseUrl), model: config.model, promptVersion: PROMPT_VERSION } }
    const validation = validateAnswerProjection(stamped, input.blocks)
    if (!validation.ok) {
      return { kind: 'fail', code: 'model_validation_failed', message: validation.reasons.join('；'), retryable: true }
    }
    return { kind: 'ok', answer: validation.answer }
  }

  return {
    async completeAnswer(input: CompleteAnswerInput): Promise<ModelResult> {
      let useStrict = true
      let last: { code: ModelFailureCode; message: string } = { code: 'model_transport', message: 'unreachable' }
      for (let call = 0; call < 2; call += 1) {
        const outcome = await callOnce(input, useStrict)
        if (outcome.kind === 'ok') return { status: 'ok', answer: outcome.answer }
        if (outcome.kind === 'degrade') {
          useStrict = false
          last = { code: 'model_http', message: '端点不支持 response_format=json_schema，降级 json_object 重试' }
          continue
        }
        last = { code: outcome.code, message: outcome.message }
        if (!outcome.retryable) return { status: 'failed', ...last }
      }
      return { status: 'failed', ...last }
    },
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<JsonModelResult<T>> {
      let strict = true
      let last: { code: ModelFailureCode; message: string } = { code: 'model_transport', message: 'unreachable' }
      for (let call = 0; call < 2; call += 1) {
        const messages: ChatMessage[] = [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ]
        const responseFormat = strict
          ? { type: 'json_schema', json_schema: { name: input.schemaName, strict: true, schema: input.schema } }
          : { type: 'json_object' }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        let response: Response
        try {
          response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
            method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ model: config.model, messages, temperature: 0, response_format: responseFormat }),
            redirect: 'manual', signal: controller.signal,
          })
        } catch (error) {
          last = { code: controller.signal.aborted ? 'model_timeout' : 'model_transport', message: redact(String(error)) }
          clearTimeout(timer)
          continue
        } finally {
          clearTimeout(timer)
        }
        if (response.status >= 300 && response.status < 400) return { status: 'failed', code: 'model_redirect_rejected', message: `model_redirect_rejected: 端点返回 ${response.status}（禁止自动跟随重定向）` }
        if (!response.ok) {
          const text = redact((await response.text()).slice(0, 500))
          if (strict && response.status === 400 && /response_format|json_schema/i.test(text)) { strict = false; continue }
          last = { code: 'model_http', message: `model_http ${response.status}: ${text}` }
          continue
        }
        let payload: unknown
        try { payload = await response.json() } catch (error) { last = { code: 'model_invalid_json', message: `model_invalid_json: ${String(error)}` }; continue }
        const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
        if (typeof content !== 'string' || content.trim() === '') { last = { code: 'model_invalid_json', message: 'model_invalid_json: 响应缺少 choices[0].message.content' }; continue }
        let candidate: unknown
        try { candidate = JSON.parse(stripFences(content)) } catch (error) { last = { code: 'model_invalid_json', message: `model_invalid_json: ${String(error)}` }; continue }
        const validation = input.validate(candidate)
        if (!validation.ok) { last = { code: 'model_validation_failed', message: validation.reasons.join('；') }; continue }
        return { status: 'ok', value: validation.value }
      }
      return { status: 'failed', ...last }
    },
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return 'unknown'
  }
}
