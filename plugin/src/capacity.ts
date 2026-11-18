import type { AutoMemConfig, ItemKind } from "./types.js";
import type { Store } from "./store.js";
import { MANAGED_HISTORY_LIMITS, reclaimForCapacity } from "./retention.js";

export type CapacityLevel = "ok" | "warn" | "compact" | "freeze" | "block";

export interface CapacityStatus {
  level: CapacityLevel;
  ratio: number;
  reason: string;
  /** Live protected-history pressure; admission reclaims once before blocking. */
  historyAtCapacity: boolean;
  counts: {
    items: number;
    autoMemory: number;
    autoRules: number;
    queue: number;
    shadow: number;
    drafts: number;
    diskBytes: number;
    changes: number;
    changeJournals: number;
    suppressions: number;
    quarantine: number;
    retiredSources: number;
    globalCandidates: number;
    migrationJournals: number;
    checkpointBackups: number;
  };
}

export type Admission =
  | { ok: true }
  | {
      ok: false;
      action: "queue" | "compact" | "block";
      reason: string;
      /** Machine-readable cause; never claims a recovery that did not run. */
      blockedReason?: string;
      retryAt?: string;
      reclaimedBytes?: number;
      reclaimableBytes?: number;
      protectedChanges?: number;
      protectedJournals?: number;
    };

export async function capacityStatus(
  store: Store,
  config: AutoMemConfig,
): Promise<CapacityStatus> {
  const [
    items,
    queue,
    shadow,
    drafts,
    diskBytes,
    changes,
    changeJournals,
    suppressions,
    quarantine,
    retiredSources,
    globalCandidates,
    migrationJournals,
    checkpointBackups,
  ] = await Promise.all([
    store.listItems(),
    store.listQueue(),
    store.listShadow(),
    store.listSkillDrafts(),
    store.dirSize(),
    store.countJsonlRows(store.changesPath),
    store.countFiles("change-journal"),
    store.countJsonlRows(store.suppressionsPath),
    store.countJsonlRows(store.extractQuarantinePath),
    store.countJsonlRows(store.retiredSourcesPath),
    store.countJsonlRows(store.globalCandidatesPath),
    store.countFiles("migrations"),
    store.countDirectories("backup", "checkpoint-"),
  ]);
  const active = items.filter((item) => item.status !== "archived");
  const autoMemory = items.filter(
    (item) => item.status === "auto" && item.kind !== "rule",
  ).length;
  const autoRules = items.filter(
    (item) => item.status === "auto" && item.kind === "rule",
  ).length;
  const ratios = [
    active.length / Math.max(1, config.caps.itemsTotal),
    queue.length / Math.max(1, config.caps.queue),
    drafts.length / Math.max(1, config.caps.skillDrafts),
    diskBytes / Math.max(1, config.caps.diskBytes),
  ];
  const ratio = Math.max(...ratios);
  const level: CapacityLevel =
    ratio >= 1
      ? "block"
      : ratio >= 0.95
        ? "freeze"
        : ratio >= 0.85
          ? "compact"
          : ratio >= 0.7
            ? "warn"
            : "ok";
  return {
    level,
    ratio: Math.round(ratio * 1000) / 1000,
    reason: reasonFor(level),
    historyAtCapacity: changes >= MANAGED_HISTORY_LIMITS.changes ||
      changeJournals >= MANAGED_HISTORY_LIMITS.changes,
    counts: {
      items: active.length,
      autoMemory,
      autoRules,
      queue: queue.length,
      shadow: shadow.length,
      drafts: drafts.length,
      diskBytes,
      changes,
      changeJournals,
      suppressions,
      quarantine,
      retiredSources,
      globalCandidates,
      migrationJournals,
      checkpointBackups,
    },
  };
}

export async function admitAutoWrite(
  store: Store,
  config: AutoMemConfig,
  kind: ItemKind,
): Promise<Admission> {
  let status = await capacityStatus(store, config);
  // Freeze/block or a protected-history cap gets one bounded safe reclaim
  // before it stops a real write. The reclaim shares the maintenance
  // lease/gate, so a request never scans the whole data directory repeatedly.
  let reclaim: Awaited<ReturnType<typeof reclaimForCapacity>> | undefined;
  if ((status.level === "freeze" || status.level === "block" || status.historyAtCapacity) &&
      !store.inTransaction) {
    try {
      reclaim = await reclaimForCapacity(store);
    } catch {
      reclaim = undefined;
    }
    if (reclaim && reclaim.reclaimedBytes > 0) status = await capacityStatus(store, config);
  }
  const lastRetention = reclaim?.skipped
    ? (await store.readState()).automation?.retention
    : undefined;
  const gate = (action: "queue" | "compact" | "block", reason: string, blockedReason: string): Admission => ({
    ok: false,
    action,
    reason,
    blockedReason,
    retryAt: reclaim?.retryAt ?? new Date(Date.now() + 15 * 60_000).toISOString(),
    ...(reclaim && !reclaim.skipped
      ? {
          reclaimedBytes: reclaim.reclaimedBytes,
          reclaimableBytes: reclaim.remainingReclaimableBytes,
          protectedChanges: reclaim.protectedChanges,
          protectedJournals: reclaim.protectedJournals,
        }
      : lastRetention
        ? {
            reclaimableBytes: lastRetention.remainingReclaimableBytes,
            protectedChanges: lastRetention.protected.changes,
            protectedJournals: lastRetention.protected.journals,
          }
        : {}),
  });
  if (status.level === "block") {
    return gate("block", "数据目录已满，写入被拒绝", "capacity-block");
  }
  if (status.level === "freeze") {
    return gate("queue", "容量达到 95%，自动写已冻结", "capacity-freeze");
  }
  if (status.level === "compact") {
    return gate("compact", "容量达到 85%，需要先压缩", "capacity-compact");
  }
  if (status.historyAtCapacity) {
    return gate("queue", "受保护变更历史已到上限，已暂停新的自动学习；停止/撤销仍可用", "history-protected-capacity");
  }
  if (kind === "rule") {
    if (status.counts.autoRules >= config.caps.autoRules) {
      return { ok: false, action: "queue", reason: "AUTO_RULES 已达硬上限", blockedReason: "auto-rules-cap" };
    }
  } else if (status.counts.autoMemory >= config.caps.autoMemory) {
    return { ok: false, action: "queue", reason: "AUTO_MEMORY 已达硬上限", blockedReason: "auto-memory-cap" };
  }
  return { ok: true };
}

export async function admitQueueItem(
  store: Store,
  config: AutoMemConfig,
): Promise<{ ok: boolean; reason?: string }> {
  const status = await capacityStatus(store, config);
  if (status.counts.diskBytes >= config.caps.diskBytes) {
    return { ok: false, reason: "数据目录已满，拒绝新候选" };
  }
  if (status.counts.queue >= config.caps.queue) {
    return {
      ok: false,
      reason: `审批队列已满（${config.caps.queue}），请先处理或压缩`,
    };
  }
  return { ok: true };
}

export async function admitNewItem(
  store: Store,
  config: AutoMemConfig,
  kind: ItemKind,
): Promise<{ ok: boolean; reason?: string }> {
  const status = await capacityStatus(store, config);
  if (status.counts.diskBytes >= config.caps.diskBytes) {
    return { ok: false, reason: "数据目录已满，写入被拒绝" };
  }
  if (status.counts.items >= config.caps.itemsTotal) {
    return { ok: false, reason: `记忆条目已达硬上限（${config.caps.itemsTotal}）` };
  }
  if (kind === "rule" && status.counts.autoRules >= config.caps.autoRules) {
    return { ok: false, reason: "AUTO_RULES 已达硬上限" };
  }
  if (kind !== "rule" && status.counts.autoMemory >= config.caps.autoMemory) {
    return { ok: false, reason: "AUTO_MEMORY 已达硬上限" };
  }
  return { ok: true };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function reasonFor(level: CapacityLevel): string {
  if (level === "block") return "容量已满：拒绝写入";
  if (level === "freeze") return "容量达到 95%：冻结自动写";
  if (level === "compact") return "容量达到 85%：建议压缩";
  if (level === "warn") return "容量达到 70%：留意增长";
  return "容量正常";
}
