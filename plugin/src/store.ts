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
import type {
  AuditReport,
  AutoMemConfig,
  Item,
  MergeJournal,
  Metrics,
  QueueItem,
  ShadowRecord,
  SkillDraft,
  SourceRef,
  UsageRecord,
} from "./types.js";
import { DEFAULT_CONFIG } from "./config.js";

const nowIso = () => new Date().toISOString();
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

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.skillDraftsDir, { recursive: true });
    await mkdir(this.outboxSkillsDir, { recursive: true });
    await ensureFile(this.itemsPath, "");
    await ensureFile(this.shadowPath, "");
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

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      const raw = await readFile(file, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  }

  private async readJsonl<T>(file: string): Promise<T[]> {
    try {
      const raw = await readFile(file, "utf8");
      const out: T[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as T);
        } catch {
          // Ignore a torn line; the next write repairs the file.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private async appendJsonl(file: string, value: unknown): Promise<void> {
    await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
  }

  async readConfig(): Promise<AutoMemConfig> {
    return this.readJson<AutoMemConfig>(this.configPath, DEFAULT_CONFIG);
  }

  async writeConfig(config: AutoMemConfig): Promise<void> {
    await this.withLock(() => this.writeJson(this.configPath, config));
  }

  async listItems(): Promise<Item[]> {
    return this.readJsonl<Item>(this.itemsPath);
  }

  async appendItem(item: Item): Promise<void> {
    await this.withLock(() => this.appendJsonl(this.itemsPath, item));
  }

  async updateItem(id: string, patch: Partial<Item>): Promise<Item | undefined> {
    return this.withLock(async () => {
      const items = await this.listItems();
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) return undefined;
      const next = { ...items[index], ...patch, updatedAt: nowIso() };
      items[index] = next;
      const tmp = `${this.itemsPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, items.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
      await rename(tmp, this.itemsPath);
      return next;
    });
  }

  async listQueue(): Promise<QueueItem[]> {
    return this.readJson<QueueItem[]>(this.queuePath, []);
  }

  async writeQueue(queue: QueueItem[]): Promise<void> {
    await this.withLock(() => this.writeJson(this.queuePath, queue));
  }

  async upsertQueue(item: QueueItem): Promise<void> {
    await this.withLock(async () => {
      const queue = await this.readJson<QueueItem[]>(this.queuePath, []);
      const index = queue.findIndex((entry) => entry.id === item.id);
      if (index === -1) queue.push(item);
      else queue[index] = { ...queue[index], ...item, updatedAt: nowIso() };
      await this.writeJson(this.queuePath, queue);
    });
  }

  async removeQueue(id: string): Promise<QueueItem | undefined> {
    return this.withLock(async () => {
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

  async appendShadow(record: ShadowRecord): Promise<void> {
    await this.withLock(() => this.appendJsonl(this.shadowPath, record));
  }

  async markShadowFalsePositive(id: string): Promise<ShadowRecord | undefined> {
    return this.withLock(async () => {
      const records = await this.listShadow();
      const index = records.findIndex((record) => record.id === id);
      if (index === -1) return undefined;
      const next = { ...records[index], falsePositive: true, falsePositiveAt: nowIso() };
      records[index] = next;
      const tmp = `${this.shadowPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
      await rename(tmp, this.shadowPath);
      return next;
    });
  }

  async readAudit(): Promise<AuditReport> {
    return this.readJson<AuditReport>(this.auditPath, emptyAudit());
  }

  async writeAudit(report: AuditReport): Promise<void> {
    await this.withLock(() => this.writeJson(this.auditPath, report));
  }

  async readMetrics(): Promise<Metrics> {
    return this.readJson<Metrics>(this.metricsPath, emptyMetrics());
  }

  async writeMetrics(metrics: Metrics): Promise<void> {
    await this.withLock(() => this.writeJson(this.metricsPath, metrics));
  }

  async appendChangelog(entry: Record<string, unknown>): Promise<void> {
    await this.withLock(() => this.appendJsonl(this.changelogPath, { at: nowIso(), ...entry }));
  }

  async readAutoMemory(): Promise<string> {
    try {
      return await readFile(this.autoMemoryPath, "utf8");
    } catch {
      return "# AUTO_MEMORY\n\n";
    }
  }

  async appendAutoMemory(text: string, meta: Record<string, unknown>): Promise<void> {
    await this.withLock(async () => {
      await appendFile(
        this.autoMemoryPath,
        `\n<!-- auto: ${JSON.stringify(meta)} -->\n- ${text}\n`,
        "utf8",
      );
    });
  }

  async readAutoRules(): Promise<string> {
    try {
      return await readFile(this.autoRulesPath, "utf8");
    } catch {
      return "# AUTO_RULES\n\n";
    }
  }

  async appendAutoRule(text: string, meta: Record<string, unknown>): Promise<void> {
    await this.withLock(async () => {
      await appendFile(
        this.autoRulesPath,
        `\n<!-- auto: ${JSON.stringify(meta)} -->\n- ${text}\n`,
        "utf8",
      );
    });
  }

  async readState(): Promise<{ sessions: Record<string, { lastMessageID?: string; lastRunAt?: string }>; lastAuditAt?: string }> {
    return this.readJson(this.statePath, { sessions: {} });
  }

  async writeState(state: { sessions: Record<string, { lastMessageID?: string; lastRunAt?: string }>; lastAuditAt?: string }): Promise<void> {
    await this.withLock(() => this.writeJson(this.statePath, state));
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
        const meta = JSON.parse(await readFile(metaPath, "utf8")) as SkillDraft;
        drafts.push({ ...meta, path: skillPath });
      } catch {
        try {
          const content = await readFile(skillPath, "utf8");
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
    await this.withLock(async () => {
      const root = path.join(this.skillDraftsDir, draft.id);
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "SKILL.md"), content, "utf8");
      await this.writeJson(path.join(root, "meta.json"), { ...draft, path: path.join(root, "SKILL.md") });
    });
  }

  async updateSkillDraft(id: string, patch: Partial<SkillDraft>, content?: string): Promise<SkillDraft | undefined> {
    const existing = await this.readSkillDraft(id);
    if (!existing) return undefined;
    const next: SkillDraft = { ...existing, ...patch, updatedAt: nowIso() };
    if (content !== undefined) {
      await this.writeSkillDraft(next, content);
    } else {
      await this.writeSkillDraft(next, await readFile(existing.path, "utf8"));
    }
    return next;
  }

  async writeOutboxSkill(name: string, content: string): Promise<string> {
    const root = path.join(this.outboxSkillsDir, name);
    await mkdir(root, { recursive: true });
    const file = path.join(root, "SKILL.md");
    await writeFile(file, content, "utf8");
    return file;
  }

  private async writeItemsFile(items: Item[]): Promise<void> {
    const tmp = `${this.itemsPath}.${process.pid}.${Date.now()}.tmp`;
    const body = items.map((item) => JSON.stringify(item)).join("\n");
    await writeFile(tmp, body.length > 0 ? `${body}\n` : "", "utf8");
    await rename(tmp, this.itemsPath);
  }

  async touchItem(id: string, source?: SourceRef): Promise<Item | undefined> {
    return this.withLock(async () => {
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
    await this.withLock(() => this.writeItemsFile(items));
  }

  async reserve(key: string, ttlMs: number): Promise<boolean> {
    return this.withLock(async () => {
      const now = Date.now();
      const data = await this.readJson<Record<string, number>>(this.reservationsPath, {});
      for (const [entry, at] of Object.entries(data)) {
        if (!Number.isFinite(at) || now - at > ttlMs) delete data[entry];
      }
      if (typeof data[key] === "number" && now - data[key] <= ttlMs) {
        await this.writeJson(this.reservationsPath, data);
        return false;
      }
      data[key] = now;
      await this.writeJson(this.reservationsPath, data);
      return true;
    });
  }

  async pruneReservations(ttlMs: number): Promise<number> {
    return this.withLock(async () => {
      const now = Date.now();
      const data = await this.readJson<Record<string, number>>(this.reservationsPath, {});
      let removed = 0;
      for (const [entry, at] of Object.entries(data)) {
        if (!Number.isFinite(at) || now - at > ttlMs) {
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
    await this.withLock(() => this.writeJson(file, value));
  }

  async appendJournal(entry: MergeJournal): Promise<void> {
    await this.withLock(() => this.appendJsonl(this.journalPath, entry));
  }

  async listJournal(): Promise<MergeJournal[]> {
    return this.readJsonl<MergeJournal>(this.journalPath);
  }

  async markJournalUndone(id: string): Promise<MergeJournal | undefined> {
    return this.withLock(async () => {
      const entries = await this.listJournal();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return undefined;
      const next = { ...entries[index], undone: true };
      entries[index] = next;
      const tmp = `${this.journalPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
      await rename(tmp, this.journalPath);
      return next;
    });
  }

  async updateJournal(
    id: string,
    patch: Partial<MergeJournal>,
  ): Promise<MergeJournal | undefined> {
    return this.withLock(async () => {
      const entries = await this.listJournal();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) return undefined;
      const next = { ...entries[index], ...patch };
      entries[index] = next;
      const tmp = `${this.journalPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
      await rename(tmp, this.journalPath);
      return next;
    });
  }

  async listChangelog(): Promise<Array<Record<string, unknown>>> {
    return this.readJsonl<Record<string, unknown>>(this.changelogPath);
  }

  async appendUsage(record: UsageRecord): Promise<void> {
    const file = record.kind === "decision" ? this.decisionUsagePath : this.rewriteUsagePath;
    await this.withLock(() => this.appendJsonl(file, record));
  }

  async listUsage(kind: "decision" | "rewrite"): Promise<UsageRecord[]> {
    const file = kind === "decision" ? this.decisionUsagePath : this.rewriteUsagePath;
    return this.readJsonl<UsageRecord>(file);
  }

  async rotateUsage(kind: "decision" | "rewrite", maxLines = 2000, maxAgeDays = 30): Promise<void> {
    const file = kind === "decision" ? this.decisionUsagePath : this.rewriteUsagePath;
    await this.withLock(async () => {
      const entries = await this.readJsonl<UsageRecord>(file);
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      const kept = entries
        .filter((entry) => new Date(entry.at).getTime() >= cutoff)
        .slice(-maxLines);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, kept.map((entry) => JSON.stringify(entry)).join("\n") + (kept.length ? "\n" : ""), "utf8");
      await rename(tmp, file);
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
    await this.withLock(async () => {
      const stats = await this.readJson<Record<string, number>>(this.statsPath, {});
      stats[name] = (stats[name] ?? 0) + by;
      await this.writeJson(this.statsPath, stats);
    });
  }

  async setStat(name: string, value: number): Promise<void> {
    await this.withLock(async () => {
      const stats = await this.readJson<Record<string, number>>(this.statsPath, {});
      stats[name] = value;
      await this.writeJson(this.statsPath, stats);
    });
  }

  async writeTextAtomic(file: string, text: string, backup = false): Promise<void> {
    await this.withLock(async () => {
      if (backup && existsSync(file)) await copyFile(file, `${file}.bak`);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, text, "utf8");
      await rename(tmp, file);
    });
  }

  async writeAutoView(memory: string, rules: string): Promise<void> {
    await this.writeTextAtomic(this.autoMemoryPath, memory, true);
    await this.writeTextAtomic(this.autoRulesPath, rules, true);
  }

  async ensureToken(): Promise<string> {
    if (existsSync(this.tokenPath)) {
      return (await readFile(this.tokenPath, "utf8")).trim();
    }
    const token = crypto.randomBytes(24).toString("hex");
    await writeFile(this.tokenPath, `${token}\n`, "utf8");
    await chmod(this.tokenPath, 0o600);
    return token;
  }
}
