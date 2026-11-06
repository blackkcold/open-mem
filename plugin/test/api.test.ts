import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { authorizedFetch as fetch } from "./http-client.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  const graphOpencode = path.join(dir, "graph-opencode");
  await mkdir(graphOpencode, { recursive: true });
  await writeFile(
    path.join(graphOpencode, "AGENTS.md"),
    "# Rules\n\n## Root Trigger Matrix\n\n| Task Signal | Must Read |\n| --- | --- |\n| deploy | SAFETY |\n\n## 输出规范\n\n回复先给结论，再给细节。\n",
    "utf8",
  );
  server = await startServer({
    store,
    config,
    token: "test-token",
    port: 0,
    consoleDir: path.join(dir, "no-console"),
    projectDir: dir,
    graphRoots: {
      opencodeDir: graphOpencode,
      openchamberDir: path.join(dir, "graph-openchamber"),
      backupRoot: path.join(dir, "graph-backups"),
      logicChainDir: path.join(dir, "graph-logic"),
    },
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

async function decisionVersionFor(id: string): Promise<string> {
  const response = await fetch(api("/api/queue"));
  const body = (await response.json()) as {
    items: Array<{ id: string; decisionVersion?: string }>;
  };
  const item = body.items.find((entry) => entry.id === id);
  if (!item?.decisionVersion) throw new Error(`missing decisionVersion for ${id}`);
  return item.decisionVersion;
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
    const body = (await queue.json()) as {
      items: QueueItem[];
      baseline?: { state: string; analysisVersion?: string };
    };
    expect(body.items.length).toBe(1);
    expect(body.baseline?.state).toBe("ready");
    expect(typeof body.baseline?.analysisVersion).toBe("string");
    expect(body.items[0]?.coverage?.some((entry) => entry.heading === "输出规范")).toBe(true);
    expect(body.items[0]?.coverageSummary?.coveredCount).toBeGreaterThan(0);
  });

  it("reports and refreshes the baseline index without writing memory", async () => {
    const status = await fetch(api("/api/baseline/status"));
    expect(status.status).toBe(200);
    const body = (await status.json()) as { state: string; sections: number };
    expect(body.state).toBe("ready");
    expect(body.sections).toBeGreaterThan(0);
    const refresh = await fetch(api("/api/baseline/refresh"), { method: "POST" });
    expect(refresh.status).toBe(200);
    expect(((await refresh.json()) as { state: string }).state).toBe("ready");
  });

  it("approves a queue item into AUTO_MEMORY", async () => {
    const response = await fetch(api("/api/queue/q1/decision"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", note: "test", expectedVersion: await decisionVersionFor("q1") }),
    });
    expect(response.status).toBe(200);
    expect(await store.listQueue()).toEqual([]);
    expect(await store.readAutoMemory()).toContain("先给结论");
  });

  it("returns a relation acknowledgement conflict over HTTP", async () => {
    const at = new Date().toISOString();
    await store.appendItem({
      id: "api-port-5199",
      title: "[F] 端口",
      text: "API 测试端口是 5199",
      kind: "fact",
      scope: "global",
      status: "auto",
      source: {},
      createdAt: at,
      updatedAt: at,
    });
    await store.upsertQueue({
      ...queueItem("q-ack", "[F] 端口", "API 测试端口是 5198"),
      kind: "fact",
    });
    const response = await fetch(api("/api/queue/q-ack/decision"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        expectedVersion: await decisionVersionFor("q-ack"),
      }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      code?: string;
      conflicts?: Array<{ id: string; relation: string; version: string }>;
    };
    expect(body.code).toBe("RELATION_ACK_REQUIRED");
    expect(body.conflicts?.[0]?.id).toBe("api-port-5199");

    const retry = await fetch(api("/api/queue/q-ack/decision"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        expectedVersion: await decisionVersionFor("q-ack"),
        acknowledgedRelations: (body.conflicts ?? []).map((entry) => ({
          id: entry.id,
          relation: entry.relation,
          version: entry.version,
        })),
      }),
    });
    expect(retry.status).toBe(200);
    expect((await store.listQueue()).some((entry) => entry.id === "q-ack")).toBe(false);
  });

  it("runs an audit and returns a map", async () => {
    const audit = await fetch(api("/api/audit/run"), { method: "POST" });
    expect(audit.status).toBe(200);
    const map = await fetch(api("/api/map"));
    expect(map.status).toBe(200);
    const body = (await map.json()) as { nodes: Array<Record<string, unknown>> };
    expect(Array.isArray(body.nodes)).toBe(true);
    for (const node of body.nodes) {
      expect(node).not.toHaveProperty("text");
      expect(node).not.toHaveProperty("candidate");
    }
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("回复先给结论");
    expect(wire).not.toContain("Swift 包用 swift build 构建");
  });

  it("returns the five-view memory graph and a bounded source detail", async () => {
    const graph = await fetch(api("/api/graph"));
    expect(graph.status).toBe(200);
    const body = (await graph.json()) as {
      sources: Array<{ id: string }>;
      views: Record<string, { nodes: unknown[] }>;
    };
    expect(body.sources.some((source) => source.id === "l0:agents")).toBe(true);
    expect(Object.keys(body.views).sort()).toEqual([
      "architecture",
      "automation",
      "backup",
      "inventory",
      "routing",
    ]);
    expect(JSON.stringify(body)).not.toContain("回复先给结论");

    const detail = await fetch(api("/api/graph/source?id=l0%3Aagents"));
    expect(detail.status).toBe(200);
    const source = (await detail.json()) as { excerpt: string; headings: string[] };
    expect(source.excerpt).toContain("Root Trigger Matrix");
    expect(source.headings).toContain("Root Trigger Matrix");

    const missing = await fetch(api("/api/graph/source?id=missing"));
    expect(missing.status).toBe(404);
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

  it("rejects batch approval, edit, apply and promote actions", async () => {
    const id = "q-batch-approval";
    await store.upsertQueue(queueItem(id, "[P] batch", "batch preference"));
    const payloads = [
      { ids: [id], decision: { action: "approve" } },
      { ids: [id], decision: { action: "edit", text: "changed" } },
      { ids: [id], decision: { action: "apply_suggestion" } },
      { ids: [id], decision: { action: "promote", targetScope: "global" } },
      { ids: [id], action: "approve" },
      { ids: [id], action: "approve", decision: { action: "approve" } },
    ];
    for (const payload of payloads) {
      const response = await fetch(api("/api/queue/batch"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
    }
    expect((await store.listQueue()).find((item) => item.id === id)?.text).toBe("batch preference");
    expect((await store.listItems()).some((item) => item.tags?.includes(id))).toBe(false);
    await store.removeQueue(id);
  });

  it("never batch-processes rule or review candidates, even for deny", async () => {
    const rule = { ...queueItem("q-batch-rule", "[R] rule", "回复必须使用 Markdown 格式"), kind: "rule" as const };
    const review = { ...queueItem("q-batch-review", "[F] review", "复盘候选"), origin: "session-review" as const };
    const reviewed = { ...queueItem("q-batch-reviewed", "[F] reviewed", "带复盘来源的候选"), reviewID: "review_batch" };
    for (const item of [rule, review, reviewed]) await store.upsertQueue(item);
    for (const decision of [{ action: "deny" }, { action: "defer" }]) {
      const response = await fetch(api("/api/queue/batch"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: [rule.id, review.id, reviewed.id], decision }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        results: Array<{ id: string; ok: boolean; error?: string }>;
      };
      expect(body.results).toHaveLength(3);
      expect(body.results.every((entry) => entry.ok === false)).toBe(true);
      expect(body.results.every((entry) => entry.error?.includes("不能批量"))).toBe(true);
    }
    for (const item of [rule, review, reviewed]) {
      expect((await store.listQueue()).some((entry) => entry.id === item.id)).toBe(true);
      await store.removeQueue(item.id);
    }
  });

  it("still approves a single rule through the user decision lane", async () => {
    const id = "q-single-rule";
    await store.upsertQueue({ ...queueItem(id, "[R] 单条规则", "回复必须使用 Markdown 格式"), kind: "rule" });
    const response = await fetch(api(`/api/queue/${id}/decision`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", expectedVersion: await decisionVersionFor(id) }),
    });
    expect(response.status).toBe(200);
    expect(await store.readAutoRules()).toContain("回复必须使用 Markdown 格式");
    expect((await store.listQueue()).some((item) => item.id === id)).toBe(false);
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
    await fetch(api("/api/queue/restore-me/decision"), { method: "POST", body: JSON.stringify({ action: "deny", expectedVersion: await decisionVersionFor("restore-me") }) });
    const entry = (await store.listChangelog()).find((entry) => entry.action === "deny" && entry.queueID === "restore-me");
    const response = await fetch(api(`/api/recovery/${entry?.recoveryID}/restore`), { method: "POST" });
    expect(response.status).toBe(200);
    expect((await store.listQueue()).find((item) => item.id === "restore-me")?.projectKey).toBe("A");
    await store.removeQueue("restore-me");
  });

  it("labels local-token decisions from the trusted server path, not the body", async () => {
    const secret = "SYNTHETIC_BODY_TEXT_MUST_NOT_BE_LOGGED";
    await store.upsertQueue(queueItem("q-source-http", "[P] 来源", secret));
    const response = await fetch(api("/api/queue/q-source-http/decision"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "deny",
        source: "agent-tool",
        surface: "agent-tool",
        expectedVersion: await decisionVersionFor("q-source-http"),
      }),
    });
    expect(response.status).toBe(200);
    const entry = (await store.listChangelog()).find(
      (row) => row.action === "deny" && row.queueID === "q-source-http",
    );
    expect(entry?.source).toBe("local-token-api");
    expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it("records only successful batch decisions with the local token source", async () => {
    const secret = "SYNTHETIC_BATCH_CANDIDATE_TEXT";
    await store.upsertQueue(queueItem("q-batch-source", "[P] 批量来源", secret));
    await store.upsertQueue({
      ...queueItem("q-batch-source-rule", "[R] 批量规则", "回复必须使用 Markdown 格式"),
      kind: "rule",
    });
    const response = await fetch(api("/api/queue/batch"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: ["q-batch-source", "q-batch-source-rule"],
        decision: { action: "deny", source: "agent-tool" },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Array<{ id: string; ok: boolean }>;
    };
    expect(body.results.find((item) => item.id === "q-batch-source")?.ok).toBe(true);
    expect(body.results.find((item) => item.id === "q-batch-source-rule")?.ok).toBe(false);
    const rows = await store.listChangelog();
    const denied = rows.find(
      (row) => row.action === "deny" && row.queueID === "q-batch-source",
    );
    expect(denied?.source).toBe("local-token-api");
    expect(JSON.stringify(denied)).not.toContain(secret);
    expect(
      rows.some(
        (row) => row.action === "deny" && row.queueID === "q-batch-source-rule",
      ),
    ).toBe(false);
    await store.removeQueue("q-batch-source-rule");
  });

  it("logs successful config field names only and does not log failed patches", async () => {
    const before = (await store.listChangelog()).length;
    const secret = "SYNTHETIC_SECRET_CONFIG_VALUE";
    const success = await fetch(api("/api/config"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: { apiKeyEnv: secret } }),
    });
    expect(success.status).toBe(200);
    const entry = (await store.listChangelog())
      .slice(before)
      .find((row) => row.action === "config_update");
    expect(entry?.source).toBe("local-token-api");
    expect(entry?.fields).toEqual(
      expect.arrayContaining(["decision.apiKeyEnv"]),
    );
    expect(JSON.stringify(entry)).not.toContain(secret);
    expect(JSON.stringify(entry)).not.toContain("test-token");

    const visible = await fetch(api("/api/changelog?action=config_update&limit=1"));
    expect(visible.status).toBe(200);
    const visibleBody = (await visible.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(visibleBody.items[0]?.source).toBe("local-token-api");
    expect(visibleBody.items[0]?.fields).toEqual(
      expect.arrayContaining(["decision.apiKeyEnv"]),
    );

    const afterSuccess = (await store.listChangelog()).length;
    const failed = await fetch(api("/api/config"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caps: { queue: 0 } }),
    });
    expect(failed.status).toBe(400);
    expect((await store.listChangelog()).length).toBe(afterSuccess);
  });

  it("serializes concurrent config patches and preserves a successful peer", async () => {
    const patchDir = await mkdtemp(path.join(os.tmpdir(), "openmem-config-patch-"));
    let patchServer: ServerHandle | undefined;
    try {
      const patchStore = new Store(patchDir);
      await patchStore.init();
      const patchConfig = mergeConfig(DEFAULT_CONFIG, {
        console: false,
        shadow: false,
      });
      const originalTransaction = patchStore.transaction.bind(patchStore);
      const originalWriteConfig = patchStore.writeConfig.bind(patchStore);
      let transactionCalls = 0;
      let writeCalls = 0;
      let releaseFirst!: () => void;
      let signalFirst!: () => void;
      let releaseSecond!: () => void;
      let signalSecond!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        signalFirst = resolve;
      });
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const secondEntered = new Promise<void>((resolve) => {
        signalSecond = resolve;
      });
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      patchStore.transaction = async function (fn) {
        transactionCalls += 1;
        if (transactionCalls === 1) {
          signalFirst();
          await firstGate;
        } else if (transactionCalls === 2) {
          signalSecond();
          await secondGate;
        }
        return originalTransaction(fn);
      };
      patchStore.writeConfig = async (next) => {
        writeCalls += 1;
        if (writeCalls === 1) {
          throw new Error("synthetic config write failure");
        }
        return originalWriteConfig(next);
      };
      patchServer = await startServer({
        store: patchStore,
        config: patchConfig,
        token: "test-token",
        port: 0,
        consoleDir: path.join(patchDir, "no-console"),
      });
      const patchAPI = (pathname: string) =>
        `http://127.0.0.1:${patchServer?.port}${pathname}?token=test-token`;
      const first = fetch(patchAPI("/api/config"), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: { apiKeyEnv: "SYNTHETIC_PATCH_A" } }),
      });
      await firstEntered;
      const second = fetch(patchAPI("/api/config"), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caps: { queue: 49 } }),
      });
      await Promise.race([
        secondEntered,
        new Promise((resolve) => setTimeout(resolve, 50)),
      ]);
      releaseFirst();
      const firstResponse = await first;
      releaseSecond();
      const secondResponse = await second;
      expect(firstResponse.status).toBe(500);
      expect(secondResponse.status).toBe(200);
      const finalConfig = (await (
        await fetch(patchAPI("/api/config"))
      ).json()) as {
        decision: { apiKeyEnv: string };
        caps: { queue: number };
      };
      expect(finalConfig.caps.queue).toBe(49);
      expect(finalConfig.decision.apiKeyEnv).not.toBe("SYNTHETIC_PATCH_A");
      const logs = (await patchStore.listChangelog()).filter(
        (row) => row.action === "config_update",
      );
      expect(logs).toHaveLength(1);
      expect(logs[0].fields).toEqual(["caps.queue"]);
      expect(logs[0].source).toBe("local-token-api");
    } finally {
      await patchServer?.close();
      await rm(patchDir, { recursive: true, force: true });
    }
  });

  it("preserves different config fields across two servers sharing one data dir", async () => {
    const sharedDir = await mkdtemp(path.join(os.tmpdir(), "openmem-config-shared-"));
    let serverA: ServerHandle | undefined;
    let serverB: ServerHandle | undefined;
    try {
      const storeA = new Store(sharedDir);
      const storeB = new Store(sharedDir);
      await storeA.init();
      await storeB.init();
      const configA = mergeConfig(DEFAULT_CONFIG, { console: false, shadow: false });
      const configB = mergeConfig(DEFAULT_CONFIG, { console: false, shadow: false });
      serverA = await startServer({
        store: storeA,
        config: configA,
        token: "test-token",
        port: 0,
        consoleDir: path.join(sharedDir, "no-console"),
      });
      serverB = await startServer({
        store: storeB,
        config: configB,
        token: "test-token",
        port: 0,
        consoleDir: path.join(sharedDir, "no-console"),
      });
      const first = await fetch(
        `http://127.0.0.1:${serverA.port}/api/config?token=test-token`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caps: { queue: 49 } }),
        },
      );
      expect(first.status).toBe(200);
      const second = await fetch(
        `http://127.0.0.1:${serverB.port}/api/config?token=test-token`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rewrite: { eager: false } }),
        },
      );
      expect(second.status).toBe(200);
      const persisted = await storeA.readConfig();
      expect(persisted.caps.queue).toBe(49);
      expect(persisted.rewrite.eager).toBe(false);
      const logs = (await storeA.listChangelog()).filter(
        (row) => row.action === "config_update",
      );
      expect(logs).toHaveLength(2);
      expect(logs.map((row) => row.fields)).toEqual(
        expect.arrayContaining([["caps.queue"], ["rewrite.eager"]]),
      );
      expect(logs.every((row) => row.source === "local-token-api")).toBe(true);
    } finally {
      await serverA?.close();
      await serverB?.close();
      await rm(sharedDir, { recursive: true, force: true });
    }
  });

  it("does not let a failed peer config write remove a successful update", async () => {
    const sharedDir = await mkdtemp(path.join(os.tmpdir(), "openmem-config-shared-fail-"));
    let serverA: ServerHandle | undefined;
    let serverB: ServerHandle | undefined;
    try {
      const storeA = new Store(sharedDir);
      const storeB = new Store(sharedDir);
      await storeA.init();
      await storeB.init();
      storeA.writeConfig = async () => {
        throw new Error("synthetic cross-server config failure");
      };
      const configA = mergeConfig(DEFAULT_CONFIG, { console: false, shadow: false });
      const configB = mergeConfig(DEFAULT_CONFIG, { console: false, shadow: false });
      serverA = await startServer({
        store: storeA,
        config: configA,
        token: "test-token",
        port: 0,
        consoleDir: path.join(sharedDir, "no-console"),
      });
      serverB = await startServer({
        store: storeB,
        config: configB,
        token: "test-token",
        port: 0,
        consoleDir: path.join(sharedDir, "no-console"),
      });
      const failed = await fetch(
        `http://127.0.0.1:${serverA.port}/api/config?token=test-token`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rewrite: { eager: false } }),
        },
      );
      expect(failed.status).toBe(500);
      const succeeded = await fetch(
        `http://127.0.0.1:${serverB.port}/api/config?token=test-token`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caps: { queue: 49 } }),
        },
      );
      expect(succeeded.status).toBe(200);
      const persisted = await storeB.readConfig();
      expect(persisted.caps.queue).toBe(49);
      expect(persisted.rewrite.eager).toBe(true);
      const logs = (await storeB.listChangelog()).filter(
        (row) => row.action === "config_update",
      );
      expect(logs).toHaveLength(1);
      expect(logs[0].fields).toEqual(["caps.queue"]);
      expect(logs[0].source).toBe("local-token-api");
    } finally {
      await serverA?.close();
      await serverB?.close();
      await rm(sharedDir, { recursive: true, force: true });
    }
  });

  it("merges a partial legacy config with defaults without dropping old values", async () => {
    const legacyDir = await mkdtemp(path.join(os.tmpdir(), "openmem-config-legacy-"));
    let legacyServer: ServerHandle | undefined;
    try {
      const legacyStore = new Store(legacyDir);
      await legacyStore.init();
      await writeFile(
        path.join(legacyDir, "config.json"),
        JSON.stringify({ version: 1, shadow: true, legacy: { keep: true } }),
      );
      const legacyConfig = mergeConfig(DEFAULT_CONFIG, {
        console: false,
        shadow: false,
      });
      legacyServer = await startServer({
        store: legacyStore,
        config: legacyConfig,
        token: "test-token",
        port: 0,
        consoleDir: path.join(legacyDir, "no-console"),
      });
      const response = await fetch(
        `http://127.0.0.1:${legacyServer.port}/api/config?token=test-token`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            review: { minConfidence: 0.8 },
            caps: { queue: 49 },
          }),
        },
      );
      expect(response.status).toBe(200);
      const persisted = await legacyStore.readConfig();
      expect(persisted.shadow).toBe(true);
      expect(persisted.version).toBe(1);
      expect(persisted.review.minConfidence).toBe(0.8);
      expect(persisted.review.idleMs).toBe(DEFAULT_CONFIG.review.idleMs);
      expect(persisted.caps.queue).toBe(49);
      expect(persisted.caps.itemsTotal).toBe(DEFAULT_CONFIG.caps.itemsTotal);
      const raw = JSON.parse(
        await readFile(path.join(legacyDir, "config.json"), "utf8"),
      ) as { legacy?: { keep?: boolean } };
      expect(raw.legacy?.keep).toBe(true);
    } finally {
      await legacyServer?.close();
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it("logs a field changed only in this instance's live config", async () => {
    const sharedDir = await mkdtemp(path.join(os.tmpdir(), "openmem-config-live-"));
    let serverA: ServerHandle | undefined;
    let serverB: ServerHandle | undefined;
    try {
      const storeA = new Store(sharedDir);
      const storeB = new Store(sharedDir);
      await storeA.init();
      await storeB.init();
      const configA = mergeConfig(DEFAULT_CONFIG, { console: false, shadow: true });
      const configB = mergeConfig(DEFAULT_CONFIG, { console: false, shadow: true });
      serverA = await startServer({
        store: storeA,
        config: configA,
        token: "test-token",
        port: 0,
        consoleDir: path.join(sharedDir, "no-console"),
      });
      serverB = await startServer({
        store: storeB,
        config: configB,
        token: "test-token",
        port: 0,
        consoleDir: path.join(sharedDir, "no-console"),
      });
      const first = await fetch(
        `http://127.0.0.1:${serverA.port}/api/config?token=test-token`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ shadow: false }),
        },
      );
      expect(first.status).toBe(200);
      const beforeSecond = (await storeB.listChangelog()).length;
      const second = await fetch(
        `http://127.0.0.1:${serverB.port}/api/config?token=test-token`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ shadow: false }),
        },
      );
      expect(second.status).toBe(200);
      const live = (await (
        await fetch(`http://127.0.0.1:${serverB.port}/api/config?token=test-token`)
      ).json()) as { shadow: boolean };
      expect(live.shadow).toBe(false);
      const added = (await storeB.listChangelog()).slice(beforeSecond);
      const entry = added.find((row) => row.action === "config_update");
      expect(entry?.fields).toEqual(["shadow"]);
      expect(entry?.source).toBe("local-token-api");
      expect(entry && "shadow" in entry).toBe(false);
    } finally {
      await serverA?.close();
      await serverB?.close();
      await rm(sharedDir, { recursive: true, force: true });
    }
  });

  it("does not swallow corrupt config JSON", async () => {
    const corruptDir = await mkdtemp(path.join(os.tmpdir(), "openmem-config-corrupt-"));
    let corruptServer: ServerHandle | undefined;
    try {
      const corruptStore = new Store(corruptDir);
      await corruptStore.init();
      const configFile = path.join(corruptDir, "config.json");
      const corrupt = "{not valid json";
      await writeFile(configFile, corrupt);
      corruptServer = await startServer({
        store: corruptStore,
        config: mergeConfig(DEFAULT_CONFIG, { console: false, shadow: false }),
        token: "test-token",
        port: 0,
        consoleDir: path.join(corruptDir, "no-console"),
      });
      const response = await fetch(
        `http://127.0.0.1:${corruptServer.port}/api/config?token=test-token`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ caps: { queue: 49 } }),
        },
      );
      expect(response.status).toBe(500);
      expect(await readFile(configFile, "utf8")).toBe(corrupt);
    } finally {
      await corruptServer?.close();
      await rm(corruptDir, { recursive: true, force: true });
    }
  });

  it("requires the displayed decision version and rejects a stale confirmation", async () => {
    const id = "q-version-basic";
    const at = new Date().toISOString();
    await store.upsertQueue(queueItem(id, "[P] 版本", "版本前置条件测试"));
    const listed = (await (await fetch(api("/api/queue"))).json()) as {
      items: Array<{ id: string; decisionVersion?: string }>;
    };
    const version = listed.items.find((item) => item.id === id)?.decisionVersion;
    expect(version).toEqual(expect.any(String));
    const stored = (await store.listQueue()).find((item) => item.id === id) as
      | (QueueItem & { decisionVersion?: string })
      | undefined;
    expect(stored && "decisionVersion" in stored).toBe(false);

    const missing = await fetch(api(`/api/queue/${id}/decision`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "deny" }),
    });
    expect(missing.status).toBe(400);
    expect((await store.listQueue()).some((item) => item.id === id)).toBe(true);

    const forged = await fetch(api(`/api/queue/${id}/decision`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "deny", expectedVersion: "forged" }),
    });
    expect(forged.status).toBe(409);
    expect((await store.listQueue()).some((item) => item.id === id)).toBe(true);

    const success = await fetch(api(`/api/queue/${id}/decision`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "deny", expectedVersion: version }),
    });
    expect(success.status).toBe(200);
    expect((await store.listQueue()).some((item) => item.id === id)).toBe(false);
    expect(at).toEqual(expect.any(String));
  });

  it("rejects an old version after the suggestion action or target changes", async () => {
    const id = "q-version-suggestion";
    const at = new Date().toISOString();
    const item: QueueItem = {
      ...queueItem(id, "[P] 建议版本", "建议版本原始正文"),
      scope: "project",
      projectKey: "proj-version",
      suggestion: {
        id: "sug-version",
        queueID: id,
        action: "create",
        proposedTitle: "[P] 建议版本",
        proposedText: "建议版本原始正文",
        preserved: ["建议版本原始正文"],
        dropped: [],
        rationale: "test",
        confidence: 0.96,
        source: "composer",
        validation: { ok: true, errors: [], warnings: [] },
        createdAt: at,
      },
      suggestionState: "ready",
    };
    await store.upsertQueue(item);
    const version = await decisionVersionFor(id);
    const beforeJournal = (await store.listJournal()).length;
    await store.upsertQueue({
      ...item,
      suggestion: {
        ...item.suggestion!,
        action: "merge_into",
        targetId: "other-target",
        proposedText: "建议版本被替换的正文",
      },
    });
    const response = await fetch(api(`/api/queue/${id}/decision`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "apply_suggestion", expectedVersion: version }),
    });
    expect(response.status).toBe(409);
    expect((await store.listQueue()).some((entry) => entry.id === id)).toBe(true);
    expect((await store.listJournal()).length).toBe(beforeJournal);
    await store.removeQueue(id);
  });

  it("detects a risk change even when updatedAt is unchanged", async () => {
    const id = "q-version-risk";
    const base = queueItem(id, "[P] 风险版本", "风险版本测试");
    const item: QueueItem = {
      ...base,
      decision: {
        ...(base.jev as NonNullable<QueueItem["jev"]>),
        conflict: 0,
      },
    };
    await store.upsertQueue(item);
    const version = await decisionVersionFor(id);
    const queue = await store.listQueue();
    await store.writeQueue(
      queue.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              decision: {
                ...(entry.decision as NonNullable<QueueItem["decision"]>),
                risk: 0.9,
              },
            }
          : entry,
      ),
    );
    const response = await fetch(api(`/api/queue/${id}/decision`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "deny", expectedVersion: version }),
    });
    expect(response.status).toBe(409);
    expect((await store.listQueue()).find((entry) => entry.id === id)?.decision?.risk).toBe(0.9);
    await store.removeQueue(id);
  });

  it("returns the persisted version after defer and resume over HTTP", async () => {
    const id = "q-defer-version-http";
    await store.upsertQueue(queueItem(id, "[P] HTTP 延后版本", "HTTP 延后版本测试"));
    const version = await decisionVersionFor(id);
    const deferred = await fetch(api(`/api/queue/${id}/decision`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "defer", expectedVersion: version }),
    });
    expect(deferred.status).toBe(200);
    const deferredBody = (await deferred.json()) as {
      decisionVersion?: string;
      item?: { deferredUntil?: string };
    };
    expect(deferredBody.decisionVersion).toEqual(expect.any(String));
    expect(deferredBody.item?.deferredUntil).toBeTruthy();
    const listed = (await (await fetch(api("/api/queue"))).json()) as {
      items: Array<{ id: string; decisionVersion?: string }>;
    };
    expect(
      listed.items.find((item) => item.id === id)?.decisionVersion,
    ).toBe(deferredBody.decisionVersion);

    const resumed = await fetch(api(`/api/queue/${id}/decision`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "resume",
        expectedVersion: deferredBody.decisionVersion,
      }),
    });
    expect(resumed.status).toBe(200);
    const resumedBody = (await resumed.json()) as {
      decisionVersion?: string;
      item?: { deferredUntil?: string };
    };
    expect(resumedBody.decisionVersion).toEqual(expect.any(String));
    expect(resumedBody.item?.deferredUntil).toBeUndefined();
    const listedAfter = (await (await fetch(api("/api/queue"))).json()) as {
      items: Array<{ id: string; decisionVersion?: string }>;
    };
    expect(
      listedAfter.items.find((item) => item.id === id)?.decisionVersion,
    ).toBe(resumedBody.decisionVersion);
    await store.removeQueue(id);
  });

  it("does not return a success version when a stale defer conflicts", async () => {
    const id = "q-defer-stale-http";
    const original = queueItem(id, "[P] 过期延后", "过期延后测试");
    await store.upsertQueue(original);
    const version = await decisionVersionFor(id);
    await store.upsertQueue({ ...original, title: "[P] 已被他人修改" });
    const response = await fetch(api(`/api/queue/${id}/decision`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "defer", expectedVersion: version }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.decisionVersion).toBeUndefined();
    const row = (await store.listQueue()).find((item) => item.id === id);
    expect(row?.title).toBe("[P] 已被他人修改");
    expect(row?.deferredUntil).toBeUndefined();
    await store.removeQueue(id);
  });

  it("exposes a persisted settings snapshot alongside live values across two instances", async () => {
    const sharedDir = await mkdtemp(path.join(os.tmpdir(), "openmem-settings-preview-"));
    let serverA: ServerHandle | undefined;
    let serverB: ServerHandle | undefined;
    try {
      const storeA = new Store(sharedDir);
      const storeB = new Store(sharedDir);
      await storeA.init();
      await storeB.init();
      const configA = mergeConfig(DEFAULT_CONFIG, { console: false, shadow: true });
      const configB = mergeConfig(DEFAULT_CONFIG, { console: false, shadow: false });
      serverA = await startServer({
        store: storeA,
        config: configA,
        token: "test-token",
        port: 0,
        consoleDir: path.join(sharedDir, "no-console"),
      });
      serverB = await startServer({
        store: storeB,
        config: configB,
        token: "test-token",
        port: 0,
        consoleDir: path.join(sharedDir, "no-console"),
      });
      const call = async (
        port: number,
        method: "GET" | "PATCH",
        body?: Record<string, unknown>,
      ) =>
        fetch(`http://127.0.0.1:${port}/api/config?token=test-token`, {
          method,
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
      const changed = await call(serverA.port, "PATCH", { caps: { queue: 49 } });
      expect(changed.status).toBe(200);
      const changedBody = (await changed.json()) as {
        persistedSettings: Record<
          string,
          { value: string | number | boolean | null; differsFromLive: boolean }
        >;
      };
      expect(changedBody.persistedSettings["caps.queue"]).toEqual({
        value: 49,
        differsFromLive: false,
      });

      const aGet = (await (await call(serverA.port, "GET")).json()) as {
        configRevision: string;
      };
      const bGet = (await (await call(serverB.port, "GET")).json()) as {
        shadow: boolean;
        configRevision: string;
        persistedSettings: Record<
          string,
          { value: string | number | boolean | null; differsFromLive: boolean }
        >;
      };
      expect(bGet.shadow).toBe(false);
      expect(bGet.configRevision).toBe(aGet.configRevision);
      expect(bGet.persistedSettings["caps.queue"]).toEqual({
        value: 49,
        differsFromLive: true,
      });
      expect(bGet.persistedSettings.shadow).toEqual({
        value: true,
        differsFromLive: true,
      });

      const second = await call(serverB.port, "PATCH", {
        caps: { queue: 48 },
        expectedConfigRevision: bGet.configRevision,
      });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as {
        configRevision: string;
        persistedSettings: Record<
          string,
          { value: string | number | boolean | null; differsFromLive: boolean }
        >;
      };
      expect(secondBody.configRevision).not.toBe(bGet.configRevision);
      expect(secondBody.persistedSettings["caps.queue"]).toEqual({
        value: 48,
        differsFromLive: false,
      });
      expect((await storeA.readConfig()).caps.queue).toBe(48);

      const bAfter = (await (await call(serverB.port, "GET")).json()) as {
        configRevision: string;
        persistedSettings: Record<
          string,
          { value: string | number | boolean | null; differsFromLive: boolean }
        >;
      };
      const stale = await call(serverB.port, "PATCH", {
        caps: { queue: 47 },
        expectedConfigRevision: bGet.configRevision,
      });
      expect(stale.status).toBe(409);
      const staleBody = (await stale.json()) as Record<string, unknown>;
      expect(staleBody.persistedSettings).toBeUndefined();
      expect((await storeA.readConfig()).caps.queue).toBe(48);
      expect(bAfter.persistedSettings["caps.queue"]).toEqual({
        value: 48,
        differsFromLive: false,
      });
    } finally {
      await serverA?.close();
      await serverB?.close();
      await rm(sharedDir, { recursive: true, force: true });
    }
  });

  it("exports only whitelisted persisted settings and hides unsafe endpoints", async () => {
    const previewDir = await mkdtemp(path.join(os.tmpdir(), "openmem-settings-safe-"));
    let previewServer: ServerHandle | undefined;
    try {
      const previewStore = new Store(previewDir);
      await previewStore.init();
      await writeFile(
        path.join(previewDir, "config.json"),
        JSON.stringify({
          ...DEFAULT_CONFIG,
          token: "SYNTHETIC_CONFIG_TOKEN",
          unknown: { secret: "SYNTHETIC_UNKNOWN_VALUE" },
          decision: {
            ...DEFAULT_CONFIG.decision,
            endpoint:
              "https://synthetic-user:synthetic-pass@ollama.com/v1?secret=SYNTHETIC_ENDPOINT_SECRET#frag",
          },
        }),
      );
      previewServer = await startServer({
        store: previewStore,
        config: mergeConfig(DEFAULT_CONFIG, { console: false, shadow: false }),
        token: "test-token",
        port: 0,
        consoleDir: path.join(previewDir, "no-console"),
      });
      const response = await fetch(
        `http://127.0.0.1:${previewServer.port}/api/config?token=test-token`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        configRevision: string;
        persistedSettings: Record<
          string,
          { value: string | number | boolean | null; differsFromLive: boolean }
        >;
      };
      expect(Object.keys(body.persistedSettings)).toHaveLength(40);
      expect(body.persistedSettings["decision.endpoint"]).toEqual({
        value: null,
        differsFromLive: true,
      });
      expect(body.persistedSettings["rewrite.model.variant"]).toEqual({
        value: DEFAULT_CONFIG.rewrite.model.variant,
        differsFromLive: false,
      });
      const serialized = JSON.stringify(body.persistedSettings);
      expect(serialized).not.toContain("SYNTHETIC_CONFIG_TOKEN");
      expect(serialized).not.toContain("SYNTHETIC_UNKNOWN_VALUE");
      expect(serialized).not.toContain("SYNTHETIC_ENDPOINT_SECRET");
      expect(serialized).not.toContain("synthetic-user");
      expect(serialized).not.toContain("synthetic-pass");
      expect("token" in body.persistedSettings).toBe(false);
      expect("dataDir" in body.persistedSettings).toBe(false);
      expect("unknown" in body.persistedSettings).toBe(false);
      expect(body.configRevision).not.toContain("SYNTHETIC_CONFIG_TOKEN");
    } finally {
      await previewServer?.close();
      await rm(previewDir, { recursive: true, force: true });
    }
  });

  it("guards config edits with a reproducible revision and keeps old clients compatible", async () => {
    const initial = await fetch(api("/api/config"));
    const initialBody = (await initial.json()) as {
      configRevision: string;
      caps: { queue: number };
    };
    expect(initialBody.configRevision).toEqual(expect.any(String));
    expect(initialBody.configRevision).not.toContain("test-token");
    expect("token" in initialBody).toBe(false);
    const revision0 = initialBody.configRevision;

    const first = await fetch(api("/api/config"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        caps: { queue: 49 },
        expectedConfigRevision: revision0,
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { configRevision: string };
    expect(firstBody.configRevision).toEqual(expect.any(String));
    expect(firstBody.configRevision).not.toBe(revision0);

    const logsBeforeConflict = (await store.listChangelog()).length;
    const stale = await fetch(api("/api/config"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        caps: { queue: 48 },
        expectedConfigRevision: revision0,
      }),
    });
    expect(stale.status).toBe(409);
    expect((await store.listChangelog()).length).toBe(logsBeforeConflict);
    const afterConflict = (await (await fetch(api("/api/config"))).json()) as {
      caps: { queue: number };
      configRevision: string;
    };
    expect(afterConflict.caps.queue).toBe(49);
    expect(afterConflict.configRevision).toBe(firstBody.configRevision);

    const secondField = await fetch(api("/api/config"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rewrite: { eager: false },
        expectedConfigRevision: firstBody.configRevision,
      }),
    });
    expect(secondField.status).toBe(200);
    expect(
      ((await (await fetch(api("/api/config"))).json()) as { rewrite: { eager: boolean } })
        .rewrite.eager,
    ).toBe(false);

    const oldClient = await fetch(api("/api/config"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caps: { queue: 47 } }),
    });
    expect(oldClient.status).toBe(200);
    const finalBody = (await oldClient.json()) as {
      caps: { queue: number };
      configRevision: string;
    };
    expect(finalBody.caps.queue).toBe(47);
    expect(finalBody.configRevision).toEqual(expect.any(String));
  });
});
