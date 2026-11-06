# Testing

## Current hardening verification (2026-11-06)

`npm run verify` runs the plugin Vitest suite, plugin/console/extension typechecks,
plugin + console build, extension bundles, extension service proxy tests and
`git diff --check`. The latest local run passed **59 files / 739 tests**, all
typechecks/builds and the extension proxy tests (exit 0). The latest result is in
the hardening ledger and completion report; earlier counts below are historical. The
verification scope and remaining gaps are recorded in
[`PROGRESS.md`](goals/openmem-hardening/PROGRESS.md). CI is configured to run this
same command on Node 22/Linux; no remote CI result is claimed before a push.

The original inventories and L4 results below are historical snapshots, not fresh
live-model tests. This hardening pass uses only synthetic data, no paid calls,
no installation and no live configuration edits.

New regression coverage includes initialization/cross-process locks, corrupted
JSON/JSONL preservation, project isolation, capacity retries, mixed-TTL leases,
shared actual-request budgets, credential/endpoint boundaries, human approval
gates, stale-target protection, conflict-checked and resumable undo/recovery,
mobile focus and token recovery, durable redo WAL with approval/apply rename-point
process-exit injection, nested rollback, 90-day/20-record retention, reference
protection, time-invalidated previews and canonical cold session continuation.
Browser checks include project filtering/failure recovery, six-page 390px layout
and accessible control names, Enter/Tab/Escape and modal focus restoration.
Browser checks are manual synthetic smoke tests,
not automated visual/accessibility certification.

## Safety boundary

Every test is isolated:

- No plugin is installed into OpenChamber, the bundled OpenCode, or a standalone OpenCode.
- The repository does not modify `~/.config/opencode/opencode.json`.
- Unit/API tests use `mkdtemp` or `open-mem/tmp/...`.
- The demo and real-instance test bind `127.0.0.1` and require a token.
- The isolated OpenCode instance uses its own `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, data directory, project directory, and ports.
- No live credential file is copied; the real test reads `OLLAMA_API_KEY` from the existing auth store into the child process only.

## Test matrix

| Level | Environment | Writes | Result |
|---|---|---|---|
| L0 | Vitest unit/API | temporary directories | latest local result in hardening ledger |
| L1 | mock OpenCode `ctx` | temporary directories | plugin setup, events, context, tool, commands |
| L2 | local demo API + Console | `open-mem/tmp/...` | API, SSE, queue, skill, map, audit |
| L3 | browser (Playwright/OpenChamber) | `tmp/` | queue, suggestion, approve, health |
| L4 | real isolated OpenCode server | isolated XDG + tmp | plugin loaded, real S1 + S2, UI approve |
| L5 | live OpenCode | live | not run; requires explicit approval |

## Original unit-test inventory (historical counts)

### `linter.test.ts` (6)

- accepts a concise atomic fact;
- rejects examples, multiple claims, overlong text;
- rejects secret-like values;
- warns about absolute local paths in global memory;
- accepts a valid skill with frontmatter/workflow/verification;
- rejects bad skill names and missing frontmatter.

### `priority.test.ts` (3)

- high-risk global rules rank above low-risk project facts;
- priority grows with age;
- deferred items sort last; queue order is deterministic.

### `store.test.ts` (2)

- data layout, `AUTO_MEMORY.md` provenance, token mode `0600`;
- queue upsert/remove.

### `decision.test.ts` (4)

- OpenCode decisions predicates map to kind/risk/duplicate/safe_auto;
- primary failure falls back to heuristic;
- strict limits and preferences classify correctly;
- duplicate phrasing is detected.

### `systemone.test.ts` (3)

- sends 8 typed questions and maps `noul`/`choice`, target, usage;
- omits `merge_target` when there are no neighbors;
- maps 401 to a clear `SystemOneError`.

### `rewrite.test.ts` (9)

- composer merges a complementary fact without losing the port;
- rules never auto-merge;
- length limit records dropped clauses;
- validator rejects a new number, empty drop reasons, rule merges, conflicts;
- System Two parses the JSON contract through `generate.text`;
- service falls back to composer on invalid JSON;
- service caches a successful rewrite (one model call for two identical inputs).

### `fingerprint.test.ts` (2)

- SimHash is deterministic; punctuation near-duplicates match;
- neighbor ranking includes item, queue, and shadow entries.

### `consolidate.test.ts` (4)

- low-risk preference auto-writes when shadow is off;
- risky rule goes to queue, never auto-written;
- shadow mode records `shadow.jsonl` and does not write auto memory;
- the same last message ID is not processed twice.

### `actions.test.ts` (3)

- approve writes `AUTO_MEMORY.md`, removes the queue item;
- deny archives; edit updates and recomputes priority; defer snoozes;
- linter failure blocks approval.

### `apply.test.ts` (2)

- merge updates the target, increments `seenCount`, removes the queue item; undo restores target and re-queues;
- reject_duplicate archives the candidate and increments the target.

### `capacity.test.ts` (5)

- total item cap blocks writes;
- auto-memory lane full returns `queue`;
- queue full rejects new candidates;
- disk budget is a hard block;
- byte formatting.

### `health.test.ts` (2)

- empty store scores 100;
- duplicates, conflicts, and decision fallbacks lower the score.

### `audit.test.ts` (1)

- duplicate, secret, stale, queue, shadow, malformed skill; metrics and percentiles.

### `map.test.ts` (2)

- coordinates in `[0,1]`; duplicate edge; queue/shadow nodes; empty/single input.
- node field allowlist: item/queue/shadow bodies never appear on the wire.

### `graph.test.ts` (1)

- five views; L0/L1/L2/OpenMem/backup sources; routing matrix; backup/restore gaps;
  source detail; inventory never contains memory bodies.

### `baseline.test.ts` (2)

- curated section matching, project isolation, numeric/negation conflicts.

### `relations.test.ts` (8)

- exact, classification mismatch, changed port, negation, containment, partial/related,
  versions/dates.

### `skill.test.ts` (2)

- valid draft approves into `outbox/skills`, never live skills; malformed draft rejected.

### `plugin.test.ts` (1)

- registers `memory_autopilot` and the three commands;
- `session.created` writes the `plugin.memory-autopilot` entry;
- `session.idle` routes a risky rule to the queue;
- tool actions `status`/`review`/`audit`/`console_url`/`learn_skill`;
- command prompt, second-session context hook, cleanup.

### `api.test.ts` (10)

- 401 without token; health/queue; approve; audit/map; skills detail/request_changes;
- false-positive metrics; config PATCH; batch deny; SSE `ready`.

### `api-v2.test.ts` (4)

- `POST /api/queue/:id/suggest` returns a prefilled merge suggestion;
- apply updates target, exposes health/usage/journal, undo restores;
- batch dry-run + apply;
- compact, config hides token, PATCH rewrite settings.

## Historical real isolated instance (L4; not re-run in hardening)

Environment: OpenCode `2.1.1`, `serve` on `127.0.0.1:47900`, isolated XDG dirs, plugin loaded from the local path, console on `127.0.0.1:47901`, Basic auth set for the isolated server. Data: `tmp/iso-live-2/mem`.

Results:

- Plugin appears in `/api/plugin`; console `/api/health` returns `200` with `shadow:false`, `decision.keySource:"env"`.
- **System One**: `POST https://ollama.com/v1/systemone`, `clef:27b-cloud` → `200`, **1.27s**, **1435 input tokens**, `ok:true`.
- **System Two**: `POST https://ollama.com/api/chat`, `glm-5.3-flash:cloud` → `200`, **16.84s**, **298 input + 2754 output tokens**, `ok:true`; output passed linter, numeric guard, and preservation.
  - Historical: this run predates the 2026-11-04 model policy correction. System Two now uses `deepseek-v4.1-flash:1017#high`. A direct `/api/chat` smoke test with `think: "high"` returned `200` in 0.9s (39 input / 22 output).
- Suggestion: `merge_into` target `[F] dev server 端口 5199`, concentration `0.95`, text `本地 dev server 端口是 5199；启动前先检查该端口是否被占用。`
- Apply: target `seenCount=2`, queue item removed, `merge-journal` written, `AUTO_MEMORY.md` rebuilt; undo restored the target and re-queued the candidate.
- Browser: selected the suggestion row, saw the prefilled System Two card, clicked **批准合并**; queue dropped from 2 to 1 and the banner showed the 24h undo hint.
- Health page: score **99**, capacity 2%, duplicate 0%, acceptance 100%, **S1 1 call / 1435 tokens / 0% fallback**, **S2 1 call / 3052 tokens / 0% fallback**; journal showed one applied and one undone merge.
- Live checks: ports `47900`/`47901` closed; live `opencode.json` plugins still `["superpowers@..."]`; no live `autopilot` data; OpenChamber `agentMemoryToolEnabled=true` and `memory.json` present; no isolated `auth.json` copied; no type suppressions.

## Bugs found and fixed

1. `mergeConfig` wrote `undefined` top-level fields over saved config, wiping `port` and auto-write flags. Fixed by filtering undefined values.
2. Isolated console returned `{"error":"not found"}` when the build directory was missing. Fixed with `OPENMEM_CONSOLE_DIR` and a root-path fallback.
3. Assistant restatements were extracted as duplicate candidates. Now only user messages are authoritative.
4. Skill detail API omitted `SKILL.md` content. Fixed.
5. Favicon 404 caused a console error. Fixed with an inline icon.
6. `existingTitles` shadowed a same-named function. Renamed.
7. CLI path resolution differed between repo root and `plugin/`. Fixed.
8. Added `data-tab`, `data-queue-id`, `data-status`, `data-skill-id` anchors for stable UI tests.

## Session review coverage (current files)

Full operational guide (manual checks, API recipes, fault injection):
[`docs/SESSION-REVIEW.md`](./SESSION-REVIEW.md).

| File | Cases | Covers |
|---|---|---|
| `review-input.test.ts` | 7 | budget, newest-first slicing, tool digests, user-only mode, redaction, stable hash, synthetic exclusion |
| `review-model.test.ts` | 19 | JSON parse, confidence clamp, evidence rules, repair, retry, circuit, cache |
| `review-orchestrator.test.ts` | 14 | idle window, re-arm, deferral, hash skip, failure, hourly cap, restart, ping no-op, subagent skip, shared lease |
| `review-reliability.test.ts` | 7 | attempt reset on new material, restart not counted, slot release, pause mid-run, single message, cross-source dedupe, manual hash skip |
| `review-integration.test.ts` | 7 | queue-only gate, rules never auto, shadow exclusion, priority floor, agent approve refused, cross-lane dedupe |
| `review-api.test.ts` | 6 | review list/detail, origin filter, auth, usage, config patch (incl. zero values) |

Total: 60 cases in these six files, plus separate session-note and reader tests.
The gate tests (`review-integration`, `review-api`) must stay green;
they assert that no review candidate can reach auto/shadow without a human decision.

## Not covered yet

- A full real agent turn / real `session.idle` in the isolated server. The plugin was loaded and the console API exercised real S1/S2; the `session.idle` path is covered by the mock `plugin.test.ts`.
- A live session-review model call end to end (the provider and orchestrator are covered with stubs; the prompt is not exercised against a real model).
- The real `generate.text` transport. The isolated test used the direct `ollama` transport to avoid copying provider credentials; `generate.text` is covered by a fake `ctx` in `rewrite.test.ts`.
- The OpenCode built-in decisions API against a live model.
- Long-running multi-session concurrency and disk growth beyond the test fixtures.
- Actual power loss, hardware faults, ENOSPC campaigns and arbitrary third-party
  writes bypassing the lock. Process-exit injection covers the actual rename
  boundaries of approval and merge apply, plus a generic two-file commit and an
  interrupted history deletion; it does not enumerate every hardware crash point.
- Concurrent read-only requests do not have MVCC snapshots across multi-file replay.
- Full screen-reader/WCAG certification and every extension iframe interaction.
- Author self-review only for this hardening pass: the user explicitly prohibited
  subagents. A second-person review is still advisable before a production release.
- Push notifications; v1 uses the console and next-turn context.

## Commands

```bash
cd open-mem
npm test
npm run typecheck
npm run build
npm run verify     # complete engineering gate, including extension checks
npm run dev:ux     # after build: fresh synthetic data, no model, 15-minute expiry
npm run demo
```

## Historical L4 acceptance (not current hardening completion criteria)

- `npm test` 0 failures; `npm run typecheck` 0 errors; `npm run build` succeeds.
- Demo API returns 200; console assets load; 0 console errors.
- Real isolated S1 and S2 return 200 and pass validation.
- Apply/undo and UI approve work; Health reflects real usage.
- Live OpenCode/OpenChamber config and data unchanged; test ports closed.

## UX smoke recipe

After building, run `nohup npm run dev:ux` in a background shell. The fixture
prints a single-use link and writes only `tmp/ux-smoke-*`. It disables review,
rewrite and cloud classification and stops itself after 15 minutes. Its token is
synthetic test data, not a user credential. A fixture is never a production store.

Check: ticket exchange clears the URL; expired-token replacement; session
promotion with confirmation; skill-to-draft navigation; history restore;
compaction preview cancellation; note ignore/restore; narrow-screen navigation,
44px main controls and candidate detail focus. Close only the browser tabs and
fixture processes opened for this check. A real user's store must not be used.
