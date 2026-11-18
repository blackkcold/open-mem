# P03 Hybrid — fresh builder check（独立只读）

Status: builder lens 复核完成；未改候选设计/主文档/产品代码/测试/配置，未运行 host 或模型，未提交。只新增本报告。
Date: 2026-11-12
Baseline: P02 + known-foreign wiring 的 74 files / 929 tests / verify0（主代理既有证据，本报告未重跑）。
Method: 读 `DESIGN-P03-HYBRID.md` 240 行、`03a-evidence-contract-audit.md` 必要段、`02-host-wiring-review.md` U1/U2；只读核对本仓库现有接口与 `@opencode/schema` 类型。

## 0. 口径与边界

- 这里只问“若我拿这份设计写实施计划，哪些必须由设计回答、猜错会改变实现/测试/验收形状”的问题；不替设计者重设计，不评价产品取舍本身。
- **本仓库不能证明的 host 行为**仍为 U：真实 host 的事件目录过滤、`event.system` 的权限/注入隔离、`generate.text` 是否内部启用工具/子会话、transcript 是否可重读。以下问题不要求设计证明这些 host 行为；只要求产品契约在“host 字段可用/不可用”两种情况下都有明确分支。
- SDK 类型是 observed（本仓库依赖的 schema），不等于真实 host 运行时一定交付；文中会区分。

## 1. 结论

**不是 “nothing important left”。** 有 9 个 load-bearing 问题；其中 4 个 P0 会直接改变 ownership、持久化或写入路径，不能带着它们进入 `writing-plans`。P1 的 4 个问题会改变 U2/U4/U6 的任务边界与测试；最后 1 个是硬验收冲突。

| # | 级别 | 问题 |
|---|---|---|
| 1 | P0 | `ReviewRecord.projectKey` 被当作 ownership 权威，但记录本身可能由实例 key 派生，形成 bootstrap 循环 |
| 2 | P0 | 新 session 的可信 owner 字段（`session.created.data` / `SessionInfo`）被设计排除，U2 可能死锁；parent 三态未定义 |
| 3 | P0 | `EvidencePacket.rawText` 到底只驻内存还是进 `pending-extract.jsonl`，设计与持久化自相矛盾；raw/offset 无唯一坐标定义 |
| 4 | P0 | `rawQuote`（≤500）当正文与既有 `memoryMaxChars=200`、多 claim/示例/临时词 linter 直接冲突 |
| 5 | P1 | 日/小时两预算不是同一事务；in-flight 停用/换配置无定义；review 优先可能饿死 extract |
| 6 | P1 | `StructuredGenerate`/`ModelCaller` 与真实 `generate.text`/`ReviewProvider` 签名、transport、cache、circuit 归属不闭合 |
| 7 | P1 | review 自动门与 `learning` 的 tool 条件同现有 `validate`/`canAutoApply` 不一致 |
| 8 | P1 | U6 把 P04/P05 的 `console` 40 个源文件算作一个单元；review 的 raw 证据改造没有单元认领 |
| 9 | P2/验收 | 设计 202 行写 390px；用户硬约束是真实 360px、rail 260/320、44px |

---

## 2. P0 问题

### 1. `ReviewRecord.projectKey` 作为 ownership 权威是循环的

**设计位置**：`DESIGN-P03-HYBRID.md:146-156`，尤其 `:148`（“同 session 已接受的 `ReviewRecord.projectKey`（含 reviewID）→ 产品权威记录”）与 `:154`（U2 不再给未知 session 打 key）。

**为什么影响实现**：如果 plan 按 :148 实现“record 即权威”，就必须回答“这条 record 的 key 是从 host 原生位置来的，还是从插件实例 `ctx.location` 来的”。当前两者没有字段区分；一条旧错误 record 会永久把 B session 授权成 A，后续 capture/recall 都会沿用它。反过来，如果要求 record 必须带原始证据才可用，则现有 record 全部不能用于 bootstrap，U2 的“等 record 到达”路径也不成立。这不是措辞问题，直接决定 `resolveOwnership` 的输入和迁移/legacy 分支。

**现有代码可答的 observed**：

- `plugin.ts:299-300`：`projectKey = sha16(ctx.location?.project?.canonical ?? ctx.location?.directory)`，来源是**插件实例**。
- `plugin.ts:481-485`：同一个 `projectKey` 传给 `ReviewOrchestrator`。
- `review/orchestrator.ts:476-480`：写 `ReviewRecord` 时 `projectKey: this.deps.projectKey`；不是从 session 的 host 位置读取。
- `types.ts:38-64`：`ReviewRecord` 只有 `projectKey?`，没有 `keySource`/`ownershipEvidence`；`ReviewEvidence` 只有 `messageID/quote/kind`（`types.ts:7-13`）。
- `review/accept.ts:59-70`：只比较 `authoritativeProjectKey` 与 `instanceProjectKey`；而 onAccepted 传入的 authoritative 也是同一个 `deps.projectKey`（`orchestrator.ts:468`），所以这个 mismatch 检查不能证明原生性。
- `02-host-wiring-review.md:72-90` 已记录：U1 路径仍会把用户文本写成 A 的 hook；U2 的 `session.created` 仍会给未知 session 打 A key。

**需要设计回答**：

1. :148 的“已接受”指 `ReviewRecord.status=ready`，还是 `queued>0`？`orchestrator.ts:476-487` 即使 `queued=0` 也会写 ready 记录，两者对 bootstrap 的影响不同。
2. 一条 record 要成为 :148 的权威，是否必须携带“key 的原生来源”字段（例如 `keySource: "host_location" | "session_get" | "instance"` 或它自己的 `EvidenceRef`）？如果不需要，如何避免上述循环？
3. legacy record（没有来源字段）在 U2 下是“不可用、继续 unknown”，还是“可用但只 observe”？这决定是否需要数据迁移/兼容分支。

### 2. 新 session 的可信 owner 字段被排除；parent 三态未定义

**设计位置**：`:146-154`，尤其 `:147`（`event.location.directory` 的 canonical，“若 SDK 提供”）与 `:153`（“只读现有 `event.location`/record/state”）。

**为什么影响实现**：设计说新 session 没有 `event.location` 就置 `ownershipUnknown`，等“后续 event location/record 到达再绑定”。但本仓库依赖的 SDK 在 `session.created` 的 **data** 里提供了 required 的 `projectID` 和 `location.directory`；`SessionInfo` 也提供 `projectID/directory/parentID`。如果设计排除这些字段，一个新 session 在 host 不给 envelope `event.location`、又还没有 record 时，既不能 capture 也不能 review，形成死锁：没有证据 → 没有 record → 永远没有 owner。如果允许这些字段，则必须定义它们与现有 `sha16(path)` `projectKey` 的映射，否则“自己的 session”会被判成 foreign。

**现有代码/SDK 可答的 observed**：

- `plugin/node_modules/@opencode/schema/dist/session-event.d.ts:34-56`：`session.created` 的 `data` 有 `sessionID`、required `projectID`、required `location.directory`、optional `parentID`。
- `plugin/node_modules/@opencode/schema/dist/v1/session.d.ts:1555-1576`：`SessionInfo` 有 `projectID`、`directory`、optional `parentID`。
- `plugin.ts:602-611`：当前 `session.created` 只读 `parentID/agent`，没有读 `data.projectID`/`data.location`。
- `plugin.ts:626-637`：当前 `session.get` 只读 `parentID/agent`，同样丢弃 `projectID/directory`。
- `plugin.ts:619` + `plugin.ts:1347-1351`：`session.created` 调 `refreshContext(..., projectKey)`，会把实例 key 写进 `contextProjectKey`（U2 的根因）。
- `types.ts:75-86`：`SessionState` 只有 `parentSessionID?` 与 `parentChecked?`；`plugin.ts:609` 只在 parent 存在时设 `parentChecked:true`，root 的 `session.created` 不会设；`plugin.ts:637` 只有 `session.get` 返回对象才设 true。

**需要设计回答**：

1. `session.created.data.location.directory` / `data.projectID` / `SessionInfo.projectID|directory` 是否可作为 :147 的 host 原生证据？如果可，优先级放在 `event.location` 之前还是之后？`projectID` 与现有 `sha16(path)` key 如何映射/兼容旧 item？
2. 如果不可，U2 的新 session 在“没有 envelope location、没有 record、`session.get` 不可用”时是否接受永久 unknown（普通记忆完全不学）？这是产品覆盖取舍，必须写进验收，而不是留给实现猜。
3. parent 三态：`parentChecked && !parentSessionID` 是否就是 root？`session.created` 的 `parentID` 缺失（SDK 语义为 optional）是否可以直接置 root，而不必等 `session.get`？如果 root 也必须等 `session.get`，`:151` 的 “parent unknown → skip” 会把无 `session.get` 的 root session 全部跳过。

### 3. `rawText` 是否进 pending、raw/offset 的坐标契约不闭合

**设计位置**：`:53-68`（`EvidencePacket` 注释“内存/有界 pending，不落全量原文”；`rawText`“仅当次处理，不持久化全文”），`:74`（`rawQuote` 是唯一保留原文），`:83`（重启后从 host 重读并重算 hash），`:117-118`（turn `captureEvidence` → `pending.append`；idle `runExtractTick`），`:186`（`pending-extract.jsonl`，≤50 packets / 200KB / 72h）。

**为什么影响实现**：这三处不能同时成立，除非明确“pending 里到底存什么”：

- 如果 `pending.append` 持久化 `EvidencePacket`，`rawText`（以及 `shownText`）会落盘，和 :53/:56/:74 的“不落全量原文/唯一保留 rawQuote”冲突；50 条 × 4,000 字会超过 200KB（中文 UTF-8 更高）。
- 如果 pending 只存 `EvidenceRef`/messageID/hash，idle extract 必须重新从 host 读原文；这需要定义读不到时的行为（设计已说 quarantine），但也要定义“重读的文本”与 capture 时是否同一 canonical text。
- 如果 pending 存 `shownText`，那它仍是一段可能接近全文的用户文本（最多 4,000 字），且 `redactText` 漏掉的秘密会持久化；和“secret 不落盘”冲突。

**raw/offset 的 observed**：

- `session/reader.ts:32-36`：`maxTextChars=4000`；`:150-160`：超过 4,000 字会 `slice + "…"`，这不是设计 `transform` 里的 `truncated` 段。所谓“host 原文”在现有读路径里已经是裁剪后的文本。
- `session/normalize.ts:43-46`：多个 part 以 `\n` 拼接成 `message.text`；`EvidenceRef.offsetStart/offsetEnd` 的坐标是 raw message JSON、拼接后的 `message.text`、还是 `shownText`？设计没有说。
- `redact.ts:23-41`：`redactText` 默认会替换绝对路径（`:39`），且 `hits` 包含 path 命中；设计 `:82` 说“`redactText` 命中即跳过整条消息”。如果 capture 直接复用默认 `redactText`，任何提到 `/Users/...` 的普通用户消息都会被整条 skip，和 `:28` 的 reference/path 快速 lane 直接冲突。设计需要明确 capture 用的是“仅 secret 的 redact”还是现有含 path 的 redact。
- `review/input.ts:86-102`：review 侧现在先 `redactText` 再 `fit()`（空白折叠 + 截断），`sources.user` 是 fitted 文本；`:142-147` 的 hash 也只覆盖 fitted `[id, role, text]`。设计 `:119` 要求 review 也有 host `EvidenceRef`，但这条路径的 raw/shown 映射不在现有 `ReviewInput` 里。

**需要设计回答**：

1. `pending-extract.jsonl` 的精确 persisted shape：`EvidencePacket`、`EvidenceRef`、还是“ref + 模型 proposal”？`rawText/shownText` 是否落盘？如果落盘，如何满足 :53/:74/:82 的“不落全量原文/secret 不持久”？
2. `rawText` 的 canonical 定义：是 `normalizeSessionMessage` 的 `message.text`（parts 以 `\n` 拼接）、host 的原始 part 数组、还是 `reader` 的 4,000 字裁剪文本？`rawHash` 覆盖哪个字节序列？
3. `offsetStart/offsetEnd` 的坐标系：raw 还是 shown？`rawQuote` 名为 raw，但 :80 又要求 quote 是 `shownText` 的逐字子串；跨 redacted/truncated 时如何用同一组 offset 回指？
4. capture 的 redact 策略是否包含绝对路径？如果包含，path/reference 类普通记忆是否全部 skip？如果不包含，`:82` 的“命中即跳过整条消息”应改为 secret-only。
5. `EvidenceRef` 放在 `ChangeEvent`/`ReviewEvidence`/`QueueItem`（:73）时，`rawQuote` 在 queue/review 记录里可能超过 90 天 undo 保留期；设计要不要给 queue/review evidence 单独的 retention？现有 `retention.ts:117-127` 只按 archived item 的 90 天裁剪，active item/queue 不会因 undo 期限删除。

### 4. `rawQuote` 当正文（≤500）与现有 200 字/linter 直接冲突

**设计位置**：`:65`（`rawQuote ≤500 chars`），`:74`（唯一保留的用户原文），`:99`（“记忆正文默认使用 `rawQuote`”），`:163-166`（`validateClaim` 的顺序，未提 linter/长度上限）。

**为什么影响实现**：这是“写 auto 还是写不进去”的硬冲突，不是语义辩论：

- `config.ts:81-83`：`memoryMaxChars=200`、`ruleMaxChars=160`、`titleMaxChars=30`。
- `linter.ts:64`：`normalized.length > maxChars` 是 error；`:76-77` >2 句是 “multiple claims” error；`:65` 示例词（例如/比如/e.g.）是 error；`:66` 今天/刚刚/临时等 transient 词是 error；`:67` secret-like 是 error。自然用户原话很容易命中其中一项。
- `consolidate.ts:327-337` 会对 `hook.text` 调 `lintText`；`canAutoApply` 在 `:927` 对 `!lintOk` 直接拒绝；`review/validate.ts:130-134` 也对 review candidate 做同样 lint。
- 如果新 `decideAutomation` 完全绕过 `lintText`，则会把 500 字、多 claim、含“比如/今天”的文本写成 Item，破坏现有 item 不变量和 UI；如果保留 `lintText`，大量 201–500 字或 >2 句的 `rawQuote` 永远不能 auto，和“普通记忆零审批”目标冲突。

**需要设计回答**：

1. extractive body 的长度上限到底是 500 还是 `memoryMaxChars=200`？如果沿用 200，`rawQuote` 是截断、取子句，还是只把 ≤200 的 quote 作为候选？截断后是否还算“逐字原话”？
2. `lintText` 的哪些 error 适用于 extractive quote？特别是 `multiple claims`、`EXAMPLE_RE`、`TRANSIENT_RE`：是保留（则很多原话不能 auto）、还是给 quote body 单独 lint profile（则 item 可能含 transient/多 claim 内容）？这需要设计明确，不应由实现自行放宽。
3. `rawQuote` 与 title 的关系：`titleMaxChars=30`，模型 `text` 只作 title/摘要；如果 `text` 不是 quote 子串，title 由谁生成、如何保证 30 字内且不引入未支持内容？
4. `canAutoApply` 的既有 `origin === "session-review"` 硬拒绝（`consolidate.ts:921-923`）是否保留？保留则 review decision/learning 永远不能 auto（违反设计 :10）；删除则是安全行为变更，必须写进设计和验收。

## 3. P1 问题

### 5. 双预算不同事务；in-flight 停用/换配置无定义

**设计位置**：`:184`（`takeAutomationSlot("modelCalls")` 日计数 + `takeModelSlot("review")` 小时计数；每次 dispatch 计数；cache hit 不占；extract 让位 review），`:185`（单 session 单飞），`:178`（mode 单事务原子），`:118`（claim 单飞）。

**为什么影响实现**：

- 现有 `store.ts:670-681` 只有一个 `takeModelSlot(kind, max, at)`，在 state lock 内改一个 `modelRequests[kind]` 数组；没有“同时预占日+小时”的方法，也没有 release/rollback。设计 :184 明确是两个调用；如果日计数成功、小时计数失败，就半占一个日槽；如果顺序反过来，小时槽被无效消耗。实现必须知道是“新增一个原子 reserveBoth”还是“允许半占并在失败时补偿”，这是 U3/U4 的核心接口。
- 现有 `review/provider.ts:282-284` 是在每次 dispatch 前 `reserveRequest`，失败/429/5xx 都消耗 slot；设计 :184 说“预检失败/缓存命中不占”。如果 cache 命中在 provider 内部判断，调用方无法知道，且 `StructuredGenerate` 的返回没有 `cached` 标志（现有 `ReviewRunResult` 有 `cached?: boolean`，`types.ts:72`）。这会让“cache hit 不占预算”无法按接口实现。
- “extract 让位 review”只给了 `extractDeferredReason=review-priority|budget`，没有最大 deferral/aging/reserved slot。共享小时上限下，review 持续占满时 extract 可以无限延后；这是产品覆盖承诺，需明确是否接受。
- in-flight：设计 :118 说“claim 单飞”，:185 说“单 session 单飞”，两个单飞范围不同（全局一条 vs 每 session 一条）。如果用户在模型调用中把 `automation.enabled` 设为 false，或改 model/config，当前设计没有说“丢弃结果/不写/中止”。现有 provider 只有 timeout 的 `AbortSignal`（`provider.ts:328-331`），没有 disable revision 检查；实现若在返回后直接写，会出现“停用后仍写入”。

**需要设计回答**：

1. 日+小时是同一次 store 事务预占，还是允许两次调用加补偿？预占顺序、失败回滚、进程崩溃后的残留如何定义？
2. “cache hit 不占”由谁判断？`StructuredGenerate` 是否要返回 `cached`/`attempts`（或把预算完全下沉到 provider）？
3. “单飞”是全局一个 extract job，还是每 session 一个？多 session 同时 idle 时并发上限是多少？
4. `automation.enabled=false` 或 model/config revision 变化发生在 in-flight 时，结果是丢弃、写 pending 等下次，还是允许完成写入？必须有明确契约，不能留给实现猜。

### 6. `StructuredGenerate`/`ModelCaller` 与真实签名、transport、cache、circuit 不闭合

**设计位置**：`:123-142`（唯一新接口、`ModelCaller`、cacheKey、复用 `generateText`）。

**现有代码可答的 observed**：

- `plugin.ts:101-123`：`PluginContext.generate.text` / `experimental.generate.text` 的返回是 `Promise<unknown>`，不是 `{text}`；`plugin.ts:464-470` 只是把它 cast 成 `{text}`。没有 usage、没有 schema/responseFormat、没有 tools 参数。
- `review/provider.ts:125-219`：`review()` 自己拥有 prompt、cache、repair、circuit；`request/dispatch/generate` 是 private（`:247-341`）；cache key 在 `:145-147` 只用 prompt version + `model.id` + `variant` + `input.hash`，不含 `providerID`。
- `config.ts:48-50`：review 默认 `transport:"ollama"`；`generateText` 只在 OpenCode transport 下使用（`provider.ts:311-341`）。设计 :142 说“复用 P02 注入的 `generateText`”，但 :139 又说抽 `ModelCaller` 共享 request/retry/circuit/budget；这两条对“extract 用 Ollama 还是 OpenCode、用 review model 还是新 model”给出不同答案。
- `provider.ts:126-128` 的 failures/openUntil 是实例字段；如果 extract 与 review 共享同一个 `ModelCaller` 实例，extract 的失败会打开 review 的 circuit，和“review 优先”冲突；如果各自实例，则“共享 circuit”只是共享代码，不是共享状态。设计没有说。
- 设计 :140 的 cacheKey 有 `model`，但没定义是否包含 `providerID`/`variant`；`sourceHash` 说覆盖 schema/prompt 版本、消息 ID/rawHash/offset/project，**没有** `shownHash`/`transformVersion`。若 redaction/truncate 策略变化，rawHash/offset 可能不变而 shown 文本变化，cache 命中后 quote 不再匹配；validator 会 fail-closed，但会反复 quarantine，且 cache 的“命中不占预算”与实际可用性脱节。

**需要设计回答**：

1. extract 的 transport/model 是 review 的配置，还是新增 `automation.model`？如果新增，配置文件/迁移/UI 由哪个单元负责？
2. `ModelCaller` 是 code reuse 还是 state sharing（circuit、failures、cache）？review 优先要求下，extract 失败是否允许影响 review circuit？
3. cacheKey 的 `model` 是否包含 `providerID/variant`？`sourceHash` 是否要包含 `shownHash`/`transformVersion`（或 cache 命中后强制重验并重新计费）？
4. `StructuredGenerate` 的返回是否要加 `cached`/`usage`/`attempts`，否则 :184 的“缓存命中不占”和 usage 统计无法实现？

### 7. review 自动门与 `learning` tool 条件同现有实现不一致

**设计位置**：`:10`（review decision/learning 零日常审批，turn 与 review 同门），`:119`（“`learning` 仍要 P02 的 ok tool 证据”），`:160`（单一 auto 门，删除旧 classifyAuthority/workflowSafe）。

**现有代码可答的 observed**：

- `consolidate.ts:921-923`：`if (input.origin === "session-review") return false;`——现有 auto 门**永久拒绝** review 来源。设计 :10 要求 review decision/learning 可 auto，但没有说这条硬门是删除、改成“有 host EvidenceRef 才放行”，还是保留（保留则目标无法实现）。
- `review/validate.ts:170-172`：`learning` 要求 `!tool.ok`（**失败**的 tool quote）；设计 :119 写的是“ok tool 证据”。两者相反。若按设计实现，现有 `learning` 测试语义会反转；若按代码实现，设计文本错误。
- `review/input.ts:86-102`：review 的 `sources.user` 是 redact + fit 后的文本；`review/validate.ts:144-157` 只对该 fitted 文本做 substring 检查，不是 host raw。设计 :119 要求 review 有 host `EvidenceRef` 才能进同一 validator，但 U1 文件清单（`:208`）没有 `review/input.ts`，U2 清单（`:209`）没有 `review/validate.ts`/`review/accept.ts`——没有单元认领这条改造。

**需要设计回答**：

1. `learning` 的 tool 条件到底是“失败 tool”（现有）还是“成功 tool”（设计 :119）？以哪个为准？
2. `decideAutomation` 是否保留 `origin=session-review` 的硬拒绝？如果不保留，review 的 auto 需要哪些额外证据/验收？如果保留，:10 的 review 零审批如何成立？
3. 哪个单元负责把 review 的 fitted `sources` 改成 raw/shown `EvidenceRef`？是 U1 扩展 `review/input.ts`，还是 U4 在 claim 层重建？这会影响 U1/U2 的文件数（3–5 上限）。

### 8. U6 跨 P04/P05 且 40 个 console 文件；≤3–5 规则不成立

**设计位置**：`:204-214`，尤其 `:213`（U6 候选产品文件 `recall.ts`、`server.ts`、`console`），`:208-209`（U1/U2 文件清单）。

**为什么影响实现**：

- U6 把 `console` 当作一个“候选产品文件”，但本仓库 `console/src` 实际有 **40 个源文件**（含 P05 的 pages/extension/styles/api 等）。如果 U6 只改 3–5 个 console 文件，无法交付 :202 的 P05 全量状态/入口；如果改完 40 个，违反 :204 的“每单元 ≤3–5 产品文件”。这不是估算误差，是任务边界矛盾。
- U6 同时包含 `recall.ts`（P04 当次请求 owned 召回）和 `server.ts`/`console`（P05 UX/状态），把 P04/P05 的范围并进 P03。设计 :13 说“保留 P04/P05”，但没有说 P03 是否实现它们；若实现，U6 需要拆成多个短任务，不能作为单个 U6。
- U1/U2 没有 `review/input.ts`（见问题 7），而 :119 又要求 review 的 host EvidenceRef；这会让该改造落到“无人认领”的空白，或者被临时塞进 U1/U2 导致超过 5 个文件。

**需要设计回答**：

1. U6 是“P03 只做 recall/status 的 server 接线，P05 UI 另立单元”，还是“P03 包含 P05 全量”？如果是后者，:204 的 3–5 文件上限必须改成可执行的拆分（例如按页面/状态拆），否则 `writing-plans` 无法遵守。
2. `review/input.ts`（以及必要的 `review/validate.ts`/`review/accept.ts`）归哪个单元？U1 是否要从 4 个文件扩到 5 个，还是 U4 承接？
3. `types.ts` 是 U1 的文件，但 U2–U6 都要加字段；计划是否需要把类型变更前置为独立任务，避免每个单元都改同一个文件？这不是设计错误，但会影响任务排序/冲突。

## 4. 验收冲突

### 9. 390px 不能替代硬约束 360px

**设计位置**：`:202`（“保留 P05：…390px、44px、键盘…”）。

**事实**：用户硬约束是真实 **360px**、rail **260/320**、44px 触控；设计只写 390px，未提 rail 260/320。390 比 360 更宽，不是“最小 360”的等价写法；在 360 视口下按 390 布局会溢出或需要横向滚动，P05 验收会直接失败。

**需要设计回答/修正**：把 :202 的验收宽度改为 360px（并明确 rail 260/320、44px 触控）；如果 390 是 P05 既有设计稿宽度，需要说明 360 的降级布局，而不是用 390 代替。此项不需要 builder 猜。

## 5. 不列为问题（可由实现合理决定）

以下不构成设计必须回答的 load-bearing 问题，避免过度追问：

- `processing` lease 的具体秒数、pending 文件内部字段顺序、cache 文件命名、重试 jitter、UI 文案措辞。
- `rawQuote` 的具体截断算法（按字符/按句）在问题 4 的上限策略确定后可由实现选择。
- 具体测试文件数量、fake host fixture 形状、日志字段命名。
- 语义 100% 正确、host 是否真的拦截受记忆影响的动作：仍是 U，不应要求设计用文字证明；但设计不能把这些写成已成立。

## 6. 给主代理的分类建议

- **必须先回设计作者**：1、2、3、4（P0；不解决则 ownership/持久化/写入路径无法定计划）。
- **同 session 修文档即可**：7（learning 条件与 review 自动门措辞）、9（360px）。
- **需要拆计划/改单元边界**：5、6、8（预算事务、接口/transport、U6 与 review input 归属）。
- **本仓库无法证明、保留为 U**：host 事件过滤、system 通道限权、`generate.text` 内部工具/子会话、transcript 可重读；本报告没有把它们当作设计缺陷。

---

# v2 scoped re-review（2026-11-12，追加；保留上方 v1 历史）

Status: 只核 B1–B9 是否被 v2 明确回答，以及 v2 直接引入的 load-bearing 新矛盾；未改候选/其他报告/产品/测试，未运行 host/模型，未提交。v2 的未来测试全部 not-run；不把 v2 文档里的“实测”当作运行证据（只对 P01 行号做了代码核对）。

Inputs: `DESIGN-P03-HYBRID.md` 247 行、`reports/03-hybrid-design-resolution.md` 55 行、`tmp/full-auto-memory/reviews/hybrid-design-v2.patch` 424 行、上方 v1 B1–B9。

## 7. B1–B9 逐项裁决

| ID | 裁决 | v2 精确证据 | builder 结论 |
|---|---|---|---|
| B1 | **ADDRESSED** | v2 `:126-132`：`ReviewRecord.ownershipEvidence`（source/keySource/projectID/directory/canonical/projectKey/sourceHash/at/version）；`:130` 明确 ready/queued 非权威、legacy 无字段 observe；`:128-129` U1/U2 不靠旧 record 授权 | 原循环已被协议层切断。残余是**验证点**：U5 必须真正重读 `session.created/get` 并核对 `ownershipEvidence`，不能只信 record 自报；host 不可读时按 legacy observe。这是 U5 实现门，不是新的设计重写。当前 `types.ts:38-64` 无该字段、`orchestrator.ts:476-480` 仍写 `deps.projectKey`，U0/U5 需改。 |
| B2 | **OPEN（窄）** | v2 `:112-124`：priority 为 created.data → SessionInfo → envelope location → verified record → hints；`:121` `projectKey=sha16(canonicalize(directory))`、projectID 只作一致性；`:122` 冲突 fail closed；`:124` created parent 缺失→root、get 缺失→root、失败/无效→unknown | 原生字段和 parent 三态已写出，但 **canonicalize/match 仍未定义**，且“created 缺失 parentID 即 root”是未证假设。见 N2/N3；这两点会直接决定 own/foreign 与 child/root，故 B2 不能算完全闭合。 |
| B3 | **OPEN（窄）** | v2 `:49-89`：Packet 仅内存、Pending 不含 raw/shown、canonical 在 4000 字 slice 前、UTF-16、transform 全分区、secret-only、不可重读整体 degraded；`:189` privacy/retention | 原“rawText 是否落盘”和 path-redact 冲突已解决。但 `PendingEvidence.rawQuote` 在 turn capture 时就要写入，而模型 quote 尚未产生；选择规则、与 `ClaimProposal.quote` 的关系、offset 指向 canonical 还是 shown 未写。见 N1。 |
| B4 | **ADDRESSED** | v2 `:134-142`：quote 必须完整 governing sentence；body ≤200、必须是 rawQuote 连续子串、保留否定/条件、不截断限定；保留 200/30/lint；多 claim 拆 body、每 packet ≤3 | 200 字/30 title/lint 的冲突已按“body 投影”解决。残余依赖 B3 的 rawQuote 选择；若 N1 答错，body 仍无法绑定。 |
| B5 | **ADDRESSED** | v2 `:164-181`：`takeAutomationModelSlot` 单锁日+小时、任一失败不递增；reservation reserved→dispatched→终态；cache/preflight 在 reserve 前；`cached/attempts`；全局 `extract:worker` 并发 1；in-flight revision/enabled/model 变化丢弃；floor 8/day + 1/hour、review 上限扣减；pending full 暂停 capture | 原“半占/无单飞/停用后写入”已给出可执行契约。`hourlyLimit` 取 `review.maxRequestsPerHour` 还是 effective 值，属于 U3 接线可自定，不构成新 blocking；但计划应固定一个值并写测试。 |
| B6 | **ADDRESSED（带非阻塞残余）** | v2 `:165-172` 唯一接口返回 `cached/attempts/requestID`; `:176` 继承 review transport/model、circuit/cache 按 purpose 隔离、cache key 含 purpose/transport/provider/model/variant/promptVersion/schemaVersion/rawHash/shownHash/transformVersion/originProjectKey/ownerVersion/redactionProfileVersion；`:176` `generate.text` unknown runtime 校验 | 原 transport/model/circuit/cache/usage 问题已答。一个**非阻塞**残余：cache key 未列 messageID/sessionID，而 `ClaimProposal.messageID` 未被 v2 `:79` 列入“模型返回即忽略”；cache hit 必须把 proposal 重绑到当前 PendingEvidence，否则会 fail-closed/quarantine（不是错误写入）。建议 U2/U4 用一句话明确“忽略/重绑 cached messageID”。 |
| B7 | **ADDRESSED** | v2 `:142` learning 维持 failing tool（`!tool.ok`），U1b 负责 review/input/validate/accept；`:146` review-origin legacy 硬拒绝只在 `automation.enabled=false` 的 `canAutoApply`，enabled=true 走 EvidenceRef admission；`:214` U1b | 与 `review/validate.ts:170-172`、`consolidate.ts:921-923` 对齐。计划需确保 enabled=true 时 review 路径不先被旧 `canAutoApply` 拦截；这是 U1b/U4/U5 的接线验收，不是未答设计。 |
| B8 | **ADDRESSED** | v2 `:208-223`：U0 types 先行；U1b 认领 review bridge；U6 仅 `server.ts`+`memory/status.ts`，明确 P03 不实现 console/P05/P04 recall；P04/P05 独立；每单元 ≤5 | 原 U6 的 40 个 console 文件与跨阶段问题已移除；review raw 证据有了 U1b 归属。`types.ts` 先行也解决了多单元同时改类型。 |
| B9 | **ADDRESSED** | v2 `:205`：360px、rail 260/320、44px、无横向滚动；390 不再是验收替代 | 与用户硬约束一致。 |

## 8. v2 直接引入/暴露的 load-bearing 新问题

### N1（P0/P1）`PendingEvidence.rawQuote` 在模型之前如何选定，和 `ClaimProposal.quote` 是什么关系？

**v2 位置**：`:61-70`（PendingEvidence 必含 `rawQuote/quoteHash/offset`）、`:80`（只存 bounded rawQuote）、`:93`（ClaimProposal.quote）、`:136-137`（quote 完整句、body 是 rawQuote 连续子串）、`:73-75`（EvidenceRef.rawQuote）。

**为什么是问题**：turn capture 在 idle extract 之前就要写 `PendingEvidence.rawQuote`，但此时还没有模型 proposal。若 capture 选“消息前 500 字/第一句”，模型之后可能选中另一句；`body` 被要求是 `rawQuote` 子串，就会错误 quarantine，或迫使实现偷偷扩大 rawQuote。若 capture 的 rawQuote 只是占位、之后由模型 quote 替换，则 `quoteHash/offsetStart/offsetEnd` 在 pending 中何时重算、是否允许更新、`EvidenceRef.rawQuote` 以谁为准都没有定义。这不是措辞细节：它决定 Pending DTO、extract prompt 输入、validator 的 span 绑定和 B4 的 body 子串检查。

**最小需要回答**（一句即可）：

1. `rawQuote` 是“capture 时选定、模型 quote 必须落在其中”，还是“capture 只存候选、extract 后用模型 quote 重写 pending/EvidenceRef”？
2. 若是前者，>500 字消息按什么规则选（整条/首句/最长句/模型之前不可选）？若是后者，pending 的 `quoteHash/offset` 何时更新，旧值是否只作 seed？
3. `offsetStart/offsetEnd` 明确指 `canonicalText` 还是 `shownText`；`quote` 必须落在 canonical 的连续 kept 区，还是 shown 的连续 kept 区？

### N2（P1）`projectKey=sha16(canonicalize(directory))` 与旧 key/实例 canonical 的兼容映射未定义

**v2 位置**：`:121-122`；旧实现 `plugin.ts:299-300` 是 `sha16(ctx.location.project.canonical ?? ctx.location.directory)`；SDK 字段见 `session-event.d.ts:34-56`、`v1/session.d.ts:1555-1576`。

**为什么是问题**：v2 说“兼容现有 item key”，但 `canonicalize` 没有定义；同时又说“不能假设 `session.directory` 等于实例 `ctx.location.project.canonical`”。如果 `session.directory` 是 worktree/subdir，而实例 canonical 是 repo root，按 `sha16(directory)` 会得到不同 key：自己的 session 会被判成 foreign/unknown，旧 item 不会被召回；如果反过来强行映射到 root，又和 v2 “subdir/worktree 不映射到 repo root”冲突。计划无法决定 `resolveOwnership` 的 equal/containment 规则。

**最小需要回答**：

1. `canonicalize()` 的精确定义（resolve/normalize/realpath？是否跟随 symlink？是否去尾斜杠/大小写？）。
2. `session.directory` 与实例 `ctx.location.project.canonical`/`ctx.location.directory` 的匹配是“完全相等”还是“允许 session 在实例 root 之下”？worktree/subdir 分别算 own 还是 unknown？
3. 旧 item 的 `projectKey` 是否必须逐字兼容；如果不兼容，迁移/observe 的分支是什么？

### N3（P1）created 缺失 optional `parentID` 直接判 root，是否“盲认”？

**v2 位置**：`:124`（“有效 created 且缺失 → root，parentChecked=true，不等 get”）；SDK `session-event.d.ts:52-56` 的 `parentID` 是 optional；当前 `plugin.ts:602-611` 只读 parent/agent，`plugin.ts:609` 只在 parent 存在时设 `parentChecked`，`:637` 只有 get 成功才设 true。

**为什么是问题**：v2 同时说“child 永不 root”，但 optional 字段的“缺失”并不等于 host 证明 root；如果 host 对某个 child 事件省略 `parentID`，设计会把子会话当 root 并学习其文本。反过来，如果要求 `session.get` 佐证，则 v2 的“不等 get”要改。这里需要明确是 host contract 还是 unknown。

**最小需要回答**：`session.created` 中缺失 `parentID` 是“host 保证 root”的正向证据，还是只表示“未声明 child”？若前者，写进 host 早期能力门；若后者，root 必须等 `session.get` 或保持 unknown。

## 9. 非阻塞残余（明确不扩成 blocking）

- **B1 验证点**：`ownershipEvidence.sourceHash` 的 canonical serialization 和重读点未写；只要 U5 明确“host 不可读→observe，不信任 record 自报”，不阻塞计划。
- **B6 cache identity**：cache key 未含 messageID/sessionID；U2/U4 只要明确“cached proposal 的 messageID 被忽略/重绑到当前 PendingEvidence”，不阻塞；若两者都不做，才会变成 fail-closed 的测试问题。
- **B5 `hourlyLimit`**：取现有 `review.maxRequestsPerHour`/effective 值的哪一个，属于 U3 接线选择，不改变协议；计划固定并测试即可。
- **`ownershipEvidence`/`repoIdentity` 的 `ownerVersion` 语义**：v2 未定义版本递增点；U0/U5 可在类型注释中定，不影响 B1–B9 的协议成立。
- **P01 “实测”**：本报告只核了 `changes.ts:263,455-457`、`suppression.ts:30-34,41-76`、`fingerprint.ts:11-15` 的代码行；未运行，不把作者文字当运行证据。P01 行为本身未发现新矛盾。

## 10. 能否进入 writing-plans

**结论：还不能无条件进入。** B1、B4、B5、B6、B7、B8、B9 已达到“可据以写计划”；B2 的 canonical 映射、B3 的 rawQuote 选择、以及 N3 的 parent root 证明仍是窄口 OPEN。它们不是要求重新设计 ownership/持久化，而是三句必须写进设计/接口的契约：

1. N2（canonicalize/match）——否则 own/foreign 与旧 item 兼容无法实现；
2. N1（rawQuote 选择/offset 坐标系）——否则 Pending→EvidenceRef 的 span 绑定无法实现；
3. N3（缺失 parentID 是否 root）——否则 child 可能被当 root 学习。

这三项若由设计作者补成明确契约，builder 看不到剩余 B1–B9 blocking；届时可进入 `writing-plans`，但仍需**用户批准设计**。v2 的 §11 host 早期关口（`:238`）方向正确，但它是文字 gate，不是证据；计划必须把它排成实现前可失败的早期任务（真实 host created/get/part provenance/transcript 重读），不能用 fake-host 通过替代。所有未来 G1–G7 测试 not-run 不构成设计失败，但也不能写成已通过。

---

# v3 scoped re-review（2026-11-12，追加；保留 v1/v2 历史）

Status: 只核 N1–N3 是否被 v3 关闭，以及 v3 直接新增的 H4/H5 必要接口是否自洽；未改候选/其他报告/产品/测试，未运行 host/模型，未提交。v3 的 G1–G7 全 not-run；只做设计与既有代码/SDK 的静态核对，不把文档中的“实测”当运行证据。**v2 结论中 N1–N3 的 OPEN 部分由本节更新；v1/v2 历史保留。**

Inputs: `DESIGN-P03-HYBRID.md` 259 行、`tmp/full-auto-memory/reviews/hybrid-design-v3.patch` 150 行、`reports/03-hybrid-design-resolution.md` §6（`:57-71`）。

## 11. N1–N3 裁决

| ID | 裁决 | v3 精确证据 | 结论 |
|---|---|---|---|
| N1 | **ADDRESSED** | v3 `:82`：capture seed 在模型前按结构句界/子句切分、synthetic/secret-only、完整句/子句、可带同发言者紧邻条件上下文、≤500、绝不前 500 字截断；`rawQuote=seed`、`seedHash`、seed 不可变；模型 quote 落在 seed 的 shown 区并映射 canonical kept；body/claim span 在 quote 内；`EvidenceRef` 可绑定更小 claim span（quoteHash）但保留 seedHash；长消息逐句分片，单句 >500 仅安全子句边界，否则 `skipped:source-too-long`；跨 seed 成句 quarantine。`:187` cache key 含 `sessionID/seedHash`，`ClaimProposal.messageID` 忽略/重绑当前 seed | seed 选择、不可变、≤500、上下文、cache 绑定均已答。**一个非阻塞精度**：`:86` 只写“坐标统一 UTF-16”，未在正文写 `offsetStart/End` 指 `canonicalText` 还是 seed 的 shown；resolution §6 已写 canonical，建议设计正文补一句。`Offset` 不改变 seed 协议。 |
| N2 | **ADDRESSED** | v3 `:124-127`：旧 `scopeKey=sha16(ctx.location.project.canonical ?? ctx.location.directory)` 逐字保留；`canonicalizeForMatch` 定义 realpath/normalize/去尾/NFC/失败 unknown/Windows 仅比较 casefold；`sessionPath` 解析 optional subpath 并拒绝 `..`/绝对逃逸；own 判据 exact → 旧 scopeKey、同 projectID subdir → 旧 scopeKey、同 repoIdentity 但 root 外 worktree → scope foreign 不合并；projectID 不匹配/exact 冲突 fail closed；runtime 无 `ctx.location.project.id` 只认 exact；无原生 match → unknown | 旧 key 兼容、exact/subdir/worktree、projectID 冲突、无 id fallback 均已明确。**观测备注**：本仓库本地 `PluginContext.location` 类型目前只有 `directory/project.canonical`（`plugin.ts:87`），没有 `project.id`；v3 已给“无 id 只 exact”的安全降级，U0/U5 需补类型，不构成设计 blocking。SDK `location.d.ts:29-35` 确有 `project.id/directory/canonical`。 |
| N3 | **ADDRESSED** | v3 `:129`：created 的 `parentID` 存在 → child skip；created 缺失 parentID → **unknown，不直接 root**；root 只在完整 `session.get` SessionInfo（id===sessionID、projectID/directory 与 native 匹配、parentID 缺失）或早期 host 能力门已证“created 缺 parentID = root”并记录 contract；get 缺失/失败/不完整 → unknown；`degraded:parent-unknown` 自动重试；旧 host 无 get 覆盖下降但安全 | 符合“created 缺 parent 先 unknown，完整 get/早期能力证明才 root”。没有再用 optional created 缺失直接判 root。 |

## 12. v3 新增 H4/H5 的 load-bearing 接口问题

### O1（P1）`evidenceRefID` 没有可指向的 `EvidenceRef.id`

**v3 位置**：`:71-76` 的 `EvidenceRef` 没有 `id`；`:138` 的 `globalCandidate` 每项存 `evidenceRefID`；`:200` 的 `ChangeEvent/QueueItem/ReviewEvidence` 只存 `evidenceRefID`/hash+offset。现有 `ReviewEvidence`（`types.ts:7-13`）也只有 `messageID/quote/kind`，没有 id。

**为什么是问题**：全局候选账本 TTL 90d，而 `PendingEvidence.id` 只有 72h；不能直接把 pending id 当 90d 的 `evidenceRefID`。`ChangeEvent`/`QueueItem`/`ReviewEvidence` 也不能在没有稳定 id 的情况下只存“evidenceRefID”。这决定 U0 的持久类型、U3 账本的外键、U4/U5 的审计引用；若由实现临时拼一个字符串，容易出现悬空引用或把 pending id 当永久 id。

**最小需要回答**：给 `EvidenceRef` 增加稳定 `id`（谁生成、何时生成、写入 item/queue/review 时是否保留），还是把 `evidenceRefID` 明确定义为 `itemID`/`changeID` 等现有稳定键？二选一即可，不需要扩展账本功能。

### O2（P1）H5 的 `originEpoch`/`baseItemVersion` 没有进入持久 DTO 或 cache key

**v3 位置**：`:166` 要求每个 proposal 带 `baseItemVersion`（模型调用前快照）和 `originEpoch`（capture 时该 source/item 的 latest changeID/tombstone epoch），写入用版本 CAS；`:169-170` 要求 stop/undo 后旧 pending/cache/in-flight 不符即丢弃。但 `PendingEvidence`（`:61-70`）没有 `originEpoch/baseItemVersion`；`ClaimProposal`（`:94`）也没有；`EvidenceRef`（`:71-76`）没有；cache key（`:187`）只含 `ownerVersion`，不含 `originEpoch`。

**为什么是问题**：`originEpoch` 是“capture 时”的值，必须在 pending 中持久化，才能在进程重启后判断 revert/tombstone 是否已经发生；`baseItemVersion` 是“模型调用前”的 CAS 基线，也必须在 pending/proposal 中保留。若只在内存中带，断电/重启后 pending 重新提取会拿到新 epoch/current version，可能把 revert 前捕获的旧证据写成新结果；cache key 不含 `originEpoch` 时，cache hit 也可能绕过 epoch 检查。这不是实现细节，直接决定 U0 类型、U3 pending 字段、U4 的 stale 判定和 U2 的 cache 键。

**最小需要回答**：`baseItemVersion`/`originEpoch` 放在 `PendingEvidence` 还是单独的持久 proposal 记录？`originEpoch` 的精确构造（单个 latest changeID，还是相关 item/tombstone 集合的 hash）？cache key 是否加入 `originEpoch`，或 cache hit 时强制从当前 P01 ledger 重新求值并比较？`sourceIdentityKey`（`:154`）也需一句定义；现有代码只有 turn/review `hookKey`（`suppression.ts:20-34`），没有同名类型。

### O3（P1）全局候选降级后的 item 状态/注入状态未定义

**v3 位置**：`:138`：“evidence 被撤销/失效时移除该 repo；剩 <2 且无显式 global quote → 已 global item 停止注入（写 change event），不静默删；再次校验失败 → stale。”

**为什么是问题**：现有 `ItemStatus` 只有 `auto|queue|shadow|promoted|false_positive|archived`（`types.ts:1-2`），没有 `stale`；`stale` 在 v3 中更像校验结果，不是可持久 item 状态。“停止注入”可以由 `invalidatedBy`、`deferredUntil`、scope 降为 project、archived 或新状态实现，但不同选择会改变：
- recall filter（P04 如何判断不注入）；
- item 的 `itemContentVersion`/queue snapshot（`fingerprint.ts:11-15` 含 status，不含 evidence）；
- change event 的 kind/actor 与用户可见活动；
- 之后第二个 repo 重新出现时如何恢复 global（是否需要新 item/新 epoch）。

**最小需要回答**：全球 item 降到 <2 repo 时，持久状态到底是什么（`invalidatedBy` 理由、`deferredUntil`、`scope=project`、`archived` 或新增状态）？写哪种 change event？第二个 repo 回来时是恢复原 item，还是新建/重新准入？

**同处一个次级问题**：`globalCandidate.claimKey`（`:138`）包含 `polarity`，但 `ClaimProposal`（`:94`）没有 `polarity` 字段；需要说明 polarity 由 validator 从 quote/否定解析，还是补字段。否则跨 repo 的 claimKey 匹配无法确定；这可作为 O3 的一句补充，不单独扩成新 blocking。

## 13. 非阻塞残余

- **N1 offset 文字**：resolution §6 已写 offset canonical；v3 正文 `:86` 只写 UTF-16。若设计正文是唯一权威，补“offsetStart/End 指 canonicalText”一句；不改变 seed 协议。
- **globalCandidate 有界性**：200 条/200KB/90d、无 rawQuote、ref/hash、repoIdentity、不跨项目模型配对、满则背压、撤销移除、expired 聚合——这些本身自洽，未发现新的容量矛盾；问题集中在 O1/O3 的引用与降级状态。
- **H5 与 P01 的代码事实**：`deactivate` 写 suppression（`changes.ts:263`）、`revert` 到 archived 才写 suppression（`:455-457`）、`reactivate`/`restoreVersion` 清 suppression（`:345`、`:581`）与 v3 的读侧说明一致；`sourceIdentityKey`/tombstone-capacity 属于 U0/U4 类型接线，不是当前设计重写。
- **host 早期门**：v3 §11 `:250` 的真实 host 能力门方向正确；它仍是文字 gate，不是证据。计划必须把 created/get、part provenance、transcript 重读排成实现前可失败的早期任务；fake host 不能关闭 C。

## 14. 能否据此写计划

**结论：N1–N3 已 ADDRESSED；但还不能无条件写计划。** v3 的 seed/canonical/parent 三个窄口已闭合，B2/B3 不再阻塞。v3 直接新增的 H4/H5 还有三个必要接口未自洽：

1. **O1**：`EvidenceRef.id` 不存在，`evidenceRefID` 无稳定外键；
2. **O2**：`baseItemVersion`/`originEpoch` 未进入 pending/claim/cache，H5 的 stale 判定无法在重启/cache hit 后成立；
3. **O3**：global item 降到 <2 repo 的持久状态/恢复路径未定义；`claimKey.polarity` 来源也未写。

这三项是类型/状态契约，不是重新设计 ownership/global 策略；补进 U0/U3/U4 后，builder 看不到剩余 blocking，届时可进入 `writing-plans`，但仍需**用户批准设计**。若设计作者认为它们只是实现细节，至少要在计划中写成明确假设；当前 v3 文本不足以让实现者无歧义地落 O1–O3。G1–G7 未来测试未跑不构成设计失败，但也不能写成已通过；P03 仍无产品代码，设计批准不等于产品完成。

---

# v4 scoped re-review（2026-11-12，追加；保留 v1/v2/v3 历史）

Status: 只核 O1–O3 是否被 v4 关闭，以及 v4 直接新增的 H5 `retired-sources`/P01 事务接线是否自洽；未改候选/其他报告/产品/测试，未运行 host/模型，未提交。v4 的 G1–G7 全 not-run；只做设计与既有代码/SDK 静态核对，不把文档中的“实测”当运行证据。**v3 的 O1–O3 OPEN 由本节更新；v1–v3 历史保留；N1–N3 及 B1/B4–B9 保留 v3 结论，不重开。**

Inputs: `DESIGN-P03-HYBRID.md` 274 行、`tmp/full-auto-memory/reviews/hybrid-design-v4.patch` 135 行、`reports/03-hybrid-design-resolution.md` §7/§8（`:71-92`）。

## 15. O1–O3 裁决

| ID | 裁决 | v4 精确证据 | 计划影响/结论 |
|---|---|---|---|
| O1 | **ADDRESSED** | v4 `:74-80` 加 `EvidenceRef.id`；`:88` 定义 `"ev:"+sha256(sessionID|messageID|offsetStart|offsetEnd|seedHash|quoteHash|rawQuoteHash)`，由本地 `EvidenceResolver` 在 host raw/offset 校验后生成；持久 `evidences.jsonl` 每 id 一行；`store.transaction` 同事务写 evidence + item/change/queue；pending 72h 只有 `seedId`，不作 90d 外键；active item/queue/review/globalCandidate 引用保护，无引用且超 90d 清，容量不足 `blocked:evidence-capacity`，缺失 ref degrade/fail closed | 稳定 id、生成点、持久表、同事务、72h seed/90d ev 分离和 GC 引用闭包均已写出。**非阻塞精度**：id 串里的 `rawQuoteHash` 没有对应字段；v4 `:99` 已定义 `quoteHash=sha256(rawQuote)`，实现用 `quoteHash` 即可，建议 U0 注释别名。`ChangeEvent/QueueItem/ReviewEvidence/globalCandidate` 只存 `evidenceRefID` 与 `EvidenceRef.id` 也已对齐。 |
| O2 | **ADDRESSED** | v4 `:61-73` 把 `seedId/sourceIdentityKey/originEpoch/targetSetHash/targets[{itemID,baseItemVersion}]` 写入 `PendingEvidence`；`:81-85` 本地 `ProposalEnvelope` 绑定 proposal/pending/sourceIdentity/targetSet/targetID/baseItemVersion；`:89` capture 前冻结 target 集（≤8）、`originEpoch` 公式、cache hit 读持久 epoch/version、不按 current 补 target/version；`:201` cache key 加 `originEpoch/targetSetHash` | 持久 target/version/epoch、可信 envelope、cache 前置、重启不重采 current、add 无 target/update 目标绑定均可落计划。**非阻塞精度**：`originEpoch` 公式的“latest source changeID/tombstone epoch”需在 U3/U4 定义为“该 source 相关集合的确定性 hash/最大时间”，但已不构成协议空白。 |
| O3 | **ADDRESSED** | v4 `:151`：新建 global + `linkGroupID`，同事务 archive/supersede 两个 project items，不改 scope、保留 P01 undo 快照；global stop/undo 覆盖 linkGroup，project 副本保持 archived；TTL 90d 视为 evidence invalid，`<2` 且无显式 global quote → `invalidatedBy/invalidatedAt`、status 不变、写 `ChangeEvent kind:"invalidate" actor:"system" reason:"global-evidence-below-2"`，P04/memoryVersion 排除 invalidatedBy；≥2 再现需新 global admission，不自动恢复；`claimKey` 含 kind/source scope/valueBearing/polarity，polarity 本地解析，无法判定不入 candidate | 新建/linkGroup/原 project archived/不改 scope/undo-stop/TTL 持久状态+event/恢复路径/polarity 均已明确。`linkGroupID` 需 U0 加到 Item/ChangeEvent，当前类型无（`types.ts:171-213`、`types.ts:650-670`）；这是 U0 字段工作，不是新设计。`invalidatedBy` 已有（`types.ts:209-210`），`buildContext`/memoryVersion 已排除（`plugin.ts:1397-1401`、`store.ts:1096-1103`），与 v4 一致。 |

## 16. v4 新增 H5：`retired-sources` 与 P01 事务接线

**v4 位置**：`:166-172`：`retired-sources.jsonl` 键 `sessionID|messageID`（message-level，同消息 respan 也命中）；每行 `items[{itemID,changeID,reason:"deactivate"|"revert"|"undo",claimKey?}]`、`quoteHashes[]`、first/last/version；不存 rawQuote、不随 90d 过期；`deactivate`/`revert-with-before`/`undo` **必须同一 P01 `store.transaction`** 写 retired index；capture 命中 skip；restore/reactivate 只移除对应 item，全部移除才删除；`retiredSourcesMax=2000/200KB`，满 `blocked:retired-source-capacity`，只有 host 永久删除证明才 prune。

**可实施性判断：核心协议可落，但“P01 不改”与“同事务写 retired”之间的文件/单元归属是唯一窄口 OPEN。**

- `retired` 的 message-level key、同消息 seed/quote/respan 拒绝、无 90d、restore 一对一删除、容量背压、host 删除证明、`originEpoch` stale 都已明确，且与 v4 `:177` 的 `itemContentVersion` 排除一致。
- 现有用户动作入口是 `server.ts:942`（`deactivateItem`）、`:952`（`revertChange`）、`:957`（`restoreVersion`）；P01 事务在 `changes.ts:227-263`、`:370-457`、`:487-581`。要“同一 P01 store.transaction”写 retired，最小实现是在 `server.ts` 路由外层用 `store.transaction` 包住 P01 调用并在同一 batch 写 retired；`store.ts:243-260` 的嵌套 transaction 共享 batch，技术上可做到，不需要改 P01 的公开行为。但这要求：
  1. 明确 **“P01 不改”= 行为保持，不禁止改 `server.ts` 路由或增加 P01 transaction hook**；若按字面“P01 文件/代码不可动”，则同事务 retired 写入无法实现。
  2. 指定负责单元/文件：U6 目前写的是 `server.ts`（但职责表只写“status 只读”），U3 写 `memory/retired-sources.ts`；没有单元明确“server 路由 + retired 同事务”的接线。若由 U6 承接，应把 U6 责任从“只读 status”扩为“用户动作 retired 接线”；若由 U4/U5 承接，应把 `server.ts`/`changes.ts` 列进对应文件清单。否则计划会出现无人认领或跨 3–5 文件边界。
- 另外 `retiredSourcesMax=2000/200KB` 满时是“阻止新增 retire 写入”还是“阻止新 capture”，v4 只写 `blocked:retired-source-capacity`；这会影响 U5 capture 与 U6 状态，属于同一接线句，建议一并写明（不扩成新机制）。

**裁决：H5 协议本身 ADDRESSED，事务/单元归属 OPEN（窄，P1）。** 不需要重新设计 retired 语义；需要设计作者补一句“P01 不改=行为保持；U6 server 路由在 store.transaction 内写 retired；满时只阻断新 retire/由 U6 显示 blocked，不阻断已存在 capture 的读取”或等价归属。

## 17. 非阻塞残余

- **O1 id 公式**：`rawQuoteHash` 与 `quoteHash` 的关系可注释为同一值；`EvidenceRef` 字段已够。
- **O1/O3 ledger 同事务**：`globalCandidate`/`retired` 的引用写未像 evidence row 一样逐项列进同一 transaction；retired 由 H5 明确，globalCandidate 由 O3 promotion 明确“同 store.transaction”；若 U3 在实现中把 ledger 写拆开，GC 只会 fail-closed/降级，不是错误写入。计划可要求 ledger 写与 promotion 同一 batch。
- **O2 `originEpoch` 的 latest 集**：U3/U4 需定义为相关 source/tombstone 的确定性 hash；不影响字段协议。
- **O3 超过两个 repo**：v4 写“两个 project items”；三元以上 linkGroup 的扩展未单列，但两 repo 是准入下限，按现有 candidate 账本可自然推广；不阻塞。
- **Host 早期门**：v4 `:264` 的 created/get、part provenance、transcript 重读仍是文字 gate，不是证据；计划必须排成实现前可失败的早期任务，fake host 不能关闭 C。未来 G1–G7 not-run 不是设计失败，但也不能写成已通过。

## 18. 能否据此写计划

**结论：O1–O3 已 ADDRESSED；H5 的 P01 transaction/单元归属仍有一个窄口 OPEN，因此还不能无条件进入 `writing-plans`。** 这不是要重做 global/retired 语义，而是补一句事务归属：

1. 明确 `P01 不改` 指**行为保持**，允许在 `server.ts` 用户动作路由外层包 `store.transaction`（或等价 P01 hook）；
2. 指定 U6 承接 `deactivate/revert/undo → retired index` 同事务，或把 `server.ts`/`changes.ts` 列入 U4/U5 文件清单；
3. 明确 `retiredSourcesMax` 满时阻断的是新 retire 写入还是新 capture（建议只阻断新 retire，已存在 capture 仍可查 retired 键）。

补完后，builder 看不到 O1–O3/H5 的负载矛盾，可进入 `writing-plans`；仍需**用户批准设计**。所有 P03 代码/测试/真实 host 尚未运行；设计可计划不等于产品完成，G1–G7 与 host 早期门都不能写成已通过。
