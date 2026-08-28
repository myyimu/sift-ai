// run-full-chain-e2e.mjs —— 真全链 E2E（路线图步骤 6 / P0_DEMO_SCOPE §6）：
//   真 Chrome（CfT）+ 产品扩展 → Alt+Shift+S 手势（manifest commands，SendKeys）→
//   SiftHost.cmd → Sift.exe(RUN_AS_NODE) → host-main → 真文件 store →
//   qa-cli（真 projectQuestion 投影）→ 本地 mock OpenAI 端点 →
//   @sift/model 校验 → 答案落盘 → 断言。
//
// 断言（失败即非零退出）：
//   1. store 里出现 authorization_granted + dom_snapshot（真捕获）；
//   2. mock 恰好收到 1 次请求（strict 模式；确认前模型调用为零——验收门 9）；
//   3. 请求体 system 含覆盖声明摘要（renderCoverageSummary 产物）；
//   4. 请求 user 含投影块 id；Authorization = Bearer <SIFT_MODEL_API_KEY>；
//   5. 答案文件合法：claims 引用真实块 id；analyzer 本地盖章（model=mock-model、
//      provider=127.0.0.1），答案文本不含 API key；
//   6. UI 冒烟：pack2 Sift.exe 以同一 store 启动到 'UI mode ready'（不驱动按钮——
//      交互自动化属 RUNBOOK 手动步骤）。
//
// 用法：node tools/e2e/run-full-chain-e2e.mjs [--keep] [--chrome <path>] [--use-local-chrome] [--mode degrade]
//   --keep             保留现场（store/答案/日志）便于排查
//   --mode degrade     mock 端点先 400 触发 adapter 的 json_object 降级（断言 2 变为恰好 2 次）
// 前置：
//   pnpm build && pnpm build:desktop && pnpm --filter @sift/desktop package:dir
//   node tools/scripts/register-sift-native-host.mjs register
// 注意：
//   - SendKeys 依赖窗口焦点，偶发闪失属已知风险：失败信息会指明直接重跑；
//   - 手势绑定若与其他扩展冲突（chrome://extensions/shortcuts），Chrome 不绑定该键
//     —— 先手动确认一次。
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createWriteStream } from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureCft, findChrome } from '../spike/cft.mjs'
import { startMockOpenAi } from './mock-openai.mjs'
import { NATIVE_HOST_NAME } from '../scripts/sift-demo-constants.mjs'

const EXTENSION_DIST = resolve('apps/extension/dist')
const QA_CLI = resolve('apps/desktop/dist/qa-cli.js')
const SIFT_EXE = resolve('apps/desktop/pack2/win-unpacked/Sift.exe')
const FIXTURES_PAGES = resolve('fixtures/pages')
const QUESTION = '这个页面主要讲了什么？'
const MODEL_ID = 'mock-model'
const API_KEY = 'sk-e2e-mock-key-not-real'

const { ELECTRON_RUN_AS_NODE: _ignored, ...CLEAN_ENV } = process.env

function parseArgs(argv) {
  const out = { keep: false, chrome: null, useLocalChrome: false, mode: 'strict' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keep') out.keep = true
    else if (argv[i] === '--chrome') out.chrome = resolve(argv[++i])
    else if (argv[i] === '--use-local-chrome') out.useLocalChrome = true
    else if (argv[i] === '--mode') out.mode = argv[++i]
    else { console.error(`未知参数 ${argv[i]}`); process.exit(2) }
  }
  return out
}

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

/** fixtures/pages 静态服务（ephemeral 端口；sanitizeUrl 只放行 http/https，file:// 会被拒）。 */
function startFixturesServer() {
  const server = createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).replace(/^[/\\]+/, '')
      if (rel.includes('..') || rel === '') throw new Error('bad')
      const body = await readFile(join(FIXTURES_PAGES, rel))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port })))
}

/** journal 行类型统计（直接读文件，不 import 包——与 dump-store 同风格）。 */
async function journalTypes(storeRoot) {
  try {
    const text = await readFile(join(storeRoot, 'observations.jsonl'), 'utf8')
    const types = {}
    for (const line of text.split('\n')) {
      if (line === '') continue
      try {
        const row = JSON.parse(line)
        types[row.type] = (types[row.type] ?? 0) + 1
      } catch { /* 断尾窗口：忽略 */ }
    }
    return types
  } catch {
    return {} // store 还没建
  }
}

/** Alt+Shift+S（manifest commands 手势）——WScript SendKeys。
 * 两个必要细节（实测 2026-08-28）：
 *  - AppActivate(chromePid)：spawn 的 PowerShell 若不显式激活目标窗口，
 *    按键会发给当时恰好在前台的任意窗口（终端/编辑器）；
 *  - windowsHide:true：默认会弹出 PowerShell 控制台窗口，它自己抢走焦点，
 *    SendKeys 打到它自己身上——手势 100% 闪失的根因。 */
function sendGrantShortcut(chromePid) {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$w = New-Object -ComObject WScript.Shell; if (-not $w.AppActivate(${chromePid})) { exit 3 }; Start-Sleep -Milliseconds 500; $w.SendKeys('%+s')`,
    ],
    { encoding: 'utf8', stdio: 'pipe', windowsHide: true },
  )
  if (r.status === 3) fail(`AppActivate(${chromePid}) 未找到 Chrome 窗口（窗口未就绪/已最小化）`)
  if (r.status !== 0) fail(`SendKeys 失败：${r.stderr}`)
}

function assertNoSiftRunning() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Sift.exe'], { encoding: 'utf8' })
  if ((r.stdout || '').toLowerCase().includes('sift.exe')) {
    fail('检测到已在运行的 Sift.exe（会持单实例锁干扰 UI 冒烟）——先 taskkill /F /IM Sift.exe')
  }
}

function assertNativeHostRegistered() {
  const r = spawnSync('reg', ['query', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`, '/ve'], { encoding: 'utf8' })
  if (r.status !== 0 || !(r.stdout || '').includes('REG_SZ')) {
    fail(`native host 未注册（${NATIVE_HOST_NAME}）——先 node tools/scripts/register-sift-native-host.mjs register`)
  }
}

/** UI 冒烟：同一 store 起 pack2 exe，等 'UI mode ready'；树杀回收。 */
async function uiSmoke(storeRoot, tmpRoot) {
  return new Promise((res, rej) => {
    const logPath = join(tmpRoot, 'ui-smoke.log')
    const child = spawn(SIFT_EXE, [], {
      env: { ...CLEAN_ENV, SIFT_STORE_ROOT: storeRoot },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const ws = createWriteStream(logPath)
    let tail = ''
    child.stderr.on('data', (d) => {
      ws.write(d)
      tail = (tail + String(d)).slice(-300)
    })
    const timer = setTimeout(() => {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
      rej(new Error(`UI 冒烟 12s 未就绪（日志 ${logPath}；尾部：${tail}）`))
    }, 12000)
    child.on('error', (e) => { clearTimeout(timer); rej(e) })
    const poll = setInterval(() => {
      if (tail.includes('UI mode ready')) {
        clearInterval(poll)
        clearTimeout(timer)
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
        res()
      }
    }, 250)
  })
}

// —— 主流程 ——

const args = parseArgs(process.argv.slice(2))

for (const [what, path] of [['产品扩展构建', EXTENSION_DIST], ['qa-cli 构建', QA_CLI], ['pack2 产物', SIFT_EXE]]) {
  if (!existsSync(path)) fail(`${what} 不存在：${path}（先 pnpm build && pnpm build:desktop && pnpm --filter @sift/desktop package:dir）`)
}
assertNativeHostRegistered()
assertNoSiftRunning()

const chromePath = args.chrome ?? (args.useLocalChrome ? findChrome() : await ensureCft())
const { server: fixtureServer, port: fixturePort } = await startFixturesServer()
const mock = await startMockOpenAi({ mode: args.mode })

const tmpRoot = mkdtempSync(join(tmpdir(), 'sift-fullchain-'))
const storeRoot = join(tmpRoot, 'store')
const profileDir = join(tmpRoot, 'chrome-profile')
const chromeLog = join(tmpRoot, 'chrome-stderr.log')
const answerOut = join(tmpRoot, 'answer.json')

console.log(`全链 E2E
chrome:      ${chromePath}
extension:   ${EXTENSION_DIST}（产品扩展，dist 构建）
fixture:     http://127.0.0.1:${fixturePort}/benign-article.html
store:       ${storeRoot}
mock model:  http://127.0.0.1:${mock.port}/v1（mode=${args.mode}）
现场:        ${tmpRoot}${args.keep ? '' : '（结束后删除；--keep 保留）'}`)

let chrome = null
try {
  // 1) 真 Chrome + 产品扩展 + 临时 store（host 由 Chrome spawn，继承 env）
  chrome = spawn(chromePath, [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${EXTENSION_DIST}`,
    `--disable-extensions-except=${EXTENSION_DIST}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crash-detection',
    '--enable-logging=stderr',
    '--no-proxy-server',
    // CfT 二进制未签名：安全软件注入会让 Win32 沙箱初始化失败（静默退出 code=3）。
    // --use-local-chrome/--chrome 指定品牌稳定版时不加（签名完整）。
    ...(chromePath.includes('.cache') ? ['--no-sandbox'] : []),
    `http://127.0.0.1:${fixturePort}/benign-article.html`,
  ], { env: { ...CLEAN_ENV, SIFT_STORE_ROOT: storeRoot }, stdio: ['ignore', 'ignore', 'pipe'] })
  const logWs = createWriteStream(chromeLog)
  chrome.stderr.on('data', (d) => logWs.write(d))
  const chromeDead = { dead: false, code: null }
  chrome.on('exit', (code) => { chromeDead.dead = true; chromeDead.code = code })

  // 2) 页面就绪后发 Alt+Shift+S 手势（闪失重试，最多 3 轮）
  await new Promise((r) => setTimeout(r, 4000))
  if (chromeDead.dead) fail(`Chrome 提前退出 code=${chromeDead.code}（日志 ${chromeLog}）`)
  let granted = false
  for (let attempt = 1; attempt <= 3 && !granted; attempt++) {
    sendGrantShortcut(chrome.pid)
    console.log(`  [手势 ${attempt}] Alt+Shift+S 已发送，等待 authorization_granted…`)
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && !granted) {
      const types = await journalTypes(storeRoot)
      if ((types.authorization_granted ?? 0) > 0) { granted = true; break }
      if (chromeDead.dead) fail(`Chrome 提前退出 code=${chromeDead.code}（日志 ${chromeLog}）`)
      await new Promise((r) => setTimeout(r, 800))
    }
  }
  if (!granted) {
    fail('15s×3 未观察到 authorization_granted。可能原因：a) SendKeys 焦点闪失（直接重跑）；b) Alt+Shift+S 被其他扩展占用（chrome://extensions/shortcuts 检查）；c) 扩展未加载（看 chrome-stderr.log）')
  }
  console.log('  ✓ authorization_granted 落盘')

  // 3) 等真捕获（dom_snapshot）
  {
    const deadline = Date.now() + 30000
    let types = {}
    while (Date.now() < deadline) {
      types = await journalTypes(storeRoot)
      if ((types.dom_snapshot ?? 0) > 0) break
      await new Promise((r) => setTimeout(r, 800))
    }
    if ((types.dom_snapshot ?? 0) === 0) fail(`30s 未观察到 dom_snapshot（journal 类型：${JSON.stringify(types)}；chrome 日志 ${chromeLog}）`)
  }
  console.log('  ✓ dom_snapshot 落盘（真 host/store 链路）')

  // 4) qa-cli：投影 -> mock 模型 -> 校验 -> 答案落盘
  // 注意必须异步 spawn：mock 端点跑在本进程事件循环里，spawnSync 会阻塞它
  // -> qa-cli 的 fetch 无人应答 -> 死锁到超时（实测退出码 null）。
  const cliCode = await new Promise((res) => {
    const cli = spawn(
      process.execPath,
      [
        QA_CLI,
        '--store-root', storeRoot,
        '--scope', 'latest-session',
        '--question', QUESTION,
        '--out', answerOut,
        '--model-base-url', `http://127.0.0.1:${mock.port}`,
        '--model-id', MODEL_ID,
        '--model-ctx', '128000',
      ],
      {
        env: { ...CLEAN_ENV, SIFT_MODEL_API_KEY: API_KEY, SIFT_STORE_ROOT: storeRoot },
        cwd: resolve('.'),
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    )
    const timer = setTimeout(() => {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(cli.pid)], { stdio: 'ignore' })
      res(null)
    }, 120000)
    cli.on('exit', (code) => { clearTimeout(timer); res(code) })
    cli.on('error', () => { clearTimeout(timer); res(null) })
  })
  if (cliCode !== 0) fail(`qa-cli 退出码 ${cliCode}（上方有其 stderr）`)

  // 5) 断言：mock 请求形状
  const expectedCalls = args.mode === 'degrade' ? 2 : 1
  if (mock.requests.length !== expectedCalls) {
    fail(`mock 收到 ${mock.requests.length} 次请求（预期恰好 ${expectedCalls}）——确认发送前模型调用必须为零，无后台重试`)
  }
  const first = mock.requests[0]
  const system = first?.body?.messages?.find((m) => m?.role === 'system')?.content ?? ''
  const user = first?.body?.messages?.find((m) => m?.role === 'user')?.content ?? ''
  if (!system.includes('数据覆盖声明')) fail('请求 system prompt 不含覆盖声明（renderCoverageSummary 产物缺失）')
  if (!/\[b-\d{4}\|/.test(user)) fail('请求 user 消息不含投影块标记（块未进 prompt）')
  if (first.authorization !== `Bearer ${API_KEY}`) fail(`Authorization 头异常：${first.authorization.slice(0, 20)}…`)
  if (args.mode === 'degrade' && mock.requests[1]?.responseFormat !== 'json_object') {
    fail('降级后第二次请求的 response_format 不是 json_object')
  }
  console.log(`  ✓ mock 请求形状正确（${expectedCalls} 次调用，coverage 摘要与块 id 均在请求中）`)

  // 6) 断言：答案文件
  const answerDoc = JSON.parse(readFileSync(answerOut, 'utf8'))
  const q = answerDoc.questionProjection
  const a = answerDoc.answer
  if (q?.question !== QUESTION) fail('答案文件的问题不匹配')
  if (q?.truncation !== 'none') fail('答案文件的投影 truncation 不是 none')
  const blockIds = new Set((q?.blocks ?? []).map((b) => b.id))
  if ((q?.blocks ?? []).length === 0) fail('投影块为空')
  for (const ref of (a?.claims ?? []).flatMap((c) => c.evidenceBlockRefs)) {
    if (!blockIds.has(ref)) fail(`claim 引用了不存在的块 ${ref}`)
  }
  if (a?.analyzer?.model !== MODEL_ID) fail(`analyzer.model 应为本地盖章 ${MODEL_ID}，实际 ${a?.analyzer?.model}`)
  if (a?.analyzer?.provider !== '127.0.0.1') fail(`analyzer.provider 应为 127.0.0.1，实际 ${a?.analyzer?.provider}`)
  if (JSON.stringify(answerDoc).includes(API_KEY)) fail('API key 泄漏进答案文件（D-051）')
  console.log(`  ✓ 答案落盘并通过全部断言（${q.blocks.length} 块 / ${a.claims.length} claims）`)

  // 7) UI 冒烟（同 store；不驱动按钮）
  await uiSmoke(storeRoot, tmpRoot)
  console.log('  ✓ UI 冒烟通过（UI mode ready）')

  console.log('\n=== 全链 E2E: PASS ✅ ===')
} catch (e) {
  fail(`${e.message}\n现场：${tmpRoot}（chrome 日志 ${chromeLog}；--keep 可保留）`)
} finally {
  try { chrome?.kill() } catch { /* already gone */ }
  await mock.close().catch(() => {})
  fixtureServer.close()
  if (!args.keep) {
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* Windows 句柄延迟；残留 %TEMP% */ }
  } else {
    console.log(`--keep: 现场保留 ${tmpRoot}`)
  }
}
