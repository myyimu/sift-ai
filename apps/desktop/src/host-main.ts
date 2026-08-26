// Sift host 模式真实入口（纯 Node 环境，E-03 替代架构：见 main.ts 注释与 ADR-002 草案）。
//
// 由 SiftHost.cmd 以 ELECTRON_RUN_AS_NODE=1 拉起同一 Sift.exe 加载本文件：
// 进程是普通 Node，process.stdin/stdout 即 Chrome 管道（二进制安全，E-03 实测干净）。
//
// 由于不再经过 main.ts 的双模式判定，这里必须自行做三条件联合校验
// （allowed origin 严格相等 + --parent-window + stdio 均为管道）——失败即退出，
// 绝不进入消息循环（失败关闭）。
//
// 以 extraResources 单文件（esbuild bundle，无外部依赖）发布在 asar 之外。
import { detectNativeHostLaunch } from '@sift/host/mode'
import { runNativeHostLoop } from '@sift/host/host-loop'
import { spikePongHandler } from '@sift/host/protocol'

// node 模式下 argv = [exe, host-main.js, origin, --parent-window=N]
const launchOk = detectNativeHostLaunch(process.argv.slice(2), {
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
})

if (!launchOk) {
  process.stderr.write('[sift] host-main: launch arguments/stdio rejected (fail closed)\n')
  process.exit(1)
}

process.stderr.write('[sift] host-main: node-mode spike ping/pong loop (ADR-001 E-03)\n')

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
    process.exitCode = 0
  },
})
