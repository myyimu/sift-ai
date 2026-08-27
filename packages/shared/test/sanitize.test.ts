// sensitive-v1 脱敏判定测试：全量消费 fixtures/sensitive/cases.json
// （ADR-001 E-08：词表语义由夹具门控，这里断言实现与夹具逐条一致）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  TITLE_MAX_CHARS,
  isSensitiveHost,
  isSensitivePath,
  redactSecrets,
  sanitizeTitle,
  sanitizeUrl,
} from '../src/sanitize'

interface PathCase { path: string; expected: 'allow' | 'deny'; note?: string }
interface QueryParamCase { param: string; expected: 'keep' | 'redact' }
interface ContentCase {
  pattern: string
  text: string
  expected: 'redacted' | 'unchanged'
  mustContain?: string
  mustNotContain?: string
  note?: string
}
interface Cases {
  pathCases: PathCase[]
  queryParamCases: QueryParamCase[]
  contentCases: ContentCase[]
}

// packages/shared/test → 仓库根/fixtures/sensitive/cases.json
const cases: Cases = JSON.parse(
  readFileSync(new URL('../../../fixtures/sensitive/cases.json', import.meta.url), 'utf8'),
)

describe('sensitive-v1 path 判定（fixtures pathCases 全量）', () => {
  it.each(cases.pathCases)('$path → $expected', (c) => {
    expect(isSensitivePath(c.path)).toBe(c.expected === 'deny')
  })

  it('sanitizeUrl 的 path 判定与 isSensitivePath 一致（含 %2F 绕过与畸形编码失败关闭）', () => {
    for (const c of cases.pathCases) {
      const result = sanitizeUrl(`https://example.com${c.path}`)
      expect(result.denied, c.path).toBe(c.expected === 'deny')
      if (c.expected === 'deny') expect(result.denyReason).toBe('path')
    }
  })
})

describe('sensitive-v1 queryParam 判定（fixtures queryParamCases 全量）', () => {
  it.each(cases.queryParamCases)('$param → $expected', (c) => {
    const result = sanitizeUrl(`https://example.com/docs/x?${c.param}=value&keep=1`)
    expect(result.denied).toBe(false)
    expect(result.redactedParams.includes(c.param)).toBe(c.expected === 'redact')
    expect(result.safeUrl.includes('keep=1')).toBe(true)
    expect(result.safeUrl.includes(`${c.param}=`)).toBe(c.expected === 'keep')
  })
})

describe('sensitive-v1 content 密钥模式（fixtures contentCases 全量）', () => {
  it.each(cases.contentCases)('$pattern → $expected', (c) => {
    const out = redactSecrets(c.text)
    if (c.expected === 'redacted') {
      if (c.mustContain) expect(out.includes(c.mustContain), c.pattern).toBe(true)
      if (c.mustNotContain) expect(out.includes(c.mustNotContain), c.pattern).toBe(false)
    } else {
      expect(out).toBe(c.text)
    }
  })
})

describe('sanitizeUrl 其余维度', () => {
  it('非 http/https scheme 拒绝（scheme 白名单）', () => {
    for (const raw of ['chrome://settings', 'file:///C:/x', 'ftp://example.com/p', 'javascript:alert(1)']) {
      const result = sanitizeUrl(raw)
      expect(result.denied, raw).toBe(true)
      expect(result.denyReason).toBe('scheme')
    }
  })

  it('解析失败拒绝（失败关闭）', () => {
    const result = sanitizeUrl('not a url')
    expect(result.denied).toBe(true)
    expect(result.denyReason).toBe('parse')
  })

  it('域名 denylist：精确与子域命中', () => {
    expect(isSensitiveHost('mail.google.com')).toBe(true)
    expect(isSensitiveHost('Mail.Google.COM')).toBe(true)
    expect(isSensitiveHost('nested.mail.google.com')).toBe(true)
    expect(isSensitiveHost('gmail.com')).toBe(false)
    expect(isSensitiveHost('example.com')).toBe(false)
    expect(sanitizeUrl('https://mail.google.com/u/0/').denyReason).toBe('host')
  })

  it('userinfo 与 fragment 剔除', () => {
    const result = sanitizeUrl('https://user:secret@example.com/p?keep=1#access_token=xyz')
    expect(result.denied).toBe(false)
    expect(result.safeUrl).toBe('https://example.com/p?keep=1')
    expect(result.safeUrl.includes('user')).toBe(false)
    expect(result.safeUrl.includes('secret')).toBe(false)
    expect(result.safeUrl.includes('#')).toBe(false)
  })

  it('畸形编码的 query 参数名失败关闭（剔除而非放行）', () => {
    const result = sanitizeUrl('https://example.com/p?tok%en=1&keep=1')
    expect(result.denied).toBe(false)
    expect(result.redactedParams.includes('tok%en')).toBe(true)
    expect(result.safeUrl.includes('tok')).toBe(false)
  })
})

describe('sanitizeTitle', () => {
  it('剔除控制字符与 Windows 路径保留字符，折叠空白', () => {
    const out = sanitizeTitle('a\u0000b\\c:d*e?f"g<h>i|j\tk')
    for (const ch of ['\u0000', '\\', ':', '*', '?', '"', '<', '>', '|']) {
      expect(out.includes(ch)).toBe(false)
    }
    expect(out).toBe('a b c d e f g h i j k')
  })

  it('按码点截断到上限', () => {
    expect(sanitizeTitle('文'.repeat(TITLE_MAX_CHARS + 10)).length).toBe(TITLE_MAX_CHARS)
  })

  it('标题中的密钥同样脱敏', () => {
    const out = sanitizeTitle('config uses AKIAIOSFODNN7EXAMPLE as the key')
    expect(out.includes('AKIAIOSFODNN7EXAMPLE')).toBe(false)
    expect(out.includes('[REDACTED:secret]')).toBe(true)
  })

  it('穿越样式的标题不残留路径分隔符形态', () => {
    const out = sanitizeTitle('..\\..\\..\\etc\\passwd')
    expect(out.includes('\\')).toBe(false)
    expect(out.includes('/')).toBe(false)
  })
})
