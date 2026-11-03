const TOKEN_KEY = "openmem.token";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function readTokenFromLocation(): string {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token") ?? "";
  if (token) setToken(token);
  return token || getToken();
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    ...(init.body ? { "content-type": "application/json" } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data && typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${response.status}`;
    throw new ApiError(response.status, message);
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

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function priorityClass(priority: number | undefined): string {
  const value = priority ?? 0;
  if (value >= 75) return "high";
  if (value >= 50) return "mid";
  return "low";
}
