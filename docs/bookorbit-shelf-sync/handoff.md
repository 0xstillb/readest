# Handoff: Checkpoint A Fix — Cross-Provider Deletion Safety + GrimmLink Generic-Store Cutover

Phase completed: Checkpoint A Review & Remediation
Model used: Gemini Flash 3.8 / Antigravity
Branch: feature/bookorbit-shelf-sync
Files changed:
- apps/readest-app/src/services/shelfSync/ShelfSyncEngine.ts
- apps/readest-app/src/services/shelfSync/ShelfSyncStore.ts
- apps/readest-app/src/services/shelfSync/migration.ts
- apps/readest-app/src/services/grimmlink/shelfSync.ts
- apps/readest-app/src/services/grimmlink/GrimmLinkSyncStore.ts
- apps/readest-app/src/components/settings/integrations/GrimmLinkShelfPanel.tsx
- apps/readest-app/src/hooks/useGrimmLinkShelfSync.ts
- apps/readest-app/src/__tests__/services/shelfSync/ShelfSyncEngine.test.ts
- apps/readest-app/src/__tests__/services/shelfSync/GrimmLinkCutover.test.ts
- docs/bookorbit-shelf-sync/checkpoint-a.md
- docs/bookorbit-shelf-sync/handoff.md

Tests run:
- `pnpm lint` (`tsc --noEmit && biome lint .`) — PASS (2,574 files checked, 0 errors, 0 warnings)
- ShelfSyncEngine unit & regression tests (`ShelfSyncEngine.test.ts`) — PASS (1 file, 15 tests)
- ShelfSyncStore tests (`ShelfSyncStore.test.ts`) — PASS (1 file, 16 tests)
- GrimmLink Cutover & Cross-Provider integration tests (`GrimmLinkCutover.test.ts`) — PASS (1 file, 6 tests)
- All Shelf Sync tests (`src/__tests__/services/shelfSync`) — PASS (4 files, 58 tests)
- GrimmLink tests suite (`grimmlink`) — PASS (12 files, 98 tests)
- Bookshelf tests (`bookshelf`) — PASS (2 files, 13 tests)
- Recent Shelf tests (`recent-shelf`) — PASS (2 files, 13 tests)
- BookOrbit tests (`bookorbit`) — PASS (18 files, 105 tests)
- Database migration tests (`src/__tests__/database`) — PASS (6 files, 89 passed, 1 skipped)

Decisions made:
1. Resolved Blocker 1 (Deletion reference counting using managed references only):
   - Extended `IShelfSyncStore` with `getAllShelfReferenceCounts(localPaths: string[], options?: ReferenceQueryOptions): Promise<Map<string, number>>`.
   - Updated `wrapLegacyShelfStore` to provide conservative fallbacks for `getAllShelfReferenceCounts`.
   - Changed generic `ShelfSyncEngine.sync()` deletion planning to query `getAllShelfReferenceCounts(paths)` across all providers and connections rather than `getManagedShelfReferenceCounts`.
   - Maintained the requirement that the entry being removed must independently satisfy `managedByProvider === true` before deletion is permitted.
   - Added regression tests in `ShelfSyncEngine.test.ts` proving:
     - Provider A managed reference + Provider B unmanaged reference with same `localPath`: removing Provider A membership with `remove_managed_copy` keeps the local file.
     - Provider A managed + Provider B managed with same `localPath`: keep file; only when single managed entry remains is it eligible for deletion.
2. Resolved Blocker 2 (GrimmLink generic-store cutover and migration idempotency):
   - Cut over GrimmLink shelf sync runtime (`GrimmLinkShelfProvider`, `syncSubscribedGrimmLinkShelves`, `GrimmLinkShelfPanel`, `useGrimmLinkShelfSync`) to active `ShelfSyncStore` on `shelf-sync.db`.
   - Preserved `GrimmLinkSyncStore` on `grimmlink-sync.db` for non-shelf tables (outbox, diagnostics, cursors, readStatus, ratings, notes, sessions).
   - `grimmlink-sync.db` is never dropped or deleted.
   - Implemented insert-only migration (`insertOnly: true` -> `ON CONFLICT DO NOTHING`) so repeated runs of `migrateGrimmLinkShelfState` never overwrite newer generic shelf sync state (e.g. disabled subscriptions, modified policies, updated local paths).
   - Created dedicated integration test suite `GrimmLinkCutover.test.ts` verifying first migration copy, repeat migration idempotency, non-reversion of modified generic store state, preservation of `grimmlink-sync.db`, runtime sync reading/writing from `shelf-sync.db`, and cross-provider reference counting.
3. Verified Generic Neutrality:
   - Zero occurrences of BookOrbit conditions or provider branching in `src/services/shelfSync/`.
   - `managed_by_grimmlink` and `grimmlink-sync.db` are isolated exclusively within `src/services/shelfSync/migration.ts`.

Do not change:
- Provider neutrality of `src/services/shelfSync/`.
- Data Safety Invariant (never delete unless entry is managed by provider, snapshot complete, cleanup policy = remove_managed_copy, and global all-shelf refCount <= 1).
- GrimmLink private non-shelf store (`GrimmLinkSyncStore.ts`) on `grimmlink-sync.db`.
- Stock BookOrbit server contract.

Next task: Task 06 — Phase 4 BookOrbit Catalog + Bulk Manifest Client
