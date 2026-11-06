/**
 * Conservative triage presentation helpers for the approval queue.
 *
 * Rules:
 * - Real hook statuses only; a missing hook list is unknown, never a zero.
 * - `ReviewRecord.queued` counts hooks created after accept, not queue
 *   admissions, so it is labelled as generated candidates.
 * - Duplicate/merge clues come only from stored decision/jev/suggestion
 *   fields. No text similarity is computed here.
 */

export const TURN_STATUSES = [
  "blocked",
  "pending",
  "processing",
  "queue",
  "auto",
  "shadow",
  "ignored",
  "failed",
] as const;

export type TurnStatus = (typeof TURN_STATUSES)[number];

export const TURN_STATUS_LABEL: Record<TurnStatus, string> = {
  blocked: "阻塞",
  pending: "待处理",
  processing: "处理中",
  queue: "审批队列",
  auto: "自动",
  shadow: "Shadow",
  ignored: "忽略",
  failed: "失败",
};

export interface TurnStatusEntry {
  status: TurnStatus;
  label: string;
  /** null means the data cannot prove the count (old or missing hooks). */
  count: number | null;
}

export interface TurnHooksView {
  hasHooks: boolean;
  captured: number | null;
  entries: TurnStatusEntry[];
  unrecognized: number;
  note: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

export function summarizeTurnHooks(
  turn: { hooks?: unknown; counts?: unknown } | null | undefined,
): TurnHooksView {
  const counts = isRecord(turn?.counts) ? turn.counts : undefined;
  const declaredCaptured = countOf(counts?.captured);
  const hooks = Array.isArray(turn?.hooks) ? turn.hooks : null;

  if (!hooks) {
    return {
      hasHooks: false,
      captured: declaredCaptured,
      entries: TURN_STATUSES.map((status) => ({
        status,
        label: TURN_STATUS_LABEL[status],
        count: null,
      })),
      unrecognized: 0,
      note: "该 turn 缺少逐条 hook 状态（旧版数据），blocked/ignored 等状态未知，无法区分。",
    };
  }

  const tally = new Map<string, number>();
  for (const hook of hooks) {
    const status = isRecord(hook) && typeof hook.status === "string" ? hook.status : "";
    tally.set(status, (tally.get(status) ?? 0) + 1);
  }
  const entries = TURN_STATUSES.map((status) => ({
    status,
    label: TURN_STATUS_LABEL[status],
    count: tally.get(status) ?? 0,
  }));
  const unrecognized = [...tally.entries()]
    .filter(([status]) => !(TURN_STATUSES as readonly string[]).includes(status))
    .reduce((sum, [, count]) => sum + count, 0);

  return {
    hasHooks: true,
    captured: declaredCaptured ?? hooks.length,
    entries,
    unrecognized,
    note: unrecognized > 0 ? `有 ${unrecognized} 条 hook 状态未识别，未计入分类。` : "",
  };
}

export interface ReviewCountSegment {
  label: string;
  value: number | null;
}

export interface ReviewCountsView {
  hooksCreated: number | null;
  queuedKnown: boolean;
  candidates: number | null;
  dropped: number | null;
  skipped: number | null;
  segments: ReviewCountSegment[];
  note: string;
}

export function reviewCountsView(input: {
  queued?: unknown;
  candidates?: unknown;
  dropped?: unknown;
  chars?: unknown;
}): ReviewCountsView {
  const hooksCreated = countOf(input.queued);
  const candidates = countOf(input.candidates);
  const dropped = countOf(input.dropped);
  const chars = countOf(input.chars);
  const skipped =
    hooksCreated !== null &&
    candidates !== null &&
    dropped !== null &&
    candidates >= hooksCreated + dropped
      ? candidates - hooksCreated - dropped
      : null;

  const segments: ReviewCountSegment[] = [
    { label: "生成候选", value: hooksCreated },
    { label: "提取", value: candidates },
    { label: "丢弃", value: dropped },
    { label: "跳过", value: skipped },
  ];
  if (chars !== null) segments.push({ label: "字", value: chars });

  return {
    hooksCreated,
    queuedKnown: hooksCreated !== null,
    candidates,
    dropped,
    skipped,
    segments,
    note: "「生成候选」是 accept 后创建的 hook 数，后续仍可能被容量或去重挡下，未必进入审批队列。",
  };
}

export type ClueSource = "decision" | "jev" | "suggestion" | "none";

export interface DuplicateClue {
  source: "decision" | "jev" | "suggestion";
  kind:
    | "merge_action"
    | "target_id"
    | "duplicate_score"
    | "suggestion_action"
    | "suggestion_target"
    | "suggestion_confidence";
  text: string;
}

export interface DuplicateClueView {
  available: boolean;
  source: ClueSource;
  duplicateScore: number | null;
  mergeAction: string | null;
  mergeTargetId: string | null;
  suggestionAction: string | null;
  suggestionTargetId: string | null;
  suggestionTargetTitle: string | null;
  suggestionConfidence: number | null;
  clues: DuplicateClue[];
  /** Stored machine judgement, not a verified fact. */
  label: string;
  emptyText: string;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function scoreOf(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 1
    ? value
    : null;
}

export function describeDuplicateClues(
  item: { decision?: unknown; jev?: unknown; suggestion?: unknown } | null | undefined,
): DuplicateClueView {
  const decision = isRecord(item?.decision) ? item.decision : undefined;
  const legacy = isRecord(item?.jev) ? item.jev : undefined;
  const assessment = decision ?? legacy;
  const suggestion = isRecord(item?.suggestion) ? item.suggestion : undefined;
  const assessmentSource: "decision" | "jev" | undefined = decision
    ? "decision"
    : legacy
      ? "jev"
      : undefined;

  const duplicateScore = scoreOf(assessment?.duplicate);
  const mergeAction = textOf(assessment?.mergeAction);
  const mergeTargetId = textOf(assessment?.mergeTargetId);
  const suggestionAction = textOf(suggestion?.action);
  const suggestionTargetId = textOf(suggestion?.targetId);
  const suggestionTargetTitle = textOf(suggestion?.targetTitle);
  const suggestionConfidence = scoreOf(suggestion?.confidence);

  const clues: DuplicateClue[] = [];
  if (assessmentSource && duplicateScore !== null) {
    clues.push({
      source: assessmentSource,
      kind: "duplicate_score",
      text: `重复评分 ${Math.round(duplicateScore * 100)}%（系统判断，不是事实）`,
    });
  }
  if (assessmentSource && mergeAction !== null) {
    clues.push({
      source: assessmentSource,
      kind: "merge_action",
      text: `已记录合并动作：${mergeAction}`,
    });
  }
  if (assessmentSource && mergeTargetId !== null) {
    clues.push({
      source: assessmentSource,
      kind: "target_id",
      text: `目标 ID：${mergeTargetId}（未记录目标标题，可能为旧数据）`,
    });
  }
  if (suggestionAction !== null) {
    clues.push({
      source: "suggestion",
      kind: "suggestion_action",
      text: `建议动作：${suggestionAction}`,
    });
  }
  if (suggestionTargetId !== null || suggestionTargetTitle !== null) {
    const title = suggestionTargetTitle ?? "未记录目标标题，可能为旧数据";
    const id = suggestionTargetId ? `（ID：${suggestionTargetId}）` : "";
    clues.push({
      source: "suggestion",
      kind: "suggestion_target",
      text: `建议目标：${title}${id}`,
    });
  }
  if (suggestionConfidence !== null) {
    clues.push({
      source: "suggestion",
      kind: "suggestion_confidence",
      text: `建议集中度 ${Math.round(suggestionConfidence * 100)}%（系统判断）`,
    });
  }

  const source: ClueSource = assessmentSource ?? (suggestion ? "suggestion" : "none");

  return {
    available: clues.length > 0,
    source,
    duplicateScore,
    mergeAction,
    mergeTargetId,
    suggestionAction,
    suggestionTargetId,
    suggestionTargetTitle,
    suggestionConfidence,
    clues,
    label: "系统判断",
    emptyText: "未标注",
  };
}

export interface QueueScopeView {
  visible: number;
  visibleLabel: string;
  global: number | null;
  globalKnown: boolean;
  globalLabel: string;
}

export type QueueOriginFilter = "" | "turn" | "session-review";

export interface QueueFilterState {
  kind: string;
  scope: string;
  projectKey: string;
  originFilter: QueueOriginFilter;
  query: string;
  queryInput: string;
}

/** Every filter field, so clearing cannot silently leave one behind. */
export function emptyQueueFilters(): QueueFilterState {
  return {
    kind: "",
    scope: "",
    projectKey: "",
    originFilter: "",
    query: "",
    queryInput: "",
  };
}

export function anyQueueFilterActive(filters: QueueFilterState): boolean {
  return Boolean(
    filters.kind ||
      filters.scope ||
      filters.projectKey ||
      filters.originFilter ||
      filters.query,
  );
}

/** Keep the filtered page count separate from the global queue metric. */
export function queueScopeView(
  visibleCount: unknown,
  metricsQueue: unknown,
  filterActive: boolean,
): QueueScopeView {
  const global = countOf(metricsQueue);
  return {
    visible: countOf(visibleCount) ?? 0,
    visibleLabel: filterActive ? "当前筛选" : "当前列表",
    global,
    globalKnown: global !== null,
    globalLabel: "全部待审",
  };
}
