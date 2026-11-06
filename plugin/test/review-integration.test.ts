import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { runConsolidation } from "../src/consolidate.js";
import { applyQueueDecision } from "../src/actions.js";
import { acceptReviewCandidates } from "../src/review/accept.js";
import type {
  DecisionProvider,
  HookRecord,
  QueueItem,
  ReviewRunResult,
  SessionMessage,
} from "../src/types.js";
import type { ReviewInput } from "../src/review/input.js";

const nowIso = () => new Date().toISOString();

const autoReady: DecisionProvider = {
  async classify() {
    return {
      kind: "preference",
      duplicate: 0,
      safeAuto: 0.99,
      risk: 0.05,
      confidence: 0.95,
      strictness: "preference",
      reasons: ["test"],
      source: "heuristic",
      mergeAction: "create",
    };
  },
};

// Short enough that the per-turn capture ignores it; this test isolates the
// review origin so `auto` cannot be incremented by a turn hook.
const messages: SessionMessage[] = [{ id: "m1", type: "user", text: "先看日志" }];

function reviewHook(overrides: Partial<HookRecord> = {}): HookRecord {
  const now = new Date().toISOString();
  return {
    id: "hook_review_1",
    key: "review|s1|m1|abc",
    sessionID: "s1",
    turnID: "review:review_1",
    messageID: "m1",
    text: "回复先给结论再看细节",
    title: "回复先给结论",
    trigger: "review:preference",
    scope: "global",
    source: { sessionID: "s1", messageID: "m1", role: "user" },
    createdAt: now,
    updatedAt: now,
    status: "pending",
    attempts: 0,
    origin: "session-review",
    reviewType: "preference",
    reviewID: "review_1",
    evidence: [{ messageID: "m1", quote: "以后回复先给结论", kind: "user" }],
    reviewConfidence: 0.95,
    ...overrides,
  };
}

describe("session review integration", () => {
  it("does not deduplicate project review candidates against another project", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-review-int-"));
    try {
      const store = new Store(dir);
      await store.init();
      const at = nowIso();
      const text = "项目统一使用 pnpm";
      await store.upsertQueue({ id: "foreign", title: text, text, kind: "preference", scope: "project", projectKey: "A", status: "queue", source: {}, createdAt: at, updatedAt: at, reason: "test" });
      const input: ReviewInput = { sessionID: "s-b", items: [], chars: 0, hash: "b", truncated: false, userCount: 1, toolCount: 0, rawToolChars: 0, sources: { m1: { user: text, tools: [] } } };
      const result: ReviewRunResult = { summary: [], openQuestions: [], model: "test", candidates: [{ type: "preference", text, scope: "project", confidence: 0.9, evidence: [{ messageID: "m1", quote: text, kind: "user" }] }] };
      const accepted = await acceptReviewCandidates(input, result, "review-b", { store, config: DEFAULT_CONFIG, projectKey: "B" });
      expect(accepted.created).toBe(1);
      expect((await store.listHooks())[0].projectKey).toBe("B");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("keeps a project candidate as a session note when no project identity is available", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-review-int-"));
    try {
      const store = new Store(dir);
      await store.init();
      const text = "本项目统一使用 pnpm";
      const input: ReviewInput = {
        sessionID: "s1",
        items: [],
        chars: 0,
        hash: "no-project",
        truncated: false,
        userCount: 1,
        toolCount: 0,
        rawToolChars: 0,
        sources: { m1: { user: text, tools: [] } },
      };
      const result: ReviewRunResult = {
        summary: [],
        openQuestions: [],
        model: "test",
        candidates: [
          {
            type: "preference",
            text,
            scope: "project",
            confidence: 0.9,
            evidence: [{ messageID: "m1", quote: text, kind: "user" }],
          },
        ],
      };
      const accepted = await acceptReviewCandidates(input, result, "review-no-project", {
        store,
        config: DEFAULT_CONFIG,
      });
      expect(accepted.created).toBe(0);
      expect(accepted.sessionNotes).toHaveLength(1);
      expect(await store.listHooks()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queues a review candidate even when the same verdict would auto-write", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-review-int-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      await store.appendHook(reviewHook());

      const result = await runConsolidation("s1", {
        store,
        decision: autoReady,
        config,
        readMessages: async () => messages,
      });

      expect(result.auto).toBe(0);
      expect(result.queued).toBe(1);
      expect(await store.readAutoMemory()).not.toContain("先给结论");
      const queue = await store.listQueue();
      expect(queue[0].origin).toBe("session-review");
      expect(queue[0].reviewType).toBe("preference");
      expect(queue[0].evidence?.[0].quote).toBe("以后回复先给结论");
      expect(queue[0].decision?.source).toBe("review");
      expect(queue[0].reason).toContain("会话复盘");
      expect(queue[0].priority).toBeGreaterThanOrEqual(55);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never lets a review rule reach AUTO_RULES", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-review-int-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      await store.appendHook(
        reviewHook({
          id: "hook_review_2",
          key: "review|s1|m1|def",
          text: "不要用 nohup 启动开发服务器",
          reviewType: "rule",
          trigger: "review:rule",
        }),
      );
      await runConsolidation("s1", {
        store,
        decision: autoReady,
        config,
        readMessages: async () => messages,
      });
      expect(await store.readAutoRules()).not.toContain("nohup");
      expect((await store.listQueue())[0].kind).toBe("rule");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts validated candidates once and skips duplicates", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-review-int-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });

      // A per-turn hook already captured the same sentence.
      await store.appendHook(
        reviewHook({
          id: "hook_turn_1",
          key: "s1|m1|existing",
          origin: undefined,
          text: "回复先给结论",
          reviewType: undefined,
          evidence: undefined,
        }),
      );

      const input: ReviewInput = {
        sessionID: "s1",
        items: [],
        chars: 0,
        hash: "hash",
        truncated: false,
        userCount: 2,
        toolCount: 0,
        rawToolChars: 0,
        sources: {
          m1: { user: "以后回复先给结论", tools: [] },
          m2: { user: "记得回复要用中文，不要用英文", tools: [] },
        },
      };
      const result: ReviewRunResult = {
        summary: [],
        openQuestions: [],
        model: "test",
        candidates: [
          {
            type: "preference",
            text: "回复先给结论",
            scope: "global",
            confidence: 0.9,
            evidence: [{ messageID: "m1", quote: "以后回复先给结论", kind: "user" }],
          },
          {
            type: "preference",
            text: "回复一律使用中文，不要用英文",
            scope: "global",
            confidence: 0.9,
            evidence: [{ messageID: "m2", quote: "记得回复要用中文，不要用英文", kind: "user" }],
          },
        ],
      };

      const first = await acceptReviewCandidates(input, result, "review_1", { store, config });
      expect(first.created).toBe(1);
      expect(first.skipped).toBe(1);

      const second = await acceptReviewCandidates(input, result, "review_1", { store, config });
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(2);

      const hooks = await store.listHooks();
      expect(hooks.filter((hook) => hook.origin === "session-review")).toHaveLength(1);
      const created = hooks.find((hook) => hook.origin === "session-review");
      expect(created?.evidence?.[0].messageID).toBe("m2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps review candidates out of shadow on the default config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-review-int-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, {
        shadow: true,
        shadowRecordAll: true,
      });
      await store.appendHook(
        reviewHook({ id: "hook_shadow", key: "review|s1|m1|shadow" }),
      );
      const result = await runConsolidation("s1", {
        store,
        decision: autoReady,
        config,
        readMessages: async () => messages,
      });
      expect(result.shadowed).toBe(0);
      expect(result.queued).toBe(1);
      expect(await store.listShadow()).toHaveLength(0);
      expect(await store.readAutoMemory()).not.toContain("先给结论");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an agent-initiated approve of a review candidate", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-review-int-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      const item: QueueItem = {
        id: "q_review_gate",
        title: "回复先给结论",
        text: "回复先给结论",
        kind: "preference",
        scope: "global",
        status: "queue",
        source: { sessionID: "s1", messageID: "m1", role: "user" },
        createdAt: nowIso(),
        updatedAt: nowIso(),
        priority: 60,
        reason: "会话复盘 · preference",
        origin: "session-review",
        reviewType: "preference",
        evidence: [{ messageID: "m1", quote: "以后回复先给结论", kind: "user" }],
      };
      await store.upsertQueue(item);

      const refused = await applyQueueDecision(store, config, item.id, {
        action: "approve",
      });
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain("控制台");

      const denied = await applyQueueDecision(store, config, item.id, {
        action: "deny",
      });
      expect(denied.ok).toBe(false);

      const originless: QueueItem = {
        ...item,
        id: "q_review_gate_2",
        title: "构建失败先看日志",
        text: "构建失败时先看日志",
        origin: undefined,
        reviewID: "review_x",
      };
      await store.upsertQueue(originless);
      const refusedOriginless = await applyQueueDecision(store, config, originless.id, {
        action: "approve",
      });
      expect(refusedOriginless.ok).toBe(false);

      const allowed = await applyQueueDecision(store, config, item.id, {
        action: "approve",
        confirmedByUser: true,
      });
      expect(allowed.ok).toBe(true);
      expect(await store.readAutoMemory()).toContain("回复先给结论");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dedupes against ignored turn hooks and existing queue items", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-review-int-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      const at = nowIso();
      await store.appendHook({
        id: "hook_ignored",
        key: "s1|m1|ignored",
        sessionID: "s1",
        turnID: "m1",
        messageID: "m1",
        text: "回复先给结论",
        title: "回复先给结论",
        trigger: "以后",
        scope: "global",
        source: { sessionID: "s1", messageID: "m1", role: "user" },
        createdAt: at,
        updatedAt: at,
        status: "ignored",
        attempts: 1,
      });
      const item: QueueItem = {
        id: "q_turn",
        title: "项目统一使用 pnpm",
        text: "项目统一使用 pnpm",
        kind: "preference",
        scope: "global",
        status: "queue",
        source: {},
        createdAt: at,
        updatedAt: at,
        reason: "turn capture",
      };
      await store.upsertQueue(item);

      const input: ReviewInput = {
        sessionID: "s1",
        items: [],
        chars: 0,
        hash: "cross-lane",
        truncated: false,
        userCount: 2,
        toolCount: 0,
        rawToolChars: 0,
        sources: {
          m1: { user: "以后回复先给结论，项目统一使用 pnpm", tools: [] },
        },
      };
      const result: ReviewRunResult = {
        summary: [],
        openQuestions: [],
        model: "test",
        candidates: [
          {
            type: "preference",
            text: "回复先给结论",
            scope: "global",
            confidence: 0.9,
            evidence: [{ messageID: "m1", quote: "以后回复先给结论", kind: "user" }],
          },
          {
            type: "preference",
            text: "项目统一使用 pnpm",
            scope: "global",
            confidence: 0.9,
            evidence: [{ messageID: "m1", quote: "项目统一使用 pnpm", kind: "user" }],
          },
        ],
      };
      const accepted = await acceptReviewCandidates(input, result, "review_cross", {
        store,
        config,
      });
      expect(accepted.created).toBe(0);
      expect(accepted.skipped).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
