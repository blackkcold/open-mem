import os from "node:os";
import path from "node:path";
import type {
  AutoMemConfig,
  AutopilotContext,
  DecisionConfig,
  RewriteConfig,
  SessionMessage,
  SkillInput,
  Suggestion,
} from "./types.js";
import { mergeConfig, type ConfigPatch } from "./config.js";
import { Store, newId } from "./store.js";
import { createDecisionProvider, resolveOllamaKey } from "./decision.js";
import { bullets, runConsolidation } from "./consolidate.js";
import { runAudit } from "./audit.js";
import { applyQueueDecision } from "./actions.js";
import { createSkillDraft } from "./skill.js";
import { startServer, type ServerHandle } from "./server.js";
import { sortQueue } from "./priority.js";
import { createRewriteService } from "./rewrite/index.js";
import { buildSuggestion } from "./suggestion.js";
import { maybeCompact } from "./compact.js";
import { collectNeighbors, entriesFor } from "./fingerprint.js";

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
    model?: { providerID?: string; id?: string };
  };
  thresholds?: Partial<AutoMemConfig["thresholds"]>;
  caps?: Partial<AutoMemConfig["caps"]>;
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

  const keyInfo = await resolveOllamaKey(config.decision.apiKeyEnv);
  const decision = createDecisionProvider({ config, store, key: keyInfo.key });
  const rewrite = createRewriteService({
    ctx,
    config,
    store,
    key: keyInfo.key,
  });

  let suggestionChain: Promise<void> = Promise.resolve();

  const suggest = async (id: string): Promise<Suggestion | undefined> => {
    const [queue, items, shadow] = await Promise.all([
      store.listQueue(),
      store.listItems(),
      store.listShadow(),
    ]);
    const item = queue.find((entry) => entry.id === id);
    if (!item) return undefined;
    const targetID = item.suggestion?.targetId ?? item.decision?.mergeTargetId;
    const target = targetID ? items.find((entry) => entry.id === targetID) : undefined;
    const resolved =
      item.decision ??
      (await decision.classify({
        candidate: item.text,
        title: item.title,
        existingTitles: [
          ...items.map((entry) => entry.title),
          ...queue.map((entry) => entry.title),
        ],
        neighbors: collectNeighbors(item.text, entriesFor(items, queue, shadow), 3),
        scope: item.scope,
        project: item.project,
      }));
    return buildSuggestion({ store, config, rewrite, broadcast: server?.broadcast }, item, resolved, target);
  };

  const server =
    config.console === false
      ? undefined
      : await ensureConsoleServer({
          store,
          config,
          token,
          consoleDir: options.consoleDir,
          decisionKeySource: keyInfo.source,
          suggest,
        });

  const deps = {
    store,
    decision,
    config,
    readMessages: async (sessionID: string): Promise<SessionMessage[]> => {
      if (!ctx.session) return [];
      return normalizeSessionMessages(await ctx.session.context({ sessionID }));
    },
    project: ctx.location?.project?.canonical ?? ctx.location?.directory,
    broadcast: server?.broadcast,
    onQueueItem: (item: import("./types.js").QueueItem, result: import("./types.js").DecisionResult, target?: import("./types.js").Item) => {
      const needsRewrite =
        result.mergeAction === "merge_into" || result.mergeAction === "replace";
      if (!needsRewrite || !config.rewrite.enabled) return;
      if (!config.rewrite.eager) return;
      suggestionChain = suggestionChain
        .then(async () => {
          const current = (await store.listQueue()).find((entry) => entry.id === item.id);
          if (!current) return;
          await store.upsertQueue({
            ...current,
            suggestionState: "pending",
            suggestionError: undefined,
          });
          server?.broadcast("queue.updated", { id: item.id, suggestionState: "pending" });
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

  const controller = new AbortController();
  if (ctx.event) {
    const api = ctx.event;
    void (async () => {
      try {
        for await (const event of api.subscribe({
          types: ["session.idle", "session.created"],
          signal: controller.signal,
        })) {
          const sessionID = eventSessionID(event);
          if (!sessionID) continue;
          if (event.type === "session.idle") {
            await runConsolidation(sessionID, deps).catch((error: unknown) => {
              console.error("[memory-autopilot] consolidation failed", safeError(error));
            });
            await maybeCompact(store, config).catch((error: unknown) => {
              console.error("[memory-autopilot] compaction failed", safeError(error));
            });
          }
          if (event.type === "session.created") {
            await refreshContext(ctx, store, config, sessionID).catch((error: unknown) => {
              console.error("[memory-autopilot] context refresh failed", safeError(error));
            });
          }
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          console.error("[memory-autopilot] event stream failed", safeError(error));
        }
      }
    })();
  }

  const contextRegistration = ctx.session?.hook
    ? await ctx.session.hook("context", async (event) => {
        const block = await buildContext(store, config);
        const text = renderContext(block);
        const entry = ctx.session?.instructions?.entry;
        if (entry && event.sessionID) {
          if (contextCache.get(event.sessionID) === text) return;
          await entry.put({
            sessionID: event.sessionID,
            key: "plugin.memory-autopilot",
            value: block,
          });
          contextCache.set(event.sessionID, text);
          return;
        }
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
              const [items, queue, shadow, audit] = await Promise.all([
                store.listItems(),
                store.listQueue(),
                store.listShadow(),
                store.readAudit(),
              ]);
              return {
                content: JSON.stringify(
                  {
                    items: items.length,
                    queue: queue.length,
                    shadow: shadow.length,
                    auto: items.filter((item) => item.status === "auto").length,
                    audit: audit.summary,
                    console: server?.url,
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
              return { content: JSON.stringify(sortQueue(await store.listQueue()), null, 2) };
            }
            if (request.action === "audit") {
              const report = await runAudit(store, config);
              return { content: JSON.stringify(report, null, 2) };
            }
            if (request.action === "suggest") {
              if (!request.id) return { content: "suggest requires id." };
              const suggestion = await suggest(request.id);
              return { content: JSON.stringify(suggestion ?? null, null, 2) };
            }
            if (request.action === "decide") {
              if (!request.id || !request.decision) {
                return { content: "decide requires id and decision." };
              }
              const result = await applyQueueDecision(store, config, request.id, {
                action: request.decision,
                text: request.text,
                title: request.title,
                note: request.note,
              });
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
              return { content: server?.url ?? "Console is disabled." };
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
          description: "Show the local OpenMem console URL.",
          execute: async ({ sessionID }: { sessionID: string }) => {
            await prompt(
              sessionID,
              `The OpenMem console is at ${server?.url ?? "(disabled)"}. Open it in the browser; the token is in the URL.`,
            );
          },
        });
      })
    : undefined;

  return async () => {
    controller.abort();
    await suggestionChain.catch(() => undefined);
    await contextRegistration?.dispose();
    await toolsRegistration?.dispose();
    await commandsRegistration?.dispose();
    if (server) {
      await server.close().catch(() => undefined);
      clearConsoleServer(dataDir, config.port ?? 0);
    }
  };
}

async function ensureConsoleServer(options: {
  store: Store;
  config: AutoMemConfig;
  token: string;
  consoleDir?: string;
  decisionKeySource: "env" | "auth" | "missing";
  suggest: (id: string) => Promise<Suggestion | undefined>;
}): Promise<ServerHandle> {
  type GlobalWithConsoles = typeof globalThis & {
    __openMemConsoles?: Map<string, Promise<ServerHandle>>;
  };
  const globalState = globalThis as GlobalWithConsoles;
  const map = globalState.__openMemConsoles ?? new Map<string, Promise<ServerHandle>>();
  globalState.__openMemConsoles = map;
  const key = `${options.store.dataDir}:${options.config.port ?? 0}`;
  const existing = map.get(key);
  if (existing) return existing;
  const promise = startServer({
    store: options.store,
    config: options.config,
    token: options.token,
    port: options.config.port,
    consoleDir: options.consoleDir,
    decisionKeySource: options.decisionKeySource,
    suggest: options.suggest,
  }).catch((error: unknown) => {
    map.delete(key);
    throw error;
  });
  map.set(key, promise);
  return promise;
}

function clearConsoleServer(dataDir: string, port: number): void {
  type GlobalWithConsoles = typeof globalThis & {
    __openMemConsoles?: Map<string, Promise<ServerHandle>>;
  };
  const map = (globalThis as GlobalWithConsoles).__openMemConsoles;
  map?.delete(`${dataDir}:${port}`);
}

async function refreshContext(
  ctx: PluginContext,
  store: Store,
  config: AutoMemConfig,
  sessionID: string,
): Promise<void> {
  const entry = ctx.session?.instructions?.entry;
  if (!entry) return;
  const block = await buildContext(store, config);
  const text = renderContext(block);
  if (contextCache.get(sessionID) === text) return;
  await entry.put({ sessionID, key: "plugin.memory-autopilot", value: block });
  contextCache.set(sessionID, text);
}

async function buildContext(
  store: Store,
  config: AutoMemConfig,
): Promise<AutopilotContext> {
  const [memory, rules, queue, audit] = await Promise.all([
    store.readAutoMemory(),
    store.readAutoRules(),
    store.listQueue(),
    store.readAudit(),
  ]);
  const auditSummary =
    audit.summary.error + audit.summary.warning > 0
      ? `${audit.summary.error} error, ${audit.summary.warning} warning`
      : undefined;
  return {
    version: 1,
    autoMemory: bullets(memory).slice(-10),
    autoRules: bullets(rules).slice(-8),
    queueCount: queue.length,
    auditSummary,
    shadow: config.shadow,
  };
}

function renderContext(block: AutopilotContext): string {
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
    `Pending review: ${block.queueCount}. Shadow mode: ${block.shadow ? "on" : "off"}.`,
  );
  if (block.auditSummary) lines.push(`Audit: ${block.auditSummary}.`);
  lines.push(
    "Use `memory_autopilot` with action=review for details; do not treat auto rules as curated policy.",
  );
  return lines.join("\n");
}

function normalizeSessionMessages(raw: unknown): SessionMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: SessionMessage[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const info = isRecord(entry.info) ? entry.info : entry;
    const parts = Array.isArray(entry.parts)
      ? entry.parts
      : Array.isArray(info.parts)
        ? info.parts
        : Array.isArray(entry.content)
          ? entry.content
          : Array.isArray(info.content)
            ? info.content
            : [];
    const text = parts
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
    const role =
      typeof info.role === "string"
        ? info.role
        : typeof entry.role === "string"
          ? entry.role
          : info.type === "user"
            ? "user"
            : info.type === "assistant"
              ? "assistant"
              : undefined;
    const id =
      typeof info.id === "string"
        ? info.id
        : typeof entry.id === "string"
          ? entry.id
          : undefined;
    if (text.length > 0) {
      messages.push({
        id,
        role,
        type: role,
        text,
        parts: parts.filter(isRecord).map((part) => ({
          type: typeof part.type === "string" ? part.type : "text",
          text: typeof part.text === "string" ? part.text : undefined,
        })),
      });
    } else if (typeof entry.text === "string") {
      messages.push({ id, role, type: role, text: entry.text });
    }
  }
  return messages;
}

function eventSessionID(event: OpenCodeEvent): string | undefined {
  if (typeof event.sessionID === "string") return event.sessionID;
  if (isRecord(event.properties) && typeof event.properties.sessionID === "string") {
    return event.properties.sessionID;
  }
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
      const model: { providerID?: string; id?: string } = {};
      if (typeof value.rewrite.model.providerID === "string") {
        model.providerID = value.rewrite.model.providerID;
      }
      if (typeof value.rewrite.model.id === "string") model.id = value.rewrite.model.id;
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

export { newId };
