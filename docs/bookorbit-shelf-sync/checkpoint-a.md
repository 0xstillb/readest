# Checkpoint A Review & Remediation Report

## Overview

Following the extraction of the generic `ShelfSyncEngine` (Phase 3), an independent architectural review of Checkpoint A identified two critical blockers before beginning the BookOrbit client implementation (Phase 4):

1. **Deletion reference counting was using managed references only**: Calling `getManagedShelfReferenceCounts` allowed local files referenced by unmanaged entries (e.g. user-imported or unmanaged shelf entries from another provider) to be unsafely deleted when a managed membership was removed with `remove_managed_copy`.
2. **GrimmLink runtime store cutover incomplete**: While legacy state was migrated to `shelf-sync.db`, the GrimmLink runtime was still constructed using the legacy `GrimmLinkSyncStore` (`grimmlink-sync.db`), isolating references and preventing cross-provider reference counting. Furthermore, migration previously ran with upsert semantics (`ON CONFLICT DO UPDATE SET`), which could overwrite newer generic state on subsequent app runs.

Both blockers have been resolved and verified with regression tests.

---

## Findings and Fixes

### 1. Managed-Reference Bug Found & Fixed

- **Root Cause**: `ShelfSyncEngine.sync()` deletion planning queried `this.store.getManagedShelfReferenceCounts(paths)`. Because this filtered on `managed_by_provider = 1`, any co-existing unmanaged references (such as from BookOrbit or manual library additions) were ignored during reference counting. If a managed entry was removed, the reference count returned `1`, triggering physical deletion of the local book even though another shelf or provider still referenced that file.
- **Fix**:
  - Extended `IShelfSyncStore` with `getAllShelfReferenceCounts(localPaths, options?)`.
  - Updated `wrapLegacyShelfStore()` to provide conservative backwards-compatible fallbacks for `getAllShelfReferenceCounts`.
  - Updated generic deletion planning in `ShelfSyncEngine` to call `this.store.getAllShelfReferenceCounts(paths)` across all providers and connections.
  - Retained the invariant that the entry being removed must still independently satisfy `managedByProvider === true` before deletion is considered.
  - Added unit regression tests proving:
    - Provider A managed reference + Provider B unmanaged reference pointing to the same `localPath`: removing Provider A membership with `remove_managed_copy` keeps the file intact.
    - Provider A managed + Provider B managed with the same `localPath`: removing Provider A keeps the file; only when the final managed entry is removed does it become eligible for deletion.

### 2. Runtime Generic-Store Cutover

- **Architecture**:
  - GrimmLink shelf sync runtime (`GrimmLinkShelfProvider`, `syncSubscribedGrimmLinkShelves`, `GrimmLinkShelfPanel`, and `useGrimmLinkShelfSync`) now uses `ShelfSyncStore` targeting `shelf-sync.db` as its active store for subscriptions, shelf entries, and reference counting.
  - `GrimmLinkSyncStore` remains strictly for non-shelf state: outbox, diagnostics, metadata cursors, read status, ratings, notes, and sessions.
  - `grimmlink-sync.db` is never deleted or dropped, and unrelated tables are preserved indefinitely.
  - Dual-write is avoided to eliminate split-brain synchronization issues.

### 3. Migration Idempotency Strategy

- **Root Cause**: `migrateGrimmLinkShelfState` previously called `targetStore.saveShelfSubscription` and `targetStore.markShelfEntries`, which performed upserts (`ON CONFLICT ... DO UPDATE SET`). Re-running migration would overwrite newer user-modified values (such as disabling a subscription, switching cleanup policy to `keep_local`, or updating local paths) with stale legacy values from `grimmlink-sync.db`.
- **Fix**:
  - Added `insertOnly?: boolean` option to `SaveShelfSubscriptionInput`, `ShelfEntryWrite`, and `markShelfEntries`.
  - When `insertOnly` is set, SQLite `INSERT ... ON CONFLICT(...) DO NOTHING` is executed.
  - Migration now executes insert-only operations: initial migration copies all legacy rows, subsequent migrations are harmless no-ops, and newer generic-store modifications are never overwritten.
  - Verified with automated tests covering first migration, repeat migration, and non-reversion of modified generic-store subscriptions and entries.

### 4. Cross-Provider Reference Counting Verification

- Added comprehensive integration tests in `GrimmLinkCutover.test.ts` using real SQLite databases (`NodeAppService`):
  1. First migration copies legacy shelf subscriptions/entries from `grimmlink-sync.db` into `shelf-sync.db`.
  2. Second migration is harmless and idempotent (`migratedSubscriptions = 0, migratedEntries = 0`).
  3. A generic-store value modified after first migration is NOT reverted by stale legacy data.
  4. Legacy `grimmlink-sync.db` and its outbox data are never deleted.
  5. GrimmLink runtime reads and writes Shelf Sync state from `shelf-sync.db` without dual-writing to `grimmlink-sync.db`.
  6. Cross-provider reference counting simultaneously sees entries from `grimmlink` and a simulated `bookorbit` provider in `shelf-sync.db`.

---

## Checkpoint A Final Review & Remediation (Subscription Semantics, Reuse Ownership & Generic Neutrality)

Following the initial Checkpoint A remediation, an independent re-review identified two behavioral regressions and one generic-neutrality concern prior to starting Phase 4 (Task 06):

1. **Disabled subscriptions were still synced**:
   - *Root cause*: Generic `ShelfSyncEngine.syncSubscribedInternal()` called `this.store.getShelfSubscriptions()` without options. Unlike legacy GrimmLink behavior which only returned enabled subscriptions, `ShelfSyncStore.getShelfSubscriptions()` returns all rows (enabled and disabled) unless filtered.
   - *Fix*: Changed `syncSubscribedInternal()` to call `this.store.getShelfSubscriptions({ enabledOnly: true })`. `syncSubscribed()` now strictly adheres to its semantic contract: syncing only currently enabled subscriptions.
   - *Regression Test*: Verified in `ShelfSyncEngine.test.ts` that enabled shelves call `adapter.getShelfBooks()` and sync, while disabled shelves are completely bypassed (no adapter calls, no imports, no removals).

2. **Reused local books failed to persist real localPath / ownership**:
   - *Root cause*: `ShelfSyncEngine.sync()` previously derived `localPath` and `managedByProvider` solely from `tracked?.localPath ?? null` and `tracked?.managedByProvider ?? false`. When a remote shelf reused an existing local library book that was not previously tracked by that shelf, `tracked` was undefined, persisting `localPath = null` and `managedByProvider = false`. This rendered global cross-provider reference counting blind to that shelf's reference to the local file.
   - *Changed-revision hazard*: If an existing tracked entry had `bookId = 10, bookHash = OLD, localPath = OLD/book.epub, managed = true` and the remote revision changed to `bookHash = NEW` (which already existed locally at `NEW/book.epub`), the previous implementation could attach the new remote identity to the old managed path (`NEW` with `OLD/book.epub`).
   - *Fix*:
     - Derives real local presence using `options.presenceIndex?.booksByHash` or `presentBooks.find(b => b.hash === remoteBook.bookHash)`.
     - Derives actual on-disk local path via `getLocalBookFilename(localBook)`.
     - Persists the actual path in the shelf entry.
     - Preserves `managedByProvider = true` ONLY if:
       - An existing tracked entry exists,
       - The tracked entry already points to the exact same resolved local path,
       - The tracked entry's hash corresponds to the current remote hash (`tracked.bookHash === remoteBook.bookHash`),
       - And `tracked.managedByProvider === true`.
     - In all other reuse cases (including new shelf reuse or changed remote revisions), marks `managedByProvider = false`.
   - *Tests added*:
     - **Test A**: New shelf reuses existing user/local book (`remote hash = H1, local library has H1, no previous shelf entry`): no download, entry saved with actual `localPath = 'H1/book.epub'` and `managedByProvider = false`.
     - **Test B**: Cross-provider safety with reused book (`Provider A managed=true, Provider B reuses local book with managed=false`): all-reference count is 2; removing Provider A membership with `cleanupPolicy = remove_managed_copy` keeps the local file intact.
     - **Test C**: Changed revision already exists locally (`tracked: bookId 10, hash OLD, path OLD/book.epub; remote: bookId 10, hash NEW; local library contains NEW/book.epub`): no download, entry saved with `bookHash = 'NEW'`, `localPath = 'NEW/book.epub'`, and `managedByProvider = false` (never points NEW hash at OLD path).
     - **Test D**: Same managed file unchanged (`tracked: hash H1, path H1/book.epub, managed=true; remote: hash H1`): reuses local file, preserves same path, and preserves valid `managedByProvider = true`.

3. **Generic Neutrality Cleanup**:
   - *Isolation*: Moved `wrapLegacyShelfStore` out of `src/services/shelfSync/ShelfSyncEngine.ts` into `src/services/grimmlink/legacyShelfStoreAdapter.ts`.
   - `src/services/shelfSync/ShelfSyncEngine.ts` now accepts `IShelfSyncStore` cleanly without any knowledge of GrimmLink field names (`managedByGrimmLink`, `managed_by_grimmlink`, legacy argument ordering).
   - Zero occurrences of BookOrbit-specific branching (`provider === 'bookorbit'`) in `src/services/shelfSync/`.
   - Legacy GrimmLink DB / column names (`grimmlink-sync.db`, `managed_by_grimmlink`) exist strictly within explicit legacy compatibility boundaries (`src/services/shelfSync/migration.ts` and `src/services/grimmlink/legacyShelfStoreAdapter.ts`).

---

## Remaining Risks & Mitigations

1. **Unindexed local files outside shelf sync**: Books imported manually or through OPDS catalogs that are not tracked in `shelf_entries` have reference count 0.
   - *Mitigation*: The Data Safety Invariant guarantees that only entries where `managedByProvider === true` can ever be deleted. User-imported books remain untouched.
2. **Concurrent syncs across different providers referencing the same local path**: If Provider A and Provider B both run deletion planning simultaneously for the same file.
   - *Mitigation*: Each engine execution performs atomic database operations and checks reference counts against the shared SQLite database. Furthermore, BookOrbit and GrimmLink each manage distinct connection-scoped subscriptions while querying global path references.

---

## Status

All Checkpoint A issues and final re-review findings are resolved and verified with automated test suites. The architecture is ready for Task 06.

**Next task: Task 06 — Phase 4 BookOrbit Catalog + Bulk Manifest Client**

