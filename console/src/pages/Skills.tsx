import { useEffect, useMemo, useState } from "react";
import { api, formatAge } from "../api";
import { confirmAction } from "../extension/confirm";
import type { SkillDraft } from "../types";

interface Props {
  refreshKey: number;
  onChanged: () => void;
}

export function SkillsPage({ refreshKey, onChanged }: Props) {
  const [items, setItems] = useState<SkillDraft[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDraft | null>(null);
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );
  const approved = items.filter((item) => item.status === "approved").length;
  const validated = items.filter((item) => item.status === "validated").length;

  useEffect(() => {
    api<{ items: SkillDraft[] }>("/api/skills")
      .then((data) => {
        setItems(data.items);
        setError("");
        if (selectedId && !data.items.some((item) => item.id === selectedId)) {
          setSelectedId(null);
          setDetail(null);
        }
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
  }, [refreshKey, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    api<SkillDraft>(`/api/skills/${encodeURIComponent(selectedId)}`)
      .then((data) => {
        setDetail(data);
        setNotes(data.testResult?.notes ?? "");
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
  }, [selectedId, refreshKey]);

  async function act(action: "approve" | "reject" | "request_changes") {
    if (!selectedId) return;
    if (action === "approve") {
      const ok = await confirmAction({
        title: "批准 Skill 草稿？",
        message: "会写入 outbox/skills，不会自动安装到 OpenCode。",
        confirmLabel: "批准",
      });
      if (!ok) return;
    }
    if (action === "request_changes" && !notes.trim()) {
      setError("Add notes before requesting changes.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ ok: boolean; path?: string; errors?: string[] }>(
        `/api/skills/${encodeURIComponent(selectedId)}/decision`,
        {
          method: "POST",
          body: JSON.stringify({ action, notes }),
        },
      );
      if (!result.ok) {
        setError(result.errors?.join("; ") ?? "skill decision failed");
      } else {
        setMessage(
          action === "approve"
            ? `Approved → ${result.path ?? "outbox"}`
            : action === "reject"
              ? "Rejected"
              : "Changes requested",
        );
        onChanged();
      }
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="kpis">
        <div className="kpi"><span>Skill drafts</span><b>{items.length}</b></div>
        <div className="kpi"><span>Validated</span><b className="good">{validated}</b></div>
        <div className="kpi"><span>Approved</span><b className="good">{approved}</b></div>
        <div className="kpi"><span>Outbox only</span><b>安全</b></div>
      </div>

      {message ? <div className="banner ok">{message}</div> : null}
      {error ? <div className="banner error">{error}</div> : null}

      <div className="skills-layout">
        <section className="panel">
          <div className="panel-head">
            <h2>Skill drafts</h2>
            <span className="meta">draft → validate → test → approve</span>
          </div>
          <div className="list">
            {items.map((item) => (
              <button
                key={item.id}
                data-skill-id={item.id}
                className={`list-item${item.id === selectedId ? " active" : ""}`}
                onClick={() => setSelectedId(item.id)}
                type="button"
              >
                <strong>{item.name}</strong>
                <span>{item.description || "No description"}</span>
                <span>
                  <span className={`badge ${statusTone(item.status)}`}>{item.status}</span>
                  {" · "}
                  {formatAge(item.updatedAt)}
                </span>
              </button>
            ))}
            {items.length === 0 ? (
              <div className="empty">No drafts yet. Skill candidates stay in the queue until the agent drafts them.</div>
            ) : null}
          </div>
        </section>

        <section className="panel">
          {!detail ? (
            <div className="empty">Select a draft to inspect its SKILL.md, validation, and test result.</div>
          ) : (
            <div className="detail-body">
              <div className="panel-head" style={{ padding: 0, border: 0 }}>
                <h2>{detail.name}</h2>
                <span className={`badge ${statusTone(detail.status)}`}>{detail.status}</span>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: "0.76rem", lineHeight: 1.5 }}>
                {detail.description}
              </p>
              <div className="chips">
                <span className="chip">{detail.validation.ok ? "validation ok" : "validation failed"}</span>
                {detail.testResult ? (
                  <span className={`chip ${detail.testResult.ok ? "ok" : "warn"}`}>
                    test {detail.testResult.ok ? "passed" : "pending"}
                  </span>
                ) : (
                  <span className="chip warn">test not run</span>
                )}
                <span className="chip">{formatAge(detail.updatedAt)}</span>
              </div>
              {detail.validation.errors.length > 0 ? (
                <div className="banner error" style={{ margin: 0 }}>
                  {detail.validation.errors.join("; ")}
                </div>
              ) : null}
              {detail.validation.warnings.length > 0 ? (
                <div className="banner ok" style={{ margin: 0 }}>
                  {detail.validation.warnings.join("; ")}
                </div>
              ) : null}
              {detail.testResult?.notes ? (
                <p className="muted" style={{ margin: 0, fontSize: "0.72rem" }}>
                  Test: {detail.testResult.notes}
                </p>
              ) : null}
              <pre className="skill-content">{detail.content ?? "Loading SKILL.md…"}</pre>
              <p className="muted" style={{ margin: 0, fontSize: "0.66rem" }}>
                Path: {detail.path}
              </p>
              <div className="field">
                <label>Review notes / changes requested</label>
                <textarea
                  className="textarea"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="What should the agent fix before approval?"
                />
              </div>
              <div className="actions">
                <button
                  className="btn primary"
                  disabled={busy || !detail.validation.ok}
                  onClick={() => void act("approve")}
                  type="button"
                >
                  Approve → outbox
                </button>
                <button className="btn" disabled={busy} onClick={() => void act("request_changes")} type="button">
                  Request changes
                </button>
                <button className="btn danger" disabled={busy} onClick={() => void act("reject")} type="button">
                  Reject
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      if (!navigator.clipboard) throw new Error("当前环境不支持剪贴板，请选择上方路径手动复制");
                      await navigator.clipboard.writeText(detail.path);
                      setMessage("路径已复制");
                    } catch {
                      setError("无法写入剪贴板，请选择路径手动复制");
                    }
                  }}
                  type="button"
                >
                  复制路径
                </button>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: "0.66rem", lineHeight: 1.45 }}>
                Approving writes to <code>outbox/skills/&lt;name&gt;/SKILL.md</code>. It does not install into OpenCode or OpenChamber.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function statusTone(status: string): string {
  if (status === "approved") return "success";
  if (status === "validated") return "info";
  if (status === "rejected") return "error";
  return "warning";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
