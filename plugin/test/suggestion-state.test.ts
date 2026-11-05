import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { resetStaleSuggestions } from "../src/plugin.js";
import type { QueueItem } from "../src/types.js";

function queueItem(overrides: Partial<QueueItem>): QueueItem {
  const now = new Date().toISOString();
  return {
    id: "queue_test",
    title: "[P] test",
    text: "test preference",
    kind: "preference",
    scope: "global",
    status: "queue",
    source: { sessionID: "s1", messageID: "m1", role: "user" },
    createdAt: now,
    updatedAt: now,
    reason: "test",
    suggestionState: "pending",
    ...overrides,
  };
}

describe("resetStaleSuggestions", () => {
  it("clears a pending marker left by a dead process", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-suggestion-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.writeQueue([
        queueItem({ updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
      ]);
      expect(await resetStaleSuggestions(store)).toBe(1);
      const [item] = await store.listQueue();
      expect(item.suggestionState).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a fresh in-flight suggestion alone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-suggestion-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.writeQueue([queueItem({ updatedAt: new Date().toISOString() })]);
      expect(await resetStaleSuggestions(store)).toBe(0);
      const [item] = await store.listQueue();
      expect(item.suggestionState).toBe("pending");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
