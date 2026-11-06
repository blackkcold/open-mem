import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyDeliveredStatus,
  classifyJobFailure,
  isJobExpired,
  planJobStart,
  type JobPolicyLimits,
  type PolicyJob,
} from "./job-policy.js";

const VERSION = "0.1.0";
const SERVICE_PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0);
const SERVICE_TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
const SERVICE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function resolveDataDir(): string {
  if (process.env.OPENMEM_DATA_DIR) return process.env.OPENMEM_DATA_DIR;
  try {
    const override = readFileSync(
      path.join(SERVICE_ROOT, "data-dir.txt"),
      "utf8",
    ).trim();
    if (override) {
      return path.resolve(override.replace(/^~(?=$|\/)/, os.homedir()));
    }
  } catch {
    // No local override; use the plugin's default data directory.
  }
  return path.join(os.homedir(), ".config", "opencode", "memory", "autopilot");
}

const DATA_DIR = resolveDataDir();
const MAX_JOB_BODY = 8_000_000;
const MAX_REQUEST_BODY = 1_000_000;
const JOB_TTL_MS = 5 * 60_000;
const MAX_JOBS = 32;
const IDLE_MS = Number(process.env.OPENMEM_SERVICE_IDLE_MS ?? 5 * 60_000);
const FORWARD_TIMEOUT_MS = 15_000;
const JOB_TIMEOUT_MS = 120_000;
const JOB_LIMITS: JobPolicyLimits = {
  terminalTtlMs: JOB_TTL_MS,
  // Pending jobs are never expired by time; maxJobs bounds memory while a slow
  // upstream request may outlive any duration-based limit.
  maxJobs: MAX_JOBS,
};

if (!SERVICE_PORT || !SERVICE_TOKEN) {
  console.error(
    "[openmem-service] OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required",
  );
  process.exit(1);
}

class UpstreamError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
  }
}

type StoredConfig = {
  port?: number;
  token?: string;
};

type Upstream = {
  port: number;
  token: string;
};

type ForwardResult = {
  status: number;
  body: string;
  contentType: string;
};

type Job = PolicyJob & {
  id: string;
  status?: number;
  body?: string;
  error?: string;
  code?: string;
};

let cachedUpstream: Upstream | undefined;
let cachedUpstreamAt = 0;
let lastActivity = Date.now();
let pendingJobs = 0;
// In-memory only. A service restart loses every record, so neither duplicate
// suppression nor eviction protection survives a restart.
const jobs = new Map<string, Job>();

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function resolveUpstream(refresh = false): Promise<Upstream> {
  if (!refresh && cachedUpstream && Date.now() - cachedUpstreamAt < 1_000) {
    return cachedUpstream;
  }
  const config = await readJson<StoredConfig>(path.join(DATA_DIR, "config.json"));
  const port = Number(config?.port) || 47821;
  let token = typeof config?.token === "string" ? config.token.trim() : "";
  if (!token) {
    try {
      token = (await readFile(path.join(DATA_DIR, "console-token"), "utf8")).trim();
    } catch {
      // The console may not have started yet. The caller turns this into a 503.
    }
  }
  if (!token) {
    throw new UpstreamError(
      503,
      "OPENMEM_NO_TOKEN",
      `未找到 console-token（${DATA_DIR}）。请确认 OpenCode 已加载 OpenMem 插件。`,
    );
  }
  cachedUpstream = { port, token };
  cachedUpstreamAt = Date.now();
  return cachedUpstream;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request: http.IncomingMessage): boolean {
  return safeEqual(
    String(request.headers.authorization ?? ""),
    `Bearer ${SERVICE_TOKEN}`,
  );
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendResult(response: http.ServerResponse, result: ForwardResult): void {
  response.writeHead(result.status, {
    "content-type": result.contentType || "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(result.body);
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BODY) {
      throw new UpstreamError(413, "OPENMEM_BODY_TOO_LARGE", "请求体过大。");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function forward(
  method: string,
  target: string,
  body: string,
  timeoutMs = FORWARD_TIMEOUT_MS,
  retried = false,
): Promise<ForwardResult> {
  const upstream = await resolveUpstream(retried);
  return new Promise<ForwardResult>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: upstream.port,
        method,
        path: target,
        headers: {
          authorization: `Bearer ${upstream.token}`,
          accept: "application/json",
          ...(body
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body)),
              }
            : {}),
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_JOB_BODY) {
            request.destroy(
              new UpstreamError(
                502,
                "OPENMEM_RESPONSE_TOO_LARGE",
                "上游响应超过 8 MB。",
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", (error) => reject(error));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode === 401 && !retried) {
            forward(method, target, body, timeoutMs, true).then(resolve, reject);
            return;
          }
          resolve({
            status: response.statusCode ?? 502,
            body: text,
            contentType: String(
              response.headers["content-type"] ?? "application/json; charset=utf-8",
            ),
          });
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(
        new UpstreamError(504, "OPENMEM_TIMEOUT", "上游请求超时。"),
      );
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error instanceof UpstreamError) {
        reject(error);
        return;
      }
      if (error.code === "ECONNREFUSED") {
        reject(
          new UpstreamError(
            503,
            "OPENMEM_OFFLINE",
            `OpenMem 控制台未运行（127.0.0.1:${upstream.port}）。请确认 OpenCode 已加载插件。`,
          ),
        );
        return;
      }
      reject(
        new UpstreamError(
          502,
          "OPENMEM_UPSTREAM",
          error.message || "无法连接 OpenMem 控制台。",
        ),
      );
    });
    if (body) request.write(body);
    request.end();
  });
}

function jobKey(method: string, target: string, body: string): string {
  return `${method} ${target} ${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
}

function isJobRoute(method: string, pathname: string, body: string): boolean {
  if (method !== "POST") return false;
  if (pathname === "/api/retention/apply") return true;
  if (/^\/api\/queue\/[^/]+\/suggest$/.test(pathname)) return true;
  if (pathname !== "/api/queue/batch") return false;
  try {
    const parsed = JSON.parse(body) as { dryRun?: unknown };
    return parsed.dryRun !== true;
  } catch {
    return false;
  }
}

function pruneJobs(now: number): void {
  for (const [id, job] of jobs) {
    if (isJobExpired(job, now, JOB_LIMITS)) jobs.delete(id);
  }
}

function startJob(method: string, target: string, body: string): Job {
  const now = Date.now();
  pruneJobs(now);
  const key = jobKey(method, target, body);
  const plan = planJobStart(jobs, key, now, JOB_LIMITS);
  if (plan.action === "reuse") return plan.job;
  if (plan.action === "reject") {
    throw new UpstreamError(
      429,
      "OPENMEM_JOB_CAPACITY",
      "后台任务缓存已满（存在进行中、结果未知或保护期内的已完成任务）。请稍后再提交；若为写操作，请先刷新核对结果，避免重复写入。",
    );
  }
  if (plan.action === "evict") jobs.delete(plan.id);
  const job: Job = {
    id: `job_${randomBytes(8).toString("hex")}`,
    key,
    state: "pending",
    createdAt: now,
  };
  jobs.set(job.id, job);
  pendingJobs += 1;
  void forward(method, target, body, JOB_TIMEOUT_MS)
    .then((result) => {
      job.settledAt = Date.now();
      job.state = "done";
      job.status = result.status;
      job.body = result.body;
      job.outcome = classifyDeliveredStatus(result.status);
    })
    .catch((error: unknown) => {
      job.settledAt = Date.now();
      const code = error instanceof UpstreamError ? error.code : "OPENMEM_UPSTREAM";
      job.state = "error";
      job.status = error instanceof UpstreamError ? error.status : 502;
      job.code = code;
      job.outcome = classifyJobFailure(code);
      job.error = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      pendingJobs = Math.max(0, pendingJobs - 1);
      lastActivity = Date.now();
    });
  return job;
}

const server = http.createServer((request, response) => {
  lastActivity = Date.now();
  void handle(request, response).catch((error: unknown) => {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof UpstreamError) {
      sendJson(response, error.status, { error: error.message, code: error.code });
      return;
    }
    sendJson(response, 502, {
      error: "OpenMem 扩展服务异常。",
      code: "OPENMEM_SERVICE",
    });
  });
});

async function handle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  if (!authorized(request)) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }

  const method = (request.method ?? "GET").toUpperCase();
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "openmem",
      version: VERSION,
      uptime: Math.round(process.uptime()),
    });
    return;
  }

  if (method === "GET" && pathname === "/meta") {
    let upstream: Upstream | undefined;
    try {
      upstream = await resolveUpstream();
    } catch {
      upstream = undefined;
    }
    sendJson(response, 200, {
      ok: true,
      service: "openmem",
      version: VERSION,
      dataDir: DATA_DIR,
      upstreamPort: upstream?.port ?? null,
      upstreamBase: upstream ? `http://127.0.0.1:${upstream.port}` : null,
      hasToken: Boolean(upstream?.token),
    });
    return;
  }

  if (method === "GET" && pathname.startsWith("/jobs/")) {
    pruneJobs(Date.now());
    const id = pathname.slice("/jobs/".length);
    const job = jobs.get(id);
    if (!job) {
      sendJson(response, 404, {
        error:
          "后台任务记录不存在：可能已被清理、已过期，" +
          "或扩展服务已重启（任务记录仅保存在内存中）。" +
          `正常清理窗口为 ${Math.round(JOB_TTL_MS / 60_000)} 分钟，` +
          "但过期或重启后都无法确认该请求是否已送达；若为写操作请先刷新核对再决定是否重试。",
        code: "OPENMEM_JOB_NOT_FOUND",
        outcome: "unknown",
      });
      return;
    }
    if (job.state === "pending") {
      sendJson(response, 200, { state: "pending" });
      return;
    }
    if (job.state === "error") {
      sendJson(response, 200, {
        state: "error",
        status: job.status,
        error: job.error,
        code: job.code ?? "OPENMEM_JOB",
        outcome: job.outcome ?? "unknown",
      });
      return;
    }
    sendJson(response, 200, {
      state: "done",
      status: job.status,
      body: job.body ?? "",
      ...(job.outcome ? { outcome: job.outcome } : {}),
    });
    return;
  }

  if (!pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "not found" });
    return;
  }

  if (pathname.includes("..") || pathname.includes("\\")) {
    sendJson(response, 400, { error: "bad path", code: "OPENMEM_BAD_PATH" });
    return;
  }

  // The extension panel uses polling; the host proxy cannot stream.
  if (pathname === "/api/events") {
    sendJson(response, 410, {
      error: "扩展模式不支持 SSE，请使用轮询。",
      code: "OPENMEM_STREAM_UNSUPPORTED",
    });
    return;
  }

  const body = await readBody(request);
  const target = `${pathname}${url.search}`;

  if (isJobRoute(method, pathname, body)) {
    const job = startJob(method, target, body);
    sendJson(response, 202, { job: job.id });
    return;
  }

  const result = await forward(method, target, body);
  sendResult(response, result);
}

server.on("error", (error) => {
  console.error("[openmem-service] server error", error);
  process.exit(1);
});

server.listen(SERVICE_PORT, "127.0.0.1", () => {
  console.log(
    `[openmem-service] listening on 127.0.0.1:${SERVICE_PORT} (data: ${DATA_DIR})`,
  );
});

const idleTimer = setInterval(() => {
  if (pendingJobs === 0 && Date.now() - lastActivity > IDLE_MS) {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  }
}, 30_000);
idleTimer.unref();

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
