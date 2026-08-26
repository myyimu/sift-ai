import { describe, expect, it } from 'vitest'
import { NATIVE_MAX_CHUNK_BYTES } from '@sift/shared/limits'
import {
  encodeFrame,
  FrameDecoder,
  FrameFormatError,
  MAX_FRAME_BYTES,
  splitIntoChunks,
} from '../src/framing'

describe('encodeFrame / FrameDecoder', () => {
  it('编码后可完整解码回原 payload', () => {
    const payload = new TextEncoder().encode('{"type":"test"}')
    const frame = encodeFrame(payload)
    const decoder = new FrameDecoder()
    const frames = decoder.push(frame)
    expect(frames).toHaveLength(1)
    expect(new TextDecoder().decode(frames[0]!)).toBe('{"type":"test"}')
  })

  it('首 4 字节是小端长度', () => {
    const frame = encodeFrame(new Uint8Array([1, 2, 3, 4, 5]))
    expect(frame[0]).toBe(5)
    expect(frame[1]).toBe(0)
    expect(frame[2]).toBe(0)
    expect(frame[3]).toBe(0)
    expect(frame.length).toBe(9)
  })

  it('流式切割：一帧逐字节喂入仍完整重组', () => {
    const payload = new TextEncoder().encode('x'.repeat(1000))
    const frame = encodeFrame(payload)
    const decoder = new FrameDecoder()
    const collected: Uint8Array[] = []
    for (const byte of frame) {
      collected.push(...decoder.push(new Uint8Array([byte])))
    }
    expect(collected).toHaveLength(1)
    expect(collected[0]!.length).toBe(1000)
  })

  it('一次 push 多帧返回多帧，乱序切割不丢字节', () => {
    const a = new TextEncoder().encode('frame-a')
    const b = new TextEncoder().encode('frame-b-longer')
    const stream = new Uint8Array([...encodeFrame(a), ...encodeFrame(b)])
    const decoder = new FrameDecoder()
    // 按奇怪边界切两半
    const mid = Math.floor(stream.length / 3)
    const first = decoder.push(stream.slice(0, mid))
    const second = decoder.push(stream.slice(mid))
    const all = [...first, ...second]
    expect(all).toHaveLength(2)
    expect(new TextDecoder().decode(all[0]!)).toBe('frame-a')
    expect(new TextDecoder().decode(all[1]!)).toBe('frame-b-longer')
  })

  it('超过上限的长度声明抛 FrameFormatError（失败关闭，不 OOM）', () => {
    const decoder = new FrameDecoder(16)
    // 声明 100000 字节帧
    const evil = new Uint8Array([0xa0, 0x86, 0x01, 0x00])
    expect(() => decoder.push(evil)).toThrow(FrameFormatError)
  })

  it('帧 payload 超过 MAX_FRAME_BYTES 时编码拒绝', () => {
    expect(() => encodeFrame(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrow(FrameFormatError)
  })
})

describe('splitIntoChunks', () => {
  it('空 payload 返回单个空块（保持消息语义）', () => {
    const chunks = splitIntoChunks(new Uint8Array(0), NATIVE_MAX_CHUNK_BYTES)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.length).toBe(0)
  })

  it('恰好等于上限时不产生多余空块', () => {
    const payload = new Uint8Array(NATIVE_MAX_CHUNK_BYTES)
    const chunks = splitIntoChunks(payload, NATIVE_MAX_CHUNK_BYTES)
    expect(chunks).toHaveLength(1)
  })

  it('上限+1 字节切成 2 块', () => {
    const payload = new Uint8Array(NATIVE_MAX_CHUNK_BYTES + 1)
    const chunks = splitIntoChunks(payload, NATIVE_MAX_CHUNK_BYTES)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.length).toBe(NATIVE_MAX_CHUNK_BYTES)
    expect(chunks[1]!.length).toBe(1)
  })

  it('切块拼接无损', () => {
    const payload = new Uint8Array(300)
    payload.forEach((_, i) => (payload[i] = i % 251))
    const merged = new Uint8Array([...splitIntoChunks(payload, 128)].flatMap(c => [...c]))
    expect(merged).toEqual(payload)
  })
})
