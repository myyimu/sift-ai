// 真实 Chrome E2E（ADR-002 批准项 3）：临时测试扩展 -> chrome.runtime.connectNative
// -> SiftHost.cmd -> Sift.exe(RUN_AS_NODE) -> host-main.js 帧往返，UI 开/关两态复验。
//
// 与 run-e03-spike.mjs（模拟 Chrome）互补：本脚本用真实浏览器的 native messaging
// 栈（注册表发现、CreateProcess、管道帧协议、SW 生命周期）。
//
// 架构（单向报告协议——控制端点不携带任何指令语义，只暴露一个只读标志位）：
//   - 临时测试扩展与产品扩展共用同一 manifest key -> 同一 Extension ID
//     （host-main 的 allowed origin 校验才会通过）；测试扩展是一次性的，
//     不触碰产品扩展代码与权限边界（产品 manifest 保持 4 权限不动）。
//   - SW 内置调度：阶段 A（UI 未运行）-> 轮询 GET /phase-b（0/1 只读标志，
//     由 harness 在拉起 Sift UI 实例后置 1）-> 阶段 B -> 停止。
//     每轮结果 POST /report（127.0.0.1，仅回传 JSON 摘要）。
//
// 扩展加载方式（本机 Chrome 151 品牌稳定版已实测忽略 --load-extension）：
//   --cft       自动下载 Chrome for Testing（官方真实 Chrome 构建，支持该 flag）
//               到 tools/.cache/cft（npmmirror 二进制镜像），全自动。
//   （默认）    用本机 Chrome：--load-extension 失败则打印手动加载指引并自动
//               打开 chrome://extensions，等待一次 Load unpacked。
//
// 用法：
//   node tools/spike/run-chrome-e2e.mjs [--cft] [--rounds 100] [--plumbing] [--keep]
//     --plumbing  管道自检：不要求注册表（预期每轮 connect 失败并回报错误，
//                 证明 Chrome 启动/扩展加载/SW/报告通道/native 调用全链触达）
//     --keep      保留临时扩展目录（调试用）
// 前置：
//   pnpm --filter @sift/desktop package:dir         （pack2 产物 + SiftHost.cmd）
//   node tools/scripts/register-sift-native-host.mjs register（正式模式；需用户确认）
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NATIVE_HOST_ALLOWED_ORIGIN, NATIVE_HOST_NAME } from '../scripts/sift-demo-constants.mjs'

const PRODUCT_MANIFEST = resolve('apps/extension/public/manifest.json')
const SIFT_EXE = resolve('apps/desktop/pack2/win-unpacked/Sift.exe')
const CFT_DIR = resolve('tools/.cache/cft')
const CFT_MIRROR = 'https://registry.npmmirror.com/-/binary/chrome-for-testing'

function parseArgs(argv) {
  const out = { rounds: 100, plumbing: false, keep: false, chrome: null, cft: false }
  const flags = new Set(['--plumbing', '--keep', '--cft'])
  for (let i = 0; i < argv.length; i++) {
    if (flags.has(argv[i])) out[argv[i].slice(2)] = true
    else if (argv[i] === '--rounds') out.rounds = Number(argv[++i])
    else if (argv[i] === '--chrome') out.chrome = resolve(argv[++i])
    else { console.error(`unknown flag ${argv[i]}`); process.exit(2) }
  }
  return out
}

function findChrome() {
  const candidates = [
    join(homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  console.error('未找到 chrome.exe（用 --chrome <path> 指定）')
  process.exit(2)
}

/** 递归找 chrome.exe（CfT zip 解压后的目录名随版本/命名变化）。 */
function findChromeExeUnder(dir) {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name.toLowerCase() === 'chrome.exe') return p
    }
  }
  return null
}

/** Chrome for Testing：npmmirror 镜像自动下载（优先与本机 Chrome 同大版本）。 */
async function ensureCft() {
  const marker = join(CFT_DIR, 'version.txt')
  if (existsSync(marker)) {
    const cached = findChromeExeUnder(CFT_DIR)
    if (cached) {
      console.log(`CfT（已缓存 ${readFileSync(marker, 'utf8').trim()}）: ${cached}`)
      return cached
    }
  }
  mkdirSync(CFT_DIR, { recursive: true })
  console.log(`下载 Chrome for Testing（${CFT_MIRROR}）……`)
  const list = await (await fetch(`${CFT_MIRROR}/`)).json()
  const versions = list.map((x) => String(x.name).replace(/\/$/, '')).filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v))
  if (!versions.length) throw new Error('镜像版本列表为空')
  const localMajor = installedChromeMajor()
  const pick = (localMajor && versions.find((v) => v.startsWith(localMajor + '.'))) || versions[versions.length - 1]
  const zipName = await pickZipName(pick)
  const url = `${CFT_MIRROR}/${pick}/win64/${zipName}`
  console.log(`  版本 ${pick} <- ${url}`)
  const zipPath = join(CFT_DIR, zipName)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  await streamToFile(res.body, zipPath)
  // 用 System32 的 bsdtar（支持 zip；PATH 里 Git 的 GNU tar 不认 zip，
  // 且 GNU 的 --force-local 是它自己的选项，bsdtar 无需也 不支持）。
  const t = spawnSync('C:\\Windows\\System32\\tar.exe', ['-xf', zipPath, '-C', CFT_DIR], { stdio: 'pipe' })
  if (t.status !== 0) throw new Error(`解压失败: ${t.stderr}`)
  // zip 保留在 tools/.cache/cft（.gitignore 已排除；不做不可验证的动态删除）。
  const exe = findChromeExeUnder(CFT_DIR)
  if (!exe) throw new Error('解压后未找到 chrome.exe')
  writeFileSync(marker, pick)
  console.log(`  就绪: ${exe}`)
  return exe
}

/** win64 目录下 zip 命名随版本变化（chrome-win64.zip / chrome-for-testing-win64.zip）。 */
async function pickZipName(version) {
  const files = await (await fetch(`${CFT_MIRROR}/${version}/win64/`)).json()
  const names = files.map((x) => String(x.name))
  return names.find((n) => /^chrome(-for-testing)?-win64\.zip$/.test(n))
}

function installedChromeMajor() {
  try {
    const p = findChrome()
    const v = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${p}').VersionInfo.ProductVersion`], { encoding: 'utf8' })
    const m = (v.stdout || '').match(/(\d+)\./)
    return m ? Number(m[1]) : null
  } catch { return null }
}

async function streamToFile(webBody, path) {
  // fetch 的 body 是 Web ReadableStream，须先转 Node 流再 pipe。
  const nodeStream = Readable.fromWeb(webBody)
  await new Promise((res, rej) => {
    const ws = createWriteStream(path)
    nodeStream.pipe(ws)
    ws.on('finish', res)
    ws.on('error', rej)
    nodeStream.on('error', rej)
  })
}

const { ELECTRON_RUN_AS_NODE: _ignored, ...CLEAN_ENV } = process.env

// —— 临时测试扩展 ——
function buildTestExtension(extDir, sinkPort, rounds) {
  const product = JSON.parse(readFileSync(PRODUCT_MANIFEST, 'utf8'))
  const manifest = {
    manifest_version: 3,
    name: 'Sift E2E Probe',
    version: '0.0.1',
    description: 'Temporary E2E probe extension (same key as product -> same extension ID). Deleted after the run.',
    key: product.key, // 与产品扩展同 key -> 同 Extension ID（allowed origin 校验前提）
    permissions: ['nativeMessaging'],
    host_permissions: ['http://127.0.0.1/*'], // 仅测试扩展：向本机报告通道回报结果
    background: { service_worker: 'background.js', type: 'module' },
  }
  mkdirSync(extDir, { recursive: true })
  writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(join(extDir, 'background.js'), `\
// 一次性 E2E 探针（自动生成，勿手动修改）。单向协议：只回报结果 + 轮询只读标志。
const SINK = 'http://127.0.0.1:${sinkPort}'
const HOST = ${JSON.stringify(NATIVE_HOST_NAME)}
const ROUNDS = ${rounds}
const ROUND_TIMEOUT_MS = 10000

async function report(obj) {
  try { await fetch(SINK + '/report', { method: 'POST', body: JSON.stringify(obj) }) } catch {}
}

async function phaseBStarted() {
  try {
    const r = await fetch(SINK + '/phase-b')
    const j = await r.json()
    return j.started === true
  } catch { return false }
}

function oneRound(i, phase) {
  const nonce = crypto.randomUUID()
  const t0 = Date.now()
  return new Promise((res) => {
    let port = null
    const timer = setTimeout(() => {
      try { port && port.disconnect() } catch {}
      res({ i, phase, ok: false, error: 'timeout ' + ROUND_TIMEOUT_MS + 'ms', ms: Date.now() - t0 })
    }, ROUND_TIMEOUT_MS)
    const settle = (r) => { clearTimeout(timer); res(Object.assign({ ms: Date.now() - t0 }, r)) }
    try { port = chrome.runtime.connectNative(HOST) } catch (e) {
      return settle({ i, phase, ok: false, error: 'connect threw: ' + String(e) })
    }
    port.onMessage.addListener((msg) => {
      const ok = msg && msg.type === 'pong' && msg.id === i && msg.nonce === nonce
      try { port.disconnect() } catch {}
      settle({ i, phase, ok, got: JSON.stringify(msg).slice(0, 120) })
    })
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError ? String(chrome.runtime.lastError.message) : 'disconnected'
      settle({ i, phase, ok: false, error: err.slice(0, 200) })
    })
    try { port.postMessage({ type: 'ping', id: i, nonce }) } catch (e) {
      settle({ i, phase, ok: false, error: 'postMessage threw: ' + String(e) })
    }
  })
}

async function runPhase(phase) {
  await report({ type: 'phase-start', phase, rounds: ROUNDS })
  let okCount = 0
  const t0 = Date.now()
  for (let i = 1; i <= ROUNDS; i++) {
    const r = await oneRound(i, phase)
    if (r.ok) okCount++
    await report(Object.assign({ type: 'round' }, r))
    await new Promise((r2) => setTimeout(r2, 50))
  }
  await report({ type: 'phase-done', phase, rounds: ROUNDS, okCount, ms: Date.now() - t0 })
}

// 内置调度：A -> 等 harness 置 /phase-b 标志（它先拉起 Sift UI 实例）-> B -> 停。
for (;;) {
  await runPhase('A')
  for (;;) {
    if (await phaseBStarted()) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  await runPhase('B')
  break
}
`)
  return extDir
}

// —— 报告端点（单向 + 只读标志；无任何指令语义） ——
const roundReports = []
const phaseDone = {}
const state = { phaseB: false, swFirstContact: false }

function startSink() {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/phase-b') {
      state.swFirstContact = true
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ started: state.phaseB }))
      return
    }
    if (req.method === 'POST' && req.url === '/report') {
      state.swFirstContact = true
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const m = JSON.parse(body)
          if (m.type === 'round') {
            roundReports.push(m)
            if (m.error) console.error(`  [${m.phase} ${m.i}] FAIL: ${m.error}`)
          } else if (m.type === 'phase-done') {
            phaseDone[m.phase] = m
            console.log(`  阶段 ${m.phase} 完成: ${m.okCount}/${m.rounds} ok (${m.ms}ms)`)
          } else if (m.type === 'phase-start') {
            console.log(`  阶段 ${m.phase} 开始: ${m.rounds} 轮`)
          }
        } catch { /* 忽略畸形回报 */ }
        res.writeHead(204)
        res.end()
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port })))
}

function waitFor(predicate, timeoutMs, everyMs = 250) {
  return new Promise((res, rej) => {
    const t0 = Date.now()
    const tick = () => {
      if (predicate()) return res(true)
      if (Date.now() - t0 > timeoutMs) return rej(new Error(`waitFor timeout after ${timeoutMs}ms`))
      setTimeout(tick, everyMs)
    }
    tick()
  })
}

/** UI 实例（同 run-e03-spike 语义：干净环境、等 stderr 就绪标志）。 */
function startUi() {
  return new Promise((res, rej) => {
    const child = spawn(SIFT_EXE, [], { env: CLEAN_ENV, stdio: ['ignore', 'ignore', 'pipe'] })
    let ready = false
    const timer = setTimeout(() => (ready ? res(child) : rej(new Error('UI not ready in 12s'))), 12000)
    child.stderr.on('data', (c) => {
      if (String(c).includes('UI mode ready')) { ready = true; clearTimeout(timer); res(child) }
    })
    child.on('error', (e) => { clearTimeout(timer); rej(e) })
  })
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(SIFT_EXE)) {
    console.error(`Sift.exe 不存在: ${SIFT_EXE}（先 pnpm --filter @sift/desktop package:dir）`)
    process.exit(2)
  }
  const chromePath = args.chrome ?? (args.cft ? await ensureCft() : findChrome())
  const rounds = args.plumbing ? 1 : args.rounds

  const { server, port } = await startSink()
  const tmpRoot = mkdtempSync(join(tmpdir(), 'sift-e2e-'))
  const extDir = join(tmpRoot, 'ext')
  const profileDir = join(tmpRoot, 'profile')
  const chromeLog = join(tmpRoot, 'chrome-stderr.log')
  buildTestExtension(extDir, port, rounds)

  console.log(`Chrome E2E（ADR-002）
chrome:     ${chromePath}
ext dir:    ${extDir}（与产品扩展同 key -> 同 Extension ID）
host:       ${NATIVE_HOST_NAME}（allowed origin ${NATIVE_HOST_ALLOWED_ORIGIN}）
rounds:     ${rounds}/phase${args.plumbing ? '（plumbing 自检：预期 connect 失败并回报）' : ''}
registry:   ${args.plumbing ? '不要求' : '必须已 register（见 tools/scripts/register-sift-native-host.mjs）'}`)

  let chrome = null
  let ui = null
  try {
    chrome = spawn(chromePath, [
      `--user-data-dir=${profileDir}`,
      `--load-extension=${extDir}`,
      `--disable-extensions-except=${extDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crash-detection',
      '--enable-logging=stderr',
      // 系统代理可能劫持 SW 对 127.0.0.1 的 fetch（且 report() 静默吞错），
      // 测试 profile 无外网需求，直接禁代理。
      '--no-proxy-server',
      'about:blank',
    ], { env: CLEAN_ENV, stdio: ['ignore', 'ignore', 'pipe'] })
    console.log(`chrome pid: ${chrome.pid}`)
    // stderr 落盘诊断（--enable-logging=stderr 输出多；必须消费防管道塞满）。
    const logWs = createWriteStream(chromeLog)
    chrome.stderr.on('data', (d) => logWs.write(d))

    // SW 首次联系；品牌稳定版可能忽略 --load-extension -> 手动回退。
    try {
      await waitFor(() => state.swFirstContact, 20000, 250)
      console.log('扩展 SW 已联系报告端点。')
    } catch {
      console.log(`\n[!] 20s 内未收到扩展联系——本机 Chrome 可能忽略 --load-extension。
    请在已打开的 Chrome 窗口中手动加载（一次性，本次会话有效）：
      1. 地址栏打开 chrome://extensions（下方也会自动开一个标签）
      2. 开启 Developer mode -> Load unpacked -> 选择目录：
         ${extDir}
    harness 继续等待（最长 5 分钟）……`)
      // 同 profile 打开扩展页（避免落到用户默认浏览器/默认 profile）。
      spawn(chromePath, [`--user-data-dir=${profileDir}`, '--no-proxy-server', 'chrome://extensions/'], { env: CLEAN_ENV, stdio: 'ignore', detached: true }).unref()
      try {
        await waitFor(() => state.swFirstContact, 300000, 500)
        console.log('扩展 SW 已联系报告端点（手动加载）。')
      } catch {
        // 转储日志尾部（finally 可能已删文件；扩展加载/SW 错误通常在末尾）。
        let tail = '(日志不可读)'
        try {
          const lines = readFileSync(chromeLog, 'utf8').split(/\r?\n/)
          tail = lines.slice(-40).join('\n')
        } catch { /* keep placeholder */ }
        throw new Error(`扩展始终未加载（chrome stderr 尾部如下；完整日志 ${chromeLog}）：\n${tail}`)
      }
    }

    // 阶段 A：UI 未运行（SW 自驱）。
    await waitFor(() => phaseDone.A !== undefined, rounds * 15000 + 90000, 500)

    // 阶段 B：拉起 UI 实例后置只读标志，SW 自行开始阶段 B。
    ui = await startUi()
    console.log('  UI 实例已就绪（阶段 B）')
    state.phaseB = true
    await waitFor(() => phaseDone.B !== undefined, rounds * 15000 + 90000, 500)

    // 汇总。
    const a = phaseDone.A
    const b = phaseDone.B
    const phaseReports = roundReports.filter((r) => r.phase === 'A' || r.phase === 'B')
    const lat = phaseReports.filter((r) => r.ok).map((r) => r.ms ?? 0).sort((x, y) => x - y)
    const allOkA = a && a.okCount === a.rounds
    const allOkB = b && b.okCount === b.rounds
    if (args.plumbing) {
      // plumbing 判定：收到扩展回报（Chrome 启动/加载/SW/报告通道/native 调用已触达），
      // 且失败原因是"未注册"类——不宣称链路完成（ADR-002 限制 2）。
      const firstErr = phaseReports[0]?.error ?? '(无错误信息)'
      const pass = phaseReports.length > 0 && !allOkA
      console.log(`\n=== plumbing 自检: ${pass ? 'OK（链路触达，预期失败：' + firstErr + '）' : '异常（' + firstErr + '）'} ===`)
      process.exitCode = pass ? 0 : 1
    } else {
      const pass = allOkA && allOkB
      console.log(`\n=== Chrome E2E 结论: ${pass ? 'PASS ✅' : 'FAIL ❌'} ===`)
      console.log(`  阶段 A（UI 未运行）: ${a ? a.okCount + '/' + a.rounds : '未完成'}`)
      console.log(`  阶段 B（UI 运行中）: ${b ? b.okCount + '/' + b.rounds : '未完成'}`)
      if (lat.length) console.log(`  往返延迟: p50=${percentile(lat, 50)}ms p95=${percentile(lat, 95)}ms max=${lat[lat.length - 1]}ms`)
      for (const f of phaseReports.filter((r) => !r.ok).slice(0, 10)) console.log(`  [${f.phase} ${f.i}] ${f.error}`)
      process.exitCode = pass ? 0 : 1
    }
  } finally {
    // 无论成败都回收：浏览器、UI、报告端点、临时目录。
    try { chrome?.kill() } catch { /* already gone */ }
    try { ui?.kill() } catch { /* already gone */ }
    server.close()
    if (!args.keep) {
      try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* Windows 句柄延迟；残留于 %TEMP% */ }
    } else {
      console.log(`--keep: 临时目录保留 ${tmpRoot}（chrome 日志 ${chromeLog}）`)
    }
  }
}

main().catch((e) => {
  console.error(`E2E 失败: ${e.message}`)
  process.exitCode = 1
})
