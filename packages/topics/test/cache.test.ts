import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clearTopicCachesStale, hasStaleTopicCaches, markTopicCachesStale, topicStaleMarkerPath } from '../src/cache'

describe('topic cache freshness marker', () => {
  it('writes a data-free marker atomically and clears it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sift-topic-cache-'))
    expect(await hasStaleTopicCaches(root)).toBe(false)
    await markTopicCachesStale(root, 'capture_changed', '2026-08-30T00:00:00.000Z')
    expect(await hasStaleTopicCaches(root)).toBe(true)
    expect(JSON.parse(await readFile(topicStaleMarkerPath(root), 'utf8'))).toEqual({ schemaVersion: 1, reason: 'capture_changed', markedAt: '2026-08-30T00:00:00.000Z' })
    await clearTopicCachesStale(root)
    expect(await hasStaleTopicCaches(root)).toBe(false)
  })
})
