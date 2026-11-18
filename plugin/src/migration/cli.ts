import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  applyCheckpointGc,
  applyMigration,
  checkpointGcPlan,
  compatExport,
  compatPreview,
  planMigration,
  restoreCheckpoint,
  undoMigration,
  type MigrationPlan,
} from "./core.js";
import {
  MigrationError,
  assertDisjoint,
  guardCheckpointRoot,
  guardExistingDirectory,
  guardTargetDirectory,
  type GuardOptions,
} from "./guard.js";

interface ParsedArgs {
  values: Map<string, string>;
  flags: Set<string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const takeValue = (index: number, name: string): number => {
    const entry = argv[index];
    const inline = entry.startsWith(`${name}=`) ? entry.slice(name.length + 1) : undefined;
    if (inline !== undefined) { values.set(name, inline); return index; }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new MigrationError(2, `${name} 缺少参数`);
    values.set(name, next);
    return index + 1;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) throw new MigrationError(2, `未知参数：${entry}`);
    const name = entry.includes("=") ? entry.slice(0, entry.indexOf("=")) : entry;
    if (["--data", "--checkpoint", "--confirm", "--undo", "--target", "--allow-dir"].includes(name)) {
      index = takeValue(index, name);
    } else if (["--dry-run", "--apply", "--status", "--restore", "--compat-export",
      "--confirm-losses", "--repair-dangling-change", "--checkpoint-gc-preview", "--checkpoint-gc", "--pin-checkpoint"].includes(name)) {
      flags.add(name);
    } else {
      throw new MigrationError(2, `未知参数：${name}`);
    }
  }
  return { values, flags };
}

function oneOf(flags: Set<string>, names: string[]): string | undefined {
  const hits = names.filter((name) => flags.has(name));
  if (hits.length > 1) throw new MigrationError(2, "模式参数互斥");
  return hits[0];
}

function guardOptions(values: Map<string, string>): GuardOptions {
  const allow = values.get("--allow-dir");
  return allow ? { allowDirs: [allow] } : {};
}

function requireData(values: Map<string, string>): string {
  const value = values.get("--data");
  if (!value) throw new MigrationError(2, "必须显式提供 --data");
  return value;
}

function requireCheckpoint(values: Map<string, string>): string {
  const value = values.get("--checkpoint");
  if (!value) throw new MigrationError(2, "必须显式提供 --checkpoint");
  return value;
}

function summary(plan: MigrationPlan): void {
  console.log(`fingerprint: ${plan.fingerprint}`);
  const categories = Object.entries(plan.counts).sort(([left], [right]) => left.localeCompare(right));
  for (const [category, count] of categories) console.log(`${category}: ${count}`);
  if (plan.blockedReasons.length > 0) console.log(`blocked: ${plan.blockedReasons.join(",")}`);
  for (const proposal of plan.proposals) console.log(`${proposal.id} ${proposal.category}`);
}

async function status(dataDir: string): Promise<number> {
  const directory = path.join(dataDir, "migrations");
  let names: string[] = [];
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new MigrationError(5, "migrations 目录非普通目录");
    names = (await readdir(directory)).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.log("migrations: 0");
      return 0;
    }
    throw error;
  }
  const allowedStatus = new Set(["applied", "undone", "applying", "undoing", "unknown"]);
  let count = 0;
  let invalid = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!/^migration_[A-Za-z0-9_]+$/u.test(id)) { invalid += 1; continue; }
    try {
      const file = path.join(directory, name);
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile()) { invalid += 1; continue; }
      const text = await readFile(file, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") { invalid += 1; continue; }
      const row = parsed as Record<string, unknown>;
      const rawStatus = typeof row.status === "string" ? row.status : "unknown";
      const statusValue = allowedStatus.has(rawStatus) ? rawStatus : "unknown";
      const counts = row.counts && typeof row.counts === "object" ? row.counts as Record<string, unknown> : {};
      const baseline = typeof counts.baseline_active === "number" ? counts.baseline_active : 0;
      const adopted = typeof counts.adopt_descriptive === "number" ? counts.adopt_descriptive : 0;
      count += 1;
      console.log(`${id} ${statusValue} baseline=${baseline} adopted=${adopted}`);
    } catch {
      invalid += 1;
    }
  }
  console.log(`migrations: ${count} invalid: ${invalid}`);
  return 0;
}

export async function runMigrateCli(argv: string[]): Promise<number> {
  try {
    const { values, flags } = parseArgs(argv);
    if (flags.has("--restore") || flags.has("--compat-export") || flags.has("--confirm-losses")) {
      throw new MigrationError(2, "该模式属于 rollback 工具");
    }
    const mode = oneOf(flags, ["--dry-run", "--apply", "--status", "--checkpoint-gc-preview", "--checkpoint-gc"]);
    const undoID = values.get("--undo");
    if (mode === "--status") {
      const dataDir = await guardExistingDirectory(requireData(values), "data", guardOptions(values));
      return status(dataDir);
    }
    if (undoID) {
      if (mode) throw new MigrationError(2, "--undo 不能与其他模式同时使用");
      if (!/^migration_[A-Za-z0-9_]+$/u.test(undoID)) throw new MigrationError(2, "迁移 id 非法");
      const dataDir = await guardExistingDirectory(requireData(values), "data", guardOptions(values));
      const checkpointRoot = await guardCheckpointRoot(requireCheckpoint(values), guardOptions(values));
      await assertDisjoint(dataDir, checkpointRoot);
      const journal = await undoMigration(dataDir, checkpointRoot, undoID, guardOptions(values));
      console.log(`undone: ${journal.id}`);
      return 0;
    }
    if (mode === "--checkpoint-gc-preview") {
      const dataDir = await guardExistingDirectory(requireData(values), "data", guardOptions(values));
      const checkpointRoot = await guardCheckpointRoot(requireCheckpoint(values), guardOptions(values));
      await assertDisjoint(dataDir, checkpointRoot);
      const plan = await checkpointGcPlan(dataDir, checkpointRoot, 90, guardOptions(values));
      console.log(`gc-fingerprint: ${plan.fingerprint}`);
      console.log(`keep: ${plan.keep.length} delete: ${plan.delete.length}`);
      for (const entry of plan.delete) console.log(`${entry.id} ${entry.bytes}`);
      return 0;
    }
    if (mode === "--checkpoint-gc") {
      const dataDir = await guardExistingDirectory(requireData(values), "data", guardOptions(values));
      const checkpointRoot = await guardCheckpointRoot(requireCheckpoint(values), guardOptions(values));
      await assertDisjoint(dataDir, checkpointRoot);
      const confirm = values.get("--confirm");
      if (!confirm) throw new MigrationError(3, "GC 需要 --confirm <fingerprint>");
      const plan = await applyCheckpointGc(dataDir, checkpointRoot, confirm, 90, guardOptions(values));
      console.log(`gc-deleted: ${plan.delete.length}`);
      return 0;
    }
    const dataDir = await guardExistingDirectory(requireData(values), "data", guardOptions(values));
    const checkpointRoot = await guardCheckpointRoot(requireCheckpoint(values), guardOptions(values));
    await assertDisjoint(dataDir, checkpointRoot);
    if (values.has("--confirm") && mode !== "--apply") {
      throw new MigrationError(2, "--confirm 只用于 --apply/--checkpoint-gc");
    }
    const plan = await planMigration(dataDir, { repairDanglingChange: flags.has("--repair-dangling-change") });
    summary(plan);
    if (mode !== "--apply") return plan.blockedReasons.length > 0 ? 6 : 0;
    const confirm = values.get("--confirm");
    if (!confirm) throw new MigrationError(3, "apply 需要 --confirm <fingerprint>");
    if (plan.fingerprint !== confirm) throw new MigrationError(3, "fingerprint 不符，零写入");
    if (plan.blockedReasons.length > 0) throw new MigrationError(6, `迁移被阻断：${plan.blockedReasons.join(",")}`);
    if (plan.noop) {
      console.log("no-op: 0");
      return 0;
    }
    const applied = await applyMigration(dataDir, checkpointRoot, plan, confirm, guardOptions(values), flags.has("--pin-checkpoint"));
    if (!applied.journal) {
      console.log("no-op: 0");
      return 0;
    }
    console.log(`applied: ${applied.id}`);
    console.log(`checkpoint: ${applied.journal.checkpointID}`);
    console.log(`baseline: ${applied.journal.changeIDs.length}`);
    return 0;
  } catch (error) {
    if (error instanceof MigrationError) {
      console.error(`error(${error.code}): ${error.message}`);
      return error.code;
    }
    console.error("error(5): 内部校验失败");
    return 5;
  }
}

export async function runRollbackCli(argv: string[]): Promise<number> {
  try {
    const { values, flags } = parseArgs(argv);
    if (flags.has("--apply") || flags.has("--dry-run") || flags.has("--status") ||
        flags.has("--checkpoint-gc") || flags.has("--checkpoint-gc-preview")) {
      throw new MigrationError(2, "该模式属于 migrate 工具");
    }
    const checkpoint = values.get("--checkpoint");
    const data = values.get("--data");
    if (checkpoint && data) throw new MigrationError(2, "--checkpoint 与 --data 互斥");
    if (!checkpoint && !data) throw new MigrationError(2, "必须提供 --checkpoint 或 --data");
    const mode = oneOf(flags, ["--restore", "--compat-export"]);
    if (!mode) throw new MigrationError(2, "必须选择 --restore 或 --compat-export");
    if (mode === "--restore" && !checkpoint) throw new MigrationError(2, "--restore 只能使用 --checkpoint");
    const options = guardOptions(values);
    const kind = checkpoint ? "checkpoint" : "data";
    const source = await guardExistingDirectory(checkpoint ?? data as string, kind, options);
    if (mode === "--compat-export" && !flags.has("--confirm-losses")) {
      const report = await compatPreview(source, kind, options);
      console.log(`compat-preview: ${report.sourceKind} items=${report.counts.items ?? 0}`);
      for (const warning of report.warnings) console.log(`loss: ${warning}`);
      return 0;
    }
    const target = values.get("--target");
    if (!target) throw new MigrationError(2, "必须显式提供 --target");
    const destination = await guardTargetDirectory(target, options);
    if (source === destination.resolved || destination.resolved.startsWith(`${source}${path.sep}`)) {
      throw new MigrationError(2, "target 不得位于导出/恢复源内");
    }
    if (mode === "--restore") {
      const manifest = await restoreCheckpoint(source, destination.resolved, options);
      console.log(`restored: ${manifest.id} files=${manifest.files.filter((file) => !file.absent).length}`);
      return 0;
    }
    const report = await compatExport(source, destination.resolved, kind, true, options);
    console.log(`compat-export: ${report.sourceKind} items=${report.counts.items ?? 0} clearedContext=${report.clearedPinnedContext}`);
    for (const warning of report.warnings) console.log(`loss: ${warning}`);
    return 0;
  } catch (error) {
    if (error instanceof MigrationError) {
      console.error(`error(${error.code}): ${error.message}`);
      return error.code;
    }
    console.error("error(5): 内部校验失败");
    return 5;
  }
}
