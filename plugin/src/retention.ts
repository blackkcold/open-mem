import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Store } from "./store.js";
import type { SessionState } from "./types.js";
import { safeStorePath } from "./util/transaction.js";

export const RETENTION_POLICY = { days: 90, minRecords: 20, sessionDays: 90 } as const;
const DAY = 86_400_000;
type RecordValue = Record<string, unknown>;
interface Group { id: string; type: string; at: number; raw?: RecordValue; files: string[]; keep: boolean }
export interface RetentionPreview {
  id: string;
  policy: typeof RETENTION_POLICY;
  deleteFiles: string[];
  archiveSessions: string[];
  pruneItems: number;
  pruneMerges: number;
  pruneHistory: number;
  reclaimableBytes: number;
  protectedCount: number;
}
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const date = (value: unknown): number => typeof value === "string" ? Date.parse(value) : Number.NaN;
const at = (value: RecordValue) => date(value.at ?? value.createdAt);
const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const jsonl = (rows: unknown[]) => rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";

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

async function planRetention(store: Store, now: number) {
  for (const file of [store.statePath, store.itemsPath, store.queuePath, store.journalPath, store.changelogPath]) await safeStorePath(store.dataDir, file);
  const files = new Map<string, string>();
  const groups: Group[] = [];
  const state = await store.readState();
  const items = await store.listItems();
  const queue = await store.listQueue();
  const merges = await store.listJournal();
  const history = await store.listChangelog();
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
  const archived = items.filter((item) => item.status === "archived");
  const keepItems = recent(archived, (item) => date(item.updatedAt ?? item.createdAt), now);
  const nextItems = items.filter((item) => item.status !== "archived" || keepItems.has(item) || refs.has(item.id));
  const nextMerges = merges.filter((row) => keepMerges.has(row));
  const nextHistory = history.filter((row) => keepHistory.has(row));
  const deleteFiles = groups.filter((group) => !group.keep).flatMap((group) => group.files).sort();
  const archiveSessions = Object.entries(state.sessions).filter(([, session]) =>
    Number.isFinite(sessionTime(session)) && now - sessionTime(session) > RETENTION_POLICY.sessionDays * DAY &&
    !session.pendingReview && !session.reviewDueAt && session.reviewStatus !== "running" && session.reviewStatus !== "scheduled")
    .map(([id]) => id).sort();
  const id = hash(JSON.stringify({ policy: RETENTION_POLICY, state, items, queue, merges, history,
    files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, text]) => [name, hash(text)]), deleteFiles, archiveSessions,
    nextItems, nextMerges, nextHistory }));
  const preview: RetentionPreview = {
    id, policy: RETENTION_POLICY, deleteFiles, archiveSessions,
    pruneItems: items.length - nextItems.length, pruneMerges: merges.length - nextMerges.length, pruneHistory: history.length - nextHistory.length,
    reclaimableBytes: deleteFiles.reduce((total, name) => total + Buffer.byteLength(files.get(name) ?? ""), 0) +
      Buffer.byteLength(jsonl(items)) - Buffer.byteLength(jsonl(nextItems)) + Buffer.byteLength(jsonl(merges)) - Buffer.byteLength(jsonl(nextMerges)) +
      Buffer.byteLength(jsonl(history)) - Buffer.byteLength(jsonl(nextHistory)),
    protectedCount: groups.filter((group) => group.keep).length + keepMerges.size + keepHistory.size + keepItems.size,
  };
  return { preview, state, nextItems, nextMerges, nextHistory };
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
    for (const file of plan.preview.deleteFiles) await store.deleteDataFile(file);
    if (plan.preview.archiveSessions.length) await store.updateState({ sessions });
    if (plan.preview.pruneItems) await store.replaceItems(plan.nextItems);
    if (plan.preview.pruneMerges) await store.writeTextAtomic(store.journalPath, jsonl(plan.nextMerges));
    if (plan.preview.pruneHistory) await store.writeTextAtomic(store.changelogPath, jsonl(plan.nextHistory));
    await store.appendChangelog({ action: "retention", days: RETENTION_POLICY.days, minRecords: RETENTION_POLICY.minRecords,
      deletedFiles: plan.preview.deleteFiles.length, archivedSessions: plan.preview.archiveSessions.length,
      prunedItems: plan.preview.pruneItems, prunedMerges: plan.preview.pruneMerges, reclaimableBytes: plan.preview.reclaimableBytes });
    return plan.preview;
  });
}
