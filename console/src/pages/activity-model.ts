import type {
  ChangelogEntry,
  ChangeEvent,
  HookRecord,
  MemoryItem,
  ReviewRecord,
} from "../types";
import { changeLabel, shortID } from "./memory-model";

export type ActivityType =
  | "write"
  | "skip"
  | "failure"
  | "revert"
  | "restore"
  | "stop"
  | "review"
  | "maintenance"
  | "migration";

export type ActivityResult = "success" | "failure" | "unknown";

export type ReasonCategory =
  | "timeout"
  | "rate-limit"
  | "validation"
  | "duplicate"
  | "capacity"
  | "sensitive"
  | "unknown";

export interface ActivityEvent {
  id: string;
  at: string;
  type: ActivityType;
  /** Short object label; falls back to a truthful "对象已不存在". */
  title: string;
  itemID?: string;
  changeID?: string;
  reviewID?: string;
  /** One-line cause; may be empty when the source did not record one. */
  reason: string;
  reasonCategory?: ReasonCategory;
  result: ActivityResult;
  /** Server capability for a legal revert of this exact event. */
  revertible: boolean;
  /** Content version the revert must be bound to. */
  expectedVersion?: string;
  sourceLabel: string;
  /** Sub-label such as "复盘" for failed/skipped review events. */
  subtype?: string;
}

export const ACTIVITY_TYPE_LABEL: Record<ActivityType, string> = {
  write: "自动写入",
  skip: "自动跳过",
  failure: "失败",
  revert: "撤销",
  restore: "恢复",
  stop: "停止使用",
  review: "复盘",
  maintenance: "维护",
  migration: "迁移",
};

const REASON_CATEGORY_LABEL: Record<ReasonCategory, string> = {
  timeout: "超时",
  "rate-limit": "限流",
  validation: "校验",
  duplicate: "重复",
  capacity: "容量",
  sensitive: "敏感",
  unknown: "其他",
};

export function reasonCategoryLabel(category: ReasonCategory | undefined): string {
  return category ? REASON_CATEGORY_LABEL[category] : "";
}

export function reasonCategory(text: string): ReasonCategory {
  const value = text.toLowerCase();
  if (/timeout|timed out|超时|etimedout/.test(value)) return "timeout";
  if (/rate.?limit|429|限流|too many/.test(value)) return "rate-limit";
  if (/duplicate|重复|similar/.test(value)) return "duplicate";
  if (/capacity|full|limit|容量|已满|预算/.test(value)) return "capacity";
  if (/sensitive|secret|credential|redact|敏感|脱敏/.test(value)) return "sensitive";
  if (/invalid|validation|schema|lint|校验|不合格|parse/.test(value)) return "validation";
  return "unknown";
}

/** Map a ledger change to the activity taxonomy. */
export function activityTypeOf(
  kind: ChangeEvent["kind"],
  actor?: ChangeEvent["actor"],
  origin?: ChangeEvent["origin"],
): ActivityType {
  switch (kind) {
    case "add":
    case "update":
    case "merge":
    case "replace":
    case "promote":
      // A user edit is not an automatic write and must not inflate that count.
      if (actor === "migration" || origin === "migration") return "migration";
      return actor === "user" || origin === "user" ? "maintenance" : "write";
    case "revert":
      return "revert";
    case "restore":
      return "restore";
    case "deactivate":
      return "stop";
    case "expire":
    case "archive":
    case "invalidate":
      return "maintenance";
    case "migration":
      return "migration";
    default:
      return "maintenance";
  }
}

export function activityTitleOf(
  change: ChangeEvent,
  items: ReadonlyMap<string, MemoryItem>,
): string {
  return (
    change.after?.title ||
    change.before?.title ||
    items.get(change.itemID)?.title ||
    `条目 ${shortID(change.itemID)}`
  );
}

export function eventFromChange(
  change: ChangeEvent,
  items: ReadonlyMap<string, MemoryItem>,
  itemVersions: ReadonlyMap<string, string>,
): ActivityEvent {
  const type = activityTypeOf(change.kind, change.actor, change.origin);
  return {
    id: change.id,
    at: change.at,
    type,
    title: activityTitleOf(change, items),
    itemID: change.itemID,
    changeID: change.id,
    reason: change.reason || changeLabel(change),
    reasonCategory: change.kind === "deactivate" ? "unknown" : undefined,
    result: "success",
    revertible: change.revertible === true,
    expectedVersion: itemVersions.get(change.itemID),
    sourceLabel:
      change.actor === "user"
        ? "你"
        : change.actor === "migration"
          ? "迁移"
          : change.actor === "curator"
            ? "维护"
            : change.actor === "system"
              ? "系统"
              : "自动",
    subtype: type === "maintenance" ? "手动写入" : undefined,
  };
}

const MAINTENANCE_ACTIONS: ReadonlySet<string> = new Set([
  "compact",
  "curator",
  "retention",
  "retention_auto",
  "undo_maintenance",
  "automation_mode",
  "config_update",
  "undo_merge",
]);

const SKIP_ACTIONS: ReadonlySet<string> = new Set([
  "capture_blocked",
  "capture_rejected",
  "retired_source_skipped",
  "global_candidate_expired",
  "extract_quarantine_expired",
  "extract_quarantined",
  "extract_learning_rejected",
  "extract_tool_source_changed",
  "extract_source_changed",
]);

const CAPACITY_ACTIONS: ReadonlySet<string> = new Set([
  "global_candidate_capacity_blocked",
  "retired_source_capacity_blocked",
  "extract_quarantine_capacity",
  "retention_blocked",
]);

const CHANGELOG_REASON: Record<string, string> = {
  capture_blocked: "采集被阻断，未写入生效记忆",
  capture_rejected: "候选未通过采集准入",
  retired_source_skipped: "退役来源已跳过",
  global_candidate_expired: "全局候选已过期",
  extract_quarantine_expired: "隔离候选已过期",
  extract_quarantined: "候选被隔离，未写入生效记忆",
  extract_learning_rejected: "学习提案未通过本地准入",
  extract_tool_source_changed: "学习来源在写入前已变化",
  extract_source_changed: "来源在写入前已变化",
  global_candidate_capacity_blocked: "全局候选容量已满",
  retired_source_capacity_blocked: "退役来源容量已满",
  extract_quarantine_capacity: "隔离区容量已满",
  retention_auto: "自动回收派生历史",
  retention_blocked: "保留策略到达上限，受保护历史未删除",
};

export function eventFromChangelog(entry: ChangelogEntry): ActivityEvent | null {
  const isSkip = SKIP_ACTIONS.has(entry.action) || CAPACITY_ACTIONS.has(entry.action);
  const isMaintenance = MAINTENANCE_ACTIONS.has(entry.action);
  if (!isSkip && !isMaintenance) return null;
  const reasonText =
    entry.reason ||
    entry.decision ||
    entry.reasons?.join("、") ||
    CHANGELOG_REASON[entry.action] ||
    entry.action;
  const reason = entry.count ? `${reasonText}（${entry.count}）` : reasonText;
  return {
    id: `changelog:${entry.at}:${entry.action}:${
      entry.itemID ??
      entry.journalID ??
      entry.reviewID ??
      entry.curatorID ??
      entry.recoveryID ??
      entry.sessionID ??
      ""
    }`,
    at: entry.at,
    type: isSkip ? "skip" : "maintenance",
    title: entry.itemID
      ? `条目 ${shortID(entry.itemID)}`
      : entry.sessionID
        ? `会话 ${shortID(entry.sessionID)}`
        : "系统维护",
    itemID: entry.itemID,
    reason,
    reasonCategory: isSkip
      ? CAPACITY_ACTIONS.has(entry.action)
        ? "capacity"
        : entry.action.includes("source_changed")
          ? "validation"
          : reasonCategory(reason)
      : undefined,
    result: "unknown",
    revertible: false,
    sourceLabel: entry.source ?? "服务端",
    subtype: entry.action,
  };
}

export function eventFromReview(review: ReviewRecord): ActivityEvent {
  const failed = review.status === "failed";
  const skipped = review.status === "skipped";
  const counts: string[] = [`候选 ${review.candidates}`];
  if (typeof review.queued === "number" && review.queued > 0) counts.push(`入队 ${review.queued}`);
  if (typeof review.learned === "number") counts.push(`学习 ${review.learned}`);
  if (typeof review.updated === "number") counts.push(`更新 ${review.updated}`);
  if (typeof review.shadowed === "number") counts.push(`观察 ${review.shadowed}`);
  if (typeof review.learningSkipped === "number") counts.push(`学习跳过 ${review.learningSkipped}`);
  if (typeof review.protectedCandidates === "number") counts.push(`受保护 ${review.protectedCandidates}`);
  if (review.learningDeferred) counts.push(`延后：${review.learningDeferred}`);
  const reason = failed
    ? review.error ?? "复盘失败，原因未记录"
    : skipped
      ? review.note ?? "本轮没有可复盘内容"
      : counts.join(" · ");
  return {
    id: `review:${review.id}`,
    at: review.createdAt,
    type: failed ? "failure" : skipped ? "skip" : "review",
    title: `会话 ${shortID(review.sessionID)}`,
    reviewID: review.id,
    reason,
    reasonCategory: failed || skipped ? reasonCategory(reason) : undefined,
    result: failed ? "failure" : "success",
    revertible: false,
    sourceLabel: review.model ?? "复盘",
    subtype: "复盘",
  };
}

export function eventFromHook(hook: HookRecord): ActivityEvent | null {
  if (hook.status !== "failed" && hook.status !== "ignored" && hook.status !== "blocked") {
    return null;
  }
  const reason =
    hook.error ||
    hook.decision?.reasons?.join("、") ||
    (hook.status === "ignored" ? "未达到写入条件" : "后台处理失败");
  return {
    id: `hook:${hook.id}`,
    at: hook.createdAt,
    type: hook.status === "failed" ? "failure" : "skip",
    title: hook.title || `候选 ${shortID(hook.id)}`,
    itemID: hook.itemID,
    reason,
    reasonCategory: reasonCategory(reason),
    result: hook.status === "failed" ? "failure" : "success",
    revertible: false,
    sourceLabel: "采集",
    subtype: hook.status === "failed" ? "自动写入" : "自动跳过",
  };
}

export interface ActivityCounts {
  write: number;
  skip: number;
  failure: number;
  revert: number;
}

export function startOfDay(now = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function activitySummary(
  events: ActivityEvent[],
  now = Date.now(),
): { today: ActivityCounts; partial: boolean } {
  const start = startOfDay(now);
  const today: ActivityCounts = { write: 0, skip: 0, failure: 0, revert: 0 };
  for (const event of events) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < start) continue;
    if (event.type === "write") today.write += 1;
    else if (event.type === "skip") today.skip += 1;
    else if (event.type === "failure") today.failure += 1;
    else if (event.type === "revert") today.revert += 1;
  }
  return { today, partial: false };
}

export function activityTypeCount(
  events: ActivityEvent[],
  type: ActivityType | "all",
): number {
  return type === "all" ? events.length : events.filter((event) => event.type === type).length;
}

export function matchesActivityFilter(
  event: ActivityEvent,
  filter: ActivityType | "all",
): boolean {
  return filter === "all" || event.type === filter;
}

export function compareActivity(left: ActivityEvent, right: ActivityEvent): number {
  return right.at.localeCompare(left.at) || right.id.localeCompare(left.id);
}
