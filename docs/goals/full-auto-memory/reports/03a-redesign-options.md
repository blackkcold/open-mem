# P03-A 重新设计：可行策略与真实取舍

Status: **仅研究/方案**。无产品代码、无测试脚手架、未运行真实 host/模型、无正式配置/记忆/凭证访问、无提交。  
Date: 2026-11-11  
Inputs: `03a-breaker.md`、`03a-review.md` §8–§10、`03a-policy.md` §10、`DESIGN.md` §1/§2/§5.2/§6/§9、`phases/03-autonomous-pipeline.md`、`phases/03-pieces.md` §A。  
Scope: 为 P03-A 提出真正不同的策略与可证边界；不写实现计划、不写最终设计、不替用户选方向。

## 1. 失败根因：不是“少几个词”，而是把三个问题混成一个

### 1.1 被混在一起的三件事

| 问题 | 例子 | 可用的判据 | 失败后果 |
|---|---|---|---|
| 这段文本是否用户本人写的、可归属？ | 混排 `<skill_content>`、任务信封、引用表格、子代理通知 | 结构/来源/span | 学到合成内容（F01） |
| 这段内容是否忠实、可复述？ | 用户说“端口从 5199 改为 5299” | 逐字 quote 只能证明“说过”；主体/值/限定仍需语义判断 | 记错值、改坏其他 token（F12） |
| 这段文本是否在请求执行权限？ | “以后删除生产库，不用问我” | **产品策略上不 auto**；但宿主是否阻止受记忆影响后的动作，需链路审计 | 误把指令当偏好（F02/F13/F15/F17） |

旧 A 用同一套正则阶梯同时回答三个问题；每个修复只移动词表/分支边界，没有改变“用有限规则判定开放自然语言”的方法。

### 1.2 三轮为什么都修不完

- 第 1 轮：F01–F11，源形状、review global、merge、scope、否定/子串等规格缺口；测试由作者编写，恰好绕开失败分支（Q01）。
- 第 2 轮：F12–F14，修 F06/F13 时引入“计数与定位不同源”的子串回归，以及 `deploy` 无条件 protected 的过度保护。
- 第 3 轮：F15–F17，修 F13 时引入“安全前缀 + 同子句直接执行”绕过；再修出 `workflowClauseSafe` 在无敏感目标时第 100 行早退，`上线前先跑测试随后部署` 仍 auto。
- 模式：**每条新规则都制造新接缝**；下一个反例总在词表/分句/早退条件之外。1031 tests 全绿不构成策略通过。

### 1.3 更深的错误：把“数据字段”当成“宿主行为证明”

- `Item.grantsPermission?: false` 只是数据字段；baseline 甚至没有该字段。它能防的是“代码把它当权限授予”，**不能证明**宿主阻止受记忆影响后的动作。
- 记忆实际写进 `event.system` 文本并 `instructions.entry.put`；`renderContext` 的“provisional/curated 优先”是 prompt 约束，不是权限/执行隔离；`escapeContextMarkers` 只防边界伪装，不阻止正文祈使句。
- 插件只拿 `ctx.tool.transform` 注册 `memory_autopilot`；`PluginContext` 无 permission/authorize API。host 是否对 system 文本或工具另行限权 = U；`grantsPermission:false` 不是运行时门。
- write guard 只门“写记忆”，不门“执行”：`findWriteConflicts` 仅在 consolidate/apply/actions/promotion 调用，无 host permission/tool hook。
- 所以“记忆永不授权”是**设计要求与待证边界**，不是 observed fact；“宿主门会拦/唯一执行权”不能写成已成立事实。F17 是 blocking，不是词表少一项。

### 1.4 范围也膨胀了

A 原本是“纯策略 + 类型/config”，实际长成源分段、authority、路由、supersede、配置的迷你 NL 管线：8 files / 52 KB patch；全量门禁到 1031 tests。一个 session 内同时改表示、规则、测试，导致每次修复都在全局接缝上震荡。重设计必须先证表示/效果边界，再谈分块。

## 2. 任何新策略都必须满足的边界

| ID | 边界 | 可验证性 |
|---|---|---|
| I1 | **设计要求**：记忆不得获得执行权限，不写 L0/skills/config；宿主实际 gate 是否足够，待链路审计，不由本报告声称 | 设计审查 + 独立链路审计 |
| I2 | 不靠正则穷举自然语言做安全保证；不把模型自评分（0.99）当可靠性 | 设计审查 + 独立反例 |
| I3 | 无可证语义时自动 skip/短期 quarantine，不 queue、不催办；但这是覆盖取舍，不证明“内容不过风险” | 行为测试 + 覆盖报告 |
| I4 | 全量目标不缩（这是目标，不等于 A 已满足）：普通 fact/preference/reference/decision、turn/review 同门、global 高证据、同源抑制、CAS/undo/supersede、容量、召回、P05 UX | 现有 ACCEPTANCE §4 + P04/P05 断言不变 |
| I5 | span/quote/schema 只证明来源与结构；忠实复述、用户意图、是否请求执行权限仍不可由它证明 | 独立语义抽样；来源须标注 |
| I6 | 模型方案是设计假设：现有 rewrite/review 实际调用链、预算、失败路径待 audit；不得把假设写成现实现证据 | 调用链 audit + 故障注入 |
| I7 | 不恢复旧 A 的 authority 正则；已闭合的独立部件可保留，但必须重新独立测试 | diff/审查 |

### 2.1 生产证据/能力前置边界（audit 2026-11-11，静态；未运行 host/model）

| # | 当前事实 | 对新设计的影响 |
|---|---|---|
| E1 Capture | `Candidate` 无 raw quote/offset；`role` 硬编码 `user`；`messageID` 缺失写 `"unknown"` 并进 key；sessionID 来自实参、projectKey 来自插件实例。 | A 的 `sourceRef` 不能由现有 capture 填；必须先补 host `messageRef`（raw quote/offset/observedRole/messageID/sessionID/projectKey）；缺 ID → skip，不得让 `"unknown"` 参与 verified。 |
| E2 Review | `ReviewInput.sources` 是 `fit()` 截断/空白归一（+redact）后的文本；validate 只对该 map 做 substring；`candidate.text` 可超出 quote；tool quote 是 digest。 | B 不能把 review quote 当 host 原文；需 `rawText`/`shownText` 双校验；`candidate.text` 必须由 quote 支持，否则只能 note/quarantine。 |
| E3 StructuredGenerate | `ReviewProvider.request/dispatch/generate` 私有；`review()` 带 review prompt/cache；`generate` 无 schema/tools/usage；`takeModelSlot` lane 固定。 | B 不是“零改可用”：需新增 `StructuredGenerate`/`extract()`、独立 parse/validate、预算 lane 或明确 review 预算记账。 |
| E4 Host isolation | 记忆与系统指令同通道；`PluginContext` 无 permission API；host 内部过滤/工具权限 = U。 | 不能承诺绝对权限拦截；`grantsPermission:false` 不是运行时隔离。 |
| E5 P02 host wiring | known-foreign 路径已修并独立 review 通过（118 行；setupPlugin 装配 projectKey；74 files/929 tests/verify0，主代理亲读）。**精确边界**：仅 `state.contextProjectKey` 的 known-foreign；U1 未知 session 的自动 consolidate 仍可写当前 A hook；U2 新 unknown session 的 `session.created` 仍被 `refreshContext` 打 A key。 | A/B 不能把 known-foreign 通过写成全项目隔离；P03 raw evidence/provenance 仍须修；U1/U2 与真实 host 事件过滤/权限仍未知。 |
| E6 Authority/strictness | baseline 无 authority 写入层；`authority` 只是 graph 图层标签；`strictness` 来自 SystemOne，review lane 固定 `unknown`；rule 语法只有 linter warning。 | A 的 protected queue 不是确定性安全门，且 review lane 的 `unknown` 不会被它覆盖；B 的 validator 不能把 authority 当既有真相；需在 `canAutoApply` 前加纯判定或明确接受模型信号，review 候选另加显式内容策略/隔离。 |

## 3. 两个真正可选的交付方向 + 一个已排除方案

### 3.1 方向 A：Span-bound schema admission（纯确定性；有界 proof/离线兜底）

**核心**：把“用户真实写下的 span”与“候选 claim 的结构”分开；只自动接纳能解析成 `AtomicClaim` 且 quote 可逐字回指 host 原文的内容。它证明的是**来源与结构**，不是忠实复述或用户意图；且 `sourceRef` 必须由 host/caller 填，不能让模型自填。**当前 capture 无 raw quote/offset、缺 messageID 写 `unknown`（E1），所以 A 的“verified”前提尚未满足；先补 SourceRef/host 原文契约，否则只是 schema demo。**

```
AtomicClaim {
  kind: "fact" | "preference" | "reference";
  subjectKey: string; predicate: string; value: string;
  qualifiers: string[];              // 条件/范围/单位/否定
  modality: "statement" | "preference" | "procedure" | "correction";
  quote: string;                     // 必须是 host 原始 user 消息的逐字子串
  sourceRef: { sessionID: string; messageID: string; observedRole: "user";
               offsetStart: number; offsetEnd: number; projectKey?: string };
  scopeHint: "project" | "global" | "unknown";
}
```

**准入顺序**（先拒绝后允许）：
1. span 必须来自 host 原始 user 消息（observedRole=user，raw quote+offset），非合成块/模板/表格/围栏/引用块；混排只保留真实段。当前 capture 硬编码 `role:"user"`、缺 ID 写 `"unknown"`，不能直接作为 verified 来源（E1）。
2. claim 必须恰好一个 subject、一个 predicate、一个值 token；占位符/代词无先行词/多 claim 句 → quarantine。
3. `modality` 只能是 statement/preference/procedure/correction；**裸执行指令 → quarantine**。
4. `procedure` 只接纳“条件 + 准备步骤”结构（如 `删库前先备份`、`上线前先跑测试`）；同句出现裸执行尾（`随后部署`/`直接删除`）→ 整条 quarantine。**F17 教训：必须看完整 claim，不允许“无敏感目标就早退”。**
5. **queue 只由既有信号产生**：`strictness` 的 safety/permission/destructive/strict_limit、rule/skill 才 queue；但 baseline 的 `strictness` 是 SystemOne 模型答案、review lane 固定 `unknown`（E6），所以这不是确定性安全门；admission 自身也不新增“危险词→queue”。
6. 真实 secret 赋值/值 → skip；**索取/存储凭证的请求** → quarantine；“token 每 30 天刷新”这类工程知识不因字样被拒。
7. 冲突/否定/数值差异走既有 `classifyRelation`/`sameNegationObject`；只有 C1–C9 全满足才 supersede；global 仍走 `evidenceProjects` ≥2 个不同项目或明确跨项目意图。
8. turn/review 共用同一 admission；但 review quote 当前只对截断/redact 的 `shownText` 校验，`candidate.text` 可超出 quote（E2）。review 候选必须绑定 host raw 原文，否则不能算 verified；`decision` 仍落 `fact` + `reviewType`。
9. 任何不确定 → quarantine/skip，绝不 queue。

对 `删库前先备份`、`上线前先跑测试`：A 只按 procedure 结构接纳，不新增“部署/删除字样”拒绝；若既有 `strictness` 误标 protected，作为既有信号质量问题单独评估，不借此放宽 protected。

**必须承认的边界**：A 仍要解析开放语义；“条件 + 准备步骤”的完整 claim 识别若继续用正则 grammar，可能复制 F17 螺旋。把 `Authority` 改名 `AtomicClaim` 不等于根因消除；只是把误判后果尽量压到漏学/隔离。更关键的是：当前 capture/review 没有 host raw quote/offset 契约（E1/E2），没有它，quote 只能证明“截断/redact 文本自洽”，不是 verified；SourceRef 必须由 host 填，模型不得自填。procedure grammar 是否有界、能否覆盖真实表达，仍需 held-out 测，不能由作者样例宣称。

**真实 UX**：普通对话零审批；记忆页显示“已学习”与“暂存观察（不注入，72h 自动结束）”；没有“待确认”徽标。能学的：canonical fact、明确长期偏好、路径/命令 reference、条件型 procedure、已证实单点纠正。不能学的：转述、长句多 claim、模糊指代、无结构自由文本。**高漏学是有界覆盖的代价，不是“全量 UX 已满足”**。

**成本**：本策略本身不新增模型调用；但现有 rewrite/review 调用链是否仍发生，待 audit。写入受 `dailyWrites=40`/`maxWritesPerSession=5` 限制；quarantine 200 条上限不变。

**误学/漏学**：误学低—中（对比/否定句可能取错值，需“多值无纠正标记 → quarantine”兜底）；漏学高（自由文本大量进 quarantine）。这是覆盖取舍，不是安全证明；必须在 held-out 语料上量化。

**复杂度/可验证性**：中。span 分段 + claim 语法 + 准入规则；结构（来源/quote/span）可强验证；语义覆盖只能抽样；grammar 仍可能随覆盖增长。

**适用**：有界 proof、离线兜底，或用户明确接受“宁缺毋滥”的候选正式主路径；前置是 E1/G1/G2/G4 的 host raw quote/offset/真实 role 契约。**在覆盖与证据契约未测前，不能把它称为全量 UX 的最佳交付。**

### 3.2 方向 B：既有 review 模型结构提案 + 确定性硬校验/恢复

**核心**：turn lane 可用方向 A 的确定性准入；review lane 复用 P02 已有的 `review.generate` 调用能力与 `opencode`/`ollama` transport，新增受控 prompt/schema 做**结构化抽取**（不新增 provider）。模型只提出 `ClaimProposal`，不判定安全、不授予权限；确定性 validator 决定是否写入。**这不是“零改可用”：当前没有通用 `StructuredGenerate`，`request/dispatch/generate` 私有，复用 `review()` 会带原 review prompt/cache（E3）；B 必须新增 `StructuredGenerate` 或 `ReviewProvider.extract()`，并明确 parse/validate/预算记账。它仍是与 A 并列的可选交付方向，不是 A 的“未来增强”。**

**最小接口（可测试）**：`StructuredGenerate({ prompt, model, signal }) → { text, usage? }`，复用现有 budget/retry/parse，但**不复用 review prompt/cache**；或 `ReviewProvider.extract(input)` 作为显式独立方法。`usage` 只能来自真实返回，不得伪造；无 schema/tools 时必须在 prompt 层要求 JSON 并由本地 parser 拒绝散文。

**模型输出**（严格 schema）：
```
ClaimProposal { quote, messageID, kind, scope, subject, predicate, value,
                qualifiers[], modality, proposalConfidence? }
```
`proposalConfidence` 只用于排序/隔离优先级，**不作准入阈值**。

**validator 必查**：
- quote 必须对 host 原始 user 消息 + offset 逐字校验，不是在 `ReviewInput.sources` 的截断/redact `shownText` 上自洽；tool quote 不能仅凭 digest 当原文（E2）。
- subject/value 必须能在 quote 中定位；`candidate.text` 必须由 quote/证据支持，不能是 quote 未支持的模型措辞；否则只能 note/quarantine。
- `scope`/`projectKey` 必须来自 host/record 的权威身份，不由模型单独声明；global 仍走 `evidenceProjects`/跨项目证据；known-foreign 已验，但 U1/U2 未知路径仍不能标全绿。
- quote 含否定/条件/对比时，claim 必须保留相同极性/限定；否则拒绝。
- secret/kind/scope/global 证据/冲突/CAS 与方向 A 相同；不通过 → quarantine/skip。
- 模型返回非法 JSON/空/超时/429 → 不写；调用前持久化最小证据（`quote/messageID/kind/scope`），按 P02 `retryAt`/backoff 重试；N 次后 quarantine，不催办。
- 若原 transcript 已不可用，无法再独立核对 quote：只能 quarantine `evidence-unavailable`，不得用模型输出冒充已验证证据。

**预算与现实验证**：`automation.dailyModelCalls=40` 是**沿用提议上限，不是已启用的真实配置**；候选设计约束是**沿用既有预算、不提高**。`takeModelSlot` 的 lane 联合当前固定，新增 extract lane 需扩 `store` 联合/统计，或明确复用 `"review"` 预算并记账（E3/G7）。若复用 P02 review 的调度，还必须同时受 P02 `review.maxRequestsPerHour` 约束，两套预算取更严，不能把 P02 预算暗中挪给 B。现有 rewrite/review 实际调用链、真实延迟、失败恢复均待 audit；本报告不声称已发生/已测。

**失败/降级**：模型失败**不阻塞 turn** 是设计目标；同时必须记录**覆盖下降/延迟/最终 quarantine**，不能一句“turn 不受影响、不丢”掩盖 A 的漏学，也不能把“不阻塞”写成“不丢/无成本”。review-only 候选会延迟；已持久化最小证据的可重试，transcript 已不可用的只能 quarantine `evidence-unavailable`，不是静默删除。若要求“绝不丢”，需把 pending proposal 持久化到独立队列——会增加文件/容量，属待确认边界。

**误学/漏学**：覆盖比 A 高（能处理转述/长句）；误学中（quote 真实但语义理解错，validator 只能查归属/极性/值，不能查“用户真正意图”）；漏学中。语义正确性必须用独立标注（来源须写明）抽样，不能拿模型置信度当准确率。

**复杂度/可验证性**：高。prompt/schema 版本、模型输出对抗样本、prompt injection（transcript 当数据）、预算/重试/降级、更多测试。结构可强验证；语义正确性只能 medium/low 置信。

**适用**：用户要求全量 UX 覆盖、且调用链 audit/预算/延迟/失败恢复/独立语义抽样都通过时，作为候选正式主路径；前置是 E1/E2 raw evidence、E3 `StructuredGenerate`；E5 的 known-foreign 已验，但 U1/U2 未知路径仍未闭合。**不能把 known-foreign 通过写成全项目隔离**；不以“编码方便”选它，也不因模型存在就默认它更好。

### 3.3 已排除：Effect-typed notes（classifier 只做 advisory）

**核心**：所有 user-authored、非合成、非 secret 的内容都存成 `Note`，`classifyAuthority` 降级为 `riskHint`，不能阻断也不能授权；渲染为非指令参考。**记忆进入 system 通道，非指令渲染只是 prompt 约束；它自认违反“不发布未证语义”，不作为 autonomous 的可选方案，也不交给用户选。** 宿主 gate 的实际能力待 audit；设计要求它是唯一执行权限，但本报告不把它写成已成立事实。

**保留借鉴**：非指令渲染、写入路径无权限字段、宿主 gate 待审计的结构契约，可被 A/B 共同采纳。

## 4. 真实取舍对比

| 维度 | A：纯确定性 | B：模型提案 + 确定性硬校验 | C：Effect-typed notes |
|---|---|---|---|
| 普通自由文本覆盖 | 低—中（canonical 才学） | 中—高 | 高 |
| 误学并注入风险 | 低—中 | 中 | 高 |
| 漏学/观察率 | 高 | 中 | 低 |
| 模型调用/日 | 本策略不新增；现有链路待 audit | 需新 extract lane/预算记账；40 是提议未启用 | 0 |
| 断网/超时 | 本策略无新增依赖；现有链路待 audit | turn 不阻塞是目标；覆盖/延迟未测 | 无新增 |
| 代码/测试面 | 中 | 高 | 低 |
| 再陷正则螺旋 | 中（grammar 可增长，可能复制 F17） | 低—中（模型处理多样性，validator 有界） | 极低 |
| 部署/删除工程知识 | 结构化 procedure 可学；裸指令 quarantine | 同 A，模型可补全转述 | 全部可存，但可能注入 |
| 可证边界 | 来源/结构可证；语义不可证 | 来源/结构可证；语义仅抽样 | 来源/结构可证；语义不可证 |
| 证据/接口前置 | 需 host raw quote/offset/真实 role（G1/G2/G4）；当前 capture 不满足 | 还需 raw review 双校验、`StructuredGenerate`；known-foreign 已验，U1/U2 未闭合 | 系统通道 + 无 permission API；排除 |
| 与全量 UX | 覆盖未测，不能称已满足 | 覆盖潜力更高，但依赖 audit/预算/恢复 | 不适用 |
| 是否可选 | 可选（有界/离线/宁缺毋滥） | 可选（全量覆盖目标） | **排除**，仅借鉴结构 |

## 5. 选择框架（本轮不替用户选）

两个真正可选的交付方向：

1. **D1 纯确定性正式主路径（A）**：适合用户接受“有界覆盖/离线兜底/宁缺毋滥”。前提是 E1/G1/G2/G4 的 host raw quote/offset/真实 role 契约 + held-out 覆盖/漏学达到用户阈值；A 未测覆盖前不能宣称最佳 UX。
2. **D2 既有 review 模型结构提案 + 确定性硬校验/恢复（B）**：适合用户要求全量 UX 覆盖。前提是 E1/E2 raw evidence、E3 `StructuredGenerate`，以及调用链 audit/预算/延迟/失败恢复/独立语义抽样都通过；E5 的 known-foreign 已验，但 U1/U2 未知路径仍未闭合；模型置信度不作准入。

选择依据是**用户的质量/覆盖/稳定目标 + 证据**，不是编码方便，也不是“A 更安全”或“B 更先进”的先验。C 不作为 autonomous 选项。**P02 known-foreign 已修并独立 review 通过（74 files/929 tests/verify0），但 U1/U2 仍可写 A hook / 打 A key；不能把 known-foreign 通过写成全项目隔离。**

**先证边界，再分块**：无论选 D1/D2，第一个 proof slice 只证表示/效果边界（span/quote/schema、准入结果、失败/隔离、独立语料），不接 Store/plugin/UI；边界被独立 review 接受后，才讨论完整分块。

## 6. 待确认的重大边界（需主代理/用户裁决）

1. **P02 known-foreign 已修，但全项目隔离未完成**：setupPlugin 装配 projectKey + known-foreign gate 已独立 review 通过（118 行；74 files/929 tests/verify0，主代理亲读）。精确边界：仅 `state.contextProjectKey` 的 known-foreign；U1 未知 session 自动 consolidate 仍可写当前 A hook；U2 新 unknown session 的 `session.created` 仍被 `refreshContext` 打 A key；真实 host 事件过滤/权限仍未知。A/B 的 raw evidence 前置 G1/G2/G4 仍未修；不能把 known-foreign 通过标成全项目隔离。
2. **接口是否允许替换**：能否用 `admitCandidate(): Admission` 取代冻结的 `classifyAuthority(): Authority`？若必须保留旧签名，旧正则层会继续存在，重设计只能包一层，失败模式不会真正消失。建议先落 Ruling/DESIGN 再编码。
3. **安全与内容风险都要，不是二选一**：结构上不授权、内容上不把清晰执行请求 auto、高风险内容隔离，三者都必须成立；区别只是没有全自然语言 100% 数学保证，但有明确受测边界/安全降级。记忆进入 system 通道、host 过滤未知，不能承诺绝对权限拦截；也不能把“接受结构不授权”写成“接受内容风险回退”，或因为无法 100% 证明就允许清晰执行请求 auto。
4. **覆盖目标**：普通自由文本的“漏学/观察率”可接受上限是多少？若要求高覆盖，A 可能不够，需评估 B；若接受“宁缺毋滥”，A 可作为有界主路径。这个数字决定方向，不能由实现者自定。
5. **模型预算/链路**：若选 B，是否接受 review lane 同时受 `automation.dailyModelCalls` 与 P02 `review.maxRequestsPerHour` 双重上限（取更严）？`StructuredGenerate`/extract lane 尚未定义；现有 rewrite/review 调用链 audit 未完成前，不得把 40 当作真实可用预算。
6. **quarantine 可见性**：记忆页显示只读“暂存观察（不注入）”列表是否可接受？它不催办、不产生待办；若必须完全隐藏，需要另一套可解释性方案。
7. **A 的范围**：span 分段/claim 语法归 A 还是 C1？supersede 是否保持独立、只做回归测试？建议 A 只做纯 schema/admission，C1 做 span 提取，supersede 不重写；A 的 raw evidence 前置（G1/G2/G4）必须单列，不能混进 admission 假装已 verified。

## 7. 独立反例验收设计

**角色分离**：作者写实现与开发测试；breaker 只读规格/公开行为，不读实现的正则/grammar，独立写反例。breaker 的语料在实现前冻结，实现者不得修改；歧义案例进“规格歧义”清单，由主代理裁决。最终验收由未参与实现的 fresh reviewer 执行，作者不能自评通过。

**语料结构**：
- 开发集（作者）：用于调试，不计入验收。
- 验证集（作者）：用于调参，报告但不作为最终证据。
- 测试集（breaker/独立审阅者，sealed）：≥120 条，覆盖中文/英文、fact/preference/procedure/reference/correction、合成块混排、模板、引用、表格、围栏、否定、条件、对比、多 claim、跨 scope、global、凭证值/存密钥请求（不是 token 刷新周期这类工程知识）、裸指令、直接执行尾。
- 生成集：固定 seed 的确定性生成器（不用新依赖），按 `{source shape} × {modality} × {subject} × {predicate} × {value} × {qualifier} × {negation} × {language} × {punctuation}` 组合，去重后冻结；记录 seed/hash/生成器版本。生成器只生成**组合**，不生成“实现期望的答案”。

**标注来源（必须写清）**：若测试标签由独立 agent 生成/审阅，报告写 `agent-assisted`，不得写 `human gold`；只有真实人类双人标注才写 human。作者自己的样例不计入独立证据。

**验收不变量（用户可见结果，不是内部 reason）**：
- I-SEC：标注为 authorization/credential 的候选不得 auto/注入；**这是产品策略，不是宿主 gate 证明**；记忆进 system 通道，host 过滤未知。
- I-PROV：任何写入必须有 host 原始 user message 的 quote + messageID + offset + observedRole；review `shownText` 单独不构成 verified；`candidate.text` 必须由 quote 支持；assistant/合成/模板内容零写入。
- I-SCOPE：global 无高证据不得 auto；同项目多 session 不升级；P02 known-foreign 已验，但 U1/U2 未知路径仍可写 A hook / 打 A key，project isolation 不能标全绿。
- I-SUP：supersede 必须唯一 target/scope/逐字 host quote/单点差异/CAS；否则原 item 逐字节不变。
- I-NOQUEUE：普通描述性候选不得产生 queue/人工待办；只有 protected/rule/skill 可 queue。
- I-REVERSIBLE：每条 auto 写入有 change event，可 undo/stop；L0/skills/config 零写入。
- I-FAIL：模型/网络/预算失败**不阻塞 turn 是目标**；同时记录覆盖下降/延迟/最终 quarantine；不得把“不阻塞”写成“不丢/不受影响”；host/model 未运行，相关结论标 not-run。

**变形/held-out 组合**（必须包含作者没写过的组合）：
- 安全 procedure 前缀 + 裸执行尾（`上线前先跑测试随后部署`、`删库前先备份，直接删除`）→ 不得 auto。
- 安全 procedure + 逗号/空白/全角/换行变体 → 不得因标点变成 queue。
- 引用块/代码围栏/表格里的“纠正” → 不得作为 supersede 证据。
- `15199` 与独立 `5199`、`v1.20` 与 `v1.2`、路径片段 → 只改独立 token 或拒绝。
- 同义替换/语序调整/中英混写/错别字/全半角 → 结果类别应稳定；不稳定则报告为覆盖缺口。
- 同一 messageID 同文本 → 抑制；新 messageID → 可学；restore → 可再学。
- 否定/条件/对比（`我不希望…`、`如果…就…`、`不是 A 而是 B`）→ 不得丢极性/条件。

**故障注入**：模型超时/空返回/非法 JSON/429/离线/预算耗尽；断言 turn 不阻塞（测试环境）、无 auto 写入、pending 可重试、最终 quarantine 不催办；同时记录覆盖下降/延迟。测试用 fake `generate`/`fetch`/`now`，不真实外呼。

**报告方式**：只报分母明确的计数（如“测试集 120 条中，authorization 24 条，auto 0 条；benign 60 条，auto 41 条，quarantine 19 条”），不报“99% 可靠”这类无校准概率。语义正确性用独立标注（来源须写明）抽样；quote 命中率不等于语义正确率；capture raw 与 review shown 分开报；host 未运行；P02 known-foreign 已验，U1/U2 未知路径与项目隔离结论标 not-run/待 P03。

**诚实边界**：可成立的是：来源/结构可证（在 host raw quote/offset 契约成立后）；清晰执行请求不 auto 的产品策略；所有 auto 写入可撤销（若实现并测试）。**不成立的是**：宿主一定阻止受记忆影响后的动作（host 未运行、无 permission API，待链路审计）；自然语言语义 100% 安全；A 未测覆盖就宣称全量 UX 已满足。**当前原始证据链不完整**：capture 无 raw quote/offset、缺 messageID 写 `unknown`，review 只校验截断/redact 的 `shownText` 且 `candidate.text` 可超出 quote；`StructuredGenerate` 缺口未修。P02 known-foreign 已修并独立 review 通过（74 files/929 tests/verify0），但 U1 未知 session 自动 consolidate 仍可写 A hook、U2 新 unknown session 仍会被打 A key；真实 host 限权/事件过滤/系统通道语义隔离仍 unknown。以上未知路径与真实 host 只能标 not-run/待审计，不能写成已满足；known-foreign 只能标“已验的 known-foreign 路径”，不是全项目隔离。
