// esbuild 打包：content script（IIFE、零运行时依赖）与 service worker（ESM）。
// 产物 + manifest 拷贝到 dist/，Chrome 开发者模式加载 dist/ 目录。
import { build } from 'esbuild'
import { cp } from 'node:fs/promises'

const common = {
  bundle: true,
  target: 'chrome109',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
}

await build({
  ...common,
  entryPoints: ['src/content-script.ts'],
  format: 'iife',
  outfile: 'dist/content-script.js',
})

await build({
  ...common,
  entryPoints: ['src/service-worker.ts'],
  format: 'esm',
  outfile: 'dist/service-worker.js',
})

await cp('public', 'dist', { recursive: true })
