# Handoff: Task 09 — Phase 7: Subscription UI + e-ink UX

Phase completed: Task 09 — Phase 7: Subscription UI + e-ink UX
Model used: Gemini Flash 3.8 / Antigravity
Commit SHA: ee716aa1f
Files changed:
- apps/readest-app/src/components/settings/integrations/BookOrbitForm.tsx
- apps/readest-app/src/components/settings/integrations/BookOrbitShelfPanel.tsx
- apps/readest-app/src/components/settings/integrations/BookOrbitShelfSyncStatus.tsx
- apps/readest-app/src/hooks/useBookOrbitShelfSync.ts
- apps/readest-app/src/pages/api/bookorbit.ts
- apps/readest-app/src/services/bookorbit/BookOrbitClient.ts
- apps/readest-app/src/services/bookorbit/shelfDownload.ts
- apps/readest-app/src/services/bookorbit/shelfSync.ts
- apps/readest-app/src/services/bookorbit/types.ts
- apps/readest-app/src/__tests__/components/BookOrbitShelfPanel.test.tsx
- apps/readest-app/src/__tests__/components/BookOrbitShelfSyncStatus.test.tsx
- apps/readest-app/src/__tests__/services/bookorbit/BookOrbitShelfSync.test.ts
- docs/bookorbit-shelf-sync/handoff.md

Tests run:
- `pnpm lint` (`tsc --noEmit && biome lint .`) — PASS (Checked 2,585 files in 2s. No fixes applied, 0 errors)
- Unit tests:
  - `src/__tests__/components/BookOrbitShelfSyncStatus.test.tsx` (5 tests) — PASS
  - `src/__tests__/components/BookOrbitShelfPanel.test.tsx` (9 tests) — PASS
  - `src/__tests__/services/bookorbit/BookOrbitShelfSync.test.ts` (6 tests) — PASS
- Regressions:
  - `vitest run bookorbit` (22 test files, 146 tests) — PASS
  - `vitest run grimmlink` (12 test files, 98 tests) — PASS
  - `vitest run shelfSync` (8 test files, 91 tests) — PASS

Known issues:
- None.

Decisions made:
1. E-ink / Ocean UX:
   - Designed `BookOrbitShelfPanel` and `BookOrbitShelfSyncStatus` with high-contrast borders (`eink-bordered`), large touch targets (labels and rows with `min-h-14`, buttons with `min-h-10` / `h-10 px-4 py-3`), minimal layout shift, and restrained animations (`motion-safe:animate-spin` on spinners only).
   - Status displays progress with `tabular-nums` and a high-contrast progress bar.
   - Progress notifications throttled to >=200ms debounce/throttle in `useBookOrbitShelfSync` to avoid thrashing e-ink displays.
2. Shelf Subscription Model & Policies:
   - Exposed BookOrbit Collections and SmartScopes as shelf subscriptions in BookOrbit settings.
   - Per-shelf controls include an enabled toggle, Download Policy (`off` | `wifi_only` | `always`), and Cleanup Policy (`keep_local` | `remove_managed_copy`).
   - State persisted in `ShelfSyncStore` with provider `bookorbit` and connection ID matching configured server URL.
3. Safe Reconciliation & Dry-Run Preview:
   - Next sync preview displays pending counts for `Downloads`, `Updates`, and `Removals` calculated via `previewBookOrbitShelfSync` (reconciling remote shelf books with local library presence index and tracked shelf entries).
   - Preserves the Data Safety Invariant: unmanaged books and books present in other shelves or providers are never removed.
4. Manual Control & Stock Server:
   - Sync is manual (button triggered); no aggressive background sync polling is added.
   - BookOrbit server remains source of truth; no remote create/edit/delete/rename UI.
   - Fallback paths (`/plugin/collections`, `/collections`, `/plugin/smartscopes`, `/plugin/smart-scopes`, `/smartscopes`) supported and proxied via `/api/bookorbit` SSRF validator whitelist.
5. EPUB Repair Passthrough:
   - `BookOrbitShelfAdapter.repairBookData` is implemented as an explicit identity passthrough to bypass Grimmory's EPUB OPF namespace mutation and prevent corrupted non-zip parses.

Do not change:
- Provider neutrality of generic core (`src/services/shelfSync/`).
- Data Safety Invariant.
- Stock BookOrbit server contract.
- GrimmLink preservation.

Next task: Task 10 FRESH SESSION.
