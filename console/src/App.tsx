import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  clearToken,
  getToken,
  exchangeConnectTicket,
  readTokenFromLocation,
  setToken,
  sseUrl,
} from "./api";
import { ConfirmHost } from "./extension/confirm";
import { connectionHint } from "./extension/errors";
import { Icon, LogoMark } from "./extension/Icon";
import { isExtension } from "./extension/mode";
import { startPolling } from "./extension/poll";
import type { Health, Metrics } from "./types";
import { AuditPage } from "./pages/Audit";
import { HealthPage } from "./pages/Health";
import { MapView } from "./pages/MapView";
import { QueuePage } from "./pages/Queue";
import { SettingsPage } from "./pages/Settings";
import { SkillsPage } from "./pages/Skills";

type Tab = "queue" | "skills" | "map" | "audit" | "health" | "settings";

const TABS: Array<{ id: Tab; label: string; icon: Parameters<typeof Icon>[0]["name"] }> = [
  { id: "queue", label: "审批队列", icon: "queue" },
  { id: "skills", label: "Skill Review", icon: "spark" },
  { id: "map", label: "记忆地图", icon: "shield" },
  { id: "audit", label: "审计", icon: "alert" },
  { id: "health", label: "健康", icon: "clock" },
  { id: "settings", label: "设置", icon: "settings" },
];

export function App() {
  const extension = isExtension();
  const [token, setTokenState] = useState(() => readTokenFromLocation());
  const [tab, setTab] = useState<Tab>("queue");
  const [health, setHealth] = useState<Health>();
  const [metrics, setMetrics] = useState<Metrics>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [healthKey, setHealthKey] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [live, setLive] = useState(false);
  const [connecting, setConnecting] = useState(() => !extension && new URL(window.location.href).searchParams.has("connect"));
  const connectAttempt = useRef<Promise<string | undefined>>(undefined);

  useEffect(() => {
    if (!connecting) return;
    connectAttempt.current ??= exchangeConnectTicket();
    void connectAttempt.current.then((value) => {
      if (value) { setTokenState(value); setError(null); }
    }).catch((caught: unknown) => setError(toApiError(caught))).finally(() => setConnecting(false));
  }, []);

  const bump = useCallback(() => setRefreshKey((value) => value + 1), []);
  const bumpHealth = useCallback(() => setHealthKey((value) => value + 1), []);
  const refresh = useCallback(() => {
    bump();
    bumpHealth();
  }, [bump, bumpHealth]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    Promise.allSettled([
      api<Health>("/api/health"),
      api<Metrics>("/api/metrics"),
    ]).then(([healthResult, metricsResult]) => {
      if (cancelled) return;
      if (healthResult.status === "fulfilled") {
        setHealth(healthResult.value);
        setError(null);
      } else {
        setError(toApiError(healthResult.reason));
      }
      if (metricsResult.status === "fulfilled") setMetrics(metricsResult.value);
    });
    return () => {
      cancelled = true;
    };
  }, [token, healthKey]);

  useEffect(() => {
    if (!token || extension) return;
    const source = new EventSource(sseUrl());
    const handler = () => {
      bump();
      bumpHealth();
    };
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
      "hooks.updated",
      "turn.updated",
      "review.updated",
      "review.failed",
      "review.scheduled",
    ];
    for (const event of events) source.addEventListener(event, handler);
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false); // EventSource retries transient errors automatically.
    const timer = window.setInterval(() => {
      bump();
      bumpHealth();
    }, 20_000);
    return () => {
      window.clearInterval(timer);
      for (const event of events) source.removeEventListener(event, handler);
      source.close();
    };
  }, [token, extension, bump, bumpHealth]);

  useEffect(() => {
    const navigate = () => {
      const value = window.location.hash.slice(1);
      if (TABS.some((entry) => entry.id === value)) setTab(value as Tab);
    };
    navigate();
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);

  useEffect(() => {
    if (!token || !extension) return;
    const interval = tab === "map" || tab === "settings" ? 20_000 : 5_000;
    return startPolling(() => bump(), interval);
  }, [token, extension, tab, bump]);

  useEffect(() => {
    if (!token || !extension) return;
    return startPolling(() => bumpHealth(), 20_000);
  }, [token, extension, bumpHealth]);

  if (connecting) return <div className="token-gate" role="status">正在安全连接本地控制台…</div>;
  if (!token) {
    return (
      <TokenGate
        initialMessage={error?.message}
        onConnect={(value) => {
          setToken(value);
          setTokenState(value);
        }}
      />
    );
  }

  if (error && !health) {
    return (
      <ConnectionError
        error={error}
        onRetry={refresh}
        onReconnect={!extension && error.status === 401 ? () => { clearToken(); setTokenState(""); setHealth(undefined); setError(null); } : undefined}
      />
    );
  }

  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <LogoMark size={30} />
          </span>
          <span className="brand-copy">
            <strong>OpenMem</strong>
            <small>Console</small>
          </span>
        </div>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            className={`nav${entry.id === tab ? " active" : ""}`}
            data-tab={entry.id}
            onClick={() => {
              setTab(entry.id);
              window.location.hash = entry.id;
              bump();
            }}
          >
            <Icon name={entry.icon} size={15} />
            <span>{entry.label}</span>
            {entry.id === "queue" && metrics ? <b>{metrics.queue}</b> : null}
            {entry.id === "skills" && metrics ? <b>{metrics.skillDrafts}</b> : null}
            {entry.id === "audit" && metrics ? <b>{metrics.auditFindings}</b> : null}
          </button>
        ))}
        <div className="sidebar-foot">
          <span className="shadow-pill">{health?.shadow ? "SHADOW ON" : "SHADOW OFF"}</span>
          <span className="sidebar-mode">{extension ? "OpenChamber 扩展" : "localhost + token"}</span>
          <span className="sidebar-version">v0.3.0</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{active.label}</h1>
            <span className="meta" title={health?.dataDir}>
              {health?.dataDir ?? "connecting…"}
            </span>
          </div>
          <span className="spacer" />
          <span className={`connection-pill${extension ? " extension" : " local"}`}>
            <i aria-hidden="true" />
            {extension ? "Extension" : live ? "实时在线" : "轮询连接 · 实时重连中"}
          </span>
          <button className="btn ghost icon-btn" onClick={refresh} type="button">
            <Icon name="refresh" size={14} />
            <span>刷新</span>
          </button>
          {!extension ? (
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                clearToken();
                setTokenState("");
              }}
            >
              断开
            </button>
          ) : null}
        </header>

        {error ? <div className="banner error">{error.message}</div> : null}

        <div className="content">
          {tab === "queue" ? <QueuePage refreshKey={refreshKey} onChanged={refresh} /> : null}
          {tab === "skills" ? <SkillsPage refreshKey={refreshKey} onChanged={refresh} /> : null}
          {tab === "map" ? <MapView refreshKey={refreshKey} onChanged={refresh} /> : null}
          {tab === "audit" ? <AuditPage refreshKey={refreshKey} onChanged={refresh} /> : null}
          {tab === "health" ? <HealthPage refreshKey={refreshKey} onChanged={refresh} /> : null}
          {tab === "settings" ? <SettingsPage refreshKey={refreshKey} onChanged={refresh} /> : null}
        </div>
      </main>
      <ConfirmHost />
    </div>
  );
}

function ConnectionError({
  error,
  onRetry,
  onReconnect,
}: {
  error: ApiError;
  onRetry: () => void;
  onReconnect?: () => void;
}) {
  const hint = connectionHint(error);
  return (
    <div className="fatal-screen">
      <div className="fatal-card">
        <div className="fatal-mark" aria-hidden="true">
          <Icon name="alert" size={22} />
        </div>
        <span className="fatal-kicker">OpenMem Console</span>
        <h1>暂时无法连接控制台</h1>
        <p>{error.message}</p>
        <p className="fatal-hint">{hint}</p>
        <div className="fatal-actions">
          {onReconnect ? <button className="btn" type="button" onClick={onReconnect}>更换 Token</button> : null}
          <button className="btn primary" type="button" onClick={onRetry}>
            <Icon name="refresh" size={14} />
            重试
          </button>
        </div>
      </div>
    </div>
  );
}

function TokenGate({ onConnect, initialMessage }: { onConnect: (token: string) => void; initialMessage?: string }) {
  const [value, setValue] = useState(getToken());
  const [message, setMessage] = useState(initialMessage ?? "");
  return (
    <div className="token-gate">
      <div className="panel" style={{ padding: 24 }}>
        <div className="brand" style={{ padding: "0 0 14px" }}>
          <span className="brand-mark" aria-hidden="true">
            <LogoMark size={30} />
          </span>
          <span className="brand-copy">
            <strong>OpenMem</strong>
            <small>Console</small>
          </span>
        </div>
        <h1 style={{ margin: 0, fontSize: "1.2rem" }}>连接本地控制台</h1>
        <p className="muted" style={{ margin: "8px 0 16px", fontSize: "0.8rem", lineHeight: 1.5 }}>
          粘贴 <code>console-token</code>，或打开带 token 的链接。Token 只保存在本机浏览器。
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
            aria-label="控制台 Token"
            type="password"
            autoFocus
          />
          <button className="btn primary" type="submit">
            连接
          </button>
        </form>
        {message ? <p className="muted" style={{ marginTop: 8 }}>{message}</p> : null}
      </div>
    </div>
  );
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(
    0,
    error instanceof Error ? error.message : String(error),
  );
}
