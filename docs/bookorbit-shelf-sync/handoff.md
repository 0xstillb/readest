# Handoff: Checkpoint A Final Fix — Subscription Semantics + Reuse Ownership Safety + Generic Neutrality

Phase completed: Checkpoint A Final Remediation
Model used: Gemini Flash 3.8 / Antigravity
Commit SHA: (Pending commit)
Files changed:
- apps/readest-app/src/services/shelfSync/ShelfSyncEngine.ts
- apps/readest-app/src/services/shelfSync/ShelfSyncStore.ts
- apps/readest-app/src/services/shelfSync/types.ts
- apps/readest-app/src/services/grimmlink/legacyShelfStoreAdapter.ts
- apps/readest-app/src/services/grimmlink/shelfSync.ts
- apps/readest-app/src/__tests__/services/shelfSync/ShelfSyncEngine.test.ts
- docs/bookorbit-shelf-sync/checkpoint-a.md
- docs/bookorbit-shelf-sync/handoff.md

Tests run:
- `pnpm lint` (`tsc --noEmit && biome lint .`) — PASS (2,575 files checked, 0 errors, 0 warnings)
- ShelfSyncEngine tests (`src/__tests__/services/shelfSync/ShelfSyncEngine.test.ts`) — PASS (1 file, 20 tests)
- ShelfSyncStore tests (`src/__tests__/services/shelfSync/ShelfSyncStore.test.ts`) — PASS (1 file, 16 tests)
- GrimmLinkCutover tests (`src/__tests__/services/shelfSync/GrimmLinkCutover.test.ts`) — PASS (1 file, 6 tests)
- All Shelf Sync tests (`src/__tests__/services/shelfSync`) — PASS (4 files, 63 tests)
- GrimmLink tests suite (`grimmlink`) — PASS (12 files, 98 tests)
- Bookshelf tests (`bookshelf`) — PASS (2 files, 13 tests)
- BookOrbit baseline tests (`bookorbit`) — PASS (18 files, 105 tests)
- Database migration tests (`src/__tests__/database`) — PASS (6 files, 89 passed, 1 skipped)

Known issues:
- None.

Decisions made:
1. Blocker 1 (Disabled subscriptions still synced):
   - Changed `ShelfSyncEngine.syncSubscribedInternal()` to query `this.store.getShelfSubscriptions({ enabledOnly: true })`.
   - Verified that disabled subscriptions are never synced, bypassing `adapter.getShelfBooks()`, file imports, and deletions.
2. Blocker 2 (Reused local books localPath / ownership bookkeeping):
   - Derived actual local presence and path (`getLocalBookFilename(localBook)`) for reused books from `presenceIndex.booksByHash` or `presentBooks` matching remote hash.
   - Saved the actual filesystem path into `shelf_entries` so global reference counting accurately sees all shelf references to the local file.
   - Enforced conservative ownership: `managedByProvider` is marked `false` on reuse unless the exact same local path, exact same hash, and previous valid `managedByProvider: true` was already held by this shelf entry.
   - Added changed-revision protection: if a remote revision changes from `OLD` to `NEW` and `NEW` already exists locally, the entry reuses `NEW` at its actual path and marks `managedByProvider = false`, never pointing `NEW` at `OLD` path and never inheriting ownership from an older revision.
   - Added regression test suite in `ShelfSyncEngine.test.ts` covering Test A (new shelf reuse), Test B (cross-provider safety with reused book), Test C (changed revision already exists locally), and Test D (same managed file unchanged).
3. Generic Neutrality Cleanup:
   - Moved `wrapLegacyShelfStore` out of `src/services/shelfSync/ShelfSyncEngine.ts` into `src/services/grimmlink/legacyShelfStoreAdapter.ts`.
   - Defined `IShelfSyncStore` in `src/services/shelfSync/types.ts` and implemented it on `ShelfSyncStore`.
   - `ShelfSyncEngine` now accepts `IShelfSyncStore` without any GrimmLink-specific branching, fields, or argument orders.
   - Verified zero occurrences of BookOrbit branching in `src/services/shelfSync/`, and legacy GrimmLink database identifiers (`grimmlink-sync.db`, `managed_by_grimmlink`) exist strictly within explicit legacy migration and adapter boundaries.

Do not change:
- Provider neutrality of `src/services/shelfSync/`.
- Data Safety Invariant (never delete unless entry is managed by provider, snapshot complete, cleanup policy = remove_managed_copy, and global all-shelf refCount <= 1).
- GrimmLink private non-shelf store (`GrimmLinkSyncStore.ts`) on `grimmlink-sync.db`.
- Stock BookOrbit server contract.

Next task: Task 06 — Phase 4 BookOrbit Catalog + Bulk Manifest Client
