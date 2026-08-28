// mock-openai.mjs —— 本地 mock OpenAI 兼容端点（全链 E2E 用；也可独立起服务手动调试）。
//
// 语义：
//  - POST /chat/completions：解析请求体，从 user 消息里找投影块标记 `[b-0001|kind]`，
//    让回答真实引用这些块 id（闭环：投影块 -> prompt -> 模型 -> AnswerProjection 引用
//    -> 本地跨对象校验通过）；
//  - 默认模式 strict：直接 200（json_schema 请求成功）；
//  - --mode degrade：第一次请求回 400（报文含 response_format/json_schema），
//    驱动 adapter 走 json_object 降级路径（第二次 200）；
//  - 记录每个请求的完整 body 与 Authorization 头（断言"恰好 1 次调用/无后台调用"、
//    coverage 摘要确实进了请求）。
//
// 独立用法：node tools/e2e/mock-openai.mjs [--port 18789] [--mode degrade]
import { createServer } from 'node:http'

/** 从 user 消息内容中提取块 id（形如 [b-0001|heading]）。 */
function blockIdsOf(body) {
  const ids = []
  const userMsg = (body?.messages ?? []).find((m) => m?.role === 'user')
  const content = typeof userMsg?.content === 'string' ? userMsg.content : JSON.stringify(userMsg?.content ?? '')
  for (const m of content.matchAll(/\[(b-\d{4})\|[a-z_]+\]/g)) {
    if (!ids.includes(m[1])) ids.push(m[1])
  }
  return ids
}

function completionJson(blockIds) {
  return JSON.stringify({
    schemaVersion: 1,
    answer:
      blockIds.length > 0
        ? `根据已观察到的页面内容（${blockIds.length} 个证据块），页面在讲事件驱动架构：协作经由事件解耦，生产者陈述事实、消费者自行响应；收益是演进自由度，代价是可观测性下降。`
        : '已观察范围内没有可支撑回答的文本块。',
    claims: blockIds.map((id, i) => ({
      claimId: `c-${i + 1}`,
      text: `证据块 ${id} 支持该论断。`,
      evidenceBlockRefs: [id],
    })),
    limitations: ['仅覆盖授权观察期间已捕获的页面内容。'],
    sources: blockIds.map((id) => ({ evidenceBlockRef: id })),
    // 故意自报错误三元组：验证本地盖章覆盖模型自报（analyzer 由 @sift/model 盖章）
    analyzer: { provider: 'self-reported', model: 'self-reported', promptVersion: 'self-reported' },
  })
}

/**
 * 工厂（E2E 内嵌用）。返回 { server, port, requests, close }；
 * requests 元素 = { body, authorization, responseFormat }。
 */
export function startMockOpenAi({ mode = 'strict' } = {}) {
  const requests = []
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = null
      try { body = JSON.parse(raw) } catch { /* 下面按缺块处理 */ }
      const record = {
        body,
        authorization: req.headers.authorization ?? '',
        responseFormat: body?.response_format?.type ?? null,
      }
      requests.push(record)
      if (mode === 'degrade' && requests.length === 1) {
        // 模拟不支持 response_format/json_schema 的端点
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: "response_format with type='json_schema' is not supported by this endpoint; use json_object" } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: completionJson(blockIdsOf(body)) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      )
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

// —— 独立服务模式 ——
const isDirect = process.argv[1] && process.argv[1].endsWith('mock-openai.mjs')
if (isDirect) {
  const args = process.argv.slice(2)
  const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 0
  const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'strict'
  const { server, port: actual } = await startMockOpenAi({ mode })
  if (port > 0) {
    server.close()
    server.listen(port, '127.0.0.1', () => console.log(`mock OpenAI: http://127.0.0.1:${port}/v1 (mode=${mode})`))
  } else {
    console.log(`mock OpenAI: http://127.0.0.1:${actual}/v1 (mode=${mode})`)
  }
}
