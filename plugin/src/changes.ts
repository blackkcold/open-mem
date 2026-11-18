import { itemContentVersion } from "./fingerprint.js";
import { newId, type Store } from "./store.js";
import { clearSuppression, suppressSource } from "./memory/suppression.js";
import { rebuildAutoFiles } from "./rebuild.js";
import {
  expireLifecycleRecordsInTransaction,
  invalidateUnsupportedGlobals,
  releaseRetiredItem,
  removeGlobalCandidatesForSources,
  retireItemSources,
} from "./memory/lifecycle.js";
import type {
  ChangeActor,
  ChangeEvent,
  ChangeJournal,
  ChangeKind,
  Item,
  ItemSnapshot,
  RevertResult,
  SourceRef,
} from "./types.js";

/** Kinds whose effect can be reversed into an earlier version. */
const REVERTIBLE: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  "add",
  "update",
  "merge",
  "replace",
  "promote",
  "restore",
]);

const DAY_MS = 86_400_000;
const DEFAULT_RETAIN_DAYS = 90;

/**
 * Pre-generate the id a writer will stamp on the item before it records the
 * matching event, so the event snapshot and the stored row stay identical.
 */
export function newChangeID(): string {
  return newId("change");
}

/** Lossless full snapshot: identity, status, provenance and derivation stay. */
export function itemSnapshot(item: Item): ItemSnapshot {
  return structuredClone(item);
}

export type ChangeInput = Omit<
  ChangeEvent,
  "id" | "at" | "itemVersion" | "revertible"
> & {
  item: Item;
  before?: Item;
};

function requireTransaction(store: Store, caller: string): void {
  if (!store.inTransaction) {
    throw new Error(`${caller} must run inside store.transaction`);
  }
}

/**
 * Expire lifecycle records in the user-change transaction. Store.transaction
 * rolls back an `{ ok: false }` result, so replay any due maintenance in its
 * own transaction when the requested change is rejected.
 */
async function withLifecycleExpiry(
  store: Store,
  operation: () => Promise<RevertResult>,
): Promise<RevertResult> {
  let invalidated: string[] = [];
  let lifecycleChanged = false;
  const result = await store.transaction(async () => {
    const maintenance = await expireLifecycleRecordsInTransaction(
      store,
      (input) => recordChange(store, input),
    );
    invalidated = maintenance.invalidated;
    lifecycleChanged = maintenance.expiredCandidates > 0 ||
      maintenance.expiredQuarantine > 0 || maintenance.invalidated.length > 0;
    return operation();
  });
  if (!result.ok && lifecycleChanged) {
    const maintenance = await store.transaction(() =>
      expireLifecycleRecordsInTransaction(store, (input) => recordChange(store, input)),
    );
    invalidated = maintenance.invalidated;
  }
  if (invalidated.length > 0) {
    await rebuildAutoFiles(store).catch(() => undefined);
  }
  return result;
}

async function retireChangedSources(
  store: Store,
  item: Item,
  reason: "deactivate" | "revert",
  changeID: string,
  before?: Item,
): Promise<void> {
  const retired = await retireItemSources(store, item, reason, changeID, before);
  await removeGlobalCandidatesForSources(store, retired.evidenceRefIDs);
  await invalidateUnsupportedGlobals(store, (input) => recordChange(store, input));
}

/**
 * Append exactly one change event for one item write.
 *
 * Must run inside `store.transaction`, so the item write, the ledger row and
 * the journal file are committed (or rolled back) together. When the written
 * item already carries a fresh `changeID`, that id becomes the event id; the
 * caller then only has to stamp it before writing.
 */
export async function recordChange(
  store: Store,
  input: ChangeInput,
): Promise<ChangeEvent> {
  requireTransaction(store, "recordChange");
  const { item, before, ...rest } = input;
  const candidate = item.changeID && /^change_[A-Za-z0-9_]+$/.test(item.changeID)
    ? item.changeID
    : undefined;
  if (candidate) {
    // A reused id would duplicate a ledger row and overwrite the older
    // change-journal (including its `undone` flag). Fail fast instead of
    // silently renaming, so the buggy writer is visible.
    const exists = (await store.listChanges()).some((event) => event.id === candidate);
    if (exists) throw new Error(`change id already exists: ${candidate}`);
  }
  const id = candidate ?? newChangeID();
  const after = rest.after ?? itemSnapshot(item);
  const event: ChangeEvent = {
    ...rest,
    id,
    at: new Date().toISOString(),
    itemVersion: itemContentVersion(after),
    after,
    before: before ? itemSnapshot(before) : undefined,
    revertible: REVERTIBLE.has(rest.kind),
  };
  await store.appendChange(event);
  // The journal is the redo/undo progress for changes that can be reversed
  // (DESIGN §5.3/§7.3). Non-revertible history (invalidate/expire/archive)
  // already keeps its full before/after in the ledger; writing one fsynced
  // file per row would make a 300-row fanout dominate the write lock.
  if (event.revertible) {
    const journal: ChangeJournal = {
      id: event.id,
      at: event.at,
      itemID: event.itemID,
      kind: event.kind,
      before: event.before,
      after: event.after,
      reverts: event.reverts,
      undone: false,
    };
    await store.writeChangeJournal(journal);
  }
  return event;
}

export interface DiffChangeMeta {
  kind: ChangeKind;
  actor: ChangeActor;
  reason: string;
  source?: SourceRef;
  origin?: ChangeEvent["origin"];
  /** per-item change id this undo reverses */
  reverts?: Map<string, string>;
}

/** Give an already-written item a fresh change id and return the stored row. */
export async function stampChange(
  store: Store,
  itemID: string,
): Promise<Item | undefined> {
  return store.updateItem(itemID, { changeID: newChangeID() });
}

/**
 * Semantic snapshot for legacy diffing: every field that changes behaviour or
 * provenance counts, while ids/counters that only move on bookkeeping do not.
 * `expiresAt` changes the active set and `derivedFrom` changes invalidation
 * boundaries, so both must produce an event.
 */
function semanticSnapshot(item: Item): string {
  const {
    changeID: _changeID,
    updatedAt: _updatedAt,
    seenCount: _seenCount,
    lastSeenAt: _lastSeenAt,
    ...rest
  } = item;
  return JSON.stringify(rest);
}

/**
 * Record one event per item whose content version changed. Used by legacy
 * undo/maintenance paths that write items themselves (merge journal,
 * maintenance journal, queue recovery) so they cannot silently skip the
 * ledger.
 */
export async function recordItemDiff(
  store: Store,
  before: Item[],
  after: Item[],
  meta: DiffChangeMeta,
): Promise<ChangeEvent[]> {
  const previous = new Map(before.map((item) => [item.id, item]));
  const events: ChangeEvent[] = [];
  for (const item of after) {
    const prior = previous.get(item.id);
    if (prior && semanticSnapshot(prior) === semanticSnapshot(item)) continue;
    const stamped = (await stampChange(store, item.id)) ?? {
      ...item,
      changeID: newChangeID(),
    };
    events.push(
      await recordChange(store, {
        kind: meta.kind,
        actor: meta.actor,
        itemID: item.id,
        item: stamped,
        ...(prior ? { before: prior } : {}),
        source: meta.source ?? item.source ?? {},
        ...(meta.origin ? { origin: meta.origin } : {}),
        ...(meta.reverts?.get(item.id) ? { reverts: meta.reverts.get(item.id) } : {}),
        reason: meta.reason,
      }),
    );
  }
  return events;
}

function versionMismatch(): RevertResult {
  return {
    ok: false,
    code: "version_mismatch",
    message: "条目已变化，请刷新后重试",
  };
}

function conflict(message: string): RevertResult {
  return { ok: false, code: "conflict", message };
}

function isExpired(item: Item, now = Date.now()): boolean {
  if (!item.expiresAt) return false;
  const at = Date.parse(item.expiresAt);
  return Number.isFinite(at) && at <= now;
}

function isActive(item: Item, now = Date.now()): boolean {
  return (
    (item.status === "auto" || item.status === "promoted") &&
    !item.invalidatedBy &&
    !isExpired(item, now)
  );
}

/** Upstream ids that cannot support an active row any more. */
async function invalidUpstreams(store: Store, item: Item): Promise<string[]> {
  const upstream = new Set<string>(item.derivedFrom ?? []);
  // A row invalidated through a supersede chain may have no derivedFrom; the
  // recorded cause is still an upstream that must be valid.
  if (item.invalidatedBy) upstream.add(item.invalidatedBy);
  if (upstream.size === 0) return [];
  const items = await store.listItems();
  const byID = new Map(items.map((entry) => [entry.id, entry]));
  const now = Date.now();
  return [...upstream].filter((id) => {
    const parent = byID.get(id);
    return !parent || !isActive(parent, now);
  });
}

/** Stop injecting an item without changing its content. */
export async function deactivateItem(
  store: Store,
  itemID: string,
  opts: { expectedVersion: string; reason?: string },
): Promise<RevertResult> {
  return withLifecycleExpiry(store, async () => {
    const items = await store.listItems();
    const current = items.find((item) => item.id === itemID);
    if (!current) {
      return { ok: false, code: "not_found", message: "记忆条目不存在" };
    }
    if (itemContentVersion(current) !== opts.expectedVersion) return versionMismatch();
    if (current.status === "archived") {
      return conflict("该条目已经停止使用");
    }
    const next: Item = {
      ...current,
      status: "archived",
      supersededBy: "deactivate",
      updatedAt: new Date().toISOString(),
      changeID: newChangeID(),
    };
    const written = await store.replaceItem(next);
    if (!written) {
      return { ok: false, code: "not_found", message: "记忆条目不存在" };
    }
    const event = await recordChange(store, {
      kind: "deactivate",
      actor: "user",
      itemID,
      item: written,
      before: current,
      source: current.source,
      origin: "user",
      reason: opts.reason ?? "deactivated",
    });
    await suppressSource(store, current, "deactivated");
    await retireChangedSources(store, current, "deactivate", event.id);
    const invalidated = await invalidateDerived(store, [itemID], {
      reason: "upstream deactivated",
    });
    return { ok: true, event, invalidated };
  });
}

/**
 * Restore use of one row, without touching its downstream.
 *
 * Two legal shapes:
 * - `archived` with `supersededBy="deactivate"`: the user stopped it.
 * - `auto`/`promoted` with `invalidatedBy`: an upstream undo stopped it; the
 *   user may bring it back once every real upstream is active again.
 *
 * Re-validating the upstream here is what closes the loop after the upstream
 * itself was restored; restoring the upstream never revives rows on its own.
 */
export async function reactivateItem(
  store: Store,
  itemID: string,
  opts: { expectedVersion: string },
): Promise<RevertResult> {
  return withLifecycleExpiry(store, async () => {
    const items = await store.listItems();
    const current = items.find((item) => item.id === itemID);
    if (!current) {
      return { ok: false, code: "not_found", message: "记忆条目不存在" };
    }
    if (itemContentVersion(current) !== opts.expectedVersion) return versionMismatch();
    const stopped =
      current.status === "archived" && current.supersededBy === "deactivate";
    const invalidatedActive =
      (current.status === "auto" || current.status === "promoted") &&
      Boolean(current.invalidatedBy);
    if (!stopped && !invalidatedActive) {
      if (current.status === "archived") {
        return conflict("该条目不是“停止使用”状态，不能恢复使用");
      }
      return conflict("该条目仍在生效，不需要恢复使用");
    }
    if (isExpired(current)) {
      return conflict("该条目已过期，只能重新学习");
    }
    // Check the real upstreams before deciding, so a still-invalid parent is
    // reported as such instead of hiding behind the status branch.
    const blocked = await invalidUpstreams(store, current);
    if (blocked.length > 0) {
      return conflict(`上游条目已失效：${blocked.join("、")}`);
    }
    let previousStatus: "auto" | "promoted";
    if (stopped) {
      const changes = await store.listChanges({ itemID });
      const stop = [...changes].reverse().find((event) => event.kind === "deactivate");
      previousStatus = stop?.before?.status === "promoted" ? "promoted" : "auto";
    } else {
      previousStatus = current.status === "promoted" ? "promoted" : "auto";
    }
    const next: Item = {
      ...current,
      status: previousStatus,
      supersededBy: stopped ? undefined : current.supersededBy,
      invalidatedBy: undefined,
      invalidatedAt: undefined,
      updatedAt: new Date().toISOString(),
      changeID: newChangeID(),
    };
    const written = await store.replaceItem(next);
    if (!written) {
      return { ok: false, code: "not_found", message: "记忆条目不存在" };
    }
    const event = await recordChange(store, {
      kind: "restore",
      actor: "user",
      itemID,
      item: written,
      before: current,
      source: current.source,
      origin: "user",
      reason: "reactivated",
    });
    await clearSuppression(store, itemID);
    await releaseRetiredItem(store, itemID);
    return { ok: true, event, invalidated: [] };
  });
}

function journalOf(event: ChangeEvent, patch: Partial<ChangeJournal>): ChangeJournal {
  return {
    id: event.id,
    at: event.at,
    itemID: event.itemID,
    kind: event.kind,
    before: event.before,
    after: event.after,
    reverts: event.reverts,
    undone: false,
    ...patch,
  };
}

/**
 * Undo one change without a time limit. With a `before` snapshot the earlier
 * version is written as a new version; without one the item stops being used.
 * A later change to the same item makes the undo unsafe: return `conflict` and
 * let the caller offer "stop using" instead of overwriting newer content.
 */
export async function revertChange(
  store: Store,
  changeID: string,
  opts: { expectedVersion: string; reason?: string; itemID?: string },
): Promise<RevertResult> {
  return withLifecycleExpiry(store, async () => {
    const changes = await store.listChanges();
    const index = changes.findIndex((event) => event.id === changeID);
    if (index === -1) {
      return { ok: false, code: "not_found", message: "变更记录不存在" };
    }
    const target = changes[index];
    if (opts.itemID !== undefined && target.itemID !== opts.itemID) {
      // The route id and the change must name the same item; otherwise the
      // caller would undo a different row than the one it refreshes.
      return { ok: false, code: "not_found", message: "该变更不属于这个条目" };
    }
    if (!target.revertible) {
      return {
        ok: false,
        code: "not_revertible",
        message: "这次变更不可撤销，只能停止使用",
      };
    }
    const existing = await store.readChangeJournal(changeID);
    if (existing?.undone) {
      return {
        ok: false,
        code: "not_revertible",
        message: "这次变更已经撤销",
      };
    }
    const current = (await store.listItems()).find((item) => item.id === target.itemID);
    if (!current) {
      return { ok: false, code: "not_found", message: "记忆条目不存在" };
    }
    if (itemContentVersion(current) !== opts.expectedVersion) return versionMismatch();
    if (current.invalidatedBy) {
      return conflict("该条目已被上游撤销或停用，不能做版本回退");
    }
    const later = changes
      .slice(index + 1)
      .filter((event) => event.itemID === target.itemID);
    if (later.length > 0) {
      return conflict(
        "该条目在这次变更后又被编辑，无法安全撤销；请改为停止使用",
      );
    }

    await store.writeChangeJournal(
      existing ?? journalOf(target, {}),
    );
    await store.writeChangeJournal(journalOf(target, { undoing: true }));

    const next: Item = target.before
      ? {
          ...target.before,
          id: current.id,
          updatedAt: new Date().toISOString(),
          changeID: newChangeID(),
          invalidatedBy: undefined,
          invalidatedAt: undefined,
        }
      : {
          ...current,
          status: "archived",
          supersededBy: "revert",
          updatedAt: new Date().toISOString(),
          changeID: newChangeID(),
        };
    const written = await store.replaceItem(next);
    if (!written) {
      return { ok: false, code: "not_found", message: "记忆条目不存在" };
    }
    const event = await recordChange(store, {
      kind: "revert",
      actor: "user",
      itemID: current.id,
      item: written,
      before: current,
      source: current.source,
      origin: "user",
      reason: opts.reason ?? `revert ${target.id}`,
      reverts: target.id,
    });
    await retireChangedSources(store, current, "revert", event.id, target.before);
    if (written.status === "archived") {
      await suppressSource(store, current, "reverted");
    }
    const invalidated = await invalidateDerived(store, [current.id], {
      reason: `upstream reverted ${target.id}`,
    });
    await store.writeChangeJournal(journalOf(target, { undone: true }));
    return { ok: true, event, invalidated };
  });
}

function isCompleteSnapshot(value: Item | undefined): value is Item {
  return Boolean(
    value &&
      typeof value.id === "string" &&
      typeof value.title === "string" &&
      typeof value.text === "string" &&
      typeof value.kind === "string" &&
      typeof value.scope === "string" &&
      typeof value.status === "string" &&
      typeof value.source === "object" &&
      value.source !== null &&
      typeof value.createdAt === "string" &&
      typeof value.updatedAt === "string",
  );
}

/**
 * Restore a historical version as the new current version. This is an explicit
 * user action bound to the current version (CAS), limited to `undo.retainDays`.
 * It never guesses a legacy journal and never applies a partial text merge.
 */
export async function restoreVersion(
  store: Store,
  itemID: string,
  changeID: string,
  opts: { expectedVersion: string },
): Promise<RevertResult> {
  return withLifecycleExpiry(store, async () => {
    const current = (await store.listItems()).find((item) => item.id === itemID);
    if (!current) {
      return { ok: false, code: "not_found", message: "记忆条目不存在" };
    }
    if (itemContentVersion(current) !== opts.expectedVersion) return versionMismatch();
    const changes = await store.listChanges({ itemID });
    const target = changes.find((event) => event.id === changeID);
    if (!target) {
      return { ok: false, code: "not_found", message: "版本记录不存在" };
    }
    if (!isCompleteSnapshot(target.after)) {
      return {
        ok: false,
        code: "not_revertible",
        message: "版本快照不完整，不能恢复旧正文",
      };
    }
    const snapshot = target.after;
    if (snapshot.status !== "auto" && snapshot.status !== "promoted") {
      return {
        ok: false,
        code: "not_revertible",
        message: "该版本不是生效版本，不能作为正文恢复",
      };
    }
    if (snapshot.scope !== current.scope) {
      return {
        ok: false,
        code: "not_revertible",
        message: "版本范围与当前条目不一致，不能恢复",
      };
    }
    if (
      current.scope === "project" &&
      snapshot.projectKey !== current.projectKey
    ) {
      return {
        ok: false,
        code: "not_revertible",
        message: "版本项目归属与当前条目不一致，不能恢复",
      };
    }
    const config = await store.readConfig();
    const retainDays = Number.isFinite(config.undo?.retainDays)
      ? Number(config.undo.retainDays)
      : DEFAULT_RETAIN_DAYS;
    const age = Date.now() - Date.parse(target.at);
    if (Number.isFinite(age) && age > retainDays * DAY_MS) {
      return {
        ok: false,
        code: "not_revertible",
        message: `超过 ${retainDays} 天版本保留期，只能停止使用`,
      };
    }
    if (isExpired(snapshot)) {
      return {
        ok: false,
        code: "not_revertible",
        message: "该版本已过期，恢复后不会注入；请重新学习",
      };
    }
    const blocked = await invalidUpstreams(store, snapshot);
    if (blocked.length > 0) {
      return conflict(`上游条目已失效：${blocked.join("、")}`);
    }
    const next: Item = {
      ...snapshot,
      id: current.id,
      updatedAt: new Date().toISOString(),
      changeID: newChangeID(),
      invalidatedBy: undefined,
      invalidatedAt: undefined,
    };
    const written = await store.replaceItem(next);
    if (!written) {
      return { ok: false, code: "not_found", message: "记忆条目不存在" };
    }
    const event = await recordChange(store, {
      kind: "restore",
      actor: "user",
      itemID,
      item: written,
      before: current,
      source: current.source,
      origin: "user",
      reason: `restore ${target.id}`,
    });
    await clearSuppression(store, itemID);
    await releaseRetiredItem(store, itemID);
    return { ok: true, event, invalidated: [] };
  });
}

/** True when `candidate` is an ancestor of `node` in the BFS tree (back edge). */
function isAncestor(candidate: string, node: string, parentOf: Map<string, string>): boolean {
  const seen = new Set<string>();
  let cursor: string | undefined = node;
  while (cursor !== undefined && !seen.has(cursor)) {
    if (cursor === candidate) return true;
    seen.add(cursor);
    cursor = parentOf.get(cursor);
  }
  return false;
}

/**
 * Recursively stop injecting rows derived from (or superseded by) the given
 * ids. The whole closure is computed from one read, then written with one
 * bulk `applyItemChanges` (keeping its CAS and maintenance journal) and one
 * event per invalidated row. A visited set plus an ancestor check makes a
 * cycle terminate and leaves one bounded audit entry; there is no arbitrary
 * depth cap, so a deep finite chain is fully invalidated.
 */
export async function invalidateDerived(
  store: Store,
  rootIDs: string[],
  opts: { reason?: string; actor?: ChangeActor } = {},
): Promise<string[]> {
  requireTransaction(store, "invalidateDerived");
  const items = await store.listItems();
  const downstream = new Map<string, Item[]>();
  for (const item of items) {
    const parents = new Set<string>(item.derivedFrom ?? []);
    if (item.supersededBy) parents.add(item.supersededBy);
    for (const parent of parents) {
      const list = downstream.get(parent);
      if (list) list.push(item);
      else downstream.set(parent, [item]);
    }
  }
  const now = new Date().toISOString();
  const visited = new Set<string>(rootIDs);
  const parentOf = new Map<string, string>();
  const hits: Array<{ item: Item; parentID: string }> = [];
  let cycle: { from: string; to: string } | undefined;
  let frontier = [...rootIDs];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const parentID of frontier) {
      for (const child of downstream.get(parentID) ?? []) {
        if (visited.has(child.id)) {
          if (!cycle && isAncestor(child.id, parentID, parentOf)) {
            cycle = { from: parentID, to: child.id };
          }
          continue;
        }
        visited.add(child.id);
        parentOf.set(child.id, parentID);
        if (child.status !== "auto" && child.status !== "promoted") continue;
        if (child.invalidatedBy) {
          // Already stopped by an earlier undo; keep walking its subtree but
          // do not emit a second event for it.
          next.push(child.id);
          continue;
        }
        hits.push({ item: child, parentID });
        next.push(child.id);
      }
    }
    frontier = next;
  }
  if (cycle) {
    await store.appendChangelog({
      action: "invalidate_cycle",
      rootID: rootIDs[0],
      edge: `${cycle.from}->${cycle.to}`,
      invalidated: hits.length,
    });
  }
  if (hits.length === 0) return [];
  const targets = new Map(hits.map((hit) => [hit.item.id, hit]));
  const after = items.map((entry) => {
    const hit = targets.get(entry.id);
    if (!hit) return entry;
    return {
      ...entry,
      invalidatedBy: hit.parentID,
      invalidatedAt: now,
      updatedAt: now,
      changeID: newChangeID(),
    };
  });
  // One full-set write inside the transaction. A maintenance journal here
  // would expose /api/maintenance/:id/undo as a route that restores a child
  // while its upstream is still archived, bypassing the upstream check.
  await store.replaceItems(after);
  const byID = new Map(after.map((entry) => [entry.id, entry]));
  for (const hit of hits) {
    const written = byID.get(hit.item.id);
    if (!written) continue;
    await recordChange(store, {
      kind: "invalidate",
      actor: opts.actor ?? "system",
      itemID: written.id,
      item: written,
      before: hit.item,
      source: written.source,
      reason: opts.reason ?? "upstream invalidated",
      derivedFrom: written.derivedFrom,
    });
  }
  return hits.map((hit) => hit.item.id);
}
