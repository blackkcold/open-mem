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

- 12s timeout, one retry on 5xx/timeout, heuristic fallback;
- 30 calls/hour, 3-failure / 10-minute circuit breaker;
- 24h result cache keyed by model + candidate + neighbor ids + scope;
- `decision-usage.jsonl` with tokens, latency, status, fallback reason.

### System Two — rewrite

`SystemTwoClient` turns a candidate + target into one compliant merged memory. Two transports:

- `opencode`: `ctx.generate.text({ model, prompt })` (no session, no tools, no history);
- `ollama`: `POST https://ollama.com/api/chat` with `format: "json"`, `stream: false`, `temperature: 0.2`.

Default model: `ollama-cloud/glm-5.3-flash:cloud`. System Two is called **only** for `merge_into` / `replace`; `create` and `keep_both` do not need rewriting.

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

## Flow

```
session.idle
  → single-writer queue (1.5s debounce)
  → user candidates
  → normalize + SimHash64
  → exact/near duplicate? seenCount++, 0 model calls
  → reservation (session|message|text, 10 min)
  → System One (8 questions)
  → route: auto / shadow / queue / skill
  → queue + merge/replace → System Two → Validator → Suggestion
  → approval: approve / edit / reject / regenerate
  → atomic apply + merge-journal + 24h undo + rebuild views
```

## Parallel dedup

- **Single writer**: all sessions share one consolidation chain; one model call per candidate.
- **Fingerprint**: SimHash64 over normalized text; Hamming ≤ 3 or Jaccard ≥ 0.92 is a duplicate.
- **Reservation**: prevents two sessions from classifying the same message simultaneously.
- **seenCount**: duplicate hits increment the canonical item instead of creating a new one.
- **Scope isolation**: `global` and `project` never merge.
- **Three states**:
  - identical → drop / `seenCount++`;
  - complementary → canonical + `aliases`; rules need human approval;
  - opposite polarity → keep both + conflict finding.
- **Generated views**: `AUTO_MEMORY.md` / `AUTO_RULES.md` are rebuilt from `items.jsonl`; they are not append-only sources of truth.

## Suggestions and approval

`Suggestion` stores action, target, prefilled title/text, preserved/dropped details, rationale, System One concentration, System Two model, and validation. The console:

- auto-generates a suggestion when an item without one is selected;
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

## Capacity and health

Hard caps are enforced by `capacity.ts`, not only shown in the UI:

- auto memory: global 100 / project 100;
- auto rules: global 50 / project 50;
- queue 50, shadow 500, skill drafts 5, total items 500;
- injected context 800 tokens;
- data directory 20 MB;
- suggestions 500 / 5 MB, decision and rewrite caches 500 each, journal and usage logs 30 days.

Ladder: **70%** warn, **85%** compact first, **95%** freeze auto-write, **100%** reject. Every rejection is written to `changelog.jsonl` and Audit; nothing is silently dropped.

Compaction: prune reservations/caches/expired logs → cluster and merge exact duplicates → rebuild views → verify (linter, duplicate rate not worse, count not larger) → rollback `.bak` if worse. Rules and promoted items are not auto-archived.

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
├── decision-cache.json
├── rewrite-cache.json
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

All `/api` endpoints require `Authorization: Bearer <token>` or `?token=`.

- `GET /api/health` — data dir, shadow, decision/rewrite status, key source
- `GET /api/queue` · `POST /api/queue/:id/suggest` · `POST /api/queue/:id/decision` · `POST /api/queue/batch`
- `GET /api/items` · `GET /api/map`
- `GET /api/skills` · `GET /api/skills/:id` · `POST /api/skills/:id/decision`
- `GET /api/audit` · `POST /api/audit/run`
- `GET /api/metrics` · `GET /api/health-score` · `POST /api/compact`
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
    "cacheTtlHours": 24
  },
  "rewrite": {
    "enabled": true,
    "transport": "ollama",
    "endpoint": "https://ollama.com",
    "model": { "providerID": "ollama-cloud", "id": "glm-5.3-flash:cloud" },
    "timeoutMs": 25000,
    "maxCallsPerHour": 20,
    "repairAttempts": 1,
    "eager": true,
    "cacheTtlHours": 72
  }
}
```

The key is read from the env var named by `apiKeyEnv`; if absent, the plugin reads `~/.local/share/opencode/auth.json` (`ollama-cloud.key`) once at startup. It is never written to config or logs. The console token is stored in `console-token` with mode 0600.

## Safety boundary

- The isolated test uses its own `XDG_*` directories, data dir, ports, and project directory.
- The plugin is loaded from a local path into a temporary OpenCode server; live `opencode.json`, live plugins, and OpenChamber settings are not modified.
- Skill approval writes to `outbox/skills/`, never the live skills directory.
- No live install is performed by this repository.
