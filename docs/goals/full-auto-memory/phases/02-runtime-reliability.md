# P02 — runtime reliability

Status: pending（preflight 完成 2026-11-11；实现待 P01 验收后开始）
Depends: P00；P01 验收后实现。P01 正在同一 worktree 并行修改 `config/store/types` 等文件；P02 只把 P01 已公布的接口签名当基线，不读在写实现推断完工，也不改其文件。
Blocks: P03, P05
Global constraints: 见 `PLAN.md` §2
Preflight: `docs/goals/full-auto-memory/reports/02-preflight.md`

## 目标

让后台复盘在真实网络/预算/多项目条件下可预期：transport 真正可选、429/空返回有类型、run/request 预算分离且不丢窗口、跨项目不重跑不写入、失败不阻塞对话。P02 不改变“是否自动写记忆”的策略。

## 非目标

- 不新增自动写入 lane、automation 路由、quarantine 语义（P03）。
- 不改 System One 的 8 问协议与模型策略。
- 不引入队列/重试服务；不新增依赖。
- 不做 UI 改版（P05）。
- 不改 P01 文件：`changes.ts`、`memory/suppression.ts`、`consolidate.ts`、`actions.ts`、`apply.ts`、`memory/promotion.ts`、`memory/session-promotion.ts`、`memory/curator.ts`、`retention.ts`、`capacity.ts`；**P02 不需要改 `store.ts`**（现有事务/预算方法足够）。

## 预检事实（先看证据，不按 V1/旧文档猜）

证据取自基线 `b992a2e`；P01 正在同 worktree 改 `config/store/types`，相关行号可能漂移，接口以 DESIGN §8.1 为准。

| 事实 | 证据 |
|---|---|
| V2 生成为 `ctx.experimental.generate.text`，`ctx.generate.text` 仍可用但已 deprecated | 官方 V2 `/build/plugins/server` 的 Generate 段；本地 `@opencode/plugin/dist/promise/plugin.d.ts:40` |
| 输入只有 `{ prompt: string; model?: Model.Ref }`；**没有 `maxOutputTokens`** | `@opencode/client/dist/effect/api/api.d.ts` 的 `GenerateTextInput` |
| 输出只有 `{ text: string }`；**没有 usage/tokens** | 同上 `GenerateTextOutput` |
| 第二个参数可传 `{ signal?: AbortSignal }` | `@opencode/client/dist/promise/generated/client.d.ts` 的 `RequestOptions` |
| `Model.Ref = { providerID, id, variant? }` | `@opencode/schema/dist/model.d.ts`；本地 `types.ts` 的 `ModelRef` 形状一致 |
| review 当前**永远**走 `/api/chat`，`rewrite.transport` 对 review 未生效 | `plugin/src/review/provider.ts:151-210`；`types.ts` 的 `ReviewConfig` 无 `transport`；`rewrite.transport` 仅被 rewrite/设置使用 |
| `request()` 最多 2 次尝试，但不读 `Retry-After`、不 sleep、预算按 `maxPerHour` 计 | `provider.ts:172-207`、`:174` |
| 空 content 只是普通 `Error`，被当作不可重试的传输失败 | `provider.ts:194`、`:341-353` |
| run 预算不足会延后窗口（不丢窗口），request 预算不足则直接失败并计一次 provider failure | `orchestrator.ts:385-397`、`:485-538` |
| `recover()` 遍历所有 session，无 projectKey 过滤 | `orchestrator.ts:183-223` |
| `onAccepted` 只传 3 个参数；accept 用**当前实例** projectKey | `orchestrator.ts:425-429`、`plugin.ts:482-488`、`accept.ts:163` |
| hook 去重是“先 listHooks 再 appendHook”的 check-then-act，跨进程可重复 | `accept.ts:55-60`、`:144-150`、`:180`；`store.ts:222-249`、`:432-438` |
| `status` 当前只 `readAudit`（保持，不是缺陷） | `plugin.ts:707`；`runAudit` 仅在 audit action `:766` |
| 无 audit 时 `emptyAudit()` 也写 `generatedAt=now`，不能据此判“无报告” | `store.ts:68-70`、`:180`；`audit.ts:269` |

## 文件

| 文件 | 改动 |
|---|---|
| `plugin/src/review/provider.ts` | `ReviewGenerate` 适配层；`review.transport` 分支；429/Retry-After 有界退避；空返回 typed error；request 预算 |
| `plugin/src/review/orchestrator.ts` | `recover()`/`schedule()`/`runNow()` 项目隔离；权威 projectKey 传播；预算/失败分类；延后而非 failed |
| `plugin/src/review/accept.ts` | 权威 projectKey + 冲突拒绝；hook 唯一性事务化；保留差异/冲突候选 |
| `plugin/src/plugin.ts` | 注入 `ctx.experimental.generate.text ?? ctx.generate.text` 包装；status 只读字段；`onAccepted` 传权威 key |
| `plugin/src/config.ts` / `types.ts` | 追加 `review.transport?`、`review.maxRequestsPerHour?`、`ReviewRecord.errorKind?`、`AuditReport.auditRunAt?`；不改 P01 已落签名 |
| `plugin/src/server.ts` | `review.transport` 设置校验/白名单；`/api/reviews`、`/api/health` 暴露预算/失败原因（只读） |
| `plugin/src/audit.ts` | `runAudit` 写 `auditRunAt`（仅用于 `auditAgeMs`，不改变 finding 语义） |
| `plugin/test/review-*.test.ts`、`plugin.test.ts` | 见 TDD 顺序；只加断言，不降低旧断言 |

## 接口（以实现时的 V2 事实为准）

```ts
// V2 实际形状：适配层只能这么包，不能伪造 usage 或 maxOutputTokens。
export type ReviewGenerate = (
  input: { model: ModelRef; prompt: string },
  options?: { signal?: AbortSignal },
) => Promise<{ text: string }>;

export interface ReviewProviderOptions {
  // 既有 store/config/key/fetchImpl/now/log
  generate?: ReviewGenerate;        // review.transport="opencode" 时必须提供
  maxRequestsPerHour?: number;      // 缺省按公式推导，见预算
  sleep?: (ms: number) => Promise<void>; // 测试注入；默认 setTimeout
}

export type ReviewFailureKind =
  | "transport" | "http" | "empty" | "format" | "budget" | "config" | "cache"
  | "retry-after";

export class ReviewRequestError extends Error {
  constructor(message: string, countsAsAttempt?: boolean, kind?: ReviewFailureKind);
  readonly countsAsAttempt: boolean; // 只作标签，绝不作为重试开关
  readonly kind: ReviewFailureKind;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  /** 已实际派发的请求数；0 表示确定没发请求。缺省=未知。 */
  readonly requestsMade?: number;
}

export class ReviewEmptyResponseError extends ReviewRequestError {} // kind="empty", countsAsAttempt=true
export class ReviewBudgetError extends ReviewRequestError {
  readonly requestsMade: number;
  /** 最早可用窗口（oldest + 1h + 1s），orchestrator 据此延后。 */
  readonly retryAt?: number;
}

export class ReviewRetryAfterError extends ReviewRequestError {
  /** 上游要求的最早重试时刻；不得被 30s 截断。 */
  readonly retryAt: number;
  readonly requestsMade: number;
}
```

`ReviewCacheError` 保留现有类型与消息，只追加 `requestsMade = 0`（测试仍 `instanceof`）。

`ReviewConfig` 追加：

```ts
transport?: "opencode" | "ollama"; // 缺省 "ollama"，保持旧行为
maxRequestsPerHour?: number;       // 缺省动态推导；显式值优先
```

`onAccepted` 增加第 4 个参数 `projectKey?: string`（来自 review 记录的权威值）。`AcceptReviewDeps` 增加 `instanceProjectKey?: string`，仅用于“不一致拒绝”，**不得**作为 hook 的 projectKey 来源。

## 行为细节

### 1. transport（review 独立，不继承 rewrite）

- `review.transport` 是 review 自己的字段；**现有 `rewrite.transport` 对 review 未生效**，P02 也不把它隐式接过来。旧配置缺该字段 → `"ollama"`，行为与今天一致。
- `ollama`：只走现有 `/api/chat`，保留 `modelHeaders`、endpoint 校验、HTTPS/loopback 限制、`format:"json"`、`num_predict`、`think`。
- `opencode`：只调用注入的 `generate`。`plugin.ts` 优先取 `ctx.experimental?.generate?.text`，否则 `ctx.generate?.text`；包装时传 `{ model, prompt }` 和 `{ signal: AbortSignal.timeout(timeoutMs) }`。
- `opencode` 且 generate 缺失 → 抛 `ReviewRequestError(..., false, "config")`，**不得**静默改走 `/api/chat`，也不得回退到别的 provider。返回非 `{text:string}` 形状同样按 `config` 失败，不按“空返回”。
- `maxOutputTokens` 只对 ollama 生效；opencode 无法经 `generate.text` 限长，phase/status 不得声称它能限长（prompt 里要求简短即可）。
- generate 无 usage → `ReviewRunResult.usage` 省略；**不得估造** token 数。

### 2. 429 / Retry-After / 重试矩阵

**Ruling（2026-11-11 主代理）：`Retry-After` 超过 30 秒不得截成 30 秒后提前重发。30 秒只是“本次后台等待”的上限；更远的 `retryAt` 必须持久化延后到完整上游期限，并保持预算/窗口不丢。**

| 情况 | 行为 |
|---|---|
| 429，`Retry-After` 解析为 ≤30s | 后台 `sleep(wait)` 后重试 **1 次**（wait=0 也允许） |
| 429，`Retry-After` >30s（含 HTTP date） | **不 sleep、不重试当前 run**；抛 `ReviewRetryAfterError{retryAt, requestsMade}`；orchestrator 持久化 `reviewDueAt=retryAt` 延后到完整期限 |
| 429，缺失/非法 header | 用有界默认 `1000ms`，重试 1 次（默认值本身 ≤30s） |
| 408 / 425 / 5xx，带 `Retry-After` | 按同一规则：≤30s sleep 后重试 1 次；>30s 转 `ReviewRetryAfterError` 延后 |
| 408 / 425 / 5xx，无/非法 header | 重试 1 次，退避 1000ms |
| 400 / 401 / 403 / 404 / 413 | 不重试，kind=`http`，消息含状态码 |
| 其他 4xx / 3xx / redirect error | 不重试，kind=`http`/`transport` |
| 网络错误 / timeout / abort | 重试 1 次，1000ms |
| 未知错误 | 不重试，避免无限放大 |

- `retry-after` 解析：纯数字=秒；HTTP date=`deadline−now`；缺失/非法=`1000ms`。**不得**对解析出的上游期限做 30s clamp；30s 只用于决定“本次等待还是转持久化延后”。
- `retry-after` 只对能拿到 response headers 的 ollama 路径生效；opencode 的 `generate` 不暴露 headers，只对可识别的 429/rate-limit/timeout 重试 1 次、固定 1000ms，**不假装读到了 Retry-After**。
- sleep 只能发生在后台 review 任务内（scheduled/manual 都经 orchestrator），不得发生在 `context` hook、`status`、`/api/*` 读路径；单次同步等待 ≤30s，不阻塞用户主对话。
- 重试也占 request 预算；重试被预算拒绝 → `ReviewBudgetError{requestsMade≥1}`。
- `http-deferred`（任何带 `Retry-After` 的可重试状态且期限 >30s）与 `budget` 共用“不 failed、不成功、不加 attempts、不写重复记录”的延后语义；区别只在原因与 `retryAt` 来源。

### 3. 空返回与 repair

- `request()` 在 HTTP 200 但 content 为 `""`/纯空白时**不再抛普通 Error**，返回 `raw: ""`；opencode 的 `text` 同理。
- `review()` 看到空 raw：
  1. `repairAttempts >= 1`：用现有 `buildRepairPrompt(prompt, "", ["模型返回为空"])` repair **1 次**（占 request 预算）；repair 仍空 → `ReviewEmptyResponseError`。
  2. `repairAttempts = 0`：直接 `ReviewEmptyResponseError`。
- 空返回是内容失败：`countsAsAttempt=true`，orchestrator 计一次 session attempt；**不计** provider circuit failure（熔断只反映 endpoint/网络健康）。
- JSON 解析失败仍走现有 repair 1 次；repair 仍失败 → `ReviewRequestError(kind="format", countsAsAttempt=true)`。

### 4. run / request 双预算：延后，不丢窗口，不反复 failed

- run 预算：`takeReviewSlot(now, review.maxPerHour, HOUR)`，一次 review run 一个 slot；repair/429 重试不重复占 run。
- request 预算：`takeModelSlot("review", effectiveMaxRequests, now)`，在**每次实际派发前**占一个 slot（首调/429 重试/repair/repair 重试都算）；被拒绝时不发请求。
- `effectiveMaxRequests = config.review.maxRequestsPerHour ?? Math.max(maxPerHour, maxPerHour * (1 + repairAttempts) * 2)`；乘 2 覆盖“每次请求最多 1 次重试”。显式配置更低时按用户值执行，不自动抬高。
- 预算不足：
  - 抛 `ReviewBudgetError`，带 `requestsMade` 与 `retryAt = oldest + HOUR + 1000`（provider 从 `store.readState()` 只读计算）。
  - orchestrator：`requestsMade === 0` → `releaseReviewSlot`；`requestsMade > 0` → 保留 run slot（调用已发生）。
  - 两种都**不**置 `reviewStatus="failed"`、**不**增 `reviewAttempts`、**不**写 failed review 记录；置 `reviewStatus="scheduled"`、`reviewDueAt = max(now+30s, retryAt)`，重新 arm，广播 `review.skipped {reason:"request-budget"}`，并记 `lastDeferred`。
  - 同一窗口不写重复 skipped 记录；下次仍是同一 `reviewedHash`，窗口不丢。
- run 预算不足：沿用 `orchestrator.ts:385-397` 的延后逻辑（`oldest + HOUR + 1000`，最少 30s），补“不写记录、不加 attempts”的断言。
- `http-deferred`（带 `Retry-After` 且期限 >30s）：orchestrator 捕获 `ReviewRetryAfterError` 后走同一条延后路径：
  - `requestsMade===0` → 释放 run slot；`>0` → 保留 run slot（请求已派发）。
  - **不**置 failed/ready、**不**增 attempts、**不**写 failed 或成功 review 记录；置 `reviewStatus="scheduled"`、`reviewDueAt = retryAt`、`reviewDeferredReason="retry-after"`，广播 `review.skipped {reason:"retry-after"}`。
  - `retryAt` 必须原样保留，不得用 30s 或一小时窗口改写；同一窗口反复收到远期限时只更新 `reviewDueAt`，不累积失败记录。
  - 若 `retryAt - now` 超过 Node `setTimeout` 上限（2^31−1 ms），持久化完整 `reviewDueAt` 后用分段 timer 续等；重启由 `recover()` 按完整期限恢复，绝不提前发请求。

### 5. 失败分类与真实计数语义

| 失败 | request slot | run slot | session attempts | review 记录 | lastError/lastDeferred |
|---|---|---|---|---|---|
| 网络/超时/5xx/429（重试后仍失败） | 每次派发各 1 | 保留 | +1 | failed，`errorKind="transport"/"http"` | lastError |
| 400/401/403/404/413 | 1 | 保留 | +1 | failed，`errorKind="http"` | lastError |
| 空返回 | 每次派发各 1 | 保留 | +1 | failed，`errorKind="empty"` | lastError |
| JSON/格式（repair 后） | 每次派发各 1 | 保留 | +1 | failed，`errorKind="format"` | lastError |
| 预算不足（requestsMade=0） | 0 | **释放** | 0 | 不写 failed；可写 deferred 状态 | lastDeferred |
| 预算不足（requestsMade>0） | 已派发数 | 保留 | 0 | 不写 failed | lastDeferred |
| 带 `Retry-After` 远期限（http-deferred，requestsMade>0） | 已派发数 | 保留 | 0 | 不写 failed/成功；`scheduled` + `reviewDueAt=retryAt` | lastDeferred |
| generate/transport 未配置、缓存损坏（确定未派发） | 0 | **释放** | +1（有界） | failed，`errorKind="config"/"cache"` | lastError |

- `runsLastHour` 是“已占用的 run slot 数”，不是成功数；`requestsLastHour` 是“已预留的 request slot 数”（含失败/abort），不是成功 token 数。状态文案必须按这个语义写。
- 新类型不得复用 `countsAsAttempt` 当重试开关；orchestrator 只按 `kind`/`requestsMade` 决策，保留 `countsAsAttempt` 仅作兼容标签。
- `ReviewRecord` 追加 `errorKind?`；不改变既有 `error`/`note` 字段。

### 6. 项目归属与权威 projectKey

- 插件实例会收到 server 全量事件（`ctx.event.subscribe` 是 server-wide），所以不能只靠“事件路由”保证归属：
  - `schedule()`：读 session 后，若 `deps.projectKey` 已定义且 `session.contextProjectKey` 已定义且不等 → 直接返回，**不写** `reviewDueAt`/`pendingReview`。
  - `runNow()`：同样的守卫放在读 session 之后；外部项目 session 返回 `undefined`，不取 lease、不占预算、不写记录。
  - `contextProjectKey` 未定义的旧 session：auto 路径保守跳过（等本项目的 `refreshContext` 打上 key）；manual 仍由 `reviewRuntime.run` 的相等校验拦住。
  - `deps.projectKey` 为 `undefined` 时（无 project 目录/旧测试）不做过滤，保持旧行为。
- `recover()`：
  - 仅处理 `session.contextProjectKey === deps.projectKey`。
  - `contextProjectKey` 未定义：取该 session **最近一条** review 记录；该记录有 `projectKey === deps.projectKey` 才处理；无记录、记录无 key、或记录 key 不同 → 跳过并记一次日志，**不 updateSession**（不把别的项目状态改掉）。
  - `reviewStatus==="running"` 的崩溃修复只对“已确认属于本项目”的 session 执行；未知归属不修。
  - 不跨项目 re-arm、不写其他项目的 review record。
- `run` 记录：`record.projectKey = 已验证的 deps.projectKey`（无则省略）；`onAccepted(input, result, reviewID, recordProjectKey)` 传同一个值。
- `acceptReviewCandidates`：
  - `deps.projectKey` 只接受 review 记录的权威值；`deps.instanceProjectKey` 只用于比较。
  - `instanceProjectKey !== undefined && projectKey !== undefined && instanceProjectKey !== projectKey` → 返回 `{created:0, skipped:candidates.length, conflicts:0, sessionNotes:[]}`，不建 hook。
  - 不再用当前实例 key 给候选赋值；无权威 key 的 project 候选仍降级为 session note（现有行为）。
  - `hook.projectKey` 只来自 `deps.projectKey`。

### 7. hook 唯一性与差异/冲突候选

- `accept.ts` 的 hook 去重从“先 list 再 append”改为**一个 `store.transaction` 内**：重新 `listHooks()` → 维护 `keys` → 逐条 `appendHook()`。事务持有跨进程文件锁，其他实例无法在 check 与 append 之间插入；失败整批回滚（不留半批 hook）。
- 事务只包 hook 读写，不包 queue/items 相似度计算（那些在事务前算，避免长临界区）；`appendHook` 在事务内因 AsyncLocalStorage 批处理而可重入，不需要新 store 方法。
- 同 key 已存在时：
  - 规范化文本相同 → `skipped`（真重复）。
  - 同 key 但原文不同（`normalizeForFingerprint` 把标点/空格折叠）→ **不静默丢弃**：保留为 `sessionNotes` 候选，`conflicts++`；P03 再决定 quarantine，P02 不新增 quarantine 语义。
- 关系为 `conflict` 的不同文本本来 key 不同，正常进 queue；不得用 `covered` 把带新增子句/替换词的候选判成重复（现有 `classifyRelation` 语义保持）。

### 8. status 与可观测（只读）

- `memory_autopilot action=status` 继续只 `readAudit`，不调用 `runAudit`；新增测试防止回归。
- `auditAgeMs`：`AuditReport.auditRunAt` 存在时 = `now - Date.parse(auditRunAt)`；缺失/非法 → `null`。不能拿 `emptyAudit()` 的 `generatedAt` 冒充“刚审计过”。
- `review`：`runsLastHour`、`requestsLastHour`、`lastError`（脱敏）、`lastFailureKind`、`lastDeferred`（reason/at）。
- `automation`、`quarantine` 属于 P03：P02 **不定义**对应配置/存储，也不返回伪造的 `false`/`0`；字段等 P03 API 存在后再加。
- `/api/reviews` 用 `store.readState()` 计算持久化 `budget`（runs/requests/retryAt）；`/api/health.review.runtime` 保留实例内 best-effort 并标明；不得返回 token、prompt、真实路径或完整错误栈。

## TDD 顺序

1. `review-model.test.ts`：`transport=opencode` 只调 fake generate、`fetch` 0 次；`transport=ollama` 只调 fake fetch；缺 generate → `kind="config"` 且不落 `/api/chat`；旧配置无 transport 默认 ollama。
2. 同上（429 有界退避）：`Retry-After: 5` → `sleep(5000)` 后重试 1 次；`Retry-After: 120` → **不重试当前 run、不调用 sleep(120000)**，抛 `ReviewRetryAfterError{retryAt=now+120000, requestsMade=1}`；HTTP date 为 `now+120s` 同理；缺失/非法 header → `sleep(1000)` + 重试 1 次；400/401/403/404/413 不重试；408/425/5xx 各 1 次。断言 fetch 次数、sleep 参数与 `retryAt`，不真实等待。
3. 同上：空 content → repair 1 次；repair 仍空 → `ReviewEmptyResponseError`；`repairAttempts=0` 直接抛；空返回不增加 circuit failures。
4. `review-reliability.test.ts`：request 预算在首调/重试/repair 各占 1；`maxRequestsPerHour` 缺省公式；预算拒绝 0 派发时抛 `requestsMade=0`；重试被拒时 `requestsMade=1`。
5. 同上：orchestrator 收到 `requestsMade=0` 释放 run slot、不 failed、不增 attempts、`reviewDueAt≈retryAt`；`requestsMade>0` 保留 run slot；run 预算不足仍延后且不写重复 skipped。
6. 同上（http-deferred）：`ReviewRetryAfterError` → `reviewStatus="scheduled"`、`reviewDueAt≥now+120s`（不被 30s 截断）、`reviewAttempts` 不变、无 ready/failed 记录、无重复 skipped；连续两次远期限只更新 dueAt，不累积 failure；`retryAt` 超过 `setTimeout` 上限时分段续等，重启由 `recover()` 恢复。
7. 同上（预算/http-deferred 计数）：两条路径都不得写入成功记录、不得写重复 failure；`runsLastHour`/`requestsLastHour` 只按已占用 slot 计。
8. `review-orchestrator.test.ts`：A 项目 session 被 `recover()` 处理；B 项目（含 running 无 dueAt）**零写入**；C 旧 session 有匹配 review 记录→处理，记录不匹配/无记录→跳过；manual `runNow(foreign)` 返回 undefined。测试用 fake `now`/短 timer，`dispose()` 清理。
9. `review-integration.test.ts`：权威 key 与实例 key 不一致 → skipped 且无 hook；一致 → hook.projectKey 为权威值；legacy project 候选 → session note；两个 `Store` 实例并发 accept 同一结果 → 仅 1 条 hook（跨进程文件锁）；规范化折叠但原文不同的候选保留为 session note/`conflicts`。
10. `plugin.test.ts`：status 不调用 `runAudit`（spy/mock 断言 0 次）；`auditAgeMs` 有/无 `auditRunAt` 两态；新字段存在且不含 token/prompt/路径。
11. 可选并发测试：review 处于注入 sleep 时，`status` 立即返回（证明重试不占用户读路径）。

所有测试只用 fake `fetch`/`generate`/`sleep`/`now`；不发起真实模型或网络请求。

## 验收

- `ACCEPTANCE.md` §3 全部通过；现有 review 测试断言不降低。
- `npm run verify` exit 0（实现阶段执行；本预检不跑）。
- `grep -n "/api/chat" plugin/src/review/provider.ts` 只在 ollama 分支；`grep -n "runAudit" plugin/src/plugin.ts` 只在 audit action。
- 代码审查：无 `as any`/`ts-ignore`/`ts-expect-error`；无新依赖；无真实模型调用。
- 行为审查：预算不足只延后；跨项目 session 无写入；accept 不覆盖权威 key；hook 并发不重复。

## 实现顺序与 P01 边界

0. **实现前置（P01 验收后）**：先把 DESIGN §8.2 的陈旧段与本文对齐——旧 `maxPerHour*3` 默认值、`ReviewGenerate` 含 `maxOutputTokens`/`usage` 的签名、以及“30s clamp”表述；再编码。本预检不改 DESIGN。
1. 先落 provider 类型/transport/重试/空返回（不依赖 P01）。
2. 再落 orchestrator 的预算分类与项目守卫（只用现有 `takeReviewSlot`/`releaseReviewSlot`）。
3. 最后落 accept 事务与权威 key、plugin/status/server 字段。
4. P02 测试不得断言 P01 的 change event/`recordChange` 结果；`onAccepted` 集成测试用 stub 或只断言 hook。P01 实现中的文件一律不改。

## 风险

| 风险 | 处理 |
|---|---|
| V2 生成 API 仍标 experimental，签名可能变 | 适配层隔离；运行时校验 `{text:string}`；缺失/形状不符明确 `kind="config"`，不猜 |
| 默认 request 预算放大调用上限 | 公式只放宽“重试/repair”所需；显式配置仍可收紧；`runsLastHour`/`requestsLastHour` 按 slot 语义展示 |
| 预算延后造成窗口饥饿 | `retryAt` 精确到最早释放点；每次延后只做一次预算检查，不循环请求 |
| 旧 session 无 projectKey | 有匹配记录才处理；否则跳过且不写，等本项目下一次请求刷新 |
| 事务内做重活拖慢写入 | 只把 hook list/append 放事务；相似度计算在事务前 |
| 规范化键碰撞误丢内容 | 原文不同则保留为 session note + `conflicts`，不静默丢弃 |
| status 字段泄漏 | 只返回计数/时间/错误类别；错误消息脱敏 |

## Fix round 1 裁决（2026-11-11，独立 review `02-review.md`）

必修（同作者最小修复，先 RED 后 GREEN）：

- **I1**：`transport/generate` 可用性检查先于 request reserve；确定未派发的 config 错误 `requestsMade=0`、不占 request、释放 run；已调用但返回形状错误保留真实派发计数。
- **I2**：`ReviewCacheError` 带 `kind="cache"`、`requestsMade=0`；orchestrator 释放 run，不记 transport。
- **I3**：`reviewDeferredReason="retry-after"` 且未到 `reviewDueAt` 时，任何新用户 `schedule()`/idle/checkpoint 不得缩短期限；保留完整 not-before 跨 `recover`。
- **I4**：第二次 429/408/425/5xx 的远 `Retry-After` 同样 typed defer；不得按 http failure 计数/丢窗口。
- **I5**：单次 timer 上限分段；回调/`fire` 早触发续 arm；`recover` 复用同一 helper。

Minor：M1 status `lastFailureKind` + `/api/reviews.budget.retryAt`；M2 status/API 错误脱敏（不含路径/引号内容）；M3 `budgetRetryAt = oldest+HOUR+1000`，去掉 `min`；M4 redirect 不可重试；M5 `retryAfterMs` 落到错误契约或明确内部；M6 成功/正常调度清 `reviewDeferredReason`，但不越过 not-before；M7 未知归属跳过有界记一次日志且不认领；M9 报告 provider 新增测试 10 项；M10 PATCH 非法 transport/optional maxRequestsPerHour 400 零写、合法持久并下次生效。M8 死码/联合类型复用 deferred 至最终 review，不趁机重构。

## Wiring fix 裁决（2026-11-11，`02-host-wiring-audit.md`）

缺口：`setupPlugin` 的 `new ReviewOrchestrator` 未传 `projectKey`，导致 `owns()/recoverOwns()` 恒 true、`onAccepted` 第 4 参恒 undefined；`02-host-wiring-audit.md` 的 setup+fakehost probe 已复现 foreign session 被 A 实例 review、project 候选降级 session note，并写出 A key 的 hook（fake fixture，非真实生产发生）。

最小方案（不改 orchestrator 算法/预算/分类）：

1. `plugin.ts` 构造 `ReviewOrchestrator` 时传入与 `knownTitles` 同一个已计算 `projectKey`；保留 `onAccepted` 权威第 4 参、`instanceProjectKey` mismatch 检查。
2. 事件循环：在 **seen-event 认领之前** 读取 session；若 `projectKey` 已定义且 `session.contextProjectKey` 已定义且不等，直接 continue。该 gate 必须早于 parent/context 更新、`consolidate`、`review.schedule` 和 seen-event 写入，避免 foreign 事件被吞、真正 owner 无法处理。保留 `event.location.directory` 明确不同即 skip；未知 `contextProjectKey` 不在本轮猜归属（P03-C1 原始证据契约后续处理）。
3. 验收：真实 `setupPlugin` + fakehost 回归——foreign 到期 session `recover()` 零 generate/review/hook 且业务状态不改；无 `event.location` 的 automatic execution event 对 known-foreign 零副作用且不占 eventID，随后真正 owner 同 eventID 可处理；own session review record 与 project hook 使用权威 key，不退 session note；manual 外层 guard 保留。原 probe 修后 exit 0。
