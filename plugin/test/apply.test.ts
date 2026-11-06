import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildSuggestion } from "../src/suggestion.js";
import { itemContentVersion } from "../src/fingerprint.js";
import { applySuggestion, undoMerge } from "../src/apply.js";
import { mergeConfig } from "../src/config.js";
import type {
  DecisionResult,
  Item,
  MergeAction,
  QueueItem,
  Suggestion,
} from "../src/types.js";

const now = new Date().toISOString();

function target(): Item {
  return {
    id: "item_target",
    title: "[P] 先给结论",
    text: "回复先给结论，再给细节",
    kind: "preference",
    scope: "global",
    status: "auto",
    source: { role: "user" },
    createdAt: now,
    updatedAt: now,
    seenCount: 1,
    lastSeenAt: now,
    sources: [{ role: "user" }],
  };
}

function queue(decision: DecisionResult): QueueItem {
  return {
    id: "queue_1",
    title: "[P] 先给结论",
    text: "回复先给结论",
    kind: "preference",
    scope: "global",
    status: "queue",
    source: { role: "user" },
    createdAt: now,
    updatedAt: now,
    decision,
    priority: 80,
    priorityBreakdown: { risk: 0.18, impact: 0.9, uncertainty: 0.05, age: 0 },
    reason: "test",
  };
}

function decision(action: DecisionResult["mergeAction"], targetId: string): DecisionResult {
  return {
    kind: "preference",
    duplicate: 0.6,
    safeAuto: 0.7,
    risk: 0.18,
    confidence: 0.95,
    strictness: "preference",
    reasons: ["test"],
    source: "heuristic",
    mergeAction: action,
    mergeTargetId: targetId,
    conflict: 0,
  };
}

function suggestionFor(
  entry: QueueItem,
  action: MergeAction,
  proposedTitle: string,
  proposedText: string,
  targetItem?: Item,
): Suggestion {
  return {
    id: `sug_${entry.id}`,
    queueID: entry.id,
    action,
    targetId: targetItem?.id,
    targetTitle: targetItem?.title,
    targetVersion: targetItem ? itemContentVersion(targetItem) : undefined,
    proposedTitle,
    proposedText,
    preserved: [proposedText],
    dropped: [],
    rationale: "test",
    confidence: 0.9,
    source: "composer",
    validation: { ok: true, errors: [], warnings: [] },
    createdAt: now,
  };
}

describe("apply suggestion", () => {
  it("refuses an incomplete journal rather than re-queuing a possibly committed apply", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendJournal({ id: "merge_incomplete", at: new Date().toISOString(), action: "create", queueID: "queue_1", before: { queue: queue(decision("create", "")) }, after: {} });
      expect((await undoMerge(store, "merge_incomplete")).ok).toBe(false);
      expect(await store.listQueue()).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("cannot merge rules even if a persisted suggestion was changed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = { ...target(), kind: "rule" as const };
      await store.appendItem(item);
      const entry = { ...queue(decision("merge_into", item.id)), kind: "rule" as const };
      await store.upsertQueue(entry);
      const suggestion = await buildSuggestion({ store, config: DEFAULT_CONFIG }, entry, entry.decision, item);
      await store.patchQueue([{ id: entry.id, patch: { suggestion: { ...suggestion, action: "merge_into" } } }]);
      expect((await applySuggestion(store, DEFAULT_CONFIG, entry.id)).ok).toBe(false);
      expect((await store.listItems())[0].seenCount).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("refuses an unvalidated suggestion unless the user edits it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = target();
      await store.appendItem(item);
      const entry = queue(decision("merge_into", item.id));
      const suggestion = {
        ...suggestionFor(entry, "merge_into", item.title, item.text, item),
        validation: { ok: false, errors: ["模拟校验失败"], warnings: [] },
      };
      await store.upsertQueue({ ...entry, suggestion, suggestionState: "ready" });

      const refused = await applySuggestion(store, DEFAULT_CONFIG, entry.id);
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain("校验");
      expect(await store.listQueue()).toHaveLength(1);
      expect((await store.listItems())[0].text).toBe(item.text);

      const edited = await applySuggestion(store, DEFAULT_CONFIG, entry.id, {
        text: "回复先给结论，再给细节。",
      });
      expect(edited.ok).toBe(true);
      const journal = (await store.listJournal()).find((entry) => entry.id === edited.journalID);
      expect(journal?.humanEdited).toBe(true);
      expect((await store.listItems())[0].text).toBe("回复先给结论，再给细节。");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not let a title-only edit bypass body validation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = target();
      await store.appendItem(item);
      const entry = queue(decision("merge_into", item.id));
      const suggestion = {
        ...suggestionFor(entry, "merge_into", item.title, item.text, item),
        validation: { ok: false, errors: ["正文校验失败"], warnings: [] },
      };
      await store.upsertQueue({ ...entry, suggestion, suggestionState: "ready" });
      const result = await applySuggestion(store, DEFAULT_CONFIG, entry.id, {
        title: "只改标题",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("校验");
      expect(await store.listQueue()).toHaveLength(1);
      expect((await store.listItems())[0].title).toBe(item.title);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses an edit that reject_duplicate would silently drop", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = target();
      await store.appendItem(item);
      const entry = queue(decision("reject_duplicate", item.id));
      const suggestion = suggestionFor(
        entry,
        "reject_duplicate",
        entry.title,
        entry.text,
        item,
      );
      await store.upsertQueue({ ...entry, suggestion, suggestionState: "ready" });
      const result = await applySuggestion(store, DEFAULT_CONFIG, entry.id, {
        title: "改标题",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("归档候选原文");
      expect(await store.listQueue()).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses a pending or failed suggestion", async () => {
    for (const state of ["pending", "failed"] as const) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
      try {
        const store = new Store(dir);
        await store.init();
        const item = target();
        await store.appendItem(item);
        const entry = queue(decision("merge_into", item.id));
        const suggestion = suggestionFor(entry, "merge_into", item.title, item.text, item);
        await store.upsertQueue({ ...entry, suggestion, suggestionState: state });
        const result = await applySuggestion(store, DEFAULT_CONFIG, entry.id);
        expect(result.ok, state).toBe(false);
        expect(result.error, state).toMatch(/生成|校验/);
        expect(await store.listQueue()).toHaveLength(1);
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });

  it("revalidates a stored merge suggestion at write time", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = {
        ...target(),
        text: "启动 dev server 时使用 nohup",
        title: "[P] 启动 dev server",
      };
      await store.appendItem(item);
      const entry = {
        ...queue(decision("merge_into", item.id)),
        text: "不要使用 nohup 启动 dev server",
        title: "[P] 不要 nohup",
      };
      const suggestion = suggestionFor(entry, "merge_into", item.title, item.text, item);
      await store.upsertQueue({ ...entry, suggestion, suggestionState: "ready" });
      const result = await applySuggestion(store, DEFAULT_CONFIG, entry.id);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("否定");
      expect(await store.listQueue()).toHaveLength(1);
      expect((await store.listItems())[0].text).toBe(item.text);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("marks a rewrite that fails validation as failed instead of ready", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = {
        ...target(),
        kind: "fact" as const,
        text: "本地 dev server 端口是 5199，启动前检查端口是否被占用",
        title: "[F] 端口 5199",
      };
      await store.appendItem(item);
      const entry = {
        ...queue(decision("merge_into", item.id)),
        text: "启动前检查 5198 是否被占用",
        title: "[F] 检查端口",
        kind: "fact" as const,
      };
      await store.upsertQueue(entry);
      const config = mergeConfig({ thresholds: { memoryMaxChars: 20, titleMaxChars: 20 } });
      const suggestion = await buildSuggestion(
        { store, config },
        entry,
        entry.decision ?? decision("merge_into", item.id),
        item,
      );
      expect(suggestion.validation.ok).toBe(false);
      const row = (await store.listQueue())[0];
      expect(row.suggestionState).toBe("failed");
      expect(row.suggestionError).toBeTruthy();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses a stale merge suggestion without changing the newer target", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = target();
      await store.appendItem(item);
      const entry = queue(decision("merge_into", item.id));
      await store.upsertQueue(entry);
      await buildSuggestion({ store, config: DEFAULT_CONFIG }, entry, entry.decision, item);
      await store.updateItem(item.id, { text: "用户最新编辑内容" });
      const result = await applySuggestion(store, DEFAULT_CONFIG, entry.id);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("重新生成");
      expect((await store.listItems())[0].text).toBe("用户最新编辑内容");
      expect(await store.listQueue()).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("refuses undo when the merged target has been edited later", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = target();
      await store.appendItem(item);
      const entry = queue(decision("merge_into", item.id));
      await store.upsertQueue(entry);
      await buildSuggestion({ store, config: DEFAULT_CONFIG }, entry, entry.decision, item);
      const applied = await applySuggestion(store, DEFAULT_CONFIG, entry.id);
      await store.updateItem(item.id, { text: "用户后来修改的内容" });
      expect((await undoMerge(store, applied.journalID ?? "")).ok).toBe(false);
      expect((await store.listItems())[0].text).toBe("用户后来修改的内容");
      expect(await store.listQueue()).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects a merge into another project's item", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = { ...target(), scope: "project" as const, projectKey: "A" };
      await store.appendItem(item);
      const entry = { ...queue(decision("merge_into", item.id)), scope: "project" as const, projectKey: "A" };
      await store.upsertQueue(entry);
      await buildSuggestion({ store, config: DEFAULT_CONFIG }, entry, entry.decision, item);
      await store.patchQueue([{ id: entry.id, patch: { projectKey: "B" } }]);
      const result = await applySuggestion(store, DEFAULT_CONFIG, entry.id);
      expect(result.ok).toBe(false);
      expect((await store.listItems()).find((candidate) => candidate.id === item.id)?.text).toBe(item.text);
      expect(await store.listQueue()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("merges into the target and undoes within the window", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = target();
      await store.appendItem(item);
      const entry = queue(decision("merge_into", item.id));
      await store.upsertQueue(entry);
      const suggestion = await buildSuggestion(
        { store, config: DEFAULT_CONFIG },
        entry,
        entry.decision as DecisionResult,
        item,
      );
      expect(suggestion.action).toBe("merge_into");
      expect(suggestion.validation.ok).toBe(true);

      const applied = await applySuggestion(store, DEFAULT_CONFIG, entry.id);
      expect(applied.ok).toBe(true);
      expect(await store.listQueue()).toEqual([]);
      const updated = (await store.listItems()).find((candidate) => candidate.id === item.id);
      expect(updated?.seenCount).toBe(2);
      const journal = await store.listJournal();
      expect(journal).toHaveLength(1);

      const undone = await undoMerge(store, journal[0].id);
      expect(undone.ok).toBe(true);
      const restored = (await store.listItems()).find((candidate) => candidate.id === item.id);
      expect(restored?.seenCount).toBe(1);
      expect(restored?.manual).toBeUndefined();
      expect(await store.listQueue()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["create", "keep_both"] as const)(
    "records the created entry for %s undo so the preview can archive it",
    async (action) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
      try {
        const store = new Store(dir);
        await store.init();
        const entry = queue(decision(action, ""));
        entry.suggestion = suggestionFor(entry, action, "[P] 另存条目", "另存正文");
        await store.upsertQueue(entry);

        const applied = await applySuggestion(store, DEFAULT_CONFIG, entry.id);
        expect(applied.ok).toBe(true);
        const journal = await store.listJournal();
        expect(journal).toHaveLength(1);
        const recorded = journal[0];
        expect(recorded.action).toBe(action);
        expect(recorded.before.queue.title).toBe(entry.title);
        expect(recorded.before.target).toBeUndefined();
        expect(recorded.after.item?.title).toBe("[P] 另存条目");
        expect(recorded.after.item?.text).toBe("另存正文");
        expect(recorded.after.target).toBeUndefined();

        const undone = await undoMerge(store, recorded.id);
        expect(undone.ok).toBe(true);
        const archived = (await store.listItems()).find(
          (candidate) => candidate.id === recorded.after.item?.id,
        );
        expect(archived?.status).toBe("archived");
        expect(archived?.supersededBy).toBe("undo");
        expect((await store.listQueue()).map((candidate) => candidate.id)).toEqual([entry.id]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("records replace before/after snapshots so undo can restore the target", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = target();
      await store.appendItem(item);
      const entry = queue(decision("replace", item.id));
      entry.suggestion = suggestionFor(
        entry,
        "replace",
        "[P] 替换后的目标",
        "替换后的正文",
        item,
      );
      await store.upsertQueue(entry);

      const applied = await applySuggestion(store, DEFAULT_CONFIG, entry.id);
      expect(applied.ok).toBe(true);
      const journal = await store.listJournal();
      expect(journal).toHaveLength(1);
      const recorded = journal[0];
      expect(recorded.action).toBe("replace");
      expect(recorded.before.target?.title).toBe(item.title);
      expect(recorded.before.target?.text).toBe(item.text);
      expect(recorded.after.target?.title).toBe("[P] 替换后的目标");
      expect(recorded.after.target?.text).toBe("替换后的正文");
      expect(recorded.after.item).toBeUndefined();

      const undone = await undoMerge(store, recorded.id);
      expect(undone.ok).toBe(true);
      const restored = (await store.listItems()).find(
        (candidate) => candidate.id === item.id,
      );
      expect(restored?.title).toBe(item.title);
      expect(restored?.text).toBe(item.text);
      expect((await store.listQueue()).map((candidate) => candidate.id)).toEqual([entry.id]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resumes an interrupted undo after a partial item restore, even past 24h", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const entry = queue(decision("create", ""));
      entry.suggestion = suggestionFor(entry, "create", "[P] 中断撤销", "中断撤销正文");
      await store.upsertQueue(entry);
      const applied = await applySuggestion(store, DEFAULT_CONFIG, entry.id);
      expect(applied.ok).toBe(true);
      const recorded = (await store.listJournal())[0];
      const createdID = recorded.after.item?.id;
      expect(createdID).toBeDefined();

      // Simulate a crash after the item write but before the queue restore.
      await store.updateJournal(recorded.id, {
        undoing: true,
        at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      });
      const items = await store.listItems();
      const intended: Item[] = items.map((item): Item =>
        item.id === createdID
          ? { ...item, status: "archived", supersededBy: "undo" }
          : item,
      );
      await store.replaceItems(intended);
      expect(await store.listQueue()).toEqual([]);

      const resumed = await undoMerge(store, recorded.id);
      expect(resumed.ok).toBe(true);
      expect((await store.listQueue()).map((candidate) => candidate.id)).toEqual([entry.id]);
      const journal = await store.listJournal();
      expect(journal[0].undone).toBe(true);
      expect(journal[0].undoing).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a duplicate and archives the candidate", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-apply-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = target();
      await store.appendItem(item);
      const entry = queue(decision("reject_duplicate", item.id));
      await store.upsertQueue(entry);
      const suggestion = await buildSuggestion(
        { store, config: DEFAULT_CONFIG },
        entry,
        entry.decision as DecisionResult,
        item,
      );
      expect(suggestion.action).toBe("reject_duplicate");

      const applied = await applySuggestion(store, DEFAULT_CONFIG, entry.id);
      expect(applied.ok).toBe(true);
      expect(await store.listQueue()).toEqual([]);
      const items = await store.listItems();
      expect(items.some((candidate) => candidate.status === "archived")).toBe(true);
      const updated = items.find((candidate) => candidate.id === item.id);
      expect(updated?.seenCount).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
