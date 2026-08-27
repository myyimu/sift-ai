// service-worker.test.ts —— SW 生命周期语义（mock 语义，非真 Chrome）：
//   stub globalThis.chrome（action/tabs/storage.session/scripting/runtime）+
//   脚本化 native port（hello→welcome、announce→transfer_ack、chunk→chunk_ack、
//   commit→commit_ack 全自动应答），再动态 import SW 模块，从监听器注册表驱动。
//
// 覆盖：授权点击→granted+badge；onUpdated 判定器（跨源 executeScript 拒绝→即时撤权、
//   同源→重注入不撤权）；关 tab→tab_closed；异源重点→先撤再授（配对完整）；
//   CS capture_failed→持久化 payload 只含 {kind,code,instanceNonce,contentEpoch}。
//
// mock 语义局限（与 RUNBOOK §5 手动步骤互补）：storage.session 用 Map（无浏览器
// 生命周期语义）；executeScript 成败由测试脚本指定（非 Chrome 真实 activeTab 判定）；
// port 为进程内对象（无 stdio 帧）。真实跨源/同源行为需按 RUNBOOK 手动验证。
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_HOST_NAME } from '@sift/shared/limits'
import { PROTOCOL_VERSION } from '@sift/shared/wire'
import type { ObservationEnvelope } from '@sift/shared'

// —— 帧类型（仅取测试断言所需字段） ——

interface AnnounceFrame {
  readonly type: 'announce'
  readonly transferId: string
  readonly envelope: ObservationEnvelope
  readonly payloadHash: string
  readonly chunkCount: number
}

interface ChunkFrame {
  readonly type: 'chunk'
  readonly transferId: string
  readonly index: number
  readonly dataB64: string
}

// —— chrome stub ——

type Cb<T extends unknown[]> = (...args: T) => void

function makeRegistry<T extends unknown[]>(): { addListener(cb: Cb<T>): void; cbs: Cb<T>[] } {
  const cbs: Cb<T>[] = []
  return { addListener: cb => cbs.push(cb), cbs }
}

function createChromeStub() {
  const sessionStore = new Map<string, unknown>()
  const badges = new Map<number, string>()
  const executeScriptCalls: Array<{ tabId: number }> = []
  let executeScriptMode: 'ok' | 'fail' = 'ok'

  const actionClicked = makeRegistry<[{ id?: number; url?: string }]>()
  const tabsUpdated = makeRegistry<[number, { status?: string }]>()
  const tabsRemoved = makeRegistry<[number]>()
  const commandsFired = makeRegistry<[string]>()
  const runtimeMessage = makeRegistry<[unknown, { tab?: { id?: number; url?: string }; origin?: string }, (r: unknown) => void]>()
  let queryResult: Array<{ id?: number; url?: string }> = []

  // —— 脚本化 native port：对 SW 发来的每类消息即时应答，驱动传输到 commit_ack ——

  const sent: unknown[] = []
  const portListeners: Array<(message: unknown) => void> = []
  const deliver = (message: unknown): void => {
    for (const listener of [...portListeners]) listener(message)
  }
  const autoRespond = (message: unknown): void => {
    const msg = message as { type: string; transferId?: string; index?: number }
    switch (msg.type) {
      case 'hello':
        deliver({ type: 'welcome', protocolVersion: PROTOCOL_VERSION })
        return
      case 'announce':
        deliver({ type: 'transfer_ack', transferId: msg.transferId, status: 'ok' })
        return
      case 'chunk':
        deliver({ type: 'chunk_ack', transferId: msg.transferId, index: msg.index })
        return
      case 'commit':
        deliver({ type: 'commit_ack', transferId: msg.transferId, deduplicated: false })
        return
      default:
        return
    }
  }
  // chrome.runtime.Port 原生形状（SW 经 connectChromeNativePort 适配器包装：postMessage）
  const port = {
    postMessage: (message: unknown) => {
      sent.push(message)
      autoRespond(message)
    },
    disconnect: () => {},
    onMessage: { addListener: (cb: (message: unknown) => void) => portListeners.push(cb) },
    onDisconnect: { addListener: () => {} },
  }
  const connectedNames: string[] = []
  const connectNative = (name: string): typeof port => {
    connectedNames.push(name)
    return port
  }

  const chromeStub = {
    action: {
      onClicked: actionClicked,
      setBadgeText: async ({ tabId, text }: { tabId: number; text: string }) => {
        badges.set(tabId, text)
      },
    },
    tabs: {
      onUpdated: tabsUpdated,
      onRemoved: tabsRemoved,
      query: async () => queryResult,
    },
    commands: {
      onCommand: commandsFired,
    },
    scripting: {
      executeScript: async (injection: { target: { tabId: number } }) => {
        executeScriptCalls.push({ tabId: injection.target.tabId })
        if (executeScriptMode === 'fail') throw new Error('mock: activeTab 已被跨源导航撤销')
        return []
      },
    },
    storage: {
      session: {
        get: async (key: string) => {
          return sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) sessionStore.set(k, v)
        },
      },
    },
    runtime: {
      connectNative,
      onMessage: runtimeMessage,
    },
  }

  return {
    chromeStub,
    sent,
    badges,
    executeScriptCalls,
    connectedNames,
    sessionStore,
    setExecuteScriptMode: (mode: 'ok' | 'fail') => {
      executeScriptMode = mode
    },
    setActiveTab: (tab: { id?: number; url?: string } | undefined) => {
      queryResult = tab === undefined ? [] : [tab]
    },
    pressCommand: async (name: string) => {
      for (const cb of commandsFired.cbs) cb(name)
      await tick()
    },
    clickAction: async (tab: { id?: number; url?: string }) => {
      for (const cb of actionClicked.cbs) cb(tab)
      await tick()
    },
    navComplete: async (tabId: number) => {
      for (const cb of tabsUpdated.cbs) cb(tabId, { status: 'complete' })
      await tick()
    },
    navLoading: async (tabId: number) => {
      for (const cb of tabsUpdated.cbs) cb(tabId, { status: 'loading' })
      await tick()
    },
    closeTab: async (tabId: number) => {
      for (const cb of tabsRemoved.cbs) cb(tabId)
      await tick()
    },
    csMessage: async (msg: unknown, sender: { tab?: { id?: number; url?: string }; origin?: string }) => {
      const responses: unknown[] = []
      for (const cb of runtimeMessage.cbs) cb(msg, sender, r => responses.push(r))
      await tick()
      return responses
    },
  }
}

type Harness = ReturnType<typeof createChromeStub>

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function tick(): Promise<void> {
  // 自动应答是同步的，但 SW 处理链（storage await → emit → sha256 await）跨多个微任务
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

// —— 断言辅助 ——

function announces(h: Harness): AnnounceFrame[] {
  return h.sent.filter(m => (m as { type?: string }).type === 'announce') as AnnounceFrame[]
}

function chunksOf(h: Harness, transferId: string): ChunkFrame[] {
  return h.sent.filter(
    m => (m as { type?: string; transferId?: string }).type === 'chunk' && (m as { transferId?: string }).transferId === transferId,
  ) as ChunkFrame[]
}

/** 从 chunk 帧重组 payload 并 JSON 解析（小 payload = 单 chunk）。 */
function payloadOf(h: Harness, transferId: string): Record<string, unknown> {
  const frames = chunksOf(h, transferId).sort((a, b) => a.index - b.index)
  const bytes = Buffer.concat(frames.map(f => Buffer.from(f.dataB64, 'base64')))
  return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
}

function stateOf(h: Harness): { sessionId: string; tabs: Record<string, { pageInstanceId: string; grantedOrigin: string; nextSequence: number }> } {
  return h.sessionStore.get('sift-state-v1') as ReturnType<typeof stateOf>
}

const GRANTED_TAB = { id: 7, url: 'https://example.com/article?id=4' }
const GRANTED_SENDER = { tab: { id: 7, url: 'https://example.com/article?id=4' }, origin: 'https://example.com' }

async function grantTab(h: Harness, tab = GRANTED_TAB): Promise<void> {
  await h.clickAction(tab)
  await waitFor(() => announces(h).length >= 1, 'authorization_granted announce')
}

// —— 用例 ——

describe('service-worker 生命周期（mock chrome）', () => {
  let h: Harness

  beforeEach(async () => {
    vi.resetModules()
    h = createChromeStub()
    ;(globalThis as unknown as { chrome: unknown }).chrome = h.chromeStub
    await import('../src/service-worker')
  })

  it('action 点击 → granted + badge S + grant 入 storage.session', async () => {
    await grantTab(h)

    const frame = announces(h)[0]!
    expect(frame.envelope.type).toBe('authorization_granted')
    expect(frame.envelope.pageInstanceId).toMatch(/^p-/)
    expect(frame.envelope.url).toBe('https://example.com/article?id=4')
    const payload = payloadOf(h, frame.transferId)
    expect(payload).toMatchObject({ kind: 'authorization_granted', reason: 'user_gesture', origin: 'https://example.com' })

    expect(h.badges.get(7)).toBe('S')
    expect(stateOf(h).tabs['7']).toMatchObject({ grantedOrigin: 'https://example.com', nextSequence: 1 })
    expect(h.connectedNames).toEqual([NATIVE_HOST_NAME]) // 唯一网络出口
  })

  it('敏感 URL 点击被拒：无 grant、无事件、无 badge', async () => {
    await h.clickAction({ id: 9, url: 'chrome://settings' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(announces(h)).toHaveLength(0)
    expect(h.badges.get(9)).toBeUndefined()
    expect(stateOf(h)).toBeUndefined() // 连 state 都未建立
  })

  it('跨源导航（executeScript 拒绝）→ 即时撤权 cross_origin + badge 清 + grant 移出 storage', async () => {
    await grantTab(h)
    h.setExecuteScriptMode('fail')

    await h.navComplete(7)
    await waitFor(() => announces(h).some(f => f.envelope.type === 'authorization_revoked'), 'authorization_revoked')

    const revoked = announces(h).find(f => f.envelope.type === 'authorization_revoked')!
    expect(revoked.envelope.pageInstanceId).toMatch(/^p-/)
    const payload = payloadOf(h, revoked.transferId)
    expect(payload).toMatchObject({ kind: 'authorization_revoked', reason: 'cross_origin', url: 'https://example.com/' })
    expect(h.badges.get(7)).toBe('')
    expect(stateOf(h).tabs['7']).toBeUndefined()
    expect(h.executeScriptCalls).toEqual([{ tabId: 7 }, { tabId: 7 }]) // 授权注入 + 导航重注入尝试
  })

  it('同源导航（executeScript 成功）→ 重注入且不撤权', async () => {
    await grantTab(h)
    await h.navComplete(7)
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(announces(h).filter(f => f.envelope.type === 'authorization_revoked')).toHaveLength(0)
    expect(h.executeScriptCalls).toEqual([{ tabId: 7 }, { tabId: 7 }])
    expect(stateOf(h).tabs['7']).toMatchObject({ grantedOrigin: 'https://example.com' })
    expect(h.badges.get(7)).toBe('S')
  })

  it('status 非 complete 的 onUpdated 不触发任何动作', async () => {
    await grantTab(h)
    await h.navLoading(7)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.executeScriptCalls).toHaveLength(1) // 只有授权时的那次注入
    expect(announces(h)).toHaveLength(1)
  })

  it('未授权 tab 的 complete 导航：不注入、不产生事件', async () => {
    await grantTab(h)
    await h.navComplete(42)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.executeScriptCalls).toEqual([{ tabId: 7 }])
    expect(announces(h)).toHaveLength(1)
  })

  it('关 tab → tab_closed 撤权 + badge 清', async () => {
    await grantTab(h)
    await h.closeTab(7)
    await waitFor(() => announces(h).some(f => f.envelope.type === 'authorization_revoked'), 'authorization_revoked')

    const payload = payloadOf(h, announces(h).find(f => f.envelope.type === 'authorization_revoked')!.transferId)
    expect(payload).toMatchObject({ kind: 'authorization_revoked', reason: 'tab_closed' })
    expect(h.badges.get(7)).toBe('')
    expect(stateOf(h).tabs['7']).toBeUndefined()
  })

  it('异源重点 → 旧 grant 先撤再授（事件配对完整，新 pageInstanceId）', async () => {
    await grantTab(h)
    const first = announces(h)[0]!

    await h.clickAction({ id: 7, url: 'https://other.example/post' })
    await waitFor(() => announces(h).length >= 3, 'revoked + 再 granted')

    const types = announces(h).map(f => f.envelope.type)
    expect(types).toEqual(['authorization_granted', 'authorization_revoked', 'authorization_granted'])

    const revokedPayload = payloadOf(h, announces(h)[1]!.transferId)
    expect(revokedPayload).toMatchObject({ kind: 'authorization_revoked', reason: 'cross_origin', url: 'https://example.com/' })
    expect(announces(h)[1]!.envelope.pageInstanceId).toBe(first.envelope.pageInstanceId) // 旧实例闭合

    const second = announces(h)[2]!
    expect(second.envelope.pageInstanceId).not.toBe(first.envelope.pageInstanceId)
    expect(second.envelope.url).toBe('https://other.example/post')
    expect(stateOf(h).tabs['7']).toMatchObject({ grantedOrigin: 'https://other.example', nextSequence: 1 })
    expect(h.badges.get(7)).toBe('S')
  })

  it('CS capture_failed → 持久化；payload 只含 {kind,code,instanceNonce,contentEpoch}，无 detail', async () => {
    await grantTab(h)

    const responses = await h.csMessage(
      {
        sift: 1,
        kind: 'capture_failed',
        instanceNonce: 'n-abc',
        code: 'capture_too_little_content',
        contentEpoch: 2,
        detail: 'readable-v1 未在 5000ms 内满足',
      },
      GRANTED_SENDER,
    )
    expect(responses).toEqual([{ ok: true }])
    await waitFor(() => announces(h).some(f => f.envelope.type === 'capture_failed'), 'capture_failed announce')

    const frame = announces(h).find(f => f.envelope.type === 'capture_failed')!
    expect(frame.envelope.source).toBe('extension')
    expect(frame.envelope.contentEpoch).toBe(2)
    expect(frame.envelope.url).toBe('https://example.com/article?id=4')

    const bytes = Buffer.concat(chunksOf(h, frame.transferId).map(f => Buffer.from(f.dataB64, 'base64')))
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    expect(hash).toBe(frame.payloadHash) // announce 声明的 hash 与真实字节一致
    expect(JSON.parse(bytes.toString('utf8'))).toEqual({
      schemaVersion: 1,
      captureVersion: 'capture-v1',
      kind: 'capture_failed',
      code: 'capture_too_little_content',
      instanceNonce: 'n-abc',
      contentEpoch: 2,
    })
    expect(bytes.toString('utf8')).not.toContain('detail')
    expect(bytes.toString('utf8')).not.toContain('readable-v1')

    expect(stateOf(h).tabs['7']).toBeDefined() // 失败 ≠ 授权结束：grant 保留
  })

  it('未授权 tab 的 CS 消息被忽略（无事件）', async () => {
    await grantTab(h)
    await h.csMessage(
      { sift: 1, kind: 'capture_failed', instanceNonce: 'n-x', code: 'capture_denied', contentEpoch: 0 },
      { tab: { id: 99, url: 'https://stranger.example/' }, origin: 'https://stranger.example' },
    )
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(announces(h)).toHaveLength(1) // 只有 granted
  })

  it('跨源 CS 消息 → 撤权（纵深防御）且 badge 清', async () => {
    await grantTab(h)
    await h.csMessage(
      { sift: 1, kind: 'document_started', instanceNonce: 'n-2', contentEpoch: 0, url: 'https://evil.example/hook', title: 'x' },
      { tab: { id: 7, url: 'https://evil.example/hook' }, origin: 'https://evil.example' },
    )
    await waitFor(() => announces(h).some(f => f.envelope.type === 'authorization_revoked'), 'authorization_revoked')
    expect(h.badges.get(7)).toBe('')
    expect(stateOf(h).tabs['7']).toBeUndefined()
  })

  // —— commands 手势（manifest commands：Alt+Shift+S，权限数组零变更） ——

  it('grant command 手势 → 与 action 点击同一授权路径（granted + badge + state）', async () => {
    h.setActiveTab({ id: 7, url: 'https://example.com/article?id=4' })
    await h.pressCommand('sift-grant-current-tab')
    await waitFor(() => announces(h).length >= 1, 'authorization_granted announce')

    const frame = announces(h)[0]!
    expect(frame.envelope.type).toBe('authorization_granted')
    expect(frame.envelope.url).toBe('https://example.com/article?id=4')
    const payload = payloadOf(h, frame.transferId)
    expect(payload).toMatchObject({ kind: 'authorization_granted', reason: 'user_gesture', origin: 'https://example.com' })
    expect(h.badges.get(7)).toBe('S')
    expect(stateOf(h).tabs['7']).toMatchObject({ grantedOrigin: 'https://example.com' })
    expect(h.connectedNames).toEqual([NATIVE_HOST_NAME])
  })

  it('command 时活动 tab 无 URL（devtools 窗口等）→ 失败关闭：无事件、无 grant', async () => {
    h.setActiveTab({ id: 8 }) // url: undefined
    await h.pressCommand('sift-grant-current-tab')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(announces(h)).toHaveLength(0)
    expect(stateOf(h)).toBeUndefined()
  })

  it('command 时活动 tab 为敏感 URL → 拒绝授权（与点击同一判定器）', async () => {
    h.setActiveTab({ id: 9, url: 'chrome://settings' })
    await h.pressCommand('sift-grant-current-tab')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(announces(h)).toHaveLength(0)
    expect(h.badges.get(9)).toBeUndefined()
  })

  it('未知 command 名 → 完全忽略', async () => {
    h.setActiveTab({ id: 7, url: 'https://example.com/article?id=4' })
    await h.pressCommand('some-other-command')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(announces(h)).toHaveLength(0)
    expect(h.executeScriptCalls).toHaveLength(0)
  })
})
