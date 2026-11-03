import crypto from "node:crypto";
import type { AutoMemConfig } from "../types.js";
import type { Store } from "../store.js";
import { composeRewrite } from "./composer.js";
import { validateRewrite } from "./validate.js";
import { SystemTwoClient, SystemTwoError, type RewriteContext } from "./systemtwo.js";
import type { RewriteInput, RewriteOutput } from "./types.js";

interface CacheEntry {
  at: number;
  value: RewriteOutput;
}

export class RewriteService {
  private readonly client: SystemTwoClient;
  private calls: number[] = [];
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly options: {
      ctx?: RewriteContext;
      config: AutoMemConfig;
      store: Store;
      key?: string;
    },
  ) {
    this.client = new SystemTwoClient({
      ctx: options.ctx,
      config: options.config.rewrite,
      key: options.key,
    });
  }

  async suggest(input: RewriteInput): Promise<RewriteOutput> {
    if (!this.options.config.rewrite.enabled) {
      return composerWith(input, "System Two 未启用");
    }
    if (!this.allow()) {
      return composerWith(input, "System Two 限流/熔断，已使用模板合并");
    }

    const key = cacheKey(input, this.options.config.rewrite.model.id);
    const cached = await this.readCache(key);
    if (cached) return { ...cached, source: "systemtwo" };

    const started = Date.now();
    try {
      let output = await this.client.rewrite(input);
      let validation = validateRewrite(input, output);
      if (!validation.ok && this.options.config.rewrite.repairAttempts > 0) {
        output = await this.client.rewrite(input, {
          previous: output,
          errors: validation.errors,
        });
        validation = validateRewrite(input, output);
      }
      if (!validation.ok) {
        this.failure();
        await this.log(output, false, validation.errors[0], Date.now() - started);
        return composerWith(
          input,
          `System Two 输出未通过校验：${validation.errors.slice(0, 2).join("；")}`,
        );
      }
      this.success();
      await this.writeCache(key, output);
      await this.log(output, true, undefined, Date.now() - started);
      return output;
    } catch (error: unknown) {
      this.failure();
      const message = errorMessage(error);
      await this.log(undefined, false, message, Date.now() - started);
      return composerWith(input, `System Two 不可用：${message}`);
    }
  }

  private allow(): boolean {
    const now = Date.now();
    if (now < this.openUntil) return false;
    this.calls = this.calls.filter((at) => now - at < 60 * 60 * 1000);
    if (this.calls.length >= this.options.config.rewrite.maxCallsPerHour) return false;
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

  private async readCache(key: string): Promise<RewriteOutput | undefined> {
    const cache = await this.options.store.readCacheFile<Record<string, CacheEntry>>(
      this.options.store.rewriteCachePath,
      {},
    );
    const entry = cache[key];
    if (!entry) return undefined;
    const ttl = this.options.config.rewrite.cacheTtlHours * 60 * 60 * 1000;
    if (Date.now() - entry.at > ttl) return undefined;
    return entry.value;
  }

  private async writeCache(key: string, value: RewriteOutput): Promise<void> {
    const cache = await this.options.store.readCacheFile<Record<string, CacheEntry>>(
      this.options.store.rewriteCachePath,
      {},
    );
    const ttl = this.options.config.rewrite.cacheTtlHours * 60 * 60 * 1000;
    const now = Date.now();
    for (const [entryKey, entry] of Object.entries(cache)) {
      if (now - entry.at > ttl) delete cache[entryKey];
    }
    cache[key] = { at: now, value };
    const entries = Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, 500);
    await this.options.store.writeCacheFile(
      this.options.store.rewriteCachePath,
      Object.fromEntries(entries),
    );
  }

  private async log(
    output: RewriteOutput | undefined,
    ok: boolean,
    error: string | undefined,
    latencyMs: number,
  ): Promise<void> {
    await this.options.store
      .appendUsage({
        at: new Date().toISOString(),
        kind: "rewrite",
        provider: this.options.config.rewrite.model.providerID,
        model: this.options.config.rewrite.model.id,
        latencyMs: output?.latencyMs ?? latencyMs,
        ok,
        inputTokens: output?.usage?.inputTokens,
        outputTokens: output?.usage?.outputTokens,
        error,
        fallback: ok ? undefined : "composer",
      })
      .catch(() => undefined);
  }
}

export function createRewriteService(options: {
  ctx?: RewriteContext;
  config: AutoMemConfig;
  store: Store;
  key?: string;
}): RewriteService {
  return new RewriteService(options);
}

function composerWith(input: RewriteInput, reason: string): RewriteOutput {
  const output = composeRewrite(input);
  return {
    ...output,
    rationale: `${output.rationale} ${reason}`.trim(),
  };
}

function cacheKey(input: RewriteInput, model: string): string {
  const payload = JSON.stringify({
    model,
    candidate: input.candidate.text.trim().toLowerCase(),
    candidateTitle: input.candidate.title,
    target: input.target.text.trim().toLowerCase(),
    targetTitle: input.target.title,
    action: input.action,
    maxChars: input.maxChars,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function errorMessage(error: unknown): string {
  if (error instanceof SystemTwoError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
