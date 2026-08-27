// @sift/model 公共 API：ModelAdapter（ADR-001 E-06）+ AnswerProjection 本地验证器。
// 本包不依赖 store/projector/Electron；网络只出现在 adapter 的 completeAnswer，
// 且只发往 config 校验过的固定 origin。
export { loadModelConfig, modelConfigSummary } from './config'
export type { ModelConfig, ModelConfigResult, ModelConfigSummary } from './config'
export { ANSWER_PROJECTION_JSON_SCHEMA } from './json-schema'
export { PROMPT_VERSION, buildAnswerMessages, withSchemaInstruction } from './prompt'
export type { AnswerMessages } from './prompt'
export { createModelAdapter, MODEL_TIMEOUT_MS } from './adapter'
export type { CompleteAnswerInput, FetchLike, ModelAdapter, ModelFailureCode, ModelResult } from './adapter'
export { validateAnswerProjection, MAX_ANSWER_CHARS, MAX_CLAIMS, MAX_CLAIM_TEXT_CHARS, MAX_LIMITATIONS, MAX_LIMITATION_CHARS } from './validate'
export type { AnswerValidation } from './validate'
