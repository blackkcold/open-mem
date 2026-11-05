import crypto from "node:crypto";
import type {
  AutoMemConfig,
  DecisionProvider,
  DecisionResult,
  HookRecord,
  HookStatus,
  Item,
  QueueItem,
  Scope,
  SessionMessage,
  ShadowRecord,
  SourceRef,
} from "./types.js";
import { Store, newId } from "./store.js";
import { autoThreshold } from "./config.js";
import { compact, lintText } from "./linter.js";
import { computePriority } from "./priority.js";
import {
  collectNeighbors,
  entriesFor,
  normalizeForFingerprint,
  type FingerprintEntry,
} from "./fingerprint.js";
import { admitAutoWrite, admitQueueItem } from "./capacity.js";
import { rebuildAutoFiles } from "./rebuild.js";
import { isKeepAliveText, isUserAuthored } from "./session/filters.js";
import { reviewDecision } from "./review/decision.js";
import { classifyScope } from "./memory/scope.js";
import { redactText } from "./redact.js";

export interface ConsolidationDeps {
  store: Store;
  decision: DecisionProvider;
  config: AutoMemConfig;
  readMessages: (sessionID: string) => Promise<SessionMessage[]>;
  project?: string;
  projectKey?: string;
  broadcast?: (event: string, data: unknown) => void;
  onQueueItem?: (
    item: QueueItem,
    decision: DecisionResult,
    target?: Item,
  ) => void | Promise<void>;
}

export interface ConsolidationResult {
  processed: number;
  captured: number;
  auto: number;
  queued: number;
  shadowed: number;
  skipped: number;
}

interface Candidate {
  text: string;
  title: string;
  trigger: string;
  source: SourceRef;
}

const CANDIDATE_RE =
  /(?:以后|每次|必须|不要|禁止|只能|优先|一律|永远|记得|记住|我喜欢|我习惯|我偏好|决定|采用|就用|文档没写|端口|路径|命令|实际上|做成|保存为|skill|workflow|流程|步骤|turns out|the command is|the path is|the port is|prefer|i like|i use|always|never|must|should|use|avoid|keep|stop)/i;

interface PreparedHook {
  hook: HookRecord;
  neighbors: ReturnType<typeof collectNeighbors>;
  reservationKey: string;
  reservationToken: string;
  index: number;
}

function sameScopeAndProject(
  entry: { scope: Scope; projectKey?: string },
  hook: HookRecord,
): boolean {
  return entry.scope === hook.scope &&
    (hook.scope !== "project" ||
      (hook.projectKey !== undefined && entry.projectKey === hook.projectKey));
}

export async function runConsolidation(
  sessionID: string,
  deps: ConsolidationDeps,
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    processed: 0,
    captured: 0,
    auto: 0,
    queued: 0,
    shadowed: 0,
    skipped: 0,
  };
  const messages = await deps.readMessages(sessionID);
  const previous = await deps.store.readSession(sessionID);
  const lastID = messages[messages.length - 1]?.id;
  const users = messages.filter(isUserAuthored);
  const lastScanned = previous?.lastScannedMessageID ?? previous?.lastMessageID;
  let start = 0;
  if (lastScanned) {
    const index = users.findIndex((message) => message.id === lastScanned);
    start = index >= 0 ? index + 1 : Math.max(0, users.length - 20);
  }
  const newUsers = users.slice(start);
  const turnID =
    newUsers[0]?.id ?? previous?.lastTurnID ?? lastID ?? newId("turn");

  if (messages.length > 0) {
    result.captured = await captureHooks(deps, sessionID, newUsers, turnID);
    if (result.captured > 0) {
      deps.broadcast?.("hooks.updated", {
        sessionID,
        turnID,
        captured: result.captured,
      });
    }
  }

  // Pending hooks must drain even when the host returns no transcript: a review
  // can queue hooks moments before the session context becomes unavailable.
  const pending = await loadPendingHooks(
    deps.store,
    sessionID,
    Math.max(1, deps.config.turn?.maxCandidates ?? 12),
  );

  if (pending.length === 0) {
    if (messages.length > 0) {
      await deps.store.updateSession(sessionID, {
        lastMessageID: lastID ?? previous?.lastMessageID,
        lastScannedMessageID: users.at(-1)?.id ?? previous?.lastScannedMessageID,
        lastTurnID: newUsers[0]?.id ?? previous?.lastTurnID,
        lastRunAt: new Date().toISOString(),
      });
    }
    return result;
  }

  const [itemsNow, queueNow, shadowNow] = await Promise.all([
    deps.store.listItems(),
    deps.store.listQueue(),
    deps.store.listShadow(),
  ]);
  let items = itemsNow;
  let queue = queueNow;
  let shadow = shadowNow;
  const seenTexts = new Set<string>();
  const prepared: PreparedHook[] = [];

  const saveHook = async (
    hook: HookRecord,
    status: HookStatus,
    patch: Partial<HookRecord> = {},
  ): Promise<void> => {
    hook.status = status;
    hook.updatedAt = new Date().toISOString();
    hook.error = undefined;
    Object.assign(hook, patch);
    await deps.store.upsertHook(hook);
  };

  for (const hook of pending) {
    const redacted = redactText(hook.text, { paths: false });
    if (redacted.hits > 0) {
      hook.text = redacted.text;
      hook.title = compact(redacted.text).slice(0, 30);
      await saveHook(hook, "ignored", { error: "敏感信息已拦截，不会发送给模型" });
      result.skipped += 1;
      continue;
    }
    hook.status = "processing";
    hook.attempts = (hook.attempts ?? 0) + 1;
    hook.updatedAt = new Date().toISOString();
    await deps.store.upsertHook(hook);
    const normalized = normalizeForFingerprint(hook.text);
    if (seenTexts.has(normalized)) {
      await saveHook(hook, "ignored", { error: "duplicate candidate in turn" });
      result.skipped += 1;
      continue;
    }
    seenTexts.add(normalized);

    const belongsToHook = (entry: { scope: Scope; projectKey?: string }): boolean => sameScopeAndProject(entry, hook);
    const entries = entriesFor(items.filter(belongsToHook), queue.filter(belongsToHook), shadow.filter(belongsToHook));
    const neighbors = collectNeighbors(hook.text, entries, 3);
    const exact = neighbors.find(
      (entry) => entry.similarity >= 0.92 && entry.scope === hook.scope,
    );
    if (exact) {
      await saveHook(hook, "ignored", {
        error: `already known: ${exact.title}`,
      });
      result.skipped += 1;
      continue;
    }

    const reservationKey = crypto
      .createHash("sha256")
      .update(`${sessionID}|${hook.messageID}|${normalized}`)
      .digest("hex");
    const reservationToken = await deps.store.claim(reservationKey, 10 * 60 * 1000);
    if (!reservationToken) {
      await saveHook(hook, "pending", { attempts: Math.max(0, hook.attempts - 1), error: "in-flight reservation; retry later" });
      result.skipped += 1;
      continue;
    }
    prepared.push({ hook, neighbors, reservationKey, reservationToken, index: prepared.length });
  }

  result.processed = prepared.length;

  const parallel = Math.max(
    1,
    Math.min(4, deps.config.turn?.parallel ?? 3),
  );
  const outcomes = await mapPool(prepared, parallel, async (entry) => {
    try {
      const decision =
        entry.hook.decision && entry.hook.error?.startsWith("capacity:")
          ? entry.hook.decision
          : entry.hook.origin === "session-review"
          ? reviewDecision(entry.hook)
          : await deps.decision.classify({
              candidate: entry.hook.text,
              title: entry.hook.title,
              existingTitles: entriesFor(items, queue, shadow).filter((item) => item.scope === entry.hook.scope &&
                (item.scope !== "project" || entry.hook.projectKey !== undefined && item.projectKey === entry.hook.projectKey)).map((item) => item.title).slice(-60),
              neighbors: entry.neighbors,
              scope: entry.hook.scope,
              project: entry.hook.project ?? deps.project,
            });
      return { entry, decision };
    } catch (error: unknown) {
      return { entry, error: safeError(error) };
    }
  });

  let autoWritten = false;
  for (const outcome of outcomes) {
    const hook = outcome.entry.hook;
    try {
    const belongsToHook = (entry: { scope: Scope; projectKey?: string }): boolean => sameScopeAndProject(entry, hook);
    if (outcome.error || !outcome.decision) {
      await saveHook(hook, "failed", {
        error: outcome.error ?? "decision provider failed",
      });
      result.skipped += 1;
      continue;
    }

    const base = outcome.decision;
    if (base.kind === "ignore") {
      await saveHook(hook, "ignored", {
        decision: base,
        error: "decision: ignore",
      });
      result.skipped += 1;
      continue;
    }

    // System One already decided this is a duplicate. Honor the verdict
    // instead of asking the user to reject it later; resolve the target from
    // items, queued candidates, or the nearest neighbor when the model did not
    // return one.
    if (base.mergeAction === "reject_duplicate") {
      const target =
        (base.mergeTargetId
          ? [...items, ...queue].find((entry) => entry.id === base.mergeTargetId && belongsToHook(entry))
          : undefined) ??
        outcome.entry.neighbors.find((entry) => entry.similarity >= 0.92);
      if (target) {
        await saveHook(hook, "ignored", {
          decision: base,
          error: `duplicate of ${target.title}`,
        });
        result.skipped += 1;
        continue;
      }
    }

    const kind = base.kind as Item["kind"];
    const title = makeTitle(kind, hook.text);
    const lint = lintText({
      title,
      text: hook.text,
      kind,
      scope: hook.scope,
      maxChars:
        kind === "rule"
          ? deps.config.thresholds.ruleMaxChars
          : deps.config.thresholds.memoryMaxChars,
      titleMaxChars: deps.config.thresholds.titleMaxChars,
    });
    const { priority: basePriority, breakdown } = computePriority(
      base,
      new Date().toISOString(),
      hook.scope,
    );
    // Review candidates carry no risk score by construction; without a floor
    // they would sort below every turn candidate and never be looked at.
    const priority =
      hook.origin === "session-review" ? Math.max(basePriority, 55) : basePriority;
    const wouldWriteTo = kind === "rule" ? "AUTO_RULES.md" : "AUTO_MEMORY.md";
    const autoCounts = {
      memory: items.filter(
        (item) => item.status === "auto" && item.kind !== "rule",
      ).length,
      rules: items.filter(
        (item) => item.status === "auto" && item.kind === "rule",
      ).length,
    };
    const autoAllowed = canAutoApply({
      config: deps.config,
      kind,
      lintOk: lint.ok,
      jev: base,
      scope: hook.scope,
      autoCounts,
      origin: hook.origin,
    });
    let admission = autoAllowed
      ? await admitAutoWrite(deps.store, deps.config, kind)
      : undefined;

    const makeShadow = (wouldRoute: "auto" | "queue"): ShadowRecord => ({
      id: newId("shadow"),
      candidate: hook.text,
      title,
      kind,
      scope: hook.scope,
      project: hook.project ?? deps.project,
      projectKey: hook.projectKey,
      wouldWriteTo,
      wouldApply: wouldRoute === "auto" ? 1 : 0,
      wouldRoute,
      turnID: hook.turnID,
      hookID: hook.id,
      decision: base,
      priority,
      source: hook.source,
      createdAt: new Date().toISOString(),
    });

    if (deps.config.shadow && autoAllowed && admission?.ok) {
      const record = makeShadow("auto");
      await deps.store.appendShadow(record, deps.config.caps.shadow);
      shadow = [...shadow, record];
      await saveHook(hook, "shadow", {
        decision: base,
        shadowID: record.id,
      });
      result.shadowed += 1;
      continue;
    }

    if (
      deps.config.shadow &&
      deps.config.shadowRecordAll &&
      !autoAllowed &&
      hook.origin !== "session-review"
    ) {
      const record = makeShadow("queue");
      await deps.store.appendShadow(record, deps.config.caps.shadow);
      shadow = [...shadow, record];
      hook.shadowID = record.id;
      result.shadowed += 1;
    }

    if (!deps.config.shadow && autoAllowed && admission?.ok) {
      const now = new Date().toISOString();
      const item: Item = {
        id: newId("item"),
        title,
        text: hook.text,
        kind,
        scope: hook.scope,
        project: hook.project ?? deps.project,
        projectKey: hook.projectKey,
        status: "auto",
        source: hook.source,
        createdAt: now,
        updatedAt: now,
        decision: base,
        priority,
        priorityBreakdown: breakdown,
        seenCount: 1,
        lastSeenAt: now,
        sources: [hook.source],
      };
      const written = await deps.store.transaction(async () => {
      if (!await deps.store.ownsClaim(outcome.entry.reservationKey, outcome.entry.reservationToken)) return false;
      admission = await admitAutoWrite(deps.store, deps.config, kind);
      if (!admission.ok) return false;
      if (kind === "rule") {
        await deps.store.appendAutoRule(hook.text, {
          id: item.id,
          kind,
          scope: hook.scope,
          source: hook.source,
          decision: base.source,
        });
      } else {
        await deps.store.appendAutoMemory(hook.text, {
          id: item.id,
          kind,
          scope: hook.scope,
          source: hook.source,
          decision: base.source,
        });
      }
      await deps.store.appendItem(item);
      await deps.store.appendChangelog({
        action: "auto",
        itemID: item.id,
        target: wouldWriteTo,
        decision: base.source,
      });
      await saveHook(hook, "auto", {
        decision: base,
        itemID: item.id,
      });
      await rebuildAutoFiles(deps.store);
      return true;
      });
      if (written) {
      items = [...items, item];
      result.auto += 1;
      autoWritten = true;
      deps.broadcast?.("items.updated", item);
      continue;
      }
    }

    const queueMin = deps.config.decision.queueMin ?? 0.72;
    const queueMinRule = deps.config.decision.queueMinRule ?? 0.8;
    const queueFloor = kind === "rule" ? queueMinRule : queueMin;
    // High-risk rules still need a human look; the rule floor only suppresses
    // low-confidence, low-risk rules that otherwise flood the queue.
    const floorApplies = kind !== "rule" || base.risk < 0.6;
    if (
      hook.origin !== "session-review" &&
      floorApplies &&
      lint.ok &&
      base.safeAuto < queueFloor
    ) {
      await saveHook(hook, "ignored", {
        decision: base,
        error: `safe_auto below queueMin ${queueFloor}`,
      });
      result.skipped += 1;
      continue;
    }

    const queueAdmission = await admitQueueItem(deps.store, deps.config);
    if (!queueAdmission.ok) {
      await saveHook(hook, "blocked", {
        decision: base,
        error: `capacity: ${queueAdmission.reason}`,
        attempts: Math.max(0, hook.attempts - 1),
      });
      await deps.store.appendChangelog({ action: "capture_blocked", hookID: hook.id, reason: queueAdmission.reason });
      result.skipped += 1;
      continue;
    }

    const reason =
      hook.origin === "session-review"
        ? `会话复盘 · ${hook.reviewType ?? "fact"}`
        : queueReason({
            config: deps.config,
            kind,
            lintOk: lint.ok,
            lintErrors: lint.errors,
            jev: base,
            scope: hook.scope,
            autoCounts,
            shadow: deps.config.shadow,
            capacityReason:
              autoAllowed && admission && !admission.ok ? admission.reason : undefined,
          });
    const displayReason =
      hook.scope === "session" ? `session-only · ${reason}` : reason;
    const targetItem =
      base.mergeTargetId !== undefined
        ? items.find(
            (item) =>
              item.id === base.mergeTargetId &&
              belongsToHook(item) &&
              (item.status === "auto" || item.status === "promoted"),
          )
        : undefined;
    const queueItem: QueueItem = {
      id: newId("queue"),
      title,
      text: hook.text,
      kind,
      scope: hook.scope,
      project: hook.project ?? deps.project,
      projectKey: hook.projectKey,
      status: "queue",
      source: hook.source,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      decision: base,
      priority,
      priorityBreakdown: breakdown,
      reason: displayReason,
      diff: `+ ${hook.text}`,
      suggestedAction:
        hook.scope === "session" ? "promote" : suggestedAction(reason, base),
      seenCount: 1,
      lastSeenAt: new Date().toISOString(),
      sources: [hook.source],
      // "pending" means a model rewrite is actually in flight. It must never
      // be a placeholder for "not generated yet": the console deliberately
      // skips auto-generation for pending rows, which would strand them.
      suggestionState:
        hook.origin !== "session-review" &&
        (base.mergeAction === "merge_into" || base.mergeAction === "replace") &&
        deps.config.rewrite.enabled &&
        deps.config.rewrite.eager
          ? "pending"
          : undefined,
      turnID: hook.turnID,
      hookID: hook.id,
      origin: hook.origin,
      reviewType: hook.reviewType,
      evidence: hook.evidence,
      reviewID: hook.reviewID,
    };
    const queued = await deps.store.transaction(async () => {
    if (!await deps.store.ownsClaim(outcome.entry.reservationKey, outcome.entry.reservationToken)) return false;
    const fresh = await admitQueueItem(deps.store, deps.config);
    if (!fresh.ok) {
      await saveHook(hook, "blocked", { decision: base, error: `capacity: ${fresh.reason}`, attempts: Math.max(0, hook.attempts - 1) });
      await deps.store.appendChangelog({ action: "capture_blocked", hookID: hook.id, reason: fresh.reason });
      return false;
    }
    await deps.store.upsertQueue(queueItem);
    await deps.store.appendChangelog({
      action: "queue",
      queueID: queueItem.id,
      reason: displayReason,
      decision: base.source,
    });
    await saveHook(hook, "queue", {
      decision: base,
      queueID: queueItem.id,
    });
    return true;
    });
    if (!queued) { result.skipped += 1; continue; }
    queue = [...queue, queueItem];
    result.queued += 1;
    deps.broadcast?.("queue.updated", queueItem);
    if (deps.onQueueItem) {
      void Promise.resolve(deps.onQueueItem(queueItem, base, targetItem)).catch(
        () => undefined,
      );
    }
    } finally {
      await deps.store.releaseReservation(outcome.entry.reservationKey, outcome.entry.reservationToken);
    }
  }

  if (autoWritten) await rebuildAutoFiles(deps.store);

  await deps.store.updateSession(sessionID, {
    lastMessageID: lastID ?? previous?.lastMessageID,
    lastScannedMessageID: users.at(-1)?.id ?? previous?.lastScannedMessageID,
    lastTurnID: newUsers[0]?.id ?? previous?.lastTurnID,
    lastRunAt: new Date().toISOString(),
  });
  deps.broadcast?.("turn.updated", {
    sessionID,
    turnID,
    captured: result.captured,
    auto: result.auto,
    queue: result.queued,
    shadow: result.shadowed,
    ignored: result.skipped,
  });
  return result;
}

async function captureHooks(
  deps: ConsolidationDeps,
  sessionID: string,
  messages: SessionMessage[],
  turnID: string,
): Promise<number> {
  if (messages.length === 0) return 0;
  const existing = await deps.store.listHooks();
  const keys = new Set(existing.map((hook) => hook.key));
  const candidates = extractCandidates(messages, sessionID, {
    // Persist the full scanned window; maxCandidates bounds processing, not
    // capture. Advancing the cursor must never discard the remaining sentences.
    max: Number.POSITIVE_INFINITY,
  });
  let captured = 0;
  for (const candidate of candidates) {
    if (redactText(candidate.text, { paths: false }).hits > 0) {
      await deps.store.appendChangelog({ action: "capture_rejected", reason: "credential", sessionID, messageID: candidate.source.messageID });
      continue;
    }
    const messageID = candidate.source.messageID ?? "unknown";
    const key = hookKey(sessionID, messageID, candidate.text);
    if (keys.has(key)) continue;
    const now = new Date().toISOString();
    const hook: HookRecord = {
      id: newId("hook"),
      key,
      sessionID,
      turnID,
      messageID,
      text: candidate.text,
      title: candidate.title,
      trigger: candidate.trigger,
      scope: scopeFor(candidate.text, deps.project),
      project: deps.project,
      projectKey: deps.projectKey,
      source: candidate.source,
      createdAt: now,
      updatedAt: now,
      status: "pending",
      attempts: 0,
    };
    await deps.store.appendHook(hook);
    keys.add(key);
    captured += 1;
  }
  return captured;
}

async function loadPendingHooks(
  store: Store,
  sessionID: string,
  limit: number,
): Promise<HookRecord[]> {
  const hooks = await store.listHooks();
  const now = Date.now();
  return hooks
    .filter(
      (hook) =>
        hook.sessionID === sessionID &&
        (hook.status === "pending" || hook.status === "blocked" ||
          (hook.status === "failed" && (hook.attempts ?? 0) < 3) ||
          (hook.status === "processing" &&
            now - new Date(hook.updatedAt).getTime() > 60_000)),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, limit);
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(items.length, Math.max(1, limit)) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function hookKey(sessionID: string, messageID: string, text: string): string {
  return `${sessionID}|${messageID}|${crypto
    .createHash("sha256")
    .update(normalizeForFingerprint(text))
    .digest("hex")
    .slice(0, 16)}`;
}

function scopeFor(text: string, project?: string): Scope {
  return classifyScope(text, project);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function extractCandidates(
  messages: SessionMessage[],
  sessionID?: string,
  options: { max?: number } = {},
): Candidate[] {
  const users = messages.filter(isUserAuthored);
  const picked: Candidate[] = [];
  const seen = new Set<string>();
  const add = (message: SessionMessage, text: string) => {
    const clean = compact(text);
    if (clean.length < 8 || clean.length > 400) return;
    if (isKeepAliveText(clean)) return;
    const trigger = clean.match(CANDIDATE_RE)?.[0];
    if (!trigger) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    picked.push({
      text: clean,
      title: compact(clean).slice(0, 30),
      trigger,
      source: {
        sessionID,
        messageID: message.id,
        role: "user",
      },
    });
  };
  // Only the user's own words are authoritative. Assistant restatements would
  // duplicate a preference and let the model reinforce its own wording.
  // Every new user message is scanned; the caller limits the batch size.
  for (const message of users) {
    for (const sentence of splitSentences(textOf(message))) add(message, sentence);
  }
  return picked.slice(0, options.max ?? 4);
}

export function canAutoApply(input: {
  config: AutoMemConfig;
  kind: Item["kind"];
  lintOk: boolean;
  jev: Pick<
    DecisionResult,
    "safeAuto" | "duplicate" | "risk" | "strictness" | "kind" | "conflict" | "mergeAction"
  >;
  scope: Scope;
  autoCounts: { memory: number; rules: number };
  origin?: "turn" | "session-review";
}): boolean {
  const { config, kind, lintOk, jev, scope, autoCounts } = input;
  // Session review is a human-in-the-loop lane by design: nothing it produces
  // may be written without approval, regardless of confidence.
  if (input.origin === "session-review") return false;
  // Session-scoped memories are transcript-only. They may be promoted later,
  // but must never be auto-written into a durable item or AUTO_* view.
  if (input.scope === "session") return false;
  if (!lintOk) return false;
  if (kind === "skill") return false;
  if (kind === "rule") return false;
  if (jev.duplicate >= config.thresholds.duplicateMax) return false;
  if (jev.risk >= 0.6) return false;
  if ((jev.conflict ?? 0) > 0.5) return false;
  if (jev.mergeAction && jev.mergeAction !== "create") return false;

  const allowed = ["preference", "workflow", "format", "unknown"];
  if (!allowed.includes(jev.strictness)) return false;
  if ((kind === "fact" || kind === "reference") && jev.risk >= 0.4) return false;
  if (jev.safeAuto < autoThreshold(config, scope)) return false;
  if (!config.autoMemory) return false;
  if (autoCounts.memory >= config.caps.autoMemory) return false;
  return true;
}

export function makeTitle(kind: Item["kind"], text: string): string {
  const prefix =
    kind === "rule"
      ? "[R]"
      : kind === "preference"
        ? "[P]"
        : kind === "skill"
          ? "[S]"
          : "[F]";
  const clean = compact(text).replace(/^\[[RPFS]\]\s*/i, "");
  const body = clean.slice(0, 26).replace(/[。！？!?；;：:，,]+$/g, "");
  return `${prefix} ${body}`.slice(0, 30);
}

export async function collectExistingTitles(store: Store, projectKey?: string): Promise<string[]> {
  const [queue, items] = await Promise.all([
    store.listQueue(),
    store.listItems(),
  ]);
  return [...queue, ...items].filter((item) => item.status !== "archived" &&
    (item.scope === "global" || item.scope === "project" && projectKey !== undefined && item.projectKey === projectKey))
    .map((item) => item.title);
}

export function bullets(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function queueReason(input: {
  config: AutoMemConfig;
  kind: Item["kind"];
  lintOk: boolean;
  lintErrors: string[];
  jev: Pick<
    DecisionResult,
    "strictness" | "safeAuto" | "duplicate" | "risk" | "conflict" | "mergeAction"
  >;
  scope: Scope;
  autoCounts: { memory: number; rules: number };
  shadow: boolean;
  capacityReason?: string;
}): string {
  if (input.kind === "skill") return "skill candidate: Agent should draft, validate, and test it";
  if (!input.lintOk) return `linter: ${input.lintErrors.join("; ")}`;
  if ((input.jev.conflict ?? 0) > 0.5) return "conflict: 与已有条目相反，需人工选择";
  if (input.jev.duplicate >= input.config.thresholds.duplicateMax) {
    return `duplicate/overlap ${Math.round(input.jev.duplicate * 100)}%`;
  }
  if (input.jev.mergeAction === "merge_into" || input.jev.mergeAction === "replace") {
    return `merge suggested: ${input.jev.mergeAction}`;
  }
  if (input.jev.risk >= 0.6) return `high risk: ${input.jev.strictness}`;
  if (input.capacityReason) return `capacity: ${input.capacityReason}`;
  if (input.kind === "rule" && input.autoCounts.rules >= input.config.caps.autoRules) {
    return "AUTO_RULES capacity reached";
  }
  if (input.kind !== "rule" && input.autoCounts.memory >= input.config.caps.autoMemory) {
    return "AUTO_MEMORY capacity reached";
  }
  if (input.jev.safeAuto < autoThreshold(input.config, input.scope)) {
    return `decision safe_auto ${Math.round(input.jev.safeAuto * 100)}% < threshold`;
  }
  return "review required";
}

function suggestedAction(
  reason: string,
  jev: Pick<DecisionResult, "duplicate" | "safeAuto" | "mergeAction">,
): QueueItem["suggestedAction"] {
  if (reason.startsWith("merge suggested")) return "merge";
  if (reason.startsWith("duplicate")) return "deny";
  if (reason.startsWith("skill")) return "edit";
  if (
    reason.startsWith("high risk") ||
    reason.startsWith("linter") ||
    reason.startsWith("conflict") ||
    reason.startsWith("capacity")
  ) {
    return "edit";
  }
  return jev.safeAuto >= 0.8 ? "approve" : "defer";
}

function textOf(message: SessionMessage): string {
  if (typeof message.text === "string") return message.text;
  const parts = message.parts ?? message.content;
  if (Array.isArray(parts)) {
    return parts
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?\n]+/)
    .map((part) => compact(part))
    .filter((part) => part.length > 0);
}

export type { FingerprintEntry };
