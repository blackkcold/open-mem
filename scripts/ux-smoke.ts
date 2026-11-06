/** Isolated UX fixture. Never opens the real autopilot directory or calls a model. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../plugin/src/store.js";
import { mergeConfig } from "../plugin/src/config.js";
import { startServer } from "../plugin/src/server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, "tmp"), { recursive: true });
const dataDir = await mkdtemp(path.join(root, "tmp", "ux-smoke-"));
const store = new Store(dataDir);
await store.init();
const graphRoot = path.join(dataDir, "graph");
const projectDir = path.join(dataDir, "project");
await mkdir(path.join(graphRoot, "opencode", "memory"), { recursive: true });
await mkdir(path.join(graphRoot, "openchamber"), { recursive: true });
await mkdir(path.join(graphRoot, "backups"), { recursive: true });
await mkdir(path.join(graphRoot, "backups", "backup-2026-11-06_0300", "global-entry"), { recursive: true });
await mkdir(path.join(graphRoot, "backups", "backup-2026-11-06_0300", "global-memory", "autopilot"), { recursive: true });
await mkdir(path.join(graphRoot, "backups", "backup-2026-11-06_0300", "openchamber-memory"), { recursive: true });
await mkdir(path.join(graphRoot, "backups", "backup-2026-11-06_0300", "project-memory", "demo"), { recursive: true });
await writeFile(path.join(graphRoot, "backups", "backup-2026-11-06_0300", "global-entry", "AGENTS.md"), "# 合成备份\n");
await writeFile(path.join(graphRoot, "backups", "backup-2026-11-06_0300", "global-memory", "autopilot", "items.jsonl"), "{}\n");
await writeFile(path.join(graphRoot, "backups", "backup-2026-11-06_0300", "openchamber-memory", "global.json"), "{}\n");
await mkdir(path.join(graphRoot, "logic"), { recursive: true });
await mkdir(path.join(projectDir, ".memory"), { recursive: true });
await writeFile(
  path.join(graphRoot, "opencode", "AGENTS.md"),
  "# 合成 AGENTS\n\n## Root Trigger Matrix\n\n| Task Signal | Must Read |\n| --- | --- |\n| 删除、部署 | `memory/SAFETY_RULES.md` |\n| 导出文档 | `memory/FILE_OUTPUT_RULES.md` |\n\n## 输出规范\n\n回复先给结论，再给细节。\n",
);
await writeFile(path.join(graphRoot, "opencode", "memory", "SAFETY_RULES.md"), "# Safety\n");
await writeFile(path.join(graphRoot, "opencode", "memory", "FILE_OUTPUT_RULES.md"), "# File output\n");
await writeFile(path.join(projectDir, ".memory", "PROJECT.md"), "# 合成项目规则\n");
await writeFile(path.join(graphRoot, "logic", "README.md"), "# 合成逻辑链图\n");
const config = mergeConfig({ shadow: true, decision: { kind: "heuristic" }, review: { enabled: false }, rewrite: { enabled: false } });
await store.writeConfig(config);
const at = new Date().toISOString();
for (const entry of [
  { id: "ux-session", title: "项目输出习惯", text: "这个项目回复先给结论", kind: "preference" as const, scope: "session" as const, projectKey: "ux-project", project: "UX 合成项目" },
  { id: "ux-skill", title: "排查流程", text: "先检查日志，再运行测试验证修复", kind: "skill" as const, scope: "project" as const, projectKey: "ux-project", project: "UX 合成项目" },
  { id: "ux-deferred", title: "中文偏好", text: "回复使用中文", kind: "preference" as const, scope: "global" as const, deferredUntil: new Date(Date.now() + 86_400_000).toISOString() },
  { id: "ux-project-b", title: "项目 B 输出", text: "这个项目使用英文小标题", kind: "preference" as const, scope: "project" as const, projectKey: "ux-project-b", project: "UX 项目 B" },
]) await store.upsertQueue({ ...entry, status: "queue", source: { sessionID: "ux-session", role: "user" }, createdAt: at, updatedAt: at, reason: "仅用于 UX 验证的合成数据", priority: 50 });
for (const entry of [
  { id: "ux-dup-a", title: "重复偏好 A", text: "回复先给结论" },
  { id: "ux-dup-b", title: "重复偏好 B", text: "回复先给结论" },
]) {
  await store.appendItem({
    ...entry,
    kind: "preference",
    scope: "global",
    status: "auto",
    source: { sessionID: "ux-session", role: "user" },
    createdAt: at,
    updatedAt: at,
  });
}
await store.appendReview({ id: "review_ux", sessionID: "ux-session", projectKey: "ux-project", status: "ready", createdAt: at, candidates: 0, dropped: 0,
  sessionNotes: [{ type: "preference", text: "输出先简述结论", createdAt: at, evidence: [{ messageID: "ux-m1", quote: "先简述结论", kind: "user" }] }] });
await mkdir(path.join(dataDir, "recovery"), { recursive: true });
for (let i = 0; i < 25; i++) await writeFile(path.join(dataDir, "recovery", `recovery_fixture_${i}.json`), JSON.stringify({ id: `recovery_fixture_${i}`, at: new Date(Date.now() - (120 + i) * 86_400_000).toISOString(), restored: true }));
await store.writeState({ sessions: { "ux-archived-session": { lastRunAt: new Date(Date.now() - 91 * 86_400_000).toISOString(), lastScannedMessageID: "ux-old-cursor" } } });
const server = await startServer({ store, config, token: "openmem-ux-fixture", port: Number(process.env.OPENMEM_UX_PORT ?? 47839), consoleDir: path.join(root, "console", "dist"), projectDir,
  graphRoots: {
    opencodeDir: path.join(graphRoot, "opencode"),
    openchamberDir: path.join(graphRoot, "openchamber"),
    backupRoot: path.join(graphRoot, "backups"),
    logicChainDir: path.join(graphRoot, "logic"),
  },
});
const connectURL = server.createConnectURL();
await writeFile(path.join(root, "tmp", "ux-smoke-current.json"), JSON.stringify({ pid: process.pid, dataDir, port: server.port, connectURL, synthetic: true }));
await writeFile(path.join(dataDir, "fixture.json"), JSON.stringify({ pid: process.pid, port: server.port, synthetic: true }));
console.log(`Synthetic UX fixture: ${connectURL}\nData: ${dataDir}\nPID: ${process.pid}`);
let closing = false;
const close = async () => { if (closing) return; closing = true; clearTimeout(expiry); await server.close(); process.exit(0); };
const expiry = setTimeout(() => void close(), 15 * 60_000);
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
