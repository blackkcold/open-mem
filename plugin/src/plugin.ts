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
  ExtractPendingWork,
  ReviewCandidate,
  ReviewEvidence,
  RewriteConfig,
  Scope,
  SessionMessage,
  SkillInput,
  Suggestion,
} from "./types.js";
import { mergeConfig, type ConfigPatch } from "./config.js";
import {
  Store,
  newId,
  EXTRACT_PENDING_MAX_BYTES,
  EXTRACT_PENDING_MAX_ROWS,
  EXTRACT_PENDING_TTL_MS,
} from "./store.js";
import { recordChange } from "./changes.js";
import { createDecisionProvider, resolveOllamaKey } from "./decision.js";
import { runConsolidation } from "./consolidate.js";
import { SessionReader } from "./session/reader.js";
import {
  classifySessionDirectories,
  readNativeSessionIdentity,
  type NativeSessionIdentity,
  type OwnerLocation,
} from "./session/provenance.js";
import { runAudit } from "./audit.js";
import { applyQueueDecision } from "./actions.js";
import { createSkillDraft } from "./skill.js";
import { startServer, type ServerHandle } from "./server.js";
import { sortQueue } from "./priority.js";
import { createRewriteService } from "./rewrite/index.js";
import { buildSuggestion } from "./suggestion.js";
import { maybeCompact } from "./compact.js";
import { pruneManagedHistory } from "./retention.js";
import { collectNeighbors, entriesFor } from "./fingerprint.js";
import { sha16 } from "./util/text.js";
import { sameScopeAndProject } from "./memory/scope.js";
import { runCurator } from "./memory/curator.js";
import { resolveRepoIdentity, runLifecycleMaintenance } from "./memory/lifecycle.js";
import { DigestCache } from "./digest/cache.js";
import {
  collectReviewKnownTitles,
  ReviewInputBuilder,
} from "./review/input.js";
import { ReviewOrchestrator, type NativeOwnershipStatus } from "./review/orchestrator.js";
import { ReviewProvider } from "./review/provider.js";
import { acceptReviewCandidates } from "./review/accept.js";
import { validateReviewCandidates } from "./review/validate.js";
import { ExtractProvider, ExtractRequestError } from "./extract/provider.js";
import { captureExtractEvidence, runExtractCreate, type ToolEvidenceKey } from "./extract/create.js";
import {
  attachRecallBlock,
  recallMemory,
  rewriteManagedPrefix,
  stripRecallBlock,
  type RecallParentState,
  type RecallSystemPart,
} from "./recall.js";

const EXTRACT_DISPATCH_LIMIT = 3;
const EXTRACT_RETRY_DELAY_MS = 30_000;
const EXTRACT_MAX_TIMER_DELAY = 2_147_483_647;

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
  system?: Array<{ type: string; text: string; metadata?: Record<string, unknown> }>;
  messages?: ReadonlyArray<unknown>;
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
      model: { providerID: string; id: string; variant?: string };
      prompt: string;
    }, options?: { signal?: AbortSignal }) => Promise<unknown>;
  };
  experimental?: {
    generate?: {
      decisions?: (input: unknown) => Promise<unknown>;
      text?: (input: {
        model: { providerID: string; id: string; variant?: string };
        prompt: string;
      }, options?: { signal?: AbortSignal }) => Promise<unknown>;
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
  const providers: Record<string, { failures: number; cached: number; openUntil?: number }> = {};
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
    if (stats.providers && typeof stats.providers === "object") {
      const source = stats.providers as Record<string, unknown>;
      for (const purpose of ["review", "extract"] as const) {
        const provider = source[purpose];
        if (!provider || typeof provider !== "object") continue;
        const value = provider as Record<string, unknown>;
        const current = providers[purpose] ?? { failures: 0, cached: 0 };
        const candidateOpenUntil = typeof value.openUntil === "number" ? value.openUntil : undefined;
        providers[purpose] = {
          failures: Math.max(current.failures, Number(value.failures ?? 0)),
          cached: Math.max(current.cached, Number(value.cached ?? 0)),
          ...(candidateOpenUntil !== undefined || current.openUntil !== undefined
            ? { openUntil: Math.max(candidateOpenUntil ?? 0, current.openUntil ?? 0) }
            : {}),
        };
      }
    }
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
    providers,
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
  const automationOff = () => config.automation.mode === "off";
  const extractAvailable = () => config.automation.enabled === true && !automationOff();
  const extractShadow = () => config.automation.mode === "shadow" ||
    (config.automation.mode === undefined && config.shadow === true);
  const token = config.token ?? (await store.ensureToken());

  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  const runMaintenanceTick = async (reason: "startup" | "interval" | "capacity") => {
    const claim = await store.claim("maintenance:tick", 14 * 60_000);
    if (!claim) return;
    try {
      // Approved-policy reclaim only: expired/duplicate auto items through the
      // curator's 24h gate + claim, lifecycle TTL, configured shadow/hook caps,
      // then bounded derived history. Failures are logged, never fatal.
      await runCurator(store, config).catch((error: unknown) => {
        console.error("[memory-autopilot] maintenance curator failed", safeError(error));
      });
      await runLifecycleMaintenance(store, (input) => recordChange(store, input)).catch((error: unknown) => {
        console.error("[memory-autopilot] lifecycle maintenance failed", safeError(error));
      });
      await store.pruneShadow(config.caps.shadow).catch(() => undefined);
      await store.pruneHooks(config.caps.hooks).catch(() => undefined);
      await store.pruneReviews(config.caps.reviews).catch(() => undefined);
      const pending = await store.maintainExtractPending();
      if (reason !== "capacity" && !automationOff()) {
        await recoverExtractPending();
      }
      const retention = await pruneManagedHistory(store, Date.now()).catch((error: unknown) => {
        console.error("[memory-autopilot] history retention failed", safeError(error));
        return undefined;
      });
      await store.updateAutomationState({ lastMaintenanceAt: new Date().toISOString() });
      if (reason === "capacity" && pending.capacityBlocked) {
        console.error("[memory-autopilot] extract pending capacity remains blocked");
      }
      if (retention?.blocked) {
        console.error("[memory-autopilot] history retention blocked", retention.blockedReasons.join(","));
      }
    } finally {
      await store.releaseReservation("maintenance:tick", claim).catch(() => undefined);
    }
  };
  let maintenanceJob: Promise<void> = Promise.resolve();
  const queueMaintenanceTick = (reason: "startup" | "interval" | "capacity"): Promise<void> => {
    const job = maintenanceJob.then(() => runMaintenanceTick(reason));
    maintenanceJob = job.catch((error: unknown) => {
      console.error(`[memory-autopilot] ${reason} maintenance failed`, safeError(error));
    });
    return maintenanceJob;
  };

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
  const generateText = ctx.experimental?.generate?.text ?? ctx.generate?.text;
  const reviewGenerate = generateText
    ? async (
        input: { model: { providerID: string; id: string; variant?: string }; prompt: string },
        options?: { signal?: AbortSignal },
      ) => (await generateText(input, options)) as { text: string }
    : undefined;
  const extractProvider = new ExtractProvider({
    store,
    config,
    key: keyInfo.key,
    ...(reviewGenerate ? { generate: reviewGenerate } : {}),
    log: (message, error) =>
      console.error(`[memory-autopilot] ${message}`, safeError(error ?? "")),
  });

  const project = ctx.location?.project?.canonical ?? ctx.location?.directory;
  const projectKey = project ? sha16(project) : undefined;
  const repoIdentity = resolveRepoIdentity(project);
  const ownerLocation: OwnerLocation = {
    directory: ctx.location?.directory,
    canonical: ctx.location?.project?.canonical,
  };
  /**
   * Host session info is the only proof of ownership. A failed read, a missing
   * location, or an id mismatch returns undefined/null and the caller fails
   * closed without consuming the event.
   */
  const readHostSession = async (
    sessionID: string,
  ): Promise<NativeSessionIdentity | null | undefined> => {
    if (!ctx.session?.get) return undefined;
    try {
      const identity = readNativeSessionIdentity(await ctx.session.get({ sessionID }));
      if (!identity) return undefined;
      if (identity.id !== undefined && identity.id !== sessionID) return null;
      return identity;
    } catch {
      return undefined;
    }
  };
  interface FreshOwnership {
    status: NativeOwnershipStatus;
    identity?: NativeSessionIdentity;
    sessionDirectory?: string;
    hostRead: boolean;
  }
  /**
   * Fresh native evidence wins over the cached directory. An id-matched host
   * read replaces the cache when owned; stored location is never unioned into
   * ownership, so a stale foreign cache cannot block the real owner.
   */
  const resolveFreshOwnership = async (
    sessionID: string,
    fresh?: NativeSessionIdentity,
    requireHost = false,
  ): Promise<FreshOwnership> => {
    if (fresh?.id !== undefined && fresh.id !== sessionID) {
      return { status: "mismatch", hostRead: false };
    }
    const freshDirectories = fresh?.directories ?? [];
    const freshState = classifySessionDirectories(freshDirectories, ownerLocation);
    if (freshState === "foreign") return { status: "foreign", hostRead: false };
    const freshOwned = freshState === "owned";
    if (freshOwned && !requireHost) {
      return {
        status: "owned",
        ...(fresh ? { identity: fresh } : {}),
        sessionDirectory: freshDirectories[0],
        hostRead: false,
      };
    }

    const host = await readHostSession(sessionID);
    if (host === null) return { status: "mismatch", hostRead: false };
    if (host && host.id !== undefined && host.directories.length > 0) {
      const hostState = classifySessionDirectories(host.directories, ownerLocation);
      if (hostState === "foreign") return { status: "foreign", hostRead: true };
      if (hostState === "owned") {
        return {
          status: "owned",
          identity: mergeNativeIdentities([fresh, host]),
          sessionDirectory: host.directories[0],
          hostRead: true,
        };
      }
    }

    const identity = mergeNativeIdentities([fresh, host]);
    if (freshOwned) {
      return {
        status: "unavailable",
        ...(identity ? { identity } : {}),
        sessionDirectory: freshDirectories[0],
        hostRead: false,
      };
    }
    return {
      status: "unavailable",
      ...(identity ? { identity } : {}),
      hostRead: false,
    };
  };
  const nativeOwnershipStatus = async (sessionID: string): Promise<NativeOwnershipStatus> => {
    const ownership = await resolveFreshOwnership(sessionID, undefined, true);
    if (ownership.status === "owned") {
      if (ownership.sessionDirectory) {
        await store
          .updateSession(sessionID, { sessionDirectory: ownership.sessionDirectory })
          .catch(() => undefined);
      }
      return "owned";
    }
    if (ownership.status === "unavailable") {
      // A failed host read cannot launder a stored foreign directory into a
      // legacy manual fallback. Only missing/owned cache may stay unavailable.
      let session: { sessionDirectory?: string } | undefined;
      try {
        session = await store.readSession(sessionID);
      } catch {
        // A store read failure is not proof of a legal missing legacy cache.
        // Reuse the existing rejection status so manual/auto both fail closed.
        return "mismatch";
      }
      if (
        session?.sessionDirectory &&
        classifySessionDirectories([session.sessionDirectory], ownerLocation) === "foreign"
      ) {
        return "foreign";
      }
    }
    return ownership.status;
  };
  type ExtractRunOptions = {
    excludeEvidence?: ReviewEvidence[];
    includeFailedTools?: boolean;
    toolEvidence?: ToolEvidenceKey[];
  };
  const extractRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const clearExtractRetry = (sessionID: string) => {
    const timer = extractRetryTimers.get(sessionID);
    if (timer) clearTimeout(timer);
    extractRetryTimers.delete(sessionID);
  };
  const extractConfigHash = () => sha16(JSON.stringify({
    enabled: config.automation.enabled,
    shadow: config.shadow,
    transport: config.review.transport ?? "ollama",
    model: config.review.model,
    endpoint: config.rewrite.endpoint,
    maxRequestsPerHour: config.review.maxRequestsPerHour,
    maxInputChars: config.review.maxInputChars,
  }));
  const ownsExtractRoot = async (candidateSessionID: string): Promise<boolean> => {
    const ownership = await resolveFreshOwnership(candidateSessionID, undefined, true);
    if (ownership.status !== "owned" || !ownership.hostRead || ownership.identity?.parentID) {
      return false;
    }
    try {
      const session = await store.readSession(candidateSessionID);
      return !session?.parentSessionID;
    } catch {
      return false;
    }
  };
  let scheduleExtractRetry: (sessionID: string, dueAt: number) => void = () => undefined;
  const executeExtractCreate = async (
    sessionID: string,
    origin: "turn" | "session-review",
    options: ExtractRunOptions = {},
  ) => {
    const current = await store.readSession(sessionID).catch(() => undefined);
    const currentPending = current?.extractPending;
    const currentPendingAt = currentPending
      ? Date.parse(currentPending.createdAt ?? currentPending.updatedAt)
      : Number.NaN;
    const old = currentPending && Number.isFinite(currentPendingAt) &&
      Date.now() - currentPendingAt < EXTRACT_PENDING_TTL_MS
      ? currentPending
      : undefined;
    const sameJob = old?.origin === origin && old.projectKey === projectKey;
    const configHash = extractConfigHash();
    const sameConfig = old?.configHash === configHash;
    const storedConfig = await store.readConfig().catch(() => undefined);
    const configReady = extractAvailable() &&
      storedConfig?.automation?.enabled === true &&
      storedConfig.automation.mode !== "off";
    const ownerReady = configReady && await ownsExtractRoot(sessionID);
    if (!configReady || !ownerReady) {
      const reason: ExtractPendingWork["reason"] = configReady ? "owner" : "configuration";
      const attempts = sameJob && sameConfig ? old?.attempts ?? 0 : 0;
      const saved = await store.setExtractPending(sessionID, {
        origin,
        createdAt: old?.createdAt ?? old?.updatedAt ?? new Date().toISOString(),
        ...(projectKey ? { projectKey } : {}),
        ...(sameJob && old?.windowHash ? { windowHash: old.windowHash } : {}),
        configHash,
        reason,
        ...(sameJob && sameConfig && old?.dispatches !== undefined
          ? { dispatches: old.dispatches }
          : {}),
        attempts,
        updatedAt: new Date().toISOString(),
      });
      if (!saved) {
        void queueMaintenanceTick("capacity");
        if (origin === "session-review") {
          throw new ExtractRequestError("extract pending capacity is full", "budget", {
            requestsMade: 0,
            waitForSignal: true,
          });
        }
        return { created: 0, skipped: 0, deferred: true as const, reason: "capacity" };
      }
      if (origin === "session-review") {
        throw new ExtractRequestError(`extract deferred: ${reason}`, "config", {
          requestsMade: 0,
          waitForSignal: true,
        });
      }
      return { created: 0, skipped: 0, deferred: true as const, reason };
    }

    let attempts = sameJob && sameConfig ? old?.attempts ?? 0 : 0;
    let pending: ExtractPendingWork = {
      origin,
      createdAt: old?.createdAt ?? old?.updatedAt ?? new Date().toISOString(),
      ...(projectKey ? { projectKey } : {}),
      ...(sameJob && old?.windowHash ? { windowHash: old.windowHash } : {}),
      configHash,
      reason: "in-flight",
      ...(sameJob && sameConfig && old?.dispatches !== undefined
        ? { dispatches: old.dispatches }
        : {}),
      attempts,
      updatedAt: new Date().toISOString(),
    };
    if (!await store.setExtractPending(sessionID, pending)) {
      if (pending.windowHash && await store.isExpiredExtractWindow(sessionID, pending.windowHash)) {
        clearExtractRetry(sessionID);
        return { created: 0, skipped: 0, deferred: true as const, reason: "expired-window" };
      }
      void queueMaintenanceTick("capacity");
      if (origin === "session-review") {
        throw new ExtractRequestError("extract pending capacity is full", "budget", {
          requestsMade: 0,
          waitForSignal: true,
        });
      }
      return { created: 0, skipped: 0, deferred: true as const, reason: "capacity" };
    }

    let result: Awaited<ReturnType<typeof runExtractCreate>>;
    let capture: Awaited<ReturnType<typeof captureExtractEvidence>> | undefined;
    try {
      capture = await captureExtractEvidence(sessionID, reader, options.excludeEvidence, {
        ...(options.includeFailedTools ? { includeFailedTools: true } : {}),
        ...(options.toolEvidence ? { toolEvidence: options.toolEvidence } : {}),
        digestMaxChars: config.digest.maxChars,
        learningMaxChars: config.thresholds.memoryMaxChars,
      });
      const windowHash = capture.evidence.materialHash;
      const sameWindow = old?.windowHash === windowHash;
      const materialChanged = sameJob && old?.windowHash !== undefined && !sameWindow;
      const persistedConfigChanged = Boolean(old && !sameConfig);
      if (materialChanged || persistedConfigChanged) {
        extractProvider.resetCircuit();
      }
      attempts = sameJob && sameWindow && sameConfig ? old?.attempts ?? 0 : 0;
      pending = {
        ...pending,
        windowHash,
        attempts,
        dispatches: sameJob && sameWindow && sameConfig ? old?.dispatches : undefined,
        updatedAt: new Date().toISOString(),
      };
      if (sameJob && sameWindow && sameConfig &&
          (pending.dispatches ?? 0) >= EXTRACT_DISPATCH_LIMIT) {
        clearExtractRetry(sessionID);
        await store.setExtractPending(sessionID, {
          ...pending,
          reason: "transport",
          retryAt: undefined,
          dueAt: undefined,
          updatedAt: new Date().toISOString(),
        });
        const waiting = new ExtractRequestError(
          "extract dispatch limit reached; waiting for new material or configuration",
          "config",
          { requestsMade: 0, waitForSignal: true },
        );
        if (origin === "session-review") throw waiting;
        return { created: 0, skipped: 0, deferred: true as const, reason: "transport" };
      }
      if (!await store.setExtractPending(sessionID, pending)) {
        if (pending.windowHash && await store.isExpiredExtractWindow(sessionID, pending.windowHash)) {
          clearExtractRetry(sessionID);
          return { created: 0, skipped: 0, deferred: true as const, reason: "expired-window" };
        }
        void queueMaintenanceTick("capacity");
        return { created: 0, skipped: 0, deferred: true as const, reason: "capacity" };
      }
      await store.updateAutomationState({ lastExtractAt: new Date().toISOString() });
      result = await runExtractCreate(sessionID, origin, {
        store,
        config,
        reader,
        provider: extractProvider,
        project,
        projectKey,
        repoIdentity,
        capture,
        ...(options.excludeEvidence ? { excludeEvidence: options.excludeEvidence } : {}),
        ...(options.includeFailedTools ? { includeFailedTools: true } : {}),
        ...(options.toolEvidence ? { toolEvidence: options.toolEvidence } : {}),
        // Extract has a stricter root-only gate than the legacy manual lane. It
        // uses fresh native ownership, never the stored project-key hint.
        ownsNativeRoot: ownsExtractRoot,
        log: (message, error) =>
          console.error(`[memory-autopilot] ${message}`, safeError(error ?? "")),
      });
    } catch (error: unknown) {
      const now = Date.now();
      const normalized = error instanceof ExtractRequestError
        ? error
        : new ExtractRequestError(
            error instanceof Error ? error.message : "extract failed",
            "transport",
            { requestsMade: 0, retryAt: now + EXTRACT_RETRY_DELAY_MS },
          );
      const requestsMade = normalized.requestsMade ?? 0;
      const waitingResponse = normalized.waitForSignal === true ||
        normalized.kind === "budget" || normalized.kind === "retry-after" ||
        normalized.kind === "circuit" || normalized.kind === "config";
      const dispatches = (pending.dispatches ?? 0) + (Number.isFinite(requestsMade)
        ? Math.max(0, Math.floor(requestsMade))
        : 0);
      const dispatchedFailures = !waitingResponse && Number.isFinite(requestsMade)
        ? Math.max(0, Math.floor(requestsMade))
        : 0;
      const nextAttempts = Math.min(EXTRACT_DISPATCH_LIMIT, attempts + dispatchedFailures);
      const capped = dispatches >= EXTRACT_DISPATCH_LIMIT;
      const waitForSignal = waitingResponse || capped;
      const retryCandidate = normalized.retryAt ??
        (normalized.kind === "transport" || normalized.kind === "format"
          ? now + EXTRACT_RETRY_DELAY_MS
          : undefined);
      const retryAt = retryCandidate !== undefined && Number.isFinite(retryCandidate)
        ? retryCandidate
        : undefined;
      const dueAt = waitForSignal ? undefined : retryAt;
      const persistedRetryAt = automationOff() || capped ? undefined : retryAt;
      const scheduledAt = capped ? undefined : dueAt ?? persistedRetryAt;
      const reason: ExtractPendingWork["reason"] = normalized.kind === "budget"
        ? "request-budget"
        : normalized.kind === "retry-after"
          ? "retry-after"
          : normalized.kind === "circuit"
            ? "circuit"
            : normalized.kind === "config"
              ? "configuration"
              : "transport";
      if (capped) clearExtractRetry(sessionID);
      await store.setExtractPending(sessionID, {
        ...pending,
        reason: automationOff() ? "configuration" : capped ? "transport" : reason,
        attempts: automationOff() ? attempts : nextAttempts,
        dispatches,
        ...(persistedRetryAt !== undefined
          ? { retryAt: new Date(persistedRetryAt).toISOString() }
          : { retryAt: undefined }),
        ...(automationOff() || dueAt === undefined
          ? { dueAt: undefined }
          : { dueAt: new Date(dueAt).toISOString() }),
        updatedAt: new Date().toISOString(),
      });
      if (origin === "turn" && scheduledAt !== undefined && extractAvailable()) {
        scheduleExtractRetry(sessionID, scheduledAt);
      }
      if (origin === "session-review" && waitForSignal) {
        if (persistedRetryAt !== undefined) {
          throw new ExtractRequestError(normalized.message, normalized.kind, {
            requestsMade: 0,
            retryAt: persistedRetryAt,
          });
        }
        throw new ExtractRequestError(normalized.message, "config", {
          requestsMade: 0,
          waitForSignal: true,
        });
      }
      if (origin === "session-review" && normalized.kind === "format" && dueAt !== undefined) {
        throw new ExtractRequestError(normalized.message, "transport", {
          requestsMade: normalized.requestsMade ?? 1,
          retryAt: dueAt,
        });
      }
      throw normalized;
    }

    if (result.deferred) {
      clearExtractRetry(sessionID);
      const reason: ExtractPendingWork["reason"] = result.reason === "unowned"
        ? "owner"
        : result.reason === "capacity"
          ? "capacity"
          : "configuration";
      await store.setExtractPending(sessionID, {
        ...pending,
        reason,
        retryAt: undefined,
        dueAt: undefined,
        updatedAt: new Date().toISOString(),
      });
      if (origin === "session-review") {
        throw new ExtractRequestError(`extract deferred: ${result.reason ?? "state changed"}`, "config", {
          requestsMade: 0,
          waitForSignal: true,
        });
      }
      return result;
    }

    clearExtractRetry(sessionID);
    await store.setExtractPending(sessionID, undefined);
    return result;
  };
  const extractCreate = async (
    sessionID: string,
    origin: "turn" | "session-review",
    options: ExtractRunOptions = {},
  ) => {
    const claimKey = `extract-run:${sessionID}`;
    const token = await store.claim(
      claimKey,
      Math.max(60_000, config.review.timeoutMs * 5),
    );
    if (!token) {
      const retryAt = Date.now() + EXTRACT_RETRY_DELAY_MS;
      if (origin === "turn") {
        const current = await store.readSession(sessionID).catch(() => undefined);
        const existing = current?.extractPending;
        // A live run owns its pending record. Rewriting it from this stale
        // snapshot would reset attempts/dispatches and add a spurious
        // retry-after for work that is still running.
        const inFlight = existing?.reason === "in-flight";
        if (
          !inFlight &&
          (!existing || existing.origin === "turn") &&
          (!existing?.projectKey || existing.projectKey === projectKey)
        ) {
          const saved = await store.setExtractPending(sessionID, {
            origin: "turn",
            createdAt: existing?.createdAt ?? existing?.updatedAt ?? new Date().toISOString(),
            ...(projectKey ? { projectKey } : {}),
            ...(existing?.windowHash ? { windowHash: existing.windowHash } : {}),
            configHash: extractConfigHash(),
            reason: "retry-after",
            attempts: existing?.attempts ?? 0,
            dispatches: existing?.dispatches ?? 0,
            dueAt: new Date(retryAt).toISOString(),
            updatedAt: new Date().toISOString(),
          });
          if (!saved) void queueMaintenanceTick("capacity");
          if (extractAvailable()) scheduleExtractRetry(sessionID, retryAt);
        }
        return {
          created: 0,
          skipped: 0,
          reason: "in-flight",
          deferred: true as const,
          retryAt,
          requestsMade: 0,
        };
      }
      throw new ExtractRequestError("extract session is already in flight", "retry-after", {
        requestsMade: 0,
        retryAt,
      });
    }
    try {
      return await executeExtractCreate(sessionID, origin, options);
    } finally {
      await store.releaseReservation(claimKey, token).catch(() => undefined);
    }
  };
  scheduleExtractRetry = (sessionID, dueAt) => {
    clearExtractRetry(sessionID);
    const timer = setTimeout(() => {
      extractRetryTimers.delete(sessionID);
      void (async () => {
        const current = await store.readSession(sessionID);
        const pending = current?.extractPending;
        if (!pending || pending.origin !== "turn" || pending.projectKey !== projectKey) return;
        const createdAt = Date.parse(pending.createdAt ?? pending.updatedAt);
        if (!Number.isFinite(createdAt) || Date.now() - createdAt >= EXTRACT_PENDING_TTL_MS) {
          await store.setExtractPending(sessionID, undefined);
          return;
        }
        const pendingRetryAt = pending.retryAt ?? pending.dueAt;
        const pendingRetryMs = pendingRetryAt ? Date.parse(pendingRetryAt) : Number.NaN;
        if (Number.isFinite(pendingRetryMs) && pendingRetryMs > Date.now()) {
          scheduleExtractRetry(sessionID, pendingRetryMs);
          return;
        }
        if (!extractAvailable()) {
          await store.setExtractPending(sessionID, {
            ...pending,
            reason: "configuration",
            retryAt: undefined,
            dueAt: undefined,
            updatedAt: new Date().toISOString(),
          });
          return;
        }
        if (await nativeOwnershipStatus(sessionID) !== "owned") {
          await store.setExtractPending(sessionID, {
            ...pending,
            reason: "owner",
            retryAt: undefined,
            dueAt: undefined,
            updatedAt: new Date().toISOString(),
          });
          return;
        }
        await extractCreate(sessionID, "turn");
      })().catch((error: unknown) => {
        console.error("[memory-autopilot] extract retry failed", safeError(error));
      });
    }, Math.min(EXTRACT_MAX_TIMER_DELAY, Math.max(0, dueAt - Date.now())));
    extractRetryTimers.set(sessionID, timer);
  };
  const recoverExtractPending = async (onlySessionID?: string): Promise<boolean> => {
    const state = await store.readState();
    const sessions = onlySessionID
      ? [[onlySessionID, state.sessions[onlySessionID]] as const]
      : Object.entries(state.sessions);
    let handled = false;
    for (const [sessionID, session] of sessions) {
      const pending = session?.extractPending;
      if (!pending || pending.origin !== "turn" || pending.projectKey !== projectKey) continue;
      const createdAt = Date.parse(pending.createdAt ?? pending.updatedAt);
      if (!Number.isFinite(createdAt) || Date.now() - createdAt >= EXTRACT_PENDING_TTL_MS) continue;
      handled = true;

      if (!extractAvailable()) {
        clearExtractRetry(sessionID);
        if (pending.reason !== "configuration" || pending.retryAt !== undefined || pending.dueAt !== undefined) {
          await store.setExtractPending(sessionID, {
            ...pending,
            reason: "configuration",
            retryAt: undefined,
            dueAt: undefined,
            updatedAt: new Date().toISOString(),
          });
        }
        continue;
      }

      const configChanged = pending.configHash !== extractConfigHash();
      const pendingRetryAt = pending.retryAt ?? pending.dueAt;
      const retryAt = pendingRetryAt ? Date.parse(pendingRetryAt) : Number.NaN;
      if (!configChanged && Number.isFinite(retryAt) && retryAt > Date.now()) {
        scheduleExtractRetry(sessionID, retryAt);
        continue;
      }

      if (await nativeOwnershipStatus(sessionID) !== "owned") {
        clearExtractRetry(sessionID);
        await store.setExtractPending(sessionID, {
          ...pending,
          reason: "owner",
          retryAt: undefined,
          dueAt: undefined,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }
      await extractCreate(sessionID, "turn");
    }
    return handled;
  };

  void queueMaintenanceTick("startup");
  maintenanceTimer = setInterval(() => {
    void queueMaintenanceTick("interval");
  }, 15 * 60_000);
  maintenanceTimer.unref?.();

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
        projectKey,
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
  const consolidate = (
    sessionID: string,
    label: string,
    options: { allowLegacyManual?: boolean } = {},
  ): Promise<void> => {
    consolidationChain = consolidationChain
      .then(async () => {
        if (automationOff() && !options.allowLegacyManual) return;
        // Defense in depth: every consolidation path revalidates fresh native
        // ownership. Only an explicitly authorized manual review may fall back
        // to its existing context-key guard when the host read is unavailable.
        const session = await store.readSession(sessionID).catch(() => undefined);
        const ownership = await nativeOwnershipStatus(sessionID);
        if (ownership !== "owned") {
          if (ownership !== "unavailable") return;
          if (
            !options.allowLegacyManual ||
            projectKey === undefined ||
            session?.contextProjectKey !== projectKey
          ) {
            return;
          }
        }
        const sessionPending = session?.extractPending;
        if (
          sessionPending &&
          sessionPending.projectKey === projectKey &&
          !options.allowLegacyManual
        ) {
          await recoverExtractPending(sessionID);
          return;
        }
        if (config.automation.enabled && !options.allowLegacyManual) {
          await extractCreate(sessionID, "turn");
        } else {
          await runConsolidation(
            sessionID,
            options.allowLegacyManual ? { ...deps, allowLegacyManual: true } : deps,
          );
        }
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
    ...(reviewGenerate ? { generate: reviewGenerate } : {}),
    log: (message, error) =>
      console.error(`[memory-autopilot] ${message}`, safeError(error ?? "")),
  });
  const logReview = (message: string, error?: unknown) =>
    console.error(`[memory-autopilot] ${message}`, error === undefined ? "" : safeError(error));
  const reviewOrchestrator = new ReviewOrchestrator({
    store,
    config,
    reader,
    projectKey,
    ownsNative: nativeOwnershipStatus,
    canResumeExtractPending: async (sessionID, session) => {
      const pending = session.extractPending;
      if (!pending || pending.origin !== "session-review") return true;
      return pending.projectKey === projectKey &&
        config.automation.enabled &&
        config.automation.mode !== "off" &&
        await nativeOwnershipStatus(sessionID) === "owned";
    },
    buildInput: (sessionID, messages, from, knownTitles) =>
      reviewBuilder.build(sessionID, messages, from, knownTitles),
    knownTitles: () => collectReviewKnownTitles(store, 30, projectKey),
    runModel: (input) => reviewProvider.review(input),
      validate: (input, candidates) => validateReviewCandidates(candidates, input, config),
      onAccepted: async (input, result, reviewID, authoritativeProjectKey, reason) => {
      if (reason === "auto" && config.automation.enabled) {
        const protectedCandidates = result.candidates.filter(
          (candidate) => candidate.type === "rule" || candidate.type === "skill",
        );
        const protectedEvidence = protectedCandidates.flatMap((candidate) => candidate.evidence);
        // Ordinary review candidates continue through the same extract
        // admission from full user text. Failing tool digests actually shown to
        // the review model are re-read and hash-checked before learning; they
        // never become a user preference or a global claim.
        const toolEvidence = Object.entries(input.sources).flatMap(([messageID, source]) =>
          source.tools
            .filter((tool) => !tool.ok && typeof tool.digestHash === "string")
            .map((tool) => ({ messageID, digestHash: tool.digestHash })),
        );
        const learned = await extractCreate(input.sessionID, "session-review", {
          excludeEvidence: protectedEvidence,
          ...(toolEvidence.length > 0
            ? { includeFailedTools: true, toolEvidence }
            : {}),
        });
        await digestCache.flush();
        if (config.automation.mode === "shadow") {
          return {
            created: 0,
            skipped: 0,
            learned: 0,
            updated: 0,
            shadowed: learned.shadowed ?? 0,
            learningSkipped: learned.learningSkipped ?? 0,
            protectedCandidates: protectedCandidates.length,
            ...(learned.deferred && learned.reason
              ? { learningDeferred: learned.reason }
              : {}),
          };
        }
        const protectedAccepted = await acceptReviewCandidates(
          input,
          { ...result, candidates: protectedCandidates },
          reviewID,
          {
            store,
            config,
            project: deps.project,
            ...(authoritativeProjectKey !== undefined
              ? { projectKey: authoritativeProjectKey }
              : {}),
            instanceProjectKey: deps.projectKey,
          },
        );
        // Ordinary review learning is counted separately from protected
        // hook/queue outcomes; it is never reported as skipped or pending.
        return {
          created: protectedAccepted.created,
          skipped: protectedAccepted.skipped,
          learned: learned.created,
          updated: learned.updated ?? 0,
          shadowed: learned.shadowed ?? 0,
          learningSkipped: learned.learningSkipped ?? 0,
          protectedCandidates: protectedCandidates.length,
          sessionNotes: protectedAccepted.sessionNotes,
          ...(learned.deferred && learned.reason
            ? { learningDeferred: learned.reason }
            : {}),
        };
      }
      const accepted = await acceptReviewCandidates(input, result, reviewID, {
        store,
        config,
        project: deps.project,
        ...(authoritativeProjectKey !== undefined
          ? { projectKey: authoritativeProjectKey }
          : {}),
        instanceProjectKey: deps.projectKey,
      });
      await digestCache.flush();
      if (result.candidates.length > 0) {
        await consolidate(input.sessionID, "review consolidation", {
          allowLegacyManual: reason === "manual",
        });
      }
      return accepted;
    },
    broadcast: server?.broadcast,
    log: logReview,
  });

  reviewRuntime.stats = () => ({
    ...reviewProvider.stats(),
    ...reviewOrchestrator.stats(),
    providers: {
      review: reviewProvider.stats(),
      extract: extractProvider.stats(),
    },
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
    config.automation = { ...next.automation };
    if (!config.review.enabled) reviewOrchestrator.pause();
    else {
      reviewOrchestrator.resume();
      if (automationOff()) reviewOrchestrator.pauseAutomatic();
    }
    void recoverExtractPending().catch((error: unknown) => {
      console.error("[memory-autopilot] extract recovery failed", safeError(error));
    });
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
          // Identify the session before claiming the event. A known foreign
          // session must not consume the shared event id, or its real owner
          // could never process it.
          const sessionID = eventSessionID(event);
          if (!sessionID) continue;
          backoff = 250;
          const created = event.type === "session.created";
          const turnFinished =
            event.type === "session.idle" ||
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.interrupted";

          // Only native host fields may prove ownership. `contextProjectKey`
          // and old review records remain hints: they can make us more
          // cautious, never claim a session for this project.
          const eventIdentities = [
            event.location
              ? readNativeSessionIdentity({ location: event.location })
              : undefined,
            readNativeSessionIdentity(event.data),
            readNativeSessionIdentity(event.properties),
          ].filter((identity): identity is NativeSessionIdentity => identity !== undefined);
          if (eventIdentities.some((identity) =>
            identity.id !== undefined && identity.id !== sessionID
          )) {
            continue;
          }
          const eventIdentity = mergeNativeIdentities(eventIdentities);
          const knownSession = await store.readSession(sessionID).catch(() => undefined);
          // Fresh event/host identity only; the cached sessionDirectory is not
          // unioned into ownership, so a stale foreign cache cannot block the
          // real owner. Turns/context always need a current host read.
          const ownership = await resolveFreshOwnership(
            sessionID,
            eventIdentity,
            !created,
          );
          if (ownership.status === "foreign" || ownership.status === "mismatch") {
            continue;
          }
          const identity = ownership.identity ?? eventIdentity;
          const parentKnown =
            identity?.parentKnown === true ||
            ownership.hostRead ||
            knownSession?.parentChecked === true ||
            knownSession?.parentSessionID !== undefined;
          const parentSessionID = identity?.parentID ?? knownSession?.parentSessionID;
          const agent = identity?.agent ?? knownSession?.agent;
          if (ownership.status === "owned" || (parentKnown && parentSessionID)) {
            await store
              .updateSession(sessionID, {
                ...(ownership.sessionDirectory
                  ? { sessionDirectory: ownership.sessionDirectory }
                  : {}),
                ...(parentSessionID ? { parentSessionID } : {}),
                ...(agent ? { agent } : {}),
                ...(parentKnown ? { parentChecked: true } : {}),
              })
              .catch((error: unknown) => {
                console.error(
                  "[memory-autopilot] session meta failed",
                  safeError(error),
                );
              });
          }
          if (ownership.status !== "owned") continue;
          if (!created) {
            // Subagents are never user memory sources. A session.created that
            // omitted its parent is not root proof; the fresh host read above
            // must prove the current root before learning from an old session.
            if (!parentKnown || parentSessionID) continue;
          }
          // Several plugin instances can share one data dir (workspaces, hot
          // reload). Process each event exactly once across them, but only
          // after native ownership and parent proof have passed.
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

          let recoveredExtract = false;
          if (parentKnown && !parentSessionID) {
            recoveredExtract = await recoverExtractPending(sessionID).catch((error: unknown) => {
              console.error("[memory-autopilot] extract owner recovery failed", safeError(error));
              return false;
            });
          }

          if (created) {
            await refreshContext(ctx, store, config, sessionID, projectKey).catch((error: unknown) => {
              console.error("[memory-autopilot] context refresh failed", safeError(error));
            });
          }
          if (turnFinished) {
            if (!recoveredExtract) await consolidate(sessionID, "consolidation");
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
      try {
        // Clear only this plugin's dynamic block before any query that can
        // fail. A failed ownership/refresh/build must not leave last request's
        // dynamic content in this request.
        if (Array.isArray(event.system)) stripRecallBlock(event.system);
        // Never inject or pin this project's memory into a session whose
        // fresh native location is foreign or unproven. The host hook has no
        // envelope location, so every request re-reads session.get; the cached
        // directory is not proof after a move.
        const ownership = event.sessionID
          ? await resolveFreshOwnership(event.sessionID, undefined, true)
          : undefined;
        if (event.sessionID && (!ownership || ownership.status !== "owned")) {
          // Early exit still strips only this plugin's own stale content. No
          // build and no entry.put; host and user text stay untouched.
          if (Array.isArray(event.system)) {
            const stripped = applyOwnedContextDetailed(event.system, "").parts;
            event.system.splice(0, event.system.length, ...stripped);
          }
          return;
        }
        if (event.sessionID && ownership?.sessionDirectory) {
          await store
            .updateSession(event.sessionID, { sessionDirectory: ownership.sessionDirectory })
            .catch(() => undefined);
        }
        // Fixed order per request: refresh the pinned prefix, replace the
        // previous owned prefix inside this request's system, then append one
        // independent dynamic recall block. `entry.put` only persists for later
        // requests, so the current request must be rewritten here even before
        // the recall switch is consulted.
        const sessionID = event.sessionID;
        const before = sessionID
          ? await store.readSession(sessionID).catch(() => undefined)
          : undefined;
        let refreshFailed = false;
        if (sessionID) {
          await refreshContext(ctx, store, config, sessionID, projectKey).catch((error: unknown) => {
            refreshFailed = true;
            console.error(
              `[memory-autopilot] context refresh failed (${contextErrorCategory(error)})`,
            );
          });
        }
        let block: AutopilotContext | undefined;
        if (sessionID && !refreshFailed) {
          const after = await store.readSession(sessionID).catch(() => undefined);
          if (after?.contextBlock && after.contextProjectKey === projectKey) {
            block = after.contextBlock;
          }
        }
        block ??= await buildContext(store, config, projectKey).catch((error: unknown) => {
          console.error(
            `[memory-autopilot] context build failed (${contextErrorCategory(error)})`,
          );
          return undefined;
        });
        if (Array.isArray(event.system) && block) {
          const freshText = renderContext(block);
          const knownTexts: string[] = [];
          if (before?.contextBlock && before.contextProjectKey === projectKey) {
            knownTexts.push(renderContext(before.contextBlock));
          }
          knownTexts.push(freshText);
          const rewritten = rewriteManagedPrefix({
            system: event.system,
            freshText,
            revokedTexts: revokedContextTexts(
              before?.contextBlock,
              before?.contextProjectKey,
              block,
              projectKey,
            ),
            knownTexts,
          });
          event.system.splice(0, event.system.length, ...rewritten.parts);
          if (rewritten.ambiguous.length > 0 && sessionID) {
            // Degraded path: a legacy unrecorded block boundary could not be
            // proven, so the part was left untouched. One bounded line.
            await logContextAmbiguous(store, sessionID, rewritten.ambiguous);
          }
        }
        if (Array.isArray(event.system) && sessionID && block) {
          await attachRecallBlock(
            {
              sessionID,
              ...(projectKey !== undefined ? { projectKey } : {}),
              messages: event.messages ?? [],
              system: event.system,
              parentState: ownershipParentState(ownership, sessionID),
              excludeTexts: [...(block.autoMemory ?? []), ...(block.autoRules ?? [])],
            },
            { store, config },
          );
        }
      } catch (error: unknown) {
        // Any failure leaves the request running. Log only a category, never
        // query/item text or arbitrary error bodies.
        console.error(
          `[memory-autopilot] context hook failed (${contextErrorCategory(error)})`,
        );
      }
    })
    : undefined;

  const toolsRegistration = ctx.tool
    ? await ctx.tool.transform((editor) => {
        editor.add({
          name: "memory_autopilot",
          description:
            "Review the OpenMem queue, run an audit, decide a pending item, generate a merge suggestion, create a skill draft, or recall relevant local memory (read-only). Use it when the user asks about pending rules, memory quality, skill review, or relevant memory.",
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
                  "recall",
                ],
              },
              id: { type: "string" },
              query: { type: "string" },
              limit: { type: "number" },
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
            // Read-only recall: instance project key only. It never accepts a
            // caller-supplied projectKey and never writes usage/learning state.
            if (request.action === "recall") {
              const sessionID = context.sessionID;
              const [result, allItems] = await Promise.all([
                recallMemory(store, config, request.query ?? "", {
                  ...(projectKey !== undefined ? { projectKey } : {}),
                  limit: request.limit ?? config.recall.apiLimit,
                  tokenBudget: config.recall.apiTokenBudget,
                  now: Date.now(),
                }),
                store.listItems().catch(() => []),
              ]);
              const allowed = new Set(
                allItems
                  .filter((entry) => visible(entry, sessionID))
                  .map((entry) => entry.id),
              );
              const hits = result.hits.filter(
                (hit) => hit.scope !== "session" && allowed.has(hit.id),
              );
              return {
                content: JSON.stringify(
                  {
                    hits,
                    tokens: result.tokens,
                    estimate: true,
                    ...(result.degraded ? { degraded: result.degraded } : {}),
                  },
                  null,
                  2,
                ),
              };
            }
            if (request.action === "status") {
              const sessionID = context.sessionID;
              const [allItems, allQueue, allShadow, allSkills, audit, state] = await Promise.all([
                store.listItems(),
                store.listQueue(),
                store.listShadow(),
                store.listSkillDrafts(),
                store.readAudit(),
                store.readState(),
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
              const now = Date.now();
              const requests = (state.modelRequests?.review ?? []).filter(
                (at) => at >= now - 60 * 60 * 1000,
              );
              const runtime = reviewRuntime.stats?.() ?? {};
              const auditRunAt = audit.auditRunAt ? Date.parse(audit.auditRunAt) : Number.NaN;
              return {
                content: JSON.stringify(
                  {
                    items: items.length,
                    queue: queue.length,
                    shadow: shadow.length,
                    auto: items.filter((item) => item.status === "auto").length,
                    audit: scopedAudit.summary,
                    auditAgeMs: Number.isFinite(auditRunAt) ? Math.max(0, now - auditRunAt) : null,
                    review: {
                      runsLastHour: Number(runtime.runsLastHour ?? 0),
                      requestsLastHour: requests.length,
                      ...(typeof runtime.lastFailureKind === "string"
                        ? {
                            lastFailureKind: runtime.lastFailureKind,
                            lastError: reviewFailureLabel(runtime.lastFailureKind),
                          }
                        : {}),
                      ...(runtime.lastDeferred ? { lastDeferred: runtime.lastDeferred } : {}),
                    },
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
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = undefined;
    await eventJob?.catch(() => undefined);
    await recoveryJob;
    while (true) {
      const pendingMaintenance = maintenanceJob;
      await pendingMaintenance;
      if (pendingMaintenance === maintenanceJob) break;
    }
    for (const timer of extractRetryTimers.values()) clearTimeout(timer);
    extractRetryTimers.clear();
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
  projectKey?: string;
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
    projectKey: options.projectKey,
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

/**
 * Key the host renders as `<context key="plugin.memory-autopilot">` and lists in
 * `metadata.experimental.instructions`. Both are used to find our own block.
 */
export const CONTEXT_KEY = "plugin.memory-autopilot";

const CONTEXT_OPEN = `<context key="${CONTEXT_KEY}">`;
const CONTEXT_CLOSE = "</context>";
/**
 * The V2 host namespaces instruction entries as `api/<key>`. Older local
 * fixtures use the raw key. Both are exact, first-party evidence; no other key
 * is accepted.
 */
const ALT_CONTEXT_KEY = `api/${CONTEXT_KEY}`;
const ALT_CONTEXT_OPEN = `<context key="${ALT_CONTEXT_KEY}">`;
const CONTEXT_OPENS = [CONTEXT_OPEN, ALT_CONTEXT_OPEN];

function isOwnedInstructionKey(value: unknown): boolean {
  return value === CONTEXT_KEY || value === ALT_CONTEXT_KEY;
}

export interface SystemTextPart {
  type: "text";
  text: string;
  metadata?: Record<string, unknown>;
}

function ownedInstructionText(metadata: Record<string, unknown> | undefined): string | undefined {
  const experimental = metadata?.experimental;
  if (!isRecord(experimental)) return undefined;
  const instructions = experimental.instructions;
  if (!Array.isArray(instructions)) return undefined;
  const entry = instructions.find(
    (candidate) => isRecord(candidate) && isOwnedInstructionKey(candidate.key),
  );
  return isRecord(entry) && typeof entry.text === "string" ? entry.text : undefined;
}

function withOwnedInstruction(
  metadata: Record<string, unknown> | undefined,
  text: string,
): Record<string, unknown> {
  const base = metadata ?? {};
  const experimental = isRecord(base.experimental) ? base.experimental : {};
  const instructions = Array.isArray(experimental.instructions)
    ? experimental.instructions
    : [];
  return {
    ...base,
    experimental: {
      ...experimental,
      instructions: instructions.map((candidate) =>
        isRecord(candidate) && isOwnedInstructionKey(candidate.key)
          ? { ...candidate, text }
          : candidate,
      ),
    },
  };
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let index = value.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(needle, index + needle.length);
  }
  return count;
}

/** The whole part is exactly one owned wrapper (nothing else attached). */
function ownedSingleOpen(source: string): string | undefined {
  const text = source.trim();
  for (const open of CONTEXT_OPENS) {
    if (
      text.startsWith(open) &&
      text.endsWith(CONTEXT_CLOSE) &&
      countOccurrences(text, open) === 1 &&
      countOccurrences(text, CONTEXT_CLOSE) === 1 &&
      // Our own OPEN is the only `<context `: a nested or following host block
      // means the single closing tag may not be ours (N4).
      countOccurrences(text, "<context ") === 1
    ) {
      return open;
    }
  }
  return undefined;
}

/**
 * True when everything after our closing tag is made of balanced foreign
 * `<context …>…</context>` blocks (or plain text). An unbalanced close means
 * the candidate close was actually inside our body.
 */
function balancedAfter(source: string): boolean {
  let depth = 0;
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<context ", index);
    const close = source.indexOf(CONTEXT_CLOSE, index);
    if (open === -1 && close === -1) break;
    if (open !== -1 && (close === -1 || open < close)) {
      depth += 1;
      index = open + "<context ".length;
    } else {
      if (depth === 0) return false;
      depth -= 1;
      index = close + CONTEXT_CLOSE.length;
    }
  }
  return depth === 0;
}

/**
 * Boundary for a part that carries our wrapper but no metadata record.
 * Returns `undefined` when the boundary cannot be proven: a literal
 * `<context ` / extra `</context>` inside the body, more than one owned
 * wrapper, or an unbalanced tail. Callers must then leave the part alone
 * instead of guessing (fixing the fix-round-1 host deletion regression).
 */
function replaceUnrecordedBlock(source: string, text: string): string | undefined {
  const single = ownedSingleOpen(source);
  if (single) {
    return text.trim() ? `${single}\n${text}\n${CONTEXT_CLOSE}` : "";
  }
  const ownedOpen = CONTEXT_OPENS.find(
    (candidate) => countOccurrences(source, candidate) === 1,
  );
  if (!ownedOpen) return undefined;
  const open = source.indexOf(ownedOpen);
  if (open === -1) return undefined;
  const close = source.indexOf(CONTEXT_CLOSE, open + ownedOpen.length);
  if (close === -1) return undefined;
  if (source.slice(open + ownedOpen.length, close).includes("<context ")) {
    return undefined;
  }
  if (!balancedAfter(source.slice(close + CONTEXT_CLOSE.length))) return undefined;
  const replacement = text.trim() ? `${ownedOpen}\n${text}\n${CONTEXT_CLOSE}` : "";
  return `${source.slice(0, open)}${replacement}${source.slice(close + CONTEXT_CLOSE.length)}`;
}

/**
 * Precisely replace the block whose body the host recorded in
 * `metadata.experimental.instructions`. The recorded copy is the only reliable
 * boundary when the body itself contains `<context`/`</context>`, because a
 * marker inside the body cannot be told apart from a real block otherwise.
 */
function replaceRecordedBlock(
  part: { text: string },
  recorded: string,
  text: string,
): string | undefined {
  const position = part.text.indexOf(recorded);
  if (position === -1) return undefined;
  const rawOpen = part.text.lastIndexOf(CONTEXT_OPEN, position);
  const altOpen = part.text.lastIndexOf(ALT_CONTEXT_OPEN, position);
  const open = Math.max(rawOpen, altOpen);
  const wrapperOpen = altOpen > rawOpen ? ALT_CONTEXT_OPEN : CONTEXT_OPEN;
  const close = part.text.indexOf(CONTEXT_CLOSE, position + recorded.length);
  if (open !== -1 && close !== -1) {
    const canonical = text.trim() ? `${wrapperOpen}\n${text}\n${CONTEXT_CLOSE}` : "";
    return `${part.text.slice(0, open)}${canonical}${part.text.slice(close + CONTEXT_CLOSE.length)}`;
  }
  return `${part.text.slice(0, position)}${text}${part.text.slice(position + recorded.length)}`;
}

function ownedPart(text: string): SystemTextPart {
  return {
    type: "text",
    text: `${CONTEXT_OPEN}\n${text}\n${CONTEXT_CLOSE}`,
    metadata: { experimental: { instructions: [{ key: CONTEXT_KEY, text }] } },
  };
}

type KnownRenderMatch =
  | { state: "none" }
  | { state: "ambiguous" }
  | { state: "replaced"; text: string };

/**
 * Exact, unique full-render evidence for a markerless own prefix. A heading or
 * a shared fact is never enough; the whole recorded rendering must appear once.
 */
function matchKnownRender(
  source: string,
  text: string,
  knownTexts: ReadonlyArray<string>,
): KnownRenderMatch {
  if (knownTexts.length === 0) return { state: "none" };
  const candidates = [...new Set(knownTexts.filter((value) => value.trim().length >= 8))];
  if (candidates.length === 0) return { state: "none" };
  if (source.includes("<context ")) {
    // A wrapper we cannot attribute is not ours to edit. If a known own
    // rendering is also present, report ambiguity instead of appending.
    return candidates.some((known) => source.includes(known))
      ? { state: "ambiguous" }
      : { state: "none" };
  }
  const matched: string[] = [];
  let ambiguous = false;
  for (const known of candidates) {
    const first = source.indexOf(known);
    if (first === -1) continue;
    if (source.indexOf(known, first + known.length) !== -1) {
      ambiguous = true;
      continue;
    }
    // Only a whole part or an edge-aligned own rendering is a reliable
    // boundary. A known block buried in arbitrary host text is reported as
    // ambiguous and left untouched.
    const atEdge = first === 0 || first + known.length === source.length;
    if (!atEdge) {
      ambiguous = true;
      continue;
    }
    matched.push(known);
  }
  if (ambiguous || matched.length > 1) return { state: "ambiguous" };
  if (matched.length === 0) return { state: "none" };
  return { state: "replaced", text: source.split(matched[0]).join(text) };
}

export interface OwnedContextResult {
  parts: SystemTextPart[];
  /** Part indexes whose owned boundary could not be proven; left untouched. */
  ambiguous: number[];
}

const ambiguousLogged = new Set<string>();

/** One bounded audit line per process/session/shape, never per request. */
async function logContextAmbiguous(
  store: Store,
  sessionID: string,
  indexes: number[],
): Promise<void> {
  const key = `${sessionID}:${indexes.join(",")}`;
  if (ambiguousLogged.has(key)) return;
  ambiguousLogged.add(key);
  await store
    .appendChangelog({
      action: "context_ambiguous",
      sessionID,
      count: indexes.length,
      parts: indexes,
    })
    .catch(() => undefined);
}

/**
 * Pure helper shared with the later dynamic-recall block: replace only this
 * plugin's own content inside the assembled system parts.
 *
 * Order of evidence: explicit `<context key>` markers with a metadata record
 * (precise), a part that is exactly our single block, then a marker-only
 * boundary that is provably closed. Anything else is ambiguous: the part is
 * returned untouched and reported, never guessed and never deleted. Other
 * plugins' parts and the user's messages are returned untouched.
 */
export function applyOwnedContextDetailed(
  parts: ReadonlyArray<{ type: string; text: string; metadata?: Record<string, unknown> }>,
  text: string,
  knownTexts: ReadonlyArray<string> = [],
): OwnedContextResult {
  const next: SystemTextPart[] = [];
  const ambiguous: number[] = [];
  let handled = false;
  parts.forEach((part, index) => {
    if (typeof part.text !== "string") {
      next.push({ type: "text", text: String(part.text ?? ""), metadata: part.metadata });
      return;
    }
    if (CONTEXT_OPENS.some((open) => part.text.includes(open))) {
      const recorded = ownedInstructionText(part.metadata);
      const replaced =
        (recorded !== undefined && recorded.length > 0
          ? replaceRecordedBlock(part, recorded, text)
          : undefined) ?? replaceUnrecordedBlock(part.text, text);
      if (replaced === undefined) {
        // Ambiguous legacy shape: keep the host text intact and say so.
        handled = true;
        ambiguous.push(index);
        next.push({ type: "text", text: part.text, metadata: part.metadata });
        return;
      }
      handled = true;
      if (replaced.trim()) {
        next.push({
          type: "text",
          text: replaced,
          metadata: part.metadata
            ? withOwnedInstruction(part.metadata, text)
            : part.metadata,
        });
      }
      return;
    }
    const recorded = ownedInstructionText(part.metadata);
    if (recorded !== undefined) {
      // A dedicated markerless part, or our recorded copy inside a larger part.
      if (recorded.length === 0 || part.text === recorded) {
        handled = true;
        if (text.trim()) {
          next.push({ type: "text", text, metadata: withOwnedInstruction(part.metadata, text) });
        }
        return;
      }
      if (recorded.length > 0 && part.text.includes(recorded)) {
        handled = true;
        const replaced = part.text.split(recorded).join(text);
        if (replaced.trim()) {
          next.push({ type: "text", text: replaced, metadata: withOwnedInstruction(part.metadata, text) });
        }
        return;
      }
    }
    const known = matchKnownRender(part.text, text, knownTexts);
    if (known.state === "ambiguous") {
      // The exact own rendering appears more than once, or two known
      // renderings coexist: keep the host text and report, never append.
      handled = true;
      ambiguous.push(index);
      next.push({ type: "text", text: part.text, metadata: part.metadata });
      return;
    }
    if (known.state === "replaced") {
      handled = true;
      if (known.text.trim()) {
        next.push({ type: "text", text: known.text, metadata: part.metadata });
      }
      return;
    }
    next.push({ type: "text", text: part.text, metadata: part.metadata });
  });
  if (!handled && text.trim()) next.push(ownedPart(text));
  return { parts: next, ambiguous };
}

export function applyOwnedContext(
  parts: ReadonlyArray<{ type: string; text: string; metadata?: Record<string, unknown> }>,
  text: string,
): SystemTextPart[] {
  return applyOwnedContextDetailed(parts, text).parts;
}

export async function refreshContext(
  ctx: PluginContext,
  store: Store,
  config: AutoMemConfig,
  sessionID: string,
  projectKey?: string,
): Promise<void> {
  await resolveContext(ctx, store, config, sessionID, projectKey);
}

/**
 * Resolve the block that must be injected for this request and persist it for
 * later requests. A version match returns the pinned block without rebuilding;
 * a mismatch rebuilds, and only a changed rendering is written through
 * `entry.put`.
 */
export async function resolveContext(
  ctx: PluginContext,
  store: Store,
  config: AutoMemConfig,
  sessionID: string,
  projectKey?: string,
): Promise<AutopilotContext> {
  const entry = ctx.session?.instructions?.entry;
  const version = await store.memoryVersion();
  const pinned = await store.readSession(sessionID);
  // Only a version change rebuilds. An unchanged memory costs one comparison
  // per model request, not a rebuild, and the block stays byte-identical.
  if (
    pinned?.contextBlock &&
    pinned.contextProjectKey === projectKey &&
    pinned.contextVersion === version
  ) {
    return pinned.contextBlock;
  }
  const block = await buildContext(store, config, projectKey);
  const text = renderContext(block);
  if (entry && contextCache.get(sessionID) !== text) {
    await entry.put({ sessionID, key: CONTEXT_KEY, value: block });
    contextCache.set(sessionID, text);
  }
  await store.updateSession(sessionID, {
    contextBlock: block,
    contextHash: sha16(text),
    contextProjectKey: projectKey,
    contextVersion: version,
  });
  return block;
}

/**
 * One context request: resolve the authoritative block, then rewrite the
 * plugin-owned system content for *this* request. `entry.put` is only the
 * persistence channel for later requests: V2 announces entry updates at the
 * next step boundary, so the already assembled `event.system` still carries
 * the previous block. Replacing it here is what makes a stop/revert effective
 * on the very next request of an existing session.
 */
export async function applyContextRequest(
  ctx: PluginContext,
  store: Store,
  config: AutoMemConfig,
  event: ContextHookEvent,
  projectKey?: string,
): Promise<void> {
  const block = event.sessionID
    ? await resolveContext(ctx, store, config, event.sessionID, projectKey)
    : await buildContext(store, config, projectKey);
  if (!Array.isArray(event.system)) return;
  const result = applyOwnedContextDetailed(event.system, renderContext(block));
  event.system.splice(0, event.system.length, ...result.parts);
  if (result.ambiguous.length > 0 && event.sessionID) {
    // Degraded path: the boundary of a legacy, unrecorded block could not be
    // proven, so the part was left untouched. One bounded line, not per turn.
    await logContextAmbiguous(store, event.sessionID, result.ambiguous);
  }
}


/**
 * Recall's parent tri-state. Only a fresh, owned, id-matched host read can
 * answer it. A failed or unavailable read stays `unknown` and dynamic recall
 * fails closed; an explicit `parentID` is always `child`.
 *
 * Risk accepted by P04: a host that omits `parentID` for root sessions is
 * indistinguishable from a child whose parent field was dropped, so an
 * omission is treated as root once the read itself is proven. Anything less
 * than an owned, host-read, id-matched identity remains `unknown`.
 *
 * Exported only so the P04 tri-state can be tested directly; it is not part of
 * the plugin's public API and no other module should import it.
 */
export function ownershipParentState(
  ownership:
    | { status: string; hostRead: boolean; identity?: NativeSessionIdentity }
    | undefined,
  sessionID: string,
): RecallParentState {
  if (!ownership || ownership.status !== "owned" || !ownership.hostRead) return "unknown";
  const identity = ownership.identity;
  if (!identity || identity.id === undefined) return "unknown";
  // A read of another session proves nothing about this one.
  if (identity.id !== sessionID) return "unknown";
  if (identity.parentID) return "child";
  // `parentKnown` false here means the host read succeeded and omitted the
  // parent slot; explicit `null` is the same answer: root.
  return "root";
}

/** Prefix lines that existed before this request and no longer render. */
function revokedContextTexts(
  before: AutopilotContext | undefined,
  beforeProjectKey: string | undefined,
  after: AutopilotContext,
  projectKey: string | undefined,
): string[] {
  if (!before || beforeProjectKey !== projectKey) return [];
  const current = new Set(
    [...after.autoMemory, ...after.autoRules].map((line) =>
      line.replace(/\s+/g, " ").trim(),
    ),
  );
  return [...before.autoMemory, ...before.autoRules].filter(
    (line) => !current.has(line.replace(/\s+/g, " ").trim()),
  );
}

/**
 * Build the frozen prefix from active items, never from the queue or review
 * state. Project items are visible only in their owning project. Expired and
 * invalidated rows are excluded so a stop/revert takes effect on the next
 * request, including a session that already has a pinned block.
 */
export async function buildContext(
  store: Store,
  config: AutoMemConfig,
  projectKey?: string,
  now = Date.now(),
): Promise<AutopilotContext> {
  const active = (await store.listItems()).filter(
    (item) =>
      (item.status === "auto" || item.status === "promoted") &&
      !item.invalidatedBy &&
      !(item.expiresAt && Date.parse(item.expiresAt) <= now),
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
  // Escape at the source so both channels agree: the persisted `entry.put`
  // value and the per-request system part never carry bare structural markers.
  const clean = (item: Item): string =>
    escapeContextMarkers(item.text.replace(/\s+/g, " ").trim());
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

/**
 * A memory body must never be able to forge or close the host's keyed
 * `<context>` block, so structural markers are escaped at render time. The
 * escape is idempotent, so a block persisted before this rule is still safe
 * when it is rendered again.
 */
function escapeContextMarkers(value: string): string {
  return value
    .replace(/<\/context/gi, "&lt;/context")
    .replace(/<context/gi, "&lt;context");
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
      ...block.autoMemory.map((line) => `- ${escapeContextMarkers(line)}`),
    );
  }
  if (block.autoRules.length > 0) {
    lines.push(
      "",
      "Auto rules (low-risk, provisional):",
      ...block.autoRules.map((line) => `- ${escapeContextMarkers(line)}`),
    );
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

/** Combine event/get identity fragments without letting any one claim a project. */
function mergeNativeIdentities(
  values: Array<NativeSessionIdentity | undefined>,
): NativeSessionIdentity | undefined {
  let id: string | undefined;
  let parentID: string | undefined;
  let parentKnown = false;
  let agent: string | undefined;
  const directories: string[] = [];
  for (const value of values) {
    if (!value) continue;
    id ??= value.id;
    parentID ??= value.parentID;
    parentKnown ||= value.parentKnown;
    agent ??= value.agent;
    directories.push(...value.directories);
  }
  if (id === undefined && directories.length === 0 && !parentKnown && agent === undefined) {
    return undefined;
  }
  return {
    ...(id !== undefined ? { id } : {}),
    parentKnown,
    ...(parentID !== undefined ? { parentID } : {}),
    ...(agent !== undefined ? { agent } : {}),
    directories: [...new Set(directories)],
  };
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
  query?: string;
  limit?: number;
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
    query: typeof value.query === "string" ? value.query : undefined,
    limit: typeof value.limit === "number" && Number.isFinite(value.limit) ? value.limit : undefined,
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

function reviewFailureLabel(kind: string): string {
  switch (kind) {
    case "transport": return "传输失败";
    case "http": return "上游 HTTP 错误";
    case "empty": return "模型返回为空";
    case "format": return "返回格式错误";
    case "budget": return "请求预算不足";
    case "config": return "配置不可用";
    case "cache": return "缓存损坏";
    case "retry-after": return "上游要求延后";
    default: return "复盘失败";
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Category-only label for context-path failures; never returns a message. */
function contextErrorCategory(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
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
