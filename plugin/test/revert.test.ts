import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import { deactivateItem, newChangeID, reactivateItem, recordChange, revertChange } from "../src/changes.js";
import { itemContentVersion } from "../src/fingerprint.js";
import { turnHookKey } from "../src/memory/suppression.js";
import { runConsolidation } from "../src/consolidate.js";
import type { Item } from "../src/types.js";

const now = new Date().toISOString();
const source = { sessionID: "s1", messageID: "m1", role: "user" as const };

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item_a",
    title: "偏好",
    text: "回复先给结论",
    kind: "preference",
    scope: "global",
    status: "auto",
    source,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-revert-"));
  const store = new Store(dir);
  await store.init();
  return { dir, store };
}

/** Write one item plus its add event, exactly like a real write path. */
async function seed(store: Store, value: Item) {
  const changeID = newChangeID();
  const written = { ...value, changeID };
  const event = await store.transaction(async () => {
    await store.appendItem(written);
    return recordChange(store, {
      kind: "add",
      actor: "auto",
      itemID: written.id,
      item: written,
      source: written.source,
      origin: "turn",
      reason: "auto",
    });
  });
  return { item: written, event };
}

describe("undo a change without a time limit", () => {
  it("archives an auto-added item and suppresses the same source", async () => {
    const { dir, store } = await fixture();
    try {
      const { item: written, event } = await seed(store, item());
      const result = await revertChange(store, event.id, {
        expectedVersion: itemContentVersion(written),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event.kind).toBe("revert");
      expect(result.event.reverts).toBe(event.id);
      const stored = (await store.listItems()).find((entry) => entry.id === "item_a");
      expect(stored?.status).toBe("archived");
      expect(stored?.supersededBy).toBe("revert");
      const rows = await store.listSuppressions();
      expect(rows.map((row) => row.hookKey)).toContain(turnHookKey(source, written.text));
      expect(rows.every((row) => row.reason === "reverted")).toBe(true);
      expect(await store.readChangeJournal(event.id)).toMatchObject({ undone: true });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("restores the full earlier version instead of patching text", async () => {
    const { dir, store } = await fixture();
    try {
      const original = item({
        id: "item_full",
        projectKey: "proj-a",
        scope: "project",
        source,
        aliases: ["旧说法"],
        derivedFrom: ["item_upstream"],
        expiresAt: "2030-01-01T00:00:00.000Z",
        seenCount: 4,
      });
      const { item: written } = await seed(store, original);
      const changeID = newChangeID();
      const edited = { ...written, text: "回复先给结论，再给细节", changeID };
      const update = await store.transaction(async () => {
        const next = await store.updateItem("item_full", { text: edited.text, changeID });
        return recordChange(store, {
          kind: "update",
          actor: "user",
          itemID: "item_full",
          item: next ?? edited,
          before: written,
          source,
          origin: "user",
          reason: "edit",
        });
      });
      const result = await revertChange(store, update.id, {
        expectedVersion: itemContentVersion(edited),
      });
      expect(result.ok).toBe(true);
      const restored = (await store.listItems()).find((entry) => entry.id === "item_full");
      expect(restored?.text).toBe("回复先给结论");
      expect(restored?.scope).toBe("project");
      expect(restored?.projectKey).toBe("proj-a");
      expect(restored?.aliases).toEqual(["旧说法"]);
      expect(restored?.derivedFrom).toEqual(["item_upstream"]);
      expect(restored?.expiresAt).toBe("2030-01-01T00:00:00.000Z");
      expect(restored?.seenCount).toBe(4);
      expect(restored?.status).toBe("auto");
      expect(restored?.changeID).not.toBe(update.id);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("returns version_mismatch and writes nothing when the version moved", async () => {
    const { dir, store } = await fixture();
    try {
      const { event } = await seed(store, item());
      const before = await store.listChanges();
      const result = await revertChange(store, event.id, { expectedVersion: "stale" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("version_mismatch");
      expect(await store.listChanges()).toHaveLength(before.length);
      expect((await store.listItems())[0].status).toBe("auto");
      expect(await store.listSuppressions()).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses a non-revertible kind and a second undo of the same change", async () => {
    const { dir, store } = await fixture();
    try {
      const { item: written } = await seed(store, item());
      const stop = await deactivateItem(store, "item_a", {
        expectedVersion: itemContentVersion(written),
      });
      expect(stop.ok).toBe(true);
      if (stop.ok) {
        const refuse = await revertChange(store, stop.event.id, {
          expectedVersion: itemContentVersion((await store.listItems())[0]),
        });
        expect(refuse.ok).toBe(false);
        if (!refuse.ok) expect(refuse.code).toBe("not_revertible");
      }
      const again = await seed(store, item({ id: "item_b", text: "另一条偏好" }));
      const first = await revertChange(store, again.event.id, {
        expectedVersion: itemContentVersion(again.item),
      });
      expect(first.ok).toBe(true);
      const second = await revertChange(store, again.event.id, {
        expectedVersion: itemContentVersion((await store.listItems()).find((entry) => entry.id === "item_b")!),
      });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.code).toBe("not_revertible");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not reopen an item invalidated by an upstream undo", async () => {
    const { dir, store } = await fixture();
    try {
      const { item: written } = await seed(store, item());
      const changeID = newChangeID();
      const upstream = await store.transaction(async () => {
        const next = await store.updateItem("item_a", {
          text: "回复先给结论（更新）",
          invalidatedBy: "item_upstream",
          changeID,
        });
        return recordChange(store, {
          kind: "update",
          actor: "user",
          itemID: "item_a",
          item: next ?? written,
          before: written,
          source,
          origin: "user",
          reason: "edit",
        });
      });
      const current = (await store.listItems())[0];
      const result = await revertChange(store, upstream.id, {
        expectedVersion: itemContentVersion(current),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("conflict");
      expect((await store.listItems())[0].text).toBe("回复先给结论（更新）");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("stop using, then restore use", () => {
  it("stops injection immediately with no time limit and re-allows it later", async () => {
    const { dir, store } = await fixture();
    try {
      const { item: written } = await seed(store, item({ scope: "global" }));
      const stop = await deactivateItem(store, "item_a", {
        expectedVersion: itemContentVersion(written),
      });
      expect(stop.ok).toBe(true);
      if (!stop.ok) return;
      expect(stop.event.kind).toBe("deactivate");
      const stopped = (await store.listItems())[0];
      expect(stopped.status).toBe("archived");
      expect(stopped.supersededBy).toBe("deactivate");
      expect((await store.listSuppressions()).length).toBeGreaterThan(0);

      // Arbitrarily far in the future: reactivate is never time limited.
      const resume = await reactivateItem(store, "item_a", {
        expectedVersion: itemContentVersion(stopped),
      });
      expect(resume.ok).toBe(true);
      if (!resume.ok) return;
      expect(resume.event.kind).toBe("restore");
      const active = (await store.listItems())[0];
      expect(active.status).toBe("auto");
      expect(active.supersededBy).toBeUndefined();
      expect(await store.listSuppressions()).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses to revive superseded, expired or invalidated rows", async () => {
    const { dir, store } = await fixture();
    try {
      const superseded = item({ id: "item_sup", supersededBy: "item_other", status: "archived" });
      const expired = item({
        id: "item_exp",
        status: "archived",
        supersededBy: "deactivate",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const invalidated = item({
        id: "item_inv",
        status: "archived",
        supersededBy: "deactivate",
        invalidatedBy: "item_up",
      });
      await store.replaceItems([superseded, expired, invalidated]);
      for (const entry of [superseded, expired, invalidated]) {
        const result = await reactivateItem(store, entry.id, {
          expectedVersion: itemContentVersion(entry),
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe("conflict");
      }
      expect((await store.listItems()).every((entry) => entry.status === "archived")).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("suppression reaches the capture lane", () => {
  it("ignores a re-captured hook from the reverted source and logs why", async () => {
    const { dir, store } = await fixture();
    try {
      // The item's original source is m1 while its evidence points at m2.
      // Reverting an add retires the evidence messages (m2) first, so m1 is
      // not covered by the retirement gate and the suppression lane is the one
      // actually exercised here.
      const evidence = {
        sessionID: "s1",
        messageID: "m2",
        role: "user" as const,
        start: 0,
        end: 5,
        quoteHash: "quote-m2",
        canonicalHash: "canonical-m2",
        partsHash: "parts-m2",
        sourceKey: "s1:m2:quote-m2",
      };
      const { item: written, event } = await seed(
        store,
        item({
          sources: [source, { sessionID: "s1", messageID: "m2", role: "user" }],
          evidenceRefs: [evidence],
        }),
      );
      await revertChange(store, event.id, {
        expectedVersion: itemContentVersion(written),
      });
      const hookID = "hook_same";
      await store.appendHook({
        id: hookID,
        key: turnHookKey(source, written.text) ?? "",
        sessionID: "s1",
        turnID: "t1",
        messageID: "m1",
        text: written.text,
        title: "偏好",
        trigger: "test",
        scope: "global",
        source,
        createdAt: now,
        updatedAt: now,
        status: "pending",
        attempts: 0,
      });
      const result = await runConsolidation("s1", {
        store,
        // The suppression check belongs to the deliberate legacy/manual lane,
        // which the kill switch keeps available while automation mode is off.
        // The explicit mode matches the fresh store's persisted config (mode
        // "off") instead of an in-memory legacy shape that drops the field.
        config: mergeConfig({
          shadow: false,
          automation: { enabled: false, mode: "off" },
        }),
        allowLegacyManual: true,
        decision: { async classify() { throw new Error("must not classify a suppressed hook"); } },
        readMessages: async () => [],
      });
      expect(result.skipped).toBe(1);
      const hook = (await store.listHooks()).find((entry) => entry.id === hookID);
      expect(hook?.status).toBe("ignored");
      expect(hook?.error).toBe("suppressed_after_revert");
      const logged = (await store.listChangelog()).find((entry) => entry.action === "suppressed_after_revert");
      expect(logged?.messageID).toBe("m1");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
