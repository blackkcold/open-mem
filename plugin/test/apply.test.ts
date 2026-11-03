import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildSuggestion } from "../src/suggestion.js";
import { applySuggestion, undoMerge } from "../src/apply.js";
import type { DecisionResult, Item, QueueItem } from "../src/types.js";

const now = new Date().toISOString();

function target(): Item {
  return {
    id: "item_target",
    title: "[P] 先给结论",
    text: "回复先给结论，再给细节",
    kind: "preference",
    scope: "global",
    status: "auto",
    source: { role: "user" },
    createdAt: now,
    updatedAt: now,
    seenCount: 1,
    lastSeenAt: now,
    sources: [{ role: "user" }],
  };
}

function queue(decision: DecisionResult): QueueItem {
  return {
    id: "queue_1",
    title: "[P] 先给结论",
    text: "回复先给结论",
    kind: "preference",
    scope: "global",
    status: "queue",
    source: { role: "user" },
    createdAt: now,
    updatedAt: now,
    decision,
    priority: 80,
    priorityBreakdown: { risk: 0.18, impact: 0.9, uncertainty: 0.05, age: 0 },
    reason: "test",
  };
}

function decision(action: DecisionResult["mergeAction"], targetId: string): DecisionResult {
  return {
    kind: "preference",
    duplicate: 0.6,
    safeAuto: 0.7,
    risk: 0.18,
    confidence: 0.95,
    strictness: "preference",
    reasons: ["test"],
    source: "heuristic",
    mergeAction: action,
    mergeTargetId: targetId,
    conflict: 0,
  };
}

describe("apply suggestion", () => {
  it("merges into the target and undoes within the window", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = target();
      await store.appendItem(item);
      const entry = queue(decision("merge_into", item.id));
      await store.upsertQueue(entry);
      const suggestion = await buildSuggestion(
        { store, config: DEFAULT_CONFIG },
        entry,
        entry.decision as DecisionResult,
        item,
      );
      expect(suggestion.action).toBe("merge_into");
      expect(suggestion.validation.ok).toBe(true);

      const applied = await applySuggestion(store, DEFAULT_CONFIG, entry.id);
      expect(applied.ok).toBe(true);
      expect(await store.listQueue()).toEqual([]);
      const updated = (await store.listItems()).find((candidate) => candidate.id === item.id);
      expect(updated?.seenCount).toBe(2);
      const journal = await store.listJournal();
      expect(journal).toHaveLength(1);

      const undone = await undoMerge(store, journal[0].id);
      expect(undone.ok).toBe(true);
      const restored = (await store.listItems()).find((candidate) => candidate.id === item.id);
      expect(restored?.seenCount).toBe(1);
      expect(await store.listQueue()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a duplicate and archives the candidate", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = target();
      await store.appendItem(item);
      const entry = queue(decision("reject_duplicate", item.id));
      await store.upsertQueue(entry);
      const suggestion = await buildSuggestion(
        { store, config: DEFAULT_CONFIG },
        entry,
        entry.decision as DecisionResult,
        item,
      );
      expect(suggestion.action).toBe("reject_duplicate");

      const applied = await applySuggestion(store, DEFAULT_CONFIG, entry.id);
      expect(applied.ok).toBe(true);
      expect(await store.listQueue()).toEqual([]);
      const items = await store.listItems();
      expect(items.some((candidate) => candidate.status === "archived")).toBe(true);
      const updated = items.find((candidate) => candidate.id === item.id);
      expect(updated?.seenCount).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
