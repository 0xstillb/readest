# Handoff: Task 13 — Phase 8C: Managed Cleanup + Reference Safety

Phase completed: Task 13 — Phase 8C: Managed Cleanup + Reference Safety
Model used: Gemini Flash 3.8 / Antigravity
Commit SHA: aad243198
Files changed:
- apps/readest-app/src/services/shelfSync/types.ts
- apps/readest-app/src/services/shelfSync/deletion.ts
- apps/readest-app/src/services/shelfSync/ShelfSyncEngine.ts
- apps/readest-app/src/services/bookorbit/shelfDownload.ts
- apps/readest-app/src/__tests__/services/shelfSync/shelfSync.test.ts
- apps/readest-app/src/__tests__/services/shelfSync/ShelfSyncEngine.test.ts
- docs/bookorbit-shelf-sync/handoff.md

Tests run:
- `pnpm lint` (`tsc --noEmit && biome lint .`) — PASS (Checked 2,586 files. 0 errors)
- `vitest run shelfSync` (8 test files, 148 tests) — PASS
- `vitest run bookorbit` (22 test files, 149 tests) — PASS
- `vitest run grimmlink` (12 test files, 98 tests) — PASS
- `vitest run database` (6 test files, 89 passed, 1 skipped) — PASS
- `cargo check -p Readest` — PASS

Known issues:
- None.

Decisions made:
1. Complete Audit of Every Shelf Sync Delete/Remove Path:
   - Audited all deletion and removal execution points across `planShelfDeletions`, `ShelfSyncEngine.ts`, `shelfDownload.ts`, and `ShelfSyncStore.ts`.
   - Strictly enforced all 6 criteria of the Data Safety Invariant:
     1) `managed_by_provider === true`: User-owned books (reused or imported directly) are always tracked with `managedByProvider = false` and can never be deleted.
     2) `removal proven from a COMPLETE successful snapshot`: Partial, failed, cancelled, restart-required, or offline snapshot results produce zero removals (`snapshot_incomplete`).
     3) `cleanup_policy === 'remove_managed_copy'`: `keep_local` preserves local files and only removes database tracking records.
     4) `no other shelf reference`: Dereferencing checks `referenceCounts > 1` (`multiple_references`). Only the final dereference can become eligible for deletion.
     5) `no other provider reference`: Global reference counts query across all providers (e.g., BookOrbit + GrimmLink sharing a file preserves the file).
     6) `tracked local file still corresponds to managed entry`: Checked via path correspondence and content hash verification against the library. If the user replaced the file or if paths are ambiguous, the file is safely kept (`unmatched_managed_entry` or `ambiguous_local_path`).
2. Robust Ambiguity and User-Replacement Protections:
   - Added `'unmatched_managed_entry'` and `'ambiguous_local_path'` to `ShelfDeletionReason`.
   - In `planShelfDeletions`, resolved the local path directory via `getBookDirOfPath(entry.localPath)`. Evaluates ambiguity if multiple library books match the path or hash.
   - If a book at `localPath` exists but matches neither `entry.bookHash` nor the tracked directory, it is recognized as user-replaced and kept.
   - If a book is not found in `library`, deletion is blocked to prevent accidental deletion of unmanaged/unindexed user files on disk ("prefer extra file over false deletion").
3. Obsolete Revision Cleanup Safety Guards:
   - In both `ShelfSyncEngine.ts` and `shelfDownload.ts`, updated obsolete revision cleanup to strictly require that the old book in `library` matches `previous.localPath` AND (if recorded) matches `previous.bookHash` or `prevDir`.
   - Removed the unsafe raw file deletion fallback on disk when the book is not verified in the library.
4. Comprehensive Verification Test Suite:
   - Added unit and integration tests covering all 10 invariant scenarios:
     1) user-owned same hash never managed/deleted
     2) BookOrbit-created copy marked managed
     3) two BookOrbit shelves keep until final ref
     4) BookOrbit+GrimmLink cross-provider ref keeps
     5) final managed ref + remove policy eligible
     6) keep_local keeps
     7) user-replaced/ambiguous path keeps
     8) remote-only has nothing to delete
     9) failed/partial snapshot no cleanup
     10) old revision cleanup only after replacement safe

Do not change:
- Provider neutrality of generic core (`src/services/shelfSync/`).
- Data Safety Invariant: Automatic deletion requires ALL 6 criteria. When uncertain, KEEP the local book. Prefer extra file over false deletion.
- Stock BookOrbit server contract.
- GrimmLink preservation.

Next task: Task 14.
