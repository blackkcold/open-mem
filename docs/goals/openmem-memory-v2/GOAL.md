# OpenMem Memory v2 — GOAL

Version: 1.0 (materialized from the user's 2026-11-04 goal message; user-owned)
Status: active

## Objective

Move OpenMem from a `global | project` binary scope to a three-tier memory model
with an explicit promotion gate and a session bypass:

- **session**: session-only constraints/notes; never injected into the global
  AUTOPILOT prefix; retained for resume/recall; expires.
- **project**: project-scoped memory; only injected in that project.
- **global**: cross-project/user memory; earned through evidence and approval,
  never the default.

The change must preserve prompt-cache stability, calm UX, and long-term
operational stability.

## Required outcomes

1. New captures default to `session`; only project evidence or explicit global
   evidence can raise the tier.
2. Session-only content cannot leak into global/project memory or the injected
   prefix.
3. Project A memory is not injected into project B.
4. A promotion gate exists for session -> project/global and project -> global.
5. The AUTOPILOT prefix is byte-stable across a 20-turn session; queue counts,
   known titles, review status, and session notes never enter it.
6. The existing 11 queue items have a dry-run migration plus a safe, undoable
   apply.
7. Existing APIs/tests remain compatible.

## Non-goals (for this goal)

- Full LLM dream/curator, skill backtest marketplace, embeddings, provider
  ecosystem, multi-profile, cross-machine sync.
- Rewriting the entire storage model or adding a database.
- Committing git.

## Hard constraints

- Cache: 20-turn prefix byte stability test must pass.
- UX: calm UI; two primary buttons + overflow; no batch global; 0 durable is a
  success state.
- Safety: no git commit; do not modify `~/.config/opencode/opencode.json`; do not
  delete user data; migration/cleanup needs backup/journal/undo; destructive
  operations stop and ask.
- Code: no `as any`, no `ts-ignore`, no broad refactor, no new dependencies
  unless necessary, do not break existing API/tests.
- Evidence: no completion claim without tests/build/live evidence.

## Definition of Done

- `npm test`, `npm run typecheck`, `npm run build`, `npm run build:extension`
  pass.
- New tests cover: scope fixture, session leakage = 0, project A/B isolation,
  20-turn prefix stability, promotion gate, migration idempotence, concurrent
  merge-by-id.
- Live `/api/queue` has `suggestionState=pending` count 0; session notes do not
  appear in context; project A does not appear in project B.
- Existing 11 items have a dry-run migration and a safe apply with undo.
- Final report includes changes, evidence, deferred items, and risks; no git
  commit.
