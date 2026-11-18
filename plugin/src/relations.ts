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
  titleScore: number;
  sameKind: boolean;
  identifiers: {
    candidate: string[];
    entry: string[];
    added: string[];
    missing: string[];
    /** Identifier slots whose local context matches but whose value changed. */
    replaced: Array<{ candidate: string; entry: string; slot: string }>;
  };
  negation: {
    candidate: number;
    entry: number;
    mismatch: boolean;
    /** Clause-level view: each marker together with the object it governs. */
    clauses: { candidate: NegationClause[]; entry: NegationClause[] };
  };
  reasons: string[];
}

export interface RelationEntry {
  text: string;
  kind?: Item["kind"];
  /** Optional title; a shared title is related evidence, never proof of coverage. */
  title?: string;
}

export interface NegationClause {
  marker: string;
  object: string;
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
const CLAUSE_SPLIT_RE = /[，。；;！？!?、\n\r]+/;
const COVERED_MIN_NORMALIZED = 6;
const SLOT_CONTEXT_BEFORE = 12;
const SLOT_CONTEXT_AFTER = 8;

/** Distinct negation phrases, used to check that a merge keeps each one. */
export function negationMarkers(text: string): string[] {
  return [...new Set((text.match(NEGATION_RE) ?? []).map((value) => value.toLowerCase()))].sort();
}

/** Distinct decisive qualifiers, used to check that a merge keeps each one. */
export function qualifierMarkers(text: string): string[] {
  return [...new Set((text.match(QUALIFIER_RE) ?? []).map((value) => value.toLowerCase()))].sort();
}

function clauseList(text: string): string[] {
  return text
    .split(CLAUSE_SPLIT_RE)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/**
 * Extract each negation marker and the object that follows it. The object is
 * compared later so "不要 nohup" and "不要 screen" are not treated as the same
 * ban just because they share a marker.
 */
export function negationClauses(text: string): NegationClause[] {
  const clauses: NegationClause[] = [];
  for (const clause of clauseList(text)) {
    const regex = new RegExp(NEGATION_RE.source, "gi");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(clause))) {
      const tail = clause
        .slice((match.index ?? 0) + match[0].length)
        .replace(/^[\s:：,，\-—]+/, "")
        .split(CLAUSE_SPLIT_RE)[0] ?? "";
      clauses.push({
        marker: match[0].toLowerCase(),
        object: normalizeForFingerprint(tail).slice(0, 24),
      });
    }
  }
  return clauses;
}

function clausePolarities(text: string): Array<{ negated: boolean; object: string }> {
  return clauseList(text).map((clause) => {
    const match = new RegExp(NEGATION_RE.source, "i").exec(clause);
    if (!match) return { negated: false, object: normalizeForFingerprint(clause) };
    const tail = clause
      .slice((match.index ?? 0) + match[0].length)
      .replace(/^[\s:：,，\-—]+/, "");
    return { negated: true, object: normalizeForFingerprint(tail) };
  });
}

/** Same banned/allowed object, allowing one wording to contain the other. */
export function sameNegationObject(left: string, right: string): boolean {
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length >= 3 && longer.includes(shorter)) return true;
  return textSimilarity(left, right) >= 0.5;
}

function polarityConflict(candidate: RelationEntry, entry: RelationEntry): boolean {
  const left = clausePolarities(candidate.text);
  const right = clausePolarities(entry.text);
  for (const candidateClause of left) {
    for (const entryClause of right) {
      if (candidateClause.negated === entryClause.negated) continue;
      if (sameNegationObject(candidateClause.object, entryClause.object)) return true;
    }
  }
  return false;
}

function differentNegationObjects(
  candidate: NegationClause[],
  entry: NegationClause[],
): boolean {
  if (candidate.length === 0 || entry.length === 0) return false;
  return !candidate.some((left) =>
    entry.some((right) => sameNegationObject(left.object, right.object)),
  );
}

interface IdentifierOccurrence {
  value: string;
  /** Local context, empty when there is not enough context to compare safely. */
  slot: string;
}

function normalizeIdentifier(value: string): string {
  return value.replace(/^0+(?=\d)/, "");
}

function identifierOccurrences(text: string): IdentifierOccurrence[] {
  const occurrences: IdentifierOccurrence[] = [];
  for (const match of text.matchAll(IDENTIFIER_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = normalizeForFingerprint(
      text.slice(Math.max(0, start - SLOT_CONTEXT_BEFORE), start),
    ).slice(-3);
    const after = normalizeForFingerprint(
      text.slice(end, end + SLOT_CONTEXT_AFTER),
    ).slice(0, 2);
    const slot = before.length >= 2 || after.length >= 1 ? `${before}|${after}` : "";
    occurrences.push({ value: normalizeIdentifier(match[0]), slot });
  }
  return occurrences;
}

function identifiersOf(text: string): string[] {
  return [...new Set(identifierOccurrences(text).map((occurrence) => occurrence.value))].sort();
}

function replacedIdentifiers(
  candidate: IdentifierOccurrence[],
  entry: IdentifierOccurrence[],
): Array<{ candidate: string; entry: string; slot: string }> {
  const replaced: Array<{ candidate: string; entry: string; slot: string }> = [];
  const used = new Set<number>();
  for (const left of candidate) {
    const index = entry.findIndex(
      (right, position) =>
        !used.has(position) &&
        right.slot.length > 0 &&
        right.slot === left.slot &&
        right.value !== left.value,
    );
    if (index < 0) continue;
    used.add(index);
    replaced.push({
      candidate: left.value,
      entry: entry[index].value,
      slot: left.slot,
    });
  }
  return [...new Map(replaced.map((entry) => [`${entry.candidate}|${entry.entry}|${entry.slot}`, entry])).values()];
}

/** Coverage needs a real subset with a minimum length, not a coincidental substring. */
function hasCoveredEvidence(left: string, right: string): boolean {
  if (left.length < COVERED_MIN_NORMALIZED) return false;
  if (!right.includes(left)) return false;
  return right.length - left.length >= 2;
}

function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

/** Shared normalized topic before the first identifier ("默认端口" in both). */
function commonIdentifierTopic(left: string, right: string): number {
  const leftIndex = left.search(IDENTIFIER_RE);
  const rightIndex = right.search(IDENTIFIER_RE);
  if (leftIndex < 0 || rightIndex < 0) return 0;
  const a = normalizeForFingerprint(left.slice(0, leftIndex));
  const b = normalizeForFingerprint(right.slice(0, rightIndex));
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
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

  const candidateOccurrences = identifierOccurrences(candidate.text);
  const entryOccurrences = identifierOccurrences(entry.text);
  const candidateIdentifiers = identifiersOf(candidate.text);
  const entryIdentifiers = identifiersOf(entry.text);
  const added = difference(candidateIdentifiers, entryIdentifiers);
  const missing = difference(entryIdentifiers, candidateIdentifiers);
  const replaced = replacedIdentifiers(candidateOccurrences, entryOccurrences);
  const candidateClauses = negationClauses(candidate.text);
  const entryClauses = negationClauses(entry.text);
  const candidateNegation = (candidate.text.match(NEGATION_RE) ?? []).length;
  const entryNegation = (entry.text.match(NEGATION_RE) ?? []).length;
  const negationMismatch = polarityConflict(candidate, entry);
  const differentBans = !negationMismatch && differentNegationObjects(candidateClauses, entryClauses);

  const score = Math.round(textSimilarity(candidate.text, entry.text) * 1000) / 1000;
  const topicScore = Math.round(
    textSimilarity(
      candidate.text.replace(IDENTIFIER_RE, ""),
      entry.text.replace(IDENTIFIER_RE, ""),
    ) * 1000,
  ) / 1000;
  const titleScore =
    candidate.title && entry.title
      ? Math.round(textSimilarity(candidate.title, entry.title) * 1000) / 1000
      : 0;
  const candidateCovered = left.length > 0 && right.includes(left);
  const entryCovered = right.length > 0 && left.includes(right);
  const identifierConflict = replaced.length > 0;

  const reasons: string[] = [];
  if (left.length > 0 && left === right) reasons.push("same normalized text");
  if (score >= 0.92) reasons.push(`lexical similarity ${score}`);
  if (!sameKind) reasons.push(`kind differs (${entry.kind} vs ${candidate.kind})`);
  if (identifierConflict) reasons.push("identifier slot replaced");
  else if (added.length > 0 || missing.length > 0) reasons.push("identifier values added or missing");
  if (negationMismatch) reasons.push("negation polarity conflicts on the same object");
  else if (differentBans) reasons.push("negation objects differ");
  if (candidateCovered && left !== right) reasons.push("candidate is contained in the existing entry");
  if (entryCovered && left !== right) reasons.push("existing entry is contained in the candidate");
  if (titleScore >= 0.6) reasons.push(`title similarity ${titleScore}`);

  const base = {
    score,
    topicScore,
    titleScore,
    sameKind,
    identifiers: {
      candidate: candidateIdentifiers,
      entry: entryIdentifiers,
      added,
      missing,
      replaced,
    },
    negation: {
      candidate: candidateNegation,
      entry: entryNegation,
      mismatch: negationMismatch,
      clauses: { candidate: candidateClauses, entry: entryClauses },
    },
    reasons,
  };

  if (left.length > 0 && left === right) {
    if (!sameKind) return { ...base, relation: "classification-mismatch" };
    if (identifierConflict || negationMismatch) return { ...base, relation: "conflict" };
    return { ...base, relation: "exact" };
  }

  if (score >= 0.92) {
    if (!sameKind) return { ...base, relation: "classification-mismatch" };
    if (identifierConflict || negationMismatch) return { ...base, relation: "conflict" };
    // High lexical overlap is not proof of equivalence. A changed object,
    // added clause or replaced word must stay visible; only normalized-equal
    // text is `exact`.
    return { ...base, relation: "partial" };
  }

  if (candidateCovered) {
    if (!sameKind) return { ...base, relation: "classification-mismatch" };
    if (identifierConflict || negationMismatch) return { ...base, relation: "conflict" };
    if (hasCoveredEvidence(left, right)) return { ...base, relation: "covered" };
    // A short rule inside a long paragraph is not coverage; keep the weaker
    // evidence instead of painting a green "already covered" chip.
    return { ...base, relation: score >= 0.35 ? "partial" : "related" };
  }

  if (entryCovered && score >= 0.5) {
    if (!sameKind) return { ...base, relation: "classification-mismatch" };
    if (identifierConflict || negationMismatch) return { ...base, relation: "conflict" };
    return { ...base, relation: "partial" };
  }

  if (identifierConflict) {
    if (!sameKind) return { ...base, relation: "classification-mismatch" };
    return { ...base, relation: "conflict" };
  }

  if (negationMismatch) {
    return { ...base, relation: "conflict" };
  }

  if (differentBans) {
    return { ...base, relation: "related" };
  }

  // A value removed on one side and added on the other is a replacement even
  // when the 3-character slot window differs ("是" vs "为", "改为", ...).
  // Added-only values stay supplementary and fall through to partial.
  if (
    added.length > 0 &&
    missing.length > 0 &&
    (score >= 0.35 ||
      topicScore >= 0.5 ||
      commonIdentifierTopic(candidate.text, entry.text) >= 4)
  ) {
    return {
      ...base,
      relation: sameKind ? "conflict" : "classification-mismatch",
    };
  }

  if (titleScore >= 0.6 && titleScore > score) {
    return { ...base, relation: "related" };
  }

  if (score >= 0.75) {
    if (!sameKind) return { ...base, relation: "classification-mismatch" };
    return { ...base, relation: "partial" };
  }

  if (score >= 0.3) {
    if (!sameKind) return { ...base, relation: "classification-mismatch" };
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
