import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Store } from "./store.js";
import type {
  ChangeEvent,
  ChangeJournal,
  ExtractQuarantineRecord,
  Item,
  ItemSnapshot,
  SessionState,
  Suppression,
} from "./types.js";
import { safeStorePath } from "./util/transaction.js";

export const RETENTION_POLICY = { days: 90, minRecords: 20, sessionDays: 90 } as const;

/**
 * The managed history ledger is bounded by retention policy, not by the
 * approval queue. Protected rows are never evicted to satisfy these numbers.
 */
export const MANAGED_HISTORY_LIMITS = {
  changes: 5_000,
  changesPerItem: 20,
  suppressions: 2_000,
  quarantine: 200,
} as const;

const DAY = 86_400_000;
const DEFAULT_RETAIN_DAYS = 90;
type RecordValue = Record<string, unknown>;
interface Group { id: string; type: string; at: number; raw?: RecordValue; files: string[]; keep: boolean }

export interface RetentionCounts {
  changes: number;
  changeJournals: number;
  suppressions: number;
  quarantine: number;
  retiredSources: number;
  globalCandidates: number;
  migrationJournals: number;
  checkpointBackups: number;
}

export interface RetentionPreview {
  id: string;
  policy: typeof RETENTION_POLICY;
  retainDays: number;
  deleteFiles: string[];
  archiveSessions: string[];
  pruneItems: number;
  pruneMerges: number;
  pruneHistory: number;
  reclaimableBytes: number;
  reclaimable: {
    filesBytes: number;
    changesBytes: number;
    changeJournalBytes: number;
    suppressionBytes: number;
    quarantineBytes: number;
  };
  protectedCount: number;
  protectedChanges: number;
  protectedJournals: number;
  protectedSuppressions: number;
  pruneChanges: number;
  pruneChangeJournals: number;
  pruneSuppressions: number;
  pruneQuarantine: number;
  deletedChanges: string[];
  deletedChangeJournals: string[];
  deletedSuppressions: string[];
  deletedQuarantine: string[];
  counts: RetentionCounts;
  historyBytes: number;
  blocked: boolean;
  blockedReasons: string[];
  notes: string[];
}

export interface HistoryPruneResult {
  skipped?: "claim" | "cooldown" | "transaction";
  retryAt?: string;
  deleteFiles: number;
  deletedChanges: number;
  deletedChangeJournals: number;
  deletedSuppressions: number;
  deletedQuarantine: number;
  reclaimedBytes: number;
  remainingReclaimableBytes: number;
  protectedChanges: number;
  protectedJournals: number;
  protectedSuppressions: number;
  blocked: boolean;
  blockedReasons: string[];
  notes: string[];
}

interface ManagedJournalFile {
  name: string;
  relative: string;
  bytes: number;
  hash: string;
  journal?: ChangeJournal;
}

interface ManagedMigrationFile {
  name: string;
  relative: string;
  bytes: number;
  hash: string;
  value?: RecordValue;
}

interface ManagedCheckpoint {
  name: string;
  relative: string;
  bytes: number;
  /** Deterministic [relativePath, sha256, bytes] rows; empty for non-dirs. */
  files: Array<[string, string, number]>;
}

interface ManagedHistoryPlan {
  changes: ChangeEvent[];
  nextChanges: ChangeEvent[];
  journals: ManagedJournalFile[];
  nextJournals: ManagedJournalFile[];
  deletedJournalFiles: Set<string>;
  nextItems: Item[];
  protectedChangeIDs: Set<string>;
  protectedJournalFiles: Set<string>;
  migrations: ManagedMigrationFile[];
  checkpoints: ManagedCheckpoint[];
  suppressions: Suppression[];
  nextSuppressions: Suppression[];
  quarantine: ExtractQuarantineRecord[];
  nextQuarantine: ExtractQuarantineRecord[];
  changesDeletionBytes: number;
  journalDeletionBytes: number;
  suppressionDeletionBytes: number;
  quarantineDeletionBytes: number;
  protectedChanges: number;
  protectedJournals: number;
  protectedSuppressions: number;
  counts: RetentionCounts;
  historyBytes: number;
  blockedReasons: string[];
  notes: string[];
}

const record = (value: unknown): value is RecordValue =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const date = (value: unknown): number => typeof value === "string" ? Date.parse(value) : Number.NaN;
const at = (value: RecordValue) => date(value.at ?? value.createdAt);
const hash = (text: string | Buffer) => crypto.createHash("sha256").update(text).digest("hex");
const jsonl = (rows: unknown[]) => rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const rowBytes = (row: unknown) => bytesOf(row) + 1;

function recent<T>(rows: T[], time: (row: T) => number, now: number): Set<T> {
  const sorted = [...rows].sort((a, b) => (time(b) || 0) - (time(a) || 0));
  return new Set([...sorted.slice(0, RETENTION_POLICY.minRecords),
    ...rows.filter((row) => !Number.isFinite(time(row)) || now - time(row) <= RETENTION_POLICY.days * DAY)]);
}
function references(value: unknown, into: Set<string>, key = ""): void {
  if (typeof value === "string" && /^(?:id|.*(?:ID|Id)|supersededBy)$/.test(key)) into.add(value);
  else if (Array.isArray(value)) for (const entry of value) references(entry, into);
  else if (record(value)) for (const [field, entry] of Object.entries(value)) references(entry, into, field);
}
function sessionTime(session: SessionState): number {
  const times = [session.lastActiveAt, session.lastRunAt, session.reviewSkipAt, session.reviewStartedAt].map(date).filter(Number.isFinite);
  return times.length ? Math.max(...times) : Number.NaN;
}
function isCompleteSnapshot(value: Item | ItemSnapshot | undefined): value is Item {
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

async function optionalText(store: Store, relative: string): Promise<string> {
  const full = await safeStorePath(store.dataDir, path.join(store.dataDir, relative));
  try {
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error("symlink / 符号链接历史路径，清理已停止");
    if (!info.isFile()) throw new Error("历史记录不是普通文件，清理已停止");
    return await readFile(full, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

async function optionalDir(store: Store, relative: string): Promise<string[]> {
  const directory = await safeStorePath(store.dataDir, path.join(store.dataDir, relative));
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) throw new Error("symlink / 符号链接历史路径，清理已停止");
    if (!info.isDirectory()) throw new Error("历史目录不是普通目录，清理已停止");
    return (await readdir(directory)).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function fileSize(file: string): Promise<number> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
  for (const name of names) {
    const full = path.join(directory, name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error("symlink / 符号链接历史路径，清理已停止");
    if (info.isDirectory()) total += await directoryBytes(full);
    else if (info.isFile()) total += info.size;
  }
  return total;
}

function parseJsonLines<T>(relative: string, text: string): T[] {
  const rows: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      throw new Error(`数据文件损坏：${path.basename(relative)}；原文件已保留，清理已停止`);
    }
  }
  return rows;
}

async function readJournals(store: Store): Promise<{ files: ManagedJournalFile[]; unreadable: boolean }> {
  const files: ManagedJournalFile[] = [];
  let unreadable = false;
  for (const name of await optionalDir(store, "change-journal")) {
    if (!name.endsWith(".json")) continue;
    const relative = `change-journal/${name}`;
    const full = await safeStorePath(store.dataDir, path.join(store.dataDir, relative));
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error("symlink / 符号链接历史路径，清理已停止");
    if (!info.isFile()) continue;
    const text = await readFile(full, "utf8");
    let journal: ChangeJournal | undefined;
    try {
      const value: unknown = JSON.parse(text);
      if (record(value) && typeof value.id === "string" && typeof value.itemID === "string") {
        journal = value as unknown as ChangeJournal;
      }
    } catch {
      journal = undefined;
    }
    if (!journal) unreadable = true;
    files.push({ name, relative, bytes: Buffer.byteLength(text), hash: hash(text), ...(journal ? { journal } : {}) });
  }
  return { files, unreadable };
}

async function checkpointManifest(
  store: Store,
  directory: string,
  prefix: string,
): Promise<{ bytes: number; files: Array<[string, string, number]> }> {
  let bytes = 0;
  const files: Array<[string, string, number]> = [];
  for (const name of (await readdir(directory)).sort()) {
    const full = await safeStorePath(store.dataDir, path.join(directory, name));
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error("symlink / 符号链接历史路径，清理已停止");
    const relative = `${prefix}/${name}`;
    if (info.isDirectory()) {
      const nested = await checkpointManifest(store, full, relative);
      bytes += nested.bytes;
      files.push(...nested.files);
    } else if (info.isFile()) {
      const text = await readFile(full);
      const size = Buffer.byteLength(text);
      bytes += size;
      files.push([relative, hash(text), size]);
    } else {
      throw new Error("未知历史路径类型，清理已停止");
    }
  }
  return { bytes, files };
}

async function readMigrations(store: Store): Promise<{ files: ManagedMigrationFile[]; unreadable: boolean; checkpoints: ManagedCheckpoint[] }> {
  const files: ManagedMigrationFile[] = [];
  let unreadable = false;
  for (const name of await optionalDir(store, "migrations")) {
    if (!name.endsWith(".json")) continue;
    const relative = `migrations/${name}`;
    const full = await safeStorePath(store.dataDir, path.join(store.dataDir, relative));
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error("symlink / 符号链接历史路径，清理已停止");
    if (!info.isFile()) continue;
    const text = await readFile(full, "utf8");
    let value: RecordValue | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (record(parsed)) value = parsed;
    } catch {
      value = undefined;
    }
    if (!value) unreadable = true;
    files.push({ name, relative, bytes: Buffer.byteLength(text), hash: hash(text), ...(value ? { value } : {}) });
  }
  const checkpoints: ManagedCheckpoint[] = [];
  for (const name of await optionalDir(store, "backup")) {
    if (!name.startsWith("checkpoint-")) continue;
    const relative = `backup/${name}`;
    const full = await safeStorePath(store.dataDir, path.join(store.dataDir, relative));
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error("symlink / 符号链接历史路径，清理已停止");
    if (info.isDirectory()) {
      const manifest = await checkpointManifest(store, full, relative);
      checkpoints.push({ name, relative, bytes: manifest.bytes, files: manifest.files });
    } else if (info.isFile()) {
      const text = await readFile(full);
      const size = Buffer.byteLength(text);
      checkpoints.push({ name, relative, bytes: size, files: [[relative, hash(text), size]] });
    } else {
      throw new Error("未知历史路径类型，清理已停止");
    }
  }
  return { files, unreadable, checkpoints };
}

function unfinishedMigration(row: RecordValue): boolean {
  return row.undoing === true || row.restoring === true || row.applying === true ||
    row.status === "applying" || row.status === "undoing" || row.status === "restoring";
}

function migrationReferences(row: RecordValue | undefined): string[] {
  if (!row) return [];
  const direct = Array.isArray(row.changeIDs) ? row.changeIDs : [];
  const referenced = Array.isArray(row.referencedChanges) ? row.referencedChanges : [];
  return [...direct, ...referenced].flatMap((value) => typeof value === "string" ? [value] : []);
}

/**
 * Plan the bounded derived-history ledger. `items` is the current snapshot so
 * active latest events and item `changeID` pointers can be protected.
 */
async function planManagedHistory(
  store: Store,
  now: number,
  items: Item[],
  retainDays: number,
  unfinishedMerge: boolean,
  options: { candidatePrunedItemIDs?: Set<string>; externalRefs?: Set<string> } = {},
): Promise<ManagedHistoryPlan> {
  const windowStart = now - retainDays * DAY;
  const changesText = await optionalText(store, "changes.jsonl");
  const changes = parseJsonLines<ChangeEvent>("changes.jsonl", changesText);
  const suppressionsText = await optionalText(store, "suppressions.jsonl");
  const suppressions = parseJsonLines<Suppression>("suppressions.jsonl", suppressionsText);
  const quarantineText = await optionalText(store, "extract-quarantine.jsonl");
  const quarantine = parseJsonLines<ExtractQuarantineRecord>("extract-quarantine.jsonl", quarantineText);
  const retiredText = await optionalText(store, "retired-sources.jsonl");
  const retired = parseJsonLines<RecordValue>("retired-sources.jsonl", retiredText);
  const globalText = await optionalText(store, "global-candidates.jsonl");
  const globals = parseJsonLines<RecordValue>("global-candidates.jsonl", globalText);
  const journalScan = await readJournals(store);
  const migrations = await readMigrations(store);

  const blockedReasons: string[] = [];
  const notes: string[] = [];
  const block = (reason: string) => { if (!blockedReasons.includes(reason)) blockedReasons.push(reason); };
  const note = (reason: string) => { if (!notes.includes(reason)) notes.push(reason); };

  const wal = await safeStorePath(store.dataDir, path.join(store.dataDir, ".pending-transaction.json"));
  const walPresent = await lstat(wal).then(() => true).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  });
  const migrationUnfinished = migrations.files.some((file) => file.value !== undefined && unfinishedMigration(file.value));
  if (walPresent) block("wal_pending");
  if (migrationUnfinished) block("migration_unfinished");
  if (journalScan.unreadable) block("change_journal_unreadable");
  if (migrations.unreadable) block("migration_journal_unreadable");
  if (unfinishedMerge) block("merge_journal_unfinished");
  const hardStop = walPresent || migrationUnfinished || journalScan.unreadable ||
    migrations.unreadable || unfinishedMerge;

  const byID = new Map(changes.map((event) => [event.id, event]));
  const itemByID = new Map(items.map((item) => [item.id, item]));
  const latestByItem = new Map<string, ChangeEvent>();
  const itemEvents = new Map<string, ChangeEvent[]>();
  for (const event of changes) {
    latestByItem.set(event.itemID, event);
    const list = itemEvents.get(event.itemID);
    if (list) list.push(event);
    else itemEvents.set(event.itemID, [event]);
  }

  const candidates = hardStop
    ? new Set<string>()
    : new Set(options.candidatePrunedItemIDs ?? []);
  const keptItemIDs = new Set(items.filter((item) => !candidates.has(item.id)).map((item) => item.id));
  const roots = new Set<string>();
  const addRoot = (id: string | undefined) => {
    if (id && byID.has(id)) roots.add(id);
  };
  const addItemRoots = (ids: Iterable<string>) => {
    for (const id of ids) {
      const item = itemByID.get(id);
      if (!item) continue;
      addRoot(item.changeID);
      if (item.status === "auto" || item.status === "promoted") addRoot(latestByItem.get(item.id)?.id);
    }
  };
  for (const reference of options.externalRefs ?? []) addRoot(reference);
  addItemRoots(keptItemIDs);

  // Complete snapshots inside the version-restore window are roots.
  for (const event of changes) {
    const time = Date.parse(event.at);
    if (!Number.isFinite(time)) {
      addRoot(event.id);
      note("change_time_unknown");
      continue;
    }
    if (time >= windowStart && (isCompleteSnapshot(event.before) || isCompleteSnapshot(event.after))) {
      addRoot(event.id);
    }
  }

  // A migration only protects its referenced changes while it is unfinished,
  // pinned, or inside its rollback window. Completed out-of-window migrations
  // remain as audit files but do not shield arbitrary history.
  const migrationActive = (row: RecordValue): boolean => {
    if (unfinishedMigration(row)) return true;
    if (row.pinned === true) return true;
    if (row.undone === true) return false;
    const created = Date.parse(typeof row.createdAt === "string" ? row.createdAt : "");
    return Number.isFinite(created) && created >= windowStart;
  };
  for (const file of migrations.files) {
    if (!file.value || !migrationActive(file.value)) continue;
    for (const id of migrationReferences(file.value)) addRoot(id);
  }

  const protectedJournalFiles = new Set<string>();
  const journalEventIDs = new Set(journalScan.files.flatMap((file) => file.journal ? [file.journal.id] : []));
  for (const file of journalScan.files) {
    const journal = file.journal;
    if (!journal) {
      // Unparseable journals are a hard stop above; keep the file.
      protectedJournalFiles.add(file.relative);
      continue;
    }
    if (!byID.has(journal.id)) {
      protectedJournalFiles.add(file.relative);
      note("journal_without_event");
    }
    if (journal.undoing) {
      protectedJournalFiles.add(file.relative);
      addRoot(journal.id);
      addRoot(journal.reverts);
      if (itemByID.has(journal.itemID)) {
        candidates.delete(journal.itemID);
        keptItemIDs.add(journal.itemID);
        addItemRoots([journal.itemID]);
      }
    }
  }
  // A revertible event without its journal cannot be verified; keep it.
  for (const event of changes) {
    if (event.revertible && !journalEventIDs.has(event.id)) {
      addRoot(event.id);
      note("missing_change_journal");
    }
  }
  if (hardStop) {
    for (const event of changes) addRoot(event.id);
    for (const file of journalScan.files) protectedJournalFiles.add(file.relative);
  }

  const closure = (): Set<string> => {
    const seen = new Set(roots);
    const frontier = [...seen];
    while (frontier.length > 0) {
      const id = frontier.pop();
      const event = id ? byID.get(id) : undefined;
      if (!event) continue;
      for (const dependency of [...(event.dependsOn ?? []), ...(event.reverts ? [event.reverts] : [])]) {
        if (byID.has(dependency) && !seen.has(dependency)) {
          seen.add(dependency);
          frontier.push(dependency);
        }
      }
    }
    return seen;
  };
  let protectedChangeIDs = closure();

  // Candidate items are pruned only when no surviving root references their
  // history. Revocation adds the item's own roots and re-runs the one closure;
  // it never deletes an event that the final set protects.
  let revoked = true;
  while (revoked) {
    revoked = false;
    for (const item of items) {
      if (!candidates.has(item.id)) continue;
      const own = itemEvents.get(item.id) ?? [];
      if (!own.some((event) => protectedChangeIDs.has(event.id))) continue;
      candidates.delete(item.id);
      keptItemIDs.add(item.id);
      addItemRoots([item.id]);
      revoked = true;
    }
    if (revoked) protectedChangeIDs = closure();
  }
  for (const file of journalScan.files) {
    if (file.journal && protectedChangeIDs.has(file.journal.id)) protectedJournalFiles.add(file.relative);
  }

  const recentPerItem = new Set<string>();
  {
    const seen = new Map<string, number>();
    const newestFirst = [...changes].sort((left, right) => {
      const rightTime = Date.parse(right.at);
      const leftTime = Date.parse(left.at);
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0) ||
        right.id.localeCompare(left.id);
    });
    for (const event of newestFirst) {
      const count = seen.get(event.itemID) ?? 0;
      if (count < MANAGED_HISTORY_LIMITS.changesPerItem) recentPerItem.add(event.id);
      seen.set(event.itemID, count + 1);
    }
  }
  const computeNext = () => {
    const nextChanges = changes.filter((event) => {
      if (protectedChangeIDs.has(event.id)) return true;
      if (!keptItemIDs.has(event.itemID)) return false;
      if (!recentPerItem.has(event.id)) return false;
      const time = Date.parse(event.at);
      return Number.isFinite(time) && time >= windowStart;
    });
    const nextChangeIDs = new Set(nextChanges.map((event) => event.id));
    const nextJournals = journalScan.files.filter((file) =>
      !file.journal || protectedJournalFiles.has(file.relative) || nextChangeIDs.has(file.journal.id));
    return { nextChanges, nextJournals };
  };
  let { nextChanges, nextJournals } = computeNext();
  // Retained journals can themselves reference changes/items that are not in
  // the ledger closure (legacy/orphan journals or migration snapshots). Feed
  // every retained journal's real reverts/snapshot references back into the
  // same roots until neither journalled roots nor kept items grow. This is a
  // reference closure, not a blanket retention of all history.
  while (true) {
    const rootCount = roots.size;
    const keptCount = keptItemIDs.size;
    const journalRefs = new Set<string>();
    for (const file of nextJournals) {
      const journal = file.journal;
      if (!journal) continue;
      if (journal.reverts) journalRefs.add(journal.reverts);
      references(journal.before, journalRefs);
      references(journal.after, journalRefs);
    }
    for (const reference of journalRefs) {
      if (byID.has(reference)) addRoot(reference);
      else if (itemByID.has(reference) && !keptItemIDs.has(reference)) {
        keptItemIDs.add(reference);
        candidates.delete(reference);
        addItemRoots([reference]);
      }
    }
    if (roots.size !== rootCount || keptItemIDs.size !== keptCount) {
      protectedChangeIDs = closure();
      for (const file of journalScan.files) {
        if (file.journal && protectedChangeIDs.has(file.journal.id)) protectedJournalFiles.add(file.relative);
      }
      for (const item of items) {
        if (!candidates.has(item.id)) continue;
        if (!(itemEvents.get(item.id) ?? []).some((event) => protectedChangeIDs.has(event.id))) continue;
        candidates.delete(item.id);
        keptItemIDs.add(item.id);
        addItemRoots([item.id]);
      }
      if (roots.size !== rootCount || keptItemIDs.size !== keptCount) {
        protectedChangeIDs = closure();
        for (const file of journalScan.files) {
          if (file.journal && protectedChangeIDs.has(file.journal.id)) protectedJournalFiles.add(file.relative);
        }
      }
      ({ nextChanges, nextJournals } = computeNext());
      continue;
    }
    break;
  }
  const nextChangeIDs = new Set(nextChanges.map((event) => event.id));
  const deletedJournals = journalScan.files.filter((file) => !nextJournals.includes(file));
  const deletedJournalFiles = new Set(deletedJournals.map((file) => file.relative));
  const nextItems = items.filter((item) => keptItemIDs.has(item.id));
  if (nextChanges.length > MANAGED_HISTORY_LIMITS.changes) block("changes_capacity");
  if (nextJournals.length > MANAGED_HISTORY_LIMITS.changes) block("change_journals_capacity");

  const activeItemIDs = new Set(items.filter((item) => item.status === "auto" || item.status === "promoted").map((item) => item.id));
  const stoppedItemIDs = new Set(items.filter((item) =>
    item.status === "archived" && (item.supersededBy === "deactivate" || item.supersededBy === "revert")).map((item) => item.id));
  const retiredMessageKeys = new Set<string>();
  const keyOf = (sessionID: string, messageID: string) => `${sessionID}\u0000${messageID}`;
  for (const row of retired) {
    if (typeof row.sessionID === "string" && typeof row.messageID === "string") {
      retiredMessageKeys.add(keyOf(row.sessionID, row.messageID));
    }
    const entries = Array.isArray(row.items) ? row.items : [];
    for (const entry of entries) {
      if (record(entry) && typeof entry.itemID === "string") stoppedItemIDs.add(entry.itemID);
    }
  }
  const hookMessageKey = (hookKey: string): string | undefined => {
    const parts = hookKey.replace(/^review\|/u, "").split("|");
    return parts.length >= 2 ? keyOf(parts[0], parts[1]) : undefined;
  };
  const nextSuppressions = suppressions.filter((row) => {
    if (!row.until) {
      note("suppression_until_missing");
      return true;
    }
    const until = Date.parse(row.until);
    if (!Number.isFinite(until) || until > now) return true;
    if (stoppedItemIDs.has(row.itemID)) return true;
    if (activeItemIDs.has(row.itemID)) return true;
    const key = hookMessageKey(row.hookKey);
    if (key && retiredMessageKeys.has(key)) return true;
    return false;
  });
  if (nextSuppressions.length > MANAGED_HISTORY_LIMITS.suppressions) block("suppression_tombstone_capacity");

  const retainedQuarantine = quarantine.filter((row) => {
    const expires = Date.parse(row.expiresAt);
    return !Number.isFinite(expires) || expires > now;
  });
  let nextQuarantine = retainedQuarantine;
  if (retainedQuarantine.length > MANAGED_HISTORY_LIMITS.quarantine) {
    const overflow = retainedQuarantine.length - MANAGED_HISTORY_LIMITS.quarantine;
    const candidatesForDrop = retainedQuarantine
      .filter((row) => Number.isFinite(Date.parse(row.at)))
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
      .slice(0, overflow);
    if (candidatesForDrop.length < overflow) block("quarantine_capacity");
    else {
      const drop = new Set(candidatesForDrop);
      nextQuarantine = retainedQuarantine.filter((row) => !drop.has(row));
    }
  }

  const nextSuppressionSet = new Set(nextSuppressions);
  const nextQuarantineSet = new Set(nextQuarantine);
  const changesDeletionBytes = changes
    .filter((event) => !nextChangeIDs.has(event.id))
    .reduce((total, event) => total + rowBytes(event), 0);
  const journalDeletionBytes = deletedJournals.reduce((total, file) => total + file.bytes, 0);
  const suppressionDeletionBytes = suppressions
    .filter((row) => !nextSuppressionSet.has(row))
    .reduce((total, row) => total + rowBytes(row), 0);
  const quarantineDeletionBytes = quarantine
    .filter((row) => !nextQuarantineSet.has(row))
    .reduce((total, row) => total + rowBytes(row), 0);

  const fixedBytes = (await Promise.all([
    "changes.jsonl",
    "suppressions.jsonl",
    "extract-quarantine.jsonl",
    "retired-sources.jsonl",
    "global-candidates.jsonl",
    "retired-source-state.json",
    "global-candidate-state.json",
  ].map((relative) => fileSize(path.join(store.dataDir, relative)))))
    .reduce((total, value) => total + value, 0);
  const journalBytes = journalScan.files.reduce((total, file) => total + file.bytes, 0);
  const migrationBytes = migrations.files.reduce((total, file) => total + file.bytes, 0);
  const checkpointBytes = migrations.checkpoints.reduce((total, checkpoint) => total + checkpoint.bytes, 0);

  return {
    changes,
    nextChanges,
    journals: journalScan.files,
    nextJournals,
    deletedJournalFiles,
    nextItems,
    protectedChangeIDs,
    protectedJournalFiles,
    migrations: migrations.files,
    checkpoints: migrations.checkpoints,
    suppressions,
    nextSuppressions,
    quarantine,
    nextQuarantine,
    changesDeletionBytes,
    journalDeletionBytes,
    suppressionDeletionBytes,
    quarantineDeletionBytes,
    protectedChanges: protectedChangeIDs.size,
    protectedJournals: protectedJournalFiles.size,
    protectedSuppressions: nextSuppressions.length,
    counts: {
      changes: changes.length,
      changeJournals: journalScan.files.length,
      suppressions: suppressions.length,
      quarantine: quarantine.length,
      retiredSources: retired.length,
      globalCandidates: globals.length,
      migrationJournals: migrations.files.length,
      checkpointBackups: migrations.checkpoints.length,
    },
    historyBytes: fixedBytes + journalBytes + migrationBytes + checkpointBytes,
    blockedReasons,
    notes,
  };
}

async function planRetention(store: Store, now: number, options: { pruneItems?: boolean } = {}) {
  for (const file of [store.statePath, store.itemsPath, store.queuePath, store.journalPath, store.changelogPath]) await safeStorePath(store.dataDir, file);
  const files = new Map<string, string>();
  const groups: Group[] = [];
  const state = await store.readState();
  const items = await store.listItems();
  const queue = await store.listQueue();
  const merges = await store.listJournal();
  const history = await store.listChangelog();
  const config = await store.readConfig();
  const retainDays = Number.isFinite(config.undo?.retainDays)
    ? Math.max(1, Math.floor(Number(config.undo.retainDays)))
    : DEFAULT_RETAIN_DAYS;
  const knownQueue = new Set(queue.map((item) => item.id));
  const load = async (relative: string): Promise<string> => {
    const full = await safeStorePath(store.dataDir, path.join(store.dataDir, relative));
    if (!(await lstat(full)).isFile()) throw new Error("历史记录不是普通文件，清理已停止");
    const text = await readFile(full, "utf8");
    files.set(relative, text);
    return text;
  };
  for (const type of ["maintenance", "recovery", "curator", "session-archive"]) {
    const directory = await safeStorePath(store.dataDir, path.join(store.dataDir, type));
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
    const consumed = new Set<string>();
    for (const name of names.sort()) {
      const relative = `${type}/${name}`;
      const info = await lstat(path.join(directory, name));
      if (info.isSymbolicLink()) throw new Error("symlink / 符号链接历史路径，清理已停止");
      if (!info.isFile() || !name.endsWith(".json")) continue;
      const text = await load(relative);
      let raw: RecordValue | undefined;
      try { const value: unknown = JSON.parse(text); if (record(value)) raw = value; } catch { /* Preserve unreadable legacy records. */ }
      const id = name.slice(0, -5);
      const group: Group = { id, type, at: raw ? at(raw) : Number.NaN, raw, files: [relative], keep: !raw || raw.id !== id || Boolean(raw.undoing || raw.restoring) };
      if (raw && record(raw.queue) && knownQueue.has(String(raw.queue.id))) group.keep = true;
      // A cold session is the canonical cursor/context, not a disposable backup.
      // Deleting it would turn a resumed conversation into a new scan.
      if (type === "session-archive") group.keep = true;
      if (type === "maintenance") {
        const backup = `${id}.items.bak`;
        if (names.includes(backup)) { await load(`${type}/${backup}`); group.files.push(`${type}/${backup}`); consumed.add(backup); }
      }
      if (type === "curator") {
        const backup = `items.jsonl.bak-${id}`;
        try { await load(backup); group.files.push(backup); } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
      consumed.add(name);
      groups.push(group);
    }
    // Orphan backups and unknown files are protected, never guessed stale.
    for (const name of names) if (!consumed.has(name) && (await lstat(path.join(directory, name))).isFile()) {
      await load(`${type}/${name}`);
      groups.push({ id: name, type, at: Number.NaN, files: [`${type}/${name}`], keep: true });
    }
    const keep = recent(groups.filter((group) => group.type === type), (group) => group.at, now);
    for (const group of keep) group.keep = true;
  }
  const keepMerges = recent(merges, (row) => date(row.at), now);
  for (const row of merges) if (row.undoing || (!row.undone && !row.after?.item && !row.after?.target)) keepMerges.add(row);
  const keepHistory = recent(history, at, now);
  const refs = new Set<string>();
  references(queue, refs);
  references(items.filter((item) => item.status !== "archived"), refs);
  references([...keepHistory], refs);
  // Retained recovery chains protect every linked journal and item snapshot.
  let changed = true;
  while (changed) {
    const before = refs.size;
    for (const row of merges) if (keepMerges.has(row) || refs.has(row.id)) { keepMerges.add(row); references(row, refs); }
    for (const group of groups) if (group.keep || refs.has(group.id)) { group.keep = true; references(group.raw, refs); }
    changed = refs.size !== before;
  }
  // Stopped/reverted rows keep their tombstones and can be restored without a
  // time limit; manual/rule rows never become retention fodder.
  const retiredRows = parseJsonLines<RecordValue>("retired-sources.jsonl", await optionalText(store, "retired-sources.jsonl"));
  for (const row of retiredRows) {
    const entries = Array.isArray(row.items) ? row.items : [];
    for (const entry of entries) if (record(entry)) {
      if (typeof entry.itemID === "string") refs.add(entry.itemID);
      if (typeof entry.changeID === "string") refs.add(entry.changeID);
    }
  }
  const archived = items.filter((item) => item.status === "archived");
  const keepItems = recent(archived, (item) => date(item.updatedAt ?? item.createdAt), now);
  // Candidate item pruning stays conservative; the managed-history planner
  // revokes a candidate if any surviving root still needs one of its events.
  const candidateNextItems = options.pruneItems === false ? items : items.filter((item) =>
    item.status !== "archived" ||
    keepItems.has(item) ||
    refs.has(item.id) ||
    item.manual === true ||
    item.kind === "rule" ||
    item.supersededBy === "deactivate" ||
    item.supersededBy === "revert");
  const candidatePrunedItemIDs = new Set(items
    .filter((item) => !candidateNextItems.includes(item))
    .map((item) => item.id));
  const managed = await planManagedHistory(
    store,
    now,
    items,
    retainDays,
    merges.some((row) => Boolean(row.undoing)),
    { candidatePrunedItemIDs, externalRefs: refs },
  );
  const nextItems = managed.nextItems;
  const nextMerges = merges.filter((row) => keepMerges.has(row));
  const nextHistory = history.filter((row) => keepHistory.has(row));
  const deleteFiles = groups.filter((group) => !group.keep).flatMap((group) => group.files).sort();
  const archiveSessions = Object.entries(state.sessions).filter(([, session]) =>
    Number.isFinite(sessionTime(session)) && now - sessionTime(session) > RETENTION_POLICY.sessionDays * DAY &&
    !session.pendingReview && !session.reviewDueAt && session.reviewStatus !== "running" && session.reviewStatus !== "scheduled")
    .map(([id]) => id).sort();
  const deletedJournalFiles = managed.deletedJournalFiles;
  const nextChangeSet = new Set(managed.nextChanges);
  const nextSuppressionSet = new Set(managed.nextSuppressions);
  const nextQuarantineSet = new Set(managed.nextQuarantine);
  const deletedChanges = managed.changes.filter((event) => !nextChangeSet.has(event)).map((event) => event.id);
  const deletedSuppressions = managed.suppressions
    .filter((row) => !nextSuppressionSet.has(row))
    .map((row) => row.id);
  const deletedQuarantine = managed.quarantine
    .filter((row) => !nextQuarantineSet.has(row))
    .map((row) => row.id);
  const historyReclaim = managed.changesDeletionBytes + managed.journalDeletionBytes +
    managed.suppressionDeletionBytes + managed.quarantineDeletionBytes;
  const filesReclaim = deleteFiles.reduce((total, name) => total + Buffer.byteLength(files.get(name) ?? ""), 0);
  const id = hash(JSON.stringify({ policy: RETENTION_POLICY, retainDays, state, items, queue, merges, history,
    files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, text]) => [name, hash(text)]), deleteFiles, archiveSessions,
    nextItems, nextMerges, nextHistory,
    managed: {
      changes: hash(await optionalText(store, "changes.jsonl")),
      suppressions: hash(await optionalText(store, "suppressions.jsonl")),
      quarantine: hash(await optionalText(store, "extract-quarantine.jsonl")),
      retired: hash(await optionalText(store, "retired-sources.jsonl")),
      retiredState: hash(await optionalText(store, "retired-source-state.json")),
      global: hash(await optionalText(store, "global-candidates.jsonl")),
      globalState: hash(await optionalText(store, "global-candidate-state.json")),
      journals: managed.journals.map((file) => [file.relative, file.hash]),
      migrations: managed.migrations.map((file) => [file.relative, file.hash]),
      checkpoints: managed.checkpoints.map((checkpoint) => [checkpoint.relative, checkpoint.bytes, checkpoint.files]),
      deletedChanges, deletedJournals: [...deletedJournalFiles].sort(), deletedSuppressions, deletedQuarantine,
      blockedReasons: managed.blockedReasons,
    } }));
  const preview: RetentionPreview = {
    id,
    policy: RETENTION_POLICY,
    retainDays,
    deleteFiles,
    archiveSessions,
    pruneItems: items.length - nextItems.length,
    pruneMerges: merges.length - nextMerges.length,
    pruneHistory: history.length - nextHistory.length,
    reclaimableBytes: filesReclaim +
      Buffer.byteLength(jsonl(items)) - Buffer.byteLength(jsonl(nextItems)) + Buffer.byteLength(jsonl(merges)) - Buffer.byteLength(jsonl(nextMerges)) +
      Buffer.byteLength(jsonl(history)) - Buffer.byteLength(jsonl(nextHistory)) + historyReclaim,
    reclaimable: {
      filesBytes: filesReclaim,
      changesBytes: managed.changesDeletionBytes,
      changeJournalBytes: managed.journalDeletionBytes,
      suppressionBytes: managed.suppressionDeletionBytes,
      quarantineBytes: managed.quarantineDeletionBytes,
    },
    protectedCount: groups.filter((group) => group.keep).length + keepMerges.size + keepHistory.size + keepItems.size,
    protectedChanges: managed.protectedChanges,
    protectedJournals: managed.protectedJournals,
    protectedSuppressions: managed.protectedSuppressions,
    pruneChanges: deletedChanges.length,
    pruneChangeJournals: deletedJournalFiles.size,
    pruneSuppressions: deletedSuppressions.length,
    pruneQuarantine: deletedQuarantine.length,
    deletedChanges,
    deletedChangeJournals: [...deletedJournalFiles].sort(),
    deletedSuppressions,
    deletedQuarantine,
    counts: managed.counts,
    historyBytes: managed.historyBytes,
    blocked: managed.blockedReasons.length > 0,
    blockedReasons: managed.blockedReasons,
    notes: managed.notes,
  };
  return { preview, state, nextItems, nextMerges, nextHistory, managed };
}

/** Remove only the derived-history rows already selected by the plan. */
async function applyManagedHistory(
  store: Store,
  plan: Awaited<ReturnType<typeof planRetention>>,
): Promise<void> {
  for (const relative of plan.preview.deletedChangeJournals) await store.deleteDataFile(relative);
  if (plan.preview.pruneChanges > 0) {
    await store.writeTextAtomic(store.changesPath, jsonl(plan.managed.nextChanges));
  }
  if (plan.preview.pruneSuppressions > 0) {
    await store.writeTextAtomic(store.suppressionsPath, jsonl(plan.managed.nextSuppressions));
  }
  if (plan.preview.pruneQuarantine > 0) {
    await store.writeTextAtomic(store.extractQuarantinePath, jsonl(plan.managed.nextQuarantine));
  }
}

export async function previewRetention(store: Store, now = Date.now()): Promise<RetentionPreview> {
  return (await planRetention(store, now)).preview;
}

export async function applyRetention(store: Store, previewID: string, confirmed: boolean, now = Date.now()): Promise<RetentionPreview> {
  if (confirmed !== true) throw new Error("历史清理需要用户确认");
  return store.transaction(async () => {
    const plan = await planRetention(store, now);
    if (!/^[a-f0-9]{64}$/.test(previewID) || plan.preview.id !== previewID) throw new Error("数据已变化，原预览失效，请重新预览");
    const sessions = { ...plan.state.sessions };
    for (const sessionID of plan.preview.archiveSessions) {
      const file = store.sessionArchivePath(sessionID);
      const id = path.basename(file, ".json");
      await store.writeTextAtomic(file, `${JSON.stringify({ id, sessionID, createdAt: new Date(now).toISOString(), state: sessions[sessionID] })}\n`);
      delete sessions[sessionID];
    }
    await applyManagedHistory(store, plan);
    for (const file of plan.preview.deleteFiles) await store.deleteDataFile(file);
    if (plan.preview.archiveSessions.length) await store.updateState({ sessions });
    if (plan.preview.pruneItems) await store.replaceItems(plan.nextItems);
    if (plan.preview.pruneMerges) await store.writeTextAtomic(store.journalPath, jsonl(plan.nextMerges));
    if (plan.preview.pruneHistory) await store.writeTextAtomic(store.changelogPath, jsonl(plan.nextHistory));
    await store.appendChangelog({ action: "retention", days: RETENTION_POLICY.days, minRecords: RETENTION_POLICY.minRecords,
      deletedFiles: plan.preview.deleteFiles.length, archivedSessions: plan.preview.archiveSessions.length,
      prunedItems: plan.preview.pruneItems, prunedMerges: plan.preview.pruneMerges, reclaimableBytes: plan.preview.reclaimableBytes,
      deletedChanges: plan.preview.pruneChanges, deletedChangeJournals: plan.preview.pruneChangeJournals,
      deletedSuppressions: plan.preview.pruneSuppressions, deletedQuarantine: plan.preview.pruneQuarantine,
      blockedReasons: plan.preview.blockedReasons });
    return plan.preview;
  });
}

/**
 * Background safe reclaim inside the approved policy: expired/duplicate auto
 * items are handled by the curator, TTL quarantine and retired tombstones by
 * lifecycle maintenance, and this function shrinks only derived history that
 * is outside the retention window and unreferenced. It never hard-deletes
 * manual/promoted/rule/stopped items, sessions, merges or the changelog.
 */
export async function pruneManagedHistory(
  store: Store,
  now = Date.now(),
  options: { claim?: boolean } = {},
): Promise<HistoryPruneResult> {
  if (store.inTransaction) return emptyPruneResult("transaction");
  let token: string | undefined;
  if (options.claim !== false) {
    token = await store.claim("retention:auto", 30_000);
    if (!token) return emptyPruneResult("claim", new Date(now + 30_000).toISOString());
  }
  try {
    // The lease above only covers concurrent overlap. This persistent gate is
    // the actual cooldown: it survives a failed or zero-reclaim scan, and both
    // automatic paths short-circuit before any planRetention scan.
    const reserved = await store.tryReserveRetentionRun(now);
    if (!reserved.ok) return emptyPruneResult("cooldown", reserved.retryAt);
    return await store.transaction(async () => {
      const plan = await planRetention(store, now, { pruneItems: false });
      await applyManagedHistory(store, plan);
      const result: HistoryPruneResult = {
        deleteFiles: 0,
        deletedChanges: plan.preview.pruneChanges,
        deletedChangeJournals: plan.preview.pruneChangeJournals,
        deletedSuppressions: plan.preview.pruneSuppressions,
        deletedQuarantine: plan.preview.pruneQuarantine,
        reclaimedBytes: plan.managed.changesDeletionBytes + plan.managed.journalDeletionBytes +
          plan.managed.suppressionDeletionBytes + plan.managed.quarantineDeletionBytes,
        remainingReclaimableBytes: Math.max(0, plan.preview.reclaimableBytes - (
          plan.managed.changesDeletionBytes + plan.managed.journalDeletionBytes +
          plan.managed.suppressionDeletionBytes + plan.managed.quarantineDeletionBytes)),
        protectedChanges: plan.preview.protectedChanges,
        protectedJournals: plan.preview.protectedJournals,
        protectedSuppressions: plan.preview.protectedSuppressions,
        blocked: plan.preview.blocked,
        blockedReasons: plan.preview.blockedReasons,
        notes: plan.preview.notes,
      };
      const retained = {
        at: new Date(now).toISOString(),
        deleted: {
          changes: result.deletedChanges,
          journals: result.deletedChangeJournals,
          suppressions: result.deletedSuppressions,
          quarantine: result.deletedQuarantine,
        },
        reclaimedBytes: result.reclaimedBytes,
        // Remaining safe derived-history bytes after this run; never the bytes
        // that were just released.
        remainingReclaimableBytes: result.remainingReclaimableBytes,
        protected: {
          changes: result.protectedChanges,
          journals: result.protectedJournals,
          suppressions: result.protectedSuppressions,
        },
        blocked: result.blocked,
        blockedReasons: result.blockedReasons,
        notes: result.notes,
        ...(result.blocked ? { nextAttemptAt: new Date(now + 5 * 60_000).toISOString() } : {}),
      };
      const previous = (await store.readState()).automation?.retention;
      await store.updateAutomationState({ retention: retained });
      if (result.deletedChanges + result.deletedChangeJournals + result.deletedSuppressions + result.deletedQuarantine > 0) {
        await store.appendChangelog({
          action: "retention_auto",
          count: result.deletedChanges + result.deletedChangeJournals + result.deletedSuppressions + result.deletedQuarantine,
          deletedChanges: result.deletedChanges,
          deletedChangeJournals: result.deletedChangeJournals,
          deletedSuppressions: result.deletedSuppressions,
          deletedQuarantine: result.deletedQuarantine,
          reclaimedBytes: result.reclaimedBytes,
        });
      } else if (result.blocked &&
        (!previous?.blocked || previous.blockedReasons.join(",") !== result.blockedReasons.join(","))) {
        await store.appendChangelog({
          action: "retention_blocked",
          count: result.protectedChanges,
          reasons: result.blockedReasons,
          protectedChanges: result.protectedChanges,
          protectedJournals: result.protectedJournals,
          protectedSuppressions: result.protectedSuppressions,
        });
      }
      return result;
    });
  } finally {
    if (token) await store.releaseReservation("retention:auto", token).catch(() => undefined);
  }
}

function emptyPruneResult(skipped: "claim" | "cooldown" | "transaction", retryAt?: string): HistoryPruneResult {
  return {
    skipped,
    ...(retryAt ? { retryAt } : {}),
    deleteFiles: 0,
    deletedChanges: 0,
    deletedChangeJournals: 0,
    deletedSuppressions: 0,
    deletedQuarantine: 0,
    reclaimedBytes: 0,
    remainingReclaimableBytes: 0,
    protectedChanges: 0,
    protectedJournals: 0,
    protectedSuppressions: 0,
    blocked: false,
    blockedReasons: [],
    notes: [],
  };
}

/**
 * One bounded attempt used before an automatic write is frozen. It never runs
 * inside an open transaction and shares the same claim/cooldown as the
 * maintenance tick, so a queued write cannot trigger a per-request full scan.
 */
export async function reclaimForCapacity(store: Store, now = Date.now()): Promise<HistoryPruneResult> {
  if (store.inTransaction) return emptyPruneResult("transaction");
  return pruneManagedHistory(store, now);
}
