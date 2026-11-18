# P03-A 纯策略与配置类型 — 实施报告

Status: **A 单元完成**（纯策略 + 类型/config + 3 个测试文件）；**P03 未完成**，B/C1/C2/D/E 未开始。
Fix1 (2026-11-11)：F01–F11/Q01 已返工，见 §8；§2–§7 中与 fix1 冲突的口径以 §8 为准。
Date: 2026-11-11
Owner: P03-A 固定 owner（单 writer）
Worktree: `full-auto-memory`（独立 worktree）

## 1. 范围与交付物

只改 A brief 允许的文件；未接线 Store/plugin/consolidate/server，未实现预算、隔离落盘、采集、更新、维护 API 或 followups。

| 文件 | 类型 | 内容 |
|---|---|---|
| `plugin/src/types.ts` | 修改 | `Authority`、`AutomationConfig`、`QuarantineRecord`、`AutoMemConfig.automation`、`Item.authority?/grantsPermission?: false`、`PersistedState.automation*` |
| `plugin/src/config.ts` | 修改 | `DEFAULT_CONFIG.automation`（enabled=false）、`ConfigPatch.automation`、`mergeConfig` 深合并 |
| `plugin/src/memory/sources.ts` | 新增 | `segmentSynthetic`、`classifyAuthority`、`sourceIdentityKey`、`hasVerbatimUserEvidence` 及结构守卫 |
| `plugin/src/memory/supersede.ts` | 新增 | `planSupersede`（证据绑定单点替换） |
| `plugin/src/automation.ts` | 新增 | `decideAutomation`、`configuredMode`（纯函数，不读时钟/Store） |
| `plugin/test/automation-sources.test.ts` | 新增 | 26 tests |
| `plugin/test/automation-supersede.test.ts` | 新增 | 16 tests |
| `plugin/test/automation.test.ts` | 新增 | 31 tests |

基准快照：`tmp/full-auto-memory/reviews/p03a-before/`（262 files / 4.5M，P01/P02 净基准）。
本轮 diff：`tmp/full-auto-memory/reviews/p03a.patch`（8 文件、含 6 个新增文件、1469 行；未 `git add`/提交）。
补丁已用 `patch -p1 --dry-run` 对 `p03a-before/` 校验，exit 0。

## 2. 冻结接口逐项

### `segmentSynthetic(text): { text; stripped[] }`
- 剥离 `<context>…</context>`、`<skill_content>…</skill_content>`、配对/自闭合 `<subagent …>`、`[Session task state …]`。
- 混排保留真实用户句；仅正文提到 `context`/`subagent` 字样不误删。
- 不负责权限、不落库、不读消息元数据。

### `classifyAuthority(input): { authority; kind?; reason }`
判定顺序（确定性，不使用模型分数）：
1. `parentSessionID` → `subagent`（子代理兜底）。
2. `strictness` ∈ safety/permission/destructive/strict_limit，或 `risk ≥ 0.6`，或 `safety ≥ 0.6` → `protected`。
3. 合成块剥离后为空 → `task_template`；结构信封（TASK+MUST DO+MUST NOT DO+CONTEXT）→ `task_template`。
4. fence-only / 引用表格 → `quoted_table`。
5. 真实凭证赋值（`token=…`、`sk-…` 等）→ `protected`（sensitive-value）。
6. 请求常驻执行权、凭证存储、生产部署、破坏性操作 → `protected`。
7. benign 长期祈使（以后/每次/from now on…）→ `preference` + `kind:"preference"`。
8. 其余普通描述 → `preference`（保留调用方 kind），reason `descriptive`。
- 不返回、也不授予任何执行权限；`Item.grantsPermission` 的类型是字面量 `false`。

### `sourceIdentityKey(source, text): string`
`sessionID|messageID|sha16(normalizeForFingerprint(text))`；不包含 `reviewID`/`turnID`，turn 与 review 同源同引用得到同一键，新 messageID 得到新键。

### `hasVerbatimUserEvidence(evidence, messageText): boolean`
- 只接受 `kind:"user"`；
- 引文必须能在真实消息中逐字定位（空白归一后 substring）；
- 空引文、tool/assistant 证据、来源消息不存在均返回 false。

### `planSupersede(input): SupersedePlan`
纯判定，不读写 Store：
- 目标必须 `status:"auto"`、非 `manual`、kind ≠ rule/skill（`not_writable`）；
- `candidateScope`/`candidateProjectKey` 必须与旧 item 完全一致（`scope_mismatch`）；
- 引文不得是引用块/围栏/表格、不得含假设/示例措辞（`quoted_or_hypothetical`）；
- 必须含唯一 A→B 纠正对；A、B 均逐字出现在 quote；A 在旧正文中唯一出现，B 尚不存在（`no_verbatim_correction` / `not_single_diff`）；
- 非标识符场景做否定极性守卫（`negation_flip`）；
- 成功时只替换该唯一位置，其余字节原样保留，reason 带 origin+quoteMessageID。
- **C1 唯一目标与 C8 版本 CAS 不在此纯函数内**：它们需要 relations/事务/CAS，归 C2 调用方；A 不伪造该覆盖。

### `decideAutomation(input): AutomationRoute`
纯路由，顺序：
1. `enabled=false` → `skip legacy-path`；suppressed → `skip`；`grantsPermission=true` → `queue`。
2. backoff/capacity/dailyWrites → `skip`（不制造人工待办）。
3. authority 为 template/table/subagent → `skip`；protected → `queue`；rule/skill → `queue`；session → `skip`；lint 失败 → `skip`；受保护 strictness → `queue`；不在 `autoWriteKinds` 或项目缺 projectKey → `skip`。
4. review lane：关闭 → `queue`；review rule/skill → `queue`；无逐字 user quote（`evidenceOk=false`）→ `skip`。
5. 冲突：仅 `supersedeOk && conflictTargets===1 && autoUpdate` → `update`；否则 `quarantine`（TTL=quarantineHours）。
6. exact/covered → `update`（touch）；重复度超阈值或非 create/merge_into → `quarantine`。
7. global：易变标识（路径/端口/版本/localhost/ses_）→ `quarantine`；无明确跨项目措辞且（含项目相对词或独立会话数不足）→ `quarantine`。
8. 非 review 的 safeAuto 低于 project/global 阈值 → `quarantine`；review lane 不以 safeAuto 为门。
9. 其余 → `auto`。

### `configuredMode(config): "legacy" | "observe" | "autonomous"`
`!automation.enabled → legacy`；`enabled && shadow → observe`；`enabled && !shadow → autonomous`。不读 Store、不落第二事实源。

## 3. 配置与类型契约

`DEFAULT_CONFIG.automation`：

| 字段 | 默认值 |
|---|---|
| `enabled` | `false` |
| `autoWriteKinds` | `["fact","preference","reference"]` |
| `autoUpdate` / `reviewLane` | `true` / `true`（仅在显式启用 automation 后生效） |
| `quarantineHours` | `72` |
| `dailyWrites` / `dailyModelCalls` | `40` / `40` |
| `minSafeAutoProject` / `minSafeAutoGlobal` | `0.92` / `0.96` |
| `minEvidenceSessions` | `2` |
| `maxWritesPerSession` | `5` |
| `undoWindowHours` | `24`（仅 legacy merge journal；设计未给默认值，已在此标注） |

- 旧 config 无 `automation` → 读取默认 `false`；部分 PATCH 只合并给定字段，不会把 `enabled`/`autoWriteKinds` 变成 undefined，也不会意外开启。
- `Item.authority`、`Item.grantsPermission?: false` 是描述性审计元数据；`PersistedState.automationBackoffUntil/Reason`、`automationLastMaintenanceAt`、`automationLastSuccess*` 只落类型，A 不读取/写入；`QuarantineRecord` 只落类型，A 不落盘。

## 4. 测试与 RED/GREEN

定向：`npx vitest run test/automation.test.ts test/automation-sources.test.ts test/automation-supersede.test.ts`
→ **3 files / 73 tests passed**（31 + 26 + 16）。日志：`tmp/full-auto-memory/reviews/p03a-target.log`。

覆盖对照：
- 源 14 类：context、skill_content、任务信封、单独 MUST NOT DO、验收表格、引用块、围栏、子代理通知、子代理会话、续跑 Session task state、assistant/tool 证据、真实敏感值、cookie/删除工程知识、越权请求。
- 路由：fact/preference/reference auto；rule/skill 永不；session skip；protected/strictness queue；review 描述性 auto 且 safeAuto=0 不挡；review rule/skill queue；无逐字 quote skip；global 明确意图/≥2 独立会话可 auto、项目相对措辞不升级、易变标识隔离；普通冲突 quarantine 不 queue；预算/容量/抑制/退避 skip；低置信隔离；exact/covered touch；多目标/未证实冲突隔离。
- supersede：版本/端口/分支成功且其余字节不变；缺 A→B、跨 scope、跨 projectKey、示例、引用块、否定、多纠正对、A 出现两次、B 已存在、仅 alias、promoted/shadow/manual/rule/skill 全部拒绝；review 来源成功。
- 配置：默认 false、部分 PATCH 不误开启、深合并保留兄弟字段、三种 configuredMode。

RED/GREEN 诚实记录：
- 先写 3 个测试文件后运行，`p03a-red.log` 记录 **3 suites failed / no tests**，原因是三个新模块尚不存在（module-not-found）。这是本轮真实 RED，不是断言级失败。
- 首次实现后定向运行出现 **2 个真实断言失败**：global 2 会话用例仍用 0.95 < global 阈值 0.96；引用块混排用例对 `kind` 期望过强。修正的是测试期望而非产品放宽，随后 73 green。该次失败输出未单独落盘，仅在终端观察，报告中如实标注。
- 原型复用声明：`p03-attempt-trash/` 的 6 文件作为参考改写，**未直接复制后宣称通过**；产品树的 73 green 是本次独立运行结果，不等于原型的 44 green，也不等于 P03 验收。

## 5. 验证账本（真实命令/原始结果）

| # | 检查 | 命令 | 关键原始结果 | Exit | 状态 |
|---|---|---|---|---|---|
| 1 | 定向测试 | `cd plugin && npx vitest run test/automation.test.ts test/automation-sources.test.ts test/automation-supersede.test.ts` | `Test Files 3 passed (3)` / `Tests 73 passed (73)` | 0 | ran/pass |
| 2 | 类型检查 | `cd plugin && npx tsc --noEmit` | 无输出 | 0 | ran/pass |
| 3 | 完整门禁 | `npm run verify`（worktree 根） | `Test Files 76 passed (76)` / `Tests 999 passed (999)`；plugin/console/extension typecheck + build + extension proxy + `git diff --check` 全过 | 0 | ran/pass |
| 4 | 补丁校验 | `cd p03a-before && patch -p1 --dry-run --forward < ../p03a.patch` | 8 files patched，无 reject | 0 | ran/pass |
| 5 | 禁用写法 | `grep -n "as any\|@ts-ignore\|@ts-expect-error"`（A 文件） | 无匹配 | 0 | ran/pass |

日志/退出码：
- `tmp/full-auto-memory/verification/verify-p03a.log`（556 行）
- `tmp/full-auto-memory/verification/verify-p03a.exit` → `exit=0`
- `tmp/full-auto-memory/reviews/p03a-red.log`（RED）
- `tmp/full-auto-memory/reviews/p03a-target.log`（73 green）
- `tmp/full-auto-memory/reviews/p03a-tsc.log`（空输出）

基线对比：P02 fix1 为 73 files / 926 tests；本次 76 files / 999 tests（+3 files / +73 tests），旧断言无回归。

## 6. 边界与未覆盖（不得当成 P03 完成）

- 未接线 `store.ts`、`plugin.ts`、`consolidate.ts`、`server.ts`；未实现 B 的预算/quarantine 落盘/`takeAutomationSlot`；未实现 C1 采集、C2 更新/supersede 事务、D 维护 API/status、E followups。
- `planSupersede` 不实现 C1 唯一目标与 C8 CAS：纯函数没有 multi-target/version 入参，二者由 C2 事务层执行；A 不新增接口、不在本报告外声称覆盖。
- `maxWritesPerSession`、`automationLastSuccess*`、`QuarantineRecord` 等仅类型/默认值，消费方分别为 B/D。
- `autoUpdate` 在 A 中只门控内容变更的 supersede；exact/covered touch 不受影响（touch 只写 seen，不改正文）。该口径已在此记录，供 C2 复核。
- 未读写正式配置/真实记忆/凭证；未发模型/host 出网请求；未安装依赖；未创建子代理；未提交/推送/发布。

## 7. 交接

A 可交给 B；B 只读已验收接口，不改本块签名。若 B/C2 需要 `expectedVersion`、multi-target 计数或 status 结构，先在 `03-autonomous-pipeline.md` 记 Ruling 再改接口。

## 8. P03-A fix1（2026-11-11，review F01–F11/Q01）

基准：`tmp/full-auto-memory/reviews/p03a-fix1-before/`（270 files / 4.6M）。
本轮 diff：`tmp/full-auto-memory/reviews/p03a-fix1.patch`（7 files、752 行；无新增文件，未 `git add`/提交）。
范围仅 A 的 `types/config/sources/supersede/automation` 与 3 个测试；未启动 B/C/D/E。

### 8.1 逐项根因与处置

| ID | 根因 | 处置 | 行为证据 |
|---|---|---|---|
| F01 | 合成列表只有 context/skill/subagent，`<task>`/`<template>`/`{{…}}` 未识别，整句按长期祈使变 preference | 配对/自闭合 task/template 剥离；剩余文本含 `{{…}}` → `task_template`；混排只剥合成段，prose 提到 task/template 字样不误删 | 三条模板 fixture 均 `task_template`；混排保留 genuine 句；prose 保持 preference |
| F02 | destructive 只有在同时命中 `asksAuthority` 才 protected | destructive 目标命中即 protected（扩到删除/清空所有/整个/删库等）；“删除前先进回收站”“删除旧分支步骤”不命中目标，仍可学 | 有/无授权词的生产删除均 protected；工程知识仍 preference |
| F03 | 旧文档“review global 仍人工”与 R1 冲突，A 沿用了 review 特殊路径 | 按 R1 统一：review 与 turn 走同一高证据门；review `evidenceOk!==true` fail-closed skip；证据不足 quarantine，不 queue | review global 明确意图/双项目 → auto；仅 sessions → quarantine；protected 才 queue |
| F04 | `autoUpdate` 只门控 supersede，`merge_into` 落到 auto-add | `autoUpdate` 成为所有正文变更总开关：merge_into/partial/related → update；false → quarantine（reason auto-update-disabled）；exact/covered touch 不变；supersede false 不再 queue | merge_into true → update；false → quarantine；exact+false 仍 update |
| F05 | `candidateScope ?? existing.scope` 与 `projectKey` 回填让跨 scope 守卫失效 | `candidateScope` 改为显式必填；project scope 必须有非空 projectKey；省略/undefined/不等 → scope_mismatch | 缺 scope、缺 projectKey、global 带 key 均 scope_mismatch |
| F06 | 仅按子串 `indexOf` 替换，5199 可改坏 15199 | 增加完整 token 边界（前后字母数字、版本/路径连接符）与边界计数；不唯一/不完整 → not_single_diff | 15199、v1.20、opt/app 路径片段均拒绝；5199/v1.2 正常成功 |
| F07 | 标识符跳过否定守卫，且旧测试未进入 negation 分支 | 用 `negationClauses`+`sameNegationObject` 比较旧 from 子句与新 to 子句极性；A→B 负例真实命中 negation_flip | “端口不要用 5199”+A→B → negation_flip；“端口用 5199”+A→B → ok |
| F08 | `直接执行/直接改` 泛化命中，凭证仅凭“记住 token”判存密钥 | 移除泛化执行词；destructive/deploy 独立保护；凭证存储需存储短语且排除刷新周期/SSO 说明 | “直接执行 npm test”“token 每 30 天刷新走 SSO” → preference；存 token/删生产 → protected |
| F09 | global 只看 `evidenceSessions` 数字，同项目两次可升级 | `AutomationInput` 增加 `evidenceProjects`；global 需 ≥2 个 distinct 已知 projectKey，或明确跨项目意图；`evidenceSessions` 不再单独升级 | 同项目 p1+p1/仅 sessions → quarantine；p1+p2 → auto |
| F10 | 缺 ID 生成 `||hash` 可碰撞键；测试自比较 | `sourceIdentityKey` 返回 `string|undefined`，缺 sessionID/messageID → undefined；测试对照 P01 `turnHookKey`/`reviewHookKey` 字节与前缀 | 缺失 ID → undefined；A 键 = turn 键，review 键 = `review|`+A 键 |
| F11 | automation 合并直接展开，显式 undefined 覆盖默认 | 深合并前过滤 undefined 值（与顶层 defined 同策略） | enabled/autoWriteKinds/dailyWrites undefined → 保留默认 |
| Q01 | 73 green 未覆盖失败分支；key 测试自比较、negation 测试未进入分支 | 先补 22 个行为用例，逐条断言 authority/reason/route/text；key 对照 P01 helper；negation A→B 真实命中；benign/destructive 双向 fixture | RED 19 failed |

### 8.2 文档矛盾裁决记录

- F03 不是“把普通 global 改人工通过 review”，而是旧 phase 文本“global 仍人工”与主代理 R1（普通描述性 global 零日常审批，turn/review 同门）冲突。本轮按 R1 实现：满足真实 user 逐字证据 + 明确跨项目意图，或 `evidenceProjects` ≥2 不同已知项目才 auto；不满足 skip/quarantine；只有 protected/rule/skill 进 legacy queue。该裁决已由主代理先落 R1–R6，本报告只记录实现遵从，reviewer 下轮按新规格重评。
- R6 `undoWindowHours=24` 仍是未接线 legacy 字段；未改 `undo.retainDays=90`，未新增/暴露撤销控件。

### 8.3 RED / GREEN 与命令

- RED（行为级，不是 module-not-found）：`npx vitest run test/automation*.test.ts` → **3 files failed / 19 failed | 76 passed (95)**；日志 `tmp/full-auto-memory/reviews/p03a-fix1-red.log`，exit `...-red.exit=1`。失败逐条覆盖 F01/F02/F05/F06/F07/F08/F10/F11 与 F03/F04/F09 路由，均断言 authority/reason/route/text。
- GREEN（定向）：同命令 → **3 files / 95 tests passed**（automation 35 + sources 35 + supersede 25）；日志 `p03a-fix1-target.log` / `.exit=0`。
- 类型：`cd plugin && npx tsc --noEmit` → 无输出，exit 0；`p03a-fix1-tsc.log`。
- 完整门禁：`npm run verify` → **exit 0，76 files / 1021 tests**；日志 `tmp/full-auto-memory/verification/verify-p03a-fix1.log`（557 行）/ `.exit`；含 plugin/console/extension typecheck、build、extension proxy、`git diff --check`。
- Patch：`p03a-fix1.patch` 7 files / 752 行；在 `p03a-fix1-before/` 上 `patch -p1 --dry-run` exit 0。
- 禁用写法：A 文件无 `as any`/`@ts-ignore`/`@ts-expect-error`；`git diff --check` exit 0。

### 8.4 剩余边界与 C1/C2 交接

- C1 必须组合三件事，不能只信 `classifyAuthority`：`classifyAuthority` + `hasVerbatimUserEvidence` + parent 三态（known root / known parent / unknown）。unknown parent 不得当 root 自动学；review 候选 `evidenceOk` 必须为 true，否则 A 已 fail-closed skip。
- `sourceIdentityKey` 输出 P01 turn 形态；C1 读取时必须同时检查 P01 `turnHookKey` 与 `reviewHookKey`/`hookKeysFor` 双通道，处理遗留 review-only 抑制行；不得只去前缀单读。
- C2 仍负责唯一 target、CAS、事务与 undo；A 的 `planSupersede` 只做纯判定，不返回 `no_single_target`。
- `evidenceProjects` 由 C1 构建真实项目身份集合；`minEvidenceSessions` 保留为附加信息，不能单独升级 global；同项目多 session 不升级。
- `maxWritesPerSession`、`QuarantineRecord`、`automationLastSuccess*` 仍只落类型/默认值，消费方 B/D。
- 未接线 Store/plugin/consolidate/server；未实现 B/C1/C2/D/E；未读写正式配置/真实记忆/凭证；未发模型/host 出网；未提交/推送。**P03 未完成。**

## 9. P03-A fix2（2026-11-11，F12/F13/F14）

基准：`tmp/full-auto-memory/reviews/p03a-fix2-before/`（270 files / 4.7M）。
本轮 diff：`tmp/full-auto-memory/reviews/p03a-fix2.patch`（6 files / 252 行；未 `git add`/提交）。
范围严格限 F12/F13/F14 及对应测试；F01–F11 不重做，B 未启动。

### 9.1 逐项根因与处置

| ID | 根因 | 处置 | 行为证据 |
|---|---|---|---|
| F12 | `tokenIndices` 只统计通过边界的 token，替换仍用原始 `indexOf(from)`；混排 `15199+5199` / `v1.20+v1.2` / 路径片段会改坏更大的前一个 token | 改为 `tokenIndices` 返回全部边界索引；恰好 1 个才替换，且直接用该索引；不唯一/无完整 token → `not_single_diff`。计数与定位同源，不再分离 | 数字/版本/路径各正反顺序 6 例：只改独立 token；`15199`/`v1.20`/`/opt/app/data` 及其他字节逐字断言不变 |
| F13 | fix1 把 destructive/deploy 字样无条件 protected，`删库前先备份`/`上线前先跑测试`/`清空所有缓存前先停服务` 被 queue | 按分句判定“安全流程”：敏感子句必须匹配 `动作 + 前/之前 + 先/要/需要/必须`；按逗号/然后/接着/并且/再拆分，任一敏感子句不满足即 protected。安全描述 → preference；同句真实执行/授权（直接删除/部署、不用问）仍 protected | 4 个安全流程 preference；3 个混合执行负例 protected；route 安全描述 auto、执行指令 queue |
| F14 | `types.ts` 的 `autoUpdate` 注释仍是 R2 前“只 gate supersede” | 改为“merge/update/supersede 所有正文变更总开关；exact/covered touch 不受影响”；仅注释，无行为变化 | tsc 通过；定向与全量测试不变 |

窄裁决已落 `phases/03-autonomous-pipeline.md` R7：token 计数与定位同源；安全流程按分句且不因“前”字绕守卫；`autoUpdate` 注释同步 R2。R1–R6 不变，普通 global 不因 review 来源回人工。

### 9.2 RED / GREEN / 门禁

- RED（行为级）：`npx vitest run test/automation*.test.ts` → **3 files failed / 5 failed | 99 passed (104)**；日志 `tmp/full-auto-memory/reviews/p03a-fix2-red.log`，exit `...-red.exit=1`。失败为 F12 三个“更大 token 在前”替换错位、F13 安全流程误 protected、route 误 queue；不是 module-not-found。
- GREEN（定向）：同命令 → **3 files / 104 tests passed**（automation 36 + sources 37 + supersede 31）；`p03a-fix2-target.log` / `.exit=0`。
- 类型：`cd plugin && npx tsc --noEmit` → 无输出，exit 0；`p03a-fix2-tsc.log`。
- 完整门禁：`npm run verify` → **exit 0，76 files / 1030 tests**；`tmp/full-auto-memory/verification/verify-p03a-fix2.log`（556 行）/ `.exit`；含 typecheck/build/extension proxy/`git diff --check`。
- Patch：6 files / 252 行；`p03a-fix2-before/` 上 `patch -p1 --dry-run` exit 0。
- 禁用写法：F12/F13 文件无 `as any`/`@ts-ignore`/`@ts-expect-error`；`git diff --check` exit 0。

### 9.3 剩余边界

- F12 仍只做单点纯判定；C2 继续负责唯一 target、CAS、事务与 undo。
- F13 的流程例外只影响 authority 分类，不授予执行权限（`Item.grantsPermission` 仍字面量 false）；真实执行/授权、存 token/凭证、生产删除仍 protected。C1 仍需组合 classify+verbatim+parent 三态。
- 未接线 Store/plugin/consolidate/server；B/C1/C2/D/E 未实现；未读写正式配置/真实记忆/凭证；未发模型/host 出网；未提交/推送。**P03 未完成。**

## 10. P03-A fix3（2026-11-11，F15/F16）

基准：`tmp/full-auto-memory/reviews/p03a-fix3-before/`（270 files / 4.7M）。
本轮 diff：`tmp/full-auto-memory/reviews/p03a-fix3.patch`（3 files / 160 行；未 `git add`/提交）。
范围严格限 F15/F16 与对应测试；F12/F14、R1–R7 未改，B 未启动。

### 10.1 根因

- **F15**：不是少词，而是 `workflowSafe` 只要求“子句里出现敏感动作 + 任意位置匹配 `前…先`”，安全前缀与后续执行尾部没有分离。无分隔符时整句一个子句，`上线前先` 命中后，尾部的 `直接部署到生产/直接删除生产库` 仍被放行。
- **F16**：先按逗号分句再匹配 `前…先`，`上线前，先跑测试` 被拆成“上线前”和“先跑测试”；前句含敏感动作却没有准备词 → 误 protected/queue。语义与无逗号版本相同。

### 10.2 判据与最小修复

- 先把 `前/之前` 后的可选空白/逗号与准备词归一（`前，先` → `前 先`），再分句；不把任意“前”放行。
- `workflowClauseSafe`：敏感动作必须恰好一个且位于 `前/之前` 的条件段；条件段不得含执行意图；`前` 后必须接 `先/要/需要/必须/应该/记得`；准备步骤之后的剩余文本不得再出现敏感动作或执行意图。否则整个子句不算安全。
- 保留逗号/然后/再旧负例、单独破坏性执行、授权/存 token 的 protected 语义；`grantsPermission` 仍字面量 false，classify 不实际赋予工具权限。
- R8 窄裁决已落 `phases/03-autonomous-pipeline.md`。

### 10.3 RED / GREEN / 门禁

- RED（行为级）：`npx vitest run test/automation*.test.ts` → **2 files failed / 3 failed | 102 passed (105)**；日志 `tmp/full-auto-memory/reviews/p03a-fix3-red.log`，exit `...-red.exit=1`。失败为 F15 四个无分隔执行尾部中的代表用例、F16 逗号安全流程、route 误判；非 module-not-found。
- GREEN（定向）：同命令 → **3 files / 105 tests passed**（automation 36 + sources 38 + supersede 31）；`p03a-fix3-target.log` / `.exit=0`。
- 类型：`cd plugin && npx tsc --noEmit` → 无输出，exit 0；`p03a-fix3-tsc.log`。
- 完整门禁：`npm run verify` → **exit 0，76 files / 1031 tests**；`tmp/full-auto-memory/verification/verify-p03a-fix3.log`（555 行）/ `.exit`；含 typecheck/build/extension proxy/`git diff --check`。
- Patch：3 files / 160 行；`p03a-fix3-before/` 上 `patch -p1 --dry-run` exit 0。
- 禁用写法：本轮文件无 `as any`/`@ts-ignore`/`@ts-expect-error`；`git diff --check` exit 0。

### 10.4 剩余边界

- F15/F16 只影响 authority 分类；C1 仍需组合 classify+verbatim+parent 三态，C2 仍负责唯一 target/CAS；本块不实际授予执行权限。
- 未接线 Store/plugin/consolidate/server；B/C1/C2/D/E 未实现；未读写正式配置/真实记忆/凭证；未发模型/host 出网；未提交/推送。**P03 未完成。**



