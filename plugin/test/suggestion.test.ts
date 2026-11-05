import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { buildSuggestion } from "../src/suggestion.js";
import type { DecisionResult, Item, QueueItem } from "../src/types.js";

const decision: DecisionResult = {
  kind: "rule",
  duplicate: 0.96,
  safeAuto: 0.4,
  risk: 0.3,
  confidence: 0.95,
  strictness: "workflow",
  reasons: ["test"],
  source: "systemone",
  mergeAction: "reject_duplicate",
};

function queueItem(): QueueItem {
  const now = new Date().toISOString();
  return {
    id: "queue_duplicate",
    title: "[R] 给出精确路径和行号",
    text: "给出精确文件路径和行号/脚本片段依据",
    kind: "rule",
    scope: "global",
    status: "queue",
    source: { sessionID: "s1", messageID: "m1", role: "user" },
    createdAt: now,
    updatedAt: now,
    reason: "duplicate/overlap 96%",
    decision,
    seenCount: 1,
    lastSeenAt: now,
    sources: [{ sessionID: "s1", messageID: "m1", role: "user" }],
  };
}

describe("buildSuggestion", () => {
  it("does not resurrect a removed queue item after suggestion generation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-suggestion-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = queueItem();
      await store.upsertQueue(item);
      await store.removeQueue(item.id);
      await buildSuggestion({ store, config: DEFAULT_CONFIG }, item, decision);
      expect(await store.listQueue()).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("does not expose an item from another project as a merge target", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-suggestion-"));
    try {
      const store = new Store(dir);
      await store.init();
      const candidate = { ...queueItem(), kind: "preference" as const, scope: "project" as const, projectKey: "B" };
      const target: Item = { id: "foreign", title: "A", text: "项目 A 的信息", kind: "preference", scope: "project", projectKey: "A", status: "auto", source: {}, createdAt: candidate.createdAt, updatedAt: candidate.updatedAt };
      await store.upsertQueue(candidate);
      const suggestion = await buildSuggestion({ store, config: DEFAULT_CONFIG }, candidate, { ...decision, kind: "preference", mergeAction: "merge_into", mergeTargetId: target.id }, target);
      expect(suggestion.targetId).toBeUndefined();
      expect(suggestion.proposedText).not.toContain(target.text);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("keeps reject_duplicate when the target is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-suggestion-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = queueItem();
      await store.writeQueue([item]);
      const suggestion = await buildSuggestion(
        { store, config: mergeConfig(DEFAULT_CONFIG, { rewrite: { enabled: false } }) },
        item,
        decision,
      );
      expect(suggestion.action).toBe("reject_duplicate");
      expect(suggestion.proposedText).toBe(item.text);
      expect(suggestion.targetId).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
