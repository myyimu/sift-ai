// Sift 桌面端主入口 —— 双模式（ADR-001 E-03）。
//
//  1. 先做三条件联合判定（allowed origin 严格相等 + --parent-window=<非负十进制> +
//     stdio 均为管道）。host 模式分支在 Electron 动态 import 之前执行——host 进程
//     从不 requestSingleInstanceLock，也不加载 UI（UI 已运行时的 host 实例必须照常工作，
//     即“不因单实例锁冲突回退/失效”）。
//  2. UI 模式才 import('electron')：申请单实例锁，锁被占用（已有 UI 实例）则直接退出；
//     打开最小 demo 窗口（正式窗口/托盘面板在 ADR-001 步骤 3/4 实现）。
//
// host stdout 只允许长度前缀帧（runNativeHostLoop 是唯一出口）；诊断一律走 stderr。
import { detectNativeHostLaunch } from '@sift/host/mode'
import { runNativeHostLoop } from '@sift/host/host-loop'
import { spikePongHandler } from '@sift/host/protocol'

const isHost = detectNativeHostLaunch(process.argv.slice(1), {
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
})

if (isHost) {
  process.stderr.write('[sift] native host mode: spike ping/pong loop (ADR-001 E-03)\n')
  runNativeHostLoop({
    stdin: process.stdin,
    stdout: process.stdout,
    onMessage: spikePongHandler,
    onFatal: (error) => {
      process.stderr.write(`[sift] host loop fatal: ${String(error)}\n`)
      process.exitCode = 1
    },
    onClosed: () => {
      // Chrome 断开（stdin end/close）：正常退出。
      process.stderr.write('[sift] host loop closed\n')
    },
  })
} else {
  // UI 模式。动态 import：host 分支完全不触碰 Electron 运行时。
  void (async () => {
    try {
      const { app, BrowserWindow } = await import('electron')
      const gotLock = app.requestSingleInstanceLock()
      if (!gotLock) {
        // 已有 UI 实例在运行；本实例直接退出（这不影响 host 模式——host 从不走此分支）。
        process.stderr.write('[sift] UI mode: another instance holds the lock; quitting\n')
        app.quit()
        return
      }
      await app.whenReady()
      const win = new BrowserWindow({
        width: 480,
        height: 320,
        title: 'Sift AI (demo spike)',
        useContentSize: true,
        show: true,
      })
      win.on('closed', () => app.quit())
      // 骨架窗口：仅证明 UI 进程可运行；正式面板在步骤 3/4。
      await win.loadURL('data:text/html,<title>Sift AI</title><h3>Sift demo spike</h3>')
      process.stderr.write('[sift] UI mode ready\n')
    } catch (error) {
      process.stderr.write(`[sift] UI mode failed: ${String(error)}\n`)
      process.exitCode = 1
    }
  })()
}
