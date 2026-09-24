# Handoff: Task 03 — Phase 2: Provider-Neutral Shelf Sync Store

Phase completed: Phase 2 (Provider-Neutral Shelf Sync Store)
Model used: Gemini Flash 3.8 / Antigravity
Commit SHA: (Pending commit)
Files changed:
- apps/readest-app/src/services/shelfSync/ShelfSyncStore.ts
- apps/readest-app/src/services/shelfSync/index.ts
- apps/readest-app/src/services/database/migrations/index.ts
- apps/readest-app/src/__tests__/services/shelfSync/ShelfSyncStore.test.ts
- docs/bookorbit-shelf-sync/handoff.md
Tests run:
- `pnpm lint` (`tsc --noEmit && biome lint .`) — PASS (2,569 files checked, 0 errors)
- ShelfSync unit tests (`shelfSync.test.ts` & `ShelfSyncStore.test.ts`) — PASS (2 files, 37 tests)
- Database migration tests (`src/__tests__/database`) — PASS (6 files, 89 passed, 1 skipped)
- GrimmLink tests: `pnpm --filter @readest/readest-app exec dotenv -e .env -e .env.test.local -- vitest run grimmlink` — PASS (11 files, 92 tests)
- BookOrbit tests: `pnpm --filter @readest/readest-app exec dotenv -e .env -e .env.test.local -- vitest run bookorbit` — PASS (18 files, 105 tests)
- Bookshelf & Shelf Sync tests: `pnpm --filter @readest/readest-app exec dotenv -e .env -e .env.test.local -- vitest run bookshelf shelf` — PASS (8 files, 80 tests)
Known issues:
- `pnpm format:check` fails globally on Windows due to pre-existing CRLF checkouts against Biome's LF setting; pre-commit hook applies Biome format cleanly to staged changes.
- Rust tests `dir_scanner` and `range_file` have pre-existing Windows host path separator differences (forward-slash expectations).
- Android e2e tests require a connected physical device or running emulator.
Decisions made:
- Implemented provider-neutral persistent `ShelfSyncStore` in `src/services/shelfSync/ShelfSyncStore.ts` backed by `shelf-sync.db`.
- Registered `'shelf-sync'` in `src/services/database/migrations/index.ts` with tables `shelf_subscriptions` and `shelf_entries`:
  - Primary key for `shelf_subscriptions`: `(provider, connection_id, shelf_type, shelf_id)`.
  - Primary key for `shelf_entries`: `(provider, connection_id, shelf_type, shelf_id, book_id)`.
  - Columns in `shelf_entries`: `provider`, `connection_id`, `shelf_type`, `shelf_id`, `book_id`, `file_id` (nullable), `book_hash` (nullable), `content_version` (nullable), `local_path` (nullable), `managed_by_provider` (0 or 1), `last_seen_at`.
  - Indexes on `local_path`, `book_hash`, `file_id`, `(managed_by_provider, local_path)`, and `(provider, connection_id, enabled)`.
- Guaranteed provider + connection + shelf isolation: identical shelf IDs across different providers or connections never collide or leak.
- Remote-only membership: entries with `local_path === null` are tracked safely without deletion risk and can be queried or updated when downloaded later.
- Managed reference count & Data Safety Invariant: `getManagedShelfReferenceCounts` queries across all shelves and providers by default to guarantee files referenced elsewhere or user-owned (`managed_by_provider === false`) are never deleted.
- Atomic transactions & batch operations: `markShelfEntries` and `removeShelfEntries` execute within SQL `BEGIN ... COMMIT / ROLLBACK` transactions. Tested transaction failure rollback.
- Chunked `IN (...)` queries capped at `SQLITE_BIND_CHUNK_SIZE = 500` to prevent SQLite variable limits.
- Idempotent schema initialization via `ensureSchema()` memoized in a `WeakMap<object, Promise<void>>` per `AppService`.
- Kept GrimmLink's outbox, metadata, ratings, notes, diagnostics, and sessions strictly unmigrated and untouched in `grimmlink-sync.db`.
Do not change:
- Provider neutrality of `src/services/shelfSync`.
- GrimmLink private store (`GrimmLinkSyncStore.ts`) and behavioral contracts.
- Data Safety Invariant (never delete unless managed_by_provider=true, snapshot complete, cleanup_policy=remove_managed_copy, refCount <= 1).
- Stock BookOrbit server contract.
Next task: Task 04
