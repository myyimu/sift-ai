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

### 1.1 模型环境变量（问答链路，2026-08-28 起）

`@sift/model`（OpenAI 兼容 Chat Completions）只从进程环境读取配置，**API Key 永不持久化、
不进日志/投影/store**：

| 变量 | 含义 | 示例 |
|---|---|---|
| `SIFT_MODEL_BASE_URL` | 端点 origin + 可选固定 basePath（https；仅 localhost/127.0.0.1/[::1] 允许 http；path 仅限字母/数字/`._~-` 静态段，禁 query/fragment/userinfo——2026-08-28 放宽，接百炼等国内兼容端点） | `https://api.example.com` 或 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `SIFT_MODEL_API_KEY` | Bearer Key（仅环境，qa-cli 不接收 key 参数） | `sk-…` |
| `SIFT_MODEL_ID` | 模型 ID | `gpt-4o-mini` / `qwen-plus` |
| `SIFT_MODEL_CTX` | 上下文窗口 token 数（投影预算用） | `128000` |

完整 baseUrl（含 path）会显示在 UI 确认屏与顶栏"模型："一行——透明性不因放宽 path 降级。

**百炼（阿里 DashScope）示例**——会话级 env + 启动（不要 `setx`：那会把 Key 写进注册表持久化）：

```powershell
cd E:\sift-ai\apps\desktop\pack2\win-unpacked
$env:SIFT_MODEL_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
$env:SIFT_MODEL_API_KEY  = 'sk-你的百炼Key'     # 百炼控制台 API-KEY 页获取
$env:SIFT_MODEL_ID       = 'qwen-plus'           # 或 qwen-max / qwen-turbo
$env:SIFT_MODEL_CTX      = '128000'
Start-Process .\Sift.exe                          # 子进程继承本次会话的 env
```

qa-cli 可用 flag 覆盖前三者（`--model-base-url/--model-id/--model-ctx`），key 只认环境：

```bash
node apps/desktop/dist/qa-cli.js --store-root <root> --scope latest-session \
  --question "这个页面主要讲了什么？" --out answer.json      # env 未配则报 model_config_missing
```

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
（与 native host 的 allowed_origins 对应）。当前 SW 已包含授权、生命周期撤权、暂停/恢复、
Native Messaging 与捕获状态持久化。

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
| 单元 | `pnpm test` | vitest（426 用例；具体数量以当前输出为准）。**必须从仓库根跑**：`pnpm -r test` 会因 eslint-sift-readonly 包的 root 配置找不到测试文件而误报失败 |
| 全链路（零 Chrome） | `pnpm vitest run apps/extension/test/e2e` | linkedom 夹具 → capture → transport → 真实 host-loop → 真实 FsStore 的 in-process 闭环（含全量重放去重） |
| 模拟 Chrome spike | `node tools/spike/run-e03-spike.mjs` | UI 开/关两态各 100 次 connect/disconnect + 帧往返；`--rounds 10` 快速冒烟 |
| 单链路诊断 | `node tools/spike/manual-roundtrip.mjs [--ui]` | 真实 `.cmd` 链路单次往返；`--ui` 先起 UI 实例 |
| E2E 管道自检 | `node tools/spike/run-chrome-e2e.mjs --cft --plumbing` | 无需注册表；验证 Chrome 启动/扩展加载/SW/报告通道/connectNative 全链触达 |
| 正式 E2E | `node tools/spike/run-chrome-e2e.mjs --cft` | 前置：注册表已 register。判定：UI 开/关两态各 100/100。2026-08-27 基线：p50=116ms |
| **全链问答 E2E** | `node tools/e2e/run-full-chain-e2e.mjs` | 前置：register + 最新 pack2 + `pnpm build && pnpm build:desktop`。真 Chrome 手势（Alt+Shift+S SendKeys）→ 授权/捕获落盘 → qa-cli 真投影 → 本地 mock OpenAI → 校验 → 答案落盘断言 + UI 冒烟。`--mode degrade` 验证 json_schema→json_object 降级（断言变恰好 2 次调用）；`--keep` 保留现场。2026-08-28 基线：strict/degrade 双 PASS |

- `--cft` 自动下载 Chrome for Testing 到 `tools/.cache/cft`（npmmirror 镜像；本机品牌
  Chrome 137+ 忽略 `--load-extension`，故必须用 CfT）。CfT 附加 `--no-sandbox` 的原因与
  其余环境坑见 `tools/spike/README.md`。
- 全链问答 E2E 的 SendKeys 依赖窗口焦点：harness 已用 `AppActivate(chromePid)` +
  隐藏 PowerShell 窗口（实测默认弹窗会抢焦点、手势 100% 闪失）。若仍闪失，失败信息
  会指明直接重跑 + `--keep`；`Alt+Shift+S` 若与其他扩展冲突（`chrome://extensions/shortcuts`）
  Chrome 不绑定该键，需手动确认一次。
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
2. 点击扩展 action 图标（或按 `Alt+Shift+S` command 手势，2026-08-28 起——与点击
   等价，见 P0_EXTENSION_ARCHITECTURE §2.1 批注）→ badge 显示 `S`（授权 + ISOLATED
   注入 + 初始快照）；
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

对**同一页面**再点一次 action 图标：切换暂停/恢复（badge `P`/`S`，不产生新的
`authorization_granted`）；恢复时固定 CS 注入保持幂等；若手动重发同 observation（模拟 commit_ack 丢失），host 靠
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

### 5.6 问答演示：授权 → 投影 → 确认 → 回答（2026-08-28 起）

前置：§5.2 完成（store 里已有授权页面的真实捕获）+ §1.1 模型 env 已配（真实 provider；
E2E 用的 mock 端点见 `node tools/e2e/mock-openai.mjs --port 18789`）。

1. 启动 UI（§2.1，与捕获同一 store）：状态行应显示"已保存到本地"；
2. scope 选目标页面/会话 → 输入问题（或点预设）→ **生成预览**：确认屏展示
   Page/快照数（含滚动历史）/Block/字节/预计 Token、provider baseUrl、model
   与将发送文本预览——**此时模型调用次数为零**（网络只发生在下一步确认之后）；
3. **确认发送** → 状态"正在回答"→ 回答顶部渲染 CoverageManifest 摘要（单元数/
   页面数/站点数/分页覆盖"未穷尽"/观察时段/未覆盖清单），claims 引用块 id，
   analyzer 为本地盖章三元组（provider=端点 host、model=配置值、promptVersion=answer-v1）；
4. 答案文件落 `<store>\..\answers\<inputHash>.json`（自包含 QuestionProjection +
   AnswerProjection，同 inputHash 覆盖 = 可重建语义）；UI "历史回答"列表可回看；
5. 模型失败/校验失败：UI 显示"回答或引用校验失败"或"模型未配置"，本地捕获不受影响。

命令行同路径：`node apps/desktop/dist/qa-cli.js --store-root <root> --scope latest-session
--question "…" --out answer.json`（§1.1）。UI 按钮自动化不做——qa-service 即产品路径，
差异仅在 IPC/渲染层；全链自动化见 §4 "全链问答 E2E"。

数据控制（验收门 14 最小实现）：UI 底部"删除本会话数据"（journal 按 session 分区重写 +
page-state/blob GC）与"删除全部数据"（含 answers 目录，两步确认）。host 持句柄时返回
真实 `store_busy` 而非伪造成功——建议关闭已授权页面后再删。

## 6. 常见问题速查

| 症状 | 原因与处理 |
|---|---|
| 新 UI 实例秒退，报锁 | 残留 Sift.exe 持单实例锁 → `taskkill /F /IM Sift.exe` |
| `pnpm --filter @sift/desktop start` 不起窗口 | 终端继承了 `ELECTRON_RUN_AS_NODE=1` → 干净终端运行 |
| E2E "20s 未收到扩展联系" 且 chrome 日志 0 字节 | CfT 沙箱静默失败（harness 已默认 `--no-sandbox`；自定义启动参数时注意） |
| connectNative 报 `host not found` | 注册表未注册或 manifest path 指向的目录已变 → `status` 查看、`register` 修正 |
| 重打包报 app.asar 被锁 | IDE 监视器占用 → 换 `directories.output` 目录，或参照 `.vscode/settings.json` 排除监视 |
| 全链 E2E 手势 15s×3 未授权 | SendKeys 焦点闪失（直接重跑 + `--keep`）或 `Alt+Shift+S` 被其他扩展占用（`chrome://extensions/shortcuts` 确认） |
| UI 删除数据报 `store_busy` | host 仍持 journal 句柄（页面还授权着）→ 关闭已授权页面后重试；这是诚实失败，不是 bug |
| 授权后反复 `capture_too_little_content: 0 < 80`，页面明明"有内容" | 先分两种：① DOM 里确实无可读正文（97% 文本在 `<script>` 预载 JSON、列表未渲染——会话恢复的后台 tab 常见）→ 刷新 tab 再授权；② **广告 token 误杀**（2026-08-28 linux.do 实测已修复：Discourse welcome-banner 主题在 `<body>` 挂含 `banner` 的类，旧规则整树删除 body）。修复后结构性根元素豁免 + 大容器不剥（P0_DEMO_SCOPE §2.2 批注）；若再遇到，用确认屏诊断计数法上报 |
| `capture_limit_exceeded: nodeCount`（信息流首页滚动后） | 去噪后 DOM 超过冻结上限 50,000 节点，失败关闭属设计行为（不存半张快照）；无限滚动的列表页 DOM 只增不减，滚多必超。上一个成功快照仍有效。demo 包络是文章型页面——Discourse 帖子页楼层有虚拟化、DOM 有界，不受影响；首页刷新后 DOM 重置可重新捕获 |
| 预览里的快照数比页数多、块里含已滚过的内容 | 2026-08-28 起为**块级合并投影**（P0_DEMO_SCOPE §2.4 批注）：每页投影 = 该页全部已 commit 快照的首见并集（textHash 去重、sources 合并、按首见时间排序），滚动看过的楼层都在提问范围内——这是设计语义不是泄漏。代价：长帖全文累积可能超块数预算（同日修订 200→600，用户授权）→ 明确报"超出投影限额"（全量或不发送，不截断）；这是诚实失败，换个更短的阅读范围再问 |

## 7. 文档索引

- 需求与冻结规范：`READ_ONLY_BROWSER_OBSERVER_SPEC.md`、`P0_*.md`、`CAPTURE_ARCHITECTURE.md`
- 工程决策：`ADR-001_DEMO_ENGINEERING.md`（E-01~E-09）、`ADR-002_NATIVE_HOST_REPLACEMENT_DRAFT.md`（host 形态）、`ADR-003_STORE_FILE_SYSTEM.md`（FS store）
- 环境坑全量清单与 spike 工具说明：`tools/spike/README.md`
- 代理/协作约束：`AGENTS.md`
