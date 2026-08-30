// TopicProjection cache 与 freshness marker 的文件边界。
// marker 只记录原因和时间，不包含网页正文、URL 或任何捕获数据。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

export const TOPIC_CACHE_SCHEMA_VERSION = 1
export interface TopicStaleMarker {
  readonly schemaVersion: 1
  readonly reason: 'capture_changed' | 'data_deleted' | 'manual'
  readonly markedAt: string
}

export function topicCacheDir(storeRoot: string): string {
  return join(dirname(resolve(storeRoot)), 'topics')
}

export function topicStaleMarkerPath(storeRoot: string): string {
  return join(topicCacheDir(storeRoot), 'stale.json')
}

export async function markTopicCachesStale(
  storeRoot: string,
  reason: TopicStaleMarker['reason'] = 'capture_changed',
  markedAt = new Date().toISOString(),
): Promise<void> {
  const path = topicStaleMarkerPath(storeRoot)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`
  const marker: TopicStaleMarker = { schemaVersion: TOPIC_CACHE_SCHEMA_VERSION, reason, markedAt }
  await writeFile(temp, `${JSON.stringify(marker)}\n`, 'utf8')
  await rename(temp, path)
}

export async function hasStaleTopicCaches(storeRoot: string): Promise<boolean> {
  return (await readTopicStaleMarker(storeRoot)) !== null
}

export async function readTopicStaleMarker(storeRoot: string): Promise<TopicStaleMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(topicStaleMarkerPath(storeRoot), 'utf8')) as Partial<TopicStaleMarker>
    if (parsed.schemaVersion === TOPIC_CACHE_SCHEMA_VERSION && typeof parsed.markedAt === 'string' && (parsed.reason === 'capture_changed' || parsed.reason === 'data_deleted' || parsed.reason === 'manual')) return parsed as TopicStaleMarker
    return { schemaVersion: TOPIC_CACHE_SCHEMA_VERSION, reason: 'manual', markedAt: new Date(0).toISOString() }
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { schemaVersion: TOPIC_CACHE_SCHEMA_VERSION, reason: 'manual', markedAt: new Date(0).toISOString() }
  }
}

export async function clearTopicCachesStaleBefore(storeRoot: string, cutoff: string): Promise<void> {
  const marker = await readTopicStaleMarker(storeRoot)
  if (marker !== null && marker.markedAt <= cutoff) await clearTopicCachesStale(storeRoot)
}

export async function clearTopicCachesStale(storeRoot: string): Promise<void> {
  await rm(topicStaleMarkerPath(storeRoot), { force: true })
}

export async function invalidateTopicCaches(storeRoot: string): Promise<void> {
  await rm(topicCacheDir(storeRoot), { recursive: true, force: true })
}
