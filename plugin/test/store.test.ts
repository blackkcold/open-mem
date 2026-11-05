import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

describe("Store", () => {
  it("refuses to rewrite items when a JSONL row is corrupt", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-store-"));
    try {
      const store = new Store(dir);
      await store.init();
      const raw = '{"id":"valid"}\n{broken\n';
      await writeFile(store.itemsPath, raw, "utf8");
      await expect(store.updateItem("valid", { text: "new" })).rejects.toThrow();
      expect(await readFile(store.itemsPath, "utf8")).toBe(raw);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("preserves a corrupt queue instead of overwriting it on update", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-store-"));
    try {
      const store = new Store(dir);
      await store.init();
      const corrupt = "{invalid json";
      await writeFile(store.queuePath, corrupt, "utf8");
      await expect(store.upsertQueue({
        id: "q1", title: "test", text: "test", kind: "rule", scope: "global",
        status: "queue", source: {}, createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), reason: "test",
      })).rejects.toThrow();
      expect(await readFile(store.queuePath, "utf8")).toBe(corrupt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("creates the data layout and round-trips auto memory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-store-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendAutoMemory("本地 dev server 端口是 5199。", { id: "x" });
      const memory = await store.readAutoMemory();
      expect(memory).toContain("5199");
      expect(memory).toContain("<!-- auto:");
      const queue = await store.listQueue();
      expect(queue).toEqual([]);
      const token = await store.ensureToken();
      expect(token.length).toBeGreaterThan(20);
      const mode = (await stat(store.tokenPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("upserts and removes queue entries", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-store-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = {
        id: "q1",
        title: "[R] test",
        text: "test",
        kind: "rule" as const,
        scope: "global" as const,
        status: "queue" as const,
        source: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        reason: "test",
      };
      await store.upsertQueue(item);
      expect((await store.listQueue()).length).toBe(1);
      await store.upsertQueue({ ...item, title: "[R] updated" });
      expect((await store.listQueue())[0].title).toBe("[R] updated");
      await store.removeQueue("q1");
      expect(await store.listQueue()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes review slots across Store instances", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-store-"));
    try {
      const first = new Store(dir);
      const second = new Store(dir);
      await first.init();
      await second.init();
      const at = Date.now();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          (index % 2 === 0 ? first : second).takeReviewSlot(
            at + index,
            2,
            60 * 60 * 1000,
          ),
        ),
      );
      expect(results.filter((entry) => entry.ok)).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
