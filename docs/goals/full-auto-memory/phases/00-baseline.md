# P00 — baseline

Status: done
Date: 2026-11-11
Owner: P0 subagent
Evidence: `docs/goals/full-auto-memory/reports/00-baseline.md`

## 目标

在不改产品代码的前提下，建立可复现的隔离基线：记录 HEAD/环境、安装现有依赖、跑完整 `npm run verify`、保存原始日志与退出码，并只读核对与本目标相关的现状。

## 输入

- Worktree: `/Users/11169285/.local/share/opencode/worktree/91548720c853e67e562f9f15a753b3403633633e/full-auto-memory`
- Branch: `feat/full-auto-memory`
- HEAD: `b992a2e608f3531988f25bca105d9530b5a5174a` (v0.5.0)
- 现有 lockfile: `plugin/package-lock.json`、`console/package-lock.json`

## 步骤

```bash
mkdir -p tmp/full-auto-memory/verification

# 只使用现有 lockfile
npm ci   # workdir=plugin
npm ci   # workdir=console

# 完整工程门禁
npm run verify   # workdir=worktree 根
```

所有输出重定向到 `tmp/full-auto-memory/verification/`，并追加 `exit=<code>`。

## 结果

| 项 | 结果 |
|---|---|
| Node / npm | `v22.22.3` / `10.9.8` |
| plugin `npm ci` | exit 0，318 packages |
| console `npm ci` | exit 0，75 packages |
| `npm run verify` | exit 0 |
| Vitest | 63 files passed / 803 tests passed |
| Duration | 52.00s |
| plugin/console/extension typecheck | 通过 |
| plugin/console build | 通过 |
| extension bundles | page 514.0kb / panel 324.0kb / status 55.5kb / service 15.0kb |
| extension proxy test | passed |
| `git diff --check` | 通过 |
| 源代码改动 | 无；`git status --short` 为空 |

日志：

```text
tmp/full-auto-memory/verification/npm-ci-plugin.log
tmp/full-auto-memory/verification/npm-ci-console.log
tmp/full-auto-memory/verification/verify-baseline.log
```

## 只读核对（不构成根因结论）

- 文件锁已有 live PID 检测与 stale 抢占（`plugin/src/util/lock.ts`）；不是缺陷。
- `status` 只 `readAudit`，不触发 `runAudit`；保持。
- 自动写入缺少同事务变更 journal；P01 处理。
- `refreshContext` 的 pinned block 不会因撤销失效；P01 处理。
- review provider 未使用 `rewrite.transport`、429 重试范围过窄、空返回通用 Error；P02 处理。
- `recover()`/`accept.ts` 的 projectKey 归属问题；P02 处理。
- 历史数据（active 0 / shadow true / queue 50 等）只是动机背景，未重新读取，不作为根因。

## 未做

- 未运行任何真实/付费模型调用。
- 未读取 `~/.config/opencode/memory/autopilot`。
- 未修改正式仓库、`~/.config/opencode`、skills/agents。
- 未提交、未推送、未发布。
- 未验证正式安装或 live OpenCode 会话。

## 退出条件

- [x] 基线可复现、日志留盘、退出码明确。
- [x] 环境错误与代码失败已区分（本次无失败）。
- [x] 工作树无源代码改动。
- [x] P01 的输入（Store/Item/context/server 现状）已定位到文件/函数。
