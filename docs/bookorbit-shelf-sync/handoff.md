# Handoff: Task 04 — Phase 3: Generic ShelfSyncEngine + GrimmLink Adapter

Phase completed: Phase 3 (Generic ShelfSyncEngine + GrimmLink Adapter)
Model used: Gemini Flash 3.8 / Antigravity
Commit SHA: c25fa27d636b041cf237b6be6d5b03f0b2f342c3
Files changed:
- apps/readest-app/src/services/shelfSync/types.ts
- apps/readest-app/src/services/shelfSync/download.ts
- apps/readest-app/src/services/shelfSync/ShelfSyncEngine.ts
- apps/readest-app/src/services/shelfSync/migration.ts
- apps/readest-app/src/services/shelfSync/index.ts
- apps/readest-app/src/services/grimmlink/shelfSync.ts
- apps/readest-app/src/services/grimmlink/download.ts
- apps/readest-app/src/__tests__/services/shelfSync/ShelfSyncEngine.test.ts
- docs/bookorbit-shelf-sync/handoff.md

Tests run:
- `pnpm lint` (`tsc --noEmit && biome lint .`) — PASS (2,573 files checked, 0 errors, 0 warnings)
- ShelfSyncEngine fake-adapter unit tests (`ShelfSyncEngine.test.ts`) — PASS (1 file, 13 tests)
- Bookshelf & Shelf Sync tests (`bookshelf shelf`) — PASS (9 files, 93 tests)
- GrimmLink tests (`grimmlink`) — PASS (11 files, 92 tests)
- BookOrbit tests (`bookorbit`) — PASS (18 files, 105 tests)
- Database migration tests (`src/__tests__/database`) — PASS (6 files, 89 passed, 1 skipped)

Known issues:
- `pnpm format:check` fails globally on Windows due to pre-existing CRLF checkouts against Biome's LF setting; pre-commit hook applies Biome format cleanly to staged changes.
- Rust tests `dir_scanner` and `range_file` have pre-existing Windows host path separator differences (forward-slash expectations).
- Android e2e tests require a connected physical device or running emulator.

Decisions made:
- Implemented `ShelfSyncEngine` in `src/services/shelfSync/ShelfSyncEngine.ts`:
  - Owns subscriptions, presence indexing, reconciliation, reuse, download/import orchestration, policies, managed bookkeeping, reference-safe cleanup, cancellation, summary/progress.
  - Implements `IShelfSyncStore` interface and `wrapLegacyShelfStore` adapter to bridge legacy stores (e.g. `GrimmLinkSyncStore` or duck-typed test doubles) seamlessly with argument order resolution.
  - Enforces Data Safety Invariant: deletes managed copies ONLY when `managedByProvider = true`, snapshot complete, `cleanupPolicy = remove_managed_copy`, and reference count <= 1 across all shelves/providers.
  - Preserves serial import, native direct download (`downloadBookToFile` via Temp), bounded memory (> 8MB threshold), and temp file cleanup.
- Created `GrimmLinkShelfAdapter` in `src/services/grimmlink/shelfSync.ts` implementing `ShelfSyncAdapter<number, GrimmLinkShelfBook>`:
  - Adapter owns remote listing (`client.getShelfBooks`), mapping, transport/download (`client.downloadShelfBook`, `downloadShelfBookToFile`), and EPUB repair.
  - Refactored `GrimmLinkShelfProvider` and `syncSubscribedGrimmLinkShelves` to delegate to `ShelfSyncEngine` while preserving identical external signatures and test doubles.
- Implemented idempotent, retryable migration utility `migrateGrimmLinkShelfState` in `src/services/shelfSync/migration.ts`:
  - Migrates old shelf subscriptions and entries from `grimmlink-sync.db` to `shelf-sync.db`.
  - NEVER deletes or drops `grimmlink-sync.db` or its tables, keeping outbox, diagnostics, cursors, ratings, etc. completely intact.
- Moved `repairMalformedEpubOpfNamespace`, `isMeteredConnection`, and `NATIVE_IMPORT_THRESHOLD_BYTES` to `src/services/shelfSync/download.ts` and re-exported from `src/services/grimmlink/download.ts` for backward compatibility.
- Added comprehensive fake-adapter test suite in `src/__tests__/services/shelfSync/ShelfSyncEngine.test.ts` (13 tests) covering serial imports, hash/path reuse, soft-deleted restoration, download/cleanup policies, multi-shelf safety, native downloads, bounded memory, cancellation, concurrent deduplication, and state migration.

Do not change:
- Provider neutrality of `src/services/shelfSync`.
- GrimmLink private store (`GrimmLinkSyncStore.ts`) and behavioral contracts.
- Data Safety Invariant (never delete unless managed_by_provider=true, snapshot complete, cleanup_policy=remove_managed_copy, refCount <= 1).
- Stock BookOrbit server contract.

Next task: Task 05 FRESH SESSION
