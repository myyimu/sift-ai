// answer-v1 提示词（ADR-001 E-06：promptVersion 版本化；P0_DEMO_SCOPE §2.5/
// P0_COVERAGE_MANIFEST_SPEC §5：CoverageManifest 摘要必须进入模型上下文）。
//
// 确定性纪律：本模块是纯函数，零墙钟零随机；输入只有问题、证据块（投影序）与
// manifest 摘要。提示词文本属 answer-v1 的一部分——任何措辞变更都应升 promptVersion。
import { renderCoverageSummary } from '@sift/shared'
import type { CoverageManifest, DemoEvidenceBlock } from '@sift/shared'
import { ANSWER_PROJECTION_JSON_SCHEMA } from './json-schema'

export const PROMPT_VERSION = 'answer-v1'

export interface AnswerMessages {
  readonly system: string
  readonly user: string
}

export function buildAnswerMessages(input: {
  readonly question: string
  readonly blocks: readonly DemoEvidenceBlock[]
  readonly coverage: CoverageManifest
}): AnswerMessages {
  const system = [
    '你是 Sift 的只读分析助手。你只能依据用户提供的证据块回答，不得引入块外知识，不得联网补充，不得猜测。',
    '输出要求：',
    '- 只输出一个 JSON 对象（符合给定的 JSON Schema），不输出任何解释、代码围栏或 HTML。',
    '- 每条 claim 必须在 evidenceBlockRefs 里引用至少一个证据块 ID（形如 b-0001），且只能引用给定块 ID。',
    '- 问题超出证据范围时不要编造 claim：answer 留为简短说明，并在 limitations 中解释缺口。',
    '- limitations 不得与下方的覆盖声明矛盾；不得把“最近一次观察中未见”表述为“已删除”；不得把样本表述为站点整体。',
    '- analyzer 字段固定填 {"provider":"local","model":"local","promptVersion":"answer-v1"}（本地会重新盖章）。',
    '- 使用中文回答。',
    '',
    '数据覆盖声明（CoverageManifest 摘要，回答的事实边界）：',
    renderCoverageSummary(input.coverage),
  ].join('\n')

  const blockLines = input.blocks.map(b => `[${b.id}|${b.kind}] ${b.text}`)
  const user = [`问题：${input.question}`, '', '证据块（按捕获顺序）：', ...blockLines].join('\n')
  return { system, user }
}

/** json_object 降级模式：把 JSON Schema 注入 system prompt（E-06 第二级约束）。 */
export function withSchemaInstruction(system: string): string {
  return `${system}\n\n输出必须符合以下 JSON Schema：\n${JSON.stringify(ANSWER_PROJECTION_JSON_SCHEMA)}`
}
