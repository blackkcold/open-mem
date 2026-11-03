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

A Memory/Rule candidate is auto-written only when all hold:

- linter passes;
- `duplicate < 0.20`;
- `conflict ≤ 0.50`;
- `mergeAction` is absent or `create`;
- facts/references: `risk < 0.40`; rules: `risk < 0.50`;
- `strictness` is `preference` / `workflow` / `format` (plus `unknown` for facts/references);
- `safeAuto ≥ 0.88` for project, `≥ 0.92` for global;
- the target lane is enabled and under its cap;
- shadow mode is off.

Everything else goes to the queue with a reason and a diff. Removal, contradiction, strict limits, permissions, safety, duplicate/conflict, low confidence, linter failures, and capacity never auto-apply.

The goal is automation for the common case: additive facts, preferences, and low-risk workflow notes. Only high-risk, conflicting, duplicate, low-confidence, rule-merge, and skill cases need a human.

## System One

- One request asks 8 typed questions; one response drives classification, risk, duplicate, safety, conflict, and merge target.
- `confidence` is distribution concentration, not correctness. It is used for ordering and batch thresholds only, never as the sole safety gate.
- 401 / 402 / 404 / 400 / 413 are surfaced as clear errors; 5xx and timeout retry once, then fall back to the heuristic.
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

`merge_into` updates the target, increments `seenCount`, adds the source, and archives the candidate. `replace` archives the old version. Every apply writes a `merge-journal` entry and can be undone within 24 hours.

## Capacity

Hard caps: total items 500; auto memory 100/scope; auto rules 50/scope; queue 50; shadow 500; skill drafts 5; suggestions 500; injection 800 tokens; data directory 20 MB.

- 70% warn; 85% compact first; 95% freeze auto-write; 100% reject.
- No silent truncation: every rejection is written to the changelog and Audit.
- Compaction only merges exact duplicates and rebuilds views; it does not auto-delete stale rules or promoted items.
- Health combines capacity, duplicates, conflicts, shadow false positives, queue age, decision/rewrite fallback, suggestion acceptance, and undo count.

## Skill

- Skills are agent-judged, drafted with `skill-creator` rules, validated, tested on a real task, and approved by the user.
- Name: lowercase letters/digits/hyphens, under 64 chars; description states when to use it.
- Body: imperative, core workflow only, under 500 lines; details go to `references/`.
- No README/INSTALL/CHANGELOG inside a skill.
- Approval writes to `outbox/skills/<name>/SKILL.md`, never the live skills directory.
