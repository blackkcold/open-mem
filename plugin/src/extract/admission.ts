import type { ItemKind, Scope } from "../types.js";
import { redactText } from "../redact.js";
import type { LocatedQuote } from "./evidence.js";
import type { ClaimProposal } from "./provider.js";
import { sha16 } from "../util/text.js";

export type ExtractAdmission =
  | { ok: true; text: string; kind: ItemKind; scope: Scope; reviewType?: "learning" }
  | { ok: false; reason: string };

const NEGATED_OR_CONDITIONAL = /(?:不要|别(?:再)?|不应|不能|不可|禁止|无需|不必|不需要|不是|并非|未曾|如果|假如|假设|除非|否则|只有.{0,12}才|条件是|do not|don't|unless|\bif\b)/i;
const ATTRIBUTED_OR_DISPUTED = /(?:同事.{0,20}说|别人.{0,20}说|有人.{0,20}说|听说|据说|转述|引述|引用|我不同意|不同意|不认同|someone said|colleague said|quoted from)/i;
const TEMPORARY_OR_TASK = /(?:本次任务|当前任务|这个会话|本会话|今天|临时|稍后|等会儿|this task|this session|for today|temporarily)/i;

// Protected operations are checked against the whole governing seed before
// any descriptive positive class. These are deny gates, not a substitute for
// the structured local positive parser below.
const PROTECTED = [
  /(?:环境变量|process\.env|environment variables?).{0,60}(?:api[_ -]?token|access[_ -]?token|credential|secret|密钥|凭证).{0,80}(?:发到|发送|上传|外传|导出|推送|webhook|send|upload|export|post)/i,
  /(?:api[_ -]?token|access[_ -]?token|credential|secret|密钥|凭证).{0,80}(?:发到|发送|上传|外传|导出|推送|webhook|send|upload|export|post)/i,
  /(?:api[_ -]?token|access[_ -]?token|credential|secret|密钥|凭证).{0,36}(?:导出|复制到|上传|外传|保存到|写入文件|export|exfiltrate)/i,
  /(?:main|master|主分支|生产(?:环境|库|数据库)?|\bprod(?:uction)?\b).{0,60}(?:强推|force\s*push|删除|清空|覆盖|重置|部署|销毁|drop|delete|overwrite)/i,
  /(?:强推|force\s*push|删除|清空|覆盖|重置|部署|销毁|drop|delete|overwrite).{0,60}(?:main|master|主分支|生产|\bprod(?:uction)?\b)/i,
  /(?:强推|force\s*push|drop\s+database|删除数据库|清空数据库|销毁数据库)/i,
  /(?:任意|任意命令|任意代码|任意脚本|arbitrary|unrestricted).{0,32}(?:执行|运行|eval|exec|shell|命令|代码|脚本)/i,
  /(?:执行|运行|eval|exec).{0,32}(?:任意|arbitrary|unrestricted|shell|任意命令|任意代码|任意脚本)/i,
  /(?:绕过|忽略|关闭|禁用|skip|bypass).{0,24}(?:安全|权限|校验|审核|确认|认证|验证|security|permission|approval)/i,
  /(?:授予|给予|开放|提升|grant|elevate).{0,24}(?:权限|访问权|管理员|root|admin|privilege)/i,
];

// High-risk capabilities are denied across the complete seed, including when
// presented as descriptive hints. These deny gates supplement the finite local
// parser; they are not the admission strategy.
const CAPABILITY_DENY = [
  /\b(?:eval|exec)\b/i,
  /(?:提权|提升权限|elevate|privilege)/i,
  /\binstall\b|安装(?!依赖)/i,
  /(?:外传|exfiltrat)/i,
  /(?:绕过|忽略|关闭|禁用|bypass|skip).{0,24}(?:安全|权限|校验|审核|确认|认证|security|permission|approval)/i,
  /(?:安全|权限|校验|审核|认证).{0,16}(?:绕过|跳过|禁用|bypass|skip)/i,
  /(?:用户提供|外部提供|不可信).{0,32}(?:命令|代码|表达式|脚本).{0,32}(?:执行|运行|调用|eval|exec|传入)/i,
  /(?:安装|install).{0,40}(?:脚本|软件|应用|插件|extension|script|program|untrusted|unknown)/i,
  /(?:不可信|未经验证|未知来源|untrusted|unverified|unknown source).{0,40}(?:安装|install|依赖|脚本|软件)/i,
];

const SAFE_COMMAND = /^(?:pnpm\s+(?:test|lint|typecheck|check|build|vitest)|npm\s+(?:test|run\s+(?:test|lint|typecheck|check|build))|yarn\s+(?:test|lint|typecheck|check)|bun\s+test|npx\s+tsc\s+--noEmit|tsc\s+--noEmit|vitest(?:\s+run)?|playwright\s+test|python\s+-m\s+pytest|pytest|git\s+(?:status|diff\s+--check))$/i;
const SAFE_PREFERENCE_VALUE = /^(?:pnpm|npm|yarn|bun|node(?:\.js)?(?:\s+\d{1,2}(?:\.\d+)*)?|python(?:\s+\d{1,2}(?:\.\d+)*)?|typescript|javascript|vitest|playwright|markdown|json|yaml|csv|中文(?:回复)?|英文(?:回复)?|结论|格式|依赖管理|测试流程|代码格式)$/i;
const SAFE_FACT_TOOL_VALUE = /^(?:pnpm|npm|yarn|bun|node(?:\.js)?(?:\s+\d{1,2}(?:\.\d+)*)?|python(?:\s+\d{1,2}(?:\.\d+)*)?|typescript|javascript|vitest|playwright|vite|sqlite|postgres(?:ql)?|mysql|redis|markdown|json|yaml|csv)$/i;
const SAFE_FACT_PROFILE_VALUE = /^(?:edge|chrome)\s+profile$/i;
const SAFE_FACT_LOCAL_ENDPOINT = /^(?:localhost|127\.0\.0\.1)(?::(?<port>\d{1,5}))?$/i;
const SAFE_FACT_VERSION = /^(?:v)?\d{1,3}(?:\.\d{1,3}){1,3}(?:[-+][\p{L}\p{N}.-]+)?$/u;

// Failing-tool learning records a native failure, never an authorization or a
// future instruction. The body is the locally built projection, so this is a
// narrow content deny, not a second general-purpose claim parser.
const TOOL_LEARNING_DENY = [
  /(?:api[_ -]?token|access[_ -]?token|credential|secret|密钥|凭证|密码|password)/i,
  /\b(?:eval|exec)\b/i,
  /(?:提权|sudo|root|管理员|admin)/i,
  /(?:绕过|忽略|关闭|禁用|bypass|skip).{0,24}(?:安全|权限|校验|审核|认证|security|permission|approval)/i,
  /(?:外传|exfiltrat|上传|export)/i,
  /(?:rm\s+-rf|force\s*push|drop\s+database|删除数据库|清空数据库)/i,
  /(?:请|你需要|你必须|please|you (?:must|should|need to)).{0,40}(?:运行|执行|安装|删除|部署|run|execute|install|delete|deploy)/i,
];

interface LocalClaim {
  kind: ItemKind;
  scope: Scope;
  subject: string;
  predicate: string;
  value: string;
  qualifiers?: string[];
  polarity?: "positive" | "negative";
  intent?: "ordinary" | "additive" | "replacement";
  oldValue?: string;
  explicitGlobal?: boolean;
  projectRelative?: boolean;
  /** Surface words for the model's lexical cross-check; never used as claim identity. */
  surfaceSubject?: string;
  surfacePredicate?: string;
  surfaceValue?: string;
}

export interface ParsedExtractClaim {
  kind: ItemKind;
  scope: Scope;
  subject: string;
  predicate: string;
  value: string;
  qualifiers: string[];
  polarity: "positive" | "negative";
  intent: "ordinary" | "additive" | "replacement";
  oldValue?: string;
  explicitGlobal: boolean;
  projectRelative: boolean;
}

/** Local positive admission; model labels and summaries never authorize writes. */
export function admitExtractProposal(
  proposal: ClaimProposal,
  located: LocatedQuote,
  maxChars = 200,
): ExtractAdmission {
  const quote = proposal.quote;
  if (!quote || quote !== quote.trim()) return { ok: false, reason: "quote-shape" };
  if (quote.length < 4 || quote.length > 500) return { ok: false, reason: "quote-size" };
  if (
    located.start !== located.span.start ||
    located.end !== located.span.end ||
    quote !== located.span.text
  ) {
    return { ok: false, reason: "incomplete-governing-seed" };
  }
  if (quote.length > Math.min(200, maxChars)) return { ok: false, reason: "projection-over-budget" };
  if (!hasCompleteProposal(proposal, quote)) return { ok: false, reason: "proposal-not-grounded" };
  if (redactText(quote, { paths: false }).hits > 0) return { ok: false, reason: "sensitive" };
  if (PROTECTED.some((pattern) => pattern.test(quote))) return { ok: false, reason: "protected" };
  if (CAPABILITY_DENY.some((pattern) => pattern.test(quote))) return { ok: false, reason: "protected-capability" };
  if (ATTRIBUTED_OR_DISPUTED.test(quote)) return { ok: false, reason: "attributed-or-disputed" };
  if (TEMPORARY_OR_TASK.test(quote)) return { ok: false, reason: "temporary" };

  const local = parseCompleteSeed(quote);
  if (!local) return { ok: false, reason: "no-complete-local-parse" };
  // A locally parsed replacement is the sole narrow exception: its full quote
  // must explicitly bind one old value to one new value. Negation is not
  // discarded or converted into an ordinary preference.
  if (NEGATED_OR_CONDITIONAL.test(quote) && local.intent !== "replacement") {
    return { ok: false, reason: "polarity-or-condition" };
  }
  if (!proposalMatchesLocalParse(proposal, local)) {
    return { ok: false, reason: "proposal-disagrees-with-local-parse" };
  }
  // Persist only a complete original projection. The model's `text` is a
  // summary hint and is intentionally not used as the item body.
  return { ok: true, text: quote, kind: local.kind, scope: local.scope };
}

/**
 * Admit a failing-tool learning seed. The native part is the authority: the
 * model only selected it. Kind/scope/reviewType are fixed locally, never taken
 * from the proposal, and the body is the bounded complete failure projection
 * built from state.error/content/output, never command text or model prose.
 */
export function admitToolLearning(
  proposal: ClaimProposal,
  located: LocatedQuote,
  maxChars = 200,
): ExtractAdmission {
  const span = located.span;
  if (span.role !== "tool" || span.ok !== false) return { ok: false, reason: "not-failing-tool" };
  if (span.observedRole !== "assistant" && span.observedRole !== "tool") {
    return { ok: false, reason: "unsupported-native-role" };
  }
  if (span.offsetSpace !== "tool-projection") {
    return { ok: false, reason: "unverified-offset-space" };
  }
  const quote = proposal.quote;
  if (!quote || quote !== quote.trim()) return { ok: false, reason: "quote-shape" };
  if (quote.length < 4 || quote.length > 500) return { ok: false, reason: "quote-size" };
  if (
    located.start !== span.start ||
    located.end !== span.end ||
    quote !== span.text
  ) {
    return { ok: false, reason: "incomplete-governing-seed" };
  }
  if (quote.length > Math.min(200, maxChars)) return { ok: false, reason: "projection-over-budget" };
  if (!quote.startsWith("工具 ") || !quote.includes(" 失败（")) {
    return { ok: false, reason: "not-tool-failure-projection" };
  }
  if (!hasCompleteProposal(proposal, quote)) return { ok: false, reason: "proposal-not-grounded" };
  if (redactText(quote, { paths: false }).hits > 0) return { ok: false, reason: "sensitive" };
  if (TOOL_LEARNING_DENY.some((pattern) => pattern.test(quote))) {
    return { ok: false, reason: "protected-tool-learning" };
  }
  return { ok: true, text: quote, kind: "fact", scope: "project", reviewType: "learning" };
}

export function parseExtractClaim(text: string): ParsedExtractClaim | undefined {
  const local = parseCompleteSeed(text);
  if (!local) return undefined;
  const explicitGlobal = local.explicitGlobal === true || local.scope === "global";
  const claim: ParsedExtractClaim = {
    kind: local.kind,
    scope: local.scope,
    subject: local.subject,
    predicate: local.predicate,
    value: local.value,
    qualifiers: [...(local.qualifiers ?? [])],
    polarity: local.polarity ?? "positive",
    intent: local.intent ?? "ordinary",
    explicitGlobal,
    projectRelative: local.projectRelative ?? (!explicitGlobal && /(?:本项目|当前项目|这个项目|该项目|本仓库|当前仓库|项目|仓库)/i.test(text)),
    ...(local.oldValue ? { oldValue: local.oldValue } : {}),
  };
  return claim;
}

export function extractClaimKey(claim: ParsedExtractClaim): string {
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  return `claim:${normalize(claim.kind)}:${sha16(JSON.stringify([
    "project-domain",
    normalize(claim.kind),
    normalize(claim.subject),
    normalize(claim.predicate),
    normalize(claim.value),
    claim.polarity,
    [...claim.qualifiers].map(normalize).sort(),
  ]))}`;
}

function hasCompleteProposal(proposal: ClaimProposal, quote: string): boolean {
  const fields = [proposal.subject, proposal.predicate, proposal.value];
  if (fields.some((field) => typeof field !== "string" || !field.trim())) return false;
  if (!Array.isArray(proposal.qualifiers) || proposal.qualifiers.some((item) => typeof item !== "string")) {
    return false;
  }
  if (!quote) return false;
  if (proposal.qualifiers.some((qualifier) => qualifier && !quote.includes(qualifier))) return false;
  return typeof proposal.kind === "string" && typeof proposal.scope === "string" &&
    typeof proposal.speechActHint === "string" && typeof proposal.text === "string" &&
    proposal.text.length > 0 && proposal.text.length <= 200;
}

function parseCompleteSeed(quote: string): LocalClaim | undefined {
  // Only sentence-final punctuation is ignored. Internal separators, clauses,
  // prefixes and tails remain part of the parse and must match a full pattern.
  const seed = quote.replace(/[。！？!?]+$/u, "");
  return parseReference(seed) ??
    parseSafeProcedure(seed) ??
    parseDescriptiveFact(seed) ??
    parseToolPreference(seed) ??
    parsePreference(seed);
}

function parseToolPreference(seed: string): LocalClaim | undefined {
  const safeValue = "(pnpm|npm|yarn|bun|node(?:\\.js)?(?:\\s+\\d{1,2}(?:\\.\\d+)*)?|python(?:\\s+\\d{1,2}(?:\\.\\d+)*)?|typescript|javascript|vitest|playwright|markdown|json|yaml|csv)";
  const replacement = new RegExp(
    `^(?:(?<durable>以后|今后)\\s*)?(?<subject>本项目|当前项目|这个项目|该项目|本仓库|当前仓库|项目|仓库|我|我们团队)?\\s*(?<predicate>默认用|默认使用|始终用|始终使用|优先用|优先使用|喜欢用|喜欢使用|习惯用|习惯使用|用|使用|采用)\\s*(?<next>${safeValue})\\s*[，,；;]\\s*(?:不再用|不用|不使用|instead of)\\s*(?<previous>${safeValue})$`,
    "i",
  ).exec(seed);
  if (replacement?.groups) {
    const { durable, subject: rawSubject, next, previous } = replacement.groups;
    const projectRelative = /(?:项目|仓库)/i.test(rawSubject ?? "");
    return {
      kind: "preference",
      scope: "project",
      subject: projectRelative ? "project-tool-choice" : "user-tool-choice",
      predicate: "tool-choice",
      value: next.toLowerCase(),
      oldValue: previous.toLowerCase(),
      intent: "replacement",
      qualifiers: [...(durable ? ["durable"] : []), `replaces:${previous.toLowerCase()}`],
      polarity: "positive",
      projectRelative,
      ...(rawSubject ? { surfaceSubject: rawSubject } : {}),
      surfacePredicate: replacement.groups.predicate,
      surfaceValue: next,
    };
  }

  const additive = new RegExp(
    `^(?:(?<subject>本项目|当前项目|这个项目|该项目|本仓库|当前仓库|项目|仓库|我|我们团队)\\s*)?(?<particle>也|还|另外|同时)?\\s*(?<durable>以后|今后)?\\s*(?<predicate>默认用|默认使用|始终用|始终使用|优先用|优先使用|喜欢用|喜欢使用|喜欢|习惯用|习惯使用|习惯|用|使用|采用)\\s*(?<value>${safeValue})$`,
    "i",
  ).exec(seed);
  if (!additive?.groups) return undefined;
  const { subject: rawSubject, particle, durable, value } = additive.groups;
  const projectRelative = /(?:项目|仓库)/i.test(rawSubject ?? "");
  return {
    kind: "preference",
    scope: "project",
    subject: projectRelative ? "project-tool-choice" : "user-tool-choice",
    predicate: "tool-choice",
    value: value.toLowerCase(),
    intent: particle ? "additive" : "ordinary",
    qualifiers: [
      ...(particle ? ["additive"] : []),
      ...(durable ? ["durable"] : []),
    ],
    polarity: "positive",
    projectRelative,
    ...(rawSubject ? { surfaceSubject: rawSubject } : {}),
    surfacePredicate: additive.groups.predicate,
    surfaceValue: value,
  };
}

function parseReference(seed: string): LocalClaim | undefined {
  const match = /^(?<subject>(?:(?:本项目|当前项目|这个项目|该项目|项目|本仓库|仓库)\s*)?(?:参考文档|参考资料|文档|配置|docs?|reference))\s*(?<predicate>位于|在|地址是|路径是)\s*(?<value>https?:\/\/[^\s，,；;：:。！？!?]+|\/(?:[^\s，,；;：:。！？!?]+))$/i.exec(seed);
  if (!match?.groups) return undefined;
  const { subject, predicate, value } = match.groups;
  if (!isSafeReferenceTarget(value)) return undefined;
  return { kind: "reference", scope: "project", subject, predicate, value };
}

function isSafeReferenceTarget(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return true;
  return value.startsWith("/") && !/(?:^|\/)(?:\.ssh|\.aws|\.config\/opencode|credentials?|secrets?)(?:\/|$)/i.test(value);
}

function parseSafeProcedure(seed: string): LocalClaim | undefined {
  const match = /^(?:(?:以后|今后)\s*)?(?<global>(?:(?:在)?(?:所有项目|每个项目|任何项目|跨项目)(?:中|里)?[，,、\s]*))?(?<project>(?:(?:本项目|当前项目|这个项目|该项目|项目|本仓库|仓库)\s*)?)(?<phase>合并|提交|部署|上线|发布)前(?:先)?(?<predicate>运行|执行|检查|验证|测试|review|run|check|test|跑)\s*(?<value>.+)$/i.exec(seed);
  if (!match?.groups) return undefined;
  const { global, project, phase, predicate, value: rawValue } = match.groups;
  const value = rawValue.trim().replace(/[。！？!?]+$/u, "");
  if (!isSafeProcedureObject(predicate, value)) return undefined;
  return {
    kind: "preference",
    scope: global ? "global" : "project",
    subject: project.trim() || (global ? "项目" : `${phase}前`),
    predicate,
    value,
    explicitGlobal: Boolean(global),
    projectRelative: !global && Boolean(project.trim()),
  };
}

function isSafeProcedureObject(predicate: string, value: string): boolean {
  if (SAFE_COMMAND.test(value)) return true;
  return /^(?:完整|全量|全部)?测试(?:套件)?$/u.test(value) && /^(?:跑|运行|执行|检查|验证|测试)$/iu.test(predicate);
}

function parseDescriptiveFact(seed: string): LocalClaim | undefined {
  const match = /^(?:(?:我们的|本项目的|当前项目的)\s*)?(?<subject>本项目版本|项目版本|版本|本项目端口|项目端口|服务端口|端口|本项目|当前项目|这个项目|该项目|本仓库|当前仓库|项目|仓库|代码库|工作区|服务|应用|cookie\s*刷新|cookie|session\s*refresh|session|profile|入口|依赖|构建|测试|刷新|配置|数据库|缓存|项目名|repository|service|application)\s*(?<predicate>默认使用|使用|采用|基于|运行|监听|部署在|是|为|依赖|支持|走|刷新方式)\s*(?<value>.+)$/i.exec(seed);
  if (!match?.groups) return undefined;
  const { subject, predicate, value } = match.groups;
  if (!isSafeFactValue(subject, predicate, value.trim())) return undefined;
  return {
    kind: "fact",
    scope: "project",
    subject,
    predicate,
    value,
    projectRelative: /(?:项目|仓库)/i.test(subject),
  };
}

function isSafeFactValue(subject: string, predicate: string, value: string): boolean {
  if (SAFE_FACT_TOOL_VALUE.test(value) || SAFE_FACT_PROFILE_VALUE.test(value)) return true;

  const endpoint = SAFE_FACT_LOCAL_ENDPOINT.exec(value);
  if (endpoint) {
    const port = endpoint.groups?.port;
    return port === undefined || isValidPort(port);
  }

  if (/(?:端口|port)/i.test(subject) && /^(?:是|为|监听|运行|开放)$/i.test(predicate)) {
    return /^\d{1,5}$/.test(value) && isValidPort(value);
  }

  if (/(?:版本|version)/i.test(subject) && /^(?:是|为)$/i.test(predicate)) {
    return SAFE_FACT_VERSION.test(value);
  }

  if (/(?:配置|入口|文档|资料|路径|地址|reference|docs?)/i.test(subject) &&
    /^(?:位于|在|地址是|路径是|是|为)$/i.test(predicate) &&
    (value.startsWith("/") || /^https?:\/\//i.test(value))) {
    return isSafeReferenceTarget(value);
  }

  return false;
}

function isValidPort(value: string): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function parsePreference(seed: string): LocalClaim | undefined {
  const regardlessOfProject = /^(?:无论|不论)(?:是)?(?:哪个|哪一个|什么)项目[，,、\s]*(?<subject>我|我们团队|我们|本团队|团队)?\s*(?:都)?(?<predicate>默认用|默认使用|始终用|始终使用|优先用|优先使用|喜欢用|喜欢使用|习惯用|习惯使用|用|使用|采用)\s*(?<value>.+)$/i.exec(seed);
  if (regardlessOfProject?.groups) {
    const { subject, predicate, value: rawValue } = regardlessOfProject.groups;
    const value = stripPreferenceSuffix(rawValue);
    if (isSafePreferenceValue(value, rawValue)) {
      return {
        kind: "preference",
        scope: "global",
        subject: subject ?? "用户",
        predicate,
        value,
        explicitGlobal: true,
      };
    }
  }

  const global = /^(?:以后|今后)?(?<scope>所有项目|每个项目|任何项目|跨项目|全局)(?:中|里)?(?<predicate>都先给|都要使用|都要用|都用|始终使用|默认使用|统一使用|统一用|优先使用|偏好|喜欢|习惯|使用|采用|先给|用)\s*(?<value>.+)$/i.exec(seed);
  if (global?.groups) {
    const { scope, predicate, value: rawValue } = global.groups;
    const value = stripPreferenceSuffix(rawValue);
    if (isSafePreferenceValue(value, rawValue)) {
      return {
        kind: "preference",
        scope: "global",
        subject: scope === "全局" ? "全局" : "项目",
        predicate,
        value,
        explicitGlobal: true,
      };
    }
  }

  const project = /^(?:以后|今后)?(?<subject>本项目|当前项目|这个项目|该项目|本仓库|当前仓库|项目|仓库|代码库)(?<predicate>始终使用|默认使用|统一使用|统一用|优先使用|都要使用|都要用|都用|使用|采用|依赖)\s*(?<value>.+)$/i.exec(seed);
  if (project?.groups) {
    const { subject, predicate, value: rawValue } = project.groups;
    const value = stripPreferenceSuffix(rawValue);
    if (isSafePreferenceValue(value, rawValue)) {
      return { kind: "preference", scope: "project", subject, predicate, value, projectRelative: true };
    }
  }

  const self = /^(?<subject>我|我们团队|本团队|团队|我们)(?<predicate>偏好|喜欢|习惯|优先使用|优先|使用|采用)(?:在(?:这个|本|当前)项目(?:中|里)?(?:使用|用)?)?\s*(?<value>.+)$/i.exec(seed);
  if (!self?.groups) return undefined;
  const { subject, predicate, value: rawValue } = self.groups;
  const value = stripPreferenceSuffix(rawValue);
  if (!isSafePreferenceValue(value, rawValue)) return undefined;
  return { kind: "preference", scope: "project", subject, predicate, value };
}

function stripPreferenceSuffix(value: string): string {
  return value.replace(/\s+安装依赖$/u, "").trim();
}

function isSafePreferenceValue(value: string, rawValue: string): boolean {
  if (!SAFE_PREFERENCE_VALUE.test(value)) return false;
  const suffix = rawValue.slice(value.length).trim();
  return suffix === "" || suffix === "安装依赖";
}

function proposalMatchesLocalParse(proposal: ClaimProposal, local: LocalClaim): boolean {
  return (!local.surfaceSubject || normalizeField(proposal.subject) === normalizeField(local.surfaceSubject)) &&
    normalizeField(proposal.predicate) === normalizeField(local.surfacePredicate ?? local.predicate) &&
    normalizeField(proposal.value) === normalizeField(local.surfaceValue ?? local.value);
}

function normalizeField(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}
