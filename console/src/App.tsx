import { useCallback, useEffect, useState } from "react";
import { clearToken, getToken, api, readTokenFromLocation, setToken, sseUrl } from "./api";
import type { Health, Metrics } from "./types";
import { QueuePage } from "./pages/Queue";
import { SkillsPage } from "./pages/Skills";
import { MapView } from "./pages/MapView";
import { AuditPage } from "./pages/Audit";
import { HealthPage } from "./pages/Health";
import { SettingsPage } from "./pages/Settings";

type Tab = "queue" | "skills" | "map" | "audit" | "health" | "settings";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "queue", label: "审批队列" },
  { id: "skills", label: "Skill Review" },
  { id: "map", label: "记忆地图" },
  { id: "audit", label: "审计" },
  { id: "health", label: "健康" },
  { id: "settings", label: "设置" },
];

export function App() {
  const [token, setTokenState] = useState(() => readTokenFromLocation());
  const [tab, setTab] = useState<Tab>("queue");
  const [health, setHealth] = useState<Health>();
  const [metrics, setMetrics] = useState<Metrics>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");

  const bump = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    Promise.all([api<Health>("/api/health"), api<Metrics>("/api/metrics")])
      .then(([nextHealth, nextMetrics]) => {
        if (cancelled) return;
        setHealth(nextHealth);
        setMetrics(nextMetrics);
        setError("");
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(messageOf(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [token, refreshKey]);

  useEffect(() => {
    if (!token) return;
    const source = new EventSource(sseUrl());
    const handler = () => bump();
    const events = [
      "queue.updated",
      "items.updated",
      "shadow.updated",
      "skills.updated",
      "audit.updated",
      "config.updated",
      "suggestion.updated",
      "health.updated",
      "merge.updated",
    ];
    for (const event of events) source.addEventListener(event, handler);
    source.onerror = () => source.close();
    const timer = window.setInterval(bump, 20_000);
    return () => {
      window.clearInterval(timer);
      for (const event of events) source.removeEventListener(event, handler);
      source.close();
    };
  }, [token, bump]);

  if (!token) {
    return (
      <TokenGate
        onConnect={(value) => {
          setToken(value);
          setTokenState(value);
        }}
      />
    );
  }

  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">OPENMEM<br />CONSOLE</div>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            className={`nav${entry.id === tab ? " active" : ""}`}
            data-tab={entry.id}
            onClick={() => setTab(entry.id)}
          >
            <span>{entry.label}</span>
            {entry.id === "queue" && metrics ? <b>{metrics.queue}</b> : null}
            {entry.id === "skills" && metrics ? <b>{metrics.skillDrafts}</b> : null}
            {entry.id === "audit" && metrics ? <b>{metrics.auditFindings}</b> : null}
          </button>
        ))}
        <div className="sidebar-foot">
          <span className="shadow-pill">{health?.shadow ? "SHADOW ON" : "SHADOW OFF"}</span>
          <br />
          localhost + token
          <br />
          v0.2.0
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{active.label}</h1>
          <span className="meta">{health?.dataDir ?? "connecting…"}</span>
          <span className="spacer" />
          <button className="btn ghost" onClick={bump}>Refresh</button>
          <button
            className="btn ghost"
            onClick={() => {
              clearToken();
              setTokenState("");
            }}
          >
            Disconnect
          </button>
        </header>

        {error ? <div className="banner error">{error}</div> : null}

        <div className="content">
          {tab === "queue" ? <QueuePage refreshKey={refreshKey} onChanged={bump} /> : null}
          {tab === "skills" ? <SkillsPage refreshKey={refreshKey} onChanged={bump} /> : null}
          {tab === "map" ? <MapView refreshKey={refreshKey} onChanged={bump} /> : null}
          {tab === "audit" ? <AuditPage refreshKey={refreshKey} onChanged={bump} /> : null}
          {tab === "health" ? <HealthPage refreshKey={refreshKey} onChanged={bump} /> : null}
          {tab === "settings" ? <SettingsPage refreshKey={refreshKey} onChanged={bump} /> : null}
        </div>
      </main>
    </div>
  );
}

function TokenGate({ onConnect }: { onConnect: (token: string) => void }) {
  const [value, setValue] = useState(getToken());
  const [message, setMessage] = useState("");
  return (
    <div className="token-gate">
      <div className="panel" style={{ padding: 22 }}>
        <div className="brand" style={{ padding: "0 0 12px" }}>OPENMEM CONSOLE</div>
        <h1 style={{ margin: 0, fontSize: "1.2rem" }}>Connect to the local console</h1>
        <p className="muted" style={{ margin: "8px 0 16px", fontSize: "0.8rem", lineHeight: 1.5 }}>
          Open the URL printed by <code>npm run demo</code>; it includes a token. You can also paste the token here.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!value.trim()) {
              setMessage("Token is required.");
              return;
            }
            onConnect(value.trim());
          }}
          style={{ display: "flex", gap: 6 }}
        >
          <input
            className="input"
            style={{ flex: 1 }}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="console token"
            autoFocus
          />
          <button className="btn primary" type="submit">Connect</button>
        </form>
        {message ? <p className="muted" style={{ marginTop: 8 }}>{message}</p> : null}
      </div>
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
