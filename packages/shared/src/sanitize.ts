// sensitive-v1 脱敏判定 —— 纯字符串层（ADR-001 E-08 / P0_DEMO_SCOPE §3）。
//
// 语义全部由 fixtures/sensitive/cases.json 门控（test/sanitize.test.ts 全量消费）：
//  - path：先对整个 path 百分号解码（畸形编码解码失败一律 deny，失败关闭），
//    再按 / 切段，与 deny 词干**精确匹配**且大小写不敏感（防 %2F 与大小写绕过；
//    /docs/login-history 不等于 login，不得误杀）；
//  - queryParam：参数名精确匹配（大小写不敏感）即整参剔除；
//  - content：密钥模式替换为 [REDACTED:secret]（含 task-based / bearer 短语反例，不得误杀）。
//
// 分层约束（ADR-001 §1）：允许被 MV3 content script / service worker import，
// 只允许纯 JS 与平台标准 API（URL/TextEncoder 级别），零运行时依赖、零副作用。

// —— 词表（版本化于 sensitive-v1；扩充词表 = 修改判定语义，需同步 fixtures） ——

/** path 段精确匹配的 deny 词干（fixtures/sensitive/cases.json pathCases 的超集，全部小写）。 */
export const DENY_PATH_STEMS: readonly string[] = [
  'login', 'signin', 'sign-in', 'sign_in', 'signup', 'sign-up', 'logout',
  'auth', 'oauth', 'account', 'billing', 'payment', 'checkout',
  'password', 'passwd', 'credentials', 'secret', 'token', 'session',
  'admin', 'settings', 'profile',
]

/** query 参数名精确匹配的 redact 词表（全部小写）。 */
export const REDACT_QUERY_PARAMS: readonly string[] = [
  'token', 'access_token', 'refresh_token', 'id_token',
  'code', 'key', 'api_key', 'apikey', 'secret', 'client_secret',
  'signature', 'sig', 'session', 'sessionid', 'session_id', 'sid',
  'auth', 'authorization', 'password', 'passwd', 'pwd', 'passphrase',
  'private_key', 'jwt',
]

/** 域名种子 denylist（整站拒绝捕获；host 精确或子域命中）。 */
export const DENY_DOMAINS: readonly string[] = [
  'accounts.google.com', 'mail.google.com', 'mail.yahoo.com',
  'outlook.live.com', 'paypal.com',
]

const DENY_PATH_STEM_SET = new Set(DENY_PATH_STEMS)
const REDACT_QUERY_PARAM_SET = new Set(REDACT_QUERY_PARAMS)

// —— path / host 判定 ——

/** path 是否命中敏感词干（畸形百分号编码失败关闭 → true）。 */
export function isSensitivePath(pathname: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return true
  }
  for (const rawSegment of decoded.split('/')) {
    const segment = rawSegment.toLowerCase()
    if (segment.length > 0 && DENY_PATH_STEM_SET.has(segment)) return true
  }
  return false
}

/** host 是否命中域名 denylist（精确或子域；大小写不敏感）。 */
export function isSensitiveHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  for (const denied of DENY_DOMAINS) {
    if (host === denied || host.endsWith(`.${denied}`)) return true
  }
  return false
}

// —— URL 清洗 ——

export type UrlDenyReason = 'parse' | 'scheme' | 'host' | 'path'

export interface UrlSanitizeResult {
  /** true = 拒绝捕获（调用方必须失败关闭，不得降级放行）。 */
  readonly denied: boolean
  readonly denyReason?: UrlDenyReason
  /** denied 时为空串；否则为清洗后的 URL（剔除凭证参数、fragment、 userinfo）。 */
  readonly safeUrl: string
  /** 本次被剔除的 query 参数名（诊断用）。 */
  readonly redactedParams: readonly string[]
}

/**
 * sensitive-v1 URL 清洗：scheme 白名单（http/https）→ 域名 denylist →
 * path 词干判定 → query 凭证参数整参剔除 → 去 fragment、去 userinfo。
 */
export function sanitizeUrl(raw: string): UrlSanitizeResult {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { denied: true, denyReason: 'parse', safeUrl: '', redactedParams: [] }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { denied: true, denyReason: 'scheme', safeUrl: '', redactedParams: [] }
  }
  if (isSensitiveHost(url.hostname)) {
    return { denied: true, denyReason: 'host', safeUrl: '', redactedParams: [] }
  }
  if (isSensitivePath(url.pathname)) {
    return { denied: true, denyReason: 'path', safeUrl: '', redactedParams: [] }
  }

  const kept: string[] = []
  const redacted: string[] = []
  const query = url.search
  if (query.startsWith('?') && query.length > 1) {
    for (const pair of query.slice(1).split('&')) {
      if (pair === '') continue
      const eq = pair.indexOf('=')
      const rawName = eq === -1 ? pair : pair.slice(0, eq)
      let name = rawName
      try {
        name = decodeURIComponent(rawName)
      } catch {
        redacted.push(rawName) // 畸形编码的参数名失败关闭
        continue
      }
      if (REDACT_QUERY_PARAM_SET.has(name.toLowerCase())) {
        redacted.push(name)
      } else {
        kept.push(pair)
      }
    }
  }
  url.search = kept.length > 0 ? `?${kept.join('&')}` : ''
  url.hash = ''
  url.username = ''
  url.password = ''
  return { denied: false, safeUrl: url.toString(), redactedParams: redacted }
}

// —— 内容密钥模式（E-08；正则按 fixtures contentCases 门控，含反例不误杀） ——

/** 单个密钥命中位置的描述（诊断用）。 */
export interface SecretMatch {
  readonly pattern: string
}

const CONTENT_SECRET_PATTERNS: readonly { pattern: string; re: RegExp }[] = [
  { pattern: 'pem-private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { pattern: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { pattern: 'bearer-token', re: /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { pattern: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { pattern: 'openai-sk', re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g },
  { pattern: 'github-pat-classic', re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { pattern: 'github-pat-fine', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { pattern: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { pattern: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
]

/** 密钥替换占位符（fixtures mustContain 断言该字面量）。 */
export const SECRET_REDACTED_PLACEHOLDER = '[REDACTED:secret]'

/** 对文本应用全部内容密钥模式，命中替换为 [REDACTED:secret]。 */
export function redactSecrets(text: string): string {
  let out = text
  for (const { re } of CONTENT_SECRET_PATTERNS) {
    out = out.replace(re, SECRET_REDACTED_PLACEHOLDER)
  }
  return out
}

// —— 标题清洗 ——

/** 标题长度上限（按码点计）。 */
export const TITLE_MAX_CHARS = 512

/**
 * 标题清洗：密钥脱敏 → 控制字符与路径保留字符替换为空格（纵深防御：title
 * 永不参与落盘路径，此处仍保证其不可能构成路径片段）→ 空白折叠 → 截断。
 * 占位符内含 ':'，先按占位符分段清洗再拼回，避免清洗破坏脱敏标记。
 */
export function sanitizeTitle(raw: string, maxChars: number = TITLE_MAX_CHARS): string {
  const redacted = redactSecrets(raw)
  const cleaned = redacted
    .split(SECRET_REDACTED_PLACEHOLDER)
    .map((segment) => {
      let out = ''
      for (const ch of segment) {
        const cp = ch.codePointAt(0)
        if (cp === undefined) continue
        if (cp < 0x20 || cp === 0x7f || '/\\:*?"<>|'.includes(ch)) {
          out += ' '
        } else {
          out += ch
        }
      }
      return out
    })
    .join(SECRET_REDACTED_PLACEHOLDER)
  const collapsed = cleaned.replace(/\s+/g, ' ').trim()
  let out = ''
  let count = 0
  for (const ch of collapsed) {
    if (count >= maxChars) break
    out += ch
    count += 1
  }
  return out
}
