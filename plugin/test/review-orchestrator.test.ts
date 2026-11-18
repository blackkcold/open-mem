import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { SessionReader } from "../src/session/reader.js";
import { DigestCache } from "../src/digest/cache.js";
import { ReviewInputBuilder } from "../src/review/input.js";
import { ReviewOrchestrator } from "../src/review/orchestrator.js";
import { ReviewBudgetError, ReviewRetryAfterError } from "../src/review/provider.js";
import { ExtractRequestError } from "../src/extract/provider.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import type { SessionMessage } from "../src/types.js";

/**
 * Automatic reviews require the persisted mode/revision to match the live
 * config (`automaticConfigCurrent`). Persist the same explicit automation
 * block the orchestrator is constructed with, instead of a legacy shape whose
 * normalized `mode: undefined` can never match the stored default `off`.
 */
const AUTOMATION = {
  enabled: true,
  mode: "autonomous" as const,
  revision: 0,
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  timeout = 3_000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value !== undefined) return value;
    await wait(20);
  }
  throw new Error("waitFor timed out");
}

async function cleanup(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await wait(20);
    }
  }
}

function user(id: string, text: string): SessionMessage {
  return { id, role: "user", type: "user", text };
}

interface Harness {
  dir: string;
  store: Store;
  reader: SessionReader;
  orchestrator: ReviewOrchestrator;
  source: { messages: SessionMessage[]; failRead: boolean; reads: number };
  calls: Array<{ sessionID: string; chars: number }>;
}

async function harness(options: {
  messages?: SessionMessage[];
  review?: Record<string, unknown>;
  fail?: boolean;
  acceptNotes?: boolean;
} = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-orch-"));
  const store = new Store(dir);
  await store.init();
  const source: Harness["source"] = {
    messages: options.messages ?? [user("m1", "以后回复都用中文"), user("m2", "另外记得用 pnpm")],
    failRead: false,
    reads: 0,
  };
  const reader = new SessionReader(async () => {
    source.reads += 1;
    if (source.failRead) throw new Error("transcript unavailable");
    return source.messages;
  }, { maxMessages: 100 });
  const digestCache = new DigestCache(store, { maxEntries: 20 });
  await digestCache.load();
  await store.writeConfig(mergeConfig(DEFAULT_CONFIG, { automation: AUTOMATION }));
  const config = mergeConfig(DEFAULT_CONFIG, {
    automation: AUTOMATION,
    review: {
      idleMs: 50,
      minNewUserMessages: 1,
      maxPerHour: 10,
      ...(options.review ?? {}),
    },
  });
  const builder = new ReviewInputBuilder({ config, digestCache });
  const calls: Array<{ sessionID: string; chars: number }> = [];
  const orchestrator = new ReviewOrchestrator({
    store,
    config,
    reader,
    buildInput: (sessionID, messages, from) => builder.build(sessionID, messages, from),
    runModel: async (input) => {
      if (options.fail) throw new Error("model down");
      calls.push({ sessionID: input.sessionID, chars: input.chars });
      return {
        summary: ["用户偏好中文回复"],
        openQuestions: [],
        model: "test",
        candidates: [
          {
            type: "preference" as const,
            text: "回复使用中文",
            scope: "global" as const,
            confidence: 0.9,
            evidence: [{ messageID: "m1", quote: "以后回复都用中文", kind: "user" as const }],
          },
        ],
      };
    },
    onAccepted: async () =>
      options.acceptNotes
        ? {
            created: 0,
            skipped: 0,
            sessionNotes: [
              {
                type: "rule" as const,
                text: "本次只读，不要修改文件",
                evidence: [{ messageID: "m1", quote: "以后回复都用中文", kind: "user" as const }],
                taskOnly: true,
                createdAt: new Date().toISOString(),
              },
            ],
          }
        : undefined,
  });
  return { dir, store, reader, orchestrator, source, calls };
}

describe("ReviewOrchestrator", () => {
  it("does not run while a sibling process owns the review lease", async () => {
    const h = await harness();
    try {
      await h.store.reserve("review-run:ses_1", 60_000);
      await h.orchestrator.runNow("ses_1", "manual");
      expect(h.calls).toHaveLength(0);
    } finally { await h.orchestrator.dispose(); await cleanup(h.dir); }
  });
  it("waits for the idle window before running", async () => {
    const h = await harness();
    try {
      await h.orchestrator.schedule("ses_1");
      const state = await h.store.readState();
      expect(state.sessions["ses_1"].reviewStatus).toBe("scheduled");
      expect(h.calls).toHaveLength(0);

      await wait(25);
      expect(h.calls).toHaveLength(0);
      await waitFor(() => (h.calls.length === 1 ? true : undefined));
      expect(h.calls[0].sessionID).toBe("ses_1");

      const after = await waitFor(async () => {
        const state = await h.store.readState();
        return state.sessions["ses_1"].reviewStatus === "ready" ? state : undefined;
      });
      expect(after.sessions["ses_1"].reviewedUpToMessageID).toBe("m2");
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("re-arms instead of running twice when another turn ends", async () => {
    const h = await harness({ review: { idleMs: 60 } });
    try {
      await h.orchestrator.schedule("ses_1");
      await wait(30);
      h.source.messages = [...h.source.messages, user("m3", "还有个偏好：先给结论")];
      await h.orchestrator.schedule("ses_1");
      await wait(30);
      expect(h.calls).toHaveLength(0);
      await waitFor(() => (h.calls.length === 1 ? true : undefined));
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("defers when the user kept typing after the review was scheduled", async () => {
    const h = await harness({ review: { idleMs: 40 } });
    try {
      await h.orchestrator.schedule("ses_1");
      h.source.messages = [...h.source.messages, user("m9", "等等，我再补充一点")];
      const deferred = await waitFor(async () => {
        const state = await h.store.readState();
        return state.sessions["ses_1"].reviewDeferrals === 1 ? state : undefined;
      });
      expect(deferred.sessions["ses_1"].reviewDeferrals).toBe(1);
      await waitFor(() => (h.calls.length === 1 ? true : undefined));
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("skips without a model call when nothing changed", async () => {
    const h = await harness();
    try {
      await h.orchestrator.runNow("ses_1", "auto");
      expect(h.calls).toHaveLength(1);
      const first = await h.store.readState();
      // Reset only the cursor: the transcript hash still matches.
      await h.store.updateSession("ses_1", {
        reviewedUpToMessageID: undefined,
        reviewedHash: first.sessions["ses_1"].reviewedHash,
      });
      await h.orchestrator.runNow("ses_1", "auto");
      expect(h.calls).toHaveLength(1);
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("records a failure and increments attempts", async () => {
    const h = await harness({ fail: true });
    try {
      const record = await h.orchestrator.runNow("ses_1", "auto");
      expect(record?.status).toBe("failed");
      const state = await h.store.readState();
      expect(state.sessions["ses_1"].reviewStatus).toBe("failed");
      expect(state.sessions["ses_1"].reviewAttempts).toBe(1);
      const reviews = await h.store.listReviews();
      expect(reviews).toHaveLength(1);
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("respects the hourly cap", async () => {
    const h = await harness({ review: { maxPerHour: 1 } });
    try {
      await h.orchestrator.runNow("ses_1", "auto");
      h.source.messages = [...h.source.messages, user("m4", "再来一条")];
      const second = await h.orchestrator.runNow("ses_1", "auto");
      expect(second).toBeUndefined();
      expect(h.calls).toHaveLength(1);
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("resumes a due review after a restart", async () => {
    const h = await harness();
    try {
      await h.store.updateSession("ses_1", {
        reviewDueAt: new Date(Date.now() - 1000).toISOString(),
        reviewStatus: "running",
      });
      await h.orchestrator.recover();
      await waitFor(() => (h.calls.length === 1 ? true : undefined));
      const state = await waitFor(async () => {
        const current = await h.store.readState();
        return current.sessions["ses_1"].reviewStatus === "ready" ? current : undefined;
      });
      expect(state.sessions["ses_1"].reviewStatus).toBe("ready");
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("does not extend a pending window when a ping adds no user message", async () => {
    const h = await harness({ review: { idleMs: 60_000 } });
    try {
      await h.orchestrator.schedule("ses_1");
      const first = (await h.store.readState()).sessions["ses_1"].reviewDueAt;
      await h.orchestrator.schedule("ses_1");
      const second = (await h.store.readState()).sessions["ses_1"].reviewDueAt;
      expect(second).toBe(first);
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("does not re-arm on an assistant-only delta", async () => {
    const h = await harness({
      messages: [{ id: "m1", role: "assistant", type: "assistant", text: "OK" }],
      review: { idleMs: 20 },
    });
    try {
      await h.store.updateSession("ses_1", {
        reviewStatus: "skipped",
        reviewDueAt: undefined,
      });
      h.source.messages = [
        { id: "m1", role: "assistant", type: "assistant", text: "OK" },
        { id: "m2", role: "assistant", type: "assistant", text: "still here" },
      ];
      await h.orchestrator.schedule("ses_1");
      const state = await h.store.readState();
      expect(state.sessions["ses_1"].reviewStatus).toBe("skipped");
      expect(state.sessions["ses_1"].reviewDueAt).toBeUndefined();
      expect(await h.store.listReviews()).toHaveLength(0);
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("does not re-arm an unchanged under-material window after a skip", async () => {
    const h = await harness({
      messages: [
        { id: "m1", role: "user", type: "user", text: "hi" },
        {
          id: "m2",
          role: "assistant",
          type: "assistant",
          text: "",
          parts: [
            {
              type: "tool",
              tool: "bash",
              state: {
                status: "completed",
                input: { command: "echo hi" },
                output: "hi",
                metadata: { exit: 0 },
              },
            },
          ],
        },
      ],
      review: { idleMs: 20 },
    });
    try {
      await h.orchestrator.runNow("ses_1", "auto");
      expect(await h.store.listReviews()).toHaveLength(1);
      await h.orchestrator.schedule("ses_1");
      const state = await h.store.readState();
      expect(state.sessions["ses_1"].reviewStatus).toBe("skipped");
      expect(state.sessions["ses_1"].reviewDueAt).toBeUndefined();
      expect(await h.store.listReviews()).toHaveLength(1);

      h.source.messages = [
        ...h.source.messages,
        user("m3", "以后回复都先给结论"),
      ];
      await h.orchestrator.schedule("ses_1");
      await waitFor(() => (h.calls.length === 1 ? true : undefined));
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("persists session notes on the review record", async () => {
    const h = await harness({ acceptNotes: true });
    try {
      const record = await h.orchestrator.runNow("ses_1", "auto");
      expect(record?.status).toBe("ready");
      const reviews = await h.store.listReviews();
      expect(reviews).toHaveLength(1);
      expect(reviews[0].sessionNotes).toHaveLength(1);
      expect(await h.store.listHooks()).toEqual([]);
      expect(await h.store.listQueue()).toEqual([]);
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("reports the next scheduled review", async () => {
    const h = await harness({ review: { idleMs: 60_000 } });
    try {
      await h.orchestrator.schedule("ses_1");
      const stats = h.orchestrator.stats();
      expect(stats.scheduled).toBe(1);
      expect(stats.nextReviewAt).toBeTruthy();
      expect(Date.parse(stats.nextReviewAt as string)).toBeGreaterThan(Date.now());
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("skips subagent sessions", async () => {
    const h = await harness();
    try {
      await h.store.updateSession("ses_1", { parentSessionID: "parent" });
      const record = await h.orchestrator.runNow("ses_1", "auto");
      expect(record).toBeUndefined();
      expect(h.calls).toHaveLength(0);
      await h.orchestrator.schedule("ses_1");
      const state = await h.store.readState();
      expect(state.sessions["ses_1"].reviewDueAt).toBeUndefined();
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("stops auto retries after repeated transcript read failures", async () => {
    const h = await harness();
    try {
      h.source.failRead = true;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await h.orchestrator.runNow("ses_1", "auto");
      }
      const state = await h.store.readState();
      expect(state.sessions["ses_1"].reviewStatus).toBe("failed");
      // Strict upper bound: the counter stops at the cap instead of growing.
      expect(state.sessions["ses_1"].reviewAttempts).toBe(5);
      // And further calls never re-read the transcript.
      expect(h.source.reads).toBe(5);
      expect(h.calls).toHaveLength(0);
      // No model call means no failed review row (usage counts stay truthful).
      expect(await h.store.listReviews()).toHaveLength(0);
      expect(h.orchestrator.stats().lastError).toContain("transcript unavailable");

      // New turns take the same cheap terminal path instead of re-reading.
      await h.orchestrator.schedule("ses_1");
      expect((await h.store.readState()).sessions["ses_1"].reviewDueAt).toBeUndefined();
      await h.orchestrator.runNow("ses_1", "auto");
      expect(h.source.reads).toBe(5);
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("does not report a next review while paused", async () => {
    const h = await harness({ review: { idleMs: 60_000 } });
    try {
      await h.orchestrator.schedule("ses_1");
      expect(h.orchestrator.stats().scheduled).toBe(1);
      expect(h.orchestrator.stats().nextReviewAt).toBeTruthy();

      h.orchestrator.pause();
      const stats = h.orchestrator.stats();
      expect(stats.scheduled).toBe(0);
      expect(stats.nextReviewAt).toBeUndefined();
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });
});

describe("review project ownership and deferral", () => {
  async function ownedHarness(options: {
    projectKey?: string;
    runModel?: () => Promise<never>;
    now?: () => number;
    onAccepted?: () => Promise<{ created: number; skipped: number }>;
  } = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-orch-p02-"));
    const store = new Store(dir);
    await store.init();
    const reader = new SessionReader(async () => [user("m1", "以后回复都用中文，并且先给结论")], {
      maxMessages: 100,
    });
    const digestCache = new DigestCache(store, { maxEntries: 20 });
    await digestCache.load();
    await store.writeConfig(mergeConfig(DEFAULT_CONFIG, { automation: AUTOMATION }));
    const config = mergeConfig(DEFAULT_CONFIG, {
      automation: AUTOMATION,
      review: { idleMs: 50, maxPerHour: 10 },
    });
    const builder = new ReviewInputBuilder({ config, digestCache });
    let calls = 0;
    const buildInput = (sessionID: string, messages: SessionMessage[], from?: string) =>
      builder.build(sessionID, messages, from);
    const createOrchestrator = () => new ReviewOrchestrator({
      store,
      config,
      reader,
      buildInput,
      ...(options.projectKey !== undefined ? { projectKey: options.projectKey } : {}),
      ...(options.now ? { now: options.now } : {}),
      runModel: async () => {
        calls += 1;
        if (options.runModel) return options.runModel();
        return {
          summary: [],
          openQuestions: [],
          model: "test",
          candidates: [],
        };
      },
      onAccepted: options.onAccepted ?? (async () => ({ created: 0, skipped: 0 })),
    });
    return { dir, store, reader, config, buildInput, createOrchestrator, orchestrator: createOrchestrator(), calls: () => calls };
  }

  it("recovers only the instance project and never repairs foreign sessions", async () => {
    const h = await ownedHarness({ projectKey: "A" });
    const now = Date.now();
    const past = new Date(now - 1_000).toISOString();
    const future = new Date(now + 60_000).toISOString();
    try {
      await h.store.updateSession("own", {
        contextProjectKey: "A",
        reviewStatus: "scheduled",
        reviewDueAt: future,
      });
      await h.store.updateSession("foreign", {
        contextProjectKey: "B",
        reviewStatus: "running",
        reviewStartedAt: new Date(now - 60_000).toISOString(),
      });
      await h.store.updateSession("legacy-own", {
        reviewStatus: "scheduled",
        reviewDueAt: future,
      });
      await h.store.updateSession("unknown", {
        reviewStatus: "scheduled",
        reviewDueAt: past,
      });
      await h.store.appendReview({
        id: "r1",
        sessionID: "legacy-own",
        projectKey: "A",
        status: "ready",
        createdAt: new Date(now - 120_000).toISOString(),
        candidates: 0,
        dropped: 0,
      });

      await h.orchestrator.recover();

      expect((await h.store.readSession("foreign"))?.reviewStatus).toBe("running");
      expect((await h.store.readSession("unknown"))?.reviewDueAt).toBe(past);
      expect((await h.store.readSession("legacy-own"))?.reviewStatus).toBe("scheduled");
      expect(h.orchestrator.stats().scheduled).toBe(2);
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("does not schedule or run a foreign session", async () => {
    const h = await ownedHarness({ projectKey: "A" });
    try {
      await h.store.updateSession("foreign", {
        contextProjectKey: "B",
        lastActiveAt: new Date().toISOString(),
      });
      await h.orchestrator.schedule("foreign");
      expect((await h.store.readSession("foreign"))?.reviewStatus).toBeUndefined();
      expect(await h.orchestrator.runNow("foreign", "manual")).toBeUndefined();
      expect(h.calls()).toBe(0);
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("defers a far Retry-After to the full deadline without a failure", async () => {
    const now = 1_000_000;
    const retryAt = now + 120_000;
    const h = await ownedHarness({
      projectKey: "A",
      now: () => now,
      runModel: async () => {
        throw new ReviewRetryAfterError("上游限流", retryAt, 1);
      },
    });
    try {
      await h.store.updateSession("own", { contextProjectKey: "A" });
      await h.orchestrator.runNow("own", "auto");
      const state = await h.store.readSession("own");
      expect(state?.reviewStatus).toBe("scheduled");
      expect(Date.parse(state?.reviewDueAt ?? "")).toBeGreaterThanOrEqual(retryAt);
      expect(state?.reviewAttempts ?? 0).toBe(0);
      expect(await h.store.listReviews()).toHaveLength(0);
      expect((await h.store.readState()).reviewRuns).toHaveLength(1);
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });

  it("releases the run slot only when a budget error dispatched no request", async () => {
    const now = 1_000_000;
    const zero = await ownedHarness({
      projectKey: "A",
      now: () => now,
      runModel: async () => {
        throw new ReviewBudgetError("无预算", 0, now + 60_000);
      },
    });
    const one = await ownedHarness({
      projectKey: "A",
      now: () => now,
      runModel: async () => {
        throw new ReviewBudgetError("无预算", 1, now + 60_000);
      },
    });
    try {
      await zero.store.updateSession("own", { contextProjectKey: "A" });
      await zero.orchestrator.runNow("own", "auto");
      expect((await zero.store.readState()).reviewRuns ?? []).toHaveLength(0);
      expect((await zero.store.readSession("own"))?.reviewStatus).toBe("scheduled");
      expect((await zero.store.readSession("own"))?.reviewAttempts ?? 0).toBe(0);

      await one.store.updateSession("own", { contextProjectKey: "A" });
      await one.orchestrator.runNow("own", "auto");
      expect((await one.store.readState()).reviewRuns ?? []).toHaveLength(1);
      expect((await one.store.readSession("own"))?.reviewAttempts ?? 0).toBe(0);
    } finally {
      await zero.orchestrator.dispose();
      await one.orchestrator.dispose();
      await cleanup(zero.dir);
      await cleanup(one.dir);
    }
  });

  it("defers extract budget exhaustion without marking the window reviewed and recovers it after restart", async () => {
    const now = 1_000_000;
    const retryAt = now + 120_000;
    let acceptedCalls = 0;
    const h = await ownedHarness({
      projectKey: "A",
      now: () => now,
      onAccepted: async () => {
        acceptedCalls += 1;
        if (acceptedCalls === 1) {
          const error = new ExtractRequestError("extract request budget exhausted", "budget");
          Object.assign(error, { requestsMade: 0, retryAt });
          throw error;
        }
        return { created: 0, skipped: 0 };
      },
    });
    try {
      await h.store.updateSession("own", { contextProjectKey: "A" });
      await h.orchestrator.runNow("own", "auto");
      const deferred = await h.store.readSession("own");
      expect(deferred?.reviewStatus).toBe("scheduled");
      expect(deferred?.reviewedHash).toBeUndefined();
      expect(deferred?.reviewAttempts ?? 0).toBe(0);
      expect(Date.parse(deferred?.reviewDueAt ?? "")).toBeGreaterThanOrEqual(retryAt);
      expect(await h.store.listReviews()).toHaveLength(0);
      // The review model already succeeded; only the later extract request
      // was budget-refused, so this run slot remains consumed.
      expect((await h.store.readState()).reviewRuns ?? []).toHaveLength(1);

      await h.orchestrator.dispose();
      await h.store.updateSession("own", {
        reviewStatus: "scheduled",
        reviewDueAt: new Date(now - 1_000).toISOString(),
      });
      const restarted = h.createOrchestrator();
      await restarted.recover();
      await waitFor(async () =>
        (await h.store.readSession("own"))?.reviewStatus === "ready" ? true : undefined,
      );
      expect(acceptedCalls).toBe(2);
      expect((await h.store.readSession("own"))?.reviewedHash).toBeTruthy();
      await restarted.dispose();
    } finally {
      await h.orchestrator.dispose();
      await cleanup(h.dir);
    }
  });
});
