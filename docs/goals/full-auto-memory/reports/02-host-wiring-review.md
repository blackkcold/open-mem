# P02 host wiring review — ReviewOrchestrator projectKey

Status: 独立复核（原 P02 reviewer；未实现本轮修复）— 只读产品 + fake-host probe；未改产品代码/测试，未读真实配置/记忆，未发真实模型/网络，未提交。
Date: 2026-11-11
Scope: 本轮 `tmp/full-auto-memory/reviews/p02-wiring.patch`（8,299B，2 文件：`plugin/src/plugin.ts` + 新增 `plugin/test/plugin-wiring.test.ts`）及直接接线；不重审已闭合的 P02 预算/重试/accept 事务。
Baseline: 当前 P02 生产树（主代理已核 `verify-p02-wiring.exit=0`、74 files / 929 tests、`git diff --check` clean；本复核未重跑整套 verify）。
References（历史保留，不修改）：`reports/02-host-wiring-audit.md`、`reports/02-host-wiring-fix.md`、`reports/02-review.md`、`reports/02-runtime-reliability.md`。

## 1. 裁决

| 维度 | 结论 |
|---|---|
| known-foreign 入口（state `contextProjectKey`） | **闭合**（recover / 自动事件 / seen / accept / record 均为 setupPlugin 级证据；record-only 见 U1 注） |
| 规格符合性（本轮范围） | **通过**；无新 Critical/Important；但**不等于所有项目已隔离** |
| 质量 | **通过（6 项 Minor：5 测试/报告 + 1 性能；不阻塞）** |
| 是否可回 P03 重设计 | **可以**；U1/U2 的未知来源路径应作为 P03-C1 输入，不需要 P02fix2 |
| 原 P02 验收历史 | 旧 73/926 与 P02 review 的 “clean” 只覆盖组件级，**未覆盖 setupPlugin 装配**；不能称此前端到端通过。本轮修复不抹该事实 |

## 2. 本轮实际证据

### 2.1 RED 真实性（独立复现）

把当前 `plugin/test/plugin-wiring.test.ts` 放进 `p02-wiring-before/plugin/src` 副本运行：

```text
Test Files  1 failed (1)
Tests       3 failed (3)
- expected 1 to be +0                         （test ①：foreign recover 触发 generate）
- expected 'running' to be undefined          （test ②：A 处理了 foreign 自动事件）
- expected undefined to be 'cbc9c3febf7e91e2'（test ③：own review 无 projectKey）
```

当前产品运行同一测试：**3 passed**。原 audit probe 复跑：**exit 0**，输出 `generateCalls=0 / reviewCount=0 / hookCount=0 / foreignSessionStatusAfter=scheduled`。三条 RED 与作者 §2 一致，测试确实从真实 `setupPlugin` 入口复现了缺参装配反例（不是直接 `new ReviewOrchestrator`）。

### 2.2 生产装配

- `plugin/src/plugin.ts:299-300`：`project = ctx.location?.project?.canonical ?? ctx.location?.directory`，`projectKey = sha16(project)`。
- 同一变量在 `:485` 传给 `new ReviewOrchestrator`（`:481-508`），并与 `knownTitles: collectReviewKnownTitles(store, 30, projectKey)`（`:488`）一致；不存在第二个 key。
- `onAccepted`（`:491-499`）第 4 参仍是 orchestrator 的 `deps.projectKey`；`acceptReviewCandidates` 的 `projectKey` 只取该权威值，`instanceProjectKey` 仍用于 mismatch 比较（`accept.ts:59-70`）。两者由同一变量构造、恒等，mismatch 检查是 defense-in-depth，不是本轮新增过滤；known-foreign 已在更早的 owns/gate 被拦截。
- manual `reviewRuntime.run`（`:515-518`）的 `state.contextProjectKey !== projectKey` 外层 guard 未改。

### 2.3 初始化 recover known foreign

`plugin/test/plugin-wiring.test.ts:114-137`：A 实例 + `contextProjectKey="B"`、`scheduled`、`reviewDueAt` 已过的 session；setupPlugin 初始化 `recover()` 后：

- `generate=0`、`listReviews()=0`、`listHooks()=0`；
- `reviewStatus="scheduled"`、`reviewDueAt` 原值、`contextProjectKey="B"` 均未变；
- audit probe 同结果（`hookCount=0`，`foreignSessionStatusAfter=scheduled`）。

### 2.4 自动事件 known-foreign、且不吞 seen

`plugin.ts:561-574` 的 gate 在 `seen` 认领（`:576-593`）**之前**，也在 `session.created` 的 parent/`refreshContext`（`:602-622`）、`consolidate`（`:643`）、`schedule`（`:644`）之前；只读 `readSession`，无写。

测试 `:139-170`：A 收到无 `location` 的 `session.execution.succeeded`（foreign key=sha16("/workspace/B")）：

- A：`generate=0`、foreign `reviewStatus` 仍 `undefined`；
- 同 dataDir、同一 `globalThis.__openMemSeenEvents:<dataDir>` Map（`:581-592`，无 dispose 清理），B（key=sha16("/workspace/B")）用**同一 eventID** 仍能处理：review 的 `projectKey=B`、存在 B 的 project hook；
- A 在 skip 前未写 seen，否则 B 会命中 `seen.has(eventID)`（`:585`）而无法处理。

补充 probe `probe-p02-wiring-known.ts`（U3）：known-foreign 自动事件后 `generate=0 / reviews=0 / hooks=0 / queue=0`，确认 gate 在 consolidate 之前。

### 2.5 same-project own review

测试 `:172-195`：own session key=sha16("/workspace/A")，事件后 `ReviewRecord.projectKey=A`、`sessionNotes` 为空、存在 A 的 project hook。RED 在 `projectKey=undefined` 处失败，证明装配 key 是决定性的。

注意（测试归属，非产品回归）：probe `probe-p02-wiring-own.ts`（O1）显示该 fixture 的唯一 hook 是 turn-consolidation 产生的（`origin=null`、`reviewID=null`、`status=ignored`），review 记录 `candidates=1, queued=0`（候选被已有 turn hook 去重）。因此该测试的 hook 断言不能单独证明 review accept 写了 project hook；`record.projectKey=A` 与 `sessionNotes=0` 才是关键证据，accept 的权威 key 另有既有 `review-integration.test.ts:82` 覆盖。

## 3. 精确剩余未知（必须保留，不得宣称全隔离）

### U1 未知 contextProjectKey 的既有 session + 无 location 自动事件

probe `probe-p02-wiring-unknown.ts`：session 无 `contextProjectKey`，A 收到无 location 的 `session.execution.succeeded`：

```text
generate=0, reviewCount=0, hookCount=1, queueCount=0
sessionKey=null, reviewStatus=null
hookProjectKeys=[sha16("/workspace/A")], hookScopes=["project"]
```

A 不跑 review（`schedule()` 的 `owns()` 对 undefined key 返回 false），但 `consolidate` 仍把该 session 的用户文本写成 **A 的 project hook**。这是 fix 前既有路径（不是本 diff 引入），但说明“事件路径已隔离”只对 **known** key 成立。补充：若该 session 没有 `contextProjectKey`、但最近 ReviewRecord 的 `projectKey=B`，`recover()` 会按记录跳过（P02 既有），自动事件 gate 却只读 `contextProjectKey`、不读记录，因此仍会 consolidate 写 A hook（无 review）；记录证据未用于事件 gate，属 P03 契约。

### U2 未知 contextProjectKey 的**新** session + `session.created` 无 location

probe `probe-p02-wiring-created.ts`：A 收到无 location 的 `session.created`（新 session，无 state）：

```text
sessionExists=true, contextProjectKey=sha16("/workspace/A"), parentSessionID=null
```

既有 `refreshContext(... projectKey)`（`:619`）会给未知新 session **打上 A 的 key**。fix report §1.2/§4 的“未知 contextProjectKey 不猜归属”表述应更正为：**本轮 gate 不新增猜测，但既有 `session.created`/refreshContext 仍会认领未知 session**。这是 P03-C1 source/parent 契约的核心输入；本 diff 未改变它（fix 前同样发生）。

### 其他边界

- **当前实例无 projectKey**（`ctx.location` 缺失）：`plugin.ts:568` gate 与 orchestrator 均按 undefined 放行；`orchestrator.ts:660-666` 的 `owns()`/`recoverOwns()` 对 `deps.projectKey===undefined` 不筛选（P02 §6 明确旧行为）。本修复未覆盖，也未测试。
- **真实 host 事件过滤**：仍未知。fake host 的 `event.location` 可缺失，gate 证明的是“已知 key 的 state 级隔离”，不能证明真实 host 的目录过滤或事件交付顺序。
- **seen 跨进程**：`:581-592` 是 per-process `globalThis` Map（按 dataDir），不是持久化；测试的“同 eventID owner 仍处理”是**同进程**证明。跨进程去重不是本 diff 的内容（既有设计）。
- **legacy 无 key session**：现在 key 已传入，auto 路径按 P02 §6 保守跳过；`recover()` 的 legacy matching-record 分支仍可能 arm 一个 `runNow` 会拒绝的 session，直到下一次 `refreshContext` 打上 key（无 review/hook 写出，暂态；host 若无 context hook 则不会自愈）。属 P03 source 契约，不是本 diff 新逻辑。
- **manual**：外层 guard 未改；没有 setupPlugin 级 manual 测试（既有 orchestrator 级 `runNow(foreign)` 测试仍绕过装配）。这是既有测试缺口，不是本轮回归。
- **性能**：每个事件新增一次 `store.readSession`（state.json 读取/解析）在 seen 去重之前；高频 server-wide 流下是额外开销，正确性无影响（Minor 6）。

## 4. 新测试质量（敏感性评估）

- 三条测试都走真实 `setupPlugin` + fake host，未直接构造类；RED 3/3 独立复现。✅
- **Minor 1**：test ①/test ② 使用固定 200ms 负向等待，没有正向控制（例如同 dataDir 的 own due session 被 recover 处理），若 recover/事件循环整体坏掉，测试也可能通过；慢 CI 下可能减弱 RED 敏感性。建议加 own positive control 或 `waitFor` 可观察信号。
- **Minor 2**：test ② 只断言 A 的 `generate/reviewStatus`，未断言 A 对外项目无 hook/queue/parent/context 写入；U3 已手工证明当前代码为零，但测试本身对“gate 被移到 consolidate 之后”不敏感。建议在 A 阶段加 hooks/queue/foreign state 断言。
- **Minor 3**：test ③ 的 project hook 来自 turn-consolidation（O1），不是 review accept；建议用未被 transcript 预捕获的候选，或断言 `origin/reviewID`/`record.queued`，把 accept 路径也锁住。
- **Minor 4**：fix report §1.2/§4 的“未知不猜归属”与 U2 冲突；§3 “三条断言分别会失败”应改为“移除 key → 3 fail；gate 后移 → test ② fail”。
- **Minor 5**：fake event stream 在 yield 后 `setTimeout(500)` 不响应 abort，dispose 最多多等 500ms；测试稳定性/时长小项。

## 5. 与 P02 历史/验收的关系（不改写历史）

- `reports/02-review.md` 的 I1-I5 与 fix1 结论针对 **orchestrator 类级**逻辑；`review-orchestrator.test.ts` 直接 `new ReviewOrchestrator({projectKey:"A"})`，`plugin.test.ts` 只测拥有者处理。故 **73 files/926 tests 全绿不能证明 setupPlugin 装配**；P02 此前的“clean/可进 P03”在 **host wiring** 这一项上是不完整的。本轮修复才补上 setupPlugin 级 known-foreign 证据。
- 本轮 929 tests 仍是 fake host/组件级 + 3 条 wiring 测试；不是真实 host、不是 P06 门禁，也不证明生产从未发生跨项目写入（audit 的 U 仍未关闭）。
- 本 report 不修改 audit/fix/旧 review；P03-A3 撤回与重设计历史保持原样。

## 6. 给主代理的结论

**known-foreign（state `contextProjectKey`）入口闭合，P02 host wiring 可接受（无新 Critical/Important），可以回到 P03 重设计。** 但必须把 U1（未知 session 的 consolidate 写 A hook；record-known 事件 gate 不读记录）与 U2（未知新 session 被 `session.created` 打 A key）作为 P03-C1 的输入，不能把本轮修复表述为“所有项目已隔离”。建议 P03 设计明确 source/parent/provenance 与 host 事件契约；本轮 Minor 1-6 可随后续同一 owner 的测试/报告修整处理，不构成 P02fix2 或推迟重设计的理由。
