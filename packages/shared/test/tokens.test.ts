import { describe, expect, it } from 'vitest'
import { estimateTokens, utf8Bytes } from '../src/tokens'

// ADR-001 E-07：estimateTokens(text) = ceil(ASCII 码点数 / 4) + 非 ASCII 码点数。
// 该纯函数进入 inputHash，语义必须逐字稳定。
describe('estimateTokens', () => {
  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('纯 ASCII：4 个码点 -> 1 token（恰好整除）', () => {
    expect(estimateTokens('abcd')).toBe(1)
  })

  it('纯 ASCII 向上取整：3 个码点 -> 1，5 个码点 -> 2', () => {
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('非 ASCII 码点逐个计 1', () => {
    expect(estimateTokens('中文')).toBe(2)
  })

  it('混合：ceil(ASCII/4) + 非 ASCII', () => {
    expect(estimateTokens('a密')).toBe(Math.ceil(1 / 4) + 1) // 2
    expect(estimateTokens('abcd密')).toBe(1 + 1) // 2
  })

  it('按 Unicode 码点计数：代理对（emoji）算 1 个码点', () => {
    expect(estimateTokens('😀')).toBe(1)
    expect(estimateTokens('a😀b😀')).toBe(Math.ceil(3 / 4) + 2) // 3
  })
})

describe('utf8Bytes', () => {
  it('ASCII 每字符 1 字节', () => {
    expect(utf8Bytes('abc')).toBe(3)
  })

  it('中文每码点 3 字节', () => {
    expect(utf8Bytes('中文')).toBe(6)
  })

  it('空串为 0', () => {
    expect(utf8Bytes('')).toBe(0)
  })
})
