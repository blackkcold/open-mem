import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { AuditReport } from "../types";
import {
  queueItemLink,
  resolveAuditTarget,
  resolveFindingQueueLinks,
} from "./audit-links";

interface Props {
  refreshKey: number;
  onChanged: () => void;
  targetFindingID?: string;
  targetReportAt?: string;
}

export function AuditPage({
  refreshKey,
  onChanged,
  targetFindingID,
  targetReportAt,
}: Props) {
  const [report, setReport] = useState<AuditReport>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [queueItems, setQueueItems] = useState<Array<{ id: string; title: string }>>([]);
  const [queueReady, setQueueReady] = useState(false);
  const [queueError, setQueueError] = useState(false);
  const [targetNotice, setTargetNotice] = useState("");
  const targetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api<AuditReport>("/api/audit")
      .then((data) => {
        setReport(data);
        setError("");
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
  }, [refreshKey]);

  useEffect(() => {
    api<{ items: Array<{ id: string; title: string }> }>("/api/queue")
      .then((data) => {
        setQueueItems(data.items);
        setQueueReady(true);
        setQueueError(false);
      })
      .catch(() => {
        setQueueItems([]);
        setQueueReady(false);
        setQueueError(true);
      });
  }, [refreshKey]);

  const resolution = useMemo(
    () =>
      resolveAuditTarget(
        targetFindingID ? { id: targetFindingID, reportAt: targetReportAt } : undefined,
        report,
      ),
    [targetFindingID, targetReportAt, report],
  );
  const currentFindingID = resolution.status === "current" ? resolution.findingID : "";

  useEffect(() => {
    if (resolution.status === "none" || resolution.status === "loading" || resolution.status === "current") {
      setTargetNotice("");
      return;
    }
    if (resolution.status === "unversioned") {
      setTargetNotice("该链接缺少审计报告版本，无法安全定位；请从审批详情重新打开。");
    } else if (resolution.status === "stale") {
      setTargetNotice("该审计发现来自旧报告，已过期；请从审批详情重新打开，或重新运行审计后再跳转。");
    } else {
      setTargetNotice("当前审计报告中找不到该发现（可能已被更新或移除）。");
    }
  }, [resolution]);

  useEffect(() => {
    if (currentFindingID) targetRef.current?.scrollIntoView({ block: "center" });
  }, [currentFindingID]);

  async function run() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await api<AuditReport>("/api/audit/run", { method: "POST" });
      setReport(next);
      setMessage(`Audit complete: ${next.findings.length} finding(s).`);
      onChanged();
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="audit-layout">
      <div className="kpis">
        <div className="kpi"><span>Errors</span><b className="warn">{report?.summary.error ?? 0}</b></div>
        <div className="kpi"><span>Warnings</span><b className="warn">{report?.summary.warning ?? 0}</b></div>
        <div className="kpi"><span>Info</span><b>{report?.summary.info ?? 0}</b></div>
        <div className="kpi"><span>Last run</span><b style={{ fontSize: "0.82rem" }}>{report ? new Date(report.generatedAt).toLocaleString() : "—"}</b></div>
      </div>

      {message ? <div className="banner ok">{message}</div> : null}
      {error ? <div className="banner error">{error}</div> : null}
      {targetNotice ? <div className="banner error" role="status">{targetNotice}</div> : null}

      <section className="panel">
        <div className="panel-head">
          <h2>审计发现</h2>
          <span className="meta">duplicate · conflict · stale · capacity · secret · skill</span>
          <button className="btn primary" disabled={busy} onClick={() => void run()} type="button">
            {busy ? "Running…" : "Run audit"}
          </button>
        </div>
        {!report || report.findings.length === 0 ? (
          <div className="empty">No findings. Run an audit after the queue or shadow store changes.</div>
        ) : (
          <div>
            {report.findings.map((finding) => {
              const resolved = resolveFindingQueueLinks(finding, queueItems);
              const isTarget = currentFindingID === finding.id;
              return (
                <div
                  className="finding"
                  key={finding.id}
                  ref={isTarget ? targetRef : undefined}
                  style={
                    isTarget
                      ? { outline: "2px solid var(--primary)", outlineOffset: 4, borderRadius: 6 }
                      : undefined
                  }
                  data-finding-id={finding.id}
                >
                  <div className="chips">
                    <span className={`badge ${severityTone(finding.severity)}`}>{finding.severity}</span>
                    <span className="chip">{finding.kind}</span>
                    {finding.suggestedAction ? <span className="chip">{finding.suggestedAction}</span> : null}
                  </div>
                  <strong className={severityText(finding.severity)}>{finding.title}</strong>
                  <p>{finding.detail}</p>
                  {finding.itemIDs.length > 0 ? (
                    <p className="muted" style={{ fontFamily: "var(--mono)", fontSize: "0.64rem" }}>
                      items: {finding.itemIDs.join(", ")}
                    </p>
                  ) : null}
                  {!queueReady ? (
                    <p className="muted small">
                      {queueError
                        ? "无法核对审批队列，暂不显示审批跳转。"
                        : "正在核对审批队列…"}
                    </p>
                  ) : resolved.links.length > 0 || resolved.missingQueueIDs.length > 0 || resolved.otherIDs.length > 0 ? (
                    <div className="chips">
                      {resolved.links.map((link) => (
                        <a
                          className="chip"
                          key={link.id}
                          href={queueItemLink(link.id)}
                          title={`打开审批条目：${link.title}`}
                        >
                          查看审批：{link.title}
                        </a>
                      ))}
                      {resolved.missingQueueIDs.length > 0 ? (
                        <span className="chip">
                          审批条目已不在队列：{resolved.missingQueueIDs.join(", ")}
                        </span>
                      ) : null}
                      {resolved.otherIDs.length > 0 ? (
                        <span className="chip">
                          非审批队列条目：{resolved.otherIDs.join(", ")}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function severityTone(severity: string): string {
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  return "info";
}

function severityText(severity: string): string {
  if (severity === "error") return "sev-error";
  if (severity === "warning") return "sev-warning";
  return "sev-info";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
