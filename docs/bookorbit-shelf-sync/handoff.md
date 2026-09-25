# Handoff: Task 14 — Phase 8D: Crash Recovery + Transaction Boundaries

Phase completed: Task 14 — Phase 8D: Crash Recovery + Transaction Boundaries
Model used: Gemini Flash 3.8 / Antigravity
Files changed:
- apps/readest-app/src/services/shelfSync/validation.ts
- apps/readest-app/src/services/shelfSync/ShelfSyncEngine.ts
- apps/readest-app/src/services/bookorbit/shelfDownload.ts
- apps/readest-app/src/__tests__/services/shelfSync/ShelfSyncEngine.test.ts
- apps/readest-app/src/__tests__/services/bookorbit/shelfDownload.test.ts
- docs/bookorbit-shelf-sync/handoff.md

Tests run:
- `pnpm lint` (`tsc --noEmit && biome lint .`) — PASS (Checked 2,586 files. 0 errors)
- `vitest run shelfSync` (8 test files, 157 tests) — PASS
- `vitest run bookorbit` (22 test files, 152 tests) — PASS
- `vitest run grimmlink` (12 test files, 98 tests) — PASS
- `cargo check -p Readest` — PASS

Known issues:
- None.

Decisions made:
1. Strict 9-Step Transactional Ordering & Crash Boundary Protocol:
   - Formalized execution sequence:
     `temp creation → download → validate → import → library save → ShelfSyncStore update → managed flag → old revision cleanup → temp delete`.
   - Guaranteed that failed downloads, validation failures, or failed imports never record success or pollute the store.
   - Guaranteed that `managedByProvider = true` is only assigned after successful local import and library persistence. Reused local matches preserve `managedByProvider: false`.
   - Preserved old valid revisions until the new revision has successfully completed import, library persistence, and store registration.
2. Lightweight Non-Buffering Validation in Generic Core:
   - Added `inspectShelfDownloadFile` in `validation.ts` to inspect file headers and sizes via `stats`/`openFile` without buffering large payloads into memory.
   - Added `validateShelfDownloadHeader` to enforce magic bytes (PK for EPUB/CBZ, %PDF for PDF) and non-zero size checks prior to import.
   - Preserved provider-neutral generic core: `remoteBook.bookHash` and `imported.hash` are not asserted equal in generic core because remote catalogs (e.g. BookOrbit MD5 / GrimmLink) may differ from Readest's internal SHA256 `Book.hash`.
3. Transaction Boundaries & Rollback Guarantees:
   - If `onImported` fails or `store.markShelfEntries` fails after `importBook`, the imported book is immediately purged (`deleteBook(imported, 'purge')`), the library array is restored to its pre-import state, and `onRemoved` is invoked.
   - Cancellation (`AbortSignal`) is checked at every boundary (before download, during download, before import, after import, before DB commit). If cancelled after import, the imported book is purged and rolled back cleanly.
   - Temp file cleanup is executed in `finally` (or `.catch(() => {})`) to remain best-effort without masking root errors or corrupting retries.
4. Comprehensive Fault-Injection Test Matrix:
   - Added fault-injection and crash recovery tests across `ShelfSyncEngine.test.ts` and `shelfDownload.test.ts`:
     * Failure after temp creation and download (bad signature, size mismatch)
     * Failure during import (`importBook` returning null or throwing)
     * Failure after import before DB mark (`onImported` failure triggers rollback and purge)
     * Failure during DB update (`store.markShelfEntries` failure triggers rollback and purge)
     * Cancellation before, during, and right after import
     * Clean retry execution recovering from failed attempts without leftover state.

Do not change:
- Provider neutrality of generic core (`src/services/shelfSync/`).
- Data Safety Invariant: Automatic deletion requires ALL 6 criteria. When uncertain, KEEP the local book. Prefer extra file over false deletion.
- Stock BookOrbit server contract.
- GrimmLink preservation.

Next task: Task 15.
