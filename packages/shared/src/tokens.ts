// 确定性 Token 估算与内容寻址 hash。
// estimateTokens 依据 ADR-001 E-07：ceil(ASCII 码点数 / 4) + 非 ASCII 码点数。
// 它是纯函数并进入 QuestionProjection.inputHash，因此实现永远不得引入随机性、
// 环境差异或词典依赖；任何改动都等于更换 inputHash 语义（需要版本化）。
//
// 运行环境约束：本模块同时被打进 MV3 service worker / content script bundle，
// 因此只允许纯 JS，不允许 node:crypto 或任何运行时依赖（ADR-001 §1：content script 零运行时依赖）。

/** 按 ADR-001 E-07 估算输入 Token 数。按 Unicode 码点（不是 UTF-16 单元）计数。 */
export function estimateTokens(text: string): number {
  let ascii = 0
  let nonAscii = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    if (cp <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4) + nonAscii
}

/** 文本的 UTF-8 字节数（用于 MAX_PROJECTION_UTF8_BYTES 判定）。TextEncoder 在浏览器与 Node 20 均可用。 */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}
