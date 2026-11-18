import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  clearToken,
  getToken,
  exchangeConnectTicket,
  fetchAutomationStatus,
  readTokenFromLocation,
  setToken,
  sseUrl,
} from "./api";
import { ConfirmHost, confirmAction } from "./extension/confirm";
import { connectionHint } from "./extension/errors";
import { Icon, LogoMark } from "./extension/Icon";
import { isExtension } from "./extension/mode";
import { startPolling } from "./extension/poll";
import { host } from "./extension/transport";
import type { AutomationStatus, Health, Metrics } from "./types";
import { AdvancedPage, AdvancedShell } from "./pages/Advanced";
import { ActivityPage } from "./pages/Activity";
import {
  canonicalHash,
  parseRouteHash,
  type ConsoleRoute,
  type MainTab,
} from "./pages/audit-links";
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
import { MemoryPage } from "./pages/Memory";
import { ReviewQueue } from "./pages/Queue";
import { SettingsPage } from "./pages/Settings";
import {
  itemActionLockScope,
  useItemActionLocks,
} from "./pages/item-action-locks";
import { SkillsPage } from "./pages/Skills";
import { axisChips, writeAxis } from "./pages/status-model";

const TABS: Array<{ id: MainTab; label: string; icon: Parameters<typeof Icon>[0]["name"] }> = [
  { id: "memory", label: "记忆", icon: "shield" },
  { id: "activity", label: "活动", icon: "clock" },
  { id: "settings", label: "设置", icon: "settings" },
];

const MAIN_TABS: ReadonlySet<string> = new Set<MainTab>(["memory", "activity", "settings"]);

export function App() {
  const extension = isExtension();
  const [token, setTokenState] = useState(() => readTokenFromLocation());
  const [tab, setTab] = useState<MainTab>("memory");
  const [route, setRoute] = useState<ConsoleRoute>({ tab: "memory" });
  const [retainedPages, setRetainedPages] = useState<readonly RetainedPage[]>([]);
  const [dirtyForms, setDirtyForms] = useState<DirtyForms>(CLEAN_FORMS);
  const [reviewVisited, setReviewVisited] = useState(
    () => parseRouteHash(window.location.hash)?.advanced === "review",
  );
  const [skillsVisited, setSkillsVisited] = useState(
    () => parseRouteHash(window.location.hash)?.advanced === "skills",
  );
  const [health, setHealth] = useState<Health>();
  const [metrics, setMetrics] = useState<Metrics>();
  const [automation, setAutomation] = useState<AutomationStatus>();
  const [currentSessionID, setCurrentSessionID] = useState<string | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [healthKey, setHealthKey] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [live, setLive] = useState(false);
  const [connecting, setConnecting] = useState(() => !extension && new URL(window.location.href).searchParams.has("connect"));
  const connectAttempt = useRef<Promise<string | undefined>>(undefined);
  const lockScope = itemActionLockScope(health);
  const actionLocks = useItemActionLocks(lockScope);
  const actionLockCount = Object.keys(actionLocks.locks).length;

  useEffect(() => {
    if (!extension) return;
    // The extension host is the only trusted source of "this session"; the
    // standalone console never guesses a session from URLs or model input.
    return host.onSession((session) => setCurrentSessionID(session?.id));
  }, [extension]);

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

  const selectTab = useCallback((next: MainTab) => {
    setTab(next);
    setRetainedPages((current) => rememberPageVisit(current, next));
  }, []);

  const applyRoute = useCallback(
    (next: ConsoleRoute) => {
      if (!MAIN_TABS.has(next.tab)) return;
      const main = next.tab as MainTab;
      selectTab(main);
      setRoute(next);
      if (next.advanced === "review") setReviewVisited(true);
      if (next.advanced === "skills") setSkillsVisited(true);
    },
    [selectTab],
  );

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

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!hasDirtyForms(dirtyForms)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirtyForms]);

  useEffect(() => {
    if (actionLockCount === 0 || actionLocks.persistence === "available") {
      return;
    }
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [actionLockCount, actionLocks.persistence]);

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
      fetchAutomationStatus(),
    ]).then(([healthResult, metricsResult, automationResult]) => {
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
        // Never keep a previous snapshot when the live read failed: counts
        // show "unknown" instead of a stale global number.
        setMetrics(undefined);
      }
      setAutomation(
        automationResult.status === "fulfilled" ? automationResult.value : undefined,
      );
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
    source.onerror = () => setLive(false);
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
      const parsed = parseRouteHash(window.location.hash);
      if (!parsed) {
        // Unknown hashes keep the existing "do not jump" behaviour. An empty
        // hash is the one case where the console lands on Memory.
        if (!window.location.hash) {
          window.history.replaceState(null, "", "#memory");
          applyRoute({ tab: "memory" });
        }
        return;
      }
      const canonical = canonicalHash(parsed);
      if (window.location.hash !== canonical) {
        window.history.replaceState(null, "", canonical);
      }
      const normalized = parseRouteHash(canonical);
      if (normalized) applyRoute(normalized);
    };
    navigate();
    window.addEventListener("hashchange", navigate);
    window.addEventListener("popstate", navigate);
    return () => {
      window.removeEventListener("hashchange", navigate);
      window.removeEventListener("popstate", navigate);
    };
  }, [applyRoute]);

  useEffect(() => {
    if (!token || !extension) return;
    const interval = tab === "settings" ? 20_000 : 5_000;
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
  const settingsVisible = tab === "settings" && !route.advanced;
  const chips = axisChips(automation);
  const writeChip = writeAxis(automation);

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
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
        <nav aria-label="主导航">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              className={`nav${entry.id === tab ? " active" : ""}`}
              data-tab={entry.id}
              aria-current={entry.id === tab ? "page" : undefined}
              onClick={() => {
                if (window.location.hash === `#${entry.id}`) {
                  applyRoute({ tab: entry.id });
                } else {
                  window.location.hash = entry.id;
                }
                bump();
              }}
            >
              <Icon name={entry.icon} size={15} />
              <span>{entry.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="sidebar-mode" title={writeChip.detail}>
            {writeChip.label}
          </span>
          <span className="sidebar-mode">{extension ? "OpenChamber 扩展" : "localhost + token"}</span>
          <span className="sidebar-version">v{__APP_VERSION__}</span>
          <span className="sidebar-build" title={__BUILD_TIME__}>
            构建 {__BUILD_TIME__.replace("T", " ").replace(/\.\d+Z$/, " UTC")}
          </span>
        </div>
      </aside>

      <main className="main" id="main-content">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{active.label}</h1>
            <span className="meta" title={health?.dataDir}>
              {health?.dataDir ?? "connecting…"}
            </span>
          </div>
          <span className="axis-chips topbar-axes" aria-label="运行状态（三轴独立）">
            {chips.map((chip) => (
              <span className={`axis-chip ${chip.tone}`} key={chip.key} title={chip.detail}>
                <i aria-hidden="true" />
                {chip.label}
              </span>
            ))}
          </span>
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
        {actionLockCount > 0 && actionLocks.persistence === "unavailable" ? (
          <div className="banner warning" role="status">
            操作结果锁无法跨刷新持久化；当前页面内仍保留，刷新前请先核对未知结果。
          </div>
        ) : null}

        <div className="content">
          {tab === "memory" ? (
            <MemoryPage
              refreshKey={refreshKey}
              health={health}
              metrics={metrics}
              automation={automation}
              itemID={route.memoryItemID}
              sessionID={currentSessionID}
              lockScope={lockScope}
              onChanged={refresh}
            />
          ) : null}
          {tab === "activity" ? (
            <ActivityPage
              refreshKey={refreshKey}
              automation={automation}
              metrics={metrics}
              eventID={route.activityEventID}
              lockScope={lockScope}
              onChanged={refresh}
            />
          ) : null}
          {isPageMounted(retainedPages, tab, "settings") ? (
            <div hidden={!settingsVisible}>
              <SettingsPage
                refreshKey={refreshKey}
                onChanged={refresh}
                onDirtyChange={onSettingsDirty}
                metrics={metrics}
                automation={automation}
              />
            </div>
          ) : null}
          {reviewVisited ? (
            <div hidden={route.advanced !== "review"}>
              <AdvancedShell section="review">
                <ReviewQueue
                  refreshKey={refreshKey}
                  onChanged={refresh}
                  targetItemID={route.reviewItemID}
                  globalQueueCount={metrics?.queue}
                  visible={route.advanced === "review"}
                  onDirtyChange={onQueueDirty}
                />
              </AdvancedShell>
            </div>
          ) : null}
          {skillsVisited ? (
            <div hidden={route.advanced !== "skills"}>
              <AdvancedShell section="skills">
                <SkillsPage
                  refreshKey={refreshKey}
                  onChanged={refresh}
                  onDirtyChange={onSkillsDirty}
                />
              </AdvancedShell>
            </div>
          ) : null}
          {route.advanced && route.advanced !== "review" && route.advanced !== "skills" ? (
            <AdvancedPage
              section={route.advanced}
              refreshKey={refreshKey}
              onChanged={refresh}
              metrics={metrics}
              auditFindingID={route.auditFindingID}
              auditReportAt={route.auditReportAt}
              graphView={route.graphView}
              onDirtyChange={onSettingsDirty}
            />
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
