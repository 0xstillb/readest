# Handoff: Task 12 — Phase 8B: Revision Detection + Safe Replacement

Phase completed: Task 12 — Phase 8B: Revision Detection + Safe Replacement
Model used: Gemini Flash 3.8 / Antigravity
Commit SHA: 08f41d712
Files changed:
- apps/readest-app/src/services/shelfSync/types.ts
- apps/readest-app/src/services/shelfSync/reconciliation.ts
- apps/readest-app/src/services/shelfSync/deletion.ts
- apps/readest-app/src/services/shelfSync/ShelfSyncEngine.ts
- apps/readest-app/src/services/bookorbit/shelfDownload.ts
- apps/readest-app/src/__tests__/services/shelfSync/shelfSync.test.ts
- apps/readest-app/src/__tests__/services/shelfSync/ShelfSyncEngine.test.ts
- docs/bookorbit-shelf-sync/handoff.md

Tests run:
- `pnpm lint` (`tsc --noEmit && biome lint .`) — PASS (Checked 2,586 files. 0 errors)
- `vitest run shelfSync` (8 test files, 129 tests) — PASS
- `vitest run bookorbit` (22 test files, 149 tests) — PASS
- `vitest run grimmlink` (12 test files, 98 tests) — PASS
- `vitest run database` (6 test files, 89 passed, 1 skipped) — PASS
- `cargo check -p Readest` — PASS

Known issues:
- None.

Decisions made:
1. Remote Revision Detection Rules:
   - Implemented `isChangedRevision`: treats the same remote `bookId` as a changed revision if `fileHash` (or `bookHash`) changes, or if `contentVersion` changes, or if `fileId` changes.
   - Conservative null-hash revision handling: when the remote book has no hash (null/undefined), it is treated as a revision ONLY if `contentVersion` or `fileId` changed. If hash is null and neither version nor fileId changed, it is conservatively assumed unchanged to prevent redundant downloads. If remote previously had null hash and now provides a hash, it is detected as a new revision.
   - String-safe book ID matching (`String(remote.bookId) === String(prev.remoteBookId)`).
2. Reconciliation with Local Presence Reuse:
   - `reconcileShelfSnapshot`: prioritizes `isChangedRevision` check ahead of previous file presence checks.
   - When a new revision's remote hash is already known to be present locally in `localHashes` (and `contentVersion`/`fileId` have not changed), it is safely categorized as `unchanged` (reuse/repoint local membership without re-downloading).
   - Cleanly aligned `planShelfSync` with `reconcileShelfSnapshot` so `reuse`, `download`, and `absent` have zero divergence.
3. Safe Replacement Execution Ordering (Data Safety Invariant):
   - Safe replacement sequence strictly enforced: detect revision -> download -> validate payload -> import into Readest DB/storage -> update shelf tracking entry (`markShelfEntries`) -> only then evaluate obsolete managed revision cleanup.
   - Never delete an old valid copy before replacement succeeds: if download, validation, or import fails, the old copy and its tracking entry are retained untouched.
   - Obsolete cleanup safety check (`canDeleteObsoleteRevision`): requires complete snapshot, `cleanupPolicy === 'remove_managed_copy'`, `managedByProvider === true`, differing path/hash from replacement, and `referenceCount === 0`.
   - In `ShelfSyncEngine.sync()`, tracking is updated before checking `getAllShelfReferenceCounts([previous.localPath])`, ensuring other shelf references or subscriptions are preserved.
   - In `ShelfSyncEngine.downloadAndImport()`, payload validation runs before `repairMalformedEpubOpfNamespace` so corrupt or non-zip downloads fail immediately with clean validation errors instead of obscure zip extraction faults.

Do not change:
- Provider neutrality of generic core (`src/services/shelfSync/`).
- Data Safety Invariant: Automatic deletion requires all criteria: managed_by_provider=true, complete snapshot, cleanup_policy=remove_managed_copy, no other references.
- Stock BookOrbit server contract.
- GrimmLink preservation.

Next task: Task 13.
