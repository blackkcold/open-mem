import type { AutoMemConfig, Item } from "./types.js";
import type { Store } from "./store.js";
import { fingerprintText, hammingDistance, textSimilarity } from "./fingerprint.js";
import { rebuildAutoFiles } from "./rebuild.js";
import { capacityStatus } from "./capacity.js";

export interface CompactionResult {
  ok: boolean;
  merged: number;
  archived: number;
  itemsBefore: number;
  itemsAfter: number;
  memory: number;
  rules: number;
  reason?: string;
  journalID?: string;
}

export async function runCompaction(
  store: Store,
  config: AutoMemConfig,
  options: { dryRun?: boolean } = {},
): Promise<CompactionResult> {
  const items = await store.listItems();
  const snapshot = structuredClone(items);
  const activeBefore = items.filter((item) => item.status !== "archived");
  const itemsBefore = activeBefore.length;

  const groups = new Map<string, Item[]>();
  for (const item of activeBefore) {
    if (item.kind === "rule" || item.manual || item.status === "promoted") continue;
    if (item.scope === "project" && !item.projectKey) continue;
    const key = JSON.stringify([item.scope, item.scope === "project" ? item.projectKey : null, item.kind]);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const next = [...items];
  const now = new Date().toISOString();
  let merged = 0;
  let archived = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort(
      (left, right) =>
        statusRank(right.status) - statusRank(left.status) ||
        (right.seenCount ?? 1) - (left.seenCount ?? 1) ||
        left.createdAt.localeCompare(right.createdAt),
    );
    const canonical = group[0];
    for (const other of group.slice(1)) {
      const duplicate =
        hammingDistance(fingerprintText(canonical.text), fingerprintText(other.text)) <= 3 ||
        textSimilarity(canonical.text, other.text) >= 0.92;
      if (!duplicate) continue;

      canonical.seenCount = (canonical.seenCount ?? 1) + (other.seenCount ?? 1);
      canonical.sources = [
        ...(canonical.sources ?? [canonical.source]),
        ...(other.sources ?? [other.source]),
      ].slice(-20);
      canonical.lastSeenAt = now;
      canonical.aliases = [...(canonical.aliases ?? []), other.text].slice(-10);
      merged += 1;

      const index = next.findIndex((item) => item.id === other.id);
      if (index !== -1) {
        next[index] = {
          ...next[index],
          status: "archived",
          supersededBy: canonical.id,
          updatedAt: now,
        };
        archived += 1;
      }
    }
    const index = next.findIndex((item) => item.id === canonical.id);
    if (index !== -1) next[index] = canonical;
  }

  if (options.dryRun) {
    return { ok: true, merged, archived, itemsBefore,
      itemsAfter: next.filter((item) => item.status !== "archived").length,
      memory: activeBefore.filter((item) => item.kind !== "rule" && item.kind !== "skill").length,
      rules: activeBefore.filter((item) => item.kind === "rule").length };
  }
  const journalID = merged > 0 ? await store.applyItemChanges(snapshot, next) : undefined;
  await store.pruneReservations(10 * 60 * 1000);
  await store.pruneShadow(config.caps.shadow);
  await store.pruneHooks(config.caps.hooks);
  await store.pruneReviews(config.caps.reviews);
  await store.rotateUsage("decision");
  await store.rotateUsage("rewrite");
  const view = await rebuildAutoFiles(store);
  const itemsAfter = next.filter((item) => item.status !== "archived").length;
  await store.setStat("lastCompactAt", Date.now());
  await store.setStat("itemsAtLastCompact", itemsAfter);
  await store.appendChangelog({
    action: "compact",
    merged,
    archived,
    itemsBefore,
    itemsAfter,
    journalID,
  });

  return {
    ok: true,
    merged,
    archived,
    itemsBefore,
    itemsAfter,
    memory: view.memory,
    rules: view.rules,
    journalID,
  };
}

export async function maybeCompact(
  store: Store,
  config: AutoMemConfig,
): Promise<CompactionResult | undefined> {
  const [stats, status, items] = await Promise.all([
    store.readStats(),
    capacityStatus(store, config),
    store.listItems(),
  ]);
  const active = items.filter((item) => item.status !== "archived").length;
  const itemsAtLastCompact = stats.itemsAtLastCompact ?? 0;
  const lastCompactAt = stats.lastCompactAt ?? 0;
  const capacityPressure =
    status.level === "compact" || status.level === "freeze" || status.level === "block";
  const newItems = active - itemsAtLastCompact >= 50;
  const daily = lastCompactAt > 0 && Date.now() - lastCompactAt >= 24 * 60 * 60 * 1000;
  const due = capacityPressure || newItems || daily;
  if (!due) return undefined;
  return runCompaction(store, config);
}

function statusRank(status: Item["status"]): number {
  if (status === "promoted") return 4;
  if (status === "auto") return 3;
  if (status === "queue") return 2;
  if (status === "shadow") return 1;
  return 0;
}
