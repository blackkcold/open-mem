import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { ChangeInput } from "../changes.js";
import type {
  ChangeEvent,
  EvidenceRef,
  ExtractQuarantineRecord,
  GlobalCandidate,
  Item,
  LifecycleStatus,
  RetiredSource,
  RetiredSourceItem,
  RetiredSourceState,
  SourceRef,
} from "../types.js";
import type { Store } from "../store.js";
import { newId } from "../store.js";
import { itemContentVersion } from "../fingerprint.js";
import { compact } from "../linter.js";
import { rebuildAutoFiles } from "../rebuild.js";
import { sha16 } from "../util/text.js";
import { extractClaimKey, parseExtractClaim } from "../extract/admission.js";

export const RETIRED_SOURCE_MAX_ROWS = 2_000;
export const RETIRED_SOURCE_MAX_BYTES = 200 * 1024;
export const GLOBAL_CANDIDATE_MAX_ROWS = 200;
export const GLOBAL_CANDIDATE_MAX_BYTES = 200 * 1024;
export const GLOBAL_CANDIDATE_TTL_MS = 90 * 86_400_000;
export const EXTRACT_QUARANTINE_MAX_ROWS = 200;
export const EXTRACT_QUARANTINE_MAX_BYTES = 200 * 1024;
export const EXTRACT_QUARANTINE_TTL_MS = 72 * 60 * 60 * 1000;

export type LifecycleRecordChange = (input: ChangeInput) => Promise<ChangeEvent>;

function requireTransaction(store: Store, operation: string): void {
  if (!store.inTransaction) throw new Error(`${operation} must run inside store.transaction`);
}

export function retiredSourceKey(sessionID: string, messageID: string): string {
  return `${sessionID}\u0000${messageID}`;
}

function itemReferencesMessage(item: Item, sessionID: string, messageID: string): boolean {
  const refs = item.evidenceRefs ?? [];
  if (refs.some((ref) => ref.sessionID === sessionID && ref.messageID === messageID)) return true;
  const sources = [item.source, ...(item.sources ?? [])];
  return sources.some((source) => source.sessionID === sessionID && source.messageID === messageID);
}

function retiredRow(rows: RetiredSource[], sessionID: string, messageID: string): RetiredSource | undefined {
  return rows.find((row) => row.sessionID === sessionID && row.messageID === messageID);
}

function retiredByBarrier(state: RetiredSourceState, observedAt?: number): boolean {
  return state.blockedAt !== undefined && (observedAt === undefined || observedAt <= state.blockedAt);
}

/** Message-level protection is intentionally stronger than quote/source hashes. */
export async function isSourceRetired(
  store: Store,
  sessionID: string,
  messageID: string,
  observedAt?: number,
): Promise<boolean> {
  const [rows, state] = await Promise.all([
    store.listRetiredSources(),
    store.readRetiredSourceState(),
  ]);
  if ((retiredRow(rows, sessionID, messageID)?.items.length ?? 0) > 0) return true;
  if (!retiredByBarrier(state, observedAt)) return false;

  // A capacity barrier only blocks re-learning from old evidence. Explicit
  // restore/reactivate remains available through its P01 item transaction;
  // an unrelated active item must never release this message-level barrier.
  return true;
}

export async function sourceEpoch(
  store: Store,
  sessionID: string,
  messageID: string,
  supplied?: { items: Item[]; suppressions: Awaited<ReturnType<Store["listSuppressions"]>> },
): Promise<string> {
  const [rows, state, items, suppressions] = await Promise.all([
    store.listRetiredSources(),
    store.readRetiredSourceState(),
    supplied ? Promise.resolve(supplied.items) : store.listItems(),
    supplied ? Promise.resolve(supplied.suppressions) : store.listSuppressions(),
  ]);
  const sourceRows = items
    .filter((item) => itemReferencesMessage(item, sessionID, messageID))
    .map((item) => [
      item.id,
      item.changeID ?? "",
      itemContentVersion(item),
      sha16(JSON.stringify(item.evidenceRefs ?? [])),
    ])
    .sort((left, right) => left[0].localeCompare(right[0]));
  const suppressionRows = suppressions
    .filter((row) => row.hookKey.startsWith(`${sessionID}|${messageID}|`) ||
      row.hookKey.startsWith(`review|${sessionID}|${messageID}|`))
    .map((row) => [row.hookKey, row.textHash, row.itemID, row.until ?? ""])
    .sort((left, right) => left[0].localeCompare(right[0]));
  const retired = retiredRow(rows, sessionID, messageID);
  return sha16(JSON.stringify({
    key: retiredSourceKey(sessionID, messageID),
    retirement: retired ? [retired.version, retired.items, retired.quoteHashes] : null,
    barrier: [state.epoch, state.blockedAt ?? null, state.reason ?? null],
    sourceRows,
    suppressionRows,
  }));
}

function itemSourcesForRetirement(
  item: Item,
  reason: RetiredSourceItem["reason"],
  before?: Item,
): Array<{ sessionID: string; messageID: string; quoteHash?: string; claimKey?: string; sourceKey?: string }> {
  const beforeKeys = new Set((before?.evidenceRefs ?? []).map((ref) => ref.sourceKey));
  const refs = (item.evidenceRefs ?? []).filter((ref) =>
    reason !== "revert" || before === undefined || !beforeKeys.has(ref.sourceKey),
  );
  const fromRefs = refs.flatMap((ref) => ref.sessionID && ref.messageID ? [{
    sessionID: ref.sessionID,
    messageID: ref.messageID,
    quoteHash: ref.quoteHash,
    claimKey: ref.claimKey,
    sourceKey: ref.sourceKey,
  }] : []);
  if (fromRefs.length > 0) return fromRefs;

  const sourceList: SourceRef[] = reason === "revert" && before
    ? [item.source]
    : [item.source, ...(item.sources ?? [])];
  if (reason === "revert" && before !== undefined && fromRefs.length === 0 &&
      (item.evidenceRefs?.length ?? 0) > 0) {
    // Evidence-bearing updates retire only the newly added refs. If none were
    // added, do not retire the older version's source by fallback.
    return [];
  }
  return sourceList.flatMap((source) => source.sessionID && source.messageID ? [{
    sessionID: source.sessionID,
    messageID: source.messageID,
  }] : []);
}

function retiredBytes(rows: RetiredSource[]): number {
  return Buffer.byteLength(rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
}

/** Persist source tombstones in the same P01 transaction; capacity never blocks stop/undo. */
export async function retireItemSources(
  store: Store,
  item: Item,
  reason: RetiredSourceItem["reason"],
  changeID: string,
  before?: Item,
): Promise<{ sourceKeys: Set<string>; evidenceRefIDs: Set<string>; blocked: boolean }> {
  requireTransaction(store, "retireItemSources");
  const sources = itemSourcesForRetirement(item, reason, before);
  const sourceKeys = new Set(sources.map((source) => retiredSourceKey(source.sessionID, source.messageID)));
  const evidenceRefIDs = new Set(sources.flatMap((source) => source.sourceKey ? [source.sourceKey] : []));
  if (sources.length === 0) return { sourceKeys, evidenceRefIDs, blocked: false };

  const rows = await store.listRetiredSources();
  const next = structuredClone(rows);
  const now = new Date().toISOString();
  for (const source of sources) {
    const index = next.findIndex((row) => row.sessionID === source.sessionID && row.messageID === source.messageID);
    const prior = index >= 0 ? next[index] : undefined;
    const entry: RetiredSourceItem = {
      itemID: item.id,
      changeID,
      reason,
      ...(source.claimKey ? { claimKey: source.claimKey } : {}),
    };
    const items = [...(prior?.items ?? []).filter((value) => value.itemID !== item.id), entry];
    const quoteHashes = [...new Set([
      ...(prior?.quoteHashes ?? []),
      ...(source.quoteHash ? [source.quoteHash] : []),
    ])].slice(-16);
    const row: RetiredSource = {
      sessionID: source.sessionID,
      messageID: source.messageID,
      items,
      quoteHashes,
      firstRetiredAt: prior?.firstRetiredAt ?? now,
      lastRetiredAt: now,
      version: (prior?.version ?? 0) + 1,
    };
    if (index >= 0) next[index] = row;
    else next.push(row);
  }

  const overflow = next.length > RETIRED_SOURCE_MAX_ROWS || retiredBytes(next) > RETIRED_SOURCE_MAX_BYTES;
  const oldState = await store.readRetiredSourceState();
  if (overflow) {
    // Keep every previously valid tombstone. A fixed-size barrier blocks old
    // evidence by host message time; new messages can continue after the cutoff.
    await store.writeRetiredSourceState({
      epoch: oldState.epoch + 1,
      blockedAt: Date.now(),
      reason: "retired-source-capacity",
    });
    await store.appendChangelog({
      action: "retired_source_capacity_blocked",
      count: rows.length,
      bytes: retiredBytes(rows),
      sourceCount: sources.length,
    });
    return { sourceKeys, evidenceRefIDs, blocked: true };
  }
  await store.writeRetiredSources(next);
  await store.writeRetiredSourceState({ epoch: oldState.epoch + 1, ...(oldState.blockedAt !== undefined ? { blockedAt: oldState.blockedAt, reason: oldState.reason } : {}) });
  return { sourceKeys, evidenceRefIDs, blocked: false };
}

/** Explicit restore removes only this item's message-level retirement entries. */
export async function releaseRetiredItem(store: Store, itemID: string): Promise<number> {
  requireTransaction(store, "releaseRetiredItem");
  const rows = await store.listRetiredSources();
  let removed = 0;
  const next: RetiredSource[] = [];
  for (const row of rows) {
    const items = row.items.filter((entry) => entry.itemID !== itemID);
    removed += row.items.length - items.length;
    if (items.length > 0) next.push({ ...row, items, version: row.version + 1, lastRetiredAt: new Date().toISOString() });
  }
  if (removed > 0) {
    await store.writeRetiredSources(next);
    const state = await store.readRetiredSourceState();
    await store.writeRetiredSourceState({
      epoch: state.epoch + 1,
      ...(state.blockedAt !== undefined ? { blockedAt: state.blockedAt, reason: state.reason } : {}),
    });
  }
  return removed;
}

function candidateBytes(rows: GlobalCandidate[]): number {
  return Buffer.byteLength(rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
}

export async function addGlobalCandidate(
  store: Store,
  evidenceRef: EvidenceRef,
  now = Date.now(),
): Promise<boolean> {
  requireTransaction(store, "addGlobalCandidate");
  if (!evidenceRef.claimKey || !evidenceRef.repoIdentity || !evidenceRef.originProjectKey ||
      evidenceRef.claimProjectRelative === true || evidenceRef.explicitGlobal === true) return false;
  const rows = await store.listGlobalCandidates();
  if (rows.some((row) => row.evidenceRefID === evidenceRef.sourceKey && row.claimKey === evidenceRef.claimKey)) return true;
  const candidate: GlobalCandidate = {
    claimKey: evidenceRef.claimKey,
    evidenceRefID: evidenceRef.sourceKey,
    quoteHash: evidenceRef.quoteHash,
    repoIdentity: evidenceRef.repoIdentity,
    originProjectKey: evidenceRef.originProjectKey,
    createdAt: new Date(now).toISOString(),
  };
  const next = [...rows, candidate];
  const state = await store.readGlobalCandidateState();
  if (next.length > GLOBAL_CANDIDATE_MAX_ROWS || candidateBytes(next) > GLOBAL_CANDIDATE_MAX_BYTES) {
    if (!state.blocked) {
      await store.writeGlobalCandidateState({ epoch: state.epoch + 1, blocked: true, reason: "global-candidate-capacity" });
      await store.appendChangelog({
        action: "global_candidate_capacity_blocked",
        count: rows.length,
        bytes: candidateBytes(rows),
      });
    }
    return false;
  }
  await store.writeGlobalCandidates(next);
  return true;
}

function uniqueEvidenceRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const bySource = new Map<string, EvidenceRef>();
  for (const ref of refs) if (!bySource.has(ref.sourceKey)) bySource.set(ref.sourceKey, ref);
  return [...bySource.values()];
}

function claimProjectionParts(item: Item): Array<{ key: string; text: string }> {
  return item.text.split(/[；;]/u).map((text) => text.trim()).filter(Boolean).flatMap((text) => {
    const claim = parseExtractClaim(text);
    return claim ? [{ key: extractClaimKey(claim), text }] : [];
  });
}

function claimProjection(item: Item, claimKey: string): string | undefined {
  return claimProjectionParts(item).find((part) => part.key === claimKey)?.text;
}

function removeClaimProjection(item: Item, claimKey: string): string | undefined {
  const parts = item.text.split(/[；;]/u).map((text) => text.trim()).filter(Boolean);
  const remaining = parts.filter((text) => {
    const claim = parseExtractClaim(text);
    return !claim || extractClaimKey(claim) !== claimKey;
  });
  return remaining.length > 0 ? remaining.join("；") : undefined;
}

/** Promote only after two distinct trusted repositories support one exact local claim. */
export async function promoteGlobalCandidate(
  store: Store,
  recordChange: LifecycleRecordChange,
  sourceItem: Item,
  now = Date.now(),
): Promise<{ promoted: boolean; itemID?: string }> {
  requireTransaction(store, "promoteGlobalCandidate");
  if (sourceItem.scope !== "project" || sourceItem.status !== "auto") return { promoted: false };
  const sourceRefs = (sourceItem.evidenceRefs ?? []).filter((ref) =>
    ref.claimKey && ref.repoIdentity && ref.originProjectKey &&
    ref.claimProjectRelative !== true && ref.explicitGlobal !== true &&
    claimProjection(sourceItem, ref.claimKey) !== undefined,
  );
  for (const ref of sourceRefs) await addGlobalCandidate(store, ref, now);
  if (sourceRefs.length === 0) return { promoted: false };

  const claimKeys = [...new Set(sourceRefs.flatMap((ref) => ref.claimKey ? [ref.claimKey] : []))];
  const [retired, retiredState] = await Promise.all([
    store.listRetiredSources(),
    store.readRetiredSourceState(),
  ]);
  let promotedItemID: string | undefined;

  for (const claimKey of claimKeys) {
    const items = await store.listItems();
    const currentSource = items.find((item) => item.id === sourceItem.id);
    const projection = currentSource && claimProjection(currentSource, claimKey);
    if (!currentSource || !projection || currentSource.scope !== "project" ||
        currentSource.status !== "auto" || currentSource.invalidatedBy || currentSource.manual) continue;
    const candidates = await store.listGlobalCandidates();
    const eligibleRefs: EvidenceRef[] = [];
    for (const candidate of candidates) {
      if (candidate.claimKey !== claimKey || now - Date.parse(candidate.createdAt) >= GLOBAL_CANDIDATE_TTL_MS) continue;
      const owner = items.find((item) =>
        (item.status === "auto" || item.status === "promoted") &&
        !item.invalidatedBy && !item.manual && item.scope === "project" && item.kind !== "rule" &&
        claimProjection(item, claimKey) !== undefined &&
        item.evidenceRefs?.some((ref) =>
          ref.sourceKey === candidate.evidenceRefID &&
          ref.claimKey === claimKey &&
          ref.repoIdentity === candidate.repoIdentity &&
          ref.originProjectKey === candidate.originProjectKey &&
          ref.quoteHash === candidate.quoteHash &&
          ref.claimProjectRelative !== true &&
          ref.explicitGlobal !== true,
        ),
      );
      const ref = owner?.evidenceRefs?.find((entry) =>
        entry.sourceKey === candidate.evidenceRefID && entry.claimKey === claimKey,
      );
      if (!ref || (retiredRow(retired, ref.sessionID, ref.messageID)?.items.length ?? 0) > 0 ||
          retiredByBarrier(retiredState, ref.observedAt)) continue;
      eligibleRefs.push(ref);
    }
    const allRefs = uniqueEvidenceRefs(eligibleRefs);
    const repos = new Set(allRefs.flatMap((ref) => ref.repoIdentity ? [ref.repoIdentity] : []));
    if (repos.size < 2) continue;

    const evidenceKeys = new Set(allRefs.map((ref) => ref.sourceKey));
    const projectItems = items.filter((item) =>
      item.scope === "project" && (item.status === "auto" || item.status === "promoted") &&
      !item.invalidatedBy && !item.manual && item.kind !== "rule" &&
      claimProjection(item, claimKey) !== undefined &&
      item.evidenceRefs?.some((ref) => ref.claimKey === claimKey && evidenceKeys.has(ref.sourceKey)),
    );
    if (projectItems.length === 0) continue;
    const existingGlobal = items.find((item) =>
      item.scope === "global" && (item.status === "auto" || item.status === "promoted") &&
      !item.invalidatedBy && item.implicitGlobalClaimKey === claimKey,
    );
    if (existingGlobal && claimProjection(existingGlobal, claimKey) !== existingGlobal.text) continue;
    const linkGroupID = existingGlobal?.linkGroupID ?? currentSource.linkGroupID ??
      projectItems.find((item) => item.linkGroupID)?.linkGroupID ?? newId("link");
    let global: Item;
    if (existingGlobal) {
      const prior = existingGlobal;
      global = {
        ...prior,
        sources: uniqueSources([...(prior.sources ?? []), ...projectItems.flatMap((item) => item.sources ?? [])]),
        evidenceRefs: uniqueEvidenceRefs([...(prior.evidenceRefs ?? []), ...allRefs]),
        implicitGlobalClaimKey: claimKey,
        linkGroupID,
        updatedAt: new Date(now).toISOString(),
        seenCount: (prior.seenCount ?? 1) + 1,
        lastSeenAt: new Date(now).toISOString(),
        changeID: newId("change"),
      };
      await store.replaceItem(global);
      await recordChange({
        kind: "update",
        actor: "auto",
        itemID: global.id,
        item: global,
        before: prior,
        source: currentSource.source,
        origin: currentSource.origin ?? "turn",
        linkGroupID,
        reason: "global-evidence-promoted",
      });
    } else {
      global = {
        ...currentSource,
        id: newId("item"),
        title: compact(projection).slice(0, 30),
        text: projection,
        scope: "global",
        project: undefined,
        projectKey: undefined,
        status: "auto",
        sources: uniqueSources(projectItems.flatMap((item) => item.sources ?? [item.source])),
        evidenceRefs: allRefs,
        implicitGlobalClaimKey: claimKey,
        linkGroupID,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        seenCount: allRefs.length,
        lastSeenAt: new Date(now).toISOString(),
        changeID: newId("change"),
      };
      await store.appendItem(global);
      await recordChange({
        kind: "promote",
        actor: "auto",
        itemID: global.id,
        item: global,
        source: currentSource.source,
        origin: currentSource.origin ?? "turn",
        linkGroupID,
        reason: "global-evidence-promoted",
      });
    }

    for (const prior of projectItems) {
      const residualText = removeClaimProjection(prior, claimKey);
      if (residualText === prior.text) continue;
      if (residualText === undefined) {
        const archived: Item = {
          ...prior,
          status: "archived",
          supersededBy: global.id,
          linkGroupID,
          updatedAt: new Date(now).toISOString(),
          changeID: newId("change"),
        };
        await store.replaceItem(archived);
        await recordChange({
          kind: "promote",
          actor: "auto",
          itemID: archived.id,
          item: archived,
          before: prior,
          source: prior.source,
          origin: prior.origin ?? "turn",
          linkGroupID,
          reason: "global-evidence-promoted",
        });
      } else {
        const residual: Item = {
          ...prior,
          title: compact(residualText).slice(0, 30),
          text: residualText,
          evidenceRefs: (prior.evidenceRefs ?? []).filter((ref) => ref.claimKey !== claimKey),
          linkGroupID,
          updatedAt: new Date(now).toISOString(),
          changeID: newId("change"),
        };
        const written = await store.replaceItem(residual);
        if (!written) continue;
        await recordChange({
          kind: "update",
          actor: "auto",
          itemID: written.id,
          item: written,
          before: prior,
          source: prior.source,
          origin: prior.origin ?? "turn",
          linkGroupID,
          reason: "global-evidence-projection-split",
        });
      }
    }
    promotedItemID ??= global.id;
  }
  return promotedItemID ? { promoted: true, itemID: promotedItemID } : { promoted: false };
}

function uniqueSources(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.sessionID ?? ""}\u0000${source.messageID ?? ""}\u0000${source.role ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidenceRefFor(items: Item[], evidenceRefID: string): EvidenceRef | undefined {
  for (const item of items) {
    const ref = item.evidenceRefs?.find((value) => value.sourceKey === evidenceRefID);
    if (ref) return ref;
  }
  return undefined;
}

function refIsRetired(ref: EvidenceRef, rows: RetiredSource[], state: RetiredSourceState): boolean {
  if ((retiredRow(rows, ref.sessionID, ref.messageID)?.items.length ?? 0) > 0) return true;
  return retiredByBarrier(state, ref.observedAt);
}

/** A source removal can invalidate a previously promoted implicit-global item. */
export async function invalidateUnsupportedGlobals(
  store: Store,
  recordChange: LifecycleRecordChange,
  now = Date.now(),
): Promise<string[]> {
  requireTransaction(store, "invalidateUnsupportedGlobals");
  const [items, candidates, retired, retiredState] = await Promise.all([
    store.listItems(),
    store.listGlobalCandidates(),
    store.listRetiredSources(),
    store.readRetiredSourceState(),
  ]);
  const invalidated: string[] = [];
  for (const item of items) {
    if (item.scope !== "global" || (item.status !== "auto" && item.status !== "promoted") || item.invalidatedBy) continue;
    const managedClaimKey = item.implicitGlobalClaimKey;
    const refs = item.evidenceRefs ?? [];
    if (!managedClaimKey || item.manual ||
        refs.some((ref) => ref.explicitGlobal === true && !refIsRetired(ref, retired, retiredState))) continue;
    const validRepos = new Set<string>();
    for (const ref of refs) {
      if (ref.claimKey !== managedClaimKey || !ref.repoIdentity || ref.explicitGlobal === true ||
          ref.claimProjectRelative === true || refIsRetired(ref, retired, retiredState)) continue;
      const candidate = candidates.find((row) =>
        row.evidenceRefID === ref.sourceKey &&
        row.claimKey === managedClaimKey &&
        row.repoIdentity === ref.repoIdentity &&
        row.originProjectKey === ref.originProjectKey &&
        row.quoteHash === ref.quoteHash &&
        now - Date.parse(row.createdAt) < GLOBAL_CANDIDATE_TTL_MS,
      );
      if (candidate) validRepos.add(ref.repoIdentity);
    }
    if (validRepos.size >= 2) continue;
    const next: Item = {
      ...item,
      invalidatedBy: "global-evidence-below-2",
      invalidatedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      changeID: newId("change"),
    };
    await store.replaceItem(next);
    await recordChange({
      kind: "invalidate",
      actor: "system",
      itemID: item.id,
      item: next,
      before: item,
      source: item.source,
      ...(item.linkGroupID ? { linkGroupID: item.linkGroupID } : {}),
      reason: "global-evidence-below-2",
    });
    invalidated.push(item.id);
  }
  return invalidated;
}

async function expireGlobalCandidatesInTransaction(
  store: Store,
  recordChange: LifecycleRecordChange,
  now: number,
): Promise<{ expiredCandidates: number; invalidated: string[]; expiredQuarantine: number }> {
  requireTransaction(store, "expireGlobalCandidatesInTransaction");
  const before = await store.listGlobalCandidates();
  const keep = before.filter((row) => {
    const at = Date.parse(row.createdAt);
    return Number.isFinite(at) && now - at < GLOBAL_CANDIDATE_TTL_MS;
  });
  const expiredCandidates = before.length - keep.length;
  if (expiredCandidates > 0) {
    await store.writeGlobalCandidates(keep);
    await store.appendChangelog({ action: "global_candidate_expired", count: expiredCandidates, at: new Date(now).toISOString() });
    const state = await store.readGlobalCandidateState();
    if (state.blocked && keep.length < GLOBAL_CANDIDATE_MAX_ROWS && candidateBytes(keep) < GLOBAL_CANDIDATE_MAX_BYTES) {
      await store.writeGlobalCandidateState({ epoch: state.epoch + 1, blocked: false });
    }
  }
  const invalidated = expiredCandidates > 0
    ? await invalidateUnsupportedGlobals(store, recordChange, now)
    : [];

  const quarantine = await store.listExtractQuarantine();
  const active = quarantine.filter((row) => {
    const expires = Date.parse(row.expiresAt);
    return Number.isFinite(expires) && expires > now;
  });
  const expiredQuarantine = quarantine.length - active.length;
  if (expiredQuarantine > 0) {
    await store.writeExtractQuarantine(active.slice(-EXTRACT_QUARANTINE_MAX_ROWS));
    await store.appendChangelog({ action: "extract_quarantine_expired", count: expiredQuarantine, at: new Date(now).toISOString() });
  }
  return { expiredCandidates, invalidated, expiredQuarantine };
}

export async function runLifecycleMaintenance(
  store: Store,
  recordChange: LifecycleRecordChange,
  now = Date.now(),
): Promise<{ expiredCandidates: number; invalidated: number; expiredQuarantine: number }> {
  const result = await store.transaction(async () => {
    const value = await expireGlobalCandidatesInTransaction(store, recordChange, now);
    return { ok: true as const, ...value };
  });
  if (result.invalidated.length > 0) await rebuildAutoFiles(store).catch(() => undefined);
  return {
    expiredCandidates: result.expiredCandidates,
    invalidated: result.invalidated.length,
    expiredQuarantine: result.expiredQuarantine,
  };
}

/** Caller may share this with the admission transaction to make expiry atomic. */
export async function expireLifecycleRecordsInTransaction(
  store: Store,
  recordChange: LifecycleRecordChange,
  now = Date.now(),
): Promise<{ expiredCandidates: number; invalidated: string[]; expiredQuarantine: number }> {
  return expireGlobalCandidatesInTransaction(store, recordChange, now);
}

export async function holdExtractQuarantine(
  store: Store,
  input: Omit<ExtractQuarantineRecord, "id" | "at" | "expiresAt">,
  now = Date.now(),
): Promise<boolean> {
  requireTransaction(store, "holdExtractQuarantine");
  const existing = await store.listExtractQuarantine();
  const active = existing.filter((row) => Date.parse(row.expiresAt) > now);
  const record: ExtractQuarantineRecord = {
    ...input,
    id: newId("extractq"),
    at: new Date(now).toISOString(),
    expiresAt: new Date(now + EXTRACT_QUARANTINE_TTL_MS).toISOString(),
  };
  const next = [...active, record];
  const bytes = Buffer.byteLength(next.map((row) => JSON.stringify(row)).join("\n"), "utf8");
  if (next.length > EXTRACT_QUARANTINE_MAX_ROWS || bytes > EXTRACT_QUARANTINE_MAX_BYTES) {
    await store.appendChangelog({ action: "extract_quarantine_capacity", count: active.length, bytes });
    return false;
  }
  await store.writeExtractQuarantine(next);
  return true;
}

/** Trusted current-instance git common-dir identity; never uses remote URLs or model paths. */
export function resolveRepoIdentity(root?: string): string | undefined {
  if (!root) return undefined;
  try {
    const common = execFileSync("git", ["-C", root, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    if (!common) return undefined;
    const absolute = path.isAbsolute(common) ? common : path.resolve(root, common);
    return `git-common:${sha16(realpathSync.native(absolute))}`;
  } catch {
    return undefined;
  }
}

export async function lifecycleStatus(store: Store, now = Date.now()): Promise<LifecycleStatus> {
  const [retired, retiredState, candidates, globalState, quarantine] = await Promise.all([
    store.listRetiredSources(),
    store.readRetiredSourceState(),
    store.listGlobalCandidates(),
    store.readGlobalCandidateState(),
    store.listExtractQuarantine(),
  ]);
  const activeQuarantine = quarantine.filter((row) => Date.parse(row.expiresAt) > now);
  return {
    retiredSources: retired.length,
    retiredBytes: retiredBytes(retired),
    retiredLearningBlocked: retiredState.blockedAt !== undefined,
    ...(retiredState.reason ? { retiredBlockReason: retiredState.reason } : {}),
    globalCandidates: candidates.length,
    globalCandidateBytes: candidateBytes(candidates),
    globalPromotionBlocked: globalState.blocked,
    quarantine: activeQuarantine.length,
    ...(activeQuarantine.length > 0
      ? { oldestQuarantineExpiry: activeQuarantine.map((row) => row.expiresAt).sort()[0] }
      : {}),
  };
}

export async function removeGlobalCandidatesForSources(
  store: Store,
  sourceKeys: Set<string>,
): Promise<number> {
  requireTransaction(store, "removeGlobalCandidatesForSources");
  if (sourceKeys.size === 0) return 0;
  const rows = await store.listGlobalCandidates();
  const keep = rows.filter((row) => !sourceKeys.has(row.evidenceRefID));
  if (keep.length !== rows.length) await store.writeGlobalCandidates(keep);
  return rows.length - keep.length;
}

export function sameSourceMessage(ref: EvidenceRef, source: { sessionID: string; messageID: string }): boolean {
  return ref.sessionID === source.sessionID && ref.messageID === source.messageID;
}

export function candidateRefFor(items: Item[], candidate: GlobalCandidate): EvidenceRef | undefined {
  const ref = evidenceRefFor(items, candidate.evidenceRefID);
  if (!ref || ref.claimKey !== candidate.claimKey || ref.repoIdentity !== candidate.repoIdentity ||
      ref.originProjectKey !== candidate.originProjectKey || ref.quoteHash !== candidate.quoteHash) return undefined;
  return ref;
}
