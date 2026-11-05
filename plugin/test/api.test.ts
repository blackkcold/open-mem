import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { authorizedFetch as fetch } from "./http-client.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { startServer, type ServerHandle } from "../src/server.js";
import { createSkillDraft } from "../src/skill.js";
import type { QueueItem, ShadowRecord } from "../src/types.js";

let dir: string;
let store: Store;
let server: ServerHandle;
let skillDraftId: string;
let shadowId: string;

const now = new Date().toISOString();

function queueItem(id: string, title: string, text: string): QueueItem {
  return {
    id,
    title,
    text,
    kind: "preference",
    scope: "global",
    status: "queue",
    source: {},
    createdAt: now,
    updatedAt: now,
    priority: 80,
    priorityBreakdown: { risk: 0.2, impact: 0.9, uncertainty: 0.1, age: 0.1 },
    reason: "test queue",
    diff: `+ ${text}`,
    jev: {
      kind: "preference",
      duplicate: 0,
      safeAuto: 0.96,
      risk: 0.1,
      confidence: 0.9,
      strictness: "preference",
      reasons: [],
      source: "heuristic",
    },
  };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openmem-api-"));
  store = new Store(dir);
  await store.init();
  const config = mergeConfig(DEFAULT_CONFIG, { console: false, shadow: false });
  server = await startServer({
    store,
    config,
    token: "test-token",
    port: 0,
    consoleDir: path.join(dir, "no-console"),
  });
  await store.upsertQueue(queueItem("q1", "[P] 先给结论", "回复先给结论"));

  const draft = await createSkillDraft(store, {
    name: "local-api-test",
    title: "Local API test",
    description: "Use when testing a local API flow.",
    scenario: "Exercise the skill review API.",
    references: ["script/test.sh"],
  });
  skillDraftId = draft.id;

  const shadow: ShadowRecord = {
    id: "shadow-api-test",
    candidate: "Swift 包用 swift build 构建",
    title: "[F] swift build",
    kind: "fact",
    scope: "global",
    wouldWriteTo: "AUTO_MEMORY.md",
    wouldApply: 1,
    jev: {
      kind: "fact",
      duplicate: 0,
      safeAuto: 0.96,
      risk: 0.1,
      confidence: 0.9,
      strictness: "unknown",
      reasons: [],
      source: "heuristic",
    },
    priority: 30,
    source: {},
    createdAt: now,
  };
  await store.appendShadow(shadow);
  shadowId = shadow.id;
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

function api(pathname: string): string {
  return `http://127.0.0.1:${server.port}${pathname}${pathname.includes("?") ? "&" : "?"}token=test-token`;
}

describe("HTTP API", () => {
  it("filters queue ownership without losing the available project choices", async () => {
    const ids = ["project-a", "project-b", "project-unknown"];
    try {
      await store.upsertQueue({ ...queueItem(ids[0], "A", "项目 A 记忆"), scope: "project", projectKey: "A", project: "/repo/A" });
      await store.upsertQueue({ ...queueItem(ids[1], "B", "项目 B 记忆"), scope: "project", projectKey: "B", project: "/repo/B" });
      await store.upsertQueue({ ...queueItem(ids[2], "未知", "缺少项目标识"), scope: "project" });
      const filtered = await (await fetch(api("/api/queue?projectKey=A"))).json() as { items: QueueItem[]; projects: Array<{ key: string; label: string }> };
      expect(filtered.items.map((item) => item.id)).toEqual(["project-a"]);
      expect(filtered.projects.map((item) => item.key).sort()).toEqual(["A", "B"]);
      const unassigned = await (await fetch(api("/api/queue?projectKey=__unassigned__"))).json() as { items: QueueItem[] };
      expect(unassigned.items.some((item) => item.id === "project-unknown")).toBe(true);
      expect(unassigned.items.every((item) => !item.projectKey)).toBe(true);
    } finally { for (const id of ids) await store.removeQueue(id); }
  });
  it("provides a read-only retention preview and requires an exact confirmed preview", async () => {
    const before = (await store.listChangelog()).length;
    const previewResponse = await fetch(api("/api/retention/preview"));
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { id: string; policy: { days: number; minRecords: number } };
    expect(preview.policy).toMatchObject({ days: 90, minRecords: 20 });
    expect((await store.listChangelog()).length).toBe(before);
    expect((await fetch(api("/api/retention/apply"), { method: "POST", body: JSON.stringify({ previewID: preview.id }) })).status).toBe(400);
    expect((await fetch(api("/api/retention/apply"), { method: "POST", body: JSON.stringify({ previewID: "stale", confirmedByUser: true }) })).status).toBe(409);
    expect((await fetch(api("/api/retention/apply"), { method: "POST", body: JSON.stringify({ previewID: preview.id, confirmedByUser: true }) })).status).toBe(200);
  });
  it("issues a single-use console link without exposing the long-lived token", async () => {
    const link = new URL(server.createConnectURL());
    expect(link.toString()).not.toContain("test-token");
    const ticket = link.searchParams.get("connect");
    expect(ticket).toBeTruthy();
    const exchange = () => globalThis.fetch(`http://127.0.0.1:${server.port}/api/connect`, { method: "POST", body: JSON.stringify({ ticket }) });
    const first = await exchange();
    expect(first.status).toBe(200);
    expect((await first.json() as { token: string }).token).toBe("test-token");
    expect((await exchange()).status).toBe(401);
  });
  it("converts a skill candidate into a reviewable draft", async () => {
    const entry = { ...queueItem("skill-queue", "流程候选", "检查日志后运行测试验证"), kind: "skill" as const };
    await store.upsertQueue(entry);
    const response = await fetch(api("/api/queue/skill-queue/draft"), { method: "POST" });
    expect(response.status).toBe(200);
    expect((await store.listQueue()).some((item) => item.id === entry.id)).toBe(false);
    expect((await store.listSkillDrafts()).some((draft) => draft.source?.sessionID === entry.source.sessionID)).toBe(true);
  });
  it("rejects invalid numeric settings instead of silently ignoring them", async () => {
    const response = await fetch(api("/api/config"), { method: "PATCH", body: JSON.stringify({ caps: { queue: 0 } }) });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain("caps.queue");
  });
  it("requires confirmation for compaction and supports a read-only preview", async () => {
    const response = await fetch(api("/api/compact"), { method: "POST" });
    expect(response.status).toBe(400);
    const preview = await fetch(api("/api/compact/preview"));
    expect(preview.status).toBe(200);
  });
  it("exposes a bounded operation history", async () => {
    await store.appendChangelog({ action: "test_history" });
    const response = await fetch(api("/api/changelog?limit=1"));
    expect(response.status).toBe(200);
    expect((await response.json() as { items: unknown[] }).items).toHaveLength(1);
  });
  it("rejects query-only authorization for writes", async () => {
    const response = await globalThis.fetch(api("/api/config"), { method: "PATCH", body: JSON.stringify({ shadow: true }) });
    expect(response.status).toBe(401);
    expect((await globalThis.fetch(api("/api/health"))).status).toBe(401);
  });
  it("rejects an untrusted model endpoint without changing config", async () => {
    const response = await globalThis.fetch(api("/api/config"), { method: "PATCH", headers: { authorization: "Bearer test-token" }, body: JSON.stringify({ rewrite: { endpoint: "https://attacker.example" } }) });
    expect(response.status).toBe(400);
  });
  it("reports invalid JSON as a client error", async () => {
    const response = await globalThis.fetch(api("/api/config"), { method: "PATCH", headers: { authorization: "Bearer test-token" }, body: "{" });
    expect(response.status).toBe(400);
  });
  it("rejects an unauthorized request", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(response.status).toBe(401);
  });

  it("returns health and queue", async () => {
    const health = await fetch(api("/api/health"));
    expect(health.status).toBe(200);
    const queue = await fetch(api("/api/queue"));
    const body = (await queue.json()) as { items: QueueItem[] };
    expect(body.items.length).toBe(1);
  });

  it("approves a queue item into AUTO_MEMORY", async () => {
    const response = await fetch(api("/api/queue/q1/decision"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", note: "test" }),
    });
    expect(response.status).toBe(200);
    expect(await store.listQueue()).toEqual([]);
    expect(await store.readAutoMemory()).toContain("先给结论");
  });

  it("runs an audit and returns a map", async () => {
    const audit = await fetch(api("/api/audit/run"), { method: "POST" });
    expect(audit.status).toBe(200);
    const map = await fetch(api("/api/map"));
    expect(map.status).toBe(200);
    const body = (await map.json()) as { nodes: unknown[] };
    expect(Array.isArray(body.nodes)).toBe(true);
  });

  it("returns skill drafts and config", async () => {
    const skills = await fetch(api("/api/skills"));
    expect(skills.status).toBe(200);
    const config = await fetch(api("/api/config"));
    expect(config.status).toBe(200);
  });

  it("returns skill detail content and accepts request_changes", async () => {
    const detail = await fetch(api(`/api/skills/${encodeURIComponent(skillDraftId)}`));
    expect(detail.status).toBe(200);
    const draft = (await detail.json()) as { content?: string };
    expect(draft.content).toContain("name: local-api-test");

    const changes = await fetch(api(`/api/skills/${encodeURIComponent(skillDraftId)}/decision`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "request_changes", notes: "add a real test" }),
    });
    expect(changes.status).toBe(200);
    const changed = (await changes.json()) as { ok: boolean };
    expect(changed.ok).toBe(true);
  });

  it("marks a shadow decision as a false positive and updates metrics", async () => {
    const response = await fetch(api(`/api/shadow/${encodeURIComponent(shadowId)}/false-positive`), {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { falsePositive?: boolean };
    expect(body.falsePositive).toBe(true);
    const metrics = await fetch(api("/api/metrics"));
    const data = (await metrics.json()) as { falsePositive: number };
    expect(data.falsePositive).toBeGreaterThanOrEqual(1);
  });

  it("patches config and reads it back", async () => {
    const patch = await fetch(api("/api/config"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shadow: false }),
    });
    expect(patch.status).toBe(200);
    const config = (await patch.json()) as { shadow: boolean };
    expect(config.shadow).toBe(false);

    const restore = await fetch(api("/api/config"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shadow: true }),
    });
    expect(restore.status).toBe(200);
  });

  it("batch-denies queue items", async () => {
    await store.upsertQueue(queueItem("q2", "[P] two", "two preference"));
    await store.upsertQueue(queueItem("q3", "[P] three", "three preference"));
    const response = await fetch(api("/api/queue/batch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["q2", "q3"], decision: { action: "deny" } }),
    });
    expect(response.status).toBe(200);
    expect(await store.listQueue()).toEqual([]);
  });

  it("streams the SSE ready event", async () => {
    const payload = await new Promise<string>((resolve, reject) => {
      const request = http.get(api("/api/events"), (response) => {
        response.once("data", (chunk: Buffer) => {
          resolve(chunk.toString("utf8"));
          request.destroy();
        });
      });
      request.on("error", (error: Error) => {
        if (!request.destroyed) reject(error);
      });
      request.setTimeout(1_500, () => {
        request.destroy();
        reject(new Error("SSE timeout"));
      });
    });
    expect(payload).toContain("event: ready");
  });
  it("restores a denied candidate from operation history", async () => {
    await store.upsertQueue({ ...queueItem("restore-me", "项目记忆", "项目采用 pnpm"), scope: "project", projectKey: "A" });
    await fetch(api("/api/queue/restore-me/decision"), { method: "POST", body: JSON.stringify({ action: "deny" }) });
    const entry = (await store.listChangelog()).find((entry) => entry.action === "deny" && entry.queueID === "restore-me");
    const response = await fetch(api(`/api/recovery/${entry?.recoveryID}/restore`), { method: "POST" });
    expect(response.status).toBe(200);
    expect((await store.listQueue()).find((item) => item.id === "restore-me")?.projectKey).toBe("A");
    await store.removeQueue("restore-me");
  });
});
