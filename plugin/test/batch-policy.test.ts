import { describe, expect, it } from "vitest";
import {
  batchItemNeedsIndividualReview,
  batchSuggestionRejection,
} from "../src/batch-policy.js";
import type { DecisionResult, QueueItem, Suggestion } from "../src/types.js";

const now = new Date().toISOString();

function decision(overrides: Partial<DecisionResult> = {}): DecisionResult {
  return {
    kind: "preference",
    duplicate: 0,
    safeAuto: 0.8,
    risk: 0.1,
    confidence: 0.96,
    strictness: "preference",
    reasons: ["test"],
    source: "heuristic",
    mergeAction: "create",
    conflict: 0,
    ...overrides,
  };
}

function item(
  overrides: Partial<QueueItem> = {},
  suggestion: Partial<Suggestion> = {},
): QueueItem {
  const base: QueueItem = {
    id: "queue_policy",
    title: "[P] 项目安全新建",
    text: "本项目采用 pnpm 安装依赖",
    kind: "preference",
    scope: "project",
    projectKey: "proj-a",
    status: "queue",
    source: {},
    createdAt: now,
    updatedAt: now,
    reason: "test",
    decision: decision(),
  };
  const next = { ...base, ...overrides };
  return {
    ...next,
    suggestion: {
      id: "sug_policy",
      queueID: next.id,
      action: "create",
      proposedTitle: next.title,
      proposedText: next.text,
      preserved: [next.text],
      dropped: [],
      rationale: "test",
      confidence: 0.96,
      source: "composer",
      validation: { ok: true, errors: [], warnings: [] },
      createdAt: now,
      ...suggestion,
    },
  };
}

describe("shared batch policy", () => {
  it("allows a validated project-scope create", () => {
    expect(batchSuggestionRejection(item(), 0.9)).toBeUndefined();
  });

  it("rejects missing or unsafe queue assessment", () => {
    const cases: Array<[string, QueueItem]> = [
      ["missing decision", item({ decision: undefined, jev: undefined })],
      ["missing conflict", item({ decision: decision({ conflict: undefined }) })],
      ["NaN risk", item({ decision: decision({ risk: Number.NaN }) })],
      ["infinite conflict", item({ decision: decision({ conflict: Number.POSITIVE_INFINITY }) })],
      ["risk above range", item({ decision: decision({ risk: 1.1 }) })],
      ["conflict below range", item({ decision: decision({ conflict: -0.1 }) })],
      ["safety strictness", item({ decision: decision({ strictness: "safety" }) })],
      ["permission strictness", item({ decision: decision({ strictness: "permission" }) })],
      ["destructive strictness", item({ decision: decision({ strictness: "destructive" }) })],
      ["strict_limit strictness", item({ decision: decision({ strictness: "strict_limit" }) })],
      ["unknown strictness", item({ decision: decision({ strictness: "unknown" }) })],
    ];
    for (const [name, value] of cases) {
      expect(batchSuggestionRejection(value, 0.9), name).toBeTruthy();
    }
  });

  it("rejects invalid, low, or client-relaxed concentration", () => {
    for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01]) {
      expect(batchSuggestionRejection(item({}, { confidence }), 0.9)).toBeTruthy();
    }
    expect(batchSuggestionRejection(item({}, { confidence: 0.89 }), 0)).toBeTruthy();
    expect(batchSuggestionRejection(item({}, { confidence: 0.9 }), Number.NaN)).toBeUndefined();
  });

  it("rejects wrong scope, identity, action, kind and review origin", () => {
    const cases: QueueItem[] = [
      item({ scope: "global" }),
      item({ projectKey: undefined }),
      item({ kind: "rule" }),
      item({ kind: "skill" }),
      item({ origin: "session-review" }),
      item({ reviewID: "review_policy" }),
      item({}, { action: "merge_into" }),
      item({}, { action: "replace" }),
      item({}, { action: "reject_duplicate" }),
      item({}, { validation: { ok: false, errors: ["lint"], warnings: [] } }),
    ];
    for (const value of cases) {
      expect(batchSuggestionRejection(value, 0.9)).toBeTruthy();
    }
  });

  it("guards rules and review candidates from every batch action", () => {
    expect(batchItemNeedsIndividualReview(item({ kind: "rule" }))).toBe(true);
    expect(batchItemNeedsIndividualReview(item({ origin: "session-review" }))).toBe(true);
    expect(batchItemNeedsIndividualReview(item({ reviewID: "review_policy" }))).toBe(true);
    expect(batchItemNeedsIndividualReview(item({ kind: "skill" }))).toBe(false);
    expect(batchItemNeedsIndividualReview(item())).toBe(false);
  });
});
