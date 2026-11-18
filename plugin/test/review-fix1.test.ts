import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { DigestCache } from "../src/digest/cache.js";
import { SessionReader } from "../src/session/reader.js";
import { ReviewInputBuilder } from "../src/review/input.js";
import { ReviewOrchestrator } from "../src/review/orchestrator.js";
import {
  ReviewCacheError,
  ReviewProvider,
  ReviewRequestError,
  ReviewRetryAfterError,
} from "../src/review/provider.js";

const text = "以后回复都用中文，并且先给结论";
const input = {
  sessionID: "s1",
  items: [{ id: "m1", role: "user" as const, text }],
  chars: text.length,
  hash: "h1",
  truncated: false,
  userCount: 1,
  toolCount: 0,
  rawToolChars: 0,
  sources: { m1: { user: text, tools: [] } },
};

async function newStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-p02-fix1-"));
  const store = new Store(dir);
  await store.init();
  return { dir, store };
}

describe("P02 fix1 provider", () => {
  it("does not reserve a request slot when generate is missing", async () => {
    const { dir, store } = await newStore();
    try {
      const provider = new ReviewProvider({
        store,
        config: mergeConfig({ review: { transport: "opencode", maxRequestsPerHour: 1 } }),
        maxRequestsPerHour: 1,
      });
      const error = await provider.review(input).catch((value: unknown) => value);
      expect(error).toMatchObject({ kind: "config", requestsMade: 0 });
      expect((await store.readState()).modelRequests?.review ?? []).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("classifies a corrupt cache as cache/zero-dispatched", async () => {
    const { dir, store } = await newStore();
    try {
      await writeFile(store.reviewCachePath, JSON.stringify({ version: 1, entries: [] }), "utf8");
      const provider = new ReviewProvider({
        store,
        config: mergeConfig({ review: { transport: "ollama", maxRequestsPerHour: 5 } }),
        maxRequestsPerHour: 5,
        fetchImpl: (async () => {
          throw new Error("must not fetch");
        }) as unknown as typeof fetch,
      });
      const error = await provider.review(input).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewCacheError);
      expect(error).toMatchObject({ kind: "cache", requestsMade: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defers a far Retry-After on the retry attempt", async () => {
    const { dir, store } = await newStore();
    try {
      let fetches = 0;
      const sleeps: number[] = [];
      const provider = new ReviewProvider({
        store,
        config: mergeConfig({ review: { transport: "ollama" } }),
        key: "k",
        maxRequestsPerHour: 5,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        fetchImpl: (async () => {
          fetches += 1;
          return fetches === 1
            ? new Response("", { status: 429, headers: { "retry-after": "2" } })
            : new Response("", { status: 429, headers: { "retry-after": "600" } });
        }) as unknown as typeof fetch,
      });
      const error = await provider.review(input).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ReviewRetryAfterError);
      expect(error).toMatchObject({ kind: "retry-after", requestsMade: 2 });
      expect(fetches).toBe(2);
      expect(sleeps).toEqual([2000]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not retry a redirect error", async () => {
    const { dir, store } = await newStore();
    try {
      let fetches = 0;
      const provider = new ReviewProvider({
        store,
        config: mergeConfig({ review: { transport: "ollama" } }),
        key: "k",
        maxRequestsPerHour: 5,
        sleep: async () => undefined,
        fetchImpl: (async () => {
          fetches += 1;
          const error = new TypeError("fetch failed") as TypeError & { cause?: unknown };
          error.cause = new Error("unexpected redirect");
          throw error;
        }) as unknown as typeof fetch,
      });
      await expect(provider.review(input)).rejects.toMatchObject({ kind: "transport" });
      expect(fetches).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the exact budget release boundary, not a one-hour clamp", async () => {
    const { dir, store } = await newStore();
    try {
      const t0 = 10_000_000;
      await store.takeModelSlot("review", 1, t0);
      const now = t0 + 60 * 60 * 1000 - 500;
      const provider = new ReviewProvider({
        store,
        config: mergeConfig({ review: { transport: "ollama", maxRequestsPerHour: 1 } }),
        maxRequestsPerHour: 1,
        now: () => now,
      });
      const error = await provider.review(input).catch((value: unknown) => value);
      expect(error).toMatchObject({ kind: "budget" });
      expect((error as { retryAt: number }).retryAt).toBe(t0 + 60 * 60 * 1000 + 1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("P02 fix1 orchestrator", () => {
  async function orchestratorFor(
    runModel: () => Promise<never>,
    options: { now?: () => number; log?: (message: string, error?: unknown) => void } = {},
  ) {
    const { dir, store } = await newStore();
    // Automatic runs compare the persisted automation mode/revision with the
    // live config, so persist the explicit block the orchestrator receives.
    const automation = {
      enabled: true,
      mode: "autonomous" as const,
      revision: 0,
    };
    await store.writeConfig(mergeConfig(DEFAULT_CONFIG, { automation }));
    const config = mergeConfig(DEFAULT_CONFIG, {
      automation,
      review: { idleMs: 45, maxPerHour: 5 },
    });
    const reader = new SessionReader(async () => [{ id: "m1", role: "user", type: "user", text }], {
      maxMessages: 100,
    });
    const digestCache = new DigestCache(store, { maxEntries: 20 });
    await digestCache.load();
    const builder = new ReviewInputBuilder({ config, digestCache });
    const orchestrator = new ReviewOrchestrator({
      store,
      config,
      reader,
      buildInput: (sessionID, messages, from) => builder.build(sessionID, messages, from),
      projectKey: "A",
      ...(options.now ? { now: options.now } : {}),
      ...(options.log ? { log: options.log } : {}),
      runModel,
      onAccepted: async () => ({ created: 0, skipped: 0 }),
    });
    await store.updateSession("s1", { contextProjectKey: "A" });
    return { dir, store, orchestrator };
  }

  it("releases the run slot for a config error that never dispatched", async () => {
    const h = await orchestratorFor(async () => {
      throw new ReviewRequestError("missing generate", false, "config", { requestsMade: 0 });
    });
    try {
      const record = await h.orchestrator.runNow("s1", "auto");
      const state = await h.store.readState();
      expect(record?.status).toBe("failed");
      expect(record?.errorKind).toBe("config");
      expect((state.reviewRuns ?? []).length).toBe(0);
      expect(state.modelRequests?.review ?? []).toHaveLength(0);
    } finally {
      await h.orchestrator.dispose();
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it("keeps the run slot when a dispatched generate call returned a bad shape", async () => {
    const h = await orchestratorFor(async () => {
      throw new ReviewRequestError("bad shape", false, "config", { requestsMade: 1 });
    });
    try {
      await h.orchestrator.runNow("s1", "auto");
      expect(((await h.store.readState()).reviewRuns ?? []).length).toBe(1);
    } finally {
      await h.orchestrator.dispose();
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it("classifies cache errors as cache and releases the run slot", async () => {
    const h = await orchestratorFor(async () => {
      throw new ReviewCacheError("cache damaged");
    });
    try {
      const record = await h.orchestrator.runNow("s1", "auto");
      const state = await h.store.readState();
      expect(record?.errorKind).toBe("cache");
      expect(record?.note).toBeUndefined();
      expect((state.reviewRuns ?? []).length).toBe(0);
    } finally {
      await h.orchestrator.dispose();
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it("does not pull a far retry-after deadline earlier for new messages", async () => {
    const retryAt = Date.now() + 120_000;
    const h = await orchestratorFor(async () => {
      throw new ReviewRetryAfterError("rate limited", retryAt, 1);
    });
    try {
      await h.orchestrator.runNow("s1", "auto");
      const before = await h.store.readSession("s1");
      await h.orchestrator.schedule("s1");
      const after = await h.store.readSession("s1");
      expect(Date.parse(after?.reviewDueAt ?? "")).toBeGreaterThanOrEqual(
        Date.parse(before?.reviewDueAt ?? ""),
      );
      expect(after?.reviewDeferredReason).toBe("retry-after");
    } finally {
      await h.orchestrator.dispose();
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it("chunks an overflowing timer and keeps the full deadline", async () => {
    const retryAt = Date.now() + 25 * 24 * 60 * 60 * 1000;
    const h = await orchestratorFor(async () => {
      throw new ReviewRetryAfterError("far rate limit", retryAt, 1);
    });
    try {
      await h.orchestrator.runNow("s1", "auto");
      await new Promise((resolve) => setTimeout(resolve, 60));
      const state = await h.store.readSession("s1");
      expect(h.orchestrator.stats().scheduled).toBe(1);
      expect(Date.parse(state?.reviewDueAt ?? "")).toBe(retryAt);
    } finally {
      await h.orchestrator.dispose();
      await rm(h.dir, { recursive: true, force: true });
    }
  });

  it("logs one bounded audit line for unowned recover sessions", async () => {
    const log = vi.fn();
    const h = await orchestratorFor(async () => {
      throw new Error("unused");
    }, { log });
    try {
      await h.store.updateSession("unknown", {
        reviewStatus: "scheduled",
        reviewDueAt: new Date(Date.now() - 1000).toISOString(),
      });
      await h.orchestrator.recover();
      expect(log.mock.calls.filter(([message]) => String(message).includes("unowned"))).toHaveLength(1);
      expect((await h.store.readSession("unknown"))?.reviewStatus).toBe("scheduled");
    } finally {
      await h.orchestrator.dispose();
      await rm(h.dir, { recursive: true, force: true });
    }
  });
});
