import { isExtension } from "./extension/mode";

const TOKEN_KEY = "openmem.token";

export interface TransportResult {
  status: number;
  body: string;
}

export type Transport = (path: string, init: RequestInit) => Promise<TransportResult>;

let transport: Transport = standaloneTransport;
let memoryToken = "";

export function setTransport(next: Transport): void {
  transport = next;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  /** Parsed response body, when the server sent one. */
  readonly details?: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** A lost write response cannot establish whether the server committed it. */
export function unknownWriteOutcome(): ApiError {
  return new ApiError(504, "操作结果未知，可能已提交。请先刷新核对，勿直接重试。", "OPENMEM_OUTCOME_UNKNOWN");
}

function readStoredToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    // The extension iframe is an opaque origin and localStorage throws.
    return "";
  }
}

export function readTokenFromLocation(): string {
  if (isExtension()) return "extension";
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has("connect")) return "";
    const token = url.searchParams.get("token") ?? "";
    if (token) {
      setToken(token);
      url.searchParams.delete("token");
      window.history.replaceState(null, "", url.toString());
    }
    return token || getToken();
  } catch {
    return getToken();
  }
}

export async function exchangeConnectTicket(): Promise<string | undefined> {
  if (isExtension()) return undefined;
  const url = new URL(window.location.href);
  const ticket = url.searchParams.get("connect");
  if (!ticket) return undefined;
  url.searchParams.delete("connect");
  window.history.replaceState(null, "", url.toString());
  const response = await fetch("/api/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) });
  const data: unknown = await response.json();
  if (!response.ok || typeof data !== "object" || data === null || !("token" in data) || typeof data.token !== "string") {
    throw new ApiError(response.status, "连接链接已过期或已使用，请重新获取链接或输入 Token");
  }
  setToken(data.token);
  return data.token;
}

export function getToken(): string {
  return isExtension() ? "" : memoryToken || readStoredToken();
}

export function setToken(token: string): void {
  if (isExtension()) return;
  memoryToken = token;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Standalone storage can be blocked by the browser; the token still lives
    // in the URL for this page load.
  }
}

export function clearToken(): void {
  if (isExtension()) return;
  memoryToken = "";
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore storage failures; there is nothing else to clear.
  }
}

async function standaloneTransport(
  path: string,
  init: RequestInit,
): Promise<TransportResult> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
    const body = await response.text();
    return { status: response.status, body };
  } catch {
    if ((init.method ?? "GET").toUpperCase() !== "GET") throw unknownWriteOutcome();
    throw new ApiError(0, "无法连接 OpenMem 控制台。请确认它正在运行。");
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const result = await transport(path, init);
  if (result.status >= 500 && (init.method ?? "GET").toUpperCase() !== "GET") {
    throw unknownWriteOutcome();
  }
  let data: unknown;
  if (result.body) {
    try {
      data = JSON.parse(result.body) as unknown;
    } catch {
      data = result.body;
    }
  }
  if (result.status < 200 || result.status >= 300) {
    const record =
      typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)
        : undefined;
    const message =
      typeof record?.error === "string"
        ? record.error
        : typeof record?.message === "string"
          ? record.message
          : Array.isArray(record?.errors)
            ? record.errors.filter((entry): entry is string => typeof entry === "string").join("；")
          : `HTTP ${result.status}`;
    throw new ApiError(
      result.status,
      message,
      typeof record?.code === "string" ? record.code : undefined,
      record,
    );
  }
  return data as T;
}

export function sseUrl(): string {
  return `/api/events?token=${encodeURIComponent(getToken())}`;
}

export function formatAge(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "—";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Longer, human phrasing for the session review card and health strip. */
export function formatReviewAge(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "未知";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function priorityClass(priority: number | undefined): string {
  const value = priority ?? 0;
  if (value >= 75) return "high";
  if (value >= 50) return "mid";
  return "low";
}
