import type { Item, QueueItem, Scope } from "../types.js";
import {
  findWriteConflicts,
  isHardWriteBlock,
  type WriteConflict,
} from "./write-guard.js";

export interface PromotionCandidate {
  id?: string;
  title?: string;
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
  /** Pending queue rows are compared too, so a manual promotion cannot duplicate them. */
  queue?: QueueItem[];
}

export type PromotionResult =
  | { ok: true }
  | { ok: false; reason: string; conflicts?: WriteConflict[] };

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

  const guard = findWriteConflicts(
    {
      id: candidate.id,
      title: candidate.title ?? "",
      text: candidate.text,
      kind: candidate.kind,
      scope: context.target,
      projectKey: context.target === "project" ? context.projectKey : undefined,
    },
    [...context.existing, ...(context.queue ?? [])],
    { excludeID: candidate.id },
  );
  if (guard.unsafe) return { ok: false, reason: "project key required" };

  const hard = guard.conflicts.filter((entry) => isHardWriteBlock(entry.relation));
  if (hard.length > 0) {
    const first = hard[0];
    return {
      ok: false,
      reason:
        first.relation === "classification-mismatch"
          ? `classification mismatch with ${first.id}`
          : `duplicate of ${first.id}`,
      conflicts: hard,
    };
  }
  const conflictList = guard.conflicts.filter(
    (entry) => entry.relation === "conflict",
  );
  if (conflictList.length > 0) {
    return {
      ok: false,
      reason: `conflict with ${conflictList[0].id}`,
      conflicts: conflictList,
    };
  }
  return { ok: true };
}
