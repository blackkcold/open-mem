import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { startServer, type ServerHandle } from "../src/server.js";
import { buildSuggestion } from "../src/suggestion.js";
import type {
  AutoMemConfig,
  DecisionResult,
  Item,
  MergeJournal,
  QueueItem,
} from "../src/types.js";

let dir: string;
let store: Store;
let server: ServerHandle;
let config: AutoMemConfig;
let target: Item;
let queue: QueueItem;

const now = new Date().toISOString();

function makeTarget(): Item {
  return {
    id: "item_target",
    title: "[P] 先给结论",
    text: "回复先给结论，再给细节",
    kind: "preference",
    scope: "global",
    status: "auto",
    source: { role: "user" },
    createdAt: now,
    updatedAt: now,
    seenCount: 1,
    lastSeenAt: now,
    sources: [{ role: "user" }],
  };
}

function makeQueue(): QueueItem {
  const decision: DecisionResult = {
    kind: "preference",
    duplicate: 0.6,
    safeAuto: 0.7,
    risk: 0.18,
    confidence: 0.95,
    strictness: "preference",
    reasons: ["test"],
    source: "heuristic",
    mergeAction: "merge_into",
    mergeTargetId: "item_target",
    conflict: 0,
  };
  return {
    id: "queue_1",
    title: "[P] 先给结论",
    text: "回复先给结论",
    kind: "preference",
    scope: "global",
    status: "queue",
    source: { role: "user" },
    createdAt: now,
    updatedAt: now,
    decision,
    priority: 80,
    priorityBreakdown: { risk: 0.18, impact: 0.9, uncertainty: 0.05, age: 0 },
    reason: "test",
    seenCount: 1,
    lastSeenAt: now,
    sources: [{ role: "user" }],
  };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openmem-api2-"));
  store = new Store(dir);
  await store.init();
  config = mergeConfig(DEFAULT_CONFIG, {
    console: false,
    shadow: false,
    rewrite: { enabled: false, eager: false },
  });
  target = makeTarget();
  await store.appendItem(target);
  queue = makeQueue();
  await store.upsertQueue(queue);
  server = await startServer({
    store,
    config,
    token: "test-token",
    port: 0,
    consoleDir: path.join(dir, "no-console"),
    suggest: async (id: string) => {
      const current = (await store.listQueue()).find((item) => item.id === id);
      if (!current?.decision) return undefined;
      const targetItem = (await store.listItems()).find(
        (item) => item.id === current.decision?.mergeTargetId,
      );
      return buildSuggestion({ store, config }, current, current.decision, targetItem);
    },
  });
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

function api(pathname: string): string {
  return `http://127.0.0.1:${server.port}${pathname}${
    pathname.includes("?") ? "&" : "?"
  }token=test-token`;
}

describe("suggestion and health API", () => {
  it("generates a prefilled merge suggestion", async () => {
    const response = await fetch(api(`/api/queue/${queue.id}/suggest`), {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      action: string;
      proposedText: string;
      validation: { ok: boolean };
    };
    expect(body.action).toBe("merge_into");
    expect(body.proposedText).toContain("先给结论");
    expect(body.validation.ok).toBe(true);
  });

  it("applies the suggestion and exposes health, usage and journal", async () => {
    const response = await fetch(api(`/api/queue/${queue.id}/decision`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "apply_suggestion" }),
    });
    expect(response.status).toBe(200);
    expect(await store.listQueue()).toEqual([]);
    const updated = (await store.listItems()).find((item) => item.id === target.id);
    expect(updated?.seenCount).toBe(2);

    const health = await fetch(api("/api/health-score"));
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { score: number };
    expect(typeof healthBody.score).toBe("number");

    const usage = await fetch(api("/api/usage"));
    expect(usage.status).toBe(200);

    const journal = await fetch(api("/api/journal"));
    const journalBody = (await journal.json()) as { items: MergeJournal[] };
    expect(journalBody.items).toHaveLength(1);
    expect(journalBody.items[0].action).toBe("merge_into");

    const undo = await fetch(api(`/api/merge/${journalBody.items[0].id}/undo`), {
      method: "POST",
    });
    expect(undo.status).toBe(200);
    expect(await store.listQueue()).toHaveLength(1);
    const restored = (await store.listItems()).find((item) => item.id === target.id);
    expect(restored?.seenCount).toBe(1);
  });

  it("batch dry-runs and applies ready suggestions", async () => {
    const dry = await fetch(api("/api/queue/batch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: [queue.id],
        action: "apply_suggestion",
        minConfidence: 0.9,
        max: 10,
        dryRun: true,
      }),
    });
    expect(dry.status).toBe(200);
    const dryBody = (await dry.json()) as { eligible: unknown[]; skipped: number };
    expect(dryBody.eligible).toHaveLength(1);

    const apply = await fetch(api("/api/queue/batch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: [queue.id],
        action: "apply_suggestion",
        max: 10,
        dryRun: false,
      }),
    });
    expect(apply.status).toBe(200);
    const applyBody = (await apply.json()) as {
      results: Array<{ ok: boolean }>;
    };
    expect(applyBody.results[0].ok).toBe(true);
    expect(await store.listQueue()).toEqual([]);
  });

  it("compacts, hides the token, and patches rewrite settings", async () => {
    const compact = await fetch(api("/api/compact"), { method: "POST" });
    expect(compact.status).toBe(200);

    const configResponse = await fetch(api("/api/config"));
    const body = (await configResponse.json()) as Record<string, unknown>;
    expect((body.decision as { model: string }).model).toBe("clef:27b-cloud");
    expect("token" in body).toBe(false);

    const patch = await fetch(api("/api/config"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rewrite: { eager: true } }),
    });
    expect(patch.status).toBe(200);
    expect(config.rewrite.eager).toBe(true);
  });
});
