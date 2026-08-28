// Sift MV3 service worker（Phase 2 实现；冻结边界见下）。
//
// 冻结的边界（P0_DEMO_SCOPE §2.2 / ADR-001 E-04 / P0_EXTENSION_ARCHITECTURE）：
//  - 仅在 Chrome 认可的用户手势（action 点击）后 scripting.executeScript 注入固定文件
//    （显式 world:'ISOLATED'、仅主 frame：allFrames:false）；
//  - manifest 无 host_permissions；跨 origin 后撤销并停止观察（验收门 3）。
//    判定器（P0_EXTENSION_ARCHITECTURE §3.4，零权限）：tabs.onUpdated(status=complete，
//    无需任何权限即可收到) 后对授权 tab 重注入固定 CS——成功=同源（activeTab 仍有效，
//    哨兵幂等）；失败=Chrome 已撤销 activeTab（跨源/不可授权页）→ 即时撤权。
//    已知取舍：同源页瞬时 executeScript 错误会误撤权（失败关闭方向，P0 不重试）；
//  - 唯一网络出口是 chrome.runtime.connectNative -> com.dj.sift.demo
//    （allowed_origins 只含固定 demo Extension ID）；
//  - 大 payload 应用层分块 <= 256 KiB；host commit_ack 后才视为落盘完成。
//
// 身份归属（SW 是权威）：sessionId 与 tabId→{pageInstanceId, grantedOrigin, sequence}
// 存 chrome.storage.session（SW 重启不丢、浏览器会话结束即清）；CS 只上报内容，
// SW 盖 envelope（id/sequence/receivedAt），hash 由 transport 计算后回填。
import type { ObservationEnvelope, ObservationType } from '@sift/shared'
import { CAPTURE_VERSION, REDACTION_POLICY } from '@sift/shared/wire'
import { sanitizeUrl } from '@sift/shared/sanitize'
import {
  connectChromeNativePort,
  createCaptureTransport,
  subtleSha256Hex,
  type PendingObservation,
} from './transport'

// —— 会话状态（chrome.storage.session；SW 重启不丢） ——

interface TabGrant {
  pageInstanceId: string
  grantedOrigin: string
  nextSequence: number
  /** 当前 document 的 CS 实例；SW 重启后从 storage.session 恢复。 */
  instanceNonce?: string
  /** tabs.onUpdated 已确认新 document，等待新 CS 首个 document_started。 */
  navigationPending?: boolean
  paused?: boolean
}

interface SwState {
  sessionId: string
  tabs: Record<string, TabGrant>
}

const STATE_KEY = 'sift-state-v1'

async function loadState(): Promise<SwState | null> {
  const bag = await chrome.storage.session.get(STATE_KEY)
  return (bag[STATE_KEY] as SwState | undefined) ?? null
}

async function saveState(state: SwState): Promise<void> {
  await chrome.storage.session.set({ [STATE_KEY]: state })
}

// —— 传输 ——

const transport = createCaptureTransport({
  connectNative: connectChromeNativePort,
  sha256Hex: subtleSha256Hex,
  log: message => console.info(`[sift] ${message}`),
})

const PENDING_HASH = `sha256:${'0'.repeat(64)}` // transport announce 前回填真实 hash

interface EmitInput {
  readonly tabId: number
  readonly grant: TabGrant
  readonly sessionId: string
  readonly type: ObservationType
  readonly source: ObservationEnvelope['source']
  readonly url: string
  readonly contentEpoch: number
  readonly payloadJson: string
}

/** 盖 envelope 入队（sequence 即时分配并持久化；同页实例单调递增）。 */
async function emit(input: EmitInput): Promise<void> {
  const sequence = input.grant.nextSequence
  input.grant.nextSequence += 1
  await saveState({ sessionId: input.sessionId, tabs: grantsSnapshot() })

  const envelope: ObservationEnvelope = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    tabId: String(input.tabId),
    pageInstanceId: input.grant.pageInstanceId,
    contentEpoch: input.contentEpoch,
    sequence,
    receivedAt: new Date().toISOString(),
    url: input.url,
    source: input.source,
    type: input.type,
    payloadRef: PENDING_HASH,
    payloadHash: PENDING_HASH,
    redactionPolicy: REDACTION_POLICY,
    captureVersion: CAPTURE_VERSION,
  }
  const observation: PendingObservation = {
    envelope,
    payloadJson: input.payloadJson,
    transferId: crypto.randomUUID(),
    kind: input.type === 'dom_snapshot' ? 'dom_snapshot' : 'control',
  }
  transport.enqueue(observation)
}

/** 控制事件 payload（固定键序，确定性序列化）。 */
function controlPayloadJson(fields: Record<string, unknown>): string {
  return JSON.stringify({ schemaVersion: 1, captureVersion: CAPTURE_VERSION, ...fields })
}

/** 当前授权表的浅拷贝（持久化用；tabId 键为字符串）。 */
const grants = new Map<string, TabGrant>()

function grantsSnapshot(): Record<string, TabGrant> {
  const out: Record<string, TabGrant> = {}
  for (const [tabId, grant] of grants) out[tabId] = grant
  return out
}

function hydrateGrants(state: SwState): void {
  grants.clear()
  for (const [tabId, grant] of Object.entries(state.tabs)) grants.set(tabId, grant)
}

// —— 授权生命周期 ——

chrome.action.onClicked.addListener(tab => {
  void handleActionClick(tab).catch(error => console.warn('[sift] action click failed:', error))
})

// 键盘手势（manifest commands：Alt+Shift+S，2026-08-27 用户批准；权限数组零变更——
// command 手势与 action 点击同样授予 activeTab）。查询当前活动 tab 后走同一授权路径；
// 查询失败/tab 无 url → 失败关闭，仅告警不动作。
const GRANT_COMMAND = 'sift-grant-current-tab'

chrome.commands.onCommand.addListener(command => {
  if (command !== GRANT_COMMAND) return
  void handleGrantCommand().catch(error => console.warn('[sift] grant command failed:', error))
})

async function handleGrantCommand(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab === undefined || tab.id === undefined || tab.url === undefined) {
    console.warn('[sift] command 手势未找到带 URL 的活动页面，忽略')
    return
  }
  await handleActionClick(tab)
}

async function handleActionClick(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || tab.url === undefined) return
  const urlResult = sanitizeUrl(tab.url)
  if (urlResult.denied) {
    console.warn(`[sift] 拒绝授权（敏感页面 ${urlResult.denyReason}）`)
    return
  }
  const origin = new URL(tab.url).origin
  const tabKey = String(tab.id)

  let state = await loadState()
  if (state === null) {
    state = { sessionId: `s-${crypto.randomUUID()}`, tabs: {} }
  }
  hydrateGrants(state)

  const existing = grants.get(tabKey)
  if (existing !== undefined && existing.grantedOrigin === origin) {
    // 已授权页面的再次手势切换暂停/恢复；首次点击仍走下方授权+注入路径。
    const state = await loadState()
    if (state === null) return
    await setCapturePaused(tab.id, state.sessionId, existing, existing.paused !== true, urlResult.safeUrl)
    return
  }
  if (existing !== undefined) {
    // 异源重点：先撤旧 grant（authorization_revoked 配对完整，旧 pageInstanceId 的 sequence 闭合）
    await revokeGrant(tab.id, 'cross_origin', `${existing.grantedOrigin}/`)
  }

  const grant: TabGrant = {
    pageInstanceId: `p-${crypto.randomUUID()}`,
    grantedOrigin: origin,
    nextSequence: 0,
    navigationPending: false,
  }
  grants.set(tabKey, grant)

  await emit({
    tabId: tab.id,
    grant,
    sessionId: state.sessionId,
    type: 'authorization_granted',
    source: 'extension',
    url: urlResult.safeUrl,
    contentEpoch: 0,
    payloadJson: controlPayloadJson({ kind: 'authorization_granted', url: urlResult.safeUrl, reason: 'user_gesture', origin }),
  })
  await chrome.action.setBadgeText({ tabId: tab.id, text: 'S' })
  try {
    await injectContentScript(tab.id)
  } catch {
    // executeScript 失败时不能留下“已授权”假状态；保留已排队的 granted，
    // 追加配对的 injection_failed 撤销事件，Host 侧按顺序落盘。
    await revokeGrant(tab.id, 'injection_failed', urlResult.safeUrl)
  }
}

async function setCapturePaused(
  tabId: number,
  sessionId: string,
  grant: TabGrant,
  paused: boolean,
  safeUrl: string,
): Promise<void> {
  grant.paused = paused
  if (!paused) {
    // 暂停期间若发生了新 document，旧 CS 已不存在；恢复时允许一次固定脚本注入，
    // document_started 会在 navigationPending 下建立新的 pageInstanceId。
    grant.navigationPending = true
  }
  await saveState({ sessionId, tabs: grantsSnapshot() })
  await chrome.action.setBadgeText({ tabId, text: paused ? 'P' : 'S' }).catch(() => {})
  if (!paused) {
    try {
      await injectContentScript(tabId)
    } catch {
      await revokeGrant(tabId, 'injection_failed', safeUrl)
      return
    }
  }
  await sendPauseToContentScript(tabId, paused)
  await emit({
    tabId,
    grant,
    sessionId,
    type: paused ? 'capture_paused' : 'capture_resumed',
    source: 'extension',
    url: safeUrl,
    contentEpoch: 0,
    payloadJson: controlPayloadJson({ kind: paused ? 'capture_paused' : 'capture_resumed' }),
  })
}

async function sendPauseToContentScript(tabId: number, paused: boolean): Promise<void> {
  try {
    const sendMessage = (chrome.tabs as typeof chrome.tabs & { sendMessage?: (id: number, message: unknown) => Promise<unknown> }).sendMessage
    if (typeof sendMessage === 'function') {
      await sendMessage.call(chrome.tabs, tabId, { sift: 1, kind: 'set_paused', paused })
    }
  } catch {
    // content script 可能已因导航销毁；状态仍按用户手势持久化，重注入时会恢复。
  }
}

async function injectContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ['content-script.js'],
    world: 'ISOLATED',
  })
}

/** 跨源/关Tab/注入失败撤销：清授权 + authorization_revoked 事件 + badge 清除。 */
async function revokeGrant(tabId: number, reason: 'cross_origin' | 'tab_closed' | 'injection_failed', url: string): Promise<void> {
  const tabKey = String(tabId)
  const grant = grants.get(tabKey)
  if (grant === undefined) return
  const state = await loadState()
  grants.delete(tabKey)
  if (state !== null) {
    await saveState({ sessionId: state.sessionId, tabs: grantsSnapshot() })
  }
  await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}) // tab 可能已不在/已跨源
  if (state === null) return
  await emit({
    tabId,
    grant,
    sessionId: state.sessionId,
    type: 'authorization_revoked',
    source: 'extension',
    url,
    contentEpoch: 0,
    payloadJson: controlPayloadJson({ kind: 'authorization_revoked', url, reason }),
  })
}

chrome.tabs.onRemoved.addListener(tabId => {
  void (async () => {
    const state = await loadState()
    if (state === null) return
    hydrateGrants(state)
    const grant = grants.get(String(tabId))
    if (grant !== undefined) {
      await revokeGrant(tabId, 'tab_closed', `${grant.grantedOrigin}/`)
    }
  })().catch(error => console.warn('[sift] tabs.onRemoved failed:', error))
})

// —— 跨 origin 即时撤权判定器（Option B：零权限变更，P0_EXTENSION_ARCHITECTURE §3.4） ——
// tabs.onUpdated 无需任何权限即可收到 status（Chrome 只扣留 url/title 字段）。
// status=complete 时对授权 tab 重注入固定 CS：
//   成功 = 同源导航（activeTab 仍有效）→ CS 哨兵幂等，观察继续；
//   失败 = Chrome 已撤销 activeTab（跨源/chrome:// 等不可授权页）→ 即时撤权。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return
  void handleNavigationComplete(tabId).catch(error => console.warn('[sift] tabs.onUpdated failed:', error))
})

async function handleNavigationComplete(tabId: number): Promise<void> {
  const state = await loadState()
  if (state === null) return
  hydrateGrants(state)
  const grant = grants.get(String(tabId))
  if (grant === undefined) return // 未授权 tab 的导航：不产生任何观察
  // 只在确认新 document 的重注入窗口内换代。初次 action 授权不设 pending，
  // 因而首个 document_started 不会无谓创建第二个 pageInstanceId。
  grant.navigationPending = true
  await saveState({ sessionId: state.sessionId, tabs: grantsSnapshot() })
  if (grant.paused === true) {
    // 暂停态不向新 document 注入观察器；恢复手势会重新注入并换代。
    grant.navigationPending = false
    await saveState({ sessionId: state.sessionId, tabs: grantsSnapshot() })
    return
  }
  try {
    await injectContentScript(tabId) // 同源：CS 重注入（document_started 由 CS 上报）
  } catch {
    // Chrome 拒绝注入 = activeTab 已被跨源导航撤销 → 失败关闭，即时撤权。
    // 已知取舍：同源页瞬时 executeScript 错误同样走这里（误撤权 = 用户重点即恢复，P0 不重试）。
    await revokeGrant(tabId, 'cross_origin', `${grant.grantedOrigin}/`)
  }
}

// —— CS 消息 ——

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const msg = raw as { sift?: number; kind?: string }
  if (msg?.sift !== 1 || typeof msg.kind !== 'string') return false
  void handleCsMessage(raw as Parameters<typeof handleCsMessage>[0], sender).catch(error =>
    console.warn('[sift] CS 消息处理失败:', error),
  )
  sendResponse({ ok: true }) // CS sendMessage 的 promise 需要一个响应以避免未处理 rejection
  return false
})

async function handleCsMessage(
  msg: { sift: 1; kind: string; instanceNonce: string; contentEpoch?: number; code?: string; detail?: string; url?: string; title?: string; payloadJson?: string },
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id
  const senderOrigin = sender.origin ?? (sender.tab?.url !== undefined ? new URL(sender.tab.url).origin : undefined)
  if (tabId === undefined) return
  const state = await loadState()
  if (state === null) return
  hydrateGrants(state)
  const grant = grants.get(String(tabId))
  if (grant === undefined) return // 未授权 tab 的注入：忽略（不产生观察）
  if (senderOrigin !== undefined && senderOrigin !== grant.grantedOrigin) {
    // 跨源：立即撤销（失败关闭；badge 由 revokeGrant 统一清除）
    const url = sanitizeUrl(msg.url ?? sender.tab?.url ?? senderOrigin)
    await revokeGrant(tabId, 'cross_origin', url.denied ? senderOrigin : url.safeUrl)
    return
  }

  // 暂停状态保存在 storage.session；SW 重启后旧 CS 可能仍短暂存活，
  // 入口侧再次拦截其内容/失败消息，避免暂停被 SW 生命周期绕过。
  if (grant.paused === true && msg.kind !== 'document_started') return

  switch (msg.kind) {
    case 'document_started': {
      if (typeof msg.instanceNonce !== 'string' || msg.instanceNonce.length < 1 || msg.instanceNonce.length > 64) return
      const previousNonce = grant.instanceNonce
      const isNewDocument = previousNonce !== undefined && previousNonce !== msg.instanceNonce
      if (isNewDocument && grant.navigationPending !== true) {
        // 已换代的旧 CS 延迟消息不能重新夺回当前页面身份。
        return
      }
      if (isNewDocument) {
        grant.pageInstanceId = `p-${crypto.randomUUID()}`
        grant.nextSequence = 0
      }
      grant.instanceNonce = msg.instanceNonce
      grant.navigationPending = false
      await saveState({ sessionId: state.sessionId, tabs: grantsSnapshot() })
      await emit({
        tabId,
        grant,
        sessionId: state.sessionId,
        type: 'document_started',
        source: 'extension',
        url: sanitizeUrl(msg.url ?? '').safeUrl || grant.grantedOrigin,
        contentEpoch: msg.contentEpoch ?? 0,
        payloadJson: controlPayloadJson({
          kind: 'document_started',
          url: sanitizeUrl(msg.url ?? '').safeUrl || grant.grantedOrigin,
          ...(typeof msg.title === 'string' ? { title: msg.title } : {}),
          instanceNonce: msg.instanceNonce,
          sameOriginReinject: isNewDocument,
        }),
      })
      return
    }
    case 'dom_snapshot': {
      if (typeof msg.instanceNonce !== 'string' || msg.instanceNonce.length < 1 || msg.instanceNonce.length > 64) return
      if (grant.instanceNonce !== undefined && grant.instanceNonce !== msg.instanceNonce) return
      if (typeof msg.payloadJson !== 'string' || typeof msg.url !== 'string') return
      const urlResult = sanitizeUrl(msg.url)
      if (urlResult.denied) {
        await revokeGrant(tabId, 'cross_origin', grant.grantedOrigin)
        return
      }
      await emit({
        tabId,
        grant,
        sessionId: state.sessionId,
        type: 'dom_snapshot',
        source: 'dom',
        url: urlResult.safeUrl,
        contentEpoch: msg.contentEpoch ?? 0,
        payloadJson: msg.payloadJson,
      })
      return
    }
    case 'capture_failed': {
      // spec §9：持久化 {kind, code, instanceNonce, contentEpoch}——无 detail、无页面内容。
      // detail 只走 console（本地化自由文本不进 hash 稳定数据）。Grant 保留（失败 ≠ 授权结束）。
      if (typeof msg.instanceNonce !== 'string' || msg.instanceNonce.length < 1 || msg.instanceNonce.length > 64) return
      if (grant.instanceNonce !== undefined && grant.instanceNonce !== msg.instanceNonce) return
      if (typeof msg.code !== 'string') return
      console.warn(`[sift] capture_failed（${msg.instanceNonce}/${msg.code}）：${msg.detail ?? ''}`)
      const failUrlResult = sanitizeUrl(msg.url ?? sender.tab?.url ?? '')
      const failUrl = failUrlResult.denied || failUrlResult.safeUrl === '' ? grant.grantedOrigin : failUrlResult.safeUrl
      const failEpoch = typeof msg.contentEpoch === 'number' ? msg.contentEpoch : 0
      await emit({
        tabId,
        grant,
        sessionId: state.sessionId,
        type: 'capture_failed',
        source: 'extension',
        url: failUrl,
        contentEpoch: failEpoch,
        payloadJson: controlPayloadJson({
          kind: 'capture_failed',
          code: msg.code,
          instanceNonce: msg.instanceNonce,
          contentEpoch: failEpoch,
        }),
      })
      return
    }
    default:
      return
  }
}
