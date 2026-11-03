import { describe, expect, it } from "vitest";
import { computePriority, sortQueue } from "../src/priority.js";
import type { JevResult, QueueItem } from "../src/types.js";

const jev = (risk: number, safeAuto = 0.5, confidence = 0.7): JevResult => ({
  kind: "rule",
  duplicate: 0,
  safeAuto,
  risk,
  confidence,
  strictness: "workflow",
  reasons: [],
  source: "heuristic",
});

describe("computePriority", () => {
  it("ranks high-risk global rules above low-risk project facts", () => {
    const high = computePriority(jev(0.95, 0.1, 0.5), new Date().toISOString(), "global");
    const low = computePriority(jev(0.1, 0.99, 0.95), new Date().toISOString(), "project");
    expect(high.priority).toBeGreaterThan(low.priority);
    expect(high.priority).toBeGreaterThanOrEqual(70);
  });

  it("grows with age", () => {
    const old = computePriority(jev(0.5), new Date(Date.now() - 14 * 86400000).toISOString(), "global");
    const fresh = computePriority(jev(0.5), new Date().toISOString(), "global");
    expect(old.priority).toBeGreaterThan(fresh.priority);
  });
});

describe("sortQueue", () => {
  it("sorts by priority descending and pushes deferred items last", () => {
    const base = {
      text: "x",
      kind: "rule" as const,
      scope: "global" as const,
      status: "queue" as const,
      source: {},
      updatedAt: new Date().toISOString(),
      reason: "test",
    };
    const queue: QueueItem[] = [
      { ...base, id: "a", title: "a", createdAt: new Date().toISOString(), priority: 20 },
      { ...base, id: "b", title: "b", createdAt: new Date().toISOString(), priority: 90, deferredUntil: new Date(Date.now() + 86400000).toISOString() },
      { ...base, id: "c", title: "c", createdAt: new Date().toISOString(), priority: 50 },
    ];
    expect(sortQueue(queue).map((item) => item.id)).toEqual(["c", "a", "b"]);
  });
});
