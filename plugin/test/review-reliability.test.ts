import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { SessionReader } from "../src/session/reader.js";
import { DigestCache } from "../src/digest/cache.js";
import { ReviewInputBuilder, type ReviewInput } from "../src/review/input.js";
import { ReviewOrchestrator } from "../src/review/orchestrator.js";
import { ReviewRequestError } from "../src/review/provider.js";
import { acceptReviewCandidates } from "../src/review/accept.js";
import { mergeConfig } from "../src/config.js";
import type { ReviewRunResult, SessionMessage } from "../src/types.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn: () => boolean, timeout = 4_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (fn()) return;
    await wait(20);
  }
  throw new Error("waitFor timed out");
}

function user(id: string, text: string): SessionMessage {
  return { id, role: "user", type: "user", text };
}

const successResult: ReviewRunResult = {
  summary: ["用户偏好中文"],
  openQuestions: [],
  model: "test",
  candidates: [
    {
      type: "preference",
      text: "回复先给结论再看细节",
      scope: "global",
      confidence: 0.9,
      evidence: [{ messageID: "m1", quote: "以后回复先给结论", kind: "user" }],
    },
  ],
};

const success = async (): Promise<ReviewRunResult> => successResult;

interface Harness {
  dir: string;
  store: Store;
  source: {
    messages: SessionMessage[];
    failRead: boolean;
    readError?: unknown;
    reads: number;
  };
  orchestrator: ReviewOrchestrator;
  counter: { calls: number };
}

async function makeHarness(options: {
  messages?: SessionMessage[];
  review?: Record<string, unknown>;
  model?: (input: ReviewInput) => Promise<ReviewRunResult>;
  onAccepted?: (
    input: ReviewInput,
    result: ReviewRunResult,
  ) => Promise<{ created: number; skipped: number }>;
  storeFactory?: (dir: string) => Store;
}): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-reliability-"));
  const store = options.storeFactory?.(dir) ?? new Store(dir);
  await store.init();
  const source: Harness["source"] = {
    messages: options.messages ?? [
      user("m1", "以后回复先给结论"),
      user("m2", "项目统一用 pnpm，不要用 npm"),
    ],
    failRead: false,
    reads: 0,
  };
  const reader = new SessionReader(async () => {
    source.reads += 1;
    if (source.failRead) {
      if ("readError" in source) throw source.readError;
      throw new Error("transcript unavailable");
    }
    return source.messages;
  }, { maxMessages: 100 });
  const cache = new DigestCache(store, { maxEntries: 20 });
  await cache.load();
  const config = mergeConfig({
    review: {
      idleMs: 60_000,
      minNewUserMessages: 1,
      maxPerHour: 20,
      ...(options.review ?? {}),
    },
  });
  const builder = new ReviewInputBuilder({ config, digestCache: cache });
  const counter = { calls: 0 };
  const model = options.model ?? success;
  const orchestrator = new ReviewOrchestrator({
    store,
    config,
    reader,
    buildInput: (sessionID, messages, from) => builder.build(sessionID, messages, from),
    runModel: async (input) => {
      counter.calls += 1;
      return model(input);
    },
    onAccepted: options.onAccepted ??
      (async (_input, result) => ({
        created: result.candidates.length,
        skipped: 0,
      })),
  });
  return { dir, store, source, orchestrator, counter };
}

async function cleanup(h: Harness): Promise<void> {
  await h.orchestrator.dispose();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(h.dir, { recursive: true, force: true });
      return;
    } catch {
      await wait(20);
    }
  }
}

describe("review reliability", () => {
  it("resets the attempt counter when new material arrives", async () => {
    let fail = true;
    const h = await makeHarness({
      model: async () => {
        if (fail) throw new Error("model down");
        return success();
      },
    });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await h.orchestrator.runNow("s1", "auto");
      }
      let state = await h.store.readState();
      expect(state.sessions["s1"].reviewAttempts).toBe(5);
      expect(h.counter.calls).toBe(5);

      const blocked = await h.orchestrator.runNow("s1", "auto");
      expect(blocked).toBeUndefined();
      expect(h.counter.calls).toBe(5);

      h.source.messages = [...h.source.messages, user("m3", "还有一个偏好：先给结论")];
      const afterNewMaterial = await h.orchestrator.runNow("s1", "auto");
      expect(afterNewMaterial?.status).toBe("failed");
      state = await h.store.readState();
      expect(state.sessions["s1"].reviewAttempts).toBe(1);
      expect(h.counter.calls).toBe(6);

      fail = false;
      h.source.messages = [...h.source.messages, user("m4", "最后再记一条：用 pnpm")];
      const record = await h.orchestrator.runNow("s1", "auto");
      expect(record?.status).toBe("ready");
      expect(h.counter.calls).toBe(7);
      state = await h.store.readState();
      expect(state.sessions["s1"].reviewAttempts).toBe(0);
    } finally {
      await cleanup(h);
    }
  });

  it("does not count a restart as a failed attempt", async () => {
    const h = await makeHarness({ messages: [] });
    try {
      await h.store.updateSession("s1", {
        reviewStatus: "running",
        reviewAttempts: 2,
      });
      await h.orchestrator.recover();
      await wait(120);
      const state = await h.store.readState();
      expect(state.sessions["s1"].reviewAttempts).toBe(2);
    } finally {
      await cleanup(h);
    }
  });

  it("keeps the hourly slot when a started model call fails", async () => {
    const h = await makeHarness({
      review: { maxPerHour: 1 },
      model: async () => {
        throw new ReviewRequestError("network down", false);
      },
    });
    try {
      const failed = await h.orchestrator.runNow("s1", "auto");
      expect(failed?.status).toBe("failed");
      const afterFailure = await h.store.readState();
      // Product change: a transport failure is still a failed automatic run,
      // so it consumes the bounded retry budget (previously it stayed 0 and
      // could retry every turn forever).
      expect(afterFailure.sessions["s1"].reviewAttempts).toBe(1);
      // The request already started, so its delivery is unknown. Keep the
      // conservative hourly slot instead of assuming it was not sent.
      expect(afterFailure.reviewRuns ?? []).toHaveLength(1);

      const blocked = await h.orchestrator.runNow("s1", "auto");
      expect(blocked).toBeUndefined();
      expect(h.counter.calls).toBe(1);
      const state = await h.store.readState();
      expect(state.sessions["s1"].reviewStatus).toBe("scheduled");

      // The hourly cap also applies to an explicit manual retry.
      const manual = await h.orchestrator.runNow("s1", "manual");
      expect(manual).toBeUndefined();
      expect(h.counter.calls).toBe(1);
    } finally {
      await cleanup(h);
    }
  });

  it("bounds automatic retries for transport and provider failures", async () => {
    const failures = [
      "network down",
      "review HTTP 401",
      "复盘模型熔断中，稍后重试",
      "network down",
      "review HTTP 401",
    ];
    let attempt = 0;
    const h = await makeHarness({
      model: async () => {
        const message = failures[Math.min(attempt, failures.length - 1)];
        attempt += 1;
        throw new ReviewRequestError(message, false);
      },
    });
    try {
      for (let run = 0; run < 7; run += 1) {
        await h.orchestrator.runNow("s1", "auto");
      }
      const state = await h.store.readState();
      expect(state.sessions["s1"].reviewAttempts).toBe(5);
      expect(state.sessions["s1"].reviewStatus).toBe("failed");
      // Runs six and seven are refused before the model call.
      expect(h.counter.calls).toBe(5);
      const rows = await h.store.listReviews();
      expect(rows).toHaveLength(5);
      expect(rows.every((row) => row.status === "failed")).toBe(true);
      expect(rows.every((row) => row.note === "transport failure")).toBe(true);
    } finally {
      await cleanup(h);
    }
  });

  it("recovers from an exhausted transport budget on an explicit manual run", async () => {
    let fail = true;
    const h = await makeHarness({
      model: async () => {
        if (fail) throw new ReviewRequestError("review HTTP 401", false);
        return success();
      },
    });
    try {
      for (let run = 0; run < 6; run += 1) {
        await h.orchestrator.runNow("s1", "auto");
      }
      expect(h.counter.calls).toBe(5);
      expect((await h.store.readState()).sessions["s1"].reviewAttempts).toBe(5);

      fail = false;
      const record = await h.orchestrator.runNow("s1", "manual");
      expect(record?.status).toBe("ready");
      expect(h.counter.calls).toBe(6);
      const state = await h.store.readState();
      expect(state.sessions["s1"].reviewAttempts).toBe(0);
      expect(state.sessions["s1"].reviewStatus).toBe("ready");
    } finally {
      await cleanup(h);
    }
  });

  it("gives genuinely new material a fresh transport budget", async () => {
    let fail = true;
    const h = await makeHarness({
      model: async () => {
        if (fail) throw new ReviewRequestError("network down", false);
        return success();
      },
    });
    try {
      for (let run = 0; run < 6; run += 1) {
        await h.orchestrator.runNow("s1", "auto");
      }
      expect(h.counter.calls).toBe(5);
      expect((await h.store.readState()).sessions["s1"].reviewAttempts).toBe(5);

      h.source.messages = [...h.source.messages, user("m3", "以后回复先给中文")];
      const record = await h.orchestrator.runNow("s1", "auto");
      expect(record?.status).toBe("failed");
      expect(h.counter.calls).toBe(6);
      const state = await h.store.readState();
      expect(state.sessions["s1"].reviewAttempts).toBe(1);
    } finally {
      await cleanup(h);
    }
  });

  it("reviews a single-message window", async () => {
    const h = await makeHarness({ messages: [user("m1", "以后回复先给结论")] });
    try {
      const record = await h.orchestrator.runNow("s1", "auto");
      expect(record?.status).toBe("ready");
      expect(h.counter.calls).toBe(1);
    } finally {
      await cleanup(h);
    }
  });

  it("keeps the hourly slot and returns to scheduled when paused mid-run", async () => {
    let release: ((value: ReviewRunResult) => void) | undefined;
    const h = await makeHarness({
      review: { maxPerHour: 1 },
      model: () =>
        new Promise<ReviewRunResult>((resolve) => {
          release = resolve;
        }),
    });
    try {
      const run = h.orchestrator.runNow("s1", "auto");
      await waitFor(() => h.counter.calls === 1);
      expect(h.counter.calls).toBe(1);
      h.orchestrator.pause();
      release?.(successResult);
      await run;
      const state = await h.store.readState();
      expect(state.sessions["s1"].reviewStatus).toBe("scheduled");
      // The model call already happened; keep its slot until it expires.
      expect(state.reviewRuns ?? []).toHaveLength(1);

      h.orchestrator.resume();
      const blocked = await h.orchestrator.runNow("s1", "auto");
      expect(blocked).toBeUndefined();
      expect(h.counter.calls).toBe(1);
    } finally {
      await cleanup(h);
    }
  });

  it("keeps the hourly slot when disposed after the model returned", async () => {
    let release: ((value: ReviewRunResult) => void) | undefined;
    const h = await makeHarness({
      review: { maxPerHour: 1 },
      model: () =>
        new Promise<ReviewRunResult>((resolve) => {
          release = resolve;
        }),
    });
    try {
      const run = h.orchestrator.runNow("s1", "auto");
      await waitFor(() => h.counter.calls === 1);
      const disposing = h.orchestrator.dispose();
      release?.(successResult);
      await run;
      await disposing;
      const state = await h.store.readState();
      expect(state.reviewRuns ?? []).toHaveLength(1);
    } finally {
      await cleanup(h);
    }
  });

  it("records null and undefined failures instead of crashing the catch", async () => {
    let thrown: unknown = null;
    const h = await makeHarness({
      model: async () => {
        throw thrown;
      },
    });
    try {
      const first = await h.orchestrator.runNow("s1", "auto");
      expect(first?.status).toBe("failed");
      let state = await h.store.readState();
      expect(state.sessions["s1"].reviewStatus).toBe("failed");
      expect(state.sessions["s1"].reviewAttempts).toBe(1);

      thrown = undefined;
      const second = await h.orchestrator.runNow("s1", "auto");
      expect(second?.status).toBe("failed");
      state = await h.store.readState();
      expect(state.sessions["s1"].reviewStatus).toBe("failed");
      expect(state.sessions["s1"].reviewAttempts).toBe(2);

      const rows = (await h.store.listReviews()).filter(
        (row) => row.status === "failed",
      );
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.error)).toEqual(["null", "undefined"]);
    } finally {
      await cleanup(h);
    }
  });

  it("bounds repeated null failures from the transcript reader", async () => {
    const h = await makeHarness({});
    try {
      h.source.failRead = true;
      h.source.readError = null;
      for (let run = 0; run < 6; run += 1) {
        await h.orchestrator.runNow("s1", "auto");
      }
      const state = await h.store.readState();
      expect(state.sessions["s1"].reviewStatus).toBe("failed");
      expect(state.sessions["s1"].reviewAttempts).toBe(5);
      expect(h.source.reads).toBe(5);
      expect(h.counter.calls).toBe(0);
      expect(await h.store.listReviews()).toHaveLength(0);
    } finally {
      await cleanup(h);
    }
  });

  it("releases the hourly slot only when the model call never started", async () => {
    const control = { failRunningUpdate: false };
    class FailingStateStore extends Store {
      override async updateSession(
        sessionID: string,
        patch: Parameters<Store["updateSession"]>[1],
      ) {
        if (control.failRunningUpdate && patch.reviewStatus === "running") {
          throw new Error("state write failed");
        }
        return super.updateSession(sessionID, patch);
      }
    }
    const h = await makeHarness({
      review: { maxPerHour: 1 },
      storeFactory: (dir) => new FailingStateStore(dir),
    });
    try {
      control.failRunningUpdate = true;
      const record = await h.orchestrator.runNow("s1", "auto");
      expect(record).toBeUndefined();
      expect(h.counter.calls).toBe(0);
      const state = await h.store.readState();
      expect(state.sessions["s1"].reviewStatus).toBe("failed");
      expect(state.sessions["s1"].reviewAttempts).toBe(1);
      // The slot was taken but the model call provably never started.
      expect(state.reviewRuns ?? []).toHaveLength(0);
    } finally {
      await cleanup(h);
    }
  });

  it("dedupes a reworded candidate that quotes the same message", async () => {
    const h = await makeHarness({ messages: [user("m1", "以后回复都用中文，别再写英文")] });
    try {
      const now = new Date().toISOString();
      await h.store.appendHook({
        id: "hook_turn",
        key: "s1|m1|turn",
        sessionID: "s1",
        turnID: "m1",
        messageID: "m1",
        text: "以后回复都用中文",
        title: "回复用中文",
        trigger: "以后",
        scope: "global",
        source: { sessionID: "s1", messageID: "m1", role: "user" },
        createdAt: now,
        updatedAt: now,
        status: "queue",
        attempts: 1,
        evidence: [{ messageID: "m1", quote: "以后回复都用中文，别再写英文", kind: "user" }],
      });
      const input: ReviewInput = {
        sessionID: "s1",
        items: [],
        chars: 0,
        hash: "hash",
        truncated: false,
        userCount: 1,
        toolCount: 0,
        rawToolChars: 0,
        sources: { m1: { user: "以后回复都用中文，别再写英文", tools: [] } },
      };
      const result = await acceptReviewCandidates(
        input,
        {
          summary: [],
          openQuestions: [],
          model: "test",
          candidates: [
            {
              type: "preference",
              text: "回复一律使用中文，不要用英文",
              scope: "global",
              confidence: 0.9,
              evidence: [
                { messageID: "m1", quote: "以后回复都用中文，别再写英文", kind: "user" },
              ],
            },
          ],
        },
        "review_1",
        { store: h.store, config: mergeConfig({}) },
      );
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(1);
    } finally {
      await cleanup(h);
    }
  });

  it("skips a manual run when the transcript is unchanged", async () => {
    const h = await makeHarness({ messages: [user("m1", "以后回复先给结论")] });
    try {
      await h.orchestrator.runNow("s1", "auto");
      expect(h.counter.calls).toBe(1);
      h.source.messages = [
        ...h.source.messages,
        { id: "m2", role: "assistant", type: "assistant", text: "好的" },
      ];
      const again = await h.orchestrator.runNow("s1", "manual");
      expect(again).toBeUndefined();
      expect(h.counter.calls).toBe(1);
    } finally {
      await cleanup(h);
    }
  });

  it("keeps the failed window when a later failure cannot read the transcript", async () => {
    let contentFails = true;
    const h = await makeHarness({
      model: async () => {
        if (contentFails) throw new ReviewRequestError("invalid json", true);
        return success();
      },
    });
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await h.orchestrator.runNow("s1", "auto");
      }
      let state = await h.store.readState();
      expect(state.sessions["s1"].reviewAttempts).toBe(4);
      const failedHash = state.sessions["s1"].reviewAttemptedHash;
      expect(failedHash).toBeTruthy();
      expect(h.counter.calls).toBe(4);
      expect(await h.store.listReviews()).toHaveLength(4);

      // A failure before the input is built cannot name its window. It must
      // not erase the known failed window and reopen the retry budget.
      h.source.failRead = true;
      await h.orchestrator.runNow("s1", "auto");
      state = await h.store.readState();
      expect(state.sessions["s1"].reviewAttempts).toBe(5);
      expect(state.sessions["s1"].reviewAttemptedHash).toBe(failedHash);
      expect(h.counter.calls).toBe(4);
      // No model call, so no failed review row is fabricated.
      expect(await h.store.listReviews()).toHaveLength(4);

      h.source.failRead = false;
      contentFails = false;
      const blocked = await h.orchestrator.runNow("s1", "auto");
      expect(blocked).toBeUndefined();
      expect(h.counter.calls).toBe(4);
      expect((await h.store.readState()).sessions["s1"].reviewStatus).toBe("failed");

      // Genuinely new material is still allowed to reset the budget.
      h.source.messages = [...h.source.messages, user("m3", "以后回复先用中文")];
      const record = await h.orchestrator.runNow("s1", "auto");
      expect(record?.status).toBe("ready");
      expect(h.counter.calls).toBe(5);
      state = await h.store.readState();
      expect(state.sessions["s1"].reviewAttempts).toBe(0);
    } finally {
      await cleanup(h);
    }
  });

  it("keeps the hourly slot when acceptance fails after the model call", async () => {
    let acceptFails = true;
    const h = await makeHarness({
      review: { maxPerHour: 1 },
      onAccepted: async (_input, result) => {
        if (acceptFails) throw new Error("accept failed");
        return { created: result.candidates.length, skipped: 0 };
      },
    });
    try {
      const failed = await h.orchestrator.runNow("s1", "auto");
      expect(failed?.status).toBe("failed");
      let state = await h.store.readState();
      expect(state.sessions["s1"].reviewStatus).toBe("failed");
      // The model call really happened, so the hourly budget must keep it.
      expect(state.reviewRuns ?? []).toHaveLength(1);
      expect(
        (await h.store.listReviews()).filter((entry) => entry.status === "failed"),
      ).toHaveLength(1);

      // Same window: the cap retries later instead of spending a second call.
      const blocked = await h.orchestrator.runNow("s1", "auto");
      expect(blocked).toBeUndefined();
      expect(h.counter.calls).toBe(1);
      state = await h.store.readState();
      expect(state.sessions["s1"].reviewStatus).toBe("scheduled");

      // New material still cannot exceed the hourly budget.
      acceptFails = false;
      h.source.messages = [...h.source.messages, user("m3", "再加一条：先给结论")];
      const capped = await h.orchestrator.runNow("s1", "auto");
      expect(capped).toBeUndefined();
      expect(h.counter.calls).toBe(1);
      expect((await h.store.readState()).sessions["s1"].reviewStatus).toBe("scheduled");
    } finally {
      await cleanup(h);
    }
  });
});
