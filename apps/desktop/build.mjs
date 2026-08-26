// esbuild 打包 desktop main：electron 与 node 内建标记 external，
// 产物 dist/main.js（ESM），由 package.json "main" 指向。
import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/main.js',
  external: ['electron'],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
})
