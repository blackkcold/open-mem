# P02 runtime reliability — independent review

Date: 2026-11-11
Reviewer: fresh reviewer（未参与实现；未改产品代码）
Scope: 仅 `tmp/full-auto-memory/reviews/p02.patch`（59,652B，12 文件，p02-before→current）及其直接接线；P01 已闭合结论不重审。
Baseline: `p02-before/`；未使用 HEAD 累计 diff。未重跑整套门禁；只跑 3 个定向测试文件（83 passed）与 tmp 探针。
Evidence: `tmp/full-auto-memory/reviews/probe-p02.ts`、`probe-p02b.ts`、`probe-p02c.ts`、`probe-p02d.ts`、`probe-p02e.ts`、`probe-p02f.ts`（全部只写 OS 临时目录，无真实模型/网络/用户数据）。

## 裁决

| 维度 | 结论 |
|---|---|
| 规格符合性 | **不通过** — 5 项 Important，均为 P02 明确合同条款 |
| 质量 | **不通过** — 新增测试对下列 Important 中的 4 项不敏感；另有 10 项 Minor |
| P01 回归 | 未发现。diff 未触碰 P01 文件；P01 事件/CAS/`ownsClaim` 语义无变化 |
| P06 host 门禁 / N3 账本性能 | 不在本轮结论内（已知 deferred，未计为缺陷） |

## Important（必须同作者修复后复审）

### I1. 未配置 generate 时先占 request slot；config 失败还保留 run slot

- 路径：`plugin/src/review/provider.ts:269`（`reserveRequest` 在 `dispatch` 前）、`:301-311`（缺 `generate` 才抛 config）；`plugin/src/review/orchestrator.ts:523`（仅 `!modelStarted` 释放 run slot）。
- 触发：`review.transport="opencode"` 但宿主无 `generate.text`（或注入缺失）。
- 证据：`probe-p02.ts` → `[P1a] kind=config requestsMade=0`，`[P1b] persisted request slots=1`，`[P1c] 下一次真实 review kind=budget, fetches=0`。即一次"确定未派发"的配置失败占掉 1 个 request slot，并让后续一小时内的真实 review 全部被预算拒绝；`probe-p02e.ts` 显示 orchestrator 对 config 失败 `runSlots=1`。违反 §4"每次实际派发前占 slot"与 §5 表（config/cache：0 request slot、**释放** run slot）。
- 最小建议：在 `reserveRequest` 之前做 transport/generate 形状校验；orchestrator 的释放条件改为"`requestsMade===0` 或 `!modelStarted`"，config 形状不符（已派发 1 次）保留 slot。

### I2. 缓存损坏被记成 transport，且保留 run slot

- 路径：`plugin/src/review/provider.ts:109-114`（`ReviewCacheError` 无 `kind`/`requestsMade`）；`plugin/src/review/orchestrator.ts:828`（未知 kind 回落 `"transport"`）、`:532`、`:573`、`:523`。
- 触发：`review-cache.json` 结构损坏（P01 已有的显式保护路径）。
- 证据：`probe-p02.ts` → `[P2a] isCacheError=true, kind=null, requestsMade=null, messageHasPath=true`；`[P2b] recordErrorKind=transport, note="transport failure", runSlots=1`。违反 §5 表（cache → `errorKind="cache"`、释放 run slot）及 §99（`ReviewCacheError` 追加 `requestsMade=0`）。`failureKind` 白名单里已有 `"cache"`，但错误对象永远没有该 kind，分支不可达。
- 最小建议：`ReviewCacheError` 增加 `kind="cache"` 与 `requestsMade=0`；`failureKind` 按 `requestsMade===0` 释放 run slot。

### I3. 新消息会在 Retry-After 期限前重新 arm

- 路径：`plugin/src/review/orchestrator.ts:149-156`（pending 只看 `lastUserID`）、`:168-184`（重写 `reviewDueAt`）；延后写入 `:496-518`。
- 触发：远期限 deferral（`reviewStatus=scheduled`、`reviewDueAt=retryAt`）后同一 session 出现新 user 消息（`idleMs` 或 1.5s checkpoint 路径）。
- 证据：`probe-p02c.ts` → 延后时 `dueInMs=119923`、`reason=retry-after`；调用 `schedule()` 后 `dueInMs=35`，`runsBeforeDeadline=true`。下一次 `fire()` 只检查 `dueAt > now+1000`（`:736`），随后正常派发，**提前请求上游**。违反 §2 Ruling"更远 retryAt 必须完整延后"、§166"不得用 30s/窗口改写"。
- 最小建议：`schedule()` 在 `reviewDeferredReason==="retry-after"` 且现有 `reviewDueAt` 未到时，不缩短期限（`delay = Math.max(idle/checkpoint delay, dueAt-now)`，或直接保留 dueAt，仅更新 `reviewUserIDAtSchedule`）。

### I4. 第二次 429 的远 Retry-After 不退避，按 http 失败计数

- 路径：`plugin/src/review/provider.ts:275-287`（`waitMs > MAX_INLINE_WAIT` 的转换只在 `attempt === 0` 分支内）。
- 触发：第一次 429 `Retry-After: 2` → sleep 2s 重试；第二次 429 `Retry-After: 600`。
- 证据：`probe-p02f.ts` → `kind=http, httpStatus=429, retryAt=null, sleeps=[2000], fetches=2`。随后 orchestrator 走 failed：`reviewAttempts+1`、写 failed 记录、不写 `reviewDueAt`；下一轮 `schedule()` 会按 idle 再次调用，等于无视上游期限。违反 §128-130"429/408/425/5xx 带 Retry-After >30s → 抛 `ReviewRetryAfterError` 延后"（矩阵未限定仅首次）。
- 最小建议：把 `waitMs > MAX_INLINE_WAIT` 判断移到 `attempt` 条件之外；第二次命中远期限时抛 `ReviewRetryAfterError`（`requestsMade=2`）。

### I5. `setTimeout` 溢出未分段，远期限 timer 立即触发后不再续等

- 路径：`plugin/src/review/orchestrator.ts:713-724`（`arm` 直接 `setTimeout(delay)`）、`:726-736`（`fire` 在 `dueAt > now+1000` 时直接 return，不 re-arm）、`:222-224`（recover 同样）。
- 触发：`retryAt - now > 2^31-1 ms`（如 HTTP-date 误给到 25 天后；`recover()` 同理）。
- 证据：`probe-p02b.ts` → `TimeoutOverflowWarning: 2159999956 ... set to 1`；60ms 后 `timersAfter60ms=0`、`status=scheduled`、`dueUnchanged=true`、`modelCalls=1`。没有提前发请求（`fire` 的 guard 生效），但窗口被搁置到重启/下一条新消息（并与 I3 组合成提前发送）。违反 §167"用分段 timer 续等，重启按完整期限恢复"。
- 最小建议：`arm` 将单次 delay 截到 `2^31-1`（建议 ≤24h）并在回调里按 `dueAt-now` 续 arm；`fire()` 在 `dueAt > now+1000` 时 re-arm 剩余时间而不是 return；`recover()` 复用同一 helper。

## Minor

1. `plugin.ts:743-748`：`review` 对象缺 `lastFailureKind`（§218 明列）；`server.ts:360-363`：`/api/reviews.budget` 缺 `retryAt`（§220）。建议补字段（budget 的 retryAt 可直接取最早 request slot+HOUR+1000）。
2. `plugin.ts:746` 把 `runtime.lastError` 原样放进 status；缓存损坏消息含绝对路径（`provider.ts:616/655`，probe `messageHasPath=true`）。§8 要求"错误消息脱敏、不得返回真实路径"。建议只返回 `{kind, 短标签}` 或剥离路径/引号内容。
3. `provider.ts:255-261`：`budgetRetryAt` 用 `Math.min(now+HOUR, oldest+HOUR+1000)`，与 §158 的 `oldest+HOUR+1000` 不同；边界（slot 与 now 同毫秒）会在到期点被 `takeModelSlot` 的闭区间再拒一次，多延 1 小时。probe P4 实测 `delta=3600000` vs 规格 `3600500`。建议去掉 `min`。
4. `provider.ts:346-358` + `:558`：`redirect:"error"` 的 TypeError 含 "fetch failed" 时会重试 1 次；§133 规定 redirect error 不重试。建议在 catch 里识别 `error.cause`/redirect 并直接转 http/transport 非重试。
5. `provider.ts:54-75`：规格接口中的 `retryAfterMs` 未落到 `ReviewRequestError`（仅 `HttpStatusError` 内部有）。无消费者，补上或从规格删除。
6. `orchestrator.ts:173-182`、`:474-486`：成功/schedule 路径不清 `reviewDeferredReason`（只在 `:543` 清），成为 write-only 残留；建议 ready/schedule 时置 `undefined`。
7. `orchestrator.ts:197`：recover 跳过未知归属 session 时不写日志；§195 要求"跳过并记一次日志"。
8. `orchestrator.ts:808-810`：`isTransportFailure` 已无调用点（dead code）；`types.ts:57` 复制了 `ReviewFailureKind` 联合而非复用，易漂移。
9. 报告 §4 `02-runtime-reliability.md:61` 称"provider 11 项"，实际新增 provider 测试 10 项（`review-model.test.ts:880-1107`；913−896=17=10+4+3）。不影响结论，但报告计数不准确。
10. `review.transport` 的 PATCH 仅静默忽略非法值（`server.ts:1624`），`maxRequestsPerHour` 因 baseline 为 `undefined` 跳过 `validateNumericPatch`（`:1704-1708`），非法值被 `assignNumbers` 静默丢弃后仍返回 200；建议补 400 与测试。

## 测试敏感性与缺口

新增测试总体**对目标实现敏感**：并发 accept 在移除 transaction 后会得到 2 条 hook；`PreReadEmptyStore` 能抓住"事务外 check"；远 Retry-After 测试能抓住 30s clamp；预算 0/1 两条路径分别能抓住"总是释放/总是保留"；recover/schedule/runNow 的 foreign 断言能抓住越权写入。作者已如实声明"同批落地、无逐条 RED，不能称 TDD 证据"，这一点可接受；`api.test.ts:1295` 的 40→42 已核对为真实白名单（`server.ts:1754-1797` 恰好 42 项，新增 `review.transport`、`review.maxRequestsPerHour`），不是降低断言，但只断言数量、未断言这两个 key 存在/生效。

缺口（与上面 Important 对应，修复时应补）：
- provider：config 失败不得占 request slot / 不得保留 run slot；第二次远 Retry-After；408/425/5xx（有/无 header、≤/>30s）；timeout/abort 重试；空返回 `repairAttempts=0` 且 fetch=1；空返回 circuit failures 不变。
- orchestrator：缓存损坏 → `errorKind=cache` 且释放 run slot；deferral 后 `schedule()` 不得提前；`arm` 溢出分段与 recover 保留完整期限；run 预算不足不写记录/不加 attempts（§162 要求）。
- accept：新路径写出的 `hook.projectKey`/`scope` 是权威值；`onAccepted` 第 4 参；mismatch 时 `conflicts=0` 且 `sessionNotes=[]`。
- plugin/API：status 不调用 `runAudit`（spy 0 次）；`auditAgeMs` 有/无 `auditRunAt`；status 不含 token/prompt/路径；PATCH `review.transport` 持久化并在下一次 provider 调用生效；`/api/reviews.budget` 字段。

## 已核对通过（非缺陷）

- 传输独立：`review.transport` 缺省 ollama、无 rewrite 继承、无跨 provider fallback（`provider.ts:292-299`；缺 generate 抛 config）。
- 适配形状：`{prompt, model: ModelRef}` → `{text}`，`ctx.experimental.generate.text ?? ctx.generate.text`（`plugin.ts:464-471`）；无 `maxOutputTokens`、不伪造 usage。
- 429/Retry-After：秒/HTTP-date 解析、≤30s 只 sleep+重试 1 次、>30s 不 sleep 不重发（首次）、缺失/非法 1000ms；4xx 不重试；重试/repair 均占 request slot（已测试）。
- 空返回：返回 `raw:""`、repair 1 次、typed empty、circuit 不增（probe P7：`fetches=2/1`、`circuitFailures=0`）。
- 双预算：`takeModelSlot`/`takeReviewSlot` 文件锁原子；`requestsMade=0` 释放、`>0` 保留；deferral 不 failed/不加 attempts/不写记录、`dueAt=max(now+30s,retryAt)`、广播 `review.skipped`、`lastDeferred` 持久化到 stats（orchestrator 测试通过）。
- 项目隔离：schedule/runNow 外部项目零写入；recover 只处理 contextProjectKey 匹配或最近记录 key 匹配的 session；无 key 不认领（测试通过）。
- 权威 key：accept 的 `projectKey` 只来自调用方权威值，`instanceProjectKey` 仅比较；mismatch 全 skipped；`hook.projectKey` 不再用实例 key（`accept.ts:59-70,177`；pre-existing 测试 `review-integration.test.ts:82` 断言 hook.projectKey）。
- hook 幂等：check+append 在 `store.transaction` 内（文件锁内重新 `listHooks`），原文不同 → `conflicts`+session note，不静默丢；跨 Store 实例只落 1 条。
- status/audit：status 只 `readAudit`（`plugin.ts:706-714`），`runAudit` 仅在 audit action（`:786`）；`emptyAudit()` 无 `auditRunAt`；`auditAgeMs` 非法/缺失为 null；新字段不含 automation/quarantine 伪造值。
- P01 未退化：patch 不含 `changes/suppression/consolidate/actions/apply/promotion/session-promotion/curator/retention/capacity/store` 改动；`ownsClaim` 成功路径仍在 `orchestrator.ts:429`。
- 无 `as any`/`ts-ignore`/`ts-expect-error`；`/api/chat` 仍只在 ollama 分支（`provider.ts:346`）。

## 给主代理的结论

P02 不能判 clean：I1-I5 均为规格明写条款，且 I1/I2/I4 已有可复现证据。建议同作者只做最小修复 + 对应测试（无需重排架构），修完仅复审这 5 项与新增测试敏感性；P01 既有修复无需重开。I3 与 I5 组合会破坏"绝不提前请求"的唯一硬保证，应优先于 P03。

---

## Fix round 1 复核（2026-11-11，沿用原 reviewer）

范围：`tmp/full-auto-memory/reviews/p02-fix1.patch`（27,647B，7 文件 = 4 产品 + 3 测试，含新增 `plugin/test/review-fix1.test.ts`）；`p02-fix1-before/` 为基准。未重跑整套门禁（主代理已核 `verify-p02-fix1.exit=0`、73 files / 926 tests、`git diff --check` 无输出）。本轮只做定向复验、未改产品代码；`tmp/full-auto-memory/reviews/probe-p02*.ts` 与 `probe-p02fix*.ts` 仅写 OS 临时目录。

### RED 真实性（独立复现）

把当前 `review-fix1.test.ts` 放进 before 快照的 `src` 副本运行（`tmp/.../p02-redcheck1`）：**9 failed | 2 passed (11)**，与作者 §4b 一致。RED 真实，不是事后补绿。但两处先绿实际是：

1. `uses the exact budget release boundary...`（M3）
2. `keeps the run slot when a dispatched generate call returned a bad shape`（守卫）

因此作者 §4b:77 把“M3 预算边界”列入失败覆盖、把先绿写成“restart/bad-shape”**不准确**；M3 测试在旧代码即通过，不能作为 M3 的回归证据（见 N1）。M3 产品修复由 probe 证实（见下）。

### 逐 ID 复核

| ID | 结论 | 实际证据（本轮） |
|---|---|---|
| I1 未派发 config 不占 slot；bad shape 保留 | **ADDRESSED** | `provider.ts:274-281` 在 reserve 前判 transport/generate；`orchestrator.ts:553-558` 按 `requestsMade===0` 释放。`probe-p02` P1b slots=0；P8 runSlots=0/requestSlots=0；`probe…` bad-shape runSlots=1（守卫，旧代码已绿） |
| I2 cache kind + 0 派发释放 | **ADDRESSED** | `provider.ts:112-113`（`kind="cache"`、`requestsMade=0`）；P2a kind=cache/requestsMade=0；P2b record errorKind=cache、note 缺省、runSlots=0；测试 55/208 均 RED |
| I3 新消息不缩短 retryAfter、reason 清除、recover 一致 | **ADDRESSED** | `orchestrator.ts:150-164` not-before 分支；P6 deferral 119,917ms → schedule 后 119,917ms、`runsBeforeDeadline=false`；F2 restart+recover due 不变、armed=1、无提前调用；F3 期限过后正常 schedule 清 reason；ready/failed 亦清（`:513`、`:579`） |
| I4 第二次 429 远期 typed defer | **ADDRESSED** | `provider.ts:288-303` 远期限判断移出 `attempt===0`；P9 kind=retry-after、requestsMade=2、fetches=2、sleeps=[2000]；F9 端到端 record=null、status=scheduled、attempts=0、reason=retry-after、due≈600s、reviews=0、run slot 保留 |
| I5 timer 分段/早到续 arm/recover 完整且不提前 | **ADDRESSED** | `orchestrator.ts:750-770` 分段 arm；`:773-785` 早到 re-arm；F1 25 天期限 80ms 后 modelCalls=1（无二次）、runSlots=1、armed=1、due 精确；F2 recover 同理；F8 直接驱动 early `fire()` → 0 次模型调用、re-arm、due 不变 |
| M1 status/budget.retryAt | **ADDRESSED** | `plugin.ts:743-751` 增 `lastFailureKind`；`server.ts:363` retryAt；F4 `/api/reviews` requests=1、retryAt−oldest=3,601,000、空槽=null；plugin status 定向测试通过。语义小瑕见 N2 |
| M2 安全标签不泄路径 | **ADDRESSED（status 范围）** | `plugin.ts:749` 改为固定标签（`reviewFailureLabel`，`:1669`）；`plugin.test` 定向通过且断言不含 dataDir。测试未触发失败态（N3）；`/api/health` 原样 `lastError` 为 fix 前既有，见 deferred |
| M3 预算边界公式 | **ADDRESSED（产品）** | `provider.ts:264` 改为 `oldest+HOUR+1000`；P4 delta=3,600,500=规格值（旧代码为 3,600,000）。测试不敏感见 N1 |
| M4 redirect 不重试 | **ADDRESSED** | `provider.ts:565-571` 检查 `error.cause`；真实 undici 形状 `TypeError: fetch failed / cause: unexpected redirect` → kind=transport、fetches=1；测试 105 RED |
| M5 retryAfterMs 对外契约 | **ADDRESSED** | `provider.ts:57/74/594`；F6 400+`Retry-After: 7` → kind=http、retryAfterMs=7000 |
| M6 stale reason | **ADDRESSED** | 正常 schedule `:200`、ready `:513`、failed `:579` 清；I3 分支保留；F3 reason=null、due≈idle。finishSkip 残留自愈，见 N6 |
| M7 未知归属有界日志 | **ADDRESSED** | `orchestrator.ts:253-258` 聚合一行；测试 261 RED；unknown session 仍 scheduled、无写入 |
| M9 报告计数 | **ADDRESSED** | §4b:61 已为 provider 10；913+11+2=926 自洽 |
| M10 PATCH 非法 400 零写/合法持久生效 | **ADDRESSED** | `server.ts:1398-1412` 事务内、写前校验；F7 400/400、文件零写、合法 200 且 `config.review.transport="opencode"`、maxRequests=7 同时落盘；新增 api 两测定向通过 |
| M8 死码/类型复用 | **DEFERRED** | `isTransportFailure` 仍无调用点（`orchestrator.ts:858`）、`errorKind` 联合仍复制（`types.ts:57`）；按约定交最终 review，不扩架构 |

### 本轮新增 Minor（不阻塞；无新 Critical/Important）

- **N1（测试/报告，最需处理）**：`test/review-fix1.test.ts:129` 的 M3 用例在旧代码即通过（RED 复现证实），不是回归守卫；§4b:77 同时误列 M3 为失败、误称先绿为“restart/bad-shape”。产品已由 P4 证实。建议：补一个“slot 与 now 同毫秒/1 秒内”的边界用例（旧公式才会失败），并更正 §4b 两处表述。
- **N2（API 语义）**：`server.ts:363` 在 `requests.length < max`（仍有预算）时也返回 `oldest+HOUR+1000`；此时最早可用窗口其实是 now。建议预算未耗尽返回 `null`（或注明该字段为“最早释放时刻”）。
- **N3（测试缺口）**：status 的失败标签路径没有端到端测试；`plugin.test` 只覆盖无失败（`lastFailureKind` 缺省）场景，不能证明“失败时不含路径”。代码映射完整，建议加一个缓存损坏 → status 的用例。
- **N4（测试缺口）**：M10 新测只断言持久化，未断言 live `config` 生效；F7 已证明 live 生效，建议在 API 测试中补一条可观察断言。
- **N5（测试缺口）**：I5 用例只断言 `scheduled=1` 与 due 不变，未断言“无第二次模型调用/run slot 不增”；F1/F8 已补证。另 408/425 与 empty-circuit 仍无用例（共享代码路径，风险低）。
- **N6（可观测残留）**：失败后再进入 deferral 时 `lastFailureKind` 不清，status 可能同时显示旧失败 kind 与新 `lastDeferred`；`finishSkip` 不清 `reviewDeferredReason`（下次正常 schedule 自愈）。仅展示层，建议顺手清。

### 未触及的既有观察（deferred，不计入本轮）

- 手动 `runNow`（含 `review_session`）仍不检查未到期的 `reviewDeferredReason`；这是 fix 前既有路径，非本轮引入。是否要让手动复盘也尊重上游 Retry-After，需产品决定，留 P03/P06。
- `/api/health.review.runtime` 仍原样返回 `lastError`（缓存错误消息含绝对路径）；fix 前既有，本轮 M2 只收口 status。
- 真实 host `experimental.generate.text` 行为、P06 host 门禁：not-run（既有边界）。
- N3 账本性能：P06 deferred，与本 diff 无关。

### Fix round 1 裁决

- **规格符合性：通过。** 原 I1-I5 全部 ADDRESSED；M1-M7、M9、M10 ADDRESSED；M2 在 status 范围闭合；M8 按约定 deferred。未发现本轮 fix 引入的新 Critical/Important。
- **质量：通过（有 6 项 Minor）。** 11 个新测试中 9 个经 before 快照独立复现为 RED；M3 用例不敏感、报告归属有误（N1），其余为测试/语义小项。无断言被削弱、无测试删除、无 `as any`/`ts-ignore`。
- **P03 闸门：可以进入 P03。** 建议由同一 owner 在 P03 起步时顺手完成 N1（更正 §4b + 补边界用例）与 N3/N5 的测试补强；N2/N4/N6 可随 P03 处理，均不构成重开 P02fix2 的理由。P01 无回归（fix1 未触碰 P01 文件）。
