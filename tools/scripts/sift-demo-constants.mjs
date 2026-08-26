// Demo 固定标识的唯一常量源（.mjs 侧）。
// 与 packages/shared/src/limits.ts 保持同步——那边有 vitest 断言防漂移
//（packages/shared/test/limits.test.ts 会校验 EXTENSION_ID 字面量）。
// 值来源：tools/scripts/gen-demo-key.mjs 生成并固化于 2026-08-26。

/** 固定 demo key 推导的 Extension ID（32 字符：SHA-256 前 16 字节高低 nibble -> a-p）。 */
export const EXTENSION_ID = 'jhkdmlohebjffokfonhiijhhmocfcppo'

/** Native messaging host 注册名。 */
export const NATIVE_HOST_NAME = 'com.dj.sift.demo'

/** host manifest allowed_origins 唯一条目。 */
export const NATIVE_HOST_ALLOWED_ORIGIN = `chrome-extension://${EXTENSION_ID}/`
