// capture.test.ts —— 九类页面夹具 + 限额失败关闭 + 确定性序列化（步骤 5 验证门）。
// 夹具来自 fixtures/pages/（见该目录 README）；hash 稳定性断言只在同环境（linkedom）内做。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { captureDomSnapshot } from '../src/capture'
import type { CaptureInput, CaptureOutcome } from '../src/capture'

const pagesDir = fileURLToPath(new URL('../../../fixtures/pages/', import.meta.url))

function loadDoc(name: string): Document {
  return parseHTML(readFileSync(`${pagesDir}${name}`, 'utf8')).document
}

function capture(name: string, overrides: Partial<CaptureInput> = {}): CaptureOutcome {
  return captureDomSnapshot(loadDoc(name), {
    url: 'https://example.com/article?id=9',
    title: '测试标题',
    contentEpoch: 0,
    reason: 'initial_readable',
    ...overrides,
  })
}

function expectOk(outcome: CaptureOutcome): Extract<CaptureOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`预期捕获成功，实际失败：${outcome.code} ${outcome.detail ?? ''}`)
  return outcome
}

describe('capture：九类夹具', () => {
  it('benign-article：正文结构保留，噪声标签移除', () => {
    const { payload } = expectOk(capture('benign-article.html', { title: '理解事件驱动架构' }))
    const html = payload.html
    expect(html).toContain('<h1>')
    expect(html).toContain('<table')
    expect(html).toContain('colspan')
    expect(html).toContain('href="https://example.com/architecture/events"')
    expect(html).toContain('src="https://example.com/images/pipeline.png"')
    expect(html).toContain('事件管道示意图')
    expect(html).not.toContain('<title')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<style')
    expect(html).not.toContain('<nav')
    expect(payload.title).toBe('理解事件驱动架构')
    expect(payload.stats.nodeCount).toBeGreaterThan(20)
    expect(payload.stats.htmlUtf8Bytes).toBeGreaterThan(1000)
  })

  it('benign-article：页面 URL 的凭证参数被剔除', () => {
    const { payload } = expectOk(capture('benign-article.html', { url: 'https://example.com/article?id=9&token=secret123' }))
    expect(payload.url).toBe('https://example.com/article?id=9')
  })

  it('script-style-heavy：脚本/样式/模板/noscript/svg 整树移除，属性白名单生效', () => {
    const { payload } = expectOk(capture('script-style-heavy.html'))
    const html = payload.html
    for (const leak of ['SCRIPTBLOCKSECRET', 'STYLEBLOCKSECRET', 'TEMPLATESECRET', 'noscriptsecret', 'BOTTOMSECRET']) {
      expect(html).not.toContain(leak)
    }
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<style')
    expect(html).not.toContain('<template')
    expect(html).not.toContain('<noscript')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('data-tracking')
    // 正文密钥文本脱敏（替换而非删段）
    expect(html).toContain('[REDACTED:secret]')
    expect(html).toContain('内联事件与追踪属性')
  })

  it('form-secrets：表单控件整树移除，预填秘密不残留', () => {
    const { payload } = expectOk(capture('form-secrets.html'))
    const html = payload.html
    for (const leak of ['alice@example.com', 'sk-FORMSECRETVALUE', 'FORMTEXTSECRET']) {
      expect(html).not.toContain(leak)
    }
    for (const tag of ['<form', '<input', '<select', '<textarea', '<button', '<label']) {
      expect(html).not.toContain(tag)
    }
    expect(html).toContain('账户中心')
    expect(html).toContain('[REDACTED:secret]')
  })

  it('sensitive-url：链接 href 按规则清洗', () => {
    const { payload } = expectOk(capture('sensitive-url.html'))
    const html = payload.html
    expect(html).toContain('page=2')
    expect(html).toContain('sort=title')
    expect(html).not.toContain('token=')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('accounts.google.com')
    expect(html).not.toContain('docs%2Fauth')
    expect(html).toContain('登录入口链接') // 文本保留，仅剥 href
    expect(html).toContain('href="https://example.com/normal/path"')
  })

  it('relative-links：相对 href/src 先按页面 URL 解析为绝对安全地址', () => {
    const { document } = parseHTML(`<html><body><main><p>${'x'.repeat(100)}</p><a href="/docs/guide">指南</a><img src="../img/diagram.png" alt="图示"></main></body></html>`)
    const outcome = captureDomSnapshot(document, {
      url: 'https://example.com/articles/current?id=1',
      title: '相对链接',
      contentEpoch: 0,
      reason: 'initial_readable',
    })
    const { payload } = expectOk(outcome)
    expect(payload.html).toContain('href="https://example.com/docs/guide"')
    expect(payload.html).toContain('src="https://example.com/img/diagram.png"')
  })

  it('traversal-title：标题的路径保留字符全部替换', () => {
    const { payload } = expectOk(capture('traversal-title.html'))
    expect(payload.title).not.toMatch(/[/\\:*?"<>|]/)
    expect(payload.title).not.toContain('../')
    expect(payload.title).not.toContain(':')
  })

  it('contenteditable-editor：编辑区整树丢弃 → capture_too_little_content', () => {
    const outcome = capture('contenteditable-editor.html', { title: '在线笔记编辑器' })
    expect(outcome).toMatchObject({ ok: false, code: 'capture_too_little_content' })
  })

  it('duplicate-stable：同 DOM 同输入 → 逐字节相同 payload', () => {
    const a = expectOk(capture('duplicate-stable.html', { title: '稳定内容页' }))
    const b = expectOk(capture('duplicate-stable.html', { title: '稳定内容页' }))
    expect(b.payloadJson).toBe(a.payloadJson)
    // reason / contentEpoch 进入 payload：差异即不同字节
    const otherReason = expectOk(capture('duplicate-stable.html', { title: '稳定内容页', reason: 'mutation_merged' }))
    expect(otherReason.payloadJson).not.toBe(a.payloadJson)
    const otherEpoch = expectOk(capture('duplicate-stable.html', { title: '稳定内容页', contentEpoch: 2 }))
    expect(otherEpoch.payloadJson).not.toBe(a.payloadJson)
  })

  it('spa-hash-nav：contentEpoch 随快照上报', () => {
    const epoch0 = expectOk(capture('spa-hash-nav.html', { contentEpoch: 0 }))
    const epoch3 = expectOk(capture('spa-hash-nav.html', { contentEpoch: 3 }))
    expect(epoch0.payload.contentEpoch).toBe(0)
    expect(epoch3.payload.contentEpoch).toBe(3)
  })

  it('empty-skeleton：可读内容不足 → capture_too_little_content', () => {
    const outcome = capture('empty-skeleton.html', { title: '加载中' })
    expect(outcome).toMatchObject({ ok: false, code: 'capture_too_little_content' })
  })
})

describe('capture：失败关闭', () => {
  it('敏感域名 URL → capture_denied', () => {
    const outcome = capture('benign-article.html', { url: 'https://mail.google.com/inbox' })
    expect(outcome).toMatchObject({ ok: false, code: 'capture_denied' })
  })

  it('非 http(s) scheme → capture_denied', () => {
    const outcome = capture('benign-article.html', { url: 'chrome://settings' })
    expect(outcome).toMatchObject({ ok: false, code: 'capture_denied' })
  })

  it('深度超 128 → capture_limit_exceeded（不产出部分快照）', () => {
    const { document } = parseHTML('<html><body></body></html>')
    let parent = document.body
    for (let i = 0; i < 140; i += 1) {
      const div = document.createElement('div')
      parent.appendChild(div)
      parent = div
    }
    const outcome = captureDomSnapshot(document, {
      url: 'https://example.com/deep',
      title: '深层嵌套',
      contentEpoch: 0,
      reason: 'initial_readable',
    })
    expect(outcome).toMatchObject({ ok: false, code: 'capture_limit_exceeded', detail: 'maxDepth' })
  })

  it('序列化字节超 5MiB → capture_limit_exceeded', () => {
    const { document } = parseHTML('<html><body><p id="p">seed</p></body></html>')
    document.getElementById('p')!.textContent = 'a'.repeat(6 * 1024 * 1024)
    const outcome = captureDomSnapshot(document, {
      url: 'https://example.com/big',
      title: '超大页面',
      contentEpoch: 0,
      reason: 'initial_readable',
    })
    expect(outcome).toMatchObject({ ok: false, code: 'capture_limit_exceeded', detail: 'htmlUtf8Bytes' })
  })
})

describe('capture：确定性序列化', () => {
  it('payload 键序固定、首键 schemaVersion（同 DOM → 同字节 → 同 hash 的前提）', () => {
    const { payload } = expectOk(capture('benign-article.html'))
    expect(Object.keys(payload)).toEqual([
      'schemaVersion', 'kind', 'captureVersion', 'reason', 'url', 'title',
      'contentEpoch', 'html', 'stats',
    ])
    expect(Object.keys(payload.stats)).toEqual(['nodeCount', 'maxDepth', 'htmlUtf8Bytes'])
  })
})
