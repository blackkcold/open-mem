import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AuditReport,
  AutoMemConfig,
  AutopilotContext,
  DecisionConfig,
  Item,
  RewriteConfig,
  Scope,
  SessionMessage,
  SkillInput,
  Suggestion,
} from "./types.js";
import { mergeConfig, type ConfigPatch } from "./config.js";
import { Store, newId } from "./store.js";
import { createDecisionProvider, resolveOllamaKey } from "./decision.js";
import { runConsolidation } from "./consolidate.js";
import { SessionReader } from "./session/reader.js";
import { runAudit } from "./audit.js";
import { applyQueueDecision } from "./actions.js";
import { createSkillDraft } from "./skill.js";
import { startServer, type ServerHandle } from "./server.js";
import { sortQueue } from "./priority.js";
import { createRewriteService } from "./rewrite/index.js";
import { buildSuggestion } from "./suggestion.js";
import { maybeCompact } from "./compact.js";
import { collectNeighbors, entriesFor } from "./fingerprint.js";
import { sha16 } from "./util/text.js";
import { sameScopeAndProject } from "./memory/scope.js";
import { runCurator } from "./memory/curator.js";
import { DigestCache } from "./digest/cache.js";
import {
  collectReviewKnownTitles,
  ReviewInputBuilder,
} from "./review/input.js";
import { ReviewOrchestrator } from "./review/orchestrator.js";
import { ReviewProvider } from "./review/provider.js";
import { acceptReviewCandidates } from "./review/accept.js";
import { validateReviewCandidates } from "./review/validate.js";

export interface PluginOptions {
  dataDir?: string;
  consoleDir?: string;
  shadow?: boolean;
  autoMemory?: boolean;
  autoRules?: boolean;
  console?: boolean;
  port?: number;
  token?: string;
  /** @deprecated Use decision. */
  decisionModel?: { providerID: string; id: string };
  decision?: Partial<DecisionConfig>;
  rewrite?: Partial<Omit<RewriteConfig, "model">> & {
    model?: { providerID?: string; id?: string; variant?: string };
  };
  thresholds?: Partial<AutoMemConfig["thresholds"]>;
  caps?: Partial<AutoMemConfig["caps"]>;
  /** Test seam for opening the local console without a browser. */
  openExternal?: (url: string) => Promise<boolean>;
}

interface Disposable {
  dispose(): Promise<void>;
}

interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ContextHookEvent {
  sessionID?: string;
  system?: Array<{ type: string; text: string }>;
  messages?: unknown[];
}

interface InstructionEntry {
  put(input: { sessionID: string; key: string; value: unknown }): Promise<void>;
}

export interface PluginContext {
  location?: { directory?: string; project?: { canonical?: string } };
  options?: unknown;
  event?: {
    subscribe(options: { types?: string[]; signal?: AbortSignal }): AsyncIterable<OpenCodeEvent>;
  };
  session?: {
    context(input: { sessionID: string }): Promise<unknown>;
    get?(input: { sessionID: string }): Promise<unknown>;
    prompt(input: { sessionID: string; text: string; delivery?: string }): Promise<unknown>;
    hook?(
      name: "context",
      callback: (event: ContextHookEvent) => void | Promise<void>,
    ): Promise<Disposable>;
    instructions?: { entry?: InstructionEntry };
  };
  tool?: {
    transform(callback: (editor: { add(tool: unknown): void }) => void): Promise<Disposable>;
  };
  command?: {
    transform(callback: (editor: { add(command: unknown): void }) => void): Promise<Disposable>;
  };
  generate?: {
    text?: (input: {
      model: { providerID: string; id: string };
      prompt: string;
    }) => Promise<unknown>;
  };
  experimental?: {
    generate?: {
      decisions?: (input: unknown) => Promise<unknown>;
      text?: (input: {
        model: { providerID: string; id: string };
        prompt: string;
      }) => Promise<unknown>;
    };
  };
}

const contextCache = new Map<string, string>();

interface ReviewRuntime {
  stats?: () => Record<string, unknown>;
  run?: (sessionID: string) => Promise<unknown>;
  onConfig?: (next: AutoMemConfig) => void;
}

function reviewRuntimeRegistry(): Map<string, Set<ReviewRuntime>> {
  const holder = globalThis as {
    __openMemReviewRuntimes?: Map<string, Set<ReviewRuntime>>;
  };
  holder.__openMemReviewRuntimes ??= new Map();
  return holder.__openMemReviewRuntimes;
}

function registerReviewRuntime(dataDir: string, runtime: ReviewRuntime): void {
  const registry = reviewRuntimeRegistry();
  const set = registry.get(dataDir) ?? new Set<ReviewRuntime>();
  set.add(runtime);
  registry.set(dataDir, set);
}

function unregisterReviewRuntime(dataDir: string, runtime: ReviewRuntime): void {
  const registry = reviewRuntimeRegistry();
  const set = registry.get(dataDir);
  if (!set) return;
  set.delete(runtime);
  if (set.size === 0) registry.delete(dataDir);
}

/** The host can load several instances for one data dir; aggregate them. */
function reviewStatsFor(dataDir: string): Record<string, unknown> {
  const set = reviewRuntimeRegistry().get(dataDir);
  if (!set || set.size === 0) return {};
  let scheduled = 0;
  let running = 0;
  let runsLastHour = 0;
  let paused = false;
  let failures = 0;
  let cached = 0;
  let lastRunAt: string | undefined;
  let lastError: string | undefined;
  let openUntil: number | undefined;
  let nextReviewAt: string | undefined;
  for (const runtime of set) {
    const stats = runtime.stats?.();
    if (!stats) continue;
    scheduled = Math.max(scheduled, Number(stats.scheduled ?? 0));
    running = Math.max(running, Number(stats.running ?? 0));
    runsLastHour = Math.max(runsLastHour, Number(stats.runsLastHour ?? 0));
    paused = paused || Boolean(stats.paused);
    failures = Math.max(failures, Number(stats.failures ?? 0));
    cached = Math.max(cached, Number(stats.cached ?? 0));
    const runAt = typeof stats.lastRunAt === "string" ? stats.lastRunAt : undefined;
    if (runAt && (!lastRunAt || runAt > lastRunAt)) lastRunAt = runAt;
    if (!lastError && typeof stats.lastError === "string") lastError = stats.lastError;
    if (
      typeof stats.openUntil === "number" &&
      (!openUntil || stats.openUntil > openUntil)
    ) {
      openUntil = stats.openUntil;
    }
    const next = typeof stats.nextReviewAt === "string" ? stats.nextReviewAt : undefined;
    if (next && (!nextReviewAt || next < nextReviewAt)) nextReviewAt = next;
  }
  return {
    scheduled,
    running,
    runsLastHour,
    paused,
    failures,
    cached,
    lastRunAt,
    lastError,
    openUntil,
    nextReviewAt,
  };
}

async function requestReviewFor(
  dataDir: string,
  sessionID: string,
): Promise<unknown> {
  const set = reviewRuntimeRegistry().get(dataDir);
  if (!set) return undefined;
  for (const runtime of set) {
    if (!runtime.run) continue;
    const record = await runtime.run(sessionID).catch(() => undefined);
    if (record) return record;
  }
  return undefined;
}

function notifyReviewConfigFor(dataDir: string, next: AutoMemConfig): void {
  const set = reviewRuntimeRegistry().get(dataDir);
  if (!set) return;
  for (const runtime of set) runtime.onConfig?.(next);
}

function consoleRefs(): Map<string, number> {
  const holder = globalThis as { __openMemConsoleRefs?: Map<string, number> };
  holder.__openMemConsoleRefs ??= new Map();
  return holder.__openMemConsoleRefs;
}

/**
 * The console build ships next to the plugin in this repo. Resolve it from the
 * module location so installation does not depend on the host's cwd, whether
 * the loader picks `dist/index.js` or the package root re-export.
 */
function bundledConsoleDir(): string | undefined {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "..", "..", "console", "dist"),
    path.resolve(moduleDir, "..", "console", "dist"),
    path.resolve(moduleDir, "console", "dist"),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, "index.html")));
}

export async function setupPlugin(
  ctx: PluginContext,
  explicitOptions?: PluginOptions,
): Promise<() => Promise<void>> {
  const options = explicitOptions ?? parseOptions(ctx.options);
  const dataDir =
    options.dataDir ??
    process.env.OPENMEM_DATA_DIR ??
    path.join(os.homedir(), ".config", "opencode", "memory", "autopilot");
  const store = new Store(dataDir);
  await store.init();
  // A process that died mid-rewrite leaves "pending" behind. The console
  // deliberately does not auto-generate for pending rows, so reset stale
  // markers before serving any UI.
  await resetStaleSuggestions(store).catch(() => undefined);

  const reader = new SessionReader(
    async (sessionID) => (ctx.session ? ctx.session.context({ sessionID }) : []),
    { maxSessions: 8, maxMessages: 400 },
  );

  const stored = await store.readConfig();
  const patch: ConfigPatch = {
    shadow: options.shadow,
    autoMemory: options.autoMemory,
    autoRules: options.autoRules,
    console: options.console,
    port: options.port,
    token: options.token,
    decision: options.decision,
    rewrite: options.rewrite,
    thresholds: options.thresholds,
    caps: options.caps,
  };
  const config = mergeConfig(stored, patch);
  config.dataDir = dataDir;
  const token = config.token ?? (await store.ensureToken());

  // Deterministic maintenance only: no model call, 24h gate and reservation
  // claim protect multi-instance/Desktop + CLI starts.
  void runCurator(store, config).catch((error: unknown) => {
    console.error("[memory-autopilot] curator failed", safeError(error));
  });

  const keyInfo = await resolveOllamaKey(config.decision.apiKeyEnv);
  const decision = createDecisionProvider({ config, store, key: keyInfo.key });
  const rewrite = createRewriteService({
    ctx,
    config,
    store,
    key: keyInfo.key,
  });

  const project = ctx.location?.project?.canonical ?? ctx.location?.directory;
  const projectKey = project ? sha16(project) : undefined;
  const visible = (
    entry: {
      scope: Scope;
      projectKey?: string;
      source?: { sessionID?: string };
      sources?: Array<{ sessionID?: string }>;
    },
    sessionID: string | undefined,
  ): boolean => visibleEntry(entry, projectKey, sessionID);

  let suggestionChain: Promise<void> = Promise.resolve();

  const suggest = async (id: string): Promise<Suggestion | undefined> => {
    const [queue, items, shadow] = await Promise.all([
      store.listQueue(),
      store.listItems(),
      store.listShadow(),
    ]);
    const item = queue.find((entry) => entry.id === id);
    if (!item) return undefined;
    // The console suggest path used to pass every item/queue/shadow row to the
    // model, including other projects. Keep the same one-way scope rule used by
    // turn consolidation: unknown project identity matches nothing.
    const belongsToItem = (entry: { scope: Scope; projectKey?: string }): boolean =>
      sameScopeAndProject(entry, item);
    const scopedItems = items.filter(belongsToItem);
    const scopedQueue = queue.filter(belongsToItem);
    const scopedShadow = shadow.filter(belongsToItem);
    const targetID = item.suggestion?.targetId ?? item.decision?.mergeTargetId;
    const target = targetID
      ? scopedItems.find((entry) => entry.id === targetID)
      : undefined;
    const resolved =
      item.decision ??
      (await decision.classify({
        candidate: item.text,
        title: item.title,
        existingTitles: [
          ...scopedItems.map((entry) => entry.title),
          ...scopedQueue.map((entry) => entry.title),
        ],
        neighbors: collectNeighbors(
          item.text,
          entriesFor(scopedItems, scopedQueue, scopedShadow),
          3,
        ),
        scope: item.scope,
        project: item.project,
      }));
    return buildSuggestion({ store, config, rewrite, broadcast: server?.broadcast }, item, resolved, target);
  };

  const reviewRuntime: ReviewRuntime = {};

  let server: ServerHandle | undefined;
  let consoleAcquired = false;
  if (config.console !== false) {
    try {
      server = await ensureConsoleServer({
        store,
        config,
        token,
        consoleDir: options.consoleDir ?? bundledConsoleDir(),
        decisionKeySource: keyInfo.source,
        projectDir: project,
        openExternal: options.openExternal,
        suggest,
        reviewStats: () => reviewStatsFor(dataDir),
        onReviewRequest: (sessionID: string) => requestReviewFor(dataDir, sessionID),
        onConfigChange: (next: AutoMemConfig) => notifyReviewConfigFor(dataDir, next),
      });
      consoleAcquired = true;
    } catch (error: unknown) {
      // A busy port or missing console build must not stop memory capture.
      console.error(
        "[memory-autopilot] console server failed to start",
        safeError(error),
      );
    }
  }

  const deps = {
    store,
    decision,
    config,
    readMessages: async (sessionID: string): Promise<SessionMessage[]> => {
      if (!ctx.session) return [];
      return reader.read(sessionID);
    },
    project,
    projectKey,
    broadcast: server?.broadcast,
    onQueueItem: (item: import("./types.js").QueueItem, result: import("./types.js").DecisionResult, target?: import("./types.js").Item) => {
      const needsRewrite =
        result.mergeAction === "merge_into" || result.mergeAction === "replace";
      // Deterministic suggestions (create / keep_both / reject_duplicate, and
      // every rewrite-disabled case) are built immediately and cost no model
      // call. Only an enabled, eager merge waits on System Two.
      const buildNow = !needsRewrite || !config.rewrite.enabled;
      if (!buildNow && !config.rewrite.eager) return;
      suggestionChain = suggestionChain
        .then(async () => {
          const current = (await store.listQueue()).find((entry) => entry.id === item.id);
          if (!current) return;
          if (!buildNow) {
            await store.upsertQueue({
              ...current,
              suggestionState: "pending",
              suggestionError: undefined,
            });
            server?.broadcast("queue.updated", { id: item.id, suggestionState: "pending" });
          }
          const items = await store.listItems();
          const targetItem =
            target ??
            (current.decision?.mergeTargetId
              ? items.find((entry) => entry.id === current.decision?.mergeTargetId)
              : undefined);
          await buildSuggestion(
            { store, config, rewrite, broadcast: server?.broadcast },
            current,
            current.decision ?? result,
            targetItem,
          );
        })
        .catch(async (error: unknown) => {
          const current = (await store.listQueue()).find((entry) => entry.id === item.id);
          if (current) {
            await store.upsertQueue({
              ...current,
              suggestionState: "failed",
              suggestionError: safeError(error),
            });
            server?.broadcast("suggestion.updated", {
              id: item.id,
              state: "failed",
              error: safeError(error),
            });
          }
        });
    },
  };

  let consolidationChain: Promise<void> = Promise.resolve();
  /** One consolidation writer across turn and review paths. */
  const consolidate = (sessionID: string, label: string): Promise<void> => {
    consolidationChain = consolidationChain
      .then(async () => {
        await runConsolidation(sessionID, deps);
        await maybeCompact(store, config);
      })
      .catch((error: unknown) => {
        console.error(`[memory-autopilot] ${label} failed`, safeError(error));
      });
    return consolidationChain;
  };

  const digestCache = new DigestCache(store, {
    maxEntries: config.digest.maxEntries,
    maxBytes: config.digest.maxBytes,
  });
  await digestCache.load();
  const reviewBuilder = new ReviewInputBuilder({ config, digestCache });
  const reviewProvider = new ReviewProvider({
    store,
    config,
    key: keyInfo.key,
    log: (message, error) =>
      console.error(`[memory-autopilot] ${message}`, safeError(error ?? "")),
  });
  const logReview = (message: string, error?: unknown) =>
    console.error(`[memory-autopilot] ${message}`, error === undefined ? "" : safeError(error));
  const reviewOrchestrator = new ReviewOrchestrator({
    store,
    config,
    reader,
    buildInput: (sessionID, messages, from, knownTitles) =>
      reviewBuilder.build(sessionID, messages, from, knownTitles),
    knownTitles: () => collectReviewKnownTitles(store, 30, projectKey),
    runModel: (input) => reviewProvider.review(input),
    validate: (input, candidates) => validateReviewCandidates(candidates, input, config),
    onAccepted: async (input, result, reviewID) => {
      const accepted = await acceptReviewCandidates(input, result, reviewID, {
        store,
        config,
        project: deps.project,
        projectKey: deps.projectKey,
      });
      await digestCache.flush();
      if (result.candidates.length > 0) {
        await consolidate(input.sessionID, "review consolidation");
      }
      return accepted;
    },
    broadcast: server?.broadcast,
    log: logReview,
  });

  reviewRuntime.stats = () => ({
    ...reviewProvider.stats(),
    ...reviewOrchestrator.stats(),
  });
  reviewRuntime.run = async (sessionID) => {
    const state = await store.readSession(sessionID);
    if (!state || state.contextProjectKey !== projectKey) return undefined;
    return reviewOrchestrator.runNow(sessionID, "manual");
  };
  reviewRuntime.onConfig = (next) => {
    Object.assign(config.review, next.review);
    Object.assign(config.digest, next.digest);
    Object.assign(config.thresholds, next.thresholds);
    Object.assign(config.caps, next.caps);
    config.shadow = next.shadow;
    config.autoMemory = next.autoMemory;
    config.autoRules = next.autoRules;
    if (!config.review.enabled) reviewOrchestrator.pause();
    else reviewOrchestrator.resume();
  };

  const controller = new AbortController();
  let eventJob: Promise<void> | undefined;

  if (ctx.event) {
    const api = ctx.event;
    // V2: `session.idle` is ephemeral and is not delivered to ctx.event.subscribe;
    // durable `session.execution.*` events mark turn completion. `session.idle`
    // stays in the list for older hosts.
    eventJob = (async () => {
      let backoff = 250;
      while (!controller.signal.aborted) {
      try {
        for await (const event of api.subscribe({
          types: [
            "session.idle",
            "session.created",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
          ],
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break;
          const owner = ctx.location?.directory;
          const eventDirectory =
            isRecord(event.location) && typeof event.location.directory === "string"
              ? event.location.directory : undefined;
          if (owner && eventDirectory && eventDirectory !== owner) continue;
          backoff = 250;
          // Several plugin instances can share one data dir (workspaces, hot
          // reload). Process each event exactly once across them.
          const eventID =
            typeof event.id === "string" ? event.id : undefined;
          if (eventID) {
            const holder = globalThis as Record<string, unknown>;
            const key = `__openMemSeenEvents:${dataDir}`;
            const seen =
              (holder[key] as Map<string, number> | undefined) ??
              new Map<string, number>();
            holder[key] = seen;
            if (seen.has(eventID)) continue;
            seen.set(eventID, Date.now());
            if (seen.size > 2000) {
              const cutoff = Date.now() - 10 * 60_000;
              for (const [id, at] of seen) {
                if (at < cutoff) seen.delete(id);
              }
            }
          }

          // The host can load one instance per workspace. Only the instance
          // whose directory owns the session may process its events.
          const sessionID = eventSessionID(event);
          if (!sessionID) continue;
          const turnFinished =
            event.type === "session.idle" ||
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.interrupted";
          if (event.type === "session.created") {
            const data = isRecord(event.data) ? event.data : undefined;
            if (data) {
              const parentSessionID = readParentID(data);
              const agent = readAgent(data);
              await store
                .updateSession(sessionID, {
                  ...(parentSessionID ? { parentSessionID, parentChecked: true } : {}),
                  ...(agent ? { agent } : {}),
                })
                .catch((error: unknown) => {
                  console.error(
                    "[memory-autopilot] session meta failed",
                    safeError(error),
                  );
                });
            }
            await refreshContext(ctx, store, config, sessionID, projectKey).catch((error: unknown) => {
              console.error("[memory-autopilot] context refresh failed", safeError(error));
            });
          }
          if (turnFinished) {
            // Subagent sessions are not user memory sources. Older sessions may
            // not have a session.created record, so backfill from session.get.
            let sessionState = await store.readSession(sessionID);
            if (!sessionState?.parentChecked && ctx.session?.get) {
              const info = await ctx.session
                .get({ sessionID })
                .catch(() => undefined);
              const parentSessionID = readParentID(info);
              const agent = readAgent(info);
              await store
                .updateSession(sessionID, {
                  parentSessionID,
                  agent,
                  parentChecked: info !== undefined,
                })
                .catch(() => undefined);
              sessionState = { ...sessionState, parentSessionID, agent, parentChecked: info !== undefined };
            }
            if (sessionState?.parentSessionID) continue;
            await consolidate(sessionID, "consolidation");
            await reviewOrchestrator.schedule(sessionID).catch((error: unknown) => {
              console.error("[memory-autopilot] review scheduling failed", safeError(error));
            });
          }
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          console.error("[memory-autopilot] event stream failed", safeError(error));
        }
      }
      if (controller.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, backoff);
        controller.signal.addEventListener("abort", finish, { once: true });
      });
      backoff = Math.min(backoff * 2, 30_000);
      }
    })();
  }

  const contextRegistration = ctx.session?.hook
    ? await ctx.session.hook("context", async (event) => {
        const entry = ctx.session?.instructions?.entry;
        if (entry && event.sessionID) {
          await refreshContext(ctx, store, config, event.sessionID, projectKey);
          return;
        }
        const block = await buildContext(store, config, projectKey);
        const text = renderContext(block);
        if (Array.isArray(event.system)) event.system.push({ type: "text", text });
      })
    : undefined;

  const toolsRegistration = ctx.tool
    ? await ctx.tool.transform((editor) => {
        editor.add({
          name: "memory_autopilot",
          description:
            "Review the OpenMem queue, run an audit, decide a pending item, generate a merge suggestion, or create a skill draft. Use it when the user asks about pending rules, memory quality, or skill review.",
          input: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: [
                  "status",
                  "review",
                  "review_session",
                  "audit",
                  "decide",
                  "suggest",
                  "learn_skill",
                  "console_url",
                ],
              },
              id: { type: "string" },
              decision: {
                type: "string",
                enum: ["approve", "deny", "edit", "defer", "apply_suggestion"],
              },
              title: { type: "string" },
              text: { type: "string" },
              description: { type: "string" },
              scenario: { type: "string" },
              references: { type: "array", items: { type: "string" } },
              note: { type: "string" },
            },
            required: ["action"],
            additionalProperties: false,
          },
          options: { codemode: false },
          execute: async (input: unknown, context: { sessionID?: string }) => {
            const request = parseToolInput(input);
            if (!request) return { content: "Invalid memory_autopilot input." };
            if (request.action === "status") {
              const sessionID = context.sessionID;
              const [allItems, allQueue, allShadow, allSkills, audit] = await Promise.all([
                store.listItems(),
                store.listQueue(),
                store.listShadow(),
                store.listSkillDrafts(),
                store.readAudit(),
              ]);
              const items = allItems.filter((entry) => visible(entry, sessionID));
              const queue = allQueue.filter((entry) => visible(entry, sessionID));
              const shadow = allShadow.filter((entry) => visible(entry, sessionID));
              const visibleIDs = new Set(
                [...items, ...queue, ...shadow].map((entry) => entry.id),
              );
              for (const draft of allSkills) {
                if (!draft.source?.sessionID || draft.source.sessionID === sessionID) {
                  visibleIDs.add(draft.id);
                }
              }
              const scopedAudit = visibleAuditReport(audit, visibleIDs);
              return {
                content: JSON.stringify(
                  {
                    items: items.length,
                    queue: queue.length,
                    shadow: shadow.length,
                    auto: items.filter((item) => item.status === "auto").length,
                    audit: scopedAudit.summary,
                    console: publicConsoleInfo(server),
                    decision: {
                      kind: config.decision.kind,
                      model: config.decision.model,
                      keySource: keyInfo.source,
                    },
                  },
                  null,
                  2,
                ),
              };
            }
            if (request.action === "review") {
              const sessionID = context.sessionID;
              const queue = (await store.listQueue()).filter((entry) =>
                visible(entry, sessionID),
              );
              return { content: JSON.stringify(sortQueue(queue), null, 2) };
            }
            if (request.action === "review_session") {
              if (!context.sessionID) {
                return { content: "review_session needs an active session." };
              }
              const record = reviewRuntime.run
                ? await reviewRuntime.run(context.sessionID)
                : await reviewOrchestrator.runNow(context.sessionID, "manual");
              return {
                content: JSON.stringify(
                  record ?? { status: "skipped", reason: "session is not owned by this project or has no new material" },
                  null,
                  2,
                ),
              };
            }
            if (request.action === "audit") {
              const sessionID = context.sessionID;
              const [report, items, queue, shadow, skills] = await Promise.all([
                runAudit(store, config),
                store.listItems(),
                store.listQueue(),
                store.listShadow(),
                store.listSkillDrafts(),
              ]);
              const visibleIDs = new Set(
                [...items, ...queue, ...shadow]
                  .filter((entry) => visible(entry, sessionID))
                  .map((entry) => entry.id),
              );
              for (const draft of skills) {
                if (!draft.source?.sessionID || draft.source.sessionID === sessionID) {
                  visibleIDs.add(draft.id);
                }
              }
              return {
                content: JSON.stringify(visibleAuditReport(report, visibleIDs), null, 2),
              };
            }
            if (request.action === "suggest") {
              if (!request.id) return { content: "suggest requires id." };
              const item = (await store.listQueue()).find((entry) => entry.id === request.id);
              if (!item || !visible(item, context.sessionID)) {
                return { content: "队列条目不存在或不属于当前项目/会话。" };
              }
              const suggestion = await suggest(request.id);
              return { content: JSON.stringify(suggestion ?? null, null, 2) };
            }
            if (request.action === "decide") {
              if (!request.id || !request.decision) {
                return { content: "decide requires id and decision." };
              }
              const item = (await store.listQueue()).find((entry) => entry.id === request.id);
              if (!item || !visible(item, context.sessionID)) {
                return { content: "队列条目不存在或不属于当前项目/会话。" };
              }
              if (["approve", "apply_suggestion", "promote"].includes(request.decision)) {
                return { content: "正式写入、合并与提升需要用户在控制台确认；请展示候选供用户处理。" };
              }
              const result = await applyQueueDecision(store, config, request.id, {
                action: request.decision,
                text: request.text,
                title: request.title,
                note: request.note,
              }, undefined, { source: "agent-tool" });
              return { content: JSON.stringify(result, null, 2) };
            }
            if (request.action === "learn_skill") {
              if (!request.title || !request.text) {
                return { content: "learn_skill requires title and text." };
              }
              const inputSkill: SkillInput = {
                name: request.title,
                title: request.title,
                description: request.description,
                scenario: request.scenario ?? request.text,
                references: request.references,
                source: { sessionID: context.sessionID, role: "user" },
              };
              const draft = await createSkillDraft(store, inputSkill);
              return { content: JSON.stringify(draft, null, 2) };
            }
            if (request.action === "console_url") {
              if (!server) return { content: "Console is disabled." };
              return {
                content:
                  "控制台由用户在本地运行 /memory-console 打开；一次性连接链接不会返回给模型。",
              };
            }
            return { content: "Unknown action." };
          },
        });
      })
    : undefined;

  const commandsRegistration = ctx.command
    ? await ctx.command.transform((editor) => {
        const prompt = async (sessionID: string, text: string) => {
          if (!ctx.session) return;
          await ctx.session.prompt({ sessionID, text, delivery: "queue" });
        };
        editor.add({
          name: "memory-review",
          description: "Review pending memory and rule candidates with priority and suggested merges.",
          execute: async ({ sessionID }: { sessionID: string }) => {
            await prompt(
              sessionID,
              "Call memory_autopilot with action=review, then present the pending items sorted by priority. Each item includes a suggestion when available; ask me to approve the suggestion, edit it, or reject it.",
            );
          },
        });
        editor.add({
          name: "memory-review-session",
          description: "Review the current session and queue durable memory candidates for approval.",
          execute: async ({ sessionID }: { sessionID: string }) => {
            const record = reviewRuntime.run
              ? await reviewRuntime.run(sessionID)
              : await reviewOrchestrator.runNow(sessionID, "manual");
            const summary =
              record && typeof record === "object"
                ? (record as { status?: unknown; candidates?: unknown })
                : undefined;
            if (!summary) {
              await prompt(
                sessionID,
                "Session review skipped: no new material, unchanged transcript, or hourly cap reached.",
              );
              return;
            }
            const status =
              typeof summary.status === "string" ? summary.status : "done";
            const candidates =
              typeof summary.candidates === "number" ? summary.candidates : 0;
            await prompt(
              sessionID,
              `Session review ${status}: ${candidates} candidate(s) queued. Call memory_autopilot with action=review to show them.`,
            );
          },
        });
        editor.add({
          name: "memory-audit",
          description: "Run a memory and skill audit and summarize findings.",
          execute: async ({ sessionID }: { sessionID: string }) => {
            await prompt(
              sessionID,
              "Call memory_autopilot with action=audit and summarize the findings by severity. Offer to compact memory if capacity is high.",
            );
          },
        });
        editor.add({
          name: "memory-console",
          description: "Open the local OpenMem console in the host browser.",
          execute: async ({ sessionID }: { sessionID: string }) => {
            if (!server) {
              await prompt(sessionID, "OpenMem 控制台未启用。");
              return;
            }
            const opened = await server.openConsole();
            await prompt(
              sessionID,
              opened
                ? "已在本地浏览器打开 OpenMem 控制台（一次性链接，不经过模型）。"
                : "无法自动打开浏览器；请让本地用户运行 /memory-console。",
            );
          },
        });
      })
    : undefined;

  registerReviewRuntime(dataDir, reviewRuntime);

  const recoveryJob = reviewOrchestrator.recover().catch((error: unknown) => {
    console.error("[memory-autopilot] review recovery failed", safeError(error));
  });

  return async () => {
    controller.abort();
    await eventJob?.catch(() => undefined);
    await recoveryJob;
    await reviewOrchestrator.dispose();
    unregisterReviewRuntime(dataDir, reviewRuntime);
    await consolidationChain.catch(() => undefined);
    await suggestionChain.catch(() => undefined);
    await contextRegistration?.dispose();
    await toolsRegistration?.dispose();
    await commandsRegistration?.dispose();
    if (consoleAcquired) {
      await releaseConsoleServer(dataDir, config.port ?? 0).catch(() => undefined);
    }
  };
}

export async function ensureConsoleServer(options: {
  store: Store;
  config: AutoMemConfig;
  token: string;
  consoleDir?: string;
  decisionKeySource: "env" | "auth" | "missing";
  projectDir?: string;
  openExternal?: (url: string) => Promise<boolean>;
  suggest: (id: string) => Promise<Suggestion | undefined>;
  reviewStats?: () => Record<string, unknown>;
  onReviewRequest?: (sessionID: string) => Promise<unknown>;
  onConfigChange?: (config: AutoMemConfig) => void;
}): Promise<ServerHandle> {
  type GlobalWithConsoles = typeof globalThis & {
    __openMemConsoles?: Map<string, Promise<ServerHandle>>;
  };
  const globalState = globalThis as GlobalWithConsoles;
  const map = globalState.__openMemConsoles ?? new Map<string, Promise<ServerHandle>>();
  globalState.__openMemConsoles = map;
  const key = `${options.store.dataDir}:${options.config.port ?? 0}`;
  const acquire = (target: Promise<ServerHandle>): Promise<ServerHandle> =>
    target.then((handle) => {
      const refs = consoleRefs();
      refs.set(key, (refs.get(key) ?? 0) + 1);
      return handle;
    });
  const existing = map.get(key);
  if (existing) return acquire(existing);
  const promise = startServer({
    store: options.store,
    config: options.config,
    token: options.token,
    port: options.config.port,
    consoleDir: options.consoleDir,
    decisionKeySource: options.decisionKeySource,
    projectDir: options.projectDir,
    openExternal: options.openExternal,
    suggest: options.suggest,
    reviewStats: options.reviewStats,
    onReviewRequest: options.onReviewRequest,
    onConfigChange: options.onConfigChange,
  }).catch((error: unknown) => {
    map.delete(key);
    throw error;
  });
  map.set(key, promise);
  return acquire(promise);
}

/**
 * The console server is shared by every plugin instance for one data dir.
 * Only the last release closes it; a hot-reloaded instance must not kill the
 * console used by its siblings.
 */
export async function releaseConsoleServer(dataDir: string, port: number): Promise<void> {
  const key = `${dataDir}:${port}`;
  const refs = consoleRefs();
  const current = refs.get(key) ?? 0;
  if (current > 1) {
    refs.set(key, current - 1);
    return;
  }
  refs.delete(key);
  type GlobalWithConsoles = typeof globalThis & {
    __openMemConsoles?: Map<string, Promise<ServerHandle>>;
  };
  const map = (globalThis as GlobalWithConsoles).__openMemConsoles;
  const promise = map?.get(key);
  map?.delete(key);
  if (!promise) return;
  const handle = await promise.catch(() => undefined);
  await handle?.close().catch(() => undefined);
}

export async function refreshContext(
  ctx: PluginContext,
  store: Store,
  config: AutoMemConfig,
  sessionID: string,
  projectKey?: string,
): Promise<void> {
  const entry = ctx.session?.instructions?.entry;
  if (!entry) return;
  const pinned = await store.readSession(sessionID);
  const block =
    pinned?.contextBlock && pinned.contextProjectKey === projectKey
      ? pinned.contextBlock
      : await buildContext(store, config, projectKey);
  const text = renderContext(block);
  if (contextCache.get(sessionID) === text) return;
  await entry.put({ sessionID, key: "plugin.memory-autopilot", value: block });
  contextCache.set(sessionID, text);
  if (!pinned?.contextBlock || pinned.contextProjectKey !== projectKey) {
    await store.updateSession(sessionID, {
      contextBlock: block,
      contextHash: sha16(text),
      contextProjectKey: projectKey,
    });
  }
}

/**
 * Build the frozen prefix from active items, never from the queue or review
 * state. Project items are visible only in their owning project.
 */
export async function buildContext(
  store: Store,
  config: AutoMemConfig,
  projectKey?: string,
): Promise<AutopilotContext> {
  const active = (await store.listItems()).filter(
    (item) => item.status === "auto" || item.status === "promoted",
  );
  const visible = active.filter(
    (item) =>
      item.scope === "global" ||
      (item.scope === "project" &&
        projectKey !== undefined &&
        item.projectKey === projectKey),
  );
  const sorted = [...visible].sort((left, right) => {
    const byScope = scopeRank(left.scope) - scopeRank(right.scope);
    if (byScope !== 0) return byScope;
    const byCreated = left.createdAt.localeCompare(right.createdAt);
    if (byCreated !== 0) return byCreated;
    return left.id.localeCompare(right.id);
  });
  const clean = (item: Item): string => item.text.replace(/\s+/g, " ").trim();
  const select = (items: Item[], max: number): string[] => {
    const global = items.filter((item) => item.scope === "global");
    const project = items.filter((item) => item.scope === "project");
    const globalSlots = Math.min(global.length, project.length ? Math.ceil(max / 2) : max);
    const selectedProject = project.slice(-(max - globalSlots));
    const selectedGlobal = global.slice(-(max - selectedProject.length));
    return [...selectedGlobal, ...selectedProject].map(clean).filter(Boolean);
  };
  return {
    version: 1,
    autoMemory: select(sorted.filter((item) => item.kind !== "rule" && item.kind !== "skill"), 10),
    autoRules: select(sorted.filter((item) => item.kind === "rule"), 8),
    shadow: config.shadow,
  };
}

function scopeRank(scope: Scope): number {
  if (scope === "global") return 0;
  if (scope === "project") return 1;
  return 2;
}

export function renderContext(block: AutopilotContext): string {
  const lines = [
    "## AUTOPILOT",
    "Provisional memory from the OpenMem plugin. Curated AGENTS.md and memory/*.md win over these entries.",
  ];
  if (block.autoMemory.length > 0) {
    lines.push(
      "",
      "Auto memory (facts/preferences, newest last):",
      ...block.autoMemory.map((line) => `- ${line}`),
    );
  }
  if (block.autoRules.length > 0) {
    lines.push("", "Auto rules (low-risk, provisional):", ...block.autoRules.map((line) => `- ${line}`));
  }
  lines.push(
    "",
    `Shadow mode: ${block.shadow ? "on" : "off"}.`,
    "Live counts: call `memory_autopilot` with action=status. Do not treat auto rules as curated policy.",
  );
  return lines.join("\n");
}

function eventSessionID(event: OpenCodeEvent): string | undefined {
  if (typeof event.sessionID === "string") return event.sessionID;
  // V2 events carry the payload under `data` (session.idle / session.created).
  if (isRecord(event.data)) {
    if (typeof event.data.sessionID === "string") return event.data.sessionID;
    if (isRecord(event.data.info) && typeof event.data.info.id === "string") {
      return event.data.info.id;
    }
  }
  if (isRecord(event.properties) && typeof event.properties.sessionID === "string") {
    return event.properties.sessionID;
  }
  return undefined;
}

/** Console availability without the long-lived token or a redeemable ticket. */
function visibleEntry(
  entry: {
    scope: Scope;
    projectKey?: string;
    source?: { sessionID?: string };
    sources?: Array<{ sessionID?: string }>;
  },
  projectKey: string | undefined,
  sessionID: string | undefined,
): boolean {
  if (entry.scope === "global") return true;
  if (entry.scope === "project") {
    return projectKey !== undefined && entry.projectKey === projectKey;
  }
  if (entry.scope !== "session" || !sessionID) return false;
  if (entry.source?.sessionID === sessionID) return true;
  return (entry.sources ?? []).some((source) => source.sessionID === sessionID);
}

function visibleAuditReport(report: AuditReport, visibleIDs: Set<string>): AuditReport {
  const findings = report.findings.filter(
    (finding) =>
      // Aggregate capacity/shadow findings have no item IDs and contain no
      // project content; keep them so the agent still sees health warnings.
      finding.itemIDs.length === 0 ||
      finding.itemIDs.every((id) => visibleIDs.has(id)),
  );
  const summary = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) summary[finding.severity] += 1;
  return { ...report, findings, summary };
}

function publicConsoleInfo(
  server: ServerHandle | undefined,
): { available: boolean; url: string; connect: string } | null {
  if (!server) return null;
  const endpoint = new URL(server.url);
  endpoint.search = "";
  endpoint.hash = "";
  return {
    available: true,
    url: endpoint.toString(),
    connect: "user-command: /memory-console",
  };
}

/** V2 and legacy envelopes expose parent/agent under different keys. */
function readParentID(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.parentID === "string") return value.parentID;
  if (typeof value.parent_id === "string") return value.parent_id;
  if (isRecord(value.info)) return readParentID(value.info);
  return undefined;
}

function readAgent(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.agent === "string") return value.agent;
  if (isRecord(value.info)) return readAgent(value.info);
  return undefined;
}

function parseOptions(value: unknown): PluginOptions {
  if (!isRecord(value)) return {};
  const options: PluginOptions = {};
  if (typeof value.dataDir === "string") options.dataDir = value.dataDir;
  if (typeof value.consoleDir === "string") options.consoleDir = value.consoleDir;
  if (typeof value.shadow === "boolean") options.shadow = value.shadow;
  if (typeof value.autoMemory === "boolean") options.autoMemory = value.autoMemory;
  if (typeof value.autoRules === "boolean") options.autoRules = value.autoRules;
  if (typeof value.console === "boolean") options.console = value.console;
  if (typeof value.port === "number") options.port = value.port;
  if (typeof value.token === "string") options.token = value.token;
  if (isRecord(value.decision)) {
    const decision: PluginOptions["decision"] = {};
    if (value.decision.kind === "systemone" || value.decision.kind === "heuristic") {
      decision.kind = value.decision.kind;
    }
    for (const key of ["endpoint", "model", "apiKeyEnv"] as const) {
      if (typeof value.decision[key] === "string") decision[key] = value.decision[key] as string;
    }
    for (const key of ["timeoutMs", "maxCallsPerHour", "cacheTtlHours"] as const) {
      if (typeof value.decision[key] === "number") decision[key] = value.decision[key] as number;
    }
    options.decision = decision;
  }
  if (isRecord(value.rewrite)) {
    const rewrite: PluginOptions["rewrite"] = {};
    if (typeof value.rewrite.enabled === "boolean") rewrite.enabled = value.rewrite.enabled;
    if (value.rewrite.transport === "opencode" || value.rewrite.transport === "ollama") {
      rewrite.transport = value.rewrite.transport;
    }
    if (typeof value.rewrite.endpoint === "string") rewrite.endpoint = value.rewrite.endpoint;
    if (typeof value.rewrite.eager === "boolean") rewrite.eager = value.rewrite.eager;
    if (isRecord(value.rewrite.model)) {
      const model: { providerID?: string; id?: string; variant?: string } = {};
      if (typeof value.rewrite.model.providerID === "string") {
        model.providerID = value.rewrite.model.providerID;
      }
      if (typeof value.rewrite.model.id === "string") model.id = value.rewrite.model.id;
      if (typeof value.rewrite.model.variant === "string") {
        model.variant = value.rewrite.model.variant;
      }
      rewrite.model = model;
    }
    for (const key of ["timeoutMs", "maxCallsPerHour", "repairAttempts", "cacheTtlHours"] as const) {
      if (typeof value.rewrite[key] === "number") rewrite[key] = value.rewrite[key] as number;
    }
    options.rewrite = rewrite;
  }
  if (isRecord(value.thresholds)) {
    const thresholds: PluginOptions["thresholds"] = {};
    for (const key of [
      "memoryMaxChars",
      "ruleMaxChars",
      "titleMaxChars",
      "autoOkMin",
      "globalAutoOkMin",
      "duplicateMax",
    ] as const) {
      if (typeof value.thresholds[key] === "number") {
        thresholds[key] = value.thresholds[key] as number;
      }
    }
    options.thresholds = thresholds;
  }
  if (isRecord(value.caps)) {
    const caps: PluginOptions["caps"] = {};
    for (const key of [
      "autoMemory",
      "autoRules",
      "queue",
      "shadow",
      "skillDrafts",
      "itemsTotal",
      "suggestions",
      "diskBytes",
    ] as const) {
      if (typeof value.caps[key] === "number") caps[key] = value.caps[key] as number;
    }
    options.caps = caps;
  }
  return options;
}

function parseToolInput(value: unknown): {
  action: string;
  id?: string;
  decision?: "approve" | "deny" | "edit" | "defer" | "apply_suggestion";
  title?: string;
  text?: string;
  description?: string;
  scenario?: string;
  references?: string[];
  note?: string;
} | undefined {
  if (!isRecord(value) || typeof value.action !== "string") return undefined;
  return {
    action: value.action,
    id: typeof value.id === "string" ? value.id : undefined,
    decision:
      value.decision === "approve" ||
      value.decision === "deny" ||
      value.decision === "edit" ||
      value.decision === "defer" ||
      value.decision === "apply_suggestion"
        ? value.decision
        : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    text: typeof value.text === "string" ? value.text : undefined,
    description: typeof value.description === "string" ? value.description : undefined,
    scenario: typeof value.scenario === "string" ? value.scenario : undefined,
    references: Array.isArray(value.references)
      ? value.references.filter((entry): entry is string => typeof entry === "string")
      : undefined,
    note: typeof value.note === "string" ? value.note : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reset "pending" markers left behind by a process that died mid-rewrite.
 * Pending is an in-flight state, never a placeholder for "not generated".
 */
export async function resetStaleSuggestions(
  store: Store,
  maxAgeMs = 5 * 60_000,
  now = Date.now(),
): Promise<number> {
  const queue = await store.listQueue();
  let reset = 0;
  for (const item of queue) {
    if (item.suggestionState !== "pending") continue;
    const updated = Date.parse(item.updatedAt);
    if (Number.isFinite(updated) && now - updated < maxAgeMs) continue;
    await store.upsertQueue({
      ...item,
      suggestionState: undefined,
      suggestionError: undefined,
    });
    reset += 1;
  }
  return reset;
}

export { newId };
