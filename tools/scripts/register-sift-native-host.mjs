// Sift Native Messaging host 注册表注册/查询/回滚（ADR-002；**写注册表前必须
// 已获用户明确确认**——ADR-002 批准限制第 1 条）。
//
// 行为：
//   status             查询注册状态（只读，随时可跑）
//   register           生成 host manifest JSON + 写入 HKCU 注册表键
//   remove             删除 HKCU 键 + 删除本脚本生成的 manifest JSON
//
// 注册目标（仅 HKCU，无需管理员，用户级最小权限）：
//   HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dj.sift.demo
//     默认值 = <manifest JSON 绝对路径>
//   manifest JSON 写入 %LOCALAPPDATA%\Sift\native-host\<name>.json
//     path = <pack2 产物>\SiftHost.cmd（ADR-002：cmd 包装器 -> RUN_AS_NODE）
//     allowed_origins = [chrome-extension://<固定 demo Extension ID>/]
//
// 约束（与 ADR-002 一致）：
//   - host manifest 的 path 只指向 SiftHost.cmd，绝不直接指向 Sift.exe
//    （GUI 引导会污染 stdout，见 ADR-002 E-1~E-6）；
//   - Extension ID / host 名只取自 sift-demo-constants.mjs（唯一常量源）；
//   - register 前置检查 SiftHost.cmd 存在，缺失即失败退出（失败关闭）；
//   - remove 只删本脚本写入的键与文件，不动其他任何内容。
//   - Edge 变体（如需）：把 SOFTWARE\Google\Chrome 换成 SOFTWARE\Microsoft\Edge，
//     其余不变；本 Demo 目标为 Chrome。
//
// 用法：
//   node tools/scripts/register-sift-native-host.mjs status
//   node tools/scripts/register-sift-native-host.mjs register
//   node tools/scripts/register-sift-native-host.mjs remove
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { EXTENSION_ID, NATIVE_HOST_ALLOWED_ORIGIN, NATIVE_HOST_NAME } from './sift-demo-constants.mjs'

const REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
const MANIFEST_DIR = join(homedir(), 'AppData', 'Local', 'Sift', 'native-host')
const MANIFEST_PATH = join(MANIFEST_DIR, `${NATIVE_HOST_NAME}.json`)
const DEFAULT_HOST_CMD = resolve('apps/desktop/pack2/win-unpacked/SiftHost.cmd')

function reg(args) {
  const r = spawnSync('reg', args, { encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function readRegistered() {
  const r = reg(['query', REG_KEY, '/ve'])
  if (r.code !== 0) return null
  const line = r.stdout.split('\n').find((l) => l.includes('REG_SZ'))
  if (!line) return null
  return line.split('REG_SZ').pop().trim()
}

function cmdStatus() {
  console.log(`注册表键:  ${REG_KEY}`)
  const registered = readRegistered()
  if (!registered) {
    console.log('状态:      未注册')
    return
  }
  console.log(`manifest:  ${registered}`)
  if (!existsSync(registered)) {
    console.log('manifest 文件不存在!')
    process.exitCode = 1
    return
  }
  try {
    const m = JSON.parse(readFileSync(registered, 'utf8'))
    console.log(`host name: ${m.name}`)
    console.log(`host path: ${m.path}`)
    console.log(`origins:   ${JSON.stringify(m.allowed_origins)}`)
    const pathOk = existsSync(m.path)
    console.log(`path 存在: ${pathOk ? '是' : '否!'}`)
    if (!pathOk || m.name !== NATIVE_HOST_NAME
      || JSON.stringify(m.allowed_origins) !== JSON.stringify([NATIVE_HOST_ALLOWED_ORIGIN])) {
      process.exitCode = 1
    }
  } catch (e) {
    console.log(`manifest 解析失败: ${e.message}`)
    process.exitCode = 1
  }
}

function cmdRegister() {
  const hostCmd = DEFAULT_HOST_CMD
  if (!existsSync(hostCmd)) {
    console.error(`SiftHost.cmd 不存在: ${hostCmd}（先 pnpm --filter @sift/desktop package:dir）`)
    process.exit(1)
  }
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'Sift AI P0 demo native host (ADR-002: SiftHost.cmd -> ELECTRON_RUN_AS_NODE)',
    path: hostCmd,
    type: 'stdio',
    allowed_origins: [NATIVE_HOST_ALLOWED_ORIGIN],
  }
  console.log('即将写入：')
  console.log(`  注册表键: ${REG_KEY}`)
  console.log(`  默认值:   ${MANIFEST_PATH}`)
  console.log(`  manifest: ${JSON.stringify(manifest, null, 2).split('\n').map((l, i) => (i === 0 ? l : '    ' + l)).join('\n')}`)

  mkdirSync(MANIFEST_DIR, { recursive: true })
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const r = reg(['add', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', MANIFEST_PATH, '/f'])
  if (r.code !== 0) {
    console.error(`reg add 失败 (${r.code}): ${r.stderr.trim()}`)
    process.exit(1)
  }
  console.log('\n注册完成。验证：')
  cmdStatus()
}

function cmdRemove() {
  console.log(`删除注册表键: ${REG_KEY}`)
  const r = reg(['delete', REG_KEY, '/f'])
  if (r.code !== 0) {
    console.log(`键不存在或删除失败 (${r.code}): ${r.stderr.trim()}`)
  } else {
    console.log('已删除。')
  }
  if (existsSync(MANIFEST_PATH)) {
    // 只删除本脚本固定生成的这一个文件；目录若空则一并移除。
    rmSync(MANIFEST_PATH)
    try { rmSync(MANIFEST_DIR, { recursive: false }) } catch { /* 目录非空则保留 */ }
    console.log(`已删除 manifest: ${MANIFEST_PATH}`)
  }
}

const mode = process.argv[2]
if (mode === 'status') cmdStatus()
else if (mode === 'register') cmdRegister()
else if (mode === 'remove') cmdRemove()
else {
  console.error('用法: node tools/scripts/register-sift-native-host.mjs <status|register|remove>')
  process.exit(2)
}
