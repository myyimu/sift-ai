// eslint sift-readonly —— Sift 只读观察器的静态防线（ADR-001 E-09，两层规则）。
//
// 第一层：全局副作用 API 一律禁止（无论接收者）——eval/Function、fetch、XHR、WebSocket、
//         window.open、document.write、postMessage、sendBeacon 等。
// 第二层：DOM 写按接收者判定——document/documentElement/body/head/window 根上的子树修改、
//         属性写与导航一律禁止；cloneNode/importNode/createDocumentFragment 返回值的
//         可追踪 clone 子树允许写（这是 sanitize 清洗克隆树的唯一合法写路径）。
//         clone 子树的写不匹配任何禁令，因此天然放行；逃逸追踪交给 Playwright canary
//         （P0_DEMO_SCOPE 验收门 4）。
//
// 使用方式：作为 rules 对象合入 flat config（见仓库根 eslint.config.js）。
// 选择器只覆盖 document 链 1~4 层与常见全局形态；更深的链、动态派生接收者与
// 运行期行为由 canary 兜底，不宣称静态规则完备。

// 子树修改 / 属性写方法（作用于 document 根链时禁止；作用于 clone 时放行）。
const DOM_WRITE_METHODS =
  'appendChild|prepend|append|insertBefore|insertAdjacentElement|insertAdjacentHTML|insertAdjacentText|replaceChild|removeChild|before|after|remove|replaceWith|setAttribute|setAttributeNS|removeAttribute|removeAttributeNS|toggleAttribute|write|writeln|open|close|execCommand|adoptNode'

// 任意接收者都禁止的交互/滚动/焦点方法（观察器不得模拟用户或扰动页面状态）。
const INTERACTIVE_METHODS =
  'focus|blur|click|requestFullscreen|exitFullscreen|scroll|scrollTo|scrollBy|scrollIntoView|print|stop|moveTo|moveBy|resizeTo|resizeBy|show|showModal|requestPointerLock'

// document 根链（document / document.X / document.X.Y / document.X.Y.Z）上的写调用选择器。
// 例：document.write(...)                     -> 1 层
//     document.body.appendChild(n)            -> 2 层
//     document.body.firstElementChild.remove() -> 3 层
const WRITE_CALL = `[callee.property.type='Identifier'][callee.property.name=/^(${DOM_WRITE_METHODS})$/]`
const docChainSelectors = [
  // 1 层：document.m()
  `CallExpression[callee.object.type='Identifier'][callee.object.name='document']${WRITE_CALL}`,
  // 2 层：document.X.m()
  `CallExpression[callee.object.type='MemberExpression'][callee.object.object.type='Identifier'][callee.object.object.name='document']${WRITE_CALL}`,
  // 3 层：document.X.Y.m()
  `CallExpression[callee.object.type='MemberExpression'][callee.object.object.type='MemberExpression'][callee.object.object.object.type='Identifier'][callee.object.object.object.name='document']${WRITE_CALL}`,
  // 4 层：document.X.Y.Z.m()
  `CallExpression[callee.object.type='MemberExpression'][callee.object.object.type='MemberExpression'][callee.object.object.object.type='MemberExpression'][callee.object.object.object.object.type='Identifier'][callee.object.object.object.object.name='document']${WRITE_CALL}`,
]

const docChainMessages = [
  'sift-readonly: document 根上禁止 DOM 写（只读观察；写只允许在脱敏 clone 子树上）。',
  'sift-readonly: document.X（如 body/head）上禁止 DOM 写。',
  'sift-readonly: document.X.Y 上禁止 DOM 写。',
  'sift-readonly: document.X.Y.Z 上禁止 DOM 写（更深链交给 canary 兜底）。',
]

export const siftReadonlyRules = {
  // —— 第一层：全局副作用 ——
  'no-eval': ['error', { allowIndirect: false }],
  'no-new-func': 'error',
  'no-restricted-globals': [
    'error',
    { name: 'eval', message: 'sift-readonly: 禁止 eval。' },
    { name: 'open', message: 'sift-readonly: 禁止 window.open。' },
    {
      name: 'fetch',
      message: 'sift-readonly: 观察器不得发起网络请求（唯一网络出口是 Native Messaging）。',
    },
    { name: 'XMLHttpRequest', message: 'sift-readonly: 禁止 XHR。' },
    { name: 'WebSocket', message: 'sift-readonly: 禁止 WebSocket。' },
    { name: 'EventSource', message: 'sift-readonly: 禁止 EventSource。' },
    { name: 'Worker', message: 'sift-readonly: 禁止 Worker。' },
    { name: 'SharedWorker', message: 'sift-readonly: 禁止 SharedWorker。' },
    { name: 'Notification', message: 'sift-readonly: 禁止 Notification。' },
  ],
  'no-restricted-syntax': [
    'error',
    // 任意接收者：消息外发与成员 fetch。
    {
      selector:
        "CallExpression[callee.type='MemberExpression'][callee.property.type='Identifier'][callee.property.name=/^(postMessage|sendBeacon)$/]",
      message: 'sift-readonly: 禁止 postMessage/sendBeacon（页面信道外泄）。',
    },
    {
      selector:
        "CallExpression[callee.type='MemberExpression'][callee.property.type='Identifier'][callee.property.name='fetch']",
      message: 'sift-readonly: 禁止成员形态 fetch。',
    },
    // 第二层：document 根链（1~4 层）上的子树修改 / 属性写。
    ...docChainSelectors.map((selector, i) => ({ selector, message: docChainMessages[i] })),
    // HTML 注入式写：innerHTML/outerHTML 赋值一律禁止（含离屏 clone——脱敏流程只删不写 HTML）。
    {
      selector:
        "AssignmentExpression[left.type='MemberExpression'][left.property.type='Identifier'][left.property.name=/^(innerHTML|outerHTML)$/]",
      message: 'sift-readonly: 禁止 innerHTML/outerHTML 赋值（HTML 注入式写）。',
    },
    // document 根链上的任意赋值（document.title=…、document.body.className=… 等；1~3 层）。
    {
      selector:
        "AssignmentExpression[left.type='MemberExpression'][left.object.type='Identifier'][left.object.name='document']",
      message: 'sift-readonly: 禁止对 document 根属性赋值。',
    },
    {
      selector:
        "AssignmentExpression[left.type='MemberExpression'][left.object.type='MemberExpression'][left.object.object.type='Identifier'][left.object.object.name='document']",
      message: 'sift-readonly: 禁止对 document 根链属性赋值。',
    },
    {
      selector:
        "AssignmentExpression[left.type='MemberExpression'][left.object.type='MemberExpression'][left.object.object.type='MemberExpression'][left.object.object.object.type='Identifier'][left.object.object.object.name='document']",
      message: 'sift-readonly: 禁止对 document 根链属性赋值（3 层）。',
    },
    // 导航：location 赋值与调用、history 变更。
    {
      selector:
        "AssignmentExpression[left.type='MemberExpression'][left.object.type='Identifier'][left.object.name='location']",
      message: 'sift-readonly: 禁止 location 赋值（导航写）。',
    },
    {
      selector:
        "CallExpression[callee.object.type='Identifier'][callee.object.name='location'][callee.property.type='Identifier'][callee.property.name=/^(assign|replace|reload)$/]",
      message: 'sift-readonly: 禁止 location.assign/replace/reload。',
    },
    {
      selector:
        "CallExpression[callee.object.type='Identifier'][callee.object.name='history'][callee.property.type='Identifier'][callee.property.name=/^(pushState|replaceState|go|back|forward)$/]",
      message: 'sift-readonly: 禁止 history 导航。',
    },
    // 任意接收者的交互/滚动/焦点方法。
    {
      selector: `CallExpression[callee.type='MemberExpression'][callee.property.type='Identifier'][callee.property.name=/^(${INTERACTIVE_METHODS})$/]`,
      message:
        'sift-readonly: 禁止 focus/blur/click/scroll/fullscreen 等扰动页面的交互方法（任意接收者）。',
    },
    // window 根调用。
    {
      selector:
        "CallExpression[callee.object.type='Identifier'][callee.object.name='window'][callee.property.type='Identifier'][callee.property.name=/^(open|print|stop|focus|blur|moveTo|moveBy|resizeTo|resizeBy)$/]",
      message: 'sift-readonly: window 根上的窗口操作一律禁止。',
    },
  ],
}

/** 便于 flat config 直接合入的 config 片段（rules 部分；parser 由使用方指定）。 */
export const siftReadonlyConfig = {
  name: 'sift/readonly',
  rules: siftReadonlyRules,
}
