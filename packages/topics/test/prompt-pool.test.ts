import { describe, expect, it } from 'vitest'
import { PROMPT_POOL_VERSION, promptPool, selectPromptPool } from '../src/prompt-pool'

describe('versioned prompt pool', () => {
  it('is deterministic and metadata-only', () => {
    expect(PROMPT_POOL_VERSION).toBe('prompt-pool-v1')
    expect(promptPool()).toHaveLength(6)
    expect(selectPromptPool({ pages: 1 }, 3).map(item => item.id)).toEqual(['summary', 'claims', 'evidence'])
    expect(selectPromptPool({ pages: 2 }, 6).map(item => item.id)).toContain('compare')
    expect(selectPromptPool({ pages: 1 }, 0)).toHaveLength(3)
  })
})
