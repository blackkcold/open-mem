import type { Scope } from "../types.js";

/**
 * Default to session. A memory only becomes project-scoped when the text
 * carries project evidence, and global only when it carries explicit
 * cross-project language or a stable environment fact.
 */
const SESSION_RE =
  /(?:本次|暂时|这个任务|当前任务|只读|不要修改|不要改|for now|today|this task|one-off|临时)/i;
const GLOBAL_RE =
  /(?:所有项目|跨项目|一切以|原则|理念|以后|每次|一律|永远|总是|always|never|all projects|我习惯|我喜欢|我偏好|prefer|i like)/i;
const PROJECT_RE =
  /(?:项目|仓库|repo|本地|端口|路径|命令|目录|技术栈|project|this repo|this project|branch)/i;
const ENV_RE =
  /(?:本机|这台机器|安装了|系统版本|homebrew|hermes|opencode|openchamber|macos|windows|linux)/i;

export function classifyScope(text: string, project?: string): Scope {
  const clean = text.trim();
  if (clean.length === 0) return "session";
  if (SESSION_RE.test(clean)) return "session";
  if (GLOBAL_RE.test(clean)) return "global";
  if (project && PROJECT_RE.test(clean)) return "project";
  if (ENV_RE.test(clean)) return "global";
  return "session";
}
