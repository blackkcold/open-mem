# Testing

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
| L0 | Vitest unit/API | temporary directories | 18 files, 65 tests passing |
| L1 | mock OpenCode `ctx` | temporary directories | plugin setup, events, context, tool, commands |
| L2 | local demo API + Console | `open-mem/tmp/...` | API, SSE, queue, skill, map, audit |
| L3 | browser (Playwright/OpenChamber) | `tmp/` | queue, suggestion, approve, health |
| L4 | real isolated OpenCode server | isolated XDG + tmp | plugin loaded, real S1 + S2, UI approve |
| L5 | live OpenCode | live | not run; requires explicit approval |

## Unit test points

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

## Real isolated instance (L4)

Environment: OpenCode `2.1.1`, `serve` on `127.0.0.1:47900`, isolated XDG dirs, plugin loaded from the local path, console on `127.0.0.1:47901`, Basic auth set for the isolated server. Data: `tmp/iso-live-2/mem`.

Results:

- Plugin appears in `/api/plugin`; console `/api/health` returns `200` with `shadow:false`, `decision.keySource:"env"`.
- **System One**: `POST https://ollama.com/v1/systemone`, `clef:27b-cloud` → `200`, **1.27s**, **1435 input tokens**, `ok:true`.
- **System Two**: `POST https://ollama.com/api/chat`, `glm-5.3-flash:cloud` → `200`, **16.84s**, **298 input + 2754 output tokens**, `ok:true`; output passed linter, numeric guard, and preservation.
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

## Not covered yet

- A full real agent turn / real `session.idle` in the isolated server. The plugin was loaded and the console API exercised real S1/S2; the `session.idle` path is covered by the mock `plugin.test.ts`.
- The real `generate.text` transport. The isolated test used the direct `ollama` transport to avoid copying provider credentials; `generate.text` is covered by a fake `ctx` in `rewrite.test.ts`.
- The OpenCode built-in decisions API against a live model.
- Long-running multi-session concurrency and disk growth beyond the test fixtures.
- Push notifications; v1 uses the console and next-turn context.

## Commands

```bash
cd open-mem
npm test
npm run typecheck
npm run build
npm run demo
```

## Acceptance

- `npm test` 0 failures; `npm run typecheck` 0 errors; `npm run build` succeeds.
- Demo API returns 200; console assets load; 0 console errors.
- Real isolated S1 and S2 return 200 and pass validation.
- Apply/undo and UI approve work; Health reflects real usage.
- Live OpenCode/OpenChamber config and data unchanged; test ports closed.
