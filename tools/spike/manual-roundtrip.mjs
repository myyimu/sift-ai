// 手动单次 round-trip 诊断（临时工具，spike 排障用）。
import { spawn } from 'node:child_process'

const exe = 'apps/desktop/pack/win-unpacked/Sift.exe'
const origin = 'chrome-extension://jhkdmlohebjffokfonhiijhhmocfcppo/'

const child = spawn(exe, [origin, '--parent-window=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
console.log('spawned pid', child.pid)

let buf = Buffer.alloc(0)
child.stdout.on('data', (d) => {
  console.log('stdout bytes:', d.length, JSON.stringify(d.subarray(0, 64).toString('latin1')))
  buf = Buffer.concat([buf, d])
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0)
    console.log('  frame len:', len)
    if (buf.length < 4 + len) break
    console.log('  frame payload:', buf.subarray(4, 4 + len).toString('utf8'))
    buf = buf.subarray(4 + len)
  }
})
child.stderr.on('data', (d) => console.log('stderr:', String(d).trim()))
child.on('error', (e) => console.log('error:', e.message))
child.on('exit', (c, s) => console.log('exit:', c, s))

const payload = Buffer.from(JSON.stringify({ type: 'ping', id: 1, nonce: 'n1' }), 'utf8')
const header = Buffer.alloc(4)
header.writeUInt32LE(payload.length)
child.stdin.write(Buffer.concat([header, payload]))
setTimeout(() => { console.log('--- 3s elapsed, ending stdin'); child.stdin.end() }, 3000)
setTimeout(() => { console.log('--- 8s elapsed, done'); process.exit(0) }, 8000)
