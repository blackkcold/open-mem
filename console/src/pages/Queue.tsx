import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatAge, priorityClass } from "../api";
import type { Config, QueueItem, Suggestion } from "../types";

interface Props {
  refreshKey: number;
  onChanged: () => void;
}

type Action = "approve" | "deny" | "defer" | "apply_suggestion";

const ACTION_LABEL: Record<Suggestion["action"], string> = {
  create: "新建条目",
  merge_into: "合并到已有",
  replace: "替换旧条目",
  keep_both: "保留两条",
  reject_duplicate: "拒绝重复",
};

export function QueuePage({ refreshKey, onChanged }: Props) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState("");
  const [scope, setScope] = useState("");
  const [query, setQuery] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editText, setEditText] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [limits, setLimits] = useState({ memory: 200, rule: 160, title: 30 });
  const requested = useRef<Set<string>>(new Set());

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );
  const suggestion = selected?.suggestion;
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
    const params = new URLSearchParams();
    if (kind) params.set("kind", kind);
    if (scope) params.set("scope", scope);
    if (query) params.set("q", query);
    api<{ items: QueueItem[] }>(`/api/queue?${params.toString()}`)
      .then((data) => {
        setItems(data.items);
        setError("");
        if (selectedId && !data.items.some((item) => item.id === selectedId)) {
          setSelectedId(null);
        }
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
  }, [refreshKey, kind, scope, query, selectedId]);

  useEffect(() => {
    if (!selected) return;
    setEditTitle(selected.suggestion?.proposedTitle ?? selected.title);
    setEditText(selected.suggestion?.proposedText ?? selected.text);
    setNote("");
  }, [selected?.id, selected?.suggestion?.id]);

  useEffect(() => {
    if (!selected) return;
    if (selected.kind === "skill") return;
    if (selected.suggestion || selected.suggestionState === "pending") return;
    if (requested.current.has(selected.id)) return;
    void generate(selected.id);
  }, [selected?.id, selected?.suggestion?.id, selected?.suggestionState]);

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
        const ok = window.confirm(
          `应用建议「${ACTION_LABEL[suggestion.action]}」？这会写入记忆并归档候选。`,
        );
        if (!ok) return;
      }
    }
    if (action === "approve" && (selected.kind === "rule" || (selected.priority ?? 0) >= 70)) {
      const ok = window.confirm(
        `Approve “${selected.title}”? This writes to the memory/rules file and removes it from the queue.`,
      );
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
      const ok = window.confirm(
        `将应用 ${preview.eligible.length} 条建议（最多 10 条，跳过 ${preview.skipped} 条，超出 ${preview.capped} 条）。继续？`,
      );
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
    if (!window.confirm(`拒绝 ${ids.length} 条候选？`)) return;
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

  const highCount = items.filter((item) => (item.priority ?? 0) >= 75).length;
  const ruleCount = items.filter((item) => item.kind === "rule").length;
  const allSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));

  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(items.map((item) => item.id)));
  }

  function toggleOne(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  return (
    <div>
      <div className="kpis">
        <div className="kpi"><span>待审批</span><b className="warn">{items.length}</b></div>
        <div className="kpi"><span>高优先级</span><b className="warn">{highCount}</b></div>
        <div className="kpi"><span>规则类</span><b>{ruleCount}</b></div>
        <div className="kpi"><span>已选</span><b>{selectedIds.size}</b></div>
      </div>

      {message ? <div className="banner ok">{message}</div> : null}
      {error ? <div className="banner error">{error}</div> : null}

      <div className="queue-layout">
        <section className="panel">
          <div className="panel-head">
            <h2>按决策优先级排序</h2>
            <span className="meta">建议已预填 · 一键批准</span>
          </div>
          <div className="toolbar">
            <select className="select" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">全部类型</option>
              <option value="rule">rule</option>
              <option value="preference">preference</option>
              <option value="fact">fact</option>
              <option value="reference">reference</option>
              <option value="skill">skill</option>
            </select>
            <select className="select" value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="">全部范围</option>
              <option value="global">global</option>
              <option value="project">project</option>
            </select>
            <input
              className="input"
              placeholder="搜索候选 / 原因"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button className="btn" onClick={toggleAll} type="button">
              {allSelected ? "取消全选" : "全选"}
            </button>
            <button
              className="btn primary"
              disabled={busy || selectedIds.size === 0}
              onClick={() => void batchApplySuggestions()}
              type="button"
            >
              批量批准建议
            </button>
            <button
              className="btn"
              disabled={busy || selectedIds.size === 0}
              onClick={() => void batchDeny()}
              type="button"
            >
              批量拒绝
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th>优先级</th>
                  <th>类型</th>
                  <th>候选</th>
                  <th>建议</th>
                  <th>范围</th>
                  <th>年龄</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    data-queue-id={item.id}
                    className={item.id === selectedId ? "selected" : ""}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <td onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        onChange={() => toggleOne(item.id)}
                      />
                    </td>
                    <td>
                      <span className={`prio ${priorityClass(item.priority)}`}>
                        {item.priority ?? 0}
                      </span>
                    </td>
                    <td><span className="badge">{item.kind}</span></td>
                    <td>
                      <strong>{item.title}</strong>
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
                    <td className="muted">{item.scope}</td>
                    <td className="muted">{formatAge(item.createdAt)}</td>
                  </tr>
                ))}
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty">队列为空。新候选会在 session.idle 后进入这里。</div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="panel detail">
          {!selected ? (
            <div className="empty">选择左侧一条候选，查看 AI 合并建议、优先级分解和操作。</div>
          ) : (
            <div className="detail-body">
              <h2>{selected.title}</h2>
              <div className="chips">
                <span className="chip">{selected.kind}</span>
                <span className="chip">{selected.scope}</span>
                <span className={`prio ${priorityClass(selected.priority)}`}>{selected.priority ?? 0}</span>
                {selected.suggestedAction ? <span className="chip">建议：{selected.suggestedAction}</span> : null}
                {selected.seenCount && selected.seenCount > 1 ? (
                  <span className="chip">seen {selected.seenCount}</span>
                ) : null}
              </div>
              <div className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.5 }}>
                {selected.reason}
              </div>

              {suggestion ? (
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
                      onChange={(event) => setEditTitle(event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>建议文本（已预填，可直接批准）</label>
                    <textarea
                      className="textarea"
                      value={editText}
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
                      Defer 24h
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
                    <strong>System Two 正在合并…</strong>
                    <div className="muted small">先生成目标、动作和预填文本，通常几秒内完成。</div>
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
                      Approve as new
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
                      Defer 24h
                    </button>
                    <button className="btn danger" disabled={busy} onClick={() => void act("deny")} type="button">
                      Deny
                    </button>
                  </div>
                </>
              ) : null}

              <div className="field">
                <label>备注（可选）</label>
                <input
                  className="input"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="为什么这样处理"
                />
              </div>

              <p className="muted" style={{ fontSize: "0.66rem", lineHeight: 1.45, margin: 0 }}>
                建议来源会标注 System Two 或模板；批准后写入 items.jsonl 并重建 AUTO_MEMORY / AUTO_RULES，24h 内可撤销。
              </p>
            </div>
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
