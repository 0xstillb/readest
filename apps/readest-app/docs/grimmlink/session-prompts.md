# GrimmLink session prompts

Copy one prompt at a time into a fresh working session. Do not start a later
session until the preceding session's tests and `STATUS.md` handoff are complete.

## Session 1 — Foundation and API contract

**Recommended model:** `gpt-5.6-terra`, reasoning `medium`

```text
Implement GrimmLink Session 1 only: provider foundation and API contract.

Read these first:
- apps/readest-app/AGENTS.md
- apps/readest-app/docs/grimmlink/{README,architecture,api-contract,implementation-plan,test-plan,session-plan,STATUS}.md
- the closest existing integration: src/services/bookorbit and its focused tests

Use TDD strictly: write focused failing tests before production code, run them,
make them pass with minimal code, then refactor. Do not modify Grimmory.

Deliver only:
1. Disabled-by-default GrimmLink settings, including encrypted credential paths.
2. Typed GrimmLink client for auth, capabilities, and request/error handling.
3. Strict Readest Web proxy for only approved GrimmLink v1 paths/methods.
4. Minimal integration connection UI seam; do not enable reader or shelf sync.
5. Focused tests and an update to docs/grimmlink/STATUS.md.

Constraints:
- Use /api/grimmlink/v1, never the legacy /api/koreader path.
- Keep all provider code under src/services/grimmlink.
- Do not edit KOSync, OPDS, Cloud Sync, generic file sync, or Book schema.
- Keep the diff upstream-friendly; no unrelated formatting or refactors.
- Run focused tests, lint/type checks proportionate to touched code, and git diff --check.

Finish with a concise summary: changed files, exact tests/results, open risks,
and the precise starting point for Session 2. Stop after Session 1.
```

## Session 2 — Book matching and progress

**Recommended model:** `gpt-5.6-terra`, reasoning `medium`

```text
Implement GrimmLink Session 2 only: hash matching and reader progress sync.

Read AGENTS.md, docs/grimmlink/STATUS.md, architecture.md, api-contract.md,
implementation-plan.md, test-plan.md, and the Session 1 diff/tests. Reuse the
existing KOSync conflict and CFI/XPointer utilities, but do not modify KOSync.

Use TDD. First add failing tests for book-link caching, unmatched books,
reflowable payloads, fixed-page payloads, pull/push strategy, and conflict
behavior. Then implement the minimum code to pass them.

Deliver only:
1. book_links persistence and hash matching via GrimmLink v1.
2. A GrimmLink reader progress provider plus explicit Push/Pull actions.
3. prompt/silent/send/receive behavior using existing Readest UX patterns.
4. Focused tests and STATUS.md handoff.

Constraints:
- Remote progress is never silently applied in prompt mode.
- EPUB uses XPointer/CFI-compatible location; PDF/CBZ uses page/total/percent.
- Do not block page turns, reader open, or close on nonessential work.
- No metadata, sessions, shelf, or download implementation in this session.
- Validate on Windows Tauri if the local environment permits; otherwise record
  the exact manual Windows scenario remaining.

Run focused tests and relevant lint/type checks. Stop after Session 2.
```

## Session 3 — Outbox, sessions, status, and rating

**Recommended model:** `gpt-5.6-terra`, reasoning `medium`

```text
Implement GrimmLink Session 3 only: durable outbox, reading sessions, read
status, and rating sync.

Read AGENTS.md and the current docs/grimmlink/STATUS.md before acting. Follow
the architecture, API contract, implementation plan, and test plan exactly.
Use TDD: failing tests first, then the smallest implementation.

Deliver only:
1. Provider SQLite schema for outbox, retries, progress coalescing, and sessions.
2. Durable replay for transport/5xx failures and pause-on-auth-failure behavior.
3. Session collection/batch upload without blocking the reader lifecycle.
4. Capability-gated read-status mapping and explicit status write.
5. Rating push/pull through the documented metadata contract.
6. Focused tests plus STATUS.md handoff.

Constraints:
- Progress coalesces to the newest state per connection/book.
- A failure in one outbox category must not block another category.
- Do not overwrite a newer explicit local status with stale remote data.
- No annotations/bookmarks or shelves yet.
- Add a restart/kill simulation test before considering the outbox complete.

Run focused tests, relevant lint/type checks, git diff --check, and record the
Windows suspend/resume validation result or remaining manual step. Stop here.
```

## Session 4 — Metadata two-way sync

**Recommended implementation model:** `gpt-5.6-terra`, reasoning `medium`

Before this session, an optional bounded `gpt-5.6-sol` / `high` read-only
review may produce a short list of metadata risks. It is not a separate delivery
session and must not edit files.

```text
Implement GrimmLink Session 4 only: two-way metadata sync.

First do a read-only design review of the current diff against
docs/grimmlink/architecture.md and api-contract.md. Inspect dedupe, cursor,
timestamp precedence, tombstones, CFI/XPointer conversion, and data-loss risks.
State the review findings briefly. Then implement only the necessary fixes and
metadata feature using TDD.

Read AGENTS.md and STATUS.md. Add failing tests first for annotation/bookmark
serialization, stable dedupe keys, cursor atomicity, local/remote merge order,
tombstones, duplicate retries, and unresolved anchors.

Deliver only:
1. BookNote/rating ↔ GrimmLink metadata payload mapping.
2. note_mappings and per-book/type metadata cursors.
3. Incremental push/pull, merge, tombstones, and reader application.
4. Focused tests plus STATUS.md handoff.

Constraints:
- Advance a cursor only after every returned item was safely handled.
- Preserve unresolved remote notes; report them rather than silently dropping.
- Keep local note on equal timestamps.
- Do not start shelf sync or change generic replica sync.

Run focused tests, lint/type checks, and git diff --check. Stop after Session 4.
```

## Session 5 — Shelf, Magic Shelf, and downloads

**Recommended model:** `gpt-5.6-terra`, reasoning `high`

```text
Implement GrimmLink Session 5 only: regular/Magic Shelf sync and authenticated
downloads.

Read AGENTS.md, current STATUS.md, architecture.md, api-contract.md,
implementation-plan.md, and test-plan.md. Follow TDD; write failing tests
before implementation.

Deliver only:
1. Local shelf subscription and shelf_entries storage.
2. Regular and Magic Shelf list/diff UI and orchestration.
3. Reuse of existing local hash matches; authenticated queued download,
   temporary-file validation, and import through AppService.
4. Transfer progress, cancel/retry, and safe cleanup policies.
5. Explicit, confirmed remote shelf-membership removal with outbox replay.
6. Focused tests plus STATUS.md handoff.

Non-negotiable safety rules:
- Default remote removal policy is keep_local.
- remove_managed_copy may delete only a provider-tracked file inside a managed
  Readest root. Never delete user-imported/in-place files.
- Local delete must never automatically remove server shelf membership.
- Do not delete Grimmory books or library records.

Run focused tests, relevant lint/type checks, git diff --check, and a Windows
Tauri small-shelf/download-cancel smoke test if possible. Stop after Session 5.
```

## Session 6 — Android and OS lifecycle hardening

**Recommended model:** `gpt-5.6-terra`, reasoning `medium`

```text
Implement GrimmLink Session 6 only: Android and OS lifecycle hardening.

Read AGENTS.md, STATUS.md, test-plan.md, and all platform-relevant changed code.
Do not redesign the provider. Use TDD for every shared logic fix before manual
device work.

Deliver only:
1. Minimal lifecycle integration for background/foreground, reader close,
   resume, connectivity change, and durable outbox replay.
2. Android-safe download/storage handling using existing Readest abstractions.
3. Android-specific fixes that do not leak platform branches into core provider
   services.
4. Focused tests and STATUS.md handoff.

Physical Android acceptance checklist:
- background/foreground while reading
- activity recreation
- force-close after queue write, then relaunch/replay
- Wi-Fi loss/reconnect and limited connectivity
- storage permission and a large shelf download/cancel

Also verify Windows sleep/wake and network reconnect have no duplicate session
or duplicate outbox replay. Record actual evidence and unresolved hardware-only
checks; do not claim them passed without a device run. Stop after Session 6.
```

## Session 7 — Security, upstream rebase, and release gate

**Recommended implementation model:** `gpt-5.6-terra`, reasoning `medium`

Before this session, an optional bounded `gpt-5.6-sol` / `high` read-only
release review may produce a short actionable finding list. It is not a separate
delivery session and must not edit files.

```text
Complete GrimmLink Session 7 only: final security, upstream, and release gate.

Read AGENTS.md, every docs/grimmlink file, STATUS.md, and the full feature diff.
First perform a read-only review for data loss, credential leakage, SSRF/proxy
mistakes, retry duplication, Android/Windows lifecycle gaps, and upstream merge
conflicts. List only actionable findings.

Then use the minimum implementation work to fix accepted findings. Preserve TDD:
write a failing regression test before each code fix.

Required completion work:
1. Validate diagnostics redaction and queue management.
2. Run all focused suites plus relevant lint/type/format checks.
3. Rebase the branch onto current upstream/main, resolve only necessary
   conflicts, and repeat affected tests.
4. Record Windows and physical Android release-gate evidence or clearly mark
   each unavailable device test as pending.
5. Update all docs and STATUS.md with final commit hashes and commands.

Constraints:
- No unrelated cleanup during rebase.
- No server-side Grimmory changes.
- Do not call a release ready if Windows or Android required evidence is absent.
- Stop after the final handoff; do not begin deployment unless separately asked.
```
