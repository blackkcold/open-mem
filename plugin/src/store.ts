import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { queueItemSnapshotVersion, itemContentVersion } from "./fingerprint.js";
import type {
  AuditReport,
  AutoMemConfig,
  ChangeEvent,
  ChangeJournal,
  ExtractPendingWork,
  ExtractQuarantineRecord,
  GlobalCandidate,
  GlobalCandidateState,
  HookRecord,
  Item,
  MergeJournal,
  Metrics,
  PersistedState,
  PersistedAutomationState,
  QueueItem,
  RetiredSource,
  RetiredSourceState,
  ReviewRecord,
  ReviewSessionNote,
  SessionState,
  ShadowRecord,
  SkillDraft,
  SourceRef,
  Suppression,
  UsageRecord,
} from "./types.js";
import { DEFAULT_CONFIG } from "./config.js";
import { withFileLock } from "./util/lock.js";
import { commitFileBatch, recoverFileBatch, safeStorePath, type FileBatch } from "./util/transaction.js";
import { sha16 } from "./util/text.js";

const nowIso = () => new Date().toISOString();
export const EXTRACT_PENDING_MAX_ROWS = 50;
export const EXTRACT_PENDING_MAX_BYTES = 200 * 1024;
export const EXTRACT_PENDING_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_EXPIRED_EXTRACT_WINDOW_HASHES = 16;
const MODEL_REQUEST_DAY_MS = 24 * 60 * 60 * 1000;
const MODEL_REQUEST_HOUR_MS = 60 * 60 * 1000;
const EXTRACT_FAIRNESS_DELAY_MS = 15 * 60 * 1000;
const REVIEW_STARVATION_MS = 2 * MODEL_REQUEST_HOUR_MS;
const DAY_MODEL_REQUEST_LIMIT = 40;
type Reservation = number | { expiresAt: number; token?: string };
// Legacy timestamps have no stored TTL. Keep them conservatively for ten
// minutes; new claims always carry their own expiry, independent of the caller.
const reservationExpiry = (value: Reservation, legacyTtl = 10 * 60_000): number =>
  typeof value === "number" ? value + legacyTtl : value?.expiresAt;

function expiredExtractWindowHashes(session: SessionState): string[] {
  return (session.extractExpiredWindowHashes ?? [])
    .filter((hash): hash is string => typeof hash === "string" && hash.length > 0 && hash.length <= 128)
    .slice(-MAX_EXPIRED_EXTRACT_WINDOW_HASHES);
}

function rememberExpiredExtractWindow(
  session: SessionState,
  windowHash: string | undefined,
): { session: SessionState; added: boolean } {
  const hashes = expiredExtractWindowHashes(session);
  const validHash = typeof windowHash === "string" && windowHash.length > 0 && windowHash.length <= 128
    ? windowHash
    : undefined;
  if (!validHash || hashes.includes(validHash)) {
    return {
      session: hashes.length > 0 ? { ...session, extractExpiredWindowHashes: hashes } : session,
      added: false,
    };
  }
  return {
    session: {
      ...session,
      extractExpiredWindowHashes: [...hashes, validHash].slice(-MAX_EXPIRED_EXTRACT_WINDOW_HASHES),
    },
    added: true,
  };
}

function expireExtractPending(session: SessionState): { session: SessionState; newlyExpired: boolean } {
  const windowHash = session.extractPending?.windowHash;
  const { extractPending: _expired, ...rest } = session;
  const terminal = rememberExpiredExtractWindow(rest, windowHash);
  const hasValidHash = typeof windowHash === "string" && windowHash.length > 0 && windowHash.length <= 128;
  return {
    session: terminal.session,
    // Hashless legacy markers still count once when removed; hashed repeats are idempotent.
    newlyExpired: !hasValidHash || terminal.added,
  };
}

function extractPendingEntries(
  state: PersistedState,
  now?: number,
): Array<[string, ExtractPendingWork]> {
  return Object.entries(state.sessions).flatMap(([sessionID, session]) => {
    const pending = session.extractPending;
    if (!pending) return [];
    if (now !== undefined) {
      const createdAt = Date.parse(pending.createdAt ?? pending.updatedAt);
      if (!Number.isFinite(createdAt) || now - createdAt >= EXTRACT_PENDING_TTL_MS) return [];
    }
    return [[sessionID, pending] as [string, ExtractPendingWork]];
  });
}

function extractPendingBytes(entries: Array<[string, ExtractPendingWork]>): number {
  return entries.reduce(
    (total, [sessionID, pending]) => total + Buffer.byteLength(JSON.stringify([sessionID, pending]), "utf8") + 1,
    0,
  );
}

export const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;

async function ensureFile(file: string, content: string): Promise<void> {
  if (!existsSync(file)) await writeFile(file, content, "utf8");
}

function emptyMetrics(): Metrics {
  return {
    generatedAt: nowIso(),
    items: 0,
    queue: 0,
    shadow: 0,
    auto: 0,
    promoted: 0,
    falsePositive: 0,
    falsePositiveRate: 0,
    queueAgeP50Hours: 0,
    queueAgeP95Hours: 0,
    skillDrafts: 0,
    auditFindings: 0,
  };
}

function emptyAudit(): AuditReport {
  return { generatedAt: nowIso(), findings: [], summary: { error: 0, warning: 0, info: 0 } };
}

export class Store {
  readonly dataDir: string;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly pending = new AsyncLocalStorage<FileBatch>();
  private readonly claims = new Map<string, string>();
  private versionCache?: { key: string; version: string; nextExpiry: number | null };

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  get itemsPath() {
    return path.join(this.dataDir, "items.jsonl");
  }
  get queuePath() {
    return path.join(this.dataDir, "queue.json");
  }
  get shadowPath() {
    return path.join(this.dataDir, "shadow.jsonl");
  }
  get hooksPath() {
    return path.join(this.dataDir, "hooks.jsonl");
  }
  get reviewsPath() {
    return path.join(this.dataDir, "reviews.jsonl");
  }
  get digestCachePath() {
    return path.join(this.dataDir, "digest-cache.json");
  }
  get reviewCachePath() {
    return path.join(this.dataDir, "review-cache.json");
  }
  get auditPath() {
    return path.join(this.dataDir, "audit.json");
  }
  get metricsPath() {
    return path.join(this.dataDir, "metrics.json");
  }
  get changelogPath() {
    return path.join(this.dataDir, "changelog.jsonl");
  }
  get configPath() {
    return path.join(this.dataDir, "config.json");
  }
  get statePath() {
    return path.join(this.dataDir, "state.json");
  }
  get tokenPath() {
    return path.join(this.dataDir, "console-token");
  }
  get autoMemoryPath() {
    return path.join(this.dataDir, "AUTO_MEMORY.md");
  }
  get autoRulesPath() {
    return path.join(this.dataDir, "AUTO_RULES.md");
  }
  get skillDraftsDir() {
    return path.join(this.dataDir, "skill-drafts");
  }
  get outboxSkillsDir() {
    return path.join(this.dataDir, "outbox", "skills");
  }
  get reservationsPath() {
    return path.join(this.dataDir, "reservations.json");
  }
  get decisionCachePath() {
    return path.join(this.dataDir, "decision-cache.json");
  }
  get rewriteCachePath() {
    return path.join(this.dataDir, "rewrite-cache.json");
  }
  get journalPath() {
    return path.join(this.dataDir, "merge-journal.jsonl");
  }
  get changesPath() {
    return path.join(this.dataDir, "changes.jsonl");
  }
  get suppressionsPath() {
    return path.join(this.dataDir, "suppressions.jsonl");
  }
  get retiredSourcesPath() {
    return path.join(this.dataDir, "retired-sources.jsonl");
  }
  get retiredSourceStatePath() {
    return path.join(this.dataDir, "retired-source-state.json");
  }
  get globalCandidatesPath() {
    return path.join(this.dataDir, "global-candidates.jsonl");
  }
  get globalCandidateStatePath() {
    return path.join(this.dataDir, "global-candidate-state.json");
  }
  get extractQuarantinePath() {
    return path.join(this.dataDir, "extract-quarantine.jsonl");
  }
  get changeJournalDir() {
    return path.join(this.dataDir, "change-journal");
  }
  get decisionUsagePath() {
    return path.join(this.dataDir, "decision-usage.jsonl");
  }
  get rewriteUsagePath() {
    return path.join(this.dataDir, "rewrite-usage.jsonl");
  }
  get statsPath() {
    return path.join(this.dataDir, "stats.json");
  }
  get lockPath() {
    return path.join(this.dataDir, ".store.lock");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await this.withWriteLock(() => this.initializeFiles());
  }

  private async initializeFiles(): Promise<void> {
    await mkdir(this.skillDraftsDir, { recursive: true });
    await mkdir(this.outboxSkillsDir, { recursive: true });
    await ensureFile(this.itemsPath, "");
    await ensureFile(this.shadowPath, "");
    await ensureFile(this.hooksPath, "");
    await ensureFile(this.reviewsPath, "");
    await ensureFile(this.changelogPath, "");
    await ensureFile(this.journalPath, "");
    await ensureFile(this.changesPath, "");
    await ensureFile(this.suppressionsPath, "");
    await ensureFile(this.retiredSourcesPath, "");
    await ensureFile(this.globalCandidatesPath, "");
    await ensureFile(this.extractQuarantinePath, "");
    if (!existsSync(this.retiredSourceStatePath)) {
      await this.writeJson(this.retiredSourceStatePath, { epoch: 0 });
    }
    if (!existsSync(this.globalCandidateStatePath)) {
      await this.writeJson(this.globalCandidateStatePath, { epoch: 0, blocked: false });
    }
    await mkdir(this.changeJournalDir, { recursive: true });
    await ensureFile(this.decisionUsagePath, "");
    await ensureFile(this.rewriteUsagePath, "");
    await ensureFile(this.autoMemoryPath, "# AUTO_MEMORY\n\n");
    await ensureFile(this.autoRulesPath, "# AUTO_RULES\n\n");
    if (!existsSync(this.configPath)) await this.writeJson(this.configPath, DEFAULT_CONFIG);
    if (!existsSync(this.queuePath)) await this.writeJson(this.queuePath, []);
    if (!existsSync(this.statePath)) await this.writeJson(this.statePath, { sessions: {} });
    if (!existsSync(this.metricsPath)) await this.writeJson(this.metricsPath, emptyMetrics());
    if (!existsSync(this.auditPath)) await this.writeJson(this.auditPath, emptyAudit());
    if (!existsSync(this.reservationsPath)) await this.writeJson(this.reservationsPath, {});
    if (!existsSync(this.decisionCachePath)) await this.writeJson(this.decisionCachePath, {});
    if (!existsSync(this.rewriteCachePath)) await this.writeJson(this.rewriteCachePath, {});
    if (!existsSync(this.digestCachePath)) await this.writeJson(this.digestCachePath, {});
    if (!existsSync(this.reviewCachePath)) await this.writeJson(this.reviewCachePath, {});
    if (!existsSync(this.statsPath)) await this.writeJson(this.statsPath, {});
  }

  /** True while a `transaction()` file batch is open on this call stack. */
  get inTransaction(): boolean {
    return Boolean(this.pending.getStore());
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Cross-instance read-modify-write guard. The in-process chain stays as the
   * fast path; the file lock is what makes two Store instances / two processes
   * agree on queue.json and items.jsonl.
   */
  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending.getStore()) return fn();
    return this.withLock(async () => {
      return withFileLock(this.lockPath, async () => {
        await recoverFileBatch(this.dataDir);
        const batch: FileBatch = new Map();
        const value = await this.pending.run(batch, fn);
        await commitFileBatch(this.dataDir, batch);
        return value;
      }, { timeoutMs: 5_000 });
    });
  }

  /** One logical operation: read-your-writes, rollback on throw or {ok:false}. */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.withWriteLock(async () => {
      const batch = this.pending.getStore();
      if (!batch) throw new Error("missing store transaction");
      const before = new Map(batch);
      const rollback = () => {
        batch.clear();
        for (const [file, content] of before) batch.set(file, content);
      };
      try {
        const value = await fn();
        if (value && typeof value === "object" && "ok" in value && value.ok === false) rollback();
        return value;
      } catch (error) {
        rollback();
        throw error;
      }
    });
  }

  /**
   * Serialize state.json read-modify-write across Store instances and
   * processes. The globalThis chain keeps same-process contention cheap; the
   * file lock closes the Desktop + CLI gap.
   */
  private async withStateLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.withWriteLock(fn);
  }

  private async readText(file: string): Promise<string> {
    const batch = this.pending.getStore();
    const key = path.resolve(file);
    if (batch?.has(key)) {
      const value = batch.get(key);
      if (value === null) throw Object.assign(new Error("file removed in transaction"), { code: "ENOENT" });
      if (value !== undefined) return value;
    }
    return readFile(file, "utf8");
  }

  private async writeText(file: string, text: string | null): Promise<void> {
    const batch = this.pending.getStore();
    if (!batch) throw new Error("write outside store transaction");
    batch.set(path.resolve(file), text);
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      const raw = await this.readText(file);
      return JSON.parse(raw) as T;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return fallback;
      }
      throw error;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await this.writeText(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async readJsonl<T>(file: string): Promise<T[]> {
    try {
      const raw = await this.readText(file);
      const out: T[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as T);
        } catch {
          throw new Error(`数据文件损坏：${path.basename(file)} 第 ${out.length + 1} 行；原文件已保留，请从备份恢复`);
        }
      }
      return out;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async appendJsonl(file: string, value: unknown): Promise<void> {
    let current = "";
    try { current = await this.readText(file); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await this.writeText(file, `${current}${JSON.stringify(value)}\n`);
  }

  private async writeJsonl(file: string, rows: unknown[]): Promise<void> {
    await this.writeText(file, rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "");
  }

  /** Transaction-aware directory listing for staged journal/checkpoint hashes. */
  async listDataDirectory(relative: string): Promise<string[]> {
    const base = path.resolve(this.dataDir, relative);
    const names = new Set<string>();
    try {
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (entry.isFile()) names.add(entry.name);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const batch = this.pending.getStore();
    if (batch) {
      for (const [file, text] of batch) {
        const rel = path.relative(base, file);
        if (!rel || rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel) || rel.includes(path.sep)) continue;
        if (text === null) names.delete(rel);
        else names.add(rel);
      }
    }
    return [...names].sort();
  }

  /** Transaction-aware raw read for migration hash/checkpoint verification. */
  async readDataText(relative: string): Promise<string | undefined> {
    const full = await safeStorePath(this.dataDir, path.join(this.dataDir, relative));
    try {
      return await this.readText(full);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async readConfig(): Promise<AutoMemConfig> {
    return this.readJson<AutoMemConfig>(this.configPath, DEFAULT_CONFIG);
  }

  async writeConfig(config: AutoMemConfig): Promise<void> {
    const { token: _token, ...safe } = config;
    await this.withWriteLock(() => this.writeJson(this.configPath, safe));
  }

  async listItems(): Promise<Item[]> {
    return this.readJsonl<Item>(this.itemsPath);
  }

  async appendItem(item: Item): Promise<void> {
    await this.withWriteLock(() => this.appendJsonl(this.itemsPath, item));
  }

  async updateItem(id: string, patch: Partial<Item>, expected?: Item): Promise<Item | undefined> {
    return this.withWriteLock(async () => {
      const items = await this.listItems();
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) return undefined;
      if (expected && JSON.stringify(items[index]) !== JSON.stringify(expected)) return undefined;
      const next = { ...items[index], ...patch, updatedAt: nowIso() };
      items[index] = next;
      await this.writeItemsFile(items);
      return next;
    });
  }

  /**
   * Replace one row with an exact item, without merging the previous fields.
   * Version restore/deactivate must not keep fields that only the current
   * version had; a partial merge would rewrite more than the user chose.
   */
  async replaceItem(item: Item): Promise<Item | undefined> {
    return this.withWriteLock(async () => {
      const items = await this.listItems();
      const index = items.findIndex((entry) => entry.id === item.id);
      if (index === -1) return undefined;
      items[index] = item;
      await this.writeItemsFile(items);
      return item;
    });
  }

  async listQueue(): Promise<QueueItem[]> {
    return this.readJson<QueueItem[]>(this.queuePath, []);
  }

  async writeQueue(queue: QueueItem[]): Promise<void> {
    await this.withWriteLock(() => this.writeJson(this.queuePath, queue));
  }

  async upsertQueue(item: QueueItem): Promise<void> {
    await this.withWriteLock(async () => {
      const queue = await this.readJson<QueueItem[]>(this.queuePath, []);
      const index = queue.findIndex((entry) => entry.id === item.id);
      if (index === -1) queue.push(item);
      else queue[index] = { ...queue[index], ...item, updatedAt: nowIso() };
      await this.writeJson(this.queuePath, queue);
    });
  }

  /**
   * Merge by id inside one write lock. Unlike writeQueue(fullArray), two
   * callers patching different ids cannot drop each other's unrelated rows.
   */
  async patchQueue(
    patches: Array<{ id: string; patch: Partial<QueueItem> }>,
    expectedVersions?: Map<string, string>,
  ): Promise<QueueItem[]> {
    return this.withWriteLock(async () => {
      const queue = await this.readJson<QueueItem[]>(this.queuePath, []);
      if (expectedVersions) {
        const byID = new Map(queue.map((entry) => [entry.id, entry]));
        for (const [id, expected] of expectedVersions) {
          const entry = byID.get(id);
          if (!entry) throw new Error(`queue item missing: ${id}`);
          if (queueItemSnapshotVersion(entry) !== expected) {
            throw new Error(`queue item changed since preview: ${id}`);
          }
        }
      }
      const byID = new Map<string, Partial<QueueItem>>();
      for (const entry of patches) {
        byID.set(entry.id, { ...(byID.get(entry.id) ?? {}), ...entry.patch });
      }
      const next = queue.map((entry) => {
        const patch = byID.get(entry.id);
        return patch ? { ...entry, ...patch, updatedAt: nowIso() } : entry;
      });
      await this.writeJson(this.queuePath, next);
      return next;
    });
  }

  async removeQueue(id: string): Promise<QueueItem | undefined> {
    return this.withWriteLock(async () => {
      const queue = await this.readJson<QueueItem[]>(this.queuePath, []);
      const found = queue.find((entry) => entry.id === id);
      const next = queue.filter((entry) => entry.id !== id);
      await this.writeJson(this.queuePath, next);
      return found;
    });
  }

  async listShadow(): Promise<ShadowRecord[]> {
    return this.readJsonl<ShadowRecord>(this.shadowPath);
  }

  async appendShadow(record: ShadowRecord, max = DEFAULT_CONFIG.caps.shadow): Promise<void> {
    await this.withWriteLock(async () => {
      const records = await this.listShadow();
      const existing = record.hookID
        ? records.find((entry) => entry.hookID === record.hookID)
        : records.find((entry) => entry.id === record.id);
      if (!existing) {
        await this.appendJsonl(this.shadowPath, record);
      } else {
        await this.writeJsonl(this.shadowPath, records.map((entry) => entry.id === existing.id
          ? { ...entry, ...record, id: existing.id, createdAt: existing.createdAt }
          : entry));
      }
      await this.trimShadow(max);
    });
  }

  private async trimShadow(max: number): Promise<number> {
    const records = await this.listShadow();
    const limit = Math.max(1, Math.floor(max));
    if (records.length <= limit) return 0;
    const samples = records.filter((entry) => entry.falsePositive).slice(-limit);
    const others = records.filter((entry) => !entry.falsePositive).slice(-Math.max(0, limit - samples.length));
    const ids = new Set([...samples, ...(samples.length === limit ? [] : others)].map((entry) => entry.id));
    await this.writeText(`${this.shadowPath}.bak`, await this.readText(this.shadowPath));
    await this.writeJsonl(this.shadowPath, records.filter((entry) => ids.has(entry.id)));
    return records.length - ids.size;
  }

  async pruneShadow(max = DEFAULT_CONFIG.caps.shadow): Promise<number> {
    return this.withWriteLock(() => this.trimShadow(max));
  }

  async listHooks(): Promise<HookRecord[]> {
    return this.readJsonl<HookRecord>(this.hooksPath);
  }

  async appendHook(record: HookRecord): Promise<void> {
    await this.withWriteLock(() => this.appendJsonl(this.hooksPath, record));
  }

  async writeHooks(hooks: HookRecord[]): Promise<void> {
    await this.withWriteLock(() => this.writeJsonl(this.hooksPath, hooks));
  }

  async upsertHook(record: HookRecord): Promise<void> {
    await this.withWriteLock(async () => {
      const hooks = await this.readJsonl<HookRecord>(this.hooksPath);
      const index = hooks.findIndex((entry) => entry.id === record.id);
      if (index === -1) hooks.push(record);
      else hooks[index] = record;
      await this.writeJsonl(this.hooksPath, hooks);
    });
  }

  /**
   * Keep hooks.jsonl bounded. Open records (pending/processing/failed) are never
   * dropped; settled history keeps the newest `max - open` entries.
   */
  async pruneHooks(max = 2000): Promise<number> {
    return this.withWriteLock(async () => {
      const hooks = await this.readJsonl<HookRecord>(this.hooksPath);
      if (hooks.length <= max) return 0;
      const isOpen = (hook: HookRecord) =>
        hook.status === "pending" ||
        hook.status === "blocked" ||
        hook.status === "processing" ||
        (hook.status === "failed" && (hook.attempts ?? 0) < 3);
      const open = hooks.filter(isOpen);
      const settled = hooks.filter((hook) => !isOpen(hook));
      const keepSettled = settled.slice(-Math.max(0, max - open.length));
      const keepIDs = new Set([...open, ...keepSettled].map((hook) => hook.id));
      const next = hooks.filter((hook) => keepIDs.has(hook.id));
      await this.writeJsonl(this.hooksPath, next);
      return hooks.length - next.length;
    });
  }

  async listReviews(): Promise<Record<string, unknown>[]> {
    return this.readJsonl<Record<string, unknown>>(this.reviewsPath);
  }

  async updateReviewNote(reviewID: string, index: number, patch: Pick<ReviewSessionNote, "status" | "promotedItemID">): Promise<boolean> {
    return this.withWriteLock(async () => {
      const records = await this.readJsonl<ReviewRecord>(this.reviewsPath);
      const review = records.find((entry) => entry.id === reviewID);
      const note = review?.sessionNotes?.[index];
      if (!note || (note.status === "promoted" && patch.status !== "promoted")) return false;
      Object.assign(note, patch);
      await this.writeJsonl(this.reviewsPath, records);
      return true;
    });
  }

  async saveQueueRecovery(queue: QueueItem, item: Item): Promise<string> {
    return this.withWriteLock(async () => {
      const id = newId("recovery");
      const root = path.join(this.dataDir, "recovery");
      await mkdir(root, { recursive: true, mode: 0o700 });
      await this.writeJson(path.join(root, `${id}.json`), { id, at: nowIso(), queue, item });
      return id;
    });
  }

  async restoreQueueAction(id: string): Promise<void> {
    if (!/^recovery_[A-Za-z0-9_]+$/.test(id)) throw new Error("invalid recovery id");
    await this.withWriteLock(async () => {
      const file = path.join(this.dataDir, "recovery", `${id}.json`);
      const record = await this.readJson<{ queue: QueueItem; item: Item; restored?: boolean; restoring?: boolean } | undefined>(file, undefined);
      if (!record || record.restored) throw new Error("操作记录不存在或已经恢复");
      const items = await this.listItems();
      const current = items.find((item) => item.id === record.item.id);
      const archived: Item = { ...record.item, status: "archived", supersededBy: id };
      if (current && JSON.stringify(current) !== JSON.stringify(record.item) &&
          !(record.restoring && JSON.stringify(current) === JSON.stringify(archived))) throw new Error("条目已被后续操作修改，无法安全恢复");
      const queue = await this.listQueue();
      const queued = queue.find((item) => item.id === record.queue.id);
      if (queued && !(record.restoring && JSON.stringify(queued) === JSON.stringify(record.queue))) throw new Error("候选已在队列中或已被修改，请刷新");
      await this.writeJson(file, { ...record, restoring: true });
      await this.writeItemsFile(items.map((item) => item.id === record.item.id ? archived : item));
      if (!queued) await this.writeJson(this.queuePath, [...queue, record.queue]);
      await this.writeJson(file, { ...record, restoring: false, restored: true });
    });
  }

  async appendReview(record: Record<string, unknown>): Promise<void> {
    await this.withWriteLock(() => this.appendJsonl(this.reviewsPath, record));
  }

  async pruneReviews(max = 500): Promise<number> {
    return this.withWriteLock(async () => {
      const reviews = await this.readJsonl<Record<string, unknown>>(this.reviewsPath);
      if (reviews.length <= max) return 0;
      const next = reviews.slice(-max);
      await this.writeJsonl(this.reviewsPath, next);
      return reviews.length - next.length;
    });
  }

  async markShadowFalsePositive(id: string): Promise<ShadowRecord | undefined> {
    return this.withWriteLock(async () => {
      const records = await this.listShadow();
      const index = records.findIndex((record) => record.id === id);
      if (index === -1) return undefined;
      const next = { ...records[index], falsePositive: true, falsePositiveAt: nowIso() };
      records[index] = next;
      await this.writeJsonl(this.shadowPath, records);
      return next;
    });
  }

  async readAudit(): Promise<AuditReport> {
    return this.readJson<AuditReport>(this.auditPath, emptyAudit());
  }

  async writeAudit(report: AuditReport): Promise<void> {
    await this.withWriteLock(() => this.writeJson(this.auditPath, report));
  }

  async readMetrics(): Promise<Metrics> {
    return this.readJson<Metrics>(this.metricsPath, emptyMetrics());
  }

  async writeMetrics(metrics: Metrics): Promise<void> {
    await this.withWriteLock(() => this.writeJson(this.metricsPath, metrics));
  }

  async appendChangelog(entry: Record<string, unknown>): Promise<void> {
    await this.withWriteLock(() => this.appendJsonl(this.changelogPath, { at: nowIso(), ...entry }));
  }

  async readAutoMemory(): Promise<string> {
    try {
      return await this.readText(this.autoMemoryPath);
    } catch {
      return "# AUTO_MEMORY\n\n";
    }
  }

  async appendAutoMemory(text: string, meta: Record<string, unknown>): Promise<void> {
    await this.withWriteLock(async () => {
      await this.writeText(this.autoMemoryPath, `${await this.readAutoMemory()}\n<!-- auto: ${JSON.stringify(meta)} -->\n- ${text}\n`);
    });
  }

  async readAutoRules(): Promise<string> {
    try {
      return await this.readText(this.autoRulesPath);
    } catch {
      return "# AUTO_RULES\n\n";
    }
  }

  async appendAutoRule(text: string, meta: Record<string, unknown>): Promise<void> {
    await this.withWriteLock(async () => {
      await this.writeText(this.autoRulesPath, `${await this.readAutoRules()}\n<!-- auto: ${JSON.stringify(meta)} -->\n- ${text}\n`);
    });
  }

  async readState(): Promise<PersistedState> {
    return this.readJson<PersistedState>(this.statePath, { sessions: {} });
  }

  sessionArchivePath(sessionID: string): string {
    return path.join(this.dataDir, "session-archive", `${crypto.createHash("sha256").update(sessionID).digest("hex")}.json`);
  }

  async readSession(sessionID: string): Promise<SessionState | undefined> {
    const active = (await this.readState()).sessions[sessionID];
    if (active) return active;
    const file = await safeStorePath(this.dataDir, this.sessionArchivePath(sessionID));
    const archived = await this.readJson<{ sessionID: string; state: SessionState } | undefined>(file, undefined);
    if (archived && archived.sessionID !== sessionID) throw new Error("会话归档身份不匹配");
    return archived?.state;
  }

  async deleteDataFile(relative: string): Promise<void> {
    await this.withWriteLock(() => this.writeText(path.resolve(this.dataDir, relative), null));
  }

  async writeState(state: PersistedState): Promise<void> {
    await this.withStateLock(() => this.writeJson(this.statePath, state));
  }

  /** Locked read-modify-write for top-level state fields. */
  async updateState(patch: Partial<PersistedState>): Promise<PersistedState> {
    return this.withStateLock(async () => {
      const state = await this.readJson<PersistedState>(this.statePath, { sessions: {} });
      const next = { ...state, ...patch };
      await this.writeJson(this.statePath, next);
      return next;
    });
  }

  /** Atomically reserve a review/extract request against shared rolling budgets. */
  async reserveModelRequest(
    kind: "decision" | "rewrite" | "review",
    maxPerHour: number,
    at = Date.now(),
    options: { purpose?: "review" | "extract"; dailyLimit?: number } = {},
  ): Promise<{ ok: boolean; retryAt?: number; window?: "hour" | "day" }> {
    return this.withStateLock(async () => {
      const state = await this.readState();
      const requests = { ...(state.modelRequests ?? {}) };
      if (kind === "review") {
        const purpose = options.purpose ?? "review";
        const hourLimit = Math.max(0, Math.floor(maxPerHour));
        const dayLimit = Math.min(
          DAY_MODEL_REQUEST_LIMIT,
          Math.max(0, Math.floor(options.dailyLimit ?? DAY_MODEL_REQUEST_LIMIT)),
        );
        const dayTimes = (requests.review ?? []).filter((entry) => entry >= at - MODEL_REQUEST_DAY_MS);
        const hourTimes = dayTimes.filter((entry) => entry >= at - MODEL_REQUEST_HOUR_MS);
        const purposes = (state.modelRequestPurposes ?? [])
          .filter((entry) => entry.at >= at - MODEL_REQUEST_DAY_MS)
          .slice(-DAY_MODEL_REQUEST_LIMIT);
        const hourlyPurposes = purposes.filter((entry) => entry.at >= at - MODEL_REQUEST_HOUR_MS);
        const unclassifiedDayRequests = Math.max(0, dayTimes.length - purposes.length);
        const unclassifiedHourRequests = Math.max(0, hourTimes.length - hourlyPurposes.length);
        const reviewDayRequests = purposes.filter((entry) => entry.purpose === "review").length +
          unclassifiedDayRequests;
        const reviewHourRequests = hourlyPurposes.filter((entry) => entry.purpose === "review").length +
          unclassifiedHourRequests;
        const pending = extractPendingEntries(state, at);
        const pendingCreatedAt = pending
          .map(([, entry]) => Date.parse(entry.createdAt ?? entry.updatedAt))
          .filter((created) => Number.isFinite(created));
        const oldestPendingAt = pendingCreatedAt.length > 0
          ? Math.min(...pendingCreatedAt)
          : undefined;
        const agedPending = oldestPendingAt !== undefined &&
          at - oldestPendingAt >= EXTRACT_FAIRNESS_DELAY_MS;
        const dueReviews = Object.values(state.sessions)
          .flatMap((session) => {
            if (session.reviewStatus !== "scheduled" || !session.reviewDueAt) return [];
            const dueAt = Date.parse(session.reviewDueAt);
            return Number.isFinite(dueAt) && dueAt <= at ? [dueAt] : [];
          });
        const oldestDueReview = dueReviews.length > 0 ? Math.min(...dueReviews) : undefined;
        const latestReviewRequest = purposes
          .filter((entry) => entry.purpose === "review")
          .reduce<number | undefined>((latest, entry) => latest === undefined || entry.at > latest ? entry.at : latest, undefined);
        const latestPurpose = purposes.at(-1)?.purpose;
        const reviewStarved = oldestDueReview !== undefined &&
          at - oldestDueReview >= REVIEW_STARVATION_MS &&
          (latestReviewRequest === undefined || at - latestReviewRequest >= REVIEW_STARVATION_MS);

        const retryForHour = (): { ok: false; window: "hour"; retryAt: number } => ({
          ok: false,
          window: "hour",
          retryAt: (hourTimes[0] ?? at) + MODEL_REQUEST_HOUR_MS + 1000,
        });
        const retryForDay = (): { ok: false; window: "day"; retryAt: number } => ({
          ok: false,
          window: "day",
          retryAt: (dayTimes[0] ?? at) + MODEL_REQUEST_DAY_MS + 1000,
        });

        if (hourTimes.length >= hourLimit) return retryForHour();
        if (dayTimes.length >= dayLimit) return retryForDay();

        if (purpose === "review" && agedPending) {
          const reviewHourShare = Math.max(0, hourLimit - Math.min(1, hourLimit));
          const reviewDayShare = Math.max(0, dayLimit - Math.min(8, dayLimit));
          // With more than one hourly slot, reserve one for aged Extract work.
          // At a one-slot cap, choose the older of the pending Extract and due
          // Review; a two-hour-starved Review still gets the next available slot.
          if (hourLimit > 1 && reviewHourRequests >= reviewHourShare && !(reviewStarved && hourTimes.length < hourLimit)) {
            return retryForHour();
          }
          if (hourLimit <= 1 && reviewHourRequests >= reviewHourShare && oldestDueReview === undefined && !reviewStarved) {
            return retryForHour();
          }
          if (reviewDayRequests >= reviewDayShare && !(reviewStarved && dayTimes.length < dayLimit)) {
            return retryForDay();
          }
        }

        if (agedPending && hourLimit <= 1 && oldestDueReview !== undefined) {
          // A single shared hourly slot cannot be statically split. Prefer the
          // older outstanding obligation, alternate ties, and never let an
          // aged due Review wait more than the starvation override above.
          const reviewHasPriority = reviewStarved ||
            oldestDueReview < (oldestPendingAt ?? Number.POSITIVE_INFINITY) ||
            (oldestDueReview === oldestPendingAt && latestPurpose === "extract");
          if (purpose !== (reviewHasPriority ? "review" : "extract")) {
            return retryForHour();
          }
        }

        dayTimes.push(at);
        requests.review = dayTimes;
        state.modelRequestPurposes = [
          ...purposes,
          { at, purpose },
        ].slice(-DAY_MODEL_REQUEST_LIMIT);
        await this.writeJson(this.statePath, { ...state, modelRequests: requests });
        return { ok: true };
      }
      {
        const times = (requests[kind] ?? []).filter((entry) => entry >= at - MODEL_REQUEST_HOUR_MS);
        if (times.length >= maxPerHour) {
          return {
            ok: false,
            window: "hour",
            retryAt: (times[0] ?? at) + MODEL_REQUEST_HOUR_MS + 1000,
          };
        }
        times.push(at);
        requests[kind] = times;
        await this.writeJson(this.statePath, { ...state, modelRequests: requests });
        return { ok: true };
      }
    });
  }

  /** Boolean compatibility for existing decision/rewrite call sites. */
  async takeModelSlot(kind: "decision" | "rewrite" | "review", max: number, at = Date.now()): Promise<boolean> {
    return (await this.reserveModelRequest(kind, max, at)).ok;
  }

  /** Atomically reserve one review model run inside a rolling window. */
  async takeReviewSlot(
    at: number,
    max: number,
    windowMs: number,
  ): Promise<{ ok: boolean; runs: number[] }> {
    return this.withStateLock(async () => {
      const state = await this.readJson<PersistedState>(this.statePath, { sessions: {} });
      const runs = (state.reviewRuns ?? []).filter((entry) => entry >= at - windowMs);
      if (runs.length >= max) {
        state.reviewRuns = runs;
        await this.writeJson(this.statePath, state);
        return { ok: false, runs };
      }
      runs.push(at);
      state.reviewRuns = runs;
      await this.writeJson(this.statePath, state);
      return { ok: true, runs };
    });
  }

  async releaseReviewSlot(at: number): Promise<number[]> {
    return this.withStateLock(async () => {
      const state = await this.readJson<PersistedState>(this.statePath, { sessions: {} });
      const runs = [...(state.reviewRuns ?? [])];
      const index = runs.indexOf(at);
      if (index !== -1) runs.splice(index, 1);
      state.reviewRuns = runs;
      await this.writeJson(this.statePath, state);
      return runs;
    });
  }

  /** Read-modify-write one session so parallel calls cannot lose updates. */
  async updateSession(
    sessionID: string,
    patch: Partial<PersistedState["sessions"][string]>,
  ): Promise<PersistedState["sessions"][string]> {
    return this.withStateLock(async () => {
      const state = await this.readJson<PersistedState>(this.statePath, { sessions: {} });
      const previous = state.sessions[sessionID] ?? await this.readSession(sessionID);
      state.sessions[sessionID] = { ...previous, ...patch, lastActiveAt: nowIso() };
      await this.writeJson(this.statePath, state);
      return state.sessions[sessionID];
    });
  }

  async isExpiredExtractWindow(sessionID: string, windowHash: string): Promise<boolean> {
    const session = await this.readSession(sessionID);
    return session ? expiredExtractWindowHashes(session).includes(windowHash) : false;
  }

  /** Bounded, transcript-free durable extract marker. */
  async setExtractPending(
    sessionID: string,
    pending: ExtractPendingWork | undefined,
    now = Date.now(),
  ): Promise<boolean> {
    return this.withStateLock(async () => {
      const state = await this.readState();
      state.sessions ??= {};
      const expiredIDs: string[] = [];
      for (const [id, session] of Object.entries(state.sessions)) {
        const entry = session.extractPending;
        if (!entry) continue;
        const createdAt = Date.parse(entry.createdAt ?? entry.updatedAt);
        if (!Number.isFinite(createdAt) || now - createdAt >= EXTRACT_PENDING_TTL_MS) {
          const expired = expireExtractPending(session);
          if (expired.newlyExpired) expiredIDs.push(id);
          state.sessions[id] = expired.session;
        }
      }
      const previous = state.sessions[sessionID] ?? {};
      let expiredWindowBlocked = false;
      if (pending) {
        const windowHash = typeof pending.windowHash === "string" &&
          pending.windowHash.length > 0 && pending.windowHash.length <= 128
          ? pending.windowHash
          : undefined;
        if (windowHash && expiredExtractWindowHashes(previous).includes(windowHash)) {
          const { extractPending: _blocked, ...rest } = previous;
          state.sessions[sessionID] = { ...rest, lastActiveAt: nowIso() };
          expiredWindowBlocked = true;
        } else {
          const firstSeen = previous.extractPending?.createdAt ??
            previous.extractPending?.updatedAt ?? pending.createdAt ?? pending.updatedAt;
          const firstSeenAt = firstSeen ? Date.parse(firstSeen) : Number.NaN;
          if (!Number.isFinite(firstSeenAt) || now - firstSeenAt >= EXTRACT_PENDING_TTL_MS) {
            // A caller holding an expired marker must not resurrect it and reset its TTL.
            const { extractPending: _expired, ...rest } = previous;
            const terminal = rememberExpiredExtractWindow(rest, windowHash);
            if (windowHash && terminal.added) expiredIDs.push(sessionID);
            state.sessions[sessionID] = { ...terminal.session, lastActiveAt: nowIso() };
            expiredWindowBlocked = true;
          } else {
            const nextPending: ExtractPendingWork = { ...pending, createdAt: firstSeen };
            const entries = extractPendingEntries(state).filter(([id]) => id !== sessionID);
            const candidate = [...entries, [sessionID, nextPending] as [string, ExtractPendingWork]];
            const bytes = extractPendingBytes(candidate);
            if (candidate.length > EXTRACT_PENDING_MAX_ROWS || bytes > EXTRACT_PENDING_MAX_BYTES) {
              const current = extractPendingEntries(state);
              const expiries = current.map(([, entry]) => Date.parse(entry.createdAt ?? entry.updatedAt) + EXTRACT_PENDING_TTL_MS)
                .filter(Number.isFinite);
              state.automation = {
                ...state.automation,
                pendingFull: (state.automation?.pendingFull ?? 0) + 1,
                pendingCapacityBlocked: true,
                ...(expiries.length > 0
                  ? { capacityBlockedUntil: new Date(Math.min(...expiries)).toISOString() }
                  : {}),
                ...(expiredIDs.length > 0
                  ? { expiredUnlearned: (state.automation?.expiredUnlearned ?? 0) + expiredIDs.length }
                  : {}),
              };
              await this.writeJson(this.statePath, state);
              return false;
            }
            state.sessions[sessionID] = { ...previous, extractPending: nextPending, lastActiveAt: nowIso() };
          }
        }
      } else {
        const { extractPending: _cleared, ...rest } = previous;
        state.sessions[sessionID] = { ...rest, lastActiveAt: nowIso() };
      }

      const entries = extractPendingEntries(state);
      const bytes = extractPendingBytes(entries);
      const capacityBlocked = entries.length >= EXTRACT_PENDING_MAX_ROWS || bytes >= EXTRACT_PENDING_MAX_BYTES;
      const expiries = entries.map(([, entry]) => Date.parse(entry.createdAt ?? entry.updatedAt) + EXTRACT_PENDING_TTL_MS)
        .filter(Number.isFinite);
      state.automation = {
        ...state.automation,
        pendingCapacityBlocked: capacityBlocked,
        ...(capacityBlocked && expiries.length > 0
          ? { capacityBlockedUntil: new Date(Math.min(...expiries)).toISOString() }
          : { capacityBlockedUntil: undefined }),
        ...(expiredIDs.length > 0
          ? { expiredUnlearned: (state.automation?.expiredUnlearned ?? 0) + expiredIDs.length }
          : {}),
      };
      await this.writeJson(this.statePath, state);
      return !expiredWindowBlocked;
    });
  }

  /** Prune expired pending details and keep only the aggregate unlearned count. */
  async maintainExtractPending(now = Date.now()): Promise<{
    expired: number;
    pending: number;
    bytes: number;
    capacityBlocked: boolean;
  }> {
    return this.withStateLock(async () => {
      const state = await this.readState();
      state.sessions ??= {};
      let expired = 0;
      for (const [sessionID, session] of Object.entries(state.sessions)) {
        const entry = session.extractPending;
        if (!entry) continue;
        const createdAt = Date.parse(entry.createdAt ?? entry.updatedAt);
        if (Number.isFinite(createdAt) && now - createdAt < EXTRACT_PENDING_TTL_MS) continue;
        const terminal = expireExtractPending(session);
        state.sessions[sessionID] = terminal.session;
        if (terminal.newlyExpired) expired += 1;
      }
      const entries = extractPendingEntries(state);
      const bytes = extractPendingBytes(entries);
      const capacityBlocked = entries.length >= EXTRACT_PENDING_MAX_ROWS || bytes >= EXTRACT_PENDING_MAX_BYTES;
      const expiries = entries.map(([, entry]) => Date.parse(entry.createdAt ?? entry.updatedAt) + EXTRACT_PENDING_TTL_MS)
        .filter(Number.isFinite);
      state.automation = {
        ...state.automation,
        pendingCapacityBlocked: capacityBlocked,
        ...(capacityBlocked && expiries.length > 0
          ? { capacityBlockedUntil: new Date(Math.min(...expiries)).toISOString() }
          : { capacityBlockedUntil: undefined }),
        ...(expired > 0
          ? { expiredUnlearned: (state.automation?.expiredUnlearned ?? 0) + expired }
          : {}),
      };
      await this.writeJson(this.statePath, state);
      return { expired, pending: entries.length, bytes, capacityBlocked };
    });
  }

  async updateAutomationState(
    patch: Partial<PersistedAutomationState>,
  ): Promise<PersistedAutomationState> {
    return this.withStateLock(async () => {
      const state = await this.readState();
      const automation = { ...(state.automation ?? {}), ...patch };
      state.automation = automation;
      await this.writeJson(this.statePath, state);
      return automation;
    });
  }

  /**
   * Spend one automatic item-write slot for `sessionID`.
   *
   * The counter lives in state.json and is written through the transaction
   * batch, so a rolled-back write does not spend a slot. It is meant to be
   * called inside the caller's `transaction()`: the file lock is reentrant
   * there and serializes two Store instances on the same dataDir, so they
   * cannot oversell the same UTC day.
   */
  async consumeWriteBudget(input: {
    sessionID: string;
    dailyWrites?: number;
    maxWritesPerSession?: number;
    /** Injected clock; the day key is always UTC. */
    now?: number;
  }): Promise<
    | { ok: true; used: number; sessionUsed: number }
    | { ok: false; reason: "write-budget"; used: number; sessionUsed: number }
  > {
    const dailyWrites = Math.max(0, Math.floor(input.dailyWrites ?? 40));
    const maxWritesPerSession = Math.max(0, Math.floor(input.maxWritesPerSession ?? 5));
    const day = new Date(input.now ?? Date.now()).toISOString().slice(0, 10);
    return this.withStateLock(async () => {
      const state = await this.readState();
      const stored = state.automation?.writeBudget;
      const budget = stored && stored.day === day
        ? { day, count: stored.count, sessions: { ...stored.sessions } }
        : { day, count: 0, sessions: {} as Record<string, number> };
      const sessionUsed = budget.sessions[input.sessionID] ?? 0;
      if (budget.count >= dailyWrites || sessionUsed >= maxWritesPerSession) {
        return { ok: false as const, reason: "write-budget" as const, used: budget.count, sessionUsed };
      }
      budget.count += 1;
      budget.sessions[input.sessionID] = sessionUsed + 1;
      state.automation = { ...(state.automation ?? {}), writeBudget: budget };
      await this.writeJson(this.statePath, state);
      return { ok: true as const, used: budget.count, sessionUsed: sessionUsed + 1 };
    });
  }

  async listSkillDrafts(): Promise<SkillDraft[]> {
    const dir = this.skillDraftsDir;
    if (!existsSync(dir)) return [];
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(dir, { withFileTypes: true }));
    const drafts: SkillDraft[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const root = path.join(dir, entry.name);
      const metaPath = path.join(root, "meta.json");
      const skillPath = path.join(root, "SKILL.md");
      try {
        const meta = JSON.parse(await this.readText(metaPath)) as SkillDraft;
        drafts.push({ ...meta, path: skillPath });
      } catch {
        try {
          const content = await this.readText(skillPath);
          drafts.push({
            id: entry.name,
            name: entry.name,
            description: "",
            status: "draft",
            path: skillPath,
            validation: { ok: false, errors: ["meta.json missing"], warnings: [] },
            createdAt: nowIso(),
            updatedAt: nowIso(),
          });
        } catch {
          // ignore empty directory
        }
      }
    }
    return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async readSkillDraft(id: string): Promise<SkillDraft | undefined> {
    return (await this.listSkillDrafts()).find((draft) => draft.id === id);
  }

  async writeSkillDraft(draft: SkillDraft, content: string): Promise<void> {
    await this.withWriteLock(async () => {
      const root = path.join(this.skillDraftsDir, draft.id);
      await mkdir(root, { recursive: true });
      await this.writeText(path.join(root, "SKILL.md"), content);
      await this.writeJson(path.join(root, "meta.json"), { ...draft, path: path.join(root, "SKILL.md") });
    });
  }

  async updateSkillDraft(id: string, patch: Partial<SkillDraft>, content?: string): Promise<SkillDraft | undefined> {
    return this.transaction(async () => {
    const existing = await this.readSkillDraft(id);
    if (!existing) return undefined;
    const next: SkillDraft = { ...existing, ...patch, updatedAt: nowIso() };
    if (content !== undefined) {
      await this.writeSkillDraft(next, content);
    } else {
      await this.writeSkillDraft(next, await this.readText(existing.path));
    }
    return next;
    });
  }

  async writeOutboxSkill(name: string, content: string): Promise<string> {
    return this.transaction(async () => {
    const root = path.join(this.outboxSkillsDir, name);
    await mkdir(root, { recursive: true });
    const file = path.join(root, "SKILL.md");
    await this.writeText(file, content);
    return file;
    });
  }

  private async writeItemsFile(items: Item[]): Promise<void> {
    await this.writeJsonl(this.itemsPath, items);
  }

  async touchItem(id: string, source?: SourceRef): Promise<Item | undefined> {
    return this.withWriteLock(async () => {
      const items = await this.listItems();
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) return undefined;
      const current = items[index];
      const sources = current.sources ?? (current.source ? [current.source] : []);
      const next: Item = {
        ...current,
        seenCount: (current.seenCount ?? 1) + 1,
        lastSeenAt: nowIso(),
        updatedAt: nowIso(),
        sources: source ? [...sources, source].slice(-20) : sources,
      };
      items[index] = next;
      await this.writeItemsFile(items);
      return next;
    });
  }

  async archiveItem(id: string, supersededBy?: string): Promise<Item | undefined> {
    return this.updateItem(id, { status: "archived", supersededBy });
  }

  async replaceItems(items: Item[]): Promise<void> {
    await this.withWriteLock(() => this.writeItemsFile(items));
  }

  /** Apply only changes calculated from an unchanged snapshot, preserving new rows. */
  async applyItemChanges(before: Item[], after: Item[]): Promise<string> {
    return this.withWriteLock(async () => {
      const original = new Map(before.map((item) => [item.id, item]));
      const changes = new Map(after.filter((item) => {
        const previous = original.get(item.id);
        return previous !== undefined && JSON.stringify(previous) !== JSON.stringify(item);
      }).map((item) => [item.id, item]));
      const current = await this.listItems();
      for (const id of changes.keys()) {
        const item = current.find((entry) => entry.id === id);
        if (!item || JSON.stringify(item) !== JSON.stringify(original.get(id))) {
          throw new Error(`item changed during maintenance: ${id}`);
        }
      }
      const id = newId("maintenance");
      const root = path.join(this.dataDir, "maintenance");
      await mkdir(root, { recursive: true });
      await this.writeJson(path.join(root, `${id}.json`), {
        id, at: nowIso(), before: before.filter((item) => changes.has(item.id)),
        after: [...changes.values()],
      });
      await this.writeText(path.join(root, `${id}.items.bak`), await this.readText(this.itemsPath));
      await this.writeItemsFile(current.map((item) => changes.get(item.id) ?? item));
      return id;
    });
  }

  async undoMaintenance(id: string): Promise<number> {
    if (!/^maintenance_[A-Za-z0-9_]+$/.test(id)) throw new Error("invalid maintenance id");
    return this.withWriteLock(async () => {
      const file = path.join(this.dataDir, "maintenance", `${id}.json`);
      const journal = await this.readJson<{ before: Item[]; after: Item[]; undone?: boolean; undoing?: boolean } | undefined>(file, undefined);
      if (!journal || !Array.isArray(journal.before) || !Array.isArray(journal.after)) throw new Error("维护记录不存在");
      if (journal.undone) throw new Error("该维护操作已撤销");
      const current = await this.listItems();
      const restore = new Map(journal.before.map((item) => [item.id, item]));
      for (const expected of journal.after) {
        const actual = JSON.stringify(current.find((item) => item.id === expected.id));
        if (actual !== JSON.stringify(expected) && !(journal.undoing && actual === JSON.stringify(restore.get(expected.id)))) {
          throw new Error("条目在维护后已被修改，无法安全撤销；请查看操作历史");
        }
      }
      await this.writeJson(file, { ...journal, undoing: true });
      await this.writeItemsFile(current.map((item) => restore.get(item.id) ?? item));
      await this.writeJson(file, { ...journal, undoing: false, undone: true });
      return restore.size;
    });
  }

  async reserve(key: string, ttlMs: number): Promise<boolean> {
    return Boolean(await this.claim(key, ttlMs));
  }

  async claim(key: string, ttlMs: number): Promise<string | undefined> {
    return this.withWriteLock(async () => {
      const now = Date.now();
      const data = await this.readJson<Record<string, Reservation>>(this.reservationsPath, {});
      for (const [entry, claim] of Object.entries(data)) {
        const expires = reservationExpiry(claim);
        if (!Number.isFinite(expires) || expires < now) delete data[entry];
      }
      if (data[key] !== undefined) {
        await this.writeJson(this.reservationsPath, data);
        return undefined;
      }
      const token = crypto.randomBytes(16).toString("hex");
      data[key] = { expiresAt: now + ttlMs, token };
      await this.writeJson(this.reservationsPath, data);
      this.claims.set(key, token);
      return token;
    });
  }

  /**
   * Atomic cooldown for bounded retention scans. This is deliberately separate
   * from `claim`: the lease only covers concurrent overlap, while this gate
   * persists the next allowed attempt even after a failed/zero-reclaim run.
   */
  async tryReserveRetentionRun(
    now = Date.now(),
    cooldownMs = 5 * 60_000,
  ): Promise<{ ok: true } | { ok: false; retryAt: string }> {
    return this.withStateLock(async () => {
      const state = await this.readState();
      const gate = state.automation?.retentionGate;
      const next = gate ? Date.parse(gate.nextAttemptAt) : Number.NaN;
      if (Number.isFinite(next) && next > now) {
        return { ok: false, retryAt: new Date(next).toISOString() };
      }
      state.automation = {
        ...(state.automation ?? {}),
        retentionGate: {
          lastAttemptAt: new Date(now).toISOString(),
          nextAttemptAt: new Date(now + cooldownMs).toISOString(),
        },
      };
      await this.writeJson(this.statePath, state);
      return { ok: true };
    });
  }

  async releaseReservation(key: string, token = this.claims.get(key)): Promise<void> {
    await this.withWriteLock(async () => {
      const data = await this.readJson<Record<string, Reservation>>(this.reservationsPath, {});
      const claim = data[key];
      if (!token || typeof claim !== "object" || claim.token !== token) return;
      delete data[key];
      if (this.claims.get(key) === token) this.claims.delete(key);
      await this.writeJson(this.reservationsPath, data);
    });
  }

  async ownsClaim(key: string, token: string): Promise<boolean> {
    const value = (await this.readJson<Record<string, Reservation>>(this.reservationsPath, {}))[key];
    return typeof value === "object" && value.token === token && value.expiresAt >= Date.now();
  }

  async pruneReservations(ttlMs: number): Promise<number> {
    return this.withWriteLock(async () => {
      const now = Date.now();
      const data = await this.readJson<Record<string, Reservation>>(this.reservationsPath, {});
      let removed = 0;
      for (const [entry, claim] of Object.entries(data)) {
        const expires = reservationExpiry(claim, ttlMs);
        if (!Number.isFinite(expires) || expires < now) {
          delete data[entry];
          removed += 1;
        }
      }
      await this.writeJson(this.reservationsPath, data);
      return removed;
    });
  }

  async readCacheFile<T>(file: string, fallback: T): Promise<T> {
    return this.readJson(file, fallback);
  }

  async writeCacheFile(file: string, value: unknown): Promise<void> {
    await this.withWriteLock(() => this.writeJson(file, value));
  }

  async appendJournal(entry: MergeJournal): Promise<void> {
    await this.withWriteLock(() => this.appendJsonl(this.journalPath, entry));
  }

  async listJournal(): Promise<MergeJournal[]> {
    return this.readJsonl<MergeJournal>(this.journalPath);
  }

  async undoMergeEntry(id: string, windowMs: number): Promise<MergeJournal> {
    return this.withWriteLock(async () => {
      const journals = await this.listJournal();
      const entry = journals.find((record) => record.id === id);
      if (!entry) throw new Error("撤销记录不存在");
      if (entry.undone) throw new Error("这次合并已经撤销过");
      if (!entry.undoing && Date.now() - Date.parse(entry.at) > windowMs) throw new Error("超过 24 小时撤销窗口");
      if ((!entry.after.target && !entry.after.item) || (entry.before.target && !entry.after.target) || (entry.after.itemID && !entry.after.item)) {
        throw new Error("旧版或未完成的合并缺少完整快照，不能安全撤销，请核对备份");
      }
      const items = await this.listItems();
      const queue = await this.listQueue();
      const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
      const expected = [entry.after.target, entry.after.item].filter((item): item is Item => Boolean(item));
      const intended = new Map<string, Item>();
      if (entry.before.target && entry.after.target) intended.set(entry.before.target.id, entry.before.target);
      if (entry.after.item) intended.set(entry.after.item.id, { ...entry.after.item, status: "archived", supersededBy: "undo" });
      for (const snapshot of expected) {
        const current = items.find((item) => item.id === snapshot.id);
        if (!same(current, snapshot) && !(entry.undoing && same(current, intended.get(snapshot.id)))) {
          throw new Error("条目在合并后已被修改，无法安全撤销");
        }
      }
      const restoredQueue = {
        ...entry.before.queue,
        suggestionState: entry.before.queue.suggestion
          ? (entry.before.queue.suggestion.validation.ok ? "ready" as const : "failed" as const)
          : undefined,
      };
      const currentQueue = queue.find((item) => item.id === entry.queueID);
      if (currentQueue && !(entry.undoing && same(currentQueue, restoredQueue))) throw new Error("候选已被其他操作恢复或修改，请刷新");
      entry.undoing = true;
      await this.writeJsonl(this.journalPath, journals);
      await this.writeItemsFile(items.map((item) => intended.get(item.id) ?? item));
      if (!currentQueue) await this.writeJson(this.queuePath, [...queue, restoredQueue]);
      entry.undone = true;
      entry.undoing = false;
      await this.writeJsonl(this.journalPath, journals);
      return entry;
    });
  }

  async markJournalUndone(id: string): Promise<MergeJournal | undefined> {
    return this.withWriteLock(async () => {
      const entries = await this.listJournal();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return undefined;
      const next = { ...entries[index], undone: true };
      entries[index] = next;
      await this.writeJsonl(this.journalPath, entries);
      return next;
    });
  }

  async updateJournal(
    id: string,
    patch: Partial<MergeJournal>,
  ): Promise<MergeJournal | undefined> {
    return this.withWriteLock(async () => {
      const entries = await this.listJournal();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return undefined;
      const next = { ...entries[index], ...patch };
      entries[index] = next;
      await this.writeJsonl(this.journalPath, entries);
      return next;
    });
  }

  async listChangelog(): Promise<Array<Record<string, unknown>>> {
    return this.readJsonl<Record<string, unknown>>(this.changelogPath);
  }

  async appendChange(event: ChangeEvent): Promise<void> {
    await this.withWriteLock(() => this.appendJsonl(this.changesPath, event));
  }

  async listChanges(
    filter: { itemID?: string; limit?: number } = {},
  ): Promise<ChangeEvent[]> {
    const rows = await this.readJsonl<ChangeEvent>(this.changesPath);
    const filtered = filter.itemID
      ? rows.filter((row) => row.itemID === filter.itemID)
      : rows;
    return filter.limit !== undefined && filter.limit > 0
      ? filtered.slice(-filter.limit)
      : filtered;
  }

  async writeChangeJournal(journal: ChangeJournal): Promise<void> {
    await this.withWriteLock(() =>
      this.writeJson(path.join(this.changeJournalDir, `${journal.id}.json`), journal),
    );
  }

  async readChangeJournal(id: string): Promise<ChangeJournal | undefined> {
    if (!/^change_[A-Za-z0-9_]+$/.test(id)) return undefined;
    return this.readJson<ChangeJournal | undefined>(
      path.join(this.changeJournalDir, `${id}.json`),
      undefined,
    );
  }

  async listSuppressions(): Promise<Suppression[]> {
    return this.readJsonl<Suppression>(this.suppressionsPath);
  }

  async appendSuppression(record: Suppression): Promise<void> {
    await this.withWriteLock(() => this.appendJsonl(this.suppressionsPath, record));
  }

  async writeSuppressions(rows: Suppression[]): Promise<void> {
    await this.withWriteLock(() => this.writeJsonl(this.suppressionsPath, rows));
  }

  async listRetiredSources(): Promise<RetiredSource[]> {
    return this.readJsonl<RetiredSource>(this.retiredSourcesPath);
  }

  async writeRetiredSources(rows: RetiredSource[]): Promise<void> {
    await this.withWriteLock(() => this.writeJsonl(this.retiredSourcesPath, rows));
  }

  async readRetiredSourceState(): Promise<RetiredSourceState> {
    return this.readJson<RetiredSourceState>(this.retiredSourceStatePath, { epoch: 0 });
  }

  async writeRetiredSourceState(state: RetiredSourceState): Promise<void> {
    await this.withWriteLock(() => this.writeJson(this.retiredSourceStatePath, state));
  }

  async listGlobalCandidates(): Promise<GlobalCandidate[]> {
    return this.readJsonl<GlobalCandidate>(this.globalCandidatesPath);
  }

  async writeGlobalCandidates(rows: GlobalCandidate[]): Promise<void> {
    await this.withWriteLock(() => this.writeJsonl(this.globalCandidatesPath, rows));
  }

  async readGlobalCandidateState(): Promise<GlobalCandidateState> {
    return this.readJson<GlobalCandidateState>(this.globalCandidateStatePath, {
      epoch: 0,
      blocked: false,
    });
  }

  async writeGlobalCandidateState(state: GlobalCandidateState): Promise<void> {
    await this.withWriteLock(() => this.writeJson(this.globalCandidateStatePath, state));
  }

  async listExtractQuarantine(): Promise<ExtractQuarantineRecord[]> {
    return this.readJsonl<ExtractQuarantineRecord>(this.extractQuarantinePath);
  }

  async writeExtractQuarantine(rows: ExtractQuarantineRecord[]): Promise<void> {
    await this.withWriteLock(() => this.writeJsonl(this.extractQuarantinePath, rows));
  }

  /**
   * Version of the injectable memory: sorted active rows, expired count and
   * the nearest future expiry. A write-free clock crossing an `expiresAt`
   * must change it, so the cache is keyed by file identity *and* guarded by
   * the next expiry boundary; mtime/size alone would freeze it forever.
   */
  async memoryVersion(now: number = Date.now()): Promise<string> {
    const inTransaction = Boolean(this.pending.getStore());
    let key = "missing";
    if (!inTransaction) {
      try {
        const info = await stat(this.itemsPath);
        key = `${info.mtimeMs}:${info.size}:${info.ino}`;
      } catch {
        key = "missing";
      }
      const cached = this.versionCache;
      if (cached && cached.key === key && (cached.nextExpiry === null || now < cached.nextExpiry)) {
        return cached.version;
      }
    }
    const rows: string[][] = [];
    let expiredCount = 0;
    let nextExpiry: number | null = null;
    for (const item of await this.listItems()) {
      if (item.status !== "auto" && item.status !== "promoted") continue;
      const expiry = item.expiresAt ? Date.parse(item.expiresAt) : Number.NaN;
      if (Number.isFinite(expiry) && expiry <= now) {
        expiredCount += 1;
        continue;
      }
      if (item.invalidatedBy) continue;
      if (Number.isFinite(expiry) && (nextExpiry === null || expiry < nextExpiry)) {
        nextExpiry = expiry;
      }
      rows.push([item.id, itemContentVersion(item), item.expiresAt ?? ""]);
    }
    rows.sort((left, right) => left[0].localeCompare(right[0]));
    const version = sha16(JSON.stringify({ rows, expiredCount, nextExpiry }));
    if (!inTransaction) this.versionCache = { key, version, nextExpiry };
    return version;
  }

  async appendUsage(record: UsageRecord): Promise<void> {
    const file = record.kind === "decision" ? this.decisionUsagePath : this.rewriteUsagePath;
    await this.withWriteLock(() => this.appendJsonl(file, record));
  }

  async listUsage(kind: "decision" | "rewrite"): Promise<UsageRecord[]> {
    const file = kind === "decision" ? this.decisionUsagePath : this.rewriteUsagePath;
    return this.readJsonl<UsageRecord>(file);
  }

  async rotateUsage(kind: "decision" | "rewrite", maxLines = 2000, maxAgeDays = 30): Promise<void> {
    const file = kind === "decision" ? this.decisionUsagePath : this.rewriteUsagePath;
    await this.withWriteLock(async () => {
      const entries = await this.readJsonl<UsageRecord>(file);
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      const kept = entries
        .filter((entry) => new Date(entry.at).getTime() >= cutoff)
        .slice(-maxLines);
      await this.writeJsonl(file, kept);
    });
  }

  /** Cheap row count for a JSONL ledger; no parse, transaction-aware. */
  async countJsonlRows(file: string): Promise<number> {
    try {
      const raw = await this.readText(file);
      return raw.split("\n").filter((line) => line.trim().length > 0).length;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
      throw error;
    }
  }

  /** Count regular files in a data-dir subdirectory (journals, migrations). */
  async countFiles(relative: string, extension = ".json"): Promise<number> {
    try {
      const entries = await readdir(path.join(this.dataDir, relative), { withFileTypes: true });
      return entries.filter((entry) => entry.isFile() && (!extension || entry.name.endsWith(extension))).length;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
      throw error;
    }
  }

  /** Count subdirectories, e.g. checkpoint backups under `backup/`. */
  async countDirectories(relative: string, prefix = ""): Promise<number> {
    try {
      const entries = await readdir(path.join(this.dataDir, relative), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix)).length;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
      throw error;
    }
  }

  async dirSize(): Promise<number> {
    const walk = async (dir: string): Promise<number> => {
      let total = 0;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return 0;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          total += await walk(full);
        } else if (entry.isFile()) {
          try {
            total += (await stat(full)).size;
          } catch {
            // A file removed during the walk is not an error.
          }
        }
      }
      return total;
    };
    return walk(this.dataDir);
  }

  async readStats(): Promise<Record<string, number>> {
    return this.readJson<Record<string, number>>(this.statsPath, {});
  }

  async incrementStat(name: string, by = 1): Promise<void> {
    await this.withWriteLock(async () => {
      const stats = await this.readJson<Record<string, number>>(this.statsPath, {});
      stats[name] = (stats[name] ?? 0) + by;
      await this.writeJson(this.statsPath, stats);
    });
  }

  async setStat(name: string, value: number): Promise<void> {
    await this.withWriteLock(async () => {
      const stats = await this.readJson<Record<string, number>>(this.statsPath, {});
      stats[name] = value;
      await this.writeJson(this.statsPath, stats);
    });
  }

  async writeTextAtomic(file: string, text: string, backup = false): Promise<void> {
    await this.withWriteLock(async () => {
      if (backup && existsSync(file)) await this.writeText(`${file}.bak`, await this.readText(file));
      await this.writeText(file, text);
    });
  }

  async writeAutoView(memory: string, rules: string): Promise<void> {
    return this.transaction(async () => {
    await this.writeTextAtomic(this.autoMemoryPath, memory, true);
    await this.writeTextAtomic(this.autoRulesPath, rules, true);
    });
  }

  async ensureToken(): Promise<string> {
    return this.withWriteLock(async () => {
      if (existsSync(this.tokenPath)) {
        await chmod(this.tokenPath, 0o600);
        return (await readFile(this.tokenPath, "utf8")).trim();
      }
      const token = crypto.randomBytes(24).toString("hex");
      await writeFile(this.tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return token;
    });
  }
}
