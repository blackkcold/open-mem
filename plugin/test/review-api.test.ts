import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { startServer, type ServerHandle } from "../src/server.js";
import type { HookRecord, QueueItem } from "../src/types.js";

let dir: string;
let store: Store;
let server: ServerHandle;
const token = "review-token";
const now = new Date().toISOString();

function baseURL(): string {
  // server.url carries the console token in a query string; API calls build
  // their own origin so the path stays absolute.
  return `http://127.0.0.1:${server.port}`;
}

async function get<T>(pathname: string): Promise<T> {
  const response = await fetch(`${baseURL()}${pathname}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openmem-review-api-"));
  store = new Store(dir);
  await store.init();
  const config = mergeConfig(DEFAULT_CONFIG, { console: false, shadow: false });
  server = await startServer({
    store,
    config,
    token,
    port: 0,
    consoleDir: path.join(dir, "no-console"),
  });

  await store.appendReview({
    id: "review_api_1",
    sessionID: "s1",
    status: "ready",
    createdAt: now,
    candidates: 1,
    dropped: 1,
    chars: 900,
    model: "test-model",
    summary: ["用户偏好中文回复"],
    openQuestions: [],
  });

  const reviewHook: HookRecord = {
    id: "hook_review_api",
    key: "review|s1|m1|abc",
    sessionID: "s1",
    turnID: "review:review_api_1",
    messageID: "m1",
    text: "回复一律使用中文",
    title: "回复用中文",
    trigger: "review:preference",
    scope: "global",
    source: { sessionID: "s1", messageID: "m1", role: "user" },
    createdAt: now,
    updatedAt: now,
    status: "queue",
    attempts: 1,
    origin: "session-review",
    reviewType: "preference",
    reviewID: "review_api_1",
    evidence: [{ messageID: "m1", quote: "以后回复都用中文", kind: "user" }],
  };
  await store.appendHook(reviewHook);

  const item: QueueItem = {
    id: "q_review_api",
    title: "回复用中文",
    text: "回复一律使用中文",
    kind: "preference",
    scope: "global",
    status: "queue",
    source: { sessionID: "s1", messageID: "m1", role: "user" },
    createdAt: now,
    updatedAt: now,
    priority: 70,
    reason: "会话复盘 · preference",
    origin: "session-review",
    reviewType: "preference",
    reviewID: "review_api_1",
    evidence: [{ messageID: "m1", quote: "以后回复都用中文", kind: "user" }],
  };
  await store.upsertQueue(item);
  await store.upsertQueue({
    ...item,
    id: "q_turn_api",
    title: "本轮候选",
    origin: undefined,
    reviewType: undefined,
    evidence: undefined,
    reason: "turn capture",
  });
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("review API", () => {
  it("lists reviews with a summary", async () => {
    const data = await get<{ items: Array<{ id: string }>; summary: { total: number } }>(
      "/api/reviews?limit=5",
    );
    expect(data.items).toHaveLength(1);
    expect(data.items[0].id).toBe("review_api_1");
    expect(data.summary.total).toBe(1);
  });

  it("returns a review with its hooks", async () => {
    const data = await get<{ review: { id: string }; hooks: Array<{ id: string }> }>(
      "/api/reviews/review_api_1",
    );
    expect(data.review.id).toBe("review_api_1");
    expect(data.hooks.map((hook) => hook.id)).toEqual(["hook_review_api"]);
  });

  it("filters the queue by origin", async () => {
    const reviews = await get<{ items: Array<{ id: string }> }>("/api/queue?origin=session-review");
    expect(reviews.items.map((item) => item.id)).toEqual(["q_review_api"]);
    const turns = await get<{ items: Array<{ id: string }> }>("/api/queue?origin=turn");
    expect(turns.items.map((item) => item.id)).toEqual(["q_turn_api"]);
  });

  it("rejects a missing token", async () => {
    const response = await fetch(`${baseURL()}/api/reviews`);
    expect(response.status).toBe(401);
  });

  it("includes review calls in the usage summary", async () => {
    const usage = await get<{
      reviewCalls: number;
      reviewTokens: number;
      reviewFailures: number;
    }>("/api/usage");
    expect(usage.reviewCalls).toBe(1);
    expect(usage.reviewTokens).toBe(0);
    expect(usage.reviewFailures).toBe(0);
  });

  it("patches review config including zero values", async () => {
    const response = await fetch(`${baseURL()}/api/config`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        review: { enabled: false, repairAttempts: 0, maxPerHour: 6 },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      review: { enabled: boolean; repairAttempts: number; maxPerHour: number };
    };
    expect(body.review.enabled).toBe(false);
    expect(body.review.repairAttempts).toBe(0);
    expect(body.review.maxPerHour).toBe(6);
  });
});
