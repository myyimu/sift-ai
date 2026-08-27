#!/usr/bin/env node
// serve-fixtures.mjs —— 手动演示用静态服务器（RUNBOOK §手动演示）。
// 仅绑定 127.0.0.1、仅伺服 fixtures/pages/ 下的文件；Ctrl-C 退出。
// 背景：sanitizeUrl 只放行 http/https——file:// 打开的夹具页会被授权判定拒绝，
// 所以演示需要一个本地 HTTP 源。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, normalize } from 'node:path'

const root = fileURLToPath(new URL('../../fixtures/pages/', import.meta.url))
const port = Number(process.argv[2] ?? 8765)

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '')
  if (rel.includes('..') || rel === '') {
    res.statusCode = rel === '' ? 400 : 403
    res.end('bad request')
    return
  }
  try {
    const body = await readFile(join(root, rel))
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(body)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`fixtures/pages -> http://127.0.0.1:${port}/<name>.html（Ctrl-C 退出）`)
})
