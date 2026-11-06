import type { QueueItem, Strictness } from "./types.js";

export const BATCH_APPLY_CONFIDENCE_FLOOR = 0.9;
export const BATCH_HIGH_RISK = 0.6;
export const BATCH_HIGH_CONFLICT = 0.5;

/** Only these assessment strictness values are safe enough for a batch. */
const BATCH_ALLOWED_STRICTNESS: ReadonlySet<Strictness> = new Set([
  "preference",
  "workflow",
  "format",
]);

/** Rules and review candidates always need the single-item path. */
export function batchItemNeedsIndividualReview(item: QueueItem): boolean {
  return (
    item.kind === "rule" ||
    item.origin === "session-review" ||
    item.reviewID !== undefined
  );
}

/** Returns why an item is unsafe for batch suggestion application. */
export function batchSuggestionRejection(
  item: QueueItem,
  minConfidence: number,
): string | undefined {
  if (batchItemNeedsIndividualReview(item)) {
    return "rules and review candidates need individual review";
  }
  if (item.kind === "skill") return "skills need individual review";
  if (item.scope !== "project") return "only project scope may be batched";
  if (!item.projectKey) return "project scope needs an explicit projectKey";

  const suggestion = item.suggestion;
  if (!suggestion) return "no suggestion";
  if (suggestion.validation.ok !== true) return "suggestion is not validated";
  if (suggestion.action !== "create" && suggestion.action !== "keep_both") {
    return "merge, replace and duplicate rejection need individual review";
  }

  const confidence = suggestion.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return "confidence must be a finite number between 0 and 1";
  }
  const floor = Number.isFinite(minConfidence)
    ? Math.max(BATCH_APPLY_CONFIDENCE_FLOOR, minConfidence)
    : BATCH_APPLY_CONFIDENCE_FLOOR;
  if (confidence < floor) return "concentration is below the batch floor";

  const assessment = item.decision ?? item.jev;
  if (!assessment) return "missing decision assessment";
  const risk = assessment.risk;
  const conflict = assessment.conflict;
  if (
    typeof risk !== "number" ||
    !Number.isFinite(risk) ||
    risk < 0 ||
    risk > 1
  ) {
    return "risk must be a finite number between 0 and 1";
  }
  if (
    typeof conflict !== "number" ||
    !Number.isFinite(conflict) ||
    conflict < 0 ||
    conflict > 1
  ) {
    return "conflict must be a finite number between 0 and 1";
  }
  if (!BATCH_ALLOWED_STRICTNESS.has(assessment.strictness)) {
    return "strictness requires individual review";
  }
  if (risk >= BATCH_HIGH_RISK) return "high risk";
  if (conflict > BATCH_HIGH_CONFLICT) return "high conflict";
  return undefined;
}
