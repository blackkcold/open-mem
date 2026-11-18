import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { newChangeID, recordChange, restoreVersion } from "../src/changes.js";
import { itemContentVersion } from "../src/fingerprint.js";
import type { ChangeEvent, ChangeJournal, Item } from "../src/types.js";

const now = new Date().toISOString();
const source = { sessionID: "s1", messageID: "m1", role: "user" as const };

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item_v",
    title: "偏好",
    text: "回复先给结论",
    kind: "preference",
    scope: "global",
    status: "auto",
    source,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    seenCount: 2,
    aliases: ["旧说法"],
    ...overrides,
  };
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-restore-"));
  const store = new Store(dir);
  await store.init();
  return { dir, store };
}

/** A change event that lives in the ledger with a chosen timestamp. */
async function historicChange(
  store: Store,
  after: Item,
  at: string,
  before?: Item,
): Promise<ChangeEvent> {
  const event: ChangeEvent = {
    id: newChangeID(),
    at,
    kind: "update",
    actor: "user",
    itemID: after.id,
    itemVersion: itemContentVersion(after),
    after,
    ...(before ? { before } : {}),
    source,
    origin: "user",
    reason: "historic",
    revertible: true,
  };
  const journal: ChangeJournal = {
    id: event.id,
    at: event.at,
    itemID: event.itemID,
    kind: event.kind,
    before: event.before,
    after: event.after,
    undone: false,
  };
  await store.transaction(async () => {
    await store.appendChange(event);
    await store.writeChangeJournal(journal);
  });
  return event;
}

describe("restore a historical version", () => {
  it("writes the old snapshot as the new current version", async () => {
    const { dir, store } = await fixture();
    try {
      const old = item();
      const event = await historicChange(store, old, new Date(Date.now() - 1000).toISOString());
      const current: Item = {
        ...old,
        text: "回复先给结论，再给细节",
        projectKey: undefined,
        changeID: newChangeID(),
      };
      await store.replaceItems([current]);
      const result = await restoreVersion(store, "item_v", event.id, {
        expectedVersion: itemContentVersion(current),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event.kind).toBe("restore");
      const stored = (await store.listItems())[0];
      expect(stored.text).toBe("回复先给结论");
      expect(stored.status).toBe("auto");
      expect(stored.aliases).toEqual(["旧说法"]);
      expect(stored.seenCount).toBe(2);
      expect(stored.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(stored.source).toEqual(source);
      expect(stored.changeID).toBe(result.event.id);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses a version older than undo.retainDays and allows a longer window", async () => {
    const { dir, store } = await fixture();
    try {
      const old = item();
      const ancient = new Date(Date.now() - 91 * 86_400_000).toISOString();
      const event = await historicChange(store, old, ancient);
      const current = { ...old, text: "现在的说法" };
      await store.replaceItems([current]);
      const refused = await restoreVersion(store, "item_v", event.id, {
        expectedVersion: itemContentVersion(current),
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.code).toBe("not_revertible");
        expect(refused.message).toContain("90");
      }
      expect((await store.listItems())[0].text).toBe("现在的说法");

      await store.writeConfig({ ...DEFAULT_CONFIG, undo: { retainDays: 200 } });
      const allowed = await restoreVersion(store, "item_v", event.id, {
        expectedVersion: itemContentVersion(current),
      });
      expect(allowed.ok).toBe(true);
      expect((await store.listItems())[0].text).toBe("回复先给结论");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("returns version_mismatch without writing when the current version moved", async () => {
    const { dir, store } = await fixture();
    try {
      const old = item();
      const event = await historicChange(store, old, now);
      const current = { ...old, text: "现在的说法" };
      await store.replaceItems([current]);
      const ledger = (await store.listChanges()).length;
      const result = await restoreVersion(store, "item_v", event.id, {
        expectedVersion: "stale",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("version_mismatch");
      expect(await store.listChanges()).toHaveLength(ledger);
      expect((await store.listItems())[0].text).toBe("现在的说法");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses an incomplete legacy snapshot instead of guessing the body", async () => {
    const { dir, store } = await fixture();
    try {
      const current = item();
      await store.replaceItems([current]);
      const broken = {
        id: newChangeID(),
        at: now,
        kind: "update",
        actor: "user",
        itemID: "item_v",
        source,
        reason: "legacy",
        revertible: true,
      } as unknown as ChangeEvent;
      await store.transaction(async () => {
        await store.appendChange(broken);
      });
      const result = await restoreVersion(store, "item_v", broken.id, {
        expectedVersion: itemContentVersion(current),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("not_revertible");
      expect((await store.listItems())[0].text).toBe("回复先给结论");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses a snapshot from a different scope or project", async () => {
    const { dir, store } = await fixture();
    try {
      const old = item({ scope: "project", projectKey: "proj-a" });
      const event = await historicChange(store, old, now);
      const current: Item = { ...old, scope: "project", projectKey: "proj-b", text: "B 项目说法" };
      await store.replaceItems([current]);
      const result = await restoreVersion(store, "item_v", event.id, {
        expectedVersion: itemContentVersion(current),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("not_revertible");
      expect((await store.listItems())[0].projectKey).toBe("proj-b");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses a snapshot that is already expired instead of succeeding without injection", async () => {
    const { dir, store } = await fixture();
    try {
      const old = item({
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        text: "过期旧正文",
      });
      const event = await historicChange(store, old, new Date(Date.now() - 1000).toISOString());
      const current = { ...old, text: "现在的正文", expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
      await store.replaceItems([current]);
      const ledger = (await store.listChanges()).length;
      const result = await restoreVersion(store, "item_v", event.id, {
        expectedVersion: itemContentVersion(current),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("not_revertible");
      expect(await store.listChanges()).toHaveLength(ledger);
      expect((await store.listItems())[0].text).toBe("现在的正文");
      expect((await store.listItems())[0].expiresAt).toBe(current.expiresAt);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("clears suppressions so the restored memory can be learned again", async () => {
    const { dir, store } = await fixture();
    try {
      const old = item();
      const event = await historicChange(store, old, now);
      const current: Item = { ...old, status: "archived", supersededBy: "deactivate", text: "停用中" };
      await store.replaceItems([current]);
      await store.appendSuppression({
        id: "supp_1",
        at: now,
        hookKey: "s1|m1|deadbeef",
        textHash: "deadbeef",
        itemID: "item_v",
        reason: "deactivated",
      });
      const result = await restoreVersion(store, "item_v", event.id, {
        expectedVersion: itemContentVersion(current),
      });
      expect(result.ok).toBe(true);
      expect(await store.listSuppressions()).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("records a full before/after snapshot for the restore event", async () => {
    const { dir, store } = await fixture();
    try {
      const old = item();
      const event = await historicChange(store, old, now);
      const current: Item = { ...old, text: "现在的说法", manual: true };
      await store.replaceItems([current]);
      const result = await restoreVersion(store, "item_v", event.id, {
        expectedVersion: itemContentVersion(current),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event.before?.text).toBe("现在的说法");
      expect(result.event.after?.text).toBe("回复先给结论");
      expect(result.event.before?.manual).toBe(true);
      expect(result.event.after?.manual).toBeUndefined();
      expect(result.event.revertible).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
