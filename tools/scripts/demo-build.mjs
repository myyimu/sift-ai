// Demo 构建编排：只生成本地 Extension/桌面目录包，不写注册表、不启动浏览器。
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(label, command, args) {
  console.log(`\n== ${label} ==`)
  // Windows 的 pnpm 是 .cmd shim，必须经 shell 启动；参数均来自本脚本固定常量。
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: false, shell: process.platform === 'win32' })
  if (result.error) {
    console.error(`${label} 启动失败：${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`${label} 失败（exit ${result.status ?? 'unknown'}）`)
    process.exit(result.status ?? 1)
  }
}

run('Extension build', pnpmCommand, ['build'])
run('Desktop build', pnpmCommand, ['build:desktop'])
run('Desktop directory package', pnpmCommand, ['--filter', '@sift/desktop', 'package:dir'])

console.log('\n构建完成。下一步：')
console.log('  1. 运行 pnpm preflight')
console.log('  2. 仅在确认后运行 node tools/scripts/register-sift-native-host.mjs register')
console.log('  3. 按 RUNBOOK.md §5 开始 Chrome 捕获与主题 Demo')
