import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ObservationEnvelope } from '@sift/shared'
import { CAPTURE_VERSION, REDACTION_POLICY } from '@sift/shared/wire'
import { openSiftStore, type SiftFsStore } from '@sift/store'
import { extractUnitsForScope } from '../src/qa-service'
import { generateTopicProjection, previewTopicProjection, topicDetail } from '../src/topic-service'
import type { ModelConfig } from '@sift/model'
import { markTopicCachesStale, topicCacheDir } from '@sift/topics'

function hash(text: string): string { return `sha256:${createHash('sha256').update(text).digest('hex')}` }
function envelope(id: string, sequence: number, payloadHash: string): ObservationEnvelope {
  return { schemaVersion: 1, id, sessionId: 'session-1', tabId: 'tab-1', pageInstanceId: 'page-1', contentEpoch: 0, sequence, receivedAt: `2026-08-30T00:00:0${sequence}.000Z`, url: 'https://example.com/article', source: 'extension', type: sequence === 0 ? 'authorization_granted' : 'dom_snapshot', payloadRef: payloadHash, payloadHash, redactionPolicy: REDACTION_POLICY, captureVersion: CAPTURE_VERSION }
}
function payload(html: string): Uint8Array { return new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, kind: 'dom_snapshot', captureVersion: CAPTURE_VERSION, reason: 'initial_readable', url: 'https://example.com/article', title: '示例文章', contentEpoch: 0, html, stats: { nodeCount: 3, maxDepth: 3, htmlUtf8Bytes: html.length } })) }

describe('on-demand TopicProjection service', () => {
  it('rejects malformed or reversed time ranges before reading the store', async () => {
    const config: ModelConfig = { baseUrl: 'http://127.0.0.1:9', origin: 'http://127.0.0.1:9', apiKey: 'test-key', model: 'topic-model', contextWindow: 128000 }
    const reversed = await generateTopicProjection('missing-store', { kind: 'demo_session', sessionId: 'missing' }, { from: '2026-08-31T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' }, config)
    expect(reversed).toMatchObject({ status: 'invalid_range' })
    const malformed = await generateTopicProjection('missing-store', { kind: 'demo_session', sessionId: 'missing' }, { from: '2026-08-30', to: '2026-08-31T00:00:00.000Z' }, config)
    expect(malformed).toMatchObject({ status: 'invalid_range' })
  })

  it('生成只发生在显式调用，且相同输入命中缓存', async () => {
    const base = await mkdtemp(join(tmpdir(), 'sift-topic-'))
    const root = join(base, 'store')
    let writer: SiftFsStore | null = await openSiftStore({ rootDir: root })
    const html = '<html><body><article><h1>本地优先</h1><p>这是一段足够长的正文，用于测试按需主题归纳与证据引用校验。</p></article></body></html>'
    const snap = payload(html)
    const snapHash = hash(new TextDecoder().decode(snap))
    await writer.appendObservation(envelope('grant-1', 0, hash('{"grant":true}')), new TextEncoder().encode('{"grant":true}'))
    await writer.appendObservation(envelope('snapshot-1', 1, snapHash), snap)
    await writer.close(); writer = null
    const extracted = await extractUnitsForScope(root, { kind: 'demo_session', sessionId: 'session-1' })
    expect(extracted.status).toBe('ok')
    if (extracted.status !== 'ok') return
    const block = extracted.evidenceBlocks[0]!
    let calls = 0
    const config: ModelConfig = { baseUrl: 'http://127.0.0.1:9', origin: 'http://127.0.0.1:9', apiKey: 'test-key', model: 'topic-model', contextWindow: 128000 }
    const fetchImpl = async (): Promise<Response> => {
      calls += 1
      return { ok: true, status: 200, redirected: false, json: async () => ({ choices: [{ message: { content: JSON.stringify({ topics: [{ topicId: 't1', label: '本地优先处理', aliases: [], summary: '证据讨论本地优先处理。', canonicalUnitRefs: [extracted.canonicalUnits[0]!.id], evidenceBlockRefs: [block.id] }] }) } }] }), text: async () => '' } as unknown as Response
    }
    const range = { from: '2026-08-29T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z' }
    const first = await generateTopicProjection(root, { kind: 'demo_session', sessionId: 'session-1' }, range, config, fetchImpl)
    expect(first.status).toBe('ok')
    expect(calls).toBe(1)
    if (first.status !== 'ok') return
    expect(first.stats).toMatchObject([{ topicId: 't1', unitCount: 1, pageCount: 1 }])
    const detail = await topicDetail(root, { kind: 'demo_session', sessionId: 'session-1' }, first.projection, 't1')
    expect(detail.status).toBe('ok')
    const tampered = await topicDetail(root, { kind: 'demo_session', sessionId: 'session-1' }, { ...first.projection, scope: { ...first.projection.scope, evidenceBlockRefs: [] } }, 't1')
    expect(tampered.status).toBe('topic_not_found')
    const second = await generateTopicProjection(root, { kind: 'demo_session', sessionId: 'session-1' }, range, config, fetchImpl)
    expect(second.status).toBe('ok')
    expect(second.status === 'ok' && second.cacheHit).toBe(true)
    expect(second.status === 'ok' && second.stats[0]?.unitCount).toBe(1)
    expect(calls).toBe(1)
    const cachePath = join(topicCacheDir(root), `${first.preview.inputHash.slice('sha256:'.length)}.json`)
    const cached = JSON.parse(await readFile(cachePath, 'utf8')) as { projection: typeof first.projection }
    await writeFile(cachePath, JSON.stringify({ schemaVersion: 1, inputHash: first.preview.inputHash, preview: first.preview, projection: { ...cached.projection, scope: { ...cached.projection.scope, evidenceBlockRefs: [] } } }), 'utf8')
    const corrupted = await generateTopicProjection(root, { kind: 'demo_session', sessionId: 'session-1' }, range, config, fetchImpl)
    expect(corrupted.status).toBe('ok')
    expect(corrupted.status === 'ok' && corrupted.cacheHit).toBe(false)
    expect(calls).toBe(2)
    await markTopicCachesStale(root, 'capture_changed', '2026-08-30T00:00:10.000Z')
    const third = await generateTopicProjection(root, { kind: 'demo_session', sessionId: 'session-1' }, range, config, fetchImpl)
    expect(third.status).toBe('ok')
    expect(third.status === 'ok' && third.cacheHit).toBe(false)
    expect(calls).toBe(3)
    await rm(base, { recursive: true, force: true })
  })

  it('时间范围比较按绝对时间而不是时区字符串排序', async () => {
    const base = await mkdtemp(join(tmpdir(), 'sift-topic-range-'))
    const root = join(base, 'store')
    const writer = await openSiftStore({ rootDir: root })
    const html = '<html><body><article><h1>时区范围</h1><p>这是一段足够长的正文，用于验证带不同偏移量的时间范围仍能正确包含观察。</p></article></body></html>'
    const snap = payload(html)
    const snapHash = hash(new TextDecoder().decode(snap))
    await writer.appendObservation(envelope('grant-range', 0, hash('{"grant":true}')), new TextEncoder().encode('{"grant":true}'))
    await writer.appendObservation(envelope('snapshot-range', 1, snapHash), snap)
    await writer.close()
    const extracted = await extractUnitsForScope(root, { kind: 'demo_session', sessionId: 'session-1' })
    expect(extracted.status).toBe('ok')
    const range = { from: '2026-08-30T08:00:00+08:00', to: '2026-08-30T09:00:00+08:00' }
    const preview = await previewTopicProjection(root, { kind: 'demo_session', sessionId: 'session-1' }, range)
    expect(preview.status).toBe('ok')
    await rm(base, { recursive: true, force: true })
  })
})
