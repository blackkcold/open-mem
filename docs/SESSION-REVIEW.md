# Session Review · Test Guide

Operational guide for the session-review lane. The short version: **the queue gate is
non-negotiable; every threshold around it is tunable.**

## Invariants (must never regress)

| Invariant | Where it is enforced | Test |
|---|---|---|
| Review candidates can only reach the queue | `canAutoApply` returns false for `origin: "session-review"`; both shadow branches exclude it; `reviewDecision` never calls System One | `review-integration.test.ts` |
| Rules never auto-write from review | `canAutoApply` origin guard + queue-only routing | `review-integration.test.ts` |
| Evidence must be a literal quote | `review/validate.ts` compares against the exact sent text | `review-model.test.ts`, `review-input.test.ts` |
| Assistant prose never enters the model | `review/input.ts` only emits user text + tool digests | `review-input.test.ts` |
| Raw tool output never leaves the process | `digest/tool.ts` clips and redacts before hashing | `review-input.test.ts`, `digest.test.ts` |
| No L0 write, no skill install | no write path; skills only become drafts | `review-integration.test.ts`, `skill.test.ts` |
| Review decisions use the confirmation-gated path | `actions.ts` refuses review-origin actions without `confirmedByUser`; the token-authenticated API sets it. A local token or this flag does **not** prove that a human confirmed the action | `review-integration.test.ts` |
| Synthetic / keep-alive messages are never captured | `session/filters.ts` excludes `type: "synthetic"`, warming metadata, and known keep-alive text; `consolidate` and `review/input` share it | `review-input.test.ts`, `consolidate.test.ts` |
| Subagent sessions are skipped | `parentID` is persisted from `session.created`; turn capture and review skip child sessions | `review-orchestrator.test.ts` |
| The injected system prefix is cache-stable | `renderContext` carries only AUTO memory/rules + shadow; live counts and audit move to `memory_autopilot status` | `context.test.ts` |

## Trigger (V2)

`session.idle` is ephemeral in OpenCode V2 and is **not** delivered to
`ctx.event.subscribe`. Turn completion arrives as the durable
`session.execution.succeeded` (or `.failed` / `.interrupted`) event; the plugin
reads `event.data.sessionID` and re-arms the review timer. `session.idle` is kept
for older hosts.

Keep-alive pings add no user-authored message; they do not extend an already
pending quiet window. Synthetic messages and subagent sessions are excluded from
capture and review.

## Automated matrix

Run everything:

```bash
npm run typecheck
npm test
npm run build
npm run build:extension
```

Review-specific files:

| File | Cases | Proves |
|---|---|---|
| `review-input.test.ts` | 7 | budget, newest-first slicing, tool digests, user-only mode, redaction, stable hash, synthetic exclusion |
| `review-model.test.ts` | 15 | parse, confidence clamp, evidence types, repair, retry, circuit, cache |
| `review-orchestrator.test.ts` | see file | idle window, re-arm, deferral, hash skip, failure, hourly cap, restart, ping no-op, subagent skip |
| `review-reliability.test.ts` | see file | bounded failures, attempt reset on new material, restart, slot accounting, pause, cross-source dedupe, manual recovery |
| `review-integration.test.ts` | 6 | queue-only gate, rules never auto, shadow exclusion, priority floor, agent approve refused, cross-lane dedupe |
| `review-api.test.ts` | 6 | reviews list/detail, origin filter, auth, usage, config patch (incl. 0) |

The gate tests are `review-integration.test.ts` — treat a failure there as a release blocker.

## Manual end-to-end (demo)

```bash
npm run demo          # prints http://127.0.0.1:47821/?token=...
```

1. **Queue** — a `Session Review` card appears; source segmented control filters
   `全部 / 本轮 / 会话复盘`; review rows show a `复盘` chip; the detail panel shows
   the evidence quote and message id.
2. **Settings → Session Review** — toggle `enabled`: the header badge switches to
   `未保存 · 将关闭`; `Save settings` writes it and the badge returns to `已关闭`.
   Clearing a numeric field must not persist 0 (values clamp to ≥1).
3. **Health** — the `Session Review` strip shows scheduled/running/runs last hour/last
   run/error. In the CLI demo it says `运行时不可用（CLI demo 无后台调度）`.
4. **Manual trigger** — only rendered when the plugin injected the orchestrator; the
   demo shows a disabled button with an explanation.
5. **Extension panel** — the compact strip shows `已复盘 / 入队 N / 提取 N` and
   review rows carry a `复盘` tag.

## API recipes

```bash
TOKEN=$(cat tmp/demo-data/console-token)
BASE=http://127.0.0.1:47821
AUTH="Authorization: Bearer $TOKEN"

curl -s -H "$AUTH" "$BASE/api/health" | jq '.review'
curl -s -H "$AUTH" "$BASE/api/reviews?limit=5" | jq '{canRun, summary, items: [.items[] | {status, candidates, queued, dropped, note}]}'
curl -s -H "$AUTH" "$BASE/api/usage" | jq '{reviewCalls, reviewTokens, reviewFailures}'
curl -s -X PATCH -H "$AUTH" -H 'content-type: application/json' \
  -d '{"review":{"enabled":false,"idleMs":180000,"maxPerHour":8}}' "$BASE/api/config" | jq '.review'
```

`POST /api/reviews/run` only works when the OpenCode plugin injected the orchestrator.
The CLI demo returns **501** and the console hides the button behind `canRun`:

Persisted state to inspect:

```bash
jq '.sessions, .reviewRuns' tmp/demo-data/state.json
tail -n 3 tmp/demo-data/reviews.jsonl | jq -c '{status, candidates, queued, dropped, note, usage}'
tail -n 3 tmp/demo-data/hooks.jsonl | jq -c 'select(.origin=="session-review") | {reviewType, evidence, status}'
jq '.sessions[].reviewAttemptedHash' tmp/demo-data/state.json
```

## Fault injection

| Scenario | How | Expected |
|---|---|---|
| Missing key / 401 | Use a synthetic provider that rejects | The failure increments `reviewAttempts`; a provider failure records `failed` with a transport note and retains its hourly slot once the provider call started |
| Malformed model JSON | Stub the provider with `not json` (see `review-model.test.ts`) | One repair call; if it still fails, `reviews.jsonl` gets `failed` without a `note`, and `state.json` increments `reviewAttempts` |
| Circuit breaker | Three transport failures | `/api/health` shows `runtime.openUntil`, logs `circuit open` |
| Queue full | Set `caps.queue` low, force a review | Hook remains `blocked` with `capacity:` and can be reconsidered when capacity is available |
| Cache write failure | Make only `review-cache.json` unwritable (mock `writeCacheFile`) | Review still returns; cache error is logged only. A fully read-only `dataDir` is expected to fail at `appendReview` |
| Corrupt cache on load | Use a synthetic malformed `review-cache.json` | The provider reports an error, leaves the file untouched, and sends no model request. After repairing the file, retry explicitly if the automatic failure budget is exhausted |
| Unchanged transcript | Run `review_session` twice with no new messages | No new `reviews.jsonl` row; `state.json .sessions[sid].reviewStatus` becomes `skipped` (`no new messages`). `transcript unchanged` only applies to auto runs |

## Cost and observability

- `/api/usage` now reports `reviewCalls`, `reviewTokens`, `reviewFailures` alongside
  System One/Two.
- `reviews.jsonl` stores per-run `usage`, `durationMs`, `chars`, `candidates`,
  `queued`, `dropped`.
- Default guards: 3-minute idle, 8 provider-run budget slots per hour (persisted
  across restarts), 12k input chars, 8 candidates, one run per quiet window,
  and a hash cache. The provider also has a separate hourly request budget;
  one run can involve more than one request due to retries or repair.
- Automatic review stops after five failures for the same known input window,
  including transport and pre-model failures. An unknown failed window does not
  gain a fresh budget merely because its hash is unavailable. A genuinely new
  known window can reset the budget; an explicit manual run can recover it.
- The hourly budget retains a slot once the provider call starts, including on
  timeouts or a later pause; only failures before the call release it. This may
  conservatively count attempts that never reached the provider.
- Runtime counters and recorded usage are not proof of billed calls or network
  requests, particularly after transport failure or a lost response.

## Known gaps

- No live agent turn is driven through the isolated OpenCode server; `session.idle`
  is covered by the mock in `plugin.test.ts`.
- The review prompt was exercised against the real model once manually (3 candidates,
  0 dropped, ~19.7s, 346 in / 2081 out tokens), but this is not part of `npm test`.
- The extension panel is built and type-checked; it is not covered by a browser test.
- Multi-instance concurrency on one data dir is bounded by the persisted hourly cap,
  but not stress-tested.
