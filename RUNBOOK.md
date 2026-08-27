# RUNBOOK —— 启动 / 重启 / 测试

适用范围：P0 Demo 当前基线（ADR-002 落地后）。以下命令均在本机 Windows 实测通过；
架构决策见 ADR-002，完整环境坑清单见 `tools/spike/README.md`。

## 0. 角色速览

| 组件 | 形态 | 生命周期 |
|---|---|---|
| Sift UI | `apps/desktop/pack2/win-unpacked/Sift.exe`（GUI 模式） | 用户启动；单实例锁（第二实例快速退出） |
| Native Host | 同一 `Sift.exe`，经 `SiftHost.cmd` 以 `ELECTRON_RUN_AS_NODE=1` 进入纯 Node | Chrome 每次连接 spawn、断开即退出，无需手动启动/重启 |
| 注册表 | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dj.sift.demo` → `%LOCALAPPDATA%\Sift\native-host\*.json` → `SiftHost.cmd` | Chrome 发现宿主的唯一入口 |
| 产品扩展 | `apps/extension/dist`（MV3，固定 ID `jhkdmlohebjffokfonhiijhhmocfcppo`） | 开发时手动 Load unpacked |

## 1. 一次性准备

```bash
pnpm install                                  # .npmrc 已配 Electron 镜像
pnpm build                                    # 扩展 -> apps/extension/dist
pnpm build:desktop                            # 桌面双入口 -> apps/desktop/dist
pnpm --filter @sift/desktop package:dir       # electron-builder --dir -> pack2/win-unpacked
node tools/scripts/register-sift-native-host.mjs register   # 写 HKCU + manifest（见 §2.4）
```

- `package:dir` 输出目录由 `electron-builder.yml` 的 `directories.output` 决定（当前 `pack2`；
  IDE 文件监视器锁 `app.asar` 时换一个输出目录再打）。
- `register` 会写注册表（仅 HKCU、仅 Chrome 键）和 `%LOCALAPPDATA%\Sift\native-host\` 清单，
  `remove` 可完整回滚——执行前确认这是你想要的写操作。

## 2. 启动

### 2.1 UI（打包产物）
双击 `apps/desktop/pack2/win-unpacked/Sift.exe`，或命令行启动。就绪标志：stderr 打印
`[sift] UI mode ready`。第二个实例因单实例锁立即退出（属预期行为）。

### 2.2 UI（开发模式）
```bash
pnpm --filter @sift/desktop start             # electron .
```
注意：Electron 系 IDE 的集成终端会带 `ELECTRON_RUN_AS_NODE=1`，被 `electron .` 继承后
不起窗口——在干净终端（或先 `unset ELECTRON_RUN_AS_NODE`）里跑。

### 2.3 开发用产品扩展
Chrome 打开 `chrome://extensions` → Developer mode → Load unpacked → 选
`apps/extension/dist`。manifest 带 key，加载后即固定 ID `jhkdmlohebjffokfonhiijhhmocfcppo`
（与 native host 的 allowed_origins 对应）。当前 SW 为骨架（action 点击注入 +
sendNativeMessage 通道），实现进度见 P0_DEMO_SCOPE 路线图。

### 2.4 注册表（native host 发现）
```bash
node tools/scripts/register-sift-native-host.mjs status    # 只读，随时可跑
node tools/scripts/register-sift-native-host.mjs register  # 写入（前置：pack2 产物存在）
node tools/scripts/register-sift-native-host.mjs remove    # 回滚（只删本脚本写入的键与文件）
```
manifest 的 path 指向 `pack2\win-unpacked\SiftHost.cmd`——重新打包到别的目录后需重跑
`register` 更新路径。

## 3. 重启

- **UI**：结束进程后重新启动。若有残留实例（不可见窗口但持单实例锁，新实例会报
  `another instance holds the lock`）：`taskkill /F /IM Sift.exe` 后再启动。
- **Native host**：无重启概念。Chrome 每次 `connectNative` 都重新 spawn，改了 host 侧
  代码只需重新打包（见下），下一次连接即生效。
- **代码更新后的完整重建链**：
  ```bash
  pnpm build && pnpm build:desktop && pnpm --filter @sift/desktop package:dir
  node tools/spike/run-e03-spike.mjs --rounds 10   # 快速复验（可选）
  ```
  若打包输出目录变化，重跑 `register`（§2.4）。

## 4. 测试（从快到慢，全部从仓库根执行）

| 层 | 命令 | 说明 |
|---|---|---|
| 静态 | `pnpm lint` / `pnpm lint:ast` | 全仓 / 观察侧两层规则 |
| 类型 | `pnpm typecheck` | 全部 workspace 包 |
| 单元 | `pnpm test` | vitest（96 用例）。**必须从仓库根跑**：`pnpm -r test` 会因 eslint-sift-readonly 包的 root 配置找不到测试文件而误报失败 |
| 模拟 Chrome spike | `node tools/spike/run-e03-spike.mjs` | UI 开/关两态各 100 次 connect/disconnect + 帧往返；`--rounds 10` 快速冒烟 |
| 单链路诊断 | `node tools/spike/manual-roundtrip.mjs [--ui]` | 真实 `.cmd` 链路单次往返；`--ui` 先起 UI 实例 |
| E2E 管道自检 | `node tools/spike/run-chrome-e2e.mjs --cft --plumbing` | 无需注册表；验证 Chrome 启动/扩展加载/SW/报告通道/connectNative 全链触达 |
| 正式 E2E | `node tools/spike/run-chrome-e2e.mjs --cft` | 前置：注册表已 register。判定：UI 开/关两态各 100/100。2026-08-27 基线：p50=116ms |

- `--cft` 自动下载 Chrome for Testing 到 `tools/.cache/cft`（npmmirror 镜像；本机品牌
  Chrome 137+ 忽略 `--load-extension`，故必须用 CfT）。CfT 附加 `--no-sandbox` 的原因与
  其余环境坑见 `tools/spike/README.md`。
- E2E 结束后确认无残留：`tasklist /FI "IMAGENAME eq Sift.exe"`（harness 已前置检查并
  树杀回收，正常情况无需手动清理）。

## 5. 常见问题速查

| 症状 | 原因与处理 |
|---|---|
| 新 UI 实例秒退，报锁 | 残留 Sift.exe 持单实例锁 → `taskkill /F /IM Sift.exe` |
| `pnpm --filter @sift/desktop start` 不起窗口 | 终端继承了 `ELECTRON_RUN_AS_NODE=1` → 干净终端运行 |
| E2E "20s 未收到扩展联系" 且 chrome 日志 0 字节 | CfT 沙箱静默失败（harness 已默认 `--no-sandbox`；自定义启动参数时注意） |
| connectNative 报 `host not found` | 注册表未注册或 manifest path 指向的目录已变 → `status` 查看、`register` 修正 |
| 重打包报 app.asar 被锁 | IDE 监视器占用 → 换 `directories.output` 目录，或参照 `.vscode/settings.json` 排除监视 |

## 6. 文档索引

- 需求与冻结规范：`READ_ONLY_BROWSER_OBSERVER_SPEC.md`、`P0_*.md`、`CAPTURE_ARCHITECTURE.md`
- 工程决策：`ADR-001_DEMO_ENGINEERING.md`（E-01~E-09）、`ADR-002_NATIVE_HOST_REPLACEMENT_DRAFT.md`（host 形态）
- 环境坑全量清单与 spike 工具说明：`tools/spike/README.md`
- 代理/协作约束：`AGENTS.md`
