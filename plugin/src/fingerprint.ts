import type {
  DecisionNeighbor,
  Item,
  QueueItem,
  ShadowRecord,
} from "./types.js";
import { bigrams, compact, jaccard } from "./linter.js";

export interface FingerprintEntry {
  id: string;
  title: string;
  text: string;
  kind: Item["kind"];
  scope: Item["scope"];
  status: string;
}

export function fingerprintText(text: string): string {
  const value = normalizeForFingerprint(text);
  const grams = [...bigrams(value)];
  if (grams.length === 0) return "0".repeat(16);
  const vector = new Array<number>(64).fill(0);
  for (const gram of grams) {
    const hash = hash64(gram);
    for (let bit = 0; bit < 64; bit++) {
      vector[bit] += (hash >> BigInt(bit)) & 1n ? 1 : -1;
    }
  }
  let output = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (vector[bit] > 0) output |= 1n << BigInt(bit);
  }
  return output.toString(16).padStart(16, "0");
}

export function hammingDistance(left: string, right: string): number {
  if (left.length === 0 || right.length === 0) return 64;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value !== 0n) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

export function textSimilarity(left: string, right: string): number {
  const a = bigrams(normalizeForFingerprint(left));
  const b = bigrams(normalizeForFingerprint(right));
  return jaccard(a, b);
}

export function isExactDuplicate(left: string, right: string): boolean {
  return (
    hammingDistance(fingerprintText(left), fingerprintText(right)) <= 3 ||
    textSimilarity(left, right) >= 0.92
  );
}

export function collectNeighbors(
  candidate: string,
  entries: FingerprintEntry[],
  limit = 3,
): DecisionNeighbor[] {
  const candidateHash = fingerprintText(candidate);
  const candidateBigrams = bigrams(normalizeForFingerprint(candidate));
  const scored = entries.map((entry) => {
    const hashScore = 1 - hammingDistance(candidateHash, fingerprintText(entry.text)) / 64;
    const lexical = jaccard(candidateBigrams, bigrams(normalizeForFingerprint(entry.text)));
    return {
      ...entry,
      similarity: Math.round(Math.max(hashScore, lexical) * 1000) / 1000,
    };
  });
  return scored
    .filter((entry) => entry.similarity >= 0.35)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, limit);
}

export function entriesFor(
  items: Item[],
  queue: QueueItem[],
  shadow: ShadowRecord[],
): FingerprintEntry[] {
  return [
    ...items
      .filter((item) => item.status !== "archived")
      .map((item) => ({
        id: item.id,
        title: item.title,
        text: item.text,
        kind: item.kind,
        scope: item.scope,
        status: item.status,
      })),
    ...queue.map((item) => ({
      id: item.id,
      title: item.title,
      text: item.text,
      kind: item.kind,
      scope: item.scope,
      status: "queue",
    })),
    ...shadow.map((record) => ({
      id: record.id,
      title: record.title,
      text: record.candidate,
      kind: record.kind,
      scope: record.scope,
      status: record.falsePositive ? "false_positive" : "shadow",
    })),
  ];
}

export function normalizeForFingerprint(text: string): string {
  return compact(text)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function hash64(value: string): bigint {
  let hash = 1469598103934665603n;
  const prime = 1099511628211n;
  const mask = (1n << 64n) - 1n;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash;
}
