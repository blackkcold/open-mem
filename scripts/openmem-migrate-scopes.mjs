#!/usr/bin/env node
/**
 * Scope migration for OpenMem queue items.
 * Default: preview. --apply requires an explicit confirmation flag and the
 * server writes queue.json.bak-* plus migrations/scope_*.json first.
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
const token = (await readFile(path.join(dataDir, "console-token"), "utf8")).trim();
const base = `http://127.0.0.1:${port}`;
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};

async function request(pathname, init) {
  const response = await fetch(`${base}${pathname}`, { headers, ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${pathname} HTTP ${response.status}: ${body.error ?? "failed"}`);
  }
  return body;
}

const undoID = value("--undo", "");

if (undoID) {
  const result = await request("/api/migrations/scopes/undo", {
    method: "POST",
    body: JSON.stringify({ id: undoID }),
  });
  console.log(`Restored ${result.restored ?? 0} item(s) from ${undoID}.`);
  process.exit(0);
}

const preview = await request("/api/migrations/scopes/preview");
const proposals = Array.isArray(preview.proposals) ? preview.proposals : [];
const previewID = typeof preview.previewID === "string" ? preview.previewID : "";
console.log(`data: ${dataDir}`);
console.log(`mode: ${flag("--apply") ? "APPLY" : "dry-run"}`);
console.log(`summary: ${JSON.stringify(preview.summary ?? {})}`);
for (const proposal of proposals) {
  console.log(
    `  ${proposal.changed ? "CHANGE" : "keep  "} ${proposal.id}  ${proposal.before} -> ${proposal.scope}  ${proposal.reason}  ${proposal.title}`,
  );
}

if (!flag("--apply")) {
  console.log("\nDry run only. Re-run with --apply to write the migration.");
  process.exit(0);
}
if (!previewID) {
  console.log("\nNo changes to apply.");
  process.exit(0);
}

const applied = await request("/api/migrations/scopes/apply", {
  method: "POST",
  body: JSON.stringify({ confirmedByUser: true, previewID }),
});
if (!applied.id) {
  console.log("\nNo changes to apply.");
  process.exit(0);
}
console.log(`\nApplied ${applied.applied} change(s).`);
console.log(`journal: ${applied.journalPath}`);
console.log(`backup:  ${applied.backupPath}`);
console.log(`undo:    node scripts/openmem-migrate-scopes.mjs --undo=${applied.id}`);
