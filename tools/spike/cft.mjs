// cft.mjs —— Chrome 获取的共用工具（从 run-chrome-e2e.mjs 抽出，Phase 3 全链 E2E 复用）：
//   findChrome()        本机品牌稳定版 chrome.exe（找不到时进程退出——脚本级工具语义）
//   ensureCft()         Chrome for Testing 自动下载（npmmirror 镜像 -> tools/.cache/cft）
// 行为与抽取前逐字一致（run-chrome-e2e.mjs 改为从这里 import）。
import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const CFT_DIR = resolve(join('tools', '.cache', 'cft'))
export const CFT_MIRROR = 'https://registry.npmmirror.com/-/binary/chrome-for-testing'

export function findChrome() {
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
export function findChromeExeUnder(dir) {
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

/** Chrome for Testing：npmmirror 镜像自动下载（优先与本机 Chrome 同大版本）。 */
export async function ensureCft() {
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
