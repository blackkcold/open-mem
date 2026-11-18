import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import {
  admitAutoWrite,
  admitNewItem,
  admitQueueItem,
  capacityStatus,
  formatBytes,
} from "../src/capacity.js";
import type { Item, QueueItem } from "../src/types.js";

const now = new Date().toISOString();

function item(id: string, kind: Item["kind"] = "fact"): Item {
  return {
    id,
    title: `[F] ${id}`,
    text: `记忆 ${id}`,
    kind,
    scope: "global",
    status: "auto",
    source: { role: "user" },
    createdAt: now,
    updatedAt: now,
  };
}

function queue(id: string): QueueItem {
  return {
    ...item(id),
    status: "queue",
    reason: "test",
  };
}

describe("capacity governor", () => {
  it("bounds shadow history while preserving recent false-positive samples", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-cap-"));
    try {
      const store = new Store(dir);
      await store.init();
      for (let i = 0; i < 4; i++) await store.appendShadow({ id: `s${i}`, title: "test", candidate: "test", kind: "fact", scope: "global", wouldWriteTo: "AUTO_MEMORY", wouldApply: 0, priority: 0, source: {}, createdAt: now, falsePositive: i === 0 }, 2);
      expect((await store.listShadow()).map((entry) => entry.id)).toEqual(["s0", "s3"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("does not let observation history block candidate admission", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-cap-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendShadow({ id: "s", title: "test", candidate: "test", kind: "fact", scope: "global", wouldWriteTo: "AUTO_MEMORY", wouldApply: 0, priority: 0, source: {}, createdAt: now });
      expect((await admitQueueItem(store, mergeConfig({ caps: { shadow: 1 } }))).ok).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("allows approval to drain a full queue", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-cap-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1"));
      expect((await admitNewItem(store, mergeConfig({ caps: { queue: 1 } }), "fact")).ok).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("blocks when the total item cap is reached", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-cap-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, {
        caps: {
          itemsTotal: 2,
          autoMemory: 2,
          autoRules: 1,
          queue: 1,
          shadow: 10,
          skillDrafts: 1,
          suggestions: 10,
          diskBytes: 20 * 1024 * 1024,
        },
      });
      expect((await capacityStatus(store, config)).level).toBe("ok");
      await store.appendItem(item("a"));
      await store.appendItem(item("b"));
      const status = await capacityStatus(store, config);
      expect(status.level).toBe("block");
      expect(status.counts.items).toBe(2);
      const admission = await admitAutoWrite(store, config, "fact");
      expect(admission.ok).toBe(false);
      if (!admission.ok) expect(admission.action).toBe("block");
      expect((await admitNewItem(store, config, "fact")).ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queues when only the auto-memory lane is full", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-cap-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, {
        caps: {
          itemsTotal: 100,
          autoMemory: 1,
          autoRules: 1,
          queue: 10,
          shadow: 10,
          skillDrafts: 1,
          suggestions: 10,
          diskBytes: 20 * 1024 * 1024,
        },
      });
      await store.appendItem(item("a"));
      const admission = await admitAutoWrite(store, config, "fact");
      expect(admission.ok).toBe(false);
      if (!admission.ok) {
        expect(admission.action).toBe("queue");
        expect(admission.reason).toContain("AUTO_MEMORY");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects queue writes when the queue is full", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-cap-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, {
        caps: {
          itemsTotal: 100,
          autoMemory: 10,
          autoRules: 10,
          queue: 1,
          shadow: 10,
          skillDrafts: 1,
          suggestions: 10,
          diskBytes: 20 * 1024 * 1024,
        },
      });
      await store.upsertQueue(queue("q1"));
      const result = await admitQueueItem(store, config);
      expect(result.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats the disk budget as a hard block", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-cap-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, {
        caps: {
          itemsTotal: 100,
          autoMemory: 10,
          autoRules: 10,
          queue: 10,
          shadow: 10,
          skillDrafts: 1,
          suggestions: 10,
          diskBytes: 1,
        },
      });
      const status = await capacityStatus(store, config);
      expect(status.level).toBe("block");
      expect(status.reason).toContain("容量已满");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("formats bytes for the UI", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

const budgetDay = Date.UTC(2026, 10, 18, 9, 0, 0);

describe("auto-write budget", () => {
  it("blocks the second write when the daily limit is one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-budget-"));
    try {
      const store = new Store(dir);
      await store.init();
      const first = await store.consumeWriteBudget({
        sessionID: "s1",
        dailyWrites: 1,
        maxWritesPerSession: 5,
        now: budgetDay,
      });
      expect(first).toMatchObject({ ok: true, used: 1, sessionUsed: 1 });
      const second = await store.consumeWriteBudget({
        sessionID: "s2",
        dailyWrites: 1,
        maxWritesPerSession: 5,
        now: budgetDay,
      });
      expect(second).toMatchObject({ ok: false, reason: "write-budget" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks a second write in the same session but not in a different session", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-budget-"));
    try {
      const store = new Store(dir);
      await store.init();
      const limits = { dailyWrites: 10, maxWritesPerSession: 1, now: budgetDay };
      expect((await store.consumeWriteBudget({ sessionID: "s1", ...limits })).ok).toBe(true);
      expect(await store.consumeWriteBudget({ sessionID: "s1", ...limits })).toMatchObject({
        ok: false,
        reason: "write-budget",
      });
      expect((await store.consumeWriteBudget({ sessionID: "s2", ...limits })).ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not oversell the daily budget across two Store instances", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-budget-"));
    try {
      const first = new Store(dir);
      const second = new Store(dir);
      await first.init();
      const limits = { dailyWrites: 1, maxWritesPerSession: 5, now: budgetDay };
      const results = await Promise.all([
        first.consumeWriteBudget({ sessionID: "a", ...limits }),
        second.consumeWriteBudget({ sessionID: "b", ...limits }),
      ]);
      expect(results.filter((entry) => entry.ok)).toHaveLength(1);
      expect((await first.readState()).automation?.writeBudget?.count).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not count a rolled-back transaction", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-budget-"));
    try {
      const store = new Store(dir);
      await store.init();
      await expect(store.transaction(async () => {
        const consumed = await store.consumeWriteBudget({
          sessionID: "s1",
          dailyWrites: 1,
          maxWritesPerSession: 5,
          now: budgetDay,
        });
        expect(consumed.ok).toBe(true);
        throw new Error("rollback");
      })).rejects.toThrow("rollback");
      expect((await store.readState()).automation?.writeBudget?.count ?? 0).toBe(0);
      const retry = await store.consumeWriteBudget({
        sessionID: "s1",
        dailyWrites: 1,
        maxWritesPerSession: 5,
        now: budgetDay,
      });
      expect(retry.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resets the counter when the UTC day rolls over", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-budget-"));
    try {
      const store = new Store(dir);
      await store.init();
      const limits = { dailyWrites: 1, maxWritesPerSession: 5 };
      const endOfDay = Date.UTC(2026, 10, 18, 23, 59, 30);
      expect((await store.consumeWriteBudget({ sessionID: "s1", ...limits, now: endOfDay })).ok).toBe(true);
      expect(await store.consumeWriteBudget({ sessionID: "s1", ...limits, now: endOfDay })).toMatchObject({
        ok: false,
        reason: "write-budget",
      });
      const nextDay = Date.UTC(2026, 10, 19, 0, 0, 30);
      const rolled = await store.consumeWriteBudget({ sessionID: "s1", ...limits, now: nextDay });
      expect(rolled).toMatchObject({ ok: true, used: 1, sessionUsed: 1 });
      expect((await store.readState()).automation?.writeBudget).toMatchObject({
        day: "2026-11-19",
        count: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
