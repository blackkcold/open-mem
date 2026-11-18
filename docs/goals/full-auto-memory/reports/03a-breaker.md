# P03-A breaker / safe rollback report

Status: **P03-A 三轮修复仍未通过；已安全撤回 A 产品变更到最后已验收 P02 基线。P03 安全停止，待用户决定。**
Date: 2026-11-11
Scope: 仅 A 自有 8 个产品/测试文件的回滚与证据归档；不是 fix4，不继续实现功能。

## 1. 为什么停止

独立审查 `reports/03a-review.md` §8.3/§9.2/§10：

- 第 1 轮 F01–F11/Q01 后仍有 F12/F13/F14；
- 第 2 轮修 F12/F13/F14 后仍有 F15/F16；
- 第 3 轮修 F15/F16 后，F16 已闭合，但 F15 仍因 **F17** 未闭合：`workflowClauseSafe` 在子句没有带目标的敏感动作时第 100 行直接 `return true`，导致 `上线前先跑测试随后部署`、`删库前先备份随后删除`、`上线前先跑测试，直接部署`、`删库前先备份，直接删除` 仍为 `preference/descriptive` → route `auto`。
- 根因不是少几个词，而是“安全准备子句的剩余部分/后续独立子句”在无敏感目标时早退，执行动词裸形式未被检查。3 轮后仍未闭合，按开发者硬规则 breaker：停止修复、回滚、报告、请用户决定。

**1031 tests 曾全绿不构成策略通过**：F17 正是无目标执行尾缺少断言导致的真实安全误放行。A 未验收，B 未启动。

## 2. 回滚清单

归档（唯一目录）：`tmp/full-auto-memory/reviews/p03a-breaker-20261111-202537/`

| 原路径 | 处置 |
|---|---|
| `plugin/src/types.ts` | 先复制到归档 `current/`，再用 `restore-types.patch` 恢复为 `p03a-before` 内容 |
| `plugin/src/config.ts` | 先复制到归档 `current/`，再用 `restore-config.patch` 恢复为 `p03a-before` 内容 |
| `plugin/src/automation.ts` | 移入归档 `current/plugin/src/` |
| `plugin/src/memory/sources.ts` | 移入归档 `current/plugin/src/memory/` |
| `plugin/src/memory/supersede.ts` | 移入归档 `current/plugin/src/memory/` |
| `plugin/test/automation.test.ts` | 移入归档 `current/plugin/test/` |
| `plugin/test/automation-sources.test.ts` | 移入归档 `current/plugin/test/` |
| `plugin/test/automation-supersede.test.ts` | 移入归档 `current/plugin/test/` |

归档还保留：`patches/p03a.patch`、`p03a-fix1.patch`、`p03a-fix2.patch`、`p03a-fix3.patch`；`evidence/03a-review.md`、`03a-policy.md`；`MANIFEST.md`（含 8 文件 sha256）。

未动：P01/P02 全部既有源码、测试、未提交状态；`p03a-before`、fix1/2/3-before 快照、所有日志、设计/计划/报告/审查。未使用 `rm`、`git reset`、`git clean`、`git checkout`、提交或推送。

## 3. 实际验证

| 检查 | 命令 | 原始结果 | Exit |
|---|---|---|---|
| src 基准一致 | `diff -rq tmp/full-auto-memory/reviews/p03a-before/plugin/src plugin/src` | 无输出 | 0 |
| test 基准一致 | `diff -rq tmp/full-auto-memory/reviews/p03a-before/plugin/test plugin/test` | 无输出 | 0 |
| types/config 恢复 | `cmp -s` 对 `p03a-before` 两文件 | 均 exit 0 | 0 |
| 完整门禁 | `npm run verify` | `Test Files 73 passed (73)` / `Tests 926 passed (926)`；typecheck/build/extension proxy 全过 | 0 |
| diff 清洁 | `git diff --check` | 无输出 | 0 |

日志：`tmp/full-auto-memory/verification/verify-p03a-rollback.log`（原始完整日志）/ `.exit`（`exit=0`）。
A 失败阶段证据：`p03a-fix3-red.log`（3 failed | 102 passed）、`verify-p03a-fix3.log`（76 files / 1031 tests）等均保留，未删除。

## 4. 现状与边界

- 产品 `plugin/src`、`plugin/test` 与 `p03a-before`（最后已验收 P02）完全一致；P01/P02 未提交改动保留。
- A 未验收；B/C1/C2/D/E 未启动；P02 followups（N1–N6 等）仍未做，不能顺便修。
- `p03a-before`、`p03a.patch`、fix1/2/3 patch、before snapshots、全部日志、设计/计划/报告/审查均保留，可恢复。
- 未触碰正式插件目录/配置/真实记忆/凭证/数据；未安装、提交、推送、发布；未删除 worktree 或证据。
- P03 未完成。后续需用户决定：是否重开 A（仅 F15/F17 窄修）或调整范围；本轮不擅自继续，也不开第四轮。

## 5. 关键 ID

- P03-A author（本块唯一 writer）：`ses_e359f6b15ffeZEmQM4ApfvQmmd`
- P03-A reviewer：`ses_e35976778ffeml1Cxn7TsWVmBO`
- P02 author / reviewer：`ses_e36134397ffeC1p765rU6H7wes` / `ses_e35c4ad4cffeHKSlDvkNXIb1I5`
