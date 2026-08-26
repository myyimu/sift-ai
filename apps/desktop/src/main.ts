// Sift 桌面端主入口（ADR-001 E-03 实测后修正：本 exe 只承担 UI 模式）。
//
// E-03 spike 实测（Windows，Electron 33，证据见 ADR-002 草案）：
//  1. 打包 exe 的 GUI（Chromium）引导在 main.js 之前无条件向 stdout 写 2 字节
//     垃圾（0d 0a，t≈30ms 到达，main.js 约 600ms 才执行；env/参数均无法抑制）——
//     Chrome native messaging 的帧解析器会把它当长度前缀，双模式单 exe 不可行。
//  2. Node 层 stdio 同样不可用：process.stdout 被 Chromium 接管为行缓冲文本流
//     （\n→\r\n 翻译、无换行的二进制帧出不去），process.stdin 的 data 事件从不
//     触发；fs.createReadStream/WriteStream({fd:0/1}) 也不通。
//  3. 同一 exe 在 ELECTRON_RUN_AS_NODE=1 下加载纯 Node 入口（host-main.js，
//     extraResources 单文件）stdio 完全干净、帧格式正确——替代架构为
//     SiftHost.cmd 包装器：设置该变量后拉起本 exe + host-main.js。
//
// 因此：native-host 形态的启动参数到达本入口时，失败关闭（此路径永远不该被
// 使用；manifest 指向 SiftHost.cmd）。UI 模式申请单实例锁，被占用则退出。
//
// UI stdout/stderr 无协议约束；host stdout 只允许长度前缀帧（host-main 的
// runNativeHostLoop 是唯一出口），诊断一律走 stderr。
import { detectNativeHostLaunch } from '@sift/host/mode'

const isHost = detectNativeHostLaunch(process.argv.slice(1), {
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
})

if (isHost) {
  process.stderr.write('[sift] native host launch args reached UI exe: rejected (see ADR-002; manifest must point to SiftHost.cmd)\n')
  process.exit(1)
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
