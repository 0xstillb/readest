# Baseline Report — BookOrbit Shelf Sync

**Date:** 2026-09-24  
**Working Branch:** `feature/bookorbit-shelf-sync`  
**Base Branch:** `main` (synced with `upstream/main`)  

---

## 1. Git Repository State & SHAs

- **Upstream Repository:** `https://github.com/readest/readest.git`
  - **Upstream `main` SHA:** `8d76d3fc1f0e26f8c5dbe1fc343f9d69256eefc2`
- **Fork Repository:** `https://github.com/0xstillb/readest.git`
  - **Fork `main` SHA (pre-sync):** `bdd06c3ee3741332cddc9017beee65daf40ae855`
  - **Fork `main` SHA (post-sync merge):** `d86d86fff0e7e17ea60662d515a81ca55a30598b`
- **Working Feature Branch:** `feature/bookorbit-shelf-sync`
  - **Feature Commit SHA:** `48a2036349547d25e4c63283251458e0a2936a7a`
  - **Feature Base SHA:** `d86d86fff0e7e17ea60662d515a81ca55a30598b`

### Ahead / Behind Comparison

- Upstream merge-base: `8750c3104337881d9b0ec9939ab5e8495f472cae`
- Fork was 54 commits ahead of merge-base, including all GrimmLink, release hardening, and Android fixes.
- Upstream had 6 commits ahead of merge-base:
  - `5d030abf3` fix(build): repair the Docker and Nix builds after #6368 (#6379)
  - `39d4f4e40` fix(settings): reset update preferences with behavior settings (#6369)
  - `85920ceef` fix(android): open Readest from TTS media controls (#6370)
  - `5dcfeab5d` fix(reader): handle footnote links in paragraph mode (#6365)
  - `19c6a4f62` feat(reader): add dialogue highlighting for quoted speech (#6376)
  - `8d76d3fc1` chore(deps): bump the github-actions group with 7 updates (#6387)
- 3-way merge into `main` concluded cleanly with 0 conflicts (`d86d86fff`).
- Relative to `upstream/main`: 55 commits ahead, 0 commits behind.

---

## 2. Test Execution & Baseline Results

### Code Hygiene & Linting
- **Command:** `pnpm lint` (`pnpm --filter @readest/readest-app lint` -> `tsc --noEmit && biome lint .`)
  - **Result:** **PASS** (Checked 2,560 files in 2s, 0 errors).
- **Command:** `pnpm format:check` (`biome format .`)
  - **Result:** **FAIL** (Pre-existing Windows CRLF line ending differences vs Biome's LF configuration). Pre-commit hooks via lint-staged apply Biome formatting cleanly on staged files.

### GrimmLink Baseline
- **Command:** `pnpm --filter @readest/readest-app exec dotenv -e .env -e .env.test.local -- vitest run grimmlink`
  - **Result:** **PASS** (11 test files passed, 92 tests passed, 0 failed).
  - Covers client, proxy, e-ink diagnostics, metadata, outbox, progress, and shelf sync.

### BookOrbit Baseline
- **Command:** `pnpm --filter @readest/readest-app exec dotenv -e .env -e .env.test.local -- vitest run bookorbit`
  - **Result:** **PASS** (18 test files passed, 105 tests passed, 0 failed).
  - Covers client, pairing, manifest, narration, audiobooks, notes, annotations, bookmarks, SSRF validation, and sync store.

### Bookshelf & Generic Shelf Sync Baseline
- **Command:** `pnpm --filter @readest/readest-app exec dotenv -e .env -e .env.test.local -- vitest run bookshelf shelf`
  - **Result:** **PASS** (6 test files passed, 43 tests passed, 0 failed).
- **Command:** `pnpm --filter @readest/readest-app exec dotenv -e .env -e .env.test.local -- vitest run src/__tests__/services/sync`
  - **Result:** **PASS** (72 test files passed, 860 tests passed, 0 failed).

### Rust & Tauri Backend Baseline
- **Commands:**
  - `cargo fmt -p Readest --check`: **PASS** (0 formatting violations)
  - `cargo clippy -p Readest --no-deps -- -D warnings`: **PASS** (0 warnings)
  - `cargo test -p Readest --lib`: **175 passed, 2 failed** (known pre-existing Windows host path format differences):
    1. `dir_scanner::tests::scan_preserves_requested_root_spelling`: Expected `/` in normalized subpath, received Windows native `\`.
    2. `range_file::tests::safe_path_accepts_absolute_traversal_free`: Posix path `/data/user/0/...` tested against `Path::is_absolute()`, which fails on a Windows host expecting drive prefixes.

---

## 3. Platform & Hardware Status

### Android & Tauri Status
- `adb devices`: Daemon active, emulator offline (`emulator-5554 offline`). No physical or online virtual device attached in current environment.
- Android tests (`scripts/test-android.sh`) are gated on CDP and designed to soft-skip safely when no active device or emulator is connected.
- Tauri WebDriver tests (`scripts/test-tauri.sh`) require active desktop graphical environment and running dev/webdriver server.

### Ocean 5 Pro Notes
- E-ink optimizations and refresh diagnostics are preserved and verified via unit tests (`grimmlinkEinkDiagnostics.test.ts`).
- Physical button mapping and hardware sleep/wake lifecycle testing remain documented in `apps/readest-app/docs/grimmlink/STATUS.md` and require testing on actual physical Android hardware.

---

## 4. Invariants & Rules Affirmed

- Generic Shelf Sync remains strictly provider-neutral.
- BookOrbit server remains stock.
- GrimmLink implementation preserved without modification.
- Data safety invariant: Local book deletion requires strict proof and conservative defaults.
