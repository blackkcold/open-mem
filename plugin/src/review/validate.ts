import type { AutoMemConfig, ItemKind, ReviewCandidate, ReviewType, Scope } from "../types.js";
import type { ReviewInput } from "./input.js";
import { compact, lintText } from "../linter.js";
import { textSimilarity } from "../fingerprint.js";
import { classifyScope } from "../memory/scope.js";

const EXPLICIT_GLOBAL_RE =
  /(?:所有项目|跨项目|所有仓库|每个项目|all projects|across projects|every project)/i;

/**
 * The review model names a scope, but it does not get to define it. Keep the
 * model's narrower choices, and upgrade nothing without deterministic
 * evidence: explicit cross-project language or a literal user quote that
 * carries it. Everything else falls back to the deterministic classifier.
 */
export function normalizeReviewScope(
  candidate: ReviewCandidate,
  input: ReviewInput,
): Scope {
  if (candidate.taskOnly || candidate.scope === "session") return "session";
  // A model may paraphrase a project-local sentence into "all projects".
  // Trust the literal user evidence, not the candidate's wording, for an
  // upgrade to global.
  const evidenceScope = classifyScope(userEvidenceText(candidate, input), "project");
  if (candidate.scope === "global") {
    if (evidenceScope === "global") return "global";
    if (scopeEvidenceSupportsGlobal(candidate, input)) return "global";
    return evidenceScope === "project" ? "project" : "session";
  }
  // A project claim is narrower than global. Keep it unless the evidence is
  // explicitly task-only; accept.ts will downgrade it to a session note when
  // no projectKey exists.
  return evidenceScope === "session" ? "session" : "project";
}

function userEvidenceText(
  candidate: ReviewCandidate,
  input: ReviewInput,
): string {
  return candidate.evidence
    .filter((entry) => entry.kind === "user")
    .map((entry) => input.sources[entry.messageID]?.user ?? "")
    .filter(Boolean)
    .join(" ");
}

function scopeEvidenceSupportsGlobal(
  candidate: ReviewCandidate,
  input: ReviewInput,
): boolean {
  const evidence = candidate.scopeEvidence?.trim() ?? "";
  if (!evidence || !EXPLICIT_GLOBAL_RE.test(evidence)) return false;
  return candidate.evidence.some((entry) => {
    if (entry.kind !== "user") return false;
    return input.sources[entry.messageID]?.user?.includes(evidence) ?? false;
  });
}

export interface ReviewValidationResult {
  accepted: ReviewCandidate[];
  dropped: Array<{ type: ReviewType; text: string; reason: string }>;
}

const TYPE_RANK: Record<ReviewType, number> = {
  rule: 0,
  decision: 1,
  learning: 2,
  preference: 3,
  fact: 4,
  skill: 5,
};

/**
 * Deterministic gate. A candidate survives only when every claim is backed by
 * a literal quote that exists in the exact text the model was shown. No second
 * model call is used to judge quality.
 */
export function validateReviewCandidates(
  candidates: ReviewCandidate[],
  input: ReviewInput,
  config: AutoMemConfig,
): ReviewValidationResult {
  const accepted: ReviewCandidate[] = [];
  const dropped: ReviewValidationResult["dropped"] = [];
  const seen: string[] = [];

  for (const candidate of candidates) {
    // Resolve the scope before lint: a global claim that is really a project
    // rule must not be rejected merely because global scope forbids an
    // absolute path.
    const scope = normalizeReviewScope(candidate, input);
    const normalized = scope === candidate.scope ? candidate : { ...candidate, scope };
    const reason = rejectReason(normalized, input, config, seen);
    if (reason) {
      dropped.push({ type: normalized.type, text: normalized.text, reason });
      continue;
    }
    seen.push(normalized.text);
    accepted.push(normalized);
  }

  accepted.sort(
    (left, right) =>
      right.confidence - left.confidence || TYPE_RANK[left.type] - TYPE_RANK[right.type],
  );

  const capped = accepted.slice(0, config.review.maxCandidates);
  for (const extra of accepted.slice(capped.length)) {
    dropped.push({ type: extra.type, text: extra.text, reason: "over candidate cap" });
  }
  return { accepted: capped, dropped };
}

function rejectReason(
  candidate: ReviewCandidate,
  input: ReviewInput,
  config: AutoMemConfig,
  seen: string[],
): string | undefined {
  if (candidate.confidence < config.review.minConfidence) {
    return `confidence ${candidate.confidence.toFixed(2)} below floor`;
  }
  const text = compact(candidate.text);
  if (text.length < 8) return "too short";
  if (text.includes("[redacted")) return "contains redacted content";

  const kind = kindFor(candidate.type);
  const maxChars =
    kind === "rule" ? config.thresholds.ruleMaxChars : config.thresholds.memoryMaxChars;
  const lint = lintText({
    title: text.slice(0, config.thresholds.titleMaxChars),
    text,
    kind,
    scope: candidate.scope,
    maxChars,
    titleMaxChars: config.thresholds.titleMaxChars,
  });
  if (!lint.ok) return `lint: ${lint.errors.join("; ")}`;

  for (const quote of seen) {
    if (textSimilarity(quote, text) >= 0.92) return "duplicate candidate";
  }

  if (candidate.evidence.length === 0) return "no evidence";
  for (const evidence of candidate.evidence) {
    const source = input.sources[evidence.messageID];
    if (!source) return `unknown message ${evidence.messageID}`;
    if (evidence.quote.length < 4) return "quote too short";
    if (evidence.kind === "user") {
      if (!source.user || !source.user.includes(evidence.quote)) {
        return "user quote is not a literal substring";
      }
    } else {
      const hit = source.tools.find((tool) => tool.text.includes(evidence.quote));
      if (!hit) return "tool quote is not a literal substring";
    }
  }

  const userEvidence = candidate.evidence.some((evidence) => {
    if (evidence.kind !== "user") return false;
    return input.sources[evidence.messageID]?.user?.includes(evidence.quote) ?? false;
  });
  const toolEvidence = candidate.evidence.flatMap((evidence) => {
    if (evidence.kind !== "tool") return [];
    const tools = input.sources[evidence.messageID]?.tools ?? [];
    const hit = tools.find((tool) => tool.text.includes(evidence.quote));
    return hit ? [hit] : [];
  });

  if (candidate.type === "learning") {
    if (!toolEvidence.some((tool) => !tool.ok)) {
      return "learning needs a failing tool quote";
    }
    return undefined;
  }
  if (candidate.type === "skill") {
    if ((candidate.steps?.length ?? 0) < 2) return "skill needs at least 2 steps";
    if (!userEvidence) return "skill needs a user quote";
    if (!toolEvidence.some((tool) => tool.ok)) return "skill needs a successful tool quote";
    return undefined;
  }
  if (!userEvidence) return `${candidate.type} needs a user quote`;
  return undefined;
}

function kindFor(type: ReviewType): ItemKind {
  if (type === "rule") return "rule";
  if (type === "skill") return "skill";
  if (type === "preference") return "preference";
  return "fact";
}
