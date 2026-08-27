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

- **锁步顺序（2026-08-27 起，capture_failed 事件类型加入后）**：扩展与 host 必须
  **先升 desktop 包、再重建/重载扩展**。旧 host 收到第一个 `capture_failed` 会因
  事件类型不在冻结词表而 fail-closed 退出（invalid_message）——顺序颠倒会让捕获
  管道在升级窗口内死掉。`pnpm build`（扩展）与 `pnpm build:desktop`（host）同仓库
  同提交构建即天然同版本；仅手工只更新一侧时注意。

## 4. 测试（从快到慢，全部从仓库根执行）

| 层 | 命令 | 说明 |
|---|---|---|
| 静态 | `pnpm lint` / `pnpm lint:ast` | 全仓 / 观察侧两层规则 |
| 类型 | `pnpm typecheck` | 全部 workspace 包 |
| 单元 | `pnpm test` | vitest（365 用例：shared 契约 / host framing+mode+capture 协议 / store 含读侧 readOnly / extension capture·debounce·transport·SW 生命周期 / projector 抽取·投影·manifest / dump 工具 / eslint 规则正反例）。**必须从仓库根跑**：`pnpm -r test` 会因 eslint-sift-readonly 包的 root 配置找不到测试文件而误报失败 |
| 全链路（零 Chrome） | `pnpm vitest run apps/extension/test/e2e` | linkedom 夹具 → capture → transport → 真实 host-loop → 真实 FsStore 的 in-process 闭环（含全量重放去重） |
| 模拟 Chrome spike | `node tools/spike/run-e03-spike.mjs` | UI 开/关两态各 100 次 connect/disconnect + 帧往返；`--rounds 10` 快速冒烟 |
| 单链路诊断 | `node tools/spike/manual-roundtrip.mjs [--ui]` | 真实 `.cmd` 链路单次往返；`--ui` 先起 UI 实例 |
| E2E 管道自检 | `node tools/spike/run-chrome-e2e.mjs --cft --plumbing` | 无需注册表；验证 Chrome 启动/扩展加载/SW/报告通道/connectNative 全链触达 |
| 正式 E2E | `node tools/spike/run-chrome-e2e.mjs --cft` | 前置：注册表已 register。判定：UI 开/关两态各 100/100。2026-08-27 基线：p50=116ms |

- `--cft` 自动下载 Chrome for Testing 到 `tools/.cache/cft`（npmmirror 镜像；本机品牌
  Chrome 137+ 忽略 `--load-extension`，故必须用 CfT）。CfT 附加 `--no-sandbox` 的原因与
  其余环境坑见 `tools/spike/README.md`。
- E2E 结束后确认无残留：`tasklist /FI "IMAGENAME eq Sift.exe"`（harness 已前置检查并
  树杀回收，正常情况无需手动清理）。

## 5. 手动演示：授权 → 捕获 → 落盘（Phase 2 闭环）

前置：§1 一次性准备完成（含 `register`）。演示的是**用户手势授权当前 Tab → 脱敏 DOM
快照 → Native Messaging → 本地 FS Store** 的完整闭环（ADR-003）。

### 5.1 起本地夹具源

```bash
node tools/scripts/serve-fixtures.mjs        # 127.0.0.1:8765，仅伺服 fixtures/pages/
```

（sanitizeUrl 只放行 http/https，`file://` 打开夹具会被授权判定拒绝——这是设计行为，
不是故障。）

### 5.2 正路径：良性文章页

1. Chrome（已加载 `apps/extension/dist`，§2.3）打开
   `http://127.0.0.1:8765/benign-article.html`；
2. 点击扩展 action 图标 → badge 显示 `S`（授权 + ISOLATED 注入 + 初始快照）；
3. 验证落盘（只读，绝不打印正文）：

```bash
node tools/scripts/dump-store.mjs            # 缺省 %LOCALAPPDATA%\Sift\store
```

预期：`observations.jsonl` 至少 2 行（`authorization_granted` + `dom_snapshot`）、
`page-states` 1 个（url/title 可见、snapshotBlob 为短 hash）、`blobs` ≥ 1 个。

4. 关闭该 Tab → 再 dump：journal 追加 `authorization_revoked`（3 行）。

### 5.3 负路径（安全边界演示）

| 夹具页 | 预期 |
|---|---|
| `sensitive-url.html` | 捕获成功；blob 里的链接 href：token 参数被剔、敏感 path/scheme/host 链接被剥 href（用 `dump-store.mjs` 看行数，内容用 SQLite/编辑器自查 blob 文件） |
| `contenteditable-editor.html` | badge 亮但不落任何 dom_snapshot——编辑区整树丢弃后不足 readable-v1，源端 `capture_too_little_content` 失败关闭；2026-08-27 起该失败持久化为 `capture_failed` 观察行（payload 仅 kind/code/instanceNonce/contentEpoch，无页面内容），诊断详文仍在扩展 SW 的 console（`chrome://extensions` → service worker） |
| 直接访问敏感站（如 mail.google.com）后点图标 | 授权被拒（域名 denylist），无任何落盘 |

### 5.4 幂等重放演示

对**同一页面**再点一次 action 图标：同源幂等（只重注入 CS，不产生新的
`authorization_granted`）；若手动重发同 observation（模拟 commit_ack 丢失），host 靠
journal 幂等返回 `deduplicated`——`pnpm vitest run apps/extension/test/e2e` 里有该场景
的自动化断言（重放后 journal 行数不变、blob 数不变）。

### 5.5 跨源/同源导航与 capture_failed 计数（2026-08-27 起）

前置：§5.2 的授权页还开着（badge 为 `S`）。

1. **跨源导航**：在该 Tab 地址栏访问任一其他 origin 的页面 → 预期 badge 立即清空，
   `dump-store.mjs` 见 `authorization_revoked`（reason=`cross_origin`）追加；
2. **同源导航**：重新授权后在该站内点击任一同源链接 → 预期 badge 保持 `S`，
   dump 见新的 `document_started` + `dom_snapshot`（CS 重注入、观察继续）；
   瞬时注入失败会被误判为跨源（失败关闭方向）——重点 action 即恢复，属已知取舍；
3. **capture_failed 入账**：授权 `contenteditable-editor.html` → dump 行数多出一条
   `capture_failed`（`partialExtractionCount` 的来源）。注意它属控制事件、在
   MAX_QUEUE=8 背压下可被逐出——计数语义是**下界**。

自动化的 mock 语义验证见 `apps/extension/test/service-worker.test.ts`（文件头声明
mock 局限）；真 Chrome 行为以本节手动步骤为准。

## 6. 常见问题速查

| 症状 | 原因与处理 |
|---|---|
| 新 UI 实例秒退，报锁 | 残留 Sift.exe 持单实例锁 → `taskkill /F /IM Sift.exe` |
| `pnpm --filter @sift/desktop start` 不起窗口 | 终端继承了 `ELECTRON_RUN_AS_NODE=1` → 干净终端运行 |
| E2E "20s 未收到扩展联系" 且 chrome 日志 0 字节 | CfT 沙箱静默失败（harness 已默认 `--no-sandbox`；自定义启动参数时注意） |
| connectNative 报 `host not found` | 注册表未注册或 manifest path 指向的目录已变 → `status` 查看、`register` 修正 |
| 重打包报 app.asar 被锁 | IDE 监视器占用 → 换 `directories.output` 目录，或参照 `.vscode/settings.json` 排除监视 |

## 7. 文档索引

- 需求与冻结规范：`READ_ONLY_BROWSER_OBSERVER_SPEC.md`、`P0_*.md`、`CAPTURE_ARCHITECTURE.md`
- 工程决策：`ADR-001_DEMO_ENGINEERING.md`（E-01~E-09）、`ADR-002_NATIVE_HOST_REPLACEMENT_DRAFT.md`（host 形态）、`ADR-003_STORE_FILE_SYSTEM.md`（FS store）
- 环境坑全量清单与 spike 工具说明：`tools/spike/README.md`
- 代理/协作约束：`AGENTS.md`
