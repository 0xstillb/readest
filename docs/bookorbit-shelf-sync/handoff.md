# Handoff: Task 15 — Phase 9: Web Proxy + Security

Phase completed: Task 15 — Phase 9: Web Proxy + Security
Model used: Gemini Flash 3.8 / Antigravity
Commit SHA: 96a825afc
Files changed:
- apps/readest-app/src/pages/api/bookorbit.ts
- apps/readest-app/src/services/bookorbit/BookOrbitClient.ts
- apps/readest-app/src/services/bookorbit/shelfDownload.ts
- apps/readest-app/src/__tests__/utils/bookorbit-ssrf.test.ts
- apps/readest-app/src/__tests__/services/bookorbit/BookOrbitClient.test.ts
- docs/bookorbit-shelf-sync/handoff.md

Tests run:
- `pnpm lint` (`tsc --noEmit && biome lint .`) — PASS (Checked 2,586 files. 0 errors)
- `vitest run bookorbit-ssrf` (1 test file, 24 tests) — PASS
- `vitest run bookorbit` (22 test files, 171 tests) — PASS
- `vitest run shelfSync` (8 test files, 157 tests) — PASS
- `vitest run grimmlink` (12 test files, 98 tests) — PASS
- `cargo check -p Readest` — PASS

Known issues:
- None.

Decisions made:
1. Strict Endpoint Allowlist & Rejection of Broad Wildcards:
   - Whitelisted exact JSON routes for collections (`/plugin/collections`, `/plugin/collections/:id`, `/plugin/collections/:id/books`, and stock fallbacks `/collections`, `/collections/:id`, `/collections/:id/books`).
   - Whitelisted exact JSON routes for smart-scopes (`/plugin/smartscopes`, `/plugin/smartscopes/:id`, `/plugin/smartscopes/:id/books`, `/plugin/smart-scopes`, and fallbacks `/smartscopes`, `/smart-scopes`).
   - Whitelisted exact JSON routes for manifest (`/plugin/catalog/manifest`, `/plugin/manifest`, `/manifest`).
   - Strictly rejected broad catalog wildcards (e.g. `/plugin/catalog/*`, `/plugin/catalog/root`, `/catalog/*`).
   - Shelf IDs strictly constrained to `[a-zA-Z0-9_-]+` to prevent path traversal and delimiter injection.
2. Dedicated Streaming Path for Binary Downloads:
   - Whitelisted binary download path strictly for `/plugin/catalog/files/<numeric-id>/download` (`\d+`).
   - Dedicated streaming pipeline (`Readable.fromWeb(response.body).pipe(res)` or Node stream pipe) without parsing JSON or buffering payloads into memory.
   - Forwards `Content-Type`, `Content-Length`, `Content-Disposition`, and sets `Cache-Control: no-store`.
   - Sends `Accept: application/octet-stream, application/epub+zip, application/pdf, */*` on download requests.
3. Rigorous SSRF, TLS & Injection Hardening:
   - Restricted schemes to `http:` and `https:`.
   - Enforced host blocking (`isBlockedHost` / `isLanAddress`) rejecting loopback, RFC1918 private, link-local (169.254.169.254), multicast, and internal hostnames before fetching.
   - Enforced `redirect: 'error'` to strictly reject redirects (both native fetch and 3xx detection), preventing redirect-based SSRF.
   - Rejected server URLs containing credentials/userinfo, query strings, fragments, or non-origin paths.
   - Enforced safe headers filtering: stripped hop-by-hop headers (`host`, `connection`, `cookie`, `content-length`, etc.), validated RFC 7230 header names, and rejected CRLF (`\r`, `\n`) or null byte injection.
   - Rejected path injection (`..`, `\`, `//`, `?`, `#`, `%2e%2e`).
4. Native TLS Isolation & Separate Scope Documentation:
   - Web proxy runs in serverless/Node environment with standard strict TLS certificate and hostname validation (no `danger` flags).
   - Documented that native desktop/Android uses Tauri HTTP plugin with `danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true }` to support self-signed certificates on local LAN BookOrbit instances. This native TLS risk is strictly isolated to native/LAN direct requests and is NOT present in the web proxy.
5. Client-Side Catalog Integration:
   - Added `downloadShelfBook(fileIdOrBookId)` and `getCatalogManifest()` to `BookOrbitClient`, routing through the secure web proxy when on web platform with a remote server.
   - Updated `BookOrbitShelfAdapter.downloadBook` to delegate to `downloadShelfBook(book.fileId ?? book.bookId)`.

Do not change:
- Provider neutrality of generic core (`src/services/shelfSync/`).
- Data Safety Invariant: Automatic deletion requires ALL 6 criteria. When uncertain, KEEP the local book. Prefer extra file over false deletion.
- Stock BookOrbit server contract.
- GrimmLink preservation.

Next task: Task 16.
