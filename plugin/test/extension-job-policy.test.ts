import { describe, expect, it } from "vitest";
import {
  classifyDeliveredStatus,
  classifyJobFailure,
  isJobExpired,
  planJobStart,
  type JobPolicyLimits,
  type PolicyJob,
} from "../../extension/src/service/job-policy.js";

const NOW = 10_000_000;

const LIMITS: JobPolicyLimits = {
  terminalTtlMs: 300_000,
  maxJobs: 3,
};

function job(overrides: Partial<PolicyJob> = {}): PolicyJob {
  return {
    key: "POST /api/queue/batch 0123456789abcdef",
    state: "done",
    createdAt: NOW,
    ...overrides,
  };
}

describe("classifyJobFailure", () => {
  it("marks only provably undelivered failures as not-submitted", () => {
    expect(classifyJobFailure("OPENMEM_NO_TOKEN")).toBe("not-submitted");
    expect(classifyJobFailure("OPENMEM_OFFLINE")).toBe("not-submitted");
  });

  it("treats timeouts, interrupted streams and unknown errors as unknown", () => {
    const unknownCodes = [
      "OPENMEM_TIMEOUT",
      "OPENMEM_UPSTREAM",
      "OPENMEM_RESPONSE_TOO_LARGE",
      "OPENMEM_SERVICE",
      "HTTP_500",
      "",
    ];
    for (const code of unknownCodes) {
      expect(classifyJobFailure(code)).toBe("unknown");
    }
    expect(classifyJobFailure(undefined)).toBe("unknown");
  });
});

describe("classifyDeliveredStatus", () => {
  it("treats an upstream 5xx response as an unknown delivered outcome", () => {
    expect(classifyDeliveredStatus(500)).toBe("unknown");
    expect(classifyDeliveredStatus(503)).toBe("unknown");
  });

  it("leaves a normal delivered response without an unknown outcome", () => {
    expect(classifyDeliveredStatus(200)).toBeUndefined();
    expect(classifyDeliveredStatus(409)).toBeUndefined();
  });
});

describe("planJobStart", () => {
  it("reuses a pending job instead of starting a duplicate write", () => {
    const pending = job({ state: "pending", createdAt: NOW - 10_000 });
    const plan = planJobStart(new Map([["job_pending", pending]]), pending.key, NOW, LIMITS);
    expect(plan).toEqual({ action: "reuse", job: pending });
  });

  it("reuses a pending job that has run far longer than the old time bound", () => {
    const pending = job({ state: "pending", createdAt: NOW - 20 * 60_000 });
    const plan = planJobStart(new Map([["job_pending", pending]]), pending.key, NOW, LIMITS);
    expect(plan).toEqual({ action: "reuse", job: pending });
  });

  it("starts a new job when the user retries a provably unsent failure", () => {
    const failed = job({ state: "error", outcome: "not-submitted" });
    const plan = planJobStart(new Map([["job_failed", failed]]), failed.key, NOW, LIMITS);
    expect(plan).toEqual({ action: "start" });
  });

  it("returns the original unknown job instead of silently replaying it", () => {
    const unknown = job({
      state: "error",
      outcome: "unknown",
      createdAt: NOW - 200_000,
    });
    const plan = planJobStart(new Map([["job_unknown", unknown]]), unknown.key, NOW, LIMITS);
    expect(plan).toEqual({ action: "reuse", job: unknown });
  });

  it("allows a new job only after the bounded unknown cache expires", () => {
    const expired = job({
      state: "error",
      outcome: "unknown",
      createdAt: NOW - 20 * 60_000,
      settledAt: NOW - LIMITS.terminalTtlMs - 1,
    });
    const plan = planJobStart(new Map([["job_unknown", expired]]), expired.key, NOW, LIMITS);
    expect(plan).toEqual({ action: "start" });
  });

  it("protects a long-running result for its full TTL after settlement", () => {
    const longRunning = job({
      state: "error",
      outcome: "unknown",
      createdAt: NOW - 20 * 60_000,
      settledAt: NOW - 60_000,
    });
    const plan = planJobStart(
      new Map([["job_unknown", longRunning]]),
      longRunning.key,
      NOW,
      LIMITS,
    );
    expect(plan).toEqual({ action: "reuse", job: longRunning });
  });

  it("reuses a successful write beyond the old 60-second window", () => {
    const done = job({
      state: "done",
      createdAt: NOW - 20 * 60_000,
      settledAt: NOW - 120_000,
    });
    const plan = planJobStart(new Map([["job_done", done]]), done.key, NOW, LIMITS);
    expect(plan).toEqual({ action: "reuse", job: done });
  });

  it("keeps a normal delivered result protected until the TTL boundary", () => {
    const done = job({
      state: "done",
      createdAt: NOW - 20 * 60_000,
      settledAt: NOW - LIMITS.terminalTtlMs + 1,
    });
    const plan = planJobStart(new Map([["job_done", done]]), done.key, NOW, LIMITS);
    expect(plan).toEqual({ action: "reuse", job: done });
  });

  it("allows a new job only after the protection window ends", () => {
    const done = job({
      state: "done",
      createdAt: NOW - 20 * 60_000,
      settledAt: NOW - LIMITS.terminalTtlMs - 1,
    });
    const plan = planJobStart(new Map([["job_done", done]]), done.key, NOW, LIMITS);
    expect(plan).toEqual({ action: "start" });
  });

  it("keeps a delivered 5xx result reusable until the cache bound", () => {
    const failed = job({
      state: "done",
      outcome: "unknown",
      createdAt: NOW - 20 * 60_000,
      settledAt: NOW - 1_000,
    });
    const plan = planJobStart(new Map([["job_done", failed]]), failed.key, NOW, LIMITS);
    expect(plan).toEqual({ action: "reuse", job: failed });
  });

  it("rejects a different request when all protected records fill the cache", () => {
    const full = new Map<string, PolicyJob>([
      ["pending", job({ key: "key-pending", state: "pending", createdAt: NOW - 8 * 60_000 })],
      [
        "unknown",
        job({ key: "key-unknown", state: "error", outcome: "unknown", createdAt: NOW - 2_000 }),
      ],
      [
        "done",
        job({ key: "key-done", state: "done", createdAt: NOW - 3_000, settledAt: NOW - 1_000 }),
      ],
    ]);
    const plan = planJobStart(full, "POST /api/retention/apply fedcba9876543210", NOW, LIMITS);
    expect(plan).toEqual({ action: "reject" });
  });

  it("evicts reusable failures by settlement time, not creation time", () => {
    const settledEarlier = job({
      key: "key-settled-earlier",
      state: "error",
      outcome: "not-submitted",
      createdAt: NOW - 10_000,
      settledAt: NOW - 200_000,
    });
    const createdEarlier = job({
      key: "key-created-earlier",
      state: "error",
      outcome: "not-submitted",
      createdAt: NOW - 200_000,
      settledAt: NOW - 10_000,
    });
    const plan = planJobStart(
      new Map([
        ["settled-earlier", settledEarlier],
        ["created-earlier", createdEarlier],
      ]),
      "POST /api/retention/apply fedcba9876543210",
      NOW,
      { ...LIMITS, maxJobs: 2 },
    );
    expect(plan).toEqual({ action: "evict", id: "settled-earlier", job: settledEarlier });
  });

  it("evicts a not-submitted failure instead of rejecting a retry", () => {
    const failed = job({ key: "key-failed", state: "error", outcome: "not-submitted" });
    const plan = planJobStart(
      new Map([["failed", failed]]),
      "POST /api/retention/apply fedcba9876543210",
      NOW,
      { ...LIMITS, maxJobs: 1 },
    );
    expect(plan).toEqual({ action: "evict", id: "failed", job: failed });
  });

  it("prefers the newest reusable record for the same request", () => {
    const older = job({ state: "error", outcome: "unknown", createdAt: NOW - 120_000 });
    const newer = job({ state: "done", createdAt: NOW - 10_000 });
    const plan = planJobStart(
      new Map([
        ["older", older],
        ["newer", newer],
      ]),
      newer.key,
      NOW,
      LIMITS,
    );
    expect(plan).toEqual({ action: "reuse", job: newer });
  });

  it("starts a new job after a settled record exceeds its TTL", () => {
    const entries = new Map<string, PolicyJob>([
      [
        "unknown",
        job({
          key: "key-unknown",
          state: "error",
          outcome: "unknown",
          createdAt: NOW - 20 * 60_000,
          settledAt: NOW - LIMITS.terminalTtlMs - 1,
        }),
      ],
    ]);
    const plan = planJobStart(entries, "POST /api/retention/apply fedcba9876543210", NOW, {
      ...LIMITS,
      maxJobs: 1,
    });
    expect(plan).toEqual({ action: "start" });
  });
});

describe("isJobExpired", () => {
  it("never expires a pending job by elapsed time", () => {
    const pending = job({ state: "pending", createdAt: NOW - 60 * 60_000 });
    expect(isJobExpired(pending, NOW, LIMITS)).toBe(false);
    expect(isJobExpired(pending, NOW + 60 * 60_000, LIMITS)).toBe(false);
  });

  it("expires a settled job from its settlement time", () => {
    const done = job({
      state: "done",
      createdAt: NOW - 20 * 60_000,
      settledAt: NOW - LIMITS.terminalTtlMs,
    });
    expect(isJobExpired(done, NOW, LIMITS)).toBe(false);
    expect(isJobExpired(done, NOW + 1, LIMITS)).toBe(true);
  });
});
