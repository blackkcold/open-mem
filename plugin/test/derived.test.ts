import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import {
  deactivateItem,
  newChangeID,
  reactivateItem,
  recordChange,
  restoreVersion,
  revertChange,
} from "../src/changes.js";
import { itemContentVersion } from "../src/fingerprint.js";
import { buildContext } from "../src/plugin.js";
import type { ChangeEvent, ChangeJournal, Item } from "../src/types.js";

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
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-derived-"));
  const store = new Store(dir);
  await store.init();
  return { dir, store };
}

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
      source,
      origin: "turn",
      reason: "auto",
    });
  });
  return { item: written, event };
}

async function historicChange(store: Store, after: Item, at: string): Promise<ChangeEvent> {
  const event: ChangeEvent = {
    id: newChangeID(),
    at,
    kind: "update",
    actor: "user",
    itemID: after.id,
    itemVersion: itemContentVersion(after),
    after,
    source,
    origin: "user",
    reason: "historic",
    revertible: true,
  };
  const journal: ChangeJournal = {
    id: event.id, at: event.at, itemID: event.itemID, kind: event.kind,
    after: event.after, undone: false,
  };
  await store.transaction(async () => {
    await store.appendChange(event);
    await store.writeChangeJournal(journal);
  });
  return event;
}

describe("derived invalidation", () => {
  it("follows A -> B -> C recursively and drops them from the injected block", async () => {
    const { dir, store } = await fixture();
    try {
      const a = await seed(store, item({ id: "item_a", text: "上游偏好" }));
      const b = await seed(store, item({ id: "item_b", text: "派生偏好 B", derivedFrom: ["item_a"] }));
      const c = await seed(store, item({ id: "item_c", text: "派生偏好 C", derivedFrom: ["item_b"] }));
      const stop = await deactivateItem(store, "item_a", {
        expectedVersion: itemContentVersion(a.item),
      });
      expect(stop.ok).toBe(true);
      if (!stop.ok) return;
      expect(stop.invalidated.sort()).toEqual(["item_b", "item_c"]);
      const rows = await store.listItems();
      expect(rows.find((row) => row.id === "item_b")?.invalidatedBy).toBe("item_a");
      expect(rows.find((row) => row.id === "item_c")?.invalidatedBy).toBe("item_b");
      const block = await buildContext(store, mergeConfig({}), undefined);
      expect(block.autoMemory).toEqual([]);
      const events = await store.listChanges();
      expect(events.filter((event) => event.kind === "invalidate")).toHaveLength(2);
      expect(b.item.status).toBe("auto");
      expect(c.item.status).toBe("auto");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("keeps a manual derived item stopped but not archived", async () => {
    const { dir, store } = await fixture();
    try {
      const a = await seed(store, item({ id: "item_a" }));
      await seed(store, item({
        id: "item_manual",
        manual: true,
        status: "promoted",
        derivedFrom: ["item_a"],
        text: "手工确认过的派生偏好",
      }));
      const revert = await revertChange(store, a.event.id, {
        expectedVersion: itemContentVersion(a.item),
      });
      expect(revert.ok).toBe(true);
      const manual = (await store.listItems()).find((row) => row.id === "item_manual");
      expect(manual?.status).toBe("promoted");
      expect(manual?.invalidatedBy).toBe("item_a");
      const block = await buildContext(store, mergeConfig({}), undefined);
      expect(block.autoMemory).not.toContain("手工确认过的派生偏好");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("terminates on a derived cycle instead of looping", async () => {
    const { dir, store } = await fixture();
    try {
      const a = await seed(store, item({ id: "item_a", derivedFrom: ["item_c"] }));
      await seed(store, item({ id: "item_b", derivedFrom: ["item_a"] }));
      await seed(store, item({ id: "item_c", derivedFrom: ["item_b"] }));
      const stop = await deactivateItem(store, "item_a", {
        expectedVersion: itemContentVersion(a.item),
      });
      expect(stop.ok).toBe(true);
      if (!stop.ok) return;
      expect(stop.invalidated.sort()).toEqual(["item_b", "item_c"]);
      expect((await store.listItems()).filter((row) => row.invalidatedBy)).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses to reactivate a row whose upstream is still stopped", async () => {
    const { dir, store } = await fixture();
    try {
      const a = await seed(store, item({ id: "item_a" }));
      const b = await seed(store, item({ id: "item_b", derivedFrom: ["item_a"], text: "派生偏好" }));
      await deactivateItem(store, "item_a", {
        expectedVersion: itemContentVersion(a.item),
      });
      const invalidated = (await store.listItems()).find((row) => row.id === "item_b");
      expect(invalidated?.status).toBe("auto");
      expect(invalidated?.invalidatedBy).toBe("item_a");
      const resume = await reactivateItem(store, "item_b", {
        expectedVersion: itemContentVersion(invalidated as Item),
      });
      expect(resume.ok).toBe(false);
      if (!resume.ok) {
        expect(resume.code).toBe("conflict");
        // The rejection must name the invalid upstream, i.e. it really ran the
        // upstream check instead of the "still active" branch.
        expect(resume.message).toContain("item_a");
      }
      expect(b.item.status).toBe("auto");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not auto-restore downstream rows when the upstream returns", async () => {
    const { dir, store } = await fixture();
    try {
      const a = await seed(store, item({ id: "item_a" }));
      await seed(store, item({ id: "item_b", derivedFrom: ["item_a"], text: "派生 B" }));
      await seed(store, item({ id: "item_c", derivedFrom: ["item_b"], text: "派生 C" }));
      await deactivateItem(store, "item_a", { expectedVersion: itemContentVersion(a.item) });
      const resumed = await reactivateItem(store, "item_a", {
        expectedVersion: itemContentVersion((await store.listItems()).find((row) => row.id === "item_a") as Item),
      });
      expect(resumed.ok).toBe(true);
      // A is back, but B/C stay stopped until the user restores each in turn.
      const rows = await store.listItems();
      expect(rows.find((row) => row.id === "item_b")?.invalidatedBy).toBe("item_a");
      expect(rows.find((row) => row.id === "item_c")?.invalidatedBy).toBe("item_b");
      const block = await buildContext(store, mergeConfig({}), undefined);
      expect(block.autoMemory).not.toContain("派生 B");
      expect(block.autoMemory).not.toContain("派生 C");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("lets the user restore each invalidated row once its upstream is active", async () => {
    const { dir, store } = await fixture();
    try {
      const a = await seed(store, item({ id: "item_a" }));
      await seed(store, item({ id: "item_b", derivedFrom: ["item_a"], text: "派生 B" }));
      await seed(store, item({ id: "item_c", derivedFrom: ["item_b"], text: "派生 C" }));
      await deactivateItem(store, "item_a", { expectedVersion: itemContentVersion(a.item) });
      const resumed = await reactivateItem(store, "item_a", {
        expectedVersion: itemContentVersion((await store.listItems()).find((row) => row.id === "item_a") as Item),
      });
      expect(resumed.ok).toBe(true);

      const b = (await store.listItems()).find((row) => row.id === "item_b") as Item;
      const resumedB = await reactivateItem(store, "item_b", {
        expectedVersion: itemContentVersion(b),
      });
      expect(resumedB.ok).toBe(true);
      if (!resumedB.ok) return;
      expect(resumedB.event.kind).toBe("restore");
      const afterB = (await store.listItems()).find((row) => row.id === "item_b");
      expect(afterB?.invalidatedBy).toBeUndefined();
      expect(afterB?.status).toBe("auto");
      // C is still stopped until the user restores it explicitly.
      expect((await buildContext(store, mergeConfig({}), undefined)).autoMemory).toContain("派生 B");
      expect((await buildContext(store, mergeConfig({}), undefined)).autoMemory).not.toContain("派生 C");

      const c = (await store.listItems()).find((row) => row.id === "item_c") as Item;
      const resumedC = await reactivateItem(store, "item_c", {
        expectedVersion: itemContentVersion(c),
      });
      expect(resumedC.ok).toBe(true);
      const block = await buildContext(store, mergeConfig({}), undefined);
      expect(block.autoMemory).toContain("派生 B");
      expect(block.autoMemory).toContain("派生 C");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses to restore a version whose upstream is invalid", async () => {
    const { dir, store } = await fixture();
    try {
      const upstream = item({ id: "item_up" });
      const child = item({ id: "item_child", derivedFrom: ["item_up"], text: "旧派生说法" });
      const event = await historicChange(store, child, new Date(Date.now() - 1000).toISOString());
      const current: Item = { ...child, text: "新派生说法", changeID: newChangeID() };
      await store.replaceItems([
        { ...upstream, status: "archived", supersededBy: "deactivate" },
        current,
      ]);
      const result = await restoreVersion(store, "item_child", event.id, {
        expectedVersion: itemContentVersion(current),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("conflict");
      expect((await store.listItems()).find((row) => row.id === "item_child")?.text).toBe("新派生说法");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("invalidation cost and depth", () => {
  it("invalidates a 300-wide fanout with one bulk write", async () => {
    const { dir, store } = await fixture();
    try {
      const rows: Item[] = [item({ id: "item_root", text: "上游偏好" })];
      for (let index = 0; index < 300; index += 1) {
        rows.push(item({ id: `item_c${index}`, text: `派生 ${index}`, derivedFrom: ["item_root"] }));
      }
      await store.replaceItems(rows);
      const replace = vi.spyOn(store, "replaceItem");
      const bulk = vi.spyOn(store, "replaceItems");
      const maintenance = vi.spyOn(store, "applyItemChanges");
      const started = Date.now();
      const stop = await deactivateItem(store, "item_root", {
        expectedVersion: itemContentVersion(rows[0]),
      });
      const elapsed = Date.now() - started;
      expect(stop.ok).toBe(true);
      if (!stop.ok) return;
      expect(stop.invalidated).toHaveLength(300);
      // The root is written once; the 300 children travel in one full-set
      // write (no per-child read/modify/write) and never through a maintenance
      // journal, which would expose an undo that bypasses the upstream check.
      expect(replace).toHaveBeenCalledTimes(1);
      expect(bulk).toHaveBeenCalledTimes(1);
      expect(maintenance).toHaveBeenCalledTimes(0);
      expect(await readdir(path.join(dir, "maintenance")).catch(() => [])).toEqual([]);
      const after = await store.listItems();
      expect(after.filter((row) => row.invalidatedBy).length).toBe(300);
      const events = await store.listChanges();
      expect(events.filter((event) => event.kind === "invalidate")).toHaveLength(300);
      const block = await buildContext(store, mergeConfig({}), undefined);
      expect(block.autoMemory).toEqual([]);
      // Reported, not asserted: a single-machine wall time would be fragile.
      console.log(`[fanout] 300 children invalidated in ${elapsed} ms`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60_000);

  it("invalidates a chain deeper than the old 20-level cap", async () => {
    const { dir, store } = await fixture();
    try {
      const rows: Item[] = [item({ id: "item_l0", text: "链路 0" })];
      for (let index = 1; index <= 25; index += 1) {
        rows.push(item({
          id: `item_l${index}`,
          text: `链路 ${index}`,
          derivedFrom: [`item_l${index - 1}`],
        }));
      }
      await store.replaceItems(rows);
      const stop = await deactivateItem(store, "item_l0", {
        expectedVersion: itemContentVersion(rows[0]),
      });
      expect(stop.ok).toBe(true);
      if (!stop.ok) return;
      expect(stop.invalidated).toHaveLength(25);
      expect((await store.listItems()).find((row) => row.id === "item_l25")?.invalidatedBy).toBe("item_l24");
      const block = await buildContext(store, mergeConfig({}), undefined);
      expect(block.autoMemory).not.toContain("链路 25");
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("records one bounded audit entry when a derived cycle is detected", async () => {
    const { dir, store } = await fixture();
    try {
      const rows = [
        item({ id: "item_a", text: "环 A", derivedFrom: ["item_c"] }),
        item({ id: "item_b", text: "环 B", derivedFrom: ["item_a"] }),
        item({ id: "item_c", text: "环 C", derivedFrom: ["item_b"] }),
      ];
      await store.replaceItems(rows);
      const stop = await deactivateItem(store, "item_a", {
        expectedVersion: itemContentVersion(rows[0]),
      });
      expect(stop.ok).toBe(true);
      if (!stop.ok) return;
      expect(stop.invalidated.sort()).toEqual(["item_b", "item_c"]);
      const audits = (await store.listChangelog()).filter(
        (entry) => entry.action === "invalidate_cycle",
      );
      expect(audits).toHaveLength(1);
      expect(String(audits[0].rootID)).toBe("item_a");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("leaves no maintenance undo path that could revive a child of a stopped upstream", async () => {
    const { dir, store } = await fixture();
    try {
      const rows = [
        item({ id: "item_root", text: "上游偏好" }),
        item({ id: "item_child", text: "派生偏好", derivedFrom: ["item_root"] }),
      ];
      await store.replaceItems(rows);
      const stop = await deactivateItem(store, "item_root", {
        expectedVersion: itemContentVersion(rows[0]),
      });
      expect(stop.ok).toBe(true);
      // No maintenance journal and no whole-file backup: the legacy undo route
      // would restore the child while its upstream is still archived.
      expect(await readdir(path.join(dir, "maintenance")).catch(() => [])).toEqual([]);
      const backups = (await readdir(dir).catch(() => [] as string[])).filter((name) =>
        name.includes("items.jsonl.bak"),
      );
      expect(backups).toEqual([]);
      const child = (await store.listItems()).find((row) => row.id === "item_child");
      expect(child?.invalidatedBy).toBe("item_root");
      expect((await buildContext(store, mergeConfig({}), undefined)).autoMemory).not.toContain("派生偏好");
      await expect(store.undoMaintenance("maintenance_missing")).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
