// Demo 启动前只读检查：不写注册表、不读取/打印 API key、不访问网络。
// 失败项返回非零，警告项（例如未配置模型）不阻止只做捕获的演示。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const requiredFiles = [
  'apps/extension/dist/manifest.json',
  'apps/extension/dist/service-worker.js',
  'apps/extension/dist/content-script.js',
  'apps/desktop/dist/main.cjs',
  'apps/desktop/dist/ui/preload.cjs',
  'apps/desktop/dist/ui/renderer.js',
  'apps/desktop/pack2/win-unpacked/Sift.exe',
  'apps/desktop/pack2/win-unpacked/SiftHost.cmd',
]
const allowedPermissions = new Set(['activeTab', 'scripting', 'nativeMessaging', 'storage'])
const forbiddenPermissions = new Set(['debugger', 'tabs', 'history', 'webNavigation', 'webRequest', '<all_urls>'])

function checkNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  const ok = major > 22 && major < 27 || major === 22 && minor >= 23
  return { ok, message: `Node.js ${process.versions.node}${ok ? '' : '（需要 >=22.23.0 且 <27）'}` }
}

function checkManifest() {
  const path = join(root, 'apps/extension/dist/manifest.json')
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : []
    const unexpected = permissions.filter(permission => !allowedPermissions.has(permission))
    const forbidden = permissions.filter(permission => forbiddenPermissions.has(permission))
    const hasHosts = Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0
    const ok = manifest.manifest_version === 3 && unexpected.length === 0 && forbidden.length === 0 && !hasHosts
    const detail = ok ? 'MV3 权限符合 P0 allowlist' : `权限异常：unexpected=${JSON.stringify(unexpected)} forbidden=${JSON.stringify(forbidden)} host_permissions=${hasHosts ? 'present' : 'empty'}`
    return { ok, message: detail }
  } catch (error) {
    return { ok: false, message: `manifest 无法读取或解析：${error instanceof Error ? error.message : String(error)}` }
  }
}

function checkHostRegistration() {
  if (process.platform !== 'win32') return { ok: false, message: 'Native Host 注册检查仅支持 Windows' }
  const script = join(root, 'tools/scripts/register-sift-native-host.mjs')
  const result = spawnSync(process.execPath, [script, 'status'], { cwd: root, encoding: 'utf8', windowsHide: true })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const registered = /状态:\s+已注册/.test(output)
  const pathExists = /路径存在:\s+是/.test(output)
  return { ok: result.status === 0 && registered && pathExists, message: registered && pathExists ? 'Native Host 已注册且路径存在' : 'Native Host 未注册或 manifest/host 路径失效（运行 register）' }
}

function checkModelConfig() {
  const missing = ['SIFT_MODEL_BASE_URL', 'SIFT_MODEL_API_KEY', 'SIFT_MODEL_ID', 'SIFT_MODEL_CTX'].filter(name => !process.env[name]?.trim())
  if (missing.length > 0) return { ok: true, warning: true, message: `模型未配置（仅捕获可用；问答/主题生成缺少 ${missing.join(', ')}）` }
  let url
  try { url = new URL(process.env.SIFT_MODEL_BASE_URL) } catch { return { ok: false, message: 'SIFT_MODEL_BASE_URL 不是合法 URL' } }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !localHttp) return { ok: false, message: '模型远程端点必须使用 https（本地回环可用 http）' }
  if (url.search || url.hash || url.username || url.password) return { ok: false, message: '模型端点不得包含 query、fragment 或 userinfo' }
  if (!/^\d+$/.test(process.env.SIFT_MODEL_CTX) || Number(process.env.SIFT_MODEL_CTX) <= 0) return { ok: false, message: 'SIFT_MODEL_CTX 必须是正整数' }
  return { ok: true, message: `模型配置已设置：${url.origin} · ${process.env.SIFT_MODEL_ID}（API key 已隐藏）` }
}

function main() {
  if (process.argv.includes('--help')) {
    console.log('用法：node tools/scripts/demo-preflight.mjs')
    console.log('只读检查 Node、构建产物、扩展权限、Native Host 注册和模型配置。')
    return
  }
  const checks = []
  const node = checkNodeVersion()
  checks.push({ name: 'Node.js', ...node })
  for (const relative of requiredFiles) checks.push({ name: `产物 ${relative}`, ok: existsSync(join(root, relative)), message: existsSync(join(root, relative)) ? '存在' : '缺失（先运行 build/build:desktop/package:dir）' })
  checks.push({ name: 'Extension manifest', ...checkManifest() })
  checks.push({ name: 'Native Host', ...checkHostRegistration() })
  checks.push({ name: 'Model config', ...checkModelConfig() })
  let failures = 0
  for (const check of checks) {
    const prefix = check.ok ? (check.warning ? 'WARN' : ' OK ') : 'FAIL'
    console.log(`[${prefix}] ${check.name}：${check.message}`)
    if (!check.ok) failures += 1
  }
  console.log(failures === 0 ? '\nPreflight 通过：可以开始 Demo。' : `\nPreflight 未通过：${failures} 项必须修复。`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
