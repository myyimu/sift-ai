// Native Messaging 应用层消息协议（ADR-001 §9 步骤 3 定稿；E-03 spike 先落 ping/pong）。
//
// 已冻结的协议语义（ADR-001 E-04，此处只声明、不实现）：
//  - 消息在分块重组后必须是合法 UTF-8 JSON，并按 host 侧 zod schema 校验，失败关闭；
//  - 幂等 commit：host 只有在 blob 完成“staging -> 校验长度+hash+flush ->
//    BEGIN IMMEDIATE -> 幂等检查 + TTL/配额复核 -> rename/复用 -> 插入 -> commit”
//    全链路后才发送 commit ack；相同 (kind, inputHash) 的重复 commit 直接去重确认；
//  - 断线、背压、schema 不符、hash 不符一律失败关闭，不返回部分成功。
//
// 步骤 3 将在此文件定稿 ExtensionMessage/HostMessage 的判别联合与 zod schema。

/** E-03 spike 往返探针：驱动方（模拟 Chrome 的测试）发 ping，host 回 pong。 */
export interface SpikePing {
  readonly type: 'ping'
  readonly id: number
  readonly nonce: string
}

export interface SpikePong {
  readonly type: 'pong'
  readonly id: number
  readonly nonce: string
}

export function isSpikePing(message: unknown): message is SpikePing {
  if (typeof message !== 'object' || message === null) return false
  const m = message as Record<string, unknown>
  return m.type === 'ping' && typeof m.id === 'number' && typeof m.nonce === 'string'
}

export function spikePongHandler(message: unknown): SpikePong | null {
  if (!isSpikePing(message)) return null
  return { type: 'pong', id: message.id, nonce: message.nonce }
}
