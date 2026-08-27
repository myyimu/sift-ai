// debounce.test.ts —— mutation 汇聚门（DEBOUNCE_MS=200 / MAX_WAIT_MS=2000 / latest-wins）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMutationGate } from '../src/debounce'

describe('createMutationGate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('静默 200ms 后触发一次', () => {
    let fires = 0
    const gate = createMutationGate(() => {
      fires += 1
    })
    gate.mark()
    expect(fires).toBe(0)
    vi.advanceTimersByTime(199)
    expect(fires).toBe(0)
    vi.advanceTimersByTime(1)
    expect(fires).toBe(1)
  })

  it('持续 mark 推迟 debounce（latest-wins，不排队）', () => {
    let fires = 0
    const gate = createMutationGate(() => {
      fires += 1
    })
    gate.mark() // t=0：debounce@200
    vi.advanceTimersByTime(150)
    gate.mark() // t=150：重置 → debounce@350
    vi.advanceTimersByTime(150) // t=300 < 350
    expect(fires).toBe(0)
    gate.mark() // t=300：重置 → debounce@500
    vi.advanceTimersByTime(200) // t=500
    expect(fires).toBe(1)
    expect(gate.pendingTriggerCount).toBe(0)
  })

  it('持续 mutation 最多 2000ms 强制触发', () => {
    let fires = 0
    const gate = createMutationGate(() => {
      fires += 1
    })
    for (let t = 0; t < 3000; t += 100) {
      vi.advanceTimersByTime(100)
      gate.mark()
    }
    // 首个 mark（t=100）武装 maxWait@2100；2100 触发后后续 mark 的新周期未到期
    expect(fires).toBe(1)
    expect(gate.pendingTriggerCount).toBeGreaterThan(0)
  })

  it('pendingTriggerCount 计数并在触发后清零', () => {
    let fires = 0
    const gate = createMutationGate(() => {
      fires += 1
    })
    gate.mark()
    gate.mark()
    gate.mark()
    expect(gate.pendingTriggerCount).toBe(3)
    vi.advanceTimersByTime(200)
    expect(fires).toBe(1)
    expect(gate.pendingTriggerCount).toBe(0)
  })

  it('cancel 取消 pending 触发', () => {
    let fires = 0
    const gate = createMutationGate(() => {
      fires += 1
    })
    gate.mark()
    gate.cancel()
    vi.advanceTimersByTime(3000)
    expect(fires).toBe(0)
    expect(gate.pendingTriggerCount).toBe(0)
  })

  it('定时器可注入（200/2000 参数来自 limits）', () => {
    const armed: { handler: () => void; ms: number }[] = []
    const timers = {
      setTimeout: (handler: () => void, ms: number) => {
        armed.push({ handler, ms })
        return armed.length
      },
      clearTimeout: () => {},
    }
    const gate = createMutationGate(() => {}, timers)
    gate.mark()
    expect(armed.map(a => a.ms).sort((a, b) => a - b)).toEqual([200, 2000])
    gate.cancel()
    // cancel 后不再有待决计时
    const before = armed.length
    gate.cancel()
    expect(armed.length).toBe(before)
  })
})
