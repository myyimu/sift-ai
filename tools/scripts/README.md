# tools/ —— 开发与注册脚本

## 环境

- Node.js >= 22.23.0 且 <27、pnpm >= 10、Windows 10/11 x64（Demo 单目标，ADR-001 E-01/E-02）。
- 依赖安装（仓库根）：`pnpm install`。

## 常用命令（仓库根）

| 命令 | 作用 |
| --- | --- |
| `pnpm lint` | 全仓 eslint（含 sift-readonly 两层规则） |
| `pnpm lint:ast` | 只检查 `apps/extension/src`（观察侧代码） |
| `pnpm test` | vitest（shared 契约 / host framing+mode / eslint 规则正反例） |
| `pnpm preflight` | 只读检查 Node、构建产物、Extension 权限、Native Host 注册和模型配置 |
| `pnpm demo:build` | 依次构建 Extension、桌面端并生成 `pack2/win-unpacked` 目录包；不注册 Host |
| `pnpm typecheck` | 各包 tsc --noEmit |
| `pnpm build` | esbuild 打包 extension -> `apps/extension/dist/` |

## 加载 Demo Extension（Chrome 开发者模式）

1. `pnpm build`；
2. Chrome -> 扩展程序 -> 开发者模式 -> 加载已解压的扩展程序 -> 选择 `apps/extension/dist`；
3. 固定 demo key 使 Extension ID 恒为 `jhkdmlohebjffokfonhiijhhmocfcppo`（`EXTENSION_ID` 常量，
   `packages/shared/src/limits.ts` 与 `tools/scripts/sift-demo-constants.mjs` 双源同步，
   `tools/scripts/demo-key.test.mjs` 从 manifest key 按算法反推校验防漂移）。

## 注册 / 注销 Native Host（ADR-001 E-03）

前置：`pnpm demo:build` 完成后，产物位于 `apps/desktop/pack2/win-unpacked/`，其中
`SiftHost.cmd` 是 Chrome Native Messaging 的唯一注册入口（ADR-002）；不要把 manifest
直接指向 GUI `Sift.exe`。

```powershell
# 查询（只读）
node tools/scripts/register-sift-native-host.mjs status

# 注册（HKCU，无需管理员；会写入当前用户注册表；allowed_origins 只含固定 demo Extension ID）
node tools/scripts/register-sift-native-host.mjs register

# 注销（删除本脚本生成的注册项与 manifest）
node tools/scripts/register-sift-native-host.mjs remove
```

host manifest 落在 `%LOCALAPPDATA%\Sift\native-host\com.dj.sift.demo.json`，`path`
固定指向打包目录下的 `SiftHost.cmd`。

## 重新生成 demo key（通常不需要）

`node tools/scripts/gen-demo-key.mjs` 会生成新的 RSA-2048 公钥并推导 Extension ID。
**注意**：demo key 已固化——重新生成会使 Extension ID 变化，必须同步更新
`apps/extension/public/manifest.json` 的 `key`、两个常量文件与 `packages/shared/test/limits.test.ts`
的断言，并重新注册 host。除非刻意轮换，不要运行它。

## 脚本清单

- `gen-demo-key.mjs` —— 生成 manifest key + Extension ID（一次性，已固化）。
- `sift-demo-constants.mjs` —— .mjs 侧固定标识常量源。
- `make-host-manifest.mjs` —— 生成 native host manifest JSON。
- `register-sift-native-host.mjs` —— 当前 ADR-002 注册/查询/回滚入口；仅操作 HKCU 和本脚本生成的 manifest。
- `register-host.ps1` / `unregister-host.ps1` —— 历史兼容脚本；不用于当前 `SiftHost.cmd` 架构。
- `dump-store.mjs` —— SiftStore 只读摘要（journal/page-state/blob 计数；**绝不打印 html 正文**）。用法：`node tools/scripts/dump-store.mjs [storeRoot]`，缺省 `%LOCALAPPDATA%\Sift\store`。回归测试 `dump-store.test.mjs`。
- `demo-model.env.example` —— OpenAI-compatible 模型环境变量模板（空 Key，占位用；不会自动加载）。
- `serve-fixtures.mjs` —— 手动演示用静态服务器（仅 127.0.0.1、仅 `fixtures/pages/`；缺省端口 8765）。sanitizeUrl 不放行 `file://`，演示夹具必须走 http。
- `../eslint-sift-readonly/` —— eslint 两层规则集及其正反例测试。
