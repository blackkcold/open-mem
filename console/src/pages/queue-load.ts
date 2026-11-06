export type QueueLoadState = "loading" | "ready" | "error" | "stale";

export interface QueueLoadInput {
  loading: boolean;
  error: boolean;
  /** True after at least one successful load in this mount. */
  hasLoaded: boolean;
  itemCount: number;
  hasFilters: boolean;
  lastLoadedAt?: string;
  /** Preformatted local time, so this module stays deterministic in tests. */
  lastLoadedLabel?: string;
}

export interface QueueLoadModel {
  state: QueueLoadState;
  writesBlocked: boolean;
  message: string;
  /** Show the "queue is empty" copy only for a successful, unfiltered load. */
  showEmptyQueue: boolean;
  showFilteredEmpty: boolean;
  canRetry: boolean;
}

/**
 * One pure state machine for the queue page. A failed first load must never be
 * rendered as "the queue is empty", and a failed refresh keeps the last good
 * list visible while writes stay paused.
 */
export function queueLoadModel(input: QueueLoadInput): QueueLoadModel {
  const { loading, error, hasLoaded, itemCount, hasFilters } = input;

  if (loading) {
    return {
      state: "loading",
      writesBlocked: true,
      message: hasLoaded ? "正在更新队列…" : "正在加载队列…",
      showEmptyQueue: false,
      showFilteredEmpty: false,
      canRetry: false,
    };
  }

  if (error && !hasLoaded) {
    return {
      state: "error",
      writesBlocked: true,
      message: "队列加载失败。未显示为空；请重试。",
      showEmptyQueue: false,
      showFilteredEmpty: false,
      canRetry: true,
    };
  }

  if (error) {
    const when = input.lastLoadedLabel ? `（${input.lastLoadedLabel}）` : "";
    return {
      state: "stale",
      writesBlocked: true,
      message: `显示的是上次成功加载的数据${when}。刷新失败，写入已暂停。`,
      showEmptyQueue: false,
      showFilteredEmpty: false,
      canRetry: true,
    };
  }

  if (itemCount === 0 && hasFilters) {
    return {
      state: "ready",
      writesBlocked: false,
      message: "没有符合当前筛选的候选。",
      showEmptyQueue: false,
      showFilteredEmpty: true,
      canRetry: false,
    };
  }

  if (itemCount === 0) {
    return {
      state: "ready",
      writesBlocked: false,
      message: "队列为空。",
      showEmptyQueue: true,
      showFilteredEmpty: false,
      canRetry: false,
    };
  }

  return {
    state: "ready",
    writesBlocked: false,
    message: `当前显示 ${itemCount} 条候选`,
    showEmptyQueue: false,
    showFilteredEmpty: false,
    canRetry: false,
  };
}

/** Baseline copy: never let an unindexed or partial index read as "not covered". */
export function baselineBanner(input: {
  state: string;
  filesSeen?: number;
  filesIndexed?: number;
  truncatedFiles?: number;
  builtAt?: string;
  projectKey?: string;
  itemProjectKey?: string;
  projectCoverageState?: string;
  errors?: number;
}): { tone: "warning" | "error" | "info" | "none"; message: string } {
  const {
    state,
    filesSeen = 0,
    filesIndexed = 0,
    truncatedFiles = 0,
    builtAt,
    projectKey,
    itemProjectKey,
    projectCoverageState,
    errors = 0,
  } = input;
  if (projectKey && itemProjectKey && projectKey !== itemProjectKey) {
    return {
      tone: "info",
      message: "该项目基线未索引；未匹配不等于未覆盖。",
    };
  }
  if (projectCoverageState === "empty") {
    return {
      tone: "info",
      message: "该项目基线未索引；未匹配不等于未覆盖。",
    };
  }
  if (projectCoverageState === "not-configured") {
    return {
      tone: "info",
      message: "项目基线未配置；未匹配不等于未覆盖。",
    };
  }
  if (state === "unconfigured") {
    return { tone: "info", message: "基线未配置；未匹配不等于未覆盖。" };
  }
  if (state === "empty") {
    return { tone: "info", message: "基线为空；未匹配不等于未覆盖。" };
  }
  if (state === "stale") {
    return {
      tone: "warning",
      message: `基线索引已过期${builtAt ? `（${builtAt}）` : ""}；覆盖判断可能不完整。`,
    };
  }
  if (state === "partial") {
    if (errors > 0) {
      return {
        tone: "warning",
        message: `基线部分目录或文件无法读取（${errors} 处）；覆盖判断可能不完整，未匹配不等于未覆盖。`,
      };
    }
    const truncated = truncatedFiles > 0 ? `，${truncatedFiles} 个文件被截断` : "";
    return {
      tone: "warning",
      message: `基线仅索引 ${filesIndexed}/${filesSeen} 个文件${truncated}；未匹配不等于未覆盖。`,
    };
  }
  if (state === "error") {
    return { tone: "error", message: "基线读取失败；覆盖判断不可用。" };
  }
  return { tone: "none", message: "" };
}
