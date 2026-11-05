import type { DecisionResult, HookRecord, ItemKind, ReviewType } from "../types.js";

/** Map a review candidate type onto the existing item kinds. */
export function reviewKind(type: ReviewType | undefined): ItemKind {
  switch (type) {
    case "rule":
      return "rule";
    case "skill":
      return "skill";
    case "preference":
      return "preference";
    default:
      return "fact";
  }
}

/**
 * Session-review candidates never go through System One: the review model has
 * already classified them and every claim carries a verbatim quote. This keeps
 * the per-candidate cost at zero and makes the routing deterministic.
 */
export function reviewDecision(hook: HookRecord): DecisionResult {
  return {
    kind: reviewKind(hook.reviewType),
    duplicate: 0,
    safeAuto: 0,
    risk: 0,
    confidence: hook.reviewConfidence ?? 0.8,
    strictness: "unknown",
    reasons: [`session-review:${hook.reviewType ?? "fact"}`],
    source: "review",
    mergeAction: "create",
  };
}
