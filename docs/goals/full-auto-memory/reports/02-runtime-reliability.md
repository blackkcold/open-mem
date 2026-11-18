# P02 runtime reliability — implementation report

Date: 2026-11-11
Scope: P02 only. No commit/push, no real model call, no real host/P06 gate, no `~/.config` or production data access.
Baseline snapshot: `tmp/full-auto-memory/reviews/p02-before/`（含 P01 untracked source/test）
Patch: `tmp/full-auto-memory/reviews/p02.patch`（snapshot→current，仅 12 个 P02 文件；不累计 P01）
Verify: `tmp/full-auto-memory/verification/verify-p02.log` / `.exit`

## 1. 结果

| 项 | 结果 |
|---|---|
| 产品代码 | 已实现（8 个 src + 4 个 test 文件） |
| 全门禁 | `npm run verify` exit 0；Test Files 72 passed / Tests 913 passed；含 typecheck/build/extension + `git diff --check` |
| 独立验收 | 未执行；需 fresh reviewer。本报告不是验收结论 |
| 真实宿主 / P06 | not-run |
| 真实模型/网络 | 未发起；测试全部 fake `fetch`/`generate`/`sleep`/`now` |

## 2. 逐项实现

| 契约 | 实现 |
|---|---|
| V2 generate | `ReviewGenerate` 按 `{prompt,model?}→{text}`；plugin 优先 `ctx.experimental.generate.text`，回退 `ctx.generate.text`；不传 `maxOutputTokens`、不伪造 usage |
| 独立 transport | `review.transport` 新增，默认 `"ollama"`；`opencode` 缺 generate/形状不符 → `kind="config"`，不落 `/api/chat`，无跨 provider fallback |
| 429/Retry-After | 429/408/425/5xx：≤30s 注入 `sleep` 后重试 1 次；>30s 抛 `ReviewRetryAfterError{retryAt}`，不 sleep、不提前重发；缺失/非法才默认 1000ms；opencode 仅识别瞬态错误固定 1s |
| 空返回 | `request()` 返回 `raw:""`；repair 1 次；仍空/无 repair → `ReviewEmptyResponseError`；不计 provider circuit |
| 双预算 | run=`takeReviewSlot`；request 每次实际派发前 `takeModelSlot("review", effective)`；`effective=maxRequestsPerHour ?? max(maxPerHour, maxPerHour*(1+repairAttempts)*2)` |
| 预算延后 | `ReviewBudgetError`：`requestsMade=0` 释放 run，`>0` 保留；与 `ReviewRetryAfterError` 都不置 failed、不加 attempts、不写成功/failed 记录，scheduled 到完整 `retryAt`；`reviewDeferredReason` 持久化 |
| 项目隔离 | `recover()` 只处理本 instance project；无 key 按最近 review record 判定，无法判定/不匹配跳过且零写入；`schedule()`/`runNow()` 同样守卫 |
| 权威 projectKey | `onAccepted(..., projectKey)` 传 review 记录值；accept `projectKey` 只来自权威值，`instanceProjectKey` 仅用于不一致拒绝；不一致全 skipped |
| hook 幂等 | check+append 移入同一 `store.transaction`；跨 `Store` 实例并发只落 1 条；normalized key 相同但原文不同 → 保留 session note + `conflicts` |
| status | 继续只 `readAudit`；`runAudit` 写 `auditRunAt`；`auditAgeMs` 缺失为 null；新增 review `runsLastHour`/`requestsLastHour`/`lastError`/`lastDeferred`；不伪造 automation/quarantine |
| config/server | `review.transport`、`review.maxRequestsPerHour` 深合并、PATCH 校验、持久设置白名单；`/api/health`、`/api/reviews` 暴露 transport/预算只读字段 |

## 3. 真实命令与输出

```text
# targeted
cd plugin && npx vitest run test/review-model.test.ts test/review-orchestrator.test.ts \
  test/review-integration.test.ts test/review-reliability.test.ts test/review-api.test.ts test/plugin.test.ts
Test Files  6 passed (6)
Tests      112 passed (112)

# full gate（第一次）
npm run verify
Test Files  1 failed | 71 passed (72)
Tests       1 failed | 912 passed (913)
失败：api.test.ts 期望 persistedSettings=40，新增两个 review 设置后实际 42

# 修正测试期望（新增字段导致的契约变化，不是放宽断言）后
npm run verify
Test Files  72 passed (72)
Tests      913 passed (913)
exit 0
```

日志：`tmp/full-auto-memory/verification/verify-p02.log`，exit：`tmp/full-auto-memory/verification/verify-p02.exit`。

## 4. 测试说明（诚实标注）

- 新增 provider 10 项、orchestrator 4 项、accept 3 项；orchestrator 首轮曾观察到失败（recover 定时器断言与 0ms timer 竞争），修正测试时钟后全绿。
- provider/accept 的新测试与实现同批落地，未逐条保留 RED 日志；因此**不能**声称为严格逐条 RED→GREEN 证据。全量 913 与新增断言是当前证据。
- 长 `Retry-After` 测试注入 `sleep`/`now`，未实际等待 120s；无真实模型请求。

## 4b. Fix round 1（独立 review `02-review.md`）

基准：`tmp/full-auto-memory/reviews/p02-fix1-before/`；本轮 diff：`tmp/full-auto-memory/reviews/p02-fix1.patch`（7 文件，含新增 `test/review-fix1.test.ts`；不 git add）。

### RED（先复现，再修）

```text
cd plugin && npx vitest run test/review-fix1.test.ts
Test Files  1 failed (1)
Tests       9 failed | 2 passed (11)
```

失败覆盖：I1 config 占 request/run slot、I2 cache 记 transport、I3 新消息提前 re-arm、I4 第二次远 Retry-After 记 http、I5 25 天 timer 溢出后 scheduled=0、M3 预算边界、M4 redirect 重试、M7 未知归属无日志。两处先绿（restart/bad-shape 守卫）未当作修复证据。

### Important

| ID | 根因 | 最小修复 | 证据 |
|---|---|---|---|
| I1 | `reserveRequest` 先于 dispatch；`modelStarted` 才决定释放 run | `request()` 在 reserve 前检查 opencode/generate；orchestrator 按 `requestsMade===0` 释放；bad-shape `requestsMade=1` 保留 | config 失败 request slots=0/run=0；bad shape run=1 |
| I2 | `ReviewCacheError` 无 kind/requestsMade；failureKind 回落 transport | 错误带 `kind="cache"`、`requestsMade=0`；按 0 释放 run | record `errorKind=cache`、无 transport note、run=0 |
| I3 | `schedule()` 重写 `reviewDueAt` 为 idle/checkpoint | `reviewDeferredReason==="retry-after"` 且未到 due 时保留完整 due，仅更新 user tail | deferral 后 due 不缩短，reason 保留 |
| I4 | 远期限判断嵌在 `attempt===0` 内 | 重试循环每次命中 `waitMs>30s` 都抛 `ReviewRetryAfterError`，`requestsMade` 准确 | 2 次 429 → retry-after + requestsMade=2，sleeps=[2000] |
| I5 | `setTimeout` 直接接收 >2^31−1；`fire` 早到直接 return | `arm()` 单次 ≤2^31−1 分段续等；`fire()` 早触发重新 arm；`recover` 复用 arm | 25 天期限 60ms 后仍 scheduled=1，due 不变 |

### Minor

- M1：status 增 `lastFailureKind`；`/api/reviews.budget.retryAt` = 最早 request slot+HOUR+1000。
- M2：status 只返回 kind 对应短标签，不返回原始 `lastError`/路径/prompt；新增断言 `content` 不含 dataDir。
- M3：`budgetRetryAt` 改为 `oldest+HOUR+1000`，去掉 `Math.min(now+HOUR,…)`。
- M4：`classifyRetry` 检查 `error.cause` 的 redirect，直接非重试。
- M5：`ReviewRequestError.retryAfterMs` 落地并在 `toRequestError` 传递（无公开消费者）。
- M6：成功/正常 `schedule()` 清 `reviewDeferredReason`；retry-after not-before 分支保留。
- M7：`recover()` 对未知归属 session 有界记一次日志，不认领/不写 session。
- M9：provider 新增测试计数纠正为 10。
- M10：PATCH 非法 `review.transport`/`maxRequestsPerHour` 400 零写；合法值持久并生效；新增 API 测试。
- M8：`isTransportFailure` 死码/联合类型复用 **deferred**，交最终 review，不做类型重构。

### GREEN / 门禁

```text
cd plugin && npx vitest run test/review-fix1.test.ts
Test Files  1 passed (1)
Tests      11 passed (11)

cd plugin && npx vitest run test/review-fix1.test.ts test/api.test.ts test/plugin.test.ts
Test Files  3 passed (3)
Tests      64 passed (64)

npm run verify
Test Files  73 passed (73)
Tests      926 passed (926)
exit 0
```

日志：`tmp/full-auto-memory/verification/verify-p02-fix1.log` / `.exit`；`git diff --check` 含在 verify 内。

## 5. 剩余边界

1. fresh reviewer 独立审查未执行。
2. 真实 OpenCode host 的 `experimental.generate.text` 行为未实测（仅官方 + 本地类型核对）；P06 host 门禁 not-run。
3. `/api/reviews` 预算读取为持久化 slot 计数，不是成功 token 数；状态文案已按此语义。
4. `auditRunAt` 为 P02 新增可选字段；旧审计报告无该字段时 `auditAgeMs=null`，不冒充新鲜。
5. 未提交、未推送、未改 P01 已验收行为；P02 patch 由 p02-before 快照对比生成，未使用累计 HEAD diff。
