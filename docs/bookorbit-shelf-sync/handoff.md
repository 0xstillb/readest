# Handoff: Task 01 — Phase 0: Upstream Sync + Baseline

Phase completed: Phase 0 (Upstream Sync + Baseline)
Model used: Gemini Flash 3.8 / Antigravity
Commit SHA: 48a2036349547d25e4c63283251458e0a2936a7a (base sync: d86d86fff0e7e17ea60662d515a81ca55a30598b)
Files changed:
- docs/bookorbit-shelf-sync/baseline.md
- docs/bookorbit-shelf-sync/handoff.md
- 72 merged upstream files across app, workflows, and tests (0 conflicts)
Tests run:
- `pnpm lint` (`tsc --noEmit && biome lint .`) — PASS (2,560 files checked, 0 errors)
- `pnpm format:check` — FAIL (pre-existing Windows CRLF vs Biome LF configuration; pre-commit auto-formats staged files)
- GrimmLink tests: `pnpm --filter @readest/readest-app exec dotenv -e .env -e .env.test.local -- vitest run grimmlink` — PASS (11 files, 92 tests)
- BookOrbit tests: `pnpm --filter @readest/readest-app exec dotenv -e .env -e .env.test.local -- vitest run bookorbit` — PASS (18 files, 105 tests)
- Bookshelf & Shelf Sync tests: `pnpm --filter @readest/readest-app exec dotenv -e .env -e .env.test.local -- vitest run bookshelf shelf` — PASS (6 files, 43 tests)
- Sync Services tests: `pnpm --filter @readest/readest-app exec dotenv -e .env -e .env.test.local -- vitest run src/__tests__/services/sync` — PASS (72 files, 860 tests)
- Rust cargo checks: `cargo fmt -p Readest --check` & `cargo clippy -p Readest --no-deps -- -D warnings` — PASS
- Rust library tests: `cargo test -p Readest --lib` — 175 passed, 2 failed (pre-existing Windows path format differences in `dir_scanner` and `range_file`)
- Android / CDP: `adb devices` checked; emulator offline, tests soft-skip as expected without connected device
Known issues:
- `pnpm format:check` fails globally on Windows due to CRLF checkouts against Biome's LF setting; pre-commit hook applies Biome format cleanly to staged changes.
- Rust tests `dir_scanner::tests::scan_preserves_requested_root_spelling` and `range_file::tests::safe_path_accepts_absolute_traversal_free` fail exclusively on Windows hosts due to forward-slash / POSIX path assumptions.
- Android e2e tests require a running emulator or physical hardware.
Decisions made:
- Added `upstream` remote (`https://github.com/readest/readest.git`) while preserving `origin` and `0xstillb` remotes.
- Fast-forwarded local `main` to `0xstillb/main` (`bdd06c3ee`) before merging `upstream/main` to preserve all fork work (GrimmLink, release hardening, Nix/Docker build fixes).
- Merged `upstream/main` (`8d76d3fc1`) into `main` cleanly with 0 conflicts (`d86d86fff`).
- Created and branched `feature/bookorbit-shelf-sync` from the synced `main`.
- Documented baseline test results and pre-existing platform quirks without modifying unrelated upstream or fork code.
Do not change:
- Generic Shelf Sync provider neutrality.
- GrimmLink implementation, outbox replay, and e-ink behaviors until BookOrbit parity is proven.
- Stock BookOrbit server contract.
- Data safety invariants regarding managed book retention/deletion.
Next task: Task 02
