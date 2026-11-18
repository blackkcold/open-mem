#!/usr/bin/env node
/**
 * Simulated 30-day soak entry point.
 *
 * Every day/session calls the real production functions through
 * `scripts/soak-core.mjs`; nothing is faked except the clock and the input
 * data. The run never reads real memory/config and never calls a model. It
 * opens a loopback-only status probe (127.0.0.1, port 0, static token) and
 * never touches an external network.
 *
 * Usage:
 *   node scripts/soak-30d.mjs [--days 30] [--sessions 120] [--seed 42]
 *     [--data <isolated-dir>] [--checkpoints <dir>] [--report <file>]
 */
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSoak } from "./soak-core.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TMP_ROOT = path.join(REPO_ROOT, "tmp");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return fallback;
  return value;
}

function numberArg(name, fallback) {
  const raw = arg(name, undefined);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`invalid ${name}: ${raw}`);
    process.exit(2);
  }
  return Math.trunc(value);
}

function assertIsolated(target, label) {
  const resolved = path.resolve(target);
  const roots = [path.resolve(TMP_ROOT), path.resolve(os.tmpdir()), path.resolve(os.tmpdir()).replace(/^\/private/u, "")];
  const inside = roots.some((root) => {
    if (resolved === root) return false;
    const relative = path.relative(root, resolved);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  if (!inside) {
    console.error(`refusing ${label} outside the isolated tmp roots: ${resolved}`);
    process.exit(2);
  }
  return resolved;
}

const days = numberArg("--days", 30);
const sessions = numberArg("--sessions", 120);
const seed = numberArg("--seed", 42);
const dataDir = assertIsolated(
  arg("--data", path.join(TMP_ROOT, "full-auto-memory", "verification", "soak-30d", "data")),
  "data dir",
);
const checkpointRoot = assertIsolated(
  arg("--checkpoints", path.join(TMP_ROOT, "full-auto-memory", "verification", "soak-30d", "checkpoints")),
  "checkpoint dir",
);
const reportPath = assertIsolated(
  arg("--report", path.join(TMP_ROOT, "full-auto-memory", "verification", "soak-30d.json")),
  "report",
);

const errors = [];
const capture = (error) => errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
process.on("unhandledRejection", capture);
process.on("uncaughtException", capture);

let report;
try {
  report = await runSoak({ days, sessions, seed, dataDir, checkpointRoot, errors });
} catch (error) {
  process.off("unhandledRejection", capture);
  process.off("uncaughtException", capture);
  console.error(error instanceof Error ? `soak failed: ${error.message}` : String(error));
  process.exit(1);
}
process.off("unhandledRejection", capture);
process.off("uncaughtException", capture);

report.fakeClock = false;
report.clockNotes = [
  "injectedNow: capacity/retention/lifecycle/curator 等接受 now 的生产函数使用模拟时间。",
  "wallClock: recordChange/Store.claim/consumeWriteBudget 的时间戳读取真实系统时间；脚本不 monkeypatch Date，也不改写这些生产函数。",
];
report.unhandledErrors = errors;
report.simulated = true;
if (errors.length > 0) {
  report.ok = false;
  report.invariants = report.invariants.map((entry) =>
    entry.id === "I10" ? { ...entry, ok: false, evidence: { captured: errors.length } } : entry);
}

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

const failed = report.invariants.filter((entry) => !entry.ok);
console.log(`simulated:true days=${days} sessions=${sessions} seed=${seed} days/sessions are simulated`);
console.log(`invariants: ${report.invariants.length - failed.length}/${report.invariants.length} pass`);
for (const entry of failed) console.log(`FAIL ${entry.id} ${entry.title}`);
console.log(`report: ${reportPath}`);
process.exit(report.ok ? 0 : 1);
