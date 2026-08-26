// 手动单次 round-trip 诊断（临时工具，spike 排障用）。
// 用法：node tools/spike/manual-roundtrip.mjs [--ui]  (--ui 先起一个 UI 实例再测 host)
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const exe = resolve('apps/desktop/pack2/win-unpacked/SiftHost.cmd')
const origin = 'chrome-extension://jhkdmlohebjffokfonhiijhhmocfcppo/'
const withUi = process.argv.includes('--ui')

// IDE 集成终端会带 ELECTRON_RUN_AS_NODE=1，Sift.exe 子进程继承后会进 node 模式。
const { ELECTRON_RUN_AS_NODE: _ignored, ...CLEAN_ENV } = process.env
// .cmd 需经 cmd.exe /c（模拟 Chrome CreateProcess 行为）。
const spawnClean = (args, options) =>
  /\.(cmd|bat)$/i.test(exe)
    ? spawn('cmd.exe', ['/c', exe, ...args], { ...options, env: CLEAN_ENV })
    : spawn(exe, args, { ...options, env: CLEAN_ENV })

function log(tag, d) { console.log(tag, String(d).trim()) }

function startUi() {
  return new Promise((res, rej) => {
    const child = spawnClean([], { stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => rej(new Error('UI not ready in 12s')), 12000)
    child.stderr.on('data', (c) => {
      log('[ui]', c)
      if (String(c).includes('UI mode ready')) { clearTimeout(timer); res(child) }
    })
    child.on('error', (e) => { clearTimeout(timer); rej(e) })
  })
}

function hostRoundtrip() {
  return new Promise((res) => {
    const child = spawnClean([origin, '--parent-window=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
    console.log('spawned host pid', child.pid)

    let buf = Buffer.alloc(0)
    child.stdout.on('data', (d) => {
      console.log('stdout bytes:', d.length, 'hex:', d.toString('hex'))
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (buf.length < 4) break
        const len = buf.readUInt32LE(0)
        if (buf.length < 4 + len) break
        console.log('  frame payload:', buf.subarray(4, 4 + len).toString('utf8'))
        buf = buf.subarray(4 + len)
      }
    })
    child.stderr.on('data', (d) => log('[host]', d))
    child.on('error', (e) => console.log('error:', e.message))
    child.on('exit', (c, s) => { console.log('exit:', c, s); res() })

    const payload = Buffer.from(JSON.stringify({ type: 'ping', id: 1, nonce: 'n1' }), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(payload.length)
    child.stdin.write(Buffer.concat([header, payload]))
    setTimeout(() => { console.log('--- 3s elapsed, ending stdin'); child.stdin.end() }, 3000)
    setTimeout(() => { console.log('--- 8s elapsed, kill'); child.kill(); }, 8000)
    setTimeout(() => { console.log('--- 12s elapsed, done'); process.exit(0) }, 12000)
  })
}

let ui
if (withUi) {
  ui = await startUi()
  console.log('UI ready, now testing host round-trip...\n')
}
await hostRoundtrip()
if (ui) ui.kill()
process.exit(0)
