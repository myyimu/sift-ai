// Native host 消息循环（ADR-001 E-03 spike 第一个落地物，步骤 3 继续演进）。
//
// 职责：stdin 字节流 -> FrameDecoder -> JSON 消息 -> onMessage 处理器 ->
// 响应帧写回 stdout。约束：
//  - host stdout 只允许长度前缀帧——本模块是 stdout 的唯一出口，诊断一律走 stderr；
//  - 非法 JSON / 帧超限 / 处理器异常 -> 失败关闭（以非零码退出，不返回部分成功）；
//  - stdin end/close（Chrome 断开）-> 排空在途异步处理后正常退出 0。
//
// 步骤 3 扩展（capture 协议需要异步 Store commit）：
//  - onMessage 可返回 Promise；**响应严格按消息到达顺序串行化**（promise 链），
//    不因异步完成顺序而乱序写帧；
//  - FailClosed：处理器声明"先写这帧响应、随后失败关闭"——协议完整性错误
//    （hash/sequence/schema）的固定出口，对齐 AGENTS 验收门 5（无软错误续跑）。
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

/**
 * 处理器抛出的"先响应后失败关闭"信号：loop 先把 response 序列化为响应帧，
 * 随后按处理器异常失败关闭（onFatal + 不再处理后续帧）。
 */
export class FailClosed extends Error {
  readonly response: unknown
  constructor(response: unknown, message?: string) {
    super(message ?? 'sift host: fail closed after response')
    this.name = 'FailClosed'
    this.response = response
  }
}

export interface NativeHostLoopOptions {
  stdin: ReadableLike
  stdout: WritableLike
  /**
   * 处理一条消息；返回非 null/undefined 时序列化为响应帧。
   * 支持 Promise：响应按消息到达顺序串行化写出。
   * 抛 FailClosed -> 先写 response 帧再失败关闭；其它异常/reject -> 失败关闭。
   */
  onMessage(message: unknown): unknown | null | Promise<unknown | null>
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
  /** 响应串行化链：异步 onMessage 的响应也严格按帧到达顺序写出。 */
  let chain: Promise<void> = Promise.resolve()

  const finish = (_kind: 'closed' | 'fatal', error?: unknown) => {
    if (closed) return
    closed = true
    if (error !== undefined) onFatal?.(error)
    onClosed?.()
  }

  const writeResponse = (response: unknown): void => {
    try {
      stdout.write(encodeFrame(new TextEncoder().encode(JSON.stringify(response))))
    } catch (error) {
      finish('fatal', error)
    }
  }

  const processFrame = async (frame: Uint8Array): Promise<void> => {
    if (closed) return
    let message: unknown
    try {
      message = JSON.parse(new TextDecoder().decode(frame))
    } catch {
      finish('fatal', new Error('host loop: frame is not valid UTF-8 JSON (fail closed)'))
      return
    }
    let response: unknown
    try {
      response = await onMessage(message)
    } catch (error) {
      if (error instanceof FailClosed && error.response !== null && error.response !== undefined) {
        writeResponse(error.response)
      }
      finish('fatal', error)
      return
    }
    if (closed) return
    if (response !== null && response !== undefined) writeResponse(response)
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
      // 链上意外 rejection 一律失败关闭；processFrame 自身全路径捕获，这里的 catch 是防御
      chain = chain
        .then(() => processFrame(frame))
        .catch((error: unknown) => {
          finish('fatal', error)
        })
    }
  }

  const onEnd = () => {
    // 排空在途异步处理后正常收尾（Chrome 断开时序下不丢已受理消息的响应）
    void chain.then(() => finish('closed'))
  }

  stdin.on('data', onData)
  stdin.on('end', onEnd)
  stdin.on('close', onEnd)

  return () => {
    finish('closed')
  }
}
