// esbuild 打包 desktop 两个入口：
//  - src/main.ts     -> dist/main.js     双模式主入口（package.json "main"）
//  - src/host-main.ts -> dist/host-main.js  host 真实入口（extraResources 单文件，
//    由主入口 host 分支以 ELECTRON_RUN_AS_NODE=1 spawn 加载，见 main.ts 注释）
// electron 与 node 内建标记 external。
import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })

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
