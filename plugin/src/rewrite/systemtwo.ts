import { compact } from "../linter.js";
import type { RewriteConfig } from "../types.js";
import type { RewriteInput, RewriteOutput } from "./types.js";

interface GenerateApiLike {
  text?: (input: {
    model: { providerID: string; id: string };
    prompt: string;
  }) => Promise<unknown>;
}

export interface RewriteContext {
  generate?: GenerateApiLike;
  experimental?: {
    generate?: GenerateApiLike;
  };
}

export interface RewriteRepair {
  previous: RewriteOutput;
  errors: string[];
}

export class SystemTwoError extends Error {
  readonly raw: string;

  constructor(message: string, raw = "") {
    super(message);
    this.name = "SystemTwoError";
    this.raw = raw;
  }
}

export class SystemTwoClient {
  constructor(
    private readonly options: {
      ctx?: RewriteContext;
      config: RewriteConfig;
      key?: string;
    },
  ) {}

  async rewrite(input: RewriteInput, repair?: RewriteRepair): Promise<RewriteOutput> {
    const prompt = buildPrompt(input, repair);
    const started = Date.now();
    if (this.options.config.transport === "opencode") {
      return this.viaOpenCode(prompt, input, started);
    }
    return this.viaOllama(prompt, input, started);
  }

  private async viaOpenCode(
    prompt: string,
    input: RewriteInput,
    started: number,
  ): Promise<RewriteOutput> {
    const owner = this.options.ctx?.generate ?? this.options.ctx?.experimental?.generate;
    const text = owner?.text;
    if (!owner || typeof text !== "function") {
      throw new SystemTwoError("当前 OpenCode 版本没有 generate.text");
    }
    const result = await withTimeout(
      text.call(owner, { model: this.options.config.model, prompt }),
      this.options.config.timeoutMs,
    );
    const raw =
      typeof result === "string"
        ? result
        : isRecord(result) && typeof result.text === "string"
          ? result.text
          : "";
    if (!raw.trim()) throw new SystemTwoError("System Two 返回为空");
    return parseOutput(
      raw,
      this.options.config.model,
      Date.now() - started,
      input.action === "replace" ? "replace" : "merge",
    );
  }

  private async viaOllama(
    prompt: string,
    input: RewriteInput,
    started: number,
  ): Promise<RewriteOutput> {
    const endpoint = this.options.config.endpoint.replace(/\/+$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.key) headers.authorization = `Bearer ${this.options.key}`;
    let response: Response;
    try {
      response = await fetch(`${endpoint}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.options.config.model.id,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          format: "json",
          options: { temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(this.options.config.timeoutMs),
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error && error.name === "TimeoutError"
          ? "System Two 请求超时"
          : `System Two 网络错误：${error instanceof Error ? error.message : String(error)}`;
      throw new SystemTwoError(message);
    }
    if (!response.ok) {
      throw new SystemTwoError(`System Two 返回 HTTP ${response.status}`);
    }
    const data: unknown = await response.json().catch(() => undefined);
    const content =
      isRecord(data) && isRecord(data.message) && typeof data.message.content === "string"
        ? data.message.content
        : "";
    if (!content.trim()) throw new SystemTwoError("System Two 返回为空");
    const output = parseOutput(
      content,
      this.options.config.model,
      Date.now() - started,
      input.action === "replace" ? "replace" : "merge",
    );
    if (isRecord(data)) {
      const inputTokens = numberValue(data.prompt_eval_count);
      const outputTokens = numberValue(data.eval_count);
      if (inputTokens !== undefined || outputTokens !== undefined) {
        output.usage = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
      }
    }
    return output;
  }
}

export function buildPrompt(input: RewriteInput, repair?: RewriteRepair): string {
  const action = input.action === "replace" ? "replace" : "merge";
  const lines = [
    "You are System Two, a precise memory editor for an OpenCode plugin.",
    `Action: ${action} the target memory with the candidate.`,
    `Kind: ${input.candidate.kind}. Scope: ${input.candidate.scope}.`,
    `Hard limits: title <= ${input.titleMaxChars} characters; text <= ${input.maxChars} characters.`,
    "",
    "Target memory:",
    `title: ${input.target.title}`,
    `text: ${input.target.text}`,
    "",
    "Candidate memory:",
    `title: ${input.candidate.title}`,
    `text: ${input.candidate.text}`,
    "",
    "Rules:",
    "- One atomic claim; at most two short clauses. No examples, no transient/session wording, no secrets, no dates unless essential.",
    "- Preserve every unique number, port, path, URL, and identifier from both inputs.",
    "- Do not invent facts. If a detail must be dropped for length, list it with a reason.",
    "- If the two memories conflict (opposite actions), return action \"keep_both\" and do not merge.",
    "- Rules must never be merged; use \"keep_both\" or \"replace\".",
    "- Prefer the target's wording; add only the candidate's new information.",
    "",
    "Return JSON only, no markdown:",
    '{"action":"merge|replace|keep_both","title":"...","text":"...","preserved":["..."],"dropped":[{"text":"...","reason":"..."}],"rationale":"..."}',
  ];
  if (repair) {
    lines.push(
      "",
      "Your previous answer was invalid.",
      `Previous JSON: ${JSON.stringify({
        action: repair.previous.action,
        title: repair.previous.title,
        text: repair.previous.text,
        preserved: repair.previous.preserved,
        dropped: repair.previous.dropped,
      })}`,
      `Validation errors: ${repair.errors.join("; ")}`,
      "Fix exactly these errors and return valid JSON only.",
    );
  }
  return lines.join("\n");
}

function parseOutput(
  raw: string,
  model: { providerID: string; id: string },
  latencyMs: number,
  fallbackAction: "merge" | "replace",
): RewriteOutput {
  const json = extractJson(raw);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new SystemTwoError("System Two 返回的不是合法 JSON", raw.slice(0, 500));
  }
  if (!isRecord(value)) throw new SystemTwoError("System Two 返回的 JSON 不是对象", raw.slice(0, 500));

  const title = typeof value.title === "string" ? compact(value.title) : "";
  const text = typeof value.text === "string" ? compact(value.text) : "";
  if (!title || !text) throw new SystemTwoError("System Two 缺少 title/text", raw.slice(0, 500));

  const action =
    value.action === "keep_both" || value.action === "replace" || value.action === "merge"
      ? value.action
      : fallbackAction;

  const preserved = Array.isArray(value.preserved)
    ? value.preserved.filter((entry): entry is string => typeof entry === "string")
    : [];
  const dropped = Array.isArray(value.dropped)
    ? value.dropped
        .filter(isRecord)
        .map((entry) => ({
          text: typeof entry.text === "string" ? entry.text : "",
          reason: typeof entry.reason === "string" ? entry.reason : "",
        }))
        .filter((entry) => entry.text.length > 0)
    : [];

  return {
    action,
    title,
    text,
    preserved,
    dropped,
    rationale:
      typeof value.rationale === "string" && value.rationale.trim()
        ? compact(value.rationale)
        : "System Two 重写。",
    source: "systemtwo",
    model,
    latencyMs,
    raw: raw.slice(0, 2000),
  };
}

function extractJson(raw: string): string {
  const withoutFence = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return withoutFence;
  return withoutFence.slice(start, end + 1);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SystemTwoError("System Two 超时")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
