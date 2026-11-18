# P02 host wiring audit — ReviewOrchestrator projectKey

Status: 只读接线审计 + fake-host setupPlugin probe；**未修产品代码/测试**，未读真实配置/记忆，未发真实模型/网络，未提交。
Date: 2026-11-11
Baseline: 当前 P02 生产树（73 files / 926 tests / verify 0，主代理既有证据；本审计未重跑）。
Probe: `tmp/full-auto-memory/reviews/probe-p02-host-wiring.ts`
Log: `tmp/full-auto-memory/reviews/probe-p02-host-wiring.log`
Exit: `tmp/full-auto-memory/reviews/probe-p02-host-wiring.exit`（**1**，预期失败断言）

## 1. 结论

**缺口成立（高）。** `setupPlugin` 创建 `ReviewOrchestrator` 时没有传 `projectKey`：

```ts
// plugin/src/plugin.ts:481-508（O）
const reviewOrchestrator = new ReviewOrchestrator({
  store, config, reader,
  buildInput: ...,
  knownTitles: () => collectReviewKnownTitles(store, 30, projectKey),
  runModel: ...,
  validate: ...,
  onAccepted: async (input, result, reviewID, authoritativeProjectKey) => {
    ... projectKey: authoritativeProjectKey ...
  },
  ...
});
```

`knownTitles` 用了 `projectKey`，但 orchestrator deps 没有 `projectKey`。因此：

- `deps.projectKey === undefined` → `owns()` 恒 `true`、`recoverOwns()` 恒 `true`（`orchestrator.ts:660-677`，O）。
- `onAccepted` 第 4 参传 `this.deps.projectKey` = `undefined`（`:464-469`，O）。
- `acceptReviewCandidates` 对 `scope="project"` 且无权威 key 的候选降级为 session note（`accept.ts`，O）。

## 2. Fake-host 实证（真实 setupPlugin 入口）

Probe 用真实 `setupPlugin(ctx, {dataDir})`，fake host context、临时 dataDir、fake `experimental.generate.text`；项目实例目录 `/workspace/A`，预置一个 `contextProjectKey="B"`、已到期 `scheduled` 的 session；`ctx.event` 关闭，只走初始化 `recover()`。

输出（`probe-p02-host-wiring.log`）：

```json
{
  "foreignContextProjectKey": "B",
  "generateCalls": 1,
  "reviewCount": 1,
  "foreignReviewStatus": "ready",
  "foreignReviewProjectKey": null,
  "hookCount": 1,
  "hooks": [{ "scope": "project", "projectKey": "cbc9c3febf7e91e2", "text": "以后项目统一用 pnpm 安装依赖" }],
  "sessionNoteTexts": ["项目统一用 pnpm 安装依赖"],
  "foreignSessionStatusAfter": "ready"
}
```

`sha16("/workspace/A") = cbc9c3febf7e91e2`。即该 fake fixture 中：

1. 实例 A 的 `recover()` 为 B 的 session 发起了模型调用（`generateCalls=1`），并写出 `ready` review（`projectKey:null`）。
2. 项目候选没有成为 project hook，而是降级为 `sessionNotes`（`onAccepted` 第 4 参 undefined）。
3. `consolidate` 后续在该 foreign session 上写出了 `projectKey = A` 的 hook（`scope:"project"`），即**代码路径允许把 B session 的内容写入 A 项目**。

断言按“正确行为”编写并失败：

```text
AssertionError: foreign session must not be recovered by another project instance
1 !== 0
```

退出码 1，日志已保留。

## 3. 影响边界（精确）

| 入口 | 现状 | 结论 |
|---|---|---|
| `reviewRuntime.run` / `review_session` manual | 外层检查 `state.contextProjectKey !== projectKey`（`plugin.ts:503-506`，O） | **有保护**；此前手工路径测试通过 |
| `recover()` 初始化 | 无 projectKey → 处理所有 session | **不受保护**；probe 已复现 foreign 被 review |
| `schedule()` / 自动 `runNow()` | `owns()` 恒 true | **不受保护**；server-wide event 下依赖 host 目录过滤 |
| `onAccepted` / accept | 第 4 参 undefined；project 候选降级 session note | **项目记忆身份丢失**，且后续 consolidate 可在实例项目下落 hook |
| `ReviewRecord.projectKey` | `undefined` | 审计/未来 recover 无法按记录判定归属 |

不能据此声称“生产已发生真实跨项目写入”：probe 是 fake host + 临时 dataDir；host 是否对 `ctx.event.subscribe` 按目录过滤仍是 **U**。但代码层在未过滤/初始化扫描场景下确实可写，且现有 P02 单元测试不能证明端到端隔离。

## 4. 为什么此前 P02 测试没抓住

- `review-orchestrator.test.ts` 的 project 隔离测试直接 `new ReviewOrchestrator({ projectKey: "A" })`，绕过了 `setupPlugin` 的装配。
- `plugin.test.ts` 未断言 foreign session 的 recover/schedule 不产生 review/hook；现有跨 workspace 测试只覆盖“拥有者处理”，没有“非拥有者不得处理”。
- 因此 73 files / 926 tests 全绿只证明类级守卫正确，**不证明生产装配把 key 传进去**。此前“P02 端到端项目隔离验收通过”的表述不完整。

## 5. 最小修复建议（后续重新落版，不在本审计执行）

1. `plugin.ts` 构造 `ReviewOrchestrator` 时传 `projectKey`（与 `knownTitles` 同一个已验证值）；不改 orchestrator 语义。
2. 新增 setupPlugin 级回归测试：fake host A + dataDir 中预置 B session（scheduled/到期）→ `recover()` 后断言 `generateCalls=0`、无 foreign review/hook、B session 状态不变；并覆盖 `session.execution.succeeded` 自动 schedule。
3. 同时断言 foreign project candidate 不会降级后经 consolidate 落到 A：要么不运行 foreign review，要么 accept 在无权威 key 时拒绝 project run（需另定最小策略，不在本审计展开）。
4. manual `review_session` 的现有外层守卫保留，并加测试区分 manual 与 auto。

## 6. 测试敏感性 / 未知

- 预期失败断言已在 probe 中保留；修复后同一 probe 应 exit 0。
- 当前未验证 host 是否按目录过滤事件；若 host 已过滤，自动事件路径风险降低，但 `recover()` 初始化扫描仍是代码内可复现缺口。
- 未运行 `npm test`/`verify`；本报告不把 P02 既有 926 tests 当作本次发现的反证。
