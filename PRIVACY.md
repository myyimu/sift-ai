# Privacy and Local Data

This document describes the current P0 Alpha implementation. It is a technical
privacy statement for the open-source demo, not a privacy policy for a hosted
service.

## What Sift captures

Only after an explicit Chrome user gesture for the current tab, the extension
may capture:

- the sanitized main-frame DOM snapshot already present in the user's tab;
- sanitized page URL and title;
- observation identity, sequence, timing, hash, and capture status metadata;
- deterministic evidence and question projections derived locally from those
  snapshots;
- validated answers after the user confirms a model request.

The current demo does not intentionally capture cookies, Authorization headers,
LocalStorage, form values, password fields, editable-region contents, keyboard
input, request bodies, or browser history.

## Local storage

Data is stored locally under the current user's application data directory. The
default Windows layout is rooted at:

```text
%LOCALAPPDATA%\Sift\
```

It contains the observation store, content-addressed snapshot blobs, page state,
derived projections/answers, and Native Host registration files. Raw payloads
are subject to the P0 TTL and quota rules documented in
[P0_DEMO_SCOPE.md](P0_DEMO_SCOPE.md).

Chrome extension storage contains only minimal authorization/reconnection state,
not raw DOM snapshots.

## Remote model processing

Capture itself makes no model call. The model request path is:

1. the user submits a question and chooses a local scope;
2. Sift builds a deterministic, bounded QuestionProjection locally;
3. the desktop UI shows pages, blocks, bytes, estimated tokens, model endpoint,
   and a text preview;
4. only after the user confirms this operation is the projection sent to the
   configured OpenAI-compatible endpoint.

The selected model provider receives the confirmed projection and question.
That provider's terms and privacy practices apply independently. Sift reads the
endpoint, model ID, context limit, and API key from process environment
variables. The API key is not stored in the Sift observation store or answer
files.

## Telemetry

The current code has no background product telemetry or analytics service.
Internal demo evaluation events are appended locally to
`%LOCALAPPDATA%\Sift\answers\demo-metrics.jsonl`. They contain only an input
hash, evidence/claim IDs, timestamps, latency/counts, an optional claim-support
rating, and an optional subjective time-saved value. They do not contain page
text, page URLs, questions, answers, model keys, or user identity, and they are
not transmitted by Sift.

Page/session deletion removes associated observations and derived answer files;
the content-free evaluation log is retained for the internal study until the
user chooses **Delete all data**, which removes the answers directory including
that log. Do not add remote telemetry without an explicit product-boundary
decision, documentation update, opt-in design, and privacy review.

## Retention and deletion

The desktop UI supports deletion of the current page, current session, and all
local data. Derived answers referencing deleted pages are removed with the
associated data. To remove the development Native Host registration and its
generated manifest:

```powershell
node tools/scripts/register-sift-native-host.mjs remove
```

Close authorized tabs before maintenance if the Native Host still holds store
files open. See [RUNBOOK.md](RUNBOOK.md) for verification and troubleshooting.

## Known limits

- Sanitization reduces risk; it cannot make arbitrary browsing data inherently
  non-sensitive.
- The demo therefore rejects known sensitive hosts/paths and requires users to
  select only public, non-sensitive pages.
- Same-origin pages and complex SPAs can change after authorization; captures
  reflect snapshots received by the observer, not a proof of what was visible in
  the viewport.
- Page content is untrusted input and must never be treated as instructions.
