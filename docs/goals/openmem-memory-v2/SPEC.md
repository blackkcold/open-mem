# OpenMem Memory v2 — SPEC

Version: 1.0
Status: active
GOAL: `GOAL.md`

## Decision summary

Adopt **Session-first, Project-scoped, Global-earned**:

- Extend `Scope` from `global | project` to `session | project | global`.
- Keep the existing `Item` / `QueueItem` / `ReviewRecord` stores; do not add a
  parallel belief store.
- Session-only review candidates are stored in `ReviewRecord.sessionNotes` and
  never become hooks or queue items.
- Project identity is a stable `projectKey`; `buildContext` filters project
  items by it. The current `AUTO_*` full view remains for audit, but is not the
  injection source.
- Pin the rendered context once per session; do not rebuild/re-put it on every
  turn. New memory reaches new sessions unless the user explicitly applies it.
- Promotion is explicit: session -> project/global, project -> global. Global
  rules require user confirmation; global facts/preferences may auto only with
  evidence and a 24h undo policy (configurable; default conservative).
- Curator is deterministic (expire/dedupe/supersede/rebuild), scheduled at
  startup/console with a 24h gate. LLM dream/backtest is deferred.
- `lesson` and `decision` remain distinct review types; do not flatten them to
  `fact`. A separate skill lane is deferred.
- Model policy: every chat-model call in this project uses
  `ollama-cloud/deepseek-v4.1-flash:1017` with variant `high`. This covers
  session review and System Two rewrite. System One remains on
  `clef:27b-cloud` because `/v1/systemone` is a typed classification endpoint,
  not a chat model. `glm-5.3-flash:cloud` is not an approved model.

## Data model

- `Scope = "session" | "project" | "global"`.
- `Item` / `QueueItem` add optional `projectKey`, `expiresAt`,
  `distinctSessions`, `promotion`, `supersedes`, `supersededBy`.
- `ReviewRecord` adds `sessionNotes?: SessionNote[]`.
- `SessionNote = { kind, text, evidence, createdAt, expiresAt? }`.
- Existing `ItemStatus` is reused: `queue` ≈ suggested, `auto|promoted` ≈
  active, `archived` + `supersededBy` ≈ superseded, `false_positive` ≈ rejected.
- `projectKey`: canonical project path hash for this phase; git-remote identity
  is a later refinement.

## Tier rules

| Signal | Tier |
|---|---|
| task-only / "本次/现在/先/暂时" / imperative task instruction | session |
| project path/repo/port/command/"在这个项目中" | project |
| explicit "always/never/所有项目/以后" without project qualifier | global candidate |
| no signal | session |
| stable environment fact | global (TTL) |
| user identity/preference | global (profile view; no separate tier) |
| failure -> fix -> boundary | project (lesson) |
| repeated successful procedure | skill lane (deferred) |

- `constraint` / `note` never leave session.
- `rule` at project/global requires manual approval.
- `task_only=true` can never become a queue item.

## Promotion gate

Minimum gate:

1. Evidence: `distinctSessions >= 2` or an explicit user quote.
2. Type: constraint/note cannot leave session; rule needs manual approval.
3. Scope: global rejects volatile identifiers (absolute paths, ports, versions,
   hostnames, session ids) unless the item is a reference/user fact with TTL.
4. Conflict: same fingerprint at the target tier -> dedupe/merge; contradictory
   active item -> keep_both/conflict finding, never silent overwrite.
5. Approval: global rules always manual; project/global facts/preferences may
   auto only when the configured policy allows and a 24h undo exists.

## Cache contract

- The injected block contains only approved global + current-project memory and
  the shadow flag.
- Session notes, queue counts, known titles, review status, timestamps, project
  paths, and curator output never enter the prefix.
- `buildContext(store, config, projectKey)` is called once per session, then the
  rendered text is pinned in `SessionState`/`contextCache`.
- `refreshContext` must not run on every turn; startup must not rewrite old
  sessions.
- The 20-turn prefix stability test mutates queue/state and asserts byte
  equality.

## Migration

- Current live `items.jsonl` is empty; migration touches queue only.
- Merge duplicate pairs first, then propose tier per item.
- Defaults: task constraints -> session/archive; project evidence -> project;
  genuine cross-project preference/fact -> global candidate.
- Dry-run writes a proposal + backup; apply writes a journal and is undoable.
- Apply must not auto-approve project/global candidates; it only sets scope /
  moves session-only items out of the durable queue.

## Safety / operations

- No new dependency; no git commit; no live config edits.
- File writes use existing atomic rename; migration creates `.bak` + journal.
- Cross-process lock is a P1 hardening item; merge-by-id is the P0 mitigation.
- Every new behavior gets a failing test first.
