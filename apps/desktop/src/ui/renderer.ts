// 渲染层（原生 DOM，无框架）。纪律：
//  - 一切动态文本走 textContent——投影块/模型回答是不可信数据，永不 innerHTML；
//  - 状态词表只用 store 可推导子集（本地存储未连接/正在捕获/观察已暂停/捕获失败/
//    跨域后需要重新授权/已保存到本地/正在生成问题投影/等待远程处理确认/正在回答/
//    回答或引用校验失败/模型未配置）；授权/捕获类状态只来自已落盘控制事件，不伪造；
//  - 确认发送前零模型调用：buildProjection 全程本地，网络只发生在"确认发送"之后。
import './styles.css'
import { renderCoverageSummary } from '@sift/shared'
import type { QuestionProjection } from '@sift/shared'
import type { AskModelIpc, IpcResult, SiftBridge } from './preload'
import type { DemoMetricEvent, StoredAnswer, StoreOverview } from '../qa-service'
import { selectPromptPool } from '@sift/topics/prompt-pool'
import { computeTopicRelations, layoutTopicCloud } from '@sift/topics/model'
import type { TopicProjection, TopicStats } from '@sift/topics/model'

declare const window: Window & { sift?: SiftBridge }

function requireBridge(): SiftBridge {
  const bridge = window.sift
  if (bridge === undefined) {
    throw new Error('preload 桥不可用（sift 未暴露——请勿在浏览器中直接打开本页）')
  }
  return bridge
}

const bridge: SiftBridge = requireBridge()

function $(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`面板骨架缺少 #${id}`)
  return el
}

const statusEl = $('status')
const hostStatusEl = $('host-status')
const storeMetaEl = $('store-meta')
const modelMetaEl = $('model-meta')
const scopeSelect = $('scope-select') as HTMLSelectElement
const questionInput = $('question-input') as HTMLTextAreaElement
const presetList = $('preset-list')
const buildButton = $('build-button') as HTMLButtonElement
const previewSection = $('preview-section')
const previewStatsEl = $('preview-stats')
const previewModelEl = $('preview-model')
const previewBlocksEl = $('preview-blocks')
const confirmButton = $('confirm-button') as HTMLButtonElement
const cancelButton = $('cancel-button') as HTMLButtonElement
const answerSection = $('answer-section')
const coverageSummaryEl = $('coverage-summary')
const answerTextEl = $('answer-text')
const answerSourcesEl = $('answer-sources')
const answerClaimsEl = $('answer-claims')
const answerLimitationsEl = $('answer-limitations')
const answerAnalyzerEl = $('answer-analyzer')
const timeSavedInput = $('time-saved-input') as HTMLInputElement
const timeSavedButton = $('time-saved-button') as HTMLButtonElement
const evaluationReportEl = $('evaluation-report')
const answersListEl = $('answers-list')
const deleteSessionButton = $('delete-session-button') as HTMLButtonElement
const deletePageButton = $('delete-page-button') as HTMLButtonElement
const deleteAllButton = $('delete-all-button') as HTMLButtonElement
const deleteReportEl = $('delete-report')
const topic7Button = $('topic-7-button') as HTMLButtonElement
const topic30Button = $('topic-30-button') as HTMLButtonElement
const topicConfirmButton = $('topic-confirm-button') as HTMLButtonElement
const topicStatusEl = $('topic-status')
const topicListEl = $('topic-list')
const topicDetailEl = $('topic-detail')
let pendingTopicDays: number | null = null

type Tone = 'ok' | 'busy' | 'err'
function setStatus(text: string, tone: Tone = 'busy'): void {
  statusEl.textContent = text
  statusEl.className = `status ${tone}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

// —— 概览与 scope ——

let overview: StoreOverview | null = null
let projection: QuestionProjection | null = null
let activeEvaluation: { readonly inputHash: string; readonly startedAt: string } | null = null

function shortUrl(url: string): string {
  return url.length > 58 ? `${url.slice(0, 55)}…` : url
}

function renderScopeOptions(): void {
  const prev = scopeSelect.value
  while (scopeSelect.options.length > 0) scopeSelect.remove(0)
  if (overview === null) return
  for (const session of overview.sessions) {
    const opt = document.createElement('option')
    opt.value = `session:${session.sessionId}`
    opt.textContent = `session ${session.sessionId.slice(0, 10)}…（${session.observationCount} 条观察 · ${session.pageInstanceIds.length} 页）`
    scopeSelect.add(opt)
  }
  for (const page of overview.pages) {
    const opt = document.createElement('option')
    opt.value = `page:${page.pageInstanceId}`
    opt.textContent = `page ${shortUrl(page.canonicalUrl)}（${page.observationCount} 条）`
    scopeSelect.add(opt)
  }
  if (prev !== '') scopeSelect.value = prev
}

async function refreshOverview(): Promise<void> {
  const result = await bridge.overview()
  if (result.ok) {
    overview = result.value
    const latest = result.value.pages.reduce<(typeof result.value.pages)[number] | null>(
      (current, page) => current === null || page.lastEventReceivedAt > current.lastEventReceivedAt ? page : current,
      null,
    )
    const status = latest?.lastEventType === 'capture_paused'
      ? ['观察已暂停', 'busy'] as const
      : latest?.lastEventType === 'capture_failed'
        ? latest.lastEventCode === 'capture_limit_exceeded'
          ? ['页面超过 Demo 上限', 'err'] as const
          : ['页面不受支持', 'err'] as const
        : latest?.lastEventType === 'authorization_revoked'
          ? latest.lastEventReason === 'cross_origin'
            ? ['跨域后需要重新授权', 'err'] as const
            : latest.lastEventReason === 'tab_closed'
              ? ['页面已关闭，需要重新授权', 'err'] as const
              : latest.lastEventReason === 'injection_failed'
                ? ['注入失败，请重新授权', 'err'] as const
                : ['观察连接已断开', 'err'] as const
          : latest?.lastEventType === 'document_started' || latest?.lastEventType === 'capture_resumed'
            ? ['正在捕获', 'busy'] as const
            : result.value.pages.length > 0
              ? ['已保存到本地', 'ok'] as const
              : ['未授权当前页面', 'busy'] as const
    setStatus(status[0], status[1])
    hostStatusEl.textContent = result.value.nativeHost.connected
      ? `Native Host 已连接（${result.value.nativeHost.activeLeases} 个进程）`
      : 'Native Host 未连接'
    hostStatusEl.className = `host-status ${result.value.nativeHost.connected ? 'connected' : 'disconnected'}`
    const last = latest?.lastEventReceivedAt ?? ''
    storeMetaEl.textContent = `${result.value.sessions.length} 个 session · ${result.value.pages.length} 个 page${last === '' ? '' : ` · 最近事件 ${last}`}`
    modelMetaEl.textContent = result.value.modelConfig.configured
      ? `模型：${result.value.modelConfig.baseUrl} · ${result.value.modelConfig.model} · ctx≈${result.value.modelConfig.contextWindow}`
      : '模型未配置（SIFT_MODEL_BASE_URL/API_KEY/ID/CTX）'
    renderPromptPool()
    renderScopeOptions()
    updateActionEnabled()
    const topicCache = await bridge.topicCacheStatus()
    if (topicCache.ok && topicCache.value.stale && pendingTopicDays === null) {
      topicStatusEl.textContent = '捕获内容已有更新，当前主题图可能过期；请重新预览并生成。'
    }
  } else {
    setStatus('本地存储未连接', 'err')
    storeMetaEl.textContent = result.message
  }
  await refreshAnswers()
}

function updateActionEnabled(): void {
  buildButton.disabled = questionInput.value.trim() === '' || scopeSelect.value === ''
  deleteSessionButton.disabled = !scopeSelect.value.startsWith('session:')
  deletePageButton.disabled = !scopeSelect.value.startsWith('page:')
}

function renderPromptPool(): void {
  while (presetList.firstChild !== null) presetList.removeChild(presetList.firstChild)
  const selectedPages = scopeSelect.value.startsWith('page:')
    ? 1
    : (overview?.sessions.find(session => `session:${session.sessionId}` === scopeSelect.value)?.pageInstanceIds.length ?? 0)
  for (const preset of selectPromptPool({ pages: selectedPages }, 6)) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'preset'
    button.textContent = preset.text
    button.addEventListener('click', () => {
      questionInput.value = preset.text
      updateActionEnabled()
    })
    presetList.append(button)
  }
}

// —— 投影与确认 ——

async function onBuild(): Promise<void> {
  if (questionInput.value.trim() === '' || scopeSelect.value === '') return
  setStatus('正在生成问题投影')
  activeEvaluation = null
  const result = await bridge.buildProjection(scopeSelect.value, questionInput.value.trim())
  if (!result.ok) {
    setStatus('本地存储未连接', 'err')
    storeMetaEl.textContent = result.message
    return
  }
  const value = result.value
  if (value.status === 'scope_parse_error' || value.status === 'scope_not_found') {
    setStatus(value.message, 'err')
    return
  }
  if (value.status === 'projection_empty') {
    setStatus('本地无可投影的文本块（scope 内没有快照或全部被去噪剥离）', 'err')
    return
  }
  if (value.status === 'projection_input_invalid') {
    setStatus(`投影输入无效：${value.reason}`, 'err')
    return
  }
  if (value.status === 'projection_limit_exceeded') {
    setStatus(
      `超出投影限额（pages=${value.usage.pages}/${value.limits.maxPages} · blocks=${value.usage.blocks}/${value.limits.maxBlocks} · bytes=${value.usage.utf8Bytes}/${value.limits.maxUtf8Bytes} · tokens≈${value.usage.estimatedTokens}/${value.limits.maxEstimatedTokens}）——全量或不发送，请缩小 scope 或减少阅读历史（单页时可删除本页数据后重新阅读再问）`,
      'err',
    )
    return
  }

  projection = value.projection
  previewStatsEl.textContent = `将发送：${value.preview.pages} 页 · ${value.preview.snapshots} 张快照（含滚动历史） · ${value.preview.blocks} 块 · ${value.preview.utf8Bytes} 字节 · ≈${value.preview.estimatedTokens} tokens · 全量不截断`
  const model = await bridge.modelConfig()
  previewModelEl.textContent = model.ok && model.value.configured
    ? `接收方：${model.value.baseUrl} · 模型 ${model.value.model}（确认前不会发起任何网络请求）`
    : '模型未配置——可预览，但无法发送'
  while (previewBlocksEl.firstChild !== null) previewBlocksEl.removeChild(previewBlocksEl.firstChild)
  for (const block of value.projection.blocks.slice(0, 30)) {
    const row = document.createElement('div')
    row.className = 'preview-block'
    const id = document.createElement('span')
    id.className = 'block-id'
    id.textContent = `${block.id}(${block.kind})`
    const text = document.createElement('span')
    text.textContent = block.text.length > 160 ? `${block.text.slice(0, 160)}…` : block.text
    row.append(id, text)
    previewBlocksEl.append(row)
  }
  if (value.projection.blocks.length > 30) {
    const more = document.createElement('div')
    more.className = 'preview-block'
    more.textContent = `… 共 ${value.projection.blocks.length} 块（预览截断仅影响显示，发送仍是全量）`
    previewBlocksEl.append(more)
  }
  previewSection.hidden = false
  answerSection.hidden = true
  setStatus('等待远程处理确认', 'busy')
  confirmButton.focus()
}

async function onConfirm(): Promise<void> {
  if (projection === null) return
  const current = projection
  const startedAt = new Date().toISOString()
  activeEvaluation = { inputHash: current.inputHash, startedAt }
  confirmButton.disabled = true
  buildButton.disabled = true
  setStatus('正在回答')
  let result: IpcResult<AskModelIpc>
  try {
    result = await bridge.askModel(current)
  } catch (error) {
    setStatus('回答或引用校验失败', 'err')
    answerTextEl.textContent = `请求未完成：${errorMessage(error)}`
    answerSection.hidden = false
    return
  } finally {
    // IPC 断线/主进程异常也必须恢复按钮，否则 Demo 面板会永久卡在“正在回答”。
    confirmButton.disabled = false
    updateActionEnabled()
  }
  if (!result.ok) {
    setStatus('回答或引用校验失败', 'err')
    answerTextEl.textContent = result.message
    answerSection.hidden = false
    return
  }
  const value = result.value
  if (value.status === 'model_unconfigured') {
    setStatus('模型未配置', 'err')
    return
  }
  if (value.status === 'failed') {
    setStatus('回答或引用校验失败', 'err')
    answerTextEl.textContent = `${value.code}：${value.message}`
    answerSection.hidden = false
    return
  }

  // 回答顶部恒渲染覆盖声明（验收门 16）：观察者不假装看过了全部内容
  coverageSummaryEl.textContent = renderCoverageSummary(current.coverage)
  answerTextEl.textContent = value.answer.answer.answer
  renderAnswerSources(value.answer.answer, current)
  while (answerClaimsEl.firstChild !== null) answerClaimsEl.removeChild(answerClaimsEl.firstChild)
  for (const claim of value.answer.answer.claims) {
    const row = document.createElement('div')
    row.className = 'claim'
    const text = document.createElement('div')
    text.textContent = claim.text
    const refs = document.createElement('div')
    refs.className = 'refs'
    refs.textContent = `证据：${claim.evidenceBlockRefs.join('、')}`
    const rating = document.createElement('div')
    rating.className = 'claim-rating'
    for (const [label, ratingValue] of [['支持', 'supported'], ['不确定', 'uncertain'], ['不支持', 'unsupported']] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.addEventListener('click', () => {
        if (activeEvaluation === null) return
        void recordMetric({ schemaVersion: 1, type: 'claim_support_rated', inputHash: activeEvaluation.inputHash, claimId: claim.claimId, rating: ratingValue, at: new Date().toISOString() })
      })
      rating.append(button)
    }
    row.append(text, refs, rating)
    answerClaimsEl.append(row)
  }
  while (answerLimitationsEl.firstChild !== null) answerLimitationsEl.removeChild(answerLimitationsEl.firstChild)
  for (const limitation of value.answer.answer.limitations) {
    const row = document.createElement('div')
    row.className = 'limitation'
    row.textContent = limitation
    answerLimitationsEl.append(row)
  }
  answerAnalyzerEl.textContent = `analyzer：${value.answer.answer.analyzer.provider} · ${value.answer.answer.analyzer.model} · ${value.answer.answer.analyzer.promptVersion}（本地盖章）`
  answerSection.hidden = false
  if (activeEvaluation !== null) {
    await recordMetric({
      schemaVersion: 1,
      type: 'answer_completed',
      inputHash: activeEvaluation.inputHash,
      startedAt: activeEvaluation.startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - Date.parse(activeEvaluation.startedAt)),
      sourceCount: value.answer.answer.sources.length,
      claimCount: value.answer.answer.claims.length,
    })
  }
  setStatus('已保存到本地', 'ok')
  previewSection.hidden = true
  projection = null
  await refreshAnswers()
}

async function recordMetric(event: DemoMetricEvent): Promise<void> {
  const result = await bridge.recordDemoMetric(event)
  if (!result.ok) evaluationReportEl.textContent = result.message
}

function renderAnswerSources(answer: StoredAnswer['answer'], current: QuestionProjection): void {
  while (answerSourcesEl.firstChild !== null) answerSourcesEl.removeChild(answerSourcesEl.firstChild)
  const byId = new Map(current.blocks.map(block => [block.id, block]))
  const refs = [...new Set([
    ...answer.sources.map(source => source.evidenceBlockRef),
    ...answer.claims.flatMap(claim => claim.evidenceBlockRefs),
  ])]
  if (refs.length === 0) return
  const heading = document.createElement('h3')
  heading.textContent = '来源'
  answerSourcesEl.append(heading)
  for (const ref of refs) {
    const block = byId.get(ref)
    if (block === undefined) continue
    const card = document.createElement('div')
    card.className = 'answer-source'
    const text = document.createElement('div')
    text.className = 'answer-source-text'
    text.textContent = block.text
    card.append(text)
    for (const source of block.sources) {
      const meta = document.createElement('div')
      meta.className = 'answer-source-meta'
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'source-link'
      open.textContent = `${source.title ?? '未命名页面'} · ${shortUrl(source.safeUrl)}`
      open.addEventListener('click', () => {
        void (async () => {
          const opened = await bridge.openSource(source.safeUrl)
          if (!opened.ok) {
            evaluationReportEl.textContent = opened.message
            return
          }
          if (activeEvaluation !== null) await recordMetric({ schemaVersion: 1, type: 'source_clicked', inputHash: activeEvaluation.inputHash, evidenceBlockRef: ref, at: new Date().toISOString() })
        })()
      })
      meta.append(open)
      card.append(meta)
    }
    answerSourcesEl.append(card)
  }
}

// —— 历史答案 ——

async function refreshAnswers(): Promise<void> {
  const result = await bridge.listAnswers()
  while (answersListEl.firstChild !== null) answersListEl.removeChild(answersListEl.firstChild)
  if (!result.ok) return
  if (result.value.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '还没有答案'
    answersListEl.append(empty)
    return
  }
  for (const item of result.value) {
    const row = document.createElement('div')
    row.className = 'answer-item'
    const q = document.createElement('div')
    q.textContent = item.question
    const meta = document.createElement('div')
    meta.className = 'meta'
    meta.textContent = `${item.completedAt} · ${item.analyzer.model} · ${item.answerPreview.slice(0, 80)}…`
    row.append(q, meta)
    answersListEl.append(row)
  }
}

function topicRange(days: number): { readonly from: string; readonly to: string } {
  const to = new Date()
  return { from: new Date(to.getTime() - days * 24 * 60 * 60 * 1000).toISOString(), to: to.toISOString() }
}

async function onPrepareTopics(days: number): Promise<void> {
  if (scopeSelect.value === '') return
  topic7Button.disabled = true
  topic30Button.disabled = true
  topicConfirmButton.hidden = true
  topicStatusEl.textContent = '正在本地计算主题范围（不会请求模型）'
  while (topicListEl.firstChild !== null) topicListEl.removeChild(topicListEl.firstChild)
  topicDetailEl.hidden = true
  const range = topicRange(days)
  let result: Awaited<ReturnType<SiftBridge['previewTopics']>>
  try {
    result = await bridge.previewTopics(scopeSelect.value, range.from, range.to)
  } catch (error) {
    topicStatusEl.textContent = `主题预览失败：${errorMessage(error)}`
    return
  } finally {
    topic7Button.disabled = false
    topic30Button.disabled = false
  }
  if (!result.ok) { topicStatusEl.textContent = result.message; return }
  const value = result.value
  if (value.status === 'scope_parse_error' || value.status === 'invalid_input' || value.status === 'scope_not_found' || value.status === 'invalid_range') { topicStatusEl.textContent = value.message ?? '主题范围无效'; return }
  if (value.status === 'projection_empty') { topicStatusEl.textContent = '范围内没有可分析的本地 Unit'; return }
  if (value.status === 'limit_exceeded') { topicStatusEl.textContent = `超出主题分析上限：${value.usage.units} Units · ${value.usage.pages} Pages · ≈${value.usage.estimatedTokens} tokens，请缩小范围`; return }
  if (value.status !== 'ok') { topicStatusEl.textContent = '主题范围预览失败'; return }
  pendingTopicDays = days
  topicConfirmButton.hidden = false
  topicConfirmButton.focus()
  topicStatusEl.textContent = `将发送到模型：${value.preview.units} Units · ${value.preview.pages} Pages · ${value.preview.domains} Domains · ≈${value.preview.estimatedTokens} tokens。仅发送上述本地捕获范围，确认后才会产生一次远程请求。`
}

async function onGenerateTopics(days: number): Promise<void> {
  const range = topicRange(days)
  topic7Button.disabled = true
  topic30Button.disabled = true
  topicConfirmButton.disabled = true
  topicStatusEl.textContent = '正在生成主题（已获得本次远程处理确认）'
  let result: Awaited<ReturnType<SiftBridge['generateTopics']>>
  try {
    result = await bridge.generateTopics(scopeSelect.value, range.from, range.to)
  } catch (error) {
    topicStatusEl.textContent = `主题生成失败：${errorMessage(error)}`
    return
  } finally {
    topic7Button.disabled = false
    topic30Button.disabled = false
    topicConfirmButton.disabled = false
    topicConfirmButton.hidden = true
    pendingTopicDays = null
  }
  if (!result.ok) { topicStatusEl.textContent = result.message; return }
  const value = result.value
  if (value.status === 'scope_parse_error' || value.status === 'invalid_input' || value.status === 'scope_not_found' || value.status === 'invalid_range') { topicStatusEl.textContent = value.message ?? '主题范围无效'; return }
  if (value.status === 'model_unconfigured') { topicStatusEl.textContent = '模型未配置，主题地图不会发送请求'; return }
  if (value.status === 'projection_empty') { topicStatusEl.textContent = '范围内没有可分析的本地 Unit'; return }
  if (value.status === 'limit_exceeded') { topicStatusEl.textContent = `超出主题分析上限：${value.usage.units} Units · ${value.usage.pages} Pages · ≈${value.usage.estimatedTokens} tokens，请缩小范围`; return }
  if (value.status === 'model_failed' || value.status === 'validation_failed') { topicStatusEl.textContent = value.status === 'model_failed' ? `${value.code}：${value.message}` : `主题引用校验失败：${value.reasons.join('；')}`; return }
  if (value.status !== 'ok') { topicStatusEl.textContent = '主题地图生成失败'; return }
  const projection: TopicProjection = value.projection
  topicStatusEl.textContent = `${value.cacheHit ? '已从本地缓存加载' : '已生成并缓存'}：${value.preview.units} Units · ${value.preview.pages} Pages · ${value.preview.domains} Domains`
  renderTopicCloud(projection, value.stats)
}

function renderTopicCloud(projection: TopicProjection, stats: readonly TopicStats[]): void {
  while (topicListEl.firstChild !== null) topicListEl.removeChild(topicListEl.firstChild)
  const width = 500
  const height = 320
  const layout = layoutTopicCloud(stats, width, height)
  const byId = new Map(projection.topics.map(topic => [topic.topicId, topic]))
  const cloud = document.createElement('div')
  cloud.className = 'topic-cloud'
  cloud.setAttribute('role', 'list')
  cloud.setAttribute('aria-label', '主题云；节点大小表示去重后的 CanonicalUnit 数')
  cloud.style.width = `${width}px`
  cloud.style.height = `${height}px`
  const relationLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  relationLayer.classList.add('topic-relations')
  relationLayer.setAttribute('aria-hidden', 'true')
  relationLayer.setAttribute('viewBox', `0 0 ${width} ${height}`)
  const centers = new Map(layout.map(node => [node.topicId, { x: node.x + node.width / 2, y: node.y + node.height / 2 }]))
  for (const relation of computeTopicRelations(projection)) {
    const from = centers.get(relation.fromTopicId)
    const to = centers.get(relation.toTopicId)
    if (from === undefined || to === undefined) continue
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('x1', String(from.x)); line.setAttribute('y1', String(from.y)); line.setAttribute('x2', String(to.x)); line.setAttribute('y2', String(to.y))
    line.setAttribute('stroke-width', String(Math.max(1, Math.round(relation.jaccardOverlap * 4))))
    line.setAttribute('stroke', '#b8c4de')
    relationLayer.append(line)
  }
  cloud.append(relationLayer)
  for (const node of layout) {
    const topic = byId.get(node.topicId)
    if (topic === undefined) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'topic-node'
    button.setAttribute('role', 'listitem')
    button.style.left = `${node.x}px`; button.style.top = `${node.y}px`; button.style.width = `${node.width}px`; button.style.height = `${node.height}px`
    button.textContent = `${topic.label}（${new Set(topic.canonicalUnitRefs).size} Units）`
    button.title = topic.summary
    button.addEventListener('click', () => void onTopicDetail(projection, topic.topicId))
    cloud.append(button)
  }
  topicListEl.append(cloud)
  const note = document.createElement('p')
  note.className = 'topic-cloud-note'
  note.textContent = '节点大小＝去重后的 CanonicalUnit 数；连线粗细＝共同 Unit 的 Jaccard overlap。点击节点查看来源。'
  topicListEl.append(note)
}

async function onTopicDetail(projection: TopicProjection, topicId: string): Promise<void> {
  const result = await bridge.topicDetail(scopeSelect.value, projection, topicId)
  while (topicDetailEl.firstChild !== null) topicDetailEl.removeChild(topicDetailEl.firstChild)
  topicDetailEl.hidden = false
  if (!result.ok) { topicDetailEl.textContent = result.message; return }
  const value = result.value
  if (value.status !== 'ok') { topicDetailEl.textContent = value.message ?? '主题详情不可用'; return }
  const heading = document.createElement('h3')
  heading.textContent = `${value.label} · 来源`
  const summary = document.createElement('p')
  summary.textContent = `AI 归纳：${value.summary}`
  topicDetailEl.append(heading, summary)
  for (const source of value.sources) {
    const card = document.createElement('div')
    card.className = 'topic-source'
    const meta = document.createElement('p')
    meta.className = 'meta'
    meta.textContent = `${source.title ?? '未命名内容'} · ${source.captureExtent} · ${source.observedAt}`
    const text = document.createElement('p')
    text.textContent = source.text
    const ref = document.createElement('p')
    ref.className = 'refs'
    ref.textContent = `${source.evidenceBlockId} · ${source.canonicalUnitId}`
    card.append(meta, text, ref)
    topicDetailEl.append(card)
  }
}

// —— 数据控制（验收门 14 最小实现） ——

async function onDeleteSession(): Promise<void> {
  const scopeRaw = scopeSelect.value
  if (!scopeRaw.startsWith('session:')) return
  const sessionId = scopeRaw.slice('session:'.length)
  deleteSessionButton.disabled = true
  const result = await bridge.deleteSession(sessionId)
  if (result.ok) {
    deleteReportEl.textContent = `已删除 ${result.value.removedObservations} 条观察、${result.value.removedPages} 个 page-state、${result.value.removedBlobs} 个 blob`
  } else {
    deleteReportEl.textContent = result.message // store_busy 等真实错误如实展示
  }
  await refreshOverview()
}

async function onDeletePage(): Promise<void> {
  const scopeRaw = scopeSelect.value
  if (!scopeRaw.startsWith('page:')) return
  const pageInstanceId = scopeRaw.slice('page:'.length)
  deletePageButton.disabled = true
  const result = await bridge.deletePage(pageInstanceId)
  deleteReportEl.textContent = result.ok
    ? `已删除 ${result.value.removedObservations} 条观察、${result.value.removedPages} 个 page-state、${result.value.removedBlobs} 个 blob 及关联答案`
    : result.message
  await refreshOverview()
}

let deleteAllArmed = false
async function onDeleteAll(): Promise<void> {
  if (!deleteAllArmed) {
    deleteAllArmed = true
    deleteAllButton.textContent = '再次点击确认删除全部'
    setTimeout(() => {
      deleteAllArmed = false
      deleteAllButton.textContent = '删除全部本地数据（含答案）'
    }, 5000)
    return
  }
  deleteAllArmed = false
  deleteAllButton.textContent = '删除全部本地数据（含答案）'
  const result = await bridge.deleteAll()
  deleteReportEl.textContent = result.ok ? '已删除全部本地数据（含答案）' : result.message
  answerSection.hidden = true
  previewSection.hidden = true
  projection = null
  activeEvaluation = null
  await refreshOverview()
}

// —— 事件绑定与启动 ——

buildButton.addEventListener('click', () => void onBuild())
confirmButton.addEventListener('click', () => void onConfirm())
cancelButton.addEventListener('click', () => {
  previewSection.hidden = true
  projection = null
  activeEvaluation = null
  void refreshOverview()
})
deleteSessionButton.addEventListener('click', () => void onDeleteSession())
deletePageButton.addEventListener('click', () => void onDeletePage())
deleteAllButton.addEventListener('click', () => void onDeleteAll())
topic7Button.addEventListener('click', () => void onPrepareTopics(7))
topic30Button.addEventListener('click', () => void onPrepareTopics(30))
topicConfirmButton.addEventListener('click', () => { if (pendingTopicDays !== null) void onGenerateTopics(pendingTopicDays) })
timeSavedButton.addEventListener('click', () => {
  if (activeEvaluation === null) return
  const minutes = Number(timeSavedInput.value)
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 10_000) {
    evaluationReportEl.textContent = '请输入 0 到 10000 之间的分钟数'
    return
  }
  void recordMetric({ schemaVersion: 1, type: 'subjective_time_saved', inputHash: activeEvaluation.inputHash, minutes, at: new Date().toISOString() })
  evaluationReportEl.textContent = '已记录主观节省时间'
})
questionInput.addEventListener('input', updateActionEnabled)
scopeSelect.addEventListener('change', () => {
  updateActionEnabled()
  renderPromptPool()
})
bridge.onOverviewUpdated(() => void refreshOverview())

void refreshOverview()
