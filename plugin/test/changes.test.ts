import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import {
  newChangeID,
  itemSnapshot,
  recordChange,
  recordItemDiff,
  revertChange,
} from "../src/changes.js";
import { itemContentVersion } from "../src/fingerprint.js";
import { applyQueueDecision } from "../src/actions.js";
import { applySuggestion, undoMerge } from "../src/apply.js";
import { promoteSessionNote } from "../src/memory/session-promotion.js";
import { runCurator } from "../src/memory/curator.js";
import { runCompaction } from "../src/compact.js";
import type { DecisionResult, Item, QueueItem, ReviewRecord, Suggestion } from "../src/types.js";

const now = new Date().toISOString();

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item_a",
    title: "偏好",
    text: "回复先给结论",
    kind: "preference",
    scope: "global",
    status: "auto",
    source: { sessionID: "s1", messageID: "m1", role: "user" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function queue(id: string, text: string, overrides: Partial<QueueItem> = {}): QueueItem {
  const base: QueueItem = {
    id,
    title: "偏好",
    text,
    kind: "preference",
    scope: "global",
    status: "queue",
    source: { sessionID: "s1", messageID: "m2", role: "user" },
    createdAt: now,
    updatedAt: now,
    priority: 70,
    priorityBreakdown: { risk: 0.2, impact: 0.9, uncertainty: 0.1, age: 0 },
    reason: "test",
    diff: `+ ${text}`,
    decision: {
      kind: "preference",
      duplicate: 0,
      safeAuto: 0.96,
      risk: 0.1,
      confidence: 0.9,
      strictness: "preference",
      reasons: [],
      source: "heuristic",
      mergeAction: "create",
      conflict: 0,
    } satisfies DecisionResult,
  };
  return { ...base, ...overrides };
}

function suggestion(queueID: string, overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: `sug-${queueID}`,
    queueID,
    action: "create",
    proposedTitle: "偏好",
    proposedText: "回复先给结论",
    preserved: ["回复先给结论"],
    dropped: [],
    rationale: "test",
    confidence: 0.96,
    source: "composer",
    validation: { ok: true, errors: [], warnings: [] },
    createdAt: now,
    ...overrides,
  };
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-changes-"));
  const store = new Store(dir);
  await store.init();
  return { dir, store };
}

describe("change ledger", () => {
  it("keeps every identity field in a lossless snapshot", async () => {
    const { dir, store } = await fixture();
    try {
      const source = { sessionID: "s1", messageID: "m1", role: "user" as const };
      const written = item({
        id: "item_full",
        manual: true,
        project: "/repo/a",
        projectKey: "proj-a",
        expiresAt: "2030-01-01T00:00:00.000Z",
        derivedFrom: ["item_upstream"],
        supersededBy: undefined,
        aliases: ["回复先给结论。"],
        sources: [source, { sessionID: "s2", messageID: "m9", role: "user" }],
        tags: ["t1"],
        evidence: [{ messageID: "m1", quote: "回复先给结论", kind: "user" }],
        origin: "turn",
        reviewType: "preference",
        reviewID: "review_1",
        changeID: "change_prev",
        invalidatedBy: undefined,
        invalidatedAt: undefined,
        seenCount: 3,
        lastSeenAt: now,
      } as Partial<Item>);
      const changeID = newChangeID();
      const withChange = { ...written, changeID };
      const event = await store.transaction(async () => {
        await store.appendItem(withChange);
        return recordChange(store, {
          kind: "add",
          actor: "auto",
          itemID: withChange.id,
          item: withChange,
          source: source,
          origin: "turn",
          reason: "auto",
        });
      });
      expect(event.after).toEqual(withChange);
      expect(event.after?.projectKey).toBe("proj-a");
      expect(event.after?.derivedFrom).toEqual(["item_upstream"]);
      expect(event.after?.aliases).toEqual(["回复先给结论。"]);
      expect(event.after?.sources).toHaveLength(2);
      expect(event.after?.manual).toBe(true);
      expect(event.after?.expiresAt).toBe("2030-01-01T00:00:00.000Z");
      expect(event.after?.reviewType).toBe("preference");
      expect(event.after?.reviewID).toBe("review_1");
      expect(event.itemVersion).toBe(itemContentVersion(withChange));
      expect(event.revertible).toBe(true);
      expect(itemSnapshot(withChange)).toEqual(withChange);
      expect(await store.listChanges()).toHaveLength(1);
      expect(await store.readChangeJournal(event.id)).toMatchObject({
        id: event.id,
        itemID: withChange.id,
        undone: false,
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rolls back the item when the ledger write fails", async () => {
    const { dir, store } = await fixture();
    try {
      await expect(store.transaction(async () => {
        await store.appendItem(item({ id: "item_rollback" }));
        await recordChange(store, {
          kind: "add",
          actor: "auto",
          itemID: "item_rollback",
          item: item({ id: "item_rollback" }),
          source: {},
          reason: "auto",
        });
        throw new Error("boom");
      })).rejects.toThrow("boom");
      expect(await store.listItems()).toHaveLength(0);
      expect(await store.listChanges()).toHaveLength(0);

      const rejected = await store.transaction(async () => {
        await store.appendItem(item({ id: "item_reject" }));
        return { ok: false as const, error: "rejected" };
      });
      expect(rejected.ok).toBe(false);
      expect(await store.listItems()).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses to write a change outside a transaction", async () => {
    const { dir, store } = await fixture();
    try {
      await expect(recordChange(store, {
        kind: "add",
        actor: "auto",
        itemID: "item_a",
        item: item(),
        source: {},
        reason: "auto",
      })).rejects.toThrow(/transaction/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("marks archive/expire/invalidate as not revertible but keeps their snapshots", async () => {
    const { dir, store } = await fixture();
    try {
      const before = item({ id: "item_arch" });
      const after = { ...before, status: "archived" as const, supersededBy: "x" };
      const event = await store.transaction(async () => {
        await store.appendItem(before);
        await store.updateItem(before.id, { status: "archived", supersededBy: "x" });
        return recordChange(store, {
          kind: "archive",
          actor: "user",
          itemID: before.id,
          item: after,
          before,
          source: {},
          reason: "denied",
        });
      });
      expect(event.revertible).toBe(false);
      expect(event.before?.status).toBe("auto");
      expect(event.after?.status).toBe("archived");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("every write path records a change event", () => {
  it("records approve and edit with the written content", async () => {
    const { dir, store } = await fixture();
    try {
      await store.upsertQueue(queue("q_approve", "回复先给结论"));
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "q_approve", {
        action: "approve",
        confirmedByUser: true,
        text: "回复先给结论，再给细节",
      });
      expect(result.ok).toBe(true);
      const events = await store.listChanges();
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("add");
      expect(events[0].actor).toBe("user");
      expect(events[0].after?.text).toBe("回复先给结论，再给细节");
      const stored = (await store.listItems())[0];
      expect(stored.changeID).toBe(events[0].id);
      expect(events[0].itemVersion).toBe(itemContentVersion(stored));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("records promote as its own event", async () => {
    const { dir, store } = await fixture();
    try {
      await store.upsertQueue(queue("q_promote", "回复先给结论", {
        scope: "session",
        kind: "fact",
      }));
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "q_promote", {
        action: "promote",
        targetScope: "global",
        confirmedByUser: true,
      });
      expect(result.ok).toBe(true);
      const events = await store.listChanges();
      expect(events.map((event) => event.kind)).toEqual(["promote"]);
      expect(events[0].after?.scope).toBe("global");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("records merge into an existing item with a full before snapshot", async () => {
    const { dir, store } = await fixture();
    try {
      const target = item({ id: "item_target", text: "回复先给结论" });
      await store.appendItem(target);
      const candidate = queue("q_merge", "先给结论再给细节", {
        suggestion: suggestion("q_merge", {
          action: "merge_into",
          targetId: "item_target",
          targetVersion: itemContentVersion(target),
          proposedText: "回复先给结论，再给细节",
        }),
        suggestionState: "ready",
      });
      await store.upsertQueue(candidate);
      const result = await applySuggestion(store, mergeConfig({}), "q_merge");
      expect(result.ok).toBe(true);
      const events = await store.listChanges();
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("merge");
      expect(events[0].before?.text).toBe("回复先给结论");
      expect(events[0].after?.text).toBe("回复先给结论，再给细节");
      expect(events[0].after?.id).toBe("item_target");
      expect(events[0].revertible).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("records replace as an archive of the old row plus an update", async () => {
    const { dir, store } = await fixture();
    try {
      const target = item({ id: "item_target", text: "回复先给结论" });
      await store.appendItem(target);
      await store.upsertQueue(queue("q_replace", "先给结论再给细节", {
        suggestion: suggestion("q_replace", {
          action: "replace",
          targetId: "item_target",
          targetVersion: itemContentVersion(target),
          proposedText: "回复先给结论，再给细节",
        }),
        suggestionState: "ready",
      }));
      const result = await applySuggestion(store, mergeConfig({}), "q_replace");
      expect(result.ok).toBe(true);
      const events = await store.listChanges();
      expect(events.map((event) => event.kind).sort()).toEqual(["replace", "update"]);
      const archived = events.find((event) => event.kind === "replace");
      expect(archived?.after?.status).toBe("archived");
      expect(archived?.after?.supersededBy).toBe("item_target");
      const updated = events.find((event) => event.kind === "update");
      expect(updated?.after?.text).toBe("回复先给结论，再给细节");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("records legacy undoMerge as a revert that points at the merge change", async () => {
    const { dir, store } = await fixture();
    try {
      const target = item({ id: "item_target", text: "回复先给结论" });
      await store.appendItem(target);
      await store.upsertQueue(queue("q_undo", "先给结论再给细节", {
        suggestion: suggestion("q_undo", {
          action: "merge_into",
          targetId: "item_target",
          targetVersion: itemContentVersion(target),
          proposedText: "回复先给结论，再给细节",
        }),
        suggestionState: "ready",
      }));
      const applied = await applySuggestion(store, mergeConfig({}), "q_undo");
      expect(applied.ok).toBe(true);
      const mergeEvent = (await store.listChanges())[0];
      const undone = await undoMerge(store, applied.journalID ?? "");
      expect(undone.ok).toBe(true);
      const events = await store.listChanges();
      const revert = events.find((event) => event.kind === "revert");
      expect(revert?.reverts).toBe(mergeEvent.id);
      expect(revert?.after?.text).toBe("回复先给结论");
      expect((await store.listItems()).find((entry) => entry.id === "item_target")?.text).toBe("回复先给结论");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("records session note promotion", async () => {
    const { dir, store } = await fixture();
    try {
      const review: ReviewRecord = {
        id: "review_1",
        sessionID: "s1",
        projectKey: "proj-a",
        status: "ready",
        createdAt: now,
        candidates: 1,
        dropped: 0,
        sessionNotes: [{
          type: "preference",
          text: "本项目测试用 pnpm",
          evidence: [{ messageID: "m5", quote: "本项目测试用 pnpm", kind: "user" }],
          createdAt: now,
        }],
      };
      await store.appendReview(review as unknown as Record<string, unknown>);
      const result = await promoteSessionNote(store, DEFAULT_CONFIG, "review_1", 0, {
        targetScope: "project",
        projectKey: "proj-a",
        confirmedByUser: true,
      });
      expect(result.ok).toBe(true);
      const events = await store.listChanges();
      expect(events.map((event) => event.kind)).toEqual(["promote"]);
      expect(events[0].after?.projectKey).toBe("proj-a");
      expect(events[0].after?.status).toBe("auto");
      expect(events[0].origin).toBe("user");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("records curator expiry and exact-duplicate merges", async () => {
    const { dir, store } = await fixture();
    try {
      const expired = item({
        id: "item_expired",
        text: "端口是 5199",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const canonical = item({ id: "item_canonical", text: "回复先给结论", seenCount: 2 });
      const duplicate = item({ id: "item_dupe", text: "回复先给结论", createdAt: new Date(Date.now() + 1).toISOString() });
      await store.replaceItems([expired, canonical, duplicate]);
      const result = await runCurator(store, DEFAULT_CONFIG, { force: true });
      expect(result.expired).toBe(1);
      expect(result.merged).toBe(1);
      const events = await store.listChanges();
      expect(events.map((event) => event.kind).sort()).toEqual(["expire", "merge", "update"]);
      expect(events.find((event) => event.kind === "expire")?.after?.status).toBe("archived");
      expect(events.find((event) => event.kind === "merge")?.after?.supersededBy).toBe("item_canonical");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("records compaction merges as events", async () => {
    const { dir, store } = await fixture();
    try {
      const canonical = item({ id: "item_c1", text: "回复先给结论", seenCount: 2 });
      const duplicate = item({ id: "item_c2", text: "回复先给结论", createdAt: new Date(Date.now() + 1).toISOString() });
      await store.replaceItems([canonical, duplicate]);
      const result = await runCompaction(store, mergeConfig({}), {});
      expect(result.merged).toBe(1);
      const events = await store.listChanges();
      expect(events.map((event) => event.kind).sort()).toEqual(["archive", "update"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not record a compaction event for a group that merged nothing", async () => {
    const { dir, store } = await fixture();
    try {
      const canonical = item({ id: "item_p1", kind: "preference", text: "回复先给结论", seenCount: 2 });
      const duplicate = item({
        id: "item_p2",
        kind: "preference",
        text: "回复先给结论",
        createdAt: new Date(Date.now() + 1).toISOString(),
      });
      // Same scope/kind group, but the numeric value differs: not a duplicate,
      // so this group must not produce any event.
      const nearA = item({ id: "item_f1", kind: "fact", text: "本地端口是 5199" });
      const nearB = item({
        id: "item_f2",
        kind: "fact",
        text: "本地端口是 5198",
        createdAt: new Date(Date.now() + 1).toISOString(),
      });
      await store.replaceItems([canonical, duplicate, nearA, nearB]);
      const result = await runCompaction(store, mergeConfig({}), {});
      expect(result.merged).toBe(1);
      const events = await store.listChanges();
      expect(events.filter((event) => event.itemID === "item_f1")).toHaveLength(0);
      expect(events.filter((event) => event.itemID === "item_f2")).toHaveLength(0);
      expect(events.filter((event) => event.itemID === "item_p1")).toHaveLength(1);
      expect(events.filter((event) => event.itemID === "item_p1")[0].kind).toBe("update");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("revert after later edits", () => {
  it("refuses to overwrite a later edit and never restores only text", async () => {
    const { dir, store } = await fixture();
    try {
      const first = item({ id: "item_late", text: "回复先给结论" });
      const changeID = newChangeID();
      const e1 = await store.transaction(async () => {
        await store.appendItem({ ...first, changeID });
        return recordChange(store, {
          kind: "update", actor: "user", itemID: first.id,
          item: { ...first, changeID }, before: first, source: {}, reason: "first",
        });
      });
      const second = { ...first, text: "回复先给结论，再给细节" };
      await store.transaction(async () => {
        await store.updateItem(first.id, { text: second.text });
        return recordChange(store, {
          kind: "update", actor: "user", itemID: first.id,
          item: second, before: first, source: {}, reason: "second",
        });
      });
      const result = await revertChange(store, e1.id, {
        expectedVersion: itemContentVersion(second),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("conflict");
      expect((await store.listItems())[0].text).toBe("回复先给结论，再给细节");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("change ids are unique", () => {  it("fails fast on a reused id instead of overwriting its journal", async () => {
    const { dir, store } = await fixture();
    try {
      const base = item({ id: "item_reuse" });
      const changeID = newChangeID();
      const written = { ...base, changeID };
      const add = await store.transaction(async () => {
        await store.appendItem(written);
        return recordChange(store, {
          kind: "add", actor: "auto", itemID: written.id, item: written,
          source: {}, origin: "turn", reason: "auto",
        });
      });
      const undone = await revertChange(store, add.id, {
        expectedVersion: itemContentVersion(written),
      });
      expect(undone.ok).toBe(true);
      expect((await store.readChangeJournal(add.id))?.undone).toBe(true);
      const ledger = (await store.listChanges()).length;

      await expect(store.transaction(async () =>
        recordChange(store, {
          kind: "update",
          actor: "user",
          itemID: written.id,
          item: { ...written, changeID: add.id },
          source: {},
          reason: "reuse",
        }),
      )).rejects.toThrow(/already exists/);

      expect(await store.listChanges()).toHaveLength(ledger);
      expect((await store.readChangeJournal(add.id))?.undone).toBe(true);
      expect((await store.listItems())[0].status).toBe("archived");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("recordItemDiff covers semantic fields", () => {
  it("records one event when only derivedFrom/expiresAt/invalidatedBy changed", async () => {
    const { dir, store } = await fixture();
    try {
      const before = [
        item({ id: "item_d1", text: "上游依赖", derivedFrom: ["item_x"], expiresAt: "2030-01-01T00:00:00.000Z" }),
        item({ id: "item_d2", text: "未变化" }),
        item({ id: "item_d3", text: "失效标记" }),
      ];
      const after = [
        { ...before[0], derivedFrom: ["item_y"], expiresAt: "2031-01-01T00:00:00.000Z" },
        before[1],
        { ...before[2], invalidatedBy: "item_upstream", invalidatedAt: now },
      ];
      await store.replaceItems(after);
      const events = await store.transaction(() =>
        recordItemDiff(store, before, after, {
          kind: "update",
          actor: "system",
          reason: "legacy undo",
        }),
      );
      expect(events.map((event) => event.itemID).sort()).toEqual(["item_d1", "item_d3"]);
      const byID = new Map((await store.listChanges()).map((event) => [event.itemID, event]));
      expect(byID.has("item_d2")).toBe(false);
      expect(byID.get("item_d1")?.before?.derivedFrom).toEqual(["item_x"]);
      expect(byID.get("item_d1")?.after?.derivedFrom).toEqual(["item_y"]);
      expect(byID.get("item_d3")?.after?.invalidatedBy).toBe("item_upstream");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("records nothing when only volatile counters changed", async () => {
    const { dir, store } = await fixture();
    try {
      const before = [item({ id: "item_v1", text: "稳定", seenCount: 1 })];
      const after = [{
        ...before[0],
        seenCount: 5,
        lastSeenAt: now,
        updatedAt: new Date(Date.now() + 1000).toISOString(),
        changeID: "change_old",
      }];
      await store.replaceItems(after);
      const events = await store.transaction(() =>
        recordItemDiff(store, before, after, {
          kind: "update",
          actor: "system",
          reason: "noop",
        }),
      );
      expect(events).toHaveLength(0);
      expect(await store.listChanges()).toHaveLength(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
