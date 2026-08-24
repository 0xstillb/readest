# GrimmLink delivery session plan

This plan divides the work into small, independently verifiable sessions. It
optimizes for low token use by avoiding repeated repository research, avoiding
parallel edits to the same files, and passing compact written handoffs rather
than full chat transcripts between sessions.

## Model policy

| Model | Use in this project | Reasoning effort |
| --- | --- | --- |
| `gpt-5.6-terra` | Default implementation, focused code review, tests, and Windows/Android fixes | `medium`; `high` for shelf/download code |
| `gpt-5.6-sol` | Two narrow quality gates: metadata/conflict design review and final upstream/release review | `high` |
| `gpt-5.6-luna` | Bounded mechanical work: test-output triage, test-case inventory, and documentation/status checks | `low` |

Do not use Sol for routine code. Do not open a Luna session merely to read the
whole codebase: the context/handoff cost defeats its price advantage. Use one
Terra implementation session at a time; all other sessions must be read-only
or work on a non-overlapping artifact.

The model choices follow the official guidance: Sol is for frontier complex
work, Terra balances quality and cost, and Luna is for efficient high-volume
work. Reasoning effort should start at `medium` for balanced tasks, `low` for
latency-sensitive work, and increase only when a measured quality gain needs
it. See [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model).

## Shared handoff format

Every session finishes with a short `docs/grimmlink/STATUS.md` update containing
only:

```text
Completed: <commit hashes and one-line outcome>
Changed: <files>
Tests: <exact commands and result>
Open risks: <maximum three>
Next session: <one precise starting task>
```

The next session reads this status file, its immediately relevant source files,
and the focused tests only. It must not repeat the original three-repository
research unless the API contract has changed.

## Sessions

### Session 1 — Foundation and contract

- **Model:** Terra, `medium`
- **TDD scope:** settings defaults/encryption, typed client, request paths,
  auth/custom-header precedence, capabilities, strict web proxy allow-list.
- **Deliverable:** isolated `services/grimmlink` foundation and connection UI
  seam, with no reader or library behavior enabled.
- **Gate:** focused tests plus lint/type check; disabled provider makes zero
  requests.

### Session 2 — Matching and reader progress

- **Model:** Terra, `medium`
- **TDD scope:** hash link cache, EPUB XPointer/CFI payloads, PDF page payloads,
  pull/push strategies, conflict behavior, and unmatched-book behavior.
- **Deliverable:** progress provider and manual Push/Pull commands.
- **Gate:** regression tests for same-device echo and unresolved remote position;
  Windows desktop smoke run.

### Session 3 — Durable outbox, sessions, status, and rating

- **Model:** Terra, `medium`
- **TDD scope:** SQLite schema, restart persistence, progress coalescing,
  session batching, backoff/error classes, read-status mapping, rating scales.
- **Deliverable:** no-loss offline behavior for progress/session/status/rating.
- **Gate:** kill/restart simulation in tests and Windows suspend/resume smoke.

### Session 4 — Metadata quality gate and implementation

- **Review model:** Sol, `high`, read-only review of dedupe, cursor, merge, and
  tombstone rules before code starts.
- **Implementation model:** Terra, `medium`
- **TDD scope:** annotation/bookmark conversion, stable mapping, cursor
  atomicity, timestamp precedence, deleted notes, unresolved anchors.
- **Deliverable:** two-way rating/annotation/bookmark sync.
- **Gate:** no duplicate note after retry; no cursor advance after partial apply.

### Session 5 — Shelves, Magic Shelves, and downloads

- **Model:** Terra, `high`
- **TDD scope:** remote diff, subscription mapping, local hash reuse,
  download validation, cancellation, retries, and all cleanup policies.
- **Deliverable:** regular/Magic Shelf UI, transfer queue integration, safe
  managed-copy cleanup, explicit remote membership removal.
- **Gate:** Windows real-server test with a small shelf and cancelled download.

### Session 6 — Android lifecycle and device hardening

- **Model:** Terra, `medium`
- **TDD scope:** lifecycle adapter behavior that can be reproduced in unit or
  Tauri integration tests before device testing.
- **Device scope:** foreground/background, activity recreation, storage
  permission, Wi-Fi loss/reconnect, force-close after outbox write, and large
  shelf download/cancel on a physical Android device.
- **Deliverable:** Android-specific fixes only; shared logic remains platform
  neutral.
- **Gate:** recorded physical-device evidence and sanitized diagnostics export.

### Session 7 — Release hardening and upstream rebase

- **Review model:** Sol, `high`, read-only review of security, data-loss, and
  upstream-diff risks.
- **Implementation model:** Terra, `medium`, only for review findings.
- **Luna task:** Luna, `low`, can summarize test logs and confirm documentation
  coverage; it must not make code changes.
- **Deliverable:** final diagnostics polish, documentation consistency, clean
  rebase onto current upstream, and release evidence.
- **Gate:** focused suites, lint/type/format checks, Windows and Android gates,
  no unrelated diff.

## Token-saving constraints

- Seven sessions total; do not split further unless a failing platform test
  creates a genuinely independent problem.
- Keep each session to one phase and one test surface. Do not combine metadata
  and shelf sync in the same context.
- Use test fixtures and local fake API responses; do not repeatedly browse the
  three repositories.
- Send only changed-file paths, test results, risks, and next action in a
  handoff. Do not paste large logs.
- Run focused tests first; run full lint/type checks only at session gates.
- Use Sol only in Sessions 4 and 7. This preserves quality where data loss or
  upstream compatibility is at stake without spending frontier tokens on normal
  implementation.
