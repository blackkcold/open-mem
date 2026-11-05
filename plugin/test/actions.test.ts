import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { applyQueueDecision } from "../src/actions.js";
import type { QueueItem } from "../src/types.js";

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
});
