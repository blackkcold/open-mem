import type { AutoMemConfig, HealthScore } from "./types.js";
import type { Store } from "./store.js";
import { capacityStatus } from "./capacity.js";
import { ageDays } from "./priority.js";
import { sameScopeAndProject } from "./memory/scope.js";
import { classifyRelation } from "./relations.js";

export async function computeHealth(
  store: Store,
  config: AutoMemConfig,
): Promise<HealthScore> {
  const [items, queue, shadow, decisionUsage, rewriteUsage, stats, capacity] =
    await Promise.all([
      store.listItems(),
      store.listQueue(),
      store.listShadow(),
      store.listUsage("decision"),
      store.listUsage("rewrite"),
      store.readStats(),
      capacityStatus(store, config),
    ]);

  const active = items.filter((item) => item.status !== "archived");
  const duplicateIds = new Set<string>();
  for (let left = 0; left < active.length; left++) {
    for (let right = left + 1; right < active.length; right++) {
      if (!sameScopeAndProject(active[left], active[right])) continue;
      const relation = classifyRelation(
        { text: active[left].text, kind: active[left].kind },
        { text: active[right].text, kind: active[right].kind },
      );
      if (relation.relation === "exact" || relation.relation === "covered") {
        duplicateIds.add(active[left].id);
        duplicateIds.add(active[right].id);
      }
    }
  }
  const duplicateRate = active.length > 0 ? duplicateIds.size / active.length : 0;

  const titles = new Map<string, Set<string>>();
  for (const item of active) {
    const key = `${item.scope}|${item.projectKey ?? ""}|${item.title.trim().toLowerCase()}`;
    const texts = titles.get(key) ?? new Set<string>();
    texts.add(item.text.trim());
    titles.set(key, texts);
  }
  let conflictCount = 0;
  for (const texts of titles.values()) if (texts.size > 1) conflictCount += 1;

  const falsePositives = shadow.filter((record) => record.falsePositive).length;
  const falsePositiveRate = shadow.length > 0 ? falsePositives / shadow.length : 0;
  const queueAges = queue
    .map((item) => ageDays(item.createdAt) * 24)
    .sort((left, right) => left - right);
  const queueAgeP95Hours = percentile(queueAges, 0.95);

  const decisionFallbackRate =
    decisionUsage.length > 0
      ? decisionUsage.filter((record) => !record.ok).length / decisionUsage.length
      : 0;
  const rewriteFallbackRate =
    rewriteUsage.length > 0
      ? rewriteUsage.filter((record) => !record.ok).length / rewriteUsage.length
      : 0;

  const applied = stats.suggestionApplied ?? 0;
  const rejected = stats.suggestionRejected ?? 0;
  const suggestionAcceptance = applied + rejected > 0 ? applied / (applied + rejected) : 1;
  const undoCount = stats.mergeUndone ?? 0;

  const breakdown = {
    capacity: clamp01(capacity.ratio),
    duplicates: clamp01(duplicateRate / 0.2),
    conflicts: clamp01(conflictCount / 5),
    falsePositive: clamp01(falsePositiveRate / 0.2),
    queueAge: clamp01(queueAgeP95Hours / 72),
    decisionFallback: clamp01(decisionFallbackRate),
    rewriteFallback: clamp01(rewriteFallbackRate),
    acceptance: clamp01(1 - suggestionAcceptance),
    undo: clamp01(undoCount / 3),
  };

  const score = Math.round(
    clamp(
      100 -
        25 * breakdown.capacity -
        20 * breakdown.duplicates -
        15 * breakdown.conflicts -
        15 * breakdown.falsePositive -
        10 * breakdown.queueAge -
        5 * breakdown.decisionFallback -
        5 * breakdown.rewriteFallback -
        3 * breakdown.acceptance -
        2 * breakdown.undo,
      0,
      100,
    ),
  );

  return {
    score,
    grade: score >= 85 ? "good" : score >= 70 ? "ok" : score >= 50 ? "warn" : "bad",
    generatedAt: new Date().toISOString(),
    breakdown,
    details: {
      items: active.length,
      queue: queue.length,
      shadow: shadow.length,
      duplicateRate,
      conflictCount,
      falsePositiveRate,
      queueAgeP95Hours,
      decisionCalls: decisionUsage.length,
      rewriteCalls: rewriteUsage.length,
      suggestionAcceptance,
      undoCount,
      capacityRatio: capacity.ratio,
    },
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));
  return Math.round(values[index] * 10) / 10;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
