# OpenMem 全自动记忆 · ACCEPTANCE

Version: 1.0
Status: active
Baseline: `b992a2e`

本文件是阶段验收门禁。任何“完成”都必须能指向命令输出、测试名或文件证据；没有证据就写“未验证”。

## 0. 全局门禁（每阶段都必须满足）

| ID | 判据 | 验证 |
|---|---|---|
| G0 | 只在当前 worktree 改动；无提交/推送/发版 | `git status`、`git log -1` |
| G1 | 不修改 `~/.config/opencode`、skills、agents、正式数据 | 命令日志/路径断言 |
| G2 | 不读写 `~/.config/opencode/memory/autopilot` 与正式仓库 | 脚本拒绝逻辑 + 测试 |
| G3 | 测试只用 `mkdtemp`/`tmp/full-auto-memory` | 测试代码审查 |
| G4 | 无 `as any`、`@ts-ignore`、`@ts-expect-error` | `grep -rn` |
| G5 | 无新重依赖；lockfile 未改 | `git diff --stat`、`npm ci` |
| G6 | `npm run verify` exit 0 | 日志 |
| G7 | 原测试数量不减少、断言不降低 | 测试文件对比 |
| G8 | WAL/事务/文件锁/target-version/安全守卫保留 | 相关测试全绿 |
| G9 | 无付费模型调用 | 测试 fake/无 key；日志无外呼 |
| G10 | 文档与实现一致；签名变更先改 DESIGN | 审查 |
| G11 | 不声称 30 天真实运行/正式迁移/已发布 | 文案审查 |

## 1. P00 baseline

- [x] HEAD/分支/worktree 记录。
- [x] Node/npm、`npm ci`、`npm run verify` 实际退出码与日志。
- [x] 63 files / 803 tests 全绿；typecheck/build/extension 通过。
- [x] 工作树无源代码改动。
- [x] 环境错误与代码失败区分；本次无失败。
- [x] 无模型调用、无真实数据访问。
- [x] 共享文件/接口冲突预检与裁决：`docs/goals/full-auto-memory/reports/00-preflight.md`。
- 证据：`docs/goals/full-auto-memory/reports/00-baseline.md`、`docs/goals/full-auto-memory/reports/00-preflight.md`、`tmp/full-auto-memory/verification/verify-baseline.log`。

## 2. P01 reversible-memory

### 必过测试（新增，名称可调整但语义不可弱化）

| 测试 | 断言 |
|---|---|
| `changes.test.ts` | 自动/人工批准/合并/替换/提升/legacy undoMerge/curator/session-note promotion 都产生事件；`itemVersion` 与无损快照一致 |
| `changes.test.ts` | 事件写失败 → item 不落盘（事务） |
| `changes.test.ts` | `before`/`after` 为全量 Item 快照，恢复不丢 id/status/来源/派生字段 |
| `revert.test.ts` | 自动新增被撤销后 item archived、事件 kind=revert、同源 hook 被抑制 |
| `revert.test.ts` | `expectedVersion` 不符 → 409，无写入；不提供“仅恢复文本” |
| `restore.test.ts` | 旧版本恢复为新版本；不覆盖后续编辑；无快照拒绝 |
| `restore.test.ts` | 默认 90 天保留（`undo.retainDays` 可配）；超期只允许停止使用，不能恢复旧正文 |
| `derived.test.ts` | A→B→C 递归；撤销 A 后 B/C 停止注入；环保护不无限循环；上游无效时拒绝恢复 |
| `suppression.test.ts` | 同 message/quote 不再重学；新 message 可学；restore 清除抑制 |
| `context-version.test.ts` | 变更后下一次 refresh 注入新内容；未变更 20 轮**稳定 prefix** 不 `entry.put` |
| `context-version.test.ts` | **旧 session** 在下一次模型请求排除被停止使用/撤销的记忆；已开始请求不追回 |
| `context-version.test.ts` | 无写入、仅时间跨过 `expiresAt` → version 改变、block 排除；不只靠 mtime/size |
| `context-version.test.ts` | 过期/失效 item 不进入 block |
| `api-items.test.ts` | GET 过滤、changes 列表、deactivate/reactivate/revert/restore；无 token 401 |
| `api-items.test.ts` | 旧 `/api/items` 响应形状不变；新 envelope 只在 `/api/memory/items` |
| `api-items.test.ts` | agent tool 无撤销/恢复入口；body `source` 被忽略 |
| `transaction.test.ts` 扩展 | 撤销写入中断后重放，不出现半状态 |

### 手工/代码审查

- `change-journal` 与 `changes.jsonl` 引用一致；保留策略生效。
- `/api/items` 不泄漏其他 project/session。
- 现有 `context.test.ts`、`transaction.test.ts`、`api*.test.ts` 全绿。

## 3. P02 runtime-reliability

| 测试 | 断言 |
|---|---|
| `review-model.test.ts` 扩展 | `transport=opencode` 只调注入 `generate`，不请求 `/api/chat`；签名按 `{prompt, model?}->{text}`，不传 `maxOutputTokens`、不伪造 usage |
| 同上 | 缺 generate/形状不符 → `kind="config"`；不隐式 fallback 到 `/api/chat` 或别的 provider |
| 同上 | `transport=ollama` 仍走 `/api/chat`，endpoint 校验保留；旧配置无 `review.transport` 默认 ollama |
| 同上 | 429 `Retry-After: 120` → 只 1 次 fetch、不 sleep 120s/30s、抛 `ReviewRetryAfterError{retryAt=now+120s}`；HTTP date 同理；缺失/非法才 1000ms 后重试 1 次 |
| 同上 | 400/401/403/404/413 不重试；408/425/5xx 无/短 header 重试 1 次，远期限转延后 |
| 同上 | 空返回抛 `ReviewEmptyResponseError`（countsAsAttempt=true），repair 一次；repair 后仍空/无 repair 直接抛 |
| `review-reliability.test.ts` 扩展 | run 与 request 预算分离；首调/重试/repair 都计入 request；缺省公式按 `maxRequestsPerHour ?? max(maxPerHour, maxPerHour*(1+repairAttempts)*2)` |
| 同上 | 预算不足 `requestsMade=0` 释放 run slot；`>0` 保留；不置 failed、不加 attempts、不写成功记录 |
| 同上 | budget 与 http-deferred 都只延后到完整 `retryAt`，不丢窗口、不重复 skipped/failure |
| `review-orchestrator.test.ts` 扩展 | `recover()` 处理本项目；其他 projectKey 零写入（含 running 不修复）；无归属旧 session 按最近 review 记录判定，否则跳过不写 |
| 同上 | `schedule()`/`runNow()` 对外项目 session 不写状态、不占预算、不建记录 |
| `review-integration.test.ts` 扩展 | `accept()` 只用 review 记录权威 projectKey；`instanceProjectKey` 不一致 → 全部 skipped、无 hook；无权威 key 的 project 候选降级 session note |
| 同上 | 两个 `Store` 实例并发 accept 同一结果 → 仅 1 条 hook；同 key 原文不同（规范化折叠）保留为 session note/`conflicts` |
| `plugin.test.ts` 扩展 | `status` 不调用 `runAudit`；`auditAgeMs` 有/无 `auditRunAt` 两态；不伪造 automation/quarantine；无 token/prompt/路径 |
| 全部 | 失败不阻塞 turn，有 failed 记录与原因；所有测试用 fake `fetch`/`generate`/`sleep`/`now`，不真实等待或请求 |

## 4. P03 autonomous-pipeline

状态：**方案已合版；代码未实现，以下全部待验证。**

| 测试 | 断言 |
|---|---|
| `automation.test.ts` | 默认 `enabled=false`：行为与 baseline 一致；legacy 配置/`autoRules=true` 不误启用 |
| 同上 | 描述性 fact/preference/reference 可 auto；rule/skill/session 永不；decision 用 fact+reviewType 表达 |
| 同上 | benign 工作偏好祈使句转 preference（有 user quote、`grantsPermission=false`）；task template/子会话/引用表格跳过 |
| 同上 | safety/permission/destructive/strict_limit → legacy 人工，不 auto |
| `automation-sources.test.ts` | `<context>`/`<skill_content>`/`<subagent …>`/`Session task state`/任务信封/引用表格/围栏-only/`parentID` 子会话不学；混排只剥合成段、genuine 用户片段保留（不按长短一刀切） |
| 同上 | 提到 cookie/删除的工程知识可学；越权/凭证请求 protected（双向 fixture） |
| `automation.test.ts` | 普通未证实冲突 → quarantine（保留双方）；不制造普通队列；TTL 到期消失且写 `quarantine_expired` |
| `automation-supersede.test.ts` | 已证实“端口/版本从 A 改为 B”（唯一目标、scope 匹配、逐字 quote、单点差异、CAS）→ 同一 item supersede，旧值留历史可 undo；不新增第二条 |
| 同上 | 缺指向/跨 scope/引用示例/否定反转/多目标/差异不唯一/CAS 不符/manual/promoted/rule → 不覆盖、原 item 逐字节不变；relations 与 lint 未放松 |
| 同上 | 做不到正确时记 `supersede_blocked`，不 append 新版本 |
| `automation.test.ts` | 同源抑制跨 turn→review（源身份键，不依赖 reviewID）；新 messageID 可学；restore 后可再学；`sourceIdentityKey` 缺真实 ID 返回 `undefined`，与 P01 双键对照 |
| 同上 | global（turn 与 review 同门）：真实 user 逐字证据 + 明确跨项目意图，或 `evidenceProjects` ≥2 个不同已知项目才 auto；同项目多 session/仅 `evidenceSessions` 不升级；不足 → skip/quarantine，不 queue |
| 同上 | review 描述性 project/global 都不因来源变人工；review 的 rule/skill 仍人工；不以 `safeAuto=0` 硬挡 |
| 同上 | `autoUpdate=false`：普通正文变更 skip/quarantine；exact/covered touch 允许；`merge_into` 必须 route update 非 auto-add |
| `automation-supersede.test.ts` | `candidateScope`/`candidateProjectKey` 必填；缺失/undefined → `scope_mismatch`，不得回填旧值 |
| `consolidate-automation.test.ts` | 自动写入/更新 = 事务 + change event（before/after）+ 视图重建；`recordChange` 失败 → item 不落盘 |
| 同上 | 日预算/会话预算/容量 85%/95% 阻断写入且 capture 继续；双 Store 并发不超卖；失败事务不计数 |
| 同上 | `autoRules=true` 仍不自动写 rule |
| `quarantine.test.ts` | 不注入、不 queue、不提醒；TTL 到期删除并写 changelog；200 上限 |
| `maintenance.test.ts` | 维护有真实接线（启动/周期/容量事件）；无 tick 不清理；到期+回收后可恢复；无冷数据如实 blocked+retryAt |
| `curator.test.ts` 扩展 | 过期/精确去重写 expire/update 事件；rule/manual/promoted 不动；保护集合不被回收 |
| `config-automation.test.ts` | 部分 PATCH 不丢 `enabled`；`POST /api/automation/mode` 单事务设置 enabled/shadow、revision 不符 409；不擅自开启正式配置；`undoWindowHours` 不作为新撤销控件/期限 |
| `api-automation.test.ts` | `enabled/configuredMode/effectiveMode/blockedReason/retryAt/lastSuccess` 如实；`shadow=true` 显示 observe 且不写 item；lastSuccess 只随真实 add/update 变化 |
| 安全 | 不写 L0/skills/config；`dataDir` 外无写入；`grep` 断言路径未触碰 |
| 保留策略 | active 最新可逆事件不被 5000/2000/200 上限清掉；必要 suppression tombstone 保留；新文件计入容量 |

## 5. P04 recall

Status: 合版后的验收契约；**新增断言尚未实现/未运行（not-run）**，实施后以实际命令输出为准。

| 测试 | 断言 |
|---|---|
| `recall.test.ts` | 中文 bigram（“复盘失败”）命中；单字查询可用 |
| 同上 | 标识符（`plugin.ts`、`/api/items`、`npm run verify`）精确命中，不被拆词 |
| 同上 | 数字 5199 命中 5199；5198 vs 5199 且共享“端口”标 numericConflict 且不进 hits；无关日期不误标冲突 |
| 同上 | 否定相反（“不要用 pnpm” vs “用 pnpm”）不误命中；“禁止使用 pnpm”同向命中 |
| 同上 | scope：global + 当前 project；其他 project/session 不出现；无 projectKey 仅 global |
| 同上 | 预算按整 item 行 + headers/分隔符/余量估算，总估算 ≤ budget；超预算项整项缺席（不是部分文本）；顺序稳定 |
| 同上 | 合法长 item（300+ 字符）在放大 budget 后可召回；小预算整项缺席；不因 >200 字符或写入 linter 长度丢弃 |
| 同上 | store 抛错 → degraded 空结果，不抛；score 仅排序、不作为概率字段 |
| `context-recall.test.ts` | 每个合格真实 user prompt 在 V2 context hook 追加一个有界 system block；`event.messages` 字节不变 |
| 同上 | 只取末尾连续 user 段；工具轮（末条 assistant/tool）不追加；动态 part 幂等 ≤1；不写 transcript/contextBlock/entry/state |
| 同上 | 清洗 system-update/context/skill/task 后取真实文本；短 command/synthetic 不注入；失败无 block 且请求继续 |
| 同上 | 父会话三态：child 跳过；root（读取成功且无 parentID）召回；unknown（读取失败）不召回、hook resolve、不写记忆 |
| 同上 | 默认矩阵：recall 缺省+automation false → 无动态；automation true 且无 recall → 有动态；recall=false+automation true → 无动态；recall=true+automation false → 有动态 |
| 同上 | 撤销/到期下一请求排除旧条目；`recall.enabled=false` 时同样排除旧 prefix（失效不依赖开关） |
| 同上 | 动态 block 不写 `contextBlock`/`entry`；稳定小偏好 prefix 与动态 block 分离；20 轮只约束无变更 prefix |
| 同上 | owned 定位只认精确 metadata key/wrapper/自身完整 render/唯一 sentinel；泛 `## AUTOPILOT` 或仅含同事实的宿主 part 原样保留 |
| 同上 | 撤销校验只限 owned parts；用户聊天/L0/core part 中同一事实逐字保留；无 metadata + 字面 `<context` 歧义时不猜边界、保守 degraded |
| 同上 | P01 owned helper 未验收时只走精确 owned 路径；helper 验收后复用，不双写 entry.put |
| `context-version.test.ts` | 20 轮只约束无变更稳定 prefix；动态召回可随 prompt 变化；撤销/到期下一请求排除 |
| API | `/api/recall` auth；projectKey 不一致 403；失败 200+degraded；agent tool 只读、不接受 projectKey、visible 过滤 |
| P06 门禁 | 真实 host 出站记录（隔离 host + fake provider，若可行）证明错误 owned 未残留；否则最终 blocked；fake host 不替代 |

## 6. P05 ux

| 场景 | 断言 |
|---|---|
| S1 | 根路径/`#memory` 落地记忆页，不出现“审批/待审”标题 |
| S2 | shadow=true 显示“影子模式 · 不写入”，事件为“本来会写入” |
| S3 | 自动写入后记忆新增 1 行、活动新增 1 条带撤销 |
| S4 | 停止使用：无确认弹窗、行变“已停止使用/恢复使用”、`aria-live` 播报一次；文案写“下一次模型请求起不再注入（含旧 session）” |
| S5 | 恢复使用：回到生效，活动新增恢复事件 |
| S6 | 活动默认全部事件；**无“待确认”徽标**；legacy 审查在设置›高级维护，不在活动页催人工 |
| S7 | 复盘失败：活动聚合 +1，筛选可见原因 |
| S8 | 无模型 key：降级运行，legacy 审查仍可用，无阻塞遮罩 |
| S9 | metrics 失败：显示“未知”，不显示 0 |
| S10 | 停止使用随时可用、无 24h 截止；版本回退默认 90 天可配置，超期只停用 |
| S11 | 撤销结果持久可见（刷新后仍在），不是 toast |
| S12 | 390px：单列、sheet、44px、无横向滚动 |
| S13 | 旧 `#queue/<id>` 落到 `#settings/advanced/review/<id>`；`#audit/...`、`#map/...` 正确重定向 |
| S14 | 全键盘完成 记忆→筛选→详情→停止→恢复→Esc |
| S15 | 图谱/审计/健康/技能/备份入口全部保留 |
| S16 | extension page/panel/status 可用，rail 触控 ≥44px |
| S17 | 目标被后续编辑时，冲突只给“安全逆转/停止使用/保留结果”，**无“仅恢复文本”** |
| S18 | 详情/活动只用统一事件/版本/来源/可撤销 + 只读 `/api/changes`，不依赖聚合计数 |
| S19 | 无“彻底删除所有副本”假按钮；不承诺云端删除；说明后台模型仍可出网 |

验证：纯逻辑用 `console-*.test.ts`；视觉/键盘用 `tmp/full-auto-memory/ux-smoke-*.md` 手工记录（不含真实数据）。

## 7. P06 migration-verification

| 项 | 判据 |
|---|---|
| 迁移 dry-run | 输出逐行提案 + 可复现 fingerprint；不写数据 |
| 迁移 apply | 备份 + journal；只改配置补全/基线 change/queue 提案；不批量删除 |
| 迁移 undo | 恢复备份；二次 undo 报错；apply→undo→再 apply 幂等；真实跑过 |
| 路径守卫 | 拒绝真实 `autopilot` 路径；拒绝非隔离目录 |
| 正式启用 | 不自动启用；需用户另行确认（本目标不做） |
| soak | 调真实生产函数 + fake clock；`--days 30` 快速完成；报告 `simulated: true`、seed、版本、不变量 |
| soak 不变量 | 无 rule 自动、无重复 active、每条 auto 可撤销、容量/保留有界、无跨项目泄漏、无未处理异常 |
| retention | changes/suppressions/quarantine/change-journal 计入容量与保留；active 最新可逆事件受保护 |
| 验证 | `npm run verify` 实跑 exit 0，日志留盘 |

## 8. P07 final-review

- 独立审查者不是本目标实现者；逐条核对本文件，不抽样。
- 每条通过附：命令、退出码、测试名/文件、日志路径。
- 反声明检查：无“30 天真实运行”“正式迁移完成”“已发布”“全量替换旧系统”。
- 已知缺口、风险、回滚方式必须列出。
- 结论只能是：`可进入用户启用评审` / `需修复后复审`，不能自行发布。
- 发布/正式启用是用户的独立决定；P07 不执行。

## 9. 最终验收命令

```bash
# 在 worktree 根目录
npm run verify > tmp/full-auto-memory/verification/verify-final.log 2>&1
echo "exit=$?"
grep -E "Test Files|Tests  " tmp/full-auto-memory/verification/verify-final.log

# 禁用项检查
grep -rn "as any\|@ts-ignore\|@ts-expect-error" plugin/src console/src extension/src || true
git status --short
git log -1 --oneline
```

通过条件：exit 0；测试数 ≥ baseline 803 且新增阶段测试全在；无禁用项；工作树只有预期文件；无提交。

## 10. 明确不验收的内容

- 未实现的“全机含备份彻底 erase”；不承诺云端删除；后台模型仍可出网。
- 未实现的向量召回。
- 真实 OpenCode V2 端到端模型调用（需要用户单独授权与付费）。
- 正式数据迁移、正式启用、发布。
- 30 天 wall-clock 稳定性；现场运行尚未执行。
- “已开始请求/已执行外部动作”的追回。

## 11. 验收边界声明（P07 必须原样写入报告）

```text
最终功能全量验收：本目标范围内完成（以本文件证据为准）。
30 天现场运行：尚未执行；soak 为加速模拟（simulated: true），不代表 wall-clock 稳定性。
正式启用/正式数据迁移：未执行，需用户另行确认。
发布/提交/推送：未执行。
```
