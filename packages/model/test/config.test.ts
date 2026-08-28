// loadModelConfig 正反例（ADR-001 E-06：origin 固定、https 例外、无默认值）。
import { describe, expect, it } from 'vitest'
import { loadModelConfig, modelConfigSummary } from '../src/config'

const FULL_ENV = {
  SIFT_MODEL_BASE_URL: 'https://api.example.com',
  SIFT_MODEL_API_KEY: 'sk-key',
  SIFT_MODEL_ID: 'gpt-x',
  SIFT_MODEL_CTX: '128000',
}

describe('loadModelConfig', () => {
  it('四变量齐 + https 固定 origin → ok', () => {
    const r = loadModelConfig(FULL_ENV)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.config.origin).toBe('https://api.example.com')
    expect(r.config.baseUrl).toBe('https://api.example.com')
    expect(r.config.model).toBe('gpt-x')
    expect(r.config.contextWindow).toBe(128_000)
  })

  it('缺失变量逐一列出，绝不猜默认值', () => {
    const r = loadModelConfig({ SIFT_MODEL_BASE_URL: 'https://api.example.com' })
    expect(r).toMatchObject({
      status: 'model_config_missing',
      missing: ['SIFT_MODEL_API_KEY', 'SIFT_MODEL_ID', 'SIFT_MODEL_CTX'],
    })
  })

  it('CTX 非正整数 → config_missing（带说明）', () => {
    const r = loadModelConfig({ ...FULL_ENV, SIFT_MODEL_CTX: 'abc' })
    expect(r.status).toBe('model_config_missing')
    if (r.status !== 'model_config_missing') return
    expect(r.missing[0]).toContain('SIFT_MODEL_CTX')
  })

  it('http 远端拒绝；localhost/127.0.0.1/[::1] 允许 http', () => {
    expect(loadModelConfig({ ...FULL_ENV, SIFT_MODEL_BASE_URL: 'http://api.example.com' })).toMatchObject({ status: 'model_origin_rejected' })
    expect(loadModelConfig({ ...FULL_ENV, SIFT_MODEL_BASE_URL: 'http://localhost:8081' }).status).toBe('ok')
    expect(loadModelConfig({ ...FULL_ENV, SIFT_MODEL_BASE_URL: 'http://127.0.0.1:8081' }).status).toBe('ok')
    expect(loadModelConfig({ ...FULL_ENV, SIFT_MODEL_BASE_URL: 'http://[::1]:8081' }).status).toBe('ok')
  })

  it('固定 basePath 允许（百炼等兼容端点）；query/userinfo/非法段仍拒', () => {
    // 2026-08-28 放宽：允许静态 path（国内 OpenAI 兼容端点普遍带 /v1 或 /compatible-mode/v1）
    const bailian = loadModelConfig({ ...FULL_ENV, SIFT_MODEL_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })
    expect(bailian.status).toBe('ok')
    if (bailian.status === 'ok') {
      expect(bailian.config.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
      expect(bailian.config.origin).toBe('https://dashscope.aliyuncs.com') // origin 字段保持纯 origin
    }
    // 尾斜杠规范化（避免拼出 //chat/completions）
    const trailing = loadModelConfig({ ...FULL_ENV, SIFT_MODEL_BASE_URL: 'https://api.example.com/v1/' })
    expect(trailing).toMatchObject({ status: 'ok' })
    if (trailing.status === 'ok') expect(trailing.config.baseUrl).toBe('https://api.example.com/v1')

    expect(loadModelConfig({ ...FULL_ENV, SIFT_MODEL_BASE_URL: 'https://api.example.com/?x=1' }).status).toBe('model_origin_rejected')
    expect(loadModelConfig({ ...FULL_ENV, SIFT_MODEL_BASE_URL: 'https://api.example.com/v1?x=1' }).status).toBe('model_origin_rejected')
    expect(loadModelConfig({ ...FULL_ENV, SIFT_MODEL_BASE_URL: 'https://u:p@api.example.com' }).status).toBe('model_origin_rejected')
    // 注：纯 '/../v1' 会被 new URL 规范化为 '/v1'（合法）；'..x' 这类段才保留原样，须拒
    expect(loadModelConfig({ ...FULL_ENV, SIFT_MODEL_BASE_URL: 'https://api.example.com/v1/..x' }).status).toBe('model_origin_rejected')
    expect(loadModelConfig({ ...FULL_ENV, SIFT_MODEL_BASE_URL: 'https://api.example.com/v 1' }).status).toBe('model_origin_rejected')
    expect(loadModelConfig({ ...FULL_ENV, SIFT_MODEL_BASE_URL: 'not a url' }).status).toBe('model_origin_rejected')
  })
})

describe('modelConfigSummary（UI 摘要，永不携带 apiKey）', () => {
  it('ok → configured + 完整 baseUrl/model/ctx（确认屏透明）', () => {
    const summary = modelConfigSummary(
      loadModelConfig({ ...FULL_ENV, SIFT_MODEL_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }),
    )
    expect(summary).toEqual({
      configured: true,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'gpt-x',
      contextWindow: 128_000,
    })
    expect(Object.keys(summary)).not.toContain('apiKey')
  })

  it('未配置 → configured false', () => {
    expect(modelConfigSummary(loadModelConfig({}))).toEqual({ configured: false, baseUrl: '', model: '', contextWindow: 0 })
  })
})
