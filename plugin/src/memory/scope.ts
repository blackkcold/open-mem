import type { Scope } from "../types.js";

/**
 * Default to session. A memory only becomes project-scoped when the text
 * carries project evidence, and global only when it carries explicit
 * cross-project language or a stable environment fact.
 */
const SESSION_RE =
  /(?:本次|这次|今天|刚才|暂时|这个任务|当前任务|只读|不要修改|不要改|for now|today|this task|one-off|临时)/i;
/**
 * Explicit cross-project language is strong enough to win over a project
 * mention ("所有项目" contains "项目"). Frequency/durability words are not:
 * "本项目每次…" must stay project-scoped.
 */
const EXPLICIT_GLOBAL_RE =
  /(?:所有项目|跨项目|所有仓库|每个项目|一切以|all projects|across projects|every project)/i;
// Durable-sounding language is not cross-project evidence. "我习惯在这个项目"
// and "never in this repo" must stay project-scoped when project evidence is
// present; without it they remain durable global candidates.
const DURABLE_GLOBAL_RE =
  /(?:以后|每次|一律|永远|总是|原则|理念|always|never|我习惯|我喜欢|我偏好|prefer|i like)/i;
const PROJECT_RE =
  /(?:项目|仓库|repo|本地|端口|路径|命令|目录|技术栈|project|this repo|this project|branch)/i;
// A stable environment fact needs explicit machine/installation/state evidence.
// A bare product or OS name is not enough: "opencode 报错了" and
// "macOS 14 上崩溃了" are events, not facts about this machine.
const ENV_RE =
  /(?:本机|这台机器|安装了|已安装|系统版本|已开启|已启用)/i;

export function classifyScope(text: string, project?: string): Scope {
  const clean = text.trim();
  if (clean.length === 0) return "session";
  if (SESSION_RE.test(clean)) return "session";
  if (EXPLICIT_GLOBAL_RE.test(clean)) return "global";
  if (project && PROJECT_RE.test(clean)) return "project";
  if (DURABLE_GLOBAL_RE.test(clean)) return "global";
  if (ENV_RE.test(clean)) return "global";
  return "session";
}

/**
 * One-way visibility for a candidate and an existing row.
 *
 * - global candidate: only global rows;
 * - project candidate: only rows with the same projectKey (unknown identity sees nothing);
 * - session candidate: only session rows.
 *
 * A global row is deliberately NOT visible to a project candidate here: this is
 * the symmetric dedupe/merge rule. Baseline coverage may add a separate one-way
 * global→project view; do not widen this helper or stored rows can cross projects.
 */
export function sameScopeAndProject(
  entry: {
    scope: Scope;
    projectKey?: string;
    source?: { sessionID?: string };
    sources?: Array<{ sessionID?: string }>;
  },
  target: {
    scope: Scope;
    projectKey?: string;
    source?: { sessionID?: string };
    sources?: Array<{ sessionID?: string }>;
  },
): boolean {
  if (entry.scope !== target.scope) return false;
  if (target.scope === "session") {
    const targetSession = sessionIDOf(target);
    return targetSession !== undefined && sessionIDOf(entry) === targetSession;
  }
  if (target.scope !== "project") return true;
  return target.projectKey !== undefined && entry.projectKey === target.projectKey;
}

function sessionIDOf(entry: {
  source?: { sessionID?: string };
  sources?: Array<{ sessionID?: string }>;
}): string | undefined {
  if (entry.source?.sessionID) return entry.source.sessionID;
  return entry.sources?.find((source) => source.sessionID)?.sessionID;
}
