// content-script.inject.test.ts —— CS 正常注入路径（linkedom + stub chrome）。
//
// 手法说明：CS 模块顶层立即执行注入逻辑，vitest 对**同一文件内多个用例**的
// 重复求值存在跨用例状态污染（实测 2026-08-28：后续用例会读到已置位的哨兵、
// query import 也绕不开）——因此注入行为按用例拆成独立文件（vitest 文件级
// 模块注册表隔离）：本文件只测正常路径；失效停机见 content-script.inval.test.ts。
import { expect, it, vi, afterEach } from 'vitest'
import { parseHTML } from 'linkedom'

function setupPage(): { sent: unknown[]; window: Window & { __siftCsActive?: boolean } } {
  const { window } = parseHTML(
    `<html><body><main><p>${'x'.repeat(120)}</p></main></body></html>`,
  )
  const sent: unknown[] = []
  class MutationObserverStub {
    observe(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('location', { href: 'https://example.com/article' })
  vi.stubGlobal('MutationObserver', MutationObserverStub)
  vi.stubGlobal('chrome', { runtime: { sendMessage: (message: unknown) => { sent.push(message) } } })
  return { sent, window }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('正常路径：哨兵置位，document_started 上报 SW，观察存活', async () => {
  const page = setupPage()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  await import('../src/content-script')

  expect(page.window.__siftCsActive).toBe(true)
  const started = page.sent.find(m => (m as { kind?: string }).kind === 'document_started')
  expect(started).toMatchObject({ sift: 1, url: 'https://example.com/article' })
  // 正文 ≥ readable 门槛：initial_readable 快照也应上报
  const snapshot = page.sent.find(m => (m as { kind?: string }).kind === 'dom_snapshot')
  expect(snapshot).toBeDefined()
})
