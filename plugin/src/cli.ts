import path from "node:path";
import { Store } from "./store.js";
import { mergeConfig } from "./config.js";
import { runAudit } from "./audit.js";
import { startServer } from "./server.js";
import { createSkillDraft } from "./skill.js";
import { computePriority } from "./priority.js";
import { buildSuggestion } from "./suggestion.js";
import type { AutoMemConfig, Item, JevResult, QueueItem, ShadowRecord } from "./types.js";

interface Flags {
  command: string;
  data?: string;
  port?: number;
  token?: string;
  consoleDir?: string;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const cwd = process.cwd();
  const root = path.basename(cwd) === "plugin" ? path.resolve(cwd, "..") : cwd;
  const dataDir = path.resolve(
    flags.data ?? path.join(root, "tmp", flags.command === "demo" ? "demo-data" : "dev-data"),
  );
  const consoleDir = path.resolve(
    flags.consoleDir ?? process.env.OPENMEM_CONSOLE_DIR ?? path.join(root, "console", "dist"),
  );
  const store = new Store(dataDir);
  await store.init();
  const stored = await store.readConfig();
  const config = mergeConfig(stored, {
    port: flags.port ?? stored.port ?? 47821,
    token: flags.token ?? process.env.OPENMEM_CONSOLE_TOKEN ?? stored.token,
  });
  config.dataDir = dataDir;

  if (flags.command === "audit") {
    const report = await runAudit(store, config);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (flags.command === "seed" || flags.command === "demo") {
    const items = await store.listItems();
    const queue = await store.listQueue();
    if (items.length === 0 && queue.length === 0) {
      await seedDemo(store, config);
      console.log("Seeded demo data.");
    }
  }

  if (flags.command === "seed") {
    console.log(`Data: ${dataDir}`);
    return;
  }

  const token = config.token ?? (await store.ensureToken());
  config.token = token;
  const suggest = async (id: string) => {
    const queue = await store.listQueue();
    const item = queue.find((entry) => entry.id === id);
    if (!item) return undefined;
    const decision = item.decision ?? item.jev;
    if (!decision) return undefined;
    const items = await store.listItems();
    const target = decision.mergeTargetId
      ? items.find((entry) => entry.id === decision.mergeTargetId)
      : undefined;
    return buildSuggestion({ store, config }, item, decision, target);
  };
  const server = await startServer({
    store,
    config,
    token,
    port: config.port,
    consoleDir,
    decisionKeySource: "missing",
    suggest,
  });
  console.log("");
  console.log("OpenMem demo");
  console.log(`URL:  ${server.url}`);
  console.log(`API:  http://127.0.0.1:${server.port}/api/health`);
  console.log(`Data: ${dataDir}`);
  console.log(`Console: ${consoleDir}`);
  console.log("");
  console.log("Press Ctrl+C to stop. Nothing was installed into OpenCode.");
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function seedDemo(store: Store, config: AutoMemConfig): Promise<void> {
  const now = new Date().toISOString();

  const factJev = jev({
    kind: "fact",
    risk: 0.1,
    safeAuto: 0.96,
    duplicate: 0,
    confidence: 0.82,
    strictness: "unknown",
  });
  const prefJev = jev({
    kind: "preference",
    risk: 0.18,
    safeAuto: 0.93,
    duplicate: 0,
    confidence: 0.8,
    strictness: "preference",
  });
  const ruleJev = jev({
    kind: "rule",
    risk: 0.4,
    safeAuto: 0.91,
    duplicate: 0,
    confidence: 0.78,
    strictness: "workflow",
  });

  await appendAuto(
    store,
    config,
    "fact",
    "本地 dev server 端口是 5199",
    "[F] dev server 端口 5199",
    factJev,
  );
  const prefItem = await appendAuto(
    store,
    config,
    "preference",
    "回复先给结论，再给细节",
    "[P] 先给结论",
    prefJev,
  );
  const ruleItem = await appendAuto(
    store,
    config,
    "rule",
    "启动 dev server 时使用 nohup",
    "[R] dev server 用 nohup",
    ruleJev,
  );

  const removalJev = jev({
    kind: "rule",
    risk: 0.92,
    safeAuto: 0.22,
    duplicate: 0,
    confidence: 0.62,
    strictness: "safety",
  });
  const strictJev = jev({
    kind: "rule",
    risk: 0.85,
    safeAuto: 0.3,
    duplicate: 0,
    confidence: 0.81,
    strictness: "strict_limit",
  });
  const duplicateJev = jev({
    kind: "rule",
    risk: 0.4,
    safeAuto: 0.5,
    duplicate: 0.9,
    confidence: 0.93,
    strictness: "workflow",
  });
  const lowPrefJev = jev({
    kind: "preference",
    risk: 0.18,
    safeAuto: 0.7,
    duplicate: 0.6,
    confidence: 0.88,
    strictness: "preference",
  });
  lowPrefJev.mergeAction = "merge_into";
  lowPrefJev.mergeTargetId = prefItem.id;
  duplicateJev.mergeAction = "reject_duplicate";
  duplicateJev.mergeTargetId = ruleItem.id;

  await addQueue(store, config, {
    title: "[R] 移除 nohup 启动规则",
    text: "不要用 nohup 启动 dev server",
    kind: "rule",
    jev: removalJev,
    reason: "high risk: safety · global · 决策 62%",
    suggestedAction: "edit",
  });
  await addQueue(store, config, {
    title: "[R] 回复不超过 50 字",
    text: "回复不超过 50 个字",
    kind: "rule",
    jev: strictJev,
    reason: "high risk: strict_limit · global · 决策 81%",
    suggestedAction: "edit",
  });
  await addQueue(store, config, {
    title: "[R] dev server 用 nohup",
    text: "启动 dev server 时使用 nohup",
    kind: "rule",
    jev: duplicateJev,
    reason: "duplicate/overlap 90%",
    suggestedAction: "deny",
  });
  await addQueue(store, config, {
    title: "[P] 先给结论",
    text: "回复先给结论",
    kind: "preference",
    jev: lowPrefJev,
    reason: "duplicate/overlap 60%",
    suggestedAction: "merge",
  });

  await addShadow(store, {
    title: "[F] Swift 包用 swift build",
    text: "Swift 包用 swift build 构建，不需要 Xcode",
    kind: "fact",
    jev: factJev,
    priority: computePriority(factJev, now, "global").priority,
  });
  await addShadow(store, {
    title: "[P] 文档用中文",
    text: "项目文档默认用中文",
    kind: "preference",
    jev: prefJev,
    priority: computePriority(prefJev, now, "global").priority,
  });

  const draft = await createSkillDraft(store, {
    name: "local-swift-app",
    title: "Local Swift app workflow",
    description:
      "Use when building a local macOS Swift package app without Xcode. Covers swift build, ad-hoc signing, and launch verification.",
    scenario:
      "Build a local Swift package app with swift build, assemble the .app bundle, ad-hoc sign it, and launch it to verify the result.",
    references: ["script/build_and_run.sh", "Package.swift"],
  });
  const content = await store.readSkillDraft(draft.id);
  if (content) {
    await store.updateSkillDraft(
      draft.id,
      { testResult: { ok: true, notes: "Validated on a sample Swift package." } },
      undefined,
    );
  }

  await runAudit(store, config);
}

async function appendAuto(
  store: Store,
  config: AutoMemConfig,
  kind: Item["kind"],
  text: string,
  title: string,
  jevResult: JevResult,
): Promise<Item> {
  const now = new Date().toISOString();
  const { priority, breakdown } = computePriority(jevResult, now, "global");
  const item: Item = {
    id: `item_demo_${Math.random().toString(36).slice(2, 9)}`,
    title,
    text,
    kind,
    scope: "global",
    status: "auto",
    source: { role: "user" },
    createdAt: now,
    updatedAt: now,
    decision: jevResult,
    priority,
    priorityBreakdown: breakdown,
    seenCount: 1,
    lastSeenAt: now,
    sources: [{ role: "user" }],
  };
  if (kind === "rule") await store.appendAutoRule(text, { id: item.id, kind, scope: "global", source: "demo", decision: jevResult.source });
  else await store.appendAutoMemory(text, { id: item.id, kind, scope: "global", source: "demo", decision: jevResult.source });
  await store.appendItem(item);
  return item;
}

async function addQueue(
  store: Store,
  config: AutoMemConfig,
  input: {
    title: string;
    text: string;
    kind: Item["kind"];
    jev: JevResult;
    reason: string;
    suggestedAction: QueueItem["suggestedAction"];
  },
): Promise<void> {
  const now = new Date().toISOString();
  const { priority, breakdown } = computePriority(input.jev, now, "global");
  await store.upsertQueue({
    id: `queue_demo_${Math.random().toString(36).slice(2, 9)}`,
    title: input.title,
    text: input.text,
    kind: input.kind,
    scope: "global",
    status: "queue",
    source: { role: "user" },
    createdAt: now,
    updatedAt: now,
    decision: input.jev,
    priority,
    priorityBreakdown: breakdown,
    reason: input.reason,
    diff: `+ ${input.text}`,
    suggestedAction: input.suggestedAction,
  });
}

async function addShadow(
  store: Store,
  input: { title: string; text: string; kind: Item["kind"]; jev: JevResult; priority: number },
): Promise<void> {
  const record: ShadowRecord = {
    id: `shadow_demo_${Math.random().toString(36).slice(2, 9)}`,
    candidate: input.text,
    title: input.title,
    kind: input.kind,
    scope: "global",
    wouldWriteTo: input.kind === "rule" ? "AUTO_RULES.md" : "AUTO_MEMORY.md",
    wouldApply: 1,
    decision: input.jev,
    priority: input.priority,
    source: { role: "user" },
    createdAt: new Date().toISOString(),
  };
  await store.appendShadow(record);
}

function jev(input: {
  kind: Item["kind"];
  risk: number;
  safeAuto: number;
  duplicate: number;
  confidence: number;
  strictness: JevResult["strictness"];
  mergeAction?: JevResult["mergeAction"];
  mergeTargetId?: string;
}): JevResult {
  return {
    ...input,
    reasons: ["demo fixture"],
    source: "heuristic",
  };
}

function parseFlags(args: string[]): Flags {
  const command = args[0] ?? "demo";
  const flags: Flags = { command };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--data" && next) {
      flags.data = next;
      i++;
    } else if (arg === "--port" && next) {
      flags.port = Number(next);
      i++;
    } else if (arg === "--token" && next) {
      flags.token = next;
      i++;
    } else if (arg === "--console-dir" && next) {
      flags.consoleDir = next;
      i++;
    }
  }
  return flags;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
