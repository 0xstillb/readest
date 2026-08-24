# GrimmLink implementation plan

## Upstream-friendly rules

- Develop on a dedicated feature branch rebased frequently onto `upstream/main`.
- Do not modify vendored code, submodules, generated files, or unrelated
  formatting.
- Keep all new behavior behind an opt-in `grimmlink.enabled` setting.
- Prefer new provider files over edits to existing generic engines.
- Make each commit independently buildable, tested, reviewable, and
  cherry-pickable. Avoid merge commits in the feature series.
- Update only focused tests alongside each changed seam.

## TDD contract

Every implementation task follows red → green → refactor:

1. Add or update a focused failing Vitest test that describes the user-visible
   behavior and its error/safety boundary.
2. Run that focused test and record the expected failure.
3. Write the minimum production code required to pass it.
4. Refactor only while the focused test remains green.
5. Run the relevant wider suite, lint/type check, and the platform test level
   required by the changed code.

No phase is complete based only on a manual happy-path test. Every fixed bug
receives a regression test first. Tests should exercise public provider APIs or
hooks rather than implementation-private details where practical.

## Target platform priority

1. **Windows Tauri** is the primary desktop target: native HTTP, file download,
   import, suspend/resume, sleep/wake, and network changes must work.
2. **Android Tauri** is the primary mobile target: background/foreground,
   activity recreation, storage access, limited connectivity, and a physical
   device transfer run must work.
3. Web, macOS, Linux, and iOS retain compatible behavior, but their platform
   details must not force Windows/Android-specific code into shared services.

## Commit sequence

### 1. Provider foundation

Add `GrimmLinkSettings`, defaults, encrypted credential declaration, typed API
models, `GrimmLinkClient`, and focused client tests. Add a minimal integration
row and connection form. Add the web proxy with a strict allow-list.

TDD first: settings migration/default tests, request-header tests, endpoint
allow-list tests, and connection-result tests.

Acceptance: an unconfigured Readest makes no requests; a user can test a
connection and capabilities without persisting a plaintext password.

### 2. Matching and progress

Add the book-link store and a progress provider which reuses Readest's KOSync
conflict behavior without changing `KOSyncClient`. Add an explicit reader menu
for Push/Pull.

TDD first: hash-match cache tests, reflowable/fixed progress serialization,
remote conflict behavior, and lifecycle-trigger tests.

Acceptance: EPUB and PDF pull/push correctly; unmatched books do not retry on
each page turn; a remote conflict is never silently applied in prompt mode.

### 3. Durable outbox and sessions

Add schema creation, progress coalescing, session rows, retry scheduling, and
batch session upload. Wire reader lifecycle events without delaying close.

TDD first: transaction/restart tests, progress coalescing, retry classification,
and session batch tests.

Acceptance: offline progress and sessions survive restart and replay exactly
once after a successful connection.

### 4. Read status and ratings

Add status capability mapping and explicit status commands. Add rating push and
pull through metadata while preserving local timestamp semantics.

TDD first: status mapping, rating scale conversion, local/remote timestamp
precedence, and unsupported capability tests.

Acceptance: unsupported remote statuses are hidden; manually changed local
status is not overwritten by an older remote value.

### 5. Annotation and bookmark sync

TDD first: note serialization, dedupe-key stability, cursor atomicity,
tombstones, merge precedence, and unresolved-anchor tests.

Implement payload conversion, note mapping, cursor pull, dedupe, tombstones,
and reader annotation application. Reuse existing CFI/XPointer utilities.

Acceptance: duplicate retry does not duplicate notes; remote deletion creates
a local tombstone; unresolved anchors are retained and reported.

### 6. Shelves and downloads

TDD first: remote diff, managed-file authorization, cancellation, corrupted
download validation, and cleanup-policy tests.

Add subscription UI, list/diff logic, transfer queue integration, secure file
validation, import, private source mapping, and safe cleanup policy.

Acceptance: regular and Magic Shelves download new items, reuse matching local
items, never delete a user-managed file, and support cancellation/retry.

### 7. Diagnostics and polish

TDD first: redaction, queue-action, disabled-provider, and accessibility state
tests.

Add redacted diagnostics, queue management UI, local/remote endpoint status,
and documentation links. Complete accessibility, e-ink, translations, and
platform QA.

Acceptance: all strings are extractable, diagnostics contain no credentials,
and disabled integration has no visible reader/library side effect.

## Definition of done

- All API paths use the canonical GrimmLink v1 prefix.
- No Grimmory repository change is required.
- Desktop, Android/iOS Tauri, and Web have defined direct/proxy behavior.
- Tests in [test-plan.md](test-plan.md) pass.
- `pnpm lint`, focused Vitest suites, format check, and appropriate Tauri
checks pass.
- A clean rebase onto the current upstream Readest main branch is performed
  before handoff.
- Windows and Android device acceptance runs are recorded before release.
