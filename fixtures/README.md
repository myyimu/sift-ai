# fixtures/ —— 固定夹具

## sensitive/（已就位）

`cases.json` —— sensitive-v1 判定正反例（ADR-001 E-08）：

- `pathCases`：path deny 词干（login/signin/sign-in/sign_in/auth/oauth/account/billing/payment/checkout）。
  判定语义：**先整体百分号解码，再按 / 切段，精确匹配**——`/%2F%2Flogin`、`/docs%2Flogin`
  必须命中 deny（先切后解的错误实现会漏判）；`/docs/login-history` 必须不误杀。
- `queryParamCases`：query 凭证参数名（token/access_token/code/key/api_key/secret/signature/
  session/auth/password 等）。
- `contentCases`：内容密钥模式（AKIA/sk-/ghp_/github_pat_/xox/AIza/三段 JWT/PEM/Bearer）。
  所有密钥样例均为公开教学样例或合成串；`expected=unchanged` 的条目是防误杀反例
  （如 `task-based` 不得因子串 `sk-` 被清洗）。

消费方：步骤 2 的 sanitize/sensitive 实现，及验收门 6 的回归测试。

## pages/（Phase 2 已就位）

安全捕获边界夹具（`apps/extension/test/capture.test.ts` 经 linkedom 消费；超限 DOM 测试内程序化生成，不落文件）：

| 夹具 | 验证点 |
|---|---|
| `benign-article.html` | 段落/列表/链接/引用/表格/代码/图片全部保留，捕获成功 |
| `script-style-heavy.html` | script/style/template/noscript/svg 整树移除；内联事件与追踪属性摘除；正文密钥文本脱敏 |
| `form-secrets.html` | form/input/select/textarea/label/button 整树移除；预填 value 不残留 |
| `sensitive-url.html` | href 凭证参数剔除、敏感 path/scheme/host 链接剥 href、普通链接保留 |
| `traversal-title.html` | title 的路径穿越/盘符/保留字符替换为空格（title 永不进落盘路径） |
| `contenteditable-editor.html` | contenteditable / role=textbox 子树整棵丢弃 → `capture_too_little_content` |
| `duplicate-stable.html` | 同 DOM 同 reason 两次捕获 → 逐字节相同 payload（同 hash 同 blob） |
| `spa-hash-nav.html` | hash 导航不重载文档，contentEpoch 自增随快照上报 |
| `empty-skeleton.html` | 可读内容 < 80 非空白字符 → `capture_too_little_content`，不包装空页面 |

期望投影（blocks/kind/textHash/inputHash）属下一阶段 Markdown/Evidence Projection 范畴，Phase 2 明确不做。
