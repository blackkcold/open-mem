import {
  connectHost,
  HostRequestError,
  type GuestRequestMethod,
} from "@openchamber/sdk";
import { ApiError, type TransportResult } from "../api";

export const host = connectHost({ requestTimeoutMs: 25_000 });

export async function extensionTransport(
  path: string,
  init: RequestInit,
): Promise<TransportResult> {
  const method = (init.method ?? "GET").toUpperCase() as GuestRequestMethod;
  const target = new URL(path, "http://openmem.local");
  const query: Record<string, string> = {};
  target.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  const body = typeof init.body === "string" ? init.body : undefined;

  let result;
  try {
    result = await host.serviceRequest({
      method,
      path: target.pathname,
      query,
      body,
    });
  } catch (error) {
    throw hostError(error);
  }

  const parsed = parseBody(result.body);
  if (
    result.status === 202 &&
    parsed &&
    typeof parsed === "object" &&
    "job" in parsed
  ) {
    return waitForJob(String((parsed as { job: unknown }).job));
  }
  return { status: result.status, body: result.body };
}

export async function serviceGet<T>(path: string): Promise<T> {
  let result;
  try {
    result = await host.serviceRequest({ method: "GET", path });
  } catch (error) {
    throw hostError(error);
  }
  const data = parseBody(result.body);
  if (result.status < 200 || result.status >= 300) {
    const message =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${result.status}`;
    const code =
      data &&
      typeof data === "object" &&
      "code" in data &&
      typeof (data as { code: unknown }).code === "string"
        ? (data as { code: string }).code
        : undefined;
    throw new ApiError(result.status, message, code);
  }
  return data as T;
}

async function waitForJob(id: string): Promise<TransportResult> {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await sleep(350);
    let result;
    try {
      result = await host.serviceRequest({
        method: "GET",
        path: `/jobs/${encodeURIComponent(id)}`,
      });
    } catch (error) {
      throw hostError(error);
    }
    const job = parseBody(result.body) as
      | { state?: string; status?: number; body?: string; error?: string }
      | undefined;
    if (!job) throw new ApiError(502, "后台任务返回异常。", "OPENMEM_JOB");
    if (job.state === "pending") continue;
    if (job.state === "error") {
      throw new ApiError(
        job.status ?? 502,
        job.error ?? "后台任务失败。",
        "OPENMEM_JOB",
      );
    }
    if (job.state === "done") {
      return { status: job.status ?? 200, body: job.body ?? "" };
    }
    throw new ApiError(502, "后台任务返回异常。", "OPENMEM_JOB");
  }
  throw new ApiError(
    504,
    "建议生成仍在后台运行，稍后刷新查看。",
    "OPENMEM_JOB_TIMEOUT",
  );
}

function hostError(error: unknown): ApiError {
  if (error instanceof HostRequestError) {
    const code = error.code;
    switch (code) {
      case "NO_SERVICE":
      case "NOT_GRANTED":
        return new ApiError(
          503,
          "OpenMem 本地服务未授权。请在 设置 → 扩展 中允许本地服务。",
          code,
        );
      case "DISABLED":
        return new ApiError(
          503,
          "OpenMem 扩展已被暂停。请在 设置 → 扩展 中启用。",
          code,
        );
      case "SERVICE_FAILED":
        return new ApiError(
          503,
          "OpenMem 扩展服务启动失败。刷新后会重试。",
          code,
        );
      case "REQUEST_FAILED":
      case "HOST_TIMEOUT":
        return new ApiError(504, "请求超时或连接中断，请重试。", code);
      case "RESPONSE_TOO_LARGE":
        return new ApiError(502, "响应超过 8 MB。", code);
      case "BAD_PATH":
        return new ApiError(400, "请求路径非法。", code);
      case "HOST_UNAVAILABLE":
        return new ApiError(503, "未连接到 OpenChamber 宿主。", code);
      default:
        return new ApiError(
          502,
          error.message || "OpenChamber 宿主返回错误。",
          code,
        );
    }
  }
  return new ApiError(
    502,
    error instanceof Error ? error.message : String(error),
    "OPENMEM_HOST",
  );
}

function parseBody(body: string): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
