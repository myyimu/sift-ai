// Mutation dirty trigger 汇聚（P0_DEMO_SCOPE §2.2 冻结参数）：
//  - DEBOUNCE_MS=200：静默 200ms 后触发一次采集；
//  - MAX_WAIT_MS=2000：即使持续有新 mutation，最多 2000ms 必须产出一次；
//  - latest-wins：pending 期间的新 trigger 只推迟 debounce 计时，不排队；
//  - mark() 传入 mutations 只记数量（诊断），不读内容。
// 时钟与定时器注入，测试用假时钟（vi.useFakeTimers 场景直接用全局）。
import { DEBOUNCE_MS, MAX_WAIT_MS } from '@sift/shared/limits'

export interface DebounceTimers {
  setTimeout(handler: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface MutationGate {
  /** mutation 到达（只计数，不读内容）。 */
  mark(): void
  /** 取消 pending 触发（页面隐藏/撤销授权时用）。 */
  cancel(): void
  readonly pendingTriggerCount: number
}

export function createMutationGate(
  onTrigger: () => void,
  timers: DebounceTimers = { setTimeout: (h, ms) => setTimeout(h, ms), clearTimeout: h => clearTimeout(h as number) },
): MutationGate {
  let debounceHandle: unknown = null
  let maxWaitHandle: unknown = null
  let pending = 0

  const fire = (): void => {
    // maxWait 强制触发时 debounce 计时可能仍在挂起：必须显式清掉，
    // 否则 mark() 见 debounceHandle===null 不会重置，旧计时晚些重复触发。
    if (debounceHandle !== null) timers.clearTimeout(debounceHandle)
    if (maxWaitHandle !== null) timers.clearTimeout(maxWaitHandle)
    debounceHandle = null
    maxWaitHandle = null
    pending = 0
    onTrigger()
  }

  return {
    mark(): void {
      pending += 1
      if (maxWaitHandle === null) {
        // 本轮第一个 trigger：启动 maxWait 兜底
        maxWaitHandle = timers.setTimeout(fire, MAX_WAIT_MS)
      }
      if (debounceHandle !== null) timers.clearTimeout(debounceHandle)
      debounceHandle = timers.setTimeout(fire, DEBOUNCE_MS) // latest-wins 重置
    },
    cancel(): void {
      if (debounceHandle !== null) timers.clearTimeout(debounceHandle)
      if (maxWaitHandle !== null) timers.clearTimeout(maxWaitHandle)
      debounceHandle = null
      maxWaitHandle = null
      pending = 0
    },
    get pendingTriggerCount(): number {
      return pending
    },
  }
}
