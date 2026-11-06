import type { AutoMemConfig, ReviewRunResult } from "../types.js";
import type { Store } from "../store.js";
import type { ReviewInput } from "./input.js";
import { parseReview, ReviewFormatError } from "./parse.js";
import { modelHeaders } from "../util/endpoint.js";

export interface ReviewProviderOptions {
  store: Store;
  config: AutoMemConfig;
  key?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

interface CacheEntry {
  at: number;
  result: ReviewRunResult;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

const MAX_CACHE_ENTRIES = 200;
const CIRCUIT_FAILURES = 3;
const CIRCUIT_MS = 10 * 60 * 1000;
// Bump once when prompt semantics change; never include the volatile known
// list in this key or every queue mutation would force a paid call.
const REVIEW_PROMPT_VERSION = 2;

export class ReviewRequestError extends Error {
  constructor(
    message: string,
    /**
     * True for a content failure, false for a transport/provider failure
     * (network, HTTP status, circuit open). The orchestrator uses this only to
     * label the review record as a transport failure; every failed run
     * consumes the same bounded retry budget, so this does not gate retries.
     */
    readonly countsAsAttempt = false,
  ) {
    super(message);
    this.name = "ReviewRequestError";
  }
}

/**
 * The persisted review cache exists but its top-level shape is invalid.
 * Thrown loudly so the orchestrator never treats it as an empty cache and a
 * later persist cannot silently overwrite the damaged file.
 */
export class ReviewCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewCacheError";
  }
}

/**
 * Session review model call. Uses the same Ollama chat transport as System Two
 * (JSON mode), but keeps its own cache, circuit breaker and prompt because the
 * task shape and the safety rules are different.
 */
export class ReviewProvider {
  private failures = 0;
  private openUntil = 0;
  private cache?: Map<string, CacheEntry>;
  private loading?: Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: ReviewProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async review(input: ReviewInput): Promise<ReviewRunResult> {
    if (this.now() < this.openUntil) {
      throw new ReviewRequestError("复盘模型熔断中，稍后重试", false);
    }
    await this.loadCache();
    const key = `${REVIEW_PROMPT_VERSION}:${this.options.config.review.model.id}:${
      this.options.config.review.model.variant ?? ""
    }:${input.hash}`;
    const cached = this.cache?.get(key);
    const ttl = this.options.config.review.cacheTtlHours * 60 * 60 * 1000;
    if (cached && this.now() - cached.at < ttl) {
      return { ...cached.result, cached: true };
    }

    const prompt = buildReviewPrompt(input, this.options.config.review.maxCandidates);
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let raw: string;
    try {
      const first = await this.request(prompt);
      raw = first.raw;
      usage = first.usage;
    } catch (error: unknown) {
      this.recordFailure();
      throw asRequestError(error, false);
    }

    let parsed;
    try {
      parsed = parseReview(raw);
    } catch (error: unknown) {
      if (this.options.config.review.repairAttempts < 1) {
        throw asRequestError(error, true);
      }
      const message = error instanceof Error ? error.message : String(error);
      this.options.log?.("review output invalid, repairing", error);
      const repaired = await this.request(buildRepairPrompt(prompt, raw, [message])).catch(
        (repairError: unknown) => {
          this.recordFailure();
          throw asRequestError(repairError, false);
        },
      );
      usage = sumUsage(usage, repaired.usage);
      try {
        parsed = parseReview(repaired.raw);
      } catch (repairError: unknown) {
        throw asRequestError(repairError, true);
      }
    }

    this.failures = 0;
    const result: ReviewRunResult = {
      ...parsed,
      model: this.options.config.review.model.id,
      ...(usage ? { usage } : {}),
    };
    // A cache write failure must never discard a paid-for review.
    try {
      await this.persist(key, result);
    } catch (error: unknown) {
      this.options.log?.("review cache write failed", error);
    }
    return result;
  }

  stats(): { failures: number; openUntil?: number; cached: number } {
    return {
      failures: this.failures,
      openUntil: this.openUntil > this.now() ? this.openUntil : undefined,
      cached: this.cache?.size ?? 0,
    };
  }

  private async request(
    prompt: string,
  ): Promise<{ raw: string; usage?: { inputTokens: number; outputTokens: number } }> {
    const { config } = this.options;
    const endpoint = config.rewrite.endpoint.replace(/\/+$/, "");
    const headers = modelHeaders(endpoint, this.options.key);
    const body = JSON.stringify({
      model: config.review.model.id,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      format: "json",
      // Native Ollama thinking control. Unsupported levels fall back to the
      // model default, so an unknown variant never breaks a review.
      ...(config.review.model.variant ? { think: config.review.model.variant } : {}),
      options: {
        temperature: 0.2,
        num_predict: this.options.config.review.maxOutputTokens,
      },
    });

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (!await this.options.store.takeModelSlot("review", config.review.maxPerHour, this.now())) {
          throw new ReviewRequestError("复盘请求预算已用尽，稍后可重试", false);
        }
        const response = await this.fetchImpl(`${endpoint}/api/chat`, {
          method: "POST",
          redirect: "error",
          headers,
          body,
          signal: AbortSignal.timeout(config.review.timeoutMs),
        });
        if (!response.ok) {
          const error = new Error(`review HTTP ${response.status}`);
          (error as Error & { retryable?: boolean }).retryable = response.status >= 500;
          throw error;
        }
        const data: unknown = await response.json().catch(() => undefined);
        const content =
          isRecord(data) && isRecord(data.message) && typeof data.message.content === "string"
            ? data.message.content
            : "";
        if (!content.trim()) throw new Error("复盘模型返回为空");
        const usage =
          isRecord(data) && (numberValue(data.prompt_eval_count) || numberValue(data.eval_count))
            ? {
                inputTokens: numberValue(data.prompt_eval_count) ?? 0,
                outputTokens: numberValue(data.eval_count) ?? 0,
              }
            : undefined;
        return { raw: content, usage };
      } catch (error: unknown) {
        lastError = error;
        if (attempt === 0 && isRetryable(error)) continue;
        break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private recordFailure(): void {
    this.failures += 1;
    if (this.failures >= CIRCUIT_FAILURES) {
      this.openUntil = this.now() + CIRCUIT_MS;
      this.options.log?.(`review circuit open for ${CIRCUIT_MS / 1000}s`);
    }
  }

  private async loadCache(): Promise<void> {
    if (!this.loading) {
      const attempt = this.readCache();
      this.loading = attempt;
      try {
        return await attempt;
      } catch (error: unknown) {
        // A temporary read/corruption failure must stay retryable: drop only
        // the in-flight reference, keep the error visible to the caller, and
        // leave the cache file untouched (readCache assigns the map only after
        // a successful read). Concurrent callers still share this attempt.
        if (this.loading === attempt) this.loading = undefined;
        throw error;
      }
    }
    await this.loading;
  }

  private async readCache(): Promise<void> {
    const cachePath = this.options.store.reviewCachePath;
    const file = await this.options.store.readCacheFile<unknown>(cachePath, {
      version: 1,
      entries: {},
    });
    this.cache = parseCacheFile(file, cachePath).entries;
  }

  private async persist(key: string, result: ReviewRunResult): Promise<void> {
    const cachePath = this.options.store.reviewCachePath;
    let committed: Map<string, CacheEntry> | undefined;
    await this.options.store.transaction(async () => {
      // Re-read and re-validate the latest on-disk snapshot inside the write
      // lock: another instance may have damaged it after our first successful
      // load. A throw aborts the transaction, leaves the file untouched, and
      // review() still returns the completed model result.
      const stored = await this.options.store.readCacheFile<unknown>(cachePath, {
        version: 1,
        entries: {},
      });
      const loaded = parseCacheFile(stored, cachePath);
      const next = new Map(loaded.entries);
      if (this.cache) {
        for (const [id, entry] of this.cache) {
          const existing = next.get(id);
          if (!existing || existing.at <= entry.at) next.set(id, entry);
        }
      }
      next.set(key, { at: this.now(), result });
      trimCache(next);
      const file: CacheFile = {
        // Keep unknown top-level fields instead of silently dropping them.
        ...loaded.extras,
        version: 1,
        entries: Object.fromEntries(next),
      };
      await this.options.store.writeCacheFile(cachePath, file);
      committed = next;
    });
    // Assign only after the transaction commits; a failed write must not make
    // the in-memory cache claim entries the disk never accepted.
    if (committed) this.cache = committed;
  }
}

export function buildReviewPrompt(
  input: ReviewInput,
  maxCandidates = 6,
): string {
  const lines = [
    "You review one OpenCode session for durable memory. Extract only knowledge worth keeping across sessions.",
    "",
    "Hard rules:",
    "- facts, preferences, rules and decisions need a verbatim quote from a USER line. Assistant prose is not provided.",
    "- learnings need a quote from a tool line marked ok=false.",
    "- skills need at least 2 steps, a user quote, and a quote from a successful tool line (ok=true).",
    "- Never invent numbers, ports, paths, versions or identifiers.",
    "- Skip transient state: today's task, current file, temporary debugging, one-off commands.",
    "- Write each text in the language the user used; one atomic claim; no dates, no session ids, no secrets.",
    "- Scope: task instructions and session constraints are session; repo/path/command evidence is project; explicit cross-project language is a global candidate. Default to session.",
    "- task_only must be true for a constraint that only applies to this task/session.",
    `- At most ${maxCandidates} candidates. Fewer is better; return an empty list when nothing is durable.`,
    "- Every candidate needs confidence in [0,1] and 1-2 evidence entries whose quote is an exact substring.",
    "",
    "Return JSON only:",
    '{"summary":["..."],"candidates":[{"type":"fact|preference|rule|decision|learning|skill","text":"...","scope":"session|project|global","task_only":false,"scope_evidence":"...","confidence":0.0,"evidence":[{"messageID":"...","quote":"...","kind":"user|tool"}],"steps":["only for skill"]}],"openQuestions":["..."]}',
    "",
    "Transcript:",
  ];
  for (const item of input.items) {
    if (item.role === "user") {
      lines.push(`[${item.id}] user: ${item.text}`);
    } else {
      lines.push(`[${item.id}] tool ${item.tool ?? "unknown"} ok=${item.ok === true}: ${item.text}`);
    }
  }
  if (input.truncated) {
    lines.push("", "Note: the transcript was truncated to fit the budget.");
  }
  // Keep this after the transcript: the instruction + transcript prefix stays
  // byte-identical when only the queue changes, and repair calls reuse it.
  if (input.knownTitles && input.knownTitles.length > 0) {
    lines.push(
      "",
      "Known titles (do not duplicate):",
      ...input.knownTitles.map((title) => `- ${title}`),
    );
  }
  return lines.join("\n");
}

export function buildRepairPrompt(original: string, raw: string, errors: string[]): string {
  return [
    original,
    "",
    "Your previous answer was invalid.",
    `Previous output: ${raw.slice(0, 1200)}`,
    `Errors: ${errors.join("; ")}`,
    "Fix exactly these errors and return valid JSON only.",
  ].join("\n");
}

function asRequestError(error: unknown, countsAsAttempt: boolean): ReviewRequestError {
  const message = error instanceof Error ? error.message : String(error);
  return new ReviewRequestError(message, countsAsAttempt);
}

function isRetryable(error: unknown): boolean {  if (error instanceof ReviewFormatError) return false;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const retryable = (error as { retryable?: boolean } | undefined)?.retryable;
  if (typeof retryable === "boolean") return retryable;
  const message = error instanceof Error ? error.message : String(error);
  return /network|fetch failed|ECONN|ETIMEDOUT|socket/i.test(message);
}

function sumUsage(
  left: { inputTokens: number; outputTokens: number } | undefined,
  right: { inputTokens: number; outputTokens: number } | undefined,
): { inputTokens: number; outputTokens: number } | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** JSON object, excluding arrays (`isRecord` would accept an array). */
function isCacheObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ParsedCache {
  entries: Map<string, CacheEntry>;
  /** Unknown top-level fields, preserved verbatim on the next write. */
  extras: Record<string, unknown>;
}

/**
 * Validate one parsed cache file. Error messages must never echo cache keys,
 * version values or text: the cache is untrusted content and may hold private
 * material. Report the damage category and counts only.
 */
function parseCacheFile(file: unknown, cachePath: string): ParsedCache {
  if (!isCacheObject(file)) {
    throw new ReviewCacheError(`复盘缓存顶层不是 JSON 对象（${cachePath}）`);
  }
  if (file.version !== undefined && file.version !== 1) {
    throw new ReviewCacheError(`复盘缓存版本不受支持（${cachePath}）`);
  }
  const entries = file.entries;
  // Store.init writes `{}`; a missing entries field is the legacy empty cache.
  // Anything else at the top level was never written or read by this provider,
  // so preserve the file instead of silently replacing it.
  if (entries === undefined) {
    const unknown = Object.keys(file).filter((field) => field !== "version");
    if (unknown.length > 0) {
      throw new ReviewCacheError(
        `复盘缓存缺少 entries 且含 ${unknown.length} 个无法识别的顶层字段（${cachePath}）`,
      );
    }
    return { entries: new Map(), extras: {} };
  }
  if (!isCacheObject(entries)) {
    throw new ReviewCacheError(`复盘缓存 entries 不是 JSON 对象（${cachePath}）`);
  }
  const extras: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(file)) {
    if (field !== "version" && field !== "entries") extras[field] = value;
  }
  const parsed = new Map<string, CacheEntry>();
  let broken = 0;
  for (const [key, entry] of Object.entries(entries)) {
    // A malformed row must not disappear on the next persist: abort the load
    // and keep the file for manual repair. Valid rows are not used until the
    // whole file is loadable.
    if (!isCacheEntry(entry)) {
      broken += 1;
      continue;
    }
    parsed.set(key, entry);
  }
  if (broken > 0) {
    throw new ReviewCacheError(
      `复盘缓存含 ${broken} 条无法解析的条目（${cachePath}）`,
    );
  }
  return { entries: parsed, extras };
}

/** Keep the newest MAX_CACHE_ENTRIES rows, oldest `at` first. */
function trimCache(entries: Map<string, CacheEntry>): void {
  while (entries.size > MAX_CACHE_ENTRIES) {
    let oldestKey: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, entry] of entries) {
      if (entry.at < oldest) {
        oldest = entry.at;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    entries.delete(oldestKey);
  }
}

/**
 * Structural envelope of one cache row. Keeps the pre-existing per-entry
 * acceptance (numeric `at`, object `result`); result fields are not revalidated.
 */
function isCacheEntry(value: unknown): value is CacheEntry {
  return (
    isCacheObject(value) &&
    typeof value.at === "number" &&
    isCacheObject(value.result)
  );
}
