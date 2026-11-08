# GrimmLink v1 API contract

All paths below are relative to the configured Grimmory origin and begin with
`/api/grimmlink/v1`. The client must send `Accept: application/json` unless it
downloads a book file. Authentication is supplied by `X-Auth-User` and
`X-Auth-Key`.

## Discovery and matching

| Operation | Method and path | Readest behavior |
| --- | --- | --- |
| Authenticate | `GET /auth` | Used by Connect/Test Connection; require JSON success. |
| Capabilities | `GET /capabilities` | Gate sessions, metadata, shelves, and future optional features. |
| Match book | `GET /books/by-hash/{bookHash}` | Persist `bookId`, `bookFileId`, format, and hash in `book_links`. |

## Progress

| Operation | Method and path | Payload / result |
| --- | --- | --- |
| Pull | `GET /syncs/progress/{bookHash}` | `KoreaderProgress`: `bookId`, `bookFileId`, `progress`, `location`, `percentage`, page fields, device fields, `updatedAt`. |
| Push | `PUT /syncs/progress` | Include `bookHash` and `document`, remote IDs when known, `fileFormat`, `progress`, `location`, `percentage`, page fields, `device`, `device_id`, `updatedAt`. |

`percentage` is a server percent in the inclusive range 0–100. Readest's
internal fraction must be converted explicitly; never send a 0–1 fraction.

## Reading sessions

| Operation | Method and path | Payload |
| --- | --- | --- |
| Single session | `POST /reading-sessions` | Use only when a single-record shape is needed. |
| Batch | `POST /reading-sessions/batch` | Preferred: `bookId`, `bookHash`, `bookType`, `device`, `deviceId`, `sessions[]`. |

Each `sessions[]` item has `startTime`, `endTime`, `durationSeconds`, optional
formatted duration, start/end progress, progress delta, start/end location,
and page fields. Restrict batches to 500 sessions.

## Metadata

### Push

Use `POST /syncs/metadata/batch` for combined push/pull or
`POST /syncs/metadata` for a push-only request. The common envelope is:

```json
{
  "schemaVersion": 1,
  "syncMode": "incremental",
  "bookId": 42,
  "bookHash": "local-file-hash",
  "bookFileId": 99,
  "fileFormat": "EPUB",
  "device": "Readest (Windows)",
  "deviceId": "stable-device-id",
  "timestamp": "2026-08-23T00:00:00Z",
  "rating": { "dedupeKey": "…", "value": 8, "scale": 10, "updatedAt": "…" },
  "annotations": [],
  "bookmarks": []
}
```

An annotation includes `dedupeKey`, `type`, `text`, `note`, `color`, `style`,
`chapter`, `page`, timestamps, and `location`. A bookmark includes a dedupe
key, title, notes, chapter, page, location, timestamps, and `deleted`.
`location` supports `cfi`, `pos0`, `pos1`, `pageno`, and `raw`.

### Pull

`GET /syncs/metadata` accepts one of `bookId`, `bookHash`, or `bookFileId`,
plus optional `cursor`, `since`, `limit` (1–500), and `type`.

The response returns `items[]` and `nextCursor`. Each item contains a type,
dedupe key, payload, client/server timestamps, and device identity. Cursor
advancement is atomic with successful local application of all items.

## Shelves and book bytes

| Operation | Method and path | Notes |
| --- | --- | --- |
| List shelves | `GET /shelves?type={regular|magic}` | Both types are first-class. |
| List regular shelf | `GET /shelves/{shelfId}/books` | Compatibility path. |
| List typed shelf | `GET /shelves/{shelfType}/{shelfId}/books` | Canonical path. |
| Download | `GET /books/{bookId}/download` | Request binary, stream to a temp path, then validate/import. |
| Remove membership | `POST /shelves/{shelfType}/{shelfId}/books/{bookId}/remove` | Explicit user action only. |

Shelf book records provide remote IDs, title/author, filename, extension or
format, size, hash, and series metadata. `bookId` and hash are authoritative;
filenames are not identity.

## Read status

| Operation | Method and path | Behavior |
| --- | --- | --- |
| Available statuses | `GET /books/read-statuses` | Cache per connection, refresh on server error. |
| Update status | `PUT /books/{bookId}/status` | Body: `{ "status": "…" }`. |

## Error handling

| Result | Behavior |
| --- | --- |
| 400/422 | Mark the queued payload invalid; surface an actionable error; do not retry automatically. |
| 401/403 | Pause this connection and require an explicit reconnect. |
| 404 on book request | Invalidate the remote link and show unmatched state. |
| 409 | Preserve local value and expose a conflict resolution action. |
| 429/5xx/transport | Retain outbox entry and retry with bounded exponential backoff. |
