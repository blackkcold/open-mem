# P02 host wiring fix — ReviewOrchestrator projectKey

Status: 最小装配修复完成，待原 P02 reviewer 独立复核；未提交。
Date: 2026-11-11
Scope: 仅 `plugin/src/plugin.ts` 装配 + 自动事件 known-foreign gate + 新增 setupPlugin 回归；未改 orchestrator 算法/预算/分类，未做 P03 设计。
Baseline snapshot: `tmp/full-auto-memory/reviews/p02-wiring-before/`
Patch: `tmp/full-auto-memory/reviews/p02-wiring.patch`（`plugin.ts` + 新增 `test/plugin-wiring.test.ts`）
Verify: `tmp/full-auto-memory/verification/verify-p02-wiring.log` / `.exit`
Probe: `tmp/full-auto-memory/reviews/probe-p02-host-wiring.ts` / `.log` / `.exit`

## 1. 修复

1. `setupPlugin` 的 `new ReviewOrchestrator` 传入与 `knownTitles` 同一个已计算 `projectKey`；`onAccepted` 第 4 参与 `instanceProjectKey` mismatch 检查保留。
2. 自动事件循环在 **seen-event 认领之前** 读取 session：
   - `projectKey` 已定义且 `session.contextProjectKey` 已定义且不同 → 直接 `continue`；
   - 该 gate 早于 parent/context 更新、`consolidate`、`review.schedule`、seen-event 写入；
   - 保留 `event.location.directory` 明确不同即 skip；
   - 未知 `contextProjectKey` 不猜归属，留 P03-C1 原始证据契约。
3. manual `reviewRuntime.run` 外层 `contextProjectKey` guard 未改。

## 2. RED → GREEN

新增 `plugin/test/plugin-wiring.test.ts` 使用真实 `setupPlugin` + fake host：

- ① 预置到期 foreign session（contextProjectKey B）→ A 的 `recover()` 零 generate/review/hook，B 状态不变。
- ② 无 `event.location` 的 automatic `session.execution.succeeded`：A 对 known-foreign 零副作用且 **不占 eventID**；随后真正 owner B 用同一 eventID 可处理。
- ③ own session 复盘：`ReviewRecord.projectKey` 与 project hook 均为权威 key，不退 sessionNote。

RED（修复前）：

```text
cd plugin && npx vitest run test/plugin-wiring.test.ts
Test Files  1 failed (1)
Tests       3 failed (3)
# foreign recover generate=1；foreign auto A generate=1；own review projectKey=undefined
```

GREEN（修复后）：

```text
cd plugin && npx vitest run test/plugin-wiring.test.ts
Test Files  1 passed (1)
Tests       3 passed (3)

npm run verify
Test Files  74 passed (74)
Tests      929 passed (929)
exit 0
```

原 audit probe：修复前 exit 1（foreign generate=1/review ready/hook A key）；修复后 exit 0：

```json
{
  "instanceProjectKey": "sha16(/workspace/A) passed to ReviewOrchestrator",
  "foreignContextProjectKey": "B",
  "generateCalls": 0,
  "reviewCount": 0,
  "foreignReviewProjectKey": null,
  "hookCount": 0,
  "sessionNoteTexts": [],
  "foreignSessionStatusAfter": "scheduled"
}
```

## 3. 测试敏感性

- 旧 `review-orchestrator.test.ts` 直接 `new ReviewOrchestrator({ projectKey: "A" })`，绕过生产装配；旧 `plugin.test.ts` 只测“拥有者处理”，不测“非拥有者拒绝”。因此 73 files/926 tests 全绿不能证明 setupPlugin 接线。
- 新测试从真实 `setupPlugin` 入口驱动 recover 与自动事件，并在 eventID 维度证明 foreign 不吞事件；移除 `projectKey` 装配或把 gate 移到 seen 之后，三条断言分别会失败。
- 新增测试使用 fake `generate`/messages/临时 dataDir，`dispose()` + 清理 timer/dir，无真实模型/网络。

## 4. 边界 / 未决

- 本修复为 **fake host 已证代码路径**；host 是否对 `ctx.event.subscribe` 按目录过滤仍是未知，不能声称生产已真实发生跨项目写入。
- 未知 `contextProjectKey` 的 session 仍按原行为不拦截；P03-C1 未知父/项目原始证据契约后续处理，本修复不扩面。
- 未改 original audit/review 历史；P02 端到端隔离验收从“不完整”修正为：装配+known-foreign 自动入口有 setupPlugin 级证据，仍需 fresh reviewer 复核。
- 未提交、未推送、未安装依赖。
