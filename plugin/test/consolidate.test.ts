import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { canAutoApply, extractCandidates, runConsolidation } from "../src/consolidate.js";
import type { DecisionProvider, HookRecord, JevResult, SessionMessage } from "../src/types.js";

const preferenceJev: JevResult = {
  kind: "preference",
  duplicate: 0,
  safeAuto: 0.96,
  risk: 0.1,
  confidence: 0.9,
  strictness: "preference",
  reasons: ["test"],
  source: "heuristic",
};

const riskyRuleJev: JevResult = {
  kind: "rule",
  duplicate: 0,
  safeAuto: 0.2,
  risk: 0.92,
  confidence: 0.5,
  strictness: "safety",
  reasons: ["test"],
  source: "heuristic",
};

const queuePreferenceJev: JevResult = {
  ...preferenceJev,
  safeAuto: 0.8,
};

function provider(result: JevResult): DecisionProvider {
  return { async classify() { return result; } };
}

function capacityBlockedHook(id: string, text: string, createdAt: string): HookRecord {
  return {
    id,
    key: id,
    sessionID: "s-starve",
    turnID: "t-old",
    messageID: `m-${id}`,
    text,
    title: `[P] ${text}`,
    trigger: "test",
    scope: "global",
    source: {},
    createdAt,
    updatedAt: createdAt,
    status: "blocked",
    attempts: 1,
    decision: queuePreferenceJev,
    error: "capacity: 审批队列已满，请先处理或压缩",
  };
}

function pendingCandidateHook(id: string, text: string, createdAt: string): HookRecord {
  return {
    id,
    key: id,
    sessionID: "s-starve",
    turnID: "t-new",
    messageID: `m-${id}`,
    text,
    title: `[P] ${text}`,
    trigger: "test",
    scope: "global",
    source: {},
    createdAt,
    updatedAt: createdAt,
    status: "pending",
    attempts: 0,
  };
}

const messages: SessionMessage[] = [
  { id: "m1", type: "user", text: "我喜欢回复先给结论" },
  { id: "m2", type: "assistant", text: "好的，以后先给结论。" },
];

describe("runConsolidation", () => {
  it.each(["auto", "queue"])("serializes %s admission with its persisted write", async (lane) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const stores = [new Store(dir), new Store(dir)];
      await stores[0].init();
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const decision = { async classify() { if (++arrived === 2) release(); await gate; return preferenceJev; } };
      const config = mergeConfig({ shadow: false, autoMemory: lane === "auto", caps: { autoMemory: 1, queue: 1 } });
      await Promise.all(stores.map((store, index) => runConsolidation(`s${index}`, { store, config, decision,
        readMessages: async () => [{ id: `m${index}`, type: "user", text: index === 0 ? "我喜欢回复先给结论" : "以后测试失败先检查环境变量" }] })));
      expect((await stores[0].listItems()).filter((item) => item.status === "auto").length).toBeLessThanOrEqual(1);
      expect(await stores[0].listQueue()).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("persists overflow candidates before advancing the scan cursor", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const deps = { store, config: mergeConfig({ turn: { maxCandidates: 1 } }), decision: provider(preferenceJev),
        readMessages: async () => [{ id: "many", type: "user", text: "我喜欢回复使用简体中文。记住构建失败时检查磁盘空间。" }] };
      const first = await runConsolidation("overflow", deps);
      expect(first.captured).toBe(2);
      expect((await store.listHooks()).filter((hook) => hook.status === "pending")).toHaveLength(1);
      await runConsolidation("overflow", deps);
      expect((await store.listHooks()).filter((hook) => hook.status === "pending")).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("retries a capacity-blocked candidate after the queue drains", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const at = new Date().toISOString();
      await store.upsertQueue({ id: "full", title: "占位", text: "不同内容", kind: "fact", scope: "global", status: "queue", source: {}, createdAt: at, updatedAt: at, reason: "test" });
      let calls = 0;
      const deps = { store, config: mergeConfig({ shadow: false, caps: { queue: 1 } }), decision: { async classify() { calls++; return queuePreferenceJev; } }, readMessages: async () => messages };
      await runConsolidation("s1", deps);
      await store.removeQueue("full");
      const next = await runConsolidation("s1", deps);
      expect(next.queued).toBe(1);
      expect(calls).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("processes a new pending candidate before retrying older capacity-blocked ones", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const at = new Date().toISOString();
      await store.upsertQueue({ id: "full", title: "占位", text: "完全不同", kind: "fact", scope: "global", status: "queue", source: {}, createdAt: at, updatedAt: at, reason: "test" });
      await store.appendHook(capacityBlockedHook("old-1", "旧候选一：使用 pnpm 安装依赖", "2026-01-01T00:00:00.000Z"));
      await store.appendHook(capacityBlockedHook("old-2", "旧候选二：构建失败先看日志", "2026-01-01T00:00:01.000Z"));
      await store.appendHook({
        id: "new-1", key: "new-1", sessionID: "s-starve", turnID: "t-new", messageID: "m-new-1",
        text: "以后测试失败先检查磁盘空间", title: "[P] 测试失败先查磁盘", trigger: "test", scope: "global",
        source: {}, createdAt: "2026-01-01T00:00:10.000Z", updatedAt: "2026-01-01T00:00:10.000Z",
        status: "pending", attempts: 0,
      });
      let calls = 0;
      const result = await runConsolidation("s-starve", {
        store,
        config: mergeConfig({ shadow: false, autoMemory: false, caps: { queue: 1 }, turn: { maxCandidates: 2 } }),
        decision: { async classify() { calls++; return queuePreferenceJev; } },
        readMessages: async () => [],
      });
      expect(calls).toBe(1);
      const fresh = (await store.listHooks()).find((hook) => hook.id === "new-1");
      expect(fresh?.status).toBe("blocked");
      expect(fresh?.decision).toBeDefined();
      expect(result.processed).toBe(2);
      expect(await store.listQueue()).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("admits new pending candidates before older blocked retries when the queue has room", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendHook(capacityBlockedHook("old-1", "旧候选一：使用 pnpm 安装依赖", "2026-01-01T00:00:00.000Z"));
      await store.appendHook(capacityBlockedHook("old-2", "旧候选二：构建失败先看日志", "2026-01-01T00:00:01.000Z"));
      await store.appendHook({
        id: "new-1", key: "new-1", sessionID: "s-starve", turnID: "t-new", messageID: "m-new-1",
        text: "以后测试失败先检查磁盘空间", title: "[P] 测试失败先查磁盘", trigger: "test", scope: "global",
        source: {}, createdAt: "2026-01-01T00:00:10.000Z", updatedAt: "2026-01-01T00:00:10.000Z",
        status: "pending", attempts: 0,
      });
      let calls = 0;
      const result = await runConsolidation("s-starve", {
        store,
        config: mergeConfig({ shadow: false, autoMemory: false, caps: { queue: 2 }, turn: { maxCandidates: 2 } }),
        decision: { async classify() { calls++; return queuePreferenceJev; } },
        readMessages: async () => [],
      });
      expect(result.queued).toBe(2);
      expect(calls).toBe(1);
      const queue = await store.listQueue();
      expect(queue).toHaveLength(2);
      expect(queue.map((item) => item.hookID)).toContain("new-1");
      const hooks = await store.listHooks();
      expect(hooks.find((hook) => hook.id === "new-1")?.status).toBe("queue");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("gives fresh and retry each a slot when both are waiting and the batch has room", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendHook(capacityBlockedHook("old-1", "旧候选一：使用 pnpm 安装依赖", "2026-01-01T00:00:00.000Z"));
      await store.appendHook(capacityBlockedHook("old-2", "旧候选二：构建失败先看日志", "2026-01-01T00:00:01.000Z"));
      await store.appendHook(pendingCandidateHook("fresh-1", "以后测试失败先检查磁盘空间", "2026-01-01T00:00:10.000Z"));
      await store.appendHook(pendingCandidateHook("fresh-2", "以后提交前先运行一遍 tsc", "2026-01-01T00:00:11.000Z"));
      let calls = 0;
      const result = await runConsolidation("s-starve", {
        store,
        config: mergeConfig({ shadow: false, autoMemory: false, caps: { queue: 5 }, turn: { maxCandidates: 2 } }),
        decision: { async classify() { calls++; return queuePreferenceJev; } },
        readMessages: async () => [],
      });
      expect(result.processed).toBe(2);
      expect(calls).toBe(1);
      const queue = await store.listQueue();
      expect(queue).toHaveLength(2);
      expect(queue.map((item) => item.hookID)).toEqual(expect.arrayContaining(["fresh-1", "old-1"]));
      const hooks = await store.listHooks();
      expect(hooks.find((hook) => hook.id === "fresh-2")?.status).toBe("pending");
      expect(hooks.find((hook) => hook.id === "old-2")?.status).toBe("blocked");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("keeps fresh priority when the batch size is one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendHook(capacityBlockedHook("old-1", "旧候选一：使用 pnpm 安装依赖", "2026-01-01T00:00:00.000Z"));
      await store.appendHook(pendingCandidateHook("fresh-1", "以后提交前先运行一遍 tsc", "2026-01-01T00:00:10.000Z"));
      let calls = 0;
      const result = await runConsolidation("s-starve", {
        store,
        config: mergeConfig({ shadow: false, autoMemory: false, caps: { queue: 5 }, turn: { maxCandidates: 1 } }),
        decision: { async classify() { calls++; return queuePreferenceJev; } },
        readMessages: async () => [],
      });
      expect(result.queued).toBe(1);
      expect(calls).toBe(1);
      const queue = await store.listQueue();
      expect(queue.map((item) => item.hookID)).toEqual(["fresh-1"]);
      const hooks = await store.listHooks();
      expect(hooks.find((hook) => hook.id === "old-1")?.status).toBe("blocked");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects credentials before capture or model classification", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      let called = false;
      await runConsolidation("secret", { store, config: DEFAULT_CONFIG,
        decision: { async classify() { called = true; return preferenceJev; } },
        readMessages: async () => [{ id: "secret-msg", type: "user", text: "记住我的 api_key=sk-synthetic1234567890" }],
      });
      expect(called).toBe(false);
      const stored = JSON.stringify([await store.listHooks(), await store.listShadow(), await store.listQueue(), await store.listChangelog()]);
      expect(stored).not.toContain("sk-synthetic1234567890");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("never auto-writes a rule even when classified as low risk", () => {
    expect(canAutoApply({ config: mergeConfig(DEFAULT_CONFIG, { autoRules: true }), kind: "rule", lintOk: true,
      jev: { ...preferenceJev, kind: "rule", strictness: "format", safeAuto: 1 }, scope: "global", autoCounts: { memory: 0, rules: 0 },
    })).toBe(false);
  });
  it("queues a conflicting candidate instead of auto-writing it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const at = new Date().toISOString();
      await store.appendItem({
        id: "port-5199",
        title: "[F] 端口",
        text: "本地 dev server 端口是 5199",
        kind: "fact",
        scope: "global",
        status: "auto",
        source: {},
        createdAt: at,
        updatedAt: at,
      });
      const result = await runConsolidation("port-guard", {
        store,
        decision: provider({ ...preferenceJev, kind: "fact" }),
        config: mergeConfig(DEFAULT_CONFIG, { shadow: false }),
        readMessages: async () => [{ id: "m-port", type: "user", text: "以后本地 dev server 端口是 5198" }],
      });
      expect(result.auto).toBe(0);
      expect(result.queued).toBe(1);
      const queue = await store.listQueue();
      expect(queue[0]?.reason).toMatch(/conflict|relation/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("queues a partial duplicate when the model still reports a high duplicate score", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const at = new Date().toISOString();
      await store.appendItem({
        id: "conclusion",
        title: "[P] 先给结论",
        text: "回复先给结论",
        kind: "preference",
        scope: "global",
        status: "auto",
        source: {},
        createdAt: at,
        updatedAt: at,
      });
      const result = await runConsolidation("partial-guard", {
        store,
        decision: provider({ ...preferenceJev, duplicate: 0.5 }),
        config: mergeConfig(DEFAULT_CONFIG, {
          shadow: false,
          thresholds: { ...DEFAULT_CONFIG.thresholds, duplicateMax: 0.8 },
        }),
        readMessages: async () => [{ id: "m-partial", type: "user", text: "以后回复先给结论，3 个要点" }],
      });
      expect(result.auto).toBe(0);
      expect(result.queued).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("re-checks the guard inside the transaction and does not duplicate a concurrent write", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      let injected = false;
      const originalTransaction = store.transaction.bind(store);
      store.transaction = async <T>(fn: () => Promise<T>): Promise<T> => {
        if (!injected) {
          injected = true;
          const at = new Date().toISOString();
          await store.appendItem({
            id: "raced",
            title: "[P] 以后回复先给结论",
            text: "以后回复先给结论",
            kind: "preference",
            scope: "global",
            status: "auto",
            source: {},
            createdAt: at,
            updatedAt: at,
          });
        }
        return originalTransaction(fn);
      };
      const result = await runConsolidation("race-session", {
        store,
        decision: provider(preferenceJev),
        config,
        readMessages: async () => [{ id: "m1", type: "user", text: "以后回复先给结论" }],
      });
      expect(result.auto).toBe(0);
      expect(result.skipped).toBe(1);
      expect((await store.listItems()).filter((item) => item.status === "auto")).toHaveLength(1);
      expect((await store.listHooks())[0]?.status).toBe("ignored");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not drop a review candidate whose kind differs from an identical stored text", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const at = new Date().toISOString();
      await store.appendItem({
        id: "pref-1",
        title: "[P] 回复先给结论",
        text: "回复先给结论",
        kind: "preference",
        scope: "global",
        status: "auto",
        source: {},
        createdAt: at,
        updatedAt: at,
      });
      await store.appendHook({
        id: "review-rule",
        key: "review-rule",
        sessionID: "s1",
        turnID: "t1",
        messageID: "m1",
        text: "回复先给结论",
        title: "[R] 回复先给结论",
        trigger: "review",
        scope: "global",
        source: {},
        createdAt: at,
        updatedAt: at,
        status: "pending",
        attempts: 0,
        origin: "session-review",
        reviewType: "rule",
      });
      const result = await runConsolidation("s1", {
        store,
        decision: provider(preferenceJev),
        config: mergeConfig(DEFAULT_CONFIG, { shadow: false }),
        readMessages: async () => [],
      });
      expect(result.skipped).toBe(0);
      expect(result.queued).toBe(1);
      expect((await store.listQueue())[0]?.kind).toBe("rule");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("does not drop a candidate that changes only a port", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const at = new Date().toISOString();
      await store.appendItem({
        id: "port-5199",
        title: "[R] dev server 端口 5199",
        text: "以后本地 dev server 端口是 5199",
        kind: "rule",
        scope: "global",
        status: "auto",
        source: {},
        createdAt: at,
        updatedAt: at,
      });
      const result = await runConsolidation("port-change", {
        store,
        decision: provider(riskyRuleJev),
        config: mergeConfig(DEFAULT_CONFIG, { shadow: false }),
        readMessages: async () => [{ id: "m-port", type: "user", text: "以后本地 dev server 端口是 5198" }],
      });
      expect(result.queued).toBe(1);
      const queue = await store.listQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].text).toContain("5198");
      expect(queue[0].reason).toMatch(/conflict|high risk/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not discard a project candidate because another project has the same text", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const at = new Date().toISOString();
      const text = "这个项目使用 pnpm 安装依赖";
      await store.appendItem({ id: "foreign", title: text, text, kind: "preference", scope: "project", projectKey: "A", status: "auto", source: {}, createdAt: at, updatedAt: at });
      await store.appendHook({ id: "hook-b", key: "hook-b", sessionID: "s-b", turnID: "t-b", messageID: "m-b", text, title: text, trigger: "test", scope: "project", projectKey: "B", source: {}, createdAt: at, updatedAt: at, status: "pending", attempts: 0 });
      const result = await runConsolidation("s-b", {
        store, decision: provider(queuePreferenceJev), config: mergeConfig(DEFAULT_CONFIG, { shadow: false }),
        readMessages: async () => [],
      });
      expect(result.queued).toBe(1);
      expect((await store.listQueue())[0].projectKey).toBe("B");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("auto-writes a low-risk preference when shadow is off", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      const result = await runConsolidation("s1", {
        store,
        decision: provider(preferenceJev),
        config,
        readMessages: async () => messages,
      });
      expect(result.auto).toBe(1);
      expect(result.queued).toBe(0);
      expect(await store.readAutoMemory()).toContain("先给结论");
      expect(await store.listQueue()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queues a risky rule and never writes it automatically", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      const result = await runConsolidation("s1", {
        store,
        decision: provider(riskyRuleJev),
        config,
        readMessages: async () => [
          { id: "m1", type: "user", text: "不要用 nohup 启动 dev server" },
        ],
      });
      expect(result.queued).toBe(1);
      expect((await store.listQueue())[0].kind).toBe("rule");
      expect(await store.readAutoMemory()).not.toContain("nohup");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records a shadow decision when shadow mode is on", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: true });
      const result = await runConsolidation("s1", {
        store,
        decision: provider(preferenceJev),
        config,
        readMessages: async () => messages,
      });
      expect(result.shadowed).toBe(1);
      expect((await store.listShadow()).length).toBe(1);
      expect(await store.listItems()).toEqual([]);
      expect(await store.readAutoMemory()).not.toContain("先给结论");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not process the same last message twice", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      const deps = {
        store,
        decision: provider(preferenceJev),
        config,
        readMessages: async () => messages,
      };
      await runConsolidation("s1", deps);
      const second = await runConsolidation("s1", deps);
      expect(second.processed).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("captures every new user message, not just the last two", () => {
    const allUsers: SessionMessage[] = [
      { id: "m1", type: "user", text: "记住：项目端口是 5199" },
      { id: "m2", type: "user", text: "以后回复先给结论再给细节" },
      { id: "m3", type: "user", text: "禁止用 nohup 启动 dev server" },
    ];
    const candidates = extractCandidates(allUsers, "s1", { max: 10 });
    expect(candidates).toHaveLength(3);
    expect(candidates.map((candidate) => candidate.source.messageID)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
  });

  it("classifies a turn with bounded parallelism", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, {
        shadow: false,
        turn: { parallel: 2, maxCandidates: 12 },
      });
      let active = 0;
      let maxActive = 0;
      const parallelProvider: DecisionProvider = {
        async classify() {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          active -= 1;
          return preferenceJev;
        },
      };
      const turnMessages: SessionMessage[] = [
        { id: "m1", type: "user", text: "记住：项目端口是 5199" },
        { id: "m2", type: "user", text: "以后回复先给结论再给细节" },
        { id: "m3", type: "user", text: "禁止用 nohup 启动 dev server" },
      ];
      const result = await runConsolidation("s1", {
        store,
        decision: parallelProvider,
        config,
        project: "/repo/a",
        projectKey: "proj-a",
        readMessages: async () => turnMessages,
      });
      expect(result.auto).toBe(2);
      expect(result.queued).toBe(1);
      expect(maxActive).toBeGreaterThan(1);
      expect(maxActive).toBeLessThanOrEqual(2);
      expect(await store.listItems()).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never auto-writes a session-scoped candidate", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      const result = await runConsolidation("s1", {
        store,
        decision: provider(preferenceJev),
        config,
        readMessages: async () => [
          { id: "m1", type: "user", text: "这个任务不要修改文件" },
        ],
      });
      expect(result.auto).toBe(0);
      expect(result.queued).toBe(1);
      expect(await store.listItems()).toEqual([]);
      expect(await store.readAutoMemory()).not.toContain("不要修改");
      const queue = await store.listQueue();
      expect(queue[0].scope).toBe("session");
      expect(queue[0].suggestedAction).toBe("promote");
      expect(queue[0].reason).toMatch(/^session-only/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not mark a create queue item as suggestion pending", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      const result = await runConsolidation("s1", {
        store,
        decision: provider(queuePreferenceJev),
        config,
        readMessages: async () => [
          { id: "m1", type: "user", text: "以后回复先给结论，再补充细节" },
        ],
      });
      expect(result.queued).toBe(1);
      const queue = await store.listQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].suggestionState).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not mark a review-origin queue item as suggestion pending", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const now = new Date().toISOString();
      await store.appendHook({
        id: "hook_review_1",
        key: "review|s1|m1|abc",
        sessionID: "s1",
        turnID: "review:r1",
        messageID: "m1",
        text: "以后回复都先给结论",
        title: "[P] 回复先给结论",
        trigger: "review:preference",
        scope: "global",
        source: { sessionID: "s1", messageID: "m1", role: "user" },
        createdAt: now,
        updatedAt: now,
        status: "pending",
        attempts: 0,
        origin: "session-review",
        reviewType: "preference",
        reviewID: "r1",
        evidence: [{ messageID: "m1", quote: "以后回复都先给结论", kind: "user" }],
        reviewConfidence: 0.9,
      });
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      const result = await runConsolidation("s1", {
        store,
        decision: provider(queuePreferenceJev),
        config,
        readMessages: async () => [],
      });
      expect(result.queued).toBe(1);
      const queue = await store.listQueue();
      expect(queue[0].origin).toBe("session-review");
      expect(queue[0].suggestionState).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops a candidate System One marked reject_duplicate", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const now = new Date().toISOString();
      await store.appendItem({
        id: "item_existing",
        title: "[R] 提供精确路径和行号",
        text: "提供精确路径和行号",
        kind: "rule",
        scope: "global",
        status: "auto",
        source: { sessionID: "s0", messageID: "m0", role: "user" },
        createdAt: now,
        updatedAt: now,
        seenCount: 1,
        lastSeenAt: now,
        sources: [{ sessionID: "s0", messageID: "m0", role: "user" }],
      });
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      const result = await runConsolidation("s1", {
        store,
        decision: provider({
          ...preferenceJev,
          kind: "rule",
          duplicate: 0.96,
          safeAuto: 0.4,
          risk: 0.3,
          strictness: "workflow",
          mergeAction: "reject_duplicate",
          mergeTargetId: "item_existing",
        }),
        config,
        readMessages: async () => [
          { id: "m1", type: "user", text: "以后给出精确文件路径和行号/脚本片段依据" },
        ],
      });
      expect(result.queued).toBe(0);
      expect(result.skipped).toBe(1);
      expect(await store.listQueue()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a low-confidence, low-risk rule below queueMinRule", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, {
        shadow: false,
        decision: { queueMinRule: 0.8 },
      });
      const result = await runConsolidation("s1", {
        store,
        decision: provider({
          ...riskyRuleJev,
          safeAuto: 0.7,
          risk: 0.35,
          strictness: "workflow",
        }),
        config,
        readMessages: async () => [
          { id: "m1", type: "user", text: "不要用 nohup 启动 dev server" },
        ],
      });
      expect(result.queued).toBe(0);
      expect(result.skipped).toBe(1);
      expect(await store.listQueue()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records queue-worthy candidates in shadow when shadowRecordAll is on", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, {
        shadow: true,
        shadowRecordAll: true,
      });
      const result = await runConsolidation("s1", {
        store,
        decision: provider(riskyRuleJev),
        config,
        readMessages: async () => [
          { id: "m1", type: "user", text: "禁止用 nohup 启动 dev server" },
        ],
      });
      expect(result.shadowed).toBe(1);
      expect(result.queued).toBe(1);
      expect(await store.listShadow()).toHaveLength(1);
      expect(await store.listQueue()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("extractCandidates", () => {
  it("ignores synthetic and keep-alive user messages", () => {
    const keepAlive =
      "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK";
    const candidates = extractCandidates([
      { id: "m1", type: "user", role: "user", text: "记住：以后回复先给结论" },
      { id: "m2", type: "synthetic", role: "user", text: keepAlive },
      { id: "m3", type: "user", role: "user", text: keepAlive },
    ]);
    expect(candidates.map((candidate) => candidate.text)).toEqual([
      "记住：以后回复先给结论",
    ]);
  });
});
