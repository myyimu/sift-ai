// DOM 脱敏快照（E-05/E-06 核心）——源端先克隆再清洗，输出确定性 payload JSON。
//
// 流程（P0_EXTENSION_ARCHITECTURE §4 / P0_DEMO_SCOPE §2.2）：
//  documentElement.cloneNode(true)（唯一合法写路径：只写 clone 子树）
//   → walker 删噪（deny 标签整树移除：脚本/样式/模板/媒体/表单/nav/header/footer/aside；
//     contenteditable 与 role=textbox 子树整棵丢弃——用户已拍板 fail-closed）
//   → 属性白名单（a[href 经 sanitizeUrl]、img[src 经 sanitizeUrl]+alt、th/td 跨列跨行）
//   → 文本节点过 redactSecrets
//   → readable-v1（删噪后 ≥80 非空白字符）
//   → 限额三检查（5MiB 序列化字节 / 50k 节点 / 128 深度，超即 capture_limit_exceeded）
//   → 固定键序 payload JSON（零时间戳零随机数：同 DOM → 同字节 → 同 hash）
//
// 本文件在 eslint sift-readonly 两层规则的静态防护内（apps/extension/src/**）。
// url/title 的 sanitizeUrl/sanitizeTitle 在此完成——denied 即 capture_denied 失败关闭。
import {
  READABLE_MIN_CHARS,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_DEPTH,
  SNAPSHOT_MAX_NODES,
} from '@sift/shared/limits'
import { redactSecrets, sanitizeTitle, sanitizeUrl } from '@sift/shared/sanitize'
import { CAPTURE_VERSION, type CaptureFailureCode, type DomSnapshotPayload } from '@sift/shared/wire'

// —— 词表（版本化于 capture-v1；修改 = 修改脱敏语义，需同步 fixtures/pages 用例） ——

/** 整树移除的标签（小写）。脚本/样式/模板/媒体/表单控件/导航性容器。 */
const DROP_TAGS = new Set([
  'script', 'style', 'template', 'noscript', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'canvas', 'svg', 'math', 'video', 'audio',
  'source', 'track', 'map', 'area', 'link', 'meta', 'base', 'title',
  'form', 'input', 'button', 'select', 'textarea', 'option', 'optgroup',
  'output', 'label', 'fieldset', 'legend', 'datalist', 'dialog',
  'nav', 'header', 'footer', 'aside',
])

/** class/id 命中即整树移除的广告 token（精确匹配，防 add/admin 误杀）。 */
const AD_TOKENS = new Set([
  'ad', 'ads', 'advert', 'adverts', 'advertisement', 'advertisements',
  'advertising', 'banner', 'banners', 'promo', 'promos', 'sponsor', 'sponsored',
])

/**
 * 结构性根元素永不参与广告判定：2026-08-28 linux.do 实测，Discourse
 * welcome-banner 主题在 <body> 上挂了含 banner token 的类（welcome-banner-*
 * 按 [-_\s] 切分后产出裸 "banner"），looksLikeAd(body) 命中 → 整棵 body 被
 * 从克隆里删除 → 满屏可见内容 capture_too_little_content: 0 < 80。
 * 三轮线上 DOM 诊断定位（计数/标签级，未取页面内容）。
 */
const AD_NEVER_TAGS = new Set(['html', 'body'])

/**
 * 广告单元的子树元素上限：命中广告 token 但子树超过它的是结构容器（wrapper
 * class 误命中），不剥、继续向下递归——子树内部真正的小广告块仍会被各自的
 * token 命中剥掉。第二道防线，防其他站点"外层容器带广告词吞正文"的同类误杀。
 */
const AD_MAX_SUBTREE_ELEMENTS = 64

function isSmallSubtree(el: Element): boolean {
  let count = 0
  const stack: Element[] = [el]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const child of Array.from(current.children)) {
      count += 1
      if (count > AD_MAX_SUBTREE_ELEMENTS) return false
      stack.push(child)
    }
  }
  return true
}

/** 编辑态判定：contenteditable≠false 或 role=textbox —— 子树整棵不采集。 */
function isEditableSubtree(el: Element): boolean {
  const ce = el.getAttribute('contenteditable')
  if (ce !== null && ce.toLowerCase() !== 'false') return true
  const role = el.getAttribute('role')
  if (role !== null && role.toLowerCase() === 'textbox') return true
  return false
}

/** class/id 按 [-_\s] 切 token 后与广告词表精确匹配。 */
function looksLikeAd(el: Element): boolean {
  for (const raw of [el.getAttribute('class') ?? '', el.getAttribute('id') ?? '']) {
    for (const token of raw.toLowerCase().split(/[-_\s]+/)) {
      if (token !== '' && AD_TOKENS.has(token)) return true
    }
  }
  return false
}

/** 数字属性（colspan/rowspan）；非数字丢弃。 */
function numericAttr(el: Element, name: string): string | null {
  const value = el.getAttribute(name)
  return value !== null && /^\d+$/.test(value) ? value : null
}

// —— walker ——

/** nodeType 数值常量（不用全局 Node 命名空间：linkedom 测试环境无该全局）。 */
const TEXT_NODE = 3
const ELEMENT_NODE = 1

interface WalkTally {
  nodeCount: number
  maxDepth: number
}

class LimitExceeded extends Error {}

/**
 * 就地清洗 clone 子树：删噪 + 属性白名单 + 文本脱敏。
 * 返回被保留的文本字符数（readable-v1 判定用）。
 * 任何限额超限抛 LimitExceeded（调用方失败关闭，不产出部分快照）。
 */
function resolveAgainstBase(raw: string, baseUrl: string): string | null {
  try {
    return new URL(raw, baseUrl).toString()
  } catch {
    return null
  }
}

function sanitizeClone(node: Node, depth: number, tally: WalkTally, baseUrl: string): number {
  tally.nodeCount += 1
  if (tally.nodeCount > SNAPSHOT_MAX_NODES) throw new LimitExceeded('nodeCount')
  if (depth > tally.maxDepth) tally.maxDepth = depth
  if (depth > SNAPSHOT_MAX_DEPTH) throw new LimitExceeded('maxDepth')

  if (node.nodeType === TEXT_NODE) {
    const text = node.textContent ?? ''
    const cleaned = redactSecrets(text)
    if (cleaned !== text) node.textContent = cleaned
    return cleaned.replace(/\s/g, '').length
  }
  if (node.nodeType !== ELEMENT_NODE) return 0

  const el = node as Element
  const tag = el.tagName.toLowerCase()
  if (DROP_TAGS.has(tag) || isEditableSubtree(el)) {
    el.parentNode?.removeChild(el)
    return 0
  }
  // 广告判定双重防线：结构性根元素豁免 + 子树超上限不剥（见 AD_NEVER_TAGS 注）
  if (!AD_NEVER_TAGS.has(tag) && isSmallSubtree(el) && looksLikeAd(el)) {
    el.parentNode?.removeChild(el)
    return 0
  }

  // 属性白名单：先摘除全部，再按标签回填清洗后的少数属性
  const keptHref = el.tagName.toLowerCase() === 'a' ? el.getAttribute('href') : null
  const keptSrc = el.tagName.toLowerCase() === 'img' ? el.getAttribute('src') : null
  const keptAlt = el.tagName.toLowerCase() === 'img' ? el.getAttribute('alt') : null
  const colSpan = numericAttr(el, 'colspan')
  const rowSpan = numericAttr(el, 'rowspan')
  for (const attr of Array.from(el.attributes)) {
    el.removeAttribute(attr.name)
  }
  if (el.tagName.toLowerCase() === 'a' && keptHref !== null) {
    const resolved = resolveAgainstBase(keptHref, baseUrl)
    if (resolved !== null) {
      const result = sanitizeUrl(resolved)
      if (!result.denied) el.setAttribute('href', result.safeUrl)
    }
  }
  if (el.tagName.toLowerCase() === 'img') {
    if (keptSrc !== null) {
      const resolved = resolveAgainstBase(keptSrc, baseUrl)
      if (resolved !== null) {
        const result = sanitizeUrl(resolved)
        if (!result.denied) el.setAttribute('src', result.safeUrl)
      }
    }
    if (keptAlt !== null) el.setAttribute('alt', redactSecrets(keptAlt))
  }
  if (el.tagName.toLowerCase() === 'td' || el.tagName.toLowerCase() === 'th') {
    if (colSpan !== null) el.setAttribute('colspan', colSpan)
    if (rowSpan !== null) el.setAttribute('rowspan', rowSpan)
  }

  let readableChars = 0
  for (const child of Array.from(el.childNodes)) {
    readableChars += sanitizeClone(child, depth + 1, tally, baseUrl)
  }
  return readableChars
}

// —— 对外入口 ——

// CaptureFailureCode 词表单一来源：@sift/shared/wire（与持久 payload schema 共用，A4）。
export type { CaptureFailureCode }

export type CaptureOutcome =
  | {
      readonly ok: true
      readonly payloadJson: string
      readonly payload: DomSnapshotPayload
    }
  | {
      readonly ok: false
      readonly code: CaptureFailureCode
      readonly detail?: string
    }

export interface CaptureInput {
  readonly url: string
  readonly title: string
  readonly contentEpoch: number
  readonly reason: DomSnapshotPayload['reason']
}

/**
 * 捕获当前文档的脱敏快照。doc 参数注入（真实 CS 传 document；测试传 linkedom 文档）。
 * payloadJson 为最终线上字节（SW 直接 TextEncoder + sha256，不再改动一个字符）。
 */
export function captureDomSnapshot(doc: Document, input: CaptureInput): CaptureOutcome {
  const urlResult = sanitizeUrl(input.url)
  if (urlResult.denied) {
    return { ok: false, code: 'capture_denied', ...(urlResult.denyReason !== undefined ? { detail: urlResult.denyReason } : {}) }
  }

  // 只写 clone 子树（sift-readonly 第二层规则的唯一合法写路径）
  const clone = doc.documentElement.cloneNode(true) as Element
  const tally: WalkTally = { nodeCount: 0, maxDepth: 0 }
  let readableChars: number
  try {
    readableChars = sanitizeClone(clone, 1, tally, urlResult.safeUrl)
  } catch (error) {
    if (error instanceof LimitExceeded) {
      return { ok: false, code: 'capture_limit_exceeded', detail: error.message }
    }
    throw error
  }

  if (readableChars < READABLE_MIN_CHARS) {
    return { ok: false, code: 'capture_too_little_content', detail: `${readableChars} < ${READABLE_MIN_CHARS}` }
  }

  const html = clone.outerHTML
  const htmlUtf8Bytes = new TextEncoder().encode(html).length
  if (htmlUtf8Bytes > SNAPSHOT_MAX_BYTES) {
    return { ok: false, code: 'capture_limit_exceeded', detail: 'htmlUtf8Bytes' }
  }

  const payload: DomSnapshotPayload = {
    schemaVersion: 1,
    kind: 'dom_snapshot',
    captureVersion: CAPTURE_VERSION,
    reason: input.reason,
    url: urlResult.safeUrl,
    title: sanitizeTitle(input.title),
    contentEpoch: input.contentEpoch,
    html,
    stats: {
      nodeCount: tally.nodeCount,
      maxDepth: tally.maxDepth,
      htmlUtf8Bytes,
    },
  }
  return { ok: true, payloadJson: JSON.stringify(payload), payload }
}
