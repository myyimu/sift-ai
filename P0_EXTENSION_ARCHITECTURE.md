# Sift AI P0：Extension DOM Capture 架构

> 状态：P0 Demo 浏览器接入规范。当前端到端范围以 `P0_DEMO_SCOPE.md` 为准；Unit 数据/抽取和 Topic Cloud 已降级到 P0.5，分别见 `P0_ANALYSIS_UNIT_SPEC.md`、`P0_UNIT_EXTRACTOR_SPEC.md`、`P0_TOPIC_CLOUD_SPEC.md`。若其他文档仍要求 P0 使用专用 Chromium、外部 CDP 调试端口或 `chrome.debugger`，以本文件为准并修订冲突。
>
> 核心原则：CDP 不是产品原则；“用户控制浏览器，AI 没有浏览器操作能力”才是产品原则。

## 1. P0 架构冻结

```text
用户自己的 Chrome
      ↓ 用户主动授权当前 Tab
Manifest V3 Extension
  activeTab + scripting
      ↓
ISOLATED content script
  DOM 初始快照 + MutationObserver
      ↓
extension service worker
      ↓ Native Messaging
Desktop Host / Local Capture Store
      ↓ 用户选择当前页面或小型 Demo Session
DemoEvidenceProjection / QuestionProjection
      ↓ 用户预览、确认并提交问题
AI API / Local Model
      ↓
AnswerProjection 校验 + Sources

Desktop UI
└── 简单窗口/托盘面板：状态、预览、自由提问、Answer + Sources
```

P0 明确不使用：

- 专用 Chromium 或第二套浏览器 Profile；
- `--remote-debugging-port`、`--remote-debugging-pipe`；
- `chrome.debugger`；
- CDP client、CDP command/event allowlist；
- `<all_urls>`、必选全站 host permission；
- XHR/Fetch response body、AX Tree、DOMSnapshot；
- 自动点击、滚动、导航、输入或提交；
- 后台 LLM 总结、Embedding、自动聚类、趋势或主动 Signal；
- 当前 Demo 中的 UnitExtractor、CanonicalUnit、Topic Cloud 和桌宠。

## 2. 用户授权模型

### 2.1 默认：一次用户手势授权当前 Tab

P0 使用：

```json
{
  "manifest_version": 3,
  "permissions": [
    "activeTab",
    "scripting",
    "nativeMessaging",
    "storage"
  ]
}
```

约束：

- 用户必须通过扩展 action、快捷键或其他 Chrome 认可的手势启用观察；
- `activeTab` 只授予当前 Tab 的临时 host permission；
- 同源页面内导航可以继续观察；
- 跳转到不同 origin、关闭 Tab 或权限被撤销时，立即停止捕获；
- 权限失效后，桌宠必须显示“未授权/观察已停止”，不得继续显示“正在记录”；
- 新 origin 必须再次由用户主动授权；
- P0 不申请 `tabs`、`history`、`webNavigation` 或 `<all_urls>`，避免为尚未验证的能力扩大权限和安装警告。

`chrome.tabs` 的非敏感事件可以在不声明 `tabs` 权限时使用；URL/title 等敏感字段只在当前 `activeTab` 授权有效时读取。

### 2.2 后续：站点级持续授权

只有真实使用证明“每次跨页面重新启用”造成明显摩擦时，才允许增加：

```json
{
  "optional_host_permissions": [
    "https://*/*",
    "http://*/*"
  ]
}
```

这只是声明可在运行时申请的范围，不代表默认获得全站访问。要求：

- 必须在用户手势中按具体 origin 请求；
- UI 明确解释用途、范围和撤销方法；
- 每个 origin 单独展示与撤销；
- 不得用“始终允许所有网站”作为默认或诱导选项；
- 权限撤销后立即卸载该 origin 的观察器并清理运行状态；
- 数据删除与权限撤销是两个独立动作，UI 必须分别提供。

### 2.3 不支持的页面

P0 对无法注入 content script 的页面明确返回 unsupported，例如浏览器内部页面、受 Chrome 限制的页面、未授权 frame 或其他禁止注入的 scheme。不得偷偷回退到 CDP、截图 OCR 或外部抓取。

## 3. Extension Capture Adapter

### 3.1 注入规则

Chrome 没有“只读 content script”权限；`activeTab + scripting` 注入的代码在技术上能够修改共享 DOM。因此 P0 的强能力边界是“AI、网页和桌面端永远拿不到注入/执行入口”，而 Extension 自身的只读性质必须由可审计实现和测试保证，不能声称由 Chrome 物理强制。

- 只通过 `chrome.scripting.executeScript` 注入扩展包内固定文件；
- 只使用 `files` 注入，不使用运行时 `func`/字符串拼接；
- 固定使用 `world: "ISOLATED"`；
- 不接受网页、桌面端、配置或 AI 提供的代码字符串；
- 不使用 `MAIN` world；
- 不使用 `eval`、`new Function`、远程托管代码或动态下载脚本；
- 不向页面 DOM 插入按钮、气泡或桌宠 UI；
- content script 尽量零第三方运行时依赖；所有代码随 Extension 打包并锁定 hash；
- 对 content-script bundle 运行 AST/静态规则，禁止 DOM 写 API、表单读取、网络 API、动态代码和主世界桥接；
- 集成测试在受控页面记录页面自身 mutation，并断言 Sift 注入前后不存在由 Extension 造成的 DOM/focus/scroll/navigation 变化；
- P0 只观察主 frame；iframe、open/closed Shadow DOM 覆盖另行验证，不宣称完整支持。

content script 在隔离世界运行，但与页面共享 DOM，因此页面 DOM、URL、标题和任何消息 payload 都是不可信输入。

### 3.2 初始捕获

用户启用观察后：

```text
validate tab + scheme + incognito policy
  ↓
chrome.scripting.executeScript(fixed content script)
  ↓
建立 captureSessionId / tabId / pageInstanceId
  ↓
读取当前 document 元数据
  ↓
达到最低可读条件
  ↓
sanitize + serialize DOM
  ↓
发送 initial_snapshot
```

若注入时页面已经形成，立即捕获；若仍在加载，content script 监听 DOM 形成并尽快产生首个可读快照。不得等待“页面完全稳定”、网络空闲或固定长延时。

### 3.3 DOM 变化

P0 使用扩展自有、固定代码中的 `MutationObserver`：

```text
MutationObserver callback
  ↓
立即记录轻量 trigger
  ↓
mark document dirty
  ↓
200ms trailing debounce + 2000ms maxWait（Demo 默认值）
  ↓
sanitize + serialize document
  ↓
hash
  ↓
发送 Raw Snapshot
```

约束：

- observer 只观察，不调用会改变页面的 DOM API；
- mutation record 只作为 trigger/provenance，不作为精确 patch；
- 连续事件合并为一次全 document Raw Snapshot；
- 内容 hash 相同则复用 blob，只增加 observation 引用；
- animation/class/style 高频变化必须受 debounce、maxWait、速率上限和背压控制；
- observer、timer 和 messaging port 在授权撤销、document unload、Tab 关闭或用户暂停时全部清理；
- 每次 snapshot 带当前 `location.href`，但 URL 不是页面实例主键。

### 3.4 导航

不使用 `webNavigation` 作为 P0 必选权限，因为它会产生“读取浏览历史”的安装警告。

P0 使用：

- content script 的 `pagehide`、`pageshow`、`popstate`、`hashchange`；
- service worker 的 `chrome.tabs.onUpdated` / `onRemoved`；
- 每次 snapshot 中的 URL/origin；
- 同源新 document 后，在授权仍有效时重新注入固定 content script。

状态规则：

```text
same-document / same-origin
  -> 保持授权
  -> 更新 contentEpoch 或 pageInstanceId
  -> 重新/继续观察

cross-origin
  -> activeTab 权限撤销
  -> 停止观察
  -> 桌宠显示“需要重新授权”
```

History API 只改 URL、DOM 完全不变时，可以只更新 metadata，不必制造重复 Raw Snapshot。若 P0 无法可靠识别某类 SPA 路由，应报告限制；不得为此偷偷加入 `webNavigation` 权限。

> **批注（2026-08-27，已落地）**：跨 origin 判定器已实现（`service-worker.ts`，
> **权限清单零改动**）：`tabs.onUpdated`（无需任何权限即可收到 `status`）在
> `status === 'complete'` 时对授权 tab 重注入固定 CS——成功 = 同源导航（activeTab
> 仍有效，CS 哨兵幂等，观察继续并补上 `document_started`）；失败（executeScript
> 拒绝）= Chrome 已撤销 activeTab（跨源/不可授权页）→ 即时 `revokeGrant(cross_origin)`。
> 已知取舍：同源页瞬时 executeScript 错误会误撤权——失败关闭方向（用户重点即恢复），
> P0 不做重试。CS 的 `pagehide`/`pageshow` 信号仍未接入（下轮）。

## 4. 源端数据最小化

Raw Snapshot 可以保留页面结构，但不能把敏感表单状态原样送出 content script。

当前 Demo 只支持用户明确选择的公开、非敏感文本页面。登录后台、支付、身份认证、医疗、金融、邮箱、私信和编辑器属于 unsupported；即使启发式没有识别出敏感页面，UI 也不得把它宣传成安全可捕获范围。真实登录态支持必须等 P0.5 的本地加密、密钥管理和威胁模型完成后再启用。

持久化或发送到 native host 前必须：

- 不读取 `input.value`、`textarea.value`、选中值、密码和键盘事件；
- 清除 HTML 中已有的 `value`、token、authorization、session、签名等敏感属性/参数；
- 对 `contenteditable`、编辑器和表单草稿采取默认清空策略；
- 删除扩展自身标记和运行时内部 ID；
- 清理 URL 中已知的认证、签名和 session query；
- 对 DOM 大小、深度、序列化时间和单次消息大小设置上限；
- 默认不在无痕窗口运行或保存数据；
- 不读取 Cookie、LocalStorage、SessionStorage、IndexedDB 或页面 JavaScript 变量。

“用户有权限看到页面”不等于“扩展可以无边界保存页面中的所有秘密”。

## 5. Extension → Desktop 通道

P0 默认使用 Chrome Native Messaging，不开放 loopback HTTP/WebSocket 调试或采集端口。

```text
content script
  -> runtime message
service worker
  -> runtime.connectNative()
registered native host
  -> Desktop Capture Service
```

约束：

- content script 不能直接调用 Native Messaging，只能发给 service worker 转发；
- Demo native host manifest 的 `allowed_origins` 固定为 demo key 产生的稳定 Extension ID；P0.5 正式分发时替换为正式签名/Store ID；
- native host 校验调用 origin、消息 schema、版本、长度、hash 和顺序；
- Raw Snapshot 使用分块协议，不依赖单条消息容纳整个页面；
- 分块至少包含 `captureId`、`chunkIndex`、`chunkCount`、`payloadHash`；
- host 写入完成后才返回 commit ack；重复 chunk/commit 必须幂等；
- 断线、service worker 休眠和桌面端未启动均返回明确状态；
- 背压时允许合并/丢弃尚未提交的中间 snapshot，但不能把未保存内容显示为成功；
- `chrome.storage` 只保存最小授权/重连状态，不保存 Raw DOM；
- 不把 Raw DOM 写入扩展 console、崩溃日志或 telemetry。

Chrome Native Messaging 单条 extension → native host 消息上限很大，但实现仍应主动小块传输，避免内存尖峰并支持校验与恢复；host → extension 的状态消息必须保持很小。

## 6. Local Capture Store 与投影

P0 Demo 的 Desktop Capture Store 只实现：

```text
Sanitized Raw Snapshot / Observation
        ↓
Materialized Page State
        ↓
按需 DemoEvidenceProjection / QuestionProjection
        ↓
AnswerProjection + Sources
```

- Capture Adapter 从 CDP 改为 Extension，不改变 Envelope、Page State 和 Projection 的核心分层；
- `pageInstanceId` 优先使用本地产生的 UUID；可结合 tab、document、origin 和时间建立关系；
- Snapshot 使用内容寻址 blob、Demo TTL 和配额；P0.5 再实现长期 compaction 与完整可达性 GC；
- Demo 不物化 UnitObservation/CanonicalUnit/UnitVersion，也不建立 Session Unit Ledger/Global Unit Index；
- DemoEvidenceBlock 只在冻结 Page State 的派生投影中存在，身份只在该 projection 内有效；
- Markdown/QuestionProjection/AnswerProjection 都不是捕获格式；
- DemoEvidenceProjection 使用 `P0_DEMO_SCOPE.md` 的 `demo-projector-v1`，不依赖 Defuddle/Readability；P0.5 引入它们时只能在桌面端处理离线克隆，显式禁用异步/联网能力；
- Demo 不做语义 Retrieval；AI 得到用户明确选择且整体不超限的全部投影和来源；
- 用户必须能预览、暂停以及按页面/Session/域名删除数据。

完整 UnitExtractor、长期身份和 TopicProjection 进入 P0.5 后，才切换到 `P0_ANALYSIS_UNIT_SPEC.md` 与 `P0_TOPIC_CLOUD_SPEC.md` 的模型。

## 7. P0 Demo UI 与 AI 成本边界

P0 支持：

| 能力 | P0 |
|---|---|
| 用户授权后的自动 DOM 捕获 | ✅ |
| 捕获状态、数量和错误显示 | ✅ |
| 简单预设问题按钮 | ✅ |
| 自由提问 | ✅ |
| 用户提交、预览并确认远程处理后调用 AI | ✅ |
| 桌宠/气泡轮播 | ❌ |
| 用户点击生成/更新 Topic Cloud | ❌ |
| 后台实时总结 | ❌ |
| 后台自动 Embedding/聚类 | ❌ |
| 主动发现新话题 | ❌ |
| 趋势或弱信号 Radar | ❌ |

P0 Demo 窗口允许出现的事实性状态：

```text
未授权当前页面
正在观察当前页面
已记录当前页面
观察已暂停
页面已跨域，需要重新授权
本地存储未连接
正在分析你的问题
正在生成问题投影
等待远程处理确认
回答或引用校验失败
```

预设 Question 示例：

```text
最近这些内容在讨论什么？
有哪些值得我看的？
有哪些不同观点？
```

P0 禁止显示：

```text
发现一个新话题
一个趋势正在升温
检测到异常信号
```

只有用户提交预设或自由问题、预览 QuestionProjection 并确认远程处理后才允许运行 LLM。P0 不得用定时器在后台生成摘要、Embedding、聚类或 Signal；完整 QuestionProjection/AnswerProjection 规则见 `P0_DEMO_SCOPE.md`。

Topic Cloud、桌宠和 Signal 均属于 P0.5 或更后阶段，当前 Demo 不显示占位入口。

## 8. P1：chrome.debugger 阶段门

只有真实测试证明 DOM Capture 无法满足已验证需求，例如必须读取 XHR response、AX Tree 或 CDP-only 信息时，才能建立 P1 ADR。

P1 约束：

- 不恢复外部 remote-debugging port；
- 通过 `chrome.debugger` attach 用户明确选择的 Tab；
- `chrome.debugger` 是 CDP transport，不是只读安全边界；
- 必须重新启用精确 command/event allowlist、参数约束、审计和 fail-closed；
- Runtime、Input、Fetch、Page 导航、DOM mutation、Target 激活/创建/关闭始终禁止；
- Network response 仍区分 `observed` 与 `seen`，并单独获得用户授权；
- 不得在 P0 manifest 中预埋 `debugger`；
- Chrome 不允许把 `debugger` 声明为 optional permission，因此优先评估独立“Advanced Capture”伴生扩展，避免给所有 P0 用户升级高权限；
- 外部 CDP 调试端口只属于开发诊断，不进入产品运行架构。

## 9. P0 验收

至少验证：

1. 安装时没有全站 host permission 或 `debugger` 权限；
2. 未经用户手势无法读取任何网页；
3. action 启用后可以捕获当前主 frame；
4. 同源导航继续观察，跨 origin 后权限撤销且 UI 状态正确；
5. MutationObserver 高频事件经 debounce/maxWait 形成受控快照；
6. 相同快照 hash 不重复存 blob；
7. 输入、textarea、contenteditable、token URL 在进入 native host 前已脱敏；
8. Native Messaging 分块、断线、重试、重复提交和背压行为正确；
9. 无桌面端时不丢失授权状态，也不伪造“保存成功”；
10. P0 无 CDP、debugger、XHR response、Cookie/Storage 读取和浏览器操作能力；
11. 静态扫描与集成 canary 证明 content script 没有 DOM/focus/scroll/navigation 写行为；
12. 用户未提交问题、预览 QuestionProjection 并确认远程处理时，AI 调用次数为零；
13. QuestionProjection 遵守 Page/Block/字节/Token 上限，超限时要求缩小 scope；
14. AnswerProjection 的每个 claim 都引用 scope 内有效 DemoEvidenceBlock，非法引用失败关闭；
15. 当前 Demo 不存在 UnitExtractor、CanonicalUnit、TopicProjection、Topic Cloud 或桌宠代码路径；
16. 浏览器限制页、iframe、Shadow DOM 和超大页面失败可解释。

## 10. 对 AI 编码代理的硬约束

- 不得为 P0 启动或连接专用 Chromium。
- 不得为 P0 打开 remote debugging port/pipe。
- 不得在 P0 manifest 中加入 `debugger`、`tabs`、`history`、`webNavigation`、`webRequest` 或 `<all_urls>`。
- 不得静态注册匹配所有网站的 content script。
- 不得在未收到 Chrome 认可的用户手势前注入或读取页面。
- 不得在 activeTab 跨 origin 失效后继续显示观察中。
- 不得在 `MAIN` world 执行 observer，不得执行网页、配置或 AI 提供的代码。
- 不得声称 Chrome 为 content script 提供浏览器级只读沙箱；只读性必须由固定 bundle、静态规则、依赖审计和集成测试证明。
- 不得让 content script 修改页面、发网站请求、访问 Cookie/Storage 或记录表单/键盘内容。
- 不得让 Raw DOM 绕过 service worker 直接连接桌面端。
- 不得通过 loopback 服务替代 Native Messaging，除非有新 ADR 和威胁模型。
- 不得把 Raw DOM 长期塞进 `chrome.storage`。
- 不得在捕获热路径运行 Defuddle、Embedding 或 LLM。
- 当前 Demo 不得实现 UnitExtractor、CanonicalUnit、UnitVersion、Global Unit Index 或 TopicProjection；P0.5 实现这些能力时仍不得放入 Extension/content script，也不得调用 LLM/Embedding/网络。
- DemoEvidenceBlock 只是 projection-scoped 来源块，不能伪装成长期 CanonicalUnit 或 Topic 票数。
- 不得让预设问题限制用户自由提问。
- 当前 Demo 不得显示 Topic Cloud 或空占位入口；P0.5 实现时不得做成传统高频词云，也不得让模型直接输出坐标、HTML、SVG 和可执行 UI。
- 不得在 P0 显示没有后台分析证据的主动 Signal。
- 任何新增扩展权限、host permission、跨 frame 能力或浏览器 API 都必须先更新权限说明、威胁模型与负向测试。

## 11. 官方依据

- [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome content scripts / isolated world](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Chrome extension permissions](https://developer.chrome.com/docs/extensions/reference/permissions-list)
- [Chrome optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome remote debugging security change](https://developer.chrome.com/blog/remote-debugging-port)
