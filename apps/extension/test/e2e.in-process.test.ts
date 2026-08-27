// e2e.in-process.test.ts —— 零 Chrome 全链路（步骤 6 验证门）：
//   linkedom 夹具 → capture（真实脱敏） → transport（真实状态机）
//   → PassThrough 双向流 → 真实 host-loop（runNativeHostLoop + createCaptureProtocolHandler）
//   → 真实 FsStore（临时目录） → 断言 blob/journal/page-state。
// 再全量重放：同 envelope.id 全部 deduplicated，blob 数不变（journal 幂等 = 崩溃恢复语义）。
// 真实定时器驱动（无 fake timers），事件流全异步，用 waitFor 轮询。
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { parseHTML } from 'linkedom'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FrameDecoder, encodeFrame } from '@sift/host/framing'
import { runNativeHostLoop } from '@sift/host/host-loop'
import { createCaptureProtocolHandler } from '@sift/host/capture-protocol'
import { openSiftStore, type SiftFsStore } from '@sift/store'
import type { ObservationEnvelope, ObservationType } from '@sift/shared'
import { CAPTURE_VERSION, REDACTION_POLICY } from '@sift/shared/wire'
import { captureDomSnapshot } from '../src/capture'
import {
  createCaptureTransport,
  subtleSha256Hex,
  type CaptureTransport,
  type NativePortLike,
  type PendingObservation,
} from '../src/transport'
import { deriveCoverageManifest, projectQuestion, type ManifestFacts, type ManifestObservation } from '@sift/projector'
import { questionProjectionSchema } from '@sift/shared'

// —— 测试装置 ——

const PAGE_URL = 'https://example.com/docs/big-article?id=9&token=leak-me'

interface HostHarness {
  readonly port: NativePortLike
  /** host → extension 的全部响应消息（按到达序）。 */
  readonly received: unknown[]
  /** onFatal 收到的异常（正常应为空）。 */
  readonly fatalErrors: unknown[]
  teardown(): void
}

function createHostHarness(store: SiftFsStore): HostHarness {
  const hostIn = new PassThrough() // extension → host（对应 host stdin）
  const hostOut = new PassThrough() // host → extension（对应 host stdout）
  const fatalErrors: unknown[] = []
  const capture = createCaptureProtocolHandler({ store })
  const teardownLoop = runNativeHostLoop({
    stdin: hostIn,
    stdout: hostOut,
    onMessage: capture.onMessage,
    onFatal: error => {
      fatalErrors.push(error)
    },
  })

  const received: unknown[] = []
  const decoder = new FrameDecoder()
  const encoder = new TextEncoder()
  const listeners: ((message: unknown) => void)[] = []
  hostOut.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(new Uint8Array(chunk))) {
      const message = JSON.parse(new TextDecoder().decode(frame)) as unknown
      received.push(message)
      for (const listener of listeners) listener(message)
    }
  })

  const port: NativePortLike = {
    send: message => {
      hostIn.write(encodeFrame(encoder.encode(JSON.stringify(message))))
    },
    disconnect: () => {
      hostIn.end()
    },
    onMessage: { addListener: cb => listeners.push(cb) },
    onDisconnect: { addListener: () => {} }, // in-process host 不会主动关 stdout
  }

  return {
    port,
    received,
    fatalErrors,
    teardown: () => {
      teardownLoop()
      hostIn.end()
      if (fatalErrors.length > 0) throw new Error(`host loop fatal: ${String(fatalErrors[0])}`)
    },
  }
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 8000,
  diagnose?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor 超时：${what}${diagnose !== undefined ? `\n诊断：${diagnose()}` : ''}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** 大文档：正文约 0.5 MiB，跨 NATIVE_MAX_CHUNK_BYTES(256KiB) 成 2+ 块。 */
function buildBigDoc(): Document {
  const { document } = parseHTML('<html><head><title>大文档</title></head><body><main><h1>大文档</h1></main></body></html>')
  const main = document.querySelector('main')!
  const para = '本段是用于跨块传输与落盘校验的正文内容，重复填充以超过单个分块上限。'.repeat(120)
  for (let i = 0; i < 120; i += 1) {
    const p = document.createElement('p')
    p.textContent = `${i}：${para}`
    main.appendChild(p)
  }
  return document
}

const PAGE_ID = 'p-e2e-1'

let seq = 0

function envelope(type: ObservationType, source: ObservationEnvelope['source']): ObservationEnvelope {
  return {
    schemaVersion: 1,
    id: `obs-e2e-${(seq += 1)}`,
    sessionId: 's-e2e',
    tabId: '7',
    pageInstanceId: PAGE_ID,
    contentEpoch: 0,
    sequence: seq - 1,
    receivedAt: new Date().toISOString(),
    url: 'https://example.com/docs/big-article?id=9',
    source,
    type,
    payloadRef: `sha256:${'0'.repeat(64)}`,
    payloadHash: `sha256:${'0'.repeat(64)}`,
    redactionPolicy: REDACTION_POLICY,
    captureVersion: CAPTURE_VERSION,
  }
}

function observation(type: ObservationType, payloadJson: string, source: ObservationEnvelope['source']): PendingObservation {
  return {
    envelope: envelope(type, source),
    payloadJson,
    transferId: `t-${seq}`,
    kind: type === 'dom_snapshot' ? 'dom_snapshot' : 'control',
  }
}

function countBlobs(shards: string[]): number {
  return shards.length
}

// —— 用例 ——

describe('in-process 全链路', () => {
  let rootDir: string

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'sift-e2e-'))
  })
  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true })
  })

  it('授权 → 脱敏快照（跨块）→ 撤销：blob/journal/page-state 落盘', { timeout: 60000 }, async () => {
    const store = await openSiftStore({ rootDir })
    const harness = createHostHarness(store)
    const transport: CaptureTransport = createCaptureTransport({
      connectNative: () => harness.port,
      sha256Hex: subtleSha256Hex,
    })

    // SW 视角的三条观察：控制事件 → 大快照 → 控制事件
    const granted = observation(
      'authorization_granted',
      JSON.stringify({
        schemaVersion: 1, kind: 'authorization_granted', captureVersion: CAPTURE_VERSION,
        url: 'https://example.com/docs/big-article?id=9', reason: 'user_gesture', origin: 'https://example.com',
      }),
      'extension',
    )
    const doc = buildBigDoc()
    const snapOutcome = captureDomSnapshot(doc, {
      url: PAGE_URL, // 含 token 参数：快照 payload.url 必须已剔除
      title: '大文档',
      contentEpoch: 0,
      reason: 'initial_readable',
    })
    if (!snapOutcome.ok) throw new Error(`快照失败：${snapOutcome.code}`)
    expect(snapOutcome.payload.stats.htmlUtf8Bytes).toBeGreaterThan(256 * 1024) // 确认跨块
    const snapshot = observation('dom_snapshot', snapOutcome.payloadJson, 'dom')
    const revoked = observation(
      'authorization_revoked',
      JSON.stringify({
        schemaVersion: 1, kind: 'authorization_revoked', captureVersion: CAPTURE_VERSION,
        url: 'https://example.com/docs/big-article?id=9', reason: 'tab_closed',
      }),
      'extension',
    )

    transport.enqueue(granted)
    transport.enqueue(snapshot)
    transport.enqueue(revoked)
    await waitFor(
      () => transport.queueSize === 0,
      '三条观察全部 commit',
      20000,
      () =>
        `state=${transport.state} fatal=${JSON.stringify(harness.fatalErrors.map(String))} received=${JSON.stringify(harness.received.map(m => (m as { type?: string; status?: string; index?: number }).type ?? m))}`,
    )

    // host 无失败关闭
    harness.teardown()
    await store.close()

    // journal：3 行，类型齐全
    const journalText = (await readFile(join(rootDir, 'observations.jsonl'), 'utf8')).trim()
    const lines = journalText.split('\n')
    expect(lines.length).toBe(3)
    const types = lines.map(l => (JSON.parse(l) as { type: string }).type)
    expect(types).toEqual(['authorization_granted', 'dom_snapshot', 'authorization_revoked'])

    // blob：内容寻址落盘，字节与 payload 一致
    const payloadHash = `sha256:${createHash('sha256').update(new TextEncoder().encode(snapOutcome.payloadJson)).digest('hex')}`
    const hex = payloadHash.slice('sha256:'.length)
    const blobBytes = await readFile(join(rootDir, 'blobs', hex.slice(0, 2), hex))
    expect(new TextDecoder().decode(blobBytes)).toBe(snapOutcome.payloadJson)
    expect(snapOutcome.payload.url).toBe('https://example.com/docs/big-article?id=9') // token 已剔除

    // page-state：快照字段替换、序列推进、无 gap
    const pageState = JSON.parse((await readFile(join(rootDir, 'page-states', `${PAGE_ID}.json`), 'utf8')).toString()) as {
      lastAppliedSequence: number
      canonicalUrl: string
      title: string
      sanitizedSnapshotBlobRef: string
      payloadHash: string
      sourceObservationId: string
      sequenceGaps: unknown[]
      observationCount: number
    }
    expect(pageState.lastAppliedSequence).toBe(2)
    expect(pageState.canonicalUrl).toBe('https://example.com/docs/big-article?id=9')
    expect(pageState.title).toBe('大文档')
    expect(pageState.sanitizedSnapshotBlobRef).toBe(payloadHash)
    expect(pageState.payloadHash).toBe(payloadHash)
    expect(pageState.sourceObservationId).toBe(snapshot.envelope.id)
    expect(pageState.sequenceGaps).toEqual([])
    expect(pageState.observationCount).toBe(3)

    // 重放：同 envelope.id 全部 deduplicated，blob 数不变
    const blobDir = join(rootDir, 'blobs')
    const shardsBefore = await readdir(blobDir)
    const blobCountBefore = countBlobs(shardsBefore)

    const store2 = await openSiftStore({ rootDir })
    const harness2 = createHostHarness(store2)
    const transport2 = createCaptureTransport({
      connectNative: () => harness2.port,
      sha256Hex: subtleSha256Hex,
    })
    // 重放使用全新 transferId（模拟 SW 重启后重发同观察）
    transport2.enqueue({ ...granted, transferId: 't-replay-1' })
    transport2.enqueue({ ...snapshot, transferId: 't-replay-2' })
    transport2.enqueue({ ...revoked, transferId: 't-replay-3' })
    await waitFor(() => transport2.queueSize === 0, '重放三条全部去重')

    const dedups = harness2.received.filter(
      m => (m as { type?: string; status?: string }).type === 'transfer_ack' && (m as { status?: string }).status === 'deduplicated',
    )
    expect(dedups.length).toBe(3)
    expect((await readFile(join(rootDir, 'observations.jsonl'), 'utf8')).trim().split('\n').length).toBe(3)

    const blobCountAfter = countBlobs(await readdir(blobDir))
    expect(blobCountBefore).toBeGreaterThan(0)
    expect(blobCountAfter).toBe(blobCountBefore)

    harness2.teardown()
    await store2.close()
  })

  it('敏感夹具走真实管线：contenteditable 页在源端失败关闭，不产生任何 host 帧', async () => {
    const pagesDir = fileURLToPath(new URL('../../../fixtures/pages/', import.meta.url))
    const { document } = parseHTML(await readFile(`${pagesDir}contenteditable-editor.html`, 'utf8').then(b => b.toString()))
    const outcome = captureDomSnapshot(document, {
      url: 'https://example.com/notes',
      title: '在线笔记编辑器',
      contentEpoch: 0,
      reason: 'initial_readable',
    })
    expect(outcome).toMatchObject({ ok: false, code: 'capture_too_little_content' })
    // 源端失败 → 无快照可传；capture_failed 的持久化走 SW 管线（见下一用例与 service-worker.test.ts）
  })

  it('capture_failed 持久化 + 读 API 组装投影：store 读出 → manifest → projectQuestion 全链 ok', { timeout: 60000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sift-e2e-pj-'))
    try {
      const store = await openSiftStore({ rootDir: root })
      const harness = createHostHarness(store)
      const transport: CaptureTransport = createCaptureTransport({
        connectNative: () => harness.port,
        sha256Hex: subtleSha256Hex,
      })

      const granted = observation(
        'authorization_granted',
        JSON.stringify({
          schemaVersion: 1, kind: 'authorization_granted', captureVersion: CAPTURE_VERSION,
          url: 'https://example.com/article', reason: 'user_gesture', origin: 'https://example.com',
        }),
        'extension',
      )
      const { document } = parseHTML(
        '<html><head><title>投影文章</title></head><body><main><h1>投影文章标题</h1><p>这是用于投影全链验证的正文段落，长度超过二十个非空白字符，满足 readable-v1 的最低可读要求。</p><p>第二段正文内容，同样超过最低门槛，用于验证块生成与确定性排序。</p><p>第三段补充正文，确保删噪后的非空白字符总数超过八十个的快照门槛。</p></main></body></html>',
      )
      const snapOutcome = captureDomSnapshot(document, {
        url: 'https://example.com/article?page=2',
        title: '投影文章',
        contentEpoch: 0,
        reason: 'initial_readable',
      })
      if (!snapOutcome.ok) throw new Error(`快照失败：${snapOutcome.code}`)
      const snapshot = observation('dom_snapshot', snapOutcome.payloadJson, 'dom')
      const failed = observation(
        'capture_failed',
        JSON.stringify({
          schemaVersion: 1, kind: 'capture_failed', captureVersion: CAPTURE_VERSION,
          code: 'capture_too_little_content', instanceNonce: 'nonce-e2e-1', contentEpoch: 1,
        }),
        'extension',
      )

      transport.enqueue(granted)
      transport.enqueue(snapshot)
      transport.enqueue(failed)
      await waitFor(() => transport.queueSize === 0, '三条观察全部 commit', 20000)
      harness.teardown()
      await store.close()

      // —— 读侧：readOnly 打开，读 API 组装 ManifestFacts ——
      const reader = await openSiftStore({ rootDir: root, readOnly: true })
      const journal = await reader.readJournal()
      expect(journal.map(r => r.type)).toEqual(['authorization_granted', 'dom_snapshot', 'capture_failed'])

      const failedRow = journal.find(r => r.type === 'capture_failed')!
      const failedBytes = await reader.readBlob(failedRow.payloadHash)
      expect(JSON.parse(new TextDecoder().decode(failedBytes))).toEqual({
        schemaVersion: 1, kind: 'capture_failed', captureVersion: CAPTURE_VERSION,
        code: 'capture_too_little_content', instanceNonce: 'nonce-e2e-1', contentEpoch: 1,
      }) // 持久 payload 无 detail、无页面内容（spec §9）

      const pages = await reader.listPages()
      expect(pages).toHaveLength(1)
      const page = pages[0]!

      // 控制事件 payload 从 blob 解码（dom_snapshot 置 null——正文不进 manifest）
      const controlPayloads = new Map<string, unknown>()
      for (const r of journal) {
        if (r.type === 'dom_snapshot') continue
        const bytes = await reader.readBlob(r.payloadHash)
        controlPayloads.set(r.id, JSON.parse(new TextDecoder().decode(bytes)))
      }

      const facts: ManifestFacts = {
        scope: { kind: 'demo_session', sessionId: 's-e2e' },
        observations: journal.map((r): ManifestObservation => ({
          id: r.id,
          sessionId: r.sessionId,
          tabId: r.tabId,
          pageInstanceId: r.pageInstanceId,
          sequence: r.sequence,
          receivedAt: r.receivedAt,
          url: r.url,
          type: r.type,
          controlPayload: r.type === 'dom_snapshot' ? null : controlPayloads.get(r.id) ?? null,
        })),
        pageStates: [{
          pageInstanceId: page.pageInstanceId,
          stateVersion: page.watermark.stateVersion,
          lastAppliedSequence: page.watermark.lastAppliedSequence,
          canonicalUrl: page.canonicalUrl,
        }],
      }

      const manifest = deriveCoverageManifest({ ...facts, unitCount: 0 })
      expect(manifest.partialExtractionCount).toBe(1)
      expect(manifest.knownMissingReasons).toContain('capture_failure')
      expect(manifest.knownMissingReasons).toContain('editor_page_dropped')
      expect(manifest.visitedPagination).toEqual([
        { origin: 'https://example.com', path: '/article', observedSelectors: ['page=2'], observedCount: 1, exhausted: false },
      ])
      expect(manifest.knownMissingReasons).toContain('unvisited_pagination')

      // —— 投影：readSnapshotPayload 取真实脱敏 HTML → projectQuestion ——
      const snapRow = journal.find(r => r.type === 'dom_snapshot')!
      const payload = await reader.readSnapshotPayload(snapRow.payloadHash)
      const result = projectQuestion({
        question: '这篇投影文章的结论是什么？',
        scope: 'demo_session',
        pages: [{
          sanitizedHtml: payload.html,
          source: {
            pageInstanceId: page.pageInstanceId,
            stateVersion: page.watermark.stateVersion,
            ordinal: 0,
            ...(payload.title !== '' ? { title: payload.title } : {}),
            safeUrl: payload.url,
            capturedAt: snapRow.receivedAt,
          },
        }],
        manifestFacts: facts,
        modelContextWindow: 128_000,
      })
      expect(result.status).toBe('ok')
      if (result.status !== 'ok') return
      expect(questionProjectionSchema.safeParse(result.projection).success).toBe(true)
      expect(result.projection.blocks.map(b => b.kind)).toEqual(['heading', 'paragraph', 'paragraph', 'paragraph'])
      expect(result.projection.coverage.partialExtractionCount).toBe(1)
      expect(result.projection.coverage.unitCount).toBe(4)
      await reader.close()
    } finally {
      // Windows：句柄释放/Defender 扫描与删除有竞态——临时目录清理属 best-effort，失败不失败用例
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
    }
  })
})
