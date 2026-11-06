/**
 * Pure helpers for the queue batch flow.
 *
 * Two rules drive everything here:
 * 1. Fail closed: if the server preview cannot prove exactly which items will
 *    run, the console must not submit anything.
 * 2. Honest results: skipped and capped items are not failures, a missing or
 *    duplicated result is unknown (never success, never a safe retry), and a
 *    thrown request that cannot prove non-submission is unknown too.
 */

export interface BatchPreviewItem {
  id: string;
  title: string;
  action: string;
  confidence: number;
  projectKey: string;
  proposedTitle: string;
  proposedText: string;
}

export interface BatchPreviewExclusion {
  id: string;
  title?: string;
  reason: string;
}

export interface BatchPreview {
  previewID: string;
  eligible: BatchPreviewItem[];
  skipped: number;
  capped: number;
  skippedItems: BatchPreviewExclusion[];
  cappedItems: BatchPreviewExclusion[];
}

export type BatchPreviewParse =
  | { ok: true; preview: BatchPreview }
  | { ok: false; reason: string };

export interface BatchResultEntry {
  id: string;
  ok: boolean;
  error?: string;
}

export interface BatchRequestScope {
  ids: string[];
  previewID?: string;
  skipped?: BatchPreviewExclusion[];
  capped?: BatchPreviewExclusion[];
}

export type BatchResultStatus = "ok" | "partial" | "failed" | "unknown";

export interface BatchResultReport {
  status: BatchResultStatus;
  succeeded: string[];
  failed: Array<{ id: string; error?: string }>;
  /** Requested items whose final state could not be proven. */
  unresolved: string[];
  /** Failed items only; skipped, capped and unknown items are never included. */
  retryIds: string[];
  skipped: BatchPreviewExclusion[];
  capped: BatchPreviewExclusion[];
  message: string;
  error: string;
  /** True when the console cannot prove the final state and a refresh is required. */
  needsRefresh: boolean;
}

export const BATCH_PREVIEW_REJECTED = "BATCH_PREVIEW_REJECTED";

/**
 * Only the server's explicit pre-execution rejection proves nothing was
 * written. Every other failure (timeout, lost response, generic 4xx) stays
 * unknown so the UI cannot invite a blind replay.
 */
export function classifyBatchSubmitFailure(
  code: string | undefined,
): "not-submitted" | "unknown" {
  return code === BATCH_PREVIEW_REJECTED ? "not-submitted" : "unknown";
}

/** Compact but distinguishable id clue for rows sharing a title. */
export function shortItemID(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export interface BatchExecutionPayload {
  previewID: string;
  ids: string[];
  action: "apply_suggestion";
  dryRun: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseExclusions(
  raw: unknown,
  label: string,
): { ok: true; items: BatchPreviewExclusion[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: `${label}明细缺失` };
  const items: BatchPreviewExclusion[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return { ok: false, reason: `${label}明细格式无效` };
    if (!nonEmptyString(entry.id)) {
      return { ok: false, reason: `${label}明细缺少 id` };
    }
    if (!nonEmptyString(entry.reason)) {
      return { ok: false, reason: `${label}明细 ${entry.id} 缺少原因` };
    }
    if (entry.title !== undefined && typeof entry.title !== "string") {
      return { ok: false, reason: `${label}明细 ${entry.id} 标题格式无效` };
    }
    const item: BatchPreviewExclusion = { id: entry.id, reason: entry.reason };
    if (typeof entry.title === "string") item.title = entry.title;
    items.push(item);
  }
  return { ok: true, items };
}

/**
 * Validate a dry-run response against the exact ids the user asked to run.
 * Anything the confirmation screen cannot show item by item is a hard failure:
 * executing on a partial, duplicated or widened preview would run items the
 * user never saw. Every requested id must appear exactly once across
 * eligible + skipped + capped, and nothing else may appear.
 */
export function parseBatchPreview(
  raw: unknown,
  requestedIDs: string[],
): BatchPreviewParse {
  if (!isRecord(raw)) return { ok: false, reason: "预览响应格式无效" };
  if (raw.dryRun !== true) return { ok: false, reason: "服务端未返回 dryRun 预览" };
  if (!nonEmptyString(raw.previewID)) {
    return { ok: false, reason: "预览缺少 previewID，无法绑定执行清单" };
  }
  const requested = new Set<string>();
  for (const id of requestedIDs) {
    if (!nonEmptyString(id)) return { ok: false, reason: "请求 ID 清单无效" };
    if (requested.has(id)) {
      return { ok: false, reason: `请求 ID 存在重复：${id}` };
    }
    requested.add(id);
  }
  if (!Array.isArray(raw.eligible)) {
    return { ok: false, reason: "预览缺少 eligible 清单" };
  }
  const eligible: BatchPreviewItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw.eligible) {
    if (!isRecord(entry)) return { ok: false, reason: "eligible 条目格式无效" };
    if (!nonEmptyString(entry.id)) {
      return { ok: false, reason: "eligible 条目缺少 id" };
    }
    if (seen.has(entry.id)) {
      return { ok: false, reason: `eligible 存在重复 id：${entry.id}` };
    }
    seen.add(entry.id);
    if (!nonEmptyString(entry.title)) {
      return { ok: false, reason: `eligible 条目 ${entry.id} 缺少标题` };
    }
    if (!nonEmptyString(entry.action)) {
      return { ok: false, reason: `eligible 条目 ${entry.id} 缺少动作` };
    }
    if (!nonEmptyString(entry.projectKey)) {
      return { ok: false, reason: `eligible 条目 ${entry.id} 缺少 projectKey` };
    }
    if (!nonEmptyString(entry.proposedTitle)) {
      return { ok: false, reason: `eligible 条目 ${entry.id} 缺少 proposedTitle` };
    }
    if (!nonEmptyString(entry.proposedText)) {
      return { ok: false, reason: `eligible 条目 ${entry.id} 缺少 proposedText` };
    }
    if (
      typeof entry.confidence !== "number" ||
      !Number.isFinite(entry.confidence) ||
      entry.confidence < 0 ||
      entry.confidence > 1
    ) {
      return { ok: false, reason: `eligible 条目 ${entry.id} 的 confidence 无效` };
    }
    eligible.push({
      id: entry.id,
      title: entry.title,
      action: entry.action,
      confidence: entry.confidence,
      projectKey: entry.projectKey,
      proposedTitle: entry.proposedTitle,
      proposedText: entry.proposedText,
    });
  }

  if (!isCount(raw.skipped)) return { ok: false, reason: "预览缺少有效的跳过计数" };
  if (!isCount(raw.capped)) return { ok: false, reason: "预览缺少有效的超限计数" };

  const skipped = parseExclusions(raw.skippedItems, "跳过");
  if (!skipped.ok) return skipped;
  const capped = parseExclusions(raw.cappedItems, "超限");
  if (!capped.ok) return capped;

  if (skipped.items.length !== raw.skipped) {
    return { ok: false, reason: "跳过明细数量与跳过计数不一致" };
  }
  if (capped.items.length !== raw.capped) {
    return { ok: false, reason: "超限明细数量与超限计数不一致" };
  }
  for (const item of [...skipped.items, ...capped.items]) {
    if (seen.has(item.id)) {
      return { ok: false, reason: `跳过/超限明细存在重复 ID：${item.id}` };
    }
    seen.add(item.id);
  }
  const missing = requestedIDs.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    return { ok: false, reason: `预览遗漏了请求中的条目：${missing.join(", ")}` };
  }
  const extra = [...seen].filter((id) => !requested.has(id));
  if (extra.length > 0) {
    return { ok: false, reason: `预览包含请求之外的条目：${extra.join(", ")}` };
  }

  return {
    ok: true,
    preview: {
      previewID: raw.previewID,
      eligible,
      skipped: raw.skipped,
      capped: raw.capped,
      skippedItems: skipped.items,
      cappedItems: capped.items,
    },
  };
}

/**
 * Build the execution body from the confirmed preview. The id list is the
 * preview's own list, unchanged and in order, and the preview id binds it.
 */
export function buildBatchExecution(preview: BatchPreview): BatchExecutionPayload {
  return {
    previewID: preview.previewID,
    ids: preview.eligible.map((entry) => entry.id),
    action: "apply_suggestion",
    dryRun: false,
  };
}

export type BatchResultsParse =
  | { ok: true; results: BatchResultEntry[] }
  | { ok: false; reason: string };

/**
 * Validate the execution response. A malformed result list proves nothing about
 * the batch, so the caller must treat it as an unknown submission.
 */
export function parseBatchResults(raw: unknown): BatchResultsParse {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "服务端没有返回 results 结果清单" };
  }
  const results: BatchResultEntry[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return { ok: false, reason: "results 条目格式无效" };
    if (!nonEmptyString(entry.id)) {
      return { ok: false, reason: "results 条目缺少 id" };
    }
    if (typeof entry.ok !== "boolean") {
      return { ok: false, reason: `results 条目 ${entry.id} 缺少有效的 ok 结果` };
    }
    if (entry.error !== undefined && typeof entry.error !== "string") {
      return { ok: false, reason: `results 条目 ${entry.id} 的错误信息格式无效` };
    }
    const result: BatchResultEntry = { id: entry.id, ok: entry.ok };
    if (typeof entry.error === "string") result.error = entry.error;
    results.push(result);
  }
  return { ok: true, results };
}

function countDuplicateIds(results: BatchResultEntry[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of results) {
    if (seen.has(entry.id)) duplicates.add(entry.id);
    else seen.add(entry.id);
  }
  return duplicates;
}

/**
 * Summarize a batch response against the confirmed request. Every requested id
 * lands in exactly one bucket: succeeded, failed, or unresolved (unknown).
 * Results for ids outside the request are ignored.
 */
export function summarizeBatchResults(
  scope: BatchRequestScope,
  results: BatchResultEntry[],
): BatchResultReport {
  const duplicates = countDuplicateIds(results);
  const byId = new Map<string, BatchResultEntry>();
  for (const entry of results) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }

  const succeeded: string[] = [];
  const failed: Array<{ id: string; error?: string }> = [];
  const unresolved: string[] = [];
  for (const id of scope.ids) {
    const entry = byId.get(id);
    if (!entry || duplicates.has(id)) unresolved.push(id);
    else if (entry.ok) succeeded.push(id);
    else failed.push({ id, error: entry.error });
  }

  const retryIds = failed.map((entry) => entry.id);
  const skipped = scope.skipped ?? [];
  const capped = scope.capped ?? [];
  const needsRefresh = unresolved.length > 0;
  const status: BatchResultStatus = needsRefresh
    ? "unknown"
    : failed.length > 0
      ? succeeded.length > 0
        ? "partial"
        : "failed"
      : "ok";

  const parts = [`成功 ${succeeded.length} 条`];
  if (failed.length > 0) parts.push(`失败 ${failed.length} 条`);
  if (unresolved.length > 0) parts.push(`未返回 ${unresolved.length} 条（状态未知）`);
  if (skipped.length > 0) parts.push(`跳过 ${skipped.length} 条`);
  if (capped.length > 0) parts.push(`超限 ${capped.length} 条`);

  const details = [
    ...failed.map((entry) =>
      entry.error ? `${entry.id}: ${entry.error}` : `${entry.id}: 处理失败`,
    ),
    ...unresolved.map((id) =>
      duplicates.has(id)
        ? `${id}: 返回了重复结果，状态未知；请刷新队列核对后再决定是否重新提交`
        : `${id}: 未返回处理结果，状态未知；请刷新队列核对后再决定是否重新提交`,
    ),
  ];

  return {
    status,
    succeeded,
    failed,
    unresolved,
    retryIds,
    skipped,
    capped,
    message: `${parts.join("，")}。`,
    error: details.join("; "),
    needsRefresh,
  };
}

/**
 * A thrown request only proves the response was lost. The server may or may not
 * have executed it, so the only safe instruction is to refresh and compare.
 */
export function unknownSubmissionReport(
  scope: BatchRequestScope,
  reason: string,
): BatchResultReport {
  const unresolved = [...scope.ids];
  const detail = reason.trim() || "请求未返回结果";
  return {
    status: "unknown",
    succeeded: [],
    failed: [],
    unresolved,
    retryIds: [],
    skipped: scope.skipped ?? [],
    capped: scope.capped ?? [],
    message:
      `提交状态未知：请求中断，无法确认服务端是否已执行（${unresolved.length} 条）。` +
      "请先刷新队列核对结果；在核对完成前不要重新提交。",
    error: `${detail}；提交状态未知，请刷新队列核对。`,
    needsRefresh: true,
  };
}
