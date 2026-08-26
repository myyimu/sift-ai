// 诊断 2：CRLF 污染的时机与可抑制性。
//  A. 时机：GUI 模式 spawn，记录 CRLF 到达时刻 vs Electron 引导延迟
//     （用 stdout 只有 CRLF、无其他输出的样本测量）。
//  B. 抑制：各种 env/参数变体下 GUI 模式是否仍写 CRLF。
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const exe = resolve('apps/desktop/pack2/win-unpacked/Sift.exe')
const { ELECTRON_RUN_AS_NODE: _ignored, ...CLEAN_ENV } = process.env

function probe(name, { args = [], env = {} }, ms = 4000) {
  return new Promise((res) => {
    const t0 = Date.now()
    const child = spawn(exe, args, { env: { ...CLEAN_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    child.stdout.on('data', (d) => out.push({ t: Date.now() - t0, hex: d.toString('hex') }))
    child.stderr.on('data', (d) => {
      const s = String(d).trim()
      if (s.includes('UI mode')) out.push({ t: Date.now() - t0, stderrReady: true })
    })
    child.on('exit', (c) => { console.log(`[${name}] exit=${c} stdout=${JSON.stringify(out)}`); res() })
    setTimeout(() => { child.kill(); setTimeout(res, 500) }, ms)
  })
}

// A. 基线：无参数 GUI 模式（会开窗口，4s 后杀）
await probe('baseline', {}, 4000)

// B. 抑制变体
await probe('log-to-stderr', { args: ['--enable-logging=stderr'] }, 4000)
await probe('no-sandbox', { args: ['--no-sandbox'] }, 4000)
await probe('env-no-attach-console', { env: { ELECTRON_NO_ATTACH_CONSOLE: '1' } }, 4000)
await probe('env-enable-logging-off', { env: { ELECTRON_ENABLE_LOGGING: 'false' } }, 4000)

process.exit(0)
