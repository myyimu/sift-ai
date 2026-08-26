import { describe, expect, it } from 'vitest'
import {
  DEBOUNCE_MS,
  EXTENSION_ID,
  GLOBAL_QUOTA_BYTES,
  MAX_BLOCKS,
  MAX_PAGES,
  MAX_PROJECTION_UTF8_BYTES,
  MAX_WAIT_MS,
  MIN_BLOCK_CHARS,
  NATIVE_MAX_CHUNK_BYTES,
  NATIVE_HOST_ALLOWED_ORIGIN,
  READABLE_MIN_CHARS,
  READABLE_WAIT_MS,
  SESSION_QUOTA_BYTES,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_DEPTH,
  SNAPSHOT_MAX_NODES,
  TOKEN_CTX_RESERVE,
  TOKEN_LIMIT_CAP,
  TTL_DAYS,
  projectionTokenLimit,
} from '../src/limits'

// 数值直接抄自 P0_DEMO_SCOPE.md / ADR-001 冻结值；这里断言的不是“代码没写错”，
// 而是“没有人静默改掉规范参数”（P0_DEMO_SCOPE §2.2“不得静默放宽”）。
describe('frozen demo limits', () => {
  it('capture 参数', () => {
    expect(DEBOUNCE_MS).toBe(200)
    expect(MAX_WAIT_MS).toBe(2000)
    expect(SNAPSHOT_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(SNAPSHOT_MAX_NODES).toBe(50_000)
    expect(SNAPSHOT_MAX_DEPTH).toBe(128)
    expect(READABLE_MIN_CHARS).toBe(80)
    expect(READABLE_WAIT_MS).toBe(5000)
  })

  it('native messaging 与存储配额', () => {
    expect(NATIVE_MAX_CHUNK_BYTES).toBe(256 * 1024)
    expect(TTL_DAYS).toBe(7)
    expect(SESSION_QUOTA_BYTES).toBe(250 * 1024 * 1024)
    expect(GLOBAL_QUOTA_BYTES).toBe(1024 * 1024 * 1024)
  })

  it('projection 上限', () => {
    expect(MAX_PAGES).toBe(20)
    expect(MAX_BLOCKS).toBe(200)
    expect(MAX_PROJECTION_UTF8_BYTES).toBe(512 * 1024)
    expect(TOKEN_LIMIT_CAP).toBe(32_000)
    expect(TOKEN_CTX_RESERVE).toBe(8_000)
    expect(MIN_BLOCK_CHARS).toBe(20)
  })

  it('token 上限 = min(32_000, ctx − 8_000)', () => {
    expect(projectionTokenLimit(40_000)).toBe(32_000)
    expect(projectionTokenLimit(28_000)).toBe(20_000)
    expect(projectionTokenLimit(20_000)).toBe(12_000)
  })

  it('demo key 推导的固定 Extension ID（与 apps/extension/public/manifest.json、tools/scripts/sift-demo-constants.mjs 同步；算法级校验见 tools/scripts/demo-key.test.mjs）', () => {
    expect(EXTENSION_ID).toBe('jhkdmlohebjffokfonhiijhhmocfcppo')
    expect(NATIVE_HOST_ALLOWED_ORIGIN).toBe('chrome-extension://jhkdmlohebjffokfonhiijhhmocfcppo/')
  })
})
