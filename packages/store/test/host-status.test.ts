import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_LEASE_TTL_MS, createNativeHostLease, getNativeHostStatus } from '../src/host-status'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('native host status lease', () => {
  it('并发租约存在时报告 connected，关闭最后一个租约后断开', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sift-host-status-'))
    roots.push(root)
    const first = await createNativeHostLease(root)
    const second = await createNativeHostLease(root)
    await expect(getNativeHostStatus(root)).resolves.toMatchObject({ connected: true, activeLeases: 2 })
    await first.close()
    await expect(getNativeHostStatus(root)).resolves.toMatchObject({ connected: true, activeLeases: 1 })
    await second.close()
    await expect(getNativeHostStatus(root)).resolves.toMatchObject({ connected: false, activeLeases: 0 })
  })

  it('过期租约不算连接', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sift-host-status-'))
    roots.push(root)
    const lease = await createNativeHostLease(root)
    const now = Date.now() + HOST_LEASE_TTL_MS + 1
    await expect(getNativeHostStatus(root, now)).resolves.toMatchObject({ connected: false, activeLeases: 0 })
    await lease.close()
  })
})
