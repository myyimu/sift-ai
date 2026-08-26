// 启动模式判定（ADR-001 E-03）：主 exe 双模式 —— UI 模式或 Native Messaging host 模式。
// 三个条件必须全部满足才进入 host 模式，任一不满足即 UI 模式（失败关闭）：
//   1. 第一个应用参数严格等于 demo key 推导的 allowed origin（===，不是 startsWith）；
//   2. 紧随其后是格式合法的 --parent-window=<非负十进制>；
//   3. stdin 与 stdout 均为非 TTY 管道。
// 附加约束（ADR-001 E-03）：不得因单实例锁冲突回退 host 模式——锁冲突时直接失败退出。
import { NATIVE_HOST_ALLOWED_ORIGIN } from '@sift/shared/limits'

export interface LaunchIo {
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
}

/** Chrome 以 <exe> <allowed-origin> --parent-window=<id> 启动 host；本函数接收 process.argv 去掉 argv[0] 后的应用参数。 */
export function detectNativeHostLaunch(args: readonly string[], io: LaunchIo): boolean {
  // 条件 1：第一个应用参数严格等于 allowed origin。
  if (args[0] !== NATIVE_HOST_ALLOWED_ORIGIN) return false
  // 条件 2：--parent-window=<非负十进制>，且紧跟 origin（Chrome 的固定传参顺序）。
  if (!/^--parent-window=\d+$/.test(args[1] ?? '')) return false
  // 条件 3：stdin/stdout 均为管道（非 TTY）。
  if (io.stdinIsTTY || io.stdoutIsTTY) return false
  return true
}
