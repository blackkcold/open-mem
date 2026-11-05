import type { AutoMemConfig, ItemKind } from "./types.js";
import type { Store } from "./store.js";

export type CapacityLevel = "ok" | "warn" | "compact" | "freeze" | "block";

export interface CapacityStatus {
  level: CapacityLevel;
  ratio: number;
  reason: string;
  counts: {
    items: number;
    autoMemory: number;
    autoRules: number;
    queue: number;
    shadow: number;
    drafts: number;
    diskBytes: number;
  };
}

export type Admission =
  | { ok: true }
  | { ok: false; action: "queue" | "compact" | "block"; reason: string };

export async function capacityStatus(
  store: Store,
  config: AutoMemConfig,
): Promise<CapacityStatus> {
  const [items, queue, shadow, drafts, diskBytes] = await Promise.all([
    store.listItems(),
    store.listQueue(),
    store.listShadow(),
    store.listSkillDrafts(),
    store.dirSize(),
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
    counts: {
      items: active.length,
      autoMemory,
      autoRules,
      queue: queue.length,
      shadow: shadow.length,
      drafts: drafts.length,
      diskBytes,
    },
  };
}

export async function admitAutoWrite(
  store: Store,
  config: AutoMemConfig,
  kind: ItemKind,
): Promise<Admission> {
  const status = await capacityStatus(store, config);
  if (status.level === "block") {
    return { ok: false, action: "block", reason: "数据目录已满，写入被拒绝" };
  }
  if (status.level === "freeze") {
    return { ok: false, action: "queue", reason: "容量达到 95%，自动写已冻结" };
  }
  if (status.level === "compact") {
    return { ok: false, action: "compact", reason: "容量达到 85%，需要先压缩" };
  }
  if (kind === "rule") {
    if (status.counts.autoRules >= config.caps.autoRules) {
      return { ok: false, action: "queue", reason: "AUTO_RULES 已达硬上限" };
    }
  } else if (status.counts.autoMemory >= config.caps.autoMemory) {
    return { ok: false, action: "queue", reason: "AUTO_MEMORY 已达硬上限" };
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
