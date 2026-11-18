import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { itemContentVersion } from "../src/fingerprint.js";
import type { Item, QueueItem } from "../src/types.js";
import {
  applyCheckpointGc,
  applyMigration,
  checkpointGcPlan,
  compatExport,
  compatPreview,
  planMigration,
  restoreCheckpoint,
  undoMigration,
} from "../src/migration/core.js";
import {
  MigrationError,
  assertDisjoint,
  guardCheckpointRoot,
  guardExistingDirectory,
} from "../src/migration/guard.js";
import { runMigrateCli, runRollbackCli } from "../src/migration/cli.js";

const AT = "2026-01-01T00:00:00.000Z";

async function rejectsWithCode(run: () => Promise<unknown>, code: number): Promise<MigrationError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationError);
    const failure = error as MigrationError;
    expect(failure.code).toBe(code);
    return failure;
  }
  throw new Error(`expected MigrationError(${code})`);
}

async function tree(root: string, relative = ""): Promise<Record<string, string>> {
  const rows: Record<string, string> = {};
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return rows;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(rows, await tree(root, next));
    else if (entry.isFile()) {
      const data = await readFile(path.join(root, next));
      rows[next] = createHash("sha256").update(data).digest("hex");
    }
  }
  return rows;
}

interface Fixture {
  root: string;
  dataDir: string;
  checkpointRoot: string;
  cleanup: () => Promise<void>;
}

function item(over: Partial<Item> & Pick<Item, "id">): Item {
  return {
    title: over.id,
    text: `text for ${over.id}`,
    kind: "fact",
    scope: "global",
    status: "auto",
    source: { sessionID: "seed", messageID: "m1", role: "user" },
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

function queueRow(over: Partial<QueueItem> & Pick<QueueItem, "id" | "text">): QueueItem {
  return {
    title: over.id,
    kind: "fact",
    scope: "session",
    status: "queue",
    source: { sessionID: "s1", messageID: `m-${over.id}`, role: "user" },
    createdAt: AT,
    updatedAt: AT,
    reason: "seed",
    ...over,
  };
}

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openmem-migration-core-"));
  const dataDir = path.join(root, "data");
  await mkdir(dataDir);
  const store = new Store(dataDir);
  await store.init();

  const active = item({ id: "item_active", text: "duplicate text" });
  const invalidated = item({
    id: "item_inv",
    text: "invalidated text",
    invalidatedBy: "item_missing",
    changeID: "change_inv",
  });
  const stopped = item({
    id: "item_stopped",
    text: "stopped text",
    status: "archived",
    supersededBy: "deactivate",
  });
  await store.replaceItems([active, invalidated, stopped]);
  await store.appendChange({
    id: "change_inv",
    at: AT,
    kind: "invalidate",
    actor: "system",
    itemID: "item_inv",
    itemVersion: itemContentVersion(invalidated),
    after: invalidated,
    source: invalidated.source,
    reason: "seed",
    revertible: false,
  });
  await store.writeState({
    sessions: {
      s1: {
        lastMessageID: "m1",
        contextBlock: { version: 1, autoMemory: ["pinned"], autoRules: [], shadow: true },
        contextHash: "hash-1",
        contextVersion: "v1",
        contextProjectKey: "proj-1",
      },
    },
  });

  const queue: QueueItem[] = [
    queueRow({ id: "q_adopt", text: "adopt this descriptive fact" }),
    queueRow({ id: "q_rule", text: "always answer in Chinese", kind: "rule", scope: "global" }),
    queueRow({ id: "q_dup", text: "duplicate text", scope: "global" }),
    queueRow({ id: "q_long", text: "x".repeat(240) }),
  ];
  // Deliberately missing kind: the migration must report it, never adopt it.
  const invalid = { ...queueRow({ id: "q_invalid", text: "invalid row" }) } as Record<string, unknown>;
  delete invalid.kind;
  await writeFile(
    path.join(dataDir, "queue.json"),
    `${JSON.stringify([...queue, invalid], null, 2)}\n`,
    "utf8",
  );

  return {
    root,
    dataDir,
    checkpointRoot: path.join(root, "checkpoints"),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function businessRows(items: Item[]): Array<Record<string, unknown>> {
  return items
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      text: entry.text,
      kind: entry.kind,
      scope: entry.scope,
      projectKey: entry.projectKey ?? null,
      status: entry.status,
      source: entry.source,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

describe("migration core", () => {
  it("dry-run writes nothing and produces a deterministic fingerprint", async () => {
    const fixture = await setup();
    try {
      const dataBefore = await tree(fixture.dataDir);
      const first = await planMigration(fixture.dataDir);
      const second = await planMigration(fixture.dataDir);

      expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(await tree(fixture.dataDir)).toEqual(dataBefore);
      await expect(lstat(fixture.checkpointRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(first.blockedReasons).toEqual([]);
      expect(first.noop).toBe(false);

      expect(first.counts).toMatchObject({
        adopt_descriptive: 1,
        keep_protected: 1,
        skip_duplicate: 1,
        skip_invalid: 1,
        quarantine_uncertain: 1,
        baseline_active: 1,
        skip_invalidated_upstream: 1,
      });

      const cliExit = await runMigrateCli([
        "--data", fixture.dataDir,
        "--checkpoint", fixture.checkpointRoot,
        "--dry-run",
      ]);
      expect(cliExit).toBe(0);
      expect(await tree(fixture.dataDir)).toEqual(dataBefore);

      const queue = JSON.parse(await readFile(path.join(fixture.dataDir, "queue.json"), "utf8")) as QueueItem[];
      queue.push(queueRow({ id: "q_extra", text: "a new fact after dry-run" }));
      await writeFile(path.join(fixture.dataDir, "queue.json"), `${JSON.stringify(queue, null, 2)}\n`, "utf8");
      const changed = await planMigration(fixture.dataDir);
      expect(changed.fingerprint).not.toBe(first.fingerprint);
    } finally {
      await fixture.cleanup();
    }
  });

  it("apply writes journal + checkpoint, rejects double undo, and re-apply is business-idempotent", async () => {
    const fixture = await setup();
    try {
      const plan = await planMigration(fixture.dataDir);
      const before = {
        items: businessRows(await new Store(fixture.dataDir).listItems()),
        queue: await readFile(path.join(fixture.dataDir, "queue.json"), "utf8"),
        config: await readFile(path.join(fixture.dataDir, "config.json"), "utf8"),
      };

      const beforeWrongConfirm = await tree(fixture.dataDir);
      await rejectsWithCode(
        () => applyMigration(fixture.dataDir, fixture.checkpointRoot, plan, "0".repeat(64), {}),
        3,
      );
      expect(await tree(fixture.dataDir)).toEqual(beforeWrongConfirm);
      await expect(lstat(fixture.checkpointRoot)).rejects.toMatchObject({ code: "ENOENT" });

      const applied = await applyMigration(fixture.dataDir, fixture.checkpointRoot, plan, plan.fingerprint, {});
      expect(applied.id).toMatch(/^migration_[A-Za-z0-9_]+$/u);
      expect(applied.journal?.status).toBe("applied");
      expect(applied.checkpointDir).toBeDefined();
      expect(path.basename(applied.checkpointDir as string)).toBe(applied.id);
      expect(await readdir(applied.checkpointDir as string)).toContain("manifest.json");

      const journalFile = path.join(fixture.dataDir, "migrations", `${applied.id}.json`);
      const journal = JSON.parse(await readFile(journalFile, "utf8")) as Record<string, unknown>;
      expect(journal.status).toBe("applied");
      expect(journal.sourceFingerprint).toBe(plan.fingerprint);
      expect(journal.checkpointID).toBe(applied.id);

      const manifest = JSON.parse(
        await readFile(path.join(fixture.checkpointRoot, applied.id, "manifest.json"), "utf8"),
      ) as { id: string; sourceFingerprint: string; files: Array<{ path: string }> };
      expect(manifest.id).toBe(applied.id);
      expect(manifest.sourceFingerprint).toBe(plan.fingerprint);
      expect(manifest.files.map((file) => file.path)).toContain("items.jsonl");

      const store = new Store(fixture.dataDir);
      await store.init();
      const afterApply = await store.listItems();
      expect(afterApply.some((entry) => entry.id === "q_adopt")).toBe(true);
      expect(await store.listQueue()).not.toContainEqual(expect.objectContaining({ id: "q_adopt" }));
      expect(await store.listQueue()).toContainEqual(expect.objectContaining({ id: "q_rule" }));
      const baselineEvents = (await store.listChanges()).filter(
        (event) => event.itemID === "item_active" && event.reason.startsWith("baseline:"),
      );
      expect(baselineEvents).toHaveLength(1);
      expect((await store.listItems()).find((entry) => entry.id === "item_active")?.changeID)
        .toBe(baselineEvents[0].id);

      const undone = await undoMigration(fixture.dataDir, fixture.checkpointRoot, applied.id, {});
      expect(undone.status).toBe("undone");
      expect(undone.undone).toBe(true);
      await rejectsWithCode(
        () => undoMigration(fixture.dataDir, fixture.checkpointRoot, applied.id, {}),
        6,
      );
      const afterUndo = await new Store(fixture.dataDir).listItems();
      expect(businessRows(afterUndo)).toEqual(before.items);
      expect(await readFile(path.join(fixture.dataDir, "queue.json"), "utf8")).toBe(before.queue);
      expect(await readFile(path.join(fixture.dataDir, "config.json"), "utf8")).toBe(before.config);

      const secondPlan = await planMigration(fixture.dataDir);
      const reapplied = await applyMigration(
        fixture.dataDir,
        fixture.checkpointRoot,
        secondPlan,
        secondPlan.fingerprint,
        {},
      );
      expect(reapplied.journal?.afterDomains.business).toBe(applied.journal?.afterDomains.business);
      expect(reapplied.journal?.afterDomains.store).not.toBe(applied.journal?.afterDomains.store);
      expect(reapplied.journal?.changeIDs.length).toBe(applied.journal?.changeIDs.length);

      const finalStore = new Store(fixture.dataDir);
      const finalChanges = await finalStore.listChanges();
      const finalBaselines = finalChanges.filter(
        (event) => event.itemID === "item_active" && event.reason.startsWith("baseline:"),
      );
      expect(finalBaselines).toHaveLength(1);
      expect(new Set(finalChanges.map((event) => event.id)).size).toBe(finalChanges.length);
      expect(businessRows(await finalStore.listItems()).filter((row) => row.id !== "q_adopt"))
        .toEqual(before.items.filter((row) => row.id !== "q_adopt"));
    } finally {
      await fixture.cleanup();
    }
  });

  it("path guard rejects the real autopilot path, a checkpoint inside data, and unsafe targets", async () => {
    const fixture = await setup();
    try {
      const autopilot = path.join(os.homedir(), ".config", "opencode", "memory", "autopilot");
      const autopilotExists = await lstat(autopilot).then(() => true).catch(() => false);
      const forbidden = await rejectsWithCode(
        () => guardExistingDirectory(autopilot, "data"),
        2,
      );
      // A real path must hit the forbidden-subtree branch; an absent one is
      // still rejected, but only as ENOENT — assert which case ran.
      expect(forbidden.message).toContain(autopilotExists ? "禁区" : "路径不存在");
      expect(await runMigrateCli([
        "--data", autopilot,
        "--checkpoint", fixture.checkpointRoot,
        "--dry-run",
      ])).toBe(2);

      const missing = await rejectsWithCode(
        () => guardExistingDirectory(path.join(fixture.root, "missing-data-dir"), "data"),
        2,
      );
      expect(missing.message).toContain("路径不存在");

      const nested = path.join(fixture.dataDir, "checkpoints");
      await mkdir(nested);
      const resolved = await guardCheckpointRoot(nested);
      const guardedData = await guardExistingDirectory(fixture.dataDir, "data");
      await rejectsWithCode(async () => assertDisjoint(guardedData, resolved), 2);
      expect(await runMigrateCli([
        "--data", fixture.dataDir,
        "--checkpoint", nested,
        "--dry-run",
      ])).toBe(2);

      const plan = await planMigration(fixture.dataDir);
      const applied = await applyMigration(fixture.dataDir, fixture.checkpointRoot, plan, plan.fingerprint, {});
      const checkpoint = applied.checkpointDir as string;

      const nonEmpty = path.join(fixture.root, "non-empty");
      await mkdir(nonEmpty);
      await writeFile(path.join(nonEmpty, "keep.txt"), "keep", "utf8");
      await rejectsWithCode(() => restoreCheckpoint(checkpoint, nonEmpty, {}), 6);

      const insideCheckpoint = path.join(checkpoint, "restore");
      await rejectsWithCode(() => restoreCheckpoint(checkpoint, insideCheckpoint, {}), 2);
      await rejectsWithCode(() => restoreCheckpoint(checkpoint, fixture.root, {}), 6);
    } finally {
      await fixture.cleanup();
    }
  });

  it("restore writes a checkpoint into a new empty target only", async () => {
    const fixture = await setup();
    try {
      const plan = await planMigration(fixture.dataDir);
      const applied = await applyMigration(fixture.dataDir, fixture.checkpointRoot, plan, plan.fingerprint, {});
      const checkpoint = applied.checkpointDir as string;
      const target = path.join(fixture.root, "restored");

      const manifest = await restoreCheckpoint(checkpoint, target, {});
      expect(manifest.id).toBe(applied.id);

      for (const file of manifest.files) {
        if (file.absent) {
          await expect(readFile(path.join(target, file.path))).rejects.toMatchObject({ code: "ENOENT" });
          continue;
        }
        const restored = await readFile(path.join(target, file.path));
        expect(createHash("sha256").update(restored).digest("hex")).toBe(file.hash);
      }
      const restoredStore = new Store(target);
      expect(businessRows(await restoredStore.listItems())).toEqual(
        businessRows(await new Store(fixture.dataDir).listItems()).filter(
          (row) => row.id !== "q_adopt" && row.id !== "q_long",
        ),
      );
      await rejectsWithCode(() => restoreCheckpoint(checkpoint, target, {}), 6);
    } finally {
      await fixture.cleanup();
    }
  });

  it("compat export previews losses until confirm-losses and never mutates the source", async () => {
    const fixture = await setup();
    try {
      const plan = await planMigration(fixture.dataDir);
      const applied = await applyMigration(fixture.dataDir, fixture.checkpointRoot, plan, plan.fingerprint, {});
      const checkpoint = applied.checkpointDir as string;
      const sourceBefore = await tree(checkpoint);
      const target = path.join(fixture.root, "compat-out");

      const preview = await compatPreview(checkpoint, "checkpoint");
      expect(preview.sourceKind).toBe("checkpoint");
      expect(preview.checkpointID).toBe(applied.id);
      expect(preview.warnings.length).toBeGreaterThanOrEqual(5);
      expect(preview.clearedPinnedContext).toBe(4);
      expect(preview.counts).toMatchObject({
        items: 3,
        archivedForCompat: 1,
        changeIDs: 1,
        invalidatedBy: 1,
        stoppedRows: 1,
        sessionsContextCleared: 4,
      });
      await expect(readFile(path.join(target, "items.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const dry = await compatExport(checkpoint, target, "checkpoint", false);
      expect(dry.counts.items).toBe(3);
      await expect(readFile(path.join(target, "items.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const cliPreview = await runRollbackCli(["--checkpoint", checkpoint, "--compat-export"]);
      expect(cliPreview).toBe(0);
      await expect(readFile(path.join(target, "items.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const written = await compatExport(checkpoint, target, "checkpoint", true);
      expect(written.counts).toEqual(preview.counts);
      const report = JSON.parse(await readFile(path.join(target, "downgrade-report.json"), "utf8")) as {
        counts: Record<string, number>;
        warnings: string[];
      };
      expect(report.counts).toEqual(preview.counts);
      expect(report.warnings).toEqual(preview.warnings);

      const exported = (await readFile(path.join(target, "items.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Item);
      const invalidated = exported.find((entry) => entry.id === "item_inv");
      expect(invalidated?.status).toBe("archived");
      expect(invalidated?.invalidatedBy).toBe("item_missing");
      const stopped = exported.find((entry) => entry.id === "item_stopped");
      expect(stopped?.supersededBy).toBe("deactivate");
      expect(await tree(checkpoint)).toEqual(sourceBefore);

      const dataPreview = await compatPreview(fixture.dataDir, "data");
      expect(dataPreview.sourceKind).toBe("data");
      expect(dataPreview.checkpointID).toBe("data");
    } finally {
      await fixture.cleanup();
    }
  });

  it("checkpoint GC keeps the recent three and deletes only after fingerprint confirmation", async () => {
    const fixture = await setup();
    try {
      const store = new Store(fixture.dataDir);
      await store.init();
      for (let index = 0; index < 4; index += 1) {
        const plan = await planMigration(fixture.dataDir);
        const applied = await applyMigration(fixture.dataDir, fixture.checkpointRoot, plan, plan.fingerprint, {});
        expect(applied.id).not.toBe("");
        await undoMigration(fixture.dataDir, fixture.checkpointRoot, applied.id, {});
      }

      const dirsBefore = (await readdir(fixture.checkpointRoot)).filter((name) =>
        /^migration_[A-Za-z0-9_]+$/u.test(name));
      expect(dirsBefore).toHaveLength(4);
      const bytesBefore = (await tree(fixture.checkpointRoot));

      const gc = await checkpointGcPlan(fixture.dataDir, fixture.checkpointRoot, 90);
      expect(gc.keep).toHaveLength(3);
      expect(gc.delete).toHaveLength(1);
      expect(Object.values(gc.protectedBy)).toEqual(
        expect.arrayContaining(["recent-3", "recent-3", "recent-3"]),
      );

      await rejectsWithCode(
        () => applyCheckpointGc(fixture.dataDir, fixture.checkpointRoot, "0".repeat(64), 90),
        3,
      );
      expect((await readdir(fixture.checkpointRoot)).filter((name) =>
        /^migration_[A-Za-z0-9_]+$/u.test(name))).toHaveLength(4);

      const appliedGc = await applyCheckpointGc(fixture.dataDir, fixture.checkpointRoot, gc.fingerprint, 90);
      expect(appliedGc.delete.map((entry) => entry.id)).toEqual(gc.delete.map((entry) => entry.id));
      const dirsAfter = (await readdir(fixture.checkpointRoot)).filter((name) =>
        /^migration_[A-Za-z0-9_]+$/u.test(name));
      expect(dirsAfter.sort()).toEqual([...gc.keep].sort());
      expect(dirsAfter).not.toContain(gc.delete[0].id);
      const bytesAfter = await tree(fixture.checkpointRoot);
      for (const name of Object.keys(bytesAfter)) expect(bytesBefore[name]).toBeDefined();
      expect(Object.keys(bytesAfter).length).toBeLessThan(Object.keys(bytesBefore).length);

      for (const name of dirsAfter) {
        const manifest = JSON.parse(
          await readFile(path.join(fixture.checkpointRoot, name, "manifest.json"), "utf8"),
        ) as { id: string };
        expect(manifest.id).toBe(name);
      }

      const statusExit = await runMigrateCli([
        "--data", fixture.dataDir,
        "--checkpoint", fixture.checkpointRoot,
        "--status",
      ]);
      expect(statusExit).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });
}, 120_000);
