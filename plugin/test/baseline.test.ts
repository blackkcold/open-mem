import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  analyzeBaselineCoverage,
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

  it("treats a shared heading with unrelated bodies as related, not covered", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-baseline-title-"));
    try {
      const opencodeDir = path.join(dir, "opencode");
      await write(
        path.join(opencodeDir, "AGENTS.md"),
        "# Docs\n\n## 部署检查\n\n周五下午进行代码评审。\n",
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
      const matches = matchBaseline(index, {
        text: "部署前先备份数据库",
        title: "部署检查",
        scope: "global",
      });
      expect(matches[0]?.relation).toBe("related");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses a section kind from frontmatter to surface a classification mismatch", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-baseline-kind-"));
    try {
      const opencodeDir = path.join(dir, "opencode");
      await write(
        path.join(opencodeDir, "AGENTS.md"),
        "---\nkind: rule\n---\n\n# Rules\n\n## 端口\n\n本地 dev server 端口是 5199。\n",
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
      const matches = matchBaseline(index, {
        text: "本地 dev server 端口是 5199",
        kind: "fact",
        scope: "global",
      });
      expect(matches[0]?.relation).toBe("classification-mismatch");
      expect(matches[0]?.line).toBe(7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("summarizes all matches before slicing and keeps one analysis version per content", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-baseline-summary-"));
    try {
      const opencodeDir = path.join(dir, "opencode");
      const file = path.join(opencodeDir, "AGENTS.md");
      await write(
        file,
        [
          "# Rules",
          "## 冲突",
          "本地端口是 5199，使用 nohup。",
          "## 覆盖一",
          "本地端口是 5198，使用 nohup 并检查端口。",
          "## 覆盖二",
          "本地端口是 5198，使用 nohup 并检查日志。",
          "## 覆盖三",
          "本地端口是 5198，使用 nohup 并确认目录。",
          "## 覆盖四",
          "本地端口是 5198，使用 nohup 并记录日志。",
        ].join("\n\n"),
      );
      const roots = {
        opencodeDir,
        openchamberDir: path.join(dir, "openchamber"),
        backupRoot: path.join(dir, "backups"),
        logicChainDir: path.join(dir, "logic"),
      };
      const index = await buildBaselineIndex({ projectDir: undefined, force: true, roots });
      const candidate = { text: "本地端口是 5198，使用 nohup", scope: "global" as const };
      const analysis = analyzeBaselineCoverage(index, candidate);
      expect(analysis.matches).toHaveLength(5);
      expect(analysis.summary).toMatchObject({
        relation: "conflict",
        conflictCount: 1,
        coveredCount: 4,
        total: 5,
      });
      expect(matchBaseline(index, candidate)).toHaveLength(3);
      expect(matchBaseline(index, candidate)[0]?.relation).toBe("conflict");

      const rebuilt = await buildBaselineIndex({ projectDir: undefined, force: true, roots });
      expect(analyzeBaselineCoverage(rebuilt, candidate).summary.analysisVersion).toBe(
        analysis.summary.analysisVersion,
      );
      await write(file, `${await readFile(file, "utf8")}\n\n## 新增\n全新内容。\n`);
      const changed = await buildBaselineIndex({ projectDir: undefined, force: true, roots });
      expect(analyzeBaselineCoverage(changed, candidate).summary.analysisVersion).not.toBe(
        analysis.summary.analysisVersion,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports the file cap instead of presenting a partial index as ready", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-baseline-cap-"));
    try {
      const opencodeDir = path.join(dir, "opencode");
      const memory = path.join(opencodeDir, "memory");
      await mkdir(memory, { recursive: true });
      for (let index = 0; index < 201; index += 1) {
        await writeFile(path.join(memory, `rule-${index}.md`), "# H\n\ncontent\n", "utf8");
      }
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
      const status = baselineStatus(index);
      expect(status.filesSeen).toBe(201);
      expect(status.filesIndexed).toBe(200);
      expect(status.filesSkipped).toBe(1);
      expect(status.maxFiles).toBe(200);
      expect(status.state).toBe("partial");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records a truncated read and an empty baseline separately", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-baseline-truncate-"));
    try {
      const opencodeDir = path.join(dir, "opencode");
      await write(
        path.join(opencodeDir, "AGENTS.md"),
        `# Rules\n\n## 大文件\n\n${ "x".repeat(300 * 1024) }`,
      );
      const roots = {
        opencodeDir,
        openchamberDir: path.join(dir, "openchamber"),
        backupRoot: path.join(dir, "backups"),
        logicChainDir: path.join(dir, "logic"),
      };
      const index = await buildBaselineIndex({ projectDir: undefined, force: true, roots });
      const status = baselineStatus(index);
      expect(status.truncatedFiles).toBe(1);
      expect(status.state).toBe("partial");

      const empty = await buildBaselineIndex({
        projectDir: undefined,
        force: true,
        roots: { ...roots, opencodeDir: path.join(dir, "empty-opencode") },
      });
      expect(baselineStatus(empty).state).toBe("empty");
      expect(baselineStatus(empty).filesSeen).toBe(0);
      expect(baselineStatus(empty).projectCoverageState).toBe("not-configured");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks an old index stale without rebuilding it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-baseline-stale-"));
    try {
      const opencodeDir = path.join(dir, "opencode");
      await write(path.join(opencodeDir, "AGENTS.md"), "# Rules\n\n## 规范\n\n回复先给结论。\n");
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
      const stale = baselineStatus({
        ...index,
        builtAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      });
      expect(stale.state).toBe("stale");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("applies the file cap across the global and project scans", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-baseline-cross-cap-"));
    try {
      const opencodeDir = path.join(dir, "opencode");
      const projectDir = path.join(dir, "project");
      const globalMemory = path.join(opencodeDir, "memory");
      const projectMemory = path.join(projectDir, ".memory");
      await mkdir(globalMemory, { recursive: true });
      await mkdir(projectMemory, { recursive: true });
      for (let index = 0; index < 150; index += 1) {
        await writeFile(path.join(globalMemory, `g-${index}.md`), "# G\n\nx\n", "utf8");
      }
      for (let index = 0; index < 60; index += 1) {
        await writeFile(path.join(projectMemory, `p-${index}.md`), "# P\n\nx\n", "utf8");
      }
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
      const status = baselineStatus(index);
      expect(status.filesSeen).toBe(210);
      expect(status.filesIndexed).toBe(200);
      expect(status.filesSkipped).toBe(10);
      expect(status.state).toBe("partial");
      expect(status.projectCoverageState).toBe("partial");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
