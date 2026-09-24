# Handoff: Task 05 — Checkpoint A Architecture Review (REVIEW ONLY)

Phase completed: Task 05 — Checkpoint A: Fresh Architecture Review
Model used: Gemini Flash 3.8 / Antigravity
Commit SHA: 99e6455c0667b9fe7ca7934416183e9ea7171d60
Files changed:
- docs/bookorbit-shelf-sync/checkpoint-a.md
- docs/bookorbit-shelf-sync/handoff.md

Tests run:
- `pnpm lint` (`tsc --noEmit && biome lint .`) — PASS (2,575 files checked, 0 errors, 0 warnings)
- ShelfSync tests (`vitest src/__tests__/services/shelfSync`) — PASS (4 files, 63 tests)
  - `ShelfSyncEngine.test.ts` (20 tests)
  - `ShelfSyncStore.test.ts` (16 tests)
  - `GrimmLinkCutover.test.ts` (6 tests)
  - `shelfSync.test.ts` (21 tests)
- GrimmLink tests (`vitest grimmlink`) — PASS (12 files, 98 tests)
- BookOrbit tests (`vitest bookorbit`) — PASS (18 files, 105 tests)
- Database migration tests (`vitest src/__tests__/database`) — PASS (6 files, 89 passed, 1 skipped)

Known issues:
- None. All architectural requirements, invariants, and regressions verified clean.

Decisions made:
1. Generic Neutrality & Isolation Verified:
   - Zero occurrences of `Grimm`, `BookOrbit`, `managed_by_grimmlink`, or `grimmlink-sync.db` in generic shelf sync core (`ShelfSyncEngine.ts`, `ShelfSyncStore.ts`, `reconciliation.ts`, `deletion.ts`, `download.ts`, `presence.ts`, `validation.ts`, `types.ts`, `index.ts`).
   - Zero generic imports from `../grimmlink` in `src/services/shelfSync/`.
   - Legacy GrimmLink identifiers exist strictly within legacy migration boundary (`src/services/shelfSync/migration.ts`) and legacy adapter boundary (`src/services/grimmlink/legacyShelfStoreAdapter.ts`).
2. Second-Provider Extensibility Verified:
   - `ShelfSyncAdapter` and `ShelfSyncStore` cleanly support BookOrbit (Phase 4 / Task 06) without modifying generic core logic.
   - Composite primary keys `(provider, connection_id, ...)` in `shelf_subscriptions` and `shelf_entries` ensure complete multi-tenant isolation in shared `shelf-sync.db`.
3. Managed Ownership & Local File Reuse:
   - Reused local books resolve real filesystem paths (`getLocalBookFilename(localBook)`) and explicitly mark `managedByProvider = false`.
   - Changed remote revisions where new revision already exists locally reuse the new path with `managedByProvider = false`, never pointing at old path or inheriting ownership.
   - Unchanged managed files preserve `managedByProvider = true`.
4. Cross-Provider Deletion Safety & Global Reference Counts:
   - Deletion planning queries `getAllShelfReferenceCounts(paths)` across ALL providers and connections. If any other shelf (managed or unmanaged) references the path (`refCount > 1`), the local file is preserved.
   - Data Safety Invariant enforced: automatic deletion requires all 6 criteria (`managed_by_provider=true`, complete successful snapshot, `remove_managed_copy`, no other shelf reference, no other provider reference, tracked file matches entry).
5. Android Bounded-Memory Preservation:
   - Native direct-to-file downloads via `downloadBookToFile`, serial import processing, 8MB chunking threshold for staging to disk, and temp file cleanup in `finally` blocks prevent WebView memory exhaustion on e-ink devices.
6. Migration Idempotency:
   - `migrateGrimmLinkShelfState` executes `insertOnly: true` (`INSERT ... ON CONFLICT DO NOTHING`), ensuring repeat migrations are harmless no-ops and never revert newer generic store modifications.
   - `grimmlink-sync.db` and its outbox data are preserved indefinitely.

Do not change:
- Provider neutrality of `src/services/shelfSync/`.
- Data Safety Invariant (never delete unless entry is managed by provider, snapshot complete, cleanup policy = remove_managed_copy, and global all-shelf refCount <= 1).
- GrimmLink private non-shelf store (`GrimmLinkSyncStore.ts`) on `grimmlink-sync.db`.
- Stock BookOrbit server contract.

Next task: Task 06 — Phase 4 BookOrbit Catalog + Bulk Manifest Client
