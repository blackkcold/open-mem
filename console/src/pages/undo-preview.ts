/**
 * Pure helpers for the Health page's merge-undo panel.
 *
 * Everything shown here comes from the journal snapshots the server already
 * wrote (`before.queue`, `before.target`, `after.target`, `after.item`). When a
 * legacy or interrupted journal lacks those snapshots it is marked unsafe
 * instead of reconstructing content from an id or title.
 */

import { ApiError } from "../api";
import type { MergeJournal } from "../types";

export type MergeUndoStatus =
  | "undoable"
  | "expired"
  | "undone"
  | "in-progress"
  | "unsafe"
  | "unknown";

export interface MergeUndoSnapshot {
  id?: string;
  title: string;
  text: string;
}

export interface MergeUndoActionInfo {
  label: string;
  meaning: string;
  requiresTarget: boolean;
  restoresTarget: boolean;
  archivesCreated: boolean;
  known: boolean;
}

export interface MergeUndoPreview {
  id: string;
  at: string;
  action: string;
  actionLabel: string;
  actionMeaning: string;
  candidate: MergeUndoSnapshot | null;
  targetBefore: MergeUndoSnapshot | null;
  targetAfter: MergeUndoSnapshot | null;
  created: MergeUndoSnapshot | null;
  restoresTarget: boolean;
  archivesCreated: boolean;
  effects: string[];
  summary: string;
  safe: boolean;
  missing: string[];
  expiresAt: string | null;
  remainingMs: number | null;
  timeKnown: boolean;
  deadline: string;
  hint: string;
  status: MergeUndoStatus;
  statusLabel: string;
  canUndo: boolean;
  /** A crash-interrupted undo can be resumed only after an explicit user check. */
  canResume: boolean;
  unknownSince?: string;
}

export type MergeUndoLocks = Record<string, string>;

export const MERGE_UNDO_LOCKS_KEY = "openmem.mergeUndoUnknown.v1";

export const UNKNOWN_OUTCOME_NOTICE =
  "撤销请求结果未知，可能已提交。请先刷新并核对合并记录、目标条目与候选队列；确认前不会再次发送撤销。核对后可手动解除“状态未知”标记。";

export const SESSION_ONLY_UNKNOWN_NOTICE =
  "当前环境不能保存“状态未知”标记：标记不能跨整页重载保存，仅在此会话有效；请用页面内刷新核对，不要整页重载。";

export const UNSAVED_UNKNOWN_LEAVE_NOTICE =
  "仍有撤销请求结果未知，且当前环境无法保存标记；离开页面会丢失状态标记，请先用页面内刷新核对。";

export const RESUME_UNDO_NOTICE =
  "这次撤销在服务端标记为未完成，可能已部分应用。继续会重新发送同一条撤销请求；服务端会校验完整快照并完成或拒绝，不会自动重放其他操作。请先核对目标条目、候选队列和备份。";

const WINDOW_MS = 24 * 60 * 60 * 1000;

const ACTIONS: Record<string, MergeUndoActionInfo> = {
  create: {
    label: "新建记忆",
    meaning: "把候选另存为新条目，不改动已有条目",
    requiresTarget: false,
    restoresTarget: false,
    archivesCreated: true,
    known: true,
  },
  keep_both: {
    label: "保留两者",
    meaning: "保留已有条目，并把候选另存为新条目",
    requiresTarget: false,
    restoresTarget: false,
    archivesCreated: true,
    known: true,
  },
  merge_into: {
    label: "并入目标",
    meaning: "把候选内容并入目标条目",
    requiresTarget: true,
    restoresTarget: true,
    archivesCreated: false,
    known: true,
  },
  replace: {
    label: "替换目标",
    meaning: "用候选内容替换目标条目",
    requiresTarget: true,
    restoresTarget: true,
    archivesCreated: false,
    known: true,
  },
  reject_duplicate: {
    label: "判重归档",
    meaning: "把候选作为重复项归档，并刷新目标条目",
    requiresTarget: false,
    restoresTarget: true,
    archivesCreated: true,
    known: true,
  },
};

const UNKNOWN_ACTION: MergeUndoActionInfo = {
  label: "未知动作",
  meaning: "记录中的动作无法识别，不能安全预览",
  requiresTarget: false,
  restoresTarget: false,
  archivesCreated: false,
  known: false,
};

export function describeMergeAction(action: string): MergeUndoActionInfo {
  return ACTIONS[action] ?? UNKNOWN_ACTION;
}

function readSnapshot(
  value: unknown,
  field: string,
  missing: string[],
): MergeUndoSnapshot | null {
  if (typeof value !== "object" || value === null) {
    missing.push(field);
    return null;
  }
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title : undefined;
  const text = typeof record.text === "string" ? record.text : undefined;
  if (title === undefined || text === undefined || title.trim() === "") {
    missing.push(field);
    return null;
  }
  const id = typeof record.id === "string" ? record.id : undefined;
  return id ? { id, title, text } : { title, text };
}

function formatRemaining(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes} 分钟`;
  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

function deadlineText(
  status: MergeUndoStatus,
  remainingMs: number | null,
  timeKnown: boolean,
): string {
  switch (status) {
    case "undone":
      return "记录显示这次合并已撤销。";
    case "in-progress":
      return timeKnown
        ? "记录显示撤销未完成，可能已部分应用；续做不受 24 小时撤销窗口限制，服务端会重新校验完整快照。"
        : "记录显示撤销未完成，可能已部分应用；记录时间无法解析，但续做不依赖 24 小时窗口，服务端会重新校验完整快照。";
    case "unsafe":
      return timeKnown
        ? "缺少完整快照，无法安全列出恢复/归档对象；请检查备份或服务端记录。"
        : "记录时间无法解析，不能确认 24 小时撤销窗口；已禁止撤销，服务端校验为准。";
    case "unknown":
      return "撤销请求结果未知，可能已提交。请先刷新并核对合并记录、目标条目与候选队列；确认前不会再次发送撤销。";
    case "expired":
      return "已超过 24 小时撤销窗口（本地时钟估算，服务端校验为准）。";
    case "undoable":
      return remainingMs === null
        ? "无法解析记录时间，不能估算撤销期限；以服务端校验为准。"
        : `24 小时内可撤销，剩余约 ${formatRemaining(remainingMs)}（本地时钟估算，服务端校验为准）。`;
  }
}

function hintText(status: MergeUndoStatus, timeKnown: boolean): string {
  switch (status) {
    case "undoable":
      return "撤销前请核对候选与目标的实际内容；服务端会再次校验快照、期限和并发修改。";
    case "unsafe":
      return timeKnown
        ? "请检查备份或服务端记录，不要凭 ID 或标题猜测恢复内容。"
        : "不要依据无法判断的本地期限撤销；请检查服务端记录或备份。";
    case "unknown":
      return "刷新后仍未显示已撤销时，保留此标记并人工核对；确认前不要重复发送。";
    case "in-progress":
      return "这次撤销可能已部分完成；请先核对目标条目、候选队列和备份，确认后再继续。";
    case "expired":
      return "服务端会按记录时间拒绝超过 24 小时的撤销。";
    case "undone":
      return "这次合并已经撤销，无需再次操作。";
  }
}

export function buildMergeUndoPreview(
  entry: MergeJournal,
  options: { now?: number; unknownSince?: string } = {},
): MergeUndoPreview {
  const now = options.now ?? Date.now();
  const info = describeMergeAction(entry.action);
  const missing: string[] = [];

  const candidate = readSnapshot(entry.before?.queue, "候选 before.queue", missing);
  const targetBefore = readSnapshot(entry.before?.target, "目标 before.target", []);
  const targetAfter = readSnapshot(entry.after?.target, "目标 after.target", []);
  const created = readSnapshot(entry.after?.item, "本次新建条目 after.item", []);

  if (info.requiresTarget) {
    if (!targetBefore) missing.push("目标 before.target");
    if (!targetAfter) missing.push("目标 after.target");
  }
  if (targetBefore && !targetAfter) {
    missing.push("目标 after.target（before.target 存在，缺少对应快照）");
  }
  if (info.archivesCreated && !created) {
    missing.push("本次新建条目 after.item");
  }
  if (entry.after?.itemID && !created) {
    missing.push("after.item（after.itemID 存在但缺少快照）");
  }
  if (!targetAfter && !created) {
    missing.push("after.target 或 after.item");
  }
  if (!info.known) {
    missing.push("动作");
  }

  const uniqueMissing = Array.from(new Set(missing));
  const safe = uniqueMissing.length === 0;
  const restoresTarget =
    safe &&
    info.restoresTarget &&
    targetBefore !== null &&
    targetAfter !== null;
  const archivesCreated = safe && info.archivesCreated && created !== null;

  const effects: string[] = [];
  if (safe) {
    if (restoresTarget && targetBefore) {
      effects.push(`恢复目标条目「${targetBefore.title}」到操作前内容`);
    }
    if (archivesCreated && created) {
      effects.push(`归档本次新建条目「${created.title}」`);
    }
    if (candidate) {
      effects.push(`候选「${candidate.title}」回到审批队列`);
    }
  }

  const parsedAt = Date.parse(entry.at);
  const timeKnown = Number.isFinite(parsedAt);
  const expiresAt = timeKnown
    ? new Date(parsedAt + WINDOW_MS).toISOString()
    : null;
  const rawRemaining = expiresAt === null ? null : Date.parse(expiresAt) - now;
  const remainingMs = rawRemaining === null ? null : Math.max(0, rawRemaining);

  let status: MergeUndoStatus;
  if (entry.undone) status = "undone";
  else if (!safe) status = "unsafe";
  else if (entry.undoing) status = "in-progress";
  else if (options.unknownSince) status = "unknown";
  else if (!timeKnown) status = "unsafe";
  else if (rawRemaining !== null && rawRemaining < 0) status = "expired";
  else status = "undoable";

  const canResume =
    status === "in-progress" && safe && options.unknownSince === undefined;
  const statusLabel =
    status === "undoable"
      ? "可撤销"
      : status === "expired"
        ? "已过期"
        : status === "undone"
          ? "已撤销"
          : status === "in-progress"
            ? "撤销未完成"
            : status === "unsafe"
              ? timeKnown
                ? "不可安全预览"
                : "时间未知"
              : "状态未知";

  return {
    id: entry.id,
    at: entry.at,
    action: entry.action,
    actionLabel: info.label,
    actionMeaning: info.meaning,
    candidate,
    targetBefore,
    targetAfter,
    created,
    restoresTarget,
    archivesCreated,
    effects,
    summary: safe ? effects.join("；") : "缺少完整快照，无法安全预览恢复/归档对象",
    safe,
    missing: uniqueMissing,
    expiresAt,
    remainingMs,
    timeKnown,
    deadline: deadlineText(status, remainingMs, timeKnown),
    hint: hintText(status, timeKnown),
    status,
    statusLabel,
    canUndo: status === "undoable",
    canResume,
    ...(options.unknownSince ? { unknownSince: options.unknownSince } : {}),
  };
}

export interface MergeUndoLockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type MergeUndoLockPersistence = "available" | "unavailable";

export interface MergeUndoLockLoad {
  locks: MergeUndoLocks;
  persistence: MergeUndoLockPersistence;
}

const PROBE_KEY = "openmem.mergeUndoUnknown.probe";

/**
 * Read persisted markers without pretending storage works. A storage that
 * accepts reads but rejects writes is reported unavailable, because a new
 * unknown marker would not survive a full page reload there.
 */
export function loadMergeUndoLocks(
  storage: MergeUndoLockStorage | undefined,
): MergeUndoLockLoad {
  if (!storage) return { locks: {}, persistence: "unavailable" };
  let raw: string | null;
  try {
    raw = storage.getItem(MERGE_UNDO_LOCKS_KEY);
  } catch {
    return { locks: {}, persistence: "unavailable" };
  }
  const locks = parseMergeUndoLocks(raw);
  try {
    storage.setItem(PROBE_KEY, "1");
    storage.removeItem(PROBE_KEY);
    return { locks, persistence: "available" };
  } catch {
    return { locks, persistence: "unavailable" };
  }
}

export function saveMergeUndoLocks(
  storage: MergeUndoLockStorage | undefined,
  locks: MergeUndoLocks,
): MergeUndoLockPersistence {
  if (!storage) return "unavailable";
  try {
    if (Object.keys(locks).length === 0) {
      storage.removeItem(MERGE_UNDO_LOCKS_KEY);
    } else {
      storage.setItem(MERGE_UNDO_LOCKS_KEY, serializeMergeUndoLocks(locks));
    }
    return "available";
  } catch {
    return "unavailable";
  }
}

/**
 * Merge stored and session markers without dropping what a read-only storage
 * could still return. A tombstone records an explicit unlock made in this page
 * session, so an older stored copy cannot quietly come back after a remount.
 * A fresh session marker for the same id wins over the tombstone.
 */
export function resolveMergeUndoLocks(
  load: MergeUndoLockLoad,
  sessionLocks: MergeUndoLocks,
  tombstones: ReadonlySet<string> = new Set(),
): MergeUndoLocks {
  const merged: MergeUndoLocks = { ...load.locks, ...sessionLocks };
  for (const id of tombstones) {
    if (!(id in sessionLocks)) delete merged[id];
  }
  return merged;
}

export function shouldWarnBeforeUnload(
  unknownCount: number,
  persistence: MergeUndoLockPersistence,
): boolean {
  return unknownCount > 0 && persistence === "unavailable";
}

export type MergeJournalLoadState = "loading" | "ready" | "failed";

/** Clearing older markers needs a successfully loaded journal list. */
export function canClearUnknownLocks(state: MergeJournalLoadState): boolean {
  return state === "ready";
}

export interface LoadRequestGate {
  latest: number;
  mounted: boolean;
}

export function createLoadRequestGate(): LoadRequestGate {
  return { latest: 0, mounted: true };
}

/** Start a fresh generation; every older in-flight request becomes stale. */
export function startLoadRequest(gate: LoadRequestGate): number {
  gate.latest += 1;
  return gate.latest;
}

/** Only the newest request, while mounted, may write state or reconcile locks. */
export function canApplyLoadRequest(
  gate: LoadRequestGate,
  requestID: number,
): boolean {
  return gate.mounted && requestID === gate.latest;
}

/** Invalidate in-flight requests on unmount without touching leave warnings. */
export function invalidateLoadRequests(gate: LoadRequestGate): void {
  gate.mounted = false;
  gate.latest += 1;
}

export interface MergeUndoLeaveEvent {
  preventDefault(): void;
  returnValue?: unknown;
}

export type MergeUndoLeaveListener = (event: MergeUndoLeaveEvent) => void;

export interface MergeUndoLeaveTarget {
  addEventListener(type: "beforeunload", listener: MergeUndoLeaveListener): void;
  removeEventListener(type: "beforeunload", listener: MergeUndoLeaveListener): void;
}

let leaveWarningTarget: MergeUndoLeaveTarget | undefined;
let leaveWarningListener: MergeUndoLeaveListener | undefined;

/**
 * Session-level beforeunload guard. It intentionally lives outside React so a
 * Health unmount does not cancel the warning while unsaved unknown markers
 * still exist. Calling with zero markers or working persistence removes it.
 */
export function syncMergeUndoLeaveWarning(
  target: MergeUndoLeaveTarget | undefined,
  unknownCount: number,
  persistence: MergeUndoLockPersistence,
): void {
  const shouldWarn = shouldWarnBeforeUnload(unknownCount, persistence);
  if (
    leaveWarningListener &&
    leaveWarningTarget &&
    (leaveWarningTarget !== target || !shouldWarn || !target)
  ) {
    leaveWarningTarget.removeEventListener("beforeunload", leaveWarningListener);
    leaveWarningTarget = undefined;
    leaveWarningListener = undefined;
  }
  if (shouldWarn && target && !leaveWarningListener) {
    const listener: MergeUndoLeaveListener = (event) => {
      event.preventDefault();
      event.returnValue = UNSAVED_UNKNOWN_LEAVE_NOTICE;
    };
    target.addEventListener("beforeunload", listener);
    leaveWarningTarget = target;
    leaveWarningListener = listener;
  }
}

export function lockMergeUndoUnknown(
  locks: MergeUndoLocks,
  journalID: string,
  at: string,
): MergeUndoLocks {
  if (locks[journalID]) return locks;
  return { ...locks, [journalID]: at };
}

export function unlockMergeUndoUnknown(
  locks: MergeUndoLocks,
  journalID: string,
): MergeUndoLocks {
  if (!(journalID in locks)) return locks;
  const next = { ...locks };
  delete next[journalID];
  return next;
}

/**
 * A refresh only proves that an undo happened when the journal says `undone`.
 * A still-pending entry, a missing entry (older than the returned page) or a
 * failed refresh is not proof that the write did not commit, so its lock stays.
 */
export function reconcileMergeUndoUnknown(
  locks: MergeUndoLocks,
  journals: MergeJournal[],
): MergeUndoLocks {
  const confirmed = new Set(
    journals.filter((entry) => entry.undone === true).map((entry) => entry.id),
  );
  let changed = false;
  const next = { ...locks };
  for (const id of Object.keys(next)) {
    if (confirmed.has(id)) {
      delete next[id];
      changed = true;
    }
  }
  return changed ? next : locks;
}

export function parseMergeUndoLocks(raw: string | null): MergeUndoLocks {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const locks: MergeUndoLocks = {};
  for (const [id, at] of Object.entries(value)) {
    if (id && typeof at === "string" && at.trim() !== "") {
      locks[id] = at;
    }
  }
  return locks;
}

export function serializeMergeUndoLocks(locks: MergeUndoLocks): string {
  return JSON.stringify(locks);
}

export function isUnknownOutcome(error: unknown): boolean {
  return error instanceof ApiError && error.code === "OPENMEM_OUTCOME_UNKNOWN";
}
