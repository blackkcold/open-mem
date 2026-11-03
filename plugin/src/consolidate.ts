import crypto from "node:crypto";
import type {
  AutoMemConfig,
  DecisionProvider,
  DecisionResult,
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

export interface ConsolidationDeps {
  store: Store;
  decision: DecisionProvider;
  config: AutoMemConfig;
  readMessages: (sessionID: string) => Promise<SessionMessage[]>;
  project?: string;
  broadcast?: (event: string, data: unknown) => void;
  onQueueItem?: (
    item: QueueItem,
    decision: DecisionResult,
    target?: Item,
  ) => void | Promise<void>;
}

export interface ConsolidationResult {
  processed: number;
  auto: number;
  queued: number;
  shadowed: number;
  skipped: number;
}

interface Candidate {
  text: string;
  title: string;
  source: SourceRef;
}

const CANDIDATE_RE =
  /(?:以后|每次|必须|不要|禁止|只能|优先|一律|永远|记得|记住|我喜欢|我习惯|我偏好|决定|采用|就用|文档没写|端口|路径|命令|实际上|做成|保存为|skill|workflow|流程|步骤|turns out|the command is|the path is|the port is|prefer|i like|i use|always|never|must|should|use|avoid|keep|stop)/i;

export async function runConsolidation(
  sessionID: string,
  deps: ConsolidationDeps,
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    processed: 0,
    auto: 0,
    queued: 0,
    shadowed: 0,
    skipped: 0,
  };
  const messages = await deps.readMessages(sessionID);
  if (messages.length === 0) return result;

  const lastID = messages[messages.length - 1]?.id;
  const state = await deps.store.readState();
  const previous = state.sessions[sessionID];
  if (lastID && previous?.lastMessageID === lastID) return result;

  const candidates = extractCandidates(messages, sessionID);
  const knownTitles = await collectExistingTitles(deps.store);
  let autoWritten = false;

  for (const candidate of candidates) {
    result.processed += 1;
    const scope: Scope =
      deps.project && /(?:项目|仓库|repo|本地|端口|路径|命令|project)/i.test(candidate.text)
        ? "project"
        : "global";

    const [itemsNow, queueNow, shadowNow] = await Promise.all([
      deps.store.listItems(),
      deps.store.listQueue(),
      deps.store.listShadow(),
    ]);
    const entries = entriesFor(itemsNow, queueNow, shadowNow);
    const neighbors = collectNeighbors(candidate.text, entries, 3);
    const exact = neighbors.find(
      (entry) => entry.similarity >= 0.92 && entry.scope === scope,
    );

    if (exact) {
      const now = new Date().toISOString();
      if (exact.status === "auto" || exact.status === "promoted") {
        await deps.store.touchItem(exact.id, candidate.source);
        await deps.store.appendChangelog({
          action: "dedup_drop",
          itemID: exact.id,
          similarity: exact.similarity,
          text: candidate.text,
        });
        result.skipped += 1;
        continue;
      }
      if (exact.status === "queue") {
        const queued = queueNow.find((item) => item.id === exact.id);
        if (queued) {
          await deps.store.upsertQueue({
            ...queued,
            seenCount: (queued.seenCount ?? 1) + 1,
            lastSeenAt: now,
            sources: [...(queued.sources ?? [queued.source]), candidate.source].slice(-20),
          });
        }
        result.skipped += 1;
        continue;
      }
      result.skipped += 1;
      continue;
    }

    const reservationKey = crypto
      .createHash("sha256")
      .update(
        `${sessionID}|${candidate.source.messageID ?? ""}|${normalizeForFingerprint(candidate.text)}`,
      )
      .digest("hex");
    if (!(await deps.store.reserve(reservationKey, 10 * 60 * 1000))) {
      result.skipped += 1;
      continue;
    }

    const base = await deps.decision.classify({
      candidate: candidate.text,
      title: candidate.title,
      existingTitles: knownTitles,
      neighbors,
      scope,
      project: deps.project,
    });
    if (base.kind === "ignore") {
      result.skipped += 1;
      continue;
    }

    const title = makeTitle(base.kind, candidate.text);
    const maxChars =
      base.kind === "rule"
        ? deps.config.thresholds.ruleMaxChars
        : deps.config.thresholds.memoryMaxChars;
    const lint = lintText({
      title,
      text: candidate.text,
      kind: base.kind,
      scope,
      maxChars,
      titleMaxChars: deps.config.thresholds.titleMaxChars,
    });
    const { priority, breakdown } = computePriority(base, new Date().toISOString(), scope);
    const wouldWriteTo = base.kind === "rule" ? "AUTO_RULES.md" : "AUTO_MEMORY.md";
    const autoCounts = {
      memory: itemsNow.filter(
        (item) => item.status === "auto" && item.kind !== "rule",
      ).length,
      rules: itemsNow.filter(
        (item) => item.status === "auto" && item.kind === "rule",
      ).length,
    };
    const autoAllowed = canAutoApply({
      config: deps.config,
      kind: base.kind,
      lintOk: lint.ok,
      jev: base,
      scope,
      autoCounts,
    });
    const admission = autoAllowed
      ? await admitAutoWrite(deps.store, deps.config, base.kind)
      : undefined;

    if (deps.config.shadow && autoAllowed && admission?.ok) {
      const record: ShadowRecord = {
        id: newId("shadow"),
        candidate: candidate.text,
        title,
        kind: base.kind,
        scope,
        project: deps.project,
        wouldWriteTo,
        wouldApply: 1,
        decision: base,
        priority,
        source: candidate.source,
        createdAt: new Date().toISOString(),
      };
      await deps.store.appendShadow(record);
      result.shadowed += 1;
      deps.broadcast?.("shadow.updated", record);
      knownTitles.push(title);
      continue;
    }

    if (!deps.config.shadow && autoAllowed && admission?.ok) {
      const now = new Date().toISOString();
      const item: Item = {
        id: newId("item"),
        title,
        text: candidate.text,
        kind: base.kind,
        scope,
        project: deps.project,
        status: "auto",
        source: candidate.source,
        createdAt: now,
        updatedAt: now,
        decision: base,
        priority,
        priorityBreakdown: breakdown,
        seenCount: 1,
        lastSeenAt: now,
        sources: [candidate.source],
      };
      if (base.kind === "rule") {
        await deps.store.appendAutoRule(candidate.text, {
          id: item.id,
          kind: base.kind,
          scope,
          source: candidate.source,
          decision: base.source,
        });
      } else {
        await deps.store.appendAutoMemory(candidate.text, {
          id: item.id,
          kind: base.kind,
          scope,
          source: candidate.source,
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
      result.auto += 1;
      autoWritten = true;
      knownTitles.push(title);
      deps.broadcast?.("items.updated", item);
      continue;
    }

    const queueAdmission = await admitQueueItem(deps.store, deps.config);
    if (!queueAdmission.ok) {
      await deps.store.appendChangelog({
        action: "capacity_reject",
        reason: queueAdmission.reason,
        text: candidate.text,
      });
      result.skipped += 1;
      continue;
    }

    const reason = queueReason({
      config: deps.config,
      kind: base.kind,
      lintOk: lint.ok,
      lintErrors: lint.errors,
      jev: base,
      scope,
      autoCounts,
      shadow: deps.config.shadow,
      capacityReason:
        autoAllowed && admission && !admission.ok ? admission.reason : undefined,
    });
    const targetItem =
      base.mergeTargetId !== undefined
        ? itemsNow.find(
            (item) =>
              item.id === base.mergeTargetId &&
              (item.status === "auto" || item.status === "promoted"),
          )
        : undefined;
    const queueItem: QueueItem = {
      id: newId("queue"),
      title,
      text: candidate.text,
      kind: base.kind,
      scope,
      project: deps.project,
      status: "queue",
      source: candidate.source,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      decision: base,
      priority,
      priorityBreakdown: breakdown,
      reason,
      diff: `+ ${candidate.text}`,
      suggestedAction: suggestedAction(reason, base),
      seenCount: 1,
      lastSeenAt: new Date().toISOString(),
      sources: [candidate.source],
      suggestionState: "pending",
    };
    await deps.store.upsertQueue(queueItem);
    await deps.store.appendChangelog({
      action: "queue",
      queueID: queueItem.id,
      reason,
      decision: base.source,
    });
    result.queued += 1;
    knownTitles.push(title);
    deps.broadcast?.("queue.updated", queueItem);
    if (deps.onQueueItem) {
      void Promise.resolve(deps.onQueueItem(queueItem, base, targetItem)).catch(
        () => undefined,
      );
    }
  }

  if (autoWritten) await rebuildAutoFiles(deps.store);

  state.sessions[sessionID] = {
    lastMessageID: lastID,
    lastRunAt: new Date().toISOString(),
  };
  await deps.store.writeState(state);
  return result;
}

export function extractCandidates(
  messages: SessionMessage[],
  sessionID?: string,
): Candidate[] {
  const users = messages.filter(
    (message) => message.type === "user" || message.role === "user",
  );
  const picked: Candidate[] = [];
  const seen = new Set<string>();
  const add = (message: SessionMessage, text: string) => {
    const clean = compact(text);
    if (clean.length < 8 || clean.length > 400) return;
    if (!CANDIDATE_RE.test(clean)) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    picked.push({
      text: clean,
      title: compact(clean).slice(0, 30),
      source: {
        sessionID,
        messageID: message.id,
        role: "user",
      },
    });
  };
  // Only the user's own words are authoritative. Assistant restatements would
  // duplicate a preference and let the model reinforce its own wording.
  for (const message of users.slice(-2)) {
    for (const sentence of splitSentences(textOf(message))) add(message, sentence);
  }
  return picked.slice(0, 4);
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
}): boolean {
  const { config, kind, lintOk, jev, scope, autoCounts } = input;
  if (!lintOk) return false;
  if (kind === "skill") return false;
  if (jev.duplicate >= config.thresholds.duplicateMax) return false;
  if (jev.risk >= 0.6) return false;
  if ((jev.conflict ?? 0) > 0.5) return false;
  if (jev.mergeAction && jev.mergeAction !== "create") return false;

  const allowed =
    kind === "rule"
      ? ["workflow", "format"]
      : ["preference", "workflow", "format", "unknown"];
  if (!allowed.includes(jev.strictness)) return false;
  if (kind === "rule" && jev.risk >= 0.5) return false;
  if ((kind === "fact" || kind === "reference") && jev.risk >= 0.4) return false;
  if (jev.safeAuto < autoThreshold(config, scope)) return false;
  if (kind === "rule" && !config.autoRules) return false;
  if (kind !== "rule" && !config.autoMemory) return false;
  if (kind === "rule" && autoCounts.rules >= config.caps.autoRules) return false;
  if (kind !== "rule" && autoCounts.memory >= config.caps.autoMemory) return false;
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

export async function collectExistingTitles(store: Store): Promise<string[]> {
  const [memory, rules, queue, items] = await Promise.all([
    store.readAutoMemory(),
    store.readAutoRules(),
    store.listQueue(),
    store.listItems(),
  ]);
  return [
    ...bullets(memory).map((line) => line.slice(0, 30)),
    ...bullets(rules).map((line) => line.slice(0, 30)),
    ...queue.map((item) => item.title),
    ...items.map((item) => item.title),
  ];
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
