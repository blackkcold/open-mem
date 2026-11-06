export type JobState = "pending" | "done" | "error";

/**
 * Whether a failed job is known to have never reached the upstream service.
 * Only pre-dispatch failures may be submitted again after an explicit user
 * action; every other failure may already have been accepted and applied.
 */
export type JobOutcome = "not-submitted" | "unknown";

export type JobPolicyLimits = {
  /** How long a settled job stays queryable and deduplicated, measured from `settledAt`. */
  terminalTtlMs: number;
  /** Maximum number of retained job records. */
  maxJobs: number;
};

export type PolicyJob = {
  key: string;
  state: JobState;
  outcome?: JobOutcome;
  createdAt: number;
  /** When the job reached done/error; expiry and dedupe are measured from here. */
  settledAt?: number;
};

export type JobStartPlan<T extends PolicyJob> =
  | { action: "reuse"; job: T }
  | { action: "evict"; id: string; job: T }
  | { action: "start" }
  | { action: "reject" };

const NOT_SUBMITTED_CODES = new Set(["OPENMEM_NO_TOKEN", "OPENMEM_OFFLINE"]);

/**
 * Only failures that happen before the upstream request is sent or accepted
 * are safe to replay. Everything else (timeout, interrupted stream, 5xx,
 * unknown) stays "unknown" so a repeat request is never submitted silently.
 */
export function classifyJobFailure(code: string | undefined): JobOutcome {
  return code && NOT_SUBMITTED_CODES.has(code) ? "not-submitted" : "unknown";
}

/**
 * A 5xx response reached the upstream, so its write may already have been
 * applied even though the response looks like a failure.
 */
export function classifyDeliveredStatus(status: number): JobOutcome | undefined {
  return status >= 500 ? "unknown" : undefined;
}

function settledTime(job: PolicyJob): number {
  return job.settledAt ?? job.createdAt;
}

export function isJobExpired(
  job: PolicyJob,
  now: number,
  limits: JobPolicyLimits,
): boolean {
  // A pending job has not produced a result yet. `http.request` timeout is an
  // inactivity timeout, so a slow stream can outlive any fixed duration; only
  // an actual done/error transition may end the protected window.
  if (job.state === "pending") return false;
  return now - settledTime(job) > limits.terminalTtlMs;
}

function isJobProtectedFromEviction(job: PolicyJob): boolean {
  // Every job route in this service persists a write. A completed result may
  // already have been applied, so it is protected for its full TTL just like
  // pending and unknown records. Only a failure proven never to have reached
  // the upstream may be discarded to make room.
  return job.outcome !== "not-submitted";
}

export function shouldReuseJob(
  job: PolicyJob,
  key: string,
  now: number,
  limits: JobPolicyLimits,
): boolean {
  if (job.key !== key) return false;
  if (isJobExpired(job, now, limits)) return false;
  if (job.state === "pending") return true;
  if (job.state === "done") {
    // A delivered result — including a 5xx — may already have been applied.
    // Reuse it for the whole protection window instead of starting a second
    // write after a shorter dedupe interval.
    return true;
  }
  // A provably unsent failure may be retried explicitly. An unknown failure
  // is answered with its original job until the bounded cache expires.
  return job.outcome !== "not-submitted";
}

function selectEvictableJob<T extends PolicyJob>(
  entries: ReadonlyArray<[string, T]>,
): [string, T] | undefined {
  let oldest: [string, T] | undefined;
  for (const entry of entries) {
    if (isJobProtectedFromEviction(entry[1])) continue;
    // Eviction age follows the actual result time, matching the TTL clock.
    if (!oldest || settledTime(entry[1]) < settledTime(oldest[1])) oldest = entry;
  }
  return oldest;
}

/**
 * Decides what a repeat submission for `key` should do. Settled records past
 * their TTL are treated as absent. A pending job is never treated as expired,
 * so memory stays bounded by `maxJobs`: when no proven-unsent failure can be
 * evicted, the new submission is rejected instead of discarding in-flight,
 * unknown, or completed write evidence.
 *
 * The bound covers this process only. A service restart drops the in-memory
 * records, so neither reuse nor eviction protection survives it.
 */
export function planJobStart<T extends PolicyJob>(
  entries: Iterable<[string, T]>,
  key: string,
  now: number,
  limits: JobPolicyLimits,
): JobStartPlan<T> {
  const live: Array<[string, T]> = [];
  for (const entry of entries) {
    if (!isJobExpired(entry[1], now, limits)) live.push(entry);
  }

  let reusable: T | undefined;
  for (const [, job] of live) {
    if (!shouldReuseJob(job, key, now, limits)) continue;
    if (!reusable || job.createdAt > reusable.createdAt) reusable = job;
  }
  if (reusable) return { action: "reuse", job: reusable };

  if (live.length < limits.maxJobs) return { action: "start" };

  const evictable = selectEvictableJob(live);
  if (evictable) {
    return { action: "evict", id: evictable[0], job: evictable[1] };
  }
  return { action: "reject" };
}
