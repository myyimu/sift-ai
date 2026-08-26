// 算法级一致性测试：manifest key -> Chromium Extension ID 推导 <-> 仓库常量。
//
// 背景：Extension ID 必须由 SHA-256(DER) 前 16 字节的每个高低半字节（共 32 个 nibble）
// 分别映射 a-p 得到 32 字符；曾经每字节只取 b%16 产生错误 16 位 ID，导致 Native Host
// allowed_origins 与 Chrome 实际 ID 不匹配（评审 P0 问题）。本测试直接读 manifest key
// 反推 ID，任何一处（key、两份常量、算法）漂移都会在这里失败。
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { EXTENSION_ID } from './sift-demo-constants.mjs'

/** Chromium 官方算法：SHA-256(公钥 DER) 前 16 字节，高低 nibble 各映射 a-p。 */
function extensionIdFromKeyField(keyField) {
  const der = Buffer.from(keyField, 'base64')
  return Array.from(
    createHash('sha256').update(der).digest().subarray(0, 16),
    (b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)),
  ).join('')
}

describe('demo key <-> Extension ID 一致性', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../apps/extension/public/manifest.json', import.meta.url), 'utf8'),
  )

  it('manifest key 按 Chromium 算法推导出的 ID 与常量一致', () => {
    expect(manifest.key).toBeTruthy()
    expect(extensionIdFromKeyField(manifest.key)).toBe(EXTENSION_ID)
  })

  it('ID 为 32 字符且全部落在 a-p', () => {
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/)
  })

  it('packages/shared 常量与本文件常量一致（双源防漂移）', async () => {
    const limitsSource = readFileSync(new URL('../../packages/shared/src/limits.ts', import.meta.url), 'utf8')
    const match = limitsSource.match(/EXTENSION_ID = '([a-p]{32})'/)
    expect(match?.[1]).toBe(EXTENSION_ID)
  })

  it('gen-demo-key.mjs 的推导算法与本测试一致（源码形态校验）', () => {
    const genSource = readFileSync(new URL('gen-demo-key.mjs', import.meta.url), 'utf8')
    // 修正后的算法必须同时取高低 nibble（b >> 4 与 b & 15），不允许回退成 b % 16 单 nibble。
    expect(genSource).toContain('b >> 4')
    expect(genSource).toContain('b & 15')
    expect(genSource).not.toMatch(/b\s*%\s*16\b/)
  })

  it('host mode 判定测试的 ORIGIN 与常量一致', () => {
    const modeTest = readFileSync(new URL('../../packages/host/test/mode.test.ts', import.meta.url), 'utf8')
    expect(modeTest).toContain(`chrome-extension://${EXTENSION_ID}/`)
    expect(modeTest).not.toContain('hdlhbfofnijhofpo')
  })
})
