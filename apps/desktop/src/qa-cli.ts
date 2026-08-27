// qa-cli —— 问答链路的 node 直跑入口（E2E 与脚本化演示用；UI 是同一 qa-service 的
// 另一薄壳）。失败关闭：任何阶段失败都以真实 code 打 stderr 并非零退出。
//
// 纪律：API key 只认环境变量 SIFT_MODEL_API_KEY（不接受 CLI 参数——命令行会进
// shell 历史/进程列表）；--model-base-url/--model-id/--model-ctx 只是 env 的显式覆盖。
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  askModel,
  buildProjectionForScope,
  getStoreOverview,
  listAnswers,
  parseScope,
  resolveStoreRoot,
} from './qa-service'
import { loadModelConfig } from '@sift/model'

interface CliArgs {
  storeRoot?: string
  scope: string
  question: string
  out?: string
  modelBaseUrl?: string
  modelId?: string
  modelCtx?: string
  listAnswers: boolean
}

function usage(): string {
  return [
    '用法：node qa-cli.js --scope page:<pid>|session:<sid>|latest-session --question "问题" [选项]',
    '  --store-root <dir>     store 根目录（默认 SIFT_STORE_ROOT 或 %LOCALAPPDATA%\\Sift\\store）',
    '  --question <text>      要回答的问题（必填）',
    '  --out <path>           额外把答案 JSON 写到该路径（"-" = 打到 stdout）',
    '  --model-base-url <url> 覆盖 SIFT_MODEL_BASE_URL（仅 https 或本地 http）',
    '  --model-id <id>        覆盖 SIFT_MODEL_ID',
    '  --model-ctx <n>        覆盖 SIFT_MODEL_CTX（正整数 token 窗口）',
    '  --list-answers         列出已存答案后退出（不调用模型）',
  ].join('\n')
}

const VALUE_FLAGS = new Set(['--store-root', '--scope', '--question', '--out', '--model-base-url', '--model-id', '--model-ctx'])

function parseArgs(argv: readonly string[]): CliArgs | { error: string } {
  const args: CliArgs = { scope: '', question: '', listAnswers: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!
    if (flag === '--list-answers') {
      args.listAnswers = true
      continue
    }
    if (!VALUE_FLAGS.has(flag)) {
      return { error: `未知参数 ${flag}（或该 flag 不接受独立取值）\n${usage()}` }
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) return { error: `${flag} 缺少取值` }
    i += 1
    switch (flag) {
      case '--store-root': args.storeRoot = value; break
      case '--scope': args.scope = value; break
      case '--question': args.question = value; break
      case '--out': args.out = value; break
      case '--model-base-url': args.modelBaseUrl = value; break
      case '--model-id': args.modelId = value; break
      case '--model-ctx': args.modelCtx = value; break
    }
  }
  if (!args.listAnswers) {
    if (args.scope === '') return { error: `缺少 --scope\n${usage()}` }
    if (args.question.trim() === '') return { error: '缺少 --question' }
  }
  return args
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if ('error' in parsed) {
    process.stderr.write(`[qa-cli] 参数错误：${parsed.error}\n`)
    return 2
  }
  const rootDir = resolveStoreRoot(parsed.storeRoot)

  if (parsed.listAnswers) {
    for (const a of await listAnswers(rootDir)) {
      process.stderr.write(`${a.completedAt}  ${a.inputHash.slice(0, 16)}…  ${a.question} → ${a.answerPreview.slice(0, 60)}…\n`)
    }
    return 0
  }

  const env = {
    ...process.env,
    ...(parsed.modelBaseUrl !== undefined ? { SIFT_MODEL_BASE_URL: parsed.modelBaseUrl } : {}),
    ...(parsed.modelId !== undefined ? { SIFT_MODEL_ID: parsed.modelId } : {}),
    ...(parsed.modelCtx !== undefined ? { SIFT_MODEL_CTX: parsed.modelCtx } : {}),
  }
  const config = loadModelConfig(env)
  if (config.status !== 'ok') {
    process.stderr.write(`[qa-cli] 模型配置失败：${config.status}${'missing' in config ? `（缺 ${config.missing.join(', ')}）` : `（${config.reason}）`}\n`)
    return 3
  }

  const overview = await getStoreOverview(rootDir, env)
  const latest = overview.sessions.length > 0 ? overview.sessions[overview.sessions.length - 1]!.sessionId : undefined
  const scope = parseScope(parsed.scope, latest)
  if ('error' in scope) {
    process.stderr.write(`[qa-cli] ${scope.error}\n`)
    return 2
  }
  process.stderr.write(`[qa-cli] scope=${JSON.stringify(scope)} pages=${overview.pages.length} sessions=${overview.sessions.length}\n`)

  const built = await buildProjectionForScope(rootDir, scope, parsed.question, config.config.contextWindow)
  if (built.status === 'scope_not_found') {
    process.stderr.write(`[qa-cli] ${built.message}\n`)
    return 4
  }
  if (built.status === 'projection_empty') {
    process.stderr.write('[qa-cli] projection_empty：scope 内没有可投影的文本块（不发送空请求）\n')
    return 4
  }
  if (built.status === 'projection_input_invalid') {
    process.stderr.write(`[qa-cli] projection_input_invalid：${built.reason}\n`)
    return 4
  }
  if (built.status === 'projection_limit_exceeded') {
    process.stderr.write(
      `[qa-cli] projection_limit_exceeded：pages=${built.usage.pages} blocks=${built.usage.blocks} bytes=${built.usage.utf8Bytes} tokens≈${built.usage.estimatedTokens}（全量或不发送——请缩小 scope）\n`,
    )
    return 4
  }
  process.stderr.write(
    `[qa-cli] 投影就绪：pages=${built.preview.pages} blocks=${built.preview.blocks} bytes=${built.preview.utf8Bytes} tokens≈${built.preview.estimatedTokens} inputHash=${built.projection.inputHash.slice(0, 16)}…\n`,
  )

  const asked = await askModel(rootDir, built.projection, config.config)
  if (asked.status === 'failed') {
    process.stderr.write(`[qa-cli] 模型调用失败：${asked.result.code}：${asked.result.message}\n`)
    return 5
  }
  process.stderr.write(`[qa-cli] 答案已落盘：${resolve(asked.answerPath)}\n`)

  const doc = `${JSON.stringify(asked.answer, null, 2)}\n`
  if (parsed.out === '-') process.stdout.write(doc)
  else if (parsed.out !== undefined) await writeFile(resolve(parsed.out), doc, 'utf8')
  return 0
}

main().then(
  code => {
    process.exitCode = code
  },
  error => {
    process.stderr.write(`[qa-cli] 未预期失败：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`)
    process.exitCode = 1
  },
)
