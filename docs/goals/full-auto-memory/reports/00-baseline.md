# P00 baseline report

Date: 2026-11-11
Owner: P0 subagent
Status: done
Verdict: baseline green; no code changes; no model calls; no live data access.

## 1. 环境

| 项 | 值 |
|---|---|
| Worktree | `/Users/11169285/.local/share/opencode/worktree/91548720c853e67e562f9f15a753b3403633633e/full-auto-memory` |
| Branch | `feat/full-auto-memory` |
| HEAD | `b992a2e608f3531988f25bca105d9530b5a5174a` |
| HEAD subject | `chore: follow release version and expose build timestamp` |
| Base version | 0.5.0 |
| Platform | darwin |
| Node | v22.22.3 |
| npm | 10.9.8 |
| Lockfiles | `plugin/package-lock.json`, `console/package-lock.json`（未修改） |

## 2. 安装

命令（workdir 分别为 `plugin/`、`console/`）：

```bash
npm ci
```

| 项 | 结果 | 日志 |
|---|---|---|
| plugin | exit 0；318 packages；audit 30 vulnerabilities（27 moderate / 1 high / 2 critical） | `tmp/full-auto-memory/verification/npm-ci-plugin.log` |
| console | exit 0；75 packages | `tmp/full-auto-memory/verification/npm-ci-console.log` |

说明：audit 数字来自现有 lockfile 的依赖树，不是本目标引入；P01–P07 不新增依赖、不执行 `npm audit fix`（会改 lockfile）。

## 3. 完整验证

命令（worktree 根）：

```bash
npm run verify > tmp/full-auto-memory/verification/verify-baseline.log 2>&1
echo "exit=$?"
```

`verify` 链：`npm test && npm run typecheck && npm run build && npm run build:extension && npm run test:extension && git diff --check`。

| 项 | 结果 |
|---|---|
| 总退出码 | **0** |
| Vitest | **63 files passed / 803 tests passed** |
| Duration | 52.00s（transform 1.31s / collect 4.60s / tests 394.31s） |
| Plugin typecheck | 通过 |
| Console typecheck | 通过 |
| Extension typecheck | 通过 |
| Plugin build | 通过 |
| Console build | 通过（54 modules；index 415.26 kB，gzip 125.10 kB） |
| Extension bundles | page 514.0kb / panel 324.0kb / status 55.5kb / service 15.0kb |
| Extension proxy test | `service proxy tests passed` |
| `git diff --check` | 通过 |

原始日志：`tmp/full-auto-memory/verification/verify-baseline.log`（446 行）。

从该日志直接读到的原文（未重跑）：

```text
 Test Files  63 passed (63)
      Tests  803 passed (803)
exit=0
```

`npm ci` 日志末尾：

```text
npm-ci-plugin.log:  added 318 packages, and audited 319 packages in 46s
npm-ci-console.log: added 75 packages, and audited 76 packages in 17s
npm-ci-plugin.log / npm-ci-console.log: exit=0
```

## 4. 工作树状态

- `git status --short` 为空。
- 新增文档（本目标）之后才会出现 `docs/goals/full-auto-memory/**` 与 `reports/00-baseline.md` 的未跟踪/修改状态；`tmp/`、`node_modules/`、`dist/` 均被 `.gitignore` 忽略。
- 无提交、无推送、无 tag。

## 5. 只读代码核对（与任务相关）

以下为现状记录，用于 P01/P02 定位；**不是根因结论**，也不替代实现阶段的验证。

| 位置 | 现状 | 归属 |
|---|---|---|
| `plugin/src/consolidate.ts` `canAutoApply` | 对 `rule`/`session-review`/`session` 返回 false；`autoRules` 字段存在但规则仍不自动 | P01/P03 |
| `plugin/src/consolidate.ts` auto 写入（约 541 行） | 写 auto view + item + changelog，但无与 item 同事务的变更 journal | P01 |
| `plugin/src/plugin.ts` `refreshContext`（约 1013 行） | pinned block 仅在缺失/projectKey 不匹配时重建；撤销不会失效 | P01 |
| `plugin/src/server.ts` `/api/items`（约 831 行） | 只有 GET 列表；无版本/变更/撤销接口 | P01 |
| `plugin/src/review/provider.ts`（约 151 行） | 直接拼 `${endpoint}/api/chat`，未使用 `rewrite.transport`；429 不按状态重试；空返回抛通用 Error | P02 |
| `plugin/src/review/provider.ts` / `orchestrator.ts` | run 预算（`takeReviewSlot`）与 request 预算（`takeModelSlot`）都受 `review.maxPerHour` 影响，语义混杂 | P02 |
| `plugin/src/review/orchestrator.ts` `recover()`（约 183 行） | 遍历共享 state 的所有 session，未按 project 归属过滤 | P02 |
| `plugin/src/review/accept.ts`（约 163 行） | project 候选使用当前实例 `deps.projectKey` | P02 |
| `plugin/src/plugin.ts` `status` | 只 `readAudit`，不 `runAudit`；这是正确现状，P02 保持并补只读字段 | P02 |
| `plugin/src/util/lock.ts` | 已检查 live PID（`kill(pid,0)`，EPERM 视为 live）并防 stale 抢占；**不是缺陷** | 保留 |
| `plugin/src/store.ts` | 已有事务、redo WAL、maintenance/recovery journal、target version；P01 复用 | 保留 |

## 6. 动机背景（不作根因）

任务上下文给出的历史观测：active 0、shadow=true、queue 50（session 34）、review failed 225 / ready 28 / skipped 155。本阶段**未重新读取真实数据**，因此这些数字只说明“需要先补可逆性与运行时可靠性”的产品动机，不能据此断定任何单一根因。P01/P02 的缺陷判断来自代码只读核对，不来自这些统计。

## 7. 未做与边界

- 未运行任何真实/付费模型调用（System One / System Two / Review 均未触发）。
- 未读取或写入 `~/.config/opencode/memory/autopilot`。
- 未修改 `~/.config/opencode`、skills、agents、正式仓库。
- 未验证正式安装、live OpenCode 会话、真实 UI。
- 未执行 30 天现场运行；未来 `soak-30d` 是模拟。
- 未提交/推送/发布。

## 8. 结论

基线可复现且全绿（exit 0，63 files / 803 tests）。P00 退出条件满足，可以进入 P01。环境错误与代码失败已区分：本次没有失败；audit 漏洞警告属于现有依赖树，未在本目标处理。
