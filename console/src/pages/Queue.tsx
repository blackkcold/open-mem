import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatAge, formatReviewAge, priorityClass } from "../api";
import { confirmAction } from "../extension/confirm";
import type { Config, QueueItem, ReviewRecord, Suggestion, TurnSummary } from "../types";

interface Props {
  refreshKey: number;
  onChanged: () => void;
}

type Action = "approve" | "deny" | "defer" | "resume" | "apply_suggestion";

const ACTION_LABEL: Record<Suggestion["action"], string> = {
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

export function QueuePage({ refreshKey, onChanged }: Props) {
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

  const turnItems = useMemo(
    () => (turn?.turnID ? items.filter((item) => item.turnID === turn.turnID) : []),
    [items, turn?.turnID],
  );
  const displayItems = items;

  const selected = useMemo(
    () => displayItems.find((item) => item.id === selectedId) ?? null,
    [displayItems, selectedId],
  );
  const suggestion = selected?.suggestion;
  useEffect(() => {
    if (selectedId && window.matchMedia("(max-width: 900px)").matches) {
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    }
  }, [selectedId]);
  const maxChars = selected
    ? selected.kind === "rule"
      ? limits.rule
      : limits.memory
    : limits.memory;
  const overLimit = editText.length > maxChars || editTitle.length > limits.title;
  const edited = Boolean(
    suggestion &&
      (editTitle !== suggestion.proposedTitle || editText !== suggestion.proposedText),
  );
  const canApply = Boolean(
    suggestion && !overLimit && (suggestion.validation.ok || edited),
  );

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
    api<{ items: QueueItem[]; projects?: Array<{ key: string; label: string }> }>(`/api/queue?${params.toString()}`)
      .then((data) => {
        if (id !== requestID.current) return;
        setItems(data.items);
        setProjects(data.projects ?? []);
        setLoadedFilter(filterKey);
        setQueueError(false);
        setError("");
        setSelectedId((current) =>
          current && data.items.some((item) => item.id === current) ? current : null,
        );
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
    if (!selected) return;
    setEditTitle(selected.suggestion?.proposedTitle ?? selected.title);
    setEditText(selected.suggestion?.proposedText ?? selected.text);
    setNote("");
  }, [selected?.id, selected?.suggestion?.id]);

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
            ? { ...item, suggestion: result, suggestionState: "ready" }
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
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await api<{
        ok: boolean;
        error?: string;
        target?: string;
        journalID?: string;
      }>(`/api/queue/${selected.id}/decision`, {
        method: "POST",
        body: JSON.stringify({
          action,
          title: editTitle,
          text: editText,
          note,
        }),
      });
      if (!result.ok) throw new Error(result.error ?? "decision failed");
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
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function promoteSelected(targetScope: "project" | "global") {
    if (!selected) return;
    if (targetScope === "project" && !selected.projectKey) {
      setError("该条目缺少 projectKey，无法保存到项目");
      return;
    }
    const taskOnly = selected.reason.includes("task-only");
    if (targetScope === "global" && taskOnly) {
      setError("task-only 候选不能提升为全局");
      return;
    }
    {
      const ok = await confirmAction({
        title: targetScope === "global" ? "提升为全局？" : "保存到项目？",
        message: targetScope === "global" ? "这条记忆会注入所有项目的新会话，且会立即离开候选队列。" : `这条记忆会用于项目“${selected.project ?? selected.projectKey}”的新会话，并离开候选队列。`,
        confirmLabel: targetScope === "global" ? "提升" : "保存到项目",
      });
      if (!ok) return;
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
      const preview = await api<{
        dryRun: boolean;
        eligible: Array<{ id: string; title: string; action?: string; confidence?: number }>;
        skipped: number;
        capped: number;
      }>("/api/queue/batch", {
        method: "POST",
        body: JSON.stringify({
          ids,
          action: "apply_suggestion",
          minConfidence: 0.9,
          max: 10,
          dryRun: true,
        }),
      });
      if (preview.eligible.length === 0) {
        setMessage(
          `没有可批量批准的条目（规则、低集中度、缺少建议会被跳过；跳过 ${preview.skipped} 条）。`,
        );
        return;
      }
      const ok = await confirmAction({
        title: "批量应用建议？",
        message: `将应用 ${preview.eligible.length} 条建议（最多 10 条，跳过 ${preview.skipped} 条，超出 ${preview.capped} 条）。`,
        confirmLabel: "应用",
      });
      if (!ok) return;
      const result = await api<{ results: Array<{ id: string; ok: boolean; error?: string }> }>(
        "/api/queue/batch",
        {
          method: "POST",
          body: JSON.stringify({
            ids: preview.eligible.map((entry) => entry.id),
            action: "apply_suggestion",
            max: 10,
            dryRun: false,
          }),
        },
      );
      const failed = result.results.filter((entry) => !entry.ok);
      setMessage(
        `已应用 ${result.results.length - failed.length} 条${failed.length ? `，失败 ${failed.length} 条` : ""}。`,
      );
      if (failed.length > 0) setError(failed.map((entry) => entry.error).filter(Boolean).join("; "));
      setSelectedIds(new Set());
      onChanged();
    } catch (caught: unknown) {
      setError(errorMessage(caught));
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
    try {
      await api("/api/queue/batch", {
        method: "POST",
        body: JSON.stringify({ ids, decision: { action: "deny" } }),
      });
      setSelectedIds(new Set());
      setMessage(`已拒绝 ${ids.length} 条`);
      onChanged();
    } catch (caught: unknown) {
      setError(errorMessage(caught));
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
      setMessage(
        result.record?.status === "failed" ? `复盘未完成：${result.record.error ?? "模型不可用，请稍后重试"}` : result.record
          ? `复盘完成：${result.record.candidates} 条候选，${result.record.queued ?? 0} 条入队。`
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
  const latestSkipped =
    latestReview && typeof latestReview.queued === "number"
      ? Math.max(0, latestReview.candidates - latestReview.queued - latestReview.dropped)
      : 0;
  const ruleCount = displayItems.filter((item) => item.kind === "rule").length;
  const allSelected =
    displayItems.length > 0 && displayItems.every((item) => selectedIds.has(item.id));

  function toggleAll() {
    setSelectedIds(
      allSelected ? new Set() : new Set(displayItems.map((item) => item.id)),
    );
  }

  function toggleOne(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  const hasFilters = Boolean(kind || scope || query || originFilter);

  function clearFilters() {
    setKind("");
    setScope("");
    setOriginFilter("");
    setQueryInput("");
    setQuery("");
  }

  return (
    <div>
      {turn?.turnID ? (
        <section className="turn-review">
          <div className="turn-review-main">
            <span className="turn-kicker">Turn Review</span>
            <strong>本轮捕获 {turn.counts.captured} 条</strong>
            <span className="turn-counts">
              <span className="ok">自动 {turn.counts.auto}</span>
              <span className="warn">待审 {turn.counts.queue}</span>
              <span>Shadow {turn.counts.shadow}</span>
              <span>忽略 {turn.counts.ignored}</span>
              {turn.counts.pending > 0 ? (
                <span>处理中 {turn.counts.pending}</span>
              ) : null}
              {turn.counts.failed > 0 ? (
                <span className="sev-error">失败 {turn.counts.failed}</span>
              ) : null}
            </span>
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
            ) : latestReview.status === "skipped" ? null : (
              <span className="review-counts">
                <span className="ok">入队 {latestReview.queued ?? 0}</span>
                <span>提取 {latestReview.candidates}</span>
                <span>丢弃 {latestReview.dropped}</span>
                {latestSkipped > 0 ? <span>跳过 {latestSkipped}</span> : null}
                {typeof latestReview.chars === "number" ? <span>{latestReview.chars} 字</span> : null}
                {latestReview.model ? <span className="mono">{latestReview.model}</span> : null}
              </span>
            )}
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
        <div className="kpi" title="当前筛选下的候选数；侧栏徽标显示全部待审">
          <span>当前筛选</span>
          <b className="warn">{displayItems.length}</b>
        </div>
        <div className="kpi"><span>高优先级</span><b className="warn">{highCount}</b></div>
        <div className="kpi"><span>规则类</span><b>{ruleCount}</b></div>
        <div className="kpi"><span>已选</span><b>{selectedIds.size}</b></div>
      </div>

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
                    onClick={() => setSelectedId(item.id)}
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
                        <button className="candidate-open" type="button" disabled={filterPending || queueError} aria-label={`查看 ${item.title}，项目归属 ${item.project ?? item.projectKey ?? "无"}`} onClick={() => setSelectedId(item.id)}>{item.title}</button>
                        <span className="chip project-chip" title={item.project ?? item.projectKey}>{item.project?.split(/[\\/]/).filter(Boolean).at(-1) ?? item.projectKey ?? "无项目归属"}</span>
                        {item.origin === "session-review" ? (
                          <span className="chip review-chip">复盘</span>
                        ) : null}
                      </div>
                      <div className="muted" style={{ fontSize: "0.66rem", marginTop: 2 }}>
                        {item.reason}
                      </div>
                    </td>
                    <td>
                      {item.suggestion ? (
                        <span className={`badge ${item.suggestion.validation.ok ? "success" : "warning"}`}>
                          {ACTION_LABEL[item.suggestion.action]}
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
          {!selected ? (
            <div className="empty">选择左侧一条候选，查看 AI 合并建议、优先级分解和操作。</div>
          ) : (
            <fieldset className="detail-body" disabled={busy || filterPending || queueError}>
              <h2>{selected.title}</h2>
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
              <div className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.5 }}>
                {selected.reason}
              </div>

              <div className="actions" style={{ marginTop: 6 }}>
                {selected.deferredUntil && Date.parse(selected.deferredUntil) > Date.now() ? <button className="btn" disabled={busy} onClick={() => void act("resume")}>取消延后</button> : null}
                {selected.scope === "session" && selected.kind !== "skill" ? (
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy || !selected.projectKey}
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
                    disabled={busy || selected.reason.includes("task-only")}
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
                    <span className="badge success">AI 合并建议</span>
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
                      onChange={(event) => setEditTitle(event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>建议文本（已预填，可直接批准）</label>
                    <textarea
                      className="textarea"
                      value={editText}
                      aria-label="建议文本"
                      onChange={(event) => setEditText(event.target.value)}
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
                  {suggestion.dropped.length > 0 ? (
                    <div className="muted small">
                      已丢弃：{suggestion.dropped.map((drop) => `${drop.text}（${drop.reason}）`).join("；")}
                    </div>
                  ) : null}
                  <div className="muted small">{suggestion.rationale}</div>
                  <div className="actions">
                    <button
                      className="btn primary"
                      disabled={busy || !canApply}
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
                    <button className="btn" disabled={busy} onClick={() => void act("defer")} type="button">
                      延后 24 小时
                    </button>
                    <button className="btn danger" disabled={busy} onClick={() => void act("deny")} type="button">
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
                    <button className="btn" disabled={busy} onClick={() => void act("approve")} type="button">
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
                    <button className="btn" disabled={busy} onClick={() => void act("defer")} type="button">
                      延后 24 小时
                    </button>
                    <button className="btn danger" disabled={busy} onClick={() => void act("deny")} type="button">
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
                  onChange={(event) => setNote(event.target.value)}
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
