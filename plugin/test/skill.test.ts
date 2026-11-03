import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { approveSkillDraft, createSkillDraft } from "../src/skill.js";
import { validateSkillDraft } from "../src/linter.js";

describe("skill drafts", () => {
  it("creates and approves a valid draft into outbox, never live skills", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-skill-"));
    try {
      const store = new Store(dir);
      await store.init();
      const draft = await createSkillDraft(store, {
        name: "local-swift-app",
        title: "Local Swift app workflow",
        description: "Use when building a local macOS Swift app without Xcode.",
        scenario: "Build a Swift package app with swift build and ad-hoc codesign.",
        references: ["script/build_and_run.sh"],
      });
      expect(draft.validation.ok).toBe(true);
      const result = await approveSkillDraft(store, draft.id);
      expect(result.ok).toBe(true);
      expect(result.path).toContain("outbox/skills");
      expect(result.path).not.toContain(".config/opencode/skills");
      const content = await readFile(result.path as string, "utf8");
      expect(content).toContain("name: local-swift-app");
      expect(content).toContain("## Workflow");
      expect(content).toContain("## Verification");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags a malformed skill", () => {
    const result = validateSkillDraft({
      name: "Bad Name",
      description: "no trigger",
      content: "# no frontmatter\n",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
