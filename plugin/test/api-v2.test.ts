import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { authorizedFetch as fetch } from "./http-client.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { startServer, type ServerHandle } from "../src/server.js";
import { buildSuggestion } from "../src/suggestion.js";
import type {
  AutoMemConfig,
  DecisionResult,
  Item,
  MergeJournal,
  QueueItem,
  Suggestion,
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

/** A queue item carrying a ready suggestion; bypasses builders for edge cases. */
function batchQueue(
  id: string,
  item: Partial<QueueItem> = {},
  suggestion: Partial<Suggestion> = {},
): QueueItem {
  const base = { ...makeQueue(), id, ...item };
  return {
    ...base,
    suggestion: {
      id: `sug_${id}`,
      queueID: id,
      action: "create",
      proposedTitle: base.title,
      proposedText: base.text,
      preserved: [base.text],
      dropped: [],
      rationale: "test",
      confidence: 0.95,
      source: "composer",
      validation: { ok: true, errors: [], warnings: [] },
      createdAt: now,
      ...suggestion,
    },
    suggestionState: "ready",
  };
}

function projectCreateQueue(id: string): QueueItem {
  const decision: DecisionResult = {
    kind: "preference",
    duplicate: 0,
    safeAuto: 0.8,
    risk: 0.1,
    confidence: 0.96,
    strictness: "preference",
    reasons: ["test"],
    source: "heuristic",
    mergeAction: "create",
    conflict: 0,
  };
  return {
    ...makeQueue(),
    id,
    title: "[P] 项目安全新建",
    text: "本项目采用 pnpm 安装依赖",
    scope: "project",
    projectKey: "proj-safe",
    project: "/repo/safe",
    decision,
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

interface BatchPreviewBody {
  previewID: string;
  eligible: Array<{
    id: string;
    title: string;
    action: string;
    confidence: number;
    projectKey: string;
    proposedTitle: string;
    proposedText: string;
  }>;
  skipped: number;
  capped: number;
  skippedItems: Array<{ id: string; title?: string; reason: string }>;
  cappedItems: Array<{ id: string; title?: string; reason: string }>;
}

async function previewSuggestion(
  ids: string[],
  options: { minConfidence?: number; max?: number } = {},
): Promise<BatchPreviewBody> {
  const response = await fetch(api("/api/queue/batch"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ids,
      action: "apply_suggestion",
      minConfidence: options.minConfidence ?? 0.9,
      max: options.max ?? 10,
      dryRun: true,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as BatchPreviewBody;
}

async function executeSuggestion(
  ids: string[],
  previewID: string,
  options: { minConfidence?: number; max?: number } = {},
): Promise<Response> {
  return fetch(api("/api/queue/batch"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ids,
      action: "apply_suggestion",
      minConfidence: options.minConfidence ?? 0.9,
      max: options.max ?? 10,
      previewID,
      dryRun: false,
    }),
  });
}

/** Frontend contract: execution carries only previewID, ids, action, dryRun. */
async function executeSuggestionFromPreview(
  ids: string[],
  previewID: string,
): Promise<Response> {
  return fetch(api("/api/queue/batch"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ids,
      action: "apply_suggestion",
      previewID,
      dryRun: false,
    }),
  });
}

async function decisionVersionFor(id: string): Promise<string> {
  const response = await fetch(api("/api/queue"));
  const body = (await response.json()) as {
    items: Array<{ id: string; decisionVersion?: string }>;
  };
  const item = body.items.find((entry) => entry.id === id);
  if (!item?.decisionVersion) throw new Error(`missing decisionVersion for ${id}`);
  return item.decisionVersion;
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
      body: JSON.stringify({
        action: "apply_suggestion",
        expectedVersion: await decisionVersionFor(queue.id),
      }),
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

  it("rejects batch merging a global suggestion", async () => {
    const payload = {
      ids: [queue.id],
      action: "apply_suggestion",
      minConfidence: 0.9,
      max: 10,
    };
    const dry = await fetch(api("/api/queue/batch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, dryRun: true }),
    });
    expect(dry.status).toBe(200);
    const dryBody = (await dry.json()) as {
      previewID: string;
      eligible: unknown[];
      skipped: number;
      skippedItems: Array<{ id: string; reason: string }>;
    };
    expect(dryBody.previewID).toEqual(expect.any(String));
    expect(dryBody.eligible).toEqual([]);
    expect(dryBody.skipped).toBe(1);
    expect(dryBody.skippedItems).toEqual([
      { id: queue.id, title: queue.title, reason: expect.any(String) },
    ]);

    const apply = await fetch(api("/api/queue/batch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...payload,
        previewID: dryBody.previewID,
        dryRun: false,
      }),
    });
    expect(apply.status).toBe(409);
    expect((await store.listQueue()).some((item) => item.id === queue.id)).toBe(true);
  });

  it("batch-applies a validated project-scope create after its preview", async () => {
    const safe = projectCreateQueue("queue_safe_create");
    await store.upsertQueue(safe);
    await buildSuggestion(
      { store, config },
      safe,
      safe.decision as DecisionResult,
    );

    const previewResponse = await fetch(api("/api/queue/batch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: [safe.id],
        action: "apply_suggestion",
        minConfidence: 0.9,
        max: 10,
        dryRun: true,
      }),
    });
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as {
      previewID: string;
      eligible: Array<{
        id: string;
        title: string;
        action: string;
        confidence: number;
        projectKey: string;
        proposedTitle: string;
        proposedText: string;
      }>;
    };
    expect(preview.eligible).toEqual([
      {
        id: safe.id,
        title: safe.title,
        action: "create",
        confidence: 0.96,
        projectKey: "proj-safe",
        proposedTitle: safe.title,
        proposedText: safe.text,
      },
    ]);

    const response = await fetch(api("/api/queue/batch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: [safe.id],
        action: "apply_suggestion",
        minConfidence: 0.9,
        max: 10,
        previewID: preview.previewID,
        dryRun: false,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: Array<{ ok: boolean }> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0].ok).toBe(true);
    expect((await store.listQueue()).some((item) => item.id === safe.id)).toBe(false);
    expect((await store.listItems()).some((item) => item.text === safe.text)).toBe(true);
    const surface = (await store.listChangelog()).find(
      (entry) =>
        entry.action === "apply_suggestion_surface" &&
        entry.queueID === safe.id,
    );
    expect(surface?.source).toBe("local-token-api");
  });

  it("rejects unsafe batch suggestions even when the client lowers minConfidence", async () => {
    const riskyDecision = { ...(makeQueue().decision as DecisionResult), risk: 0.6 };
    const conflictingDecision = { ...(makeQueue().decision as DecisionResult), conflict: 0.51 };
    const fixtures: QueueItem[] = [
      batchQueue("batch_merge", { scope: "project", projectKey: "proj-a" }, { action: "merge_into", targetId: "item_target" }),
      batchQueue("batch_replace", { scope: "project", projectKey: "proj-a" }, { action: "replace", targetId: "item_target" }),
      batchQueue("batch_reject_duplicate", { scope: "project", projectKey: "proj-a" }, { action: "reject_duplicate", targetId: "item_target" }),
      batchQueue("batch_global", { scope: "global" }),
      batchQueue("batch_rule", { kind: "rule", scope: "project", projectKey: "proj-a" }),
      batchQueue("batch_skill", { kind: "skill", scope: "project", projectKey: "proj-a" }),
      batchQueue("batch_review_origin", { scope: "project", projectKey: "proj-a", origin: "session-review" }),
      batchQueue("batch_review_id", { scope: "project", projectKey: "proj-a", reviewID: "review_1" }),
      batchQueue("batch_invalid", { scope: "project", projectKey: "proj-a" }, { validation: { ok: false, errors: ["lint"], warnings: [] } }),
      batchQueue("batch_low", { scope: "project", projectKey: "proj-a" }, { confidence: 0.89 }),
      batchQueue("batch_risk", { scope: "project", projectKey: "proj-a", decision: riskyDecision }),
      batchQueue("batch_conflict", { scope: "project", projectKey: "proj-a", decision: conflictingDecision }),
      batchQueue("batch_unowned", { scope: "project" }),
    ];
    for (const item of fixtures) await store.upsertQueue(item);

    const payload = {
      ids: fixtures.map((item) => item.id),
      action: "apply_suggestion",
      minConfidence: 0,
      max: 20,
    };
    const dry = await fetch(api("/api/queue/batch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, dryRun: true }),
    });
    expect(dry.status).toBe(200);
    const dryBody = (await dry.json()) as { eligible: unknown[]; skipped: number };
    expect(dryBody.eligible).toEqual([]);
    expect(dryBody.skipped).toBe(fixtures.length);

    const apply = await fetch(api("/api/queue/batch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, dryRun: false }),
    });
    expect(apply.status).toBe(409);
    const queueIDs = new Set((await store.listQueue()).map((item) => item.id));
    for (const item of fixtures) expect(queueIDs.has(item.id)).toBe(true);
  });

  it("rejects batch suggestions with missing or unsafe assessment", async () => {
    const fixtures: QueueItem[] = [
      batchQueue("batch_no_decision", {
        scope: "project",
        projectKey: "proj-a",
        decision: undefined,
        jev: undefined,
      }),
      batchQueue("batch_no_conflict", {
        scope: "project",
        projectKey: "proj-a",
        decision: {
          ...(makeQueue().decision as DecisionResult),
          conflict: undefined,
        },
      }),
      batchQueue("batch_nan_risk", {
        scope: "project",
        projectKey: "proj-a",
        decision: {
          ...(makeQueue().decision as DecisionResult),
          risk: Number.NaN,
        },
      }),
      batchQueue("batch_safety", {
        scope: "project",
        projectKey: "proj-a",
        decision: {
          ...(makeQueue().decision as DecisionResult),
          strictness: "safety",
        },
      }),
    ];
    for (const item of fixtures) await store.upsertQueue(item);
    const response = await fetch(api("/api/queue/batch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: fixtures.map((item) => item.id),
        action: "apply_suggestion",
        minConfidence: 0,
        max: 20,
        dryRun: true,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { eligible: unknown[]; skipped: number };
    expect(body.eligible).toEqual([]);
    expect(body.skipped).toBe(fixtures.length);
    const queueIDs = new Set((await store.listQueue()).map((item) => item.id));
    for (const item of fixtures) expect(queueIDs.has(item.id)).toBe(true);
  });

  it("ignores a forged HTTP batchContext", async () => {
    const safe = projectCreateQueue("queue_forged_context");
    await store.upsertQueue(safe);
    await buildSuggestion({ store, config }, safe, safe.decision as DecisionResult);
    const previewResponse = await fetch(api("/api/queue/batch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: [safe.id],
        action: "apply_suggestion",
        minConfidence: 0.9,
        max: 10,
        dryRun: true,
      }),
    });
    const preview = (await previewResponse.json()) as { previewID: string };
    const response = await fetch(api("/api/queue/batch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: [safe.id],
        action: "apply_suggestion",
        minConfidence: 0.9,
        max: 10,
        previewID: preview.previewID,
        dryRun: false,
        batchContext: {
          expectedContentHash: "forged",
          action: "apply_suggestion",
          minConfidence: 0,
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: Array<{ ok: boolean }> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0].ok).toBe(true);
    expect((await store.listQueue()).some((item) => item.id === safe.id)).toBe(false);
  });

  it("requires a preview and rejects missing, forged, and replayed preview IDs", async () => {
    const safe = projectCreateQueue("queue_preview_single_use");
    await store.upsertQueue(safe);
    await buildSuggestion({ store, config }, safe, safe.decision as DecisionResult);

    const missingPreview = await executeSuggestion([safe.id], "");
    expect(missingPreview.status).toBe(409);
    expect(
      ((await missingPreview.json()) as { code?: string }).code,
    ).toBe("BATCH_PREVIEW_REJECTED");
    expect((await executeSuggestion([safe.id], "forged-preview")).status).toBe(409);
    expect((await store.listQueue()).some((item) => item.id === safe.id)).toBe(true);

    const preview = await previewSuggestion([safe.id]);
    expect(preview.eligible.map((item) => item.id)).toEqual([safe.id]);
    const first = await executeSuggestion([safe.id], preview.previewID);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { results: Array<{ ok: boolean }> };
    expect(firstBody.results[0].ok).toBe(true);
    const itemCount = (await store.listItems()).length;

    const replay = await executeSuggestion([safe.id], preview.previewID);
    expect(replay.status).toBe(409);
    expect((await store.listItems()).length).toBe(itemCount);
  });

  it("rejects IDs that do not exactly match the preview", async () => {
    const first = projectCreateQueue("queue_preview_ids_a");
    const second = projectCreateQueue("queue_preview_ids_b");
    for (const item of [first, second]) {
      await store.upsertQueue(item);
      await buildSuggestion({ store, config }, item, item.decision as DecisionResult);
    }

    const previewFirst = await previewSuggestion([first.id]);
    expect((await executeSuggestion([first.id, second.id], previewFirst.previewID)).status).toBe(409);
    expect((await store.listQueue()).some((item) => item.id === first.id)).toBe(true);
    expect((await store.listQueue()).some((item) => item.id === second.id)).toBe(true);

    const previewBoth = await previewSuggestion([first.id, second.id]);
    expect((await executeSuggestion([first.id], previewBoth.previewID)).status).toBe(409);
    expect((await executeSuggestion([second.id], previewBoth.previewID)).status).toBe(409);

    await store.removeQueue(first.id);
    await store.removeQueue(second.id);
  });

  it("caps preview eligibility and rejects IDs outside the previewed cap", async () => {
    const items = Array.from({ length: 12 }, (_, index) =>
      batchQueue(`queue_cap_${index}`, {
        title: `[P] 批量上限 ${index}`,
        text: `项目批量上限测试 ${index}`,
        scope: "project",
        projectKey: "proj-cap",
      }),
    );
    for (const item of items) await store.upsertQueue(item);

    const preview = await previewSuggestion(items.map((item) => item.id), { max: 10 });
    expect(preview.eligible).toHaveLength(10);
    expect(preview.capped).toBe(2);
    expect(preview.skipped).toBe(0);
    expect(preview.cappedItems.map((item) => item.id)).toEqual(
      items.slice(10).map((item) => item.id),
    );
    const withinCap = preview.eligible.map((item) => item.id);
    const beyondPreview = [...withinCap.slice(0, 9), preview.cappedItems[0].id];
    expect((await executeSuggestion(beyondPreview, preview.previewID)).status).toBe(409);

    const apply = await executeSuggestion(withinCap, preview.previewID);
    expect(apply.status).toBe(200);
    const body = (await apply.json()) as { results: Array<{ ok: boolean }> };
    expect(body.results.every((entry) => entry.ok)).toBe(true);
    const remaining = new Set((await store.listQueue()).map((item) => item.id));
    for (const item of items.slice(10)) expect(remaining.has(item.id)).toBe(true);
    for (const item of items.slice(10)) await store.removeQueue(item.id);
  });

  it("expires a preview without sleeping", async () => {
    const expiryDir = await mkdtemp(path.join(os.tmpdir(), "openmem-preview-expiry-"));
    let expiryStore: Store | undefined;
    let expiryServer: ServerHandle | undefined;
    let clock = Date.now();
    try {
      expiryStore = new Store(expiryDir);
      await expiryStore.init();
      const expiryConfig = mergeConfig(DEFAULT_CONFIG, {
        console: false,
        shadow: false,
        rewrite: { enabled: false, eager: false },
      });
      const safe = projectCreateQueue("queue_preview_expiry");
      await expiryStore.upsertQueue(safe);
      await buildSuggestion(
        { store: expiryStore, config: expiryConfig },
        safe,
        safe.decision as DecisionResult,
      );
      expiryServer = await startServer({
        store: expiryStore,
        config: expiryConfig,
        token: "test-token",
        port: 0,
        consoleDir: path.join(expiryDir, "no-console"),
        now: () => clock,
      });
      const localAPI = (pathname: string) =>
        `http://127.0.0.1:${expiryServer?.port}${pathname}?token=test-token`;
      const previewResponse = await fetch(localAPI("/api/queue/batch"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: [safe.id],
          action: "apply_suggestion",
          minConfidence: 0.9,
          max: 10,
          dryRun: true,
        }),
      });
      expect(previewResponse.status).toBe(200);
      const preview = (await previewResponse.json()) as { previewID: string };
      clock += 120_001;
      const execution = await fetch(localAPI("/api/queue/batch"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: [safe.id],
          action: "apply_suggestion",
          minConfidence: 0.9,
          max: 10,
          previewID: preview.previewID,
          dryRun: false,
        }),
      });
      expect(execution.status).toBe(409);
      expect((await expiryStore.listQueue()).some((item) => item.id === safe.id)).toBe(true);
    } finally {
      await expiryServer?.close();
      await rm(expiryDir, { recursive: true, force: true });
    }
  });

  it("returns a per-item failure when a normal batch item appears after screening", async () => {
    const raceDir = await mkdtemp(path.join(os.tmpdir(), "openmem-batch-race-"));
    let raceServer: ServerHandle | undefined;
    try {
      const raceStore = new Store(raceDir);
      await raceStore.init();
      const late: QueueItem = {
        ...batchQueue("queue_late_arrival", {
          title: "[P] 迟到的候选",
          text: "这个候选在初筛后才出现",
          scope: "project",
          projectKey: "proj-race",
        }),
      };
      const originalListQueue = raceStore.listQueue.bind(raceStore);
      let calls = 0;
      raceStore.listQueue = async () => {
        const snapshot = await originalListQueue();
        if (calls++ === 0) await raceStore.upsertQueue(late);
        return snapshot;
      };
      const raceConfig = mergeConfig(DEFAULT_CONFIG, {
        console: false,
        shadow: false,
        rewrite: { enabled: false, eager: false },
      });
      raceServer = await startServer({
        store: raceStore,
        config: raceConfig,
        token: "test-token",
        port: 0,
        consoleDir: path.join(raceDir, "no-console"),
      });
      const response = await fetch(
        `http://127.0.0.1:${raceServer.port}/api/queue/batch?token=test-token`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ids: [late.id],
            decision: { action: "deny" },
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        results: Array<{ id: string; ok: boolean; error?: string }>;
      };
      expect(body.results).toHaveLength(1);
      expect(body.results[0].ok).toBe(false);
      expect(body.results[0].error).toContain("不存在");
      expect((await raceStore.listQueue()).some((item) => item.id === late.id)).toBe(true);
    } finally {
      await raceServer?.close();
      await rm(raceDir, { recursive: true, force: true });
    }
  });

  it("executes custom preview parameters without the client repeating them", async () => {
    const items = [
      batchQueue("queue_custom_params_a", {
        title: "[P] 自定义参数 A",
        text: "项目自定义参数 A",
        scope: "project",
        projectKey: "proj-custom",
      }),
      batchQueue("queue_custom_params_b", {
        title: "[P] 自定义参数 B",
        text: "项目自定义参数 B",
        scope: "project",
        projectKey: "proj-custom",
      }),
    ];
    for (const item of items) await store.upsertQueue(item);

    const preview = await previewSuggestion(
      items.map((item) => item.id),
      { minConfidence: 0.95, max: 1 },
    );
    expect(preview.eligible).toHaveLength(1);
    expect(preview.capped).toBe(1);
    const applyID = preview.eligible[0].id;
    const cappedID = preview.cappedItems[0].id;

    const execution = await executeSuggestionFromPreview([applyID], preview.previewID);
    expect(execution.status).toBe(200);
    const body = (await execution.json()) as { results: Array<{ ok: boolean }> };
    expect(body.results).toHaveLength(1);
    expect(body.results[0].ok).toBe(true);
    const remaining = new Set((await store.listQueue()).map((item) => item.id));
    expect(remaining.has(applyID)).toBe(false);
    expect(remaining.has(cappedID)).toBe(true);

    expect((await executeSuggestionFromPreview([applyID], preview.previewID)).status).toBe(409);
    await store.removeQueue(cappedID);
  });

  it("keeps the default preview executable without repeating parameters", async () => {
    const safe = projectCreateQueue("queue_default_preview_execution");
    await store.upsertQueue(safe);
    await buildSuggestion({ store, config }, safe, safe.decision as DecisionResult);
    const preview = await previewSuggestion([safe.id]);
    const execution = await executeSuggestionFromPreview([safe.id], preview.previewID);
    expect(execution.status).toBe(200);
    const body = (await execution.json()) as { results: Array<{ ok: boolean }> };
    expect(body.results[0].ok).toBe(true);
  });

  it("rejects explicit execution parameters that differ from the frozen preview", async () => {
    const items = [
      batchQueue("queue_explicit_params_a", {
        title: "[P] 显式参数 A",
        text: "项目显式参数 A",
        scope: "project",
        projectKey: "proj-explicit",
      }),
      batchQueue("queue_explicit_params_b", {
        title: "[P] 显式参数 B",
        text: "项目显式参数 B",
        scope: "project",
        projectKey: "proj-explicit",
      }),
    ];
    for (const item of items) await store.upsertQueue(item);
    const ids = items.map((item) => item.id);
    const preview = await previewSuggestion(ids, { minConfidence: 0.95, max: 5 });

    expect((await executeSuggestion(ids, preview.previewID, { minConfidence: 0.9, max: 5 })).status).toBe(409);
    expect((await executeSuggestion(ids, preview.previewID, { minConfidence: 0.99, max: 5 })).status).toBe(409);
    expect((await executeSuggestion(ids, preview.previewID, { minConfidence: 0.95, max: 4 })).status).toBe(409);
    expect((await executeSuggestion(ids, preview.previewID, { minConfidence: 0.95, max: 6 })).status).toBe(409);
    expect((await executeSuggestion(ids, preview.previewID, { minConfidence: 0.9, max: 10 })).status).toBe(409);

    const execution = await executeSuggestion(ids, preview.previewID, {
      minConfidence: 0.95,
      max: 5,
    });
    expect(execution.status).toBe(200);
    const body = (await execution.json()) as { results: Array<{ ok: boolean }> };
    expect(body.results.every((entry) => entry.ok)).toBe(true);
  });

  it("invalidates a preview when the queue snapshot changes but stays valid", async () => {
    const fixtures = [
      batchQueue("preview_stale_text", {
        title: "[P] 预览正文变化",
        text: "项目预览正文变化",
        scope: "project",
        projectKey: "proj-preview",
      }),
      batchQueue("preview_stale_risk", {
        title: "[P] 预览风险变化",
        text: "项目预览风险变化",
        scope: "project",
        projectKey: "proj-preview",
        decision: {
          ...(makeQueue().decision as DecisionResult),
          risk: 0.1,
        },
      }),
      batchQueue("preview_stale_scope", {
        title: "[P] 预览范围变化",
        text: "项目预览范围变化",
        scope: "project",
        projectKey: "proj-preview",
      }),
    ];
    for (const item of fixtures) await store.upsertQueue(item);
    const mutations = [
      (item: QueueItem): QueueItem => ({
        ...item,
        suggestion: {
          ...(item.suggestion as Suggestion),
          proposedText: `${item.text}，仍然安全`,
        },
      }),
      (item: QueueItem): QueueItem => ({
        ...item,
        decision: {
          ...(item.decision as DecisionResult),
          risk: 0.2,
        },
      }),
      (item: QueueItem): QueueItem => ({
        ...item,
        scope: "global",
        projectKey: undefined,
        project: undefined,
      }),
    ];

    for (const [index, item] of fixtures.entries()) {
      const preview = await previewSuggestion([item.id]);
      expect(preview.eligible.map((entry) => entry.id)).toEqual([item.id]);
      await store.upsertQueue(mutations[index](item));
      const execution = await executeSuggestion([item.id], preview.previewID);
      expect(execution.status).toBe(200);
      const body = (await execution.json()) as {
        results: Array<{ ok: boolean; error?: string }>;
      };
      expect(body.results).toHaveLength(1);
      expect(body.results[0].ok).toBe(false);
      expect(body.results[0].error).toContain("批量筛选后变更");
      expect((await store.listQueue()).some((entry) => entry.id === item.id)).toBe(true);
      await store.removeQueue(item.id);
    }
  });

  it("requires an explicit boolean dryRun and does not consume the preview on malformed values", async () => {
    const safe = {
      ...projectCreateQueue("queue_dry_run_boolean"),
      title: "[P] dryRun 布尔边界",
      text: "dryRun 布尔边界专用正文",
    };
    await store.upsertQueue(safe);
    await buildSuggestion({ store, config }, safe, safe.decision as DecisionResult);
    const preview = await previewSuggestion([safe.id]);
    const invalidBodies: Array<Record<string, unknown>> = [
      { ids: [safe.id], action: "apply_suggestion", previewID: preview.previewID, dryRun: "true" },
      { ids: [safe.id], action: "apply_suggestion", previewID: preview.previewID, dryRun: 1 },
      { ids: [safe.id], action: "apply_suggestion", previewID: preview.previewID },
    ];
    for (const invalid of invalidBodies) {
      const response = await fetch(api("/api/queue/batch"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invalid),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code?: string }).code).toBe(
        "BATCH_PREVIEW_REJECTED",
      );
      expect((await store.listQueue()).some((item) => item.id === safe.id)).toBe(true);
      expect((await store.listItems()).some((item) => item.text === safe.text)).toBe(false);
    }
    const execution = await executeSuggestionFromPreview([safe.id], preview.previewID);
    expect(execution.status).toBe(200);
    const body = (await execution.json()) as { results: Array<{ ok: boolean }> };
    expect(body.results[0].ok).toBe(true);
  });

  it("compacts, hides the token, and patches rewrite settings", async () => {
    const compact = await fetch(api("/api/compact"), { method: "POST", body: JSON.stringify({ confirmedByUser: true }) });
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
