import { describe, expect, it } from 'vitest'
import { detectNativeHostLaunch } from '../src/mode'

const ORIGIN = 'chrome-extension://jhkdmlohebjffokfonhiijhhmocfcppo/'
const pipes = { stdinIsTTY: false, stdoutIsTTY: false }
const tty = { stdinIsTTY: true, stdoutIsTTY: true }

// ADR-001 E-03：三条件联合判定，失败关闭。
describe('detectNativeHostLaunch', () => {
  it('三条件全部满足 -> host 模式', () => {
    expect(detectNativeHostLaunch([ORIGIN, '--parent-window=12345'], pipes)).toBe(true)
    expect(detectNativeHostLaunch([ORIGIN, '--parent-window=0'], pipes)).toBe(true)
  })

  it('条件 1 失败：第一个参数不是严格相等的 allowed origin', () => {
    expect(detectNativeHostLaunch(['https://evil.example/', '--parent-window=1'], pipes)).toBe(false)
    expect(detectNativeHostLaunch([`${ORIGIN}x`, '--parent-window=1'], pipes)).toBe(false)
    // 前缀相同但长度不同（末位多一个 p）必须拒绝。
    expect(
      detectNativeHostLaunch(['chrome-extension://jhkdmlohebjffokfonhiijhhmocfcppoo/', '--parent-window=1'], pipes),
    ).toBe(false)
    expect(detectNativeHostLaunch([], pipes)).toBe(false)
  })

  it('条件 2 失败：--parent-window 缺失或格式非法', () => {
    expect(detectNativeHostLaunch([ORIGIN], pipes)).toBe(false)
    expect(detectNativeHostLaunch([ORIGIN, '--parent-window=-1'], pipes)).toBe(false)
    expect(detectNativeHostLaunch([ORIGIN, '--parent-window=1.5'], pipes)).toBe(false)
    expect(detectNativeHostLaunch([ORIGIN, '--parent-window=0x10'], pipes)).toBe(false)
    expect(detectNativeHostLaunch([ORIGIN, '--parent-window='], pipes)).toBe(false)
    expect(detectNativeHostLaunch([ORIGIN, 'garbage'], pipes)).toBe(false)
  })

  it('条件 3 失败：stdin 或 stdout 是 TTY', () => {
    expect(detectNativeHostLaunch([ORIGIN, '--parent-window=1'], tty)).toBe(false)
    expect(detectNativeHostLaunch([ORIGIN, '--parent-window=1'], { stdinIsTTY: true, stdoutIsTTY: false })).toBe(false)
    expect(detectNativeHostLaunch([ORIGIN, '--parent-window=1'], { stdinIsTTY: false, stdoutIsTTY: true })).toBe(false)
  })

  it('origin 之后多余参数不影响判定（Chrome 未来附加参数时不误伤）', () => {
    expect(detectNativeHostLaunch([ORIGIN, '--parent-window=1', '--extra=2'], pipes)).toBe(true)
  })
})
