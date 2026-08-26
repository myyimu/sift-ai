import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { encodeFrame, FrameDecoder } from '../src/framing'
import { runNativeHostLoop } from '../src/host-loop'
import { spikePongHandler } from '../src/protocol'

/** 把多个帧拼接成一个字节流。 */
function framed(...messages: unknown[]): Uint8Array {
  const encoded = messages.map(m => encodeFrame(new TextEncoder().encode(JSON.stringify(m))))
  const total = encoded.reduce((n, f) => n + f.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const f of encoded) {
    out.set(f, offset)
    offset += f.length
  }
  return out
}

function collectFrames(stream: PassThrough): Promise<unknown[]> {
  return new Promise(resolve => {
    const decoder = new FrameDecoder()
    const messages: unknown[] = []
    const tryResolve = () => {
      if (stream.writableEnded || stream.readableEnded) resolve(messages)
    }
    stream.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(new Uint8Array(chunk))) {
        messages.push(JSON.parse(new TextDecoder().decode(frame)))
      }
    })
    stream.on('end', tryResolve)
    stream.on('close', tryResolve)
    // 兜底：数据已收但流未显式 end（host-loop 不关闭注入的 stdout）
    setTimeout(() => resolve(messages), 200)
  })
}

describe('runNativeHostLoop', () => {
  it('ping -> pong 帧往返', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const collecting = collectFrames(stdout)

    runNativeHostLoop({ stdin, stdout, onMessage: spikePongHandler })

    stdin.end(framed({ type: 'ping', id: 7, nonce: 'abc123' }))
    const messages = await collecting
    expect(messages).toEqual([{ type: 'pong', id: 7, nonce: 'abc123' }])
  })

  it('一条流里多帧依次响应，顺序保持', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const collecting = collectFrames(stdout)

    runNativeHostLoop({ stdin, stdout, onMessage: spikePongHandler })

    stdin.end(
      framed(
        { type: 'ping', id: 1, nonce: 'n1' },
        { type: 'ping', id: 2, nonce: 'n2' },
        { type: 'ping', id: 3, nonce: 'n3' },
      ),
    )
    const messages = await collecting
    expect(messages.map(m => (m as { id: number }).id)).toEqual([1, 2, 3])
  })

  it('handler 返回 null 时不写响应帧（如未知消息类型）', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const collecting = collectFrames(stdout)
    const onFatal = vi.fn()

    runNativeHostLoop({ stdin, stdout, onMessage: spikePongHandler, onFatal })

    stdin.end(framed({ type: 'unknown_message' }, { type: 'ping', id: 9, nonce: 'x' }))
    const messages = await collecting
    expect(messages).toEqual([{ type: 'pong', id: 9, nonce: 'x' }])
    expect(onFatal).not.toHaveBeenCalled()
  })

  it('非法 JSON 帧失败关闭并回调 onFatal', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const onFatal = vi.fn()

    runNativeHostLoop({ stdin, stdout, onMessage: spikePongHandler, onFatal })

    stdin.end(encodeFrame(new TextEncoder().encode('{not json')))
    await new Promise(r => setImmediate(r))
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onFatal.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it('超过上限的帧长度声明失败关闭（FrameFormatError）', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const onFatal = vi.fn()

    runNativeHostLoop({ stdin, stdout, onMessage: spikePongHandler, onFatal })

    stdin.end(new Uint8Array([0xff, 0xff, 0xff, 0x00])) // 声明 ~16MB 帧
    await new Promise(r => setImmediate(r))
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onFatal.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it('stdin end 后正常结束（Chrome 断开），不触发 onFatal', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const onFatal = vi.fn()
    const onClosed = vi.fn()

    runNativeHostLoop({ stdin, stdout, onMessage: spikePongHandler, onFatal, onClosed })

    stdin.end()
    await new Promise(r => setImmediate(r))
    expect(onFatal).not.toHaveBeenCalled()
    expect(onClosed).toHaveBeenCalledTimes(1)
  })
})
