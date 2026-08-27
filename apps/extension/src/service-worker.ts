// Sift MV3 service worker（Phase 2 实现；冻结边界见下）。
//
// 冻结的边界（P0_DEMO_SCOPE §2.2 / ADR-001 E-04 / P0_EXTENSION_ARCHITECTURE）：
//  - 仅在 Chrome 认可的用户手势（action 点击）后 scripting.executeScript 注入固定文件
//    （显式 world:'ISOLATED'、仅主 frame：allFrames:false）；
//  - manifest 无 host_permissions；跨 origin 后撤销并停止观察（验收门 3）；
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
    // 同源重复点击：幂等——只确保 CS 在场（CS 自带防重复注入哨兵）
    await injectContentScript(tab.id)
    return
  }

  const grant: TabGrant = {
    pageInstanceId: `p-${crypto.randomUUID()}`,
    grantedOrigin: origin,
    nextSequence: 0,
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
  await injectContentScript(tab.id)
}

async function injectContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ['content-script.js'],
    world: 'ISOLATED',
  })
}

/** 跨源/关Tab 撤销：清授权 + authorization_revoked 事件 + badge 清除。 */
async function revokeGrant(tabId: number, reason: 'cross_origin' | 'tab_closed', url: string): Promise<void> {
  const tabKey = String(tabId)
  const grant = grants.get(tabKey)
  if (grant === undefined) return
  const state = await loadState()
  grants.delete(tabKey)
  if (state !== null) {
    await saveState({ sessionId: state.sessionId, tabs: grantsSnapshot() })
  }
  if (reason === 'tab_closed') {
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}) // tab 可能已不在
  }
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
  msg: { sift: 1; kind: string; instanceNonce: string; contentEpoch?: number; url?: string; title?: string; payloadJson?: string },
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
    // 跨源：立即撤销（失败关闭）
    const url = sanitizeUrl(msg.url ?? sender.tab?.url ?? senderOrigin)
    await revokeGrant(tabId, 'cross_origin', url.denied ? senderOrigin : url.safeUrl)
    await chrome.action.setBadgeText({ tabId, text: '' })
    return
  }

  switch (msg.kind) {
    case 'document_started': {
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
          sameOriginReinject: false,
        }),
      })
      return
    }
    case 'dom_snapshot': {
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
    case 'capture_failed':
      console.warn(`[sift] capture_failed（${String(msg.instanceNonce)}）：只记诊断，不落盘`)
      return
    default:
      return
  }
}
