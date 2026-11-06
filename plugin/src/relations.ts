import type { Item } from "./types.js";
import { normalizeForFingerprint, textSimilarity } from "./fingerprint.js";

/**
 * Relation types used by dedupe, audit and the memory graph.
 *
 * This module is deliberately deterministic and local: it never decides that a
 * paraphrase is equivalent. It only protects exact/near-exact comparisons from
 * losing numbers, versions, ports, dates or polarity, and exposes "unknown"
 * instead of pretending that low lexical overlap means "not related".
 */
export type RelationKind =
  | "exact"
  | "classification-mismatch"
  | "conflict"
  | "covered"
  | "partial"
  | "related"
  | "unknown";

export interface RelationResult {
  relation: RelationKind;
  score: number;
  topicScore: number;
  sameKind: boolean;
  identifiers: {
    candidate: string[];
    entry: string[];
    added: string[];
    missing: string[];
  };
  negation: {
    candidate: number;
    entry: number;
    mismatch: boolean;
  };
  reasons: string[];
}

export interface RelationEntry {
  text: string;
  kind?: Item["kind"];
}

const IDENTIFIER_RE =
  /\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?\b|\d+(?:[.:/-]\d+)*/g;
/**
 * Negation markers are deliberately phrase-level. A bare "不" would turn
 * "不同/未来" into a false negation, so the list names the forms that change
 * a rule's polarity. "严禁/不准/禁用/拒绝" are common rule imperatives that
 * the previous list missed.
 */
const NEGATION_RE =
  /(?:不建议|不支持|不允许|不推荐|不使用|不采用|不需要|不应该|不可以|不启用|不开启|不安装|不再|不要|不得|不能|不可|严禁|不准|禁用|拒绝|不是|而不是|禁止|避免|无需|不用|请勿|切勿|别(?:用|再|做|把|让|急|忘)|勿|未(?:使用|启用|安装|配置|完成|通过)|\bnot\b|never|must not|do not|don't|avoid|no longer)/gi;
const QUALIFIER_RE =
  /(?:(?:^|[^不])仅|只能|只需|只有|只限|只可|除非|必须|至少|最多|至多|唯一)/gi;

/** Distinct negation phrases, used to check that a merge keeps each one. */
export function negationMarkers(text: string): string[] {
  return [...new Set((text.match(NEGATION_RE) ?? []).map((value) => value.toLowerCase()))].sort();
}

/** Distinct decisive qualifiers, used to check that a merge keeps each one. */
export function qualifierMarkers(text: string): string[] {
  return [...new Set((text.match(QUALIFIER_RE) ?? []).map((value) => value.toLowerCase()))].sort();
}

function identifiersOf(text: string): string[] {
  const values = text.match(IDENTIFIER_RE) ?? [];
  return [...new Set(values.map((value) => value.replace(/^0+(?=\d)/, "")))].sort();
}

function negationCount(text: string): number {
  return (text.match(NEGATION_RE) ?? []).length;
}

function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

/**
 * Compare a candidate with one existing entry. `kind` is optional because the
 * pre-classification dedupe pass does not know the candidate's kind yet; when
 * either side is unknown, kind is treated as compatible and the caller must
 * re-check after classification before dropping anything.
 */
export function classifyRelation(
  candidate: RelationEntry,
  entry: RelationEntry,
): RelationResult {
  const left = normalizeForFingerprint(candidate.text);
  const right = normalizeForFingerprint(entry.text);
  const sameKind =
    candidate.kind === undefined ||
    entry.kind === undefined ||
    candidate.kind === entry.kind;

  const candidateIdentifiers = identifiersOf(candidate.text);
  const entryIdentifiers = identifiersOf(entry.text);
  const added = difference(candidateIdentifiers, entryIdentifiers);
  const missing = difference(entryIdentifiers, candidateIdentifiers);
  const candidateNegation = negationCount(candidate.text);
  const entryNegation = negationCount(entry.text);
  const negationMismatch = candidateNegation > 0 !== entryNegation > 0;

  const score = Math.round(textSimilarity(candidate.text, entry.text) * 1000) / 1000;
  const topicScore = Math.round(
    textSimilarity(
      candidate.text.replace(IDENTIFIER_RE, ""),
      entry.text.replace(IDENTIFIER_RE, ""),
    ) * 1000,
  ) / 1000;
  const candidateCovered = left.length > 0 && right.includes(left);
  const entryCovered = right.length > 0 && left.includes(right);
  const identifierMismatch = added.length > 0 || missing.length > 0;

  const reasons: string[] = [];
  if (left.length > 0 && left === right) reasons.push("same normalized text");
  if (score >= 0.92) reasons.push(`lexical similarity ${score}`);
  if (!sameKind) reasons.push(`kind differs (${entry.kind} vs ${candidate.kind})`);
  if (identifierMismatch) reasons.push("numeric/identifier values differ");
  if (negationMismatch) reasons.push("negation differs");
  if (candidateCovered && left !== right) reasons.push("candidate is contained in the existing entry");
  if (entryCovered && left !== right) reasons.push("existing entry is contained in the candidate");

  const base = {
    score,
    topicScore,
    sameKind,
    identifiers: {
      candidate: candidateIdentifiers,
      entry: entryIdentifiers,
      added,
      missing,
    },
    negation: {
      candidate: candidateNegation,
      entry: entryNegation,
      mismatch: negationMismatch,
    },
    reasons,
  };

  if (left.length > 0 && left === right) {
    if (!sameKind) return { ...base, relation: "classification-mismatch" };
    if (identifierMismatch || negationMismatch) return { ...base, relation: "conflict" };
    return { ...base, relation: "exact" };
  }

  if (score >= 0.92) {
    if (!sameKind) return { ...base, relation: "classification-mismatch" };
    if (identifierMismatch || negationMismatch) return { ...base, relation: "conflict" };
    // High lexical overlap is not proof of equivalence. A changed object,
    // added clause or replaced word must stay visible; only normalized-equal
    // text is `exact`.
    return { ...base, relation: "partial" };
  }

  if (candidateCovered) {
    if (!sameKind) return { ...base, relation: "classification-mismatch" };
    if (identifierMismatch || negationMismatch) return { ...base, relation: "conflict" };
    return { ...base, relation: "covered" };
  }

  if (entryCovered && score >= 0.5) {
    if (!sameKind) return { ...base, relation: "classification-mismatch" };
    if (identifierMismatch || negationMismatch) return { ...base, relation: "conflict" };
    return { ...base, relation: "partial" };
  }

  if (identifierMismatch && (score >= 0.35 || topicScore >= 0.5)) {
    return { ...base, relation: "conflict" };
  }

  if (score >= 0.75) {
    if (!sameKind) return { ...base, relation: "classification-mismatch" };
    if (identifierMismatch || negationMismatch) return { ...base, relation: "conflict" };
    return { ...base, relation: "partial" };
  }

  if (score >= 0.3) {
    if (!sameKind) return { ...base, relation: "classification-mismatch" };
    if (identifierMismatch || negationMismatch) return { ...base, relation: "conflict" };
    return { ...base, relation: "related" };
  }

  return { ...base, relation: "unknown" };
}

export function isExactRelation(relation: RelationResult): boolean {
  return relation.relation === "exact" && relation.sameKind;
}

export function relationLabel(relation: RelationKind): string {
  switch (relation) {
    case "exact":
      return "完全重复";
    case "classification-mismatch":
      return "分类不一致";
    case "conflict":
      return "数值或极性冲突";
    case "covered":
      return "已被覆盖";
    case "partial":
      return "部分重合";
    case "related":
      return "相关";
    case "unknown":
      return "无法判断";
  }
}
