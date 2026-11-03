import type { Item } from "./types.js";
import type { Store } from "./store.js";

/**
 * AUTO_MEMORY.md and AUTO_RULES.md are generated views. items.jsonl is the
 * source of truth, so compaction can rewrite the files without losing entries.
 */
export async function rebuildAutoFiles(
  store: Store,
): Promise<{ memory: number; rules: number }> {
  const items = (await store.listItems()).filter(
    (item) => item.status === "auto" || item.status === "promoted",
  );
  const memoryItems = items.filter((item) => item.kind !== "rule" && item.kind !== "skill");
  const ruleItems = items.filter((item) => item.kind === "rule");

  await store.writeAutoView(
    render("# AUTO_MEMORY", memoryItems),
    render("# AUTO_RULES", ruleItems),
  );
  return { memory: memoryItems.length, rules: ruleItems.length };
}

function render(header: string, items: Item[]): string {
  const lines = [
    header,
    "",
    "<!-- Generated from items.jsonl. Curated AGENTS.md and memory/*.md win. -->",
    "",
  ];
  for (const item of sortItems(items)) {
    lines.push(`<!-- id: ${item.id} · ${item.scope} · ${item.kind} -->`);
    lines.push(`- ${item.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

function sortItems(items: Item[]): Item[] {
  return [...items].sort((left, right) => {
    const byScope = left.scope.localeCompare(right.scope);
    if (byScope !== 0) return byScope;
    const byKind = left.kind.localeCompare(right.kind);
    if (byKind !== 0) return byKind;
    const byPriority = (right.priority ?? 0) - (left.priority ?? 0);
    if (byPriority !== 0) return byPriority;
    return left.createdAt.localeCompare(right.createdAt);
  });
}
