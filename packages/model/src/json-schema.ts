// AnswerProjection 的 JSON Schema（response_format=json_schema 用；ADR-001 E-06 两级
// 约束的第一级）。shared 用 zod 3.24（无 z.toJSONSchema），因此手写并配双向往来一致性
// 测试（test/adapter.test.ts 的 ajv 对照矩阵）。
//
// 与 zod 的分工：本 Schema 只约束“模型输出的形状”；跨对象不变式（引用属于投影、
// claimId 唯一、超长字段、HTML 拒绝）是本地 validate.ts 的职责，无法也不应塞进这里。
// analyzer 三元组本地会重新盖章，此处只要求形状存在。
export const ANSWER_PROJECTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'answer', 'claims', 'limitations', 'sources', 'analyzer'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    answer: { type: 'string', minLength: 1 },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claimId', 'text', 'evidenceBlockRefs'],
        properties: {
          claimId: { type: 'string', minLength: 1 },
          text: { type: 'string', minLength: 1 },
          evidenceBlockRefs: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        },
      },
    },
    limitations: { type: 'array', items: { type: 'string' } },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['evidenceBlockRef'],
        properties: { evidenceBlockRef: { type: 'string', minLength: 1 } },
      },
    },
    analyzer: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'model', 'promptVersion'],
      properties: {
        provider: { type: 'string', minLength: 1 },
        model: { type: 'string', minLength: 1 },
        promptVersion: { type: 'string', minLength: 1 },
      },
    },
  },
} as const
