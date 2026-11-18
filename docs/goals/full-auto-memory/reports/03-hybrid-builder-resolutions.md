# P03 Hybrid — builder resolutions（B1–B9）

Status: **工程决议，不是独立审查通过，也不是用户批准。** 候选 `DESIGN-P03-HYBRID.md` 保持原样；未改候选/旧主设计/phase/PROGRESS；无产品代码/测试/安装/模型/host/提交。  
Baseline: P02 + known-foreign wiring 74 files / 929 tests / verify0（既有证据，本文件未重跑）。  
原则：用户已委托工程选择；以下都在既有目标内决定，不再要求用户选。Host 运行时未知仍标 U，不编造。

## B1 — ReviewRecord 不能自证 ownership

**决议**
- `ReviewRecord` 新增可选 `ownershipEvidence`：`{source:"session_created"|"session_get"|"event_location", projectID?, directory, canonical, projectKey, at, version:1}`。只有带该字段、且 `source` 是原生 host 证据的记录，才可作 ownership **bootstrap**。
- `status=ready` / `queued>0` **不是** ownership 权威；`record.projectKey` 若来自实例 key 或 `contextProjectKey`，只是 hint。legacy 无 `ownershipEvidence` 的记录 → `ownershipUnknown`/observe，不授权写入/召回。
- `contextProjectKey`、插件实例 `projectKey`、`ReviewRecord.projectKey` 均不得单独授权；`contextProjectKey` 只可用于 known-foreign 的 **skip**（安全方向）。
- `resolveOwnership` 读取 record 时只接受 `ownershipEvidence` 与当前 session 匹配且无冲突的记录；`ready/queued` 不参与循环。

**兼容/验收**
- 旧记录不改写、不批量迁移；无字段即不可用。新记录由 `ReviewOrchestrator` 写入时复制 `SessionState.ownership`（来自原生 event/get）；若没有则省略。
- 验收：legacy record + 只有 ready/queued → 不写；native `ownershipEvidence` record → 可 bootstrap；record 与当前 native 冲突 → fail closed。
- 引用：`types.ts:38-64`、`orchestrator.ts:476-480`、`plugin.ts:299-300`。

## B2 — 原生 owner 字段与 parent 三态

**决议**
- 原生来源优先级：`session.created.data`（`projectID` required、`location.directory` required、`parentID` optional）→ `SessionInfo`（`projectID`、`directory`、`parentID`）→ envelope `event.location.directory`（若存在）→ 带 `ownershipEvidence` 的 ReviewRecord → 实例/`contextProjectKey` hint。任何两个原生来源冲突 → fail closed。
- `projectKey` 兼容映射：`canonical = canonicalize(directory)`；`projectKey = sha16(canonical)`，与现有 item key 兼容。`projectID` 作为 host 身份用于一致性/冲突校验，不改 key。只有 `projectID`、无 `directory` → 无法映射旧 key，`ownershipUnknown`（不写/不动态召回）。
- parent：`session.created.data.parentID` 存在 → child skip；**有效 created 且 parentID 缺失 → root**（`parentChecked=true`，不必等 `session.get`）；`session.get` 成功且 parentID 缺失 → root；`session.get`/created 读取失败 → unknown skip。child 永不 root。
- U2 修复：未知 owner 的 `session.created` 不调用 `refreshContext(..., instanceProjectKey)`、不写 `contextProjectKey`；置 `ownershipUnknown`，不动态召回。有效 created/get 后绑定 native owner；root 因此不会“永不学习”。
- Runtime 不交付 SDK 字段 → safe degradation：unknown，不写当前项目；这是设计分支，不是待用户选。

**兼容/验收**
- 现有 `sha16(canonical)` item 继续命中；`projectID` 变化但 directory 不变、或 directory 变化但 projectID 不变 → conflict/no write。
- 验收（fake host）：created root 学习；created child skip；get 缺失 + created 无效 → unknown；created/get 冲突 → no write；U2 无 A key。
- 引用：`@opencode/schema/dist/session-event.d.ts:34-56`、`v1/session.d.ts:1555-1576`、`plugin.ts:602-637`。

## B3 — in-memory packet 与 persisted pending 分离；坐标/裁剪/redact 固定

**决议**
- `EvidencePacket` 只驻内存：包含 `canonicalText`、`shownText`、`partMap`、`transform`；**不落盘**。
- `PendingEvidence` 是唯一持久 DTO：`id/sourceHash/sessionID/messageID/observedRole/originProjectKey/rawQuote(≤500)/quoteHash/offsetStart/offsetEnd/canonicalHash/shownHash/transformVersion/redactionProfile/status/attempts/nextRetryAt/expiresAt`。**不存 rawText/shownText/full parts**。
- `canonicalText`：`SessionReader.readForEvidence` 返回的 `normalizeSessionMessage` 拼接文本（parts 以 `\n` 连接），在现有 4000 字裁剪**之前**；若 host/reader 只能给裁剪文本，`readerTruncated=true`，offset 只在该窗口有效，超出 → `evidence_truncated`。
- 坐标：**UTF-16 code units**（JS string index），`offsetStart/End` 指 `canonicalText`；`rawHash=sha256(utf8(canonicalText))`、`shownHash=sha256(utf8(shownText))`、`quoteHash=sha256(utf8(rawQuote))`。`partMap` 只在内存；pending 不存 parts。
- Redaction 分 profile：capture/pending 用 **secret-only**（API key/token/password 等），**不**复用默认 `redactText` 的绝对路径替换；path/reference 正常保留。secret 命中 → 跳过该 sentence/quote，不持久、不发送。模型 shown 用 secret-only + fit；不得静默把路径类记忆整条 skip。
- 截断不得切值：`rawQuote` 必须是完整 sentence/clause，≤500；超长 → 该 sentence 进 quarantine/skip，不截断。`PendingEvidence` TTL 72h、50 条、200KB；`EvidenceRef` 随 active item，queue/review 证据 90 天封顶；无全量 transcript。
- 验收：pending 文件无 rawText/shown；重启/断电不丢 quote/hash/offset；redact/truncate 边界 quote → `evidence_transform_gap`；路径 reference 可学、secret 不可学。
- 引用：`session/reader.ts:32-36,150-160`、`normalize.ts:43-46`、`redact.ts:23-41`、`review/input.ts:86-102`。

## B4 — 200 字正文、30 字标题与 linter 不变量

**决议**
- 保留 `memoryMaxChars=200`、`titleMaxChars=30` 与现有 `lintText` errors。`rawQuote`（≤500）只是证据；**body 必须是 `rawQuote` 的连续子串且 ≤200**。
- 提取规则：模型给出 `body`；validator 检查是 `rawQuote` 子串、≤200、包含 `value`/必要 `qualifiers` token、token 边界完整；不得截断值/路径/端口/版本，不得丢否定/条件。多 claim → 模型拆成多个 body，各自验证；拆不出/无法忠实 ≤200 → quarantine，**不截断、不绕过 linter**。
- 示例/比如/transient/secret 等命中 `lintText` → quarantine/skip；保留旧 linter 语义。`title` 由模型给或本地 fallback（≤30）；title 不支持不构成 body 证据，不声称语义正确。
- `canAutoApply` 的 `origin=session-review` 硬拒绝只保留在 **automation.enabled=false** 的 legacy 路径；新 `automation.enabled=true` 路径改用“EvidenceRef + body + risk gate” admission，普通 review 不再永久挡。rule/skill 仍 manual。
- 验收：201–500 字原话不被静默截成 200；≤200 完整子串可写；多 claim/示例/transient/secret 不进 auto；review decision 可走新门、旧 legacy 断言不变。
- 引用：`config.ts:81-83`、`linter.ts:64-77`、`consolidate.ts:921-923`。

## B5 — 日+小时一次预占；in-flight 与公平

**决议**
- 新增 `Store.takeAutomationModelSlot({dailyLimit, hourlyLimit, now, purpose})`：单锁内同时检查/递增日计数与共享小时窗口，任一失败则**都不递增**；返回 `{ok, reason, retryAt, usedDaily, usedHourly, reservationID}`。不半占。
- 崩溃语义：reservation 先持久化 `reserved`，dispatch 后标 `dispatched`，完成/失败标终态；崩溃遗留 `reserved` 按 **attempt/reservation** 保守计数，启动标 `abandoned`，不退；不声称真实 network exactly-once。`usage` 缺失记 `usageMissing`，不伪造成 token。
- 缓存/预检在 reserve 前；`StructuredGenerate` 返回 `{text, usage?, cached, attempts, requestID?}`；cache hit `attempts=0`、不占；repair/retry 每次 dispatch 重新 reserve。
- 单飞：全局 `claim("extract:worker")`，并发 1；batch ≤8；per-session `PendingEvidence` lease 防重复；不按 session 多开。
- in-flight：任务开始时记录 `configRevision/enabled/model/prompt/schema`；返回后写事务前重读；`enabled=false` 或 revision/model 变化 → discard/abort，不写；pending 回 `retry_wait` 或 `skipped`（按原因），最多 3 次。
- 公平：共享 40/day 与既有小时上限，不提高；pending 年龄 >15min 时每小时**保留 1 个 extract slot**，review 该小时最多用 `limit-1`；无 pending 时 review 用满。extract 不会无限饿死，也不新增预算。
- 验收：日成功/小时失败无半占；崩溃 `reserved` 可见且不超卖；cache hit 不占；停用/换配置不写；单飞并发 1；aging 生效。
- 引用：`store.ts:670-681`、`provider.ts:282-284`。

## B6 — 单一 transport/model：继承 review 配置

**决议**
- `extract` **继承** `config.review.transport` 与 `config.review.model`（含 `providerID/id/variant`），不新增 `automation.model`，不做迁移/UI；review transport 不可用 → extract degraded，不 fallback 到另一 provider。
- `ModelCaller` 只复用代码，不共享实例状态：extract 与 review 各自 `circuit/failures/cache`；budget 通过 Store 共享。extract 失败不打开 review circuit。
- `cacheKey` 必须含：`purpose:p03-extract`、`transport`、`providerID`、`model.id`、`variant`、`promptVersion`、`schemaVersion`、`rawHash`、`shownHash`、`transformVersion`、`originProjectKey`、`ownerVersion`、`redactionProfileVersion`。`ownerVersion` 取 `SessionState.ownership.checkedAt/version`。命中后仍重验来源/抑制/当前 item 版本/CAS；失败删 cache、quarantine。extract cache 独立 200 条/24h，不串 review cache。
- Runtime：`generate.text` 返回 `unknown`，`ExtractProvider` 必须校验 `{text:string}`；无 schema/tools/usage 能力，usage 仅在真实返回时记录；不伪造。`StructuredGenerate` 返回 `cached/attempts` 以支持 B5 计数；不保留第二套 API。
- 验收：transport/model 继承；cache 不串 review；circuit 不互相拖死；cache key 覆盖 shown/transform/owner；runtime shape 无效 → config error/no write；usage 缺失不伪造。
- 引用：`plugin.ts:101-123,464-470`、`provider.ts:125-219`。

## B7 — learning 维持 failing tool；review 证据桥

**决议**
- `learning` 维持现有 **失败 tool** 条件（`review/validate.ts:170-172` 的 `!tool.ok`），候选设计“ok tool”是笔误，以现有代码为准。
- Tool evidence：`kind:"tool"`，`messageID` 指 tool 消息/part，`quote` 对 digest 摘要逐字校验；新增可选 `toolCallID/partIndex/digestHash/rawHash?`。tool 证据**不替代** user 身份/quote；preference/global 仍需 user `EvidenceRef`；learning 默认 project，global 仍走同一高证据门，不能仅凭 tool failure 升 global。
- `review/input.ts` 保留 raw/shown map 与 user 原文；`review/validate.ts` 用户 quote 对 raw、tool quote 对 digest；`review/accept.ts` 携带 `EvidenceRef`/tool ref。三者由 **U1b** 认领（3 文件）。
- 新 `automation.enabled=true` 路径删除 review-origin 永久硬拒绝，改“有 user EvidenceRef + 通过 admission”才 auto；legacy `canAutoApply` 不变；rule/skill 仍 manual。
- 验收：learning 必须 failing tool；成功 tool 不触发；tool 不能冒充 user；review decision 可 auto、rule/skill 仍 queue；旧断言不降。
- 引用：`review/validate.ts:170-172`、`review/input.ts:86-102`、`consolidate.ts:921-923`。

## B8 — P03 只做后端契约/状态；P04/P05 独立

**决议**
- P03 单元改为：U0 `types.ts`（契约/可选字段，先做）；U1 evidence core（`session/reader.ts`、`session/normalize.ts`、`redact.ts`）；U1b review bridge（`review/input.ts`、`review/validate.ts`、`review/accept.ts`）；U2 extract（`review/provider.ts`、`review/extract.ts`、`review/parse-extract.ts`）；U3 pending（`store.ts`、`memory/pending.ts`）；U4 admission（`automation.ts`、`memory/claim-validate.ts`）；U5 ownership/wiring（`plugin.ts`、`consolidate.ts`、`session/filters.ts`）；U6 backend status/API（`server.ts`、`memory/status.ts`）；U7 integration tests（`plugin-hybrid.test.ts`）。每单元 ≤3–5 产品文件。
- 删除 U6 的 `console`（实际 `console/src` 约 40 个源文件，不能冒充一个 ≤5 文件单元）；P04 recall（`recall.ts` + context hook）与 P05 frontend（页面/组件按页面拆分）是独立阶段，P03 只提供 `effectiveMode/pending/degraded/ownership` 等只读字段，不实现 UI；全量目标不变，拆分交付。
- `types.ts` 先行，U1–U6 只消费；review evidence 改造不再“无人认领”。
- 验收：每单元文件数 ≤5；U6 无 console；P04/P05 不混入 P03 任务；类型变更前置。

## B9 — 360px 硬约束

**决议**
- P05 验收改为 **真实 360px** 最小视口；rail **260/320**；触控 **44px**。390px 只可作为设计稿宽度，不是验收替代；360 下不得横向滚动。
- 验收：360 单列/sheet/44px；rail 260/320；键盘/撤销状态保留。

## N1 — capture 的 seed 选择与 quote/offset 绑定

**决议**
- capture 在模型之前对 `canonicalText` 做**结构句界/子句切分**；seed 先经 synthetic 剥离与 secret-only redaction（secret 命中该句 skip）；每个 seed 是完整句/子句，可带同说话人紧邻句作为条件/指代上下文，`seed ≤500`；**绝不做“前 500 字”截断**，也不让模型后写覆盖旧 seed。
- seed 固定不可变：`PendingEvidence.rawQuote=seed`、`quoteHash=seedHash`；模型 `quote` 必须落在该 seed 的 shown 范围并映射回 canonical kept 区；`body`/claim span 必须落在 `quote` 内。`EvidenceRef` 可绑定更小的完整 claim span（新 offset/hash），但**绝不改 seedHash**。
- 长消息：每个完整句一个 seed；单句 >500 时只在**安全子句边界**拆，拆出的每片必须自身完整；否则 `skipped:source-too-long`。计数 `seedCount/tooLong/dropped`；pending 满按 §7 背压，不静默丢。
- 坐标唯一：持久 `offsetStart/End` 永远指全 `canonicalText` 的 UTF-16；shownSeed 位置由 `transform` 映射回 canonical；不混用 shown offset。
- 模型 quote/body 必须保留支配的否定/条件/归属；跨 seed 才能成句的 claim → quarantine，不拼接。
- cache key 加 `sessionID+seedHash`；cache 命中时 `ClaimProposal.messageID` 忽略/重绑当前 seed，避免同文跨 session 混淆。
- 验收：长消息无“首 500”丢句；seedHash 不变；quote/body 不出 seed；offset 可回指 canonical；同文跨 session 不命中同一 proposal；跨 seed claim 0 auto。
- 引用：v2 §3.2/§3.3/§5；`session/reader.ts:32-36,150-160`、`normalize.ts:43-46`。

## N2 — 旧 scopeKey 与 canonical 匹配

**决议**
- 旧 key **逐字保留**：`scopeKey = sha16(ctx.location.project.canonical ?? ctx.location.directory)`（`plugin.ts:299-300` 的原始字符串）。**路径规范化只用于匹配，不得用于重算/替换旧 key**；新 item 的 own scope 仍用实例旧 key。**v2 §4.1 的 `sha16(canonicalize(directory))` 表述由本决议取代**，合并时改为“旧 key + 仅匹配 canonicalize”。
- `canonicalizeForMatch`：`realpathSync.native` 跟随 symlink → `path.normalize` → 去尾分隔符（根除外）→ NFC；失败（ENOENT/EACCES/非法）→ `unknown`；Windows 仅比较时 casefold。不得用 `startsWith`；用 `path.relative` 的段边界。
- `sessionPath`：`realpath(location.directory)` 解析 optional `subpath`（若 `..`/绝对逃逸 → unknown）。实例侧：`ctx.location.project.id`（SDK `location.d.ts:29-35` 的 `project.id`）、`project.canonical`、`directory`。
- own 判据：
  1. `session.projectID === ctx.location.project.id` 且 `sessionPath` 与实例 `canonical`/`directory` **exact** → own，旧 scopeKey。
  2. 同 projectID 且 `path.relative(instanceCanonical, sessionPath)` 非空、非 `..`、非绝对 → **subdir own**，仍用旧 scopeKey；不新建 key。
  3. 同 `repoIdentity` 但 sessionPath 在实例 root 之外（worktree）→ **scope foreign**（即使 projectID 相同也不合并），不映射 root、不写当前项目；repoIdentity 只在 global 独立计，且同 repo worktree 不凑第二个 repo。
- `projectID` 不匹配 → foreign/conflict fail closed；完全缺失 `ctx.location.project.id` 的 runtime → 只认 exact directory，subdir/worktree → unknown；早期 host 门验证，不虚构字段。目录 exact 但 projectID 冲突 → fail closed。
- 无足够原生 match → `unknown`，不写当前项目、不动态召回；不把任意子目录/同 repo 路径盲映射 root。
- 引用：`session-event.d.ts:34-56`（data `projectID/location.directory/subpath/parentID`）、`v1/session.d.ts:1555-1576`（`SessionInfo.id/projectID/directory/parentID`）、`location.d.ts:29-35`、`plugin.ts:299-300`。

## N3 — parentID 缺失不是自动 root

**决议**
- 有效 `session.created.data.parentID` 存在 → child skip，永不 root。
- `session.created` 缺失 `parentID` → 先 `unknown`，**不直接 root**；**v2 §4.1 的“created 缺失→root”由本决议取代**。
- root 只在：`session.get` 返回完整 `SessionInfo`，`id===sessionID`、`projectID`/`directory` 与 native 来源匹配、`parentID` 缺失；或早期 host 能力门已证明“created absent parentID = root”并记录该 contract。否则 unknown。
- `session.get` 缺失/失败/对象不完整 → unknown；不写当前项目、不动态召回；状态 `degraded:parent-unknown`，可自动重试；child 不得学成 root。
- 旧 host 无 `session.get` → 覆盖下降但安全；native created/get 之后自动恢复；不要求用户为覆盖放宽 root 判据。
- 验收：created child 0 写；created 缺 parent + get 缺/失败 0 写；get 完整且 parent 缺失 root 可学；gate 未证时 unknown；child 0 学成 root。
- 引用：`session-event.d.ts:52-56`、`v1/session.d.ts:1572-1576`、当前 `plugin.ts:602-637`。

## 仍未知（不由本文件解决）

- 真实 host 是否交付 `session.created.data`/`SessionInfo` 字段、是否按目录过滤事件、是否对 system/工具限权；runtime 不交付即按 B2 safe degradation（unknown/no write），不编造。
- host 是否能重读 transcript/原文以重算 hash；不能则 pending → `evidence-unavailable`，普通记忆覆盖下降，需在验收如实报。
- `generate.text` 内部是否启用工具/子会话；本设计只按返回形状校验，不声称无工具。
- 以上是 U/待 host 审计，不阻塞本次工程决议；没有需要用户重新选择的语义取舍。
