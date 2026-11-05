import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { SessionReader } from "../src/session/reader.js";
import { DigestCache } from "../src/digest/cache.js";
import { ReviewInputBuilder } from "../src/review/input.js";
import { ReviewOrchestrator } from "../src/review/orchestrator.js";
import { mergeConfig } from "../src/config.js";
import type { SessionMessage } from "../src/types.js";

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
  source: { messages: SessionMessage[] };
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
  const source = {
    messages: options.messages ?? [user("m1", "以后回复都用中文"), user("m2", "另外记得用 pnpm")],
  };
  const reader = new SessionReader(async () => source.messages, { maxMessages: 100 });
  const digestCache = new DigestCache(store, { maxEntries: 20 });
  await digestCache.load();
  const config = mergeConfig({
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
});
