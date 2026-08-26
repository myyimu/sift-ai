// 诊断：定位 stdout 上的 0d 0a 污染字节是谁写的（父进程 Chromium 启动 vs node 子进程启动）。
// 实验 1：UI 模式（无参数）spawn，stdout 管道捕获。
// 实验 2：RUN_AS_NODE 直连（不经父进程中继，直接以 node 模式跑 host-main.js）。
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const exe = resolve('apps/desktop/pack2/win-unpacked/Sift.exe')
const hostEntry = resolve('apps/desktop/pack2/win-unpacked/resources/host-main.js')
const { ELECTRON_RUN_AS_NODE: _ignored, ...CLEAN_ENV } = process.env
const spawnClean = (args, options) => spawn(exe, args, { ...options, env: { ...CLEAN_ENV, ...options?.env } })

function watch(name, child) {
  child.stdout.on('data', (d) => console.log(`[${name}] stdout ${d.length}B hex=${d.toString('hex')}`))
  child.stderr.on('data', (d) => console.log(`[${name}] stderr: ${String(d).trim()}`))
  child.on('exit', (c) => console.log(`[${name}] exit ${c}`))
  return child
}

// 实验 1：UI 模式（会开窗口，3s 后杀）
console.log('--- 实验 1: UI 模式 stdout 是否出现 CRLF ---')
const ui = watch('ui', spawnClean([], { stdio: ['ignore', 'pipe', 'pipe'] }))

// 实验 2：node 模式直连 host-main.js（等 UI 实验先跑 1.5s，避免输出混流）
setTimeout(() => {
  console.log('--- 实验 2: RUN_AS_NODE 直连 stdout 是否出现 CRLF ---')
  const node = watch('node', spawnClean([hostEntry], {
    env: { ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }))
  // 发一个 ping，看帧前有没有 CRLF
  const payload = Buffer.from(JSON.stringify({ type: 'ping', id: 1, nonce: 'p' }), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length)
  node.stdin.write(Buffer.concat([header, payload]))
  setTimeout(() => node.stdin.end(), 1500)
  setTimeout(() => { if (!node.killed) node.kill() }, 6000)
}, 1500)

setTimeout(() => { ui.kill() }, 3500)
setTimeout(() => process.exit(0), 9000)
