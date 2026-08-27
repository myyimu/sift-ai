#!/usr/bin/env node
// dump-store.mjs —— SiftStore 只读摘要（RUNBOOK 手动演示验证用）。
//
// 用法：node tools/scripts/dump-store.mjs [storeRoot]
//   storeRoot 缺省 = %SIFT_STORE_ROOT% ?? %LOCALAPPDATA%\Sift\store
//
// 只读：不写任何文件。绝不打印 blob/html 正文——只输出 journal 行数/类型分布、
// page-state 摘要字段（url/title 截断展示）、blob 计数与字节、meta 记账。
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root =
  process.argv[2] ??
  process.env.SIFT_STORE_ROOT ??
  (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Sift', 'store') : null)

if (root === null) {
  console.error('用法：node tools/scripts/dump-store.mjs <storeRoot>（或设置 SIFT_STORE_ROOT / LOCALAPPDATA）')
  process.exit(1)
}

const cut = (text, max) => (text.length <= max ? text : `${text.slice(0, max)}…`)
const shortHash = (ref) => (typeof ref === 'string' ? `${ref.slice(0, 11)}…${ref.slice(-6)}` : '-')

let failed = false

// —— journal：行数 + 类型分布 + 会话/页实例摘要 ——
const journalPath = join(root, 'observations.jsonl')
try {
  const text = await readFile(journalPath, 'utf8')
  const rows = text.split('\n').filter(line => line !== '').map(line => JSON.parse(line))
  const byType = new Map()
  const sessions = new Set()
  const pages = new Map()
  for (const row of rows) {
    byType.set(row.type, (byType.get(row.type) ?? 0) + 1)
    sessions.add(row.sessionId)
    const page = pages.get(row.pageInstanceId) ?? { count: 0, minSeq: row.sequence, maxSeq: row.sequence }
    page.count += 1
    page.minSeq = Math.min(page.minSeq, row.sequence)
    page.maxSeq = Math.max(page.maxSeq, row.sequence)
    pages.set(row.pageInstanceId, page)
  }
  console.log(`== observations.jsonl：${rows.length} 行 ==`)
  for (const [type, count] of byType) console.log(`  ${type}: ${count}`)
  console.log(`  sessions: ${[...sessions].join(', ') || '-'}`)
  for (const [pid, page] of pages) {
    console.log(`  page ${pid}: ${page.count} 条，sequence ${page.minSeq}..${page.maxSeq}`)
  }
} catch (error) {
  console.error(`journal 读取失败（${error.code ?? error.message}）——store 尚未初始化或路径错误：${root}`)
  failed = true
}

// —— page-states：摘要字段（不含任何正文） ——
try {
  const files = (await readdir(join(root, 'page-states'))).filter(f => f.endsWith('.json'))
  console.log(`== page-states：${files.length} 个 ==`)
  for (const file of files) {
    const ps = JSON.parse(await readFile(join(root, 'page-states', file), 'utf8'))
    console.log(`  ${ps.pageInstanceId}: stateVersion=${ps.stateVersion} lastAppliedSequence=${ps.lastAppliedSequence}`)
    console.log(`    url=${cut(ps.canonicalUrl, 80)} title=${cut(ps.title, 40)}`)
    console.log(`    snapshotBlob=${shortHash(ps.sanitizedSnapshotBlobRef)} payloadHash=${shortHash(ps.payloadHash)} observations=${ps.observationCount}`)
    console.log(`    gaps=${ps.sequenceGaps?.length ?? 0}${ps.sequenceGapsTruncated ? '（已截断）' : ''} documentDirty=${ps.documentDirty === true} pendingTriggers=${ps.pendingTriggerCount ?? 0}`)
    if (ps.lastEventType !== undefined) console.log(`    lastEvent=${ps.lastEventType} @ ${ps.lastEventReceivedAt ?? '-'}`)
  }
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error(`page-states 读取失败：${error.code ?? error.message}`)
    failed = true
  }
}

// —— blobs：计数与字节（不读内容） ——
try {
  const shards = await readdir(join(root, 'blobs'))
  let count = 0
  let bytes = 0
  for (const shard of shards) {
    for (const file of await readdir(join(root, 'blobs', shard))) {
      count += 1
      bytes += (await readFile(join(root, 'blobs', shard, file))).length
    }
  }
  console.log(`== blobs：${count} 个，共 ${(bytes / 1024).toFixed(1)} KiB（${shards.length} 个分片目录）==`)
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error(`blobs 读取失败：${error.code ?? error.message}`)
    failed = true
  }
}

// —— meta：记账缓存 ——
try {
  const meta = JSON.parse(await readFile(join(root, 'meta.json'), 'utf8'))
  console.log('== meta.json ==')
  console.log(`  observations=${meta.observationCount} globalBytes=${(meta.globalBytes / 1024).toFixed(1)} KiB sessions=${meta.sessions?.length ?? 0} updatedAt=${meta.updatedAt ?? '-'}`)
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error(`meta 读取失败：${error.code ?? error.message}`)
    failed = true
  }
}

console.log(`store root: ${root}`)
process.exit(failed ? 1 : 0)
