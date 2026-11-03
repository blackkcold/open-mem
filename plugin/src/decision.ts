import crypto from "node:crypto";
import type {
  AutoMemConfig,
  DecisionInput,
  DecisionProvider,
  DecisionResult,
  Strictness,
} from "./types.js";
import { bigrams, jaccard } from "./linter.js";
import { SystemOneClient, SystemOneError } from "./systemone.js";
import type { Store } from "./store.js";

const SKILL_RE = /(?:做成|保存为|skill|workflow|流程|步骤|可复用|repeatable)/i;
const RULE_RE =
  /(?:以后|每次|必须|不要|禁止|只能|优先|一律|永远|记得|记住|stop|always|never|must|should|use|avoid|prefer|keep|do not)/i;
const PREF_RE = /(?:我喜欢|我习惯|我偏好|偏好|prefer|i like|i use|favorite)/i;
const FACT_RE =
  /(?:是|有|位于|端口|路径|命令|版本|文档没写|实际上|turns out|the command is|the path is|the port is)/i;
const REF_RE = /(?:https?:\/\/|~\/|\/Users\/|[A-Za-z]:\\|\.md\b|\.json\b|\.ts\b)/i;
const SAFETY_RE =
  /(?:安全|凭证|密码|密钥|token|secret|credential|删除|覆盖|rm -rf|drop table|destructive|danger)/i;
const PERMISSION_RE = /(?:权限|permission|allow|deny|访问|network|网络|sandbox)/i;
const STRICT_RE =
  /(?:最多|至少|不超过|上限|下限|配额|超时|限制|只能|仅限|only|at most|at least|timeout|quota|cap|limit)/i;
const FORMAT_RE = /(?:格式|format|markdown|表格|回复|字数|长度|language|语言)/i;

export class HeuristicDecisionProvider implements DecisionProvider {
  async classify(input: DecisionInput): Promise<DecisionResult> {
    const text = `${input.title} ${input.candidate}`;
    const kind = classifyKind(text);
    const strictness = classifyStrictness(text, kind);
    const duplicate = Math.max(
      ...input.existingTitles.map((title) => jaccard(bigrams(text), bigrams(title))),
      0,
    );
    const risk = riskOf(strictness, kind);
    const safeAuto = clamp01(1 - risk - duplicate * 0.4);
    const mergeAction =
      duplicate >= 0.9 ? "reject_duplicate" : duplicate >= 0.6 ? "keep_both" : "create";
    return {
      kind,
      duplicate: clamp01(duplicate),
      safeAuto,
      risk,
      confidence: 0.65,
      strictness,
      reasons: [
        `heuristic: ${kind}`,
        `strictness: ${strictness}`,
        duplicate >= 0.25 ? `overlap ${Math.round(duplicate * 100)}%` : "no strong overlap",
      ],
      source: "heuristic",
      mergeAction,
      conflict: 0,
    };
  }
}

/**
 * Adapter for OpenCode's built-in decisions API. Kept for environments that
 * expose it; the production path for ollama-cloud is SystemOneClient.
 */
export class OpenCodeDecisionProvider implements DecisionProvider {
  constructor(
    private readonly ctx: {
      experimental?: {
        generate?: {
          decisions?: (input: unknown) => Promise<unknown>;
        };
      };
    },
    private readonly model: { providerID: string; id: string },
  ) {}

  async classify(input: DecisionInput): Promise<DecisionResult> {
    const generate = this.ctx.experimental?.generate;
    const decisions = generate?.decisions;
    if (!generate || typeof decisions !== "function") throw new Error("decisions API unavailable");
    const state = [
      `candidate: ${input.candidate}`,
      `title: ${input.title}`,
      `scope: ${input.scope}`,
      `existing_rules: ${input.existingTitles.slice(0, 30).join(" | ")}`,
    ].join("\n");
    const result = await decisions.call(generate, {
      model: this.model,
      input: [{ type: "text", text: state }],
      questions: [
        {
          type: "predicate",
          name: "is_skill",
          instructions: "Is this a reusable workflow or skill candidate rather than a fact or rule?",
        },
        {
          type: "predicate",
          name: "is_rule",
          instructions: "Is this an imperative rule that changes how work should be done?",
        },
        {
          type: "predicate",
          name: "is_preference",
          instructions: "Is this a user preference about style, tools, or workflow?",
        },
        {
          type: "predicate",
          name: "is_fact",
          instructions: "Is this a durable project or environment fact?",
        },
        {
          type: "predicate",
          name: "is_duplicate",
          instructions: "Is this already covered by the existing rules or titles?",
        },
        {
          type: "predicate",
          name: "is_safe_auto",
          instructions: "Is it safe to apply this without asking the user first?",
        },
        {
          type: "predicate",
          name: "is_safety",
          instructions: "Does this affect safety, credentials, destructive actions, or privacy?",
        },
        {
          type: "predicate",
          name: "is_strict_limit",
          instructions: "Does this impose a hard numeric limit, quota, timeout, or scope restriction?",
        },
      ],
    });
    const values = [
      "is_skill",
      "is_rule",
      "is_preference",
      "is_fact",
      "is_duplicate",
      "is_safe_auto",
      "is_safety",
      "is_strict_limit",
    ].map((name) => answerNumber(result, name));
    if (values.every((value) => value === 0)) throw new Error("empty decisions answer");

    const heuristic = await new HeuristicDecisionProvider().classify(input);
    const [isSkill, isRule, isPreference, isFact, isDuplicate, isSafe, isSafety, isStrict] = values;
    const kind =
      isSkill > 0.5
        ? "skill"
        : isRule > 0.5
          ? "rule"
          : isPreference > 0.5
            ? "preference"
            : isFact > 0.5
              ? "fact"
              : heuristic.kind;
    const strictness: Strictness =
      isSafety > 0.5
        ? "safety"
        : isStrict > 0.5
          ? "strict_limit"
          : heuristic.strictness;
    const duplicate = Math.max(heuristic.duplicate, isDuplicate);
    const risk = Math.max(heuristic.risk, isSafety > 0.5 ? 0.95 : isStrict > 0.5 ? 0.85 : 0);
    return {
      kind,
      duplicate: clamp01(duplicate),
      safeAuto: clamp01(isSafe),
      risk,
      confidence: 0.75,
      strictness,
      reasons: [
        `opencode decisions: ${kind}`,
        `strictness: ${strictness}`,
        `safe_auto ${Math.round(isSafe * 100)}%`,
      ],
      source: "jev",
      mergeAction:
        duplicate >= 0.9 ? "reject_duplicate" : duplicate >= 0.6 ? "keep_both" : "create",
      conflict: 0,
    };
  }
}

export class HybridDecisionProvider implements DecisionProvider {
  constructor(
    private readonly primary: DecisionProvider,
    private readonly fallback: DecisionProvider,
  ) {}

  async classify(input: DecisionInput): Promise<DecisionResult> {
    try {
      return await this.primary.classify(input);
    } catch {
      const result = await this.fallback.classify(input);
      return { ...result, reasons: [...result.reasons, "primary unavailable; heuristic fallback"] };
    }
  }
}

interface CachedDecision {
  at: number;
  value: DecisionResult;
}

export interface DecisionServiceOptions {
  config: AutoMemConfig;
  store: Store;
  client?: SystemOneClient;
  heuristic?: DecisionProvider;
  env?: NodeJS.ProcessEnv;
}

/**
 * System One with cache, hourly rate limit, and a circuit breaker. Any failure
 * degrades to the deterministic heuristic without blocking consolidation.
 */
export class DecisionService implements DecisionProvider {
  private readonly heuristic: DecisionProvider;
  private calls: number[] = [];
  private failures = 0;
  private openUntil = 0;

  constructor(private readonly options: DecisionServiceOptions) {
    this.heuristic = options.heuristic ?? new HeuristicDecisionProvider();
  }

  async classify(input: DecisionInput): Promise<DecisionResult> {
    const client = this.options.client;
    if (!client) return this.heuristic.classify(input);
    if (!this.allow()) {
      const fallback = await this.heuristic.classify(input);
      return {
        ...fallback,
        reasons: [...fallback.reasons, "System One 限流/熔断，已降级"],
      };
    }

    const key = cacheKey(input, this.options.config.decision.model);
    const cached = await this.readCache(key);
    if (cached) return { ...cached, cached: true };

    const started = Date.now();
    try {
      const result = await client.classify(input);
      this.success();
      await this.writeCache(key, result);
      await this.log({
        at: new Date().toISOString(),
        kind: "decision",
        provider: "ollama-cloud",
        model: this.options.config.decision.model,
        latencyMs: Date.now() - started,
        ok: true,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
      });
      return result;
    } catch (error: unknown) {
      this.failure();
      const message = errorMessage(error);
      await this.log({
        at: new Date().toISOString(),
        kind: "decision",
        provider: "ollama-cloud",
        model: this.options.config.decision.model,
        latencyMs: Date.now() - started,
        ok: false,
        error: message,
        status: error instanceof SystemOneError ? error.status : undefined,
      });
      const fallback = await this.heuristic.classify(input);
      return {
        ...fallback,
        reasons: [...fallback.reasons, `System One 降级：${message}`],
      };
    }
  }

  private allow(): boolean {
    const now = Date.now();
    if (now < this.openUntil) return false;
    this.calls = this.calls.filter((at) => now - at < 60 * 60 * 1000);
    if (this.calls.length >= this.options.config.decision.maxCallsPerHour) return false;
    this.calls.push(now);
    return true;
  }

  private success(): void {
    this.failures = 0;
  }

  private failure(): void {
    this.failures += 1;
    if (this.failures >= 3) {
      this.openUntil = Date.now() + 10 * 60 * 1000;
      this.failures = 0;
    }
  }

  private async readCache(key: string): Promise<DecisionResult | undefined> {
    const cache = await this.options.store.readCacheFile<Record<string, CachedDecision>>(
      this.options.store.decisionCachePath,
      {},
    );
    const entry = cache[key];
    if (!entry) return undefined;
    const ttl = this.options.config.decision.cacheTtlHours * 60 * 60 * 1000;
    if (Date.now() - entry.at > ttl) return undefined;
    return entry.value;
  }

  private async writeCache(key: string, value: DecisionResult): Promise<void> {
    const cache = await this.options.store.readCacheFile<Record<string, CachedDecision>>(
      this.options.store.decisionCachePath,
      {},
    );
    const ttl = this.options.config.decision.cacheTtlHours * 60 * 60 * 1000;
    const now = Date.now();
    for (const [entryKey, entry] of Object.entries(cache)) {
      if (now - entry.at > ttl) delete cache[entryKey];
    }
    cache[key] = { at: now, value };
    const entries = Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, 500);
    await this.options.store.writeCacheFile(
      this.options.store.decisionCachePath,
      Object.fromEntries(entries),
    );
  }

  private async log(record: Parameters<Store["appendUsage"]>[0]): Promise<void> {
    await this.options.store.appendUsage(record).catch(() => undefined);
  }
}

export function createDecisionProvider(options: {
  config: AutoMemConfig;
  store: Store;
  key?: string;
  env?: NodeJS.ProcessEnv;
}): DecisionProvider {
  const env = options.env ?? process.env;
  const enabled =
    options.config.decision.kind === "systemone" &&
    typeof options.key === "string" &&
    options.key.length > 0 &&
    env.VITEST !== "true";
  if (!enabled) {
    return new DecisionService({
      config: options.config,
      store: options.store,
      heuristic: new HeuristicDecisionProvider(),
    });
  }
  return new DecisionService({
    config: options.config,
    store: options.store,
    client: new SystemOneClient({
      endpoint: options.config.decision.endpoint,
      model: options.config.decision.model,
      apiKey: options.key as string,
      timeoutMs: options.config.decision.timeoutMs,
    }),
  });
}

export async function resolveOllamaKey(
  envName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ key?: string; source: "env" | "auth" | "missing" }> {
  const fromEnv = env[envName];
  if (fromEnv && fromEnv.trim().length > 0) return { key: fromEnv.trim(), source: "env" };
  try {
    const { readFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
    const raw = await readFile(file, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const entry = data["ollama-cloud"];
    if (typeof entry === "object" && entry !== null) {
      const key = (entry as Record<string, unknown>).key;
      if (typeof key === "string" && key.length > 0) return { key, source: "auth" };
    }
  } catch {
    // A missing auth file is normal for an isolated profile.
  }
  return { source: "missing" };
}

export function errorMessage(error: unknown): string {
  if (error instanceof SystemOneError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function classifyKind(text: string): DecisionResult["kind"] {
  if (SKILL_RE.test(text)) return "skill";
  if (RULE_RE.test(text)) return "rule";
  if (PREF_RE.test(text)) return "preference";
  if (REF_RE.test(text)) return "reference";
  if (FACT_RE.test(text)) return "fact";
  return text.trim().length >= 10 ? "fact" : "ignore";
}

function classifyStrictness(text: string, kind: DecisionResult["kind"]): Strictness {
  if (SAFETY_RE.test(text)) return "safety";
  if (PERMISSION_RE.test(text)) return "permission";
  if (STRICT_RE.test(text)) return "strict_limit";
  if (FORMAT_RE.test(text)) return "format";
  if (kind === "rule") return "workflow";
  if (kind === "preference") return "preference";
  if (kind === "skill") return "workflow";
  return "unknown";
}

function riskOf(strictness: Strictness, kind: DecisionResult["kind"]): number {
  if (strictness === "safety" || strictness === "destructive") return 0.95;
  if (strictness === "permission") return 0.85;
  if (strictness === "strict_limit") return 0.8;
  if (strictness === "workflow") return kind === "skill" ? 0.35 : 0.45;
  if (strictness === "preference" || strictness === "format") return 0.2;
  return kind === "fact" ? 0.1 : 0.3;
}

function answerNumber(result: unknown, name: string): number {
  if (!isRecord(result)) return 0;
  const answers = isRecord(result.answers) ? result.answers : undefined;
  const answer = answers && isRecord(answers[name]) ? answers[name] : undefined;
  if (typeof answer === "number") return clamp01(answer);
  if (isRecord(answer)) {
    for (const key of ["noul", "probability", "value", "score"]) {
      const value = answer[key];
      if (typeof value === "number") return clamp01(value);
    }
    if (isRecord(answer.probabilities) && typeof answer.probabilities.true === "number") {
      return clamp01(answer.probabilities.true);
    }
  }
  return 0;
}

function cacheKey(input: DecisionInput, model: string): string {
  const payload = JSON.stringify({
    model,
    candidate: input.candidate.trim().toLowerCase(),
    title: input.title,
    scope: input.scope,
    project: input.project ?? "",
    neighbors: (input.neighbors ?? []).map((neighbor) => neighbor.id),
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
