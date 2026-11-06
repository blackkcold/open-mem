import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  baselineStatus,
  buildBaselineIndex,
  matchBaseline,
} from "../src/baseline.js";
import { sha16 } from "../src/util/text.js";

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

describe("baseline coverage", () => {
  it("matches curated sections and keeps project baselines isolated", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-baseline-"));
    try {
      const opencodeDir = path.join(dir, "opencode");
      const projectDir = path.join(dir, "project");
      await write(
        path.join(opencodeDir, "AGENTS.md"),
        "# Global\n\n## 输出规范\n\n回复先给结论，再给细节。\n",
      );
      await write(path.join(opencodeDir, "memory", "GLOBAL.md"), "# Global memory\n");
      await write(
        path.join(projectDir, ".memory", "PROJECT.md"),
        "# 项目规则\n\n这个项目使用 pnpm 安装依赖。\n",
      );

      const index = await buildBaselineIndex({
        projectDir,
        force: true,
        roots: {
          opencodeDir,
          openchamberDir: path.join(dir, "openchamber"),
          backupRoot: path.join(dir, "backups"),
          logicChainDir: path.join(dir, "logic"),
        },
      });
      expect(baselineStatus(index).state).toBe("ready");

      const globalMatches = matchBaseline(index, {
        text: "回复先给结论",
        scope: "global",
      });
      expect(globalMatches[0]?.heading).toBe("输出规范");
      expect(globalMatches[0]?.relation).toBe("covered");

      const projectKey = sha16(projectDir);
      const projectMatches = matchBaseline(index, {
        text: "这个项目使用 pnpm",
        scope: "project",
        projectKey,
      });
      expect(projectMatches.some((match) => match.source.endsWith("PROJECT.md"))).toBe(true);
      expect(projectMatches[0]?.relation).toBe("covered");

      const foreignProject = matchBaseline(index, {
        text: "这个项目使用 pnpm",
        scope: "project",
        projectKey: "another-project",
      });
      expect(foreignProject.some((match) => match.source.endsWith("PROJECT.md"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces numeric and negation differences instead of calling them covered", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-baseline-conflict-"));
    try {
      const opencodeDir = path.join(dir, "opencode");
      await write(
        path.join(opencodeDir, "AGENTS.md"),
        "# Rules\n\n## 端口\n\n本地 dev server 端口是 5199。\n\n## 启动\n\n启动 dev server 时使用 nohup。\n",
      );
      const index = await buildBaselineIndex({
        projectDir: undefined,
        force: true,
        roots: {
          opencodeDir,
          openchamberDir: path.join(dir, "openchamber"),
          backupRoot: path.join(dir, "backups"),
          logicChainDir: path.join(dir, "logic"),
        },
      });
      const port = matchBaseline(index, { text: "本地 dev server 端口是 5198", scope: "global" });
      expect(port[0]?.relation).toBe("conflict");
      const negation = matchBaseline(index, {
        text: "启动 dev server 时不要使用 nohup",
        scope: "global",
      });
      expect(negation[0]?.relation).toBe("conflict");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
