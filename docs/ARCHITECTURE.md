# Architecture

OpenMem is an OpenCode server plugin plus a local web console. It is built and tested in this repository; it is **not installed** into OpenChamber, the bundled OpenCode, or any standalone OpenCode.

## Two systems

### System One — decisions

`SystemOneClient` posts to `https://ollama.com/v1/systemone` with `model: clef:27b-cloud` and a bearer `OLLAMA_API_KEY`. One request asks eight typed questions:

| Question | Type | Purpose |
|---|---|---|
| `kind` | choice | fact / preference / rule / reference / skill / ignore |
| `safety` | noul | safety, credentials, privacy, destructive impact |
| `strict_limit` | noul | hard limit, quota, timeout, permission, scope |
| `duplicate` | noul | already covered by a neighbor |
| `safe_auto` | noul | safe to write without review |
| `conflict` | noul | contradicts a neighbor |
| `merge_action` | choice | create / merge_into / replace / keep_both / reject_duplicate |
| `merge_target` | choice | none / n1 / n2 / n3 (only when neighbors exist) |

The response is `{ answers, usage }`. `noul` is a probability; `choice` has `choice`, `probabilities`, and `confidence`. **`confidence` is distribution concentration, not calibrated correctness**; the UI labels it “集中度”.

The service adds:

- 12s timeout and heuristic fallback on transport failure (no automatic System One retry);
- 30 calls/hour, 3-failure / 10-minute circuit breaker;
- 24h result cache keyed by model + candidate + neighbor content + scope;
- `decision-usage.jsonl` with tokens, latency, status, fallback reason.

### System Two — rewrite

`SystemTwoClient` turns a candidate + target into one compliant merged memory. Two transports:

- `opencode`: `ctx.generate.text({ model, prompt })` (no session, no tools, no history);
- `ollama`: `POST https://ollama.com/api/chat` with `format: "json"`, `stream: false`, `temperature: 0.2`.

Default model: `ollama-cloud/deepseek-v4.1-flash:1017` with variant `high`. System Two is called **only** for `merge_into` / `replace`; `create` and `keep_both` do not need rewriting.

### Model policy

- Review and System Two are chat-model calls. Both use
  `ollama-cloud/deepseek-v4.1-flash:1017` with variant `high`
  (`think: "high"` on the native Ollama transport, `variant` on
  `ctx.generate.text`).
- System One stays on `clef:27b-cloud` because
  `https://ollama.com/v1/systemone` is a typed classification endpoint, not a
  chat model. It never used glm.
- `glm-5.3-flash:cloud` must not be referenced by any default, live config, or
  documentation example. An earlier revision silently defaulted review/rewrite
  to glm; that was an unauthorized deviation from the project model policy and
  is recorded in `docs/goals/openmem-memory-v2/LEDGER.md`.
- Thinking shares the output budget. With `variant: high`, keep
  `review.maxOutputTokens >= 1500`; a 600-token cap can end at
  `done_reason=length` with empty content, which the provider treats as a
  failed review.

The JSON contract:

```json
{
  "action": "merge | replace | keep_both",
  "title": "...",
  "text": "...",
  "preserved": ["..."],
  "dropped": [{ "text": "...", "reason": "..." }],
  "rationale": "..."
}
```

`validateRewrite` gates the output:

1. JSON shape and field whitelist.
2. Existing linter: atomic, length, no examples/transient/secrets/session ids.
3. Numeric/identifier guard: no number, port, path, URL, or id absent from the inputs.
4. Preservation: every input identifier must appear in the output or in `dropped` with a reason.
5. Rule/conflict guard: rules never merge; conflicts must return `keep_both`.

On failure: one repair call with the error list; then the deterministic **Composer** (common prefix/suffix, unique clauses, length budget, linter). The suggestion still exists and is editable.

## Session review

In OpenCode V2 the `session.idle` event is ephemeral and is not delivered to
`ctx.event.subscribe`. The plugin therefore treats the durable
`session.execution.succeeded` / `.failed` / `.interrupted` events as turn
completion, and reads the session id from `event.data.sessionID` (V2 payload
shape). `session.idle` is still handled for older hosts.

The orchestrator synthesizes a session-level idle signal: each turn re-arms a
timer (`review.idleMs`, default 3 min), and a long session also checks in after
`checkpointMessages` new messages (user or tool).

Input is assembled by three pure layers:

1. `SessionReader` caches normalized messages and only parses new ones (O(ΔN) instead of O(N) per turn). It keeps `time` so idle detection and evidence ordering work.
2. `ToolDigester` turns each tool call into a deterministic, redacted one-liner (command + exit + error line for bash; path + line count for read; never file contents), cached by content hash.
3. `ReviewInputBuilder` slices the window, redacts, enforces the character budget and hashes the result. An unchanged hash skips the model call entirely. The prompt appends a compact, redacted list of known queue/memory titles **after** the transcript; it is a hint, not part of the input hash, so queue churn never invalidates a review. The reply is capped by `review.maxOutputTokens` (`num_predict`). A skipped window stores its tail/hash and is not re-read until new material arrives.

Every candidate must cite a literal quote from that exact input. `validate.ts` enforces
type-specific evidence (facts need a user quote, learnings a failing tool quote, skills
two steps plus a successful tool quote), lints the text, dedupes, and caps the batch.
Accepted candidates become `HookRecord`s with `origin: "session-review"` and flow through
the normal decision/dedupe pipeline; `canAutoApply` refuses that origin, so they can only
land in the queue. No L0 file is ever written and no skill is installed.

The injected `AUTOPILOT` block is deliberately stable: it carries only AUTO memory/rules
plus the shadow flag, never queue counts or audit summaries. That keeps the prefix of a
prompt-cache-warmed session intact when reviews add queue items. Subagent sessions
(`parentID`) and synthetic keep-alive messages are excluded from capture and review.

## Flow

```
session.idle
  → per-session debounce (1.5s) → single-writer queue
  → user candidates (SessionReader cache, O(new messages))
  → normalize + SimHash64
  → exact/near duplicate? seenCount++, 0 model calls
  → reservation (session|message|text, 10 min)
  → System One (8 questions)
  → route: auto / shadow / queue / skill
  → queue + merge/replace → System Two → Validator → Suggestion
  → approval: approve / edit / reject / regenerate
  → guarded apply + merge-journal + conflict-checked 24h undo + rebuild views

session idle 3 min (session review)
  → incremental slice (user text + deterministic tool digests)
  → redact + 12k budget + input hash (skip when unchanged)
  → review model → candidates with literal evidence quotes
  → deterministic evidence validation → HookRecord(origin=session-review)
  → same decision/dedupe pipeline → queue only (never auto)
```

## Parallel dedup

- **Serialized writes**: individual Store mutations use a cross-instance file lock;
  startup and counters use the same guard. Consolidation is serialized in-process,
  with persisted reservations to reduce cross-instance duplicate work. Multi-file
  decisions are not a full database transaction.
- **Fingerprint**: SimHash64 over normalized text; Hamming ≤ 3 or Jaccard ≥ 0.92 is a duplicate.
- **Reservation**: prevents two sessions from classifying the same message simultaneously.
- **seenCount**: duplicate hits increment the canonical item instead of creating a new one.
- **Scope isolation**: `global` and `project` never merge; project operations also
  require matching `projectKey`. Unknown project identity is not auto-merged.
- **Three states**:
  - identical → drop / `seenCount++`;
  - complementary → canonical + `aliases`; rules need human approval;
  - opposite polarity → keep both + conflict finding.
- **Audit views**: `AUTO_MEMORY.md` / `AUTO_RULES.md` are rebuilt from active items across all scopes for human audit. `buildContext` injects only `global` + the current `projectKey` from `items.jsonl`; review known titles come from items/queue, never from the AUTO files.

## Suggestions and approval

`Suggestion` stores action, target, prefilled title/text, preserved/dropped details, rationale, System One concentration, System Two model, and validation. The console:

- uses eager generation when configured; otherwise the user clicks “生成建议”;
- shows a “AI 合并建议” card with prefilled text and live character/linter status;
- offers **批准建议 / 改后批准 / 重新生成 / 拒绝 / Defer**;
- batch-applies only ready suggestions with concentration ≥ 0.9, non-rule, max 10, with a dry-run preview;
- writes `merge-journal.jsonl` and exposes 24h undo on the Health page.

Apply semantics:

| Action | Result |
|---|---|
| `merge_into` | update target, `seenCount++`, add source, archive candidate |
| `replace` | update target, archive old version |
| `keep_both` | create a new item, keep target |
| `reject_duplicate` | archive candidate, `seenCount++` target |
| `create` | create a new item |

Rules cannot merge; conflicts can only `keep_both`.

Suggestions store a material target version. Changed/archived targets require
regeneration rather than overwriting newer text. Merge undo checks full post-apply
snapshots under the file lock and restores original metadata; legacy journals
without snapshots are refused rather than guessed. Undo/recovery records mark
in-progress writes so an interrupted restore can be retried. Store stages logical
writes in an AsyncLocalStorage transaction under the cross-process file lock.
Multi-file commits persist a redo WAL before fsync/rename replacements; startup
and subsequent mutations replay any pending commit. Single-file replacement uses
the fsync/rename fast path. Approval, apply, undo/restore and promotion share this
boundary. Read-only requests do not get an MVCC snapshot during physical replay.

## Capacity and health

Hard caps are enforced by `capacity.ts`, not only shown in the UI:

- auto memory: 100 across the shared data directory;
- auto rules: 50 across the shared data directory;
- queue 50, shadow 500, skill drafts 5, total items 500;
- injected context: up to 10 memories + 8 rules, global slots reserved when project items dominate (no exact token cap);
- data directory 20 MB;
- decision/rewrite caches are bounded by their providers; usage logs keep up to
  2000 records from 30 days when maintenance runs. Recovery/maintenance/curator/merge
  histories and archived items retain at least 90 days and the latest 20 per class.
  References protect dependent journals and snapshots; unknown/corrupt/in-progress
  records are conservatively kept. Cleanup requires a read-only preview and exact
  confirmed fingerprint; stale previews and symlink paths are rejected.

Sessions inactive for over 90 days can be cold-archived through the same preview.
`readSession`/`updateSession` restore their original cursor, parent metadata and
pinned context on resume. Cold state is canonical, not a disposable history backup;
it is not deleted by the 90-day history policy. Neither this policy nor the 20 MB
admission guard promises a hard disk quota; protected data may exceed that budget.

Ladder: **70%** warn, **85%** request compaction, **95%** freeze auto-write,
**100%** restrict admission. Each lane checks its own capacity: a full queue does
not prevent approvals from draining it. Capacity-blocked hooks remain retryable
and reuse a stored classification. Shadow history is bounded independently.

Compaction has a read-only preview and explicit console confirmation. It computes
near-duplicate changes per scope/project/kind, saves a full backup + changed-item
journal, compares against the current snapshot before writing, then rebuilds
views. Concurrent additions survive; conflicting edits abort. Rules, manual and
promoted items are protected. There is no post-compaction quality validator or
automatic rollback claim. The user can undo unchanged results from history.

Health score combines capacity, duplicates, conflicts, shadow false positives, queue p95, decision fallback, rewrite fallback, suggestion acceptance, and undo count.

## Data layout

```
<dataDir>/
├── items.jsonl              source of truth
├── queue.json
├── shadow.jsonl
├── config.json
├── state.json
├── stats.json
├── changelog.jsonl
├── merge-journal.jsonl
├── maintenance/<id>.json    before/after snapshots and undo progress
├── maintenance/<id>.items.bak
├── recovery/<id>.json       approval/denial/promotion recovery snapshots
├── curator/<id>.json        curator → maintenance journal reference
├── session-archive/<hash>.json complete cold session cursor/context
├── .pending-transaction.json durable redo WAL while a commit is pending
├── decision-cache.json
├── rewrite-cache.json
├── reviews.jsonl            session review history
├── digest-cache.json        content-addressed tool digests
├── review-cache.json        review model cache
├── decision-usage.jsonl
├── rewrite-usage.jsonl
├── reservations.json
├── console-token            mode 0600
├── AUTO_MEMORY.md           generated view
├── AUTO_RULES.md            generated view
├── skill-drafts/<id>/SKILL.md
└── outbox/skills/<name>/SKILL.md
```

## API

All ordinary `/api` endpoints require `Authorization: Bearer <token>`.
Only `GET /api/events` accepts a query token for EventSource. `POST /api/connect`
exchanges a cryptographically random, 60-second single-use ticket for a token;
it does not accept arbitrary unauthenticated login. Local tokens authorize the
caller, not a proven human identity. Agent tools cannot approve/apply/promote.

- `GET /api/health` — data dir, shadow, decision/rewrite/review status, key source
- `GET /api/queue` — filters `kind`, `scope`, `origin`, `q`, `projectKey`;
  returns stable project choices, with `__unassigned__` for missing ownership
- `GET /api/reviews` · `GET /api/reviews/:id` — review history and its hooks
- `POST /api/reviews/:id/notes/:index/promote` · `POST /api/reviews/:id/notes/:index/dismiss`
- `POST /api/queue/:id/draft` — convert a workflow candidate to an uninstalled skill draft
- `GET /api/items` · `GET /api/map`
- `GET /api/skills` · `GET /api/skills/:id` · `POST /api/skills/:id/decision`
- `GET /api/audit` · `POST /api/audit/run`
- `GET /api/metrics` · `GET /api/health-score` · `POST /api/compact`
- `GET /api/compact/preview` — read-only; compact POST requires `confirmedByUser: true`
- `GET /api/retention/preview` · `POST /api/retention/apply` — exact preview fingerprint
  and `confirmedByUser: true`; data or deletion-selection changes return 409
- `GET /api/changelog` · `POST /api/recovery/:id/restore` · `POST /api/maintenance/:id/undo`
- `GET /api/usage` · `GET /api/journal` · `POST /api/merge/:id/undo`
- `GET /api/config` · `PATCH /api/config`
- `POST /api/shadow/:id/false-positive`
- `GET /api/events` (SSE)

## Configuration

```json
{
  "shadow": false,
  "decision": {
    "kind": "systemone",
    "endpoint": "https://ollama.com/v1/systemone",
    "model": "clef:27b-cloud",
    "apiKeyEnv": "OLLAMA_API_KEY",
    "timeoutMs": 12000,
    "maxCallsPerHour": 30,
    "cacheTtlHours": 24,
    "queueMin": 0.72,
    "queueMinRule": 0.8
  },
  "rewrite": {
    "enabled": true,
    "transport": "opencode",
    "endpoint": "https://ollama.com",
    "model": {
      "providerID": "ollama-cloud",
      "id": "deepseek-v4.1-flash:1017",
      "variant": "high"
    },
    "timeoutMs": 25000,
    "maxCallsPerHour": 20,
    "repairAttempts": 1,
    "eager": true,
    "cacheTtlHours": 72
  },
  "review": {
    "enabled": true,
    "idleMs": 180000,
    "minNewUserMessages": 1,
    "checkpointMessages": 20,
    "maxInputChars": 12000,
    "maxUserCharsPerMessage": 800,
    "maxCandidates": 8,
    "minConfidence": 0.72,
    "maxPerHour": 8,
    "maxOutputTokens": 1500,
    "transcript": "user+tools",
    "redact": true,
    "timeoutMs": 30000,
    "repairAttempts": 1,
    "cacheTtlHours": 72,
    "model": {
      "providerID": "ollama-cloud",
      "id": "deepseek-v4.1-flash:1017",
      "variant": "high"
    },
    "maxDeferrals": 3
  },
  "digest": { "maxEntries": 2000, "maxBytes": 2097152, "maxChars": 160 }
}
```

The key is read from the env var named by `apiKeyEnv`; if absent, the plugin reads `~/.local/share/opencode/auth.json` (`ollama-cloud.key`) once at startup. It is never written to config or logs. The console token is stored in `console-token` with mode 0600.

Direct model endpoints permit only HTTPS `ollama.com` or loopback Ollama. Cloud
credentials are omitted for loopback and HTTP redirects are refused. Detected
credentials are blocked before turn capture/classification; model inputs receive
defensive redaction. Shared request budgets count actual attempts, including
review retries and rewrite repairs. Shadow does not disable enabled model calls.

## Safety boundary

- The isolated test uses its own `XDG_*` directories, data dir, ports, and project directory.
- The plugin is loaded from a local path into a temporary OpenCode server; live `opencode.json`, live plugins, and OpenChamber settings are not modified.
- Skill approval writes to `outbox/skills/`, never the live skills directory.
- No live install is performed by this repository.
