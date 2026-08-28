// Sift host 模式真实入口（纯 Node 环境，E-03 替代架构：见 main.ts 注释与 ADR-002 草案）。
//
// 由 SiftHost.cmd 以 ELECTRON_RUN_AS_NODE=1 拉起同一 Sift.exe 加载本文件：
// 进程是普通 Node，process.stdin/stdout 即 Chrome 管道（二进制安全，E-03 实测干净）。
//
// 由于不再经过 main.ts 的双模式判定，这里必须自行做三条件联合校验
// （allowed origin 严格相等 + --parent-window + stdio 均为管道）——失败即退出，
// 绝不进入消息循环（失败关闭）。
//
// Phase 2（ADR-001 §9 步骤 3）：消息循环接 capture 协议（announce/chunk/commit +
// journal 幂等落盘，ADR-003 FS store）。E-03 spike 的 ping/pong 由协议处理器内部
// 兼容保留（真实 Chrome E2E harness 依赖）。store 打开失败 = store_corrupt/权限
// 问题 → 失败关闭退出，不进入半可用状态。
//
// 以 extraResources 单文件（esbuild bundle，无外部依赖）发布在 asar 之外。
import { detectNativeHostLaunch } from '@sift/host/mode'
import { runNativeHostLoop } from '@sift/host/host-loop'
import { createCaptureProtocolHandler } from '@sift/host/capture-protocol'
import { defaultStoreRoot, openSiftStore, pruneExpiredData, type SiftFsStore } from '@sift/store'
import { mkdir } from 'node:fs/promises'

// node 模式下 argv = [exe, host-main.js, origin, --parent-window=N]
const launchOk = detectNativeHostLaunch(process.argv.slice(2), {
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
})

if (!launchOk) {
  process.stderr.write('[sift] host-main: launch arguments/stdio rejected (fail closed)\n')
  process.exit(1)
}

const rootDir = defaultStoreRoot()
let store: SiftFsStore | null = null
try {
  // Host 是唯一捕获写者；在取得 journal 句柄前回收过期捕获，避免与自身并发。
  await mkdir(rootDir, { recursive: true })
  await pruneExpiredData(rootDir)
  store = await openSiftStore({
    rootDir,
    onRecover: (message) => process.stderr.write(`[sift] store recover: ${message}\n`),
  })
} catch (error) {
  process.stderr.write(`[sift] host-main: store open failed (fail closed): ${String(error)}\n`)
  process.exit(1)
}
if (store === null) process.exit(1)

process.stderr.write(`[sift] host-main: capture protocol v1 loop, store at ${rootDir}\n`)

const capture = createCaptureProtocolHandler({ store })

runNativeHostLoop({
  stdin: process.stdin,
  stdout: process.stdout,
  onMessage: capture.onMessage,
  onFatal: (error) => {
    process.stderr.write(`[sift] host loop fatal: ${String(error)}\n`)
    process.exitCode = 1
    void store?.close()
  },
  onClosed: () => {
    // Chrome 断开（stdin end/close）：正常退出。
    process.stderr.write('[sift] host loop closed\n')
    process.exitCode = 0
    void store?.close()
  },
})
