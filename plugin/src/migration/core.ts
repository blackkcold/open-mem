import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { newId, Store } from "../store.js";
import { newChangeID, recordChange } from "../changes.js";
import { redactText } from "../redact.js";
import { holdExtractQuarantine } from "../memory/lifecycle.js";
import type { Item, QueueItem } from "../types.js";
import {
  MigrationError,
  assertDisjoint,
  assertRegularFile,
  ensureCheckpointRoot,
  guardCheckpointRoot,
  guardExistingDirectory,
  guardTargetDirectory,
  manifestRelative,
  type GuardOptions,
} from "./guard.js";

export const TOOL_VERSION = "full-auto-memory-migrate/1";
export const DATA_SCHEMA = 1;
const DAY = 86_400_000;
const QUARANTINE_TTL_MS = 72 * 60 * 60_000;
const QUARANTINE_LIMIT = 200;

const FIXED_FILES = [
  "items.jsonl",
  "queue.json",
  "state.json",
  "config.json",
  "changes.jsonl",
  "suppressions.jsonl",
  "extract-quarantine.jsonl",
  "retired-sources.jsonl",
  "retired-source-state.json",
  "global-candidates.jsonl",
  "global-candidate-state.json",
  "merge-journal.jsonl",
  "changelog.jsonl",
] as const;

const DIRECTORY_FILES = ["change-journal", "migrations"] as const;

type RecordValue = Record<string, unknown>;
export type ProposalCategory =
  | "keep_protected"
  | "keep_missing_project_key"
  | "adopt_descriptive"
  | "quarantine_uncertain"
  | "skip_duplicate"
  | "skip_invalid"
  | "skip_dangling_change"
  | "skip_invalidated_upstream"
  | "baseline_active";

export interface Proposal {
  id: string;
  category: ProposalCategory;
  reason: string;
  queue?: QueueItem;
  item?: Item;
  baseline?: Item;
  repairChangeID?: string | undefined;
  repairBaseline?: boolean;
}

export interface MigrationPlan {
  toolVersion: string;
  schema: number;
  fingerprint: string;
  options: { repairDanglingChange: boolean };
  proposals: Proposal[];
  counts: Record<string, number>;
  inputFiles: Array<[string, string | null]>;
  configBefore: string | undefined;
  configAfter?: RecordValue;
  configChanged: boolean;
  blockedReasons: string[];
  dangling: boolean;
  noop: boolean;
}

export interface CheckpointFile {
  path: string;
  bytes: number;
  hash: string;
  absent: boolean;
  referencedBy: string[];
}

export interface CheckpointManifest {
  schema: number;
  toolVersion: string;
  id: string;
  createdAt: string;
  sourceFingerprint: string;
  files: CheckpointFile[];
  inputFiles: Array<[string, string | null]>;
  beforeDomains: DomainSnapshot;
}

export interface DomainSnapshot {
  items: string;
  queue: string;
  state: string;
  config: string;
  changes: string;
  suppressions: string;
  journal: string;
  quarantine: string;
  retired: string;
  global: string;
  migrations: string;
  changeJournals: string;
  changelog: string;
  files: string;
  business: string;
  store: string;
}

export interface MigrationJournal {
  id: string;
  createdAt: string;
  status: "applied" | "undone";
  undone: boolean;
  undoneAt?: string;
  pinned?: boolean;
  toolVersion: string;
  sourceFingerprint: string;
  checkpointID: string;
  checkpointHash: string;
  checkpointFiles: number;
  checkpointBytes: number;
  checkpointManifest: CheckpointFile[];
  counts: Record<string, number>;
  proposals: Array<{ id: string; category: ProposalCategory }>;
  changeIDs: string[];
  referencedChanges: string[];
  beforeDomains: DomainSnapshot;
  afterDomains: DomainSnapshot;
  afterFiles: Array<[string, string | null]>;
}

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as RecordValue)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
};
const canonicalText = (value: unknown) => JSON.stringify(canonical(value));
const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

async function optionalText(root: string, relative: string): Promise<string | undefined> {
  await assertNoSymlinkUnder(root, relative);
  try {
    return await readFile(path.join(root, relative), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new MigrationError(5, `无法读取数据文件：${relative}`);
  }
}

function parseJson<T>(relative: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MigrationError(5, `数据文件损坏：${relative}`);
  }
}

function parseJsonl<T>(relative: string, text: string | undefined): T[] {
  const rows: T[] = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      throw new MigrationError(5, `数据文件损坏：${relative}`);
    }
  }
  return rows;
}

function asArray<T>(relative: string, value: unknown): T[] {
  if (!Array.isArray(value)) throw new MigrationError(5, `数据文件形状不符：${relative}`);
  return value as T[];
}

function safeName(value: string): string | undefined {
  return /^[A-Za-z0-9_.-]+$/u.test(value) ? value : undefined;
}

async function safeDirectory(root: string, relative: string): Promise<boolean> {
  await assertNoSymlinkUnder(root, relative);
  try {
    const info = await lstat(path.join(root, relative));
    if (info.isSymbolicLink() || !info.isDirectory()) throw new MigrationError(5, "数据目录含链接或非目录");
    return true;
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw new MigrationError(5, "无法检查数据目录");
  }
}

export async function collectFileHashes(root: string): Promise<Array<[string, string | null]>> {
  const rows: Array<[string, string | null]> = [];
  for (const relative of FIXED_FILES) {
    const text = await optionalText(root, relative);
    rows.push([relative, text === undefined ? null : sha(text)]);
  }
  for (const directory of DIRECTORY_FILES) {
    if (!(await safeDirectory(root, directory))) continue;
    const names = (await readdir(path.join(root, directory))).sort();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const relative = `${directory}/${name}`;
      const text = await optionalText(root, relative);
      rows.push([relative, text === undefined ? null : sha(text)]);
    }
  }
  return rows.sort(([left], [right]) => left.localeCompare(right));
}

const itemKeys = new Set([
  "id", "title", "text", "kind", "scope", "project", "projectKey", "expiresAt", "manual",
  "status", "source", "createdAt", "updatedAt", "decision", "jev", "priority", "priorityBreakdown",
  "tags", "deferredUntil", "seenCount", "sources", "lastSeenAt", "fingerprint", "supersededBy",
  "aliases", "origin", "reviewType", "evidence", "evidenceRefs", "linkGroupID",
  "implicitGlobalClaimKey", "reviewID", "invalidatedBy", "invalidatedAt", "derivedFrom",
]);
function businessProjection(item: Item): RecordValue {
  return Object.fromEntries(Object.entries(item)
    .filter(([key]) => itemKeys.has(key) && key !== "changeID")
    .sort(([left], [right]) => left.localeCompare(right)));
}

function businessKey(item: { text?: string; kind?: string; scope?: string; projectKey?: string }): string {
  return `${item.scope ?? ""}\u0000${item.projectKey ?? ""}\u0000${item.kind ?? ""}\u0000${(item.text ?? "").trim()}`;
}

async function domainSnapshot(store: Store, excludeMigration?: string, extraFiles: string[] = []): Promise<DomainSnapshot> {
  const items = await store.listItems();
  const queue = await store.listQueue();
  const stateText = (await store.readDataText("state.json")) ?? "";
  const config = (await store.readDataText("config.json")) ?? "";
  const changes = await store.listChanges();
  const suppressions = await store.listSuppressions();
  const journal = await store.listJournal();
  const quarantine = await store.listExtractQuarantine();
  const retired = await store.listRetiredSources();
  const retiredState = await store.readRetiredSourceState();
  const global = await store.listGlobalCandidates();
  const globalState = await store.readGlobalCandidateState();
  const changelog = await store.listChangelog();
  const migrations: Array<[string, string | undefined]> = [];
  if (await safeDirectory(store.dataDir, "migrations")) {
    for (const name of await store.listDataDirectory("migrations")) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (id === excludeMigration) continue;
      migrations.push([name, await store.readDataText(`migrations/${name}`)]);
    }
  }
  const changeJournals: Array<[string, string | undefined]> = [];
  if (await safeDirectory(store.dataDir, "change-journal")) {
    for (const name of await store.listDataDirectory("change-journal")) {
      if (!name.endsWith(".json")) continue;
      changeJournals.push([name, await store.readDataText(`change-journal/${name}`)]);
    }
  }
  const extra: Array<[string, string | null]> = [];
  for (const relative of [...new Set(extraFiles)].sort()) {
    const text = await store.readDataText(relative);
    extra.push([relative, text === undefined ? null : sha(text)]);
  }
  const itemsHash = sha(canonicalText(items));
  const queueHash = sha(canonicalText(queue));
  const stateHash = sha(stateText);
  const configHash = sha(config);
  const changesHash = sha(canonicalText(changes));
  const suppressionsHash = sha(canonicalText(suppressions));
  const journalHash = sha(canonicalText(journal));
  const quarantineHash = sha(canonicalText(quarantine));
  const retiredHash = sha(canonicalText({ retired, retiredState }));
  const globalHash = sha(canonicalText({ global, globalState }));
  const migrationsHash = sha(canonicalText(migrations));
  const changeJournalsHash = sha(canonicalText(changeJournals));
  const changelogHash = sha(canonicalText(changelog));
  return {
    items: itemsHash,
    queue: queueHash,
    state: stateHash,
    config: configHash,
    changes: changesHash,
    suppressions: suppressionsHash,
    journal: journalHash,
    quarantine: quarantineHash,
    retired: retiredHash,
    global: globalHash,
    migrations: migrationsHash,
    changeJournals: changeJournalsHash,
    changelog: changelogHash,
    files: sha(canonicalText(extra)),
    business: sha(canonicalText({
      items: items.map(businessProjection),
      queue,
      config,
    })),
    store: sha(canonicalText({
      items, queue, state: stateText, config, changes, suppressions, journal, quarantine,
      retired, retiredState, global, globalState, migrations, changeJournals, changelog, extra,
    })),
  };
}

function sensitiveField(key: string): boolean {
  const normalized = key.toLowerCase();
  if (normalized === "authorization" || normalized === "proxy-authorization" ||
      normalized === "cookie" || normalized === "set-cookie" || normalized === "x-api-key" ||
      normalized === "key" || normalized === "auth") return true;
  return /(^|_)(token|password|passwd|secret|apikey|api_key|accesskey|access_key|privatekey|private_key|clientsecret|client_secret|refreshtoken|refresh_token)$/u.test(normalized);
}

function envReference(value: string): boolean {
  const trimmed = value.trim();
  return /^\{env:[^}]+\}$/u.test(trimmed) || /^\$[A-Z_][A-Z0-9_]*$/u.test(trimmed);
}

function urlHasCredentials(value: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(value.trim())) return false;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return true;
    for (const [key, entry] of url.searchParams) {
      if (entry && sensitiveField(key)) return true;
    }
    return false;
  } catch {
    // A URL-shaped value that cannot be parsed is not safe to copy.
    return true;
  }
}

function containsSecret(value: unknown, key = ""): boolean {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (envReference(trimmed)) return false;
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.endsWith("env")) {
      // Env var names stay legal; an actual token or URL here does not.
      return !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(trimmed);
    }
    if (urlHasCredentials(trimmed)) return true;
    if (sensitiveField(key)) return true;
    return redactText(trimmed, { paths: false }).hits > 0;
  }
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, key));
  if (isRecord(value)) return Object.entries(value).some(([field, entry]) => containsSecret(entry, field));
  return false;
}

function configPlan(raw: string | undefined): {
  before: string | undefined;
  after?: RecordValue;
  changed: boolean;
  blocked?: string;
} {
  if (raw === undefined) {
    return { before: raw, after: { automation: { enabled: false }, undo: { retainDays: 90 } }, changed: true };
  }
  const parsed = parseJson<unknown>("config.json", raw);
  if (!isRecord(parsed)) return { before: raw, changed: false, blocked: "config-not-object" };
  if (containsSecret(parsed)) {
    return { before: raw, changed: false, blocked: "config-secret-present" };
  }
  const next = structuredClone(parsed);
  if (!("automation" in next)) next.automation = { enabled: false };
  else if (isRecord(next.automation)) {
    if (!("enabled" in next.automation)) next.automation.enabled = false;
  } else return { before: raw, changed: false, blocked: "automation-not-object" };
  if (!("undo" in next)) next.undo = { retainDays: 90 };
  else if (isRecord(next.undo)) {
    if (!("retainDays" in next.undo)) next.undo.retainDays = 90;
  } else return { before: raw, changed: false, blocked: "undo-not-object" };
  return { before: raw, after: next, changed: JSON.stringify(next) !== JSON.stringify(parsed) };
}

export async function planMigration(
  dataDir: string,
  options: { repairDanglingChange?: boolean } = {},
): Promise<MigrationPlan> {
  const queueText = await optionalText(dataDir, "queue.json");
  const itemsText = await optionalText(dataDir, "items.jsonl");
  const changesText = await optionalText(dataDir, "changes.jsonl");
  const configText = await optionalText(dataDir, "config.json");
  const quarantineText = await optionalText(dataDir, "extract-quarantine.jsonl");
  const queue = queueText === undefined ? [] : asArray<QueueItem>("queue.json", parseJson<unknown>("queue.json", queueText));
  const items = parseJsonl<Item>("items.jsonl", itemsText);
  const changes = parseJsonl<{ id: string; itemID: string }>("changes.jsonl", changesText);
  const quarantine = parseJsonl<RecordValue>("extract-quarantine.jsonl", quarantineText);
  const changeIDs = new Set(changes.map((event) => event.id));
  const changeOwner = new Map(changes.map((event) => [event.id, event.itemID]));
  const latestByItem = new Map<string, string>();
  for (const event of changes) latestByItem.set(event.itemID, event.id);
  const ownsChangeID = (itemID: string, changeID: unknown): boolean =>
    typeof changeID === "string" && changeIDs.has(changeID) && changeOwner.get(changeID) === itemID;
  const config = configPlan(configText);
  const blockedReasons: string[] = [];
  if (config.blocked) blockedReasons.push(config.blocked);
  if (await lstat(path.join(dataDir, ".pending-transaction.json")).then(() => true).catch(() => false)) {
    blockedReasons.push("wal-present");
  }
  const repair = options.repairDanglingChange === true;
  const proposals: Proposal[] = [];
  const existingKeys = new Set(items.map(businessKey));
  const existingIDs = new Set(items.map((item) => item.id));
  const adoptedIDs = new Set<string>();
  const queuedKeys = new Set<string>();
  let dangling = false;

  const queueDangling = queue.some((item) => typeof item.changeID === "string" && !ownsChangeID(item.id, item.changeID));
  const itemDangling = items.some((item) => typeof item.changeID === "string" && !ownsChangeID(item.id, item.changeID));
  dangling = queueDangling || itemDangling;
  if (dangling && !repair) blockedReasons.push("dangling-change");

  for (const row of queue) {
    const copy = structuredClone(row);
    if (typeof copy.id !== "string" || !copy.id ||
        typeof copy.text !== "string" || !copy.text.trim() ||
        typeof copy.title !== "string" || !copy.title.trim() ||
        typeof copy.kind !== "string" || !copy.kind ||
        (copy.scope !== "session" && copy.scope !== "project" && copy.scope !== "global") ||
        !isRecord(copy.source)) {
      proposals.push({ id: typeof copy.id === "string" && copy.id ? copy.id : "invalid", category: "skip_invalid", reason: "missing-fields", queue: copy });
      continue;
    }
    if (copy.manual === true || copy.status === "promoted" || copy.kind === "rule" || copy.kind === "skill") {
      proposals.push({ id: copy.id, category: "keep_protected", reason: "protected-kind", queue: copy });
      continue;
    }
    if (copy.kind !== "fact" && copy.kind !== "preference" && copy.kind !== "reference") {
      proposals.push({ id: copy.id, category: "keep_protected", reason: "unknown-kind", queue: copy });
      continue;
    }
    if (!isRecord(copy.source) || Object.keys(copy.source).length === 0 ||
        (typeof copy.source.sessionID !== "string" && typeof copy.source.messageID !== "string")) {
      proposals.push({ id: copy.id, category: "keep_protected", reason: "source-unknown", queue: copy });
      continue;
    }
    if (copy.scope === "project" && !copy.projectKey) {
      proposals.push({ id: copy.id, category: "keep_missing_project_key", reason: "missing-project-key", queue: copy });
      continue;
    }
    const danglingQueue = typeof copy.changeID === "string" && !ownsChangeID(copy.id, copy.changeID);
    if (danglingQueue && !repair) {
      proposals.push({ id: copy.id, category: "skip_dangling_change", reason: "dangling-change", queue: copy });
      continue;
    }
    if (danglingQueue) copy.changeID = undefined;
    if (existingIDs.has(copy.id) || adoptedIDs.has(copy.id)) {
      proposals.push({ id: copy.id, category: "skip_duplicate", reason: "duplicate-id", queue: copy });
      continue;
    }
    const key = businessKey(copy);
    if (existingKeys.has(key) || queuedKeys.has(key)) {
      proposals.push({ id: copy.id, category: "skip_duplicate", reason: "exact-duplicate", queue: copy });
      continue;
    }
    queuedKeys.add(key);
    const maxChars = isRecord(config.after?.thresholds) && typeof config.after.thresholds.memoryMaxChars === "number"
      ? config.after.thresholds.memoryMaxChars
      : 200;
    const conflict = isRecord(copy.decision) && typeof copy.decision.conflict === "number" ? copy.decision.conflict : 0;
    if (copy.text.length > maxChars || conflict >= 0.8) {
      if (quarantine.filter((entry) => typeof entry.expiresAt === "string" && Date.parse(entry.expiresAt) > Date.now()).length >= QUARANTINE_LIMIT) {
        proposals.push({ id: copy.id, category: "keep_protected", reason: "quarantine-capacity", queue: copy });
        continue;
      }
      proposals.push({ id: copy.id, category: "quarantine_uncertain", reason: copy.text.length > maxChars ? "too-long" : "conflict", queue: copy });
      continue;
    }
    adoptedIDs.add(copy.id);
    proposals.push({
      id: copy.id,
      category: "adopt_descriptive",
      reason: danglingQueue ? "repair-baseline" : "descriptive-queue",
      queue: copy,
      item: { ...copy, status: "queue" },
      ...(danglingQueue ? { repairBaseline: true } : {}),
    });
  }

  for (const item of items) {
    if (typeof item.changeID === "string" && !ownsChangeID(item.id, item.changeID) && latestByItem.has(item.id)) {
      proposals.push({
        id: item.id,
        category: "skip_dangling_change",
        reason: "dangling-change",
        baseline: item,
        repairChangeID: latestByItem.get(item.id),
      });
      continue;
    }
    if (typeof item.changeID === "string" && !ownsChangeID(item.id, item.changeID) &&
        !latestByItem.has(item.id) && item.status !== "auto" && item.status !== "promoted") {
      proposals.push({ id: item.id, category: "skip_dangling_change", reason: "dangling-change", baseline: item, repairBaseline: true });
      continue;
    }
    if (item.status !== "auto" && item.status !== "promoted") continue;
    if (latestByItem.has(item.id)) continue;
    if (typeof item.changeID === "string" && !ownsChangeID(item.id, item.changeID) && !repair) {
      proposals.push({ id: item.id, category: "skip_dangling_change", reason: "dangling-change", baseline: item });
      continue;
    }
    proposals.push({
      id: item.id,
      category: "baseline_active",
      reason: "missing-baseline",
      baseline: item,
      repairChangeID: typeof item.changeID === "string" && !ownsChangeID(item.id, item.changeID) ? undefined : item.changeID,
    });
  }
  for (const item of items) {
    if (!item.invalidatedBy) continue;
    const upstream = items.find((entry) => entry.id === item.invalidatedBy);
    if (!upstream || (upstream.status !== "auto" && upstream.status !== "promoted") || upstream.invalidatedBy) {
      proposals.push({ id: item.id, category: "skip_invalidated_upstream", reason: "invalid-upstream" });
    }
  }

  const inputFiles = await collectFileHashes(dataDir);
  const counts: Record<string, number> = {};
  for (const proposal of proposals) counts[proposal.category] = (counts[proposal.category] ?? 0) + 1;
  const optionsKey = { repairDanglingChange: repair };
  const proposalKey = proposals
    .map((proposal) => ({
      id: proposal.id,
      category: proposal.category,
      kind: proposal.queue?.kind ?? proposal.baseline?.kind ?? proposal.item?.kind ?? null,
      scope: proposal.queue?.scope ?? proposal.baseline?.scope ?? proposal.item?.scope ?? null,
      projectKey: proposal.queue?.projectKey ?? proposal.baseline?.projectKey ?? proposal.item?.projectKey ?? null,
      textHash: sha(proposal.queue?.text ?? proposal.baseline?.text ?? proposal.item?.text ?? ""),
      changeID: proposal.queue?.changeID ?? proposal.baseline?.changeID ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const fingerprint = sha(canonicalText({
    toolVersion: TOOL_VERSION,
    schema: DATA_SCHEMA,
    options: optionsKey,
    inputFiles,
    proposals: proposalKey,
    configChanged: config.changed,
    configAfter: config.changed ? config.after : null,
  }));
  return {
    toolVersion: TOOL_VERSION,
    schema: DATA_SCHEMA,
    fingerprint,
    options: optionsKey,
    proposals,
    counts,
    inputFiles,
    configBefore: config.before,
    ...(config.after ? { configAfter: config.after } : {}),
    configChanged: config.changed,
    blockedReasons: blockedReasons.sort(),
    dangling: dangling && !repair,
    noop: blockedReasons.length === 0 && !config.changed &&
      !proposals.some((proposal) =>
        proposal.category === "adopt_descriptive" ||
        proposal.category === "quarantine_uncertain" ||
        proposal.category === "baseline_active" ||
        (proposal.category === "skip_dangling_change" && repair)),
  };
}

async function writeDurable(file: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const dir = await open(path.dirname(file), "r");
  try { await dir.sync(); } finally { await dir.close(); }
}

async function fileInfo(file: string): Promise<{ exists: boolean; bytes: number; hash: string }> {
  const status = await assertRegularFile(file);
  if (status === "absent") return { exists: false, bytes: 0, hash: "" };
  const data = await readFile(file);
  return { exists: true, bytes: data.length, hash: sha(data) };
}

async function referencedCheckpointFiles(store: Store): Promise<string[]> {
  const changelog = parseJsonl<RecordValue>("changelog.jsonl", await store.readDataText("changelog.jsonl"));
  const references = new Set<string>();
  const visit = (value: unknown, key = "") => {
    if (typeof value === "string" && /^(?:.*ID|.*Id)$/u.test(key)) references.add(value);
    else if (Array.isArray(value)) for (const entry of value) visit(entry);
    else if (isRecord(value)) for (const [field, entry] of Object.entries(value)) visit(entry, field);
  };
  for (const entry of changelog) visit(entry);
  const files = new Set<string>();
  for (const id of references) {
    const name = safeName(id);
    if (!name) continue;
    files.add(`recovery/${name}.json`);
    files.add(`maintenance/${name}.json`);
    files.add(`maintenance/${name}.items.bak`);
    files.add(`curator/${name}.json`);
    files.add(`curator/items.jsonl.bak-${name}`);
    files.add(`session-archive/${name}.json`);
  }
  return [...files].filter((relative) => safeName(path.basename(relative, ".json")) !== undefined ||
    relative.endsWith(".items.bak") || relative.startsWith("curator/items.jsonl.bak-"));
}

async function checkpointPaths(store: Store): Promise<string[]> {
  const paths = new Set<string>(FIXED_FILES);
  for (const directory of DIRECTORY_FILES) {
    if (!(await safeDirectory(store.dataDir, directory))) continue;
    for (const name of await store.listDataDirectory(directory)) {
      if (name.endsWith(".json")) paths.add(`${directory}/${name}`);
    }
  }
  for (const relative of await referencedCheckpointFiles(store)) {
    if (await store.readDataText(relative) !== undefined) paths.add(relative);
  }
  return [...paths].sort();
}

export async function createCheckpoint(
  dataDir: string,
  checkpointRoot: string,
  id: string,
  plan: MigrationPlan,
  guard: GuardOptions,
): Promise<{ dir: string; manifest: CheckpointManifest }> {
  const guardedRoot = await guardCheckpointRoot(checkpointRoot, guard);
  await assertDisjoint(dataDir, guardedRoot);
  const root = await ensureCheckpointRoot(guardedRoot, guard);
  const finalDir = path.join(root, id);
  const staging = path.join(root, `.${id}.tmp-${process.pid}-${Date.now()}`);
  if (await lstat(finalDir).then(() => true).catch(() => false)) {
    throw new MigrationError(6, "checkpoint 已存在");
  }
  const store = new Store(dataDir);
  const snapshot = await store.transaction(async () => {
    const configText = await store.readDataText("config.json");
    if (configText !== undefined && containsSecret(parseJson<unknown>("config.json", configText))) {
      throw new MigrationError(6, "配置含凭证字段，拒绝创建 checkpoint");
    }
    const currentInputs = await collectFileHashesFromStore(store);
    if (canonicalText(currentInputs) !== canonicalText(plan.inputFiles)) {
      throw new MigrationError(4, "数据在 dry-run 后发生变化；未写 checkpoint");
    }
    const paths = await checkpointPaths(store);
    const files: CheckpointFile[] = [];
    for (const relative of paths) {
      const text = await store.readDataText(relative);
      const absent = text === undefined;
      const bytes = absent ? 0 : Buffer.byteLength(text);
      const digest = absent ? "" : sha(text);
      files.push({
        path: relative,
        bytes,
        hash: digest,
        absent,
        referencedBy: [relative.includes("/") ? "referenced-history" : "runtime/ledger"],
      });
      if (!absent) await writeDurable(path.join(staging, relative), text);
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const beforeDomains = await domainSnapshot(store, undefined, paths);
    const manifest: CheckpointManifest = {
      schema: DATA_SCHEMA,
      toolVersion: TOOL_VERSION,
      id,
      createdAt: new Date().toISOString(),
      sourceFingerprint: plan.fingerprint,
      files,
      inputFiles: currentInputs,
      beforeDomains,
    };
    await writeDurable(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return readCheckpointManifest(staging);
  });
  await rename(staging, finalDir);
  const parent = await open(root, "r");
  try { await parent.sync(); } finally { await parent.close(); }
  return { dir: finalDir, manifest: snapshot };
}

function checkpointAllowedPath(relative: string): boolean {
  if ((FIXED_FILES as readonly string[]).includes(relative)) return true;
  const patterns = [
    /^change-journal\/[A-Za-z0-9_.-]+\.json$/u,
    /^migrations\/[A-Za-z0-9_.-]+\.json$/u,
    /^recovery\/[A-Za-z0-9_.-]+\.json$/u,
    /^maintenance\/[A-Za-z0-9_.-]+\.json$/u,
    /^maintenance\/[A-Za-z0-9_.-]+\.items\.bak$/u,
    /^curator\/[A-Za-z0-9_.-]+\.json$/u,
    /^curator\/items\.jsonl\.bak-[A-Za-z0-9_.-]+$/u,
    /^session-archive\/[A-Za-z0-9_.-]+\.json$/u,
  ];
  return patterns.some((pattern) => pattern.test(relative));
}

function isDomainSnapshot(value: unknown): value is DomainSnapshot {
  if (!isRecord(value)) return false;
  return ["items", "queue", "state", "config", "changes", "suppressions", "journal", "quarantine",
    "retired", "global", "migrations", "changeJournals", "changelog", "files", "business", "store"]
    .every((key) => typeof value[key] === "string" && /^[a-f0-9]{64}$/u.test(value[key] as string));
}

async function assertNoSymlinkUnder(root: string, relative: string): Promise<void> {
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    if (!part) continue;
    cursor = path.join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new MigrationError(5, "checkpoint 含符号链接");
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw new MigrationError(5, "无法检查 checkpoint 路径");
    }
  }
}

export async function readCheckpointManifest(dir: string): Promise<CheckpointManifest> {
  const manifestPath = path.join(dir, "manifest.json");
  const manifestInfo = await lstat(manifestPath).catch(() => {
    throw new MigrationError(5, "checkpoint manifest 缺失或不可读");
  });
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new MigrationError(5, "checkpoint manifest 非普通文件");
  const raw = await readFile(manifestPath, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new MigrationError(5, "checkpoint manifest 损坏"); }
  if (!isRecord(parsed) || parsed.schema !== DATA_SCHEMA || !Array.isArray(parsed.files) ||
      !Array.isArray(parsed.inputFiles) || !isRecord(parsed.beforeDomains) ||
      typeof parsed.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.sourceFingerprint) ||
      typeof parsed.id !== "string" || !/^migration_[A-Za-z0-9_]+$/u.test(parsed.id) ||
      typeof parsed.toolVersion !== "string" || typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      !isDomainSnapshot(parsed.beforeDomains)) {
    throw new MigrationError(5, "checkpoint manifest 形状不符");
  }
  const seenPaths = new Set<string>();
  const files: CheckpointFile[] = [];
  for (const entry of parsed.files) {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.hash !== "string" ||
        typeof entry.bytes !== "number" || typeof entry.absent !== "boolean" ||
        !Array.isArray(entry.referencedBy)) throw new MigrationError(5, "checkpoint manifest 文件项非法");
    const relative = manifestRelative(entry.path);
    if (!checkpointAllowedPath(relative) || seenPaths.has(relative)) {
      throw new MigrationError(5, "checkpoint manifest 含越权或重复路径");
    }
    seenPaths.add(relative);
    if (!entry.absent && !/^[a-f0-9]{64}$/u.test(entry.hash)) {
      throw new MigrationError(5, "checkpoint manifest hash 形状不符");
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) throw new MigrationError(5, "checkpoint manifest bytes 非法");
    await assertNoSymlinkUnder(dir, relative);
    const info = await fileInfo(path.join(dir, relative));
    if (entry.absent) {
      if (info.exists) throw new MigrationError(5, "checkpoint absent 文件实际存在");
    } else if (!info.exists || info.hash !== entry.hash || info.bytes !== entry.bytes) {
      throw new MigrationError(5, "checkpoint 文件 hash 不符");
    }
    files.push({
      path: relative,
      bytes: entry.bytes,
      hash: entry.hash,
      absent: entry.absent,
      referencedBy: entry.referencedBy.filter((value): value is string => typeof value === "string"),
    });
  }
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  for (const relative of FIXED_FILES) {
    if (!fileByPath.has(relative)) throw new MigrationError(5, "checkpoint manifest 缺少固定文件记录");
  }
  const inputSeen = new Set<string>();
  for (const entry of parsed.inputFiles) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" ||
        (entry[1] !== null && (typeof entry[1] !== "string" || !/^[a-f0-9]{64}$/u.test(entry[1]))) ||
        inputSeen.has(entry[0])) {
      throw new MigrationError(5, "checkpoint manifest inputFiles 非法");
    }
    const relative = manifestRelative(entry[0]);
    if (!((FIXED_FILES as readonly string[]).includes(relative) ||
      /^(change-journal|migrations)\/[A-Za-z0-9_.-]+\.json$/u.test(relative))) {
      throw new MigrationError(5, "checkpoint manifest inputFiles 越权");
    }
    const file = fileByPath.get(relative);
    if (!file) throw new MigrationError(5, "checkpoint manifest inputFiles 缺少文件项");
    if (entry[1] === null ? !file.absent : (file.absent || file.hash !== entry[1])) {
      throw new MigrationError(5, "checkpoint manifest inputFiles 与文件项不一致");
    }
    inputSeen.add(relative);
  }
  return {
    schema: DATA_SCHEMA,
    toolVersion: String(parsed.toolVersion),
    id: String(parsed.id),
    createdAt: String(parsed.createdAt),
    sourceFingerprint: parsed.sourceFingerprint,
    files,
    inputFiles: parsed.inputFiles as Array<[string, string | null]>,
    beforeDomains: parsed.beforeDomains as unknown as DomainSnapshot,
  };
}

export async function applyMigration(
  dataDir: string,
  checkpointRoot: string,
  plan: MigrationPlan,
  confirm: string,
  guard: GuardOptions,
  pin = false,
): Promise<{ id: string; journal?: MigrationJournal; checkpointDir?: string }> {
  if (plan.fingerprint !== confirm) throw new MigrationError(3, "fingerprint 不符，零写入");
  if (plan.blockedReasons.length > 0) throw new MigrationError(6, `迁移被阻断：${plan.blockedReasons.join(",")}`);
  if (plan.noop) return { id: "" };
  const wal = path.join(dataDir, ".pending-transaction.json");
  if (await lstat(wal).then(() => true).catch(() => false)) {
    throw new MigrationError(6, "存在未恢复 WAL；请先用生产 Store 恢复并重新 dry-run");
  }
  const id = newId("migration");
  const checkpoint = await createCheckpoint(dataDir, checkpointRoot, id, plan, guard);
  const store = new Store(dataDir);
  const now = Date.now();
  const checkpointPaths = checkpoint.manifest.files.map((file) => file.path);
  const journal = await store.transaction(async () => {
    const stagedInputs = await collectFileHashesFromStore(store);
    if (canonicalText(stagedInputs) !== canonicalText(checkpoint.manifest.inputFiles)) {
      throw new MigrationError(4, "输入在 checkpoint 后发生变化；checkpoint 成为孤儿");
    }
    const before = await domainSnapshot(store, undefined, checkpointPaths);
    if (canonicalText(before) !== canonicalText(checkpoint.manifest.beforeDomains)) {
      throw new MigrationError(4, "数据域在 checkpoint 后发生变化");
    }
    const queue = await store.listQueue();
    const items = await store.listItems();
    const removeIDs = new Set(plan.proposals
      .filter((proposal) => proposal.category === "adopt_descriptive" || proposal.category === "quarantine_uncertain")
      .map((proposal) => proposal.id));
    const nextQueue = queue.filter((entry) => !removeIDs.has(entry.id));
    const nextItems = [...items];
    const adopted = plan.proposals
      .filter((proposal) => proposal.category === "adopt_descriptive" && proposal.item)
      .map((proposal) => proposal.item as Item);
    nextItems.push(...adopted);
    const baselineItems: Item[] = [];
    const changeIDs: string[] = [];
    for (const proposal of plan.proposals) {
      if (proposal.category === "baseline_active" && proposal.baseline) {
        const current = nextItems.find((entry) => entry.id === proposal.id);
        if (!current) continue;
        const stamped: Item = {
          ...current,
          changeID: newChangeID(),
        };
        const index = nextItems.findIndex((entry) => entry.id === current.id);
        if (index >= 0) nextItems[index] = stamped;
        baselineItems.push(stamped);
        continue;
      }
      if (proposal.category === "skip_dangling_change" && plan.options.repairDanglingChange && proposal.baseline) {
        const index = nextItems.findIndex((entry) => entry.id === proposal.id);
        if (index < 0) continue;
        const current = nextItems[index];
        const repaired = { ...current } as Item;
        if (proposal.repairChangeID) {
          repaired.changeID = proposal.repairChangeID;
        } else {
          repaired.changeID = newChangeID();
          baselineItems.push(repaired);
        }
        nextItems[index] = repaired;
      }
    }
    for (const proposal of plan.proposals) {
      if (!proposal.repairBaseline || proposal.category !== "adopt_descriptive") continue;
      const index = nextItems.findIndex((entry) => entry.id === proposal.id);
      if (index < 0) continue;
      const repaired = { ...nextItems[index], changeID: newChangeID() };
      nextItems[index] = repaired;
      baselineItems.push(repaired);
    }
    await store.writeQueue(nextQueue);
    await store.replaceItems(nextItems);
    for (const proposal of plan.proposals) {
      if (proposal.category !== "quarantine_uncertain" || !proposal.queue) continue;
      const source = proposal.queue.source;
      const held = await holdExtractQuarantine(store, {
        text: proposal.queue.text,
        title: proposal.queue.title,
        kind: proposal.queue.kind,
        scope: proposal.queue.scope,
        ...(proposal.queue.projectKey ? { projectKey: proposal.queue.projectKey } : {}),
        source,
        reason: "migration-uncertain",
      }, now);
      if (!held) throw new MigrationError(5, "隔离区拒收，迁移已回滚");
    }
    if (plan.configChanged && plan.configAfter) {
      await store.writeTextAtomic(store.configPath, `${JSON.stringify(plan.configAfter, null, 2)}\n`);
    }
    for (const item of baselineItems) {
      const event = await recordChange(store, {
        kind: "migration",
        actor: "migration",
        itemID: item.id,
        item,
        before: item,
        source: item.source,
        origin: "migration",
        reason: `baseline:${TOOL_VERSION}`,
      });
      changeIDs.push(event.id);
    }
    const counts = plan.counts;
    await store.appendChangelog({
      action: "migration",
      migrationID: id,
      counts,
      baseline: baselineItems.length,
      adopted: adopted.length,
      quarantined: plan.counts.quarantine_uncertain ?? 0,
    });
    const after = await domainSnapshot(store, id, checkpointPaths);
    const afterFiles = await collectFileHashesFromStore(store);
    const journal: MigrationJournal = {
      id,
      createdAt: new Date().toISOString(),
      status: "applied",
      undone: false,
      ...(pin ? { pinned: true } : {}),
      toolVersion: TOOL_VERSION,
      sourceFingerprint: plan.fingerprint,
      checkpointID: id,
      checkpointHash: sha(canonicalText(checkpoint.manifest.files)),
      checkpointFiles: checkpoint.manifest.files.filter((file) => !file.absent).length,
      checkpointBytes: checkpoint.manifest.files.reduce((total, file) => total + file.bytes, 0),
      checkpointManifest: checkpoint.manifest.files,
      counts,
      proposals: plan.proposals.map((proposal) => ({ id: proposal.id, category: proposal.category })),
      changeIDs,
      referencedChanges: baselineItems.map((item) => item.changeID ?? "").filter(Boolean),
      beforeDomains: before,
      afterDomains: after,
      afterFiles,
    };
    await store.writeTextAtomic(path.join(store.dataDir, "migrations", `${id}.json`), `${JSON.stringify(journal, null, 2)}\n`);
    return journal;
  });
  const verifyStore = new Store(dataDir);
  const verified = await domainSnapshot(verifyStore, id, checkpointPaths);
  if (canonicalText(verified) !== canonicalText(journal.afterDomains)) {
    throw new MigrationError(5, "迁移提交后校验失败；未覆盖新数据，请人工核对");
  }
  return { id, journal, checkpointDir: checkpoint.dir };
}

async function collectFileHashesFromStore(store: Store): Promise<Array<[string, string | null]>> {
  const rows: Array<[string, string | null]> = [];
  for (const relative of FIXED_FILES) {
    const text = await store.readDataText(relative);
    rows.push([relative, text === undefined ? null : sha(text)]);
  }
  for (const directory of DIRECTORY_FILES) {
    if (!(await safeDirectory(store.dataDir, directory))) continue;
    for (const name of await store.listDataDirectory(directory)) {
      if (!name.endsWith(".json")) continue;
      const relative = `${directory}/${name}`;
      const text = await store.readDataText(relative);
      rows.push([relative, text === undefined ? null : sha(text)]);
    }
  }
  return rows.sort(([left], [right]) => left.localeCompare(right));
}

export async function undoMigration(
  dataDir: string,
  checkpointRoot: string,
  id: string,
  guard: GuardOptions,
): Promise<MigrationJournal> {
  const journalPath = path.join(dataDir, "migrations", `${id}.json`);
  if (await lstat(path.join(dataDir, ".pending-transaction.json")).then(() => true).catch(() => false)) {
    throw new MigrationError(6, "存在未恢复 WAL，拒绝 undo");
  }
  const checkpointDir = path.join(checkpointRoot, id);
  await guardExistingDirectory(checkpointDir, "checkpoint", guard);
  const manifest = await readCheckpointManifest(checkpointDir);
  const store = new Store(dataDir);
  return store.transaction(async () => {
    const journalText = await store.readDataText(`migrations/${id}.json`);
    if (journalText === undefined) throw new MigrationError(6, "迁移 journal 不存在");
    const journal = JSON.parse(journalText) as MigrationJournal;
    if (journal.undone || journal.status === "undone") throw new MigrationError(6, "这次迁移已经撤销");
    if (journal.status !== "applied") throw new MigrationError(6, "迁移状态不可 undo");
    if (manifest.id !== id || sha(canonicalText(manifest.files)) !== journal.checkpointHash) {
      throw new MigrationError(5, "journal 与 checkpoint 不匹配");
    }
    const checkpointPaths = manifest.files.map((file) => file.path);
    const current = await domainSnapshot(store, id, checkpointPaths);
    if (canonicalText(current) !== canonicalText(journal.afterDomains)) {
      throw new MigrationError(4, "迁移后数据域发生漂移；请使用 rollback --restore 到新目录");
    }
    for (const file of manifest.files) {
      if (file.path === `migrations/${id}.json`) continue;
      if (file.absent) {
        await store.deleteDataFile(file.path);
        continue;
      }
      const data = await readFile(path.join(checkpointDir, file.path), "utf8");
      await store.writeTextAtomic(path.join(store.dataDir, file.path), data);
    }
    const beforePaths = new Set(manifest.files.filter((file) => !file.absent).map((file) => file.path));
    for (const [relative, hash] of journal.afterFiles ?? []) {
      if (!hash || relative === `migrations/${id}.json` || beforePaths.has(relative)) continue;
      await store.deleteDataFile(relative);
    }
    const restored = await domainSnapshot(store, id, checkpointPaths);
    if (canonicalText(restored) !== canonicalText(manifest.beforeDomains)) {
      throw new MigrationError(5, "恢复后 checkpoint 校验失败，事务已回滚");
    }
    const next: MigrationJournal = { ...journal, status: "undone", undone: true, undoneAt: new Date().toISOString() };
    await store.writeTextAtomic(journalPath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export async function restoreCheckpoint(
  checkpointDir: string,
  target: string,
  guard: GuardOptions,
): Promise<CheckpointManifest> {
  const source = await guardExistingDirectory(checkpointDir, "checkpoint", guard);
  const destination = await guardTargetDirectory(target, guard);
  if (destination.resolved === source || destination.resolved.startsWith(`${source}${path.sep}`)) {
    throw new MigrationError(2, "target 不得位于 checkpoint 内");
  }
  const manifest = await readCheckpointManifest(source);
  const configEntry = manifest.files.find((file) => file.path === "config.json" && !file.absent);
  if (configEntry) {
    const configText = await readFile(path.join(source, "config.json"), "utf8");
    if (containsSecret(parseJson<unknown>("config.json", configText))) {
      throw new MigrationError(6, "checkpoint 配置含凭证字段，拒绝恢复");
    }
  }
  await mkdir(destination.resolved, { recursive: true, mode: 0o700 });
  for (const file of manifest.files) {
    if (file.absent) continue;
    const data = await readFile(path.join(source, file.path));
    await writeDurable(path.join(destination.resolved, file.path), data);
  }
  for (const file of manifest.files) {
    const info = await fileInfo(path.join(destination.resolved, file.path));
    if (file.absent ? info.exists : (!info.exists || info.hash !== file.hash)) {
      throw new MigrationError(5, "restore 目标校验失败");
    }
  }
  return manifest;
}

export interface CompatLossReport {
  sourceKind: "checkpoint" | "data";
  checkpointID: string;
  warnings: string[];
  counts: Record<string, number>;
  createdAt: string;
  clearedPinnedContext: number;
}

interface CompatFiles {
  source: string;
  kind: "checkpoint" | "data";
  report: CompatLossReport;
  files: Map<string, string>;
}

async function buildCompat(sourceDir: string, kind: "checkpoint" | "data", guard: GuardOptions): Promise<CompatFiles> {
  const source = await guardExistingDirectory(sourceDir, kind === "checkpoint" ? "checkpoint" : "data", guard);
  const manifest = kind === "checkpoint" ? await readCheckpointManifest(source) : undefined;
  const read = async (relative: string): Promise<string | undefined> => {
    if (manifest) {
      const entry = manifest.files.find((file) => file.path === relative);
      if (!entry || entry.absent) return undefined;
      await assertNoSymlinkUnder(source, relative);
      return readFile(path.join(source, relative), "utf8");
    }
    return optionalText(source, relative);
  };
  const itemsText = await read("items.jsonl");
  const items = parseJsonl<Item>("items.jsonl", itemsText);
  const stateText = await read("state.json");
  const state = stateText === undefined ? undefined : parseJson<RecordValue>("state.json", stateText);
  let clearedPinnedContext = 0;
  if (state && isRecord(state.sessions)) {
    for (const session of Object.values(state.sessions)) {
      if (!isRecord(session)) continue;
      for (const key of ["contextBlock", "contextHash", "contextVersion", "contextProjectKey"]) {
        if (key in session) {
          delete session[key];
          clearedPinnedContext += 1;
        }
      }
    }
  }
  const configText = await read("config.json");
  if (configText !== undefined) {
    if (containsSecret(parseJson<unknown>("config.json", configText))) {
      throw new MigrationError(6, "兼容导出源配置含凭证字段，拒绝导出");
    }
  }
  let archived = 0;
  let changeIDs = 0;
  let invalidated = 0;
  let derived = 0;
  let stopped = 0;
  const oldItems = items.map((item) => {
    if (item.changeID) changeIDs += 1;
    if (item.invalidatedBy) invalidated += 1;
    if ((item.derivedFrom?.length ?? 0) > 0) derived += 1;
    if (item.supersededBy === "deactivate" || item.supersededBy === "revert") stopped += 1;
    if (item.invalidatedBy || item.supersededBy === "deactivate" || item.supersededBy === "revert") {
      if (item.status !== "archived") archived += 1;
      return { ...item, status: "archived" as const };
    }
    return item;
  });
  const quarantineRows = parseJsonl<RecordValue>("extract-quarantine.jsonl", await read("extract-quarantine.jsonl"));
  const changes = parseJsonl<RecordValue>("changes.jsonl", await read("changes.jsonl"));
  const suppressions = parseJsonl<RecordValue>("suppressions.jsonl", await read("suppressions.jsonl"));
  const report: CompatLossReport = {
    sourceKind: kind,
    checkpointID: manifest?.id ?? "data",
    createdAt: new Date().toISOString(),
    clearedPinnedContext,
    warnings: [
      "兼容导出只恢复运行时可见文件，不包含 P01 事件/抑制/change-journal/隔离区。",
      "旧版没有 message-level retirement；已停止来源可能被旧路径重新学习。",
      "changeID 在旧版被忽略，再升级后撤销可能 not_found。",
      "invalidatedBy/derivedFrom/supersededBy 在旧版可能被忽略；本导出已把失效/停止行转 archived，但仍非无损。",
      "旧版不会保护停止使用无时限，90 天后可能清理 archived 行；本导出清除了 pinned context/cache 版本，不能保留迁移后编辑。",
      "scope/projectKey 历史与 migration baseline 不随旧版导出恢复。",
    ],
    counts: {
      items: items.length,
      archivedForCompat: archived,
      changeIDs,
      invalidatedBy: invalidated,
      derivedFrom: derived,
      stoppedRows: stopped,
      changesOmitted: changes.length,
      suppressionsOmitted: suppressions.length,
      quarantineOmitted: quarantineRows.length,
      sessionsContextCleared: clearedPinnedContext,
    },
  };
  const files = new Map<string, string>();
  const queue = await read("queue.json");
  if (queue !== undefined) files.set("queue.json", queue);
  if (state !== undefined) files.set("state.json", `${JSON.stringify(state, null, 2)}\n`);
  if (configText !== undefined) files.set("config.json", configText);
  files.set("items.jsonl", oldItems.length ? `${oldItems.map((item) => JSON.stringify(item)).join("\n")}\n` : "");
  files.set("downgrade-report.json", `${JSON.stringify(report, null, 2)}\n`);
  return { source, kind, report, files };
}

export async function compatPreview(
  sourceDir: string,
  kind: "checkpoint" | "data",
  guard: GuardOptions = {},
): Promise<CompatLossReport> {
  return (await buildCompat(sourceDir, kind, guard)).report;
}

export async function compatExport(
  sourceDir: string,
  target: string,
  kind: "checkpoint" | "data",
  confirmLosses: boolean,
  guard: GuardOptions = {},
): Promise<CompatLossReport> {
  const built = await buildCompat(sourceDir, kind, guard);
  if (!confirmLosses) return built.report;
  const destination = await guardTargetDirectory(target, guard);
  if (destination.resolved === built.source || destination.resolved.startsWith(`${built.source}${path.sep}`)) {
    throw new MigrationError(2, "target 不得位于导出源内");
  }
  await mkdir(destination.resolved, { recursive: true, mode: 0o700 });
  for (const [relative, text] of built.files) {
    await writeDurable(path.join(destination.resolved, relative), text);
  }
  return built.report;
}

export interface CheckpointGcPlan {
  fingerprint: string;
  keep: string[];
  delete: Array<{ id: string; bytes: number }>;
  protectedBy: Record<string, string>;
  digests: Record<string, string>;
}

interface GcJournalSummary {
  id: string;
  status: string;
  undone: boolean;
  pinned: boolean;
  createdAt: string;
  checkpointID: string;
  checkpointHash: string;
  changeIDs: string[];
  referencedChanges: string[];
}

async function gcJournals(dataDir: string): Promise<GcJournalSummary[]> {
  const rows: GcJournalSummary[] = [];
  if (!(await safeDirectory(dataDir, "migrations"))) return rows;
  const names = (await readdir(path.join(dataDir, "migrations"))).sort();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const text = await optionalText(dataDir, `migrations/${name}`);
    if (text === undefined) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new MigrationError(6, "迁移 journal 不可读，拒绝 GC"); }
    if (!isRecord(parsed) || typeof parsed.id !== "string") throw new MigrationError(6, "迁移 journal 形状不符，拒绝 GC");
    rows.push({
      id: parsed.id,
      status: typeof parsed.status === "string" ? parsed.status : "unknown",
      undone: parsed.undone === true || parsed.status === "undone",
      pinned: parsed.pinned === true,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      checkpointID: typeof parsed.checkpointID === "string" ? parsed.checkpointID : parsed.id,
      checkpointHash: typeof parsed.checkpointHash === "string" ? parsed.checkpointHash : "",
      changeIDs: Array.isArray(parsed.changeIDs) ? parsed.changeIDs.filter((value): value is string => typeof value === "string") : [],
      referencedChanges: Array.isArray(parsed.referencedChanges) ? parsed.referencedChanges.filter((value): value is string => typeof value === "string") : [],
    });
  }
  return rows;
}

async function gcCheckpoints(root: string): Promise<Array<{ id: string; bytes: number; digest: string; createdAt: string }>> {
  const entries = (await readdir(root)).filter((name) => /^migration_[A-Za-z0-9_]+$/u.test(name));
  const rows: Array<{ id: string; bytes: number; digest: string; createdAt: string }> = [];
  for (const name of entries) {
    const dir = path.join(root, name);
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new MigrationError(5, "checkpoint 根含非目录/链接");
    const manifest = await readCheckpointManifest(dir);
    if (manifest.id !== name) throw new MigrationError(5, "checkpoint id 与目录不符");
    let bytes = 0;
    const walk = async (current: string) => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) throw new MigrationError(5, "checkpoint 含符号链接");
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) bytes += (await stat(full)).size;
        else throw new MigrationError(5, "checkpoint 含特殊文件");
      }
    };
    await walk(dir);
    rows.push({
      id: name,
      bytes,
      digest: sha(canonicalText({ id: manifest.id, createdAt: manifest.createdAt, files: manifest.files })),
      createdAt: manifest.createdAt,
    });
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

export async function checkpointGcPlan(
  dataDir: string,
  checkpointRoot: string,
  retainDays = 90,
  guard: GuardOptions = {},
): Promise<CheckpointGcPlan> {
  const root = await guardExistingDirectory(checkpointRoot, "checkpoint", guard);
  const journals = await gcJournals(dataDir);
  const checkpoints = await gcCheckpoints(root);
  const keep = new Map<string, string>();
  const byCreated = [...checkpoints].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id));
  for (const entry of byCreated.slice(0, 3)) keep.set(entry.id, "recent-3");
  const windowStart = Date.now() - Math.max(1, retainDays) * DAY;
  for (const journal of journals) {
    if (journal.pinned) keep.set(journal.checkpointID, "pinned");
    if (!journal.undone) {
      if (journal.status === "applying" || journal.status === "undoing") keep.set(journal.checkpointID, "unfinished");
      const created = Date.parse(journal.createdAt);
      if (!Number.isFinite(created) || created >= windowStart) keep.set(journal.checkpointID, "rollback-window");
    }
  }
  const remove = checkpoints.filter((entry) => !keep.has(entry.id));
  const fingerprint = sha(canonicalText({
    toolVersion: TOOL_VERSION,
    journals: [...journals].sort((left, right) => left.id.localeCompare(right.id)),
    keep: [...keep.entries()].sort(([left], [right]) => left.localeCompare(right)),
    checkpoints: checkpoints.map((entry) => ({ id: entry.id, bytes: entry.bytes, digest: entry.digest })),
    delete: remove.map((entry) => entry.id),
  }));
  return {
    fingerprint,
    keep: [...keep.keys()].sort(),
    delete: remove.map((entry) => ({ id: entry.id, bytes: entry.bytes })).sort((left, right) => left.id.localeCompare(right.id)),
    protectedBy: Object.fromEntries([...keep.entries()].sort(([left], [right]) => left.localeCompare(right))),
    digests: Object.fromEntries(checkpoints.map((entry) => [entry.id, entry.digest])),
  };
}

export async function applyCheckpointGc(
  dataDir: string,
  checkpointRoot: string,
  confirm: string,
  retainDays = 90,
  guard: GuardOptions = {},
): Promise<CheckpointGcPlan> {
  if (await lstat(path.join(dataDir, ".pending-transaction.json")).then(() => true).catch(() => false)) {
    throw new MigrationError(6, "存在未恢复 WAL，拒绝 GC");
  }
  const store = new Store(dataDir);
  return store.transaction(async () => {
    const plan = await checkpointGcPlan(dataDir, checkpointRoot, retainDays, guard);
    if (plan.fingerprint !== confirm) throw new MigrationError(3, "GC fingerprint 不符");
    const root = await guardExistingDirectory(checkpointRoot, "checkpoint", guard);
    const current = await gcCheckpoints(root);
    const currentByID = new Map(current.map((entry) => [entry.id, entry]));
    for (const entry of plan.delete) {
      if (!/^migration_[A-Za-z0-9_]+$/u.test(entry.id)) throw new MigrationError(2, "GC 目标 id 非法");
      const now = currentByID.get(entry.id);
      if (!now || now.digest !== plan.digests[entry.id] || now.bytes !== entry.bytes) {
        throw new MigrationError(4, "GC checkpoint 内容在确认前变化");
      }
      await assertNoSymlinkUnder(root, entry.id);
      const info = await lstat(path.join(root, entry.id));
      if (info.isSymbolicLink() || !info.isDirectory()) throw new MigrationError(5, "GC 目标不再是目录");
      await rm(path.join(root, entry.id), { recursive: true, force: false });
    }
    return plan;
  });
}
