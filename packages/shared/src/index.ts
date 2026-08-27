// @sift/shared —— 跨端契约与冻结参数。
//
// 分层约束（ADR-001 §1：content script 零运行时依赖）：
// - MV3 content script / service worker 只允许 import 纯路径：
//   '@sift/shared/limits'、'@sift/shared/tokens'、
//   '@sift/shared/wire'（线协议纯类型/纯函数）、'@sift/shared/sanitize'
//   （sensitive-v1 纯字符串层）——均为零运行时依赖，esbuild 直接入 bundle；
// - zod schema（本入口，含 envelope/evidence/projections/capture）只在
//   桌面端 / Native Host 侧使用（入 Store、出 projector、模型响应终审）。
export * from './limits'
export * from './tokens'
export * from './wire'
export * from './sanitize'
export * from './envelope'
export * from './evidence'
export * from './projections'
export * from './capture'
