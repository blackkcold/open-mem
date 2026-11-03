import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

describe("Store", () => {
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
});
