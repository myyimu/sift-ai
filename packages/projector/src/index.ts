// @sift/projector —— demo-projector-v1（ADR-001 §9 步骤 4 / E-05；Phase 3 工作流 D+E）。
//
// P0_DEMO_SCOPE §2.4 冻结的六步规则（不使用 Defuddle/Readability、LLM 或站点 Adapter）：
//  1. 对已脱敏的离线 DOM 克隆再剥离一次（纵深防御：script/style/template/noscript/
//     nav/header/footer/aside/form/dialog、交互控件、hidden/aria-hidden、噪声 role）；
//  2. 优先 eligible text 最多的 main；无 main 时取通过最低文本检查的顶层
//     article/[role=article]；仍无则用去噪 body；
//  3. 按 DOM 顺序从 heading/paragraph/blockquote/pre/code/table row/list item/
//     剩余连续文本生成块；
//  4. heading 只要求非空；普通文本块 >= 20 个非空白字符；
//  5. 全局按 textHash 去重并保留全部来源 refs；
//  6. 空结果返回 projection_empty，不得把 raw outerHTML 送给模型。
//
// 本包保持纯：依赖 @sift/shared + linkedom + node:crypto，不依赖 @sift/store
// （读侧事实由调用方从 store 读出后以值传入——桌面 UI 即此形态）。
export { deriveCoverageManifest, snapshotGroupKey } from './manifest'
export type { ManifestInput, ManifestObservation, ManifestPageState } from './manifest'
export { extractBlocks, normalizeBlockText, textHashOf } from './extract'
export { projectQuestion } from './project'
export type { ManifestFacts, ProjectQuestionParams, ProjectorPageInput, ProjectorResult } from './project'
export type { QuestionProjection } from '@sift/shared'
