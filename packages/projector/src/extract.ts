// 步骤 1–4：已脱敏离线 DOM → DemoEvidenceBlock 候选（P0_DEMO_SCOPE §2.4 六步规则）。
//
// 输入是 capture（sensitive-v1）清洗后的 HTML——本层再剥离一次属纵深防御
// （清单文档化，语义与 capture DROP_TAGS 对齐但不依赖其完整性）。
// 输出确定性：同一 HTML → 同块序同文本（NFC + 空白归一，零墙钟零随机）。
import { createHash } from 'node:crypto'
import { parseHTML } from 'linkedom'
import { MIN_BLOCK_CHARS } from '@sift/shared/limits'
import type { DemoEvidenceBlock } from '@sift/shared'

/** 步骤 1 剥离标签（小写）：脚本/样式/模板/交互控件/媒体/导航性容器。 */
const STRIP_TAGS = new Set([
  'script', 'style', 'template', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'dialog',
  'button', 'input', 'select', 'textarea', 'option', 'label',
  'object', 'embed', 'iframe', 'canvas', 'svg', 'video', 'audio', 'picture', 'source', 'track',
  'map', 'area',
])

/** 步骤 1 剥离的 role 值（小写）。 */
const STRIP_ROLES = new Set(['navigation', 'search', 'banner', 'contentinfo', 'menu', 'menubar', 'toolbar'])

/** 步骤 3 的块生成标签（最外层命中优先；命中后不再收割后代）。 */
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const CODE_TAGS = new Set(['pre', 'code'])

/** 内联透传元素：不冲刷文本 run、不生成块。 */
const INLINE_TAGS = new Set([
  'a', 'span', 'strong', 'em', 'b', 'i', 'u', 'small', 'abbr', 'cite', 'q', 'time', 'mark',
  'sub', 'sup', 'code', 'kbd', 'samp', 'var', 'br', 'wbr', 's', 'strike', 'del', 'ins',
])

export interface ExtractedBlock {
  readonly kind: DemoEvidenceBlock['kind']
  /** NFC + 空白归一 + trim 后的原文（不摘要、不改写）。 */
  readonly text: string
  readonly textHash: string
  /** 页内块序（组装 EvidenceSourceRef.ordinal 用）。 */
  readonly ordinal: number
}

/** 归一化（钉死）：NFC → 空白折叠为单空格 → trim。 */
export function normalizeBlockText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim()
}

export function textHashOf(normalized: string): string {
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`
}

// —— 节点判定（鸭子类型：tagName/getAttribute/childNodes；不用全局 Node 命名空间） ——

const TEXT_NODE = 3
const ELEMENT_NODE = 1

interface DuckNode {
  readonly nodeType: number
  readonly textContent: string | null
  readonly childNodes: readonly DuckNode[]
  readonly parentNode: DuckNode | null
  readonly tagName?: string
  getAttribute?(name: string): string | null
  removeChild?(child: DuckNode): unknown
}

function asElement(node: DuckNode): DuckNode | null {
  return node.nodeType === ELEMENT_NODE ? node : null
}

function tagOf(el: DuckNode): string {
  return (el.tagName ?? '').toLowerCase()
}

/** 步骤 1 判定：整树剥离（标签/hidden/aria-hidden/噪声 role/aria-modal）。 */
function shouldStrip(el: DuckNode): boolean {
  if (STRIP_TAGS.has(tagOf(el))) return true
  const get = el.getAttribute
  if (get !== undefined) {
    if (get.call(el, 'hidden') !== null) return true
    const ariaHidden = get.call(el, 'aria-hidden')
    if (ariaHidden !== null && ariaHidden.toLowerCase() === 'true') return true
    if (get.call(el, 'aria-modal') !== null) return true
    const role = get.call(el, 'role')
    if (role !== null && STRIP_ROLES.has(role.toLowerCase())) return true
  }
  return false
}

/** 就地剥离（步骤 1）：移除命中子树，返回剩余 eligible 非空白字符数。 */
function stripTree(node: DuckNode): number {
  const el = asElement(node)
  if (el !== null && shouldStrip(el)) {
    node.parentNode?.removeChild?.(el)
    return 0
  }
  if (node.nodeType === TEXT_NODE) {
    return (node.textContent ?? '').replace(/\s/g, '').length
  }
  if (el === null) return 0
  let chars = 0
  for (const child of [...el.childNodes]) {
    chars += stripTree(child)
  }
  return chars
}

/** 步骤 2 的 eligible text：子树内非空白字符数。 */
function eligibleTextOf(node: DuckNode): number {
  return (node.textContent ?? '').replace(/\s/g, '').length
}

/** 是否有指定标签的祖先（顶层 article 判定）。 */
function hasAncestorTag(el: DuckNode, tag: string): boolean {
  let cur = el.parentNode
  while (cur !== null) {
    if (tagOf(cur) === tag) return true
    cur = cur.parentNode
  }
  return false
}

// —— 步骤 3：DOM 序收割（最外层命中优先） ——

interface RawBlock {
  readonly kind: DemoEvidenceBlock['kind']
  readonly text: string
}

interface WalkState {
  /** 当前未冲刷的剩余文本 run 片段。 */
  run: string[]
  readonly out: RawBlock[]
}

function flushRun(state: WalkState): void {
  if (state.run.length === 0) return
  const text = normalizeBlockText(state.run.join(''))
  state.run = []
  if (text !== '') state.out.push({ kind: 'paragraph', text })
}

function blockKindFor(tag: string): DemoEvidenceBlock['kind'] | null {
  if (HEADING_TAGS.has(tag)) return 'heading'
  if (tag === 'p') return 'paragraph'
  if (tag === 'blockquote') return 'quote'
  if (CODE_TAGS.has(tag)) return 'code'
  if (tag === 'tr') return 'table'
  if (tag === 'li') return 'list_item'
  return null
}

function walk(node: DuckNode, state: WalkState): void {
  if (node.nodeType === TEXT_NODE) {
    const text = node.textContent ?? ''
    if (text !== '') state.run.push(text)
    return
  }
  const el = asElement(node)
  if (el === null) return
  const tag = tagOf(el)

  const kind = blockKindFor(tag)
  if (kind !== null) {
    // 命中即整块收割（后代不再单独成块；嵌套结构并入本文本）
    flushRun(state)
    let text: string
    if (tag === 'tr') {
      // 表格行：单元格文本单空格连接
      const cells: string[] = []
      for (const child of el.childNodes) {
        const cell = asElement(child)
        if (cell !== null && (tagOf(cell) === 'td' || tagOf(cell) === 'th')) {
          cells.push(normalizeBlockText(cell.textContent ?? ''))
        }
      }
      text = cells.join(' ')
    } else {
      text = normalizeBlockText(el.textContent ?? '')
    }
    if (text !== '') state.out.push({ kind, text })
    return
  }

  if (INLINE_TAGS.has(tag)) {
    walkChildren(el, state)
    return
  }
  // 其余块级容器：前后冲刷（文本 run 不跨块级边界）
  flushRun(state)
  walkChildren(el, state)
  flushRun(state)
}

function walkChildren(el: DuckNode, state: WalkState): void {
  for (const child of [...el.childNodes]) {
    walk(child, state)
  }
}

// —— 对外入口 ——

/**
 * 六步规则的步骤 1–4：剥噪 → 选根 → DOM 序块生成 → 门槛过滤。
 * 空 HTML / 无可读内容 → 空数组（步骤 6 由调用方判 projection_empty）。
 */
export function extractBlocks(sanitizedHtml: string): ExtractedBlock[] {
  if (sanitizedHtml.trim() === '') return [] // linkedom 对空串无 documentElement（防御）
  const { document } = parseHTML(sanitizedHtml)
  const body = document.body as unknown as DuckNode | null
  if (body === null) return []

  // 步骤 1：全树剥离
  stripTree(body)

  // 步骤 2：根选择——eligible text 最多的 main（并列取文档序第一个）
  const roots = {
    mains: [] as DuckNode[],
    articles: [] as DuckNode[],
  }
  collect(body, roots)
  let root: DuckNode = body
  if (roots.mains.length > 0) {
    let best: DuckNode | null = null
    let bestChars = -1
    for (const main of roots.mains) {
      const chars = eligibleTextOf(main)
      if (chars > bestChars) {
        best = main
        bestChars = chars
      }
    }
    root = best!
  } else if (roots.articles.length > 0) {
    // 无 main：顶层 article/[role=article] 里第一个通过最低文本检查的
    const topLevel = roots.articles.filter(a => !hasAncestorTag(a, 'article') && eligibleTextOf(a) >= MIN_BLOCK_CHARS)
    if (topLevel.length > 0) root = topLevel[0]!
    // 仍无：去噪 body 兜底
  }

  // 步骤 3 + 4：DOM 序收割 + 门槛
  const state: WalkState = { run: [], out: [] }
  walkChildren(root, state)
  flushRun(state)

  const blocks: ExtractedBlock[] = []
  for (const raw of state.out) {
    const nonWs = raw.text.replace(/\s/g, '').length
    const passes = raw.kind === 'heading' ? raw.text !== '' : nonWs >= MIN_BLOCK_CHARS
    if (!passes) continue
    blocks.push({ kind: raw.kind, text: raw.text, textHash: textHashOf(raw.text), ordinal: blocks.length })
  }
  return blocks
}

/** 深度优先收集 main 与 article/[role=article]（文档序）。 */
function collect(node: DuckNode, out: { mains: DuckNode[]; articles: DuckNode[] }): void {
  const el = asElement(node)
  if (el === null) return
  const tag = tagOf(el)
  if (tag === 'main') {
    out.mains.push(el)
    return // 嵌套 main 不计（外层已覆盖）
  }
  if (tag === 'article') out.articles.push(el)
  else {
    const get = el.getAttribute
    if (get !== undefined && get.call(el, 'role') === 'article') out.articles.push(el)
  }
  for (const child of [...el.childNodes]) collect(child, out)
}
