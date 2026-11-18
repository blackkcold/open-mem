# P03 分片实施计划（短任务 brief）

Status: A review FAIL, fix1 in progress; B–E 未启动. 方案拆分，代码未验收。
Parent: `03-autonomous-pipeline.md`（全部验收要求保持不变）
Baseline: `tmp/full-auto-memory/reviews/p03-before/`（253 files / 4.4M）
Rule: 单 writer 串行；一块完成并通过该块验收后再派下一块；新短任务 owner 固定负责本块修复；阶段结束由 fresh reviewer 审全 P03。

## 依赖与顺序

```text
A (纯策略 + 类型/config)
  └─ B (Store quarantine/预算/状态)
       └─ C1 (采集/路由/自动新增/touch/抑制)
            └─ C2 (更新/supersede/冲突隔离/review lane)
                 └─ D (maintenance/mode/API/status/PATCH)
                      └─ E (P02 followups + 生产整链 + 全 verify)
```

禁止跨块预写；后续块可读前块已验收代码，但不得改其接口。任何签名不符先在 `03-autonomous-pipeline.md` 记 Ruling 再改。

## A — 纯策略与配置类型

Depends: 无（P01/P02 已验收）
Files:
- `plugin/src/types.ts`：`Authority`、`AutomationConfig`、`QuarantineRecord`、`AutoMemConfig.automation`、`Item.authority?/grantsPermission?:false`、`PersistedState.automation*`
- `plugin/src/config.ts`：默认 `enabled=false`、`ConfigPatch.automation`、`mergeConfig` 深合并
- `plugin/src/memory/sources.ts`（新）
- `plugin/src/memory/supersede.ts`（新）
- `plugin/src/automation.ts`（新）
- 测试：`automation.test.ts`、`automation-sources.test.ts`、`automation-supersede.test.ts`

Interfaces（冻结；A review R1–R6 后修订）:
```ts
segmentSynthetic(text): { text; stripped[] }
classifyAuthority(input): { authority; kind?; reason }
sourceIdentityKey(source, text): string | undefined   // missing real session/message id => undefined
hasVerbatimUserEvidence(evidence, messageText): boolean
planSupersede(input): SupersedePlan   // candidateScope required; projectKey explicit/validated
decideAutomation(input): AutomationRoute
configuredMode(config): "legacy"|"observe"|"autonomous"
```
RED:
- 14 类源 fixture：synthetic 剥离、混排保留 genuine、信封/表格/围栏/引用/子代理/续跑 skip、parentID 兜底；`<task>`/`<template>`/`{{…}}` 不被学成 preference
- benign 祈使→preference；cookie/删除工程知识可学；无授权词 destructive 仍 protected；授权/凭证/部署 protected；strictness 四类 protected
- supersede：版本/端口成功；缺 A→B、**缺 candidateScope/projectKey**、跨 scope、示例、否定、多目标、CAS 前置、manual/promoted/rule 拒绝；`15199` 子串与标识符否定用例真实命中 `not_single_diff`/`negation_flip`
- 路由：rule/skill/session 永不；reviewLane 不用 safeAuto；**普通 global（turn/review 同门）高证据可 auto，同项目多 session 不升级**；冲突→quarantine；预算/容量/抑制→skip
- `autoUpdate=false`：普通内容变更 skip/quarantine；exact/covered touch 允许；`merge_into` 必须 route update
- `sourceIdentityKey` 与 P01 `turnHookKey`/`reviewHookKey` 对照；缺 ID 返回 undefined
Done: 三文件行为测试全绿、`npx tsc --noEmit` 通过；A review clean 后才可交 B。当前 76/999 全绿不等于 A 通过。
Boundary: 不改 consolidate/store/plugin/server；不实现状态读取。

## B — Store 隔离、原子预算与状态

Depends: A
Files:
- `plugin/src/store.ts`：`quarantinePath`、`list/append/write/pruneQuarantine`、`takeAutomationSlot(kind, limit, now, sessionID?, sessionLimit?)`
- `plugin/src/types.ts`：仅补 B 需要的可选状态字段
- 测试：`store-automation.test.ts`

RED:
- quarantine 200 上限、坏行报错不吞、写后读回
- 双 Store 同日写预算：并发 10 次 limit 5 只成功 5；session 上限独立；失败事务回滚不计数；stub `now` 跨 UTC 日切重置
- `takeAutomationSlot` 一次锁内读改写（stat/spy 断言无两步）
Done: 单测绿；`Store.init` 创建 `quarantine.jsonl`；旧 store 测试全绿。
Boundary: 不改 P01 changes/suppression 语义；不实现 TTL（C2/D）。

## C1 — 采集、路由、自动新增、touch、抑制

Depends: B
Files:
- `plugin/src/session/filters.ts` + `consolidate.ts`（capture 前接 `segmentSynthetic`）
- `plugin/src/consolidate.ts`：`captureHooks` 源过滤；`runConsolidation` 的 `automation.enabled` 分支；写入事务 + P01 `recordChange`；exact/covered → `touchItem`；抑制检查
- `plugin/src/plugin.ts`：把 `automation` 传入配置（不接 timer）
- 测试：`consolidate-automation.test.ts`、`suppression-cross-origin.test.ts`

RED:
- synthetic/子代理/任务信封不落 hook；混排只留 genuine
- 自动 add：item + 1 条 `add` change（before/after）+ AUTO_MEMORY；`recordChange` 抛错→item 不落盘
- exact/covered：`seenCount++`、不新建、`lastSuccess` 不变（touch 不算成功写入）
- turn 写入被撤销后 review 同 quote 跳过；不依赖 reviewID；新 messageID 可学；restore 后可再学
- review 描述性可 auto（evidence 逐字匹配）；rule/skill queue
- 预算/容量/backoff→skip 不 queue；shadow=true 只 shadow
Done: 旧 `enabled=false` 测试全绿；新用例独立绿；`consolidate.test.ts` 不改断言。
Boundary: 不做 C2 的 update/supersede/quarantine TTL；不动维护。

## C2 — 更新、supersede、普通冲突隔离

Depends: C1
Files:
- `plugin/src/consolidate.ts`：guard→exact/covered/update/supersede/quarantine 分支
- `plugin/src/memory/quarantine.ts`（新）：`enqueueQuarantine/expireQuarantine/list`
- 测试：`automation-update.test.ts`、`quarantine.test.ts`

RED:
- 兼容新证据→同 id `update`（before/after、CAS `expectedVersion`、失败不写）
- C1–C9 全满足→单 item supersede；旧值入 aliases/历史，可 undo；不新增第二条
- 不满足（缺指向/跨 scope/引用/否定/多目标/CAS 不符/manual/promoted/rule）→ quarantine 且原 item 逐字段不变
- 普通冲突→quarantine（T120 双方保留）；不 queue、不提醒、不计 status 待办；到期删除 + `quarantine_expired`
- 敏感原文不进 quarantine；lint 失败 skip
Done: 数值/标识/否定守卫未被绕过（同一输入在 lane 关闭时仍 conflict）；`curator.test.ts` 旧断言不动。
Boundary: 不做维护 tick/容量回收；不改 relations/linter。

## D — 维护、模式、状态、API

Depends: C2
Files:
- `plugin/src/memory/maintenance.ts`（新）：`runMaintenanceTick(store, config, {now, reason})`
- `plugin/src/memory/curator.ts`：回收调用保持既有事件
- `plugin/src/plugin.ts`：启动 tick + 15min `unref` timer + dispose 清理
- `plugin/src/automation.ts`：`automationStatus` 读取真实 state/stats/capacity
- `plugin/src/server.ts`：`GET /api/automation`、`POST /api/automation/mode`、PATCH 白名单、status 字段
- 测试：`maintenance.test.ts`、`config-automation.test.ts`、`api-automation.test.ts`

RED:
- 启动/周期/dispose：无 tick 不清理；tick 后 TTL 到期；dispose 后无 timer 句柄
- 容量 85/95：policy 内回收（过期/exact/quarantine/shadow/hook caps）→复检恢复；无冷数据如实 blocked+retryAt；保护 manual/promoted/rule/stopped/active 最新/90 天
- 旧 config 无 automation→false；partial PATCH 不丢 enabled；`autoRules=true` 不写 rule
- mode POST 原子设 enabled+shadow，revision 不符 409；observe 不写 item；effectiveMode/blockedReason/retryAt/lastSuccess 真实
- N2 budget retryAt：未耗尽返回 null；N3 health lastError 脱敏；N4 PATCH live；N6 失败/延后字段不并存
Done: `plugin-automation.test.ts` 真实 `setupPlugin` 事件流可见；单实例读 API 无写副作用。
Boundary: 不实现 P06 完整 retention；只做保守有界回收；不改 P01 helper。

## E — P02 followups 收口、生产整链与全门禁

Depends: D
Files:
- `plugin/src/review/orchestrator.ts`：manual `runNow` 尊重未到期 `Retry-After`；N6 清理
- `plugin/src/server.ts` / `plugin/src/plugin.ts`：N3 脱敏一致
- 测试：`review-p03-followups.test.ts`、`plugin-automation.test.ts` 扩展
- `reports/03-autonomous-pipeline.md`、`docs/goals/full-auto-memory/PROGRESS.md`

RED:
- N1 报告修正 + `oldest+HOUR` vs `+1000` 同毫秒边界用例（旧式 RED、新式 GREEN）
- N5 长 timer：溢出/早触发不二次调用、slot 不增；408/425/空返回矩阵
- manual runNow 在 Retry-After 未到期时不发请求、保持 scheduled
- 全链：真实 setupPlugin → capture → auto → change → API → mode 关闭 → 不再写 → dispose
Done: P02 followups N1–N6 逐项关闭或写明真实 deferred；`npm run verify` exit 0；测试数 ≥926+；`git diff --check` 干净；fresh reviewer 全 P03 通过后才算完成。
Boundary: 不重开 P02 fix2；M8 死码/P01 N3 规模留最终 review/P06。

## 全局完成条件（不缩减）

- `ACCEPTANCE.md` §4 全部满足；原 phase03 的零普通审批、源过滤、C1–C9、CAS、容量保护、mode 真实性、预算约束一条不减。
- 自动写/更新只经 `recordChange`；无 L0/skills/config 写入；旧 `/api/items` 形状不变。
- 任何未跑项写 `not-run`，不以原型 green 冒充阶段完成。
