// @sift/shared —— 跨端契约与冻结参数。
//
// 分层约束（ADR-001 §1：content script 零运行时依赖）：
// - MV3 content script / service worker 只允许 import '@sift/shared/limits' 与 '@sift/shared/tokens'
//   （纯函数、零依赖，esbuild 直接入 bundle）；
// - zod schema（本入口）只在桌面端 / Native Host 侧使用（入 Store、出 projector、模型响应终审）。
export * from './limits'
export * from './tokens'
export * from './envelope'
export * from './evidence'
export * from './projections'
