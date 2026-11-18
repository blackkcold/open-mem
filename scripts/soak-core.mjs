/**
 * Shared orchestrator for the full-auto-memory soak.
 *
 * The write lane is the real one: candidate capture, `runConsolidation` with
 * `HeuristicDecisionProvider`, the production admission/budget/shadow checks,
 * `revertChange`/`restoreVersion`, curator, lifecycle, retention, capacity and
 * the migration core. There is no local copy of consolidate/decision logic.
 *
 * Clock: production calls that accept `now` receive the simulated day.
 * `recordChange`/`Store.claim`/`consumeWriteBudget` read the system clock, so
 * only `soak.test.ts` controls them (`vi.setSystemTime`). `soak-30d.mjs` keeps
 * `fakeClock:false` and documents that those timestamps are wall-clock.
 */
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, mergeConfig } from "../plugin/src/config.ts";
import { Store, newId } from "../plugin/src/store.ts";
import {
  deactivateItem,
  newChangeID,
  reactivateItem,
  recordChange,
  restoreVersion,
  revertChange,
} from "../plugin/src/changes.ts";
import { itemContentVersion } from "../plugin/src/fingerprint.ts";
import { runCurator } from "../plugin/src/memory/curator.ts";
import { holdExtractQuarantine, isSourceRetired, runLifecycleMaintenance } from "../plugin/src/memory/lifecycle.ts";
import { applyRetention, previewRetention, reclaimForCapacity } from "../plugin/src/retention.ts";
import { admitAutoWrite, capacityStatus } from "../plugin/src/capacity.ts";
import { recallMemory } from "../plugin/src/recall.ts";
import { classifyRelation, isExactRelation } from "../plugin/src/relations.ts";
import { runConsolidation } from "../plugin/src/consolidate.ts";
import { HeuristicDecisionProvider } from "../plugin/src/decision.ts";
import { startServer } from "../plugin/src/server.ts";
import {
  applyCheckpointGc,
  applyMigration,
  checkpointGcPlan,
  planMigration,
  undoMigration,
} from "../plugin/src/migration/core.ts";

export const SOAK_FORMAT_VERSION = 2;
export const SOAK_TOOL_VERSION = "soak-core/2";
export const DAY = 86_400_000;
export const DEFAULT_START_AT = Date.UTC(2026, 0, 5, 8, 0, 0);

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_TMP = path.join(REPO_ROOT, "tmp");
const REPO_TMP_FAMILY = path.join(REPO_TMP, "full-auto-memory");
const SOAK_MARKER = /soak/iu;
const SOAK_TOKEN = "soak-local-token";

export const PRODUCTION_MODULES = Object.freeze([
  "plugin/src/store.ts:Store/transaction/consumeWriteBudget",
  "plugin/src/consolidate.ts:runConsolidation (capture + admission + shadow + queue)",
  "plugin/src/decision.ts:HeuristicDecisionProvider",
  "plugin/src/changes.ts:recordChange/deactivateItem/reactivateItem/revertChange/restoreVersion",
  "plugin/src/memory/curator.ts:runCurator",
  "plugin/src/memory/lifecycle.ts:runLifecycleMaintenance/holdExtractQuarantine/isSourceRetired",
  "plugin/src/retention.ts:previewRetention/applyRetention/reclaimForCapacity",
  "plugin/src/capacity.ts:capacityStatus/admitAutoWrite",
  "plugin/src/recall.ts:recallMemory",
  "plugin/src/relations.ts:classifyRelation/isExactRelation",
  "plugin/src/server.ts:GET /api/automation/status (effectiveMode)",
  "plugin/src/migration/core.ts:planMigration/applyMigration/undoMigration/checkpointGcPlan/applyCheckpointGc",
]);

export const SOAK_INVARIANTS = Object.freeze([
  { id: "I01", title: "无 rule/skill/safety 自动写入" },
  { id: "I02", title: "无重复 active（exact 去重后）" },
  { id: "I03", title: "每条 auto item 有 change 事件且可停止使用" },
  { id: "I04", title: "容量/日预算有界，95% freeze 生效，回收后恢复" },
  { id: "I05", title: "无跨 project/session 注入/召回泄漏" },
  { id: "I06", title: "隔离 TTL 到期清理" },
  { id: "I07", title: "撤销后同源不再重学，新纠正可学" },
  { id: "I08", title: "递归失效/环保护有界，恢复不激活无效上游" },
  { id: "I09", title: "保留策略不删 active 最新可逆事件，日志/副本有界" },
  { id: "I10", title: "无未处理异常/未捕获 rejection" },
  { id: "I11", title: "retention 保护与收缩，必要 tombstone 超限 blocked 而非误删" },
  { id: "I12", title: "模拟日重开 Store，无重复事件/半状态，init 恢复成功" },
  { id: "I13", title: "I1 裁决：上游 deactivate/restore 不自动复活下游，显式恢复才复活" },
  { id: "I14", title: "scope 隔离：project A 不进入 project B" },
  { id: "I15", title: "连续 5 次迁移/回滚后 checkpoint/backup 数量/字节有界且无嵌套" },
  { id: "I16", title: "无假自动：shadow 真实分支不写，effectiveMode 与写入一致，预算拒绝不冒充成功" },
]);

export const SOAK_TEXTS = Object.freeze({
  factA: "project project-A the port is 5000",
  factB: "project project-B the path is apps/web",
  factC: "project project-C the port is 7000",
  shadowFact: "project project-Z the port is 9000",
  correctionA: "project project-A the port is now 5001",
  rule: "以后回复一律使用中文格式",
  skill: "把这个流程做成 skill 保存为可复用步骤",
  sessionNote: "session scratch note",
});

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isSameOrAncestor(candidate, other) {
  return candidate === other || isInside(other, candidate);
}

async function canonicalForDelete(target) {
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  try {
    return path.join(await realpath(parent), path.basename(resolved));
  } catch {
    return resolved;
  }
}

/**
 * Deletion guard for simulated runs. It refuses `/`, home, the repo root, the
 * shared `tmp` roots, and any ancestor of them. A deletable path must sit at
 * least two levels below an allowed root and carry a "soak" marker, so a typo
 * can never remove `tmp/full-auto-memory` or the whole temp directory.
 */
export async function assertSafeSoakPath(target, label = "soak path") {
  const resolved = await canonicalForDelete(target);
  if (!resolved || resolved === path.parse(resolved).root) {
    throw new Error(`${label}: refusing to touch the filesystem root`);
  }
  if (!SOAK_MARKER.test(resolved)) {
    throw new Error(`${label}: refusing to delete a path without a soak marker: ${resolved}`);
  }
  const tempRoot = await realpath(os.tmpdir()).catch(() => path.resolve(os.tmpdir()));
  const forbidden = [
    path.parse(resolved).root,
    path.resolve(os.homedir()),
    REPO_ROOT,
    REPO_TMP,
    REPO_TMP_FAMILY,
    tempRoot,
    path.resolve(os.tmpdir()),
  ];
  for (const entry of forbidden) {
    if (isSameOrAncestor(resolved, entry)) {
      throw new Error(`${label}: refusing to delete ${resolved} (forbidden/ancestor: ${entry})`);
    }
  }
  const allowedRoot = [REPO_TMP, tempRoot].find((root) => isInside(resolved, root));
  if (!allowedRoot) {
    throw new Error(`${label}: refusing to delete ${resolved} outside the isolated tmp roots`);
  }
  const depth = path.relative(allowedRoot, resolved).split(path.sep).filter(Boolean).length;
  if (depth < 2) {
    throw new Error(`${label}: refusing to delete shallow path ${resolved}`);
  }
  try {
    const info = await lstat(resolved);
    if (info.isSymbolicLink()) throw new Error(`${label}: refusing to delete a symlink`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return resolved;
    throw error;
  }
  return resolved;
}

async function resetSafeDir(directory, label) {
  const resolved = await assertSafeSoakPath(directory, label);
  await rm(resolved, { recursive: true, force: true });
  await mkdir(resolved, { recursive: true });
  return resolved;
}

async function dirBytes(directory) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await dirBytes(full);
    else if (entry.isFile()) total += Buffer.byteLength(await readFile(full));
  }
  return total;
}

async function checkpointDirs(root) {
  let names;
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  return names.filter((name) => /^migration_[A-Za-z0-9_]+$/u.test(name)).sort();
}

function isActive(item) {
  return item.status === "auto" || item.status === "promoted";
}

function findDuplicateActive(items) {
  const active = items.filter((item) => isActive(item) && !item.invalidatedBy);
  for (let left = 0; left < active.length; left += 1) {
    for (let right = left + 1; right < active.length; right += 1) {
      const a = active[left];
      const b = active[right];
      if (a.scope !== b.scope || (a.projectKey ?? "") !== (b.projectKey ?? "") || a.kind !== b.kind) continue;
      if (isExactRelation(classifyRelation({ text: a.text, kind: a.kind }, { text: b.text, kind: b.kind }))) {
        return [a.id, b.id];
      }
    }
  }
  return undefined;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function createRecorder() {
  const invariants = new Map(SOAK_INVARIANTS.map((entry) => [
    entry.id,
    { ...entry, ok: true, evidence: {}, partial: false },
  ]));
  const failures = [];
  const fail = (id, detail) => {
    const entry = invariants.get(id);
    if (!entry) return;
    entry.ok = false;
    failures.push({ id, detail });
  };
  const markPartial = (id, note) => {
    const entry = invariants.get(id);
    if (entry) entry.partial = true;
    entry.evidence = { ...entry.evidence, partialNote: note };
  };
  const setEvidence = (id, evidence) => {
    const entry = invariants.get(id);
    if (!entry) return;
    entry.evidence = { ...entry.evidence, ...evidence };
  };
  return { invariants, failures, fail, markPartial, setEvidence };
}

function soakConfig() {
  return mergeConfig(DEFAULT_CONFIG, {
    shadow: false,
    autoMemory: true,
    automation: { enabled: true, mode: "autonomous", revision: 1 },
    caps: {
      autoMemory: 60,
      autoRules: 10,
      queue: 30,
      itemsTotal: 90,
      skillDrafts: 4,
      diskBytes: 4 * 1024 * 1024,
    },
  });
}

async function seedHistory(store, startAt) {
  const oldAt = iso(startAt - 120 * DAY);
  const archived = [];
  await store.transaction(async () => {
    for (let index = 0; index < 3; index += 1) {
      const row = {
        id: `item_seeded_archive_${index}`,
        title: `seeded archive ${index}`,
        text: `seeded archive row ${index}`,
        kind: "fact",
        scope: "global",
        status: "archived",
        source: { sessionID: "seed", messageID: `seed-${index}`, role: "user" },
        createdAt: oldAt,
        updatedAt: oldAt,
      };
      await store.appendItem(row);
      archived.push(row);
    }
    for (let index = 0; index < 60; index += 1) {
      const target = archived[index % archived.length];
      await store.appendChange({
        id: `change_seeded_${String(index).padStart(3, "0")}`,
        at: iso(startAt - (120 + index) * DAY),
        kind: "expire",
        actor: "curator",
        itemID: target.id,
        itemVersion: "seeded",
        after: target,
        source: { sessionID: "seed", messageID: `seed-${index}`, role: "user" },
        reason: "seeded old history",
        revertible: false,
      });
    }
    const sessionRow = {
      id: "item_session_scratch",
      title: "session scratch",
      text: SOAK_TEXTS.sessionNote,
      kind: "fact",
      scope: "session",
      status: "auto",
      source: { sessionID: "sess-session", messageID: "m-session", role: "user" },
      createdAt: oldAt,
      updatedAt: oldAt,
      changeID: newChangeID(),
    };
    await store.appendItem(sessionRow);
    await recordChange(store, {
      kind: "add",
      actor: "auto",
      itemID: sessionRow.id,
      item: sessionRow,
      source: sessionRow.source,
      origin: "turn",
      reason: "soak:session-scope",
    });
  });
  return archived.length;
}

async function seedDerivations(store, now) {
  const stamp = async (over) => {
    const row = {
      id: over.id,
      title: over.title,
      text: over.text,
      kind: "fact",
      scope: "global",
      status: "auto",
      source: { sessionID: over.sessionID, messageID: over.messageID, role: "user" },
      createdAt: iso(now),
      updatedAt: iso(now),
      changeID: newChangeID(),
      ...(over.derivedFrom ? { derivedFrom: over.derivedFrom } : {}),
    };
    await store.transaction(async () => {
      await store.appendItem(row);
      await recordChange(store, {
        kind: "add",
        actor: "auto",
        itemID: row.id,
        item: row,
        source: row.source,
        origin: "turn",
        reason: "soak:seed-derived",
      });
    });
    return row;
  };
  const parent = await stamp({
    id: "item_upstream_parent",
    title: "upstream",
    text: "upstream parent preference",
    sessionID: "derived",
    messageID: "d0",
  });
  const child = await stamp({
    id: "item_derived_child",
    title: "child",
    text: "derived child detail",
    sessionID: "derived",
    messageID: "d1",
    derivedFrom: [parent.id],
  });
  const cycleA = await stamp({
    id: "item_cycle_a",
    title: "cycle a",
    text: "cycle node alpha",
    sessionID: "derived",
    messageID: "d2",
    derivedFrom: ["item_cycle_b"],
  });
  const cycleB = await stamp({
    id: "item_cycle_b",
    title: "cycle b",
    text: "cycle node beta",
    sessionID: "derived",
    messageID: "d3",
    derivedFrom: [cycleA.id],
  });
  return { parent, child, cycleA, cycleB };
}

async function insertQuarantine(store, now, tag) {
  return store.transaction(() => holdExtractQuarantine(store, {
    text: `quarantine text ${tag}`,
    title: `quarantine ${tag}`,
    kind: "fact",
    scope: "global",
    source: { sessionID: `quarantine-${tag}`, messageID: `quarantine-${tag}`, role: "user" },
    reason: "soak-quarantine",
  }, now));
}

async function readEffectiveMode(store, config, dataDir) {
  const server = await startServer({
    store,
    config,
    token: SOAK_TOKEN,
    port: 0,
    consoleDir: path.join(dataDir, "no-console"),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/automation/status`, {
      headers: { authorization: `Bearer ${SOAK_TOKEN}` },
    });
    if (!response.ok) throw new Error(`automation status HTTP ${response.status}`);
    const body = await response.json();
    return typeof body.effectiveMode === "string" ? body.effectiveMode : "unknown";
  } finally {
    await server.close();
  }
}

function decisionProvider() {
  return new HeuristicDecisionProvider();
}

async function consolidateSession(store, config, decision, input) {
  const result = await runConsolidation(input.sessionID, {
    store,
    config,
    decision,
    readMessages: async () => [{ id: input.messageID, type: "user", text: input.text }],
    ...(input.projectKey ? { project: input.projectKey, projectKey: input.projectKey } : {}),
  });
  return result;
}

async function newItemsSince(store, beforeIDs) {
  return (await store.listItems()).filter((item) => !beforeIDs.has(item.id));
}

function idsOf(items) {
  return new Set(items.map((item) => item.id));
}

async function runInvariantProbes({
  store,
  config,
  now,
  recorder,
  dataDir,
  checkpointRoot,
  evidence,
}) {
  const items = await store.listItems();
  const changes = await store.listChanges();
  const eventByID = new Map(changes.map((event) => [event.id, event]));
  const hooks = await store.listHooks();
  const queue = await store.listQueue();

  // I01: rule/skill candidates went through the real heuristic + lane and never
  // became auto rows.
  const ruleHooks = hooks.filter((hook) => hook.decision?.kind === "rule");
  const skillHooks = hooks.filter((hook) => hook.decision?.kind === "skill");
  const autoRuleSkills = items.filter((item) => (item.kind === "rule" || item.kind === "skill") &&
    (item.status === "auto" || item.status === "promoted"));
  const queuedRuleSkills = queue.filter((entry) => entry.kind === "rule" || entry.kind === "skill");
  recorder.setEvidence("I01", {
    ruleCandidates: ruleHooks.length,
    skillCandidates: skillHooks.length,
    ruleLane: ruleHooks.map((hook) => hook.status).join(",") || "none",
    skillLane: skillHooks.map((hook) => hook.status).join(",") || "none",
    queuedRuleSkills: queuedRuleSkills.length,
    autoRuleSkills: autoRuleSkills.length,
    kindsWritten: [...evidence.generatedKinds],
  });
  if (ruleHooks.length === 0 || skillHooks.length === 0) {
    recorder.fail("I01", "rule/skill candidates were not classified by the real lane");
  }
  if (autoRuleSkills.length > 0) recorder.fail("I01", `auto rule/skill rows: ${autoRuleSkills.length}`);

  // I02: no exact duplicate active, and the real pre-write dedupe actually ran.
  const duplicate = findDuplicateActive(items);
  recorder.setEvidence("I02", {
    active: items.filter(isActive).length,
    duplicate: duplicate ?? null,
    duplicateAttempts: evidence.duplicateAttempts,
    duplicateSkips: evidence.duplicateSkips,
  });
  if (duplicate) recorder.fail("I02", `duplicate active: ${duplicate.join(",")}`);
  if (evidence.duplicateAttempts === 0 || evidence.duplicateSkips === 0) {
    recorder.fail("I02", "duplicate write path was not exercised");
  }

  // I03: every active row owns an event; stop/restore/revert/restoreVersion ran.
  const missing = items.filter((item) => isActive(item) &&
    (!item.changeID || eventByID.get(item.changeID)?.itemID !== item.id));
  recorder.setEvidence("I03", {
    active: items.filter(isActive).length,
    missing: missing.map((item) => item.id),
    stops: evidence.stops,
    restores: evidence.restores,
    reverts: evidence.reverts,
    restoreVersions: evidence.restoreVersions,
  });
  if (missing.length > 0) recorder.fail("I03", `active rows without owned event: ${missing.length}`);
  if (evidence.stops === 0 || evidence.restores === 0) recorder.fail("I03", "stop/restore path not exercised");
  if (evidence.reverts === 0 || evidence.restoreVersions === 0) {
    recorder.fail("I03", "revertChange/restoreVersion path not exercised");
  }

  // I05/I14: production recall is scope filtered.
  const recallA = await recallMemory(store, config, "project-A port", { projectKey: "project-A", now, limit: 20 });
  const recallB = await recallMemory(store, config, "project-B path", { projectKey: "project-B", now, limit: 20 });
  const leakedA = recallA.hits.filter((hit) => hit.text.includes("project-B") || hit.text.includes(SOAK_TEXTS.sessionNote));
  const leakedB = recallB.hits.filter((hit) => hit.text.includes("project-A") || hit.text.includes(SOAK_TEXTS.sessionNote));
  recorder.setEvidence("I05", {
    projectAHits: recallA.hits.length,
    projectBHits: recallB.hits.length,
    leaks: leakedA.length + leakedB.length,
    sessionScopedHits: [...recallA.hits, ...recallB.hits]
      .filter((hit) => hit.text.includes(SOAK_TEXTS.sessionNote)).length,
  });
  recorder.setEvidence("I14", {
    projectAHits: recallA.hits.length,
    projectBHits: recallB.hits.length,
    crossProjectLeaks: leakedA.length + leakedB.length,
  });
  if (leakedA.length + leakedB.length > 0) recorder.fail("I05", "recall leaked across scope");
  if (leakedA.length + leakedB.length > 0) recorder.fail("I14", "project recall leaked");

  // I06: TTL expiry (user transactions expire due rows too, so check the row).
  const quarantine = await store.listExtractQuarantine();
  const activeQuarantine = quarantine.filter((row) => Date.parse(row.expiresAt) > now);
  const staleGone = !quarantine.some((row) => row.text === "quarantine text stale");
  recorder.setEvidence("I06", {
    expired: evidence.quarantineExpired,
    staleGone,
    remaining: activeQuarantine.length,
  });
  if (evidence.quarantineExpired === 0 && !staleGone) recorder.fail("I06", "no quarantine row expired");
  if (activeQuarantine.length === 0) recorder.fail("I06", "fresh quarantine row was removed before TTL");

  // I07: the stopped source stays retired; a correction was accepted.
  recorder.setEvidence("I07", {
    stops: evidence.stops,
    restores: evidence.restores,
    blockedRelearn: evidence.blockedRelearn,
    correctionsQueued: evidence.correctionsQueued,
    suppressionKept: evidence.suppressionKept,
  });
  if (evidence.blockedRelearn === 0) recorder.fail("I07", "same source was not retired after stop");
  if (evidence.correctionsQueued === 0) recorder.fail("I07", "new correction was not accepted");

  // I13: I1 ruling.
  recorder.setEvidence("I13", evidence.i1);
  if (!evidence.i1.childInvalidatedAfterUpstreamStop) recorder.fail("I13", "downstream was not invalidated");
  if (!evidence.i1.childStillInvalidAfterUpstreamRestore) recorder.fail("I13", "downstream revived with upstream");
  if (!evidence.i1.childRestoredExplicitly) recorder.fail("I13", "explicit child restore failed");

  // I08: cycle protection terminated and wrote one bounded audit entry.
  const changelog = await store.listChangelog();
  const cycleEntries = changelog.filter((entry) => entry.action === "invalidate_cycle");
  recorder.setEvidence("I08", {
    cycleEntries: cycleEntries.length,
    invalidatedChild: evidence.i1.childInvalidatedAfterUpstreamStop,
  });
  if (cycleEntries.length === 0) recorder.fail("I08", "derived cycle was not reported by production invalidation");

  // I09/I11: retention protects live history and only shrinks cold rows.
  const preview = await previewRetention(store, now);
  const latestByItem = new Map();
  for (const event of changes) latestByItem.set(event.itemID, event);
  const activeLatest = new Set(items.filter(isActive).map((item) => latestByItem.get(item.id)?.id).filter(Boolean));
  const deleted = new Set(preview.deletedChanges);
  const deletedLatest = [...activeLatest].filter((id) => deleted.has(id));
  recorder.setEvidence("I09", {
    activeLatest: activeLatest.size,
    deletedLatest: deletedLatest.length,
    changelog: changelog.length,
    checkpointDirs: (await checkpointDirs(checkpointRoot)).length,
  });
  if (deletedLatest.length > 0) recorder.fail("I09", `retention deleted ${deletedLatest.length} active latest events`);
  if (changelog.length > 5000) recorder.fail("I09", "changelog grew without bound");

  const suppressionKept = (await store.listSuppressions()).some((row) => row.itemID === evidence.stoppedItemID);
  recorder.setEvidence("I11", {
    protectedChanges: preview.protectedChanges,
    protectedJournals: preview.protectedJournals,
    pruneChanges: preview.pruneChanges,
    reclaimedChanges: evidence.reclaimedChanges,
    blocked: preview.blocked,
    blockedReasons: preview.blockedReasons,
    stoppedSuppressionKept: suppressionKept,
  });
  if (preview.pruneChanges + evidence.reclaimedChanges === 0) {
    recorder.fail("I11", "cold history was not reclaimed");
  }
  if (!suppressionKept) recorder.fail("I11", "stopped source suppression was lost");

  // I11b: necessary tombstones over the cap block instead of being deleted.
  const probeDir = await assertSafeSoakPath(`${dataDir}-retention-probe`, "retention probe");
  const probe = new Store(probeDir);
  try {
    await resetSafeDir(probeDir, "retention probe");
    await probe.init();
    const until = iso(now + 365 * DAY);
    await probe.writeSuppressions(Array.from({ length: 2001 }, (_, index) => ({
      id: `sup_probe_${index}`,
      at: iso(now),
      hookKey: `turn|probe|m${index}|${index}`,
      textHash: `hash-${index}`,
      itemID: `probe_item_${index}`,
      reason: "deactivated",
      until,
    })));
    const blocked = await previewRetention(probe, now);
    if (!blocked.blocked || !blocked.blockedReasons.includes("suppression_tombstone_capacity")) {
      recorder.fail("I11", "2001 live tombstones did not block");
    }
    if (blocked.pruneSuppressions !== 0) recorder.fail("I11", "blocked tombstones were pruned");
    if (blocked.counts.suppressions !== 2001) recorder.fail("I11", "tombstone count was not reported");
    recorder.setEvidence("I11", {
      tombstoneCapBlocked: blocked.blocked,
      tombstoneBlockedReasons: blocked.blockedReasons,
      tombstonePruned: blocked.pruneSuppressions,
    });
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}

async function runBudgetProbe(dataDir, now, recorder, evidence) {
  const probeDir = await assertSafeSoakPath(`${dataDir}-budget-probe`, "budget probe");
  const probe = new Store(probeDir);
  try {
    await resetSafeDir(probeDir, "budget probe");
    await probe.init();
    const first = await probe.consumeWriteBudget({ sessionID: "budget-a", dailyWrites: 1, maxWritesPerSession: 1, now });
    const second = await probe.consumeWriteBudget({ sessionID: "budget-a", dailyWrites: 1, maxWritesPerSession: 1, now });
    const crossSession = await probe.consumeWriteBudget({ sessionID: "budget-b", dailyWrites: 1, maxWritesPerSession: 1, now });
    const perSessionFirst = await probe.consumeWriteBudget({ sessionID: "budget-c", dailyWrites: 10, maxWritesPerSession: 1, now });
    const perSessionSecond = await probe.consumeWriteBudget({ sessionID: "budget-c", dailyWrites: 10, maxWritesPerSession: 1, now });
    recorder.setEvidence("I04", {
      budgetFirst: first.ok,
      budgetSecondBlocked: !second.ok && second.reason === "write-budget",
      budgetCrossSessionBlocked: !crossSession.ok && crossSession.reason === "write-budget",
      budgetPerSessionFirst: perSessionFirst.ok,
      budgetPerSessionSecondBlocked: !perSessionSecond.ok && perSessionSecond.reason === "write-budget",
      soakBudgetCount: evidence.budgetCount,
    });
    if (!first.ok || second.ok || crossSession.ok) {
      recorder.fail("I04", "daily write budget did not bound automatic writes");
    }
    if (!perSessionFirst.ok || perSessionSecond.ok) {
      recorder.fail("I04", "per-session write budget did not bound automatic writes");
    }
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}

async function runMigrationCycles({ dataDir, checkpointRoot, now, recorder }) {
  const store = new Store(dataDir);
  await store.init();
  const created = [];
  for (let cycle = 0; cycle < 6; cycle += 1) {
    await store.upsertQueue({
      id: `queue_migration_${cycle}`,
      title: `migration candidate ${cycle}`,
      text: `migration candidate fact ${cycle}`,
      kind: "fact",
      scope: "session",
      status: "queue",
      source: { sessionID: `migration-${cycle}`, messageID: `migration-${cycle}-m`, role: "user" },
      createdAt: iso(now),
      updatedAt: iso(now),
      reason: "soak migration candidate",
    });
    const plan = await planMigration(dataDir);
    if (!plan.proposals.some((proposal) => proposal.category === "adopt_descriptive")) {
      recorder.fail("I15", `cycle ${cycle}: no adoptable proposal`);
      break;
    }
    const applied = await applyMigration(dataDir, checkpointRoot, plan, plan.fingerprint, {}, cycle === 0);
    if (!applied.id) {
      recorder.fail("I15", `cycle ${cycle}: migration was a no-op`);
      break;
    }
    created.push(applied.id);
    if (cycle === 0) {
      // Simulate `--pin-checkpoint` after the rollback window passed: age both
      // the journal and the manifest so the pinned backup is deterministically
      // outside the recent-3 window.
      const aged = iso(now - 200 * DAY);
      const journalFile = path.join(dataDir, "migrations", `${applied.id}.json`);
      const journal = JSON.parse(await readFile(journalFile, "utf8"));
      journal.createdAt = aged;
      journal.pinned = true;
      await writeFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
      const manifestFile = path.join(checkpointRoot, applied.id, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      manifest.createdAt = aged;
      await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
    await undoMigration(dataDir, checkpointRoot, applied.id, {});
  }

  // An unfinished (applying) rollback journal must keep its own backup even
  // when the checkpoint is outside the recent-3 window and the 90-day window.
  if (created[1]) {
    const aged = iso(now - 200 * DAY);
    const journalFile = path.join(dataDir, "migrations", `${created[1]}.json`);
    const journal = JSON.parse(await readFile(journalFile, "utf8"));
    journal.status = "applying";
    journal.undone = false;
    journal.createdAt = aged;
    await writeFile(journalFile, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    const manifestFile = path.join(checkpointRoot, created[1], "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.createdAt = aged;
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  const dirsBefore = await checkpointDirs(checkpointRoot);
  const bytesBefore = await dirBytes(checkpointRoot);
  const gc = await checkpointGcPlan(dataDir, checkpointRoot, 90, {});
  const appliedGc = await applyCheckpointGc(dataDir, checkpointRoot, gc.fingerprint, 90, {});
  const dirsAfter = await checkpointDirs(checkpointRoot);
  const bytesAfter = await dirBytes(checkpointRoot);

  let nesting = 0;
  const sizes = [];
  for (const name of dirsAfter) {
    sizes.push(await dirBytes(path.join(checkpointRoot, name)));
    const entries = await readdir(path.join(checkpointRoot, name));
    nesting += entries.filter((entry) => /^(checkpoint-|backup-)/u.test(entry)).length;
  }
  const pinned = created[0];
  const pinnedProtected = gc.protectedBy[pinned];
  const unfinished = created[1];
  const unfinishedProtected = gc.protectedBy[unfinished];
  const liveBytes = await dirBytes(dataDir);
  const maxSize = sizes.length ? Math.max(...sizes) : 0;
  const minSize = sizes.length ? Math.min(...sizes) : 0;

  recorder.setEvidence("I15", {
    created: created.length,
    dirsBefore: dirsBefore.length,
    kept: dirsAfter.length,
    deleted: appliedGc.delete.length,
    pinnedProtectedBy: pinnedProtected ?? null,
    unfinishedProtectedBy: unfinishedProtected ?? null,
    nesting,
    bytesBefore,
    bytesAfter,
    dataBytes: liveBytes,
    maxCheckpointBytes: maxSize,
    maxMinRatio: minSize > 0 ? Math.round((maxSize / minSize) * 1000) / 1000 : 0,
  });
  if (created.length < 6) recorder.fail("I15", `only ${created.length} migration cycles ran`);
  if (dirsAfter.length > 5) recorder.fail("I15", `checkpoint count not bounded: ${dirsAfter.length}`);
  if (nesting > 0) recorder.fail("I15", "checkpoint contained nested backup/checkpoint dirs");
  if (!dirsAfter.includes(pinned)) recorder.fail("I15", "pinned rollback checkpoint was deleted");
  if (!dirsAfter.includes(unfinished)) recorder.fail("I15", "unfinished rollback journal backup was deleted");
  if (pinnedProtected !== "pinned" && pinnedProtected !== "recent-3") {
    recorder.fail("I15", `pinned checkpoint was not protected: ${pinnedProtected ?? "none"}`);
  }
  if (unfinishedProtected !== "unfinished" && unfinishedProtected !== "recent-3") {
    recorder.fail("I15", `unfinished journal checkpoint was not protected: ${unfinishedProtected ?? "none"}`);
  }
  if (bytesAfter > bytesBefore) recorder.fail("I15", "checkpoint bytes grew during GC");
  if (bytesAfter > liveBytes * 4) recorder.fail("I15", "retained checkpoints exceed 4x live data");
  if (maxSize > 0 && maxSize / Math.max(1, minSize) > 3) {
    recorder.fail("I15", "checkpoint size grew geometrically");
  }

  const journals = (await readdir(path.join(dataDir, "migrations")))
    .filter((name) => name.endsWith(".json"));
  const journalRows = [];
  for (const name of journals) {
    journalRows.push(JSON.parse(await readFile(path.join(dataDir, "migrations", name), "utf8")));
  }
  recorder.setEvidence("I15", {
    journals: journalRows.length,
    undoneJournals: journalRows.filter((row) => row.status === "undone").length,
    applyingJournals: journalRows.filter((row) => row.status === "applying").length,
    adopted: journalRows.reduce((total, row) => total + (row.counts?.adopt_descriptive ?? 0), 0),
  });
  recorder.setEvidence("I09", { checkpointDirsAfterGc: dirsAfter.length, backupDirs: 0 });
  if (journalRows.some((row) => row.status === "applied")) recorder.fail("I15", "migration journal left applied");
}

/**
 * Run the simulated soak. Invariant failures are reported in the result; the
 * caller asserts them. Invalid or unsafe paths throw.
 */
export async function runSoak(options = {}) {
  const days = Math.max(1, Math.trunc(options.days ?? 3));
  const sessions = Math.max(1, Math.trunc(options.sessions ?? 5));
  const seed = Math.trunc(options.seed ?? 42);
  const startAt = options.startAt ?? DEFAULT_START_AT;
  const dataDirInput = options.dataDir;
  if (!dataDirInput) throw new Error("runSoak requires dataDir");
  const checkpointRootInput = options.checkpointRoot ?? `${dataDirInput}-checkpoints`;
  if (checkpointRootInput === dataDirInput ||
      path.resolve(checkpointRootInput).startsWith(`${path.resolve(dataDirInput)}${path.sep}`)) {
    throw new Error("checkpointRoot must live outside dataDir");
  }
  const config = options.config ?? soakConfig();
  const decision = decisionProvider();
  const recorder = createRecorder();
  const setNow = options.setNow;
  const errors = options.errors ?? [];
  const evidence = {
    generatedKinds: new Set(),
    consolidationCalls: 0,
    autoWrites: 0,
    shadowed: 0,
    queued: 0,
    skipped: 0,
    duplicateAttempts: 0,
    duplicateSkips: 0,
    stops: 0,
    restores: 0,
    reverts: 0,
    restoreVersions: 0,
    blockedRelearn: 0,
    correctionsQueued: 0,
    quarantineExpired: 0,
    reclaimedChanges: 0,
    stoppedItemID: "",
    suppressionKept: false,
    budgetCount: 0,
    modes: { shadow: "unknown", autonomous: "unknown" },
    shadow: { shadowed: 0, auto: 0, itemsBefore: 0, itemsAfter: 0, shadowBefore: 0, shadowAfter: 0 },
    i1: {
      childInvalidatedAfterUpstreamStop: false,
      childStillInvalidAfterUpstreamRestore: false,
      childRestoredExplicitly: false,
    },
  };
  const startedAt = new Date().toISOString();
  const capacitySamples = [];

  const dataDir = await resetSafeDir(dataDirInput, "soak data dir");
  const checkpointRoot = await resetSafeDir(checkpointRootInput, "soak checkpoint dir");
  let store = new Store(dataDir);
  await store.init();
  await store.writeConfig(config);
  await seedHistory(store, startAt);
  const derived = await seedDerivations(store, startAt);
  await insertQuarantine(store, startAt - 4 * DAY, "stale");

  // I13 setup: production invalidation/restore semantics.
  const parentStop = await deactivateItem(store, derived.parent.id, {
    expectedVersion: itemContentVersion(derived.parent),
  });
  const childAfterStop = (await store.listItems()).find((item) => item.id === derived.child.id);
  evidence.i1.childInvalidatedAfterUpstreamStop = parentStop.ok === true && Boolean(childAfterStop?.invalidatedBy);
  const parentStopped = (await store.listItems()).find((item) => item.id === derived.parent.id);
  const restoreUpstream = parentStopped
    ? await reactivateItem(store, derived.parent.id, { expectedVersion: itemContentVersion(parentStopped) })
    : { ok: false };
  const childAfterRestore = (await store.listItems()).find((item) => item.id === derived.child.id);
  evidence.i1.childStillInvalidAfterUpstreamRestore = restoreUpstream.ok === true &&
    Boolean(childAfterRestore?.invalidatedBy) &&
    childAfterRestore?.status !== "archived";
  const restoreChild = childAfterRestore
    ? await reactivateItem(store, derived.child.id, { expectedVersion: itemContentVersion(childAfterRestore) })
    : { ok: false };
  evidence.i1.childRestoredExplicitly = restoreChild.ok === true;
  const cycleStop = await deactivateItem(store, derived.cycleA.id, {
    expectedVersion: itemContentVersion(derived.cycleA),
  });
  if (!cycleStop.ok) recorder.fail("I08", "cycle deactivate failed");

  // I16 shadow: the real branch, and the real effectiveMode endpoint.
  const shadowConfig = mergeConfig(config, {
    shadow: true,
    automation: { enabled: true, mode: "shadow", revision: 2 },
  });
  await store.writeConfig(shadowConfig);
  evidence.modes.shadow = await readEffectiveMode(store, shadowConfig, dataDir);
  const shadowItemsBefore = await store.listItems();
  const shadowBefore = (await store.listShadow()).length;
  const shadowResult = await consolidateSession(store, shadowConfig, decision, {
    sessionID: "shadow-session",
    messageID: "shadow-message",
    text: SOAK_TEXTS.shadowFact,
    projectKey: "project-Z",
  });
  evidence.consolidationCalls += 1;
  evidence.shadowed += shadowResult.shadowed;
  const shadowItemsAfter = await store.listItems();
  const shadowAfter = (await store.listShadow()).length;
  evidence.shadow = {
    shadowed: shadowResult.shadowed,
    auto: shadowResult.auto,
    itemsBefore: shadowItemsBefore.length,
    itemsAfter: shadowItemsAfter.length,
    shadowBefore,
    shadowAfter,
  };
  if (shadowResult.auto !== 0 || shadowResult.shadowed === 0 ||
      shadowItemsBefore.length !== shadowItemsAfter.length || shadowAfter <= shadowBefore) {
    recorder.fail("I16", "real shadow branch did not shadow without writing");
  }
  await store.writeConfig(config);
  evidence.modes.autonomous = await readEffectiveMode(store, config, dataDir);
  if (evidence.modes.shadow !== "shadow" || evidence.modes.autonomous !== "autonomous") {
    recorder.fail("I16", "effectiveMode did not match the configured automation mode");
  }

  const perDay = Math.ceil(sessions / days);
  let sessionCursor = 0;
  let autoSeen = 0;

  for (let day = 0; day < days; day += 1) {
    const now = startAt + day * DAY;
    if (setNow) setNow(now);
    store = new Store(dataDir);
    try {
      await store.init();
    } catch (error) {
      recorder.fail("I12", `reopen failed on day ${day}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const ids = (await store.listItems()).map((item) => item.id);
    if (new Set(ids).size !== ids.length) recorder.fail("I12", `duplicate item ids on day ${day}`);
    const changeIDs = (await store.listChanges()).map((event) => event.id);
    if (new Set(changeIDs).size !== changeIDs.length) recorder.fail("I12", `duplicate change ids on day ${day}`);

    const dayEnd = Math.min(sessions, sessionCursor + perDay);
    for (let index = sessionCursor; index < dayEnd; index += 1) {
      const sessionID = `session-${index}`;
      const messageID = `message-${index}`;
      if (index === 0) {
        const beforeIDs = idsOf(await store.listItems());
        const run = await consolidateSession(store, config, decision, {
          sessionID,
          messageID,
          text: SOAK_TEXTS.factA,
          projectKey: "project-A",
        });
        evidence.consolidationCalls += 1;
        evidence.autoWrites += run.auto;
        autoSeen += run.auto;
        const created = await newItemsSince(store, beforeIDs);
        for (const item of created) evidence.generatedKinds.add(item.kind);
        if (run.auto > 0 && created[0]) {
          const addID = created[0].changeID;
          const revert = addID
            ? await revertChange(store, addID, { expectedVersion: itemContentVersion(created[0]) })
            : { ok: false };
          if (revert.ok) evidence.reverts += 1;
          const archived = (await store.listItems()).find((item) => item.id === created[0].id);
          if (revert.ok && archived && addID) {
            const restored = await restoreVersion(store, created[0].id, addID, {
              expectedVersion: itemContentVersion(archived),
            });
            if (restored.ok) evidence.restoreVersions += 1;
          }
        }
        const correction = await consolidateSession(store, config, decision, {
          sessionID: `${sessionID}-correction`,
          messageID: `${messageID}-correction`,
          text: SOAK_TEXTS.correctionA,
          projectKey: "project-A",
        });
        evidence.consolidationCalls += 1;
        evidence.queued += correction.queued;
        evidence.correctionsQueued += correction.queued;
      } else if (index === 1) {
        const beforeB = idsOf(await store.listItems());
        const runB = await consolidateSession(store, config, decision, {
          sessionID,
          messageID,
          text: SOAK_TEXTS.factB,
          projectKey: "project-B",
        });
        evidence.consolidationCalls += 1;
        evidence.autoWrites += runB.auto;
        autoSeen += runB.auto;
        const createdB = await newItemsSince(store, beforeB);
        for (const item of createdB) evidence.generatedKinds.add(item.kind);
        if (runB.auto > 0 && createdB[0]) {
          const current = createdB[0];
          const stop = await deactivateItem(store, current.id, { expectedVersion: itemContentVersion(current) });
          if (stop.ok) evidence.stops += 1;
          const relearnBlocked = await isSourceRetired(store, current.source.sessionID ?? "", current.source.messageID ?? "");
          if (relearnBlocked) evidence.blockedRelearn += 1;
          const stoppedRow = (await store.listItems()).find((item) => item.id === current.id);
          if (stoppedRow) {
            const restore = await reactivateItem(store, current.id, {
              expectedVersion: itemContentVersion(stoppedRow),
            });
            if (restore.ok) evidence.restores += 1;
          }
        }
        const beforeC = idsOf(await store.listItems());
        const runC = await consolidateSession(store, config, decision, {
          sessionID: `${sessionID}-c`,
          messageID: `${messageID}-c`,
          text: SOAK_TEXTS.factC,
          projectKey: "project-C",
        });
        evidence.consolidationCalls += 1;
        evidence.autoWrites += runC.auto;
        autoSeen += runC.auto;
        const createdC = await newItemsSince(store, beforeC);
        for (const item of createdC) evidence.generatedKinds.add(item.kind);
        if (runC.auto > 0 && createdC[0]) {
          const permanent = createdC[0];
          const stop = await deactivateItem(store, permanent.id, {
            expectedVersion: itemContentVersion(permanent),
          });
          if (stop.ok) evidence.stops += 1;
          const relearnBlocked = await isSourceRetired(store, permanent.source.sessionID ?? "", permanent.source.messageID ?? "");
          if (relearnBlocked) evidence.blockedRelearn += 1;
          evidence.stoppedItemID = permanent.id;
          evidence.suppressionKept = (await store.listSuppressions()).some((row) => row.itemID === permanent.id);
        }
      } else if (index === 2) {
        const beforeIDs = idsOf(await store.listItems());
        const duplicateRun = await consolidateSession(store, config, decision, {
          sessionID,
          messageID,
          text: SOAK_TEXTS.factA,
          projectKey: "project-A",
        });
        evidence.consolidationCalls += 1;
        evidence.duplicateAttempts += 1;
        evidence.duplicateSkips += duplicateRun.skipped;
        evidence.autoWrites += duplicateRun.auto;
        const created = await newItemsSince(store, beforeIDs);
        if (created.length > 0 || duplicateRun.auto > 0) {
          recorder.fail("I02", "exact duplicate was written instead of skipped");
        }
      } else if (index === 3) {
        const run = await consolidateSession(store, config, decision, {
          sessionID,
          messageID,
          text: SOAK_TEXTS.rule,
        });
        evidence.consolidationCalls += 1;
        evidence.autoWrites += run.auto;
        evidence.queued += run.queued;
        if (run.auto > 0) recorder.fail("I01", "rule candidate was auto-written");
      } else if (index === 4) {
        const run = await consolidateSession(store, config, decision, {
          sessionID,
          messageID,
          text: SOAK_TEXTS.skill,
        });
        evidence.consolidationCalls += 1;
        evidence.autoWrites += run.auto;
        if (run.auto > 0) recorder.fail("I01", "skill candidate was auto-written");
      } else {
        const beforeIDs = idsOf(await store.listItems());
        const duplicateRun = await consolidateSession(store, config, decision, {
          sessionID,
          messageID,
          text: index % 2 === 0 ? SOAK_TEXTS.factA : SOAK_TEXTS.factB,
          projectKey: index % 2 === 0 ? "project-A" : "project-B",
        });
        evidence.consolidationCalls += 1;
        evidence.duplicateAttempts += 1;
        evidence.duplicateSkips += duplicateRun.skipped;
        evidence.autoWrites += duplicateRun.auto;
        const created = await newItemsSince(store, beforeIDs);
        if (created.length > 0 || duplicateRun.auto > 0) {
          recorder.fail("I02", "exact duplicate was written instead of skipped");
        }
      }
    }
    sessionCursor = dayEnd;

    await runCurator(store, config, { now, force: true });
    const lifecycle = await runLifecycleMaintenance(store, (input) => recordChange(store, input), now);
    evidence.quarantineExpired += lifecycle.expiredQuarantine;

    if (day === 1) {
      const status = await capacityStatus(store, config);
      capacitySamples.push({ day, ratio: status.ratio, level: status.level, diskBytes: status.counts.diskBytes });
      const beforeItems = (await store.listItems()).length;
      const frozen = mergeConfig(config, {
        caps: { ...config.caps, diskBytes: Math.max(1, Math.ceil(status.counts.diskBytes / 0.97)) },
      });
      const frozenStatus = await capacityStatus(store, frozen);
      const gate = await store.transaction(() => admitAutoWrite(store, frozen, "fact"));
      const afterItems = (await store.listItems()).length;
      const preview = await previewRetention(store, now);
      const applied = await applyRetention(store, preview.id, true, now);
      evidence.reclaimedChanges += applied.pruneChanges;
      const afterBytes = (await capacityStatus(store, config)).counts.diskBytes;
      const recoveredCap = Math.max(1, Math.ceil(afterBytes / 0.7));
      const recovered = mergeConfig(config, { caps: { ...config.caps, diskBytes: recoveredCap } });
      const recoveredStatus = await capacityStatus(store, recovered);
      const recoveredGate = await admitAutoWrite(store, recovered, "fact");
      recorder.setEvidence("I04", {
        frozenRatio: frozenStatus.ratio,
        frozenLevel: frozenStatus.level,
        frozenBlockedReason: gate.ok ? null : gate.blockedReason ?? null,
        itemsBefore: beforeItems,
        itemsAfter: afterItems,
        pruneChanges: applied.pruneChanges,
        diskBefore: status.counts.diskBytes,
        diskAfter: afterBytes,
        recoveredRatio: recoveredStatus.ratio,
        recoveredLevel: recoveredStatus.level,
        recoveredAdmission: recoveredGate.ok,
      });
      if (frozenStatus.level !== "freeze" || gate.ok) recorder.fail("I04", "95% freeze did not stop the write");
      if (beforeItems !== afterItems) recorder.fail("I04", "frozen write changed items");
      if (applied.pruneChanges === 0) recorder.fail("I04", "retention reclaimed no cold history");
      if (afterBytes >= status.counts.diskBytes) recorder.fail("I04", "disk bytes did not shrink after retention");
      if (!recoveredGate.ok) recorder.fail("I04", "admission did not recover after reclaim");
    }

    const status = await capacityStatus(store, config);
    capacitySamples.push({ day, ratio: status.ratio, level: status.level, diskBytes: status.counts.diskBytes });
    if (status.ratio > 1.0001) recorder.fail("I04", `capacity ratio above 1: ${status.ratio}`);
    if (autoSeen > 0) evidence.budgetCount = (await store.readState()).automation?.writeBudget?.count ?? 0;
  }

  const lastNow = startAt + (days - 1) * DAY;
  if (setNow) setNow(lastNow);
  const freshInserted = await insertQuarantine(store, lastNow, "fresh");
  if (!freshInserted) recorder.fail("I06", "fresh quarantine row was rejected");

  await runCurator(store, config, { now: lastNow, force: true });
  await runInvariantProbes({ store, config, now: lastNow, recorder, dataDir, checkpointRoot, evidence });
  await runBudgetProbe(dataDir, lastNow, recorder, evidence);

  const firstReclaim = await reclaimForCapacity(store, lastNow);
  const secondReclaim = await reclaimForCapacity(store, lastNow);
  recorder.setEvidence("I16", {
    shadowAttempts: evidence.shadow.shadowed,
    shadowWrites: evidence.shadow.auto,
    shadowItemsDelta: evidence.shadow.itemsAfter - evidence.shadow.itemsBefore,
    shadowRecordsDelta: evidence.shadow.shadowAfter - evidence.shadow.shadowBefore,
    effectiveModeShadow: evidence.modes.shadow,
    effectiveModeAutonomous: evidence.modes.autonomous,
    admittedWrites: evidence.autoWrites,
    firstReclaim: firstReclaim.skipped ?? "ran",
    secondReclaim: secondReclaim.skipped ?? "ran",
    secondRetryAt: secondReclaim.retryAt ?? null,
  });
  if (evidence.shadow.auto !== 0 || evidence.shadow.itemsAfter !== evidence.shadow.itemsBefore) {
    recorder.fail("I16", "shadow wrote items");
  }
  if (evidence.autoWrites === 0) recorder.fail("I16", "autonomous mode produced no auto write");
  if (evidence.budgetCount === 0) recorder.fail("I16", "write path did not consume the daily write budget");
  if (!secondReclaim.skipped && secondReclaim.reclaimedBytes > 0) {
    recorder.fail("I16", "cooldown allowed a second full reclaim");
  }

  await runMigrationCycles({ dataDir, checkpointRoot, now: lastNow, recorder });

  recorder.setEvidence("I10", { captured: errors.length });
  if (errors.length > 0) recorder.fail("I10", errors.map((error) => String(error)).join(" | "));

  const pendingTransaction = (await readdir(dataDir)).includes(".pending-transaction.json");
  recorder.setEvidence("I12", {
    simulatedDays: days,
    reopenCount: days,
    pendingTransaction,
  });
  if (pendingTransaction) recorder.fail("I12", "WAL was left behind");

  const capacityMax = capacitySamples.reduce(
    (max, sample) => (sample.ratio > max.ratio ? sample : max),
    { ratio: 0, level: "ok", day: -1, diskBytes: 0 },
  );
  const finalPreview = await previewRetention(store, lastNow);

  return {
    simulated: true,
    fakeClock: Boolean(setNow),
    formatVersion: SOAK_FORMAT_VERSION,
    toolVersion: SOAK_TOOL_VERSION,
    seed,
    days,
    sessions,
    startedAt,
    finishedAt: new Date().toISOString(),
    productionModules: [...PRODUCTION_MODULES],
    invariants: [...recorder.invariants.values()],
    failures: recorder.failures,
    ok: recorder.failures.length === 0,
    modes: { ...evidence.modes },
    shadow: { ...evidence.shadow },
    budget: { consumedInSoak: evidence.budgetCount },
    totals: {
      consolidationCalls: evidence.consolidationCalls,
      writes: evidence.autoWrites,
      stops: evidence.stops,
      restores: evidence.restores,
      reverts: evidence.reverts,
      restoreVersions: evidence.restoreVersions,
      correctionsQueued: evidence.correctionsQueued,
      blockedRelearn: evidence.blockedRelearn,
      duplicateAttempts: evidence.duplicateAttempts,
      duplicateSkips: evidence.duplicateSkips,
      shadowed: evidence.shadowed,
    },
    retentionCounts: finalPreview.counts,
    capacityMax,
    capacitySamples,
    notes: [
      "模拟运行：未访问真实数据目录、模型或网络；decision 使用 HeuristicDecisionProvider。",
      "injectedNow: capacity/retention/lifecycle/curator 使用注入的模拟 now。",
      "wallClock: recordChange/Store.claim/consumeWriteBudget 的时间戳读取系统时钟；soak.test.ts 用 vi.setSystemTime，soak-30d.mjs 不伪造 Date，故 fakeClock:false。",
      "模型审查/提取/consolidate 的 SystemOne 路径未参与；本次使用生产 heuristic 决策。",
    ],
  };
}
