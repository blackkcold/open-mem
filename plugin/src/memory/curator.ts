import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AutoMemConfig, Item } from "../types.js";
import type { Store } from "../store.js";
import { newId } from "../store.js";
import { classifyRelation, isExactRelation } from "../relations.js";
import { rebuildAutoFiles } from "../rebuild.js";

const DAY = 24 * 60 * 60 * 1000;

export interface CuratorResult {
  due: boolean;
  expired: number;
  merged: number;
  id?: string;
  backupPath?: string;
  journalPath?: string;
}

interface BeforeItem {
  id: string;
  status: Item["status"];
  supersededBy?: string;
  seenCount?: number;
  sources?: Item["sources"];
  aliases?: string[];
  expiresAt?: string;
  manual?: boolean;
  lastSeenAt?: string;
}

interface CuratorJournal {
  id: string;
  createdAt: string;
  before: BeforeItem[];
  maintenanceID?: string;
}

function snapshot(item: Item): BeforeItem {
  return {
    id: item.id,
    status: item.status,
    supersededBy: item.supersededBy,
    seenCount: item.seenCount,
    sources: item.sources,
    aliases: item.aliases,
    expiresAt: item.expiresAt,
    manual: item.manual,
    lastSeenAt: item.lastSeenAt,
  };
}

/**
 * Deterministic, zero-model maintenance:
 * - expires auto-written volatile facts
 * - dedupes auto-written items within one scope/projectKey/kind
 * - never touches rules, promoted items, or user-approved (manual) items
 * - writes a backup + journal before replacing items
 */
export async function runCurator(
  store: Store,
  _config: AutoMemConfig,
  options: { now?: number; force?: boolean } = {},
): Promise<CuratorResult> {
  const now = options.now ?? Date.now();
  const nowISO = new Date(now).toISOString();
  const state = await store.readState();
  if (!options.force) {
    const last = state.lastCuratedAt ? Date.parse(state.lastCuratedAt) : Number.NaN;
    if (Number.isFinite(last) && now - last < DAY) {
      return { due: false, expired: 0, merged: 0 };
    }
  }

  const claimed = await store.claim("curator:run", 10 * 60 * 1000);
  if (!claimed) return { due: false, expired: 0, merged: 0 };

  try {
    const items = await store.listItems();
    const changed = new Map<string, Item>();
    let expired = 0;

    for (const item of items) {
      if (
        item.status !== "auto" ||
        item.kind === "rule" ||
        item.manual === true ||
        !item.expiresAt
      ) {
        continue;
      }
      const at = Date.parse(item.expiresAt);
      if (!Number.isFinite(at) || at > now) continue;
      changed.set(item.id, { ...item, status: "archived", updatedAt: nowISO });
      expired += 1;
    }

    const groups = new Map<string, Item[]>();
    for (const item of items) {
      if (
        item.status !== "auto" ||
        item.kind === "rule" ||
        item.manual === true ||
        (item.scope === "project" && !item.projectKey) ||
        changed.has(item.id)
      ) {
        continue;
      }
      const key = `${item.scope}|${item.projectKey ?? ""}|${item.kind}`;
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }

    let merged = 0;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort(
        (left, right) =>
          (right.seenCount ?? 1) - (left.seenCount ?? 1) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
      const canonical = { ...group[0] };
      for (const other of group.slice(1)) {
        // Same rule as compaction: only exact, same-kind duplicates may be
        // archived automatically. Similarity alone can erase a changed port,
        // version, date or negation.
        const duplicate = isExactRelation(
          classifyRelation(
            { text: canonical.text, kind: canonical.kind },
            { text: other.text, kind: other.kind },
          ),
        );
        if (!duplicate) continue;
        canonical.seenCount = (canonical.seenCount ?? 1) + (other.seenCount ?? 1);
        canonical.sources = [
          ...(canonical.sources ?? [canonical.source]),
          ...(other.sources ?? [other.source]),
        ].slice(-20);
        canonical.aliases = [...(canonical.aliases ?? []), other.text].slice(-10);
        canonical.lastSeenAt = nowISO;
        canonical.updatedAt = nowISO;
        changed.set(canonical.id, canonical);
        changed.set(other.id, {
          ...other,
          status: "archived",
          supersededBy: canonical.id,
          updatedAt: nowISO,
        });
        merged += 1;
      }
    }

    let id: string | undefined;
    let backupPath: string | undefined;
    let journalPath: string | undefined;
    if (changed.size > 0) {
      await store.transaction(async () => {
      if (!await store.ownsClaim("curator:run", claimed)) throw new Error("整理租约已失效");
      id = newId("curator");
      backupPath = path.join(store.dataDir, `items.jsonl.bak-${id}`);
      await store.writeTextAtomic(backupPath, await readFile(store.itemsPath, "utf8"));
      const curatorDir = path.join(store.dataDir, "curator");
      await mkdir(curatorDir, { recursive: true });
      journalPath = path.join(curatorDir, `${id}.json`);
      const journal: CuratorJournal = {
        id,
        createdAt: nowISO,
        before: items.filter((item) => changed.has(item.id)).map(snapshot),
        maintenanceID: await store.applyItemChanges(items, items.map((item) => changed.get(item.id) ?? item)),
      };
      await store.writeTextAtomic(
        journalPath,
        `${JSON.stringify(journal, null, 2)}\n`,
      );
      await rebuildAutoFiles(store);
      await store.appendChangelog({
        action: "curator",
        curatorID: id,
        journalID: journal.maintenanceID,
        expired,
        merged,
      });
      });
    }

    await store.updateState({ lastCuratedAt: nowISO });
    return {
      due: true,
      expired,
      merged,
      ...(id && backupPath && journalPath ? { id, backupPath, journalPath } : {}),
    };
  } finally {
    await store.releaseReservation("curator:run", claimed).catch(() => undefined);
  }
}

export async function undoCurator(
  store: Store,
  id: string,
): Promise<number> {
  if (!/^curator_[A-Za-z0-9_]+$/.test(id)) {
    throw new Error("invalid curator id");
  }
  const journalPath = path.join(store.dataDir, "curator", `${id}.json`);
  const journal = JSON.parse(
    await readFile(journalPath, "utf8"),
  ) as CuratorJournal;
  if (!Array.isArray(journal.before)) throw new Error("invalid curator journal");
  if (!journal.maintenanceID) throw new Error("旧版整理记录没有冲突快照，不能安全撤销；请手动核对备份");
  const restored = await store.undoMaintenance(journal.maintenanceID);
  await rebuildAutoFiles(store);
  await store.appendChangelog({ action: "undo_maintenance", curatorID: id, journalID: journal.maintenanceID });
  return restored;
}
