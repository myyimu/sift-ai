// esbuild 打包 desktop 入口：
//  - src/main.ts       -> dist/main.js        UI 主入口（package.json "main"）
//  - src/host-main.ts  -> dist/host-main.js   host 真实入口（extraResources 单文件，
//    由 SiftHost.cmd 以 ELECTRON_RUN_AS_NODE=1 加载，见 main.ts 注释/ADR-002）
//  - src/qa-cli.ts     -> dist/qa-cli.js      问答链路 node 直跑入口（E2E/脚本用）
//  - src/ui/preload.ts -> dist/ui/preload.js  渲染层唯一桥（CJS：sandbox 预载不支持 ESM）
//  - src/ui/renderer.ts -> dist/ui/renderer.js + renderer.css（browser 平台；styles.css
//    经 import 打包出独立 css——渲染层无内联样式，CSP style-src 'self'）
// index.html 原样复制。electron 与 node 内建标记 external。
import { build } from 'esbuild'
import { copyFile, mkdir, rm } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })
await mkdir('dist/ui', { recursive: true })

const common = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
}

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js' })
await build({ ...common, entryPoints: ['src/host-main.ts'], outfile: 'dist/host-main.js' })
await build({ ...common, entryPoints: ['src/qa-cli.ts'], outfile: 'dist/qa-cli.js' })
await build({ ...common, format: 'cjs', entryPoints: ['src/ui/preload.ts'], outfile: 'dist/ui/preload.js' })
await build({
  ...common,
  platform: 'browser',
  target: 'chrome120',
  entryPoints: ['src/ui/renderer.ts'],
  outfile: 'dist/ui/renderer.js',
})
await copyFile('src/ui/index.html', 'dist/ui/index.html')
