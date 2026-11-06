import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, formatAge, formatReviewAge, priorityClass } from "../api";
import { confirmAction } from "../extension/confirm";
import {
  auditFindingLink,
  findingsForQueueItem,
  consumeTarget,
  markTargetCheck,
  resolveQueueTarget,
  targetCheckHandled,
  targetConsumed,
  type ConsumedTarget,
  type TargetCheckMark,
} from "./audit-links";
import {
  anyQueueFilterActive,
  describeDuplicateClues,
  emptyQueueFilters,
  queueScopeView,
  reviewCountsView,
  summarizeTurnHooks,
} from "./queue-triage";
import { suggestionApplyState } from "./queue-apply";
import {
  decisionLockedByUnknown,
  decisionSnapshotOf,
  deferRebaseExpectation,
  discardQueueDraft,
  globalQueueTotal,
  hasDecisionVersion,
  hasDirtyQueueDrafts,
  initialQueueDraft,
  queueDraftConflict,
  rebaselineQueueDraft,
  resolveDeferRebase,
  sameDecisionSnapshot,
  shouldClearConsumedDraft,
  storeQueueDraft,
  type DeferRebaseExpectation,
  type PendingDecisionCheck,
  type QueueDraft,
  type QueueDrafts,
} from "./queue-draft";
import {
  buildBatchExecution,
  classifyBatchSubmitFailure,
  parseBatchPreview,
  parseBatchResults,
  shortItemID,
  summarizeBatchResults,
  unknownSubmissionReport,
  type BatchPreview,
  type BatchRequestScope,
  type BatchResultReport,
  type BatchResultStatus,
} from "./queue-batch-result";
import type { AuditReport, Config, QueueItem, ReviewRecord, Suggestion, TurnSummary } from "../types";

interface Props {
  refreshKey: number;
  onChanged: () => void;
  targetItemID?: string;
  /** Global pending total from App's single /api/metrics snapshot. */
  globalQueueCount?: number;
  /** False while the queue is kept mounted but another tab is visible. */
  visible?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}

type Action = "approve" | "deny" | "defer" | "resume" | "apply_suggestion";

const ACTION_LABEL: Record<string, string> = {
  create: "新建条目",
  merge_into: "合并到已有",
  replace: "替换旧条目",
  keep_both: "保留两条",
  reject_duplicate: "拒绝重复",
};

const REVIEW_TYPE_LABEL: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  rule: "规则",
  decision: "决策",
  learning: "教训",
  skill: "流程",
};

const SCOPE_LABEL: Record<string, string> = {
  session: "会话",
  project: "项目",
  global: "全局",
};

const STATUS_LABEL: Record<ReviewRecord["status"], string> = {
  ready: "已复盘",
  running: "复盘中",
  scheduled: "已排期",
  skipped: "已跳过",
  failed: "失败",
};

const STATUS_TONE: Record<ReviewRecord["status"], string> = {
  ready: "success",
  running: "warning",
  scheduled: "",
  skipped: "",
  failed: "error",
};

export function QueuePage({
  refreshKey,
  onChanged,
  targetItemID,
  globalQueueCount,
  visible = true,
  onDirtyChange,
}: Props) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState("");
  const [scope, setScope] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [projects, setProjects] = useState<Array<{ key: string; label: string }>>([]);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [queueError, setQueueError] = useState(false);
  const [baseline, setBaseline] = useState<{ state: string; sources: number; sections: number }>();
  const [editTitle, setEditTitle] = useState("");
  const [editText, setEditText] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [limits, setLimits] = useState({ memory: 200, rule: 160, title: 30 });
  const requested = useRef<Set<string>>(new Set());
  const requestID = useRef(0);
  const detailRef = useRef<HTMLElement>(null);
  const [turn, setTurn] = useState<TurnSummary>();
  const [originFilter, setOriginFilter] = useState<"" | "turn" | "session-review">("");
  const filterKey = JSON.stringify([kind, scope, projectKey, originFilter, query]);
  const [loadedFilter, setLoadedFilter] = useState(filterKey);
  const filterPending = filterKey !== loadedFilter;
  const [latestReview, setLatestReview] = useState<ReviewRecord>();
  const [reviewHistory, setReviewHistory] = useState<ReviewRecord[]>([]);
  const [reviewSelection, setReviewSelection] = useState("");
  const [nextReviewAt, setNextReviewAt] = useState<string>();
  const [reviewBusy, setReviewBusy] = useState(false);
  const [canRunReview, setCanRunReview] = useState(false);
  const [batchPreview, setBatchPreview] = useState<BatchPreview | null>(null);
  const [batchReport, setBatchReport] = useState<BatchResultReport | null>(null);
  const [batchLabels, setBatchLabels] = useState<Record<string, string>>({});
  const [auditReport, setAuditReport] = useState<AuditReport>();
  const [auditError, setAuditError] = useState(false);
  const [drafts, setDrafts] = useState<QueueDrafts>({});
  const draftsRef = useRef<QueueDrafts>({});
  const [targetNotice, setTargetNotice] = useState<
    { tone: "warning" | "error"; text: string } | null
  >(null);
  const targetHandled = useRef<TargetCheckMark | null>(null);
  const consumedTarget = useRef<ConsumedTarget | null>(null);
  const targetRefreshRequested = useRef<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<PendingDecisionCheck | null>(
    null,
  );
  const decisionInputsRef = useRef<{
    selected: QueueItem | null;
    title: string;
    text: string;
    note: string;
  }>({ selected: null, title: "", text: "", note: "" });
  const deferExpectations = useRef<Record<string, DeferRebaseExpectation>>({});

  const hasFilters = anyQueueFilterActive({
    kind,
    scope,
    projectKey,
    originFilter,
    query,
    queryInput,
  });

  const turnItems = useMemo(
    () => (turn?.turnID ? items.filter((item) => item.turnID === turn.turnID) : []),
    [items, turn?.turnID],
  );
  const turnView = turn ? summarizeTurnHooks(turn) : undefined;
  const displayItems = items;

  const selected = useMemo(
    () => displayItems.find((item) => item.id === selectedId) ?? null,
    [displayItems, selectedId],
  );
  const suggestion = selected?.suggestion;
  const activeDraft = selected ? drafts[selected.id] : undefined;
  const draftConflict = activeDraft
    ? queueDraftConflict(activeDraft, selected)
    : null;
  const orphanDraft = selectedId && !selected ? drafts[selectedId] : undefined;
  const orphanDraftIDs = Object.keys(drafts).filter(
    (id) => !displayItems.some((item) => item.id === id),
  );
  const relatedFindings = useMemo(
    () =>
      selected && auditReport
        ? findingsForQueueItem(selected.id, auditReport.findings)
        : [],
    [selected?.id, auditReport],
  );
  const duplicateClues = selected ? describeDuplicateClues(selected) : undefined;
  decisionInputsRef.current = {
    selected,
    title: editTitle,
    text: editText,
    note,
  };
  const decisionVersionReady = Boolean(
    selected && hasDecisionVersion(selected.decisionVersion),
  );
  const decisionUnknownLocked = decisionLockedByUnknown(
    pendingDecision,
    selected?.id,
  );
  const decisionsBlocked =
    draftConflict !== null || !decisionVersionReady || decisionUnknownLocked;
  useEffect(() => {
    if (!visible) return;
    if (selectedId && window.matchMedia("(max-width: 900px)").matches) {
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    }
  }, [selectedId, visible]);
  const maxChars = selected
    ? selected.kind === "rule"
      ? limits.rule
      : limits.memory
    : limits.memory;
  const overLimit = editText.length > maxChars || editTitle.length > limits.title;
  const applyState = suggestionApplyState({
    suggestion,
    suggestionState: selected?.suggestionState,
    title: editTitle,
    text: editText,
    overLimit,
  });
  const { edited, canApply } = applyState;

  useEffect(() => {
    api<Config>("/api/config")
      .then((config) =>
        setLimits({
          memory: config.thresholds.memoryMaxChars,
          rule: config.thresholds.ruleMaxChars,
          title: config.thresholds.titleMaxChars,
        }),
      )
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(queryInput.trim()), 250);
    return () => clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (scope) params.set("scope", scope);
    if (projectKey) params.set("projectKey", projectKey);
    if (originFilter) params.set("origin", originFilter);
    if (query) params.set("q", query);
    const id = ++requestID.current;
    setLoading(true);
    api<{
      items: QueueItem[];
      projects?: Array<{ key: string; label: string }>;
      baseline?: { state: string; sources: number; sections: number };
    }>(`/api/queue?${params.toString()}`)
      .then((data) => {
        if (id !== requestID.current) return;
        setItems(data.items);
        setProjects(data.projects ?? []);
        setBaseline(data.baseline);
        setLoadedFilter(filterKey);
        setQueueError(false);
        setError("");
        setSelectedId((current) => {
          if (!current) return null;
          if (data.items.some((item) => item.id === current)) return current;
          // A background refresh or filter change must not drop a dirty draft:
          // keep the id so the detail can offer copy/discard for it.
          return draftsRef.current[current] ? current : null;
        });
      })
      .catch((caught: unknown) => {
        if (id !== requestID.current) return;
        setQueueError(true);
        setError(errorMessage(caught));
      })
      .finally(() => {
        if (id === requestID.current) setLoading(false);
      });
  }, [refreshKey, kind, scope, originFilter, query, projectKey]);

  useEffect(() => {
    api<{ items: ReviewRecord[]; canRun?: boolean; nextAt?: string | null }>(
      "/api/reviews?limit=20",
    )
      .then((data) => {
        setReviewHistory(data.items);
        setLatestReview(data.items.find((entry) => entry.id === reviewSelection) ?? data.items[0]);
        setCanRunReview(data.canRun === true);
        setNextReviewAt(data.nextAt ?? undefined);
      })
      .catch(() => {
        setLatestReview(undefined);
        setCanRunReview(false);
        setNextReviewAt(undefined);
      });
  }, [refreshKey, reviewSelection]);

  useEffect(() => {
    api<TurnSummary>("/api/turns/latest")
      .then(setTurn)
      .catch(() => setTurn(undefined));
  }, [refreshKey]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [originFilter, kind, scope, query, projectKey]);

  useEffect(() => {
    api<AuditReport>("/api/audit")
      .then((data) => {
        setAuditReport(data);
        setAuditError(false);
      })
      .catch(() => {
        setAuditReport(undefined);
        setAuditError(true);
      });
  }, [refreshKey]);


  useEffect(() => {
    if (!targetItemID) {
      targetHandled.current = null;
      consumedTarget.current = null;
      targetRefreshRequested.current = null;
      setTargetNotice(null);
      return;
    }
    // The deep link selects its target exactly once. After that a refresh (or
    // the user picking another row) must not steal the selection back.
    if (targetConsumed(consumedTarget.current, targetItemID)) return;
    if (loading || filterPending) return;
    const key = `${targetItemID}|${filterKey}`;
    const generation = requestID.current;
    if (targetCheckHandled(targetHandled.current, key, generation)) return;
    const visible = items.find((item) => item.id === targetItemID);
    if (visible) {
      targetHandled.current = markTargetCheck(key, generation);
      consumedTarget.current = consumeTarget(targetItemID);
      setSelectedId(visible.id);
      setTargetNotice(null);
      return;
    }
    let cancelled = false;
    setTargetNotice(null);
    api<{ items: QueueItem[] }>("/api/queue")
      .then((data) => {
        if (cancelled || requestID.current !== generation) return;
        // Mark only after the check completed, so a cancelled reload retries.
        targetHandled.current = markTargetCheck(key, generation);
        const status = resolveQueueTarget(
          targetItemID,
          [],
          data.items,
          hasFilters,
        );
        if (status === "filtered") {
          setTargetNotice({
            tone: "warning",
            text: "该审批条目存在，但被当前筛选隐藏；清除筛选后即可查看。",
          });
          return;
        }
        if (status === "stale-list") {
          if (targetRefreshRequested.current !== targetItemID) {
            targetRefreshRequested.current = targetItemID;
            onChanged();
          }
          setTargetNotice({
            tone: "warning",
            text: "该审批条目存在于全量队列，但当前列表尚未刷新；已请求刷新，请稍后查看。",
          });
          return;
        }
        setTargetNotice({
          tone: "error",
          text: "该审批条目已不在队列中（可能已处理或删除）。",
        });
      })
      .catch((caught: unknown) => {
        if (cancelled || requestID.current !== generation) return;
        targetHandled.current = markTargetCheck(key, generation);
        setTargetNotice({
          tone: "error",
          text: `无法核对目标审批条目：${errorMessage(caught)}`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [targetItemID, filterKey, loading, filterPending, items, hasFilters, onChanged]);

  useEffect(() => {
    if (!selected) return;
    const existing = draftsRef.current[selected.id];
    if (existing) {
      // A dirty draft wins over the fresh server version; a conflict banner
      // offers explicit discard or re-confirmation.
      setEditTitle(existing.title);
      setEditText(existing.text);
      setNote(existing.note);
      return;
    }
    const initial = initialQueueDraft(selected);
    setEditTitle(initial.title);
    setEditText(initial.text);
    setNote(initial.note);
  }, [
    selected?.id,
    selected?.suggestion?.id,
    selected?.suggestion?.proposedTitle,
    selected?.suggestion?.proposedText,
    selected?.updatedAt,
    selected?.title,
    selected?.text,
  ]);

  const draftsDirty = hasDirtyQueueDrafts(drafts);
  useEffect(() => {
    onDirtyChange?.(draftsDirty);
  }, [draftsDirty, onDirtyChange]);
  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );

  // Only our own defer/resume may auto-rebaseline a draft, and only after the
  // reloaded item proves exactly the version the server returned.
  useEffect(() => {
    if (!selected) return;
    const expectation = deferExpectations.current[selected.id];
    if (!expectation) return;
    const outcome = resolveDeferRebase({
      expectation,
      draft: draftsRef.current[selected.id],
      current: selected,
    });
    if (outcome.action === "rebase") {
      delete deferExpectations.current[selected.id];
      syncDrafts(storeQueueDraft(draftsRef.current, outcome.draft));
      return;
    }
    if (outcome.action === "none" || outcome.action === "conflict") {
      delete deferExpectations.current[selected.id];
    }
  }, [selected, drafts]);

  function syncDrafts(next: QueueDrafts) {
    draftsRef.current = next;
    setDrafts(next);
  }

  function editDraft(field: "title" | "text" | "note", value: string) {
    if (!selected) return;
    const base = draftsRef.current[selected.id] ?? initialQueueDraft(selected);
    const nextDraft: QueueDraft = { ...base, [field]: value };
    syncDrafts(storeQueueDraft(draftsRef.current, nextDraft));
    if (field === "title") setEditTitle(value);
    else if (field === "text") setEditText(value);
    else setNote(value);
  }

  function discardSelectedDraft() {
    if (!selected) return;
    syncDrafts(discardQueueDraft(draftsRef.current, selected.id));
    const initial = initialQueueDraft(selected);
    setEditTitle(initial.title);
    setEditText(initial.text);
    setNote(initial.note);
    setMessage("已放弃草稿，改用当前版本。");
  }

  function rebaselineSelectedDraft() {
    if (!selected) return;
    const draft = draftsRef.current[selected.id];
    if (!draft) return;
    const rebased = rebaselineQueueDraft(draft, selected);
    if (!rebased) {
      setError(
        "无法按当前版本重新确认草稿（缺少 decisionVersion 或条目 ID 不一致），草稿仍保留。",
      );
      return;
    }
    syncDrafts(storeQueueDraft(draftsRef.current, rebased));
    setMessage("草稿已按当前版本重新确认；提交前请复核内容。");
  }

  async function discardOrphanDraft() {
    if (!selectedId) return;
    const ok = await confirmAction({
      title: "放弃这份草稿？",
      message: "该审批条目已不在当前列表，放弃后草稿内容无法恢复。",
      confirmLabel: "放弃草稿",
      danger: true,
    });
    if (!ok) return;
    syncDrafts(discardQueueDraft(draftsRef.current, selectedId));
    setSelectedId(null);
    setMessage("已放弃离开队列条目的草稿。");
  }

  async function generate(id: string) {
    requested.current.add(id);
    setGenerating(true);
    setError("");
    setMessage("");
    try {
      const result = await api<Suggestion>(`/api/queue/${encodeURIComponent(id)}/suggest`, {
        method: "POST",
      });
      setItems((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                suggestion: result,
                suggestionState: result.validation.ok ? "ready" : "failed",
              }
            : item,
        ),
      );
      onChanged();
    } catch (caught: unknown) {
      requested.current.delete(id);
      setError(errorMessage(caught));
    } finally {
      setGenerating(false);
    }
  }

  async function act(action: Action) {
    if (!selected) return;
    if (decisionUnknownLocked) {
      setError("该条目上次提交结果未知；请先刷新核对并解除锁定，再重新操作。");
      return;
    }
    if (!decisionVersionReady) {
      setError("该审批条目缺少 decisionVersion，已停止提交；请刷新队列后重试。");
      return;
    }
    if (draftConflict) {
      setError("草稿对应的条目或建议已更新；请先丢弃草稿或按当前版本重新确认。");
      return;
    }
    const snapshot = decisionSnapshotOf(selected, {
      title: editTitle,
      text: editText,
      note,
    });
    // Bind the draft object that exists at submit time. Reading it after the
    // await could bind a replacement object created while the request runs.
    const submittedDraft = draftsRef.current[snapshot.itemID];
    if (action === "apply_suggestion") {
      if (!suggestion || !canApply) return;
      if (selected.kind === "rule" || (selected.priority ?? 0) >= 85) {
        const ok = await confirmAction({
          title: "应用合并建议？",
          message: `应用「${ACTION_LABEL[suggestion.action]}」会写入记忆并归档候选。`,
          confirmLabel: "应用",
        });
        if (!ok) return;
      }
    }
    if (action === "approve" && (selected.kind === "rule" || (selected.priority ?? 0) >= 70)) {
      const ok = await confirmAction({
        title: "批准这条候选？",
        message: `「${selected.title}」会写入${selected.kind === "rule" ? "规则" : "记忆"}文件，并从队列移除。`,
        confirmLabel: "批准",
      });
      if (!ok) return;
    }
    // The confirm dialog may be open while a refresh or an edit changes the
    // item: abort before writing instead of submitting a different version.
    const live = decisionInputsRef.current;
    if (
      !live.selected ||
      !sameDecisionSnapshot(
        snapshot,
        decisionSnapshotOf(live.selected, {
          title: live.title,
          text: live.text,
          note: live.note,
        }),
      )
    ) {
      setError("确认期间所选条目或内容已变化，已中止提交（未写入）。");
      return;
    }
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await api<{
        ok: boolean;
        error?: string;
        target?: string;
        journalID?: string;
        decisionVersion?: string;
        item?: QueueItem;
      }>(`/api/queue/${selected.id}/decision`, {
        method: "POST",
        body: JSON.stringify({
          action,
          title: snapshot.title,
          text: snapshot.text,
          note: snapshot.note,
          expectedVersion: snapshot.decisionVersion,
        }),
      });
      if (!result.ok) {
        setError(result.error ?? "decision failed");
        return;
      }
      const after = decisionInputsRef.current;
      if (
        after.selected?.id === snapshot.itemID &&
        shouldClearConsumedDraft({
          action,
          itemID: snapshot.itemID,
          draft: draftsRef.current[snapshot.itemID],
          submitted: {
            title: snapshot.title,
            text: snapshot.text,
            note: snapshot.note,
          },
          current: { title: after.title, text: after.text, note: after.note },
        })
      ) {
        syncDrafts(discardQueueDraft(draftsRef.current, snapshot.itemID));
      }
      if (action === "defer" || action === "resume") {
        const expectation = deferRebaseExpectation({
          draft: submittedDraft,
          itemID: snapshot.itemID,
          oldVersion: snapshot.decisionVersion,
          draftVersion: submittedDraft?.baseline.decisionVersion,
          responseItemID: result.item?.id,
          responseVersion: result.decisionVersion,
        });
        if (expectation) {
          deferExpectations.current[snapshot.itemID] = expectation;
        } else {
          delete deferExpectations.current[snapshot.itemID];
        }
      }
      setPendingDecision(null);
      setMessage(
        action === "apply_suggestion"
          ? result.journalID
            ? `已应用建议 · 24h 内可在 Health 页撤销`
            : "已应用建议"
          : action === "approve"
            ? `Approved → ${result.target ?? "auto file"}`
            : `${action} saved`,
      );
      onChanged();
    } catch (caught: unknown) {
      if (caught instanceof ApiError && caught.status >= 400 && caught.status < 500) {
        // The server answered with a rejection; the transaction did not write.
        setError(errorMessage(caught));
      } else {
        setPendingDecision({ itemID: snapshot.itemID, action });
        setError(
          `提交结果未知：${errorMessage(caught)}。请先刷新队列核对；核对前不会重复提交。该核对标记仅保存在当前页面，刷新页面或断开连接后会丢失。`,
        );
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  async function promoteSelected(targetScope: "project" | "global") {
    if (!selected) return;
    if (decisionUnknownLocked) {
      setError("该条目上次提交结果未知；请先刷新核对并解除锁定，再重新操作。");
      return;
    }
    if (!decisionVersionReady) {
      setError("该审批条目缺少 decisionVersion，已停止提交；请刷新队列后重试。");
      return;
    }
    if (targetScope === "project" && !selected.projectKey) {
      setError("该条目缺少 projectKey，无法保存到项目");
      return;
    }
    const taskOnly = selected.reason.includes("task-only");
    if (targetScope === "global" && taskOnly) {
      setError("task-only 候选不能提升为全局");
      return;
    }
    const snapshot = decisionSnapshotOf(selected, {
      title: editTitle,
      text: editText,
      note,
    });
    // Bind the draft object that exists at submit time. Reading it after the
    // await could bind a replacement object created while the request runs.
    const submittedDraft = draftsRef.current[snapshot.itemID];
    {
      const ok = await confirmAction({
        title: targetScope === "global" ? "提升为全局？" : "保存到项目？",
        message: targetScope === "global" ? "这条记忆会注入所有项目的新会话，且会立即离开候选队列。" : `这条记忆会用于项目“${selected.project ?? selected.projectKey}”的新会话，并离开候选队列。`,
        confirmLabel: targetScope === "global" ? "提升" : "保存到项目",
      });
      if (!ok) return;
    }
    const live = decisionInputsRef.current;
    if (
      !live.selected ||
      !sameDecisionSnapshot(
        snapshot,
        decisionSnapshotOf(live.selected, {
          title: live.title,
          text: live.text,
          note: live.note,
        }),
      )
    ) {
      setError("确认期间所选条目或内容已变化，已中止提交（未写入）。");
      return;
    }
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await api<{ ok: boolean; error?: string }>(
        `/api/queue/${encodeURIComponent(selected.id)}/decision`,
        {
          method: "POST",
          body: JSON.stringify({
            action: "promote",
            targetScope,
            projectKey: selected.projectKey,
            expectedVersion: snapshot.decisionVersion,
          }),
        },
      );
      if (!result.ok) {
        setError(result.error ?? "promotion failed");
        return;
      }
      setPendingDecision(null);
      setMessage(targetScope === "global" ? "已提升为全局" : "已保存到项目");
      onChanged();
    } catch (caught: unknown) {
      if (caught instanceof ApiError && caught.status >= 400 && caught.status < 500) {
        setError(errorMessage(caught));
      } else {
        setPendingDecision({ itemID: snapshot.itemID, action: "promote" });
        setError(
          `提交结果未知：${errorMessage(caught)}。请先刷新队列核对；核对前不会重复提交。该核对标记仅保存在当前页面，刷新页面或断开连接后会丢失。`,
        );
        onChanged();
      }
    } finally {
      setBusy(false);
    }
  }

  async function promoteNote(index: number, targetScope: "project" | "global") {
    const review = latestReview;
    const note = review?.sessionNotes?.[index];
    if (!review || !note) return;
    if (targetScope === "project" && !review.projectKey) {
      setError("本次复盘缺少 projectKey，无法保存到项目");
      return;
    }
    {
      const ok = await confirmAction({
        title: targetScope === "global" ? "提升会话记忆为全局？" : "保留为项目记忆？",
        message: targetScope === "global" ? "这条会话记忆会注入所有项目的新会话。" : `这条笔记会成为项目“${review.projectKey}”的长期记忆。`,
        confirmLabel: targetScope === "global" ? "提升" : "保留为项目",
      });
      if (!ok) return;
    }
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await api<{ ok: boolean; error?: string }>(
        `/api/reviews/${encodeURIComponent(review.id)}/notes/${index}/promote`,
        {
          method: "POST",
          body: JSON.stringify({
            targetScope,
            projectKey: review.projectKey,
            confirmedByUser: true,
          }),
        },
      );
      if (!result.ok) throw new Error(result.error ?? "promotion failed");
      setMessage(targetScope === "global" ? "已提升为全局" : "已保存到项目");
      onChanged();
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function createDraft() {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/api/queue/${encodeURIComponent(selected.id)}/draft`, { method: "POST" });
      setMessage("草稿已生成，等待人工检查，不会自动安装");
      onChanged();
      window.location.hash = "skills";
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }

  async function batchApplySuggestions() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await api<unknown>("/api/queue/batch", {
        method: "POST",
        body: JSON.stringify({
          ids,
          action: "apply_suggestion",
          minConfidence: 0.9,
          max: 10,
          dryRun: true,
        }),
      });
      const parsed = parseBatchPreview(response, ids);
      if (!parsed.ok) {
        setBatchPreview(null);
        setError(`批量预览不可用：${parsed.reason}。未执行任何条目。`);
        return;
      }
      setBatchPreview(parsed.preview);
      if (parsed.preview.eligible.length === 0) {
        setMessage(
          `没有可批量应用的条目（跳过 ${parsed.preview.skipped} 条，超限 ${parsed.preview.capped} 条）；未执行任何条目。`,
        );
        return;
      }
      setMessage(
        `批量预览已生成：将执行 ${parsed.preview.eligible.length} 条（跳过 ${parsed.preview.skipped} 条，超限 ${parsed.preview.capped} 条）。请核对下方明细后确认。`,
      );
    } catch (caught: unknown) {
      setBatchPreview(null);
      setError(`无法获取批量预览：${errorMessage(caught)}。未执行任何条目。`);
    } finally {
      setBusy(false);
    }
  }

  function cancelBatchPreview() {
    setBatchPreview(null);
    setMessage("已取消批量执行，未提交任何条目。");
    setError("");
  }

  async function confirmBatchExecution() {
    const preview = batchPreview;
    if (!preview || preview.eligible.length === 0) return;
    setBatchPreview(null);
    const ids = preview.eligible.map((entry) => entry.id);
    const scope: BatchRequestScope = {
      ids,
      previewID: preview.previewID,
      skipped: preview.skippedItems,
      capped: preview.cappedItems,
    };
    const labels: Record<string, string> = {};
    for (const entry of preview.eligible) {
      labels[entry.id] = entry.proposedTitle || entry.title;
    }
    setBatchLabels(labels);
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await api<unknown>("/api/queue/batch", {
        method: "POST",
        body: JSON.stringify(buildBatchExecution(preview)),
      });
      const resultsRaw =
        typeof response === "object" && response !== null && "results" in response
          ? response.results
          : undefined;
      const parsed = parseBatchResults(resultsRaw);
      if (!parsed.ok) {
        setBatchReport(unknownSubmissionReport(scope, parsed.reason));
        setSelectedIds(new Set());
        onChanged();
        return;
      }
      const report = summarizeBatchResults(scope, parsed.results);
      setBatchReport(report);
      setSelectedIds(new Set(report.retryIds));
      onChanged();
    } catch (caught: unknown) {
      const code = caught instanceof ApiError ? caught.code : undefined;
      if (classifyBatchSubmitFailure(code) === "not-submitted") {
        // The server explicitly rejected the preview before executing: nothing
        // was written, so the selection can be kept for a fresh preview.
        setBatchReport(null);
        setMessage(
          "服务端拒绝该预览（可能已过期），未提交任何条目；请重新选择后再次预览。",
        );
        setError("");
        return;
      }
      // A lost response cannot prove the request was not applied: keep the
      // batch size, ask for a refresh, and never mark it for blind retry.
      setBatchReport(unknownSubmissionReport(scope, errorMessage(caught)));
      setSelectedIds(new Set());
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function batchDeny() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const ok = await confirmAction({
      title: "批量拒绝候选？",
      message: `将拒绝 ${ids.length} 条候选。`,
      confirmLabel: "拒绝",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setMessage("");
    setError("");
    const labels: Record<string, string> = {};
    for (const item of items) {
      if (ids.includes(item.id)) labels[item.id] = item.title;
    }
    setBatchLabels(labels);
    try {
      const response = await api<unknown>("/api/queue/batch", {
        method: "POST",
        body: JSON.stringify({ ids, decision: { action: "deny" } }),
      });
      const resultsRaw =
        typeof response === "object" && response !== null && "results" in response
          ? response.results
          : undefined;
      const parsed = parseBatchResults(resultsRaw);
      if (!parsed.ok) {
        setBatchReport(unknownSubmissionReport({ ids }, parsed.reason));
        setSelectedIds(new Set());
        onChanged();
        return;
      }
      const report = summarizeBatchResults({ ids }, parsed.results);
      setBatchReport(report);
      setSelectedIds(new Set(report.retryIds));
      onChanged();
    } catch (caught: unknown) {
      setBatchReport(unknownSubmissionReport({ ids }, errorMessage(caught)));
      setSelectedIds(new Set());
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function runReview() {
    if (!latestReview?.sessionID || reviewBusy) return;
    setReviewBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await api<{ record: ReviewRecord | null; reason?: string }>("/api/reviews/run", {
        method: "POST",
        body: JSON.stringify({ sessionID: latestReview.sessionID }),
      });
      const counts = result.record ? reviewCountsView(result.record) : undefined;
      setMessage(
        result.record?.status === "failed" ? `复盘未完成：${result.record.error ?? "模型不可用，请稍后重试"}` : counts
          ? `复盘完成：提取 ${counts.candidates ?? "未知"} 条候选，生成 ${counts.hooksCreated ?? "未知"} 个待处理候选（未必进入审批队列）。`
          : result.reason ?? "没有可复盘的新内容。",
      );
      onChanged();
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setReviewBusy(false);
    }
  }

  async function dismissNote(index: number, restore: boolean) {
    if (!latestReview) return;
    setBusy(true);
    try {
      await api(`/api/reviews/${encodeURIComponent(latestReview.id)}/notes/${index}/dismiss`, { method: "POST", body: JSON.stringify({ restore }) });
      setMessage(restore ? "笔记已恢复" : "笔记已忽略，历史中仍可恢复");
      onChanged();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }

  const highCount = displayItems.filter((item) => (item.priority ?? 0) >= 75).length;
  const reviewView = latestReview ? reviewCountsView(latestReview) : undefined;
  const ruleCount = displayItems.filter((item) => item.kind === "rule").length;
  const allSelected =
    displayItems.length > 0 && displayItems.every((item) => selectedIds.has(item.id));

  function toggleAll() {
    setSelectedIds(
      allSelected ? new Set() : new Set(displayItems.map((item) => item.id)),
    );
  }

  function selectQueueItem(id: string) {
    if (targetItemID) consumedTarget.current = consumeTarget(targetItemID);
    setSelectedId(id);
  }

  function batchEntryLabel(id: string): string {
    const label = batchLabels[id];
    const short = shortItemID(id);
    return label ? `${label}（${short}）` : short || id;
  }

  function unlockPendingDecision() {
    setPendingDecision(null);
    setMessage("已解除该条目的提交锁定；请先确认服务端实际结果，再决定是否重新操作。");
  }

  function toggleOne(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  const scopeView = queueScopeView(
    displayItems.length,
    globalQueueTotal(globalQueueCount),
    hasFilters,
  );

  function clearFilters() {
    const empty = emptyQueueFilters();
    setKind(empty.kind);
    setScope(empty.scope);
    setProjectKey(empty.projectKey);
    setOriginFilter(empty.originFilter);
    setQueryInput(empty.queryInput);
    setQuery(empty.query);
  }

  return (
    <div>
      {turn?.turnID && turnView ? (
        <section className="turn-review">
          <div className="turn-review-main">
            <span className="turn-kicker">Turn Review</span>
            <strong>本轮捕获 {turnView.captured === null ? "未知" : turnView.captured} 条</strong>
            <span className="turn-counts">
              {turnView.entries.map((entry) => (
                <span
                  key={entry.status}
                  className={
                    entry.status === "failed"
                      ? "sev-error"
                      : entry.status === "blocked"
                        ? "warn"
                        : ""
                  }
                >
                  {entry.label} {entry.count === null ? "未知" : entry.count}
                </span>
              ))}
            </span>
            {turnView.note ? (
              <span className="muted small">{turnView.note}</span>
            ) : null}
          </div>
          <div className="turn-review-actions">
            <button
              className="btn"
              type="button"
              disabled={turnItems.length === 0}
              title={
                originFilter === "session-review"
                  ? "当前来源筛选下没有本轮候选"
                  : "仅选中当前筛选内的本轮候选"
              }
              onClick={() => setSelectedIds(new Set(turnItems.map((item) => item.id)))}
            >
              选中本轮待审
            </button>
          </div>
        </section>
      ) : null}

      {latestReview ? (
        <section
          className={`review-card ${latestReview.status === "failed" ? "review-card-error" : ""}`}
        >
          <div className="review-card-main">
            <div className="review-card-top">
              <span className="review-kicker">Session Review</span>
              <span className={`badge ${STATUS_TONE[latestReview.status]}`}>
                {STATUS_LABEL[latestReview.status]}
              </span>
              {latestReview.sessionID ? (
                <span className="mono muted small">#{latestReview.sessionID.slice(-6)}</span>
              ) : null}
            </div>
            <strong>会话复盘 · {formatReviewAge(latestReview.createdAt)}</strong>
            {nextReviewAt ? (
              <span className="review-counts">
                下次复盘 {formatClock(nextReviewAt)}
              </span>
            ) : null}
            {latestReview.status === "failed" ? (
              <span className="review-counts sev-error review-error" title={latestReview.error}>
                {latestReview.error ?? "复盘失败"}
              </span>
            ) : latestReview.status === "running" ? (
              <span className="review-counts">
                <span className="review-pulse" aria-hidden="true" />
                正在复盘…
              </span>
            ) : latestReview.status === "scheduled" ? (
              <span className="review-counts">已排期，等待会话安静</span>
            ) : latestReview.status === "skipped" ? null : reviewView ? (
              <span className="review-counts">
                {reviewView.segments.map((segment) => (
                  <span
                    key={segment.label}
                    className={segment.label === "生成候选" ? "ok" : ""}
                    title={
                      segment.label === "生成候选" ? reviewView.note : undefined
                    }
                  >
                    {segment.label} {segment.value === null ? "未知" : segment.value}
                  </span>
                ))}
                {latestReview.model ? <span className="mono">{latestReview.model}</span> : null}
              </span>
            ) : null}
            {latestReview.status === "skipped" ? (
              <p className="review-summary">
                {latestReview.note ?? "本次没有新的可沉淀内容"}
              </p>
            ) : null}
            {latestReview.status === "ready" && latestReview.summary?.[0] ? (
              <p className="review-summary">{latestReview.summary[0]}</p>
            ) : null}
          </div>
          <div className="review-card-actions">
            <select aria-label="选择复盘历史" className="select" value={reviewSelection} onChange={(event) => setReviewSelection(event.target.value)}>
              <option value="">最近一次复盘</option>
              {reviewHistory.map((entry) => <option key={entry.id} value={entry.id}>{new Date(entry.createdAt).toLocaleString()} · {entry.status}</option>)}
            </select>
            <button
              className="btn"
              type="button"
              disabled={!canRunReview || reviewBusy}
              title={
                canRunReview
                  ? "对最近一次复盘所属会话立即运行"
                  : "当前实例没有复盘触发器（CLI demo 使用独立服务）"
              }
              onClick={() => void runReview()}
            >
              {reviewBusy ? "复盘中…" : "立即复盘"}
            </button>
            <button
              className="btn"
              type="button"
              aria-pressed={originFilter === "session-review"}
              onClick={() =>
                setOriginFilter(originFilter === "session-review" ? "" : "session-review")
              }
            >
              筛选会话复盘
            </button>
            {!canRunReview ? (
              <span className="muted small">当前实例未接后台调度</span>
            ) : null}
          </div>
        </section>
      ) : null}

      {latestReview && latestReview.sessionNotes?.length ? (
        <section className="panel">
          <div className="panel-head">
            <h2>会话记忆 · {latestReview.sessionNotes.length}</h2>
            <span className="muted small">仅本次会话，不进入全局前缀</span>
          </div>
          <div className="detail-body">
            {latestReview.sessionNotes.map((note, index) => (
              <div
                key={`${note.createdAt}-${index}`}
                style={{
                  display: "grid",
                  gap: 6,
                  padding: "8px 0",
                  borderTop: index > 0 ? "1px solid var(--border)" : undefined,
                }}
              >
                <div className="chips">
                  <span className="badge">
                    {REVIEW_TYPE_LABEL[note.type] ?? note.type}
                  </span>
                  {note.taskOnly ? <span className="chip">task-only</span> : null}
                  {note.status ? <span className="chip">{note.status === "promoted" ? "已保存长期记忆" : "已忽略"}</span> : null}
                </div>
                <div>{note.text}</div>
                <div className="actions">
                  <button
                    className="btn primary"
                    type="button"
                    disabled={
                      busy || Boolean(note.status) || note.taskOnly === true || !latestReview.projectKey
                    }
                    title={
                      latestReview.projectKey
                        ? "写入当前项目的长期记忆"
                        : "本次复盘缺少 projectKey"
                    }
                    onClick={() => void promoteNote(index, "project")}
                  >
                    保留为项目
                  </button>
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || Boolean(note.status) || note.taskOnly === true}
                    onClick={() => void promoteNote(index, "global")}
                  >
                    提升为全局
                  </button>
                  {note.status !== "promoted" ? <button className="btn" disabled={busy} onClick={() => void dismissNote(index, note.status === "dismissed")}>{note.status === "dismissed" ? "恢复笔记" : "忽略笔记"}</button> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="kpis">
        <div className="kpi" title="仅统计当前筛选结果，不代表全部待审">
          <span>{scopeView.visibleLabel}</span>
          <b className="warn">{scopeView.visible}</b>
        </div>
        <div className="kpi" title="来自 App 定期获取的 /api/metrics 快照（该接口会写入指标文件）；不可用时显示未知">
          <span>{scopeView.globalLabel}</span>
          <b>{scopeView.global === null ? "未知" : scopeView.global}</b>
        </div>
        <div className="kpi"><span>高优先级</span><b className="warn">{highCount}</b></div>
        <div className="kpi"><span>规则类</span><b>{ruleCount}</b></div>
        <div className="kpi"><span>已选</span><b>{selectedIds.size}</b></div>
      </div>

      {targetNotice ? (
        <div
          className={`banner ${targetNotice.tone === "error" ? "error" : ""}`}
          role="status"
        >
          {targetNotice.text}
        </div>
      ) : null}

      {pendingDecision ? (
        <div className="banner error" role="status">
          条目 {shortItemID(pendingDecision.itemID)} 的 {pendingDecision.action} 提交结果未知；请先刷新核对服务端结果，核对前不会重复提交。该标记仅保存在当前页面，刷新页面或断开连接后会丢失。
          <button className="btn" type="button" onClick={unlockPendingDecision}>
            已核对结果，解除提交锁定
          </button>
        </div>
      ) : null}

      {orphanDraftIDs.length > 0 ? (
        <div className="banner" role="status">
          有 {orphanDraftIDs.length} 条未保存草稿对应的审批条目不在当前列表中：
          {orphanDraftIDs.map((id) => (
            <button
              className="btn"
              key={id}
              type="button"
              title={id}
              onClick={() => selectQueueItem(id)}
            >
              查看草稿 {id.slice(0, 8)}…
            </button>
          ))}
        </div>
      ) : null}

      {message ? (
        <div className="banner ok" role="status">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="banner error" role="alert">
          {error}
        </div>
      ) : null}
      {baseline && baseline.state !== "ready" ? (
        <div className="banner warning" role="status">
          基线索引{baseline.state === "unavailable" ? "不可用" : baseline.state === "partial" ? "部分可用" : "为空"}：
          覆盖提示可能不完整，未匹配不等于未覆盖。
          {baseline.sections > 0 ? ` 已索引 ${baseline.sections} 个段落。` : ""}
        </div>
      ) : null}

      {batchPreview ? (
        <section className="panel" aria-label="批量执行确认">
          <div className="panel-head">
            <h2>批量执行确认</h2>
            <span className="muted small mono" title={batchPreview.previewID}>
              预览 {batchPreview.previewID.slice(0, 12)}
            </span>
          </div>
          <div className="detail-body">
            <p className="muted small" style={{ margin: 0 }}>
              执行清单已与服务端预览绑定；取消不会提交任何条目。
            </p>
            {batchPreview.eligible.length === 0 ? (
              <div className="empty">没有可执行的条目。</div>
            ) : (
              <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 12 }}>
                {batchPreview.eligible.map((entry) => (
                  <li key={entry.id}>
                    <div className="chips">
                      <span className="badge success">
                        {ACTION_LABEL[entry.action] ?? entry.action}
                      </span>
                      <span className="chip">
                        {Math.round(entry.confidence * 100)}% 集中度
                      </span>
                      <span className="chip project-chip" title={entry.projectKey}>
                        项目：{projectLabel(entry.projectKey)}
                      </span>
                      <span className="chip" title={entry.id}>
                        ID {shortItemID(entry.id)}
                      </span>
                    </div>
                    <div>
                      <strong>{entry.title}</strong>
                    </div>
                    <div className="muted small">建议标题：{entry.proposedTitle}</div>
                    <div className="diff" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>
                      {entry.proposedText}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {batchPreview.skippedItems.length > 0 ? (
              <div>
                <span className="badge warning">跳过 {batchPreview.skipped} 条</span>
                <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                  {batchPreview.skippedItems.map((entry) => (
                    <li key={entry.id}>
                      {entry.title ?? entry.id}（{shortItemID(entry.id)}）：{entry.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {batchPreview.cappedItems.length > 0 ? (
              <div>
                <span className="badge">超限 {batchPreview.capped} 条</span>
                <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                  {batchPreview.cappedItems.map((entry) => (
                    <li key={entry.id}>
                      {entry.title ?? entry.id}（{shortItemID(entry.id)}）：{entry.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="actions">
              <button
                className="btn primary"
                type="button"
                disabled={busy || batchPreview.eligible.length === 0}
                onClick={() => void confirmBatchExecution()}
              >
                确认执行 {batchPreview.eligible.length} 条
              </button>
              <button className="btn" type="button" disabled={busy} onClick={cancelBatchPreview}>
                取消
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {batchReport ? (
        <section className="panel" aria-label="批量执行结果">
          <div className="panel-head">
            <h2>批量执行结果</h2>
            <span className={`badge ${batchStatusTone(batchReport.status)}`}>
              {BATCH_STATUS_LABEL[batchReport.status]}
            </span>
          </div>
          <div className="detail-body">
            <div>{batchReport.message}</div>
            {batchReport.succeeded.length > 0 ? (
              <div className="chips">
                {batchReport.succeeded.map((id) => (
                  <span className="chip" key={id}>
                    ✓ {batchEntryLabel(id)}
                  </span>
                ))}
              </div>
            ) : null}
            {batchReport.failed.length > 0 ? (
              <div>
                <span className="badge error">失败 {batchReport.failed.length} 条</span>
                <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                  {batchReport.failed.map((entry) => (
                    <li key={entry.id}>
                      {batchEntryLabel(entry.id)}：{entry.error ?? "处理失败"}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {batchReport.unresolved.length > 0 ? (
              <div className="banner error" style={{ margin: 0 }}>
                <strong>状态未知：{batchReport.unresolved.length} 条未确认最终结果。</strong>
                <div>
                  请刷新队列核对后再决定是否重新提交；在核对完成前不要重新提交这些条目。
                </div>
                <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                  {batchReport.unresolved.map((id) => (
                    <li key={id}>{batchEntryLabel(id)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {batchReport.skipped.length > 0 ? (
              <div>
                <span className="badge warning">跳过 {batchReport.skipped.length} 条</span>
                <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                  {batchReport.skipped.map((entry) => (
                    <li key={entry.id}>
                      {entry.title ?? entry.id}（{shortItemID(entry.id)}）：{entry.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {batchReport.capped.length > 0 ? (
              <div>
                <span className="badge">超限 {batchReport.capped.length} 条</span>
                <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
                  {batchReport.capped.map((entry) => (
                    <li key={entry.id}>
                      {entry.title ?? entry.id}（{shortItemID(entry.id)}）：{entry.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {batchReport.error ? (
              <div className="muted small">{batchReport.error}</div>
            ) : null}
            {batchReport.retryIds.length > 0 ? (
              <div className="muted small">
                已选中 {batchReport.retryIds.length} 条失败项，可在上方复核后单独处理；跳过与超限项未选中。
              </div>
            ) : null}
            <div className="actions">
              <button className="btn" type="button" onClick={() => setBatchReport(null)}>
                关闭结果
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <div className="queue-layout">
        <section className="panel">
          <div className="panel-head">
            <h2>按决策优先级排序</h2>
            <span className="meta">建议已预填 · 一键批准</span>
          </div>
          <div className="toolbar">
            <div className="segmented" role="group" aria-label="候选来源">
              {([
                ["", "全部来源"],
                ["turn", "本轮捕获"],
                ["session-review", "会话复盘"],
              ] as const).map(([value, label]) => (
                <button
                  key={value || "all"}
                  type="button"
                  aria-pressed={originFilter === value}
                  className={originFilter === value ? "active" : ""}
                  onClick={() => setOriginFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <select
              className="select"
              aria-label="按类型筛选"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="">全部类型</option>
              <option value="rule">rule</option>
              <option value="preference">preference</option>
              <option value="fact">fact</option>
              <option value="reference">reference</option>
              <option value="skill">skill</option>
            </select>
            <select
              className="select"
              aria-label="按层级筛选"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="">全部层级</option>
              <option value="session">会话</option>
              <option value="project">项目</option>
              <option value="global">全局</option>
            </select>
            <select className="select project-filter" aria-label="按项目归属筛选" value={projectKey} onChange={(event) => setProjectKey(event.target.value)}>
              <option value="">全部项目归属</option>
              <option value="__unassigned__">无项目归属</option>
              {projectKey && projectKey !== "__unassigned__" && !projects.some((entry) => entry.key === projectKey) ? <option value={projectKey}>{projectKey}（暂无候选）</option> : null}
              {projects.map((entry) => <option key={entry.key} value={entry.key}>{entry.label} · {entry.key.length <= 12 ? entry.key : entry.key.slice(0, 8)}</option>)}
            </select>
            <input
              className="input"
              aria-label="搜索候选或原因"
              placeholder="搜索候选 / 原因"
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
            />
            <button className="btn" disabled={filterPending || queueError} onClick={toggleAll} type="button">
              {allSelected ? "取消全选" : "全选"}
            </button>
            <button
              className="btn primary"
              disabled={busy || filterPending || queueError || selectedIds.size === 0}
              onClick={() => void batchApplySuggestions()}
              type="button"
            >
              批量批准建议
            </button>
            <button
              className="btn"
              disabled={busy || filterPending || queueError || selectedIds.size === 0}
              onClick={() => void batchDeny()}
              type="button"
            >
              批量拒绝
            </button>
          </div>
          <div className="muted small filter-status" role="status" aria-live="polite">{queueError ? "筛选加载失败，请刷新后再处理候选。" : filterPending ? "正在更新筛选结果，操作暂不可用…" : `当前显示 ${displayItems.length} 条候选`}</div>
          <div className="table-wrap" aria-busy={filterPending}>
            <table>
              <thead>
                <tr>
                  <th scope="col" aria-label="选择" style={{ width: 44 }} />
                  <th>优先级</th>
                  <th>类型</th>
                  <th>候选</th>
                  <th>建议</th>
                  <th>层级</th>
                  <th>年龄</th>
                </tr>
              </thead>
              <tbody>
                {displayItems.map((item) => (
                  <tr
                    key={item.id}
                    data-queue-id={item.id}
                    className={item.id === selectedId ? "selected" : ""}
                    aria-current={item.id === selectedId}
                    onClick={() => selectQueueItem(item.id)}
                  >
                    <td onClick={(event) => event.stopPropagation()}>
                      <label className="queue-check">
                      <input
                        type="checkbox"
                        disabled={filterPending || queueError}
                        aria-label={`选择 ${item.title}`}
                        checked={selectedIds.has(item.id)}
                        onChange={() => toggleOne(item.id)}
                      />
                      </label>
                    </td>
                    <td>
                      <span className={`prio ${priorityClass(item.priority)}`}>
                        {item.priority ?? 0}
                      </span>
                    </td>
                    <td><span className="badge">{item.kind}</span></td>
                    <td>
                      <div className="candidate-title">
                        <button className="candidate-open" type="button" disabled={filterPending || queueError} aria-label={`查看 ${item.title}，项目归属 ${item.project ?? item.projectKey ?? "无"}`} onClick={() => selectQueueItem(item.id)}>{item.title}</button>
                        <span className="chip project-chip" title={item.project ?? item.projectKey}>{item.project?.split(/[\\/]/).filter(Boolean).at(-1) ?? item.projectKey ?? "无项目归属"}</span>
                        {item.origin === "session-review" ? (
                          <span className="chip review-chip">复盘</span>
                        ) : null}
                        <CoverageChip coverage={item.coverage} />
                      </div>
                      <div className="muted" style={{ fontSize: "0.66rem", marginTop: 2 }}>
                        {item.reason}
                      </div>
                    </td>
                    <td>
                      {item.suggestion ? (
                        <span
                          className={`badge ${
                            item.suggestionState === "failed"
                              ? "warning"
                              : item.suggestion.validation.ok
                                ? "success"
                                : "warning"
                          }`}
                          title={
                            item.suggestionState === "failed"
                              ? item.suggestionError
                              : undefined
                          }
                        >
                          {item.suggestionState === "failed"
                            ? "建议失败"
                            : ACTION_LABEL[item.suggestion.action]}
                        </span>
                      ) : item.suggestionState === "pending" ? (
                        <span className="badge warning">生成中</span>
                      ) : (
                        <span className="badge">—</span>
                      )}
                    </td>
                    <td>
                      <span className="badge">{SCOPE_LABEL[item.scope] ?? item.scope}</span>
                    </td>
                    <td className="muted">{formatAge(item.createdAt)}</td>
                  </tr>
                ))}
                {displayItems.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      {loading ? (
                        <div className="empty">载入中…</div>
                      ) : hasFilters ? (
                        <div className="empty">
                          没有符合当前筛选的候选。
                          <button className="btn" type="button" onClick={clearFilters}>
                            清除筛选
                          </button>
                        </div>
                      ) : (
                        <div className="empty">队列为空。新候选会在 session.idle 后进入这里。</div>
                      )}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="panel detail" ref={detailRef} tabIndex={-1} aria-label="候选详情">
          {!selected && orphanDraft ? (
            <div className="detail-body">
              <h2>草稿已保留</h2>
              <div className="banner error" role="status">
                该审批条目不在当前筛选结果中（可能被筛选隐藏或已离开队列）。草稿不会自动提交；可复制内容后明确放弃。
              </div>
              {pendingDecision && pendingDecision.itemID === selectedId ? (
                <div className="banner error" role="alert">
                  该条目上次提交结果未知（{pendingDecision.action}），请先核对服务端结果再决定；核对标记仅保存在当前页面。
                  <div className="actions">
                    <button
                      className="btn"
                      type="button"
                      onClick={unlockPendingDecision}
                    >
                      已核对结果，解除提交锁定
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="field">
                <label>标题</label>
                <textarea
                  className="textarea"
                  readOnly
                  aria-label="保留的草稿标题"
                  value={orphanDraft.title}
                  style={{ minHeight: 44 }}
                />
              </div>
              <div className="field">
                <label>建议正文</label>
                <textarea
                  className="textarea"
                  readOnly
                  aria-label="保留的草稿正文"
                  value={orphanDraft.text}
                  style={{ minHeight: 96 }}
                />
              </div>
              <div className="field">
                <label>备注</label>
                <textarea
                  className="textarea"
                  readOnly
                  aria-label="保留的草稿备注"
                  value={orphanDraft.note}
                  style={{ minHeight: 44 }}
                />
              </div>
              <div className="actions">
                <button
                  className="btn danger"
                  type="button"
                  onClick={() => void discardOrphanDraft()}
                >
                  放弃草稿
                </button>
              </div>
            </div>
          ) : !selected ? (
            <div className="empty">选择左侧一条候选，查看 AI 合并建议、优先级分解和操作。</div>
          ) : (
            <fieldset className="detail-body" disabled={busy || filterPending || queueError}>
              <h2>{selected.title}</h2>
              {draftConflict ? (
                <div className="banner error" style={{ margin: 0 }} role="alert">
                  <strong>
                    {draftConflict === "suggestion-changed"
                      ? "AI 建议已更新"
                      : draftConflict === "item-mismatch"
                        ? "草稿与当前审批条目不一致"
                        : draftConflict === "version-missing"
                          ? "缺少服务端决策版本，无法确认草稿版本"
                          : draftConflict === "version-changed"
                            ? "服务端决策版本已变化"
                            : "审批条目已更新"}
                    ：草稿仍保留，未应用到新版本。
                  </strong>
                  <div className="actions">
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={discardSelectedDraft}
                    >
                      丢弃草稿，使用当前版本
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={rebaselineSelectedDraft}
                    >
                      保留草稿并按当前版本重新确认
                    </button>
                  </div>
                </div>
              ) : null}
              {!decisionVersionReady ? (
                <div className="banner error" style={{ margin: 0 }} role="alert">
                  该审批条目缺少 decisionVersion，无法安全提交；请刷新队列后再操作。
                </div>
              ) : null}
              {decisionUnknownLocked && pendingDecision ? (
                <div className="banner error" style={{ margin: 0 }} role="alert">
                  <strong>
                    该条目上次提交结果未知（{pendingDecision.action}）。
                  </strong>
                  <div>
                    请先刷新队列核对服务端实际结果；核对前不会重复提交。该核对标记仅保存在当前页面，刷新页面或断开连接后会丢失。
                  </div>
                  <div className="actions">
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={unlockPendingDecision}
                    >
                      已核对结果，解除提交锁定
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="chips">
                <span className="chip">{selected.kind}</span>
                <span className="chip">{SCOPE_LABEL[selected.scope] ?? selected.scope}</span>
                <span className="chip project-chip" title={selected.project ?? selected.projectKey}>项目归属：{selected.project?.split(/[\\/]/).filter(Boolean).at(-1) ?? selected.projectKey ?? "无"}</span>
                {selected.origin === "session-review" ? (
                  <span className="chip review-chip">会话复盘</span>
                ) : null}
                <span className={`prio ${priorityClass(selected.priority)}`}>{selected.priority ?? 0}</span>
                {selected.deferredUntil && Date.parse(selected.deferredUntil) > Date.now() ? <span className="chip">已延后至 {new Date(selected.deferredUntil).toLocaleString()}</span> : null}
                {selected.suggestedAction ? <span className="chip">建议：{selected.suggestedAction}</span> : null}
                {selected.seenCount && selected.seenCount > 1 ? (
                  <span className="chip">seen {selected.seenCount}</span>
                ) : null}
              </div>
              <div className="field">
                <label>审计关联</label>
                {auditError ? (
                  <span className="muted small">无法读取审计报告，暂不显示关联。</span>
                ) : !auditReport ? (
                  <span className="muted small">正在核对审计关联…</span>
                ) : relatedFindings.length === 0 ? (
                  <span className="muted small">没有审计发现引用此审批条目。</span>
                ) : (
                  <div className="chips">
                    {relatedFindings.map((finding) => (
                      <a
                        className="chip"
                        key={finding.id}
                        href={auditFindingLink(finding.id, auditReport.generatedAt)}
                        title={`打开审计发现：${finding.title}`}
                      >
                        {finding.severity} · {finding.kind} · {finding.title}
                      </a>
                    ))}
                  </div>
                )}
              </div>
              <div className="field">
                <label>重复 / 合并线索</label>
                {duplicateClues?.available ? (
                  <div>
                    <div className="chips">
                      <span className="badge info">{duplicateClues.label}</span>
                    </div>
                    <div className="chips">
                      {duplicateClues.clues.map((clue) => (
                        <span className="chip" key={`${clue.source}-${clue.kind}`}>
                          {clue.text}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <span className="muted small">
                    {duplicateClues?.emptyText ?? "未标注"}
                  </span>
                )}
              </div>
              <div className="field">
                <label>基线覆盖</label>
                {selected.coverage?.length ? (
                  <div className="chips">
                    {selected.coverage.map((entry) => (
                      <span
                        className={`chip${coverageTone(entry.relation) ? ` ${coverageTone(entry.relation)}` : ""}`}
                        key={`${entry.sourceId}-${entry.line}`}
                        title={entry.source}
                      >
                        {coverageLabel(entry.relation)} · {shortSource(entry.source)} › {entry.heading}:{entry.line}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="muted small">
                    未匹配到 L0/L2 基线；这不等于“未覆盖”，可能只是词面不同或索引不可用。
                  </span>
                )}
              </div>
              <div className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.5 }}>
                {selected.reason}
              </div>

              <div className="actions" style={{ marginTop: 6 }}>
                {selected.deferredUntil && Date.parse(selected.deferredUntil) > Date.now() ? <button className="btn" disabled={busy || decisionsBlocked} onClick={() => void act("resume")}>取消延后</button> : null}
                {selected.scope === "session" && selected.kind !== "skill" ? (
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy || !selected.projectKey || decisionsBlocked}
                    title={
                      selected.projectKey
                        ? "写入候选所属项目的长期记忆"
                        : "该条目缺少 projectKey，无法保存到项目"
                    }
                    onClick={() => void promoteSelected("project")}
                  >
                    保存到项目
                  </button>
                ) : null}
                {selected.scope !== "global" && selected.kind !== "skill" ? (
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || selected.reason.includes("task-only") || decisionsBlocked}
                    title={
                      selected.reason.includes("task-only")
                        ? "task-only 内容不能提升为全局"
                        : "注入所有项目的新会话"
                    }
                    onClick={() => void promoteSelected("global")}
                  >
                    提升为全局
                  </button>
                ) : null}
              </div>

              {selected.origin === "session-review" && selected.evidence?.length ? (
                <div className="evidence">
                  <div className="evidence-head">
                    <span className="badge info">证据</span>
                    <span className="muted small">
                      {REVIEW_TYPE_LABEL[selected.reviewType ?? "fact"] ?? selected.reviewType} · 逐字引用
                    </span>
                  </div>
                  {selected.evidence.map((entry, index) => (
                    <blockquote
                      className="evidence-quote"
                      key={`${entry.messageID}-${index}`}
                    >
                      <p>“{entry.quote}”</p>
                      <footer>
                        {entry.kind === "user" ? "用户原话" : "工具输出"}
                        <span className="evidence-sep">·</span>
                        <code>{entry.messageID}</code>
                      </footer>
                    </blockquote>
                  ))}
                </div>
              ) : null}

              {selected.kind === "skill" ? (
                <div className="suggestion"><span className="badge info">流程候选</span><p className="muted small">先生成草稿，在 Skill Review 中检查步骤和验证方式；不会写入记忆或自动安装。</p><button className="btn primary" disabled={busy} onClick={() => void createDraft()}>生成草稿并检查</button></div>
              ) : selected.scope === "session" ? (
                <div className="suggestion">
                  <div className="suggestion-head">
                    <span className="badge warning">会话候选</span>
                  </div>
                  <div className="muted small">
                    仅本次会话，不能直接批准；请用上方“保存到项目 / 提升为全局”，或拒绝。
                  </div>
                </div>
              ) : suggestion ? (
                <div className="suggestion">
                  <div className="suggestion-head">
                    <span
                      className={`badge ${
                        selected.suggestionState === "failed" ? "warning" : "success"
                      }`}
                    >
                      {selected.suggestionState === "failed" ? "建议失败" : "AI 合并建议"}
                    </span>
                    <span className="chip">{ACTION_LABEL[suggestion.action]}</span>
                    {suggestion.targetTitle ? (
                      <span className="muted small">目标：{suggestion.targetTitle}</span>
                    ) : null}
                    <span className="spacer" />
                    <span className="conf">{Math.round(suggestion.confidence * 100)}% 集中度</span>
                  </div>
                  <div className="suggestion-meta">
                    <span>{suggestion.source === "systemtwo" ? "System Two 重写" : "模板合并"}</span>
                    {suggestion.model ? <span>{suggestion.model.id}</span> : null}
                    <span>{formatAge(suggestion.createdAt)}</span>
                  </div>
                  <div className="field">
                    <label>标题</label>
                    <input
                      className="input"
                      value={editTitle}
                      aria-label="候选标题"
                      disabled={suggestion.action === "reject_duplicate"}
                      onChange={(event) => editDraft("title", event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>建议文本（已预填，可直接批准）</label>
                    <textarea
                      className="textarea"
                      value={editText}
                      aria-label="建议文本"
                      disabled={suggestion.action === "reject_duplicate"}
                      onChange={(event) => editDraft("text", event.target.value)}
                      style={{ minHeight: 96 }}
                    />
                  </div>
                  <div className="suggestion-meta">
                    <span className={overLimit ? "sev-error" : ""}>
                      {editText.length} / {maxChars} 字
                    </span>
                    <span className={suggestion.validation.ok ? "ok" : "sev-error"}>
                      {suggestion.validation.ok ? "linter 通过" : "linter 未通过"}
                    </span>
                    {overLimit ? <span className="sev-error">超长</span> : null}
                    {suggestion.action === "reject_duplicate" ? (
                      <span className="muted">确认后会归档候选</span>
                    ) : null}
                  </div>
                  {suggestion.validation.errors.length > 0 ? (
                    <div className="banner error" style={{ margin: 0 }}>
                      {suggestion.validation.errors.join("；")}
                    </div>
                  ) : null}
                  {selected.suggestionState === "failed" && suggestion.validation.ok ? (
                    <div className="banner warning" style={{ margin: 0 }}>
                      上次生成失败：{selected.suggestionError ?? "未知原因"}。可重新生成，或直接编辑正文后应用。
                    </div>
                  ) : null}
                  {suggestion.dropped.length > 0 ? (
                    <div className="muted small">
                      已丢弃：{suggestion.dropped.map((drop) => `${drop.text}（${drop.reason}）`).join("；")}
                    </div>
                  ) : null}
                  <div className="muted small">{suggestion.rationale}</div>
                  <div className="actions">
                    <button
                      className="btn primary"
                      disabled={busy || !canApply || decisionsBlocked}
                      onClick={() => void act("apply_suggestion")}
                      type="button"
                    >
                      {primaryLabel(suggestion.action, edited)}
                    </button>
                    <button
                      className="btn"
                      disabled={busy || generating}
                      onClick={() => void generate(selected.id)}
                      type="button"
                    >
                      重新生成
                    </button>
                    <button className="btn" disabled={busy || decisionsBlocked} onClick={() => void act("defer")} type="button">
                      延后 24 小时
                    </button>
                    <button className="btn danger" disabled={busy || decisionsBlocked} onClick={() => void act("deny")} type="button">
                      拒绝
                    </button>
                  </div>
                </div>
              ) : selected.suggestionState === "pending" || generating ? (
                <div className="suggestion pending">
                  <div className="spinner" />
                  <div>
                    <strong>正在生成合并建议…</strong>
                    <div className="muted small">
                      通常几秒内完成。若长时间没有结果，可重新生成。
                    </div>
                    <div className="actions" style={{ marginTop: 8 }}>
                      <button
                        className="btn"
                        disabled={busy || generating}
                        onClick={() => void generate(selected.id)}
                        type="button"
                      >
                        重新生成
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="suggestion">
                  <div className="suggestion-head">
                    <span className="badge warning">尚未生成建议</span>
                    <span className="spacer" />
                  </div>
                  <div className="muted small">
                    可以直接作为新条目通过，或让 System One + System Two 生成合并建议。
                  </div>
                  <div className="actions">
                    <button className="btn primary" disabled={busy || generating} onClick={() => void generate(selected.id)} type="button">
                      生成建议
                    </button>
                    <button className="btn" disabled={busy || decisionsBlocked} onClick={() => void act("approve")} type="button">
                      作为新记忆批准
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: "grid", gap: 5 }}>
                <Bar label="risk" value={selected.priorityBreakdown?.risk ?? 0} tone="high" />
                <Bar label="impact" value={selected.priorityBreakdown?.impact ?? 0} tone="mid" />
                <Bar label="uncertainty" value={selected.priorityBreakdown?.uncertainty ?? 0} tone="low" />
                <Bar label="age" value={selected.priorityBreakdown?.age ?? 0} tone="low" />
              </div>

              {reasonsOf(selected).length > 0 ? (
                <div className="chips">
                  {reasonsOf(selected).map((reason) => (
                    <span className="chip" key={reason}>{reason}</span>
                  ))}
                </div>
              ) : null}

              {!suggestion ? (
                <>
                  <div className="diff">{selected.diff ?? `+ ${selected.text}`}</div>
                  <div className="actions">
                    <button className="btn" disabled={busy || decisionsBlocked} onClick={() => void act("defer")} type="button">
                      延后 24 小时
                    </button>
                    <button className="btn danger" disabled={busy || decisionsBlocked} onClick={() => void act("deny")} type="button">
                      拒绝
                    </button>
                  </div>
                </>
              ) : null}

              <div className="field">
                <label>备注（可选）</label>
                <input
                  className="input"
                  aria-label="审批备注"
                  value={note}
                  onChange={(event) => editDraft("note", event.target.value)}
                  placeholder="为什么这样处理"
                />
              </div>

              <p className="muted" style={{ fontSize: "0.66rem", lineHeight: 1.45, margin: 0 }}>
                建议来源会标注 System Two 或模板；批准后写入 items.jsonl 并重建 AUTO_MEMORY / AUTO_RULES，24h 内可撤销。
              </p>
            </fieldset>
          )}
        </aside>
      </div>
    </div>
  );
}

function CoverageChip({ coverage }: { coverage: QueueItem["coverage"] }) {
  if (!coverage?.length) return null;
  const tone = coverageTone(coverage[0].relation);
  return (
    <span
      className={`chip${tone ? ` ${tone}` : ""}`}
      title={coverage.map((entry) => `${entry.source} › ${entry.heading}:${entry.line}`).join("\n")}
    >
      {coverageLabel(coverage[0].relation)}
    </span>
  );
}

function coverageLabel(relation: string): string {
  if (relation === "exact" || relation === "covered") return "基线已覆盖";
  if (relation === "conflict") return "基线冲突";
  if (relation === "classification-mismatch") return "基线分类不一致";
  if (relation === "partial") return "基线部分重合";
  if (relation === "related") return "基线相关";
  return "基线待确认";
}

function coverageTone(relation: string): string {
  if (relation === "conflict") return "warn";
  if (relation === "exact" || relation === "covered") return "ok";
  return "";
}

function shortSource(source: string): string {
  return source.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
}

const BATCH_STATUS_LABEL: Record<BatchResultStatus, string> = {
  ok: "全部成功",
  partial: "部分失败",
  failed: "全部失败",
  unknown: "状态未知",
};

function batchStatusTone(status: BatchResultStatus): string {
  if (status === "ok") return "success";
  if (status === "partial") return "warning";
  if (status === "unknown") return "info";
  return "error";
}

function projectLabel(key: string): string {
  return key.split(/[\\/]/).filter(Boolean).at(-1) ?? key;
}

function primaryLabel(action: Suggestion["action"], edited: boolean): string {
  if (action === "reject_duplicate") return "确认拒绝重复";
  if (action === "keep_both") return "保留两条";
  if (action === "create") return edited ? "改后批准" : "批准为新条目";
  if (action === "merge_into") return edited ? "改后批准合并" : "批准合并";
  return edited ? "改后批准替换" : "批准替换";
}

function reasonsOf(item: QueueItem): string[] {
  return item.decision?.reasons ?? item.jev?.reasons ?? [];
}

function Bar({ label, value, tone }: { label: string; value: number; tone: "high" | "mid" | "low" }) {
  const width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
  return (
    <div className="bar-row">
      <span>{label}</span>
      <div className="track">
        <div
          className={`fill ${tone === "mid" ? "mid" : tone === "low" ? "low" : ""}`}
          style={{ width }}
        />
      </div>
      <span>{value.toFixed(2)}</span>
    </div>
  );
}

function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
