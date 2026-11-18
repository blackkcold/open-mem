import type { SessionMessage } from "../types.js";
import { redactText } from "../redact.js";
import { clipMiddle, fileName, firstLine, lastLines, sha16, truncate } from "../util/text.js";

export interface ToolDigest {
  /** Content address of the redacted output; stable across re-reads. */
  id: string;
  /** Hash of the complete raw output; never persists the output itself. */
  rawHash: string;
  tool: string;
  ok: boolean;
  /** Bounded, human-readable line that is safe to send to a model. */
  summary: string;
  signals: string[];
  /** Original output size, for the review report only. */
  chars: number;
}

export interface ToolDigestOptions {
  maxChars?: number;
  maxOutputChars?: number;
  bashTailLines?: number;
}

export type ToolFailureProjection =
  | {
    ok: true;
    tool: string;
    status: string;
    exit?: number;
    /** Complete, bounded failure sentence; never command text or arbitrary args. */
    text: string;
    /** Legacy digest content address; still bounded/redacted for review display. */
    digestHash: string;
    /** Secret-redacted hash of the complete native diagnostic set. */
    rawHash: string;
  }
  | {
    ok: false;
    reason: "not-failing" | "no-diagnostic" | "diagnostic-not-complete" | "no-tool";
  };

export const DEFAULT_DIGEST_OPTIONS: Required<ToolDigestOptions> = {
  maxChars: 160,
  maxOutputChars: 4000,
  bashTailLines: 3,
};

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Tool parts of a normalized message; empty when the message has none. */
export function toolParts(message: SessionMessage): Array<Record_> {
  const out: Array<Record_> = [];
  for (const part of message.parts ?? []) {
    if (isRecord(part) && part.type === "tool" && toolName(part)) {
      out.push(part);
    }
  }
  return out;
}

/** Tool parts with their native index in the normalized parts array. */
export function indexedToolParts(
  message: SessionMessage,
): Array<{ part: Record_; index: number }> {
  const out: Array<{ part: Record_; index: number }> = [];
  const parts = message.parts ?? [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (isRecord(part) && part.type === "tool" && toolName(part)) {
      out.push({ part, index });
    }
  }
  return out;
}

function toolName(part: Record_): string | undefined {
  return str(part.tool) ?? str(part.name);
}

/**
 * Deterministic, model-free digest of one tool call. Raw output never leaves
 * this function: the complete native error/output is secret-redacted first,
 * then the review copy is clipped and reduced to a single line.
 */
export function digestToolPart(
  part: Record_,
  options: ToolDigestOptions = {},
): ToolDigest | undefined {
  const view = readToolPartView(part, options);
  if (!view) return undefined;
  return {
    id: view.digestId,
    rawHash: view.rawHash,
    tool: view.tool,
    ok: view.ok,
    summary: view.summary,
    signals: view.signals,
    chars: view.chars,
  };
}

interface ToolPartView {
  tool: string;
  status: string;
  exit?: number;
  ok: boolean;
  input: Record_;
  /** Complete native error/output after secret-only redaction; paths retained. */
  diagnostic: string;
  /** Bounded redacted content used by the legacy review digest. */
  digestText: string;
  digestId: string;
  rawHash: string;
  summary: string;
  signals: string[];
  chars: number;
}

/**
 * One native-field reader shared by review digests, learning capture, and
 * write-time verification. V2 keeps tool failures in `state.error` (message,
 * type, status, response.body) and may also carry `state.content`; reading only
 * `state.output` would silently lose the actual error.
 */
function readToolPartView(
  part: Record_,
  options: ToolDigestOptions = {},
): ToolPartView | undefined {
  const opts = { ...DEFAULT_DIGEST_OPTIONS, ...options };
  const tool = toolName(part);
  if (!tool) return undefined;

  const state = isRecord(part.state) ? part.state : {};
  const input = isRecord(state.input) ? state.input : {};
  const metadata = isRecord(state.metadata) ? state.metadata : {};
  const status = str(state.status) ?? "completed";
  const error = isRecord(state.error) ? state.error : undefined;
  const errorMessage = str(state.error) ?? (error ? str(error.message) : undefined);
  const errorType = error ? str(error.type) : undefined;
  const responseBody = error && isRecord(error.response)
    ? str(error.response.body)
    : undefined;
  const contentText = Array.isArray(state.content)
    ? state.content
      .map((content) => isRecord(content) && typeof content.text === "string" ? content.text : "")
      .filter(Boolean)
      .join("\n")
    : "";
  const output = str(state.output) ?? str(metadata.output) ?? str(part.text) ?? "";
  const rawText = [errorMessage, errorType ? `[${errorType}]` : "", responseBody, contentText, output]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  // Secret-only redaction runs before clipping or hashing. Absolute paths stay
  // ordinary engineering evidence.
  const diagnostic = redactText(rawText, { paths: false }).text.trim();
  const digestText = redactText(clipMiddle(diagnostic, opts.maxOutputChars), {
    paths: false,
  }).text;
  const exit = num(metadata.exit) ?? num(metadata.exitCode) ?? num(state.exitCode);
  const ok = status !== "error" && (exit === undefined || exit === 0);

  const signals = [`status:${status}`];
  if (exit !== undefined) signals.push(`exit:${exit}`);
  if (errorType) signals.push(`error:${errorType}`);

  const summary = truncate(
    redactText(buildSummary(tool, input, digestText, ok, exit, opts)).text,
    opts.maxChars,
  );
  return {
    tool,
    status,
    ...(exit !== undefined ? { exit } : {}),
    ok,
    input,
    diagnostic,
    digestText,
    digestId: sha16(`${tool}|${ok ? "ok" : "err"}|${digestText}`),
    rawHash: sha16(diagnostic),
    summary,
    signals,
    chars: rawText.length,
  };
}

/**
 * Extract a complete, bounded failure sentence from native state.error/content/
 * output. Commands and full args are never part of the body. A long first line
 * without a complete sentence boundary is skipped rather than arbitrarily cut.
 */
export function projectToolFailure(
  part: Record_,
  maxChars = 200,
): ToolFailureProjection {
  const view = readToolPartView(part);
  if (!view) return { ok: false, reason: "no-tool" };
  if (view.ok) return { ok: false, reason: "not-failing" };
  if (!view.diagnostic) return { ok: false, reason: "no-diagnostic" };

  const status = view.status === "completed" && view.exit !== undefined
    ? `exit ${view.exit}`
    : view.exit !== undefined
      ? `${view.status} / exit ${view.exit}`
      : view.status;
  const prefix = `工具 ${view.tool} 失败（${status}）：`;
  const remaining = Math.min(200, maxChars) - prefix.length;
  if (remaining < 8) return { ok: false, reason: "diagnostic-not-complete" };

  const line = firstLine(view.diagnostic);
  const sentence = line.length <= remaining
    ? line
    : firstCompleteSentence(view.diagnostic, remaining);
  if (!sentence) return { ok: false, reason: "diagnostic-not-complete" };

  return {
    ok: true,
    tool: view.tool,
    status: view.status,
    ...(view.exit !== undefined ? { exit: view.exit } : {}),
    text: `${prefix}${sentence}`,
    digestHash: view.digestId,
    rawHash: view.rawHash,
  };
}

/** First complete sentence inside the remaining budget, or undefined. */
function firstCompleteSentence(value: string, max: number): string | undefined {
  const limit = Math.min(value.length, max);
  for (let index = 0; index < limit; index += 1) {
    const char = value[index];
    if (!/[。！？.!?]/.test(char)) continue;
    const next = value[index + 1];
    // CJK sentence punctuation is a boundary even without a following space.
    if (/[.!?]/.test(char) && next !== undefined && !/\s/.test(next)) continue;
    const sentence = value.slice(0, index + 1).trim();
    if (sentence.length > 0) return sentence;
  }
  return undefined;
}

export function digestMessageTools(
  message: SessionMessage,
  options: ToolDigestOptions = {},
): ToolDigest[] {
  const out: ToolDigest[] = [];
  for (const part of toolParts(message)) {
    const digest = digestToolPart(part, options);
    if (digest) out.push(digest);
  }
  return out;
}

function buildSummary(
  tool: string,
  input: Record_,
  output: string,
  ok: boolean,
  exit: number | undefined,
  options: Required<ToolDigestOptions>,
): string {
  switch (tool) {
    case "bash":
    case "shell": {
      const command = truncate(str(input.command) ?? str(input.cmd) ?? "", 90);
      if (ok) {
        const tail = lastLines(output, options.bashTailLines);
        return `bash $ ${command}${tail ? ` → ${truncate(tail, 40)}` : ""}`;
      }
      const reason = firstLine(output) || firstLine(str(input.stderr) ?? "");
      return `bash $ ${command} → 失败${exit !== undefined ? ` (exit ${exit})` : ""}${
        reason ? `: ${truncate(reason, 60)}` : ""
      }`;
    }
    case "read": {
      const path = str(input.filePath) ?? str(input.path);
      const lines = output ? output.split("\n").length : 0;
      return `read ${fileName(path)}${lines > 0 ? ` (${lines} 行)` : ""}`;
    }
    case "write": {
      const path = str(input.filePath) ?? str(input.path);
      return `write ${fileName(path)}`;
    }
    case "edit":
    case "patch":
    case "multiedit": {
      const path = str(input.filePath) ?? str(input.path);
      return `edit ${fileName(path)}${ok ? "" : " → 失败"}`;
    }
    case "grep": {
      const pattern = truncate(str(input.pattern) ?? str(input.query) ?? "", 60);
      const hits = output ? output.split("\n").filter((line) => line.trim().length > 0).length : 0;
      return `grep ${pattern}${hits > 0 ? ` → ${hits} 行` : " → 无命中"}`;
    }
    case "glob": {
      const pattern = truncate(str(input.pattern) ?? "", 60);
      const files = output ? output.split("\n").filter((line) => line.trim().length > 0).length : 0;
      return `glob ${pattern}${files > 0 ? ` → ${files} 个文件` : " → 无结果"}`;
    }
    case "webfetch": {
      const url = str(input.url) ?? "";
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        // keep the raw url text
      }
      return `fetch ${truncate(host, 60)}${ok ? "" : " → 失败"}`;
    }
    case "task": {
      const description = str(input.description) ?? str(input.prompt) ?? "";
      return `task ${truncate(description, 80)}${ok ? "" : " → 失败"}`;
    }
    default:
      return `${tool}${ok ? "" : " → 失败"}${output ? ` (${output.length} 字符输出)` : ""}`;
  }
}
