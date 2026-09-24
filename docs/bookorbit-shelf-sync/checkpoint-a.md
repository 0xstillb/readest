# Checkpoint A: Architecture Review & Verification Report

## 1. Executive Summary

This architecture review independently audits the generic Shelf Synchronization engine (`src/services/shelfSync/`), its SQLite persistent store (`ShelfSyncStore`), cutover from the legacy GrimmLink implementation, and readiness for the Phase 4 BookOrbit bulk catalog implementation (Task 06).

All ten architectural criteria have been independently audited and verified:
1. **Generic neutrality**: Core sync engine, store, reconciliation, and deletion logic are 100% provider-agnostic.
2. **Zero generic GrimmLink imports**: No imports from `../grimmlink` exist within `src/services/shelfSync/`.
3. **Second-provider extensibility**: Architecture cleanly supports BookOrbit via `ShelfSyncAdapter` and `ShelfSyncStore` without core modifications.
4. **Managed ownership**: Conservative rules ensure that reused books or altered revisions are marked `managedByProvider = false`.
5. **Cross-provider deletion safety**: Deletions check global reference counts across all shelves and providers.
6. **Reference counts**: `getAllShelfReferenceCounts` and `getManagedShelfReferenceCounts` accurately chunk and count references across the unified database.
7. **DB coherence**: Schema migrations are registered in `src/services/database/migrations/index.ts` with user-version fast paths and schema idempotency.
8. **Android bounded-memory preservation**: Serial downloads, direct native file streaming, 8MB chunking thresholds, and temp file cleanup are preserved.
9. **Retryable migrations**: Migrations use `insertOnly: true` (`ON CONFLICT DO NOTHING`), guaranteeing idempotency and preventing regression of user changes.
10. **Cherry-pickability**: Commits are atomic, structured, and cherry-pick friendly against upstream.

---

## 2. Code Search Audit (Generic Code Isolation)

A targeted search across `apps/readest-app/src/services/shelfSync/` was conducted for legacy and provider-specific tokens:

| Search Term | Occurrences in Generic Core (`ShelfSyncEngine`, `ShelfSyncStore`, `reconciliation`, `deletion`, `download`, `presence`, `validation`, `types`) | Occurrences in Migration Boundary (`migration.ts`) | Status |
| :--- | :--- | :--- | :--- |
| `Grimm` / `GrimmLink` | 0 | 5 (in `migrateGrimmLinkShelfState` definition) | Pass (Strictly isolated to migration) |
| `BookOrbit` | 0 | 0 | Pass (Zero occurrences) |
| `managed_by_grimmlink` | 0 | 2 (in SQL query reading legacy DB) | Pass (Legacy SQL query only) |
| `grimmlink-sync.db` | 0 | 2 (in legacy DB open statement) | Pass (Legacy DB path only) |
| Import of `../grimmlink` | 0 | 0 | Pass (Zero imports) |

All legacy GrimmLink database identifiers (`grimmlink-sync.db`, `managed_by_grimmlink`, parameter orderings) exist strictly within explicit legacy compatibility boundaries (`src/services/shelfSync/migration.ts` and `src/services/grimmlink/legacyShelfStoreAdapter.ts`).

---

## 3. Independent Verification Matrix

### 3.1 Generic Neutrality & Extensibility
- **Interface Segregation**: `IShelfSyncStore` and `ShelfSyncAdapter` provide clean decoupling between the orchestrating engine (`ShelfSyncEngine`), persistent storage (`ShelfSyncStore`), and remote transports (`GrimmLinkShelfAdapter`, and upcoming `BookOrbitShelfAdapter`).
- **Composite Keys**: Tables `shelf_subscriptions` and `shelf_entries` use `(provider, connection_id, shelf_type, shelf_id, ...)` as primary keys, providing complete data isolation across providers and server connections while residing in a shared SQLite database (`shelf-sync.db`).
- **Second Provider (BookOrbit)**: Can be added with zero changes to `ShelfSyncEngine` or `ShelfSyncStore` by implementing `ShelfSyncAdapter` and instantiating `ShelfSyncStore(appService, 'bookorbit', connectionId)`.

### 3.2 Data Safety Invariant & Deletion Protection
The Data Safety Invariant mandates:
> *When uncertain, KEEP the local book. Automatic deletion requires ALL: `managed_by_provider=true`; removal proven from a COMPLETE successful snapshot; `cleanup_policy=remove_managed_copy`; no other shelf reference; no other provider reference; tracked local file still corresponds to managed entry. Failed/partial/cancelled/restarted/offline manifests MUST NEVER trigger deletion.*

Verification:
- **Snapshot Completeness**: If remote listing fails, the engine throws before touching local state. `planShelfDeletions` enforces `snapshotComplete === true`; if false, entries are kept with reason `snapshot_incomplete`.
- **Cancellation Safety**: Abort signal check occurs before deletions; cancelled runs throw before reaching deletion planning.
- **Managed Flag Guard**: Only entries with `managedByProvider === true` are eligible for deletion. Unmanaged books are kept with reason `not_managed_by_provider`.
- **All-Shelf Reference Counting**: Deletion queries `getAllShelfReferenceCounts(paths)` across all providers and connections. If any other shelf (managed or unmanaged) references the path (`refCount > 1`), the file is kept with reason `multiple_references`.
- **Cleanup Policy**: Defaults to `keep_local`. Only `remove_managed_copy` allows deletion planning.
- **Missing Path Guard**: Entries missing local paths are kept with reason `missing_local_path`.

### 3.3 Managed Ownership & Local File Reuse
- **Test A (New Shelf Reuse)**: When a shelf reuses an existing local library file (matching hash or path), it records the real filesystem path (`getLocalBookFilename(localBook)`) and sets `managedByProvider = false`.
- **Test B (Cross-Provider Coexistence)**: Provider A downloads book (`managed=true`). Provider B syncs a shelf that reuses that book (`managed=false`). Total reference count is 2. When Provider A removes membership with `remove_managed_copy`, the file is preserved.
- **Test C (Revision Change)**: When a remote book's hash changes from `OLD` to `NEW` and `NEW` already exists locally, the entry reuses `NEW` at its actual path and marks `managedByProvider = false`. The entry is never pointed at `OLD` path, and never inherits managed ownership.
- **Test D (Unchanged Managed File)**: When a remote book hash matches previous tracked hash and path, `managedByProvider = true` is preserved.

### 3.4 Runtime Cutover & Database Coherence
- **Active Store**: GrimmLink runtime (`GrimmLinkShelfProvider`, `syncSubscribedGrimmLinkShelves`, `GrimmLinkShelfPanel`, and `useGrimmLinkShelfSync`) uses `ShelfSyncStore` (`shelf-sync.db`) as its active store.
- **No Dual-Write**: GrimmLink shelf operations write solely to `shelf-sync.db`. `grimmlink-sync.db` is never dual-written for shelf data.
- **Non-Shelf State Preserved**: `grimmlink-sync.db` is never deleted or dropped; outbox, reading progress, ratings, diagnostics, and cursors remain intact.
- **Migration Idempotency**: `migrateGrimmLinkShelfState` executes `insertOnly: true` (`ON CONFLICT DO NOTHING`). Re-running migration is a safe no-op that never overwrites newer generic store state.

### 3.5 Android Bounded-Memory Preservation
- **Direct File Downloads**: `ShelfSyncEngine.downloadAndImport()` checks `isTauriAppPlatform()` and `adapter.downloadBookToFile` to download directly to disk in `Temp`, avoiding loading multi-megabyte payloads into WebView memory.
- **Serial Import Execution**: Remote books are downloaded and imported serially (`for (const book of needsDownload)`), preventing memory spikes on low-RAM Android e-ink devices.
- **Native Threshold Fallback**: For in-memory downloads `>= 8MB` (`NATIVE_IMPORT_THRESHOLD_BYTES`), data is staged to a temporary file on disk before calling `appService.importBook`, preventing large base64 IPC serialization across Tauri bridges.
- **Temp File Cleanup**: All temporary download files are deleted in `finally` blocks.

---

## 4. Prior Audit Findings & Remediations

During Checkpoint A review, the following issues were identified and permanently resolved:

1. **Managed-only Reference Counting Bug**:
   - *Issue*: `ShelfSyncEngine` previously called `getManagedShelfReferenceCounts`, ignoring unmanaged entries and risking deletion of user-imported files or cross-provider references.
   - *Fix*: Implemented `getAllShelfReferenceCounts` in `ShelfSyncStore` and `IShelfSyncStore`. Updated deletion planning to query all references across providers.
2. **Runtime Store Cutover**:
   - *Issue*: GrimmLink runtime was still using `GrimmLinkSyncStore` (`grimmlink-sync.db`), isolating references.
   - *Fix*: Wired GrimmLink runtime components to use `ShelfSyncStore` on `shelf-sync.db`.
3. **Migration Overwrite Hazard**:
   - *Issue*: Upsert semantics in migration could revert user-modified settings on subsequent app launches.
   - *Fix*: Added `insertOnly` flag causing SQLite `INSERT ... ON CONFLICT DO NOTHING`.
4. **Subscription Filtering Regression**:
   - *Issue*: `syncSubscribedInternal()` synced all subscriptions regardless of `enabled` state.
   - *Fix*: Passed `{ enabledOnly: true }` to `getShelfSubscriptions()`.
5. **Reused Books Local Path & Ownership Loss**:
   - *Issue*: Reused books lacked resolved `localPath` in database, causing reference counting to miss them.
   - *Fix*: Resolved real local paths from `presenceIndex` or `presentBooks`, persisting real paths with `managedByProvider = false`.
6. **Generic Neutrality Violation**:
   - *Issue*: `wrapLegacyShelfStore` with GrimmLink-specific properties was located in `ShelfSyncEngine.ts`.
   - *Fix*: Moved `wrapLegacyShelfStore` to `src/services/grimmlink/legacyShelfStoreAdapter.ts`.

---

## 5. Frozen Architectural Decisions

The following decisions are strictly frozen and must NOT be modified during Phase 4:

1. **Provider Neutrality of Core**: `src/services/shelfSync/` must remain 100% provider-neutral. No provider-specific conditionals (`provider === 'bookorbit'`), imports, or tables.
2. **Data Safety Invariant**: Keep local books whenever uncertain. Automatic deletion requires all 6 safety criteria.
3. **Reference Counting Scope**: Deletion planning must always check `getAllShelfReferenceCounts` across all providers and connections.
4. **Isolated GrimmLink Non-Shelf Store**: `GrimmLinkSyncStore` and `grimmlink-sync.db` are preserved indefinitely for non-shelf synchronization (outbox, diagnostics, cursors).
5. **Stock BookOrbit Server Contract**: BookOrbit server implementation remains stock; all BookOrbit-specific synchronization adaptations must happen client-side in `apps/readest-app/src/services/bookorbit/`.
6. **Conservative Reuse Ownership**: Any book reused from an existing local copy or updated from a different remote revision must have `managedByProvider = false`.

---

## 6. Remaining Risks & Mitigations

| Risk | Mitigation |
| :--- | :--- |
| **Unindexed local files outside shelf sync** | The Data Safety Invariant guarantees that only entries where `managedByProvider === true` can ever be deleted. User-imported books not tracked in shelf sync cannot be deleted. |
| **Concurrent sync runs across providers** | `ShelfSyncStore` uses SQLite atomic operations and transactions (`BEGIN ... COMMIT`). Each engine execution checks reference counts immediately prior to deletion. |
| **Mass deletion from corrupt/truncated remote snapshot** | Snapshot complete guard, HTTP status check, and minimum payload validation ensure failed or empty responses reject before deletion planning. |
| **Android e-ink WebView memory exhaustion** | Direct-to-file download (`downloadBookToFile`), serial processing, and 8MB disk offloading bound memory usage. |

---

## 7. Verification Test Results

All test suites pass cleanly:
- `pnpm lint` (`tsc --noEmit && biome lint .`): **PASS** (2,575 files checked, 0 errors, 0 warnings)
- Vitest Shelf Sync (`src/__tests__/services/shelfSync`): **PASS** (4 files, 63 tests)
  - `ShelfSyncEngine.test.ts` (20 tests)
  - `ShelfSyncStore.test.ts` (16 tests)
  - `GrimmLinkCutover.test.ts` (6 tests)
  - `shelfSync.test.ts` (21 tests)
- Vitest GrimmLink (`grimmlink`): **PASS** (12 files, 98 tests)
- Vitest BookOrbit (`bookorbit`): **PASS** (18 files, 105 tests)
- Vitest Database (`src/__tests__/database`): **PASS** (6 files, 89 passed, 1 skipped)

---

## 8. Conclusion

Checkpoint A architecture review is complete. Generic shelf sync is provider-neutral, deletion-safe, coherent, and verified. The codebase is cleared to proceed to **Task 06: Phase 4 BookOrbit Catalog + Bulk Manifest Client**.
