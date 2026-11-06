import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../console/src/api.js";
import { connectionHint } from "../../console/src/extension/errors.js";

let transport: typeof import("../../console/src/extension/transport.js");
let HostRequestError: typeof import("../../console/node_modules/@openchamber/sdk/dist/index.js").HostRequestError;

beforeAll(async () => {
  // A synthetic frame prevents any access to an actual browser or host.
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    parent: { postMessage: () => undefined },
    setTimeout,
  });
  ({ HostRequestError } = await import("../../console/node_modules/@openchamber/sdk/dist/index.js"));
  transport = await import("../../console/src/extension/transport.js");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(() => vi.unstubAllGlobals());

describe("extension request outcome", () => {
  const ambiguousHostCodes = [
    "SERVICE_FAILED", "NO_SERVICE", "NOT_GRANTED", "DISABLED", "BAD_PATH",
  ] as const;

  it("warns that a timed-out write may already have committed", async () => {
    vi.spyOn(transport.host, "serviceRequest").mockRejectedValueOnce(
      new HostRequestError("HOST_TIMEOUT", "host timed out"),
    );
    const error = await transport.extensionTransport("/api/queue/x/decision", {
      method: "POST",
      body: "{}",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.code).toBe("OPENMEM_OUTCOME_UNKNOWN");
    expect(error.message).toContain("可能已提交");
    expect(error.message).toContain("刷新");
  });

  it("keeps retry guidance for a timed-out read", async () => {
    vi.spyOn(transport.host, "serviceRequest").mockRejectedValueOnce(
      new HostRequestError("HOST_TIMEOUT", "host timed out"),
    );
    const error = await transport.extensionTransport("/api/queue", {
      method: "GET",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.code).toBe("HOST_TIMEOUT");
    expect(error.message).toContain("重试");
  });

  it.each(ambiguousHostCodes)("does not assume host error %s proves a write was not dispatched", async (code) => {
    vi.spyOn(transport.host, "serviceRequest").mockRejectedValueOnce(
      new HostRequestError(code, "host error without dispatch proof"),
    );
    const error = await transport.extensionTransport("/api/queue/x/decision", {
      method: "POST",
      body: "{}",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.code).toBe("OPENMEM_OUTCOME_UNKNOWN");
    expect(error.message).toContain("可能已提交");
  });

  it.each(ambiguousHostCodes)("treats host error %s while polling an accepted job as unknown", async (code) => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      parent: { postMessage: () => undefined },
      setTimeout,
    });
    vi.spyOn(transport.host, "serviceRequest")
      .mockResolvedValueOnce({ status: 202, body: JSON.stringify({ job: "job_synthetic" }) })
      .mockRejectedValueOnce(new HostRequestError(code, "polling failed"));
    const outcome = transport.extensionTransport("/api/queue/batch", {
      method: "POST",
      body: "{}",
    }).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(350);
    const error = await outcome;
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.code).toBe("OPENMEM_OUTCOME_UNKNOWN");
    expect(error.message).toContain("可能已提交");
  });

  it("treats an expired background-job record as an unknown write outcome", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      parent: { postMessage: () => undefined },
      setTimeout,
    });
    vi.spyOn(transport.host, "serviceRequest")
      .mockResolvedValueOnce({ status: 202, body: JSON.stringify({ job: "job_synthetic" }) })
      .mockResolvedValueOnce({ status: 404, body: JSON.stringify({ error: "missing job" }) });
    const outcome = transport.extensionTransport("/api/queue/batch", {
      method: "POST",
      body: "{}",
    }).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(350);
    const error = await outcome;
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.code).toBe("OPENMEM_OUTCOME_UNKNOWN");
    expect(error.message).toContain("可能已提交");
  });

  it("treats an upstream 504 on a write as potentially committed", async () => {
    vi.spyOn(transport.host, "serviceRequest").mockResolvedValueOnce({
      status: 504,
      body: JSON.stringify({ code: "OPENMEM_TIMEOUT", error: "上游超时" }),
    });
    const error = await transport.extensionTransport("/api/queue/x/decision", {
      method: "POST",
      body: "{}",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.code).toBe("OPENMEM_OUTCOME_UNKNOWN");
    expect(error.message).toContain("可能已提交");
  });

  it("does not treat an unwrapped offline error as proof a write was not submitted", async () => {
    vi.spyOn(transport.host, "serviceRequest").mockResolvedValueOnce({
      status: 503,
      body: JSON.stringify({ code: "OPENMEM_OFFLINE", error: "本地服务未运行" }),
    });
    const error = await transport.extensionTransport("/api/queue/x/decision", {
      method: "POST",
      body: "{}",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.code).toBe("OPENMEM_OUTCOME_UNKNOWN");
    expect(error.message).toContain("可能已提交");
  });

  it("distinguishes a background job explicitly recorded as not submitted", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      parent: { postMessage: () => undefined },
      setTimeout,
    });
    vi.spyOn(transport.host, "serviceRequest")
      .mockResolvedValueOnce({ status: 202, body: JSON.stringify({ job: "job_synthetic" }) })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          state: "error",
          status: 503,
          code: "OPENMEM_OFFLINE",
          outcome: "not-submitted",
          error: "本地服务未运行",
        }),
      });
    const outcome = transport.extensionTransport("/api/queue/batch", {
      method: "POST",
      body: "{}",
    }).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(350);
    const error = await outcome;
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.code).toBe("OPENMEM_OFFLINE");
    expect(error.message).not.toContain("可能已提交");
  });

  it("keeps a disconnected standalone read as a connection error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("disconnected"); }));
    const error = await api("/api/queue").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.status).toBe(0);
    expect(error.code).not.toBe("OPENMEM_OUTCOME_UNKNOWN");
  });

  it("does not advise blindly retrying a write of unknown outcome", () => {
    const hint = connectionHint(new ApiError(504, "unknown", "OPENMEM_OUTCOME_UNKNOWN"));
    expect(hint).toContain("核对");
  });

  it("warns that a disconnected standalone write may have committed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("disconnected"); }));
    const error = await api("/api/queue/x/decision", { method: "POST", body: "{}" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.code).toBe("OPENMEM_OUTCOME_UNKNOWN");
    expect(error.message).toContain("可能已提交");
  });
});
