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
import { ConfirmHost, confirmAction } from "./extension/confirm";
import { connectionHint } from "./extension/errors";
import { Icon, LogoMark } from "./extension/Icon";
import { isExtension } from "./extension/mode";
import { startPolling } from "./extension/poll";
import type { Health, Metrics, MemoryGraphView } from "./types";
import { AuditPage } from "./pages/Audit";
import { parseRouteHash, type RouteTab } from "./pages/audit-links";
import {
  CLEAN_FORMS,
  disconnectDraftWarning,
  hasDirtyForms,
  isPageMounted,
  isPageVisible,
  rememberPageVisit,
  setFormDirty,
} from "./pages/draft-state";
import type { DirtyForms, DraftForm, RetainedPage } from "./pages/draft-state";
import { HealthPage } from "./pages/Health";
import { MemoryGraph } from "./pages/MemoryGraph";
import { QueuePage } from "./pages/Queue";
import { SettingsPage } from "./pages/Settings";
import { SkillsPage } from "./pages/Skills";

type Tab = RouteTab;

const TABS: Array<{ id: Tab; label: string; icon: Parameters<typeof Icon>[0]["name"] }> = [
  { id: "queue", label: "审批队列", icon: "queue" },
  { id: "skills", label: "Skill Review", icon: "spark" },
  { id: "map", label: "记忆图谱", icon: "shield" },
  { id: "audit", label: "审计", icon: "alert" },
  { id: "health", label: "健康", icon: "clock" },
  { id: "settings", label: "设置", icon: "settings" },
];

export function App() {
  const extension = isExtension();
  const [token, setTokenState] = useState(() => readTokenFromLocation());
  const [tab, setTab] = useState<Tab>("queue");
  // The queue is the default tab; mark it retained from the start so its
  // unsaved decision drafts survive switching to audit and back.
  const [retainedPages, setRetainedPages] = useState<readonly RetainedPage[]>(["queue"]);
  const [dirtyForms, setDirtyForms] = useState<DirtyForms>(CLEAN_FORMS);
  const [queueTarget, setQueueTarget] = useState<string>();
  const [auditTarget, setAuditTarget] = useState<{ id?: string; reportAt?: string }>();
  const [graphView, setGraphView] = useState<MemoryGraphView>("architecture");
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

  // Remembering the visit in the same update as the tab change means a page
  // mounts on its first visit and is never unmounted by a later switch.
  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    setRetainedPages((current) => rememberPageVisit(current, next));
  }, []);

  // Stable per-page callbacks: the retained editors register their dirty state
  // here, and clear it on unmount so a stale flag cannot block a clean exit.
  const registerDirty = useCallback((form: DraftForm, dirty: boolean) => {
    setDirtyForms((current) => setFormDirty(current, form, dirty));
  }, []);
  const onSettingsDirty = useCallback(
    (dirty: boolean) => registerDirty("settings", dirty),
    [registerDirty],
  );
  const onSkillsDirty = useCallback(
    (dirty: boolean) => registerDirty("skills", dirty),
    [registerDirty],
  );
  const onQueueDirty = useCallback(
    (dirty: boolean) => registerDirty("queue", dirty),
    [registerDirty],
  );

  // Browser-level close/reload must warn while any retained editor is dirty.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!hasDirtyForms(dirtyForms)) return;
      event.preventDefault();
      // Legacy browsers require a truthy returnValue to show the prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirtyForms]);

  async function disconnect() {
    const warning = disconnectDraftWarning(dirtyForms);
    if (warning) {
      const ok = await confirmAction({
        title: "断开控制台？",
        message: `${warning.message} 取消会保持连接和当前草稿。`,
        confirmLabel: "断开并丢弃草稿",
        cancelLabel: "取消",
        danger: true,
      });
      if (!ok) return;
    }
    clearToken();
    setTokenState("");
  }

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
      if (metricsResult.status === "fulfilled") {
        setMetrics(metricsResult.value);
      } else {
        // Never keep a previous snapshot when the live read failed: the queue
        // shows "unknown" instead of a stale global count.
        setMetrics(undefined);
      }
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
      const route = parseRouteHash(window.location.hash);
      if (!route) return;
      selectTab(route.tab);
      setQueueTarget(route.queueItemID);
      setAuditTarget(
        route.auditFindingID
          ? { id: route.auditFindingID, reportAt: route.auditReportAt }
          : undefined,
      );
      if (route.graphView) {
        setGraphView(route.graphView);
      } else if (route.tab === "map") {
        setGraphView("architecture");
      }
    };
    navigate();
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, [selectTab]);

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
              selectTab(entry.id);
              setQueueTarget(undefined);
              setAuditTarget(undefined);
              if (entry.id === "map") setGraphView("architecture");
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
          <span className="sidebar-version">v0.5.0</span>
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
              onClick={() => void disconnect()}
            >
              断开
            </button>
          ) : null}
        </header>

        {error ? <div className="banner error">{error.message}</div> : null}

        <div className="content">
          {isPageMounted(retainedPages, tab, "queue") ? (
            <div hidden={!isPageVisible(tab, "queue")}>
              <QueuePage
                refreshKey={refreshKey}
                onChanged={refresh}
                targetItemID={queueTarget}
                globalQueueCount={metrics?.queue}
                visible={isPageVisible(tab, "queue")}
                onDirtyChange={onQueueDirty}
              />
            </div>
          ) : null}
          {isPageMounted(retainedPages, tab, "skills") ? (
            <div hidden={!isPageVisible(tab, "skills")}>
              <SkillsPage refreshKey={refreshKey} onChanged={refresh} onDirtyChange={onSkillsDirty} />
            </div>
          ) : null}
          {tab === "map" ? (
            <MemoryGraph
              refreshKey={refreshKey}
              view={graphView}
              onViewChange={setGraphView}
            />
          ) : null}
          {tab === "audit" ? (
            <AuditPage
              refreshKey={refreshKey}
              onChanged={refresh}
              targetFindingID={auditTarget?.id}
              targetReportAt={auditTarget?.reportAt}
            />
          ) : null}
          {tab === "health" ? <HealthPage refreshKey={refreshKey} onChanged={refresh} /> : null}
          {isPageMounted(retainedPages, tab, "settings") ? (
            <div hidden={!isPageVisible(tab, "settings")}>
              <SettingsPage refreshKey={refreshKey} onChanged={refresh} onDirtyChange={onSettingsDirty} />
            </div>
          ) : null}
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
