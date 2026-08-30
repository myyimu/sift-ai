# Sift AI

[简体中文](README.zh-CN.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md) · [Contributing](CONTRIBUTING.md)

> **People provide access to the web. AI provides the reading bandwidth to
> understand it.**

**Sift AI aims to compress the thousand things you reached but could not read
into the few that are genuinely worth your attention—and make every conclusion
traceable to the original page.**

The web is not short of information; people are short of reading bandwidth.
Forum threads, comments, GitHub issues, product communities, and research
sources keep moving. A browser can reach them and the user may have legitimate
access, but reading, comparing, deduplicating, and tracking them across pages is
still slow. AI can read quickly, yet it usually lacks a trustworthy, continuous,
and inspectable evidence layer built from the user's own browsing.

Sift AI is designed to become that layer. The user keeps browsing in their own
Chrome, chooses every source, and performs every interaction. Sift records only
explicitly authorized pages into a local, replayable evidence store. AI can then
answer questions over a user-selected scope, aggregate themes, and eventually
surface changes that deserve attention.

## Why this could matter

This is not another “summarize this tab” button. Sift is about a batch of pages,
a research session, and eventually the stream of information a person has
chosen to explore:

- **Multiply reading bandwidth:** compress dozens of pages, long threads, and
  comments into themes, disagreements, counterarguments, and a small reading
  list;
- **Connect signals across sources:** expose recurring pain points,
  contradictory claims, and concepts that are just beginning to appear in
  different communities;
- **Keep conclusions auditable:** every answer claim must cite evidence from the
  selected scope, with a user-initiated route back to the source page;
- **Grow into a personal information radar:** answer “what did I just encounter?”
  today, then use a stable history to ask what is new, spreading, or becoming
  worth watching;
- **Keep the repository user-owned:** captures, history, and indexes remain
  local by default; a remote model receives only the bounded projection the user
  previews and confirms for that operation.

A representative workflow looks like this:

```text
you manually browse a set of forum posts, issues, and comments
  -> Sift retains evidence from the pages you explicitly authorized
  -> you ask: “What is the real disagreement, and what should I read myself?”
  -> AI returns cross-page claims, each tied to evidence and the original page
  -> later: the same local evidence feeds a topic map and historical weak signals
```

The key idea is division of labor, not browser autonomy:

```text
person: chooses sources, signs in, navigates, and judges conclusions
browser: handles real-site access and rendering
Sift data layer: observes, sanitizes, deduplicates, stores, and projects evidence
AI: reads, compares, aggregates, and explains within an explicit scope
```

This avoids turning the product into a crawler that constantly fights websites
or an agent that takes control of browsing. Access remains with the person. AI
receives the minimum auditable reading material, never browser action
capabilities.

## Vision and current foothold

| Stage | Capability | Value to validate |
|---|---|---|
| **P0 (implemented)** | User-authorized DOM capture, local evidence, bounded cross-page Q&A, Answer + Sources | Can evidence-backed batch reading save meaningful time? |
| **P0.5 (partial)** | Offline content identity/deduplication and on-demand Topic Cloud; desktop information-radar entry point remains next | Can users understand the main themes they encountered at a glance? |
| **Later** | Stable themes, relationship graph, signal ranking, historical baselines, and hybrid retrieval | Can the system reliably surface new, accelerating, and cross-source weak signals? |

The final row is documented product direction, not a claim about the current code.
P0.5 now has a partial, demo-ready offline identity layer and an explicitly
confirmed Topic Cloud flow; the full desktop information-radar experience is
still future work. Sift starts with the trust-sensitive foundation: reliable
capture, clear authorization, a local source of truth, deterministic projections,
and verifiable citations.

> **Current release level: Alpha source preview.** Sift AI is a Windows-only,
> internal P0 demo. It is not production-ready, does not support sensitive or
> authenticated pages, and is not distributed through the Chrome Web Store.

P0 already completes the first end-to-end value loop:

```text
user gesture in Chrome
  -> fixed MV3 ISOLATED content script
  -> sanitized DOM snapshots
  -> Chrome Native Messaging
  -> local observation store
  -> explicit scope and projection preview
  -> user confirms remote model processing
  -> validated answer with evidence references
```

The project is **not** a browser agent, crawler, OCR system, background RAG
service, or browser automation framework. Those non-goals make “human-controlled
access, AI-powered comprehension” an enforceable product property rather than a
tagline.

## Current status

The repository implements the P0 vertical slice:

- Manifest V3 extension with only `activeTab`, `scripting`,
  `nativeMessaging`, and `storage` permissions;
- fixed main-frame content script in the `ISOLATED` world;
- initial snapshot plus debounced `MutationObserver` capture;
- source-side sanitization, sensitive-page denial, size limits, and hashing;
- chunked, schema-validated, fail-closed Native Messaging;
- local observation journal, content-addressed blobs, and materialized page
  state;
- deterministic, bounded question projection;
- zero model calls before the user previews and confirms the projection;
- OpenAI-compatible Chat Completions adapter with local output validation;
- coverage disclosure and local deletion controls;
- evidence/source cards with user-initiated, revalidated return-to-page links;
- expiring Native Host status leases and precise capture failure labels;
- local, content-free internal-demo evaluation events for answer latency, source
  clicks, citation support ratings, and subjective time saved.
- partial P0.5 offline UnitExtractor/Ledger and an on-demand Topic Cloud with
  bounded preview, explicit remote-processing confirmation, cached projections,
  and source details (see [RUNBOOK.md](RUNBOOK.md) §5.7).

Current Alpha limitations:

- distribution remains an unpacked extension plus manually registered,
  unsigned Windows directory build; there is no installer, updater, or Web
  Store release;
- only public, non-sensitive, text-oriented main-frame pages are supported;
- iframe, Shadow DOM, canvas, highly virtualized lists, and some complex SPAs
  remain partial or unsupported;
- demo evaluation events stay local and are not production analytics.

See [P0_DEMO_SCOPE.md](P0_DEMO_SCOPE.md) for the P0 scope and
[P0.5_IMPLEMENTATION_STATUS.md](P0.5_IMPLEMENTATION_STATUS.md) for the current
partial P0.5 status. The full P0.5 product shape is not yet implemented.

## Security and privacy model

- Navigation, clicking, typing, scrolling, login, and submission remain under
  human control.
- Capture begins only after a Chrome-recognized user gesture for the active tab.
- Cross-origin navigation revokes the grant and requires a new user gesture.
- The capture path does not fetch page URLs or load remote extraction code.
- Form controls, editable regions, known credential patterns, and sensitive URL
  parameters are removed or rejected before Native Messaging.
- Captured data stays local by default. A model request is made only after the
  user sees the bounded projection and confirms that operation.
- The model API key is read from the process environment and is not persisted by
  Sift.

Chrome does not provide a physically enforced read-only content-script
permission. `activeTab + scripting` is technically capable of page mutation.
This project enforces read-only behavior through a fixed bundle, isolation from
the model path, restricted AST rules, and mutation/focus/scroll canary tests. Do
not describe it as a browser-enforced read-only sandbox.

Read [SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md), and
[P0_EXTENSION_ARCHITECTURE.md](P0_EXTENSION_ARCHITECTURE.md) before evaluating
or deploying the project.

## Requirements

- Windows 10/11 x64
- Google Chrome with Developer mode enabled
- Node.js 24 LTS recommended (Node.js 22 LTS is also supported)
- pnpm 10.14.0, managed through Corepack or installed separately

## Build

Run commands from the repository root:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm build:desktop
pnpm --filter @sift/desktop package:dir
```

Outputs:

- unpacked extension: `apps/extension/dist`
- desktop directory build: `apps/desktop/pack2/win-unpacked`

## Run the demo

1. In Chrome, open `chrome://extensions`, enable Developer mode, choose
   **Load unpacked**, and select `apps/extension/dist`.
2. Register the Native Messaging host for the current Windows user:

   ```powershell
   node tools/scripts/register-sift-native-host.mjs register
   ```

3. Start `apps/desktop/pack2/win-unpacked/Sift.exe`.
4. Open a public, non-sensitive text page and explicitly activate Sift using the
   extension action or `Alt+Shift+S`.
5. Select a local page/session in the desktop window, enter a question, inspect
   the projection preview, and explicitly confirm model processing.

Model configuration is optional for capture and required only for question
answering:

```powershell
$env:SIFT_MODEL_BASE_URL = 'https://your-compatible-endpoint.example/v1'
$env:SIFT_MODEL_API_KEY = 'your-api-key'
$env:SIFT_MODEL_ID = 'your-model-id'
$env:SIFT_MODEL_CTX = '128000'
```

Do not use `setx` for model secrets: it persists values in the Windows registry.
See [RUNBOOK.md](RUNBOOK.md) for the complete setup, fixture server, diagnostics,
rebuild, and uninstall procedures.

## Test

```powershell
pnpm lint
pnpm lint:ast
pnpm typecheck
pnpm test
pnpm build
pnpm build:desktop
```

The real Chrome/Native Host suites require the packaged desktop application and
manual per-user Host registration. Their commands and prerequisites are listed
in [RUNBOOK.md](RUNBOOK.md).

## Repository map

```text
apps/extension/   MV3 authorization, capture, and Native Messaging transport
apps/desktop/     Electron UI, Native Host entry point, and local QA service
packages/host/    framing and capture protocol
packages/store/   local observation store and maintenance
packages/projector/ deterministic evidence/question projection
packages/model/   model adapter and validated AnswerProjection
packages/shared/  schemas, limits, sanitization, and shared contracts
fixtures/         synthetic security and extraction fixtures only
tools/            registration, diagnostics, E2E, and read-only lint tooling
```

Architecture decisions are recorded in `ADR-*.md`. The product background is in
[READ_ONLY_BROWSER_OBSERVER_SPEC.md](READ_ONLY_BROWSER_OBSERVER_SPEC.md). New
contributors should start with [CONTRIBUTING.md](CONTRIBUTING.md) and
[AGENTS.md](AGENTS.md).

## Data removal

Use the desktop UI to delete a page, a session, or all local data. To remove the
development Native Host registration:

```powershell
node tools/scripts/register-sift-native-host.mjs remove
```

The default data location and manual verification steps are documented in
[PRIVACY.md](PRIVACY.md) and [RUNBOOK.md](RUNBOOK.md).

## Contributing

Contributions are welcome, but changes must preserve the human-control,
least-privilege, local-first, and untrusted-page boundaries. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report security
issues privately according to [SECURITY.md](SECURITY.md).

## License

Licensed under the [Apache License 2.0](LICENSE). Third-party dependency and
redistribution notes are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

“Sift AI” is a provisional project name. This repository is not affiliated with
other products or companies using “Sift” or “Sift AI”.
