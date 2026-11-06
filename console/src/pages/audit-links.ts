/**
 * Pure link/route helpers for the audit ↔ approval relationship.
 *
 * A link is only produced from data the server already recorded: an audit
 * finding's `itemIDs` and a queue item's own `id`. Nothing here matches by
 * title, text or similarity, and nothing here mutates approval state.
 */

import type { MemoryGraphView } from "../types";
import { isMemoryGraphView } from "./memory-graph";

export type RouteTab =
  | "queue"
  | "skills"
  | "map"
  | "audit"
  | "health"
  | "settings";

const ROUTE_TABS: ReadonlySet<string> = new Set<RouteTab>([
  "queue",
  "skills",
  "map",
  "audit",
  "health",
  "settings",
]);

export interface ConsoleRoute {
  tab: RouteTab;
  queueItemID?: string;
  auditFindingID?: string;
  /** Report generation the finding belongs to; guards against reused finding ids. */
  auditReportAt?: string;
  /** Internal view for the memory graph tab. */
  graphView?: MemoryGraphView;
}

export interface QueueRefLike {
  id: string;
  title: string;
}

export interface AuditFindingLike {
  id: string;
  kind: string;
  title: string;
  itemIDs: string[];
}

export interface FindingRefLike {
  id: string;
  title: string;
  kind: string;
  severity: string;
  itemIDs: string[];
}

export interface AuditReportLike {
  generatedAt: string;
  findings: Array<{ id: string }>;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Parse a location hash. Legacy tab hashes (`#queue`, `#audit`, …) keep
 * working. Unknown or malformed hashes return null so the app keeps its
 * current view instead of guessing a destination.
 */
export function parseRouteHash(hash: string): ConsoleRoute | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const segments = raw.split("/");
  const tab = segments[0];
  if (!ROUTE_TABS.has(tab)) return null;

  if (tab === "map") {
    if (segments.length === 1) return { tab };
    if (segments.length !== 2 || segments[1] === "") return null;
    const view = decode(segments[1]);
    if (view === null || !isMemoryGraphView(view)) return null;
    return { tab, graphView: view };
  }

  if (tab === "queue") {
    if (segments.length === 1) return { tab };
    if (segments.length !== 2 || segments[1] === "") return null;
    const queueItemID = decode(segments[1]);
    if (queueItemID === null) return null;
    return { tab, queueItemID };
  }

  if (tab === "audit") {
    if (segments.length === 1) return { tab };
    if (segments[1] !== "finding") return null;
    if (segments.length < 3 || segments.length > 4) return null;
    const auditFindingID = decode(segments[2]);
    if (auditFindingID === null || auditFindingID === "") return null;
    if (segments.length === 3) return { tab, auditFindingID };
    const auditReportAt = decode(segments[3]);
    if (auditReportAt === null) return null;
    return { tab, auditFindingID, auditReportAt };
  }

  return { tab: tab as RouteTab };
}

export function queueItemLink(id: string): string {
  return `#queue/${encodeURIComponent(id)}`;
}

export function auditFindingLink(id: string, reportGeneratedAt: string): string {
  return `#audit/finding/${encodeURIComponent(id)}/${encodeURIComponent(reportGeneratedAt)}`;
}

export interface FindingQueueLinks {
  /** Queue entries that exist in the queue snapshot, by exact id. */
  links: QueueRefLike[];
  /** Ids that are provably queue ids (kind "queue") but are no longer in the queue. */
  missingQueueIDs: string[];
  /**
   * Ids that are not in the queue snapshot and whose domain is ambiguous
   * (memory, skill draft, shadow). They get an explicit note, never a queue link.
   */
  otherIDs: string[];
}

/**
 * Resolve a finding's evidence against the current queue snapshot.
 * `kind:"queue"` findings are produced from the queue alone, so an absent id
 * there is genuinely missing. Other findings mix memory/queue/shadow ids, so an
 * absent id is only reported as "not a queue entry" without guessing.
 */
export function resolveFindingQueueLinks(
  finding: AuditFindingLike,
  queue: QueueRefLike[],
): FindingQueueLinks {
  const byId = new Map(queue.map((entry) => [entry.id, entry]));
  const links: QueueRefLike[] = [];
  const missingQueueIDs: string[] = [];
  const otherIDs: string[] = [];
  const seen = new Set<string>();
  for (const id of finding.itemIDs) {
    if (seen.has(id)) continue;
    seen.add(id);
    const found = byId.get(id);
    if (found) links.push({ id: found.id, title: found.title });
    else if (finding.kind === "queue") missingQueueIDs.push(id);
    else otherIDs.push(id);
  }
  return { links, missingQueueIDs, otherIDs };
}

/** Findings whose recorded evidence contains this exact queue id. */
export function findingsForQueueItem(
  itemID: string,
  findings: FindingRefLike[],
): FindingRefLike[] {
  return findings.filter((finding) => finding.itemIDs.includes(itemID));
}

export type QueueTargetResolution =
  | "visible"
  | "filtered"
  | "stale-list"
  | "missing";

/**
 * Explain why a linked queue id is not currently shown. With a filter active,
 * an id present in the full queue but absent from the page is filtered out.
 * Without a filter, the full queue is newer than the rendered list, so the
 * only honest answer is that the list is stale — never "filtered".
 */
export function resolveQueueTarget(
  itemID: string,
  visible: QueueRefLike[],
  all: QueueRefLike[],
  filterActive: boolean,
): QueueTargetResolution {
  if (visible.some((entry) => entry.id === itemID)) return "visible";
  if (all.some((entry) => entry.id === itemID)) {
    return filterActive ? "filtered" : "stale-list";
  }
  return "missing";
}

export interface ConsumedTarget {
  itemID: string;
}

/** A deep link selects its target once; later list updates must not steal back. */
export function targetConsumed(
  consumed: ConsumedTarget | null | undefined,
  targetItemID: string | undefined,
): boolean {
  return Boolean(consumed && targetItemID && consumed.itemID === targetItemID);
}

export function consumeTarget(itemID: string): ConsumedTarget {
  return { itemID };
}

export type AuditTargetResolution =
  | { status: "none" }
  | { status: "loading" }
  | { status: "unversioned" }
  | { status: "stale" }
  | { status: "missing" }
  | { status: "current"; findingID: string };

/**
 * Finding ids are rebuilt by position on every audit run, so an id alone is
 * not proof across reports. A link is only followed when the report generation
 * matches; otherwise it is presented as expired.
 */
export function resolveAuditTarget(
  target: { id?: string; reportAt?: string } | undefined,
  report: AuditReportLike | undefined,
): AuditTargetResolution {
  if (!target?.id) return { status: "none" };
  if (!report) return { status: "loading" };
  if (target.reportAt === undefined) return { status: "unversioned" };
  if (target.reportAt !== report.generatedAt) return { status: "stale" };
  if (!report.findings.some((finding) => finding.id === target.id)) {
    return { status: "missing" };
  }
  return { status: "current", findingID: target.id };
}

export interface TargetCheckMark {
  key: string;
  /** Queue request generation the completed check belongs to. */
  generation: number;
}

/**
 * A deep-link target check may only be marked handled after it completed.
 * A newer queue request generation invalidates the mark so the target is
 * re-checked against the reloaded list instead of early-returning forever.
 */
export function targetCheckHandled(
  mark: TargetCheckMark | null | undefined,
  key: string,
  generation: number,
): boolean {
  return mark !== null && mark !== undefined && mark.key === key && mark.generation === generation;
}

export function markTargetCheck(key: string, generation: number): TargetCheckMark {
  return { key, generation };
}
