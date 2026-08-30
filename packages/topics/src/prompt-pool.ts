// P0.5 预设问题池：只降低“可以问什么”的认知成本，不构成问题白名单。
// 选择只依赖廉价 Session metadata，不读取正文，也不调用模型。
export const PROMPT_POOL_VERSION = 'prompt-pool-v1'

export interface PromptPreset { readonly id: string; readonly text: string; readonly minPages?: number }
export interface PromptPoolContext { readonly pages: number; readonly units?: number }

const POOL: readonly PromptPreset[] = [
  { id: 'summary', text: '这个页面或范围主要讲了什么？' },
  { id: 'claims', text: '页面里有哪些关键结论或主张？', minPages: 1 },
  { id: 'evidence', text: '哪些证据最直接支持这些结论？', minPages: 1 },
  { id: 'gaps', text: '这个范围没有覆盖哪些内容？', minPages: 1 },
  { id: 'compare', text: '不同页面之间有哪些相同点和差异？', minPages: 2 },
  { id: 'follow-up', text: '基于这些内容，下一步值得核查什么？', minPages: 1 },
]

export function promptPool(): readonly PromptPreset[] { return POOL }

export function selectPromptPool(context: PromptPoolContext, limit = 3): readonly PromptPreset[] {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, POOL.length) : 3
  return POOL.filter(item => item.minPages === undefined || context.pages >= item.minPages).slice(0, safeLimit)
}
