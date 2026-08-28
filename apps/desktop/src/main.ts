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
// Phase 3：UI 从 spike 骨架窗升级为问答面板（P0_DEMO_SCOPE §5）。主进程 = IPC
// 薄壳，全部逻辑在 qa-service（Electron 无关，qa-cli 同源消费）：
//   - 渲染层零直接 fs/store 访问（sandbox:true、contextIsolation:true、
//     nodeIntegration:false；唯一桥是 preload 暴露的类型化 invoke 包装）；
//   - overview 5s 轮询 + 窗口 focus 刷新（readOnly store 开-读-关，与 host 写者共存）；
//   - 确认屏在渲染层（预览即 buildProjection 的本地结果）；主进程只在她显式
//     invoke askModel 后才触碰网络（验收门 9：确认前模型调用次数为零）。
import { app, BrowserWindow, ipcMain } from 'electron'
import { detectNativeHostLaunch } from '@sift/host/mode'
import {
  askModel,
  buildProjectionForScope,
  deletePageStoreData,
  deleteAllStoreData,
  deleteSessionStoreData,
  getStoreOverview,
  listAnswers,
  parseScope,
  pruneExpiredAnswerFiles,
  resolveStoreRoot,
} from './qa-service'
import { loadModelConfig, modelConfigSummary } from '@sift/model'
import type { QuestionProjection } from '@sift/shared'

const isHost = detectNativeHostLaunch(process.argv.slice(1), {
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
})

if (isHost) {
  process.stderr.write('[sift] native host launch args reached UI exe: rejected (see ADR-002; manifest must point to SiftHost.cmd)\n')
  process.exit(1)
} else {
  // UI 模式。electron 用静态 ESM import（Electron 33 对 ESM main 的标准形态；
  // spike 期的动态 import 会踩 cjsPreparseModuleExports 的坑）。host 分支永不
  // 到达此文件——manifest 指向 SiftHost.cmd → host-main.js。
  void (async () => {
    try {
      const gotLock = app.requestSingleInstanceLock()
      if (!gotLock) {
        // 已有 UI 实例在运行；本实例直接退出（这不影响 host 模式——host 从不走此分支）。
        process.stderr.write('[sift] UI mode: another instance holds the lock; quitting\n')
        app.quit()
        return
      }
      await app.whenReady()
      const { join } = await import('node:path')
      const win = new BrowserWindow({
        width: 560,
        height: 720,
        title: 'Sift AI (demo)',
        useContentSize: true,
        show: true,
        webPreferences: {
          preload: join(app.getAppPath(), 'dist', 'ui', 'preload.cjs'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      win.on('closed', () => app.quit())

      // —— IPC 薄壳：结果一律 {ok,value}|{ok,message}，渲染层不因异常断线 ——
      // 注册必须在 loadFile 之前：渲染层脚本一加载就会 invoke overview。

      const rootDir = resolveStoreRoot()
      await pruneExpiredAnswerFiles(rootDir)
      const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value })
      const fail = (error: unknown): { readonly ok: false; readonly message: string } => ({
        ok: false,
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })

      ipcMain.handle('sift:overview', () =>
        getStoreOverview(rootDir).then(ok, fail))
      ipcMain.handle('sift:build-projection', async (_e, raw: unknown) => {
        try {
          const { scopeRaw, question } = raw as { scopeRaw: string; question: string }
          const overview = await getStoreOverview(rootDir) // scope 解析需要 latest-session
          const latest = overview.sessions.length > 0 ? overview.sessions[overview.sessions.length - 1]!.sessionId : undefined
          const scope = parseScope(scopeRaw, latest)
          if ('error' in scope) return ok({ status: 'scope_parse_error' as const, message: scope.error })
          return ok(await buildProjectionForScope(rootDir, scope, question, modelContextWindowOf()))
        } catch (error) {
          return fail(error)
        }
      })
      ipcMain.handle('sift:ask-model', async (_e, raw: unknown) => {
        try {
          const { projection } = raw as { projection: QuestionProjection }
          const config = loadModelConfig(process.env)
          if (config.status !== 'ok') {
            return ok({
              status: 'model_unconfigured' as const,
              missing: config.status === 'model_config_missing' ? config.missing : [],
              reason: config.status === 'model_origin_rejected' ? config.reason : '',
            })
          }
          const result = await askModel(rootDir, projection, config.config)
          if (result.status === 'failed') {
            return ok({ status: 'failed' as const, code: result.result.code, message: result.result.message })
          }
          return ok({ status: 'ok' as const, answer: result.answer, answerPath: result.answerPath })
        } catch (error) {
          return fail(error)
        }
      })
      ipcMain.handle('sift:list-answers', () => listAnswers(rootDir).then(ok, fail))
      ipcMain.handle('sift:delete-session', (_e, raw: unknown) =>
        deleteSessionStoreData(rootDir, (raw as { sessionId: string }).sessionId).then(ok, fail))
      ipcMain.handle('sift:delete-page', (_e, raw: unknown) =>
        deletePageStoreData(rootDir, (raw as { pageInstanceId: string }).pageInstanceId).then(ok, fail))
      ipcMain.handle('sift:delete-all', () => deleteAllStoreData(rootDir).then(() => ok(undefined), fail))
      ipcMain.handle('sift:model-config', () => Promise.resolve(ok(modelConfigSummary(loadModelConfig(process.env)))))

      await win.loadFile(join(app.getAppPath(), 'dist', 'ui', 'index.html'))
      process.stderr.write('[sift] UI mode ready\n')

      // —— 概览刷新：5s 轮询 + focus 即刻刷新 ——

      let overviewTimer: NodeJS.Timeout | undefined
      const pushOverviewTick = (): void => {
        if (!win.isDestroyed()) win.webContents.send('sift:overview-updated')
      }
      const startPolling = (): void => {
        overviewTimer = setInterval(pushOverviewTick, 5000)
        overviewTimer.unref()
      }
      win.on('focus', pushOverviewTick)
      startPolling()

      app.on('second-instance', () => {
        if (!win.isDestroyed()) {
          if (win.isMinimized()) win.restore()
          win.focus()
        }
      })
    } catch (error) {
      process.stderr.write(`[sift] UI mode failed: ${String(error)}\n${error instanceof Error ? (error.stack ?? '') : ''}\n`)
      process.exitCode = 1
    }
  })()
}

/** 投影限额用的模型 token 窗口：未配置时退回一个保守演示值（不阻塞预览）。 */
function modelContextWindowOf(): number {
  const config = loadModelConfig(process.env)
  return config.status === 'ok' ? config.config.contextWindow : 32_768
}
