// Sift 只读观察 content script（Phase 2 实现；冻结边界见下）。
//
// 冻结的边界（P0_DEMO_SCOPE §2.2 / AGENTS.md）：
//  - 固定 ISOLATED world，只观察主 frame；仅在用户手势后由 service worker 动态注入本文件；
//  - 禁止读取表单值、Cookie、Storage、键盘输入，禁止向网站发起请求；
//  - 源端先克隆并脱敏（cloneNode 子树是唯一合法写路径，sift-readonly 第二层规则），
//    再序列化；hash 由 SW 计算（CS 不持身份字段）；
//  - readable-v1：非空 body 且删噪后 >= 80 个非空白字符，授权后最多等 5s，
//    不足则 capture_too_little_content，不包装空页面；
//  - MutationObserver 只记 dirty trigger（debounce=200ms / maxWait=2000ms），
//    每页只保留一个 latest-wins 待提交 Snapshot；
//  - 5 MiB / 50,000 节点 / 128 深度任一超出即失败关闭 capture_limit_exceeded。
//
// 身份归属：CS 只持 instanceNonce（SW 据此识别换代）+ contentEpoch（SPA 导航自增）。
// CS→SW 消息只带内容；envelope（id/pageInstanceId/sequence/receivedAt）由 SW 盖章。
import { READABLE_WAIT_MS } from '@sift/shared/limits'
import { captureDomSnapshot, type CaptureFailureCode } from './capture'
import { createMutationGate } from './debounce'

/** CS→SW 消息（sift 前缀区分；ISOLATED world 的 runtime.sendMessage 页面无法伪造）。 */
export interface CsDocumentStarted {
  readonly sift: 1
  readonly kind: 'document_started'
  readonly instanceNonce: string
  readonly sameOriginReinject: boolean
  readonly url: string
  readonly title: string
  readonly contentEpoch: number
}

export interface CsDomSnapshot {
  readonly sift: 1
  readonly kind: 'dom_snapshot'
  readonly instanceNonce: string
  readonly contentEpoch: number
  readonly url: string
  readonly title: string
  readonly payloadJson: string
}

export interface CsCaptureFailed {
  readonly sift: 1
  readonly kind: 'capture_failed'
  readonly instanceNonce: string
  readonly code: CaptureFailureCode
  readonly contentEpoch: number
  readonly detail?: string
}

export type CsMessage = CsDocumentStarted | CsDomSnapshot | CsCaptureFailed

/** 重复注入幂等哨兵：SW 在授权重点击时可能再次 executeScript，已存活的 CS 直接退出。 */
const sentinel = window as { __siftCsActive?: boolean }

function startObserving(): void {
  const instanceNonce = crypto.randomUUID()
  let contentEpoch = 0
  let readableTimer: ReturnType<typeof setInterval> | null = null
  let stopped = false
  let paused = false
  let lastSeenUrl = location.href

  // 扩展上下文失效（扩展被重载/更新，旧 CS 残留在已打开页面）：观察必须立即停止，
  // 并释放幂等哨兵——否则之后重新授权注入的新 CS 会被旧哨兵挡住，观察静默死亡。
  // 上报失败的其他形态（如 SW 未唤醒）不停机，只有 context invalidated 是不可恢复的。
  function shutdown(): void {
    if (stopped) return
    stopped = true
    if (readableTimer !== null) clearInterval(readableTimer)
    gate.cancel()
    observer.disconnect()
    const runtimeOnMessage = (chrome.runtime as typeof chrome.runtime & {
      onMessage?: { removeListener(listener: (message: unknown) => boolean): void }
    }).onMessage
    runtimeOnMessage?.removeListener(onControlMessage)
    window.removeEventListener('popstate', onSpaNav)
    window.removeEventListener('hashchange', onSpaNav)
    sentinel.__siftCsActive = false
    console.info('[sift] 扩展上下文已失效（扩展重载/更新），本页观察停止；重新授权可注入新实例')
  }

  function isContextInvalidated(error: unknown): boolean {
    return error instanceof Error && error.message.includes('Extension context invalidated')
  }

  const report = (message: CsMessage): void => {
    if (stopped) return
    try {
      const sent = chrome.runtime.sendMessage(message) as unknown
      // MV3 返回 promise：rejection 形态的失效也要落到同一停机路径
      if (sent !== undefined && typeof (sent as Promise<unknown>).catch === 'function') {
        ;(sent as Promise<unknown>).catch((error: unknown) => {
          if (isContextInvalidated(error)) shutdown()
        })
      }
    } catch (error) {
      if (isContextInvalidated(error)) shutdown()
    }
  }

  const captureNow = (reason: 'initial_readable' | 'mutation_merged'): void => {
    if (stopped || paused) return
    // pushState/replaceState 不触发 popstate；在每次完整快照前比较 URL，
    // 把这类同文档路由纳入新的 contentEpoch，而不改写页面 history API。
    if (location.href !== lastSeenUrl) {
      contentEpoch += 1
      lastSeenUrl = location.href
    }
    const outcome = captureDomSnapshot(document, {
      url: location.href,
      title: document.title,
      contentEpoch,
      reason,
    })
    if (outcome.ok) {
      report({
        sift: 1,
        kind: 'dom_snapshot',
        instanceNonce,
        contentEpoch,
        url: location.href,
        title: document.title,
        payloadJson: outcome.payloadJson,
      })
    } else {
      // 失败关闭：不包装、不降级；报告给 SW 持久化 capture_failed（detail 仅 console 诊断）
      report({
        sift: 1,
        kind: 'capture_failed',
        instanceNonce,
        code: outcome.code,
        contentEpoch,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      })
      console.warn(`[sift] capture failed (${outcome.code}): ${outcome.detail ?? ''}`)
    }
  }

  // readable-v1 等待：授权注入时页面可能尚未渲染完正文——最多等 5s。
  let waitedMs = 0
  const READABLE_POLL_MS = 250

  const isReadable = (): boolean => {
    const text = document.body !== null ? document.body.innerText : ''
    return text.replace(/\s/g, '').length >= 80
  }

  const waitForReadable = (): void => {
    if (isReadable()) {
      captureNow('initial_readable')
      return
    }
    const timer = setInterval(() => {
      waitedMs += READABLE_POLL_MS
      if (isReadable()) {
        clearInterval(timer)
        readableTimer = null
        captureNow('initial_readable')
      } else if (waitedMs >= READABLE_WAIT_MS) {
        clearInterval(timer)
        readableTimer = null
        report({
          sift: 1,
          kind: 'capture_failed',
          instanceNonce,
          code: 'capture_too_little_content',
          contentEpoch,
          detail: `readable-v1 未在 ${READABLE_WAIT_MS}ms 内满足`,
        })
        console.warn('[sift] readable-v1 超时：capture_too_little_content')
      }
    }, READABLE_POLL_MS)
    readableTimer = timer
  }

  // SPA 同源导航：epoch 自增（popstate/hashchange 都视作同源软导航）
  const onSpaNav = (): void => {
    if (location.href !== lastSeenUrl) {
      contentEpoch += 1
      lastSeenUrl = location.href
    }
  }
  window.addEventListener('popstate', onSpaNav)
  window.addEventListener('hashchange', onSpaNav)

  // mutation 汇聚：latest-wins，静默 200ms 或强制 2000ms 出一次 merged snapshot
  const gate = createMutationGate(() => {
    captureNow('mutation_merged')
  })

  const observer = new MutationObserver(mutations => {
    gate.mark()
    void mutations.length // 只计数不读内容（防误用）
  })
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    // 白名单属性会进入快照或影响脱敏判定；其变化不能静默漏采。
    attributes: true,
    attributeFilter: ['href', 'src', 'alt', 'colspan', 'rowspan', 'class', 'id', 'role', 'contenteditable', 'hidden', 'aria-hidden'],
  })

  function setPaused(next: boolean): void {
    if (stopped || paused === next) return
    paused = next
    gate.cancel()
    if (readableTimer !== null) {
      clearInterval(readableTimer)
      readableTimer = null
    }
    if (paused) {
      observer.disconnect()
      return
    }
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href', 'src', 'alt', 'colspan', 'rowspan', 'class', 'id', 'role', 'contenteditable', 'hidden', 'aria-hidden'],
    })
    captureNow('mutation_merged')
  }

  function onControlMessage(message: unknown): boolean {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return false
    const input = message as { sift?: unknown; kind?: unknown; paused?: unknown }
    if (input.sift !== 1 || input.kind !== 'set_paused' || typeof input.paused !== 'boolean') return false
    setPaused(input.paused)
    return false
  }

  const runtimeOnMessage = (chrome.runtime as typeof chrome.runtime & {
    onMessage?: { addListener(listener: (message: unknown) => boolean): void }
  }).onMessage
  runtimeOnMessage?.addListener(onControlMessage)

  // 注入即上报 document_started，然后等 readable-v1
  report({
    sift: 1,
    kind: 'document_started',
    instanceNonce,
    sameOriginReinject: false,
    url: location.href,
    title: document.title,
    contentEpoch,
  })
  waitForReadable()
}

if (sentinel.__siftCsActive === true) {
  // 本 document 已有存活的 CS 实例（授权重点击再次注入）：幂等退出
  console.info('[sift] content script 已注入，跳过重复注入')
} else {
  sentinel.__siftCsActive = true
  startObserving()
}
