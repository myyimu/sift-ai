// @sift/host —— Native Messaging 协议纯逻辑（不依赖 Electron UI）。
// E-03：host 模式可复用主 exe，但 host 侧代码必须能在无 UI 的前提下独立测试。
export { detectNativeHostLaunch, type LaunchIo } from './mode'
export {
  encodeFrame,
  FrameDecoder,
  FrameFormatError,
  MAX_FRAME_BYTES,
  splitIntoChunks,
} from './framing'
export {
  runNativeHostLoop,
  FailClosed,
  type ReadableLike,
  type WritableLike,
  type NativeHostLoopOptions,
} from './host-loop'
export { isSpikePing, spikePongHandler, type SpikePing, type SpikePong } from './protocol'
export {
  CAPTURE_VERSION,
  PROTOCOL_VERSION,
  REDACTION_POLICY,
  createCaptureProtocolHandler,
  type CaptureCommitResult,
  type CaptureObservationRef,
  type CapturePageWatermark,
  type CaptureProtocolOptions,
  type CaptureStore,
} from './capture-protocol'
