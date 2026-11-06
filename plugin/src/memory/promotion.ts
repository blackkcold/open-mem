import type { Item, Scope } from "../types.js";
import { classifyRelation } from "../relations.js";

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
  /(?:\/Users\/|\/home\/|[A-Za-z]:\\|\bses_[A-Za-z0-9]+\b|(?:\bport\b|端口)\s*(?:(?:[:=]|是|为)\s*)?\d{2,5}\b|:\d{4,5}\b)/i;

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

  for (const item of context.existing) {
    if (
      item.scope !== context.target ||
      (context.target === "project" && item.projectKey !== context.projectKey)
    ) {
      continue;
    }
    const relation = classifyRelation(
      { text: candidate.text, kind: candidate.kind },
      { text: item.text, kind: item.kind },
    );
    if (relation.relation === "classification-mismatch") {
      return { ok: false, reason: `classification mismatch with ${item.id}` };
    }
    if (relation.relation === "conflict") {
      return { ok: false, reason: `conflict with ${item.id}` };
    }
    if (relation.relation === "exact" || relation.relation === "covered") {
      return { ok: false, reason: `duplicate of ${item.id}` };
    }
  }
  return { ok: true };
}
