import { ApiError } from "../api";
import type { Health, HealthScore } from "../types";
import { startPolling } from "./poll";
import { bootExtension } from "./runtime";
import statusCss from "./status.css";
import { injectStyles } from "./styles";
import { host, serviceGet } from "./transport";

bootExtension();
injectStyles(statusCss);

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("OpenMem status root missing");
const mount: HTMLElement = rootElement;

mount.innerHTML = `
  <div class="st" data-state="loading">
    <div class="st-top">
      <span class="st-dot"></span>
      <span class="st-name">OpenMem</span>
      <span class="st-pill">…</span>
      <span class="st-spacer"></span>
      <span class="st-mode">扩展</span>
    </div>
    <div class="st-body"><span class="st-loading">正在连接…</span></div>
  </div>
`;

async function load(): Promise<void> {
  try {
    const [queue, score, health] = await Promise.all([
      serviceGet<{ items: unknown[] }>("/api/queue"),
      serviceGet<HealthScore>("/api/health-score"),
      serviceGet<Health>("/api/health"),
    ]);
    renderOk(queue.items.length, score, health);
  } catch (error) {
    renderError(
      error instanceof ApiError ? error : new ApiError(0, String(error)),
    );
  }
}

function renderOk(
  count: number,
  score: HealthScore,
  health: Health,
): void {
  const grade = score.grade;
  const width = Math.max(0, Math.min(100, score.score));
  mount.innerHTML = `
    <div class="st" data-state="ok">
      <div class="st-top">
        <span class="st-dot"></span>
        <span class="st-name">OpenMem</span>
        <span class="st-pill ${health.shadow ? "shadow" : "live"}">${health.shadow ? "SHADOW" : "LIVE"}</span>
        <span class="st-spacer"></span>
        <span class="st-mode">扩展</span>
      </div>
      <div class="st-body">
        <span class="st-metric"><b>${count}</b><span>待审批</span></span>
        <span class="st-divider"></span>
        <span class="st-metric"><b class="${grade}">${score.score}</b><span>健康</span></span>
        <span class="st-bar" data-grade="${grade}"><i style="width:${width}%"></i></span>
      </div>
    </div>
  `;
}

function renderError(error: ApiError): void {
  mount.innerHTML = `
    <div class="st" data-state="error">
      <div class="st-top">
        <span class="st-dot"></span>
        <span class="st-name">OpenMem</span>
        <span class="st-pill error">离线</span>
        <span class="st-spacer"></span>
        <span class="st-mode">扩展</span>
      </div>
      <div class="st-body"><span class="st-error"></span></div>
    </div>
  `;
  const message = mount.querySelector<HTMLElement>(".st-error");
  if (message) message.textContent = error.message;
}

void host.setHeight(88).catch(() => undefined);
void load();
startPolling(load, 10_000);
