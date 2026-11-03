import { readFile } from "node:fs/promises";
import type {
  AuditFinding,
  AuditReport,
  AutoMemConfig,
  Item,
  Metrics,
  QueueItem,
  ShadowRecord,
} from "./types.js";
import { Store } from "./store.js";
import { bigrams, hasSecret, jaccard, lintText, validateSkillDraft } from "./linter.js";
import { ageDays } from "./priority.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runAudit(store: Store, config: AutoMemConfig): Promise<AuditReport> {
  const [items, queue, shadow, skills] = await Promise.all([
    store.listItems(),
    store.listQueue(),
    store.listShadow(),
    store.listSkillDrafts(),
  ]);
  const findings: AuditFinding[] = [];
  const add = (finding: Omit<AuditFinding, "id">) =>
    findings.push({ id: `finding_${findings.length + 1}`, ...finding });

  // Duplicate / conflict pass over memory, queue, and shadow candidates.
  const pool: Array<{ id: string; title: string; text: string; status: string }> = [
    ...items.map((item) => ({ id: item.id, title: item.title, text: item.text, status: item.status })),
    ...queue.map((item) => ({ id: item.id, title: item.title, text: item.text, status: "queue" })),
    ...shadow.map((item) => ({ id: item.id, title: item.title, text: item.candidate, status: "shadow" })),
  ];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const left = pool[i];
      const right = pool[j];
      if (left.title.toLowerCase() === right.title.toLowerCase() && left.text !== right.text) {
        add({
          severity: "warning",
          kind: "conflict",
          title: `可能的冲突：${left.title}`,
          detail: "同一标题下存在不同内容，请确认哪一条是最新规则。",
          itemIDs: [left.id, right.id],
          suggestedAction: "review",
        });
      }
      const score = jaccard(bigrams(`${left.title} ${left.text}`), bigrams(`${right.title} ${right.text}`));
      if (score >= 0.75) {
        add({
          severity: "warning",
          kind: "duplicate",
          title: `重复候选：${left.title}`,
          detail: `相似度 ${Math.round(score * 100)}%，建议合并或拒绝其中一条。`,
          itemIDs: [left.id, right.id],
          suggestedAction: "merge",
        });
      }
    }
  }

  for (const item of items) {
    const age = ageDays(item.createdAt);
    if (age > 90) {
      add({
        severity: "info",
        kind: "stale",
        title: `可能过期：${item.title}`,
        detail: `已有 ${Math.round(age)} 天未更新，复核是否仍然有效。`,
        itemIDs: [item.id],
        suggestedAction: "review",
      });
    }
    if (hasSecret(`${item.title} ${item.text}`)) {
      add({
        severity: "error",
        kind: "secret",
        title: `疑似密钥：${item.title}`,
        detail: "条目包含疑似密钥或凭证，建议立即删除并轮换。",
        itemIDs: [item.id],
        suggestedAction: "delete",
      });
    }
    const lint = lintText({
      title: item.title,
      text: item.text,
      kind: item.kind,
      scope: item.scope,
      maxChars: item.kind === "rule" ? config.thresholds.ruleMaxChars : config.thresholds.memoryMaxChars,
      titleMaxChars: config.thresholds.titleMaxChars,
    });
    if (!lint.ok) {
      add({
        severity: "warning",
        kind: "lint",
        title: `格式不合格：${item.title}`,
        detail: lint.errors.join("; "),
        itemIDs: [item.id],
        suggestedAction: "edit",
      });
    }
  }

  const autoMemory = items.filter((item) => item.status === "auto" && item.kind !== "rule").length;
  const autoRules = items.filter((item) => item.status === "auto" && item.kind === "rule").length;
  if (autoMemory > config.caps.autoMemory) {
    add({
      severity: "warning",
      kind: "capacity",
      title: "AUTO_MEMORY 超过容量",
      detail: `${autoMemory} 条 > ${config.caps.autoMemory} 条，停止自动写入并整理。`,
      itemIDs: [],
      suggestedAction: "compact",
    });
  }
  if (autoRules > config.caps.autoRules) {
    add({
      severity: "warning",
      kind: "capacity",
      title: "AUTO_RULES 超过容量",
      detail: `${autoRules} 条 > ${config.caps.autoRules} 条，停止自动写入并整理。`,
      itemIDs: [],
      suggestedAction: "compact",
    });
  }

  for (const item of queue) {
    const age = ageDays(item.createdAt);
    if (age > 7) {
      add({
        severity: "warning",
        kind: "queue",
        title: `队列积压：${item.title}`,
        detail: `已等待 ${Math.round(age)} 天，优先级 ${item.priority ?? 0}。`,
        itemIDs: [item.id],
        suggestedAction: "review",
      });
    }
  }

  const falsePositives = shadow.filter((record) => record.falsePositive).length;
  if (shadow.length > 0 && falsePositives / shadow.length > 0.1) {
    add({
      severity: "warning",
      kind: "shadow",
      title: "Shadow 误报率偏高",
      detail: `${falsePositives}/${shadow.length} 条 shadow 决策被标为误报，建议收紧阈值。`,
      itemIDs: [],
      suggestedAction: "retune",
    });
  }

  for (const draft of skills) {
    try {
      const content = await readFile(draft.path, "utf8");
      const validation = validateSkillDraft({
        name: draft.name,
        description: draft.description,
        content,
      });
      if (!validation.ok) {
        add({
          severity: "warning",
          kind: "skill",
          title: `Skill 草稿不合格：${draft.name}`,
          detail: validation.errors.join("; "),
          itemIDs: [draft.id],
          suggestedAction: "edit",
        });
      }
    } catch {
      add({
        severity: "warning",
        kind: "skill",
        title: `Skill 草稿不可读：${draft.name}`,
        detail: draft.path,
        itemIDs: [draft.id],
        suggestedAction: "review",
      });
    }
  }

  const summary = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) summary[finding.severity] += 1;
  const report: AuditReport = { generatedAt: new Date().toISOString(), findings, summary };
  await store.writeAudit(report);
  await computeMetrics(store, report);
  return report;
}

export async function computeMetrics(store: Store, audit?: AuditReport): Promise<Metrics> {
  const [items, queue, shadow, skills] = await Promise.all([
    store.listItems(),
    store.listQueue(),
    store.listShadow(),
    store.listSkillDrafts(),
  ]);
  const report = audit ?? (await store.readAudit());
  const auto = items.filter((item) => item.status === "auto").length;
  const promoted = items.filter((item) => item.status === "promoted").length;
  const falsePositives = shadow.filter((record) => record.falsePositive).length;
  const queueAges = queue
    .map((item) => ageDays(item.createdAt) * 24)
    .sort((a, b) => a - b);
  const metrics: Metrics = {
    generatedAt: new Date().toISOString(),
    items: items.length,
    queue: queue.length,
    shadow: shadow.length,
    auto,
    promoted,
    falsePositive: falsePositives,
    falsePositiveRate: shadow.length > 0 ? falsePositives / shadow.length : 0,
    queueAgeP50Hours: percentile(queueAges, 0.5),
    queueAgeP95Hours: percentile(queueAges, 0.95),
    skillDrafts: skills.length,
    auditFindings: report.findings.length,
  };
  await store.writeMetrics(metrics);
  return metrics;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));
  return Math.round(values[index] * 10) / 10;
}

export function ageMs(createdAt: string): number {
  const created = new Date(createdAt).getTime();
  return Number.isFinite(created) ? Math.max(0, Date.now() - created) : 0;
}

export function dayMs(): number {
  return DAY_MS;
}
