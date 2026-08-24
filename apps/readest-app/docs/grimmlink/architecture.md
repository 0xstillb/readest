# GrimmLink architecture

## Integration boundary

Add a new provider under `src/services/grimmlink/`. It must be independent of
`KOSyncClient`, Readest Cloud sync, OPDS, and third-party file-sync engines.
It may reuse their stable utilities (`AppService`, `openDatabase`, transfer
queue, `importBook`, `BookNote`, and CFI/XPointer helpers), but must not alter
their behavior.

```text
Settings / Library UI / Reader UI
                |
                v
      GrimmLink hooks and controllers
        |        |        |        |
 progress   metadata  sessions  shelves
        \        |        |        /
            GrimmLinkClient
                   |
          direct Tauri request
              or Web proxy
                   |
       Grimmory /api/grimmlink/v1
```

## Proposed source layout

```text
src/services/grimmlink/
  GrimmLinkClient.ts          HTTP client, endpoint types, response validation
  GrimmLinkRequestError.ts    typed error classification
  GrimmLinkSyncStore.ts       local SQLite state and outbox
  types.ts                    API and local-domain types
  capabilities.ts             capability-gated feature decisions
  bookLinks.ts                hash matching and remote IDs
  progress.ts                 payload conversion only
  metadata.ts                 BookNote/rating conversion and merge rules
  sessions.ts                 session construction and batching
  shelfSync.ts                remote diff, safe cleanup plan, orchestration
  download.ts                 authenticated download and validation
  outbox.ts                   persistent replay scheduler

src/components/settings/integrations/GrimmLinkForm.tsx
src/app/library/hooks/useGrimmLinkShelves.ts
src/app/library/components/GrimmLinkShelfPanel.tsx
src/app/reader/hooks/useGrimmLinkSync.ts
src/pages/api/grimmlink.ts
```

The exact UI filenames may change to match upstream conventions, but all
provider logic stays inside `services/grimmlink`.

## Why this is a service, not an `apps/` plugin

Readest has three distinct extension patterns:

| Existing location | Intended role | GrimmLink decision |
| --- | --- | --- |
| `apps/readest.koplugin` | A separately installable Lua companion for KOReader | Not applicable: this work adds Grimmory access to the Readest app. |
| `apps/readest-calibre-plugin` | A separately packaged Calibre extension | Not applicable: GrimmLink is not a Calibre integration. |
| `src/plugins/yomitan` | Sandboxed bundled dictionary runtime and worker protocol | Not applicable: GrimmLink needs trusted app services, network, local SQLite, reader lifecycle, and file import. |
| `src/services/bookorbit`, `hardcover`, `readwise` | First-party integration providers inside the Readest app | Use this pattern. |

Therefore add `src/services/grimmlink` plus focused UI/hooks, not a new
top-level `apps/grimmlink-*` directory and not a `src/plugins` worker plugin.
This follows existing upstream integration boundaries and minimizes future
rebase conflicts.

## Settings

Add an optional `grimmlink` section to `SystemSettings`. Default it to disabled
and keep credentials encrypted using the existing settings-adapter mechanism.

```ts
interface GrimmLinkSettings {
  enabled: boolean;
  serverUrl: string;
  fallbackUrl?: string;
  username: string;
  userkey: string; // MD5(password), never derived at request time
  deviceId: string;
  deviceName: string;
  strategy: 'prompt' | 'silent' | 'send' | 'receive';
  syncProgress: boolean;
  syncMetadata: boolean;
  syncSessions: boolean;
  syncReadStatus: boolean;
  customHeaders?: Record<string, string>;
}
```

Shelf subscriptions are not global settings. Store them locally in the
provider database because their download root, local cleanup policy, and
download state vary by device.

## Local persistence

Use `appService.openDatabase('grimmlink-sync', 'grimmlink-sync.db', 'Data')`.
No Readest core schema migration is required.

| Table | Purpose | Key |
| --- | --- | --- |
| `book_links` | Readest hash to remote book/file identifiers | connection + local hash |
| `shelf_subscriptions` | enabled regular/Magic Shelf preferences | connection + type + shelf |
| `shelf_entries` | managed local copies and last-seen remote membership | subscription + remote book |
| `metadata_cursors` | incremental pull cursor by book and metadata type | connection + local hash + type |
| `note_mappings` | stable remote dedupe key for each local note | connection + local hash + note |
| `outbox` | queued progress, sessions, metadata, and shelf removal writes | idempotency key |
| `diagnostics` | bounded, redacted last failures and timings | connection + timestamp |

`book_links` and `shelf_entries` are device-local. They must not be published
by replica sync or file sync, because a different device does not necessarily
have the same downloaded file or path.

## Authentication and networking

Every request uses `X-Auth-User` and `X-Auth-Key`; the latter is the MD5 digest
stored when the user connects. `GrimmLinkClient` also merges normalized custom
headers but prevents them from overriding either auth header.

- Tauri desktop/mobile calls the configured server directly via the existing
  Tauri HTTP client, including the same explicit invalid-certificate behavior
  used by compatible Readest integrations.
- Readest Web calls `pages/api/grimmlink.ts`. The proxy accepts only the
  documented GrimmLink methods and path templates, rejects private targets,
  follows no redirects, does not cache authenticated responses, and streams
  downloads instead of buffering them.
- A fallback URL is attempted only for transport failures, never after an HTTP
  authentication or validation error.
- Logs must redact URL query strings, auth headers, secrets, and metadata text.

## Book matching

The local book's `hash` is the primary identity. The first operation needing a
remote record calls `GET /books/by-hash/{hash}` and persists the returned IDs
in `book_links`.

If no match exists, show a non-blocking "Book not found in Grimmory" state.
Never create a remote book, guess by title, or retry every reader event. A
negative match is cached briefly and invalidated by manual retry or shelf sync.

## Progress

Reuse Readest's existing progress conflict UI and CFI/XPointer utilities.

- On book open, pull remote progress after resolving the link.
- Reflowable books send/consume `location` plus native `progress` (XPointer).
- Fixed-layout books send `currentPage`, `totalPages`, `progress`, and
  `percentage`.
- Coalesce queued progress to a single latest row per book.
- Push on the existing debounce and lifecycle boundaries; do not block page
  turns, book open, or close.
- `prompt`, `silent`, `send`, and `receive` have the same meaning as KOSync.

## Sessions and read status

Create a session when a reader becomes active and close it on background, book
change, and explicit close. Validate a minimum duration or progress delta in
Readest, then submit `reading-sessions/batch`. Queue valid sessions offline.

Read status is a separate write. Obtain allowed values from the server, map
Readest's `unread`, `reading`, `finished`, and `abandoned` only when a server
equivalent exists, and never overwrite a newer locally explicit status.

## Metadata

Metadata supports rating, annotations, and bookmarks.

- Push creates stable dedupe keys rooted in connection ID, local book hash,
  note ID, type, and a content/version suffix.
- Pull stores a cursor only after every returned item was validated and merged.
- Merge uses remote `updatedAt` and local `BookNote.updatedAt`; ties preserve
  the local note to avoid unexpected loss. Tombstones become `deletedAt`.
- CFI is authoritative for Readest rendering. XPointer is included when
  conversion succeeds, so KOReader-compatible peers can locate the note.
- An annotation whose anchor cannot be resolved is retained in history and
  shown as unavailable rather than being silently dropped.

## Shelf sync and download safety

For each enabled subscription:

1. Fetch the selected regular or Magic Shelf.
2. Diff remote `bookId`/`bookHash` against `shelf_entries` and local hash index.
3. Reuse an existing local match; otherwise queue an authenticated download.
4. Download to a temporary cache path, validate content type, expected size,
   and EPUB/CBZ/PDF signatures, then import with `appService.importBook`.
5. Write `shelf_entries` only after import succeeds.
6. Mark present entries `last_seen_at` only after a complete successful remote
   list, never after a partial or cancelled list.
7. For entries absent from a complete remote list, apply the subscription
   policy: `keep_local` (default), `ask`, or `remove_managed_copy`.

Only a row with `managed_by_grimmlink = 1` and a path inside Readest's managed
library roots may be locally deleted. There is no automatic local-delete to
server-shelf-delete action. A separate confirmed command calls the shelf
membership removal endpoint.

## Offline outbox

The provider outbox is durable and ordered by dependency:

1. Coalesced progress writes
2. Session batches
3. Metadata mutations
4. Explicit shelf-removal requests

Each row carries an idempotency key, attempt count, timestamp, serialized
payload, and next retry time. HTTP 401/403 pauses the connection and asks the
user to reconnect; 404 invalidates the relevant book link; transport and 5xx
errors use bounded exponential backoff. A failure in one category never stops
another category.

## Performance rules

- Reader open only waits for the optional progress pull; shelf and metadata
  work never block it.
- Reuse book links and shelf snapshots to avoid redundant matching requests.
- Use cursor-based metadata pulls and batched session/metadata writes.
- Limit concurrent downloads: 2 on mobile, 3 on desktop, 1 under a low-power
  mode if Readest exposes it.
- Use the existing transfer UI for progress, cancellation, retry, and errors.
