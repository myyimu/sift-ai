# Sift AI

[English](README.md) · [安全策略](SECURITY.md) · [隐私说明](PRIVACY.md) · [贡献指南](CONTRIBUTING.md)

> **人负责探索互联网，AI 负责阅读和整理。**

**你负责寻找信息，Sift AI 负责把它读完。它会从你打开的一批网页中提炼重点、比较观点，筛出最值得亲自阅读的原文；每条结论都能追溯到出处。**

长期目标很直接：即使面对 1000 条内容，你也不必逐条扫完，就能迅速看清主要话题，并找到最值得打开的那几条原文。

互联网并不缺信息，真正稀缺的是人的阅读时间。论坛热榜、评论区、GitHub Issues、产品社区和
行业资料不断更新。你可以打开这些页面，浏览器也已经完成访问和渲染，但靠人工很难在有限时间
里读完、比较、去重并持续跟踪。AI 虽然读得快，却往往看不到你刚才浏览过的完整内容，也没有
一个可信、连续、可以回查的证据库。

Sift AI 要补上的正是这个缺口：你照常使用自己的 Chrome，自己选择信息源并完成所有浏览；
Sift 只记录你明确授权的页面，在本地整理成可重复分析的证据。之后，AI 可以在你选定的范围内
回答问题、归纳主题，并在未来帮助你发现值得持续关注的变化。

## 这个设想为什么有价值

它不是又一个“总结当前网页”的按钮。Sift 面向的是一批页面、一次研究过程，以及你在一段时间
里主动接触的信息：

- **放大阅读带宽**：把几十个页面、长帖和评论压缩成主要主题、争议、反方观点与少数高价值原文；
- **跨来源建立联系**：发现不同社区反复出现的问题、相互矛盾的判断和刚刚冒头的新概念；
- **结论可回查**：回答不是悬空摘要，每个 claim 都必须引用本次范围内的真实证据，用户可一键回到来源；
- **形成个人信息雷达**：今天先回答“刚才看到了什么”，未来在稳定历史基线上回答“什么首次出现、
  正在扩散或值得持续关注”；
- **数据仍属于用户**：捕获、历史和索引默认留在本地，远程模型只接收用户本次预览并确认的有界证据。

一个典型过程可以是：

```text
你手动浏览一批论坛帖子、Issue 和评论
  -> Sift 记住已授权页面及滚动过程中出现过的内容
  -> 你问：“这批讨论真正的争议是什么？哪些原文值得我亲自看？”
  -> AI 返回跨页面结论，每条绑定证据与原网页
  -> 未来：同一份本地证据生成主题地图，并与历史基线比较，浮现弱信号
```

关键分工不是“让 AI 接管浏览器”，而是充分利用双方各自擅长的部分：

```text
人：选择信息源、登录、导航、判断结论
浏览器：完成真实网站访问与渲染
Sift 数据层：只读捕获、脱敏、去重、存储和证据投影
AI：在明确范围内高速阅读、比较、聚合和解释
```

这条路线避开了浏览器 Agent 的失控风险，也不需要把产品做成与网站持续对抗的爬虫。网页访问
始终由用户掌控；AI 得到的是经过筛选、可以审计的阅读材料，而不是浏览器操作能力。

## 愿景与当前落点

| 阶段 | 能力 | 要验证的价值 |
|---|---|---|
| **P0（已实现）** | 主动授权的 DOM 捕获、本地证据库、有界跨页面问答、Answer + Sources | 有来源的批量阅读能否显著节省时间 |
| **P0.5（下一步）** | 内容身份与去重、Topic Cloud、克制的桌面信息雷达入口 | 用户能否快速看懂一段时间内接触的主要主题 |
| **后续阶段** | 稳定主题、关系图、Signal Ranking、历史基线与混合检索 | 能否可靠发现升温、新颖、跨来源扩散的弱信号 |

后两行是已经写入规范的产品方向，不是当前代码的功能声明。Sift 先把最困难、也最值得被信任的
基础打牢：可靠捕获、清晰授权、本地事实源、确定性投影和可验证引用。

> **当前发布级别：Alpha 源码预览。** Sift AI 目前是 Windows-only 的内部 P0 Demo，
> 不是生产版本，不支持登录态或敏感页面，也未通过 Chrome Web Store 分发。

P0 已经跑通第一条完整价值链：

```text
用户在 Chrome 中主动授权
  -> 固定 MV3 ISOLATED content script
  -> 已脱敏 DOM snapshot
  -> Chrome Native Messaging
  -> 本地 Observation Store
  -> 显式选择范围并预览投影
  -> 用户确认远程模型处理
  -> 本地校验回答与证据引用
```

它不是浏览器 Agent、爬虫、OCR、后台 RAG 服务或浏览器自动化框架；这些非目标正是为了让
“人控制访问、AI 专注理解”成为可信的产品能力，而不只是宣传语。

## 当前状态

仓库已经实现 P0 纵向链路：

- Extension 权限仅为 `activeTab`、`scripting`、`nativeMessaging`、`storage`；
- 固定主 frame、`ISOLATED` world content script；
- 初始 Snapshot 与经 debounce/maxWait 合并的 MutationObserver 捕获；
- 源端脱敏、敏感页拒绝、资源上限与内容 hash；
- 分块、schema 校验、失败关闭、幂等的 Native Messaging；
- 本地 Observation Journal、内容寻址 blob 与 Page State；
- 确定性、有明确预算的 QuestionProjection；
- 用户预览并确认前，模型调用次数为零；
- OpenAI-compatible Chat Completions 与本地 AnswerProjection 校验；
- CoverageManifest 和本地删除控制；
- 脱敏证据/来源卡片，以及用户点击后重新校验并打开的原网页链接；
- 可过期的 Native Host 状态租约与更精确的捕获失败状态；
- 只保留 hash/ID/时间和人工评分的本地内部 Demo 指标。

当前 Alpha 限制：

- 分发仍是 unpacked Extension + 手工注册、未签名的 Windows 目录包，没有安装器、更新器或
  Chrome Web Store 版本；
- 只支持公开、非敏感、文本型主 frame 页面；
- iframe、Shadow DOM、Canvas、高度虚拟化列表和部分复杂 SPA 仍然部分支持或不支持；
- Demo 评估事件只留在本地，不是生产遥测或分析服务。

唯一当前范围以 [P0_DEMO_SCOPE.md](P0_DEMO_SCOPE.md) 为准。仓库里的 P0.5 文档是未来
契约，不代表对应能力已经实现。

## 安全与隐私边界

- 导航、点击、输入、滚动、登录和提交始终由人完成；
- 只有 Chrome 认可的当前 Tab 用户手势才能启动捕获；
- 跨 origin 后立即撤销授权，必须重新由用户授权；
- 捕获链路不访问页面 URL，也不加载远程提取代码；
- 表单控件、可编辑区域、已知密钥模式和敏感 URL 参数在 Native Messaging 前被剥离或拒绝；
- 数据默认只留在本地；只有用户看到有界投影并针对本次操作确认后才调用模型；
- 模型 API Key 只从进程环境读取，Sift 不持久化它。

Chrome 不提供物理强制的只读 content-script 权限；`activeTab + scripting` 技术上能够修改
页面。本项目依靠固定 bundle、模型链路隔离、受限 AST 规则和 DOM/focus/scroll canary
测试约束只读行为，不能把它宣传为“浏览器强制的只读沙箱”。

评估或部署前请阅读 [SECURITY.md](SECURITY.md)、[PRIVACY.md](PRIVACY.md) 和
[P0_EXTENSION_ARCHITECTURE.md](P0_EXTENSION_ARCHITECTURE.md)。

## 环境要求

- Windows 10/11 x64
- 开启开发者模式的 Google Chrome
- 推荐 Node.js 24 LTS，同时支持 Node.js 22 LTS
- pnpm 10.14.0，可通过 Corepack 管理

## 构建

在仓库根目录运行：

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm build:desktop
pnpm --filter @sift/desktop package:dir
```

产物：

- unpacked Extension：`apps/extension/dist`
- 桌面目录包：`apps/desktop/pack2/win-unpacked`

## 运行 Demo

1. Chrome 打开 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，目录为
   `apps/extension/dist`。
2. 为当前 Windows 用户注册 Native Host：

   ```powershell
   node tools/scripts/register-sift-native-host.mjs register
   ```

3. 启动 `apps/desktop/pack2/win-unpacked/Sift.exe`。
4. 打开公开、非敏感文本页，通过扩展图标或 `Alt+Shift+S` 主动授权当前页面。
5. 在桌面窗口选择本地页面或 Session，输入问题，检查投影预览，再明确确认远程模型处理。

捕获不需要模型；问答需要配置 OpenAI-compatible endpoint：

```powershell
$env:SIFT_MODEL_BASE_URL = 'https://your-compatible-endpoint.example/v1'
$env:SIFT_MODEL_API_KEY = 'your-api-key'
$env:SIFT_MODEL_ID = 'your-model-id'
$env:SIFT_MODEL_CTX = '128000'
```

不要用 `setx` 保存模型密钥，它会把值持久化到 Windows 注册表。完整安装、夹具服务器、诊断、
重建和卸载说明见 [RUNBOOK.md](RUNBOOK.md)。

## 测试

```powershell
pnpm lint
pnpm lint:ast
pnpm typecheck
pnpm test
pnpm build
pnpm build:desktop
```

真实 Chrome/Native Host 测试需要桌面打包产物和当前用户级 Host 注册，命令与前置条件见
[RUNBOOK.md](RUNBOOK.md)。

## 仓库结构

```text
apps/extension/   MV3 授权、捕获与 Native Messaging transport
apps/desktop/     Electron UI、Native Host 入口和本地 QA service
packages/host/    framing 与捕获协议
packages/store/   本地 Observation Store 与维护
packages/projector/ 确定性 Evidence/Question Projection
packages/model/   模型适配与 AnswerProjection 校验
packages/shared/  schema、限额、脱敏和共享契约
fixtures/         仅包含合成的安全与抽取夹具
tools/            注册、诊断、E2E 和只读 lint 工具
```

架构决策见 `ADR-*.md`，产品背景见
[READ_ONLY_BROWSER_OBSERVER_SPEC.md](READ_ONLY_BROWSER_OBSERVER_SPEC.md)。新贡献者应先阅读
[CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。

## 删除数据

桌面 UI 支持删除 Page、Session 或全部本地数据。移除开发用 Native Host 注册：

```powershell
node tools/scripts/register-sift-native-host.mjs remove
```

默认数据目录和人工核验方法见 [PRIVACY.md](PRIVACY.md) 与 [RUNBOOK.md](RUNBOOK.md)。

## 贡献与许可

欢迎贡献，但所有变更必须保持人控制、最小权限、本地优先和网页输入不可信等边界。提交 PR 前
阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题按 [SECURITY.md](SECURITY.md) 私下报告。

项目使用 [Apache License 2.0](LICENSE)，第三方依赖与再分发说明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

“Sift AI”是暂定项目名，本仓库与其他使用“Sift”或“Sift AI”名称的产品及公司无关联。
