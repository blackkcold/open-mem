import { useCallback, useEffect, useState } from "react";
import { ApiError, api, formatAge, priorityClass } from "../api";
import type { Health, HealthScore, QueueItem, ReviewRecord, TurnSummary } from "../types";
import { confirmAction, ConfirmHost } from "./confirm";
import { connectionHint } from "./errors";
import { Icon, LogoMark } from "./Icon";
import { startPolling } from "./poll";

type Decision = "approve" | "deny" | "promote" | "draft";

export function PanelApp() {
  const [health, setHealth] = useState<Health>();
  const [score, setScore] = useState<HealthScore>();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [turn, setTurn] = useState<TurnSummary>();
  const [review, setReview] = useState<ReviewRecord>();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [healthResult, scoreResult, queueResult, turnResult, reviewResult] =
        await Promise.allSettled([
          api<Health>("/api/health"),
          api<HealthScore>("/api/health-score"),
          api<{ items: QueueItem[] }>("/api/queue"),
          api<TurnSummary>("/api/turns/latest"),
          api<{ items: ReviewRecord[] }>("/api/reviews?limit=1"),
        ]);
      if (healthResult.status === "rejected") {
        throw healthResult.reason;
      }
      setHealth(healthResult.value);
      if (scoreResult.status === "fulfilled") setScore(scoreResult.value);
      if (queueResult.status === "fulfilled") setQueue(queueResult.value.items);
      if (turnResult.status === "fulfilled") setTurn(turnResult.value);
      if (reviewResult.status === "fulfilled") setReview(reviewResult.value.items[0]);
      setError(null);
    } catch (caught: unknown) {
      setError(toApiError(caught));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => startPolling(load, 5_000), [load]);

  async function decide(item: QueueItem, action: Decision) {
    const needsConfirm =
      action === "deny" || action === "promote" || item.kind === "rule" || (item.priority ?? 0) >= 70;
    if (needsConfirm) {
      const ok = await confirmAction({
        title: action === "promote" ? (item.projectKey ? "保存到项目？" : "提升为全局？") : action === "approve" ? "批准这条记忆？" : "拒绝这条候选？",
        message:
          action === "promote"
            ? (item.projectKey ? `「${item.title}」将成为项目“${item.project ?? item.projectKey}”的长期记忆。` : `「${item.title}」将用于所有项目的新会话。`)
            : action === "approve"
            ? `「${item.title}」会写入${item.kind === "rule" ? "规则" : "记忆"}文件，并从队列移除。`
            : `「${item.title}」会从队列移除。`,
        confirmLabel: action === "promote" ? "保存" : action === "approve" ? "批准" : "拒绝",
        danger: action === "deny",
      });
      if (!ok) return;
    }
    setBusy(`${item.id}:${action}`);
    setMessage("");
    setError(null);
    try {
      const result = await api<{ ok: boolean; error?: string }>(
        `/api/queue/${encodeURIComponent(item.id)}/${action === "draft" ? "draft" : "decision"}`,
        {
          method: "POST",
          body: JSON.stringify({ action, ...(action === "promote" ? { targetScope: item.projectKey ? "project" : "global", projectKey: item.projectKey } : {}) }),
        },
      );
      if (!result.ok) throw new Error(result.error ?? "操作失败");
      setQueue((current) => current.filter((entry) => entry.id !== item.id));
      setMessage(action === "draft" ? "草稿已生成，可在完整控制台的 Skill Review 中检查" : action === "promote" ? "已保存长期记忆" : action === "approve" ? "已批准" : "已拒绝，可在健康页的操作历史恢复");
      window.setTimeout(() => setMessage(""), 2_500);
      void load();
    } catch (caught: unknown) {
      setError(toApiError(caught));
    } finally {
      setBusy(null);
    }
  }

  if (!loaded) {
    return (
      <div className="op-panel" aria-busy="true">
        <PanelHead online={false} />
        <div className="op-skeleton" />
        <div className="op-skeleton short" />
        <div className="op-skeleton" />
      </div>
    );
  }

  if (error && !health) {
    return (
      <div className="op-panel">
        <PanelHead online={false} />
        <div className="op-error-card">
          <span className="op-error-icon" aria-hidden="true">
            <Icon name="alert" size={18} />
          </span>
          <strong>暂时无法连接 OpenMem</strong>
          <p>{error.message}</p>
          <p className="op-hint">{connectionHint(error)}</p>
          <button className="op-btn primary" type="button" onClick={() => void load()}>
            <Icon name="refresh" size={14} />
            重试
          </button>
        </div>
        <PanelFoot onRefresh={load} />
      </div>
    );
  }

  const grade = score?.grade ?? "ok";

  return (
    <div className="op-panel">
      <PanelHead online={!error} />

      <section className="op-hero">
        <div className="op-card">
          <span className="op-label">待审批</span>
          <b className={queue.length > 0 ? "warn" : "good"}>{queue.length}</b>
          <span className="op-sub">
            {queue.length > 0
              ? "需要你的判断"
              : turn && turn.counts.captured > 0
                ? `本轮 ${turn.counts.captured} 条`
                : "队列为空"}
          </span>
        </div>
        <div className="op-card">
          <span className="op-label">健康</span>
          <b className={`score ${grade}`}>{score?.score ?? "—"}</b>
          <span className="op-bar" data-grade={grade}>
            <i style={{ width: `${score?.score ?? 0}%` }} />
          </span>
        </div>
      </section>

      <div className="op-meta">
        <span className={`op-pill ${health?.shadow ? "shadow" : "live"}`}>
          {health?.shadow ? "SHADOW" : "LIVE"}
        </span>
        <span className="op-meta-text">
          {score ? gradeLabel(score.grade) : "正在连接…"}
        </span>
        <span className="op-spacer" />
        <span className="op-mode">
          {turn && turn.counts.captured > 0 ? `本轮 ${turn.counts.captured}` : "扩展"}
        </span>
      </div>

      {review ? (
        <section className="op-review" aria-label="会话复盘">
          <span className={`op-tag ${review.status}`}>{reviewStatusLabel(review.status)}</span>
          <span className="op-review-text">{reviewSummary(review)}</span>
          <span className="op-review-age">{formatAge(review.createdAt)}</span>
        </section>
      ) : null}

      <section className="op-list">
        <div className="op-list-head">
          <span>最近候选</span>
          <span>{queue.length}</span>
        </div>
        {queue.slice(0, 3).map((item) => (
          <article className="op-row" key={item.id}>
            <span className={`op-prio ${priorityClass(item.priority)}`}>
              {item.priority ?? 0}
            </span>
            <div className="op-row-copy">
              <strong title={item.title}>{item.title}</strong>
              <span>
                {item.origin === "session-review" ? (
                  <i className="op-tag review">复盘</i>
                ) : null}
                {item.kind} · {item.scope} · {formatAge(item.createdAt)}
              </span>
            </div>
            <div className="op-row-actions">
              <button
                className="op-btn"
                type="button"
                aria-label={`${item.kind === "skill" ? "转为草稿" : item.scope === "session" ? "保存长期记忆" : "批准"} ${item.title}`}
                title={item.kind === "skill" ? "生成供人工检查的草稿，不会安装" : "保存记忆"}
                disabled={busy !== null}
                onClick={() => void decide(item, item.kind === "skill" ? "draft" : item.scope === "session" ? "promote" : "approve")}
              >
                <Icon name="check" size={14} />
                {item.kind === "skill" ? "草稿" : item.scope === "session" ? (item.projectKey ? "保留" : "提升") : "批准"}
              </button>
              <button
                className="op-icon-btn deny"
                type="button"
                aria-label={`拒绝 ${item.title}`}
                title="拒绝"
                disabled={busy !== null}
                onClick={() => void decide(item, "deny")}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          </article>
        ))}
        {queue.length === 0 ? (
          <div className="op-empty">
            <span className="op-empty-icon" aria-hidden="true">
              <Icon name="check" size={16} />
            </span>
            <strong>队列为空</strong>
            <span>新的候选会在会话结束后出现。</span>
          </div>
        ) : null}
        {message ? <div className="op-toast">{message}</div> : null}
        {error && health ? (
          <div className="op-warning">
            <Icon name="alert" size={14} />
            <span>{error.message}</span>
            <button type="button" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : null}
      </section>

      <PanelFoot onRefresh={load} />
      <ConfirmHost />
    </div>
  );
}

function PanelHead({ online }: { online: boolean }) {
  return (
    <header className="op-head">
      <span className="op-logo" aria-hidden="true">
        <LogoMark size={30} />
      </span>
      <span className="op-title">
        <strong>OpenMem</strong>
        <small>记忆自动巡航</small>
      </span>
      <span
        className={`op-dot ${online ? "ok" : "off"}`}
        title={online ? "运行中" : "离线"}
        aria-label={online ? "运行中" : "离线"}
      />
    </header>
  );
}

function PanelFoot({ onRefresh }: { onRefresh: () => void | Promise<void> }) {
  return (
    <footer className="op-foot">
      <span>完整控制台 · 侧边栏 → 扩展页面</span>
      <button
        className="op-icon-btn"
        type="button"
        aria-label="刷新"
        title="刷新"
        onClick={() => void onRefresh()}
      >
        <Icon name="refresh" size={14} />
      </button>
    </footer>
  );
}

function gradeLabel(grade: HealthScore["grade"]): string {
  if (grade === "good") return "状态健康";
  if (grade === "ok") return "状态可用";
  if (grade === "warn") return "需要留意";
  return "需要处理";
}

function reviewStatusLabel(status: ReviewRecord["status"]): string {
  if (status === "ready") return "已复盘";
  if (status === "running") return "复盘中";
  if (status === "scheduled") return "已排期";
  if (status === "skipped") return "已跳过";
  return "失败";
}

function reviewSummary(review: ReviewRecord): string {
  if (review.status === "ready") {
    return `入队 ${review.queued ?? 0} / 提取 ${review.candidates}`;
  }
  if (review.status === "skipped") return review.note ?? "无新内容";
  if (review.status === "failed") return review.error ?? "复盘失败";
  if (review.status === "running") return "正在整理本次会话";
  return "等待会话安静";
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(0, error instanceof Error ? error.message : String(error));
}
