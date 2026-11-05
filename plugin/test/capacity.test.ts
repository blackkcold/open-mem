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
