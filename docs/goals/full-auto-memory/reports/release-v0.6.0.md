# OpenMem v0.6.0 — release verification

Date: 2026-11-18
Version: 0.6.0
Branch: `release/v0.6.0` → `main`
Tag: `v0.6.0`

## Verdict

Verified and installed locally; release candidate ready. `npm run verify` passed with
**82 test files / 1080 tests**, all three typechecks, plugin and console builds,
extension service proxy tests and `git diff --check`.

## Rulings

- Hybrid lane is the shipped product; `autoWriteKinds` / `reviewLane` /
  `quarantineHours` are covered by `automation.mode`, extract quarantine and local
  admission. `autoUpdate` and daily/per-session write budgets are implemented.
- Recall root = owned + host-read + id-matched + no `parentID`; failed/unavailable =
  `unknown`; `parentID` present = `child`.
- Plugin installs to `~/.config/opencode/plugins/open-mem`; extension to
  `~/.config/openchamber/extensions/openmem`; backups first; the extension is left
  disabled until the user enables it.
- The simulated soak keeps `fakeClock:false`; injected `now` where production
  functions accept it, `recordChange` timestamps remain wall-clock. Phase06's
  `fakeClock:true` field is not met and is not claimed.

## Changes

- **Core write path** — capacity admission before every extract add/update; legacy
  config revision normalization; `autoUpdate` content switch; UTC-day and per-session
  write budgets inside the write transaction; in-flight pending recovery no longer
  clobbers attempts/dispatches.
- **Recall** — ACCEPTANCE P04 root semantics and 28 recall/context-recall tests.
- **Console** — Memory / Activity / Settings model tests and synthetic ux-smoke
  fixtures for stopped/restored/expired/undoable/legacy/project B.
- **Migration and soak** — guarded dry-run/apply/undo/re-apply/restore/compat-export/GC
  tests; 30-day simulated soak through the real consolidation lane, 16/16 invariants,
  `simulated:true`.
- **Test repairs** — 24 stale consolidate + 1 extract fixture, 8 plugin-wiring, 7
  api/revert/review-integration, 8 plugin.test, 34 review/context-version fixtures.
  Test-only; no product gate was weakened.

## Verification

- `npm run verify` → exit 0; 82 files / 1080 tests; 110.49s. Log:
  `tmp/full-auto-memory/verification/verify-final-2.log`.
- Typechecks: plugin, console, extension. Builds: plugin, console, extension service.
  Extension service proxy tests passed. `git diff --check` passed.
- Extension package: `dist/openmem-console-extension-0.6.0-20261118T074418Z.zip`
  (293K), version `0.6.0+build.20261118T074418Z`.
- Installed plugin static import smoke passed; default export + `setupPlugin` present.
- Migration core + soak: 8 tests green; 30-day soak `simulated:true`, 16/16 invariants,
  ~13s; `fakeClock:false` documented.

## Install

- Plugin: `~/.config/opencode/plugins/open-mem` (0.6.0). Config backup:
  `~/.config/opencode/opencode.json.bak-20261118-154421`.
- Extension: `~/.config/openchamber/extensions/openmem`
  (`0.6.0+build.20261118T074418Z`); backup
  `openmem.bak-20261118-154421`. `extensions.json` path unchanged;
  `disabledGuests.openmem` remains `true`.
- Manual: quit/reopen OpenCode; enable OpenMem in OpenChamber Settings → Extensions;
  automation stays off until chosen.

## Release

- Tag: <https://github.com/blackkcold/open-mem/releases/tag/v0.6.0>
- Asset: `openmem-console-extension-0.6.0-20261118T074418Z.zip`
- Merge note: `main` was at the v0.4.0 baseline; this release carries the v0.5.0
  content plus v0.6.0. A merge commit preserves the v0.5.0 tag ancestry (a squash
  merge would not).

## Remaining boundaries

- Real OpenCode host injection, real model quality, real-data migration and 30-day
  wall-clock stability are not verified.
- Visual/keyboard acceptance on a real screen remains manual.
- Automation is off by default; do not enable it or migrate real memory until the
  host/data checks are done.
- `fakeClock:false` for the simulated soak; phase06's `fakeClock:true` field is not
  met.
