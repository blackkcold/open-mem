import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { applyQueueDecision } from "../src/actions.js";
import { queueItemSnapshotVersion } from "../src/fingerprint.js";
import type { DecisionResult, Item, QueueItem, Suggestion } from "../src/types.js";

const now = new Date().toISOString();

function queue(id: string, title: string, text: string): QueueItem {
  return {
    id,
    title,
    text,
    kind: "preference",
    scope: "global",
    status: "queue",
    source: {},
    createdAt: now,
    updatedAt: now,
    priority: 70,
    priorityBreakdown: { risk: 0.2, impact: 0.9, uncertainty: 0.1, age: 0 },
    reason: "test",
    diff: `+ ${text}`,
    jev: {
      kind: "preference",
      duplicate: 0,
      safeAuto: 0.96,
      risk: 0.1,
      confidence: 0.9,
      strictness: "preference",
      reasons: [],
      source: "heuristic",
    },
  };
}

function projectQueue(
  id: string,
  item: Partial<QueueItem> = {},
  suggestion: Partial<Suggestion> = {},
): QueueItem {
  const base = {
    ...queue(id, "[P] 项目安全新建", "本项目采用 pnpm 安装依赖"),
    scope: "project" as const,
    projectKey: "proj-a",
    project: "/repo/a",
    decision: {
      kind: "preference" as const,
      duplicate: 0,
      safeAuto: 0.8,
      risk: 0.1,
      confidence: 0.96,
      strictness: "preference" as const,
      reasons: ["test"],
      source: "heuristic" as const,
      mergeAction: "create" as const,
      conflict: 0,
    } satisfies DecisionResult,
    ...item,
  };
  return {
    ...base,
    suggestion: {
      id: `sug-${id}`,
      queueID: id,
      action: "create",
      proposedTitle: base.title,
      proposedText: base.text,
      preserved: [base.text],
      dropped: [],
      rationale: "test",
      confidence: 0.96,
      source: "composer",
      validation: { ok: true, errors: [], warnings: [] },
      createdAt: now,
      ...suggestion,
    },
    suggestionState: "ready",
  };
}

describe("queue actions", () => {
  it("resumes recovery interrupted after archiving the produced item", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("crash", "偏好", "回复先给结论"));
      await applyQueueDecision(store, DEFAULT_CONFIG, "crash", { action: "approve" });
      const history = (await store.listChangelog()).find((entry) => entry.action === "approve");
      const id = String(history?.recoveryID);
      const file = path.join(dir, "recovery", `${id}.json`);
      const record = JSON.parse(await readFile(file, "utf8")) as { queue: QueueItem; item: QueueItem };
      await writeFile(file, JSON.stringify({ ...record, restoring: true }));
      await store.replaceItems([{ ...record.item, status: "archived", supersededBy: id }]);
      await store.restoreQueueAction(id);
      expect((await store.listQueue()).map((entry) => entry.id)).toEqual(["crash"]);
      expect((await store.listItems())[0].status).toBe("archived");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("does not bypass capacity limits through promotion", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue({ ...queue("p", "偏好", "回复先给结论"), scope: "session" });
      const result = await applyQueueDecision(store, { ...DEFAULT_CONFIG, caps: { ...DEFAULT_CONFIG.caps, diskBytes: 1 } }, "p", { action: "promote", targetScope: "global", confirmedByUser: true });
      expect(result.ok).toBe(false);
      expect(await store.listItems()).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("records a recoverable denial with project metadata intact", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue({ ...queue("recover", "项目偏好", "项目使用 pnpm"), scope: "project", projectKey: "A" });
      await applyQueueDecision(store, DEFAULT_CONFIG, "recover", { action: "deny" });
      const history = (await store.listChangelog()).find((entry) => entry.action === "deny");
      expect(history?.recoveryID).toEqual(expect.any(String));
      expect((await store.listItems())[0].projectKey).toBe("A");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("applies a double-click approval only once", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("once", "偏好", "回复先给结论"));
      await Promise.all([store, new Store(dir)].map((entry) => applyQueueDecision(entry, DEFAULT_CONFIG, "once", { action: "approve", confirmedByUser: true })));
      expect(await store.listItems()).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("does not allow an agent to approve a turn-origin rule", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue({ ...queue("rule", "[R] 格式", "每次回复先给结论"), kind: "rule" });
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "rule", { action: "approve" });
      expect(result.ok).toBe(false);
      expect(await store.listItems()).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("approve writes AUTO_MEMORY and removes the queue item", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1", "[P] 先给结论", "回复先给结论"));
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "q1", { action: "approve", note: "test" });
      expect(result.ok).toBe(true);
      expect(result.target).toBe("AUTO_MEMORY.md");
      expect(await store.listQueue()).toEqual([]);
      expect(await store.readAutoMemory()).toContain("回复先给结论");
      const items = await store.listItems();
      expect(items.length).toBe(1);
      expect(items[0].status).toBe("auto");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to approve an exact duplicate without an acknowledgement", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem({
        id: "existing",
        title: "[P] 先给结论",
        text: "回复先给结论",
        kind: "preference",
        scope: "global",
        status: "auto",
        source: {},
        createdAt: now,
        updatedAt: now,
      });
      await store.upsertQueue(queue("dup", "[P] 先给结论", "回复先给结论"));
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "dup", { action: "approve" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("重复");
      expect(await store.listQueue()).toHaveLength(1);
      expect((await store.listItems()).filter((entry) => entry.status === "auto")).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("requires an acknowledgement for a conflict and binds it to the version", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem({
        id: "port-5199",
        title: "[F] 端口",
        text: "本地 dev server 端口是 5199",
        kind: "fact",
        scope: "global",
        status: "auto",
        source: {},
        createdAt: now,
        updatedAt: now,
      });
      await store.upsertQueue({ ...queue("port-5198", "[F] 端口", "本地 dev server 端口是 5198"), kind: "fact" });

      const first = await applyQueueDecision(store, DEFAULT_CONFIG, "port-5198", { action: "approve" });
      expect(first.ok).toBe(false);
      expect(first.conflict).toBe(true);
      expect(first.code).toBe("RELATION_ACK_REQUIRED");
      expect(first.conflicts?.[0]).toMatchObject({ id: "port-5199", relation: "conflict" });
      expect(await store.listQueue()).toHaveLength(1);

      const stale = await applyQueueDecision(store, DEFAULT_CONFIG, "port-5198", {
        action: "approve",
        acknowledgedRelations: [{ id: "port-5199", relation: "conflict", version: "stale" }],
      });
      expect(stale.ok).toBe(false);
      expect(stale.conflict).toBe(true);
      expect(await store.listQueue()).toHaveLength(1);

      const version = first.conflicts?.[0]?.version ?? "";
      const allowed = await applyQueueDecision(store, DEFAULT_CONFIG, "port-5198", {
        action: "approve",
        acknowledgedRelations: [{ id: "port-5199", relation: "conflict", version }],
      });
      expect(allowed.ok).toBe(true);
      const changelog = (await store.listChangelog()).find((entry) => entry.action === "approve");
      expect(changelog?.acknowledgedRelations).toEqual([
        { id: "port-5199", relation: "conflict", version },
      ]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("still requires an acknowledgement when the wording around the value changes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem({
        id: "port-worded",
        title: "[F] 端口",
        text: "本地端口为 5199",
        kind: "fact",
        scope: "global",
        status: "auto",
        source: {},
        createdAt: now,
        updatedAt: now,
      });
      await store.upsertQueue({ ...queue("port-worded-q", "[F] 端口", "本地端口是 5198"), kind: "fact" });
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "port-worded-q", { action: "approve" });
      expect(result.ok).toBe(false);
      expect(result.conflict).toBe(true);
      expect(result.code).toBe("RELATION_ACK_REQUIRED");
      expect(await store.listQueue()).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses to approve while an unhandled suggestion exists unless it is ignored", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(projectQueue("with-suggestion"));
      const blocked = await applyQueueDecision(store, DEFAULT_CONFIG, "with-suggestion", { action: "approve" });
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toContain("建议");
      expect(await store.listQueue()).toHaveLength(1);

      const allowed = await applyQueueDecision(store, DEFAULT_CONFIG, "with-suggestion", {
        action: "approve",
        ignoreSuggestion: true,
      });
      expect(allowed.ok).toBe(true);
      const changelog = (await store.listChangelog()).find((entry) => entry.action === "approve");
      expect(changelog?.ignoredSuggestion).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("records a human edit without copying the body into the changelog", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("edited", "[P] 先给结论", "回复先给结论"));
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "edited", {
        action: "approve",
        confirmedByUser: true,
        title: "[R] 先给结论",
        text: "回复先给结论，最多三点",
      });
      expect(result.ok).toBe(true);
      const changelog = (await store.listChangelog()).find((entry) => entry.action === "approve");
      expect(changelog?.humanEdited).toBe(true);
      expect(changelog?.editedFields).toEqual(["title", "text"]);
      expect(JSON.stringify(changelog)).not.toContain("最多三点");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not promote a candidate that duplicates a pending queue row", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue({ ...queue("session-1", "[P] 先给结论", "回复先给结论"), scope: "session" });
      await store.upsertQueue(queue("pending-dup", "[P] 先给结论", "回复先给结论"));
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "session-1", {
        action: "promote",
        targetScope: "global",
        confirmedByUser: true,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("重复");
      expect(await store.listQueue()).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("requires an acknowledgement to promote over a pending conflict", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue({ ...queue("session-version", "[F] 版本", "部署版本是 1.2.3"), scope: "session", kind: "fact" });
      await store.upsertQueue({ ...queue("pending-version", "[F] 版本", "部署版本是 1.2.4"), kind: "fact" });
      const first = await applyQueueDecision(store, DEFAULT_CONFIG, "session-version", {
        action: "promote",
        targetScope: "global",
        confirmedByUser: true,
      });
      expect(first.ok).toBe(false);
      expect(first.conflict).toBe(true);
      expect(first.conflicts?.[0]?.relation).toBe("conflict");
      const version = first.conflicts?.[0]?.version ?? "";
      const allowed = await applyQueueDecision(store, DEFAULT_CONFIG, "session-version", {
        action: "promote",
        targetScope: "global",
        confirmedByUser: true,
        acknowledgedRelations: [{ id: "pending-version", relation: "conflict", version }],
      });
      expect(allowed.ok).toBe(true);
      const changelog = (await store.listChangelog()).find((entry) => entry.action === "promote");
      expect(changelog?.acknowledgedRelations).toEqual([
        { id: "pending-version", relation: "conflict", version },
      ]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("requires every pending conflict to be acknowledged on promote", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue({ ...queue("session-all", "[F] 版本", "部署版本是 1.2.3"), scope: "session", kind: "fact" });
      await store.upsertQueue({ ...queue("pending-one", "[F] 版本", "部署版本为 1.2.4"), kind: "fact" });
      await store.upsertQueue({ ...queue("pending-two", "[F] 版本", "部署版本改为 1.2.5"), kind: "fact" });
      const first = await applyQueueDecision(store, DEFAULT_CONFIG, "session-all", {
        action: "promote",
        targetScope: "global",
        confirmedByUser: true,
      });
      expect(first.ok).toBe(false);
      expect(first.conflicts?.map((entry) => entry.id).sort()).toEqual([
        "pending-one",
        "pending-two",
      ]);
      const partial = await applyQueueDecision(store, DEFAULT_CONFIG, "session-all", {
        action: "promote",
        targetScope: "global",
        confirmedByUser: true,
        acknowledgedRelations: [first.conflicts![0]],
      });
      expect(partial.ok).toBe(false);
      expect(partial.conflicts).toHaveLength(1);
      const allowed = await applyQueueDecision(store, DEFAULT_CONFIG, "session-all", {
        action: "promote",
        targetScope: "global",
        confirmedByUser: true,
        acknowledgedRelations: first.conflicts!.map(({ id, relation, version }) => ({
          id,
          relation,
          version,
        })),
      });
      expect(allowed.ok).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("deny archives, edit updates, defer snoozes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1", "[P] one", "one preference"));
      await store.upsertQueue(queue("q2", "[P] two", "two preference"));
      await store.upsertQueue(queue("q3", "[P] three", "three preference"));

      await applyQueueDecision(store, DEFAULT_CONFIG, "q1", { action: "deny" });
      const items = await store.listItems();
      expect(items.some((item) => item.status === "archived")).toBe(true);

      await applyQueueDecision(store, DEFAULT_CONFIG, "q2", {
        action: "edit",
        title: "[P] two edited",
        text: "two preference edited",
        confirmedByUser: true,
      });
      const edited = (await store.listQueue()).find((item) => item.id === "q2");
      expect(edited?.title).toBe("[P] two edited");

      await applyQueueDecision(store, DEFAULT_CONFIG, "q3", { action: "defer" });
      const deferred = (await store.listQueue()).find((item) => item.id === "q3");
      expect(deferred?.deferredUntil).toBeTruthy();
      expect(new Date(deferred?.deferredUntil ?? 0).getTime()).toBeGreaterThan(Date.now());
      await applyQueueDecision(store, DEFAULT_CONFIG, "q3", { action: "resume" });
      expect((await store.listQueue()).find((item) => item.id === "q3")?.deferredUntil).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns the persisted decisionVersion for defer and resume", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("defer-version", "[P] 延后版本", "延后版本测试"));
      const deferred = await applyQueueDecision(store, DEFAULT_CONFIG, "defer-version", {
        action: "defer",
      });
      expect(deferred.ok).toBe(true);
      expect(deferred.decisionVersion).toEqual(expect.any(String));
      const deferredRow = (await store.listQueue()).find((item) => item.id === "defer-version");
      expect(deferredRow?.deferredUntil).toBeTruthy();
      expect(deferred.item).toEqual(deferredRow);
      expect(deferred.decisionVersion).toBe(queueItemSnapshotVersion(deferredRow!));

      const resumed = await applyQueueDecision(store, DEFAULT_CONFIG, "defer-version", {
        action: "resume",
        expectedVersion: deferred.decisionVersion,
      });
      expect(resumed.ok).toBe(true);
      expect(resumed.decisionVersion).toEqual(expect.any(String));
      const resumedRow = (await store.listQueue()).find((item) => item.id === "defer-version");
      expect(resumedRow?.deferredUntil).toBeUndefined();
      expect(resumed.item).toEqual(resumedRow);
      expect(resumed.decisionVersion).toBe(queueItemSnapshotVersion(resumedRow!));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the deferred row cannot be re-read", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("defer-vanish", "[P] 延后消失", "延后消失测试"));
      const originalListQueue = store.listQueue.bind(store);
      let calls = 0;
      store.listQueue = async () => {
        calls += 1;
        if (calls >= 2) return [];
        return originalListQueue();
      };
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "defer-vanish", {
        action: "defer",
      });
      store.listQueue = originalListQueue;
      expect(result.ok).toBe(false);
      expect(result.decisionVersion).toBeUndefined();
      const row = (await store.listQueue()).find((item) => item.id === "defer-vanish");
      expect(row?.deferredUntil).toBeUndefined();
      expect(
        (await store.listChangelog()).some(
          (entry) => entry.action === "defer" && entry.queueID === "defer-vanish",
        ),
      ).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("promotes a session candidate to a project with the gate", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue({
        ...queue("q1", "[P] 先给结论", "回复先给结论"),
        scope: "session",
        evidence: [{ messageID: "m1", quote: "先给结论", kind: "user" }],
      });
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "q1", {
        action: "promote",
        targetScope: "project",
        projectKey: "A",
        confirmedByUser: true,
      });
      expect(result.ok).toBe(true);
      const items = await store.listItems();
      expect(items).toHaveLength(1);
      expect(items[0].scope).toBe("project");
      expect(items[0].projectKey).toBe("A");
      expect(await store.listQueue()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a rule promotion without manual confirmation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue({
        ...queue("q1", "[R] 只读", "本次只读"),
        kind: "rule",
        scope: "session",
      });
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "q1", {
        action: "promote",
        targetScope: "global",
        confirmedByUser: false,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("rule requires approval");
      expect(await store.listQueue()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a global promotion with a volatile path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue({
        ...queue("q1", "[F] backup", "备份在 /Users/me/backup"),
        kind: "fact",
        scope: "project",
        projectKey: "A",
      });
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "q1", {
        action: "promote",
        targetScope: "global",
        confirmedByUser: true,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("volatile identifier");
      expect(await store.listQueue()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses approve and apply_suggestion for a session row", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue({
        ...queue("q1", "[P] 本次只读", "这个任务不要修改文件"),
        scope: "session",
      });
      const approve = await applyQueueDecision(store, DEFAULT_CONFIG, "q1", {
        action: "approve",
        confirmedByUser: true,
      });
      expect(approve.ok).toBe(false);
      expect(approve.error).toContain("session");

      const apply = await applyQueueDecision(store, DEFAULT_CONFIG, "q1", {
        action: "apply_suggestion",
        confirmedByUser: true,
      });
      expect(apply.ok).toBe(false);
      expect(apply.error).toContain("session");
      expect(await store.listQueue()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects approve when the linter fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue(queue("q1", "[P] too long", "例如，".repeat(200)));
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "q1", { action: "approve" });
      expect(result.ok).toBe(false);
      expect(await store.listQueue()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a batch suggestion when the queue item changed after screening", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      const original = projectQueue("stale-scope");
      await store.upsertQueue(original);
      const expectedContentHash = queueItemSnapshotVersion(original);
      await store.upsertQueue({
        ...original,
        scope: "global",
        projectKey: undefined,
        project: undefined,
      });
      const result = await applyQueueDecision(
        store,
        DEFAULT_CONFIG,
        original.id,
        { action: "apply_suggestion", confirmedByUser: true },
        { expectedContentHash, action: "apply_suggestion", minConfidence: 0.9 },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("批量筛选后变更");
      expect(await store.listQueue()).toHaveLength(1);
      expect(await store.listItems()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a batch suggestion when the suggestion became unsafe after screening", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      const original = projectQueue("stale-suggestion");
      await store.upsertQueue(original);
      const expectedContentHash = queueItemSnapshotVersion(original);
      await store.upsertQueue({
        ...original,
        suggestion: {
          ...(original.suggestion as Suggestion),
          action: "merge_into",
          confidence: 0.5,
        },
      });
      const result = await applyQueueDecision(
        store,
        DEFAULT_CONFIG,
        original.id,
        { action: "apply_suggestion", confirmedByUser: true },
        { expectedContentHash, action: "apply_suggestion", minConfidence: 0.9 },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("批量筛选后变更");
      expect(await store.listQueue()).toHaveLength(1);
      expect(await store.listItems()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects batch execution when assessment data is missing or unsafe", async () => {
    const cases: Array<[string, QueueItem]> = [
      [
        "missing decision",
        projectQueue("batch-no-decision", { decision: undefined, jev: undefined }),
      ],
      [
        "missing conflict",
        projectQueue("batch-no-conflict", {
          decision: {
            ...(projectQueue("batch-no-conflict").decision as DecisionResult),
            conflict: undefined,
          },
        }),
      ],
      [
        "NaN risk",
        projectQueue("batch-nan-risk", {
          decision: {
            ...(projectQueue("batch-nan-risk").decision as DecisionResult),
            risk: Number.NaN,
          },
        }),
      ],
      [
        "safety strictness",
        projectQueue("batch-safety", {
          decision: {
            ...(projectQueue("batch-safety").decision as DecisionResult),
            strictness: "safety",
          },
        }),
      ],
    ];
    for (const [name, candidate] of cases) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
      try {
        const store = new Store(dir);
        await store.init();
        await store.upsertQueue(candidate);
        const result = await applyQueueDecision(
          store,
          DEFAULT_CONFIG,
          candidate.id,
          { action: "apply_suggestion", confirmedByUser: true },
          {
            expectedContentHash: queueItemSnapshotVersion(candidate),
            action: "apply_suggestion",
            minConfidence: 0.9,
          },
        );
        expect(result.ok, name).toBe(false);
        expect(await store.listQueue(), name).toHaveLength(1);
        expect(await store.listItems(), name).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("rejects a batch suggestion when its proposed text changes but remains valid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      const original = projectQueue("stale-text");
      await store.upsertQueue(original);
      const expectedContentHash = queueItemSnapshotVersion(original);
      await store.upsertQueue({
        ...original,
        suggestion: {
          ...(original.suggestion as Suggestion),
          proposedText: `${original.text}，并且保持安全`,
        },
      });
      const result = await applyQueueDecision(
        store,
        DEFAULT_CONFIG,
        original.id,
        { action: "apply_suggestion", confirmedByUser: true },
        { expectedContentHash, action: "apply_suggestion", minConfidence: 0.9 },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("批量筛选后变更");
      expect(await store.listQueue()).toHaveLength(1);
      expect(await store.listItems()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a still-valid replacement suggestion after preview", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      const original = projectQueue("stale-replacement");
      await store.upsertQueue(original);
      const expectedContentHash = queueItemSnapshotVersion(original);
      await store.upsertQueue({
        ...original,
        suggestion: {
          ...(original.suggestion as Suggestion),
          id: "sug-replacement",
          proposedText: "本项目改用 npm 安装依赖",
        },
      });
      const result = await applyQueueDecision(
        store,
        DEFAULT_CONFIG,
        original.id,
        { action: "apply_suggestion", confirmedByUser: true },
        { expectedContentHash, action: "apply_suggestion", minConfidence: 0.9 },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("批量筛选后变更");
      expect(await store.listQueue()).toHaveLength(1);
      expect(await store.listItems()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a decision risk change even when it stays below the high-risk threshold", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      const original = projectQueue("stale-risk");
      await store.upsertQueue(original);
      const expectedContentHash = queueItemSnapshotVersion(original);
      await store.upsertQueue({
        ...original,
        decision: {
          ...(original.decision as DecisionResult),
          risk: 0.2,
        },
      });
      const result = await applyQueueDecision(
        store,
        DEFAULT_CONFIG,
        original.id,
        { action: "apply_suggestion", confirmedByUser: true },
        { expectedContentHash, action: "apply_suggestion", minConfidence: 0.9 },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("批量筛选后变更");
      expect(await store.listQueue()).toHaveLength(1);
      expect(await store.listItems()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("applies a validated project create through the batch context", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      const candidate = projectQueue("batch-valid");
      await store.upsertQueue(candidate);
      const result = await applyQueueDecision(
        store,
        DEFAULT_CONFIG,
        candidate.id,
        { action: "apply_suggestion", confirmedByUser: true },
        {
          expectedContentHash: queueItemSnapshotVersion(candidate),
          action: "apply_suggestion",
          minConfidence: 0.9,
        },
      );
      expect(result.ok).toBe(true);
      expect(await store.listQueue()).toEqual([]);
      expect((await store.listItems()).some((entry) => entry.text === candidate.text)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records the trusted decision source without candidate text", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      const secret = "SYNTHETIC_CANDIDATE_BODY_SHOULD_NOT_BE_LOGGED";
      await store.upsertQueue(queue("q-source", "[P] 来源", secret));
      const result = await applyQueueDecision(
        store,
        DEFAULT_CONFIG,
        "q-source",
        { action: "deny" },
        undefined,
        { source: "agent-tool" },
      );
      expect(result.ok).toBe(true);
      const entry = (await store.listChangelog()).find(
        (row) => row.action === "deny" && row.queueID === "q-source",
      );
      expect(entry?.source).toBe("agent-tool");
      expect(JSON.stringify(entry)).not.toContain(secret);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records apply-suggestion provenance without candidate text", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      const candidate = projectQueue("q-apply-source");
      await store.upsertQueue(candidate);
      const result = await applyQueueDecision(
        store,
        DEFAULT_CONFIG,
        candidate.id,
        { action: "apply_suggestion", confirmedByUser: true },
        undefined,
        { source: "local-token-api" },
      );
      expect(result.ok).toBe(true);
      const entry = (await store.listChangelog()).find(
        (row) =>
          row.action === "apply_suggestion_surface" &&
          row.queueID === candidate.id,
      );
      expect(entry?.source).toBe("local-token-api");
      expect(JSON.stringify(entry)).not.toContain(candidate.text);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still approves a single rule through the user decision lane", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-actions-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.upsertQueue({
        ...queue("rule-single", "[R] 单条规则", "回复必须使用 Markdown 格式"),
        kind: "rule",
      });
      const result = await applyQueueDecision(store, DEFAULT_CONFIG, "rule-single", {
        action: "approve",
        confirmedByUser: true,
      });
      expect(result.ok).toBe(true);
      expect(await store.readAutoRules()).toContain("回复必须使用 Markdown 格式");
      expect(await store.listQueue()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
