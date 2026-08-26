// @sift/projector —— demo-projector-v1 —— 骨架（ADR-001 §9 步骤 4 / E-05）。
//
// P0_DEMO_SCOPE §2.4 冻结的六步规则（不使用 Defuddle/Readability、LLM 或站点 Adapter）：
//  1. 对已脱敏的离线 DOM 克隆删 script/style/template/noscript/nav/header/footer/aside/
//     form/dialog、交互控件、hidden/aria-hidden 和已知噪声；
//  2. 优先 eligible text 最多的 main；无 main 时取通过最低文本检查的顶层
//     article/[role=article]；仍无则用去噪 body；
//  3. 按 DOM 顺序从 heading/paragraph/blockquote/pre/code/table row/信息量 list item/
//     剩余连续文本生成块；
//  4. heading 只要求非空；普通文本块 >= 20 个非空白字符；
//  5. 同一 Page State 内按 textHash 去重并保留全部来源 page refs；
//  6. 空结果返回 projection_empty，不得把 raw outerHTML 送给模型。
//
// E-05：DOM 实现用 linkedom（离线、零网络）；夹具不足时回退 jsdom（另开 ADR 事项）。
// 选择算法：按 (capturedAt, pageInstanceId, ordinal) 确定性排序；全量或不发送，
// 不截断不抽样。inputHash 覆盖 question + 规范化 blocks（estimateTokens 同入 hash）。
import type { QuestionProjection } from '@sift/shared'

export type { QuestionProjection }

/** 投影器输入：冻结 Page State 的脱敏 HTML + 页面来源元数据。步骤 4 定稿。 */
export interface ProjectorInput {
  /** 调用方保证已脱敏（sensitive-v1）的离线 HTML。 */
  sanitizedHtml: string
  source: {
    pageInstanceId: string
    stateVersion: number
    ordinal: number
    title?: string
    safeUrl: string
    capturedAt: string
  }
}

export type ProjectorResult =
  | { status: 'ok'; projection: QuestionProjection }
  | { status: 'projection_empty' }
  | { status: 'projection_input_invalid'; reason: string }
