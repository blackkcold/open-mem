import { useEffect, useRef, useState } from "react";
import { api, formatAge, formatPercent, formatReviewAge } from "../api";
import { confirmAction } from "../extension/confirm";
import type { Health, HealthScore, MergeJournal, UsageSummary } from "../types";
import {
  buildMergeUndoPreview,
  canApplyLoadRequest,
  canClearUnknownLocks,
  createLoadRequestGate,
  invalidateLoadRequests,
  isUnknownOutcome,
  loadMergeUndoLocks,
  lockMergeUndoUnknown,
  reconcileMergeUndoUnknown,
  resolveMergeUndoLocks,
  RESUME_UNDO_NOTICE,
  saveMergeUndoLocks,
  SESSION_ONLY_UNKNOWN_NOTICE,
  startLoadRequest,
  syncMergeUndoLeaveWarning,
  UNKNOWN_OUTCOME_NOTICE,
  unlockMergeUndoUnknown,
  type LoadRequestGate,
  type MergeJournalLoadState,
  type MergeUndoLocks,
  type MergeUndoLeaveTarget,
  type MergeUndoLockPersistence,
  type MergeUndoLockStorage,
  type MergeUndoStatus,
} from "./undo-preview";

interface Props {
  refreshKey: number;
  onChanged: () => void;
}

interface HistoryEntry { at: string; action: string; itemID?: string; queueID?: string; journalID?: string; recoveryID?: string; target?: string }
interface RetentionPreview {
  id: string;
  policy: { days: number; minRecords: number; sessionDays: number };
  deleteFiles: string[];
  archiveSessions: string[];
  pruneItems: number;
  pruneMerges: number;
  pruneHistory: number;
  reclaimableBytes: number;
  protectedCount: number;
}

const HISTORY_LABEL: Record<string, string> = { approve: "批准记忆", deny: "拒绝候选", promote: "提升范围", promote_session_note: "保留会话笔记", compact: "压缩", curator: "自动整理", edit: "编辑", defer: "延后", resume: "取消延后", undo_maintenance: "撤销整理", undo_merge: "撤销合并", restore_queue_action: "恢复候选", create_skill_draft: "生成流程草稿", dismiss_note: "忽略笔记", restore_note: "恢复笔记", capture_blocked: "容量待处理", capture_rejected: "敏感信息拦截" };

let sessionUnknownLocks: MergeUndoLocks = {};
let sessionUnlockTombstones = new Set<string>();
let sessionLockPersistence: MergeUndoLockPersistence = "unavailable";

const BREAKDOWN_LABELS: Array<[keyof HealthScore["breakdown"], string]> = [
  ["capacity", "容量"],
  ["duplicates", "重复"],
  ["conflicts", "冲突"],
  ["falsePositive", "Shadow 误报"],
  ["queueAge", "队列年龄"],
  ["decisionFallback", "决策降级"],
  ["rewriteFallback", "重写降级"],
  ["acceptance", "建议拒绝率"],
  ["undo", "撤销次数"],
];

export function HealthPage({ refreshKey, onChanged }: Props) {
  const [health, setHealth] = useState<HealthScore>();
  const [healthInfo, setHealthInfo] = useState<Health>();
  const [usage, setUsage] = useState<UsageSummary>();
  const [journal, setJournal] = useState<MergeJournal[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retention, setRetention] = useState<RetentionPreview>();
  const [journalLoadState, setJournalLoadState] = useState<MergeJournalLoadState>("loading");
  const [unknownLocks, setUnknownLocks] = useState<MergeUndoLocks>(() => initialMergeUndoLocks());
  const [lockPersistence, setLockPersistence] = useState<MergeUndoLockPersistence>(
    () => sessionLockPersistence,
  );
  const unknownLocksRef = useRef(unknownLocks);
  const loadGate = useRef<LoadRequestGate>(createLoadRequestGate());

  function updateUnknownLocks(next: MergeUndoLocks) {
    for (const id of Object.keys(unknownLocksRef.current)) {
      if (!(id in next)) sessionUnlockTombstones.add(id);
    }
    unknownLocksRef.current = next;
    sessionUnknownLocks = next;
    setUnknownLocks(next);
    const persistence = saveMergeUndoLocks(mergeUndoLockStorage(), next);
    sessionLockPersistence = persistence;
    setLockPersistence(persistence);
  }

  useEffect(() => {
    const gate = loadGate.current;
    gate.mounted = true;
    return () => {
      // In-flight responses must not write state after this page is unmounted.
      // The session-level beforeunload warning is intentionally left alone.
      invalidateLoadRequests(gate);
    };
  }, []);

  useEffect(() => {
    void load();
  }, [refreshKey]);

  useEffect(() => {
    syncMergeUndoLeaveWarning(
      mergeUndoLeaveWarningTarget(),
      Object.keys(unknownLocks).length,
      lockPersistence,
    );
  }, [unknownLocks, lockPersistence]);

  async function load() {
    const gate = loadGate.current;
    const requestID = startLoadRequest(gate);
    if (!canApplyLoadRequest(gate, requestID)) return;
    setJournalLoadState("loading");
    try {
      const [nextHealth, nextUsage, nextJournal, nextInfo, nextHistory] = await Promise.all([
        api<HealthScore>("/api/health-score"),
        api<UsageSummary>("/api/usage"),
        api<{ items: MergeJournal[] }>("/api/journal"),
        api<Health>("/api/health"),
        api<{ items: HistoryEntry[] }>("/api/changelog?limit=50"),
      ]);
      if (!canApplyLoadRequest(gate, requestID)) return;
      setHealth(nextHealth);
      setUsage(nextUsage);
      setJournal(nextJournal.items);
      setHealthInfo(nextInfo);
      setHistory(nextHistory.items);
      const reconciled = reconcileMergeUndoUnknown(unknownLocksRef.current, nextJournal.items);
      if (reconciled !== unknownLocksRef.current) updateUnknownLocks(reconciled);
      setJournalLoadState("ready");
      setError("");
    } catch (caught: unknown) {
      if (!canApplyLoadRequest(gate, requestID)) return;
      setJournalLoadState("failed");
      setError(errorMessage(caught));
    }
  }

  async function compact() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const preview = await api<{ merged: number; archived: number }>("/api/compact/preview");
      const ok = await confirmAction({ title: "压缩与整理历史？", message: `预计合并 ${preview.merged} 条、归档 ${preview.archived} 条；不会更改规则或人工批准的记忆。历史记录会按容量保留，记忆合并会先备份并可撤销。`, confirmLabel: "确认整理" });
      if (!ok) return;
      const result = await api<{
        merged: number;
        archived: number;
        itemsBefore: number;
        itemsAfter: number;
      }>("/api/compact", { method: "POST", body: JSON.stringify({ confirmedByUser: true }) });
      setMessage(
        `压缩完成：合并 ${result.merged} 条，归档 ${result.archived} 条，${result.itemsBefore} → ${result.itemsAfter} 条。`,
      );
      onChanged();
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function previewHistory() {
    setBusy(true);
    setError("");
    try { setRetention(await api<RetentionPreview>("/api/retention/preview")); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }

  async function cleanHistory() {
    if (!retention) return;
    const rows = retention.pruneItems + retention.pruneMerges + retention.pruneHistory;
    if (!await confirmAction({ title: "清理预览中的过期历史？", message: `将删除 ${retention.deleteFiles.length} 个历史文件、${rows} 条过期记录，冷归档 ${retention.archiveSessions.length} 个会话状态。活跃记忆和队列不变；删除的过期历史不再提供恢复。数据变化会要求重新预览。`, confirmLabel: "确认清理这些历史", danger: true })) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/retention/apply", { method: "POST", body: JSON.stringify({ previewID: retention.id, confirmedByUser: true }) });
      setRetention(undefined);
      setMessage("历史清理完成；旧会话续聊仍可读取冷归档状态。");
      onChanged();
    } catch (caught) { setError(errorMessage(caught)); setRetention(undefined); }
    finally { setBusy(false); }
  }

  async function undoMaintenance(id: string) {
    if (!await confirmAction({ title: "撤销这次整理？", message: "只恢复本次整理改动的记忆，不覆盖之后新增的条目。如条目已被编辑，将提示冲突。", confirmLabel: "撤销" })) return;
    setBusy(true);
    try {
      await api(`/api/maintenance/${encodeURIComponent(id)}/undo`, { method: "POST" });
      setMessage("已撤销整理");
      onChanged();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }

  async function restoreAction(id: string) {
    if (!await confirmAction({ title: "恢复到审批队列？", message: "本次操作产生的记忆会归档，原候选恢复到队列供重新决定。若条目已被修改，将提示冲突。", confirmLabel: "恢复" })) return;
    setBusy(true);
    try {
      await api(`/api/recovery/${encodeURIComponent(id)}/restore`, { method: "POST" });
      setMessage("已恢复到审批队列");
      onChanged();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }

  async function undo(entry: MergeJournal, mode: "normal" | "resume" = "normal") {
    const preview = buildMergeUndoPreview(entry, {
      now: Date.now(),
      unknownSince: unknownLocksRef.current[entry.id],
    });
    if (mode === "resume" ? !preview.canResume : !preview.canUndo) {
      setError(preview.deadline);
      return;
    }
    const message = mode === "resume"
      ? [
          RESUME_UNDO_NOTICE,
          `服务端会按记录内容处理：${preview.effects.join("；")}。`,
          preview.deadline,
          preview.hint,
        ].join(" ")
      : [
          `动作：${preview.actionLabel}（${preview.actionMeaning}）。`,
          `撤销后会：${preview.effects.join("；")}。`,
          preview.deadline,
          preview.hint,
        ].join(" ");
    const ok = await confirmAction({
      title: mode === "resume" ? "继续未完成的撤销？" : `撤销${preview.actionLabel}？`,
      message,
      confirmLabel: mode === "resume" ? "核对后继续撤销" : "撤销",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await api(`/api/merge/${encodeURIComponent(entry.id)}/undo`, { method: "POST" });
      updateUnknownLocks(unlockMergeUndoUnknown(unknownLocksRef.current, entry.id));
      setMessage(
        mode === "resume"
          ? `已完成未完成的撤销（${preview.actionLabel}）`
          : `已撤销${preview.actionLabel}`,
      );
      onChanged();
    } catch (caught: unknown) {
      if (isUnknownOutcome(caught)) {
        updateUnknownLocks(
          lockMergeUndoUnknown(
            unknownLocksRef.current,
            entry.id,
            new Date().toISOString(),
          ),
        );
        setError(UNKNOWN_OUTCOME_NOTICE);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  async function acknowledgeUnknown(entryID: string) {
    if (!await confirmAction({
      title: "解除“状态未知”标记？",
      message: "解除后，如果记录仍在撤销窗口内，可以再次发送撤销请求。请先刷新并核对目标条目、候选队列和备份；解除标记本身不会发送任何写操作。",
      confirmLabel: "我已核对，解除标记",
    })) return;
    updateUnknownLocks(unlockMergeUndoUnknown(unknownLocksRef.current, entryID));
    setError("");
    setMessage("已解除该条记录的“状态未知”标记；未发送任何撤销或修改请求，请自行核对服务端结果。");
  }

  async function acknowledgeHiddenUnknown() {
    if (!canClearUnknownLocks(journalLoadState)) {
      setError("合并记录尚未成功加载，无法核对并清除更早的“状态未知”标记；请先刷新成功后再试。");
      return;
    }
    const visible = new Set(journal.map((entry) => entry.id));
    const hidden = Object.keys(unknownLocksRef.current).filter((id) => !visible.has(id));
    if (hidden.length === 0) return;
    if (!await confirmAction({
      title: "确认已人工核对？",
      message: `将清除 ${hidden.length} 条不在最近合并记录中的“状态未知”标记。此操作不会发送撤销、删除或修改请求；请先核对服务端记录与备份。`,
      confirmLabel: "我已核对，清除标记",
    })) return;
    let next = unknownLocksRef.current;
    for (const id of hidden) next = unlockMergeUndoUnknown(next, id);
    updateUnknownLocks(next);
    setError("");
    setMessage(`已清除 ${hidden.length} 条更早的“状态未知”标记；未发送任何写操作。`);
  }

  const grade = health?.grade ?? "warn";
  const gradeLabel =
    grade === "good" ? "健康" : grade === "ok" ? "可用" : grade === "warn" ? "注意" : "需处理";
  const reviewFailureRate =
    usage && usage.reviewCalls > 0 ? usage.reviewFailures / usage.reviewCalls : 0;
  const now = Date.now();
  const visibleJournalIDs = new Set(journal.map((entry) => entry.id));
  const unknownLockCount = Object.keys(unknownLocks).length;
  const hiddenUnknownCount = Object.keys(unknownLocks).filter(
    (id) => !visibleJournalIDs.has(id),
  ).length;

  return (
    <div className="health">
      <div className="kpis">
        <div className="kpi"><span>健康分</span><b className={`health-score ${grade}`}>{health?.score ?? "—"}</b></div>
        <div className="kpi"><span>容量</span><b>{formatPercent(health?.details.capacityRatio ?? 0)}</b></div>
        <div className="kpi"><span>重复率</span><b className="warn">{formatPercent(health?.details.duplicateRate ?? 0)}</b></div>
        <div className="kpi"><span>建议采纳率</span><b className="good">{formatPercent(health?.details.suggestionAcceptance ?? 1)}</b></div>
      </div>

      {message ? <div className="banner ok" role="status">{message}</div> : null}
      {error ? <div className="banner error" role="alert">{error}</div> : null}

      {healthInfo?.review ? (
        <section className="panel" style={{ marginBottom: 12 }}>
          <div className="panel-head">
            <h2>Session Review</h2>
            <span className={`badge ${healthInfo.review.enabled ? "success" : "warning"}`}>
              {healthInfo.review.enabled ? "开启" : "关闭"}
            </span>
            <span className="meta">
              {healthInfo.review.model.id}
              {healthInfo.review.model.variant ? `#${healthInfo.review.model.variant}` : ""}
            </span>
          </div>
          <div
            className="detail-body"
            style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, alignItems: "center" }}
          >
            {healthInfo.review.runtime ? (
              <>
                <span className="muted small">
                  已排期 {healthInfo.review.runtime.scheduled ?? 0}
                </span>
                <span className="muted small">
                  运行中 {healthInfo.review.runtime.running ?? 0}
                </span>
                <span className="muted small">
                  近一小时 {healthInfo.review.runtime.runsLastHour ?? 0} /{" "}
                  {healthInfo.review.maxPerHour}
                </span>
                <span className="muted small">
                  上次{" "}
                  {healthInfo.review.runtime.lastRunAt
                    ? formatReviewAge(healthInfo.review.runtime.lastRunAt)
                    : "—"}
                </span>
                {healthInfo.review.runtime.openUntil ? (
                  <span className="badge warning">熔断中</span>
                ) : null}
                {healthInfo.review.runtime.lastError ? (
                  <span
                    className="sev-error small"
                    title={healthInfo.review.runtime.lastError}
                  >
                    {healthInfo.review.runtime.lastError}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="muted small">运行时不可用（CLI demo 无后台调度）</span>
            )}
          </div>
        </section>
      ) : null}

      <div className="health-layout">
        <section className="panel">
          <div className="panel-head">
            <h2>记忆健康</h2>
            <span className={`badge ${grade === "good" ? "success" : grade === "bad" ? "error" : "warning"}`}>
              {gradeLabel}
            </span>
            <button className="btn" disabled={busy} onClick={() => void compact()} type="button">
              {busy ? "处理中…" : "运行压缩"}
            </button>
            <button className="btn ghost" onClick={() => void load()} type="button">刷新</button>
          </div>
          <div className="detail-body">
            <div className={`health-hero ${grade}`}>
              <div className="score">{health?.score ?? "—"}</div>
              <div>
                <strong>{gradeLabel}</strong>
                <div className="muted small">
                  容量、重复、冲突、误报、队列年龄、降级、建议采纳与撤销的综合得分。
                </div>
              </div>
            </div>
            <div className="breakdown">
              {BREAKDOWN_LABELS.map(([key, label]) => (
                <Bar key={key} label={label} value={health?.breakdown[key] ?? 0} />
              ))}
            </div>
            <div className="health-facts">
              <span>条目 {health?.details.items ?? 0}</span>
              <span>队列 {health?.details.queue ?? 0}</span>
              <span>Shadow {health?.details.shadow ?? 0}</span>
              <span>冲突 {health?.details.conflictCount ?? 0}</span>
              <span>队列 p95 {health?.details.queueAgeP95Hours ?? 0}h</span>
              <span>撤销 {health?.details.undoCount ?? 0}</span>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><h2>模型调用</h2><span className="meta">近 30 天</span></div>
          <div className="detail-body">
            <div className="usage-row">
              <div>
                <span className="muted small">System One</span>
                <b>{usage?.decisionCalls ?? 0} 次</b>
              </div>
              <div>
                <span className="muted small">tokens</span>
                <b>{usage?.decisionTokens ?? 0}</b>
              </div>
              <div>
                <span className="muted small">降级</span>
                <b className={(usage?.decisionFallbackRate ?? 0) > 0.2 ? "sev-error" : ""}>
                  {formatPercent(usage?.decisionFallbackRate ?? 0)}
                </b>
              </div>
            </div>
            <div className="usage-row">
              <div>
                <span className="muted small">System Two</span>
                <b>{usage?.rewriteCalls ?? 0} 次</b>
              </div>
              <div>
                <span className="muted small">tokens</span>
                <b>{usage?.rewriteTokens ?? 0}</b>
              </div>
              <div>
                <span className="muted small">降级</span>
                <b className={(usage?.rewriteFallbackRate ?? 0) > 0.2 ? "sev-error" : ""}>
                  {formatPercent(usage?.rewriteFallbackRate ?? 0)}
                </b>
              </div>
            </div>
            <div className="usage-row">
              <div>
                <span className="muted small">Session Review</span>
                <b>{usage?.reviewCalls ?? 0} 次</b>
              </div>
              <div>
                <span className="muted small">tokens</span>
                <b>{usage?.reviewTokens ?? 0}</b>
              </div>
              <div>
                <span className="muted small">失败</span>
                <b className={reviewFailureRate > 0.2 ? "sev-error" : ""}>
                  {formatPercent(reviewFailureRate)}
                </b>
              </div>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              降级 = 模型不可用/超限/输出不合格时走 heuristic 或模板合并；不会阻塞队列。
            </p>
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 12 }} aria-label="历史保留与清理">
        <div className="panel-head"><h2>历史保留与清理</h2><span className="spacer" /><button className="btn" disabled={busy} onClick={() => void previewHistory()}>预览历史清理</button></div>
        <div className="detail-body">
          <p className="muted small">恢复记录至少保留 90 天及每类最近 20 次；90 天不活跃的会话状态可冷归档，续聊会保留原游标与固定上下文。不会后台自动删除。</p>
          {retention ? <div role="status">
            <p>预计清理 {retention.deleteFiles.length} 个文件、{retention.pruneItems + retention.pruneMerges + retention.pruneHistory} 条记录，释放约 {(retention.reclaimableBytes / 1024).toFixed(1)} KB；冷归档 {retention.archiveSessions.length} 个会话状态。</p>
            <p className="muted small">保守保护 {retention.protectedCount} 份记录；保护窗口内或时间不明的历史不会为满足容量强行删除。冷归档只减少活跃状态，不等于释放同等磁盘空间。</p>
            {retention.deleteFiles.length ? <details><summary>查看待清理文件名</summary><ul>{retention.deleteFiles.slice(0, 50).map((file) => <li key={file}><code>{file}</code></li>)}</ul>{retention.deleteFiles.length > 50 ? <p>另有 {retention.deleteFiles.length - 50} 个文件</p> : null}</details> : null}
            <div className="actions"><button className="btn danger" disabled={busy || !(retention.deleteFiles.length + retention.archiveSessions.length + retention.pruneItems + retention.pruneMerges + retention.pruneHistory)} onClick={() => void cleanHistory()}>确认清理预览项</button><button className="btn" disabled={busy} onClick={() => setRetention(undefined)}>取消预览</button></div>
          </div> : null}
        </div>
      </section>

      <section className="panel" style={{ marginTop: 12 }} aria-label="操作历史">
        <div className="panel-head"><h2>操作历史</h2><span className="meta">最近 50 条 · 不含私密原文</span></div>
        {history.length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>操作</th><th>对象</th><th>恢复</th></tr></thead><tbody>
          {history.map((entry, index) => <tr key={`${entry.at}-${index}`}><td>{formatAge(entry.at)}</td><td>{HISTORY_LABEL[entry.action] ?? (entry.action === "retention" ? "历史清理" : entry.action)}</td><td className="muted">{entry.itemID ?? entry.queueID ?? "—"}</td><td>
            {entry.recoveryID && entry.action !== "restore_queue_action" && !history.some((other) => other.action === "restore_queue_action" && other.recoveryID === entry.recoveryID) ? <button className="btn" disabled={busy} onClick={() => void restoreAction(entry.recoveryID!)}>恢复候选</button> : ["compact", "curator"].includes(entry.action) && entry.journalID && !history.some((other) => other.action === "undo_maintenance" && other.journalID === entry.journalID) ? <button className="btn" disabled={busy} onClick={() => void undoMaintenance(entry.journalID!)}>撤销整理</button> : "—"}
          </td></tr>)}
        </tbody></table></div> : <div className="empty">暂无操作记录。</div>}
      </section>

      <section className="panel" style={{ marginTop: 12 }} aria-label="最近合并与撤销">
        <div className="panel-head">
          <h2>最近合并</h2>
          <span className="meta">24h 内可撤销 · 本地估算，服务端校验为准</span>
        </div>
        {unknownLockCount ? (
          <div className="banner error" role="status">
            <div>
              <strong>{unknownLockCount} 条撤销请求结果未知</strong>
              ：可能已经提交。请先刷新并核对目标条目与候选队列；确认前不会再次发送撤销。
            </div>
            <div className="muted small">
              只有记录显示“已撤销”才会自动清除标记；一次刷新没有显示，不代表没有提交。
            </div>
            {lockPersistence === "unavailable" ? (
              <div className="sev-error small" role="alert">
                <strong>{SESSION_ONLY_UNKNOWN_NOTICE}</strong>
              </div>
            ) : null}
            {hiddenUnknownCount && !canClearUnknownLocks(journalLoadState) ? (
              <div className="muted small">
                合并记录尚未成功加载，无法核对更早的未知标记；请先刷新成功后再清除。
              </div>
            ) : null}
            <div className="actions">
              <button
                className="btn"
                disabled={busy}
                onClick={() => void load()}
                type="button"
              >
                刷新核对
              </button>
              {hiddenUnknownCount ? (
                <button
                  className="btn ghost"
                  disabled={busy || !canClearUnknownLocks(journalLoadState)}
                  onClick={() => void acknowledgeHiddenUnknown()}
                  type="button"
                >
                  {canClearUnknownLocks(journalLoadState)
                    ? `我已核对，清除 ${hiddenUnknownCount} 条更早标记`
                    : "合并记录未加载，无法清除"}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {journal.length === 0 ? (
          <div className="empty">还没有合并记录。</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>时间</th><th>动作</th><th>影响</th><th>状态</th><th>操作</th></tr>
              </thead>
              <tbody>
                {journal.map((entry) => {
                  const preview = buildMergeUndoPreview(entry, {
                    now,
                    unknownSince: unknownLocks[entry.id],
                  });
                  const locked = Boolean(unknownLocks[entry.id]);
                  return (
                    <tr key={entry.id}>
                      <td className="muted">{formatAge(entry.at)}</td>
                      <td>
                        <span className={`badge ${preview.safe ? "" : "warning"}`}>
                          {preview.actionLabel}
                        </span>
                        <div className="muted small">
                          <code>{entry.action}</code> · {preview.actionMeaning}
                        </div>
                      </td>
                      <td>
                        {preview.safe ? (
                          <>
                            <div>
                              <span className="muted small">候选</span>{" "}
                              {preview.candidate?.title ?? "—"}
                            </div>
                            {preview.targetBefore || preview.targetAfter ? (
                              <div className="muted small">
                                目标：{preview.targetBefore?.title ?? "—"} →{" "}
                                {preview.targetAfter?.title ?? "—"}
                              </div>
                            ) : null}
                            {preview.created ? (
                              <div className="muted small">新建：{preview.created.title}</div>
                            ) : null}
                            <div className="muted small">撤销影响：{preview.summary}</div>
                            <details>
                              <summary className="muted small">查看实际前后内容</summary>
                              <div className="small" style={{ whiteSpace: "pre-wrap" }}>
                                {preview.candidate ? (
                                  <p>
                                    候选（操作前）：标题「{preview.candidate.title}」；正文：
                                    {preview.candidate.text}
                                  </p>
                                ) : null}
                                {preview.targetBefore ? (
                                  <p>
                                    目标（操作前）：标题「{preview.targetBefore.title}」；正文：
                                    {preview.targetBefore.text}
                                  </p>
                                ) : null}
                                {preview.targetAfter ? (
                                  <p>
                                    目标（操作后）：标题「{preview.targetAfter.title}」；正文：
                                    {preview.targetAfter.text}
                                  </p>
                                ) : null}
                                {preview.created ? (
                                  <p>
                                    本次新建：标题「{preview.created.title}」；正文：
                                    {preview.created.text}
                                  </p>
                                ) : null}
                                <p>{preview.deadline}</p>
                                <p className="muted">{preview.hint}</p>
                              </div>
                            </details>
                          </>
                        ) : (
                          <div className="muted small">
                            缺少完整快照，不能安全预测恢复/归档对象；请核对备份或服务端记录。
                            {preview.missing.length ? (
                              <div>缺失字段：{preview.missing.join("、")}</div>
                            ) : null}
                            {preview.candidate ||
                            preview.targetBefore ||
                            preview.targetAfter ||
                            preview.created ? (
                              <details>
                                <summary>查看已记录字段（不构成恢复保证）</summary>
                                <div style={{ whiteSpace: "pre-wrap" }}>
                                  {preview.candidate ? (
                                    <p>
                                      候选（操作前）：标题「{preview.candidate.title}」；正文：
                                      {preview.candidate.text}
                                    </p>
                                  ) : null}
                                  {preview.targetBefore ? (
                                    <p>
                                      目标（操作前）：标题「{preview.targetBefore.title}」；正文：
                                      {preview.targetBefore.text}
                                    </p>
                                  ) : null}
                                  {preview.targetAfter ? (
                                    <p>
                                      目标（操作后）：标题「{preview.targetAfter.title}」；正文：
                                      {preview.targetAfter.text}
                                    </p>
                                  ) : null}
                                  {preview.created ? (
                                    <p>
                                      本次新建：标题「{preview.created.title}」；正文：
                                      {preview.created.text}
                                    </p>
                                  ) : null}
                                </div>
                              </details>
                            ) : null}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${statusBadgeClass(preview.status)}`}>
                          {preview.statusLabel}
                        </span>
                        {locked && preview.status !== "unknown" ? (
                          <span className="badge warning" style={{ marginLeft: 4 }}>
                            状态未知
                          </span>
                        ) : null}
                        <div className="muted small">{preview.deadline}</div>
                      </td>
                      <td>
                        {locked ? (
                          <button
                            className="btn ghost"
                            disabled={busy}
                            onClick={() => void acknowledgeUnknown(entry.id)}
                            type="button"
                          >
                            我已核对，解除标记
                          </button>
                        ) : preview.canResume ? (
                          <button
                            className="btn"
                            disabled={busy}
                            onClick={() => void undo(entry, "resume")}
                            type="button"
                          >
                            核对后继续撤销
                          </button>
                        ) : (
                          <button
                            className="btn"
                            disabled={!preview.canUndo || busy}
                            onClick={() => void undo(entry)}
                            type="button"
                          >
                            {preview.canUndo ? "撤销" : preview.statusLabel}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Bar({ label, value }: { label: string; value: number }) {
  const width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
  return (
    <div className="bar-row">
      <span>{label}</span>
      <div className="track"><div className="fill" style={{ width }} /></div>
      <span>{Math.round(value * 100)}</span>
    </div>
  );
}

function statusBadgeClass(status: MergeUndoStatus): string {
  switch (status) {
    case "undoable":
      return "success";
    case "undone":
      return "";
    case "expired":
    case "in-progress":
    case "unsafe":
      return "warning";
    case "unknown":
      return "error";
  }
}

let leaveWarningTarget: MergeUndoLeaveTarget | undefined;

function mergeUndoLeaveWarningTarget(): MergeUndoLeaveTarget | undefined {
  if (leaveWarningTarget) return leaveWarningTarget;
  if (typeof window === "undefined") return undefined;
  leaveWarningTarget = {
    addEventListener(type, listener) {
      window.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      window.removeEventListener(type, listener);
    },
  };
  return leaveWarningTarget;
}

function mergeUndoLockStorage(): MergeUndoLockStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function initialMergeUndoLocks(): MergeUndoLocks {
  const storage = mergeUndoLockStorage();
  const loaded = loadMergeUndoLocks(storage);
  sessionLockPersistence = loaded.persistence;
  // Read-only storage can still contain valid unknown markers. Keep them, but
  // let this session's explicit unlocks suppress stale copies via tombstones.
  sessionUnknownLocks = resolveMergeUndoLocks(
    loaded,
    sessionUnknownLocks,
    sessionUnlockTombstones,
  );
  if (loaded.persistence === "available") {
    sessionLockPersistence = saveMergeUndoLocks(storage, sessionUnknownLocks);
  }
  return sessionUnknownLocks;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
