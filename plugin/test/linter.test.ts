import { describe, expect, it } from "vitest";
import { lintText, validateSkillDraft } from "../src/linter.js";

describe("lintText", () => {
  it("accepts a concise atomic fact", () => {
    const result = lintText({
      title: "[F] dev server port",
      text: "本地 dev server 端口是 5199。",
      kind: "fact",
      scope: "global",
      maxChars: 200,
      titleMaxChars: 30,
    });
    expect(result.ok).toBe(true);
    expect(result.normalized).toContain("5199");
  });

  it("rejects examples, multiple claims, and overlong text", () => {
    const result = lintText({
      title: "x",
      text: "例如用 nohup 启动。还要用 bun。然后写很多很多很多很多很多很多很多很多很多很多很多很多",
      kind: "rule",
      scope: "global",
      maxChars: 20,
      titleMaxChars: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects secret-like values", () => {
    const result = lintText({
      title: "[F] key",
      text: "api_key=sk-0000000000000000",
      kind: "fact",
      scope: "global",
      maxChars: 200,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("contains a secret-like value");
  });

  it("warns about absolute local paths in global memory", () => {
    const result = lintText({
      title: "[F] path",
      text: "脚本在 /Users/me/project/script.sh。",
      kind: "fact",
      scope: "global",
      maxChars: 200,
    });
    expect(result.warnings.join(" ")).toContain("absolute local path");
  });
});

describe("validateSkillDraft", () => {
  const validContent = `---
name: local-swift-app
description: "Use when building a local Swift app without Xcode."
---

# Local Swift app

## Workflow

1. Run swift build.

## Verification

- [ ] App launches.
`;

  it("accepts a skill with frontmatter, workflow, and verification", () => {
    const result = validateSkillDraft({
      name: "local-swift-app",
      description: "Use when building a local Swift app without Xcode.",
      content: validContent,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects bad names and missing frontmatter", () => {
    const result = validateSkillDraft({
      name: "Local Swift App",
      description: "Something",
      content: "# no frontmatter\n",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
