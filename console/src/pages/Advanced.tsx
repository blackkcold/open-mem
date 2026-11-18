import type { ReactNode } from "react";
import type { MemoryGraphView, Metrics } from "../types";
import { advancedLink } from "./audit-links";
import type { AdvancedSection } from "./audit-links";
import { AuditPage } from "./Audit";
import { HealthPage } from "./Health";
import { MemoryGraph } from "./MemoryGraph";
import { SkillsPage } from "./Skills";

interface Props {
  section: AdvancedSection;
  refreshKey: number;
  onChanged: () => void;
  metrics?: Metrics;
  auditFindingID?: string;
  auditReportAt?: string;
  graphView?: MemoryGraphView;
  onDirtyChange: (dirty: boolean) => void;
}

const ENTRY_LABEL: Record<AdvancedSection, string> = {
  review: "审查（legacy）",
  health: "健康与维护",
  audit: "审计",
  graph: "记忆图谱",
  skills: "技能审查",
  history: "历史",
  backup: "备份",
};

const ENTRY_ORDER: AdvancedSection[] = [
  "review",
  "health",
  "audit",
  "graph",
  "skills",
  "history",
  "backup",
];

/**
 * Settings › advanced. Kept as one shell so every legacy capability has a
 * real, reachable route and its own back link; no capability is reduced to a
 * decorative button.
 */
export function AdvancedShell({
  section,
  children,
}: {
  section: AdvancedSection;
  children: ReactNode;
}) {
  return (
    <div className="advanced-page">
      <header className="advanced-head">
        <a className="btn ghost" href="#settings">
          ← 设置
        </a>
        <h1>{ENTRY_LABEL[section]}</h1>
        <span className="muted small">高级与维护 · 主动进入，不催审</span>
      </header>
      <nav className="advanced-nav" aria-label="高级与维护">
        {ENTRY_ORDER.map((entry) => (
          <a
            key={entry}
            className="advanced-nav-link"
            href={advancedLink(entry)}
            aria-current={entry === section ? "page" : undefined}
          >
            {ENTRY_LABEL[entry]}
          </a>
        ))}
      </nav>

      {children}
    </div>
  );
}

export function AdvancedPage({
  section,
  refreshKey,
  onChanged,
  metrics,
  auditFindingID,
  auditReportAt,
  graphView,
  onDirtyChange,
}: Props) {
  return (
    <AdvancedShell section={section}>
      {section === "health" || section === "history" ? (
        <>
          {section === "history" ? (
            <p className="banner" role="note">
              历史包含操作历史、合并撤销与维护回滚；旧合并记录的 24 小时窗口只约束 legacy 撤销。
            </p>
          ) : null}
          <HealthPage refreshKey={refreshKey} onChanged={onChanged} />
        </>
      ) : null}
      {section === "audit" ? (
        <AuditPage
          refreshKey={refreshKey}
          onChanged={onChanged}
          targetFindingID={auditFindingID}
          targetReportAt={auditReportAt}
        />
      ) : null}
      {section === "graph" || section === "backup" ? (
        <MemoryGraph
          refreshKey={refreshKey}
          view={section === "backup" ? "backup" : (graphView ?? "architecture")}
          onViewChange={(view) => {
            window.location.hash = `settings/advanced/graph/${view}`;
          }}
        />
      ) : null}
      {section === "skills" ? (
        <SkillsPage refreshKey={refreshKey} onChanged={onChanged} onDirtyChange={onDirtyChange} />
      ) : null}
    </AdvancedShell>
  );
}
