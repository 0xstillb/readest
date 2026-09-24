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

## Remaining Risks & Mitigations

1. **Unindexed local files outside shelf sync**: Books imported manually or through OPDS catalogs that are not tracked in `shelf_entries` have reference count 0.
   - *Mitigation*: The Data Safety Invariant guarantees that only entries where `managedByProvider === true` can ever be deleted. User-imported books remain untouched.
2. **Concurrent syncs across different providers referencing the same local path**: If Provider A and Provider B both run deletion planning simultaneously for the same file.
   - *Mitigation*: Each engine execution performs atomic database operations and checks reference counts against the shared SQLite database. Furthermore, BookOrbit and GrimmLink each manage distinct connection-scoped subscriptions while querying global path references.

---

## Status

All architectural review findings for Checkpoint A are resolved. The generic shelf sync engine and persistent store are ready for BookOrbit integration.

**Next task: Task 06 — Phase 4 BookOrbit Catalog + Bulk Manifest Client**
