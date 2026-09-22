# GrimmLink implementation status

```text
Completed: Session 1–2 provider foundation/progress plus Session 3 durable
           SQLite outbox, independent retry replay, sessions, status, and rating sync;
           Session 4 annotation/bookmark metadata mapping, cursored pull, tombstones,
           stable dedupe mappings, and reader-side application; Session 5 regular/Magic
           Shelf subscriptions, hash diffing, validated authenticated import, and safe cleanup.
Changed: `services/grimmlink/{GrimmLinkSyncStore,outbox,sessions,capabilities,
         readStatus,rating,metadata,metadataProvider,shelfSync,download}.ts`, client/proxy,
         reader hook, shelf settings panel, focused tests.
         Rating follow-up adds transactional cursor/rating storage, validated
         500-item pagination, device identity, and production reader pull wiring;
         missing replay handlers now retain outbox rows.
Tests: `pnpm test -- src/__tests__/services/grimmlink/grimmlinkOutbox.test.ts`
       and `pnpm lint` both abort before execution because this worktree lacks
       `foliate-js@workspace:*`; `git diff --check` passes.
Security hardening: GrimmLink no longer accepts invalid TLS certificates by
default. `allowSelfSignedCertificate` is opt-in and enforced only for LAN
addresses; public and Cloudflare Tunnel endpoints always use normal TLS
verification. Requests now have explicit 15s/120s request/download deadlines,
three retries with 250/500/1000ms exponential backoff, and typed Auth/Network/
Server/Conflict/Invalid-data categories. The web proxy has a 15s upstream
deadline and shelf payloads are rejected when malformed instead of silently
dropping records.
Tests: `pnpm test --run src/__tests__/services/grimmlink
       src/__tests__/services/grimmlink-settings.test.ts
       src/__tests__/utils/grimmlink-proxy.test.ts` (52 passed).
       TypeScript check reaches the existing unrelated `pdf-worker-compat.test.ts`
       `GlobalWorkerOptions` mismatch; no GrimmLink diagnostics are reported.
Diagnostics/lifecycle: Readest now persists last attempt/success/error state,
queue counts and retry timing; the GrimmLink settings page exposes connection
status, retry/clear-invalid/export-redacted actions, and category-specific
errors. Progress pull is single-flight and only unlocks push after a successful
pull. Foreground/background and online transitions close/restart sessions and
replay the durable outbox without merging suspended time. GrimmLink conflicts
use human-readable position/device/percentage/time labels and never render raw
CFI/XPointer identifiers.
Open release-gate evidence: authenticated sync and offline→online replay still
require a configured test account. On 2026-09-22, the supplied Grimmory LAN
endpoint and public endpoint both returned the Grimmory UI (200) and protected
GrimmLink capabilities with missing/invalid credentials (401), confirming
reachability and the auth gate without transmitting real credentials. The
public endpoint is plain HTTP, so it must be upgraded to HTTPS before production
use. No connected Android device was available in `adb devices`, and Windows UI
automation was unavailable; device/lifecycle scenarios remain open.
```
