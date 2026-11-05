import type { ReviewCandidate, ReviewEvidence, ReviewType } from "../types.js";

export class ReviewFormatError extends Error {
  constructor(
    message: string,
    readonly raw = "",
  ) {
    super(message);
    this.name = "ReviewFormatError";
  }
}

export interface ParsedReview {
  summary: string[];
  candidates: ReviewCandidate[];
  openQuestions: string[];
}

const TYPES: ReviewType[] = ["fact", "preference", "rule", "decision", "learning", "skill"];

export function parseReview(raw: string): ParsedReview {
  const json = extractJson(raw);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ReviewFormatError("复盘模型返回的不是合法 JSON", raw.slice(0, 500));
  }
  if (!isRecord(value)) {
    throw new ReviewFormatError("复盘模型返回的 JSON 不是对象", raw.slice(0, 500));
  }
  if (!Array.isArray(value.candidates)) {
    throw new ReviewFormatError("缺少 candidates 数组", raw.slice(0, 500));
  }

  const candidates: ReviewCandidate[] = [];
  for (const entry of value.candidates) {
    if (!isRecord(entry)) continue;
    const type =
      typeof entry.type === "string" && TYPES.includes(entry.type as ReviewType)
        ? (entry.type as ReviewType)
        : undefined;
    if (!type) continue;
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (!text) continue;
    const confidence =
      typeof entry.confidence === "number" && Number.isFinite(entry.confidence)
        ? Math.min(1, Math.max(0, entry.confidence))
        : 0;
    const steps = stringArray(entry.steps).slice(0, 8);
    candidates.push({
      type,
      text,
      scope:
        entry.scope === "project"
          ? "project"
          : entry.scope === "global"
            ? "global"
            : "session",
      confidence,
      evidence: parseEvidence(entry.evidence),
      ...(entry.task_only === true ? { taskOnly: true } : {}),
      ...(typeof entry.scope_evidence === "string" && entry.scope_evidence.trim()
        ? { scopeEvidence: entry.scope_evidence.trim() }
        : {}),
      ...(steps.length > 0 ? { steps } : {}),
    });
  }

  return {
    summary: stringArray(value.summary).slice(0, 8),
    candidates,
    openQuestions: stringArray(value.openQuestions).slice(0, 6),
  };
}

function parseEvidence(value: unknown): ReviewEvidence[] {
  if (!Array.isArray(value)) return [];
  const out: ReviewEvidence[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const messageID = typeof entry.messageID === "string" ? entry.messageID.trim() : "";
    const quote = typeof entry.quote === "string" ? entry.quote.trim() : "";
    const kind = entry.kind === "tool" ? "tool" : entry.kind === "user" ? "user" : undefined;
    if (!messageID || !quote || !kind) continue;
    out.push({ messageID, quote, kind });
  }
  return out.slice(0, 3);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
