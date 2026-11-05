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
  source: { messages: SessionMessage[] };
  orchestrator: ReviewOrchestrator;
  counter: { calls: number };
}

async function makeHarness(options: {
  messages?: SessionMessage[];
  review?: Record<string, unknown>;
  model?: (input: ReviewInput) => Promise<ReviewRunResult>;
}): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-reliability-"));
  const store = new Store(dir);
  await store.init();
  const source = {
    messages: options.messages ?? [
      user("m1", "以后回复先给结论"),
      user("m2", "项目统一用 pnpm，不要用 npm"),
    ],
  };
  const reader = new SessionReader(async () => source.messages, { maxMessages: 100 });
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
    onAccepted: async (_input, result) => ({
      created: result.candidates.length,
      skipped: 0,
    }),
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

  it("releases the hourly slot when the model call fails", async () => {
    let fail = true;
    const h = await makeHarness({
      review: { maxPerHour: 1 },
      model: async () => {
        if (fail) throw new ReviewRequestError("network down", false);
        return success();
      },
    });
    try {
      const failed = await h.orchestrator.runNow("s1", "auto");
      expect(failed?.status).toBe("failed");
      const afterFailure = await h.store.readState();
      expect(afterFailure.sessions["s1"].reviewAttempts).toBe(0);
      expect(afterFailure.reviewRuns ?? []).toHaveLength(0);

      fail = false;
      const record = await h.orchestrator.runNow("s1", "auto");
      expect(record?.status).toBe("ready");
      expect(h.counter.calls).toBe(2);
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

  it("releases the slot and returns to scheduled when paused mid-run", async () => {
    let release: ((value: ReviewRunResult) => void) | undefined;
    const h = await makeHarness({
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
});
