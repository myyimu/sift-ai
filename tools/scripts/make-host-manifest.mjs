// 生成 Chromium native messaging host manifest JSON（ADR-001 E-03）。
//
// 用法：
//   node tools/scripts/make-host-manifest.mjs --exe <Sift.exe 绝对路径> [--out <输出路径>]
// 不给 --out 时打印到 stdout（便于检查）。
//
// allowed_origins 只含固定 demo Extension ID；Chromium 要求 path 为绝对路径。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { NATIVE_HOST_ALLOWED_ORIGIN, NATIVE_HOST_NAME } from './sift-demo-constants.mjs'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--exe') out.exe = value
    else if (flag === '--out') out.out = value
    else {
      console.error(`unknown flag: ${flag}`)
      process.exit(2)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.exe) {
  console.error('usage: node make-host-manifest.mjs --exe <abs-path-to-Sift.exe> [--out <path>]')
  process.exit(2)
}

// 相对路径按 cwd 解析；Chromium 只接受绝对路径。
const exePath = isAbsolute(args.exe) ? args.exe : resolve(args.exe)

const manifest = {
  name: NATIVE_HOST_NAME,
  description: 'Sift AI P0 Demo Native Host (read-only observer)',
  path: exePath,
  type: 'stdio',
  allowed_origins: [NATIVE_HOST_ALLOWED_ORIGIN],
}

const json = JSON.stringify(manifest, null, 2) + '\n'
if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, json, 'utf8')
  console.error(`written: ${args.out}`)
} else {
  process.stdout.write(json)
}
