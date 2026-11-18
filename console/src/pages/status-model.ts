import { formatReviewAge } from "../api";
import type { AutomationStatus } from "../types";

/**
 * Three orthogonal axes for write state, run quality and data freshness.
 * They are deliberately returned separately: one green dot must never stand
 * in for all three.
 */
export type AxisTone = "neutral" | "success" | "warning" | "error" | "info";

export interface AxisChip {
  key: "write" | "quality" | "freshness";
  label: string;
  detail: string;
  tone: AxisTone;
}

export function modeLabel(mode: AutomationStatus["effectiveMode"] | undefined): string {
  if (mode === "autonomous") return "自动写入";
  if (mode === "shadow") return "观察模式 · 不写入生效记忆";
  if (mode === "off") return "已停止学习 · 不写入";
  if (mode === "legacy") return "兼容配置 · 按旧配置运行";
  return "写入状态未知";
}

function configuredLabel(mode: AutomationStatus["configuredMode"] | undefined): string {
  if (mode === "autonomous") return "自动写入";
  if (mode === "shadow") return "观察不写入";
  if (mode === "off") return "停止学习";
  if (mode === "legacy") return "兼容配置";
  return "未知";
}

export function writeAxis(status: AutomationStatus | undefined): AxisChip {
  if (!status) {
    return {
      key: "write",
      label: "写入状态未知",
      detail: "自动化状态接口不可用；已有记忆不受影响。",
      tone: "neutral",
    };
  }
  const blocking = [...status.blockedReasons];
  if (status.pending.capacityBlocked) blocking.push("pending-capacity");
  const extract = status.availability.extract;
  const degraded =
    extract === "degraded" ||
    status.degraded.some(
      (entry) => entry.state === "blocked" || entry.state === "degraded",
    );
  const detailParts = [
    `配置 ${configuredLabel(status.configuredMode)}`,
    `服务端有效 ${configuredLabel(status.effectiveMode)}`,
    `抽取可用性 ${extract}`,
  ];
  if (blocking.length > 0) {
    detailParts.push(`阻断 ${[...new Set(blocking)].map(reasonLabel).join("、")}`);
  }

  let label: string;
  let tone: AxisTone;
  if (status.effectiveMode === "off") {
    label = "已停止学习 · 不写入";
    tone = "warning";
  } else if (status.effectiveMode === "shadow") {
    label = "观察模式 · 不写入生效记忆";
    tone = "neutral";
  } else if (status.effectiveMode === "legacy") {
    label = "兼容配置 · 按旧配置运行";
    tone = "neutral";
  } else if (blocking.length > 0) {
    label = "自动写入 · 当前被阻断";
    tone = "warning";
  } else if (extract === "unknown") {
    label = "自动写入 · 运行状态未知";
    tone = "warning";
  } else if (degraded || extract !== "configured") {
    label = "自动写入 · 部分能力受限";
    tone = "warning";
  } else {
    label = "自动写入 · 生效中";
    tone = "success";
  }

  return {
    key: "write",
    label,
    detail: detailParts.join("；"),
    tone,
  };
}

export function qualityAxis(status: AutomationStatus | undefined): AxisChip {
  if (!status) {
    return {
      key: "quality",
      label: "运行质量未知",
      detail: "没有自动化状态快照，不能判断是否降级。",
      tone: "neutral",
    };
  }
  const problems = status.degraded.filter(
    (entry) =>
      entry.state === "blocked" ||
      entry.state === "degraded" ||
      entry.state === "unknown",
  );
  if (problems.length === 0) {
    return {
      key: "quality",
      label: "运行正常",
      detail: "服务端未报告阻断或降级；这不代表已做真实宿主验证。",
      tone: "success",
    };
  }
  const retry = problems.find((entry) => entry.retryAt)?.retryAt;
  return {
    key: "quality",
    label: problems.some((entry) => entry.state === "blocked")
      ? "运行受限"
      : "降级运行",
    detail: `${problems.map((entry) => reasonLabel(entry.reason)).join("、")}${
      retry ? ` · 重试 ${formatReviewAge(retry)}` : ""
    }`,
    tone: problems.some((entry) => entry.state === "blocked") ? "warning" : "warning",
  };
}

export function freshnessAxis(
  status: AutomationStatus | undefined,
  now = Date.now(),
): AxisChip {
  if (!status) {
    return {
      key: "freshness",
      label: "状态快照未知",
      detail: "没有可读的自动化状态快照；不能拿空缓存或 0 次冒充正常。",
      tone: "neutral",
    };
  }
  const lastWrite = status.lastSuccess?.at;
  const writeDetail = lastWrite
    ? `最近真实写入：${lastWrite}`
    : "最近真实写入：无记录";
  const snapshot = status.generatedAt;
  if (!snapshot || !Number.isFinite(Date.parse(snapshot))) {
    return {
      key: "freshness",
      label: "快照时间未知",
      detail: `服务端未返回快照时间；${writeDetail}`,
      tone: "neutral",
    };
  }
  const age = Math.max(0, now - Date.parse(snapshot));
  const stale = age > 2 * 60_000;
  return {
    key: "freshness",
    label: stale
      ? `状态快照已过期 · 上次 ${formatReviewAge(snapshot)}`
      : `状态快照 ${formatReviewAge(snapshot)}更新`,
    detail: `快照生成于 ${snapshot}；${writeDetail}。没有后台活动不等于记忆过期。`,
    tone: stale ? "neutral" : "info",
  };
}

export function axisChips(status: AutomationStatus | undefined, now = Date.now()): AxisChip[] {
  return [writeAxis(status), qualityAxis(status), freshnessAxis(status, now)];
}

export const DEGRADED_REASON_LABEL: Record<string, string> = {
  "mode-off": "模式为停止学习",
  "automation-disabled": "自动写入开关关闭",
  "pending-capacity": "候选队列容量已满",
  "capacity-freeze": "容量达到 95%，自动写已冻结",
  "capacity-block": "容量已满，写入被拒绝",
  "history-protected-capacity": "受保护变更历史已到上限，自动学习暂停",
  "retention-blocked": "派生历史保留策略到达上限",
  "retired-source-capacity": "退役来源容量阻断",
  "global-candidate-capacity": "全局候选容量阻断",
  "owner-unconfirmed": "会话归属未确认",
  "extract-provider-circuit": "抽取模型熔断",
  "model-unconfigured": "抽取模型未配置",
  "circuit-open": "模型熔断",
  "runtime-provider-unknown": "运行时模型状态未知",
  "hourly-limit": "小时预算已用尽",
  "daily-limit": "每日预算已用尽",
};

export function reasonLabel(reason: string): string {
  return DEGRADED_REASON_LABEL[reason] ?? reason;
}
