// Native host 消息循环（ADR-001 E-03 spike 第一个落地物，步骤 3 继续演进）。
//
// 职责：stdin 字节流 -> FrameDecoder -> JSON 消息 -> onMessage 处理器 ->
// 响应帧写回 stdout。约束：
//  - host stdout 只允许长度前缀帧——本模块是 stdout 的唯一出口，诊断一律走 stderr；
//  - 非法 JSON / 帧超限 / 处理器异常 -> 失败关闭（以非零码退出，不返回部分成功）；
//  - stdin end/close（Chrome 断开）-> 正常退出 0。
//
// 通过注入流而不是直接引用 process.stdin/stdout，保证本模块可单测。
import { encodeFrame, FrameDecoder, FrameFormatError } from './framing'

export interface ReadableLike {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'end' | 'close', listener: () => void): unknown
}

export interface WritableLike {
  write(data: Uint8Array): unknown
}

export interface NativeHostLoopOptions {
  stdin: ReadableLike
  stdout: WritableLike
  /** 处理一条消息；返回非 null 时序列化为响应帧。抛异常 -> 失败关闭。 */
  onMessage(message: unknown): unknown | null
  /** 失败关闭钩子（写 stderr、设退出码等由调用方决定）。 */
  onFatal?(error: unknown): void
  /** 正常结束钩子。 */
  onClosed?(): void
}

/** 返回一个 teardown 函数（移除监听；测试与异常路径用）。 */
export function runNativeHostLoop(opts: NativeHostLoopOptions): () => void {
  const { stdin, stdout, onMessage, onFatal, onClosed } = opts
  const decoder = new FrameDecoder()
  let closed = false

  const finish = (_kind: 'closed' | 'fatal', error?: unknown) => {
    if (closed) return
    closed = true
    if (error !== undefined) onFatal?.(error)
    onClosed?.()
  }

  const onData = (chunk: Buffer) => {
    let frames: Uint8Array[]
    try {
      frames = decoder.push(new Uint8Array(chunk))
    } catch (error) {
      finish('fatal', error instanceof FrameFormatError ? error : new FrameFormatError(String(error)))
      return
    }
    for (const frame of frames) {
      let message: unknown
      try {
        message = JSON.parse(new TextDecoder().decode(frame))
      } catch {
        finish('fatal', new Error('host loop: frame is not valid UTF-8 JSON (fail closed)'))
        return
      }
      let response: unknown
      try {
        response = onMessage(message)
      } catch (error) {
        finish('fatal', error)
        return
      }
      if (response !== null && response !== undefined) {
        try {
          stdout.write(encodeFrame(new TextEncoder().encode(JSON.stringify(response))))
        } catch (error) {
          finish('fatal', error)
          return
        }
      }
    }
  }

  const onEnd = () => finish('closed')

  stdin.on('data', onData)
  stdin.on('end', onEnd)
  stdin.on('close', onEnd)

  return () => {
    finish('closed')
  }
}
