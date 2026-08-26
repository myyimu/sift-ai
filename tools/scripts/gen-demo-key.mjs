// 生成 MV3 manifest 的固定 demo key（RSA-2048 公钥，SPKI DER 的 base64），
// 并按 Chromium 规则推导稳定 Extension ID：SHA-256(DER) 前 16 字节的每个字节
// 拆高低半字节（共 32 个 nibble），每个 nibble 0..15 映射到 a..p，得到 32 字符 ID。
//
// 只输出公钥——unpacked 加载不需要私钥；demo 不打 .crx，私钥不落盘。
// 依据：ADR-001 E-02 / P0_DEMO_SCOPE §2.1（固定 demo key 得到稳定 Demo Extension ID）。
import { generateKeyPairSync, createHash } from 'node:crypto'

const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
})
const der = publicKey.export({ type: 'spki', format: 'der' })
const keyField = der.toString('base64') // manifest "key" 字段格式

const id = Array.from(
  createHash('sha256').update(der).digest().subarray(0, 16),
  b => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)), // 高低 nibble -> a..p
).join('')

console.log(JSON.stringify({ keyField, extensionId: id }, null, 2))
