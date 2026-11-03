import type { JevResult, PriorityBreakdown, QueueItem, Scope } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function ageDays(createdAt: string, now = Date.now()): number {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, (now - created) / DAY_MS);
}

export function computePriority(
  jev: JevResult,
  createdAt: string,
  scope: Scope,
  now = Date.now(),
): { priority: number; breakdown: PriorityBreakdown } {
  const risk = clamp01(jev.risk);
  const impact = scope === "global" ? 0.9 : 0.65;
  const uncertainty = clamp01(1 - jev.confidence);
  const age = Math.min(ageDays(createdAt, now) / 14, 1);
  const priority = Math.round(
    100 * (0.4 * risk + 0.25 * impact + 0.2 * uncertainty + 0.15 * age),
  );
  return { priority, breakdown: { risk, impact, uncertainty, age } };
}

export function priorityReason(
  jev: JevResult,
  scope: Scope,
  createdAt: string,
  now = Date.now(),
): string {
  const parts: string[] = [];
  if (jev.strictness === "safety" || jev.strictness === "destructive") parts.push("安全/破坏性");
  else if (jev.strictness === "permission") parts.push("权限变更");
  else if (jev.strictness === "strict_limit") parts.push("严格限制");
  else if (jev.kind === "rule") parts.push("规则");
  else if (jev.kind === "skill") parts.push("skill 候选");
  else parts.push("记忆候选");
  if (scope === "global") parts.push("global");
  if (jev.duplicate >= 0.25) parts.push(`重复 ${Math.round(jev.duplicate * 100)}%`);
  parts.push(`Jev ${Math.round(jev.confidence * 100)}%`);
  const days = Math.floor(ageDays(createdAt, now));
  if (days > 0) parts.push(`${days}d`);
  return parts.join(" · ");
}

export function sortQueue(queue: QueueItem[]): QueueItem[] {
  return [...queue].sort((a, b) => {
    const deferredA = a.deferredUntil ? new Date(a.deferredUntil).getTime() > Date.now() : false;
    const deferredB = b.deferredUntil ? new Date(b.deferredUntil).getTime() > Date.now() : false;
    if (deferredA !== deferredB) return deferredA ? 1 : -1;
    return (b.priority ?? 0) - (a.priority ?? 0) || b.createdAt.localeCompare(a.createdAt);
  });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
