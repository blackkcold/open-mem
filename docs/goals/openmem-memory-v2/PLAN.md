# OpenMem Memory v2 — PLAN

Version: 1.0
Status: active
SPEC: `SPEC.md`
GOAL: `GOAL.md`

## Current iteration

### Task 1 — Scope type + parse/provider defaults

- Add `session` to `Scope`; accept it in review parse/provider.
- Default unknown/missing scope to `session`, never `global`.
- Tests: parse session/project/global; missing -> session; prompt enum.

### Task 2 — Session bypass

- `ReviewRecord.sessionNotes`; `acceptReviewCandidates` returns session notes
  and does not create hooks/queue items for `scope=session`.
- Orchestrator persists `sessionNotes` on the review record.
- Tests: session candidate -> no hook/queue; record contains note; review
  origin still never auto-writes.

### Task 3 — Project isolation + context pin

- Add `projectKey` to items/queue; derive from canonical project path hash.
- `buildContext(store, config, projectKey)` filters global + current project.
- Pin rendered context per session; remove per-turn refresh and startup rewrite.
- Tests: project A/B isolation; 20-turn prefix byte stability.

### Task 4 — Promotion gate

- `canPromote` pure function + queue scope/promote action.
- Rules/global manual; volatile identifiers rejected for global.
- Tests: session->project/global gate, rule manual, volatile id rejection,
  conflict/dedupe.

### Task 5 — Migration

- `scripts/openmem-migrate-scopes.mjs`: dry-run proposal, backup, apply,
  undo; idempotent.
- Tests: fixture queue -> proposals; apply/undo; second apply no-op.

### Task 6 — UI

- Tier chip + "why"; session notes tab; two primary actions + overflow.
- No batch global; 0 durable success state.

## Deferred

- Cross-process file lock (P1, merge-by-id first).
- `review.auto`, `purge`, historical subagent backfill, `excludeProjects`,
  `maxPerDay`, `queueSoftCap`.
- LLM dream/curator, skill backtest, embeddings.

## Acceptance

See `GOAL.md` DoD. Every task updates `LEDGER.md` with evidence.
