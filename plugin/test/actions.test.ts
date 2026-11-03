import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { applyQueueDecision } from "../src/actions.js";
import type { QueueItem } from "../src/types.js";

const now = new Date().toISOString();

function queue(id: string, title: string, text: string): QueueItem {
  return {
    id,
    title,
    text,
    kind: "preference",
    scope: "global",
    status: "queue",
    source: {},
    createdAt: now,
    updatedAt: now,
    priority: 70,
    priorityBreakdown: { risk: 0.2, impact: 0.9, uncertainty: 0.1, age: 0 },
    reason: "test",
    diff: `+ ${text}`,
    jev: {
      kind: "preference",
      duplicate: 0,
      safeAuto: 0.96,
      risk: 0.1,
      confidence: 0.9,
      strictness: "preference",
      reasons: [],
      source: "heuristic",
    },
  };
}

describe("queue actions", () => {
  it("approve writes AUTO_MEMORY and removes the queue item", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1", "[P] 先给结论", "回复先给结论"));
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "q1", { action: "approve", note: "test" });
      expect(result.ok).toBe(true);
      expect(result.target).toBe("AUTO_MEMORY.md");
      expect(await store.listQueue()).toEqual([]);
      expect(await store.readAutoMemory()).toContain("回复先给结论");
      const items = await store.listItems();
      expect(items.length).toBe(1);
      expect(items[0].status).toBe("auto");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deny archives, edit updates, defer snoozes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1", "[P] one", "one preference"));
      await store.upsertQueue(queue("q2", "[P] two", "two preference"));
      await store.upsertQueue(queue("q3", "[P] three", "three preference"));

      await applyQueueDecision(store, DEFAULT_CONFIG, "q1", { action: "deny" });
      const items = await store.listItems();
      expect(items.some((item) => item.status === "archived")).toBe(true);

      await applyQueueDecision(store, DEFAULT_CONFIG, "q2", {
        action: "edit",
        title: "[P] two edited",
        text: "two preference edited",
      });
      const edited = (await store.listQueue()).find((item) => item.id === "q2");
      expect(edited?.title).toBe("[P] two edited");

      await applyQueueDecision(store, DEFAULT_CONFIG, "q3", { action: "defer" });
      const deferred = (await store.listQueue()).find((item) => item.id === "q3");
      expect(deferred?.deferredUntil).toBeTruthy();
      expect(new Date(deferred?.deferredUntil ?? 0).getTime()).toBeGreaterThan(Date.now());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects approve when the linter fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1", "[P] too long", "例如，".repeat(200)));
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "q1", { action: "approve" });
      expect(result.ok).toBe(false);
      expect(await store.listQueue()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
