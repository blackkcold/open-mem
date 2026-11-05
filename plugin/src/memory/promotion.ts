import type { Item, Scope } from "../types.js";
import { textSimilarity } from "../fingerprint.js";

export interface PromotionCandidate {
  text: string;
  kind: Item["kind"];
  scope: Scope;
  taskOnly?: boolean;
  evidenceCount?: number;
  distinctSessions?: number;
}

export interface PromotionContext {
  target: "project" | "global";
  confirmedByUser?: boolean;
  projectKey?: string;
  existing: Item[];
}

export type PromotionResult =
  | { ok: true }
  | { ok: false; reason: string };

const VOLATILE_RE =
  /(?:\/Users\/|\/home\/|[A-Za-z]:\\|\bses_[A-Za-z0-9]+\b|\b(?:port|端口)\s*[:=]?\s*\d{2,5}\b|:\d{4,5}\b)/i;

/**
 * Promotion is deliberately manual and conservative in this phase. The gate
 * is pure so the UI, API and tests share exactly one policy.
 */
export function canPromote(
  candidate: PromotionCandidate,
  context: PromotionContext,
): PromotionResult {
  if (candidate.taskOnly) {
    return { ok: false, reason: "task-only" };
  }
  if (candidate.scope === "global") {
    return { ok: false, reason: "already global" };
  }
  if (context.target === "project" && candidate.scope !== "session") {
    return { ok: false, reason: "target must be higher" };
  }
  if (context.target === "project" && !context.projectKey) {
    return { ok: false, reason: "project key required" };
  }
  if (candidate.kind === "rule" && context.confirmedByUser !== true) {
    return { ok: false, reason: "rule requires approval" };
  }
  if (context.confirmedByUser !== true) {
    return { ok: false, reason: "manual approval required" };
  }
  if (/(?:本次|这次|当前任务|这个任务|this task|for now|one-off)/i.test(candidate.text)) {
    return { ok: false, reason: "task-only" };
  }
  if (context.target === "global" && VOLATILE_RE.test(candidate.text)) {
    return { ok: false, reason: "volatile identifier" };
  }

  const duplicate = context.existing.find(
    (item) =>
      item.scope === context.target &&
      (context.target !== "project" || item.projectKey === context.projectKey) &&
      textSimilarity(item.text, candidate.text) >= 0.92,
  );
  if (duplicate) {
    return { ok: false, reason: `duplicate of ${duplicate.id}` };
  }
  return { ok: true };
}
