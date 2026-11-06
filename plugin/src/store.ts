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
import { queueItemSnapshotVersion } from "./fingerprint.js";
import type {
  AuditReport,
  AutoMemConfig,
  HookRecord,
  Item,
  MergeJournal,
  Metrics,
  PersistedState,
  QueueItem,
  ReviewRecord,
  ReviewSessionNote,
  SessionState,
  ShadowRecord,
  SkillDraft,
  SourceRef,
  UsageRecord,
} from "./types.js";
import { DEFAULT_CONFIG } from "./config.js";
import { withFileLock } from "./util/lock.js";
import { commitFileBatch, recoverFileBatch, safeStorePath, type FileBatch } from "./util/transaction.js";

const nowIso = () => new Date().toISOString();
type Reservation = number | { expiresAt: number; token?: string };
// Legacy timestamps have no stored TTL. Keep them conservatively for ten
// minutes; new claims always carry their own expiry, independent of the caller.
const reservationExpiry = (value: Reservation, legacyTtl = 10 * 60_000): number =>
  typeof value === "number" ? value + legacyTtl : value?.expiresAt;
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

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
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
      await this.appendJsonl(this.shadowPath, record);
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

  /** Atomically reserve one review model call inside a rolling window. */
  async takeModelSlot(kind: "decision" | "rewrite" | "review", max: number, at = Date.now()): Promise<boolean> {
    return this.withStateLock(async () => {
      const state = await this.readState();
      const requests = state.modelRequests ?? {};
      const times = (requests[kind] ?? []).filter((entry) => entry >= at - 60 * 60 * 1000);
      if (times.length >= max) return false;
      times.push(at);
      requests[kind] = times;
      await this.writeJson(this.statePath, { ...state, modelRequests: requests });
      return true;
    });
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
