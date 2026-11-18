# P03-A 证据契约与权限边界审计（只读）

Status: 只读审计完成，未改产品代码/测试/配置，未运行 host 或模型。基线为当前 worktree 的 P02 生产树（P01/P02 未提交改动仍在）。
Date: 2026-11-11
Scope: `plugin/src/{consolidate.ts,review/*,memory/suppression.ts,relations.ts,plugin.ts,types.ts,linter.ts,memory/write-guard.ts,memory/scope.ts}` 及必要调用点；不读真实记忆/凭证/正式配置。
Method: 静态阅读 + 行号核对；不运行 `npm test`/`verify`，不发起网络或子代理。
Marks: **O**=代码直接可见；**I**=由代码结构推断（未执行）；**U**=本仓库无法证实（host 内部/未读实现）。

## 1. 结论先行

1. **Capture 没有“原始 quote”**：`extractCandidates` 只取 `isUserAuthored` 的句子，`source.role` 硬编码为 `user`，`messageID` 缺失时写 `"unknown"`；没有偏移、原文校验或逐消息 session/parent 校验。O `consolidate.ts:871-906,769,892-896`；`filters.ts:23-28`。
2. **Review quote 只对“模型看到的文本”成立**：`ReviewInput.sources` 存的是 `fit()` 截断/空白归一后的用户文本（开启 redact 时还会替换）和 tool digest 摘要；`validate` 只做该 map 的 substring 检查，不是 host 原始消息。O `review/input.ts:86-102,108-135,197-207`；`review/validate.ts:144-157`。I：tool quote 无法仅凭证据回到原始 tool output。
3. **Baseline 没有 memory authority 层**：`authority` 仅存在于 `graph.ts` 的图层来源，不是写入/权限门；`strictness` 是 SystemOne 的模型答案，review lane 直接设为 `unknown`；rule 语法只有 linter 警告，不是硬门。O `graph.ts:34,372-387`；`types.ts:131-159`；`systemone.ts:254-263`；`review/decision.ts:22-34`；`linter.ts:73-75`。
4. **所有 write guard 只门“写记忆”，不门“执行”**：`findWriteConflicts` 只被 consolidate/apply/actions/promotion 调用；没有 host permission/tool-execution hook。O `write-guard.ts:84-126`；`consolidate.ts:366-419,496-539`；`actions.ts:380-418`。I：memory 文本进入 system 后仍可能被模型当指令。
5. **P02 的 review projectKey 没有接上**：`ReviewOrchestrator` 构造未传 `projectKey`，导致 `owns()` 恒 true、`onAccepted` 的第 4 参恒 undefined，project review 候选在 accept 降级为 session note。O `plugin.ts:481-508`；`review/orchestrator.ts:31-32,468,479,660-664`；`review/accept.ts:108-111`。I：影响是项目复习候选不能落项目记忆，且自动入口的项目隔离变空操作。
6. `grantsPermission:false` 不是“不会误学/不会执行”的证据；baseline 甚至没有该字段。O `types.ts:171-213`（无该字段）；P03-A 的字段已在归档，不在生产树。

## 2. 生产链路与调用顺序

| 阶段 | 实际入口/顺序 | 证据与信任边界 |
|---|---|---|
| 触发 | `ctx.event.subscribe` → `session.idle`/`session.execution.*`；`session.created` 记 parent/agent | O `plugin.ts:534-544,583-606`。事件是 server-wide；代码只按 parent 跳过子会话，未见按 project 过滤 consolidate（I）。 |
| 读消息 | `readMessages` → `SessionReader.read` → `ctx.session.context({sessionID})`；缓存 400 条、每会话 8 个 | O `plugin.ts:386-389,262-265`；`session/reader.ts:57-110`。host 返回的 transcript 是唯一来源；`SessionMessage` 无 sessionID/parent/project 字段（O `types.ts:538-548`）。 |
| 归一化 | `normalizeSessionMessage` 把全部 part.text 拼成 `message.text`；role 取 `info.role`/`entry.role`/`info.type` | O `session/normalize.ts:39-88`。part 类型未参与拼接（O）；I：user 消息里夹带的合成文本会进入 `text`。 |
| Turn capture | `runConsolidation` → `users = messages.filter(isUserAuthored)` → `captureHooks` → `extractCandidates` → 句切/`compact` → `appendHook` | O `consolidate.ts:101-124,749-796,871-906`；`filters.ts:14-28`。只认 role/type=user 且非 synthetic/keep-alive；不剥 `<context>`/任务信封。 |
| Hook key | `sessionID / messageID / sha16(normalized text)` | O `consolidate.ts:855-860`。同会话多个无 id 消息且同文会共用 `unknown` key（I）。 |
| 待处理 | `loadPendingHooks` 取 pending/blocked/failed(<3)/超时 processing；fresh 优先，retry 留 1 槽 | O `consolidate.ts:798-832`。批大小受 `turn.maxCandidates` 限制，不是 capture 上限（O `:758-762`）。 |
| 预检 | redact → suppression → 批内去重 → 邻居 exact 预检 → `claim` 预留 | O `consolidate.ts:170-236`。`redactText` 在 capture 和 hook 处理各一次；`isSuppressed` 用 hook.key + textHash。 |
| 分类 | review 来源 `reviewDecision`；否则 `deps.decision.classify`（SystemOne/Heuristic） | O `consolidate.ts:245-265`；`review/decision.ts:22-34`；`decision.ts:226-275`。模型给 kind/strictness/safeAuto/risk/mergeAction/mergeTargetId。 |
| 写前判定 | `canAutoApply` → `findWriteConflicts` → admission → shadow/auto/queue | O `consolidate.ts:356-422,443-581,694-715`。auto 分支在事务内重新 `ownsClaim`、重新 list/guard/admission（O `:490-541`）。 |
| Review 调度 | `schedule` → parent/retry/live 检查 → `delta` → `buildInput` → 材料阈值 → `takeSlot` → `runModel` | O `review/orchestrator.ts:107-115,311-443`。`takeSlot` 是 run 预算；`runModel` 前写 `reviewStatus=running`。 |
| Review 输入 | `ReviewInputBuilder.build` 倒序取 user 文本（`typeof message.text === "string"`）和 tool digest；生成 hash | O `review/input.ts:57-163`。reader 已把 parts 拼入 `text`（O `normalize.ts:43-46`），builder 本身不再读 parts（O `:86`）；tool 摘要来自 digest（O `:108-135`）。 |
| Review 模型 | `buildReviewPrompt` → `ReviewProvider.review` → cache/request/parse/repair → `validateReviewCandidates` → `onAccepted` | O `review/provider.ts:140-219,462-517`；`plugin.ts:481-505`；`review/orchestrator.ts:443-469`。生成 JSON 仅靠 prompt + 本地 parse。 |
| Accept | `acceptReviewCandidates` 建 `HookRecord`（`origin:"session-review"`）→ `appendHook` 事务 | O `review/accept.ts:50-228`。不直接写 queue/item/AUTO；随后 `consolidate(input.sessionID)` 走正常 pipeline（O `plugin.ts:500-503`）。 |
| 上下文 | `resolveContext`/`applyContextRequest` 把 active items 渲染进 `event.system` 的 `<context key=...>` 和 `instructions.entry` | O `plugin.ts:1310-1369,1379-1423,1443-1467`。只取 auto/promoted、未失效、未过期；project 需同 projectKey。 |

## 3. 原始 quote 与身份契约

### 3.1 Capture

| 问题 | 事实 | 标记 |
|---|---|---|
| 有 quote 字段吗 | 没有；`Candidate` 只有 text/title/trigger/source | O `consolidate.ts:60-65,888-897` |
| 文本是原文吗 | `compact()` 折叠空白、按句切分；长度 8–400 | O `consolidate.ts:879-884,1047-1052` |
| role 可信吗 | 硬编码 `role:"user"`，不读消息实际 role | O `consolidate.ts:892-896` |
| messageID 可信吗 | 取 `message.id`；缺失写 `"unknown"`，并进入 key | O `consolidate.ts:769,855-860,893-895` |
| sessionID 可信吗 | 来自 `runConsolidation(sessionID)` 实参，不来自消息 | O `consolidate.ts:89-101,773-785` |
| projectKey 可信吗 | 来自 `deps.projectKey`（插件实例），不来自消息 | O `consolidate.ts:782-784`；`plugin.ts:299-300,382-391` |
| parent 能逐消息判断吗 | 不能；parent 只在 `SessionState`，consolidate 入口不查 | O `types.ts:75-86`；`plugin.ts:590-631` |

### 3.2 Review

- 模型返回 `type/text/scope/confidence/evidence[{messageID,quote,kind}]/task_only/scope_evidence/steps`（O `review/parse.ts:21-89`）。
- 硬门：`messageID` 必须存在于 `input.sources`；`kind=user` 的 quote 必须是 `source.user` 的 substring；`kind=tool` 必须是该消息 digest 摘要的 substring；`learning` 必须有不 ok 的 tool；`skill` 必须有 ≥2 steps、user quote、ok tool（O `review/validate.ts:144-183`）。
- `candidate.text` 是模型自己的措辞，**不要求**是 quote 的 substring，也没有事实/来源一致性检查；只有长度、lint、候选间相似度门（O `review/validate.ts:123-142`）。I：模型可在 quote 为真时写出 quote 未支持的内容。
- `scope=global` 只有在 user evidence 文本本身被判 global，或 `scopeEvidence` 是 user source 的 literal substring 时才保留；否则降级（O `review/validate.ts:16-57`）。`scope=project` 只要 evidence 不被判 session 就保留，不要求 quote 含项目词（O `:25-33`；I：project 身份可被模型声明）。
- `project` 候选在没有 `projectKey` 时降为 session note，不建 hook（O `review/accept.ts:106-111,148-160`）。
- Accept 的 `source.role` 来自 evidence.kind，而不是 host 消息 role；但 kind 与 lane 的 substring 检查绑定（O `review/accept.ts:178-183`；`review/validate.ts:149-156`）。I：这是“模型声明 + 输入窗口约束”，不是 host 签名。
- `ReviewInput.hash` 只覆盖 `[id, role, text]`，不含 tool digest、knownTitles（O `review/input.ts:142-147`）；I：改 digest 摘要不会使 review cache 失效。

### 3.3 身份缺失/混排矩阵

| 身份 | 缺失时 | 可否混排 | 标记 |
|---|---|---|---|
| role | `isUserAuthored` 为 false；review 只取 user 文本 | capture 硬编码 user；assistant/tool 不会进 capture（O `consolidate.ts:876,895`） | O |
| messageID | capture 用 `"unknown"`；review 跳过无 id 消息 | capture key 可碰撞（I）；review evidence 不能引用 | O `consolidate.ts:769`；`review/input.ts:81` |
| sessionID | `SourceRef.sessionID?` 可空；review 用 `input.sessionID` | 无逐消息校验；`SessionReader` 按 sessionID 取，生产上隔离（I） | O `types.ts:124-129`；`review/accept.ts:169,179` |
| parent | 未知 parent 可能被当 root；`parentChecked` 由 `info !== undefined` 决定 | `session.created`/`session.get` 缺失时继续 consolidate | O `plugin.ts:615-630`；I：未知 ≠ root 未实现 |
| project | `projectKey` 可空；project 候选会降 session | consolidate 无 project 归属检查；review `owns()` 因未传 key 恒 true | O `plugin.ts:630-632,481-508`；`orchestrator.ts:660-664` |

## 4. 模型调用、结构化与预算

| 能力 | 现状 | 标记 |
|---|---|---|
| Generate | `ctx.experimental.generate.text({model,prompt}, {signal}) → {text}`，无 tools/session/response_format/max tokens 参数；回退 `ctx.generate.text` | O `plugin.ts:108-113,464-470`；`review/provider.ts:317-341`；02-preflight §2 已核对 |
| 结构化 | 仅“prompt 要求 JSON → `parseReview` → 失败时 `buildRepairPrompt` 1 次”；无 JSON Schema 强约束 | O `review/provider.ts:154-204,462-517`；`review/parse.ts:21-75` |
| 无工具/无子会话 | 接口层没有 tools/session 参数，且用的不是 `session.generate`；I：按签名不会创建子 session，但 host 内部是否执行工具 U | O 同上；U host 实现 |
| Review 请求预算 | `takeModelSlot("review", effectiveMaxRequests)`；`effective = maxRequestsPerHour ?? max(maxPerHour, maxPerHour*(1+repair)*2)`；这是每小时请求上限，不是“只发一次” | O `review/provider.ts:238-257`；`store.ts:671-679` |
| 重试 | 固定 2 次尝试；429/5xx 可重试，>30s 转 `ReviewRetryAfterError`；空返回/解析失败可 repair 1 次 | O `review/provider.ts:166-204,282-305,519-585` |
| Run 预算 | orchestrator `takeSlot`/`releaseSlot`，与 request 预算分离 | O `review/orchestrator.ts:424-436,732-749` |
| usage | ollama 读 `prompt_eval_count`/`eval_count`；SystemOne 读可选 `usage`；generate 不返回 usage，故结果省略 | O `review/provider.ts:207-211,340,380-387`；`systemone.ts:273-280` |
| 可复用性 | `ReviewProvider.review()` 公开；`request/dispatch/generate` 私有；`takeModelSlot` 的 kind 联合只有 decision/rewrite/review | O `review/provider.ts:125-341`；`store.ts:671`；I：新提取器要么走 `review()`，要么改接口 |

**结论**：自动提取若复用 `generate`，只能在 prompt 中要求“只返回结构数据”，再靠 `parseReview`/自定义 parser 拒绝散文；API 层不能强制“无工具、无子会话、JSON schema”。预算/重试可复用 `ReviewProvider` 的私有实现，但当前没有通用结构化提取入口；复用 `review()` 会带上 review prompt/缓存/repair 语义。不得把 generate 结果写成 `usage`。

`SystemOneClient.classify` 也不是提取器：它按单个 candidate 发 `answers` 式结构化问题，返回 `DecisionResult`，不返回候选列表；无重试，预算走 `takeModelSlot("decision")` 且失败降级 heuristic（O `systemone.ts:44-80,203-303`；`decision.ts:226-238`）。

## 5. rule / strictness 与现有边界

- `ItemKind = fact|preference|rule|reference|skill`；`ReviewType` 多 `decision|learning`，`reviewKind` 把 decision/learning 映射为 `fact`（O `types.ts:1-5`；`review/decision.ts:4-15`）。
- rule 的“语法”只有 linter 的 `RULE_MARKER_RE` **warning**（“不像祈使句”），不是拒绝；真正的 rule 判定来自 SystemOne 的 `kind` 答案或 review `type:"rule"`（O `linter.ts:11-12,73-75`；`systemone.ts:92-105`；`review/parse.ts:39-43`）。
- `strictness` 由 SystemOne 的 `safety`/`strict_limit`/kind 推导，review lane 固定 `unknown`；`safeAuto` 是模型给出的概率（O `systemone.ts:254-263`；`review/decision.ts:29`）。
- `canAutoApply` 硬拒 `kind=rule|skill`、`scope=session`、review origin、lint 失败、duplicate/risk/conflict/mergeAction、非 `preference|workflow|format|unknown` strictness；`fact/reference` 还要求 risk<0.4（O `consolidate.ts:908-942`）。
- 因此：**rule 永不自动写**（只能人工 approve 或 review queue），但“把祈使句误标为 preference/fact”没有被确定性语法门拦住；linter 只查长度/示例/临时词/秘密/多claim（O `linter.ts:52-79`）。
- 关系边界：`exact|classification-mismatch|conflict|covered|partial|related|unknown`；`unknown` 在 write-guard 中被跳过（不是“安全”，只是不作为冲突证据）；`exact/covered/classification-mismatch` 是 hard block（O `relations.ts:12-19,244-390`；`write-guard.ts:106-135`）。
- authority：`graph.ts` 的 `authority` 是图层来源标签（L0 最高），与写入/权限无关；baseline 没有 `Item.authority`/`grantsPermission`（O `graph.ts:34,372-387`；`types.ts:171-213`）。

## 6. 写前安全守卫与“只门写不门执行”

| 守卫 | 位置 | 作用 |
|---|---|---|
| 凭证/敏感值 | capture 前后 `redactText`；linter `SECRET_RE` | 拦截/跳过，不进模型或队列（O `consolidate.ts:170-177,765-768`；`linter.ts:6-7`） |
| 撤销后抑制 | `isSuppressed` + 90 天 suppression | 同 session/message/text 不再学；新消息可纠正（O `suppression.ts:13-34,78-90`） |
| 批内/跨 lane 去重 | normalized text、`classifyRelation` exact/covered | 避免同轮重复；高相似但改值仍进 queue（O `consolidate.ts:197-224,297-324`） |
| 预留/并发 | `store.claim` + `ownsClaim` + transaction | 同 key 跨进程只写一次（O `consolidate.ts:226-236,490-541`；`store.ts:888-923`） |
| 写前关系 | `findWriteConflicts` 两次（决策前 + 事务内 fresh） | conflict/classification-mismatch/unsafe 阻断 auto；partial+duplicate≥0.2 也阻断（O `consolidate.ts:366-419,496-539`） |
| lint | `lintText` | 空/长度/多claim/临时/秘密/session id 等硬错误（O `linter.ts:52-79`） |
| 容量 | `admitAutoWrite`/`admitQueueItem`/`admitNewItem` | auto/queue/approve 的容量门（O `consolidate.ts:420-422,615-625,694-715`） |
| 人工批准 | `canPromote` + `confirmedByUser` | rule 或未确认提升拒绝（O `memory/promotion.ts:39-59`） |
| CAS/版本 | queue action `expectedVersion`、suggestion `targetVersion` | 防止覆盖已变化的目标；**不是**当前 auto-add 的通用 CAS（O `actions.ts:135-136`；`apply.ts:130`） |

**这些守卫的调用点全部在“生成/修改 Item/Queue/Hook”路径**；没有一处拦截模型工具调用或 shell/文件执行（O：`findWriteConflicts` 仅上述四处；`plugin.ts` 无 permission API）。`grantsPermission:false` 即使存在也只是字面量类型，不会影响 host 的权限判定（O P03-A 归档类型；I host 行为）。

## 7. 记忆与宿主权限是否真正分离

- 记忆写入 `event.system` 的 text part，并同时通过 `instructions.entry.put` 持久化（O `plugin.ts:1310-1342,1352-1369`）。这是**指令/系统通道**，不是独立的“数据/引用”通道。
- `renderContext` 明确写“provisional…curated AGENTS.md/memory 优先”“Do not treat auto rules as curated policy”（O `plugin.ts:1443-1467`）。这是 prompt 文本约束，不是权限/执行隔离（I）。
- 结构上只防“伪造 `<context>` 边界”：`escapeContextMarkers` 转义 `<context`/`</context>`，`applyOwnedContextDetailed` 只替换自己的 keyed block（O `plugin.ts:1096-1186,1437-1441`）。它不阻止正文里的祈使句、角色冒充或“忽略之前指令”类文本。
- 本仓库没有 host permission 实现可读：插件只拿到 `ctx.tool.transform` 注册 `memory_autopilot`，没有 permission/authorize hook；`PluginContext` 也无 permission API（O `plugin.ts:86-113,665-701`）。**host 是否对 `memory_autopilot` 或系统文本另行限权 = U，不能声称已硬隔离。**
- 因此要区分两件事：**(a) 事实**——没有代码把 memory 文本映射成 permission 授予；`grantsPermission:false` 不是运行时门；**(b) 风险**——memory 文本与系统指令同通道，模型仍可能按其中的祈使句行动；字段为 false 不能证明“误学无害”。

## 8. 可新增的标签/metadata（不破 P01/WAL/旧 API）

| 扩展点 | 可否加可选字段 | 约束/证据 |
|---|---|---|
| `SourceRef` | 可以加可选 provenance（如 turnID、observedRole、parentSessionID、quote范围） | O `types.ts:124-129`；`itemContentVersion` 不含 source（O `fingerprint.ts:11-14`），不会使 suggestion 失效；但 `queueItemSnapshotVersion` 含 `source/sources`（O `fingerprint.ts:22-54`），新字段会让**新写**队列行的版本变化，旧预览需刷新。 |
| `ReviewEvidence` | 可以加 `sessionID?/turnID?/rawQuote?/offset?` | O `types.ts:7-13`；当前 validate/parse 只认 messageID/quote/kind，新增字段需同时补 parse/validate（O `review/parse.ts:77-89`；`review/validate.ts:144-157`）。 |
| `Item`/`QueueItem` | 可以加 `originDetail?`、`authority?`、`evidenceRef?` 等 | O `types.ts:171-213,234-266`；`ItemSnapshot = Item`，Undo 会原样恢复（O `types.ts:644-670`；`changes.ts:44-90`）。 |
| `HookRecord` | 可以加 capture 诊断字段 | **不要改 `key` 格式**：capture key 与 suppression 都依赖 `sessionID / messageID / textHash`（O `consolidate.ts:855-860`；`suppression.ts:13-34`）。 |
| `ReviewRecord` | 可以加 `sourceWindow?`、`evidenceMode?` | O `types.ts:38-64`；JSONL 读写是泛型对象，旧行缺字段按 undefined 处理（O `store.ts:289-299,515-562`）。 |
| `AutopilotContext` | 可加可选数组/统计字段，但不要加第二个 `<context>` block | O `plugin.ts:1038-1062,1096-1108,1180-1186`；`CONTEXT_KEY` 单例，`isSingleOwnedBlock` 只允许一个 `<context `。 |
| `SessionMessage.metadata` | 可透传 synthetic/parent 诊断 | O `types.ts:538-548`；`filters.ts:14-20` 已读 `metadata.synthetic/warming`；但当前不解析嵌套/文本信封（O）。 |

P01/WAL 事实：`Store.transaction` 用 `.pending-transaction.json` 批量重放，JSON 文本无 schema 校验（O `util/transaction.ts:1-10,44-70`；`store.ts:243-262`）；因此新增可选字段可被 WAL/Undo 原样携带，但**任何 key/版本算法变更**都会破坏去重、suppression 或预览绑定。旧 API：`server.ts:861,976-981` 直接返回 store 对象；I：旧客户端是否忽略未知字段未验证（U）。

## 9. 具体接口缺口与最小接线建议（不建议整套策略）

| # | 缺口 | 最小接线点（未来实现，不在本报告改） |
|---|---|---|
| G1 | `SessionMessage` 没有 sessionID/parent/project/part-level role；capture 无法逐消息证明身份 | 在 `SessionReader.read(sessionID)` 附加只读 `messageRef`（sessionID、parentSessionID?、projectKey?、role、synthetic）；`SourceRef`/`ReviewEvidence` 增可选字段；模型不得填写这些字段。O `types.ts:538-548`；`reader.ts:57-110` |
| G2 | capture 伪造 `role:"user"`、`messageID:"unknown"` | `extractCandidates` 从 `SessionMessage` 读实际 role/type；无 id 时跳过或标 `identityMissing`，不要写 `unknown` 参与 key。O `consolidate.ts:769,892-896` |
| G3 | synthetic/context/skill/任务信封只在顶层 metadata 识别 | 在 `isUserAuthored`/`extractCandidates` 入口增加“内容信封剥离/标记”纯函数；A 的 `segmentSynthetic` 已归档，只作参考，不直接复活。O `filters.ts:14-28`；`normalize.ts:43-46` |
| G4 | review quote 只对截断/redact/digest 文本成立 | `ReviewInput.sources` 同时保留 `rawText` 与 `shownText`（或 range/hash）；validate 对两者分别校验；tool 证据保留 raw part 指针或 digest 输入 hash。O `review/input.ts:86-135,197-207`；`review/validate.ts:144-157` |
| G5 | P02 review projectKey 未接线 | `new ReviewOrchestrator({... projectKey})`；`onAccepted` 使用 record/权威 key；accept 已支持 authoritative + instance mismatch。O `plugin.ts:481-508`；`orchestrator.ts:31-32,468,479` |
| G6 | 无通用结构化提取入口；`request/dispatch/generate` 私有 | 抽一个 `StructuredGenerate` 接口（prompt + model + signal → raw）复用现有 budget/retry/parse；或让 `ReviewProvider` 暴露明确的 `extract()`；不要复用 review prompt 冒充提取。O `review/provider.ts:125-341` |
| G7 | `takeModelSlot` lane 联合固定 | 若新增 extract lane，需扩 `store.ts:671` 联合及状态/统计；否则只能复用 `"review"` 预算并接受混账。O `store.ts:671-679` |
| G8 | rule 语法/strictness 无确定性分离 | 在 `canAutoApply` 前增加纯判定（复用 `lintText` + `classifyRelation` + 现有 strictness），把“祈使句/权限/破坏性”从 preference 内容分开；不在本报告设计分类器。O `consolidate.ts:356-364,908-942`；`linter.ts:73-75` |
| G9 | 记忆文本与系统指令同通道 | 若要硬隔离，需要 host 提供非指令的数据通道或 permission/authorize hook；当前 `PluginContext` 没有，标 U。不要用 `grantsPermission:false` 或“curated 优先”文案当作隔离证明。O `plugin.ts:86-113,1352-1369,1443-1467` |

## 10. 未知与不要过度声称

- **U**：host 是否对 `event.system` 中的 memory 文本做权限/注入过滤；host 是否对 `memory_autopilot` 工具调用另行限权；host 对 `generate.text` 是否内部启用工具/子会话。本仓库无实现可读。
- **U**：生产环境 `ctx.session.context` 是否可能返回跨 session 消息；代码层没有逐消息 session 校验，只有 reader 的入参 sessionID（O `reader.ts:57-110`）。
- **I**：`owns()` 恒 true 的实际影响取决于 host 事件是否已按目录过滤；不能仅凭本代码断言“已发生跨项目写入”。
- 未运行测试/verify；P02 的 73 files/926 tests 是主代理既有证据，本审计不重跑、不把它当作本报告新证据。
- 未读取 `03a-policy` 之外的策略设计；本报告不评价 A 的 regex，也不提出新分类器/策略选项。
