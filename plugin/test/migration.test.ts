import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import {
  applyScopeMigration,
  previewScopeMigration,
  scopeMigrationSummary,
  undoScopeMigration,
} from "../src/memory/migrate.js";
import { sha16 } from "../src/util/text.js";
import type { QueueItem, Scope } from "../src/types.js";

const now = new Date().toISOString();

function queue(
  id: string,
  text: string,
  scope: Scope,
  projectKey?: string,
): QueueItem {
  return {
    id,
    title: text.slice(0, 30),
    text,
    kind: "rule",
    scope,
    project: "/repo/a",
    projectKey,
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

describe("scope migration", () => {
  it("previews, applies, is idempotent and can be undone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-migrate-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1", "MUST NOT DO: Modify files.", "global"));
      await store.upsertQueue(
        queue("q2", "在这个项目中，回复先给结论", "global"),
      );
      await store.upsertQueue(
        queue("q3", "用户本机安装了 hermes", "project", "old"),
      );

      const preview = await previewScopeMigration(store);
      expect(preview.map((proposal) => proposal.scope)).toEqual([
        "session",
        "project",
        "global",
      ]);
      expect(preview[1].projectKey).toBe(sha16("/repo/a"));
      expect(scopeMigrationSummary(preview)).toEqual({
        session: 1,
        project: 1,
        global: 1,
      });

      const applied = await applyScopeMigration(store, preview);
      expect(applied?.applied).toBe(3);
      expect(applied?.backupPath).toContain("queue.json.bak-");
      const queueAfter = await store.listQueue();
      expect(queueAfter.map((item) => item.scope)).toEqual([
        "session",
        "project",
        "global",
      ]);
      expect(queueAfter[1].projectKey).toBe(sha16("/repo/a"));

      const secondPreview = await previewScopeMigration(store);
      expect(secondPreview.every((proposal) => proposal.changed)).toBe(false);
      expect(await applyScopeMigration(store, secondPreview)).toBeUndefined();

      const journal = JSON.parse(
        await readFile(applied?.journalPath ?? "", "utf8"),
      ) as { before: Array<{ id: string; scope: Scope }> };
      expect(journal.before).toHaveLength(3);
      expect(await undoScopeMigration(store, applied?.id ?? "")).toBe(3);
      const restored = await store.listQueue();
      expect(restored.map((item) => item.scope)).toEqual([
        "global",
        "global",
        "project",
      ]);
      await expect(undoScopeMigration(store, applied?.id ?? "")).rejects.toThrow(/撤销/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("merges concurrent patches by id without dropping rows", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-migrate-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1", "one", "global"));
      await store.upsertQueue(queue("q2", "two", "global"));
      await Promise.all([
        store.patchQueue([{ id: "q1", patch: { scope: "session" } }]),
        store.patchQueue([{ id: "q2", patch: { projectKey: "A" } }]),
      ]);
      const queueAfter = await store.listQueue();
      expect(queueAfter.find((item) => item.id === "q1")?.scope).toBe("session");
      expect(queueAfter.find((item) => item.id === "q2")?.projectKey).toBe("A");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to patch a row whose preview version changed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-migrate-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1", "MUST NOT DO: Modify files.", "global"));
      const preview = await previewScopeMigration(store);
      const expected = new Map([["q1", preview[0].beforeVersion ?? ""]]);
      await store.patchQueue([{ id: "q1", patch: { reason: "later edit" } }]);
      await expect(
        store.patchQueue([{ id: "q1", patch: { scope: "session" } }], expected),
      ).rejects.toThrow(/changed since preview/);
      expect((await store.listQueue())[0].scope).toBe("global");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses undo after the migrated row changed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-migrate-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1", "在这个项目中，回复先给结论", "global"));
      const preview = await previewScopeMigration(store);
      const applied = await applyScopeMigration(store, preview);
      expect(applied?.applied).toBe(1);
      await store.patchQueue([{ id: "q1", patch: { text: "later edit" } }]);
      await expect(
        undoScopeMigration(store, applied?.id ?? ""),
      ).rejects.toThrow(/changed since migration/);
      expect((await store.listQueue())[0].text).toBe("later edit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("applies exactly the previewed rows and leaves later changes for a new preview", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-migrate-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1", "MUST NOT DO: Modify files.", "global"));
      const preview = await previewScopeMigration(store);
      await store.upsertQueue(queue("q2", "在这个项目中，回复先给结论", "global"));
      const applied = await applyScopeMigration(store, preview);
      expect(applied?.applied).toBe(1);
      const queueAfter = await store.listQueue();
      expect(queueAfter.find((item) => item.id === "q1")?.scope).toBe("session");
      expect(queueAfter.find((item) => item.id === "q2")?.scope).toBe("global");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a stale preview and commits no backup or journal", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-migrate-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1", "在这个项目中，回复先给结论", "global"));
      const preview = await previewScopeMigration(store);
      await store.patchQueue([{ id: "q1", patch: { text: "后来修改的内容" } }]);
      await expect(applyScopeMigration(store, preview)).rejects.toThrow(
        /changed since preview/,
      );
      expect((await store.listQueue())[0].text).toBe("后来修改的内容");
      const root = await readdir(dir);
      expect(root.some((name) => name.startsWith("queue.json.bak-"))).toBe(false);
      const migrations = await readdir(path.join(dir, "migrations")).catch(() => []);
      expect(migrations).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rolls back the backup and journal when the queue patch fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-migrate-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1", "在这个项目中，回复先给结论", "global"));
      const preview = await previewScopeMigration(store);
      const spy = vi
        .spyOn(store, "patchQueue")
        .mockRejectedValueOnce(new Error("synthetic patch failure"));
      await expect(applyScopeMigration(store, preview)).rejects.toThrow(
        "synthetic patch failure",
      );
      spy.mockRestore();
      expect((await store.listQueue())[0].scope).toBe("global");
      const root = await readdir(dir);
      expect(root.some((name) => name.startsWith("queue.json.bak-"))).toBe(false);
      const migrations = await readdir(path.join(dir, "migrations")).catch(() => []);
      expect(migrations).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
