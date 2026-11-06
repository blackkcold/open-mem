import type {
  AutoMemConfig,
  ReviewCandidate,
  ReviewRecord,
  ReviewRunResult,
  ReviewSessionNote,
  SessionMessage,
  SessionState,
} from "../types.js";
import type { Store } from "../store.js";
import type { SessionReader } from "../session/reader.js";
import { newId } from "../store.js";
import { toolParts } from "../digest/tool.js";
import { isUserAuthored } from "../session/filters.js";
import { sha16 } from "../util/text.js";
import type { ReviewInput } from "./input.js";

export interface ReviewOrchestratorDeps {
  store: Store;
  config: AutoMemConfig;
  reader: SessionReader;
  buildInput: (
    sessionID: string,
    messages: SessionMessage[],
    from?: string,
    knownTitles?: string[],
  ) => ReviewInput;
  /** Existing queue/memory titles used only as a prompt hint. */
  knownTitles?: () => Promise<string[] | undefined>;
  /** Stable project identity for session-note promotion. */
  projectKey?: string;
  runModel: (input: ReviewInput) => Promise<ReviewRunResult>;
  /** Deterministic evidence gate; runs before anything is accepted. */
  validate?: (
    input: ReviewInput,
    candidates: ReviewCandidate[],
  ) => { accepted: ReviewCandidate[]; dropped: Array<{ reason: string }> };
  onAccepted: (
    input: ReviewInput,
    result: ReviewRunResult,
    reviewID: string,
  ) => Promise<{
    created: number;
    skipped: number;
    sessionNotes?: ReviewSessionNote[];
  } | void>;
  broadcast?: (event: string, payload: unknown) => void;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

export interface ReviewOrchestratorStats {
  scheduled: number;
  running: number;
  /** Slots consumed this hour: a conservative retry budget, not proof of token spend or HTTP requests. */
  runsLastHour: number;
  paused: boolean;
  lastRunAt?: string;
  lastError?: string;
  /** Earliest armed timer, for truthful "next review" copy. */
  nextReviewAt?: string;
}

const HOUR = 60 * 60 * 1000;
const STALE_DUE = 24 * 60 * 60 * 1000;
const CHECKPOINT_DELAY = 1500;
const CAP_RETRY_MIN = 30_000;
/**
 * Consecutive failed review runs before auto review stops for a session. Every
 * cause counts (content, transport, provider circuit, infrastructure), so the
 * bound is strict; the provider circuit breaker only throttles an unbounded
 * retry, it does not cap it.
 */
const ATTEMPT_LIMIT = 5;

/**
 * Synthesizes a session-level idle signal on top of `session.idle`, which the
 * server emits at the end of every turn. A pending review is cancelled and
 * re-armed whenever a new turn ends; state is persisted so a plugin restart can
 * resume work that was already due. New material or a successful run resets the
 * failure counter. Every failed run consumes the bounded budget, including
 * transport and provider failures, so a broken endpoint cannot be retried every
 * turn forever. A slot is returned only when the model call provably never
 * started; the hourly budget is a conservative cap, not proof of token spend or
 * HTTP request counts.
 */
export class ReviewOrchestrator {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dueAt = new Map<string, number>();
  private readonly running = new Set<string>();
  private readonly jobs = new Set<Promise<unknown>>();
  private runs: number[] = [];
  private disposed = false;
  private paused = false;
  private lastRunAt?: string;
  private lastError?: string;

  constructor(private readonly deps: ReviewOrchestratorDeps) {}

  async schedule(sessionID: string): Promise<void> {
    if (!this.active()) return;
    const state = await this.deps.store.readState();
    const session = await this.deps.store.readSession(sessionID) ?? {};
    if (session.parentSessionID) return;
    // Auto review is terminal for this session until new material can be
    // proven. Re-arming would retry a window whose identity is unknown.
    if (retryExhausted(session)) return;

    // A live review owns this session. Queue one follow-up instead of
    // starting a second review from a turn that lands mid-call.
    if (isLiveReview(session, this.now(), this.deps.config.review.timeoutMs)) {
      await this.deps.store.updateSession(sessionID, { pendingReview: true });
      return;
    }

    // One transcript read per idle: derive both material count and latest user id.
    let messages: SessionMessage[] = [];
    let lastUserID = session.reviewUserIDAtSchedule;
    let material = 0;
    let failed = false;
    try {
      messages = await this.deps.reader.delta(
        sessionID,
        session.reviewedUpToMessageID,
      );
      material = messages.filter(isMaterial).length;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (isUserAuthored(message) && message.id) {
          lastUserID = message.id;
          break;
        }
      }
    } catch {
      // Counting is an optimisation; fall back to the normal idle delay.
      failed = true;
    }
    const window = windowKey(messages);

    // Warming/keep-alive pings (assistant-only or synthetic deltas) must not
    // re-arm a review: material is the only signal that a review can add value.
    if (!failed) {
      if (material === 0) return;
      const dueAt = session.reviewDueAt
        ? Date.parse(session.reviewDueAt)
        : Number.NaN;
      const pending =
        session.reviewStatus === "scheduled" &&
        Number.isFinite(dueAt) &&
        dueAt > this.now();
      if (pending && lastUserID === session.reviewUserIDAtSchedule) return;
      // A skipped window must not be re-read forever: only new material
      // (a different tail/hash) may arm another review.
      if (
        session.reviewStatus === "skipped" &&
        session.reviewSkipToMessageID === window.id &&
        session.reviewSkipHash === window.hash
      ) {
        return;
      }
    }

    this.clear(sessionID);
    const delay =
      material >= this.deps.config.review.checkpointMessages
        ? CHECKPOINT_DELAY
        : this.deps.config.review.idleMs;
    const patch: Partial<SessionState> = {
      reviewDueAt: new Date(this.now() + delay).toISOString(),
      reviewStatus: "scheduled",
      reviewUserIDAtSchedule: lastUserID,
      reviewDeferrals: 0,
      reviewStartedAt: undefined,
      reviewSkipToMessageID: undefined,
      reviewSkipHash: undefined,
      reviewSkipAt: undefined,
    };
    await this.deps.store.updateSession(sessionID, patch);
    this.arm(sessionID, delay);
    this.deps.broadcast?.("review.scheduled", { sessionID, delay });
  }

  async recover(): Promise<void> {
    if (!this.active()) return;
    const state = await this.deps.store.readState();
    const now = this.now();
    this.runs = (state.reviewRuns ?? []).filter((at) => at >= now - HOUR);

    let index = 0;
    for (const [sessionID, session] of Object.entries(state.sessions)) {
      // A ready/skipped session with a leftover dueAt must not be re-armed.
      if (
        session.reviewStatus &&
        session.reviewStatus !== "scheduled" &&
        session.reviewStatus !== "running"
      ) {
        continue;
      }
      // A crash can leave a running record without a dueAt; always repair it.
      if (session.reviewStatus === "running") {
        await this.deps.store.updateSession(sessionID, { reviewStatus: "scheduled" });
        this.arm(sessionID, index * 50);
        index += 1;
        continue;
      }
      const due = session.reviewDueAt ? Date.parse(session.reviewDueAt) : Number.NaN;
      if (!Number.isFinite(due)) continue;
      if (now - due > STALE_DUE) {
        await this.deps.store.updateSession(sessionID, {
          reviewDueAt: undefined,
          reviewStatus: "skipped",
        });
        continue;
      }
      if (due > now) {
        this.arm(sessionID, due - now);
        index += 1;
        continue;
      }
      this.arm(sessionID, index * 50);
      index += 1;
    }
  }

  pause(): void {
    this.paused = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    // Nothing is armed while paused, so no "next review" may be advertised.
    this.dueAt.clear();
  }

  resume(): void {
    this.paused = false;
    void this.recover();
  }

  /**
   * Runs a review now. Returns the record for a model run, or undefined when
   * the session was skipped (no material, unchanged input, hourly cap).
   */
  async runNow(
    sessionID: string,
    reason: "auto" | "manual" = "auto",
  ): Promise<ReviewRecord | undefined> {
    // The host can load several plugin instances for one data dir (workspaces,
    // hot reload). Serialize reviews across them so one window costs one call.
    return this.track(this.withProcessLock(() => this.runNowUnlocked(sessionID, reason)));
  }

  private track<T>(job: Promise<T>): Promise<T> {
    this.jobs.add(job);
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job));
    return job;
  }

  private async withProcessLock<T>(fn: () => Promise<T>): Promise<T> {
    const key = `__openMemReviewChain:${this.deps.store.dataDir}`;
    const holder = globalThis as Record<string, unknown>;
    const previous = (holder[key] as Promise<void> | undefined) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    holder[key] = previous.then(() => gate);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async runNowUnlocked(
    sessionID: string,
    reason: "auto" | "manual",
  ): Promise<ReviewRecord | undefined> {
    if (!this.active()) return undefined;
    if (this.running.has(sessionID)) {
      await this.deps.store.updateSession(sessionID, { pendingReview: true });
      return undefined;
    }

    const lease = `review-run:${sessionID}`;
    const leaseToken = await this.deps.store.claim(lease, Math.max(60_000, this.deps.config.review.timeoutMs * 5));
    if (!leaseToken) return undefined;

    this.running.add(sessionID);
    this.clear(sessionID);
    const startedAt = this.now();
    const reviewID = newId("review");
    let record: ReviewRecord | undefined;
    let slotAt: number | undefined;
    let attemptedHash: string | undefined;
    let modelStarted = false;

    try {
      const state = await this.deps.store.readState();
      const session: SessionState = await this.deps.store.readSession(sessionID) ?? {};

      // A live review owns this session. A sibling instance must not start a
      // second paid call for the same window.
      if (isLiveReview(session, this.now(), this.deps.config.review.timeoutMs)) {
        return undefined;
      }

      // Subagent sessions are not user memory sources.
      if (session.parentSessionID) {
        await this.deps.store.updateSession(sessionID, {
          reviewStatus: "skipped",
          reviewDueAt: undefined,
        });
        return undefined;
      }
      // The retry budget is spent and the failed window cannot be named.
      // Reading again could neither prove new material nor end the loop.
      if (reason === "auto" && retryExhausted(session)) {
        await this.deps.store.updateSession(sessionID, {
          reviewStatus: "failed",
          reviewDueAt: undefined,
        });
        return undefined;
      }
      const from = session.reviewedUpToMessageID;
      const messages = await this.deps.reader.delta(sessionID, from);
      const window = windowKey(messages);
      if (messages.length === 0) {
        await this.finishSkip(sessionID, "no new messages", reason === "auto", window);
        return undefined;
      }

      const knownTitles = this.deps.knownTitles
        ? await this.deps.knownTitles().catch(() => undefined)
        : undefined;
      const input = this.deps.buildInput(sessionID, messages, from, knownTitles);
      attemptedHash = input.hash;
      const minUsers = Math.max(1, this.deps.config.review.minNewUserMessages);
      if (
        reason === "auto" &&
        input.userCount < minUsers &&
        input.toolCount < 3
      ) {
        await this.finishSkip(sessionID, "not enough new material", true, window);
        return undefined;
      }
      if (input.userCount === 0 && input.toolCount === 0) {
        await this.finishSkip(
          sessionID,
          "empty review window",
          reason === "auto",
          window,
        );
        return undefined;
      }
      if (session.reviewedHash === input.hash) {
        await this.finishSkip(
          sessionID,
          "transcript unchanged",
          reason === "manual",
          window,
        );
        return undefined;
      }

      // Consecutive failures stop auto review for this exact window; genuinely
      // new material gets a fresh budget. An unknown window is not new material:
      // never reset the budget on a hash we cannot compare.
      if (reason === "auto" && (session.reviewAttempts ?? 0) >= ATTEMPT_LIMIT) {
        if (
          session.reviewAttemptedHash === undefined ||
          session.reviewAttemptedHash === input.hash
        ) {
          await this.deps.store.updateSession(sessionID, {
            reviewStatus: "failed",
            reviewDueAt: undefined,
          });
          return undefined;
        }
        await this.deps.store.updateSession(sessionID, {
          reviewAttempts: 0,
          reviewAttemptedHash: undefined,
        });
      }

      slotAt = await this.takeSlot();
      if (slotAt === undefined) {
        // Do not lose the window: retry when the oldest call leaves the hour.
        const oldest = this.runs[0] ?? this.now();
        const delay = Math.max(CAP_RETRY_MIN, oldest + HOUR - this.now() + 1000);
        await this.deps.store.updateSession(sessionID, {
          reviewStatus: "scheduled",
          reviewDueAt: new Date(this.now() + delay).toISOString(),
        });
        this.arm(sessionID, delay);
        this.deps.broadcast?.("review.skipped", { sessionID, reason: "hourly-cap" });
        return undefined;
      }

      await this.deps.store.updateSession(sessionID, {
        reviewStatus: "running",
        reviewStartedAt: new Date(this.now()).toISOString(),
      });
      modelStarted = true;
      const result = await this.deps.runModel(input);
      if (this.paused) {
        // The call already happened; keep its slot until the hour expires.
        await this.deps.store.updateSession(sessionID, {
          reviewStatus: "scheduled",
          reviewDueAt: new Date(
            this.now() + this.deps.config.review.idleMs,
          ).toISOString(),
          reviewStartedAt: undefined,
        });
        return undefined;
      }
      if (this.disposed) {
        // The call already happened; the slot expires with the rolling hour.
        return undefined;
      }
      if (!await this.deps.store.ownsClaim(lease, leaseToken)) return undefined;
      const validated = this.deps.validate
        ? this.deps.validate(input, result.candidates)
        : { accepted: result.candidates, dropped: [] };
      const candidates = validated.accepted.slice(0, this.deps.config.review.maxCandidates);
      const accepted = await this.deps.onAccepted(
        input,
        { ...result, candidates },
        reviewID,
      );
      const queued =
        accepted && typeof accepted.created === "number"
          ? accepted.created
          : candidates.length;

      const durationMs = this.now() - startedAt;
      record = {
        id: reviewID,
        sessionID,
        ...(this.deps.projectKey ? { projectKey: this.deps.projectKey } : {}),
        status: "ready",
        createdAt: new Date().toISOString(),
        fromMessageID: from,
        toMessageID: input.toMessageID,
        inputHash: input.hash,
        chars: input.chars,
        candidates: candidates.length,
        queued,
        dropped:
          validated.dropped.length +
          Math.max(0, validated.accepted.length - candidates.length),
        durationMs,
        model: result.model,
        ...(result.usage ? { usage: result.usage } : {}),
        summary: result.summary,
        openQuestions: result.openQuestions,
        ...(accepted?.sessionNotes?.length
          ? { sessionNotes: accepted.sessionNotes }
          : {}),
      };
      this.lastRunAt = record.createdAt;
      this.lastError = undefined;

      await this.deps.store.appendReview(record as unknown as Record<string, unknown>);
      await this.deps.store.updateSession(sessionID, {
        reviewStatus: "ready",
        reviewDueAt: undefined,
        reviewedUpToMessageID: input.toMessageID ?? from,
        reviewedHash: input.hash,
        reviewAttempts: 0,
        reviewAttemptedHash: undefined,
        reviewDeferrals: 0,
        reviewStartedAt: undefined,
        reviewSkipToMessageID: undefined,
        reviewSkipHash: undefined,
        reviewSkipAt: undefined,
      });
      this.deps.broadcast?.("review.updated", {
        sessionID,
        reviewID,
        candidates: candidates.length,
        queued,
        summary: result.summary,
      });
      return record;
    } catch (error: unknown) {
      // Release only when the model call provably never started. Once it
      // started, delivery is unknown (timeout, network loss) and a returned
      // call already happened, so keep the slot until the rolling hour expires.
      if (slotAt !== undefined && !modelStarted) await this.releaseSlot(slotAt);
      if (this.disposed) return undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      // Transport/provider failures keep their label in the record, but every
      // failed run consumes the same strict budget. `countsAsAttempt` is not a
      // retry gate anymore: a permanent 401/circuit would otherwise retry on
      // every turn forever. A thrown null/undefined must not break this catch.
      const transportFailure = isTransportFailure(error);
      const current = await this.deps.store.readSession(sessionID) ?? {};
      // Strict upper bound: a permanently failing session cannot grow this
      // counter (and therefore its retries) without limit.
      const attempts = Math.min(
        ATTEMPT_LIMIT,
        (current.reviewAttempts ?? 0) + 1,
      );
      await this.deps.store.updateSession(sessionID, {
        reviewStatus: "failed",
        reviewDueAt: undefined,
        reviewAttempts: attempts,
        // Never overwrite a known failed window with an unknown one; the next
        // run would otherwise read "unknown" as proof of new material.
        reviewAttemptedHash: attemptedHash ?? current.reviewAttemptedHash,
        reviewStartedAt: undefined,
        reviewSkipToMessageID: undefined,
        reviewSkipHash: undefined,
        reviewSkipAt: undefined,
      });
      this.deps.broadcast?.("review.failed", {
        sessionID,
        error: message,
        attempts,
      });
      this.deps.log?.("session review failed", error);
      // No model call was attempted, so this is not a review call. Publish the
      // failure through session state instead of fabricating a usage row.
      if (!modelStarted) return undefined;
      record = {
        id: reviewID,
        sessionID,
        status: "failed",
        createdAt: new Date().toISOString(),
        candidates: 0,
        dropped: 0,
        durationMs: this.now() - startedAt,
        error: message,
        ...(transportFailure ? { note: "transport failure" } : {}),
      };
      await this.deps.store.appendReview(record as unknown as Record<string, unknown>);
      return record;
    } finally {
      await this.deps.store.releaseReservation(lease, leaseToken);
      this.running.delete(sessionID);
      if (!this.disposed) {
        const state = await this.deps.store.readState().catch(() => undefined);
        if (state?.sessions[sessionID]?.pendingReview) {
          await this.deps.store
            .updateSession(sessionID, { pendingReview: false })
            .catch(() => undefined);
          void this.schedule(sessionID);
        }
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.dueAt.clear();
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }

  stats(): ReviewOrchestratorStats {
    this.pruneRuns();
    const next = this.dueAt.size
      ? Math.min(...this.dueAt.values())
      : undefined;
    return {
      scheduled: this.timers.size,
      running: this.running.size,
      runsLastHour: this.runs.length,
      paused: this.paused,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      nextReviewAt:
        next === undefined ? undefined : new Date(next).toISOString(),
    };
  }

  private active(): boolean {
    return this.deps.config.review.enabled && !this.disposed && !this.paused;
  }

  private async finishSkip(
    sessionID: string,
    note: string,
    appendRecord: boolean,
    window?: WindowKey,
  ): Promise<void> {
    if (this.disposed) return;
    await this.deps.store.updateSession(sessionID, {
      reviewStatus: "skipped",
      reviewDueAt: undefined,
      reviewStartedAt: undefined,
      reviewSkipToMessageID: window?.id,
      reviewSkipHash: window?.hash,
      reviewSkipAt: new Date(this.now()).toISOString(),
    });
    if (!appendRecord) return;
    // Sibling instances can observe the same skipped window. Keep one card per
    // distinct reason/window instead of writing a duplicate record per timer.
    const reviews = await this.deps.store.listReviews();
    const duplicate = reviews.some(
      (entry) =>
        entry.sessionID === sessionID &&
        entry.status === "skipped" &&
        entry.note === note &&
        entry.toMessageID === window?.id,
    );
    if (duplicate) return;
    const record: ReviewRecord = {
      id: newId("review"),
      sessionID,
      status: "skipped",
      createdAt: new Date().toISOString(),
      toMessageID: window?.id,
      candidates: 0,
      dropped: 0,
      note,
    };
    await this.deps.store.appendReview(record as unknown as Record<string, unknown>);
  }

  private async takeSlot(): Promise<number | undefined> {
    const at = this.now();
    const result = await this.deps.store.takeReviewSlot(
      at,
      this.deps.config.review.maxPerHour,
      HOUR,
    );
    this.runs = result.runs;
    return result.ok ? at : undefined;
  }

  private async releaseSlot(at: number): Promise<void> {
    // Always return the persisted slot, even while shutting down; otherwise a
    // disposed instance can consume one of the hourly calls.
    const runs = await this.deps.store.releaseReviewSlot(at).catch(() => undefined);
    if (!this.disposed && runs) this.runs = runs;
  }

  private arm(sessionID: string, delay: number): void {
    if (this.disposed) return;
    this.clear(sessionID);
    this.dueAt.set(sessionID, this.now() + Math.max(0, delay));
    const timer = setTimeout(() => {
      this.dueAt.delete(sessionID);
      this.timers.delete(sessionID);
      void this.track(this.fire(sessionID)).catch((error: unknown) => this.deps.log?.("scheduled review failed", error));
    }, Math.max(0, delay));
    timer.unref?.();
    this.timers.set(sessionID, timer);
  }

  private async fire(sessionID: string): Promise<void> {
    if (!this.active()) return;
    const state = await this.deps.store.readState();
    const session = await this.deps.store.readSession(sessionID) ?? {};
    // A sibling timer may already have completed this window. Never let a
    // stale timer manufacture a skipped record or a second paid call.
    if (session.reviewStatus !== "scheduled") return;
    const dueAt = session.reviewDueAt
      ? Date.parse(session.reviewDueAt)
      : Number.NaN;
    if (Number.isFinite(dueAt) && dueAt > this.now() + 1_000) return;
    const lastUser = await this.deps.reader.lastUser(sessionID);

    if (this.running.has(sessionID)) {
      await this.deps.store.updateSession(sessionID, { pendingReview: true });
      return;
    }

    if (
      session.reviewUserIDAtSchedule !== undefined &&
      lastUser?.id !== undefined &&
      lastUser.id !== session.reviewUserIDAtSchedule
    ) {
      const deferrals = (session.reviewDeferrals ?? 0) + 1;
      if (deferrals <= this.deps.config.review.maxDeferrals) {
        const delay = this.deps.config.review.idleMs;
        await this.deps.store.updateSession(sessionID, {
          reviewDeferrals: deferrals,
          reviewUserIDAtSchedule: lastUser.id,
          reviewDueAt: new Date(this.now() + delay).toISOString(),
        });
        this.arm(sessionID, delay);
        return;
      }
    }

    await this.runNow(sessionID, "auto");
  }

  private clear(sessionID: string): void {
    const timer = this.timers.get(sessionID);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionID);
    this.dueAt.delete(sessionID);
  }

  private pruneRuns(): void {
    const cutoff = this.now() - HOUR;
    this.runs = this.runs.filter((at) => at >= cutoff);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}

interface WindowKey {
  id?: string;
  hash?: string;
}

/** Identity of the exact delta window, used to avoid re-reading a skip forever. */
function windowKey(messages: SessionMessage[]): WindowKey {
  if (messages.length === 0) return {};
  return {
    id: messages[messages.length - 1]?.id,
    hash: sha16(
      JSON.stringify(
        messages.map((message) => [
          message.id ?? "",
          message.text ?? "",
          (message.parts ?? []).length,
        ]),
      ),
    ),
  };
}

/**
 * Safe classification for unknown thrown values. Throwing `null`/`undefined`
 * is legal JavaScript, so never dereference the value directly in a catch.
 */
function isTransportFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "countsAsAttempt" in error &&
    error.countsAsAttempt === false
  );
}

/**
 * Auto review is terminal when the retry budget is spent and the failed window
 * has no identity. Re-reading cannot prove new material, and re-reading is the
 * step that keeps failing, so the conservative choice is to stop.
 */
function retryExhausted(session: SessionState): boolean {
  return (
    (session.reviewAttempts ?? 0) >= ATTEMPT_LIMIT &&
    session.reviewAttemptedHash === undefined
  );
}

/** True while another instance still owns this review call. */
function isLiveReview(
  session: SessionState,
  now: number,
  timeoutMs: number,
): boolean {
  if (session.reviewStatus !== "running") return false;
  const started = session.reviewStartedAt
    ? Date.parse(session.reviewStartedAt)
    : Number.NaN;
  if (!Number.isFinite(started)) return false;
  return now - started < Math.max(30_000, timeoutMs * 2);
}

function isMaterial(message: SessionMessage): boolean {
  if (isReviewableUser(message)) return true;
  return toolParts(message).length > 0;
}

function isReviewableUser(message: SessionMessage): boolean {
  return isUserAuthored(message) && typeof message.text === "string" && message.text.trim().length >= 8;
}
