import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

      const applied = await applyScopeMigration(store);
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
      expect(await applyScopeMigration(store)).toBeUndefined();

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
});
