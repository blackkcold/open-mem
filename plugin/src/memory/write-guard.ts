import { queueItemSnapshotVersion } from "../fingerprint.js";
import { sha16 } from "../util/text.js";
import { classifyRelation, type RelationKind } from "../relations.js";
import type { Item, QueueItem, Scope } from "../types.js";
import { sameScopeAndProject } from "./scope.js";

/**
 * One deterministic guard shared by approve, consolidate and promote.
 *
 * It never decides that a paraphrase is safe: it only reports the relations a
 * caller must handle. Callers own the policy (reject, queue, or require an
 * explicit acknowledgement), so the three write paths cannot drift apart.
 */
export interface WriteGuardCandidate {
  id?: string;
  title: string;
  text: string;
  kind: Item["kind"];
  scope: Scope;
  projectKey?: string;
  source?: Item["source"];
  sources?: Item["sources"];
}

export interface WriteGuardEntry {
  id: string;
  title: string;
  text: string;
  kind: Item["kind"];
  scope: Scope;
  projectKey?: string;
  status: string;
  source?: Item["source"];
  sources?: Item["sources"];
  /** Precomputed version; queue rows should pass their snapshot version. */
  version?: string;
}

export interface WriteConflict {
  id: string;
  title: string;
  relation: RelationKind;
  score: number;
  reasons: string[];
  /** Content version the caller must echo back when acknowledging. */
  version: string;
}

export interface WriteGuardResult {
  conflicts: WriteConflict[];
  /** Set when the guard cannot decide safely (for example, a missing projectKey). */
  unsafe?: string;
}

const RANK: Record<RelationKind, number> = {
  conflict: 0,
  "classification-mismatch": 1,
  covered: 2,
  exact: 3,
  partial: 4,
  related: 5,
  unknown: 6,
};

function entryVersion(entry: WriteGuardEntry): string {
  if (entry.version !== undefined) return entry.version;
  if (entry.status === "queue" && "reason" in entry) {
    return queueItemSnapshotVersion(entry as QueueItem);
  }
  // Same material fields as itemContentVersion, but tolerant of the string
  // status used by FingerprintEntry so the guard can consume entriesFor().
  return sha16(
    JSON.stringify([
      entry.title,
      entry.text,
      entry.kind,
      entry.scope,
      entry.projectKey,
      entry.status,
    ]),
  );
}

export function findWriteConflicts(
  candidate: WriteGuardCandidate,
  entries: Array<Item | QueueItem | WriteGuardEntry>,
  options: { excludeID?: string } = {},
): WriteGuardResult {
  if (candidate.scope === "project" && !candidate.projectKey) {
    return {
      conflicts: [],
      unsafe: "候选缺少 projectKey，无法判断项目范围",
    };
  }

  const conflicts: WriteConflict[] = [];
  for (const entry of entries) {
    if (entry.status === "archived") continue;
    if (entry.id === candidate.id) continue;
    if (entry.id === options.excludeID) continue;
    if (!sameScopeAndProject(entry, candidate)) continue;
    const relation = classifyRelation(
      { text: candidate.text, title: candidate.title, kind: candidate.kind },
      { text: entry.text, title: entry.title, kind: entry.kind },
    );
    // `unknown` is not evidence of a relation; surfacing it would turn every
    // unrelated row into an approval prompt.
    if (relation.relation === "unknown") continue;
    conflicts.push({
      id: entry.id,
      title: entry.title,
      relation: relation.relation,
      score: relation.score,
      reasons: relation.reasons,
      version: entryVersion(entry),
    });
  }

  conflicts.sort(
    (left, right) =>
      RANK[left.relation] - RANK[right.relation] ||
      right.score - left.score ||
      left.id.localeCompare(right.id),
  );
  return { conflicts };
}

/** Relations that block an approve/promote without any acknowledgement path. */
export function isHardWriteBlock(relation: RelationKind): boolean {
  return (
    relation === "exact" ||
    relation === "covered" ||
    relation === "classification-mismatch"
  );
}
