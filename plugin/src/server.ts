import http from "node:http";
import path from "node:path";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { URL } from "node:url";
import type {
  AutoMemConfig,
  Suggestion,
  UsageSummary,
} from "./types.js";
import { Store } from "./store.js";
import { sortQueue } from "./priority.js";
import { computeMetrics, runAudit } from "./audit.js";
import { projectMap } from "./map.js";
import { applyQueueDecision, type QueueDecision } from "./actions.js";
import { approveSkillDraft, rejectSkillDraft } from "./skill.js";
import { undoMerge } from "./apply.js";
import { computeHealth } from "./health.js";
import { runCompaction } from "./compact.js";

export interface ServerOptions {
  store: Store;
  config: AutoMemConfig;
  token: string;
  host?: string;
  port?: number;
  consoleDir?: string;
  decisionKeySource?: "env" | "auth" | "missing";
  suggest?: (id: string) => Promise<Suggestion | undefined>;
  onConfigChange?: (config: AutoMemConfig) => void;
}

export interface ServerHandle {
  url: string;
  port: number;
  token: string;
  broadcast(event: string, data: unknown): void;
  close(): Promise<void>;
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const store = options.store;
  const config = options.config;
  const token = options.token;
  const host = options.host ?? "127.0.0.1";
  const clients = new Set<http.ServerResponse>();
  const consoleDir = path.resolve(
    options.consoleDir ??
      process.env.OPENMEM_CONSOLE_DIR ??
      path.join(process.cwd(), "..", "console", "dist"),
  );

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null && "port" in address
      ? address.port
      : (options.port ?? 0);
  const url = `http://${host}:${port}/?token=${encodeURIComponent(token)}`;

  const broadcast = (event: string, data: unknown): void => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const requestURL = new URL(req.url ?? "/", `http://${host}:${port}`);
    applyCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!requestURL.pathname.startsWith("/api")) {
      await serveStatic(requestURL.pathname, res);
      return;
    }

    if (!isAuthorized(req, requestURL, token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (requestURL.pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        version: "0.2.0",
        dataDir: store.dataDir,
        shadow: config.shadow,
        decision: {
          kind: config.decision.kind,
          model: config.decision.model,
          endpoint: config.decision.endpoint,
          keySource: options.decisionKeySource ?? "missing",
        },
        rewrite: {
          enabled: config.rewrite.enabled,
          transport: config.rewrite.transport,
          model: config.rewrite.model,
        },
      });
      return;
    }

    if (requestURL.pathname === "/api/queue" && req.method === "GET") {
      const kind = requestURL.searchParams.get("kind");
      const scope = requestURL.searchParams.get("scope");
      const query = requestURL.searchParams.get("q")?.toLowerCase() ?? "";
      const queue = (await store.listQueue()).filter((item) => {
        if (kind && item.kind !== kind) return false;
        if (scope && item.scope !== scope) return false;
        if (query && !`${item.title} ${item.text} ${item.reason}`.toLowerCase().includes(query)) {
          return false;
        }
        return true;
      });
      sendJson(res, 200, { items: sortQueue(queue) });
      return;
    }

    const suggestMatch = requestURL.pathname.match(/^\/api\/queue\/([^/]+)\/suggest$/);
    if (suggestMatch && req.method === "POST") {
      if (!options.suggest) {
        sendJson(res, 501, { error: "当前实例没有配置合并建议生成器" });
        return;
      }
      const id = decodeURIComponent(suggestMatch[1]);
      const suggestion = await options.suggest(id);
      if (!suggestion) {
        sendJson(res, 404, { error: "队列条目不存在或无法生成建议" });
        return;
      }
      broadcast("suggestion.updated", suggestion);
      sendJson(res, 200, suggestion);
      return;
    }

    const queueDecision = requestURL.pathname.match(/^\/api\/queue\/([^/]+)\/decision$/);
    if (queueDecision && req.method === "POST") {
      const id = decodeURIComponent(queueDecision[1]);
      const body = await readJson(req);
      const decision = parseQueueDecision(body);
      if (!decision) {
        sendJson(res, 400, { error: "invalid decision body" });
        return;
      }
      const result = await applyQueueDecision(store, config, id, decision);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error ?? "decision failed" });
        return;
      }
      broadcast("queue.updated", { id, decision: decision.action });
      if (result.journalID) broadcast("merge.updated", { id, journalID: result.journalID });
      sendJson(res, 200, result);
      return;
    }

    if (requestURL.pathname === "/api/queue/batch" && req.method === "POST") {
      const body = await readJson(req);
      if (!isRecord(body) || !Array.isArray(body.ids)) {
        sendJson(res, 400, { error: "invalid batch body" });
        return;
      }
      const ids = body.ids.filter((id): id is string => typeof id === "string");
      if (body.action === "apply_suggestion") {
        const minConfidence =
          typeof body.minConfidence === "number" ? body.minConfidence : 0.9;
        const max = typeof body.max === "number" ? Math.min(20, Math.max(1, body.max)) : 10;
        const queue = await store.listQueue();
        const eligible = queue.filter(
          (item) =>
            ids.includes(item.id) &&
            item.kind !== "rule" &&
            item.suggestion?.validation.ok === true &&
            item.suggestion.confidence >= minConfidence,
        );
        const preview = eligible.map((item) => ({
          id: item.id,
          title: item.title,
          action: item.suggestion?.action,
          targetId: item.suggestion?.targetId,
          confidence: item.suggestion?.confidence,
        }));
        if (body.dryRun === true) {
          sendJson(res, 200, {
            dryRun: true,
            eligible: preview,
            skipped: ids.length - eligible.length,
            capped: Math.max(0, eligible.length - max),
          });
          return;
        }
        const results = [];
        for (const item of eligible.slice(0, max)) {
          results.push({
            id: item.id,
            ...(await applyQueueDecision(store, config, item.id, {
              action: "apply_suggestion",
            })),
          });
        }
        broadcast("queue.updated", { batch: results.length });
        sendJson(res, 200, { results });
        return;
      }

      if (!isRecord(body.decision)) {
        sendJson(res, 400, { error: "invalid decision" });
        return;
      }
      const decision = parseQueueDecision(body.decision);
      if (!decision) {
        sendJson(res, 400, { error: "invalid decision" });
        return;
      }
      const results = [];
      for (const id of ids) {
        results.push({ id, ...(await applyQueueDecision(store, config, id, decision)) });
      }
      broadcast("queue.updated", { batch: results.length });
      sendJson(res, 200, { results });
      return;
    }

    if (requestURL.pathname === "/api/items" && req.method === "GET") {
      sendJson(res, 200, { items: await store.listItems() });
      return;
    }

    if (requestURL.pathname === "/api/map" && req.method === "GET") {
      const [items, queue, shadow] = await Promise.all([
        store.listItems(),
        store.listQueue(),
        store.listShadow(),
      ]);
      sendJson(res, 200, projectMap({ items, queue, shadow }));
      return;
    }

    if (requestURL.pathname === "/api/skills" && req.method === "GET") {
      sendJson(res, 200, { items: await store.listSkillDrafts() });
      return;
    }

    const skillMatch = requestURL.pathname.match(/^\/api\/skills\/([^/]+)$/);
    if (skillMatch && req.method === "GET") {
      const draft = await store.readSkillDraft(decodeURIComponent(skillMatch[1]));
      if (!draft) {
        sendJson(res, 404, { error: "skill draft not found" });
      } else {
        const content = await readFile(draft.path, "utf8").catch(() => "");
        sendJson(res, 200, { ...draft, content });
      }
      return;
    }

    const skillDecisionMatch = requestURL.pathname.match(/^\/api\/skills\/([^/]+)\/decision$/);
    if (skillDecisionMatch && req.method === "POST") {
      const id = decodeURIComponent(skillDecisionMatch[1]);
      const body = await readJson(req);
      if (!isRecord(body) || typeof body.action !== "string") {
        sendJson(res, 400, { error: "invalid skill decision" });
        return;
      }
      if (body.action === "approve") {
        const result = await approveSkillDraft(store, id);
        if (!result.ok) sendJson(res, 400, result);
        else sendJson(res, 200, result);
        broadcast("skills.updated", { id, action: "approve" });
        return;
      }
      if (body.action === "reject") {
        const ok = await rejectSkillDraft(store, id);
        sendJson(res, ok ? 200 : 404, { ok });
        broadcast("skills.updated", { id, action: "reject" });
        return;
      }
      if (body.action === "request_changes") {
        const notes = typeof body.notes === "string" ? body.notes : "";
        const draft = await store.readSkillDraft(id);
        if (!draft) {
          sendJson(res, 404, { error: "skill draft not found" });
          return;
        }
        const updated = await store.updateSkillDraft(id, {
          status: "draft",
          testResult: { ok: false, notes },
        });
        sendJson(res, 200, { ok: Boolean(updated), item: updated });
        broadcast("skills.updated", { id, action: "request_changes" });
        return;
      }
      sendJson(res, 400, { error: "unknown skill action" });
      return;
    }

    if (requestURL.pathname === "/api/audit" && req.method === "GET") {
      sendJson(res, 200, await store.readAudit());
      return;
    }

    if (requestURL.pathname === "/api/audit/run" && req.method === "POST") {
      const report = await runAudit(store, config);
      broadcast("audit.updated", report.summary);
      sendJson(res, 200, report);
      return;
    }

    if (requestURL.pathname === "/api/metrics" && req.method === "GET") {
      sendJson(res, 200, await computeMetrics(store));
      return;
    }

    if (requestURL.pathname === "/api/health-score" && req.method === "GET") {
      sendJson(res, 200, await computeHealth(store, config));
      return;
    }

    if (requestURL.pathname === "/api/compact" && req.method === "POST") {
      const result = await runCompaction(store, config);
      broadcast("health.updated", result);
      sendJson(res, 200, result);
      return;
    }

    if (requestURL.pathname === "/api/usage" && req.method === "GET") {
      const [decision, rewrite] = await Promise.all([
        store.listUsage("decision"),
        store.listUsage("rewrite"),
      ]);
      const summary: UsageSummary = {
        decisionCalls: decision.length,
        decisionTokens: decision.reduce(
          (sum, record) => sum + (record.inputTokens ?? 0) + (record.outputTokens ?? 0),
          0,
        ),
        rewriteCalls: rewrite.length,
        rewriteTokens: rewrite.reduce(
          (sum, record) => sum + (record.inputTokens ?? 0) + (record.outputTokens ?? 0),
          0,
        ),
        decisionFallbackRate:
          decision.length > 0 ? decision.filter((record) => !record.ok).length / decision.length : 0,
        rewriteFallbackRate:
          rewrite.length > 0 ? rewrite.filter((record) => !record.ok).length / rewrite.length : 0,
        since:
          [...decision, ...rewrite]
            .map((record) => record.at)
            .sort()
            .at(0) ?? new Date().toISOString(),
      };
      sendJson(res, 200, summary);
      return;
    }

    if (requestURL.pathname === "/api/journal" && req.method === "GET") {
      const journal = await store.listJournal();
      sendJson(res, 200, { items: journal.slice(-50).reverse() });
      return;
    }

    const undoMatch = requestURL.pathname.match(/^\/api\/merge\/([^/]+)\/undo$/);
    if (undoMatch && req.method === "POST") {
      const result = await undoMerge(store, decodeURIComponent(undoMatch[1]));
      if (!result.ok) sendJson(res, 400, { error: result.error });
      else {
        broadcast("queue.updated", { undo: result.journalID });
        broadcast("merge.updated", { undo: result.journalID });
        sendJson(res, 200, result);
      }
      return;
    }

    if (requestURL.pathname === "/api/config" && req.method === "GET") {
      sendJson(res, 200, publicConfig(config));
      return;
    }

    if (requestURL.pathname === "/api/config" && req.method === "PATCH") {
      const body = await readJson(req);
      if (!isRecord(body)) {
        sendJson(res, 400, { error: "invalid config body" });
        return;
      }
      applyConfigPatch(config, body);
      await store.writeConfig(config);
      options.onConfigChange?.(config);
      broadcast("config.updated", publicConfig(config));
      sendJson(res, 200, publicConfig(config));
      return;
    }

    const shadowMatch = requestURL.pathname.match(/^\/api\/shadow\/([^/]+)\/false-positive$/);
    if (shadowMatch && req.method === "POST") {
      const record = await store.markShadowFalsePositive(decodeURIComponent(shadowMatch[1]));
      if (!record) sendJson(res, 404, { error: "shadow record not found" });
      else {
        await computeMetrics(store);
        broadcast("shadow.updated", record);
        sendJson(res, 200, record);
      }
      return;
    }

    if (requestURL.pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("event: ready\ndata: {}\n\n");
      clients.add(res);
      const keepAlive = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(keepAlive);
        }
      }, 15_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
    let relative = pathname === "/" ? "index.html" : pathname.slice(1);
    try {
      relative = decodeURIComponent(relative);
    } catch {
      sendJson(res, 400, { error: "bad path" });
      return;
    }
    const base = path.resolve(consoleDir);
    let file = path.resolve(base, relative);
    if (!file.startsWith(base)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    try {
      const info = await stat(file);
      if (info.isDirectory()) file = path.join(file, "index.html");
    } catch {
      if (path.extname(relative) && relative !== "index.html") {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      file = path.join(base, "index.html");
    }
    try {
      await stat(file);
    } catch {
      sendHtml(
        res,
        200,
        "<!doctype html><meta charset=\"utf-8\"><title>OpenMem Console</title><body style=\"font-family:system-ui;padding:2rem\"><h1>OpenMem Console</h1><p>Console build not found.</p><p>Run <code>npm run build</code> in <code>open-mem</code>, then reload.</p></body>",
      );
      return;
    }
    res.writeHead(200, { "content-type": contentType(file) });
    createReadStream(file).pipe(res);
  }

  function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin;
    if (origin === "http://127.0.0.1:5173" || origin === "http://localhost:5173") {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type,authorization");
    }
  }

  return {
    url,
    port,
    token,
    broadcast,
    async close(): Promise<void> {
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function applyConfigPatch(config: AutoMemConfig, body: Record<string, unknown>): void {
  if (typeof body.shadow === "boolean") config.shadow = body.shadow;
  if (typeof body.autoMemory === "boolean") config.autoMemory = body.autoMemory;
  if (typeof body.autoRules === "boolean") config.autoRules = body.autoRules;
  if (isRecord(body.thresholds)) {
    assignNumbers(config.thresholds, body.thresholds, [
      "memoryMaxChars",
      "ruleMaxChars",
      "titleMaxChars",
      "autoOkMin",
      "globalAutoOkMin",
      "duplicateMax",
    ]);
  }
  if (isRecord(body.caps)) {
    assignNumbers(config.caps, body.caps, [
      "autoMemory",
      "autoRules",
      "queue",
      "shadow",
      "skillDrafts",
      "itemsTotal",
      "suggestions",
      "diskBytes",
    ]);
  }
  if (isRecord(body.decision)) {
    const value = body.decision;
    if (value.kind === "systemone" || value.kind === "heuristic") config.decision.kind = value.kind;
    if (typeof value.endpoint === "string") config.decision.endpoint = value.endpoint;
    if (typeof value.model === "string") config.decision.model = value.model;
    if (typeof value.apiKeyEnv === "string") config.decision.apiKeyEnv = value.apiKeyEnv;
    assignNumbers(config.decision, value, [
      "timeoutMs",
      "maxCallsPerHour",
      "cacheTtlHours",
    ]);
  }
  if (isRecord(body.rewrite)) {
    const value = body.rewrite;
    if (typeof value.enabled === "boolean") config.rewrite.enabled = value.enabled;
    if (value.transport === "opencode" || value.transport === "ollama") {
      config.rewrite.transport = value.transport;
    }
    if (typeof value.endpoint === "string") config.rewrite.endpoint = value.endpoint;
    if (typeof value.eager === "boolean") config.rewrite.eager = value.eager;
    if (isRecord(value.model)) {
      if (typeof value.model.providerID === "string") {
        config.rewrite.model.providerID = value.model.providerID;
      }
      if (typeof value.model.id === "string") config.rewrite.model.id = value.model.id;
    }
    assignNumbers(config.rewrite, value, [
      "timeoutMs",
      "maxCallsPerHour",
      "repairAttempts",
      "cacheTtlHours",
    ]);
  }
}

function assignNumbers(
  target: object,
  source: Record<string, unknown>,
  keys: string[],
): void {
  const record = target as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      record[key] = value;
    }
  }
}

function publicConfig(config: AutoMemConfig): Omit<AutoMemConfig, "token"> {
  const { token: _token, ...rest } = config;
  return rest;
}

function isAuthorized(req: http.IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization;
  if (header === `Bearer ${token}`) return true;
  return url.searchParams.get("token") === token;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("invalid json");
  }
}

function parseQueueDecision(value: unknown): QueueDecision | undefined {
  if (!isRecord(value) || typeof value.action !== "string") return undefined;
  if (
    !["approve", "deny", "edit", "defer", "apply_suggestion"].includes(value.action)
  ) {
    return undefined;
  }
  return {
    action: value.action as QueueDecision["action"],
    text: typeof value.text === "string" ? value.text : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    note: typeof value.note === "string" ? value.note : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function contentType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
