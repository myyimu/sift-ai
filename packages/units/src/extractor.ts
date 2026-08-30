// P0.5 分级 UnitExtractor-v1.2：Semantic → Repeated Structure → Main Content fallback。
// 输入永远是已经脱敏、持久化的 HTML；linkedom/projector 只在离线内存中运行。
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { sanitizeUrl } from '@sift/shared'
import { extractBlocks, type ExtractedBlock } from '@sift/projector'
import {
  UNIT_EXTRACTOR_VERSION,
  UNIT_NORMALIZER_VERSION,
  type CanonicalUnit,
  type CaptureExtent,
  type DerivedMetadata,
  type EvidenceBlob,
  type EvidenceBlock,
  type ExtractionMode,
  type IdentityKey,
  type SourceMetadataSnapshot,
  type UnitMaterialization,
  type UnitObservation,
  type UnitObservationSourceLink,
  canonicalUnitIdFor,
  evidenceBlockIdFor,
  materializeUnitVersions,
  sha256Of,
  stableContentFingerprint,
  unitObservationIdFor,
} from './model'

export interface UnitExtractorLimits {
  readonly maxInputBytes: number
  readonly maxNodes: number
  readonly maxDepth: number
  readonly maxCandidates: number
  readonly maxUnits: number
  readonly minTextChars: number
  readonly splitThreshold: number
}

export const DEFAULT_UNIT_EXTRACTOR_LIMITS: UnitExtractorLimits = {
  maxInputBytes: 5 * 1024 * 1024,
  maxNodes: 50_000,
  maxDepth: 64,
  maxCandidates: 1_000,
  maxUnits: 200,
  minTextChars: 20,
  splitThreshold: 0.6,
}

export interface UnitExtractorInput {
  readonly html: string
  readonly sourceObservationId: string
  readonly sessionId: string
  readonly pageInstanceId: string
  readonly stateVersion: number
  readonly safeUrl: string
  readonly title?: string
  readonly observedAt: string
  readonly captureExtent?: CaptureExtent
  readonly limits?: Partial<UnitExtractorLimits>
}

export interface UnitExtractorDiagnostics {
  readonly extractorVersion: string
  readonly visitedNodes: number
  readonly candidateCount: number
  readonly acceptedUnitCount: number
  readonly semanticCount: number
  readonly repeatedStructureCount: number
  readonly fallbackUsed: boolean
}

export type UnitExtractorResult =
  | {
      readonly status: 'ok'
      readonly observations: readonly UnitObservation[]
      readonly sourceLinks: readonly UnitObservationSourceLink[]
      readonly canonicalUnits: readonly CanonicalUnit[]
      readonly derivedMetadata: readonly DerivedMetadata[]
      readonly evidenceBlocks: readonly EvidenceBlock[]
      readonly evidenceBlobs: readonly EvidenceBlob[]
      readonly materialization: UnitMaterialization
      readonly diagnostics: UnitExtractorDiagnostics
    }
  | { readonly status: 'extraction_empty'; readonly diagnostics: UnitExtractorDiagnostics }
  | { readonly status: 'extraction_failed'; readonly reason: 'input_too_large' | 'resource_limit' | 'invalid_html'; readonly diagnostics: UnitExtractorDiagnostics }

interface Candidate {
  readonly element: Element
  readonly mode: ExtractionMode
  readonly confidence: number
  readonly ownHtml: string
  readonly blocks: readonly ExtractedBlock[]
  readonly identityKey: IdentityKey
  readonly unitUrl?: string
  readonly sourceMetadata?: SourceMetadataSnapshot
}

interface WalkStats { nodes: number; maxDepth: number }

function mergedLimits(input?: Partial<UnitExtractorLimits>): UnitExtractorLimits {
  return { ...DEFAULT_UNIT_EXTRACTOR_LIMITS, ...(input ?? {}) }
}

function walkStats(root: Element, limits: UnitExtractorLimits): WalkStats | null {
  const stats: WalkStats = { nodes: 0, maxDepth: 0 }
  const visit = (node: Node, depth: number): boolean => {
    stats.nodes += 1
    stats.maxDepth = Math.max(stats.maxDepth, depth)
    if (stats.nodes > limits.maxNodes || depth > limits.maxDepth) return false
    for (const child of Array.from(node.childNodes)) if (!visit(child, depth + 1)) return false
    return true
  }
  return visit(root, 0) ? stats : null
}

function textLength(text: string): number {
  return text.replace(/\s/g, '').length
}

function candidateOwnHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element
  // 先保留子 Unit 自己的候选，再从父 Unit ownContent 中剔除，避免 EvidenceBlock 重叠。
  for (const nested of Array.from(clone.querySelectorAll('article,[role="article"]'))) nested.remove()
  // projector 的根选择需要一个真实 document.body；linkedom 对裸片段会把 body 留空。
  return `<html><body>${clone.outerHTML}</body></html>`
}

function canonicalUrlOf(raw: string, pageUrl: string): string | null {
  const absolute = (() => {
    try { return new URL(raw, pageUrl).toString() } catch { return null }
  })()
  if (absolute === null) return null
  const safe = sanitizeUrl(absolute)
  return safe.denied ? null : safe.safeUrl
}

function firstAttr(element: Element, selectors: readonly string[], attrs: readonly string[]): string | undefined {
  for (const selector of selectors) {
    const found = element.matches(selector) ? element : element.querySelector(selector)
    if (found === null) continue
    for (const attr of attrs) {
      const value = found.getAttribute(attr)
      if (value !== null && value.trim() !== '') return value.trim()
    }
  }
  return undefined
}

function metadataOf(element: Element): SourceMetadataSnapshot | undefined {
  const author = firstAttr(element, ['[rel~="author"]', '[itemprop="author"]', '[data-author]'], ['content', 'datetime', 'data-author'])
  const publishedAt = firstAttr(element, ['time[datetime]', '[itemprop="datePublished"]'], ['datetime', 'content'])
  const metadata: SourceMetadataSnapshot = {
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata
}

function typeOf(element: Element): 'article' | 'comment' | 'content' | 'unknown' {
  const role = element.getAttribute('role')?.toLowerCase()
  const itemType = element.getAttribute('itemtype')?.toLowerCase() ?? ''
  if (role === 'comment' || itemType.includes('comment')) return 'comment'
  if (itemType.includes('article') || itemType.includes('discussionforumposting') || element.tagName.toLowerCase() === 'article' || role === 'article') return 'article'
  return textLength(element.textContent ?? '') >= 80 ? 'content' : 'unknown'
}

function structureFingerprint(element: Element): string {
  const tags = Array.from(element.children).slice(0, 16).map(child => child.tagName.toLowerCase()).join(',')
  const role = element.getAttribute('role')?.toLowerCase() ?? ''
  const textBucket = Math.min(9, Math.floor(textLength(element.textContent ?? '') / 100))
  const links = element.querySelectorAll('a').length
  const controls = element.querySelectorAll('button,input,select,textarea').length
  return `${element.tagName.toLowerCase()}|${role}|${tags}|t${textBucket}|l${Math.min(9, links)}|c${Math.min(9, controls)}`
}

function identityOf(element: Element, pageUrl: string): { key: IdentityKey; unitUrl?: string } {
  const permalink = firstAttr(element, ['a[rel~="permalink"]', 'a[itemprop="url"]', '[itemprop="url"]', '[data-permalink]'], ['href', 'content', 'data-permalink'])
  const permalinkUrl = permalink === undefined ? null : canonicalUrlOf(permalink, pageUrl)
  if (permalinkUrl !== null) return { key: { kind: 'permalink', url: permalinkUrl }, unitUrl: permalinkUrl }
  const anchor = element.getAttribute('id')?.trim()
  if (anchor !== undefined && anchor !== '') {
    try {
      const page = new URL(pageUrl)
      return { key: { kind: 'anchor', origin: page.origin, canonicalPageUrl: pageUrl, stableAnchor: anchor } }
    } catch {
      // safeUrl 已在捕获侧校验；解析失败时保守退化为 unkeyed。
    }
  }
  return { key: { kind: 'unkeyed' } }
}

function isEligibleListItem(element: Element, limits: UnitExtractorLimits): boolean {
  const role = element.getAttribute('role')?.toLowerCase()
  if (role === 'button' || role === 'menuitem' || isNoiseAncestor(element)) return false
  if (element.querySelector('button,input,select,textarea') !== null && textLength(element.textContent ?? '') < limits.minTextChars * 2) return false
  return textLength(element.textContent ?? '') >= limits.minTextChars
}

function isNoiseAncestor(element: Element): boolean {
  let current: Element | null = element.parentElement
  while (current !== null) {
    const tag = current.tagName.toLowerCase()
    const role = current.getAttribute('role')?.toLowerCase()
    if (tag === 'nav' || tag === 'header' || tag === 'footer' || tag === 'aside' || role === 'navigation' || role === 'menu' || role === 'menubar' || role === 'toolbar') return true
    current = current.parentElement
  }
  return false
}

function buildCandidate(
  element: Element,
  mode: ExtractionMode,
  confidence: number,
  input: UnitExtractorInput,
): Candidate | null {
  const ownHtml = candidateOwnHtml(element)
  const blocks = extractBlocks(ownHtml)
  if (blocks.length === 0 || blocks.every(block => textLength(block.text) < (block.kind === 'heading' ? 1 : (input.limits?.minTextChars ?? DEFAULT_UNIT_EXTRACTOR_LIMITS.minTextChars)))) return null
  const identity = identityOf(element, input.safeUrl)
  const sourceMetadata = metadataOf(element)
  const mergedMetadata = input.title !== undefined && input.title.trim() !== ''
    ? { title: input.title, ...(sourceMetadata ?? {}) }
    : sourceMetadata
  return {
    element,
    mode,
    confidence,
    ownHtml,
    blocks,
    identityKey: identity.key,
    ...(identity.unitUrl === undefined ? {} : { unitUrl: identity.unitUrl }),
    ...(mergedMetadata === undefined ? {} : { sourceMetadata: mergedMetadata }),
  }
}

function semanticCandidates(body: Element, input: UnitExtractorInput, limit: UnitExtractorLimits): Candidate[] {
  const out: Candidate[] = []
  for (const element of Array.from(body.querySelectorAll('article,[role="article"]'))) {
    const candidate = buildCandidate(element, 'semantic', 0.95, input)
    if (candidate !== null) out.push(candidate)
    if (out.length > limit.maxCandidates) break
  }
  return out
}

function repeatedCandidates(body: Element, input: UnitExtractorInput, limit: UnitExtractorLimits): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<Element>()
  for (const parent of Array.from(body.querySelectorAll('*'))) {
    if (isNoiseAncestor(parent)) continue
    const groups = new Map<string, Element[]>()
    for (const child of Array.from(parent.children)) {
      const role = child.getAttribute('role')?.toLowerCase()
      if (role === 'navigation' || role === 'menuitem') continue
      const key = structureFingerprint(child)
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [child])
      else group.push(child)
    }
    for (const group of groups.values()) {
      if (group.length < 3) continue
      for (const element of group) {
        if (seen.has(element) || !isEligibleListItem(element, limit)) continue
        const candidate = buildCandidate(element, 'repeated_structure', limit.splitThreshold + 0.05, input)
        if (candidate !== null) { seen.add(element); out.push(candidate) }
      }
    }
    if (out.length >= limit.maxCandidates) break
  }
  return out
}

function fallbackCandidate(body: Element, input: UnitExtractorInput, limit: UnitExtractorLimits): Candidate | null {
  // Readability 只处理独立的 linkedom 文档副本；传入的已捕获 HTML 不会触发
  // 网络或资源加载。它修改传入 DOM，因此绝不能复用主解析树。
  try {
    const clonedDocument = parseHTML(`<html><body>${body.innerHTML}</body></html>`).document
    const article = new Readability(clonedDocument, {
      disableJSONLD: true,
      maxElemsToParse: limit.maxNodes,
    }).parse()
    const content = typeof article?.content === 'string' ? article.content : ''
    const text = article?.textContent ?? ''
    if (content.trim() !== '' && textLength(text) >= limit.minTextChars) {
      const ownHtml = `<html><body>${content}</body></html>`
      const blocks = extractBlocks(ownHtml)
      if (blocks.length > 0 && blocks.some(block => block.kind !== 'heading' && textLength(block.text) >= limit.minTextChars)) {
        const sourceMetadata: SourceMetadataSnapshot = {
          ...(input.title === undefined || input.title.trim() === '' ? {} : { title: input.title }),
          ...(typeof article?.byline === 'string' && article.byline.trim() !== '' ? { author: article.byline.trim() } : {}),
          ...(typeof article?.publishedTime === 'string' && article.publishedTime.trim() !== '' ? { publishedAt: article.publishedTime.trim() } : {}),
        }
        return {
          element: body,
          mode: 'main_content_fallback',
          confidence: 0.55,
          ownHtml,
          blocks,
          identityKey: { kind: 'unkeyed' },
          ...(Object.keys(sourceMetadata).length === 0 ? {} : { sourceMetadata }),
        }
      }
    }
  } catch {
    // Readability 对非浏览器 DOM 的兼容性可能随版本变化；失败时继续走确定性根选择。
  }
  const roots: Array<{ element: Element; priority: number; order: number }> = [{ element: body, priority: 0, order: 0 }]
  const rootSelectors: ReadonlyArray<{ selector: string; priority: number }> = [
    { selector: 'main,[role="main"],article,[role="article"],[itemprop="articleBody"]', priority: 3 },
    { selector: '#content,#main,.article,.post,.entry,[class*="article"],[class*="content"],[class*="post"],[class*="entry"]', priority: 2 },
  ]
  let order = 1
  for (const { selector, priority } of rootSelectors) {
    for (const element of Array.from(body.querySelectorAll(selector))) roots.push({ element, priority, order: order++ })
  }
  let selected: { element: Element; ownHtml: string; blocks: readonly ExtractedBlock[]; priority: number; order: number; score: number } | null = null
  for (const root of roots) {
    const content = root.element === body ? body.innerHTML : root.element.outerHTML
    const ownHtml = `<html><body>${content}</body></html>`
    const blocks = extractBlocks(ownHtml)
    if (blocks.length === 0 || !blocks.some(block => block.kind !== 'heading' && textLength(block.text) >= limit.minTextChars)) continue
    const score = blocks.reduce((total, block) => total + (block.kind === 'heading' ? 0 : textLength(block.text)), 0)
    if (selected === null || root.priority > selected.priority || (root.priority === selected.priority && (score > selected.score || (score === selected.score && root.order < selected.order)))) selected = { ...root, ownHtml, blocks, score }
  }
  // 标题 alone 不是可读主内容；fallback 必须至少有一个达到正文门槛的块，
  // 否则返回 extraction_empty，不为了“有一个 Unit”而包装空壳页面。
  if (selected === null) return null
  const identity = identityOf(selected.element, input.safeUrl)
  return {
    element: selected.element,
    mode: 'main_content_fallback',
    confidence: 0.55,
    ownHtml: selected.ownHtml,
    blocks: selected.blocks,
    identityKey: { kind: 'unkeyed' },
    ...(identity.unitUrl === undefined ? {} : { unitUrl: identity.unitUrl }),
  }
}

function makeResult(candidates: readonly Candidate[], input: UnitExtractorInput, diagnostics: UnitExtractorDiagnostics): UnitExtractorResult {
  const observations: UnitObservation[] = []
  const sourceLinks: UnitObservationSourceLink[] = []
  const canonical = new Map<string, CanonicalUnit>()
  const metadata: DerivedMetadata[] = []
  const evidenceBlocks: EvidenceBlock[] = []
  const evidenceBlobs = new Map<string, EvidenceBlob>()
  const occurrences = new Map<string, number>()
  const extent = input.captureExtent ?? 'unknown'

  for (const candidate of candidates) {
    const rawFingerprint = sha256Of(candidate.ownHtml)
    const occurrenceKey = `${input.pageInstanceId}|${rawFingerprint}`
    const occurrence = occurrences.get(occurrenceKey) ?? 0
    occurrences.set(occurrenceKey, occurrence + 1)
    const canonicalUnitId = canonicalUnitIdFor(candidate.identityKey, candidate.identityKey.kind === 'unkeyed' ? String(occurrence) : '')
    const observationId = unitObservationIdFor(input.sourceObservationId, canonicalUnitId, rawFingerprint)
    const text = candidate.blocks.map(block => block.text).join('\n\n')
    const stableFingerprint = stableContentFingerprint(text)
    const blocks: EvidenceBlock[] = candidate.blocks.map((block, ordinal) => {
      const id = evidenceBlockIdFor(observationId, block.textHash, ordinal)
      evidenceBlobs.set(block.textHash, { id: block.textHash, text: block.text, textHash: block.textHash })
      return { id, unitObservationId: observationId, evidenceBlobId: block.textHash, textHash: block.textHash, stateVersion: input.stateVersion, ordinal }
    })
    const observation: UnitObservation = {
      id: observationId,
      canonicalUnitId,
      captureExtent: extent,
      observedAt: input.observedAt,
      sessionId: input.sessionId,
      pageInstanceId: input.pageInstanceId,
      extractionMode: candidate.mode,
      confidence: Math.max(0, Math.min(1, candidate.confidence)),
      rawFingerprint,
      stableContentFingerprint: stableFingerprint,
      normalizerVersion: UNIT_NORMALIZER_VERSION,
      ...(candidate.sourceMetadata === undefined ? {} : { sourceMetadata: { ...(input.title === undefined ? {} : { title: input.title }), ...candidate.sourceMetadata } }),
      evidenceBlocks: blocks,
    }
    observations.push(observation)
    sourceLinks.push({ unitObservationId: observationId, sourceObservationId: input.sourceObservationId, linkedAt: input.observedAt })
    if (!canonical.has(canonicalUnitId)) {
      canonical.set(canonicalUnitId, {
        id: canonicalUnitId,
        identityKey: candidate.identityKey,
        createdAt: input.observedAt,
        ...(candidate.unitUrl === undefined ? {} : { url: candidate.unitUrl }),
      })
    }
    metadata.push({ canonicalUnitId, parserVersion: UNIT_EXTRACTOR_VERSION, type: typeOf(candidate.element) })
    evidenceBlocks.push(...blocks)
  }

  const canonicalUnits = [...canonical.values()]
  const materialization = materializeUnitVersions(observations, canonicalUnits)
  return {
    status: 'ok',
    observations,
    sourceLinks,
    canonicalUnits,
    derivedMetadata: metadata,
    evidenceBlocks,
    evidenceBlobs: [...evidenceBlobs.values()].sort((a, b) => a.id.localeCompare(b.id)),
    materialization,
    diagnostics,
  }
}

export function extractUnits(input: UnitExtractorInput): UnitExtractorResult {
  const limits = mergedLimits(input.limits)
  const baseDiagnostics: UnitExtractorDiagnostics = {
    extractorVersion: UNIT_EXTRACTOR_VERSION,
    visitedNodes: 0,
    candidateCount: 0,
    acceptedUnitCount: 0,
    semanticCount: 0,
    repeatedStructureCount: 0,
    fallbackUsed: false,
  }
  if (new TextEncoder().encode(input.html).byteLength > limits.maxInputBytes) return { status: 'extraction_failed', reason: 'input_too_large', diagnostics: baseDiagnostics }
  if (input.html.trim() === '') return { status: 'extraction_empty', diagnostics: baseDiagnostics }
  let body: Element
  try {
    const parsed = parseHTML(input.html).document
    // linkedom parses a bare fragment outside document.body; normalize it so
    // fixtures and persisted snapshots follow the same extraction path.
    if ((parsed.body?.childNodes.length ?? 0) === 0 && !/<body\b/i.test(input.html)) {
      body = parseHTML(`<html><body>${input.html}</body></html>`).document.body as unknown as Element
    } else {
      body = parsed.body as unknown as Element
    }
  } catch {
    return { status: 'extraction_failed', reason: 'invalid_html', diagnostics: baseDiagnostics }
  }
  const stats = walkStats(body, limits)
  if (stats === null) return { status: 'extraction_failed', reason: 'resource_limit', diagnostics: { ...baseDiagnostics, visitedNodes: limits.maxNodes + 1 } }
  const semantic = semanticCandidates(body, input, limits)
  const repeated = repeatedCandidates(body, input, limits)
  const candidates: Candidate[] = []
  const seenElements = new Set<Element>()
  for (const candidate of [...semantic, ...repeated]) {
    if (seenElements.has(candidate.element)) continue
    seenElements.add(candidate.element)
    candidates.push(candidate)
    if (candidates.length >= limits.maxCandidates) break
  }
  if (candidates.length > limits.maxUnits) {
    return {
      status: 'extraction_failed',
      reason: 'resource_limit',
      diagnostics: { ...baseDiagnostics, visitedNodes: stats.nodes, candidateCount: candidates.length, semanticCount: semantic.length, repeatedStructureCount: repeated.length },
    }
  }
  const accepted = candidates.filter(candidate => candidate.confidence >= limits.splitThreshold)
  const selected = accepted.length > 0 ? accepted : (() => {
    const fallback = fallbackCandidate(body, input, limits)
    return fallback === null ? [] : [fallback]
  })()
  const diagnostics: UnitExtractorDiagnostics = {
    ...baseDiagnostics,
    visitedNodes: stats.nodes,
    candidateCount: candidates.length,
    acceptedUnitCount: selected.length,
    semanticCount: semantic.length,
    repeatedStructureCount: repeated.length,
    fallbackUsed: accepted.length === 0 && selected.length > 0,
  }
  if (selected.length === 0) return { status: 'extraction_empty', diagnostics }
  return makeResult(selected, input, diagnostics)
}
