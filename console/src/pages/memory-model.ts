import type { ChangeEvent, MemoryItem } from "../types";

/** Visible memory segments. "all" also classifies rows outside the four states. */
export type MemorySegment = "active" | "session" | "stopped" | "expired" | "all";

export type SourceKind = "auto" | "review" | "manual" | "migration" | "unknown";

export type TimeWindow = "any" | "24h" | "7d" | "30d";

export interface MemoryFilters {
  segment: MemorySegment;
  scope: "" | MemoryItem["scope"];
  kind: "" | MemoryItem["kind"];
  source: "" | Exclude<SourceKind, "unknown">;
  time: TimeWindow;
  query: string;
}

export const EMPTY_MEMORY_FILTERS: MemoryFilters = {
  segment: "active",
  scope: "",
  kind: "",
  source: "",
  time: "any",
  query: "",
};

export const SEGMENT_LABEL: Record<MemorySegment, string> = {
  active: "生效中",
  session: "本次会话",
  stopped: "已停止",
  expired: "已过期",
  all: "全部",
};

export const KIND_LABEL: Record<MemoryItem["kind"], string> = {
  fact: "事实",
  preference: "偏好",
  rule: "规则",
  reference: "引用",
  skill: "流程",
};

export const SCOPE_LABEL: Record<MemoryItem["scope"], string> = {
  session: "本次会话",
  project: "项目",
  global: "全局",
};

export const SOURCE_LABEL: Record<SourceKind, string> = {
  auto: "自动",
  review: "复盘",
  manual: "手动",
  migration: "迁移",
  unknown: "来源未知",
};

export const STATUS_LABEL: Record<MemoryItem["status"], string> = {
  auto: "自动写入",
  queue: "旧审批队列",
  shadow: "影子观察",
  promoted: "已提升",
  false_positive: "已标记误报",
  archived: "不再注入",
};

/**
 * Classify a row from server flags only. `expired` and archive state are
 * computed by the server; the UI never re-derives the 90-day window locally.
 */
export function segmentOf(item: MemoryItem): MemorySegment {
  if (item.status === "archived") {
    if (item.expired || item.latestChange?.kind === "expire") return "expired";
    // Only an explicit user stop (or a deactivate record) belongs in
    // "已停止"; merged/expired archives stay in "全部" with an honest label.
    if (item.restorable || item.supersededBy === "deactivate") return "stopped";
    return "all";
  }
  if (item.expired) return "expired";
  if (item.status === "auto" || item.status === "promoted") {
    if (item.invalidatedBy) return "stopped";
    if (item.scope === "session") return "session";
    return "active";
  }
  return "all";
}

export function matchesSegment(item: MemoryItem, segment: MemorySegment): boolean {
  if (segment === "all") return true;
  return segmentOf(item) === segment;
}

/** Stop is only offered when the server says the row is currently injected. */
export function canStop(item: MemoryItem): boolean {
  return item.stoppable === true;
}

/** Restore is only offered on explicit server capability, never on local dates. */
export function canRestore(item: MemoryItem): boolean {
  return item.restorable === true;
}

/** Version rollback is only offered when the change itself is revertible. */
export function canRevert(change: ChangeEvent | undefined): boolean {
  return change?.revertible === true;
}

export function sourceKindOf(item: MemoryItem): SourceKind {
  if (item.manual) return "manual";
  if (
    item.latestChange?.origin === "migration" ||
    item.latestChange?.kind === "migration"
  ) {
    return "migration";
  }
  if (item.origin === "session-review" || item.reviewType) return "review";
  if (item.source?.sessionID || item.source?.messageID) return "auto";
  return "auto";
}

const WINDOW_MS: Record<Exclude<TimeWindow, "any">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export function inTimeWindow(item: MemoryItem, time: TimeWindow, now = Date.now()): boolean {
  if (time === "any") return true;
  const at = Date.parse(item.updatedAt || item.createdAt);
  if (!Number.isFinite(at)) return false;
  return now - at <= WINDOW_MS[time];
}

export function matchesFilters(
  item: MemoryItem,
  filters: MemoryFilters,
  now = Date.now(),
): boolean {
  if (!matchesSegment(item, filters.segment)) return false;
  if (filters.scope && item.scope !== filters.scope) return false;
  if (filters.kind && item.kind !== filters.kind) return false;
  if (filters.source && sourceKindOf(item) !== filters.source) return false;
  if (!inTimeWindow(item, filters.time, now)) return false;
  const query = filters.query.trim().toLowerCase();
  if (query && !`${item.title} ${item.text}`.toLowerCase().includes(query)) return false;
  return true;
}

export function filterItems(
  items: MemoryItem[],
  filters: MemoryFilters,
  now = Date.now(),
): MemoryItem[] {
  return items
    .filter((item) => matchesFilters(item, filters, now))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function segmentCounts(items: MemoryItem[]): Record<MemorySegment, number> {
  const counts: Record<MemorySegment, number> = {
    active: 0,
    session: 0,
    stopped: 0,
    expired: 0,
    all: items.length,
  };
  for (const item of items) {
    const segment = segmentOf(item);
    if (segment !== "all") counts[segment] += 1;
  }
  return counts;
}

/** Unknown counts stay unknown; they never collapse into a believable 0. */
export function countLabel(label: string, value: number | undefined): string {
  return value === undefined ? `${label} 未知` : `${label} ${value}`;
}

export function countAria(label: string, value: number | undefined, scope: string): string {
  return value === undefined
    ? `${label}未知，${scope}指标不可用`
    : `${label}${value}，口径：${scope}`;
}

export function filterCountLabel(shown: number, segment: number, allProjects: number | undefined): string {
  return `分段 ${segment} 条 · 筛选后 ${shown} 条 · 全部项目 ${
    allProjects === undefined ? "未知" : `${allProjects} 条`
  }`;
}

export function projectLabel(project: { label?: string; key?: string } | null | undefined): string {
  if (!project?.label && !project?.key) return "项目不可确认";
  return project.label || project.key || "项目不可确认";
}

export function changeLabel(change: ChangeEvent): string {
  switch (change.kind) {
    case "add":
      return "新增";
    case "update":
      return "更新";
    case "merge":
      return "合并";
    case "replace":
      return "替换";
    case "archive":
      return "归档";
    case "revert":
      return "撤销";
    case "restore":
      return "恢复版本";
    case "deactivate":
      return "停止使用";
    case "expire":
      return "过期";
    case "invalidate":
      return "上游失效";
    case "promote":
      return "提升";
    case "migration":
      return "迁移";
    default:
      return change.kind;
  }
}

export function statusTextOf(item: MemoryItem): string {
  if (item.expired) return "已过期";
  if (item.status === "archived") {
    if (item.restorable || item.supersededBy === "deactivate") return "已停止使用";
    if (item.latestChange?.kind === "expire") return "已过期";
    return "已归档";
  }
  if (item.invalidatedBy) return "已失效";
  if (item.status === "auto" || item.status === "promoted") return "生效中";
  return STATUS_LABEL[item.status];
}

export function itemProjectLabel(item: MemoryItem): string {
  if (!item.project) return item.projectKey ? `项目 ${shortID(item.projectKey)}` : "";
  const parts = item.project.replace(/\\/g, "/").split("/").filter(Boolean);
  return `项目 ${parts.at(-1) ?? item.project}`;
}

export function sourceText(item: MemoryItem): string {
  const parts: string[] = [];
  if (item.source?.sessionID) parts.push(`会话 ${shortID(item.source.sessionID)}`);
  if (item.source?.messageID) parts.push(`消息 ${shortID(item.source.messageID)}`);
  if (item.source?.project) parts.push(item.source.project);
  return parts.length > 0 ? parts.join(" · ") : "来源未记录";
}

export function shortID(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-3)}`;
}

/** Only the fields that are safe to show; never raw tool arguments or secrets. */
export function evidenceSummary(item: MemoryItem): string {
  if (!item.evidence || item.evidence.length === 0) return "";
  return item.evidence
    .map((entry) => `${entry.kind === "user" ? "用户" : "工具"}：${entry.quote}`)
    .join("\n");
}
