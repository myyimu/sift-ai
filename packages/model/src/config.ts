// ModelAdapter 配置（ADR-001 E-06 冻结）：baseUrl/apiKey/model/ctx 全部来自进程
// 环境变量 SIFT_MODEL_BASE_URL / SIFT_MODEL_API_KEY / SIFT_MODEL_ID / SIFT_MODEL_CTX。
//
// 纪律（D-051 / P0_DEMO_SCOPE §3）：
//  - API Key 永不持久化、永不进入日志与投影——本模块只把它保存在返回的 config 里，
//    供 adapter 构造 Authorization 头；任何面向 UI 的摘要只允许携带 origin/model/ctx。
//  - baseUrl 必须解析成固定 origin（+ 可选固定 basePath）：远程端点只允许 https:；
//    仅 localhost / 127.0.0.1 / [::1] 本地网关允许 http:。禁止 query/fragment/userinfo，
//    path 仅允许字母数字._~- 的静态段（2026-08-28 放宽，接百炼等国内兼容端点），
//    且完整 baseUrl 必须出现在确认屏摘要里——防止把请求（连同 Key）发往未预览的位置。
/** 已通过 origin 校验的开发期 provider 配置。apiKey 只进内存，永不外发摘要。 */
export interface ModelConfig {
  /** 固定 origin + 可选 basePath（如 https://dashscope.aliyuncs.com/compatible-models/v1）。请求 URL = baseUrl + /chat/completions。 */
  readonly baseUrl: string
  readonly origin: string
  readonly apiKey: string
  readonly model: string
  readonly contextWindow: number
}

export type ModelConfigResult =
  | { readonly status: 'ok'; readonly config: ModelConfig }
  | { readonly status: 'model_config_missing'; readonly missing: readonly string[] }
  | { readonly status: 'model_origin_rejected'; readonly reason: string }

const ENV_NAMES = ['SIFT_MODEL_BASE_URL', 'SIFT_MODEL_API_KEY', 'SIFT_MODEL_ID', 'SIFT_MODEL_CTX'] as const

/** UI 展示与确认屏用的无密摘要（E-06：确认 UI 展示最终 provider 地址、model、数据范围）。 */
export interface ModelConfigSummary {
  readonly configured: boolean
  /** 完整 base 地址（origin + path）——确认屏必须展示这个，透明性不因放宽 path 而降级。 */
  readonly baseUrl: string
  readonly model: string
  readonly contextWindow: number
}

export function modelConfigSummary(result: ModelConfigResult): ModelConfigSummary {
  if (result.status === 'ok') {
    return { configured: true, baseUrl: result.config.baseUrl, model: result.config.model, contextWindow: result.config.contextWindow }
  }
  return { configured: false, baseUrl: '', model: '', contextWindow: 0 }
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/** 解析并校验环境变量。任何缺失/非法都以结果联合返回，绝不抛异常、绝不猜默认值。 */
export function loadModelConfig(env: Record<string, string | undefined>): ModelConfigResult {
  const missing = ENV_NAMES.filter(name => {
    const value = env[name]
    return value === undefined || value.trim() === ''
  })
  if (missing.length > 0) {
    return { status: 'model_config_missing', missing }
  }

  const baseUrl = env.SIFT_MODEL_BASE_URL!.trim()
  const apiKey = env.SIFT_MODEL_API_KEY!.trim()
  const model = env.SIFT_MODEL_ID!.trim()
  const ctxRaw = env.SIFT_MODEL_CTX!.trim()

  const ctxNumber = Number(ctxRaw)
  if (!Number.isInteger(ctxNumber) || ctxNumber <= 0) {
    return { status: 'model_config_missing', missing: ['SIFT_MODEL_CTX（需为正整数 token 窗口）'] }
  }

  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return { status: 'model_origin_rejected', reason: `SIFT_MODEL_BASE_URL 不是合法 URL：${baseUrl}` }
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    return {
      status: 'model_origin_rejected',
      reason: `远程端点只允许 https:（仅 localhost/127.0.0.1/[::1] 允许 http:），当前协议 ${url.protocol}`,
    }
  }
  if (url.username !== '' || url.password !== '') {
    return { status: 'model_origin_rejected', reason: 'SIFT_MODEL_BASE_URL 不得携带 userinfo' }
  }
  // 允许固定 basePath（如百炼 /compatible-models/v1），但不得带 query/fragment——
  // 2026-08-28 放宽：E-06 原"纯 origin"规则挡住了国内 OpenAI 兼容端点（百炼等），
  // 用户授权接入。透明性不降：path 是静态配置的一部分且必须显示在确认屏
  // （summary.baseUrl 携带完整地址），与"防 key 发往未预览位置"的原意图一致。
  if (url.search !== '' || url.hash !== '') {
    return { status: 'model_origin_rejected', reason: 'SIFT_MODEL_BASE_URL 不得携带 query/fragment' }
  }
  if (url.pathname.includes('..')) {
    return { status: 'model_origin_rejected', reason: `SIFT_MODEL_BASE_URL path 含非法片段：${url.pathname}` }
  }
  const trimmedPath = url.pathname !== '/' ? url.pathname.replace(/\/+$/, '') : ''
  if (!/^(?:\/[A-Za-z0-9._~-]+)*$/.test(trimmedPath)) {
    return { status: 'model_origin_rejected', reason: `SIFT_MODEL_BASE_URL path 仅允许字母/数字/._~- 的固定段：${url.pathname}` }
  }

  const origin = url.origin
  const fullBaseUrl = `${origin}${trimmedPath}`
  return {
    status: 'ok',
    config: { baseUrl: fullBaseUrl, origin, apiKey, model, contextWindow: ctxNumber },
  }
}
