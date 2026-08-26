// Sift P0 Demo 全部冻结参数的唯一来源。
// 依据：P0_DEMO_SCOPE.md §2（“版本化 Demo 默认值，不得静默放宽”）、ADR-001 E-06/E-07。
// 修改任何值都必须先改规范再改这里；test/limits.test.ts 会对照规范数值防漂移。

/** 固定 demo key 推导出的 Demo Extension ID（SHA-256 前 16 字节高低 nibble 映射 a-p，共 32 字符；tools/scripts/demo-key.test.mjs 校验与 manifest key 一致）。 */
export const EXTENSION_ID = 'jhkdmlohebjffokfonhiijhhmocfcppo'

/** Native Host 唯一允许的扩展 origin（ADR-001 E-03 三条件之一）。 */
export const NATIVE_HOST_ALLOWED_ORIGIN = `chrome-extension://${EXTENSION_ID}/`

/** Native Messaging host 注册名（HKCU 注册表键名 / host manifest "name"）。 */
export const NATIVE_HOST_NAME = 'com.dj.sift.demo'

// —— 捕获（P0_DEMO_SCOPE §2.2 / CAPTURE_ARCHITECTURE） ——
/** MutationObserver dirty trigger 汇聚的 debounce（毫秒）。 */
export const DEBOUNCE_MS = 200
/** 即使持续有新 mutation 也必须产出 Snapshot 的 maxWait（毫秒）。 */
export const MAX_WAIT_MS = 2000
/** 脱敏序列化后 Snapshot 上限（字节），超过即失败关闭 capture_limit_exceeded。 */
export const SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024
/** Snapshot DOM 节点数上限，超过即失败关闭。 */
export const SNAPSHOT_MAX_NODES = 50_000
/** Snapshot DOM 深度上限，超过即失败关闭。 */
export const SNAPSHOT_MAX_DEPTH = 128

// —— readable-v1（P0_DEMO_SCOPE §2.2） ——
/** 删噪后至少 80 个非空白文本字符才算可读。 */
export const READABLE_MIN_CHARS = 80
/** 授权后最多等待可读条件的毫秒数；仍不足返回 capture_too_little_content。 */
export const READABLE_WAIT_MS = 5000

// —— Native Messaging（P0_DEMO_SCOPE §2.2 / ADR-001 E-04） ——
/** 应用层分块上限（字节）。 */
export const NATIVE_MAX_CHUNK_BYTES = 256 * 1024

// —— 本地数据生命周期（P0_DEMO_SCOPE §2.3） ——
/** 默认 TTL（天）。 */
export const TTL_DAYS = 7
/** 单 Session 配额（字节）。 */
export const SESSION_QUOTA_BYTES = 250 * 1024 * 1024;
/** 全局配额（字节）。 */
export const GLOBAL_QUOTA_BYTES = 1024 * 1024 * 1024

// —— QuestionProjection 上限（P0_DEMO_SCOPE §2.4，“全量或不发送”） ——
export const MAX_PAGES = 20
export const MAX_BLOCKS = 200
/** blocks 文本的 UTF-8 总字节上限。 */
export const MAX_PROJECTION_UTF8_BYTES = 512 * 1024
/** 预计输入 Token 硬上限。 */
export const TOKEN_LIMIT_CAP = 32_000
/** 模型上下文预留（输入上限 = min(TOKEN_LIMIT_CAP, ctx - TOKEN_CTX_RESERVE)）。 */
export const TOKEN_CTX_RESERVE = 8_000

/** 普通文本块的最低非空白字符数（heading 只要求非空）。 */
export const MIN_BLOCK_CHARS = 20

/** 输入 Token 上限 = min(32,000, modelContextWindow − 8,000)（P0_DEMO_SCOPE §2.4）。 */
export function projectionTokenLimit(modelContextWindow: number): number {
  return Math.min(TOKEN_LIMIT_CAP, modelContextWindow - TOKEN_CTX_RESERVE)
}

/** QuestionProjection.limits 的冻结值集合（投影创建时原样写入）。 */
export function projectionLimits(modelContextWindow: number) {
  return {
    maxPages: MAX_PAGES,
    maxBlocks: MAX_BLOCKS,
    maxUtf8Bytes: MAX_PROJECTION_UTF8_BYTES,
    maxEstimatedTokens: projectionTokenLimit(modelContextWindow),
  } as const
}
