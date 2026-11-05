import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { QueueItem, Scope } from "../types.js";
import type { Store } from "../store.js";
import { newId } from "../store.js";
import { sha16 } from "../util/text.js";
import { classifyScope } from "./scope.js";

export interface ScopeProposal {
  id: string;
  title: string;
  before: Scope;
  scope: Scope;
  projectKey?: string;
  reason: string;
  changed: boolean;
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
  proposals: ScopeProposal[];
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
    };
  });
}

export async function applyScopeMigration(
  store: Store,
): Promise<ScopeMigration | undefined> {
  const proposals = await previewScopeMigration(store);
  const changed = proposals.filter((proposal) => proposal.changed);
  if (changed.length === 0) return undefined;

  const id = newId("scope");
  const createdAt = new Date().toISOString();
  const queue = await store.listQueue();
  const byID = new Map(queue.map((item) => [item.id, item]));
  const before = changed.flatMap((proposal) => {
    const item = byID.get(proposal.id);
    return item
      ? [{ id: item.id, scope: item.scope, projectKey: item.projectKey }]
      : [];
  });

  const backupPath = path.join(store.dataDir, `queue.json.bak-${id}`);
  const migrationsDir = path.join(store.dataDir, "migrations");
  const journalPath = path.join(migrationsDir, `${id}.json`);
  await copyFile(store.queuePath, backupPath);
  await mkdir(migrationsDir, { recursive: true });
  const journal: Journal = { id, createdAt, before, proposals: changed };
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

  await store.patchQueue(
    changed.map((proposal) => ({
      id: proposal.id,
      patch: {
        scope: proposal.scope,
        projectKey: proposal.scope === "project" ? proposal.projectKey : undefined,
      },
    })),
  );

  return {
    id,
    createdAt,
    backupPath,
    journalPath,
    proposals,
    applied: changed.length,
  };
}

export async function undoScopeMigration(
  store: Store,
  id: string,
): Promise<number> {
  if (!/^scope_[A-Za-z0-9_]+$/.test(id)) {
    throw new Error("invalid migration id");
  }
  const journalPath = path.join(store.dataDir, "migrations", `${id}.json`);
  const raw = await readFile(journalPath, "utf8");
  const journal = JSON.parse(raw) as Journal;
  if (!Array.isArray(journal.before)) throw new Error("invalid journal");
  await store.patchQueue(
    journal.before.map((entry) => ({
      id: entry.id,
      patch: { scope: entry.scope, projectKey: entry.projectKey },
    })),
  );
  return journal.before.length;
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
