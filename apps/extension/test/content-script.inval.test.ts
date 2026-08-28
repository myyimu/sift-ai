// content-script.inval.test.ts —— CS 上下文失效优雅停机（2026-08-28 修复回归）。
//
// 场景：扩展被重载/更新后，旧 CS 残留在已打开页面上，runtime 上下文失效，
// 每次 chrome.runtime.sendMessage 抛 "Extension context invalidated"——修复前
// 向页面控制台反复裸抛（linux.do 实测 8 连抛）；修复后必须：
//   1) observer 断开、gate 取消（观察立即停止——spec：扩展侧失效即停止捕获）；
//   2) 幂等哨兵释放（否则重载后重新授权注入的新 CS 被旧哨兵挡住，观察静默死亡）；
//   3) 打一条诊断 info，不再裸抛。
//
// 手法说明：与 content-script.inject.test.ts 同理，注入行为每文件单用例
// （vitest 同文件多用例的模块重复求值存在状态污染，2026-08-28 实测）。
import { expect, it, vi, afterEach } from 'vitest'
import { parseHTML } from 'linkedom'

function setupInvalidatedPage(): {
  observers: { disconnectCalls: number }
  window: Window & { __siftCsActive?: boolean }
} {
  const { window } = parseHTML(
    `<html><body><main><p>${'x'.repeat(120)}</p></main></body></html>`,
  )
  const observers = { disconnectCalls: 0 }
  class MutationObserverStub {
    observe(): void {}
    disconnect(): void {
      observers.disconnectCalls += 1
    }
  }
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('location', { href: 'https://example.com/article' })
  vi.stubGlobal('MutationObserver', MutationObserverStub)
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: () => {
        throw new Error('Extension context invalidated.')
      },
    },
  })
  return { observers, window }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('context invalidated → 停机：observer 断开、哨兵释放、诊断信息不裸抛', async () => {
  const page = setupInvalidatedPage()
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  await import('../src/content-script')

  expect(page.window.__siftCsActive).toBe(false) // 哨兵必须释放（新 CS 才能接管）
  expect(page.observers.disconnectCalls).toBe(1) // observer 已断开
  expect(info).toHaveBeenCalledWith(expect.stringContaining('扩展上下文已失效'))
})
