# OpenMem Memory v2 — LEDGER

## Identity

- Goal version: 1.0
- Spec version: 1.0
- Plan version: 1.0

## Baseline

- Branch: `main`; working tree already contains the session-review feature and
  prior P0 fixes. No commit for this goal yet.
- Live queue (observed): 11 items, 7 review / 4 turn, 0 pending after the prior
  fix. `items.jsonl` empty; migration affects queue only.
- `scopeFor()` defaults to global; review JSON only allows global|project;
  `rebuild` does not filter project; `buildContext` has no project argument.

## Decisions / Rulings

- R1: Use 3 tiers (`session|project|global`), fold user profile into global as
  `kind=preference|fact`; no fourth tier.
- R2: Session notes live on `ReviewRecord.sessionNotes`; no separate session
  directory.
- R3: Pin context once per session; no `context/vN.md` file store.
- R4: Zero-model curator first; LLM dream deferred.
- R5: Global rules manual; global facts/preferences only with evidence and a
  conservative policy/undo.
- R6: Cross-process lock is P1; P0 mitigation is merge-by-id.
- Cost if R1 wrong: losing a separate user profile view; recoverable by adding
  `profileKey` later.
- Cost if R2 wrong: session notes are less searchable; can add an index later.
- Cost if R3 wrong: no forensic rendering history; `reviews`/`changelog` remain.
- Cost if R5 wrong: some genuine global facts need manual approval.

## Model policy correction (2026-11-04)

- Project policy: all chat-model calls use
  `ollama-cloud/deepseek-v4.1-flash:1017` with variant `high` (the user's
  `#high`).
- Unauthorized deviation: review and System Two defaults were set to
  `ollama-cloud/glm-5.3-flash:cloud` without the user's approval. Live evidence
  before correction: `reviewCalls=20`, `reviewTokens=35,893`,
  `reviewFailures=8`, and all 12 ready review records carried
  `glm-5.3-flash:cloud`. This was the assistant's decision, not a project
  requirement.
- Correction: defaults, config merge, server PATCH, review transport
  (`think: "high"`) and System Two transport (`variant: "high"`) now carry the
  DeepSeek model and variant. The console Settings exposes the variant.
- Scope exception: System One keeps `clef:27b-cloud` because
  `https://ollama.com/v1/systemone` is a typed classification endpoint and was
  never glm.
- Evidence: `test/model-config.test.ts` 3/3,
  `test/review-model.test.ts` 19/19 (includes `think: "high"` request body),
  `test/rewrite.test.ts` 10/10 (includes variant pass-through); direct
  `/api/show` returned `thinking.values=[false,low,high,max]` and a
  `/api/chat` smoke test with `think: "high"` returned `200` in 0.9s.
  Hot-reloaded live check: `/api/health` reports
  `deepseek-v4.1-flash:1017` + `variant: high`; the shipped
  `ReviewProvider` ran end-to-end against the live config in 3.6s with
  401 input / 497 output tokens and parsed one project rule candidate.
- Rule: do not introduce or silently substitute a model. A model change is a
  project decision and must be recorded here before it ships.

## Progress

- [x] Task 1 — scope type + parse/provider defaults
  - Evidence: `test/scope.test.ts` 5/5; `test/review-model.test.ts` 18/18;
    plugin `tsc --noEmit` clean.
- [x] Task 2 — session bypass
  - Evidence: `test/session-notes.test.ts` 1/1; `test/review-orchestrator.test.ts`
    13/13; `ReviewRecord.sessionNotes` persisted; no hook/queue for session.
- [x] Task 3 — project isolation + context pin
  - Evidence: `test/context.test.ts` 4/4 (A/B filter, 20-call pin);
    `test/plugin.test.ts` 1/1; plugin `tsc --noEmit` clean.
  - Note: `buildContext` now reads active items, filters projectKey, and ignores
    queue; startup 50-session rewrite removed; context is pinned in
    `SessionState.contextBlock`.
- [x] Task 4 — promotion gate
  - Evidence: `test/promotion.test.ts` 6/6; `test/actions.test.ts` 6/6;
    `test/session-notes.test.ts` 3/3; `test/review-api.test.ts` 6/6; typecheck.
- [x] Task 5 — migration
  - Evidence: `test/migration.test.ts` 2/2 (preview/apply/undo/idempotent/
    concurrent merge-by-id).
  - Live: applied 8 changes; queue now 4 session / 2 project / 5 global;
    journal `migrations/scope_mw1kzmwf_3ebbe497.json`;
    backup `queue.json.bak-scope_mw1kzmwf_3ebbe497`; second preview all `keep`.
- [x] Task 6 — UI
  - Evidence: console typecheck/build pass; browser snapshot shows tier column,
    tier filter, no "生成中"; session-notes panel/promote buttons compiled.
  - Deferred: full "two primary + overflow" refactor of legacy detail actions.

## Evidence

- Baseline tests: 149/149 (prior run); typecheck/build passed before this goal.
- No new evidence yet for this goal.

## Checkpoints

### Checkpoint 2 — P1 hardening complete

- Done: P1-1 session write-path guards, P1-2 cross-instance file lock,
  P1-3 zero-model curator, P1-4 AUTO audit view.
- Evidence: `npm test` 37 files / 184 tests; `npm run typecheck`;
  `npm run build`; `npm run build:extension`; `git diff --check`; live queue
  `total=12, pending=0, scopes={session:5, project:2, global:5}`; live
  `lastCuratedAt=2026-11-04T07:03:42.442Z`; AUTO_MEMORY banner contains
  `AUDIT VIEW ONLY`.
- Key tests: `lock.test.ts` 3/3 (two Store patches, stale lock, state),
  `curator.test.ts` 4/4 (expire/dedupe/scope isolation/gate/undo),
  `rebuild.test.ts` 2/2 (audit banner/known titles), `actions` 7/7,
  `consolidate` 13/13.
- Deferred: full legacy detail-action overflow refactor, `review.auto` split,
  `purge`, historical subagent startup backfill, `excludeProjects`,
  `maxPerDay/queueSoftCap`, git-remote projectKey, LLM dream/skill backtest.
- Design ruling: session rows stay queue-visible as promotion candidates; auto,
  approve and apply_suggestion are blocked at the write boundary. The live
  queue has 5 session rows; they are not injected and must be promoted/denied.
- Not committed; no `opencode.json` change.

### Checkpoint 1 — implementation complete

- Done: Task 1–6, migration applied, UI built.
- Evidence: `npm test` 34 files / 173 tests; `npm run typecheck`;
  `npm run build`; `npm run build:extension`; `git diff --check`; live queue
  `total=11, pending=0, scopes={session:4, project:2, global:5}`; migration
  journal/backup present; second preview all `keep`; browser shows tier
  column/filter and no "生成中".
- Next: final report only.
- Open decisions: full legacy action overflow refactor; cross-process lock;
  turn-lane session queue items remain queue-visible but are excluded from
  context.
- Cache-UX status: `AUTOPILOT` prefix still built only from active global +
  current project, pinned once per session; queue/session notes excluded.
- Not committed; no live `opencode.json` changes.

### Checkpoint 0 — setup

- Goal/Spec/Plan materialized because `docs/goals/openmem-memory-v2/` was
  missing from the repo; content is based on the user's goal message and the
  round-1/round-2 reviews.
- Next: Task 1 RED tests.
