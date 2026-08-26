// Sift 只读观察 content script —— 骨架（ADR-001 §9 步骤 2 实现）。
//
// 冻结的边界（P0_DEMO_SCOPE §2.2 / AGENTS.md）：
//  - 固定 ISOLATED world，只观察主 frame；仅在用户手势后由 service worker 动态注入本文件；
//  - 禁止读取表单值、Cookie、Storage、键盘输入，禁止向网站发起请求；
//  - 源端先克隆并脱敏（cloneNode 子树是唯一合法写路径，sift-readonly 第二层规则），
//    再序列化与 hash；不得读取 live form property；
//  - readable-v1：非空 body 且删噪后 >= 80 个非空白字符，授权后最多等 5s，
//    不足则 capture_too_little_content，不包装空页面；
//  - MutationObserver 只记 dirty trigger，debounce=200ms / maxWait=2000ms，
//    每页只保留一个 latest-wins 待提交 Snapshot；
//  - 5 MiB / 50,000 节点 / 128 深度任一超出即失败关闭 capture_limit_exceeded。
//
// 本文件通过 eslint sift-readonly 两层规则静态约束（tools/eslint-sift-readonly），
// 并受 Playwright canary 的 subtree hash/焦点/滚动不变断言保护（验收门 4）。
export const SIFT_CONTENT_SCRIPT_MARKER = 'sift-content-script-v0'
