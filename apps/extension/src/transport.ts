// Capture 传输状态机（service worker 侧；ADR-001 §9 步骤 3 / P0_EXTENSION_ARCHITECTURE §5）。
//
// 生命周期：懒开 port（connectNative）→ hello → welcome(3s) → 队列逐条：
//   announce → transfer_ack(ok → stop-and-wait chunk×N（2s 超时重发同 index ≤2 次）→ commit
//              → commit_ack(5s 超时→同 transferId 重新 announce ≤2 次))
//   transfer_ack(deduplicated) → 直接下一条（host 已 commit，免发 chunk）。
// 队列空 5s 闲置断开 port（规避 MV3 挂起）；断线/错误：观察留在队头（transferId 不变），
// 1s 后重连——host 侧靠 journal 幂等去重，重发安全。
// 背压：有界队列（8）；dom_snapshot latest-wins 合并（同 pageInstanceId 优先），
// 在途（队头正在传输的）观察不可被合并替换。
//
// port/hash/定时器全部注入——单测用 fake port 与即时 sha256，无需 Chrome。
import {
  NATIVE_HOST_NAME,
  NATIVE_MAX_CHUNK_BYTES,
} from '@sift/shared/limits'
import type { ObservationEnvelope } from '@sift/shared'
import {
  PROTOCOL_VERSION,
  bytesToBase64,
  chunkCountFor,
  parseHostMessage,
} from '@sift/shared/wire'

export interface NativePortLike {
  send(message: unknown): void
  disconnect(): void
  onMessage: { addListener(callback: (message: unknown) => void): void }
  onDisconnect: { addListener(callback: () => void): void }
}

export interface PendingObservation {
  readonly envelope: ObservationEnvelope
  readonly payloadJson: string
  /** SW 生成的传输幂等键（跨重试不变）。 */
  readonly transferId: string
  readonly kind: 'dom_snapshot' | 'control'
}

export interface TransportDeps {
  connectNative(): NativePortLike
  sha256Hex(bytes: Uint8Array): Promise<string>
  log?(message: string): void
}

/**
 * chrome.runtime.connectNative 的直连适配（SW 生产用）。
 *
 * **唯一 postMessage 豁免点**：sift-readonly 的 postMessage 禁令针对页面信道外泄；
 * connectNative 端口是架构批准的唯一网络出口（P0_EXTENSION_ARCHITECTURE §5）。
 * 全仓库只有本函数体内出现一次 postMessage 调用（见 disable 注释）。
 */
export function connectChromeNativePort(): NativePortLike {
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
  return {
    send: (message: unknown) => {
      // eslint-disable-next-line no-restricted-syntax -- 唯一批准的 native 信道路径（见函数头注释）
      port.postMessage(message)
    },
    disconnect: () => port.disconnect(),
    onMessage: port.onMessage,
    onDisconnect: port.onDisconnect,
  }
}

/** SW 安全上下文的 sha256（hex，无 Node 依赖）；测试与生产同实现。 */
export async function subtleSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource)
  const view = new Uint8Array(digest)
  let out = ''
  for (const byte of view) out += byte.toString(16).padStart(2, '0')
  return out
}

const MAX_QUEUE = 8
const WELCOME_TIMEOUT_MS = 3000
const ANNOUNCE_TIMEOUT_MS = 3000
const CHUNK_TIMEOUT_MS = 2000
const CHUNK_MAX_RETRIES = 2
const COMMIT_TIMEOUT_MS = 5000
const COMMIT_MAX_RETRIES = 2
const RETRY_CONNECT_MS = 1000
const IDLE_DISCONNECT_MS = 5000
const CHUNK_SIZE = NATIVE_MAX_CHUNK_BYTES

type State = 'idle' | 'hello' | 'announce' | 'chunk' | 'commit'

export interface CaptureTransport {
  enqueue(observation: PendingObservation): void
  readonly queueSize: number
  readonly state: State
}

export function createCaptureTransport(deps: TransportDeps): CaptureTransport {
  const encoder = new TextEncoder()
  const queue: PendingObservation[] = []
  let port: NativePortLike | null = null
  let state: State = 'idle'
  /** 在途观察始终 = queue[0]（直到 commit_ack/dedup 才出队）。 */
  let inFlightBytes: Uint8Array | null = null
  let inFlightHash = ''
  let inFlightChunkCount = 0
  let nextChunkIndex = 0
  let chunkRetries = 0
  let commitRetries = 0
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let idleHandle: ReturnType<typeof setTimeout> | null = null
  let retryHandle: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const log = (message: string): void => deps.log?.(message)

  const clearAwaitTimer = (): void => {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle)
      timeoutHandle = null
    }
  }

  const armAwaitTimer = (ms: number, onTimeout: () => void): void => {
    clearAwaitTimer()
    timeoutHandle = setTimeout(onTimeout, ms)
  }

  const scheduleIdleDisconnect = (): void => {
    if (idleHandle !== null) return
    idleHandle = setTimeout(() => {
      idleHandle = null
      if (queue.length === 0 && port !== null) {
        log('transport：队列空 5s，断开 native port')
        // 必须走 teardownPort 清空引用：自己 disconnect() 不会触发自己的
        // onDisconnected（Chrome 只在对方断开时回调），残留引用会让下一次
        // enqueue 对已断端口 postMessage，抛 "Attempting to use a
        // disconnected port object"（实测 2026-08-28）。
        teardownPort()
      }
    }, IDLE_DISCONNECT_MS)
  }

  const cancelIdleDisconnect = (): void => {
    if (idleHandle !== null) {
      clearTimeout(idleHandle)
      idleHandle = null
    }
  }

  const teardownPort = (): void => {
    clearAwaitTimer()
    if (port !== null) {
      const dying = port
      port = null
      try {
        dying.disconnect()
      } catch {
        // 已断开
      }
    }
    state = 'idle'
    inFlightBytes = null
  }

  const scheduleRetry = (): void => {
    if (retryHandle !== null || queue.length === 0) return
    retryHandle = setTimeout(() => {
      retryHandle = null
      pump()
    }, RETRY_CONNECT_MS)
  }

  // —— 发送侧 ——

  const connectAndHello = (): void => {
    cancelIdleDisconnect()
    let connectedPort: NativePortLike
    try {
      connectedPort = deps.connectNative()
    } catch (error) {
      log(`transport：connectNative 失败：${String(error)}`)
      scheduleRetry()
      return
    }
    port = connectedPort
    // 端口断开回调可能在 teardown 后延迟到达；绑定实例，避免旧端口
    // 清空新端口引用或把新一轮状态误判为断线。
    connectedPort.onMessage.addListener(raw => {
      if (port === connectedPort) onHostMessage(raw)
    })
    connectedPort.onDisconnect.addListener(() => {
      if (port === connectedPort) onDisconnected()
    })
    state = 'hello'
    connectedPort.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, client: 'sift-extension' })
    armAwaitTimer(WELCOME_TIMEOUT_MS, () => {
      log('transport：welcome 超时')
      teardownPort()
      scheduleRetry()
    })
  }

  const startAnnounce = async (): Promise<void> => {
    const obs = queue[0]
    if (obs === undefined || port === null) return
    state = 'announce'
    const bytes = encoder.encode(obs.payloadJson)
    const hash = `sha256:${await deps.sha256Hex(bytes)}`
    if (state !== 'announce' || queue[0] !== obs || port === null) return // 竞态守卫
    inFlightBytes = bytes
    inFlightHash = hash
    inFlightChunkCount = chunkCountFor(bytes.length, CHUNK_SIZE)
    const envelope = { ...obs.envelope, payloadRef: hash, payloadHash: hash }
    port.send({
      type: 'announce',
      transferId: obs.transferId,
      envelope,
      payloadBytes: bytes.length,
      payloadHash: hash,
      chunkSize: CHUNK_SIZE,
      chunkCount: inFlightChunkCount,
    })
    armAwaitTimer(ANNOUNCE_TIMEOUT_MS, () => {
      log('transport：transfer_ack 超时')
      teardownPort()
      scheduleRetry()
    })
  }

  const sendChunk = (index: number): void => {
    const obs = queue[0]
    if (obs === undefined || port === null || inFlightBytes === null) return
    state = 'chunk'
    const slice = inFlightBytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)
    port.send({
      type: 'chunk',
      transferId: obs.transferId,
      index,
      chunkCount: inFlightChunkCount,
      payloadHash: inFlightHash,
      dataB64: bytesToBase64(slice),
    })
    armAwaitTimer(CHUNK_TIMEOUT_MS, () => {
      chunkRetries += 1
      if (chunkRetries > CHUNK_MAX_RETRIES) {
        log(`transport：chunk#${index} 重发超限`)
        chunkRetries = 0
        teardownPort()
        scheduleRetry()
        return
      }
      log(`transport：chunk#${index} ack 超时，重发`)
      sendChunk(index)
    })
  }

  const sendCommit = (): void => {
    const obs = queue[0]
    if (obs === undefined || port === null) return
    state = 'commit'
    port.send({ type: 'commit', transferId: obs.transferId, payloadHash: inFlightHash })
    armAwaitTimer(COMMIT_TIMEOUT_MS, () => {
      commitRetries += 1
      if (commitRetries > COMMIT_MAX_RETRIES) {
        log('transport：commit_ack 超时超限')
        commitRetries = 0
        teardownPort()
        scheduleRetry()
        return
      }
      log('transport：commit_ack 超时，重新 announce 同 transferId')
      void startAnnounce()
    })
  }

  const pump = (): void => {
    if (stopped) return
    if (port === null) {
      if (queue.length > 0) connectAndHello()
      else scheduleIdleDisconnect()
      return
    }
    if (state === 'idle' && queue.length > 0) void startAnnounce()
    else if (queue.length === 0) scheduleIdleDisconnect()
  }

  // —— 接收侧 ——

  const onHostMessage = (raw: unknown): void => {
    const msg = parseHostMessage(raw)
    if (msg === null) {
      // Host 回包属于不可信输入；畸形帧不能被当作“未知事件”静默忽略，
      // 否则可能造成队列错误出队或版本不兼容继续传输。
      log('transport：收到非法 host 回包，暂停传输')
      teardownPort()
      stopped = true
      queue.length = 0
      return
    }
    const head = queue[0]
    switch (msg?.type) {
      case 'welcome':
        if (state === 'hello') {
          if (msg.protocolVersion !== PROTOCOL_VERSION || msg.storeReady !== true) {
            log('transport：welcome 版本或 store 状态不符，暂停传输')
            teardownPort()
            stopped = true
            queue.length = 0
            return
          }
          state = 'idle'
          clearAwaitTimer()
          pump()
        }
        return
      case 'transfer_ack':
        if (state === 'announce' && head !== undefined && msg.transferId === head.transferId) {
          clearAwaitTimer()
          if (msg.status === 'deduplicated') {
            log(`transport：${msg.transferId} host 已 commit（deduplicated）`)
            queue.shift()
            chunkRetries = 0
            commitRetries = 0
            inFlightBytes = null
            state = 'idle' // 必须复位，pump 只在 idle 时发起下一条 announce
            pump()
          } else {
            chunkRetries = 0
            nextChunkIndex = 0
            sendChunk(0)
          }
        }
        return
      case 'chunk_ack':
        if (state === 'chunk' && head !== undefined && msg.transferId === head.transferId && msg.index === nextChunkIndex) {
          clearAwaitTimer()
          chunkRetries = 0
          nextChunkIndex += 1
          if (nextChunkIndex >= inFlightChunkCount) sendCommit()
          else sendChunk(nextChunkIndex)
        }
        return
      case 'commit_ack':
        if (state === 'commit' && head !== undefined && msg.transferId === head.transferId) {
          if (msg.payloadHash !== inFlightHash) {
            log('transport：commit_ack payloadHash 不符，暂停传输')
            teardownPort()
            stopped = true
            queue.length = 0
            return
          }
          clearAwaitTimer()
          log(`transport：${msg.transferId} commit_ack（deduplicated=${msg.deduplicated}）`)
          queue.shift()
          chunkRetries = 0
          commitRetries = 0
          inFlightBytes = null
          state = 'idle' // 必须复位，pump 只在 idle 时发起下一条 announce
          pump()
        }
        return
      case 'error':
        // host 一律 fail-closed（进程将退出）：断开重连，观察留队头重发。
        // 永久性错误（版本不配/序列违例/配额）重连无意义：停止传输循环（P0：SW 重启前不再尝试）。
        log(`transport：host error ${msg.code}（${msg.transferId ?? '-'}）`)
        teardownPort()
        if (msg.code === 'protocol_version_mismatch' || msg.code === 'sequence_violation' || msg.code === 'quota_exceeded') {
          stopped = true
          queue.length = 0
          log('transport：永久性错误，暂停捕获传输（需人工介入/重装）')
          return
        }
        scheduleRetry()
        return
      default:
        return
    }
  }

  const onDisconnected = (): void => {
    log('transport：native port 断开')
    port = null
    state = 'idle'
    inFlightBytes = null
    clearAwaitTimer()
    scheduleRetry()
  }

  // —— 队列与背压 ——

  const enqueue = (obs: PendingObservation): void => {
    if (stopped) return
    cancelIdleDisconnect()
    const inFlight = state === 'announce' || state === 'chunk' || state === 'commit'
    const replaceableFrom = inFlight ? 1 : 0 // 队头在途时不可替换
    if (obs.kind === 'dom_snapshot') {
      // latest-wins：同 pageInstanceId 的旧 pending 快照被新快照替换
      let idx = queue.findIndex((o, i) => i >= replaceableFrom && o.kind === 'dom_snapshot' && o.envelope.pageInstanceId === obs.envelope.pageInstanceId)
      if (idx === -1 && queue.length >= MAX_QUEUE) {
        // 队满：退而合并任意旧快照
        idx = queue.findIndex((o, i) => i >= replaceableFrom && o.kind === 'dom_snapshot')
      }
      if (idx !== -1) {
        queue[idx] = obs
        log('transport：背压合并（dom_snapshot latest-wins）')
        pump()
        return
      }
      if (queue.length >= MAX_QUEUE) {
        log('transport：队列满且无快照可合并，丢弃新 dom_snapshot')
        return
      }
    } else if (queue.length >= MAX_QUEUE) {
      // 控制事件：挤掉最老的可替换控制事件
      const idx = queue.findIndex((o, i) => i >= replaceableFrom && o.kind === 'control')
      if (idx === -1) {
        log('transport：队列满，丢弃新控制事件')
        return
      }
      queue.splice(idx, 1)
    }
    queue.push(obs)
    pump()
  }

  return {
    enqueue,
    get queueSize(): number {
      return queue.length
    },
    get state(): State {
      return state
    },
  }
}
