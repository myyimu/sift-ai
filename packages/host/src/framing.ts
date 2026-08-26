// Native Messaging 线格式与应用层分块（P0_DEMO_SCOPE §2.2 / ADR-001 E-04）。
//
// 线格式与 Chromium native messaging 一致：4 字节小端无符号长度前缀 + payload。
// 应用层把大 payload 切成 <= NATIVE_MAX_CHUNK_BYTES 的块（默认 256 KiB），
// host 完成原子写入后才返回 commit ack（幂等语义在步骤 3 的 protocol/store 层实现）。
//
// host stdout 只允许长度前缀帧（诊断一律走 stderr）——本模块是 stdout 的唯一出口。

export class FrameFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrameFormatError'
  }
}

const HEADER_BYTES = 4

/** 单帧 payload 上限（帧长度声明超过它按协议错误处理，防恶意长度声明导致 OOM）。 */
export const MAX_FRAME_BYTES = 1024 * 1024

function writeU32LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
  target[offset + 2] = (value >>> 16) & 0xff
  target[offset + 3] = (value >>> 24) & 0xff
}

function readU32LE(src: Uint8Array, offset: number): number {
  return (src[offset]! | (src[offset + 1]! << 8) | (src[offset + 2]! << 16) | (src[offset + 3]! << 24)) >>> 0
}

/** 编码一帧：4 字节小端长度 + payload。 */
export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_FRAME_BYTES) {
    throw new FrameFormatError(`frame payload ${payload.length} exceeds ${MAX_FRAME_BYTES}`)
  }
  const out = new Uint8Array(HEADER_BYTES + payload.length)
  writeU32LE(out, 0, payload.length)
  out.set(payload, HEADER_BYTES)
  return out
}

/** 流式解码器：push 任意切割的字节流，返回完整解出的帧（可能 0..n 帧）。 */
export class FrameDecoder {
  private buffer = new Uint8Array(0)

  constructor(private readonly maxFrameBytes: number = MAX_FRAME_BYTES) {}

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.buffer.length === 0) {
      this.buffer = chunk.slice()
    } else {
      const merged = new Uint8Array(this.buffer.length + chunk.length)
      merged.set(this.buffer)
      merged.set(chunk, this.buffer.length)
      this.buffer = merged
    }
    const frames: Uint8Array[] = []
    for (;;) {
      if (this.buffer.length < HEADER_BYTES) break
      const declared = readU32LE(this.buffer, 0)
      if (declared > this.maxFrameBytes) {
        throw new FrameFormatError(`declared frame length ${declared} exceeds ${this.maxFrameBytes}`)
      }
      if (this.buffer.length < HEADER_BYTES + declared) break
      frames.push(this.buffer.slice(HEADER_BYTES, HEADER_BYTES + declared))
      this.buffer = this.buffer.slice(HEADER_BYTES + declared)
    }
    return frames
  }
}

/** 把大 payload 按应用层上限切块（默认 256 KiB，@sift/shared NATIVE_MAX_CHUNK_BYTES）。 */
export function splitIntoChunks(payload: Uint8Array, maxBytes: number): Uint8Array[] {
  if (maxBytes <= 0) throw new RangeError('maxBytes must be positive')
  if (payload.length === 0) return [new Uint8Array(0)]
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < payload.length; offset += maxBytes) {
    chunks.push(payload.slice(offset, Math.min(offset + maxBytes, payload.length)))
  }
  return chunks
}
