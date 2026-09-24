# Handoff: Task 08 — Phase 6: Native Download + Import

Phase completed: Task 08 — Phase 6: Native Download + Import
Model used: Gemini Flash 3.8 / Antigravity
Commit SHA: e346cc11f
Files changed:
- apps/readest-app/src/services/bookorbit/shelfDownload.ts
- apps/readest-app/src/services/bookorbit/download.ts
- apps/readest-app/src/services/shelfSync/types.ts
- apps/readest-app/src/services/shelfSync/ShelfSyncEngine.ts
- apps/readest-app/src/__tests__/services/bookorbit/shelfDownload.test.ts
- docs/bookorbit-shelf-sync/handoff.md

Tests run:
- `pnpm lint` (`tsc --noEmit && biome lint .`) — PASS (2,578 files checked, 0 errors, 0 warnings)
- Shelf download tests (`vitest src/__tests__/services/bookorbit/shelfDownload.test.ts`) — PASS (1 file, 21 tests)
- ShelfSync tests (`vitest src/__tests__/services/shelfSync`) — PASS (4 files, 63 tests)
- BookOrbit tests (`vitest bookorbit`) — PASS (19 files, 126 tests)
- GrimmLink tests (`vitest grimmlink`) — PASS (12 files, 98 tests)
- Database migration tests (`vitest src/__tests__/database`) — PASS (6 files, 89 passed, 1 skipped)

Known issues:
- None.

Decisions made:
1. Native Direct Download & Bounded Memory:
   - Preferred flow strictly followed: `BookOrbit HTTP → native direct-to-file → temp → validate → importBook(nativePath) → persist → cleanup`.
   - On native Tauri / Android platforms, uses `tauriDownload` streaming directly to disk in `Temp`, avoiding loading multi-megabyte payloads into WebView memory.
   - `inspectDownloadedFile` reads magic bytes via `file.slice(0, 8)` and metadata via `stats`, avoiding loading large files (e.g. 50MB+ PDFs) into ArrayBuffer/Blob memory before importing.
2. File Signature & Size Validation:
   - Rejects corrupt or invalid file downloads: validates ZIP PK (`[0x50, 0x4B]`) for EPUB and CBZ, and `%PDF` (`[0x25, 0x50, 0x44, 0x46]`) for PDF.
   - Validates `sizeBytes` when present against actual filesystem size; rejects empty downloads (`size === 0`).
3. Identity Verification & Data Safety:
   - For original bytes with `fileHash`, verifies that `imported.hash` matches `fileHash`. On mismatch, purges the freshly imported book, throws error, and refuses to mark store entries or touch existing library files.
   - For `audioless_epub`, allows null `fileHash` and `sizeBytes`; retains remote `bookId`, `fileId`, `contentVersion` along with local computed `Book.hash` (`imported.hash`).
4. Cancellation & Temp Cleanup:
   - Checks `signal?.aborted` before download, after download, before import, and after import.
   - Cleans up temporary download file in `finally` without ever touching imported library files in `Books`.
5. Serial Imports:
   - `downloadAndImportBookOrbitBooksSerially` processes items one by one sequentially to protect low-RAM e-ink devices against memory spikes.
6. Generic Shelf Sync Neutrality:
   - Provider-neutral properties `fileId` and `contentVersion` added to `ShelfSyncBook` and forwarded to `ShelfSyncStore` in `ShelfSyncEngine`, without provider-specific branches or conditionals.

Do not change:
- Provider neutrality of `src/services/shelfSync/`.
- Data Safety Invariant (never delete unless entry is managed by provider, snapshot complete, cleanup policy = remove_managed_copy, and global all-shelf refCount <= 1).
- Direct-to-file native download and bounded memory inspection.
- Stock BookOrbit server contract.

Next task: Task 09
