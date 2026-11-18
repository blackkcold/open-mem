import { useSyncExternalStore } from "react";
import type { Health } from "../types";

/**
 * Shared, hash-only outcome locks for item actions.
 *
 * The existing merge-undo lock pattern is reused: a marker records a rejected
 * or unknown action so the same submit cannot be repeated after a poll or a
 * component remount. Markers store no body, prompt, secret or tool payload.
 */
export type ItemAction = "deactivate" | "reactivate" | "revert" | "restore";
export type ItemActionLockKind = "conflict" | "unknown";

export interface ItemActionLock {
  key: string;
  itemHash: string;
  action: ItemAction;
  /** Content version submitted with the rejected/unknown request. */
  version: string;
  changeID?: string;
  kind: ItemActionLockKind;
  at: string;
}

export interface ItemActionLockSnapshot {
  locks: Readonly<Record<string, ItemActionLock>>;
  persistence: "available" | "unavailable";
  unknownLocks: ItemActionLock[];
}

interface LockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface LockStore {
  scope: string;
  storageKey: string;
  storage?: LockStorage;
  locks: Record<string, ItemActionLock>;
  persistence: "available" | "unavailable";
  snapshot: ItemActionLockSnapshot;
  listeners: Set<() => void>;
}

const STORAGE_PREFIX = "openmem.itemActionLocks.v1:";
const PROBE_KEY = "openmem.itemActionLocks.probe";
const ACTIONS: ReadonlySet<ItemAction> = new Set([
  "deactivate",
  "reactivate",
  "revert",
  "restore",
]);
const stores = new Map<string, LockStore>();

/** Stable server identity; no URL/user-provided key is accepted as identity. */
export function itemActionLockScope(health: Health | undefined): string | undefined {
  if (!health?.dataDir) return undefined;
  return `${health.dataDir}|${health.project?.key ?? "no-project"}`;
}

/** Small non-cryptographic hash; ids/versions are already opaque references. */
function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function storageKeyFor(scope: string): string {
  return `${STORAGE_PREFIX}${hashText(scope)}`;
}

function browserStorage(): LockStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function probe(storage: LockStorage | undefined): "available" | "unavailable" {
  if (!storage) return "unavailable";
  try {
    storage.setItem(PROBE_KEY, "1");
    storage.removeItem(PROBE_KEY);
    return "available";
  } catch {
    return "unavailable";
  }
}

function parseLocks(raw: string | null): Record<string, ItemActionLock> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const result: Record<string, ItemActionLock> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.itemHash !== "string" ||
      typeof entry.action !== "string" ||
      !ACTIONS.has(entry.action as ItemAction) ||
      typeof entry.version !== "string" ||
      (entry.changeID !== undefined && typeof entry.changeID !== "string") ||
      (entry.kind !== "conflict" && entry.kind !== "unknown") ||
      typeof entry.at !== "string"
    ) {
      continue;
    }
    result[key] = {
      key,
      itemHash: entry.itemHash,
      action: entry.action as ItemAction,
      version: entry.version,
      ...(typeof entry.changeID === "string" ? { changeID: entry.changeID } : {}),
      kind: entry.kind,
      at: entry.at,
    };
  }
  return result;
}

function snapshotOf(store: LockStore): ItemActionLockSnapshot {
  return {
    locks: store.locks,
    persistence: store.persistence,
    unknownLocks: Object.values(store.locks).filter(
      (lock) => lock.kind === "unknown",
    ),
  };
}

function notify(store: LockStore): void {
  store.snapshot = snapshotOf(store);
  for (const listener of store.listeners) listener();
}

function persist(store: LockStore): void {
  if (!store.storage || store.persistence === "unavailable") return;
  try {
    const values = Object.values(store.locks);
    if (values.length === 0) store.storage.removeItem(store.storageKey);
    else store.storage.setItem(store.storageKey, JSON.stringify(store.locks));
  } catch {
    store.persistence = "unavailable";
  }
}

function getStore(scope: string | undefined): LockStore {
  const resolved = scope ?? "unscoped:memory";
  const existing = stores.get(resolved);
  if (existing) return existing;
  const storage = scope ? browserStorage() : undefined;
  const storageKey = storageKeyFor(resolved);
  let raw: string | null = null;
  try {
    raw = storage?.getItem(storageKey) ?? null;
  } catch {
    raw = null;
  }
  const locks = parseLocks(raw);
  const store: LockStore = {
    scope: resolved,
    storageKey,
    ...(storage ? { storage } : {}),
    locks,
    persistence: probe(storage),
    snapshot: { locks, persistence: "unavailable", unknownLocks: [] },
    listeners: new Set(),
  };
  store.snapshot = snapshotOf(store);
  if (storage && store.persistence === "available" && typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key !== storageKey) return;
      store.locks = parseLocks(event.newValue);
      notify(store);
    });
  }
  stores.set(resolved, store);
  return store;
}

export function actionLockKey(
  itemID: string,
  action: ItemAction,
  version: string,
  changeID?: string,
): string {
  return `${hashText(itemID)}|${action}|${version}|${changeID ?? ""}`;
}

export function addItemActionLock(
  scope: string | undefined,
  input: {
    itemID: string;
    action: ItemAction;
    version: string;
    changeID?: string;
    kind: ItemActionLockKind;
  },
): ItemActionLock {
  const store = getStore(scope);
  const key = actionLockKey(input.itemID, input.action, input.version, input.changeID);
  const lock: ItemActionLock = {
    key,
    itemHash: hashText(input.itemID),
    action: input.action,
    version: input.version,
    ...(input.changeID ? { changeID: input.changeID } : {}),
    kind: input.kind,
    at: new Date().toISOString(),
  };
  store.locks = { ...store.locks, [key]: lock };
  persist(store);
  notify(store);
  return lock;
}

export function unlockUnknownLocks(scope: string | undefined, itemID: string): void {
  const store = getStore(scope);
  const itemHash = hashText(itemID);
  const next = Object.fromEntries(
    Object.entries(store.locks).filter(
      ([, lock]) => !(lock.itemHash === itemHash && lock.kind === "unknown"),
    ),
  );
  store.locks = next;
  persist(store);
  notify(store);
}

export function isActionLocked(
  locks: Readonly<Record<string, ItemActionLock>>,
  itemID: string,
  action: ItemAction,
  version: string,
  changeID?: string,
): boolean {
  const itemHash = hashText(itemID);
  return Object.values(locks).some((lock) => {
    if (lock.itemHash !== itemHash || lock.action !== action) return false;
    if (lock.version !== version) return false;
    if (action === "revert" || action === "restore") {
      return lock.changeID === changeID;
    }
    return true;
  });
}

export function unknownLockFor(
  snapshot: ItemActionLockSnapshot,
  itemID: string,
): ItemActionLock | undefined {
  const itemHash = hashText(itemID);
  return snapshot.unknownLocks.find((lock) => lock.itemHash === itemHash);
}

export function unknownOutcomeChanged(
  lock: ItemActionLock,
  fresh: { version: string; changeID?: string },
): boolean {
  return (
    fresh.version !== lock.version ||
    (lock.changeID !== undefined && fresh.changeID !== lock.changeID)
  );
}

export function useItemActionLocks(scope: string | undefined): ItemActionLockSnapshot {
  const store = getStore(scope);
  return useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    () => store.snapshot,
    () => store.snapshot,
  );
}
