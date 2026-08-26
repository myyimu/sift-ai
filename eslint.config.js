// 仓库根 flat config。sift-readonly 两层规则（ADR-001 E-09）应用于所有观察/离屏 DOM 代码：
// - apps/extension/src：content script 与 service worker（页面观察侧）
// - packages/projector/src：demo-projector-v1（离线 DOM，同样不允许 document 根写）
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import { siftReadonlyRules } from '@sift/eslint-config-readonly'

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/*.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/extension/src/**/*.ts', 'packages/projector/src/**/*.ts'],
    rules: siftReadonlyRules,
  },
)
