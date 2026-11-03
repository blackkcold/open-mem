import { useEffect, useState } from "react";
import { api } from "../api";
import type { AuditReport } from "../types";

interface Props {
  refreshKey: number;
  onChanged: () => void;
}

export function AuditPage({ refreshKey, onChanged }: Props) {
  const [report, setReport] = useState<AuditReport>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<AuditReport>("/api/audit")
      .then((data) => {
        setReport(data);
        setError("");
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
  }, [refreshKey]);

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
            {report.findings.map((finding) => (
              <div className="finding" key={finding.id}>
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
              </div>
            ))}
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
