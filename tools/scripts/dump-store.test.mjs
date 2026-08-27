// dump-store.test.mjs —— dump 工具回归：真实 store 产物 → 只读 dump 输出摘要，
// 且断言 html 正文绝不出现（只读 + 不泄密是本工具的两条硬约束）。
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { openSiftStore } from '../../packages/store/src/index.ts'
import { runNativeHostLoop } from '../../packages/host/src/host-loop.ts'
import { createCaptureProtocolHandler } from '../../packages/host/src/capture-protocol.ts'
import { FrameDecoder, encodeFrame } from '../../packages/host/src/framing.ts'

const SECRET_BODY = '绝不能出现在 dump 输出里的正文内容'

it('dump-store.mjs：摘要齐全且不打印 html 正文', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sift-dump-test-'))
  try {
    const store = await openSiftStore({ rootDir: dir })
    const hostIn = new PassThrough()
    const hostOut = new PassThrough()
    const capture = createCaptureProtocolHandler({ store })
    runNativeHostLoop({ stdin: hostIn, stdout: hostOut, onMessage: capture.onMessage })

    const decoder = new FrameDecoder()
    const encoder = new TextEncoder()
    hostOut.on('data', chunk => {
      for (const frame of decoder.push(new Uint8Array(chunk))) {
        const m = JSON.parse(new TextDecoder().decode(frame))
        if (m.type === 'error') throw new Error(`host error：${m.code}`)
      }
    })
    const send = message => hostIn.write(encodeFrame(encoder.encode(JSON.stringify(message))))

    const env = sequence => ({
      schemaVersion: 1,
      id: `obs-dump-${sequence}`,
      sessionId: 's-dump',
      tabId: '1',
      pageInstanceId: 'p-dump',
      contentEpoch: 0,
      sequence,
      receivedAt: new Date().toISOString(),
      url: 'https://example.com/a',
      source: 'dom',
      type: sequence === 1 ? 'dom_snapshot' : 'document_started',
      payloadRef: `sha256:${'a'.repeat(64)}`,
      payloadHash: `sha256:${'a'.repeat(64)}`,
      redactionPolicy: 'sensitive-v1',
      captureVersion: 'capture-v1',
    })
    const hashOf = text => `sha256:${createHash('sha256').update(text).digest('hex')}`

    const payload1 = JSON.stringify({
      schemaVersion: 1, kind: 'dom_snapshot', captureVersion: 'capture-v1', reason: 'initial_readable',
      url: 'https://example.com/a', title: '演示页', contentEpoch: 0,
      html: `<html><body><p>${SECRET_BODY.repeat(20)}</p></body></html>`,
      stats: { nodeCount: 5, maxDepth: 3, htmlUtf8Bytes: 300 },
    })
    const payload2 = JSON.stringify({
      schemaVersion: 1, kind: 'document_started', captureVersion: 'capture-v1',
      url: 'https://example.com/a', title: '演示页', instanceNonce: 'n1', sameOriginReinject: false,
    })

    send({ type: 'hello', protocolVersion: 1, client: 'sift-extension' })
    const h1 = hashOf(payload1)
    send({ type: 'announce', transferId: 't1', envelope: { ...env(1), payloadRef: h1, payloadHash: h1 }, payloadBytes: Buffer.byteLength(payload1), payloadHash: h1, chunkSize: 262144, chunkCount: 1 })
    send({ type: 'chunk', transferId: 't1', index: 0, chunkCount: 1, payloadHash: h1, dataB64: Buffer.from(payload1).toString('base64') })
    send({ type: 'commit', transferId: 't1', payloadHash: h1 })
    const h2 = hashOf(payload2)
    send({ type: 'announce', transferId: 't2', envelope: { ...env(2), payloadRef: h2, payloadHash: h2 }, payloadBytes: Buffer.byteLength(payload2), payloadHash: h2, chunkSize: 262144, chunkCount: 1 })
    send({ type: 'chunk', transferId: 't2', index: 0, chunkCount: 1, payloadHash: h2, dataB64: Buffer.from(payload2).toString('base64') })
    send({ type: 'commit', transferId: 't2', payloadHash: h2 })
    await new Promise(resolve => setTimeout(resolve, 300))
    hostIn.end()
    await store.close()

    const out = execFileSync(process.execPath, [join('tools', 'scripts', 'dump-store.mjs'), dir], { encoding: 'utf8' })
    expect(out).toContain('observations.jsonl：2 行')
    expect(out).toContain('dom_snapshot: 1')
    expect(out).toContain('document_started: 1')
    expect(out).toContain('page p-dump: 2 条，sequence 1..2')
    expect(out).toContain('page-states：1 个')
    expect(out).toContain('stateVersion=2 lastAppliedSequence=2')
    expect(out).toContain('title=演示页')
    expect(out).toContain('blobs：2 个')
    expect(out).toContain('store root:')
    // 硬约束：正文与完整 hash 不出现在输出
    expect(out).not.toContain(SECRET_BODY)
    expect(out).not.toContain(h1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
