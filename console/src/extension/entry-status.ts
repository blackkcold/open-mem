import { ApiError } from "../api";
import type { AutomationStatus, Health, MemoryItem } from "../types";
import { startPolling } from "./poll";
import { bootExtension } from "./runtime";
import statusCss from "./status.css";
import { injectStyles } from "./styles";
import { host, serviceGet } from "./transport";
import { freshnessAxis, qualityAxis, writeAxis } from "../pages/status-model";

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
      <span class="st-mode">只读</span>
    </div>
    <div class="st-body"><span class="st-loading">正在连接…</span></div>
  </div>
`;

async function load(): Promise<void> {
  try {
    const results = await Promise.allSettled([
      serviceGet<AutomationStatus>("/api/automation/status"),
      serviceGet<{ items: MemoryItem[] }>("/api/memory/items"),
      serviceGet<Health>("/api/health"),
    ]);
    const automation = results[0].status === "fulfilled" ? results[0].value : undefined;
    const items = results[1].status === "fulfilled" ? results[1].value.items : undefined;
    const health = results[2].status === "fulfilled" ? results[2].value : undefined;
    if (!automation && !items) {
      const reason = results.find(
        (entry): entry is PromiseRejectedResult => entry.status === "rejected",
      )?.reason;
      throw reason instanceof ApiError ? reason : new ApiError(0, String(reason));
    }
    renderOk(automation, items, health);
  } catch (error) {
    renderError(
      error instanceof ApiError ? error : new ApiError(0, String(error)),
    );
  }
}

function renderOk(
  automation: AutomationStatus | undefined,
  items: MemoryItem[] | undefined,
  health: Health | undefined,
): void {
  const active = items ? items.filter((item) => item.stoppable).length : undefined;
  const write = writeAxis(automation);
  const quality = qualityAxis(automation);
  const fresh = freshnessAxis(automation);
  mount.innerHTML = `
    <div class="st" data-state="ok">
      <div class="st-top">
        <span class="st-dot"></span>
        <span class="st-name">OpenMem</span>
        <span class="st-pill" title="${escapeText(write.detail)}">${write.label}</span>
        <span class="st-spacer"></span>
        <span class="st-mode">只读</span>
      </div>
      <div class="st-body">
        <span class="st-metric"><b>${active === undefined ? "未知" : active}</b><span>生效中</span></span>
        <span class="st-divider"></span>
        <span class="st-axis ${quality.tone}" title="${quality.detail}">${quality.label}</span>
        <span class="st-divider"></span>
        <span class="st-axis ${fresh.tone}" title="${fresh.detail}">${fresh.label}</span>
      </div>
      <div class="st-sub">${health?.project?.label ? `当前项目 ${escapeText(health.project.label)}` : "当前项目不可确认"} · 只读，不在此操作</div>
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
        <span class="st-mode">只读</span>
      </div>
      <div class="st-body"><span class="st-error"></span></div>
    </div>
  `;
  const message = mount.querySelector<HTMLElement>(".st-error");
  if (message) message.textContent = error.message;
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

void host.setHeight(88).catch(() => undefined);
void load();
startPolling(load, 10_000);
