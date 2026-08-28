# Security Policy

## Supported versions

Sift AI is currently an Alpha source preview with no supported binary release.
Security fixes are applied to the latest `master` revision only. Do not use the
project with authenticated, private, financial, medical, email, messaging,
editor, payment, or other sensitive pages.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability or include captured
page content, credentials, browsing data, or personal information in a report.

Use the repository's **Security → Report a vulnerability** flow:

https://github.com/myyimu/sift-ai/security/advisories/new

Include only the minimum information needed to reproduce the issue:

- affected commit and environment;
- component and security boundary involved;
- redacted reproduction steps using synthetic content;
- expected and observed behavior;
- impact assessment;
- a proposed fix, if available.

Maintainers will acknowledge and triage reports on a best-effort basis. Because
the project is an Alpha, no fixed response or release timeline is promised.

## High-priority security boundaries

Reports are especially valuable when they involve:

- capture without a Chrome-recognized user gesture;
- capture continuing after cross-origin navigation or revocation;
- reading form values, editable regions, cookies, browser storage, request
  headers, or other forbidden data;
- bypassing sensitive-page, URL, payload, quota, or schema validation;
- page content influencing executable code, permissions, model instructions, or
  browser actions;
- Native Messaging origin, framing, hash, sequence, replay, or path traversal
  failures;
- model calls before projection preview and per-operation confirmation;
- secrets or captured page content written to logs, source control, or model
  configuration files;
- Electron renderer escape, unsafe IPC, remote code execution, or dependency
  supply-chain compromise.

## Security model and non-guarantees

Chrome does not expose a physically enforced read-only content-script
permission. `activeTab + scripting` can technically mutate the page. Sift's
read-only behavior is an application invariant enforced by fixed code,
isolation, static rules, and tests; it is not a Chrome security boundary.

The current demo supports only public, non-sensitive, text-oriented main-frame
pages. It does not claim complete coverage for iframes, Shadow DOM, canvas,
virtualized lists, restricted schemes, or hostile resource-exhaustion cases.

See [P0_EXTENSION_ARCHITECTURE.md](P0_EXTENSION_ARCHITECTURE.md) and
[PRIVACY.md](PRIVACY.md) for the full boundary.

## Synthetic secrets in tests

Some fixtures intentionally contain syntactically realistic but non-functional
credential strings to verify redaction. They are confined to the paths listed in
`.gitleaks.toml`. Never replace them with live credentials. A secret-looking
value outside those allowlisted fixtures must be treated as a real incident
until proven otherwise.

The `key` in `apps/extension/public/manifest.json` is an SPKI **public** key used
to keep the unpacked Chrome Extension ID stable; it is not signing key material.
Generated Electron/Chrome directories are ignored by Git and excluded from the
working-tree scan, while their tracked source inputs remain in scope.
