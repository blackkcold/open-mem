import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  conflictFromError,
  fetchItemChanges,
  fetchMemoryItems,
  fetchRecall,
  formatAge,
  postItemAction,
} from "../api";
import type {
  AutomationStatus,
  ChangeEvent,
  Health,
  MemoryItem,
  Metrics,
  RecallResult,
} from "../types";
import {
  activityEventLink,
  memoryItemLink,
} from "./audit-links";
import {
  EMPTY_MEMORY_FILTERS,
  KIND_LABEL,
  SCOPE_LABEL,
  SEGMENT_LABEL,
  SOURCE_LABEL,
  canRestore,
  canRevert,
  canStop,
  changeLabel,
  countAria,
  countLabel,
  evidenceSummary,
  filterCountLabel,
  filterItems,
  itemProjectLabel,
  projectLabel,
  segmentCounts,
  segmentOf,
  shortID,
  sourceKindOf,
  sourceText,
  statusTextOf,
} from "./memory-model";
import type { MemoryFilters, MemorySegment } from "./memory-model";
import {
  addItemActionLock,
  isActionLocked,
  unknownLockFor,
  unknownOutcomeChanged,
  unlockUnknownLocks,
  useItemActionLocks,
} from "./item-action-locks";
import { axisChips } from "./status-model";

interface Props {
  refreshKey: number;
  health?: Health;
  metrics?: Metrics;
  automation?: AutomationStatus;
  /** Route target from #memory/<id>. */
  itemID?: string;
  /** Trusted extension host session id; undefined in standalone or before ready. */
  sessionID?: string;
  /** Shared item-action lock scope derived from the server identity. */
  lockScope?: string;
  onChanged: () => void;
}

type Feedback = {
  kind: "stopped" | "restored" | "reverted" | "version";
  id: string;
  title: string;
  changeID?: string;
};

const SEGMENTS: MemorySegment[] = ["active", "session", "stopped", "expired", "all"];

export function MemoryPage({
  refreshKey,
  health,
  metrics,
  automation,
  itemID,
  sessionID,
  lockScope,
  onChanged,
}: Props) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filters, setFilters] = useState<MemoryFilters>(EMPTY_MEMORY_FILTERS);
  const [detailId, setDetailId] = useState<string | undefined>(itemID);
  const [detail, setDetail] = useState<MemoryItem | undefined>();
  const [history, setHistory] = useState<ChangeEvent[] | undefined>();
  const [historyState, setHistoryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [historyError, setHistoryError] = useState("");
  const [recall, setRecall] = useState<RecallResult | undefined>();
  const [recallState, setRecallState] = useState<"idle" | "loading" | "ready" | "error" | "unavailable">("idle");
  const [recallError, setRecallError] = useState("");
  const [busy, setBusy] = useState<string | undefined>();
  const [actionError, setActionError] = useState<{ id: string; message: string } | undefined>();
  const [actionNotice, setActionNotice] = useState<{ id: string; message: string } | undefined>();
  const actionLocks = useItemActionLocks(lockScope);
  const [feedback, setFeedback] = useState<Feedback | undefined>();
  const [liveMessage, setLiveMessage] = useState("");
  const [focusSeq, setFocusSeq] = useState(0);
  const [narrow, setNarrow] = useState(() => matchesNarrow());
  const [verifying, setVerifying] = useState(false);
  const [unverified, setUnverified] = useState<ReadonlySet<string>>(new Set());

  const rowActions = useRef(new Map<string, HTMLButtonElement>());
  const feedbackRef = useRef<HTMLDivElement | null>(null);
  const detailActionRef = useRef<HTMLButtonElement | null>(null);
  const detailTitleRef = useRef<HTMLHeadingElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  const detailTrigger = useRef<HTMLButtonElement | null>(null);
  const pageHeadRef = useRef<HTMLHeadingElement | null>(null);
  const pendingFocus = useRef<{ kind: "detail" | "row" | "next" | "feedback"; id?: string; index?: number } | null>(null);
  const pendingScroll = useRef<{
    windowY: number;
    listY: number;
    detailY: number;
  } | null>(null);
  const actionIndex = useRef(0);
  const sheetFocused = useRef<string | undefined>(undefined);

  const chips = axisChips(automation);
  const relatedRecall = useMemo(
    () => (recall?.hits ?? []).filter((hit) => hit.id !== detail?.id),
    [recall, detail?.id],
  );
  const isUnknown = (id: string) => Boolean(unknownLockFor(actionLocks, id));
  const actionLocked = (
    id: string,
    version: string,
    action: "deactivate" | "reactivate" | "revert" | "restore",
    changeID?: string,
  ) => isActionLocked(actionLocks.locks, id, action, version, changeID);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 900px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchMemoryItems({ includeArchived: true })
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
        setLoadError("");
        setUnverified((current) => {
          if (current.size === 0) return current;
          const next = new Set(
            [...current].filter((id) => !rows.some((row) => row.id === id)),
          );
          return next.size === current.size ? current : next;
        });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setLoadError(errorMessage(caught));
        setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `loading` intentionally omitted: only a refresh key or a retry reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Keep an open detail snapshot alive even when the row leaves the active
  // segment; only refresh its capabilities from the newest server row.
  useEffect(() => {
    if (!itemID) return;
    setDetailId(itemID);
    const found = items.find((item) => item.id === itemID);
    if (found) {
      setDetail((current) => (current?.id === itemID ? { ...current, ...found } : found));
    }
  }, [itemID, items]);

  useEffect(() => {
    if (itemID) return;
    // A hash change to plain #memory closes the detail. The open click sets
    // the hash synchronously, so the stale prop cannot close it first.
    if (window.location.hash === "" || window.location.hash === "#memory") {
      setDetailId(undefined);
      setDetail(undefined);
    }
  }, [itemID]);

  useEffect(() => {
    if (!detailId) {
      setHistory(undefined);
      setHistoryState("idle");
      return;
    }
    let cancelled = false;
    setHistoryState("loading");
    setHistoryError("");
    fetchItemChanges(detailId)
      .then((changes) => {
        if (cancelled) return;
        setHistory(changes);
        setHistoryState("ready");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setHistory(undefined);
        setHistoryState("error");
        setHistoryError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [detailId, refreshKey]);

  useEffect(() => {
    if (!detail) {
      setRecall(undefined);
      setRecallState("idle");
      return;
    }
    if (!health?.project?.key) {
      setRecall(undefined);
      setRecallState("unavailable");
      setRecallError(
        "当前服务实例没有可确认的项目身份，关联记忆不可用；不会拿全部项目冒充当前项目。",
      );
      return;
    }
    let cancelled = false;
    setRecallState("loading");
    setRecallError("");
    const query = `${detail.title} ${detail.text}`.slice(0, 400);
    fetchRecall(query, 5)
      .then((result) => {
        if (cancelled) return;
        setRecall(result);
        setRecallState("ready");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setRecall(undefined);
        setRecallState("error");
        setRecallError(
          caught instanceof ApiError && caught.status === 403
            ? "当前服务实例不允许查询其他项目的关联记忆。"
            : errorMessage(caught),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.id, detail?.version, health?.project?.key]);

  const sessionItems = useMemo(
    () =>
      sessionID
        ? items.filter(
            (item) =>
              segmentOf(item) === "session" && item.source?.sessionID === sessionID,
          )
        : [],
    [items, sessionID],
  );
  const view = useMemo(
    () =>
      filters.segment === "session"
        ? filterItems(sessionItems, filters)
        : filterItems(items, filters),
    [items, sessionItems, filters],
  );
  const counts = useMemo(() => segmentCounts(items), [items]);
  const effectiveCounts = useMemo(
    () => ({ ...counts, session: sessionItems.length }),
    [counts, sessionItems.length],
  );
  // A failed read or an unprovable session is "unknown", never a believable zero.
  const knownCounts = !loading && !loadError ? effectiveCounts : undefined;
  const sessionKnown = Boolean(sessionID);
  const project = projectLabel(health?.project);
  const currentKey = health?.project?.key;
  const currentActive =
    !loading && !loadError && currentKey
      ? items.filter(
          (item) =>
            segmentOf(item) === "active" &&
            (item.scope !== "project" || item.projectKey === currentKey),
        ).length
      : undefined;
  const allProjects = metrics?.items;

  useLayoutEffect(() => {
    if (pendingScroll.current) {
      window.scrollTo({ top: pendingScroll.current.windowY, behavior: "auto" });
      if (listRef.current) listRef.current.scrollTop = pendingScroll.current.listY;
      if (detailRef.current) detailRef.current.scrollTop = pendingScroll.current.detailY;
      pendingScroll.current = null;
    }
    const plan = pendingFocus.current;
    if (!plan || busy !== undefined) return;
    pendingFocus.current = null;
    // Focus only a real, enabled control on the new render. A still-busy or
    // unverified row falls through to the next row and then the feedback bar.
    if (plan.kind === "detail") {
      const node = detailActionRef.current;
      if (node && !node.disabled) {
        node.focus({ preventScroll: true });
        return;
      }
    }
    if (plan.id) {
      const button = rowActions.current.get(plan.id);
      if (button && !button.disabled) {
        button.focus({ preventScroll: true });
        return;
      }
    }
    const index = Math.min(plan.index ?? actionIndex.current, view.length - 1);
    const next = index >= 0 ? view[index] : undefined;
    const fallback = next ? rowActions.current.get(next.id) : undefined;
    if (fallback && !fallback.disabled) {
      fallback.focus({ preventScroll: true });
      return;
    }
    feedbackRef.current?.focus({ preventScroll: true });
  }, [focusSeq, view, detail, busy]);

  async function mutate(
    item: MemoryItem,
    action: "deactivate" | "reactivate" | "revert" | "restore",
    changeID?: string,
  ) {
    if (
      busy ||
      verifying ||
      unverified.has(item.id) ||
      unknownLockFor(actionLocks, item.id) ||
      isActionLocked(actionLocks.locks, item.id, action, item.version, changeID)
    ) {
      return;
    }
    pendingScroll.current = {
      windowY: window.scrollY,
      listY: listRef.current?.scrollTop ?? 0,
      detailY: detailRef.current?.scrollTop ?? 0,
    };
    actionIndex.current = view.findIndex((entry) => entry.id === item.id);
    const detailOpen = detailId === item.id;
    setBusy(`${item.id}:${action}`);
    setActionError(undefined);
    setActionNotice(undefined);
    let focusPlan: {
      kind: "detail" | "row";
      id?: string;
      index?: number;
    } | null = null;
    try {
      const result = await postItemAction(item.id, action, {
        expectedVersion: item.version,
        ...(changeID ? { changeID } : {}),
        ...(action === "deactivate" ? { reason: "user-deactivated" } : {}),
      });
      if (!result.ok) {
        // api() rejects non-2xx, so this is only a defensive path; never treat
        // an unreadable result as success.
        setActionError({ id: item.id, message: result.message });
        pendingScroll.current = null;
        return;
      }
      const event = result.event;
      let refreshed: MemoryItem[] | null = null;
      try {
        refreshed = await fetchMemoryItems({ includeArchived: true });
      } catch {
        refreshed = null;
      }
      const fresh = refreshed?.find((entry) => entry.id === item.id);
      let title = event.after?.title ?? item.title;
      let finalMessage =
        action === "deactivate"
          ? `已停止使用「${title}」，下一次模型请求起不再注入（含旧会话）。`
          : action === "reactivate"
            ? `已恢复「${title}」，从下一次模型请求起重新注入（含旧会话）。`
            : `已撤销「${title}」的这次变更，下一步请求会使用回退后的内容。`;

      if (refreshed && fresh) {
        setItems(refreshed);
        setUnverified((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
        if (detailId === item.id) {
          setDetail((current) =>
            current?.id === item.id ? { ...current, ...fresh } : fresh,
          );
        }
        title = fresh.title;
        focusPlan = detailOpen
          ? { kind: "detail", index: actionIndex.current }
          : { kind: "row", id: item.id, index: actionIndex.current };
      } else {
        // The write is confirmed, but the capability refresh failed. Keep the
        // server's post-action snapshot for display only and disable every
        // follow-up action until a real envelope read succeeds.
        const display: MemoryItem = {
          ...item,
          ...(event.after ?? {}),
          version: item.version,
          changeID: event.id,
          latestChange: event,
          revertible: false,
          stoppable: false,
          restorable: false,
          expired: item.expired,
        };
        setItems((current) =>
          current.map((entry) => (entry.id === item.id ? display : entry)),
        );
        if (detailId === item.id) setDetail(display);
        setUnverified((current) => new Set(current).add(item.id));
        finalMessage = `${finalMessage} 操作成功，但状态刷新不可用；已禁用该条后续动作，刷新页面后可继续。`;
        focusPlan = detailOpen
          ? { kind: "detail", index: actionIndex.current }
          : { kind: "row", id: item.id, index: actionIndex.current };
      }

      setFeedback({
        kind:
          action === "deactivate"
            ? "stopped"
            : action === "reactivate"
              ? "restored"
              : action === "revert"
                ? "reverted"
                : "version",
        id: item.id,
        title,
        changeID: event.id,
      });
      setLiveMessage(finalMessage);
      onChanged();
    } catch (caught: unknown) {
      const conflict = conflictFromError(caught);
      if (conflict) {
        addItemActionLock(lockScope, {
          itemID: item.id,
          action,
          version: item.version,
          ...(changeID ? { changeID } : {}),
          kind: "conflict",
        });
        if (action === "revert" || action === "restore") {
          setActionError({
            id: item.id,
            message:
              conflict.code === "not_revertible"
                ? "该版本不可回退（可能已撤销、超期或快照不完整）；只能停止使用并保留现有内容。"
                : "当前已被修改，无法安全撤销；只能停止使用并保留现有内容。",
          });
        } else {
          const verb = action === "deactivate" ? "停止" : "恢复";
          setActionError({
            id: item.id,
            message: `${verb}未执行：${conflict.message}${
              conflict.version ? `；服务端最新版本 ${shortID(conflict.version)}` : ""
            }。请刷新后再试。`,
          });
        }
        pendingScroll.current = null;
        return;
      }
      if (
        caught instanceof ApiError &&
        (caught.code === "OPENMEM_OUTCOME_UNKNOWN" || caught.status === 504)
      ) {
        addItemActionLock(lockScope, {
          itemID: item.id,
          action,
          version: item.version,
          ...(changeID ? { changeID } : {}),
          kind: "unknown",
        });
        setActionError({
          id: item.id,
          message: "操作结果未知：已停止重复提交，请先核对服务端最新版本。",
        });
      } else {
        setActionError({ id: item.id, message: errorMessage(caught) });
      }
      pendingScroll.current = null;
    } finally {
      setBusy(undefined);
      if (focusPlan) {
        pendingFocus.current = focusPlan;
        setFocusSeq((value) => value + 1);
      }
    }
  }

  async function recheckUnknown(itemID: string) {
    if (verifying) return;
    const lock = unknownLockFor(actionLocks, itemID);
    if (!lock) {
      setActionError({
        id: itemID,
        message: "核对失败：缺少本次提交前的共享锁基线，保持锁定。",
      });
      return;
    }
    setVerifying(true);
    try {
      const rows = await fetchMemoryItems({ includeArchived: true });
      const fresh = rows.find((entry) => entry.id === itemID);
      if (!fresh) {
        setActionError({
          id: itemID,
          message: "核对失败：服务端暂未返回该条目，保持锁定。",
        });
        return;
      }
      setItems(rows);
      if (detailId === itemID) {
        setDetail((current) => (current?.id === itemID ? { ...current, ...fresh } : fresh));
      }
      const changed = unknownOutcomeChanged(lock, {
        version: fresh.version,
        changeID: fresh.changeID,
      });
      unlockUnknownLocks(lockScope, itemID);
      setUnverified((current) => {
        const next = new Set(current);
        next.delete(itemID);
        return next;
      });
      setActionError(undefined);
      setActionNotice({
        id: itemID,
        message: changed
          ? "已核对：服务端已有新版本，操作可能已生效；已按最新能力刷新。"
          : "已核对：服务端版本未变化，未确认已提交；已解除锁定，可重新操作。",
      });
      onChanged();
    } catch (caught: unknown) {
      setActionError({
        id: itemID,
        message: `核对失败：${errorMessage(caught)}；保持锁定。`,
      });
    } finally {
      setVerifying(false);
    }
  }

  function openDetail(item: MemoryItem, trigger: HTMLButtonElement) {
    detailTrigger.current = trigger;
    setDetailId(item.id);
    setDetail(item);
    if (window.location.hash !== memoryItemLink(item.id)) {
      window.location.hash = memoryItemLink(item.id);
    }
  }

  function closeDetail() {
    const trigger = detailTrigger.current;
    sheetFocused.current = undefined;
    setDetailId(undefined);
    setDetail(undefined);
    if (window.location.hash !== "#memory") window.location.hash = "memory";
    window.setTimeout(() => {
      if (trigger?.isConnected) {
        trigger.focus({ preventScroll: true });
        return;
      }
      const first = view[0] ? rowActions.current.get(view[0].id) : undefined;
      (first ?? feedbackRef.current ?? pageHeadRef.current)?.focus({ preventScroll: true });
    }, 0);
  }

  useEffect(() => {
    if (!narrow || !detailId || sheetFocused.current === detailId) return;
    sheetFocused.current = detailId;
    const timer = window.setTimeout(
      () => detailTitleRef.current?.focus({ preventScroll: true }),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [narrow, detailId]);

  useEffect(() => {
    if (!detailId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDetail();
        return;
      }
      if (event.key !== "Tab" || !narrow) return;
      const root = detailRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        detailTitleRef.current?.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const atTitle = active === detailTitleRef.current;
      if (event.shiftKey && (active === first || atTitle || !root.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailId, narrow]);

  const setFilter = <K extends keyof MemoryFilters>(key: K, value: MemoryFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="memory-page">
      <header className="page-head">
        <div>
          <h1 ref={pageHeadRef} tabIndex={-1}>
            记忆
          </h1>
          <p className="muted small">
            自动写入的记忆在这里管理；普通记忆不进入审批队列。
          </p>
        </div>
        <div className="axis-chips" aria-label="运行状态（三轴独立）">
          {chips.map((chip) => (
            <span className={`axis-chip ${chip.tone}`} key={chip.key} title={chip.detail}>
              <i aria-hidden="true" />
              {chip.label}
            </span>
          ))}
        </div>
      </header>

      <div className="count-line">
        <span
          title="口径：当前项目（含全局；不含其他项目）"
          aria-label={countAria(SEGMENT_LABEL.active, currentActive, "当前项目")}
        >
          {countLabel(SEGMENT_LABEL.active, currentActive)}
        </span>
        <span className="muted">· 当前项目 {project}</span>
        <span className="spacer" />
        <span
          className="muted small"
          aria-label={countAria("全部项目", allProjects, "全部项目")}
        >
          {countLabel("全部项目", allProjects)}
        </span>
      </div>

      <div className="segmented memory-segments" role="group" aria-label="记忆分段">
        {SEGMENTS.map((segment) => (
          <button
            key={segment}
            type="button"
            aria-pressed={filters.segment === segment}
            className={filters.segment === segment ? "active" : ""}
            onClick={() => setFilter("segment", segment)}
          >
            {SEGMENT_LABEL[segment]}{" "}
            {segment === "session" && !sessionKnown
              ? "未知"
              : knownCounts
                ? knownCounts[segment]
                : "未知"}
          </button>
        ))}
      </div>

      <div className="toolbar memory-filters">
        <input
          className="input memory-search"
          type="search"
          value={filters.query}
          placeholder="搜索标题或正文"
          aria-label="搜索记忆"
          onChange={(event) => setFilter("query", event.target.value)}
        />
        <select
          className="select"
          value={filters.scope}
          aria-label="按范围筛选"
          onChange={(event) => setFilter("scope", event.target.value as MemoryFilters["scope"])}
        >
          <option value="">全部范围</option>
          <option value="global">全局</option>
          <option value="project">项目</option>
          <option value="session">本次会话</option>
        </select>
        <select
          className="select"
          value={filters.kind}
          aria-label="按类型筛选"
          onChange={(event) => setFilter("kind", event.target.value as MemoryFilters["kind"])}
        >
          <option value="">全部类型</option>
          {Object.entries(KIND_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={filters.source}
          aria-label="按来源筛选"
          onChange={(event) => setFilter("source", event.target.value as MemoryFilters["source"])}
        >
          <option value="">全部来源</option>
          <option value="auto">自动</option>
          <option value="review">复盘</option>
          <option value="manual">手动</option>
          <option value="migration">迁移</option>
        </select>
        <select
          className="select"
          value={filters.time}
          aria-label="按时间筛选"
          onChange={(event) => setFilter("time", event.target.value as MemoryFilters["time"])}
        >
          <option value="any">全部时间</option>
          <option value="24h">近 24 小时</option>
          <option value="7d">近 7 天</option>
          <option value="30d">近 30 天</option>
        </select>
      </div>

      <p className="muted small filter-count" aria-live="off">
        {knownCounts &&
        !(filters.segment === "session" && !sessionKnown)
          ? filterCountLabel(view.length, knownCounts[filters.segment], allProjects)
          : `分段 未知 · 筛选后 ${
              filters.segment === "session" && !sessionKnown ? "未知" : view.length
            } · 全部项目 ${
              allProjects === undefined ? "未知" : `${allProjects} 条`
            }`}
      </p>
      {filters.segment === "session" ? (
        <p className="muted small" role="note">
          {sessionKnown
            ? "仅当前扩展会话可见，不会进入长期记忆；会话结束后通常不再生效。"
            : "本次会话不可确认：当前控制台没有可信的当前会话；不会把其他会话的记忆冒充本次会话。选择“全部”可查看会话范围（全部会话）。"}
        </p>
      ) : null}
      {filters.segment === "all" ? (
        <p className="muted small" role="note">
          全部分段包含会话范围（全部会话）；这不代表当前会话。
        </p>
      ) : null}

      {feedback ? (
        <div className="feedback-bar" ref={feedbackRef} tabIndex={-1} role="status">
          <span>
            {feedback.kind === "stopped"
              ? `已停止使用「${feedback.title}」，下一次模型请求起不再注入（含旧会话）。`
              : feedback.kind === "restored"
                ? `已恢复「${feedback.title}」，从下一次模型请求起重新注入（含旧会话）。`
                : `已撤销「${feedback.title}」的这次变更。`}
          </span>
          {feedback.kind === "stopped" ? (
            <button
              className="btn ghost row-action"
              type="button"
              disabled={
                busy !== undefined ||
                verifying ||
                isUnknown(feedback.id) ||
                unverified.has(feedback.id) ||
                actionLocked(
                  feedback.id,
                  items.find((entry) => entry.id === feedback.id)?.version ?? "",
                  "reactivate",
                )
              }
              onClick={() => {
                const item = items.find((entry) => entry.id === feedback.id);
                if (item) void mutate(item, "reactivate");
              }}
            >
              恢复使用
            </button>
          ) : null}
          {feedback.changeID ? (
            <a className="link-action" href={activityEventLink(feedback.changeID)}>
              查看活动
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="sr-only" aria-live="polite">
        {liveMessage}
      </div>

      <div className={`memory-layout${detailId ? " has-detail" : ""}`}>
        <section className="panel memory-list-panel" aria-label="记忆列表">
          {loading ? <div className="empty">正在读取记忆…</div> : null}
          {loadError ? (
            <div className="empty" role="alert">
              {loadError}
            </div>
          ) : null}
          {!loading && !loadError && view.length === 0 ? (
            <div className="empty">
              {filters.segment === "session" && !sessionKnown
                ? "本次会话不可确认；当前控制台不会展示其他会话来冒充。"
                : filters.segment === "active" &&
              !filters.query &&
              !filters.scope &&
              !filters.kind &&
              !filters.source &&
              filters.time === "any"
                ? "还没有生效记忆。自动写入开启后，符合条件的候选会直接出现在这里。"
                : "没有符合当前筛选的记忆。"}
            </div>
          ) : null}
          <div className="memory-list" ref={listRef}>
            {view.map((item) => {
              const busyHere = busy === `${item.id}:deactivate` || busy === `${item.id}:reactivate`;
              const segment = segmentOf(item);
              return (
                <article
                  className={`memory-row${detailId === item.id ? " active" : ""}`}
                  key={item.id}
                  aria-busy={busyHere}
                >
                  <button
                    className="memory-open"
                    type="button"
                    onClick={(event) => openDetail(item, event.currentTarget)}
                    aria-label={`打开记忆「${item.title}」`}
                  >
                    <strong className="memory-title">{item.title}</strong>
                    <span className="memory-summary">{item.text}</span>
                  </button>
                  <div className="chips memory-chips">
                    <span className="chip">{SCOPE_LABEL[item.scope]}</span>
                    {item.scope === "project" && itemProjectLabel(item) ? (
                      <span className="chip" title={item.project}>
                        {itemProjectLabel(item)}
                      </span>
                    ) : null}
                    <span className="chip">{KIND_LABEL[item.kind]}</span>
                    <span className="chip">{SOURCE_LABEL[sourceKindOf(item)]}</span>
                    <span className="chip">{formatAge(item.updatedAt)}</span>
                    <span className={`chip status-chip ${segment}`}>{statusTextOf(item)}</span>
                  </div>
                  <div className="memory-row-actions">
                    {unverified.has(item.id) ? (
                      <span className="muted small">状态待刷新</span>
                    ) : canStop(item) ? (
                      <button
                        className="btn ghost row-action"
                        type="button"
                        ref={(node) => {
                          if (node) rowActions.current.set(item.id, node);
                          else rowActions.current.delete(item.id);
                        }}
                        disabled={
                          busy !== undefined ||
                          verifying ||
                          unverified.has(item.id) ||
                          isUnknown(item.id) ||
                          actionLocked(item.id, item.version, "deactivate")
                        }
                        onClick={() => void mutate(item, "deactivate")}
                      >
                        {busyHere ? "停止中…" : "停止使用"}
                      </button>
                    ) : canRestore(item) ? (
                      <button
                        className="btn ghost row-action"
                        type="button"
                        ref={(node) => {
                          if (node) rowActions.current.set(item.id, node);
                          else rowActions.current.delete(item.id);
                        }}
                        disabled={
                          busy !== undefined ||
                          verifying ||
                          unverified.has(item.id) ||
                          isUnknown(item.id) ||
                          actionLocked(item.id, item.version, "reactivate")
                        }
                        onClick={() => void mutate(item, "reactivate")}
                      >
                        {busyHere ? "恢复中…" : "恢复使用"}
                      </button>
                    ) : (
                      <span className="muted small">{statusTextOf(item)}</span>
                    )}
                  </div>
                  {actionError?.id === item.id ? (
                    <p className="action-error" role="alert">
                      {actionError.message}
                      {isUnknown(item.id) ? (
                        <button
                          className="btn ghost row-action"
                          type="button"
                          disabled={verifying}
                          onClick={() => void recheckUnknown(item.id)}
                        >
                          {verifying ? "核对中…" : "核对最新版本"}
                        </button>
                      ) : null}
                    </p>
                  ) : null}
                  {actionNotice?.id === item.id ? (
                    <p className="muted small" role="status">
                      {actionNotice.message}
                    </p>
                  ) : null}
                  {isUnknown(item.id) && actionError?.id !== item.id ? (
                    <p className="action-error" role="alert">
                      操作结果未知：已停止重复提交，请先核对服务端最新版本。
                      <button
                        className="btn ghost row-action"
                        type="button"
                        disabled={verifying}
                        onClick={() => void recheckUnknown(item.id)}
                      >
                        {verifying ? "核对中…" : "核对最新版本"}
                      </button>
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>

        {narrow && detailId ? (
          <button className="sheet-backdrop" type="button" aria-label="关闭详情" onClick={closeDetail} />
        ) : null}
        {detailId ? (
          <aside
            ref={detailRef}
            className={`memory-detail${narrow ? " sheet" : ""}`}
            aria-label="记忆详情"
            role={narrow ? "dialog" : "region"}
            aria-modal={narrow ? true : undefined}
          >
            <div className="panel-head">
              <h2 ref={detailTitleRef} tabIndex={-1}>
                {detail?.title ?? "记忆详情"}
              </h2>
              <button className="btn ghost row-action" type="button" onClick={closeDetail}>
                关闭
              </button>
            </div>
            {!detail ? (
              <div className="detail-body">
                <p className="muted">
                  {loading
                    ? "正在读取这条记忆…"
                    : "没有找到这条记忆；它可能已被清理或迁移，当前实例不提供该对象。"}
                </p>
              </div>
            ) : (
              <div className="detail-body">
                <p className="memory-body">{detail.text}</p>
                <div className="chips">
                  <span className="chip">{SCOPE_LABEL[detail.scope]}</span>
                  {detail.scope === "project" && itemProjectLabel(detail) ? (
                    <span className="chip" title={detail.project}>
                      {itemProjectLabel(detail)}
                    </span>
                  ) : null}
                  <span className="chip">{KIND_LABEL[detail.kind]}</span>
                  <span className="chip">{SOURCE_LABEL[sourceKindOf(detail)]}</span>
                  <span className="chip">更新 {formatAge(detail.updatedAt)}</span>
                  <span className="chip">{statusTextOf(detail)}</span>
                </div>

                <section aria-label="来源">
                  <h3>来源</h3>
                  <p className="muted small">{sourceText(detail)}</p>
                  {evidenceSummary(detail) ? (
                    <blockquote className="evidence-quote">
                      <p>{evidenceSummary(detail)}</p>
                    </blockquote>
                  ) : (
                    <p className="muted small">当前条目没有逐字证据记录；不会补造引用。</p>
                  )}
                </section>

                <section aria-label="版本历史">
                  <h3>版本历史</h3>
                  {historyState === "loading" ? (
                    <p className="muted small">正在读取版本…</p>
                  ) : null}
                  {historyState === "error" ? (
                    <p className="muted small" role="status">
                      当前实例未提供版本历史：{historyError}
                    </p>
                  ) : null}
                  {historyState === "ready" && history && history.length > 0 ? (
                    <ol className="version-list">
                      {[...history].reverse().slice(0, 20).map((change) => (
                        <li key={change.id}>
                          <div className="version-head">
                            <span className="mono small">{formatAge(change.at)}</span>
                            <span className="chip">{changeLabel(change)}</span>
                            <span className="muted small">{change.actor}</span>
                          </div>
                          <p className="muted small">{change.reason || "未记录原因"}</p>
                          {canRevert(change) &&
                          !actionLocked(detail.id, detail.version, "restore", change.id) ? (
                            <button
                              className="btn ghost row-action"
                              type="button"
                              disabled={
                                busy !== undefined ||
                                verifying ||
                                unverified.has(detail.id) ||
                                isUnknown(detail.id) ||
                                actionLocked(detail.id, detail.version, "restore", change.id)
                              }
                              onClick={() => void mutate(detail, "restore", change.id)}
                            >
                              恢复到此版本
                            </button>
                          ) : (
                            <p className="muted small">此版本不可回退或已超出服务端窗口。</p>
                          )}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {historyState === "ready" && history && history.length === 0 ? (
                    <p className="muted small">当前实例未提供版本历史。</p>
                  ) : null}
                </section>

                <section aria-label="相关记忆">
                  <h3>相关记忆</h3>
                  {recallState === "loading" ? <p className="muted small">正在检索…</p> : null}
                  {recallState === "error" || recallState === "unavailable" ? (
                    <p className="muted small">{recallError}</p>
                  ) : null}
                  {recallState === "ready" && recall ? (
                    recall.degraded?.reason === "store_error" ? (
                      <p className="muted small">召回存储读取失败，关联记忆不可用。</p>
                    ) : recall.degraded?.reason === "unlocated" ? (
                      <p className="muted small">无法确认当前项目位置，关联记忆不可用。</p>
                    ) : recall.degraded?.reason === "budget" ? (
                      <p className="muted small">相关记忆超出本轮召回预算，未显示。</p>
                    ) : relatedRecall.length > 0 ? (
                      <ul className="recall-list">
                        {relatedRecall.map((hit) => (
                          <li key={hit.id}>
                            <a className="recall-link" href={memoryItemLink(hit.id)}>
                              <strong>{hit.title}</strong>
                            </a>
                            <span className="muted small">
                              {SCOPE_LABEL[hit.scope]} · {hit.reasons.join("、") || "相似"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : recall.hits.length > 0 ? (
                      <p className="muted small">只有当前条目本身，没有其他相关记忆命中。</p>
                    ) : (
                      <p className="muted small">当前没有相关记忆命中。</p>
                    )
                  ) : null}
                </section>

                <section className="detail-actions" aria-label="记忆动作">
                  {unverified.has(detail.id) ? (
                    <p className="muted small">
                      操作已成功，但状态刷新不可用；该条后续动作已禁用，请刷新后再继续。
                    </p>
                  ) : canStop(detail) ? (
                    <button
                      className="btn"
                      type="button"
                      ref={detailActionRef}
                      disabled={
                        busy !== undefined ||
                        verifying ||
                        unverified.has(detail.id) ||
                        isUnknown(detail.id) ||
                        actionLocked(detail.id, detail.version, "deactivate")
                      }
                      onClick={() => void mutate(detail, "deactivate")}
                    >
                      {busy === `${detail.id}:deactivate` ? "停止中…" : "停止使用"}
                    </button>
                  ) : canRestore(detail) ? (
                    <button
                      className="btn"
                      type="button"
                      ref={detailActionRef}
                      disabled={
                        busy !== undefined ||
                        verifying ||
                        unverified.has(detail.id) ||
                        isUnknown(detail.id) ||
                        actionLocked(detail.id, detail.version, "reactivate")
                      }
                      onClick={() => void mutate(detail, "reactivate")}
                    >
                      {busy === `${detail.id}:reactivate` ? "恢复中…" : "恢复使用"}
                    </button>
                  ) : null}
                  {detail.revertible &&
                  detail.latestChange &&
                  !unverified.has(detail.id) &&
                  !isUnknown(detail.id) &&
                  !actionLocked(
                    detail.id,
                    detail.version,
                    "revert",
                    detail.latestChange.id,
                  ) ? (
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={
                        busy !== undefined ||
                        verifying ||
                        unverified.has(detail.id) ||
                        isUnknown(detail.id) ||
                        actionLocked(
                          detail.id,
                          detail.version,
                          "revert",
                          detail.latestChange?.id,
                        )
                      }
                      onClick={() => void mutate(detail, "revert", detail.latestChange?.id)}
                    >
                      撤销最近变更
                    </button>
                  ) : null}
                </section>
                {actionNotice?.id === detail.id ? (
                  <p className="muted small" role="status">
                    {actionNotice.message}
                  </p>
                ) : null}
                {actionError?.id === detail.id ? (
                  <p className="action-error" role="alert">
                    {actionError.message}
                    {isUnknown(detail.id) ? (
                      <button
                        className="btn ghost row-action"
                        type="button"
                        disabled={verifying}
                        onClick={() => void recheckUnknown(detail.id)}
                      >
                        {verifying ? "核对中…" : "核对最新版本"}
                      </button>
                    ) : null}
                  </p>
                ) : null}
                <p className="muted small">
                  停止使用只改变上下文注入：下一次模型请求起不再注入（含旧会话）。它不撤回已经开始的请求、已执行的工具动作或上游服务侧的数据。
                </p>
              </div>
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function matchesNarrow(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(max-width: 900px)").matches;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


