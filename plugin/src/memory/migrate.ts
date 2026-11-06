import { readFile } from "node:fs/promises";
import path from "node:path";
import type { QueueItem, Scope } from "../types.js";
import type { Store } from "../store.js";
import { newId } from "../store.js";
import { sha16 } from "../util/text.js";
import { queueItemSnapshotVersion } from "../fingerprint.js";
import { classifyScope } from "./scope.js";

export interface ScopeProposal {
  id: string;
  title: string;
  before: Scope;
  scope: Scope;
  projectKey?: string;
  reason: string;
  changed: boolean;
  /** Full queue-row version at preview time; apply refuses a changed row. */
  beforeVersion?: string;
}

export interface ScopeMigration {
  id: string;
  createdAt: string;
  backupPath: string;
  journalPath: string;
  proposals: ScopeProposal[];
  applied: number;
}

interface Journal {
  id: string;
  createdAt: string;
  before: Array<{ id: string; scope: Scope; projectKey?: string }>;
  after: Array<{ id: string; scope: Scope; projectKey?: string; version?: string }>;
  proposals: ScopeProposal[];
  undone?: boolean;
  undoneAt?: string;
}

export async function previewScopeMigration(
  store: Store,
): Promise<ScopeProposal[]> {
  const queue = await store.listQueue();
  return queue.map((item) => {
    const proposed = classifyScope(item.text, item.project);
    const projectKey =
      proposed === "project"
        ? (item.projectKey ??
          (item.project ? sha16(item.project) : undefined))
        : undefined;
    const scope: Scope =
      proposed === "project" && !projectKey ? "session" : proposed;
    const reason =
      scope === "session"
        ? "task-only / no durable signal"
        : scope === "project"
          ? "project evidence"
          : "explicit global or environment fact";
    return {
      id: item.id,
      title: item.title,
      before: item.scope,
      scope,
      projectKey,
      reason,
      changed:
        item.scope !== scope ||
        (scope === "project" && item.projectKey !== projectKey),
      beforeVersion: queueItemSnapshotVersion(item),
    };
  });
}

export async function applyScopeMigration(
  store: Store,
  proposals: ScopeProposal[],
): Promise<ScopeMigration | undefined> {
  const changed = proposals.filter((proposal) => proposal.changed);
  if (changed.length === 0) return undefined;

  const seen = new Set<string>();
  for (const proposal of changed) {
    if (!proposal.id || seen.has(proposal.id)) {
      throw new Error("invalid migration preview: duplicate or empty id");
    }
    if (
      proposal.scope !== "session" &&
      proposal.scope !== "project" &&
      proposal.scope !== "global"
    ) {
      throw new Error(`invalid migration preview scope: ${proposal.id}`);
    }
    if (proposal.scope === "project" && !proposal.projectKey) {
      throw new Error(`invalid migration preview project key: ${proposal.id}`);
    }
    if (!proposal.beforeVersion) {
      throw new Error(`invalid migration preview version: ${proposal.id}`);
    }
    seen.add(proposal.id);
  }

  const id = newId("scope");
  const createdAt = new Date().toISOString();
  const backupPath = path.join(store.dataDir, `queue.json.bak-${id}`);
  const journalPath = path.join(store.dataDir, "migrations", `${id}.json`);

  return store.transaction(async () => {
    const queue = await store.listQueue();
    const byID = new Map(queue.map((item) => [item.id, item]));
    for (const proposal of changed) {
      const item = byID.get(proposal.id);
      if (!item) throw new Error(`queue item missing since preview: ${proposal.id}`);
      if (queueItemSnapshotVersion(item) !== proposal.beforeVersion) {
        throw new Error(`queue item changed since preview: ${proposal.id}`);
      }
    }

    const before = changed.map((proposal) => {
      const item = byID.get(proposal.id);
      if (!item) throw new Error(`queue item missing since preview: ${proposal.id}`);
      return { id: item.id, scope: item.scope, projectKey: item.projectKey };
    });
    const after = changed.map((proposal) => ({
      id: proposal.id,
      scope: proposal.scope,
      projectKey: proposal.scope === "project" ? proposal.projectKey : undefined,
      version: undefined as string | undefined,
    }));
    const expectedVersions = new Map(
      changed.map((proposal) => [proposal.id, proposal.beforeVersion as string]),
    );

    // Backup, queue patch and journal share one redo-WAL transaction: a crash
    // leaves either the old queue with no journal, or the new queue with a
    // complete journal that undo can verify.
    const queueBeforePatch = await readFile(store.queuePath, "utf8");
    await store.writeTextAtomic(backupPath, queueBeforePatch);
    const next = await store.patchQueue(
      changed.map((proposal) => ({
        id: proposal.id,
        patch: {
          scope: proposal.scope,
          projectKey: proposal.scope === "project" ? proposal.projectKey : undefined,
        },
      })),
      expectedVersions,
    );
    const nextByID = new Map(next.map((entry) => [entry.id, entry]));
    for (const entry of after) {
      const current = nextByID.get(entry.id);
      if (current) entry.version = queueItemSnapshotVersion(current);
    }
    const journal: Journal = { id, createdAt, before, after, proposals: changed };
    await store.writeTextAtomic(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

    return {
      id,
      createdAt,
      backupPath,
      journalPath,
      proposals: changed,
      applied: changed.length,
    };
  });
}

export async function undoScopeMigration(
  store: Store,
  id: string,
): Promise<number> {
  if (!/^scope_[A-Za-z0-9_]+$/.test(id)) {
    throw new Error("invalid migration id");
  }
  const journalPath = path.join(store.dataDir, "migrations", `${id}.json`);
  return store.transaction(async () => {
    const raw = await readFile(journalPath, "utf8");
    const journal = JSON.parse(raw) as Journal;
    if (journal.undone) throw new Error("这次迁移已经撤销");
    if (!Array.isArray(journal.before)) throw new Error("invalid journal");
    if (!Array.isArray(journal.after)) {
      throw new Error("migration journal lacks after state; manual review required");
    }
    const queue = await store.listQueue();
    const byID = new Map(queue.map((entry) => [entry.id, entry]));
    const expectedVersions = new Map<string, string>();
    for (const entry of journal.after) {
      const current = byID.get(entry.id);
      if (!current) throw new Error(`queue item missing since migration: ${entry.id}`);
      if (!entry.version) {
        throw new Error("migration journal lacks after version; manual review required");
      }
      const currentVersion = queueItemSnapshotVersion(current);
      if (currentVersion !== entry.version) {
        throw new Error(`queue item changed since migration: ${entry.id}`);
      }
      expectedVersions.set(entry.id, currentVersion);
    }
    await store.patchQueue(
      journal.before.map((entry) => ({
        id: entry.id,
        patch: { scope: entry.scope, projectKey: entry.projectKey },
      })),
      expectedVersions,
    );
    // Mark the undo in the same transaction as the queue restore. A crash
    // cannot leave "queue restored but journal still says applied".
    await store.writeTextAtomic(
      journalPath,
      `${JSON.stringify(
        { ...journal, undone: true, undoneAt: new Date().toISOString() },
        null,
        2,
      )}\n`,
    );
    return journal.before.length;
  });
}

export function scopeMigrationSummary(
  proposals: ScopeProposal[],
): Record<string, number> {
  return proposals.reduce<Record<string, number>>(
    (counts, proposal) => {
      counts[proposal.scope] = (counts[proposal.scope] ?? 0) + 1;
      return counts;
    },
    {},
  );
}

export type { QueueItem };
