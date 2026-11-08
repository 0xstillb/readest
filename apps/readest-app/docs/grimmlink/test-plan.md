# GrimmLink test plan

## Required TDD workflow

For every behavior, create the smallest failing test before implementation.
Run it, implement the smallest passing change, then refactor with the test
green. New implementation code without a corresponding focused test is not
ready for review. Test filenames should follow the provider boundary, for
example `GrimmLinkClient.test.ts`, `grimmlinkProgress.test.ts`, and
`grimmlinkShelfSync.test.ts`.

## Client unit tests

- Normalizes origin URL and never duplicates `/api/grimmlink/v1`.
- Sends auth headers; custom headers cannot override them.
- Parses successful auth/capabilities and rejects HTML success pages.
- Covers every endpoint, path encoding, GET query, JSON body, and binary
  download request.
- Classifies 400, 401, 403, 404, 409, 429, 5xx, malformed JSON, timeout, and
  transport failures.
- Attempts fallback only after a transport failure.
- Omits invalid-TLS flags by default; allows them only for an opted-in LAN
  endpoint and never for public or Cloudflare Tunnel origins.
- Retries transient responses and transport timeouts with a 15s request
  deadline, three retries, and 250/500/1000ms exponential backoff.

## Store and outbox tests

- Schema creation is idempotent.
- Progress coalesces per connection/book.
- Session batch order and retry metadata survive close/reopen.
- Cursor is not advanced after any metadata item fails to apply.
- Note mappings are isolated by connection and book hash.
- Managed shelf entry cannot authorize deletion outside the managed library
  root.
- Diagnostics summary, persisted error categories, URL redaction, retry and
  invalid-row cleanup.
- Lifecycle session intervals remain separate across suspend/resume and a
  single-flight pull prevents duplicate replay races.

## Progress tests

- EPUB CFI/XPointer conversion and fallback fraction behavior.
- PDF/CBZ page, total, and percentage conversion.
- Prompt/silent/send/receive strategies.
- Same-device remote echo does not create a false conflict.
- Unmatched book and unresolved native position are non-destructive.
- GrimmLink conflict labels show user-facing position/device/time data without
  exposing CFI, XPointer, hashes, or internal IDs.

## Metadata tests

- Rating scales 1–10 and 1–5 conversion.
- Annotation/bookmark serialization contains dedupe key and positions.
- Local/remote merge by timestamp, duplicate pulls, and tombstones.
- Missing or invalid remote locations do not discard user data.
- Pagination/cursor behavior at 1, 100, and 500 items.

## Shelf and download tests

- Regular and Magic Shelf list parsing.
- First sync, repeated unchanged sync, remote added, remote removed, missing
  managed file, and existing local hash match.
- Cancellation leaves no usable partial file or false `shelf_entries` row.
- Reject HTML/JSON payloads, empty files, invalid EPUB/CBZ ZIP signatures,
  invalid PDF signature/EOF, and unexpectedly small file responses.
- `keep_local`, `ask`, and `remove_managed_copy` policies.
- Explicit server shelf removal never deletes a remote library record.

## Web proxy tests

- Reject non-POST proxy calls, unsupported paths/methods, non-HTTP(S) URLs,
  private/local addresses, redirects, and malformed payloads.
- Preserve only allowed headers and never echo credentials in errors or logs.
- Stream file downloads and preserve status/content type safely.

## End-to-end and manual matrix

| Target | Required scenario |
| --- | --- |
| Windows device / Tauri | Self-signed local server, progress conflict, shelf download/cancel, restart replay, sleep/wake, network adapter disconnect/reconnect, and managed-file cleanup. |
| Android physical device / Tauri | Background/foreground, activity recreation, app force-close after queue write, constrained Wi-Fi/mobile network, large shelf, download cancellation, storage permission, and reconnect replay. |
| Web | Public HTTPS server through proxy, metadata pull, download handling, no CORS dependency. |
| OS lifecycle | Open a book, suspend/background during active reading, resume, change network, then confirm exactly one valid session and independently replayed queue categories. |
| Offline | Read, annotate, change status, reconnect, and verify each queued category drains independently. |
| Safety | Remove a shelf member, locally delete a user-imported book, and verify neither action deletes unintended bytes or server records. |

## Windows and Android release gate

Before a release candidate is accepted:

- Run focused Vitest suites and the affected Tauri integration tests in CI.
- Run the Windows Tauri scenario on a real Windows device, not only a browser.
- Run the Android scenario on a physical Android device. An emulator can add
  coverage but cannot replace storage, lifecycle, and network validation.
- Capture a sanitized diagnostics export and confirm it contains no URL,
  credential, annotation text, or book-content leak.
- Record app version, Grimmory version, network type, and pass/fail evidence
  for each device run.
