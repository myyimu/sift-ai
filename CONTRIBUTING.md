# Contributing to Sift AI

Thank you for helping with Sift AI. The project accepts focused contributions to
the current P0 Alpha while preserving its privacy and human-control boundaries.

## Read the contracts first

Before changing implementation, read in this order:

1. `AGENTS.md`
2. `P0_DEMO_SCOPE.md`
3. `P0_EXTENSION_ARCHITECTURE.md`
4. `CAPTURE_ARCHITECTURE.md`
5. `P0_ANALYSIS_UNIT_SPEC.md`
6. `P0_UNIT_EXTRACTOR_SPEC.md`
7. `P0_TOPIC_CLOUD_SPEC.md`
8. `READ_ONLY_BROWSER_OBSERVER_SPEC.md`
9. `ADR-001_DEMO_ENGINEERING.md`

P0.5 documents are long-term contracts, not authorization to implement future
features in the current Demo.

## Non-negotiable boundaries

Do not submit changes that silently add or enable:

- browser navigation, clicking, scrolling, typing, form submission, or URL
  fetching;
- `chrome.debugger`, CDP, remote debugging ports, mandatory host permissions,
  `MAIN` world scripts, remote code, or new extension permissions;
- cookies, Authorization, browser storage, form values, or sensitive-page
  capture;
- model access to Extension/browser capabilities;
- background model calls, embeddings, RAG, topic clustering, or P0.5 product
  surfaces;
- uploading captured data without a per-operation user preview and confirmation.

Requests that require those changes must first be discussed as explicit product
and security boundary decisions, with the affected specifications updated.

## Development setup

Use Windows x64, Node.js 24 LTS (22 LTS is also supported), and pnpm 10.14.0.

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm lint:ast
pnpm typecheck
pnpm test
pnpm build
pnpm build:desktop
```

Native Host registration and real Chrome E2E modify the current user's local
environment. Follow [RUNBOOK.md](RUNBOOK.md), understand the register/remove
operations, and never commit generated manifests or captured data.

## Pull requests

Keep pull requests small and include:

- the problem and P0 scope affected;
- security/privacy boundary impact, including “none” when applicable;
- tests added or updated;
- commands actually run and their results;
- known page types and limitations not covered;
- any new production dependency, its purpose, license, network behavior, and why
  existing code was insufficient.

Do not weaken allowlists, limits, sanitization, citation validation, or read-only
tests merely to make a test pass.

## Fixtures and secrets

Use only synthetic pages and synthetic credentials. Never add real page captures,
browsing history, API keys, cookies, tokens, personal data, or private URLs to an
issue, pull request, test fixture, log, or commit.

Secret-shaped fixture strings are restricted to `.gitleaks.toml` allowlisted
paths. New exceptions require a narrow path, a test justification, and review.

## Licensing contributions

Unless explicitly stated otherwise, contributions submitted for inclusion are
licensed under Apache License 2.0, as described by Section 5 of the license. By
submitting a contribution, you represent that you have the right to do so.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
