import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
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
import { promoteSessionNote } from "./memory/session-promotion.js";
import {
  applyScopeMigration,
  previewScopeMigration,
  scopeMigrationSummary,
  undoScopeMigration,
} from "./memory/migrate.js";
import { approveSkillDraft, rejectSkillDraft, createSkillDraft } from "./skill.js";
import { undoMerge } from "./apply.js";
import { computeHealth } from "./health.js";
import { runCompaction } from "./compact.js";
import { applyRetention, previewRetention } from "./retention.js";
import { rebuildAutoFiles } from "./rebuild.js";
import { validateModelEndpoint } from "./util/endpoint.js";

export interface ServerOptions {
  store: Store;
  config: AutoMemConfig;
  token: string;
  host?: string;
  port?: number;
  consoleDir?: string;
  decisionKeySource?: "env" | "auth" | "missing";
  suggest?: (id: string) => Promise<Suggestion | undefined>;
  reviewStats?: () => Record<string, unknown>;
  onReviewRequest?: (sessionID: string) => Promise<unknown>;
  onConfigChange?: (config: AutoMemConfig) => void;
}

export interface ServerHandle {
  url: string;
  port: number;
  token: string;
  broadcast(event: string, data: unknown): void;
  close(): Promise<void>;
  createConnectURL(): string;
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const store = options.store;
  const config = options.config;
  const token = options.token;
  const host = options.host ?? "127.0.0.1";
  const clients = new Set<http.ServerResponse>();
  const connectTickets = new Map<string, number>();
  const consoleDir = path.resolve(
    options.consoleDir ??
      process.env.OPENMEM_CONSOLE_DIR ??
      path.join(process.cwd(), "..", "console", "dist"),
  );

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (res.headersSent) { res.end(); return; }
      const status = message === "invalid json" ? 400 : message === "body too large" ? 413 : 500;
      sendJson(res, status, { error: message });
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
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!requestURL.pathname.startsWith("/api")) {
      await serveStatic(requestURL.pathname, res);
      return;
    }

    if (requestURL.pathname === "/api/connect" && req.method === "POST") {
      const body = await readJson(req);
      const ticket = isRecord(body) && typeof body.ticket === "string" ? body.ticket : "";
      const expires = connectTickets.get(ticket);
      connectTickets.delete(ticket);
      if (!expires || expires < Date.now()) {
        sendJson(res, 401, { error: "连接链接已过期或已使用，请重新获取链接" });
        return;
      }
      sendJson(res, 200, { token });
      return;
    }

    if (!isAuthorized(req, requestURL, token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (requestURL.pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        version: "0.3.0",
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
        review: {
          enabled: config.review.enabled,
          model: config.review.model,
          idleMs: config.review.idleMs,
          transcript: config.review.transcript,
          maxPerHour: config.review.maxPerHour,
          runtime: options.reviewStats?.() ?? null,
        },
      });
      return;
    }

    if (requestURL.pathname === "/api/queue" && req.method === "GET") {
      const kind = requestURL.searchParams.get("kind");
      const scope = requestURL.searchParams.get("scope");
      const origin = requestURL.searchParams.get("origin");
      const projectKey = requestURL.searchParams.get("projectKey");
      const query = requestURL.searchParams.get("q")?.toLowerCase() ?? "";
      const allQueue = await store.listQueue();
      const projects = [...new Map(allQueue.filter((item) => item.projectKey).map((item) => [item.projectKey!, {
        key: item.projectKey!, label: item.project?.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? item.projectKey!,
      }])).values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
      const queue = allQueue.filter((item) => {
        if (projectKey === "__unassigned__" ? Boolean(item.projectKey) : projectKey && item.projectKey !== projectKey) return false;
        if (kind && item.kind !== kind) return false;
        if (scope && item.scope !== scope) return false;
        if (origin === "session-review" && item.origin !== "session-review") return false;
        if (origin === "turn" && item.origin === "session-review") return false;
        if (query && !`${item.title} ${item.text} ${item.reason}`.toLowerCase().includes(query)) {
          return false;
        }
        return true;
      });
      sendJson(res, 200, { items: sortQueue(queue), projects });
      return;
    }

    if (requestURL.pathname === "/api/reviews" && req.method === "GET") {
      const sessionID = requestURL.searchParams.get("sessionID");
      const limit = Math.min(
        100,
        Math.max(1, Number(requestURL.searchParams.get("limit") ?? 20) || 20),
      );
      const all = (await store.listReviews())
        .filter((entry) => !sessionID || entry.sessionID === sessionID)
        .sort((left, right) =>
          String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")),
        );
      const items = all.slice(0, limit);
      const runtime = options.reviewStats?.();
      sendJson(res, 200, {
        items,
        canRun: Boolean(options.onReviewRequest),
        nextAt:
          runtime && typeof runtime.nextReviewAt === "string"
            ? runtime.nextReviewAt
            : null,
        summary: {
          total: all.length,
          last24h: all.filter(
            (entry) =>
              typeof entry.createdAt === "string" &&
              Date.now() - Date.parse(entry.createdAt) < 24 * 60 * 60 * 1000,
          ).length,
        },
      });
      return;
    }

    if (requestURL.pathname === "/api/reviews/run" && req.method === "POST") {
      if (!options.onReviewRequest) {
        sendJson(res, 501, { error: "当前实例没有配置复盘触发器" });
        return;
      }
      const body = await readJson(req);
      const sessionID =
        isRecord(body) && typeof body.sessionID === "string" ? body.sessionID : "";
      if (!sessionID) {
        sendJson(res, 400, { error: "sessionID is required" });
        return;
      }
      const record = await options.onReviewRequest(sessionID);
      broadcast("review.updated", { sessionID, record });
      const state = (await store.readState()).sessions[sessionID];
      const runtime = options.reviewStats?.();
      const reason = !config.review.enabled ? "会话复盘已关闭，可在设置中开启。"
        : runtime?.paused ? "复盘已暂停。"
        : state?.parentSessionID ? "子代理会话不会作为记忆来源。"
        : state?.reviewStatus === "running" ? "这条会话正在复盘，请等待完成。"
        : state?.reviewStatus === "scheduled" ? "复盘已排期或达到请求预算，请稍后重试。"
        : "没有新的可复盘内容，或会话尚未关联到当前项目。";
      sendJson(res, 200, { ok: true, record: record ?? null, ...(record ? {} : { reason }) });
      return;
    }

    const noteDismiss = requestURL.pathname.match(/^\/api\/reviews\/([^/]+)\/notes\/(\d+)\/dismiss$/);
    if (noteDismiss && req.method === "POST") {
      const body = await readJson(req);
      const id = decodeURIComponent(noteDismiss[1]);
      const index = Number(noteDismiss[2]);
      const ok = await store.transaction(async () => {
        const updated = await store.updateReviewNote(id, index, { status: isRecord(body) && body.restore === true ? undefined : "dismissed" });
        if (updated) await store.appendChangelog({ action: isRecord(body) && body.restore === true ? "restore_note" : "dismiss_note", reviewID: id, noteIndex: index });
        return updated;
      });
      if (!ok) { sendJson(res, 409, { error: "笔记不存在或已经提升，无法忽略" }); return; }
      broadcast("review.updated", { reviewID: id });
      sendJson(res, 200, { ok: true });
      return;
    }

    const notePromote = requestURL.pathname.match(
      /^\/api\/reviews\/([^/]+)\/notes\/(\d+)\/promote$/,
    );
    if (notePromote && req.method === "POST") {
      const reviewID = decodeURIComponent(notePromote[1]);
      const noteIndex = Number(notePromote[2]);
      const body = await readJson(req);
      const targetScope = isRecord(body) ? body.targetScope : undefined;
      if (targetScope !== "project" && targetScope !== "global") {
        sendJson(res, 400, { error: "invalid target scope" });
        return;
      }
      const result = await promoteSessionNote(
        store,
        config,
        reviewID,
        noteIndex,
        {
          targetScope,
          projectKey:
            isRecord(body) && typeof body.projectKey === "string"
              ? body.projectKey
              : undefined,
          confirmedByUser: isRecord(body) && body.confirmedByUser === true,
        },
      );
      if (!result.ok) {
        sendJson(res, 400, { error: result.error ?? "promotion failed" });
        return;
      }
      broadcast("review.updated", { reviewID, noteIndex, item: result.item });
      sendJson(res, 200, result);
      return;
    }

    const reviewMatch = requestURL.pathname.match(/^\/api\/reviews\/([^/]+)$/);
    if (reviewMatch && req.method === "GET") {
      const id = decodeURIComponent(reviewMatch[1]);
      const review = (await store.listReviews()).find((entry) => entry.id === id);
      if (!review) {
        sendJson(res, 404, { error: "review not found" });
        return;
      }
      const hooks = (await store.listHooks()).filter(
        (hook) => hook.reviewID === id || hook.turnID === `review:${id}`,
      );
      sendJson(res, 200, { review, hooks });
      return;
    }

    if (requestURL.pathname === "/api/hooks" && req.method === "GET") {
      const status = requestURL.searchParams.get("status");
      const sessionID = requestURL.searchParams.get("sessionID");
      const hooks = (await store.listHooks()).filter((hook) => {
        if (status && hook.status !== status) return false;
        if (sessionID && hook.sessionID !== sessionID) return false;
        return true;
      });
      sendJson(res, 200, { items: hooks });
      return;
    }

    if (requestURL.pathname === "/api/turns/latest" && req.method === "GET") {
      // Review hooks share hooks.jsonl but belong to the session-review card,
      // not to the last turn summary.
      const hooks = (await store.listHooks()).filter(
        (hook) => hook.origin !== "session-review",
      );
      const latest = [...hooks].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      )[0];
      if (!latest) {
        sendJson(res, 200, {
          sessionID: null,
          turnID: null,
          createdAt: null,
          counts: {
            captured: 0,
            pending: 0,
            auto: 0,
            shadow: 0,
            queue: 0,
            ignored: 0,
            failed: 0,
          },
          hooks: [],
        });
        return;
      }
      const turnHooks = hooks
        .filter(
          (hook) =>
            hook.sessionID === latest.sessionID &&
            hook.turnID === latest.turnID,
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      sendJson(res, 200, {
        sessionID: latest.sessionID,
        turnID: latest.turnID,
        createdAt: latest.createdAt,
        counts: {
          captured: turnHooks.length,
          pending: turnHooks.filter((hook) => hook.status === "pending").length,
          auto: turnHooks.filter((hook) => hook.status === "auto").length,
          shadow: turnHooks.filter((hook) => hook.status === "shadow").length,
          queue: turnHooks.filter((hook) => hook.status === "queue").length,
          ignored: turnHooks.filter((hook) => hook.status === "ignored").length,
          failed: turnHooks.filter((hook) => hook.status === "failed").length,
        },
        hooks: turnHooks,
      });
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
    const queueDraft = requestURL.pathname.match(/^\/api\/queue\/([^/]+)\/draft$/);
    if (queueDraft && req.method === "POST") {
      const id = decodeURIComponent(queueDraft[1]);
      const key = `queue-action:${id}`;
      const leaseToken = await store.claim(key, 60_000);
      if (!leaseToken) { sendJson(res, 409, { error: "该候选正在处理" }); return; }
      try {
        const draft = await store.transaction(async () => {
        if (!await store.ownsClaim(key, leaseToken)) return undefined;
        const item = (await store.listQueue()).find((item) => item.id === id);
        if (!item || item.kind !== "skill") return undefined;
        const draft = await createSkillDraft(store, { title: item.title, scenario: item.text, source: item.source });
        await store.removeQueue(id);
        await store.appendChangelog({ action: "create_skill_draft", queueID: id, draftID: draft.id });
        return draft;
        });
        if (!draft) { sendJson(res, 400, { error: "请选择有效的流程候选，或刷新后重试" }); return; }
        broadcast("queue.updated", { id });
        broadcast("skills.updated", { id: draft.id });
        sendJson(res, 200, { ok: true, draft });
      } finally { await store.releaseReservation(key, leaseToken); }
      return;
    }
    if (queueDecision && req.method === "POST") {
      const id = decodeURIComponent(queueDecision[1]);
      const body = await readJson(req);
      const decision = parseQueueDecision(body);
      if (!decision) {
        sendJson(res, 400, { error: "invalid decision body" });
        return;
      }
      const result = await applyQueueDecision(store, config, id, {
        ...decision,
        confirmedByUser: true,
      });
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
      if (ids.length > 200 || new Set(ids).size !== ids.length) {
        sendJson(res, 400, { error: "批量请求最多 200 条，且不能包含重复 ID" });
        return;
      }
      if (body.action === "apply_suggestion") {
        const minConfidence =
          typeof body.minConfidence === "number" ? body.minConfidence : 0.9;
        const max = typeof body.max === "number" ? Math.min(20, Math.max(1, body.max)) : 10;
        const queue = await store.listQueue();
        const eligible = queue.filter(
          (item) =>
            ids.includes(item.id) &&
            item.kind !== "rule" &&
            item.scope !== "session" &&
            item.origin !== "session-review" &&
            item.reviewID === undefined &&
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
              confirmedByUser: true,
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
        results.push({
          id,
          ...(await applyQueueDecision(store, config, id, {
            ...decision,
            confirmedByUser: true,
          })),
        });
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
        if (!result.ok) sendJson(res, 400, { ...result, error: result.errors?.join("; ") || "Skill 审批失败，请检查草稿" });
        else sendJson(res, 200, result);
        broadcast("skills.updated", { id, action: "approve" });
        return;
      }
      if (body.action === "reject") {
        const ok = await rejectSkillDraft(store, id);
        sendJson(res, ok ? 200 : 404, { ok, ...(ok ? {} : { error: "skill draft not found" }) });
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

    if (requestURL.pathname === "/api/retention/preview" && req.method === "GET") {
      try { sendJson(res, 200, await previewRetention(store)); }
      catch (error) { sendJson(res, 409, { error: error instanceof Error ? error.message : "无法安全预览历史" }); }
      return;
    }
    if (requestURL.pathname === "/api/retention/apply" && req.method === "POST") {
      const body = await readJson(req);
      if (!isRecord(body) || body.confirmedByUser !== true || typeof body.previewID !== "string") {
        sendJson(res, 400, { error: "请先预览并确认历史清理" }); return;
      }
      try {
        const result = await applyRetention(store, body.previewID, true);
        broadcast("items.updated", { retention: true });
        broadcast("health.updated", { retention: true });
        sendJson(res, 200, { ok: true, result });
      } catch (error) { sendJson(res, 409, { error: error instanceof Error ? error.message : "历史清理未执行，请重新预览" }); }
      return;
    }
    if (requestURL.pathname === "/api/compact/preview" && req.method === "GET") {
      sendJson(res, 200, await runCompaction(store, config, { dryRun: true }));
      return;
    }
    if (requestURL.pathname === "/api/compact" && req.method === "POST") {
      const body = await readJson(req);
      if (!isRecord(body) || body.confirmedByUser !== true) {
        sendJson(res, 400, { error: "请先预览并确认压缩操作" });
        return;
      }
      const result = await runCompaction(store, config);
      broadcast("health.updated", result);
      sendJson(res, 200, result);
      return;
    }

    if (requestURL.pathname === "/api/changelog" && req.method === "GET") {
      const limit = Math.min(200, Math.max(1, Number(requestURL.searchParams.get("limit")) || 50));
      const action = requestURL.searchParams.get("action");
      const entries = (await store.listChangelog()).filter((entry) => !action || entry.action === action);
      const fields = ["at", "action", "queueID", "itemID", "target", "journalID", "reviewID", "curatorID", "recoveryID"];
      sendJson(res, 200, { items: entries.slice(-limit).reverse().map((entry) => Object.fromEntries(fields.filter((field) => entry[field] !== undefined).map((field) => [field, entry[field]]))) });
      return;
    }

    const restoreAction = requestURL.pathname.match(/^\/api\/recovery\/(recovery_[A-Za-z0-9_]+)\/restore$/);
    if (restoreAction && req.method === "POST") {
      try {
        await store.transaction(async () => {
        await store.restoreQueueAction(restoreAction[1]);
        await rebuildAutoFiles(store);
        await store.appendChangelog({ action: "restore_queue_action", recoveryID: restoreAction[1] });
        });
        broadcast("queue.updated", { restored: true });
        broadcast("items.updated", { restored: true });
        sendJson(res, 200, { ok: true });
      } catch (error) { sendJson(res, 409, { error: error instanceof Error ? error.message : "恢复失败" }); }
      return;
    }

    const maintenanceUndo = requestURL.pathname.match(/^\/api\/maintenance\/(maintenance_[A-Za-z0-9_]+)\/undo$/);
    if (maintenanceUndo && req.method === "POST") {
      try {
        const restored = await store.transaction(async () => {
        const restored = await store.undoMaintenance(maintenanceUndo[1]);
        await rebuildAutoFiles(store);
        await store.appendChangelog({ action: "undo_maintenance", journalID: maintenanceUndo[1] });
        return restored;
        });
        broadcast("items.updated", { restored });
        sendJson(res, 200, { ok: true, restored });
      } catch (error) {
        sendJson(res, 409, { error: error instanceof Error ? error.message : "无法撤销" });
      }
      return;
    }

    if (requestURL.pathname === "/api/usage" && req.method === "GET") {
      const [decision, rewrite, reviews] = await Promise.all([
        store.listUsage("decision"),
        store.listUsage("rewrite"),
        store.listReviews(),
      ]);
      const reviewRows = reviews.filter(
        (record) => record.status === "ready" || record.status === "failed",
      );
      const reviewTokens = reviewRows.reduce((sum, record) => {
        const usage = record.usage as
          | { inputTokens?: number; outputTokens?: number }
          | undefined;
        return sum + (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
      }, 0);
      const reviewFailures = reviews.filter((record) => record.status === "failed").length;
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
        reviewCalls: reviewRows.length,
        reviewTokens,
        reviewFailures,
        decisionFallbackRate:
          decision.length > 0 ? decision.filter((record) => !record.ok).length / decision.length : 0,
        rewriteFallbackRate:
          rewrite.length > 0 ? rewrite.filter((record) => !record.ok).length / rewrite.length : 0,
        since:
          [
            ...decision.map((record) => record.at),
            ...rewrite.map((record) => record.at),
            ...reviews
              .map((record) => record.createdAt)
              .filter((value): value is string => typeof value === "string"),
          ]
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

    if (
      requestURL.pathname === "/api/migrations/scopes/preview" &&
      req.method === "GET"
    ) {
      const proposals = await previewScopeMigration(store);
      sendJson(res, 200, {
        proposals,
        summary: scopeMigrationSummary(proposals),
      });
      return;
    }

    if (
      requestURL.pathname === "/api/migrations/scopes/apply" &&
      req.method === "POST"
    ) {
      const body = await readJson(req);
      if (!isRecord(body) || body.confirmedByUser !== true) {
        sendJson(res, 400, { error: "confirmedByUser is required" });
        return;
      }
      const result = await applyScopeMigration(store);
      broadcast("migration.updated", result ?? { applied: 0 });
      sendJson(res, 200, result ?? { applied: 0 });
      return;
    }

    if (
      requestURL.pathname === "/api/migrations/scopes/undo" &&
      req.method === "POST"
    ) {
      const body = await readJson(req);
      const id = isRecord(body) && typeof body.id === "string" ? body.id : "";
      if (!id) {
        sendJson(res, 400, { error: "migration id is required" });
        return;
      }
      try {
        const restored = await undoScopeMigration(store, id);
        broadcast("migration.updated", { id, restored });
        sendJson(res, 200, { id, restored });
      } catch (error: unknown) {
        sendJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
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
      try {
        validateNumericPatch(body, config);
        for (const field of ["decision", "rewrite"]) {
          const value = body[field];
          if (isRecord(value) && typeof value.endpoint === "string") validateModelEndpoint(value.endpoint);
        }
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid endpoint" });
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
    if (file !== base && !file.startsWith(base + path.sep)) {
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
    createConnectURL() {
      for (const [ticket, expires] of connectTickets) if (expires < Date.now()) connectTickets.delete(ticket);
      if (connectTickets.size >= 32) connectTickets.delete(connectTickets.keys().next().value ?? "");
      const ticket = randomBytes(24).toString("hex");
      connectTickets.set(ticket, Date.now() + 60_000);
      return `http://${host}:${port}/?connect=${ticket}`;
    },
    async close(): Promise<void> {
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function applyConfigPatch(config: AutoMemConfig, body: Record<string, unknown>): void {
  if (typeof body.shadow === "boolean") config.shadow = body.shadow;
  if (typeof body.shadowRecordAll === "boolean") {
    config.shadowRecordAll = body.shadowRecordAll;
  }
  if (typeof body.autoMemory === "boolean") config.autoMemory = body.autoMemory;
  if (typeof body.autoRules === "boolean") config.autoRules = body.autoRules;
  if (isRecord(body.turn)) {
    assignNumbers(config.turn, body.turn, ["maxCandidates", "parallel"]);
  }
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
      "hooks",
      "reviews",
      "diskBytes",
    ]);
  }
  if (isRecord(body.review)) {
    const value = body.review;
    if (typeof value.enabled === "boolean") config.review.enabled = value.enabled;
    if (typeof value.redact === "boolean") config.review.redact = value.redact;
    if (value.transcript === "user" || value.transcript === "user+tools") {
      config.review.transcript = value.transcript;
    }
    if (isRecord(value.model)) {
      if (typeof value.model.providerID === "string") {
        config.review.model.providerID = value.model.providerID;
      }
      if (typeof value.model.id === "string") config.review.model.id = value.model.id;
      if (typeof value.model.variant === "string") {
        config.review.model.variant = value.model.variant;
      }
    }
    assignNumbers(config.review, value, [
      "idleMs",
      "minNewUserMessages",
      "checkpointMessages",
      "maxInputChars",
      "maxUserCharsPerMessage",
      "maxCandidates",
      "minConfidence",
      "maxPerHour",
      "maxOutputTokens",
      "timeoutMs",
      "cacheTtlHours",
    ]);
    assignNonNegative(config.review, value, ["repairAttempts", "maxDeferrals"]);
  }
  if (isRecord(body.digest)) {
    assignNumbers(config.digest, body.digest, ["maxEntries", "maxBytes", "maxChars"]);
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
    assignNonNegative(config.decision, value, ["queueMin", "queueMinRule"]);
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
      if (typeof value.model.variant === "string") {
        config.rewrite.model.variant = value.model.variant;
      }
    }
    assignNumbers(config.rewrite, value, [
      "timeoutMs",
      "maxCallsPerHour",
      "repairAttempts",
      "cacheTtlHours",
    ]);
  }
}

function validateNumericPatch(patch: Record<string, unknown>, current: object, prefix = ""): void {
  const baseline = current as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (typeof baseline[key] === "number") {
      const zeroAllowed = prefix === "thresholds" || ["repairAttempts", "maxDeferrals", "queueMin", "queueMinRule"].includes(key);
      if (typeof value !== "number" || !Number.isFinite(value) || (zeroAllowed ? value < 0 : value <= 0)) {
        throw new Error(`${field} 必须是${zeroAllowed ? "非负" : "大于 0 的"}有效数字`);
      }
    } else if (isRecord(value) && isRecord(baseline[key])) {
      validateNumericPatch(value, baseline[key], field);
    }
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

function assignNonNegative(
  target: object,
  source: Record<string, unknown>,
  keys: string[],
): void {
  const record = target as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
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
  const supplied = header?.startsWith("Bearer ") ? header.slice(7)
    : req.method === "GET" && url.pathname === "/api/events" ? url.searchParams.get("token") ?? "" : "";
  const expected = Buffer.from(token);
  const actual = Buffer.from(supplied);
  return actual.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected);
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
    !["approve", "deny", "edit", "defer", "resume", "apply_suggestion", "promote"].includes(
      value.action,
    )
  ) {
    return undefined;
  }
  return {
    action: value.action as QueueDecision["action"],
    text: typeof value.text === "string" ? value.text : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    note: typeof value.note === "string" ? value.note : undefined,
    targetScope:
      value.targetScope === "project" || value.targetScope === "global"
        ? value.targetScope
        : undefined,
    projectKey:
      typeof value.projectKey === "string" ? value.projectKey : undefined,
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
