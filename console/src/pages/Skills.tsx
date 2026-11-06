import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, formatAge } from "../api";
import { confirmAction } from "../extension/confirm";
import type { SkillDraft } from "../types";
import {
  applyLoad,
  applySaveResult,
  canSubmitSkillDecision,
  isDraftDirty,
  newLoadTicket,
  reconcileSkillList,
} from "./draft-state";

interface Props {
  refreshKey: number;
  onChanged: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

export function SkillsPage({ refreshKey, onChanged, onDirtyChange }: Props) {
  const [items, setItems] = useState<SkillDraft[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDraft | null>(null);
  const [notes, setNotes] = useState({ draft: "", saved: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [unavailableId, setUnavailableId] = useState<string | null>(null);

  const notesRef = useRef(notes);
  const notesSeq = useRef(0);
  const listSeq = useRef(0);
  const loadedNotesId = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    notesRef.current = notes;
  }, [notes]);
  useLayoutEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const resetNotes = (id: string | null) => {
    loadedNotesId.current = null;
    const empty = { draft: "", saved: "" };
    notesRef.current = empty;
    setNotes(empty);
    if (!id) setDetail(null);
  };

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );
  const approved = items.filter((item) => item.status === "approved").length;
  const validated = items.filter((item) => item.status === "validated").length;
  const notesDirty = isDraftDirty(notes.draft, notes.saved);
  const actionsBlocked = selectedId !== null && unavailableId === selectedId;
  const actionsEnabled = canSubmitSkillDecision({ busy, unavailable: actionsBlocked });

  useEffect(() => {
    onDirtyChange(notesDirty);
  }, [notesDirty, onDirtyChange]);

  useEffect(() => {
    // Unmounting (disconnect, token gate, error screen) must clear the
    // registration so a stale dirty flag cannot warn about a gone draft.
    return () => {
      onDirtyChange(false);
    };
  }, [onDirtyChange]);

  useEffect(() => {
    const requestId = ++listSeq.current;
    api<{ items: SkillDraft[] }>("/api/skills")
      .then((data) => {
        const decision = reconcileSkillList({
          requestId,
          latestRequestId: listSeq.current,
          selectedId: selectedIdRef.current,
          ids: data.items.map((item) => item.id),
        });
        if (decision.kind === "ignored") return;
        setItems(data.items);
        setError("");
        // A background list never clears notes/detail. A missing selection is
        // marked unavailable so its dirty draft stays visible and blocked.
        if (decision.kind === "kept-unavailable") setUnavailableId(decision.id);
        else setUnavailableId(null);
      })
      .catch((caught: unknown) => {
        if (requestId === listSeq.current) setError(errorMessage(caught));
      });
  }, [refreshKey]);

  useEffect(() => {
    if (!selectedId) {
      resetNotes(null);
      return;
    }
    const id = selectedId;
    const explicit = loadedNotesId.current !== id;
    if (explicit) {
      // Switching drafts is explicit: show the empty state rather than the
      // previous skill's notes while the new detail loads.
      setDetail((current) => (current?.id === id ? current : null));
      const empty = { draft: "", saved: "" };
      notesRef.current = empty;
      setNotes(empty);
    }
    const ticket = newLoadTicket(++notesSeq.current, notesRef.current.draft);
    let cancelled = false;
    api<SkillDraft>(`/api/skills/${encodeURIComponent(id)}`)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        const outcome = applyLoad({
          ticket,
          latestTicketId: notesSeq.current,
          draft: notesRef.current.draft,
          saved: notesRef.current.saved,
          loaded: data.testResult?.notes ?? "",
          explicit,
        });
        if (outcome.applied) {
          loadedNotesId.current = id;
          const next = { draft: outcome.draft, saved: outcome.saved };
          notesRef.current = next;
          setNotes(next);
        }
        setError("");
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, refreshKey]);

  useEffect(() => {
    if (!notesDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [notesDirty]);

  async function selectSkill(id: string) {
    if (id === selectedId) return;
    if (notesDirty) {
      const ok = await confirmAction({
        title: "切换草稿？",
        message: "当前 Skill 的备注尚未保存，切换会丢弃这段备注；请先复制或保存。",
        confirmLabel: "切换并丢弃备注",
      });
      if (!ok) return;
    }
    setUnavailableId(null);
    setDetail(null);
    setSelectedId(id);
  }

  async function act(action: "approve" | "reject" | "request_changes") {
    if (!selectedId) return;
    const skillId = selectedId;
    if (unavailableId === skillId) {
      setError("当前 Skill 条目已不可用，无法提交。请复制备注或明确放弃。");
      return;
    }
    if (action === "approve") {
      const ok = await confirmAction({
        title: "批准 Skill 草稿？",
        message: "会写入 outbox/skills，不会自动安装到 OpenCode。",
        confirmLabel: "批准",
      });
      if (!ok) return;
    }
    if (action === "request_changes" && !notesRef.current.draft.trim()) {
      setError("Add notes before requesting changes.");
      return;
    }
    const submittedNotes = notesRef.current.draft;
    const savedBefore = notesRef.current.saved;
    // Drop responses from detail loads issued before this decision.
    notesSeq.current += 1;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ ok: boolean; path?: string; errors?: string[] }>(
        `/api/skills/${encodeURIComponent(skillId)}/decision`,
        {
          method: "POST",
          body: JSON.stringify({ action, notes: submittedNotes }),
        },
      );
      if (selectedIdRef.current !== skillId) return;
      if (!result.ok) {
        setError(result.errors?.join("; ") ?? "skill decision failed");
        return;
      }
      if (action === "request_changes") {
        const outcome = applySaveResult({
          ok: true,
          submitted: submittedNotes,
          currentDraft: notesRef.current.draft,
          savedBefore,
          responseSaved: submittedNotes,
        });
        const next = {
          draft: outcome.adoptResponse ? submittedNotes : notesRef.current.draft,
          saved: outcome.saved,
        };
        notesRef.current = next;
        setNotes(next);
        setMessage(
          outcome.keptNewerEdits
            ? "Changes requested；请求期间继续输入的内容仍未保存。"
            : "Changes requested",
        );
      } else {
        setMessage(
          action === "approve" ? `Approved → ${result.path ?? "outbox"}` : "Rejected",
        );
      }
      onChanged();
    } catch (caught: unknown) {
      // A failed decision keeps the notes draft untouched.
      if (selectedIdRef.current === skillId) setError(errorMessage(caught));
    } finally {
      // A detail load issued during the decision may have read the server
      // before it persisted the notes; never let it replace this draft. A
      // different skill selected meanwhile keeps its own fresh load.
      if (selectedIdRef.current === skillId) notesSeq.current += 1;
      setBusy(false);
    }
  }

  async function copyNotes() {
    try {
      if (!navigator.clipboard) throw new Error("当前环境不支持剪贴板，请手动选择备注文本复制");
      await navigator.clipboard.writeText(notesRef.current.draft);
      setMessage("备注已复制");
    } catch {
      setError("无法写入剪贴板，请手动选择备注文本复制");
    }
  }

  async function discardUnavailableDraft() {
    const ok = await confirmAction({
      title: "放弃当前备注？",
      message: "当前条目已不在列表中，放弃后备注和详情都会清空。",
      confirmLabel: "放弃备注",
      danger: true,
    });
    if (!ok) return;
    setUnavailableId(null);
    setSelectedId(null);
    resetNotes(null);
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
      {actionsBlocked ? (
        <div className="banner" role="status">
          <div>当前 Skill 条目已不在刷新后的列表中，无法提交决策；备注和详情已保留。</div>
          <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => void copyNotes()} type="button">
              复制备注
            </button>
            <button className="btn danger" disabled={busy} onClick={() => void discardUnavailableDraft()} type="button">
              放弃备注
            </button>
          </div>
        </div>
      ) : null}

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
                onClick={() => void selectSkill(item.id)}
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
                <label>
                  Review notes / changes requested
                  {notesDirty ? <span className="meta"> 未保存</span> : null}
                </label>
                <textarea
                  className="textarea"
                  value={notes.draft}
                  onChange={(event) => {
                    const next = { ...notes, draft: event.target.value };
                    notesRef.current = next;
                    setNotes(next);
                  }}
                  placeholder="What should the agent fix before approval?"
                />
                <p className="muted small" style={{ margin: 0 }}>
                  后台刷新不会覆盖正在编辑的备注；切换草稿会载入所选草稿的备注。
                </p>
              </div>
              <div className="actions">
                <button
                  className="btn primary"
                  disabled={!actionsEnabled || !detail.validation.ok}
                  onClick={() => void act("approve")}
                  type="button"
                >
                  Approve → outbox
                </button>
                <button className="btn" disabled={!actionsEnabled} onClick={() => void act("request_changes")} type="button">
                  Request changes
                </button>
                <button className="btn danger" disabled={!actionsEnabled} onClick={() => void act("reject")} type="button">
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
