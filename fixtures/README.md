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

## pages/（步骤 4/6 补齐）

对应 P0_DEMO_SCOPE 验收门 12，至少覆盖：文章、列表、评论、代码、表格、SPA、
恶意 prompt、表单、超大 DOM 九类页面 + 期望 DemoEvidenceProjection。

每类夹具需附带期望投影（blocks/kind/textHash/inputHash），使"相同 Page State 与
projectionVersion 产生相同投影与 inputHash"（验收门 8）可自动回归。
