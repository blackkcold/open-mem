import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../src/store.js";
import { withFileLock } from "../src/util/lock.js";
import type { HookRecord, QueueItem, Scope } from "../src/types.js";

const now = new Date().toISOString();

function queue(id: string, scope: Scope): QueueItem {
  return {
    id,
    title: id,
    text: id,
    kind: "preference",
    scope,
    status: "queue",
    source: { sessionID: "s1", messageID: "m1", role: "user" },
    createdAt: now,
    updatedAt: now,
    reason: "test",
    seenCount: 1,
    lastSeenAt: now,
    sources: [{ sessionID: "s1", messageID: "m1", role: "user" }],
  };
}

describe("cross-instance store lock", () => {
  it("does not let an expired owner release a successor's lease", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-lock-"));
    let at = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => at);
    try {
      const first = new Store(dir), second = new Store(dir);
      await first.init();
      const old = await first.claim("lease", 100);
      at += 101;
      const next = await second.claim("lease", 100);
      expect(next).toBeTruthy();
      await first.releaseReservation("lease", old);
      expect(await first.reserve("lease", 100)).toBe(false);
      await second.releaseReservation("lease", next);
      expect(await first.reserve("lease", 100)).toBe(true);
    } finally { clock.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });
  it("does not expire a long lease when another caller uses a shorter TTL", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-lock-"));
    let at = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => at);
    try {
      const store = new Store(dir);
      await store.init();
      expect(await store.reserve("review", 300_000)).toBe(true);
      at += 61_000;
      expect(await store.reserve("queue", 60_000)).toBe(true);
      expect(await store.reserve("review", 300_000)).toBe(false);
    } finally { clock.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });
  it("does not overwrite a concurrent item update when a snapshot is supplied", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-lock-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = { ...queue("cas", "global"), status: "auto" as const };
      await store.appendItem(item);
      await new Store(dir).updateItem(item.id, { text: "新的用户内容" });
      expect(await store.updateItem(item.id, { text: "旧快照覆盖" }, item)).toBeUndefined();
      expect((await store.listItems())[0].text).toBe("新的用户内容");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("waits for the shared lock before initializing default files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-lock-"));
    const store = new Store(dir);
    let startup: Promise<void> | undefined;
    let wroteBeforeRelease = false;
    try {
      await withFileLock(store.lockPath, async () => {
        startup = store.init();
        await new Promise((resolve) => setTimeout(resolve, 40));
        wroteBeforeRelease = existsSync(store.queuePath);
      });
      await startup;
      expect(wroteBeforeRelease).toBe(false);
      expect(await store.listQueue()).toEqual([]);
    } finally { await startup; await rm(dir, { recursive: true, force: true }); }
  });
  it("does not steal an old lock owned by a living local process", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-lock-"));
    try {
      const file = path.join(dir, ".store.lock");
      await writeFile(file, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "live" }));
      const old = new Date(Date.now() - 60_000);
      await utimes(file, old, old);
      await expect(withFileLock(file, async () => true, { timeoutMs: 30, staleMs: 10 })).rejects.toThrow("timed out");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("preserves updates from two independent Node processes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-lock-"));
    try {
      const store = new Store(dir);
      await store.init();
      const script = `import { Store } from './src/store.ts';
        const store = new Store(process.argv[1]);
        for (let i = 0; i < 15; i++) await store.incrementStat('processRuns');`;
      const run = promisify(execFile);
      await Promise.all([0, 1].map(() => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, dir], { cwd: process.cwd() })));
      expect((await store.readStats()).processRuns).toBe(30);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not lose concurrent statistics updates", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-lock-"));
    try {
      const stores = [new Store(dir), new Store(dir)];
      await stores[0].init();
      await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2].incrementStat("runs")));
      expect((await stores[0].readStats()).runs).toBe(20);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("returns the same private token during concurrent startup", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-lock-"));
    try {
      const stores = [new Store(dir), new Store(dir)];
      await stores[0].init();
      const tokens = await Promise.all(stores.map((store) => store.ensureToken()));
      expect(new Set(tokens).size).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("preserves hooks when two instances upsert concurrently", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-lock-"));
    try {
      const stores = [new Store(dir), new Store(dir)];
      await stores[0].init();
      await stores[1].init();
      const hook = (id: string): HookRecord => ({
        id, key: id, sessionID: "s1", turnID: "t1", messageID: "m1",
        text: id, title: id, trigger: "test", scope: "global", source: {},
        createdAt: now, updatedAt: now, status: "pending", attempts: 0,
      });
      await Promise.all(Array.from({ length: 12 }, (_, i) =>
        stores[i % 2].upsertHook(hook(`h${i}`)),
      ));
      expect((await stores[0].listHooks()).map((entry) => entry.id).sort())
        .toEqual(Array.from({ length: 12 }, (_, i) => `h${i}`).sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not append an item while another instance holds the store lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-lock-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem({
        id: "existing", title: "test", text: "test", kind: "fact", scope: "global",
        status: "auto", source: {}, createdAt: now, updatedAt: now,
      });
      const second = new Store(dir);
      let release!: () => void;
      let acquired!: () => void;
      const ready = new Promise<void>((resolve) => { acquired = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const holding = withFileLock(path.join(dir, ".store.lock"), async () => {
        acquired();
        await gate;
      });
      await ready;
      let completed = false;
      const append = store.appendItem({
        id: "i1", title: "test", text: "test", kind: "fact", scope: "global",
        status: "auto", source: {}, createdAt: now, updatedAt: now,
      }).then(() => { completed = true; });
      let touched = false;
      const touch = second.touchItem("existing").then(() => { touched = true; });
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(completed).toBe(false);
        expect(touched).toBe(false);
      } finally {
        release();
        await holding;
        await append;
        await touch;
      }
      expect((await store.listItems()).map((item) => item.id)).toContain("i1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not lose disjoint queue patches from two Store instances", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-lock-"));
    try {
      const first = new Store(dir);
      const second = new Store(dir);
      await first.init();
      await second.init();
      await first.upsertQueue(queue("q1", "global"));
      await first.upsertQueue(queue("q2", "global"));

      await Promise.all([
        first.patchQueue([{ id: "q1", patch: { scope: "session" } }]),
        second.patchQueue([{ id: "q2", patch: { scope: "project", projectKey: "A" } }]),
      ]);

      const queueAfter = await first.listQueue();
      expect(queueAfter.find((item) => item.id === "q1")?.scope).toBe("session");
      expect(queueAfter.find((item) => item.id === "q2")?.scope).toBe("project");
      expect(queueAfter.find((item) => item.id === "q2")?.projectKey).toBe("A");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reclaims a stale lock file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-lock-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1", "global"));
      const lockPath = path.join(dir, ".store.lock");
      await writeFile(lockPath, JSON.stringify({ token: "stale" }), "utf8");
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath, old, old);

      await store.patchQueue([{ id: "q1", patch: { scope: "session" } }]);
      expect((await store.listQueue())[0].scope).toBe("session");
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent state updates between two Store instances", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-lock-"));
    try {
      const first = new Store(dir);
      const second = new Store(dir);
      await first.init();
      await second.init();
      await Promise.all([
        first.updateSession("s1", { lastTurnID: "turn-1" }),
        second.updateSession("s2", { lastTurnID: "turn-2" }),
      ]);
      const state = await first.readState();
      expect(state.sessions.s1.lastTurnID).toBe("turn-1");
      expect(state.sessions.s2.lastTurnID).toBe("turn-2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
