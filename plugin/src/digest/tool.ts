import type { SessionMessage } from "../types.js";
import { redactText } from "../redact.js";
import { clipMiddle, fileName, firstLine, lastLines, sha16, truncate } from "../util/text.js";

export interface ToolDigest {
  /** Content address of the redacted output; stable across re-reads. */
  id: string;
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
    if (isRecord(part) && part.type === "tool" && typeof part.tool === "string") {
      out.push(part);
    }
  }
  return out;
}

/**
 * Deterministic, model-free digest of one tool call. Raw output never leaves
 * this function: it is clipped, redacted, then reduced to a single line.
 */
export function digestToolPart(
  part: Record_,
  options: ToolDigestOptions = {},
): ToolDigest | undefined {
  const opts = { ...DEFAULT_DIGEST_OPTIONS, ...options };
  const tool = str(part.tool);
  if (!tool) return undefined;

  const state = isRecord(part.state) ? part.state : {};
  const input = isRecord(state.input) ? state.input : {};
  const metadata = isRecord(state.metadata) ? state.metadata : {};
  const status = str(state.status) ?? "completed";
  const rawOutput = str(state.output) ?? str(metadata.output) ?? str(part.text) ?? "";
  const redacted = redactText(clipMiddle(rawOutput, opts.maxOutputChars)).text;
  const exit = num(metadata.exit) ?? num(metadata.exitCode) ?? num(state.exitCode);
  const ok = status !== "error" && (exit === undefined || exit === 0);

  const signals = [`status:${status}`];
  if (exit !== undefined) signals.push(`exit:${exit}`);

  const summary = truncate(
    redactText(buildSummary(tool, input, redacted, ok, exit, opts)).text,
    opts.maxChars,
  );
  return {
    id: sha16(`${tool}|${ok ? "ok" : "err"}|${redacted}`),
    tool,
    ok,
    summary,
    signals,
    chars: rawOutput.length,
  };
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
