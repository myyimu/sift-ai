import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const script = resolve(root, 'tools/scripts/demo-preflight.mjs')

describe('demo-preflight 安全输出', () => {
  it('never prints the model API key', () => {
    const secret = 'demo-preflight-secret-should-never-leak'
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SIFT_MODEL_BASE_URL: 'https://api.example.com/v1',
        SIFT_MODEL_API_KEY: secret,
        SIFT_MODEL_ID: 'demo-model',
        SIFT_MODEL_CTX: '128000',
      },
      windowsHide: true,
    })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    expect(output).not.toContain(secret)
    expect(output).toContain('API key 已隐藏')
  })
})
