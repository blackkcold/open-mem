/**
 * Redaction runs before anything leaves the process: tool digests, the review
 * prompt, and the persisted digest cache all see redacted text only.
 */

const PRIVATE_KEY =
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g;
const ASSIGNED_SECRET =
  /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|密钥|密码)\s*[:=]\s*)(?!\[redacted)[^\s"',;]{4,}/gi;
const KNOWN_TOKEN =
  /(?:\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16})/g;
const HIGH_ENTROPY = /\b(?=[A-Za-z0-9+/=_-]{32,}\b)(?=[^\s]*[A-Za-z])(?=[^\s]*[0-9])[A-Za-z0-9+/=_-]{32,}\b/g;
const ABSOLUTE_PATH =
  /(?<=^|\s)(\/(?:Users|home|private|var|tmp|etc|opt|srv)\/[^\s"')`\]]+)/g;

const PLACEHOLDER = "[redacted]";

export interface RedactionResult {
  text: string;
  hits: number;
}

export function redactText(input: string, options: { paths?: boolean } = {}): RedactionResult {
  if (!input) return { text: input, hits: 0 };
  let hits = 0;
  let text = input;

  const replace = (pattern: RegExp, value: string | ((match: string, ...rest: string[]) => string)) => {
    text = text.replace(pattern, (...args: unknown[]) => {
      hits += 1;
      return typeof value === "string" ? value : (value as (...inner: unknown[]) => string)(...args);
    });
  };

  replace(PRIVATE_KEY, "[redacted:private-key]");
  replace(ASSIGNED_SECRET, (_match, prefix: string) => `${prefix}${PLACEHOLDER}`);
  replace(KNOWN_TOKEN, `${PLACEHOLDER}:token`);
  replace(HIGH_ENTROPY, `${PLACEHOLDER}:token`);
  if (options.paths !== false) replace(ABSOLUTE_PATH, `${PLACEHOLDER}:path`);

  return { text, hits };
}

export function redactString(input: string): string {
  return redactText(input).text;
}
