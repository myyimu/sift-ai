// Native Host 状态租约（P0 UI 状态用）。
// 每个 connectNative 进程拥有独立租约；UI 只读扫描未过期租约，避免
// 一个 host 退出时误把其他并发 host 标记为断线。租约是诊断状态，不是捕获事实。
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const HOST_LEASE_TTL_MS = 15_000
const HEARTBEAT_MS = 5_000
const LEASE_FILE = /^host-([0-9a-f-]{36})\.json$/

export interface NativeHostStatus {
  readonly connected: boolean
  readonly activeLeases: number
  readonly checkedAt: string
}

interface HostLeaseDoc {
  readonly schemaVersion: 1
  readonly pid: number
  readonly startedAt: string
  readonly heartbeatAt: string
}

export interface NativeHostLease {
  readonly close: () => Promise<void>
}

async function writeLease(path: string, doc: HostLeaseDoc): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(doc)}\n`, 'utf8')
  await rename(tmp, path)
}

/** Host 启动后创建租约并持续心跳；close 幂等且尽力删除自身租约。 */
export async function createNativeHostLease(rootDir: string): Promise<NativeHostLease> {
  const dir = join(rootDir, 'host-leases')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `host-${randomUUID()}.json`)
  const startedAt = new Date().toISOString()
  let closed = false
  const heartbeat = async (): Promise<void> => {
    if (closed) return
    try {
      await writeLease(path, { schemaVersion: 1, pid: process.pid, startedAt, heartbeatAt: new Date().toISOString() })
    } catch {
      // Host 主协议仍由 stdin/stdout 驱动；租约写失败不能污染协议流。
    }
  }
  // 首次租约写入失败应让调用方决定是否启动 host；后续心跳失败按过期处理。
  await writeLease(path, { schemaVersion: 1, pid: process.pid, startedAt, heartbeatAt: startedAt })
  const timer = setInterval(() => { void heartbeat() }, HEARTBEAT_MS)
  timer.unref()
  return {
    close: async () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      await unlink(path).catch(() => undefined)
    },
  }
}

/** UI/诊断侧只读扫描租约；过期或损坏租约按断线处理，不做写入清理。 */
export async function getNativeHostStatus(rootDir: string, now = Date.now()): Promise<NativeHostStatus> {
  const dir = join(rootDir, 'host-leases')
  let names: readonly string[]
  try {
    names = await readdir(dir)
  } catch {
    return { connected: false, activeLeases: 0, checkedAt: new Date(now).toISOString() }
  }
  let activeLeases = 0
  for (const name of names) {
    if (!LEASE_FILE.test(name)) continue
    try {
      const doc = JSON.parse(await readFile(join(dir, name), 'utf8')) as Partial<HostLeaseDoc>
      if (doc.schemaVersion !== 1 || typeof doc.heartbeatAt !== 'string') continue
      const heartbeatAt = Date.parse(doc.heartbeatAt)
      if (Number.isFinite(heartbeatAt) && now - heartbeatAt <= HOST_LEASE_TTL_MS) activeLeases += 1
    } catch {
      // 半写/损坏租约只影响状态显示，不影响捕获事实。
    }
  }
  return { connected: activeLeases > 0, activeLeases, checkedAt: new Date(now).toISOString() }
}
