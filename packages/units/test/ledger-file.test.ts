import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyUnitLedger } from '../src/ledger'
import { pruneSessionUnitLedgers, readUnitLedger, sessionUnitLedgerPath, unitLedgerPath, writeUnitLedger } from '../src/ledger-file'

describe('derived ledger file', () => {
  it('缺失返回空 ledger，写入使用 schemaVersion 和原子临时文件', async () => {
    const base = await mkdtemp(join(tmpdir(), 'sift-ledger-file-'))
    const path = unitLedgerPath(join(base, 'store'))
    expect((await readUnitLedger(path)).observations).toEqual([])
    await writeUnitLedger(path, emptyUnitLedger())
    expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(1)
    expect((await readUnitLedger(path)).versions).toEqual([])
    await rm(base, { recursive: true, force: true })
  })

  it('损坏文件 fail-closed', async () => {
    const base = await mkdtemp(join(tmpdir(), 'sift-ledger-file-'))
    const path = unitLedgerPath(join(base, 'store'))
    await writeUnitLedger(path, emptyUnitLedger())
    await (await import('node:fs/promises')).writeFile(path, '{bad', 'utf8')
    await expect(readUnitLedger(path)).rejects.toThrow('unit ledger 读取失败')
    await rm(base, { recursive: true, force: true })
  })

  it('Session ledger 路径只接受安全标识符并保持在 derived 目录', async () => {
    const base = await mkdtemp(join(tmpdir(), 'sift-ledger-file-'))
    const path = sessionUnitLedgerPath(join(base, 'store'), 'session_01')
    expect(path).toContain('derived')
    expect(path).toContain('session_01')
    expect(() => sessionUnitLedgerPath(join(base, 'store'), '..\\escape')).toThrow('sessionId 不适合作为派生文件名')
    await rm(base, { recursive: true, force: true })
  })

  it('全量重建后可清理已删除 Session 的派生文件', async () => {
    const base = await mkdtemp(join(tmpdir(), 'sift-ledger-file-'))
    const root = join(base, 'store')
    await writeUnitLedger(sessionUnitLedgerPath(root, 'keep'), emptyUnitLedger())
    await writeUnitLedger(sessionUnitLedgerPath(root, 'gone'), emptyUnitLedger())
    await pruneSessionUnitLedgers(root, new Set(['keep']))
    expect(await readUnitLedger(sessionUnitLedgerPath(root, 'keep'))).toEqual(emptyUnitLedger())
    await expect(readUnitLedger(sessionUnitLedgerPath(root, 'gone'))).resolves.toEqual(emptyUnitLedger())
    expect(await readdir(join(root, 'derived', 'sessions'))).toEqual(['keep'])
    await rm(base, { recursive: true, force: true })
  })
})
