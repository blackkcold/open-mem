import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { rebuildAutoFiles } from "../src/rebuild.js";
import { collectReviewKnownTitles } from "../src/review/input.js";
import { collectExistingTitles } from "../src/consolidate.js";
import type { Item } from "../src/types.js";

const now = new Date().toISOString();

function item(overrides: Partial<Item>): Item {
  return {
    id: "item_test",
    title: "test",
    text: "test",
    kind: "fact",
    scope: "global",
    status: "auto",
    source: { sessionID: "s1", messageID: "m1", role: "user" },
    createdAt: now,
    updatedAt: now,
    seenCount: 1,
    lastSeenAt: now,
    ...overrides,
  };
}

describe("AUTO audit views", () => {
  it("does not leak other projects or audit-only titles into model hints", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-rebuild-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem(item({ id: "a", scope: "project", projectKey: "A", title: "A-only" }));
      await store.appendItem(item({ id: "b", scope: "project", projectKey: "B", title: "B-only" }));
      await store.writeAutoView("# AUTO_MEMORY\n- audit-only", "");
      expect(await collectReviewKnownTitles(store, 30, "B")).toEqual(["B-only"]);
      const titles = await collectExistingTitles(store, "B");
      expect(titles).toEqual(["B-only"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("marks the view audit-only and records projectKey", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-rebuild-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem(item({ id: "g", text: "global fact" }));
      await store.appendItem(
        item({ id: "a", text: "A fact", scope: "project", projectKey: "A" }),
      );
      await rebuildAutoFiles(store);
      const memory = await store.readAutoMemory();
      expect(memory).toContain("AUDIT VIEW ONLY");
      expect(memory).toContain("project: A");
      expect(memory).toContain("global fact");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("collects known titles from items, never from AUTO audit files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-rebuild-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem(
        item({ id: "i1", title: "item title", text: "item text" }),
      );
      await store.writeAutoView(
        "# AUTO_MEMORY\n\n- auto-only title\n",
        "# AUTO_RULES\n\n- auto-only rule\n",
      );
      const titles = await collectReviewKnownTitles(store);
      expect(titles).toContain("item title");
      expect(titles).not.toContain("auto-only title");
      expect(titles).not.toContain("auto-only rule");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
