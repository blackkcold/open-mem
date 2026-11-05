# Quality Policy

## Memory / Rule

Write only what is durable, reusable, and safe to inject into every relevant session.

- **Atomic**: one claim per entry; at most two short clauses after a merge.
- **Generic**: no session narrative, no “today/just now”, no task-specific detail.
- **Concise**: memory ≤ 200 characters; rule ≤ 160; title ≤ 30.
- **No examples**: “例如 / 比如 / e.g.” must move to a skill or reference.
- **No transient state**: no current branch, current task, temporary path, or “for now”.
- **No secrets**: API keys, tokens, passwords, private keys, and customer data are rejected.
- **Rules are imperative**: make the action and scope explicit.
- **No duplicates/conflicts**: fingerprint and semantic checks run before any model call.

## Auto-apply gate

A fact/preference/reference candidate from turn capture is auto-written only when all hold.
Rules, skills, session-only notes, and review-origin candidates never auto-apply:

- linter passes;
- `duplicate < 0.20`;
- `conflict ≤ 0.50`;
- `mergeAction` is absent or `create`;
- `risk < 0.40`;
- `strictness` is `preference` / `workflow` / `format` / `unknown`;
- `safeAuto ≥ 0.88` for project, `≥ 0.92` for global;
- the target lane is enabled and under its cap;
- shadow mode is off.

Everything else goes to the queue with a reason and a diff. Removal, contradiction, strict limits, permissions, safety, duplicate/conflict, low confidence, linter failures, and capacity never auto-apply.

The goal is automation for additive facts and preferences. Every rule and every
review candidate requires a user-facing decision. The local token authorizes a
caller; it does not prove a physical human click. Agent tools cannot approve,
apply suggestions, or promote durable memory.

## System One

- One request asks 8 typed questions; one response drives classification, risk, duplicate, safety, conflict, and merge target.
- `confidence` is distribution concentration, not correctness. It is used for ordering and batch thresholds only, never as the sole safety gate.
- 401 / 402 / 404 / 400 / 413 are mapped to clear errors; transport failures fall back to the heuristic. System One does not retry automatically.
- Every call is cached and logged; the console shows calls, tokens, and fallback rate.

## System Two

- Only `merge_into` / `replace` are rewritten; new entries do not need a model.
- Output must be one atomic, concise, example-free, secret-free entry; title and text respect the limits.
- **Numeric/identifier guard**: no new number, port, path, URL, or id may appear.
- **Preservation**: every input identifier must appear in the output or in `dropped` with a reason.
- **Rules never merge**; conflicts must return `keep_both`.
- One repair attempt; then the deterministic Composer. The suggestion remains editable and approvable.

## Merge policy

| Situation | Action |
|---|---|
| identical / near identical | drop or `seenCount++`; no new entry |
| complementary | canonical + `aliases`; rules need approval |
| opposite polarity | keep both + conflict finding |
| different scope (`global` / `project`) | never merge |
| queue vs item | item is the merge target; queue duplicates are rejected or kept |

`merge_into` updates the target, increments `seenCount`, adds the source, and removes
the queued candidate. `replace` archives the old version. Every apply writes a
`merge-journal` entry. Undo is available within 24 hours only while the affected
items match their recorded after-snapshots; later edits cause a recoverable
conflict instead of being overwritten. Old journals lacking snapshots require
manual inspection.

## Capacity

Admission limits: active items 500; auto memory 100 and auto rules 50 across the
shared data directory (not per project); queue 50; shadow history 500; skill drafts
5; data directory 20 MB. Context selects at most 10 memories + 8 rules, reserving
global slots in a busy project. There is no enforced 800-token injection limit.

- 70% warn; 85% compact first; 95% freeze auto-write; 100% reject.
- Capacity-blocked capture remains retryable and records a changelog reason.
  All captured sentences are persisted before advancing the scan cursor; the
  per-turn cap limits processing rather than silently dropping overflow.
- Compaction merges near-duplicates within one scope/project/kind, skips rules,
  manual/promoted items and unknown project identity, and rebuilds audit views.
- Shadow keeps bounded history, prioritizing false-positive samples; a full
  Shadow history does not block capture or queue approvals.
- Backup/recovery journals and archived items keep at least 90 days and the latest
  20 per class; recovery references and unknown/in-progress records are protected.
  Cleanup is previewed and confirmed, never silently run to force a disk quota.
- Inactive sessions can be cold-archived after 90 days; canonical cold state is
  preserved for later continuation, not deleted as an expired backup.
- The disk limit is an admission guard, not a hard filesystem quota. Protected
  records may still grow. Cross-file mutations have durable redo/replay and process
  crash tests, not proof against full disks, real power loss or hardware failure.
- Health combines capacity, duplicates, conflicts, shadow false positives, queue age, decision/rewrite fallback, suggestion acceptance, and undo count.

## Skill

- Skills are agent-judged, drafted with `skill-creator` rules, validated, tested on a real task, and approved by the user.
- Name: lowercase letters/digits/hyphens, under 64 chars; description states when to use it.
- Body: imperative, core workflow only, under 500 lines; details go to `references/`.
- No README/INSTALL/CHANGELOG inside a skill.
- Approval writes to `outbox/skills/<name>/SKILL.md`, never the live skills directory.
