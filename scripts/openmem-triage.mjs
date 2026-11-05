#!/usr/bin/env node
/**
 * One-shot queue triage for OpenMem.
 *
 * Default is a dry run. Auto-selects only high-confidence noise:
 *   - System One already returned reject_duplicate
 *   - near-duplicate text clusters (Jaccard bigrams >= 0.9)
 *   - queue items from subagent sessions recorded in state.json
 *
 * Meta/task-discussion items are printed for a human decision, never denied
 * automatically. The console token is read from the data dir; no file is
 * mutated directly while the plugin is running.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const hit = argv.find((entry) => entry.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
};

const dataDir = path.resolve(
  value("--data", process.env.OPENMEM_DATA_DIR ??
    path.join(os.homedir(), ".config", "opencode", "memory", "autopilot")),
);
const port = Number(value("--port", process.env.OPENMEM_PORT ?? "47821"));
const apply = flag("--apply");
const explicitIds = (value("--ids", "") || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？；：、,.!?;:()[\]{}"'`]/g, "");
}

function bigrams(text) {
  const out = new Set();
  for (let index = 0; index < text.length - 1; index += 1) {
    out.add(text.slice(index, index + 2));
  }
  return out;
}

function similarity(left, right) {
  const a = bigrams(normalize(left));
  const b = bigrams(normalize(right));
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / Math.max(1, a.size + b.size - shared);
}

function looksMeta(item) {
  const text = `${item.title ?? ""} ${item.text ?? ""}`;
  return (
    /^(TASK|EXPECTED OUTCOME|REQUIRED TOOLS|MUST DO|MUST NOT DO|CONTEXT)\b/im.test(text) ||
    /(?:open-?mem|memory-autopilot|会话复盘|交叉核查)/i.test(text)
  );
}

async function main() {
  const token = (await readFile(path.join(dataDir, "console-token"), "utf8")).trim();
  const state = JSON.parse(
    await readFile(path.join(dataDir, "state.json"), "utf8").catch(() => '{"sessions":{}}'),
  );
  const parentSessions = new Set(
    Object.entries(state.sessions ?? {})
      .filter(([, session]) => session && session.parentSessionID)
      .map(([id]) => id),
  );

  const response = await fetch(`http://127.0.0.1:${port}/api/queue`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`GET /api/queue failed: HTTP ${response.status}`);
  const payload = await response.json();
  const queue = Array.isArray(payload.items) ? payload.items : [];

  const selected = new Map();
  for (const item of queue) {
    if (explicitIds.includes(item.id)) selected.set(item.id, "explicit --ids");
  }
  for (const item of queue) {
    if (item.decision?.mergeAction === "reject_duplicate") {
      selected.set(item.id, "System One reject_duplicate");
    }
    const sessionID = item.source?.sessionID;
    if (sessionID && parentSessions.has(sessionID)) {
      selected.set(item.id, "subagent session");
    }
  }

  // Greedy near-duplicate clusters: keep the highest priority / oldest item.
  const candidates = [...queue].sort(
    (left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0) ||
      String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")),
  );
  const kept = [];
  for (const item of candidates) {
    if (selected.has(item.id)) continue;
    const duplicate = kept.find(
      (other) =>
        other.scope === item.scope &&
        similarity(other.text ?? other.title, item.text ?? item.title) >= 0.9,
    );
    if (duplicate) {
      selected.set(item.id, `near-duplicate of ${duplicate.id}`);
    } else {
      kept.push(item);
    }
  }

  const rows = queue.filter((item) => selected.has(item.id));
  const meta = queue.filter(
    (item) => !selected.has(item.id) && item.origin === "session-review" && looksMeta(item),
  );
  const rest = queue.length - rows.length - meta.length;

  console.log(`data: ${dataDir}`);
  console.log(`mode: ${apply ? "APPLY" : "dry-run"}`);
  console.log(`queue: ${queue.length}  selected: ${rows.length}  meta(manual): ${meta.length}  other: ${rest}`);
  for (const item of rows) {
    console.log(
      `  DENY ${item.id}  [${item.origin ?? "turn"}/${item.kind}]  ${selected.get(item.id)}  ${item.title}`,
    );
  }
  if (meta.length > 0) {
    console.log("\nManual review (not denied automatically):");
    for (const item of meta) {
      console.log(`  ?    ${item.id}  ${item.title}`);
    }
  }
  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to deny the selected rows.");
    return;
  }
  if (rows.length === 0) {
    console.log("\nNothing to deny.");
    return;
  }

  const result = await fetch(`http://127.0.0.1:${port}/api/queue/batch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ids: rows.map((item) => item.id),
      decision: { action: "deny" },
    }),
  });
  const body = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(`POST /api/queue/batch failed: HTTP ${result.status}`);
  const failed = Array.isArray(body.results)
    ? body.results.filter((entry) => entry.ok === false)
    : [];
  console.log(`\nDenied ${rows.length - failed.length} item(s).`);
  for (const entry of failed) {
    console.log(`  failed ${entry.id}: ${entry.error ?? "unknown"}`);
  }
}

main().catch((error) => {
  console.error(`openmem-triage: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
