# P02 preflight — runtime reliability

Date: 2026-11-11
Scope: 只读静态核查 + 更新 `phases/02-runtime-reliability.md`；不改产品代码、不跑测试/构建、不提交、不访问真实配置/记忆/凭证、不发起模型请求。
Method: 读基线 `b992a2e` 的 review/plugin 源码、`plugin/node_modules/@opencode/*` 已安装 V2 类型、V2 官方 `https://opencode.ai/v2/docs/build/plugins/server`；P01 正在**同一个 worktree** 并行修改 `plugin/src/{config,store,types}.ts` 并新增 `changes.ts`，本预检未读取、未修改这些在写文件，也不据其判断 P01 完工；P02 只以 DESIGN §8.1 的签名和基线方法为基准。

## 1. 结论

预检通过（文档层）。P02 方案已按以下事实修正：V2 `generate` 的真实签名、review 需要独立 transport、429/Retry-After 有界退避（含主代理 Ruling：>30s 不得 clamp 后提前重发）、空返回 typed retry、run/request 双预算延后而非丢窗口、recover/自动入口的项目隔离、权威 projectKey 传播、hook check/append 事务化。未修改产品代码，未运行测试。

## 2. V2 generate 事实（官方 + 本地类型）

官方 V2 `/build/plugins/server` 的 Generate 段：

- `ctx.generate.text` 仍可用但已 deprecated，优先 `ctx.experimental.generate.text`。
- 调用形状：`{ model: { providerID, id }, prompt }`。
- 返回：`{ text }`。
- 同页 `session.generate` 返回 `{ text }`；不用于 review，避免创建 session/触发工具。

本地已安装类型（比文档更精确）：

```ts
// @opencode/client/dist/effect/api/api.d.ts
export type GenerateTextInput = {
  readonly prompt: string;
  readonly model?: Model.Ref | undefined;
};
export type GenerateTextOutput = { readonly text: string };
export interface GenerateApi<E = never> {
  readonly text: GenerateTextOperation<E>;
}

// Model.Ref = { providerID; id; variant? }
// 第二参数 RequestOptions = { signal?: AbortSignal; headers?; onActivity? }
```

裁决：

1. `ReviewGenerate` **不得**包含 `maxOutputTokens`；该字段只保留给 ollama 的 `num_predict`。
2. **不得**声明/伪造 `usage`；`generate` 路径省略 `ReviewRunResult.usage`。
3. 适配层优先 `ctx.experimental.generate.text`，回退同 API 的 `ctx.generate.text`；这不是“换 provider 回退”。
4. `opencode` 且 API 缺失/返回形状不符 → `ReviewRequestError(kind="config")`，明确失败，**不**静默走 `/api/chat`。

原 phase 文档的 `{ model; prompt; maxOutputTokens }` 与 `usage` 已纠正。

## 3. 现状核查（基线代码）

| 项 | 观察 | 影响 |
|---|---|---|
| review transport | `provider.ts:151-210` 永远 `POST ${endpoint}/api/chat`；`ReviewConfig` 无 `transport`；`rewrite.transport` 只被 rewrite 使用 | 现有 `rewrite.transport` 对 review 未生效；需独立字段 |
| 重试 | `provider.ts:172-207` 固定 2 次；`isRetryable` 只看 5xx/网络；不读 `Retry-After`、不 sleep | 429 无退避；4xx 分类过粗 |
| 空返回 | `provider.ts:194` 抛普通 `Error("复盘模型返回为空")`，`isRetryable` 为 false | 不是 typed error，也不会 repair |
| request 预算 | `provider.ts:174` 用 `review.maxPerHour`，每次尝试各占 1 | 与 run 预算混用；429/repair 会悄悄挤占 run 配额 |
| run 预算 | `orchestrator.ts:385-397` 拒绝后 `scheduled` + `oldest+HOUR+1000` | 已做到“不丢窗口”，保留并补断言 |
| 预算失败 | 预算拒绝被 `review()` 外层 `recordFailure()` 计入 circuit；orchestrator catch 统一 `failed` + `attempts+1` | 预算不足会反复 failed，必须单独处理 |
| recover | `orchestrator.ts:183-223` 遍历 `state.sessions` 全部，无 projectKey 过滤；`running` 修复也直接写 | 跨项目 re-arm/写入风险 |
| 自动入口 | `ctx.event.subscribe` 是 server-wide；`schedule()` 无归属校验；`runNow()` 只在 manual 包装层校验 | 自动路径可能用错项目身份 |
| 权威 key | `onAccepted` 3 参；`plugin.ts:487` 传当前实例 `deps.projectKey`；`accept.ts:163` 直接赋给 hook | 旧 review/跨项目时可能覆盖来源 |
| hook 唯一性 | `accept.ts:55-60` 先 `listHooks`，`:144-150` 查 `keys`，`:180` 再 `appendHook`（各自加锁） | check-then-act 跨进程可重复；同 key 不同原文被静默丢 |
| status | `plugin.ts:707` 只 `readAudit`；`runAudit` 仅 `:766` | 正确，仅补只读字段和回归测试 |
| auditAge 语义 | `store.ts:68-70` 的 `emptyAudit()` 也写 `generatedAt=now` | 无法区分“从未审计”，需 `auditRunAt` 标记 |
| 预算读取 | `store.ts:634-663` 的 `takeModelSlot`/`takeReviewSlot`、`:665+` 的 `releaseReviewSlot` 已存在；`transaction` 在 `:222-249` | P02 **不需要**改 `store.ts`，避开 P01 |

## 4. 预检决定

1. **transport**：新增可选 `review.transport`，缺省 `"ollama"`（与旧行为一致）；与 `rewrite.transport` 完全解耦；无隐式故障回退。配置写入 `mergeConfig`、server PATCH 校验、`PERSISTED_SETTINGS_PATHS`。
2. **重试**：429 读 `Retry-After`（秒/HTTP date，缺失 1000ms）；≤30s 才 `sleep` 后重试 1 次；>30s **不 sleep、不提前重发**，转持久化 `retryAt` 延后（见 §5 Ruling）；408/425/5xx 无/短 `Retry-After` 时 1 次 1000ms，远期限同样转延后；400/401/403/404/413 及其他 4xx/3xx 不重试。opencode 无法读 headers，只对可识别瞬态错误固定 1000ms，不假装读到 `Retry-After`。
3. **sleep 注入**：provider 增加 `sleep`，默认 setTimeout；测试注入 fake，不真实等待。sleep 只在后台 review 任务内，不在 `context` hook/status/读 API。
4. **空返回**：`request()` 返回 `raw:""` 而不是抛普通错误；`review()` 有 `repairAttempts` 时 repair 1 次，否则/仍空抛 `ReviewEmptyResponseError`（`countsAsAttempt=true`）。空返回不计 provider circuit。
5. **双预算**：run 用 `takeReviewSlot`；request 每次实际派发前 `takeModelSlot("review", effectiveMaxRequests)`；`effective = maxRequestsPerHour ?? max(maxPerHour, maxPerHour*(1+repairAttempts)*2)`。原文档 `maxPerHour*3` 不足覆盖“每次请求 1 次重试 × repair”，已纠正。
6. **预算不足**：`ReviewBudgetError{requestsMade, retryAt}`；`requestsMade=0` 释放 run slot，`>0` 保留；都不置 failed、不加 attempts、不写 failed 记录，只 `scheduled` 到 `max(now+30s, retryAt)` 并记 `lastDeferred`。
7. **失败计数**：新增 `kind`（transport/http/empty/format/budget/config/cache/retry-after）；`countsAsAttempt` 只作兼容标签，不再当重试开关。`runsLastHour`=占用的 run slot，`requestsLastHour`=预留的 request slot，不冒充成功数/token；budget/http-deferred 都不是成功、也不重复 failure。
8. **项目隔离**：`recover()` 只处理 `contextProjectKey===deps.projectKey`；无 key 时按“最近一条 review 记录”判定，无法判定/不匹配 → 跳过且**不写**；`running` 修复只对已归属 session。`schedule()`/`runNow()` 增加同样的归属守卫（事件是 server-wide，不能只靠路由）。
9. **权威身份**：`onAccepted` 第 4 参传 review 记录的 projectKey；accept 的 `projectKey` 只来自权威值，`instanceProjectKey` 仅用于不一致拒绝；不一致 → 全部 skipped、无 hook；无权威 key 的 project 候选仍降级 session note。
10. **hook 并发**：check+append 放进同一个 `store.transaction`（跨进程文件锁）；失败整批回滚。同 key 且原文相同 → skipped；同 key 但原文不同（规范化折叠）→ 保留 session note + `conflicts`，不静默丢。queue/items 相似度计算留在事务外，缩短临界区。
11. **status**：继续只 `readAudit`；`auditAgeMs` 依赖 `runAudit` 写入的 `auditRunAt`，缺失为 `null`；P02 不加 automation/quarantine 的伪造字段。

## 5. Ruling（2026-11-11 主代理补记）

**`Retry-After` 超过 30 秒不得截成 30 秒后提前再发。30 秒仅“本次后台等待”的上限；更远的 `retryAt` 必须持久化延后到完整上游期限，并保持预算/窗口不丢。**

落地：

- `Retry-After` 解析为 ≤30s：后台 `sleep(wait)` 后重试 1 次；缺失/非法才用有界默认 1000ms。
- 解析为 >30s（数字秒或 HTTP date）：当前 run **不 sleep、不重试、不提前发**；抛 `ReviewRetryAfterError{retryAt, requestsMade}`。
- orchestrator 捕获后：`reviewStatus="scheduled"`、`reviewDueAt=retryAt`（原样，不用 30s/一小时改写）、`reviewDeferredReason="retry-after"`；不置 ready/failed、不增 attempts、不写成功/failed 记录、不重复 skipped。
- run slot：`requestsMade>0` 保留（请求已派发），`=0` 释放；request slot 按实际派发计。`retryAt-now` 超过 `setTimeout` 上限时分段续等，重启由 `recover()` 按完整期限恢复。
- budget 与 http-deferred 共用“不成功、不重复 failure、只延后”的计数语义。

测试（实现阶段先写失败测试）：

1. `Retry-After: 120` → fetch 只 1 次、`sleep` 未被调用（尤其不得 `sleep(30000)` 后提前重发）、`ReviewRetryAfterError.retryAt=now+120000`、orchestrator `reviewDueAt≥now+120s`。
2. HTTP date = `now+120s` → 同上；HTTP date 在过去 → 0 等待/可立即重试。
3. 缺失/非法 header → 默认 1000ms 后重试 1 次。
4. 预算不足与 http-deferred 都不写 ready、不重复写 failed、不增 attempts；`runsLastHour`/`requestsLastHour` 只反映已占 slot。
5. 全部用注入 `now`/`sleep`/fake fetch，不真实等待、不真实请求。

附注：§2 的 V2 签名是“官方文档 + 本地已安装类型”核对，**不是实机模型调用验证**；实现时先同步 DESIGN §8.2 的陈旧段（旧 `maxPerHour*3`、`ReviewGenerate` 含 `maxOutputTokens`/`usage`、30s clamp 表述）与本文一致，再编码。

## 6. 属于 P03（P02 不做）

- automation 路由/`decideAutomation`、benign 祈使句分类、日预算、kill switch。
- quarantine 的存储、TTL、`/api` 与 status 计数、冲突候选的隔离语义（P02 只保留内容 + `conflicts` 计数）。
- 自动写入/`recordChange` 策略（P01/P03）；P02 的 accept 只建 hook，写入仍由现有 consolidation 负责。
- UI/console 展示 review transport/预算（P05）；P02 只保证 API 字段存在、只读、脱敏。

## 7. 风险与未决

| 风险 | 状态 |
|---|---|
| `ctx.experimental.generate` 仍标 experimental，版本升级可能变形 | 适配层 + 运行时形状校验；缺失明确报错，不猜 |
| `Retry-After` 在 opencode 路径不可得 | 只对可识别瞬态错误固定 1s；文档/测试不声称读 header |
| 旧 session 无 `contextProjectKey` 且无 review 记录 | 保守跳过且不写；本项目下一次请求 `refreshContext` 后会重新入队 |
| 并发 accept 测试能否真实覆盖跨进程 | 用两个 `Store` 实例同目录 + 文件锁验证；这是现有 `store.test.ts` 已用的模式 |
| P01 正在同一 worktree 写 `config/store/types/changes`，后续还会改 `consolidate.ts` | P02 不读在写实现、不改其文件；等 P01 验收后再实现/对齐；集成测试用 stub，不断言 change event |
| `review.maxRequestsPerHour` 显式设得过低 | 按用户值执行，只影响重试/repair，不自动抬高；状态可见 |
| `auditRunAt` 需动 `audit.ts` | 只加一个可选字段，不改 finding/`generatedAt`；现有测试不受影响 |

## 8. 验证记录

| 检查 | 方式 | 结果 |
|---|---|---|
| V2 generate 签名 | 官方 V2 server 文档 + 本地 `@opencode/client`/`@opencode/plugin` 类型 | 已核对（见 §2）；**非实机模型调用验证** |
| Ruling | 主代理已接受 `02-preflight.md` 主体，唯一修正“Retry-After 与 30s 等待”不得 clamp 提前发 | 已记入 §5 与 phase §2/§4 |
| review/provider 现状 | 只读 `plugin/src/review/provider.ts` | 已核对 |
| orchestrator/recover/预算 | 只读 `plugin/src/review/orchestrator.ts` | 已核对 |
| accept/hook 并发 | 只读 `plugin/src/review/accept.ts`、`plugin/src/store.ts` | 已核对 |
| plugin provider 装配/status | 只读 `plugin/src/plugin.ts` | 已核对 |
| 测试/构建 | 未运行（预检禁止；P00 基线日志已存在） | not-run: 本阶段只做静态预检 |
| 产品代码/真实数据 | 未改、未访问；P01 在写的 `config.ts`/`store.ts`/`types.ts`/`changes.ts` 未读取（仅 `git status`/`git diff --stat` 确认它们存在） | 符合约束 |

## 9. 文档合版同步（2026-11-11，P02）

已把 phase02 与本文裁决同步到总文档的 P02 相关段（只动 P02，不动 P01/P03/P04/P05/P06 段或 `PROGRESS.md`）：

| 目标 | 段落 | 同步内容 |
|---|---|---|
| `DESIGN.md` | §6.1 review 配置 | `review.transport` 独立默认兼容；`maxRequestsPerHour` 陈旧 `maxPerHour*3` 改为冻结公式 |
| `DESIGN.md` | §8.2 P02 产出 | V2 `generate` 精确签名与 experimental 优先；不伪造 `maxOutputTokens`/`usage`；独立 `review.transport` 默认兼容/禁止隐式 fallback；`ReviewRetryAfterError`；`Retry-After` 完整期限；空返回 repair；双预算真实计数；权威 projectKey；事务化 hook；status 只读与真实 `auditRunAt` |
| `DESIGN.md` | §10 失败与降级（Review 行） | 429/5xx 只在 ≤30s 等待；>30s 完整期限延后；预算/http-deferred 不置 failed、不重复记录 |
| `PLAN.md` | §3 P02 检查表、§5 接口速查 P02 行 | 与 phase02 的 10 项检查一致；产出摘要补独立 transport/远期限延后/事务 hook |
| `ACCEPTANCE.md` | §3 P02 测试契约 | 新增 120s/HTTP date/缺失 header、预算与 http-deferred 不成功不重复 failure、项目隔离、hook 并发、status 新鲜度等断言 |

待执行项（P02 尚未开始写产品）：

1. 等 P01fix1 的独立复核（`ses_e35fbf9e1ffeaHF29xcFt6ZvV8`）clean；期间不写产品代码。phase02 §实现顺序第 0 项（先同步 DESIGN 陈旧段）已由本次合版完成；实现前只复核，不需再改 DESIGN。
2. 复核通过后，按 phase02 §实现顺序先落 provider/transport/重试/空返回，再落 orchestrator 预算与项目守卫，最后 accept/plugin/status/server。
3. 实现阶段先跑失败测试，再跑 `npm run verify` 并更新 `PROGRESS.md`；本合版不算阶段完成。
4. 实现中若发现 V2 或 P01 接口新事实，先 ruling 并回写 DESIGN/phase02，再编码，不按旧假设猜。

P01 证据口径：修复作者报告的最新 **886 tests / `npm run verify` exit 0** 是**作者侧证据**，不等同于独立验收；独立 review 仍在运行。P02 当前只完成文档合版，未获准写产品代码。

结论：P02 方案可进入实现；实现须在 P01 验收后、按本文件与 `reports/02-preflight.md` 执行，先写失败测试。
