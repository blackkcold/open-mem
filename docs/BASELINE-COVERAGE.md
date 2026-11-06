# Baseline coverage: detecting duplicates against curated memory

Status: **partially implemented (read-only)**. The queue now reports deterministic coverage
against L0/L2 Markdown; there is no persisted index, no automatic decision, and no semantic
Stage C. The original proposal below is kept as the design record.

Implemented in this pass:

- `plugin/src/baseline.ts` builds an in-memory section index for `AGENTS.md`, `memory/**/*.md`,
  project `AGENTS.md`, `.opencode/AGENTS.md` and `.memory/**/*.md`; bodies never persist and
  the index is rebuilt at most once per 30 s.
- `GET /api/queue` adds `coverage` locations (path, heading, line, relation, score) and a
  `baseline` status. Coverage is derived at read time and is not part of `decisionVersion`.
- `GET /api/baseline/status` and `POST /api/baseline/refresh` are read-only status and
  cache-refresh endpoints.
- The Queue card shows `基线已覆盖 / 基线相关 / 基线冲突`; the detail shows
  `path › heading:line` and never the baseline body.
- Global L0 is visible to every candidate; project L2 is visible only to a candidate with the
  same `projectKey`. Unknown project identity gets no project baseline.
- A changed number/port/date or an opposite negation is reported as a conflict, not covered
  (`plugin/src/relations.ts`).

Still not implemented: persisted baseline index, Stage C model check, audit `coverage`
findings, queue default deferral, and any automatic merge/rejection. Those remain proposals.

## Problem

The dedupe pipeline only compares a candidate against OpenMem's own data. A rule that
restates `AGENTS.md`, `memory/*.md`, a logic-chain diagram, or a project document is
therefore never recognized as a duplicate, and same-meaning rules keep accumulating in
parallel.

Evidence:

- `plugin/src/fingerprint.ts:131-167` — `entriesFor()` builds the comparison pool from
  `items`, `queue` and `shadow` only.
- `plugin/src/consolidate.ts:184-196` — the exact-duplicate pass keeps entries that share
  `scope` **and** `projectKey`; global and project never mix.
- `plugin/src/consolidate.ts:227-228` — System One only receives the last 60 titles from
  the same scope, never bodies and never curated files.
- `plugin/src/fingerprint.ts:103-108` — matching is lexical: SimHash Hamming ≤ 3 or
  bigram Jaccard ≥ 0.92. Paraphrased Chinese scores far below this.
- `plugin/src/audit.ts:29-58` — the audit duplicate sweep uses the same three pools,
  threshold 0.75, and only reports a conflict when titles match exactly.
- `docs/ARCHITECTURE.md:175` — rules can never merge or replace another item, so
  near-duplicate rules cannot be collapsed even when they are found.
- `plugin/src/rebuild.ts:31` — the generated views already state that curated files win,
  yet nothing reads them.

Four structural gaps follow:

1. **No baseline source.** Curated L0 files and docs are not part of the pool.
2. **Scope blindness.** A global curated rule is invisible to a project candidate.
3. **Lexical-only similarity.** Rewording defeats the fingerprint.
4. **No classification check.** Duplicate detection ignores `kind`, so the same text
   filed as `rule` and as `preference` is not flagged.

## Goals

- Report, at review time, that a candidate is already covered by a curated source, with
  `path`, heading and line.
- Compare across scopes **one way only**: global baselines are visible to project
  candidates; project baselines are not visible to other projects.
- Flag exact duplicates whose `kind` differs as a classification problem.
- Keep curated files strictly read-only. No write-back, no copy into `items.jsonl`,
  no upload.

## Non-goals

- No automatic rejection, merge, or deferral of covered candidates. Coverage is advice.
- No change to rule approval semantics: rules still require the confirmation-gated path.
- No embeddings service, no new network dependency in the default configuration.
- No indexing of credentials, tokens, session databases, or `autopilot/` data files.

## Design

### 1. Sources and precedence

| Scope | Default roots |
|---|---|
| global | `~/.config/opencode/AGENTS.md`, `~/.config/opencode/memory/**/*.md` |
| global (optional) | the logic-chain directory configured by the user |
| project | `<project>/AGENTS.md`, `<project>/.memory/**/*.md`, `<project>/.opencode/AGENTS.md` |

Roots are configuration, not hard-coded. Each indexed file records its scope and, for
project files, the `projectKey` that OpenMem already uses for isolation.

Excluded by pattern, before reading: `autopilot/`, `**/console-token`, `**/*.key`,
`**/*.pem`, `**/.env*`, `node_modules/`, `.git/`, files over the size cap, symlinks,
non-UTF-8 content.

### 2. Index shape

The persisted index holds **no document body**. It stores what is needed to locate a
section again:

```json
{
  "version": 1,
  "builtAt": "2026-11-06T02:00:00.000Z",
  "sources": [
    { "path": "/Users/me/.config/opencode/AGENTS.md", "scope": "global",
      "hash": "sha256:…", "mtimeMs": 0, "bytes": 12345, "truncated": false }
  ],
  "sections": [
    { "source": "/Users/me/.config/opencode/AGENTS.md", "heading": "Root Trigger Matrix",
      "line": 30, "length": 812, "fingerprint": "9f2c…" }
  ]
}
```

Section bodies exist only in memory during refresh and matching. When the console wants
to show the matched excerpt, it re-reads that file and slices by line. This keeps curated
memory out of the autopilot data directory and out of API payloads by default.

Chunking: split on Markdown headings (`#`…`######`); sections without a heading fall back
to 40-line windows with 8-line overlap. Caps: 200 files, 256 KB per file, 5000 sections.

### 3. Refresh

- Triggers: a queue listing request and the pre-classification dedupe pass.
- Throttle: at most once per 30 s. `stat` mtime+size; hash only when either changed.
- A failed read marks the source `error` and leaves its previous sections out of the
  index. The API then reports `baseline: "unavailable"` rather than "not covered".
- The index is a cache: deleting it is safe and triggers a rebuild.

### 4. Matching

Stage A — deterministic, local only:

- `exact`: same rule as items (Hamming ≤ 3 or Jaccard ≥ 0.92 between candidate text and
  a section or one of its paragraphs).
- `near`: Jaccard ≥ 0.75 over `title + text` against `heading + section text`.
- A shared-token guard (at least three CJK bigrams or two ASCII tokens of length ≥ 4)
  keeps single-topic documents from matching everything.

Stage B — scope and kind:

- global sections are compared with every candidate;
- project sections only with candidates of the same `projectKey`;
- if a section heading contains rule/permission vocabulary and the candidate is a `rule`,
  the finding is labelled `rule-coverage`; otherwise `topic-coverage`.

Stage C — optional semantic check (default **off**):

- when enabled, send only the candidate plus the matched heading and a 120-character
  snippet of the candidate itself, never the baseline body;
- ask one yes/no question, separate budget of 20 calls/hour, cached by pair hash.

### 5. Data model and API

- `QueueItem.coverage?: Array<{ source: string; heading: string; line: number;
  score: number; exact: boolean; kind: "rule-coverage" | "topic-coverage" }>`
  (maximum 3, highest score first).
- `AuditFinding.kind` gains `"coverage"`; detail carries `path#heading:line`.
- New `kind: "classification"` finding when two entries are exact duplicates but their
  `kind` differs.
- `GET /api/queue` includes coverage; `GET /api/audit` includes the new findings.
- `GET /api/baseline/status` returns sources, section count, built time, errors, and
  whether the index is stale. Read-only; the only mutation endpoint is
  `POST /api/baseline/refresh`, which touches the cache only.
- Config: `baseline: { enabled, roots, refreshMs, maxFiles, maxFileBytes, modelCheck }`.

### 6. Console

- Queue card badge: “已被基线覆盖”, expandable to `AGENTS.md › Root Trigger Matrix:30`
  and a short excerpt read from the file on demand.
- Audit page: `coverage` and `classification` filters; both link to the queue item.
- Settings: a read-only “基线索引” block with source count, last refresh, errors and a
  rebuild button. Saving settings still requires `configRevision`, unchanged.

### 7. Privacy and safety

- Curated files are read-only; no endpoint can write to them.
- Index stores fingerprints and locations, not bodies.
- Baseline content never leaves the machine unless Stage C is explicitly enabled, and
  even then only the heading is sent.
- Secret-looking content is skipped by pattern before indexing; a hit is reported as a
  `secret` finding, not silently ignored.
- A stale index never causes an automatic decision; it only suppresses a coverage claim.

### 8. Failure modes

| Case | Behavior |
|---|---|
| Permission denied | source `error`, `baseline: "unavailable"` |
| File over cap | indexed `truncated: true`, coverage labelled partial |
| Symlink or non-UTF-8 | skipped and reported once |
| Index corrupt | deleted and rebuilt; no findings produced from it |
| Project root renamed | old `projectKey` sections dropped on next refresh |

### 9. Tests

- Chunker: headings, overlaps, caps, front-matter.
- Matching: exact, near, paraphrased (expected miss without Stage C), cross-scope
  visibility, project isolation, kind mismatch.
- Privacy: token file never indexed; index JSON contains no body text.
- API: queue payload, audit findings, `baseline/status`, unavailable path.
- Behavior: no automatic approve/deny/merge when coverage is present.

### 10. Rollout

1. Ship with `enabled: true`, `modelCheck: false`; display-only for at least one week.
2. Collect false-positive rate from the `false_positive` action on coverage badges.
3. Only then consider an optional “covered candidates are deferred by default” setting;
   it stays off unless the user turns it on.

### 11. Open questions

- Which exact directory should be indexed as the logic-chain baseline?
- Should coverage of a **rule** block batch approval? Proposal: yes, exclude covered
  rules from batch, keep single-item approval available.
- Is Stage C wanted at all, given the privacy trade-off?

### 12. Effort

About 10 files: `plugin/src/baseline.ts` (new), `config.ts`, `types.ts`, `consolidate.ts`,
`server.ts`, `audit.ts`, two console components, and three test files. No schema
migration; the index is a regenerable cache.
