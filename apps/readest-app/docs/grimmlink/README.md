# GrimmLink integration

This directory is the implementation specification for connecting Readest to the
GrimmLink v1 API exposed by the `0xstillb/grimmory` fork. The integration is
implemented entirely in Readest. It must not require a Grimmory server change
or a change to the GrimmLink KOReader plugin.

## Goals

- Let a Readest user connect to a Grimmory server through its canonical
  `/api/grimmlink/v1` API.
- Support the server-backed features available to GrimmLink: authentication,
  capability detection, book matching, progress, reading sessions, ratings,
  annotations, bookmarks, read status, regular shelves, Magic Shelves, and
  authenticated downloads.
- Work on Tauri desktop, Tauri mobile, and Readest Web.
- Remain safe while offline and never delete a user-managed local book.
- Keep the patch small, additive, opt-in, and easy to rebase onto upstream
  Readest.

## Non-goals

- Do not change Grimmory, add endpoints to it, or use `/api/koreader/**` as
  the primary contract.
- Do not port KOReader-specific UI, gestures, `.sdr` parsing, SimpleUI refresh,
  Wi-Fi enablement, or plugin self-update logic.
- Do not introduce a general-purpose remote-library abstraction solely for
  this integration.
- Do not delete a book from Grimmory's library. Removing shelf membership is
  always an explicit user action.

## Documents

- [Architecture](architecture.md) — module boundaries, data ownership, flows,
  security, and platform behavior.
- [API contract](api-contract.md) — complete endpoint and payload mapping.
- [Implementation plan](implementation-plan.md) — upstream-friendly commits,
  order of work, and acceptance criteria.
- [Test plan](test-plan.md) — unit, integration, and real-device coverage.
- [Session plan](session-plan.md) — token-efficient delivery sessions, model
  selection, and handoff requirements.
- [Session prompts](session-prompts.md) — copy/paste instructions for the
  seven delivery sessions.

## Terminology

- **Grimmory**: the server hosting the canonical GrimmLink v1 API.
- **GrimmLink**: the provider implemented in Readest, not a bundled KOReader
  plugin.
- **managed copy**: a local file downloaded by the GrimmLink provider and
  recorded in its private mapping store.
- **remote book link**: a durable association between a Readest book hash and
  Grimmory's `bookId`/`bookFileId`.

## GrimmLink feature coverage

| GrimmLink capability | Readest equivalent | Delivery |
| --- | --- | --- |
| Connection test and server capability detection | Integration connection form and diagnostics | Phase 1 |
| Local/remote server fallback | transport-only fallback URL | Phase 1 |
| Hash-based book match and manual rematch | `book_links` and Retry match action | Phase 2 |
| Pull/push progress and conflict choice | Reader progress provider | Phase 2 |
| Offline progress queue | provider outbox, coalesced per book | Phase 3 |
| Reading sessions and batch replay | reader lifecycle session recorder | Phase 3 |
| Read-status actions and completion flow | reader/library status commands | Phase 4 |
| Ratings | metadata rating adapter | Phase 4 |
| Annotation/bookmark push, pull, dedupe, and tombstones | `BookNote` metadata adapter | Phase 5 |
| Regular Shelf and Magic Shelf sync | subscription panel and shelf engine | Phase 6 |
| Managed downloads, cancellation, retry, and safe cleanup | existing transfer UI plus `shelf_entries` | Phase 6 |
| Explicit shelf-membership removal | confirmed library action plus outbox replay | Phase 6 |
| Queue inspection, retry, diagnostic export, secure logs | diagnostics panel | Phase 7 |
| KOReader gestures, SimpleUI refresh, `.sdr` import, plugin updater | Readest-native UI/updates; no literal port | Out of scope |

## Design principles

1. Grimmory owns remote truth; Readest owns its local library and local files.
2. A disabled provider is inert: no requests, timers, migrations into shared
   schemas, or changed behavior for existing users.
3. Book hashes identify a match. Names and filenames are display metadata only.
4. Every write is idempotent or safely replayable from a persistent outbox.
5. Remote progress is never applied without the existing Readest conflict
   policy deciding it is safe.
6. A shelf removal can only clean up a managed copy; the default behavior is
   to keep the local bytes.
7. Development is test-driven: a failing focused test precedes each behavior
   change, then production code makes it pass, then the code is refactored.
8. Windows and Android are primary supported targets. Device lifecycle and
   real-network behavior are acceptance criteria, not post-release checks.
