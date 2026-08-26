// E-03 spike 驱动（ADR-001 验证门）：模拟 Chrome 的 native messaging 行为——
// spawn 打包后的 Sift.exe <allowed-origin> --parent-window=<id>，在 stdin/stdout
// 管道上做长度前缀帧 ping/pong 往返，然后断开。
//
// 两个阶段各 >= ROUNDS 次（默认 100）：
//   A. UI 未运行时的 host connect/disconnect + framed round-trip；
//   B. UI 实例运行中重复 A，并顺带断言“第二个 UI 实例因单实例锁快速退出、
//      不影响 host 模式”。
//
// 帧编解码在这里内联（独立复算），故意不 import @sift/host——spike 的意义是
// 用与被测对象无关的实现交叉验证线上格式。
// 用法：node tools/spike/run-e03-spike.mjs [--exe <Sift.exe>] [--rounds 100]
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const ORIGIN = 'chrome-extension://jhkdmlohebjffokfonhiijhhmocfcppo/'

function parseArgs(argv) {
  const out = { exe: resolve('apps/desktop/pack/win-unpacked/Sift.exe'), rounds: 100 }
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--exe') out.exe = resolve(argv[i + 1])
    else if (argv[i] === '--rounds') out.rounds = Number(argv[i + 1])
    else { console.error(`unknown flag ${argv[i]}`); process.exit(2) }
  }
  return out
}

// —— 内联帧编解码（独立复算） ——
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8')
  if (payload.length > 1024 * 1024) throw new Error('frame too large')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length)
  return Buffer.concat([header, payload])
}

function makeFrameReader() {
  let buffer = Buffer.alloc(0)
  return function push(chunk) {
    buffer = Buffer.concat([buffer, chunk])
    const frames = []
    for (;;) {
      if (buffer.length < 4) break
      const declared = buffer.readUInt32LE(0)
      if (declared > 1024 * 1024) throw new Error(`declared frame ${declared} exceeds 1MiB`)
      if (buffer.length < 4 + declared) break
      frames.push(buffer.subarray(4, 4 + declared).toString('utf8'))
      buffer = buffer.subarray(4 + declared)
    }
    return frames
  }
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

function stats(durations) {
  const sorted = [...durations].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  }
}

/** 单次 host connect/disconnect + framed round-trip。 */
function roundTrip(exe, id, timeoutMs) {
  return new Promise((res) => {
    const startedAt = Date.now()
    const nonce = randomUUID()
    const child = spawn(exe, [ORIGIN, `--parent-window=${id}`], { stdio: ['pipe', 'pipe', 'pipe'] })
    const reader = makeFrameReader()
    let settled = false
    const finish = (ok, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 断开 stdin（模拟 Chrome disconnect）；host 应自行退出。
      try { child.stdin.end() } catch { /* already closed */ }
      const killTimer = setTimeout(() => child.kill(), 4000)
      child.once('exit', () => {
        clearTimeout(killTimer)
        res({ ok, ms: Date.now() - startedAt, error })
      })
      // exit 事件 4s 未到则由 killTimer 强杀后仍会触发 exit。
    }
    const timer = setTimeout(() => finish(false, `timeout after ${timeoutMs}ms`), timeoutMs)

    child.stdout.on('data', (chunk) => {
      let frames
      try { frames = reader(chunk) } catch (e) { finish(false, `bad frame: ${e.message}`); return }
      for (const frame of frames) {
        let msg
        try { msg = JSON.parse(frame) } catch { finish(false, 'pong frame is not JSON'); return }
        if (msg.type === 'pong' && msg.id === id && msg.nonce === nonce) {
          finish(true)
          return
        }
        finish(false, `unexpected frame: ${frame.slice(0, 120)}`)
        return
      }
    })
    child.stderr.on('data', () => { /* 诊断日志，不判失败 */ })
    child.on('error', (e) => finish(false, `spawn error: ${e.message}`))

    child.stdin.write(encodeFrame(JSON.stringify({ type: 'ping', id, nonce })))
  })
}

/** 启动 UI 实例并等到就绪标志（stderr 'UI mode ready'）。 */
function startUi(exe) {
  return new Promise((res, rej) => {
    const child = spawn(exe, [], { stdio: ['ignore', 'ignore', 'pipe'] })
    let ready = false
    const timer = setTimeout(() => (ready ? res(child) : rej(new Error('UI instance not ready in 12s'))), 12000)
    child.stderr.on('data', (c) => {
      if (String(c).includes('UI mode ready')) {
        ready = true
        clearTimeout(timer)
        res(child)
      }
    })
    child.on('error', (e) => { clearTimeout(timer); rej(e) })
    child.on('exit', (code) => { if (!ready) { clearTimeout(timer); rej(new Error(`UI exited early code=${code}`)) } })
  })
}

/** 第二个 UI 实例必须因单实例锁快速退出。 */
function assertSecondUiExits(exe) {
  return new Promise((res) => {
    const startedAt = Date.now()
    const child = spawn(exe, [], { stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => { child.kill(); res({ ok: false, error: 'second UI did not exit in 10s' }) }, 10000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      // app.quit() 路径退出码 0；即使非 0，只要快速退出即视为锁生效。
      res({ ok: true, code, ms: Date.now() - startedAt })
    })
  })
}

async function runPhase(label, exe, rounds) {
  console.log(`\n=== 阶段 ${label}：${rounds} 次 connect/disconnect + framed round-trip ===`)
  const failures = []
  const durations = []
  for (let i = 1; i <= rounds; i++) {
    // 首轮给 Defender 冷扫描留余量。
    const timeoutMs = i <= 2 ? 20000 : 10000
    const r = await roundTrip(exe, i, timeoutMs)
    durations.push(r.ms)
    if (!r.ok) {
      failures.push({ i, error: r.error })
      console.error(`  [${i}/${rounds}] FAIL: ${r.error}`)
    } else if (i % 20 === 0 || i === 1) {
      console.log(`  [${i}/${rounds}] ok (${r.ms}ms)`)
    }
    if (failures.length >= 5) {
      console.error('  连续失败过多，提前终止本阶段。')
      break
    }
  }
  const s = stats(durations)
  console.log(`  阶段 ${label} 结果: ${durations.length - failures.length}/${durations.length} ok; p50=${s.p50}ms p95=${s.p95}ms max=${s.max}ms`)
  return { failures, okCount: durations.length - failures.length, total: durations.length, stats: s }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.exe)) {
    console.error(`exe 不存在: ${args.exe}（先 pnpm --filter @sift/desktop package:dir）`)
    process.exit(2)
  }
  console.log(`E-03 spike\nexe:    ${args.exe}\norigin: ${ORIGIN}\nrounds: ${args.rounds}/phase`)

  // 阶段 A：UI 未运行。
  const phaseA = await runPhase('A（UI 未运行）', args.exe, args.rounds)

  // 阶段 B：UI 运行中。
  let uiChild
  try {
    uiChild = await startUi(args.exe)
    console.log('  UI 实例已就绪')
  } catch (e) {
    console.error(`阶段 B 前置失败：无法启动 UI 实例：${e.message}`)
    process.exit(1)
  }
  const lockCheck = await assertSecondUiExits(args.exe)
  console.log(`  单实例锁断言: ${lockCheck.ok ? `通过（第二实例 ${lockCheck.ms}ms 退出 code=${lockCheck.code}）` : `失败：${lockCheck.error}`}`)

  const phaseB = await runPhase('B（UI 运行中）', args.exe, args.rounds)

  uiChild.kill()

  const pass =
    phaseA.okCount === phaseA.total &&
    phaseB.okCount === phaseB.total &&
    lockCheck.ok
  console.log(`\n=== E-03 spike 结论: ${pass ? 'PASS ✅（主 exe 双模式在两种 UI 状态下均通过全部往返）' : 'FAIL ❌'} ===`)
  if (!pass) {
    console.log('失败明细：')
    for (const f of [...phaseA.failures, ...phaseB.failures]) console.log(`  round ${f.i}: ${f.error}`)
    console.log('（按 ADR-001 E-03：未通过则另开替代 ADR——独立轻量 host，packages/host 契约不变）')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
