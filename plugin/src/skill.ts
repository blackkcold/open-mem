import type { SkillDraft, SkillInput } from "./types.js";
import { Store, newId } from "./store.js";
import { compact, validateSkillDraft } from "./linter.js";

export function slugify(value: string): string {
  const slug = compact(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "auto-skill";
}

export function buildSkillContent(input: {
  name: string;
  title: string;
  description: string;
  scenario: string;
  references: string[];
}): string {
  const refs =
    input.references.length > 0
      ? input.references.map((ref) => `- \`${ref}\``).join("\n")
      : "- Add concrete file paths, commands, or docs here.";
  return `---
name: ${input.name}
description: "${input.description.replace(/"/g, '\\"')}"
---

# ${input.title}

## Workflow

1. ${input.scenario}
2. Confirm the prerequisites and inputs before acting.
3. Execute the smallest reliable path.
4. Verify the result before reporting.

## References

${refs}

## Verification

- [ ] The workflow completes on a real task.
- [ ] Outputs match the expected shape.
- [ ] No secrets or environment-specific assumptions leaked.

## Pitfalls

- Add the failure modes discovered during the test run.
`;
}

export async function createSkillDraft(store: Store, input: SkillInput): Promise<SkillDraft> {
  const name = slugify(input.name ?? input.title);
  const title = compact(input.title);
  const description =
    compact(input.description ?? "") ||
    `Use when the user needs ${compact(input.scenario)}. Keep the workflow specific and verifiable.`;
  const references = input.references ?? [];
  const content = buildSkillContent({
    name,
    title,
    description,
    scenario: compact(input.scenario),
    references,
  });
  const validation = validateSkillDraft({ name, description, content, references });
  const now = new Date().toISOString();
  const draft: SkillDraft = {
    id: newId("skill"),
    name,
    description,
    status: validation.ok ? "validated" : "draft",
    path: "",
    validation,
    source: input.source,
    createdAt: now,
    updatedAt: now,
  };
  await store.writeSkillDraft(draft, content);
  return { ...draft, path: `${store.skillDraftsDir}/${draft.id}/SKILL.md` };
}

export async function readSkillContent(store: Store, draft: SkillDraft): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(draft.path, "utf8");
}

export async function approveSkillDraft(
  store: Store,
  id: string,
): Promise<{ ok: boolean; path?: string; errors?: string[] }> {
  const draft = await store.readSkillDraft(id);
  if (!draft) return { ok: false, errors: ["draft not found"] };
  const content = await readSkillContent(store, draft);
  const validation = validateSkillDraft({
    name: draft.name,
    description: draft.description,
    content,
  });
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const outbox = await store.writeOutboxSkill(draft.name, content);
  await store.updateSkillDraft(id, { status: "approved", validation }, content);
  return { ok: true, path: outbox };
}

export async function rejectSkillDraft(store: Store, id: string): Promise<boolean> {
  const draft = await store.readSkillDraft(id);
  if (!draft) return false;
  const content = await readSkillContent(store, draft);
  await store.updateSkillDraft(id, { status: "rejected" }, content);
  return true;
}
