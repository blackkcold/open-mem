# P03 — autonomous pipeline

Status: **P03-A archived after review FAIL; P03 provenance is PASS; extract/create + C2 lifecycle remain partial; lifecycle corrections typecheck, behavior unverified; P03-D four wiring corrections typecheck exit 0 but behavior remains unverified; full-chain acceptance remains incomplete**. Split see `phases/03-pieces.md`; A–E serial.
Depends: P01（change/undo/抑制）, P02（预算/跨项目/typed errors）
Blocks: P06
Split: `phases/03-pieces.md`（A 纯策略 → B Store → C1 采集 → C2 更新/隔离 → D 维护/API → E followups/整链）
Handoff: `reports/03-attempt-01.md`（attempt 01 未交付与回滚证据）
Global constraints: 见 `PLAN.md` §2
Baseline: `b992a2e`（803 tests / 63 files）

## P03-C2 生命周期工程决议（2026-11-13，编码前）
1. 执行以 `PLAN.md` §2.2 为准；保留既有 native-owner fail-closed，不等待 hybrid v4 旧 host gate 才编码。
2. Capture（模型前）冻结同 project/scope 的关系目标、完整 Item 快照、`itemContentVersion`、记录 hash、source epoch；模型 target/scope/subject/confidence 不授权。
3. 本地完整 seed 解析决定关系；模型字段只核对可见词法表面，canonical claim/relation key 仍由本地生成；additive 合并保留双方完整句，不 supersede；replacement 仅旧/新值唯一 token、极性/限定可核验且唯一目标时更新。
4. 不确定关系写 72h 有界隔离，不进普通审批队列；正文保留完整限定，超过 200 字不截断。
5. `EvidenceRef` 保持兼容；claim/repo/link 元数据不进 `itemContentVersion`，不另存 transcript 或跨项目 rawQuote。
6. `deactivate`/`revert` 在 P01 同一事务登记 message-level retirement；显式 restore 只移除该 item 条目；索引无 TTL。
7. retired 上限 2000 条/200KB；满时写持久全局学习屏障，不驱逐 tombstone；不以任意 active item 解除旧来源屏障，显式原项恢复仍走 P01 路径，stop/undo 仍提交。
8. global 候选最多 200 条/200KB/90d，只存 claim/ref/hash/repoIdentity/originProjectKey；身份不可证则不计数。
9. 显式 global quote 可直写；隐式升级需同 claim 两个不同可信 git common-dir repoIdentity，且无项目相对限定。
10. Promotion 按单个 claimKey 计两 repo，只提升完整本地 claim 投影；混合 item 仅剥离已提升片段并保留其他 project 事实，空残余才归档；保留 linkGroup 与单一注入语义，global stop/undo 不自动恢复 project item。
11. 仅带 `implicitGlobalClaimKey` 的生命周期隐式 global 受 2-repo invalidation；legacy/manual/显式 global 不因缺元数据失效。retired/TTL 后再有两 repo 只能新 admission，不自动复活。
12. 生命周期 TTL 接入现有启动维护及 create/user-change 路径；status 消费字段留紧接下一个 maintenance/mode/status 单元。

## P03-C2 接线修正与验证（2026-11-13）

- `proposalMatchesLocalParse` 比较可见 subject/predicate/value surface tuple；完整 quote 门不变，内部 relation 仍来自本地 parser。
- `isSourceRetired` 不再把同消息任意 active item 当作 barrier restore；明确恢复原 item 仍走 P01 事务，容量屏障只阻止旧来源自动重学。
- `promoteGlobalCandidate` 逐 claimKey 汇总可信 repo；global body 只取已准入完整投影，混合 project item 留下未提升片段。`invalidateUnsupportedGlobals` 只检查带本地 implicit 管理标记的单 claim global。
- before-relative patch 含重建的 `extract/evidence.ts`；其 before 来自已接受的 P03-boundary 快照+hunk，和当前文件的唯一差异是 `observedAt` 声明/采集。修正后 `npm run typecheck` exit 0；patch 正反向 dry-run 均通过。行为测试、full verify、真实 host/model 未运行。

## P03-U1b 普通复盘桥工程决议（2026-11-16，编码前）
1. 普通 review 候选仍由 extract 从完整用户原文独立提案并走本地正类准入；auto+enabled 的 onAccepted 不再把普通候选记成 skipped，也不再只接收 protected rule/skill。
2. learning 只消费 review 实际看过的 native `ok=false` tool part；模型只选择种子，本地固定为 project `fact` + `reviewType:"learning"`，不从 candidate.kind/confidence 赋权。
3. 写前用 reader 原始 part 重算 digest/raw hash，并核对 messageID/partIndex/callID/失败状态；不匹配即 skip + changelog，不复制工具 args、完整输出或 transcript。
4. 证据 span 扩为 role/observedRole 安全 union；extract cache key 与 window materialHash 覆盖 role/tool/part/call/digest/raw hash，不得借 user cache 洗成 tool 授权。
5. 学习写入沿用单一 P01 writer、freeze target/source epoch、retirement/suppression/CAS；learning create-only，不升级 user preference/global；停用/撤销按 message-level 来源生效。
6. shadow 只写 would-write 审计，off 不调用；manual 与 protected rule/skill hook 路径保留；ReviewRecord 增可选 learned/updated/shadowed/learningSkipped/protectedCandidates。
7. 不新增 model lane/provider/预算；仅做必要 typecheck，行为与真实 host/model/dataDir 未验证。

### P03-U1b fix1 工程决议（2026-11-16，源码验收后）
1. 失败工具只接纳 native assistant/tool 消息；user/system/synthetic 伪 tool part 不采集。`role:"tool"` 仅为本地证据类别，`observedRole` 保留实际消息 role，并在 provider/cache/ref/写前复核全链一致。
2. 学习正文改为 `projectToolFailure` 的完整有界失败投影：优先 state.error.message/type/response.body，其次 state.content/output；先 secret-only 脱敏再裁剪，命令与完整 args 不进入正文；无完整诊断句则 skip 并记录原因。
3. `rawHash` 覆盖脱敏后的完整相关诊断；legacy review digest 仍有界展示；`offsetSpace:"tool-projection"` 明确投影坐标而非 canonical message offset。
4. 写前复核共享同一投影/摘要 helper，重验 native role、partIndex、callID、失败状态与 digest/raw hash；任一不符不写。

## 目标

普通描述性记忆零日常审批：后台采集、复盘、去重、**按证据更新**、维护直接生效；不确定内容短期隔离后自然结束；不产生新的人工待办。

同时成立的四件事，缺一不可：

1. **真自动**：fact / preference / reference（含 review 的 `decision`、`learning`）自动采集并写入，不因来源是 review 而硬排队。
2. **真更新**：同主体新证据可更新正文（`touch` / `update`），不是 append-only；但数值、标识符、否定冲突一律不覆盖。
3. **真维护**：隔离 TTL、容量回收、curator 都有真实运行接线，到期结束、退避后恢复，不是“写不动了就永久停写还叫全自动”。
4. **真边界**：benign 工作偏好可学成描述性 `preference`（`grantsPermission=false`）；执行授权、凭证、部署、安全硬限制不从记忆获得，L0 不改。

## 非目标

- 不自动写 L0、不自动装 skill、不改配置；不把 rule 语法自动升成 L0。
- 不自动处理 safety / permission / destructive / strict_limit。
- 不把任务模板、子会话、合成块、引用表格、代码示例当用户长期偏好。
- 不做向量召回（P04）、不做 UX 实现（P05）、不做迁移（P06）。
- 不删除旧 queue/hook 历史；不批量清理。
- 不把 `automation.enabled` 默认设为 true。
- 不靠“把 safeAuto 阈值提到 0.96”声称可靠；模型自评分不是校准概率。
- 不新增服务、数据库、调度依赖；复用 Store/事务/文件锁/WAL。

## 一、生产接线（先钉死“跑在哪里”）

| # | 触发点（真实入口） | 调用 | 生效内容 | 验证 |
|---|---|---|---|---|
| W1 | `plugin.ts` `session.execution.*` 回合结束 → `consolidate()` | `runConsolidation` → `decideAutomation` | 采集→分类→路由→事务写入→`recordChange`→视图重建 | `plugin-automation.test.ts` 事件流 |
| W2 | 同上，`captureHooks` | `session/filters.ts` + `memory/sources.ts` | 合成块/任务模板/子代理通知在**入 hook 前**剥离，不落库 | `automation-sources.test.ts` |
| W3 | 同上，路由前 | `isSuppressed`（P01）+ `sourceIdentityKey` | 撤销/停用后同源同引用不再学 | `automation.test.ts` 抑制组 |
| W4 | `plugin.ts` 启动（已有 `runCurator`）| `runMaintenanceTick` | 隔离到期清理 + 容量回收 + curator（24h 内部 gate） | `maintenance.test.ts`、`quarantine.test.ts` |
| W5 | `plugin.ts` 常驻 timer（默认 15min，`unref()`）| `runMaintenanceTick`（`claim("maintenance:tick")`）| 长会话内也能到期/回收，不只靠重启 | `plugin-automation.test.ts` dispose 后无残留 |
| W6 | 回合结束、自动写入前 | `takeAutomationSlot` | 日写/日调用/会话写预算**跨实例**原子计数 | `consolidate-automation.test.ts` 双 Store |
| W7 | 容量拒绝（≥85% compact / ≥95% freeze）| `runMaintenanceTick({reason:"capacity"})` + `automationBackoffUntil` | 回收冷数据→复检→恢复自动写；仍不足则退避，不永久停 | `maintenance.test.ts` |
| W8 | review `onAccepted`（P02）| 现有 accept → hook → W1 | reviewLane 描述性候选走自动；rule/skill 仍人工 | `review-integration.test.ts` 新用例 |
| W9 | `GET /api/automation`、`GET /api/status` | 只读 | 预算/隔离/容量/退避 + `enabled/configuredMode/effectiveMode/blockedReason/retryAt/lastSuccess` | `api-automation.test.ts` |
| W9b | `POST /api/automation/mode`（`{mode, expectedConfigRevision}`）| 单事务原子设 `automation.enabled` + `shadow` | 一个控件切换 legacy/observe/autonomous | `config-automation.test.ts` |
| W10 | `PATCH /api/config` | `applyConfigPatch` 白名单 + `mergeConfig` 深合并 | 开关/阈值即时生效，legacy 不会误启用 | `config-automation.test.ts` |
| W11 | `ctx.tool` = `memory_autopilot` | 只读 status | 不新增 agent 写入/撤销入口 | 现有 tool 测试 + 新增断言 |

维护不在 `context` hook、不在读 API 里做写操作：TTL/回收是后台动作，读接口只读。

## 二、源类别矩阵（采集层 = 唯一入口）

过滤原则：**剥合成片段、看 scope/意图/证据，不做“关键词一票否决”，不按长短一律丢弃。**
`assumed` 说明：W2 的两种合成文本形状来自任务书，未在仓库内观测到常量；实现用结构性匹配（标签/信封），不绑定唯一字符串。

| 源类别 | fixture 形状 | 处理 | 期望 |
|---|---|---|---|
| 真实用户陈述 | `这个项目用 pnpm` | 正常 | 可 auto（project fact） |
| 真实偏好 | `以后提交前先跑 tsc` | 转 `preference`，`grantsPermission=false` | 可 auto，不含执行权 |
| 用户消息混入 skill 块 | `<skill_content>…</skill_content>\n以后提交前先跑 tsc` | 只剥离 `<skill_content>…</skill_content>`，保留后半句 | 学后半句，不学 skill 正文 |
| `<context>` 注入块 | `<context>…</context>` | 整段剥离 | 不产生候选 |
| 任务书信封 | 含 `TASK:` + `MUST DO` + `MUST NOT DO` + `CONTEXT:` 的整条消息 | `task_template` | skip，不落 hook |
| 单独 `MUST NOT DO` 行 | 无信封、普通行 | 视为普通文本，按 intent 判定 | 不因标题词直接丢弃 |
| 验收表格 | 连续 `\|` 行 + 分隔行 | `quoted_table` | skip |
| 引用块 | `> …` | 剥离引用行 | 块外真实内容仍可学 |
| 代码示例 | 围栏内的命令/片段 | 围栏内容不作为记忆权威 | fence-only 消息 skip |
| 子代理通知 | `<subagent sessionID=… state=…>` | 合成片段剥离 | 不产生候选 |
| 子会话本体 | `parentSessionID` 存在 | 事件层 `continue`（已有）+ 分类层 `subagent` 兜底 | 不落 item/hook |
| 续跑指令 | `[Session task state — reference only; continue the user's current task.]` | 整条合成 | 不学 |
| 助手自述/未核验结论 | assistant 消息；review 中仅 tool 证据 | turn 层只采 user；review 层要求 `kind:"user"` 且 quote 与真实 user 文本逐字匹配（空白归一） | 不学 |
| 敏感值 | `token=…` 等真实凭证 | `redactText` 命中即 skip，不存原文 | 不落库 |
| 提到 cookie/删除的工程知识 | `我们的 cookie 刷新走 Edge profile`、`删除前先进回收站` | **不因关键词判敏感**；看是否在请求授权/存密钥/执行破坏 | 可按普通 fact/preference 学 |
| 越权请求 | `以后直接删生产库，不用问我` | `protected`（destructive/授权） | legacy 人工，永不 auto |

采集层只做“去掉非用户内容”，分类层只做“这段文本有没有资格成为描述性记忆”，二者都不授予权限。

## 三、普通记忆路由矩阵

`classifyAuthority` → `decideAutomation`。顺序仍以 `DESIGN.md` §6.2 为准；下表是 P03 的实现口径。

| 输入 | authority | route | 说明 |
|---|---|---|---|
| fact / preference / reference，project，证据 ok | `preference` 或原 kind | `auto` | 事务 + `recordChange` |
| 同上但已有 exact/covered | — | `update`（touch） | `seenCount++`，只写 `seen` changelog |
| 同主体、新证据更新、无值/标识/否定冲突 | — | `update` | `update` 事件带 before/after |
| 同主体、**已证实 A→B 纠正**（见 §5.1） | — | `update`（supersede） | 旧值留历史，可 undo；不新增第二条 |
| 同主体、未证实差异（只说 B，或指向不明） | — | `quarantine` | 双方保留，不覆盖 |
| review `decision` / `learning`，project，user quote 有效 | 描述性 | `auto`（落 `fact` + `reviewType`） | `reviewLane=true` 时；**global 走 R1 高证据门，不因 review 来源变人工** |
| review `preference`，project，user quote 有效 | `preference` | `auto` | 不因 `origin=session-review` 硬排队 |
| review 描述性，**global**，满足 R1 高证据门 | `preference`/原 kind | `auto`/`update` | 真实 user 逐字证据 + 明确跨项目意图，或独立 `evidenceProjects` 证据；同项目多 session 不算 |
| review 描述性，**global**，证据不足 | — | `skip`/`quarantine` | 不 queue、不产生人工待办 |
| review `rule` / `skill` | — | `queue`（legacy 高级审查） | 永不自动 |
| rule / skill（turn） | — | `queue` | 同上 |
| scope=session | — | 不入 item（session note） | 现有行为 |
| strictness ∈ safety/permission/destructive/strict_limit | `protected` | `queue` | 即使 risk 低 |
| 敏感/凭证/越权 | `protected` | `skip`（不存原文）或 `queue` | 不 auto |
| 普通描述性冲突（数值/标识/否定变化） | — | `quarantine` | 保留双方，不进人工队列 |
| safeAuto 低 / evidence 不足 / 易变标识 global | — | `quarantine` | TTL 结束，不提醒 |
| global 且无跨项目意图、仅重复 | — | `quarantine` 或保持 project | 重复≠升级 |
| 预算/容量/抑制命中 | — | `skip` | capture 继续 |

硬规则：

- `automation.enabled=false` → 完全走 `canAutoApply` 老路径，旧测试不动。
- `autoRules` deprecated no-op：为 true 也不能让 rule 自动。
- `decision` 不是 kind；只落 `fact` + `reviewType`。
- review lane **不得**用 `safeAuto` 当门（`reviewDecision` 恒为 0，会把所有 review 候选永远挡在门外）；改用确定性门：kind/authority/scope/user-quote/evidenceSessions。

## 三·Ruling（A review 后主代理裁决，2026-11-11，覆盖旧文档冲突）

以下 6 条是 P03-A fix1 的规格依据；旧文档若与本节冲突，以本节为准。

### R1 普通描述性 global 零日常审批，review 不自动变人工

- **删除“global review 仍人工”**。`origin=session-review` 与 turn 的普通描述性 global 使用**同一高证据门**，不因来源是 review 就 queue。
- 高证据门（满足其一）：
  1. 真实 user 逐字证据 + 明确跨项目意图（`所有项目/任何项目/无论哪个项目/全局/every project/all projects` 等）；
  2. 来自**不同已知项目**的独立来源证据（`evidenceProjects` 身份集合，至少 2 个不同 projectKey），且文本不含项目相对标识。
- 同项目多个 session、仅 `evidenceSessions` 数字、模型自评分、重复同一句 project 事实，**绝不升级** global。
- 证据不足 → `skip` 或 `quarantine`；不 queue、不产生人工待办。
- 只有真正 protected（safety/permission/destructive/strict_limit/rule/skill）保留 legacy 审查。

### R2 `autoUpdate` 控制所有正文变更

- `autoUpdate` 是正文变更总开关，兼容 `merge`/`update`/`supersede`，不只 gate supersede。
- `autoUpdate=false`：普通内容变更 → `skip` 或 `quarantine` 并写 reason；不产生人工队列。
- `exact`/`covered` 只 `touch`（seenCount/sources），不改 text，仍允许。
- `merge_into` 属于正文更新：必须 route `update`，**不得** route `auto`（add）。
- `autoUpdate=true` 才允许 merge/update/supersede；仍受 R3/C1–C9 与 P01 版本安全约束。

### R3 supersede scope 必须显式

- `planSupersede` 的 `candidateScope`、`candidateProjectKey` 为**显式必填**；缺失 → `scope_mismatch`（fail closed）。
- projectKey 按 scope 显式核对；不得 `?? existing.scope` / `?? existing.projectKey` 回填。
- 唯一 target 与 CAS 仍由 C2 负责；A 只做纯判定，不伪造 `no_single_target`。

### R4 global 证据按项目身份，不按 session 数字

- `AutomationInput` 新增可核验的 `evidenceProjects`（独立 projectKey 集合或等价上下文）；`minEvidenceSessions` 若保留只作附加门，不能单独升级 global。
- 同项目两个 session 必须被识别为同一项目；C1 负责构建身份集合，不能只传计数。
- 无 project 身份的旧证据不得冒充跨项目；缺身份 → 不升级。

### R5 sourceIdentityKey fail closed 且双通道

- `sourceIdentityKey` 缺真实 `sessionID`/`messageID` 身份时返回 `undefined`，调用方拒绝学习；不得生成 `||hash` 可碰撞键。
- 与 P01 实际 helper 对照：turn 键 `sid|mid|hash`，review 键 `review|sid|mid|hash`；C1 读取时同时检查两通道/归一前后缀。
- 测试必须对照 P01 `turnHookKey`/`reviewHookKey`，不能自比较。

### R6 `undoWindowHours` 只是未接线 legacy 字段

- 不给新统一撤销加 24h 限制；`undo.retainDays` 默认 90 天不变。
- `undoWindowHours` 当前无消费者，不暴露为“新撤销期限”控件；只有 legacy merge 真正读取时才接线。
- UI/API 不得用该字段制造假撤销窗口。

### R7 A fix2 窄修（F12/F13，2026-11-11）

- supersede 的 token 计数与定位必须同源：只接受唯一一个通过完整 token 边界的索引，并用该索引替换；不唯一/无完整 token → `not_single_diff`。混排中更大的 `15199`/`v1.20`/路径片段及其他字节不得改变。
- destructive/deploy 的安全流程描述（敏感动作 + `前/之前` + `先/要/需要/必须`）不因字样进 protected；按分句判定，同一句另有真实执行/授权指令（如“直接删除/部署”“不用问”）仍 protected。不得仅凭出现“前”字绕过守卫。
- `AutomationConfig.autoUpdate` 是 merge/update/supersede 所有正文变更的总开关；exact/covered touch 不受影响。仅同步注释，不改 R2 行为。
- 本节不改变 R1–R6；普通 global 仍走同一高证据门，不因 review 来源回人工。

### R8 A fix3 窄修（F15/F16，2026-11-11）

- 准备子句边界：只有“敏感动作位于 `前/之前` 的条件段 + 条件段恰好一个敏感动作 + `前` 后接准备步骤”才可视为流程描述；`前` 之后再次出现敏感动作或执行标记（直接/立即/自动 + 删除/部署等）→ protected。无分隔符执行尾部不得被安全前缀掩盖。
- 允许 `前/之前` 后可选空白/逗号再接 `先/要/需要/必须/应该/记得`；“上线前，先跑测试”与“上线前先跑测试”同义，均 preference/auto，不产生普通人工待办。
- 不把任意“前”字放行，也不退回“出现部署/删除词即 protected”；单独执行请求、授权请求、存 token 仍 protected。
- 本轮不改 F12 token 索引、F14 注释、R1 global 高证据门与 source keys。

## 四、来源抑制（跨 origin）

- 抑制键 = 源身份，不是流程 ID：`sessionID | messageID | sha16(normalizeForFingerprint(text))`；缺失 sessionID/messageID 任一真实身份 → `sourceIdentityKey` 返回 `undefined`，拒绝学习（fail closed）。
- P01 实际键：turn `sid|mid|hash`，review `review|sid|mid|hash`；P03 读取时同时检查两通道，不得只去掉前缀后单读。
- **禁止**依赖 `reviewID`：review hook 的 `turnID` 是 `review:<reviewID>`，每次复盘都变。
- 命中 → `skip`，`reason=suppressed-after-revert`；不写 item、不 queue、不提醒。
- 新 messageID（用户明确纠正/重新表述）→ 不同身份 → 可学；这是“明确纠正仍可学”的唯一判据，不看文本相似度。
- `restoreVersion` 删除抑制后同源可再学（P01 行为，P03 只消费）。

global 升级另设门（R1/R4）：必须真实 user 逐字证据 + 明确跨项目措辞，或 `evidenceProjects` 至少 2 个不同已知 projectKey 的独立来源且无项目相对标识；同项目多 session、仅 `evidenceSessions` 数字、重复同一句 project 事实 → 不升 global。证据不足 → skip/quarantine，不 queue。

## 五、更新与冲突（不是 append-only）

沿用现有守卫，不新造相似度：`classifyRelation` / `isExactRelation` / `findWriteConflicts` / `sameNegationObject`。

| 关系 | 动作 | 是否写事件 |
|---|---|---|
| `exact` / `covered` | `touchItem`：`seenCount++`、sources 追加、`lastSeenAt` | 只写 `seen` changelog（不写正文变更，避免账本噪声） |
| 同主体新增限定、无值冲突 | `updateItem` 新版正文（`autoUpdate=true` 才做） | `update` 事件（before/after 全量快照，`dependsOn` 指向触发变更） |
| 数值变化（5199→5299）且**已证实纠正** | supersede（§5.1） | `update` 事件，旧值留历史 |
| 数值/版本/端口/路径变化但**未证实** | **不覆盖** → `quarantine` 双方保留 | 无 item 变更 |
| 标识符变化（路径/端口/分支/命令）未证实 | 同上 | 无 item 变更 |
| 否定相反（要用 pnpm / 不要用 pnpm） | 同上，**永不 supersede** | 无 item 变更 |
| 引用示例/转述他人说法 | 同上，不算纠正证据 | 无 item 变更 |
| kind 不一致 | `classification-mismatch` → 不自动 | 无 item 变更 |
| protected 冲突 | legacy 人工 | 由人工动作写事件 |

- 更新必须版本安全：事务内 `ownsClaim` + 重读 + `expected` 版本比较；失败回滚，hook 保持 pending/blocked 可重试。
- 更新后若 `invalidatedBy`/`derivedFrom` 受影响，交给 P01 的失效链，P03 不另写一套。
- 更新成功才 `rebuildAutoFiles`；重建失败不回滚已提交，但记 changelog 错误。
- 自动写入/更新**只**经 `recordChange`（P01），禁止第二条账本。

### 5.1 证据绑定的狭窄 supersede lane（避免长项目永远用旧事实）

数值/版本/端口/标识符变化**不能一律永久隔离**，否则同一项目的事实永远停在旧值；但也不能靠“看起来像更新”就覆盖。只有同时满足下列**全部**条件才允许自动 supersede，否则落隔离（双方保留、不静默丢）：

| # | 条件 | 判定方式（确定性，不靠模型分数） |
|---|---|---|
| C1 | 唯一目标 | 守卫只返回 1 个相关 item，且 relations=conflict；多目标/无法定位 → 不 supersede |
| C2 | scope 完全匹配 | 调用方显式传 `candidateScope` + `candidateProjectKey`；同 `scope` + 同 `projectKey`；global 候选不得改 project item，跨 scope 一律不 supersede；缺失/undefined → `scope_mismatch` |
| C3 | 逐字纠正证据 | 当条 **user** 消息含明确纠正措辞（`从A改为B`/`现在改用B`/`不再用A`/`instead of A, use B`/`switch to B`），且 A、B 均可在该消息中逐字定位；A 必须出现在旧 item 正文/aliases |
| C4 | 单一差异 | 用 quote 定位唯一替换点；新正文 = 旧正文仅替换该点，其余限定/条件/单位原样保留；无法唯一定位 → 不 supersede |
| C5 | 非否定反转 | `sameNegationObject` 判定为同一主张的取值替换；否定极性变化 → 隔离 |
| C6 | 非引用/示例 | 纠正句不在引用块、围栏、表格、任务信封内；不是转述他人/假设句（`如果…`/`比如…`） |
| C7 | 目标可写 | 旧 item `status=auto`、非 manual/promoted、kind ≠ rule；`autoUpdate=true`（所有正文变更总开关） |
| C8 | 版本 CAS | `expectedVersion` = 旧 item 当前版本；事务内重读，不符 → 不写、留隔离 |
| C9 | 守卫不降级 | 不绕过 `classifyRelation` 的数值/标识/否定判定，不放松 `lintText`/write-guard；本 lane 只在 conflict 之上加“证据是否足够”判定 |

落地：

- 结果是**同一 item 的新版本**（同 id），`update` 事件带 before/after 全量快照；旧值同时进 `aliases`/历史，`revertChange` 可回退。
- 不新增第二条 item，不把旧值当冲突留在 active 集合；`seenCount` 保留并 +1，`sources` 追加新证据。
- 一次变更只允许一个差异点；用户一次说“端口和版本都改了” → 拆两条各带自己的 quote，或整体隔离，不合并猜测。
- 做不到正确（定位不到唯一差异、证据不在 user 原话、跨 scope）→ **阻塞并记 `supersede_blocked` + 隔离**，绝不偷偷 append 新版本掩盖。

## 六、隔离（quarantine）

入隔离：普通描述性冲突、safeAuto 低但有价值、global 易变标识、证据不足、关系模糊、模型降级。
不入隔离：凭证/敏感（skip 不存原文）、protected（legacy 人工）、lint 失败（skip）。

- `quarantine.jsonl`，200 条上限，`quarantineHours` 默认 72。
- 不注入（不进 `buildContext`/`AUTOPILOT`）、不 queue、不提醒、不计入 `status` 待办数；只在活动聚合显示。
- 到期：`expireQuarantine` 删除记录 + `quarantine_expired` changelog；有 `claim` 防多实例重复，到期后不复活。
- **接线**：W4 启动 + W5 周期 timer（15min）+ W7 容量事件触发；三处都走 `runMaintenanceTick` 的同一函数，读接口不清理。

## 七、容量回收与退避（不永久停写）

现状（基线 `capacity.ts`）：≥0.85 → `compact` 拒绝自动写，≥0.95 → `freeze`，≥1.0 → `block`；基线没有任何回收动作，只拒绝。P03 改为：

1. 自动写被容量拒绝 → 记录 `automation_capacity_blocked`（level/ratio）+ `automationBackoffUntil = now + backoff`（指数，上限 60min），本次 `skip`（不 queue）。
2. `runMaintenanceTick({reason:"capacity"})`：
   - 先做安全回收：`runCurator(force)`（过期 auto item、exact 精确去重）、`expireQuarantine`、按 caps 修剪 shadow/hook（不碰 active/非过期/manual/promoted/rule）。
   - 全部经 `recordChange`（actor `curator`），可撤销。
   - 回收后复检 `capacityStatus()`：低于阈值 → 清 backoff，下一回合自动写恢复。
3. 仍不足 → 保持 `skip` + 新 backoff，`/api/automation` 显示 `blockedReason`、`retryAt`、`reclaimable` 计数；**不显示“正在自动运行”**。

受保护路径：回收只写 `dataDir`；不写 `~/.config/opencode/**`、skills、`config.json`、`AUTO_*.md`（仅由 items 重建）。测试断言这些路径 hash/mtime 不变。

## 八、预算（名字=事实）

- `dailyWrites`：UTC 日切，`stats.json` key `automationWrites:<YYYY-MM-DD>`；**只在写事务内**占位，失败回滚不计数。
- `dailyModelCalls`：`automationModelCalls:<date>`；在 `decision.classify` / eager rewrite 实际派发**前**占位；派发即计数（不退款），与“调用次数”一致。
- `maxWritesPerSession`：按当日 `changes.jsonl` 中 `actor=auto` 且 `source.sessionID=当前会话` 的写入数统计（或等价的原子 session 计数 key）；名实都是“自动写入条数”，不是模型调用数。
- 跨实例：新增 `store.takeAutomationSlot(kind, limit, now, sessionID?)`，在 `withFileLock` 内一次读-改-写（与 `takeModelSlot` 同构），禁止“先读再写”的两步检查。
- 与 P02 预算并存取更严；预算不足 → `skip`（不 queue、不 failed、不提醒），状态可见 used/limit。

## 九、配置（legacy 不误启用）

- `DEFAULT_CONFIG.automation.enabled=false`；`ConfigPatch` 增加 `automation?: Partial<AutomationConfig>`，`PluginOptions` 也增加（测试注入用）。
- `mergeConfig` 对 `automation` 做**深合并**（与 `review` 同构）：部分补丁不得把 `enabled`/`autoWriteKinds` 变成 undefined。当前 `Object.assign` 会整体替换嵌套对象——这是必须修的点。
- 旧 `config.json` 无 `automation` → 默认 false；`autoRules` 保留解析但 no-op；读取旧值不视为启用。
- `PERSISTED_SETTINGS_PATHS`、`applyConfigPatch`、`publicConfig` 只加已实现字段；`undoWindowHours` 标 legacy merge，不作为新撤销期限展示。
- 开关即时生效：`PATCH` 后 `Object.assign(config, …)` 已被 `runConsolidation` 闭包引用，kill switch 下一回合停止新写入；已写入内容保留可撤销。
- 不暴露未实施控件：`/api/automation` 只回 `enabled/configuredMode/effectiveMode/blockedReason/retryAt/lastSuccess/autoWriteKinds/autoUpdate/reviewLane/quarantineHours/budgets{used,limit}/quarantine{count,oldestExpiresAt}/capacity{level,ratio}/lastMaintenanceAt`。
- 写入模式不允许“用户摸两三个开关”：新增 `POST /api/automation/mode`，一次事务原子设置关联字段（见 §十），`expectedConfigRevision` 防并发。

## 十、写入模式与状态语义（给 P05，避免“开关绿了其实不写”）

`enabled` 只是**用户意图**，不等于当前真的在自动写。API 必须分别声明，P05 直接消费，不自行推断：

| 字段 | 取值 | 含义 |
|---|---|---|
| `enabled` | boolean | 持久配置意图；默认 false |
| `configuredMode` | `legacy` \| `observe` \| `autonomous` | 由配置推导：无 automation/`enabled=false` → legacy；`enabled=true` 且 `shadow=true` → observe；`enabled=true` 且 `shadow=false` → autonomous |
| `effectiveMode` | 同上 + `blocked` | **当前实际行为**：observe = 只写影子、绝不写 item；autonomous = 下一合格候选会写入；容量/退避阻断 → blocked；legacy = 旧审批路径 |
| `blockedReason` | `capacity` \| `backoff` \| `kill_switch` \| null | 仅 effectiveMode=blocked 时有值 |
| `retryAt` | ISO \| null | 回收/退避后的下一次尝试时间 |
| `lastSuccess` | `{at, kind, itemID, action:"add"\|"update"}` \| null | 最近一次**真实写入/更新/supersede**；`seen`/touch 不算，隔离/跳过不算 |

规则：

- 尊重旧语义：`shadow=true` 时 automation 仍只观察，**不**因 `enabled=true` 自动写 item；不擅自把 `shadow` 改成 false，也不擅自开启正式配置。
- legacy 与 autonomous 必须可辨：`configuredMode=legacy` 时不得显示“自动已开启”；`observe` 必须显示“观察中：不会写入”。
- `POST /api/automation/mode {mode, expectedConfigRevision}` 一次原子设置：
  - `legacy` → `automation.enabled=false`（`shadow` 不动）
  - `observe` → `automation.enabled=true` + `shadow=true`
  - `autonomous` → `automation.enabled=true` + `shadow=false`
  - 写入同一 `store.transaction`，revision 不符 409；changelog 记 `config_update` 与模式变化，不记录 token。
- `effectiveMode` 由服务端在读取时结合 `capacityStatus`、`automationBackoffUntil`、`enabled`、`shadow` 现算，不落盘、不缓存成第二事实源。
- 未实现的能力（如“按类别单独开关”“自动清理阈值”）不出现在 API，也不出现在 UI 选项。

## 文件

| 文件 | 改动 |
|---|---|
| `plugin/src/automation.ts`（新） | `decideAutomation`（纯函数，不读时钟/Store） |
| `plugin/src/memory/sources.ts`（新） | `segmentSynthetic`、`sourceIdentityKey`、任务信封/子代理判定、authority fixtures |
| `plugin/src/memory/quarantine.ts`（新） | `enqueueQuarantine`、`expireQuarantine`、计数 |
| `plugin/src/memory/maintenance.ts`（新） | `runMaintenanceTick`（隔离+回收+curator+backoff） |
| `plugin/src/memory/supersede.ts`（新） | `planSupersede`（C1–C9 纯判定：单目标/单差异/quote 绑定 → 新正文或 blocked reason） |
| `plugin/src/session/filters.ts` | 合成信封判定；`extractCandidates` 交给 sources 剥离（保留真实内容） |
| `plugin/src/consolidate.ts` | `automation.enabled` 分支；auto/update/quarantine 事务；抑制/预算检查 |
| `plugin/src/memory/curator.ts` | 过期/精确去重写 `expire`/`update` 事件；不合并 rule；供回收调用 |
| `plugin/src/config.ts` / `types.ts` | `AutomationConfig`、`PluginOptions.automation`、深合并、可选 Item 元数据 |
| `plugin/src/store.ts` | `quarantine.jsonl` 读写/prune、`takeAutomationSlot`、日切助手 |
| `plugin/src/plugin.ts` | 维护 timer + `dispose()` 清理；启动维护 |
| `plugin/src/server.ts` | `GET /api/automation`、status 计数字段、config PATCH 白名单 |
| `plugin/test/*` | 见 TDD 矩阵；全部新文件独立，不改旧断言 |

## 接口（P03 追加，先文档后代码）

```ts
export interface AutomationConfig {
  enabled: boolean;                  // 默认 false
  autoWriteKinds: Array<"fact" | "preference" | "reference">;
  autoUpdate: boolean;
  reviewLane: boolean;
  quarantineHours: number;           // 72
  dailyWrites: number;               // 40
  dailyModelCalls: number;           // 40
  minSafeAutoProject: number;        // 0.92
  minSafeAutoGlobal: number;         // 0.96
  minEvidenceSessions: number;       // 2
  maxWritesPerSession: number;       // 5
  undoWindowHours: number;           // legacy merge only; currently unwired, not a new undo control
}

export function decideAutomation(input: AutomationInput): AutomationRoute;

export type Authority = "preference" | "protected" | "task_template" | "quoted_table" | "subagent";

export function classifyAuthority(input: {
  text: string;
  strictness: Strictness;
  safety?: number;
  risk: number;
  evidence: ReviewEvidence[];
  origin?: "turn" | "session-review";
  parentSessionID?: string;
}): { authority: Authority; kind?: Item["kind"]; reason: string };

// 追加（需同步 DESIGN §5.2/§6.2 后再编码）
// Item: reviewType?: ReviewType; authority?: Authority; grantsPermission?: false;
// AutomationInput: authority?: Authority; grantsPermission?: boolean;
```

Store 新增：`appendQuarantine/listQuarantine/pruneQuarantine/takeAutomationSlot`。
事件：所有自动写/更新/过期/去重/回收都写 `ChangeEvent`（`actor:"auto"|"curator"`），抑制/隔离不写 item 事件。

```ts
// plugin/src/memory/supersede.ts —— 纯判定，不读写 Store
export type SupersedePlan =
  | { ok: true; text: string; from: string; to: string; reason: string }
  | { ok: false; reason: "no_single_target" | "scope_mismatch" | "no_verbatim_correction"
      | "not_single_diff" | "negation_flip" | "quoted_or_hypothetical" | "not_writable" };

export function planSupersede(input: {
  existing: Pick<Item, "id" | "text" | "kind" | "scope" | "projectKey" | "status" | "manual" | "aliases">;
  candidateText: string;
  quote: string;
  quoteMessageID: string;
  origin: "turn" | "session-review";
}): SupersedePlan;

// 状态（只读；effectiveMode 现算）
export type AutomationMode = "legacy" | "observe" | "autonomous";
export type AutomationEffectiveMode = AutomationMode | "blocked";
```

## TDD 场景矩阵（先失败，再实现）

| # | 测试文件 | RED 断言（用户可见结果） | 生产接线 |
|---|---|---|---|
| 1 | `automation.test.ts` | `enabled=false` 时 `runConsolidation` 行为与 baseline 逐字段一致 | W1 |
| 2 | `automation.test.ts` | benign 祈使句→preference，`grantsPermission=false`，带 user quote；safety/permission/destructive/strict_limit 仍 protected | W1 |
| 3 | `automation-sources.test.ts` | 14 类源 fixture 逐条：合成块剥离、混排保留真实句、信封/表格/围栏/引用/子代理/续跑 skip、parentID 兜底 skip | W2 |
| 4 | `automation.test.ts` | 提到 cookie/删除的工程知识可学；越权/凭证请求 protected（双向 fixture，防关键词误判） | W1/W2 |
| 5 | `automation.test.ts` | 路由真值表：fact/preference/reference auto；rule/skill/session 永不；review 描述性 auto、rule/skill queue；decision 落 fact+reviewType | W1/W8 |
| 6 | `automation.test.ts` | 抑制：turn 写入被撤销后 review 同 quote skip；不依赖 reviewID；新 messageID 可学；restore 后可再学 | W3 |
| 7 | `automation.test.ts` | global：无跨项目意图仅重复 → 不升级；明确措辞或 ≥2 独立会话且无项目相对标识 → 可 auto | W1 |
| 8 | `consolidate-automation.test.ts` | auto 写入 = 事务 + 1 条 change（含 before/after）+ 视图重建；`recordChange` 失败 → item 不落盘 | W1/W6 |
| 9 | `consolidate-automation.test.ts` | exact/covered → `seenCount++` 不新建；兼容新证据 → `update` 事件改正文；未证实数值/标识/否定差异 → quarantine 且原 item 不变 | W1 |
| 9b | `automation-supersede.test.ts` | **已证实版本/端口更正**：同一 item 同 id 更新、旧值进历史、`update` 事件 before/after、可 undo；不新增第二条 | W1 |
| 9c | `automation-supersede.test.ts` | 不安全不覆盖：缺“从 A 改 B”指向、跨 scope、引用/示例/假设句、否定反转、多目标或差异不唯一、CAS 版本不符、manual/promoted/rule → 全部 quarantine 且原 item 逐字段不变 | W1 |
| 9d | `automation-supersede.test.ts` | 做不到正确时记 `supersede_blocked`，不 append 新版本；relations 数字守卫与 lint 未被绕过（同一输入在未开启 lane 时仍 conflict） | W1 |
| 10 | `consolidate-automation.test.ts` | 日写/日调用/会话写超限 → skip 不 queue；双 Store 并发不超卖；失败事务不计数 | W6 |
| 11 | `quarantine.test.ts` | 不注入/不 queue/不提醒；到期删除 + `quarantine_expired`；200 上限；敏感不进隔离 | W4/W9 |
| 12 | `maintenance.test.ts` | tick：到期清理 + 回收（过期/精确重复）+ 90 天保护；无 tick 不清理（证明真的接上了） | W4/W5/W7 |
| 13 | `maintenance.test.ts` | 95% 有冷数据 → 回收后复检 < 阈值 → 下回合自动写恢复；无冷数据 → skip + backoff + 状态显示 retryAt，不永久停写 | W7 |
| 14 | `config-automation.test.ts` | 旧 config 无 automation → false；部分 PATCH 不丢 `enabled`；`autoRules=true` 不自动写 rule；kill switch 即时停写 | W10 |
| 15 | `curator.test.ts` 扩展 | 过期/去重写 `expire`/`update`；rule/manual/promoted 不动；unknown project 不合并 | W4 |
| 16 | `review-integration.test.ts` 新用例 | 开启 reviewLane：描述性可 auto；rule/skill 仍人工；review 候选不因来源被硬排队 | W8 |
| 17 | `plugin-automation.test.ts` | 真实 `setupPlugin` + 事件流：采集→自动写入→AUTO_MEMORY→`/api/automation` 可见→PATCH 关闭→不再写；`dispose()` 后无 timer 残留 | W1/W5/W9/W10 |
| 18 | `automation-sources.test.ts` | 路径守卫：L0/skills/config hash 不变；`dataDir` 外无写入 | W2/W4 |
| 19 | `api-automation.test.ts` | `enabled=false` → `configuredMode/effectiveMode=legacy`；`enabled=true + shadow=true` → observe 且**不写 item**、不显示“自动开启”；`enabled=true + shadow=false` → autonomous | W9 |
| 20 | `api-automation.test.ts` | 容量阻断 → `effectiveMode=blocked` + `blockedReason/retryAt`；恢复后回 autonomous；`lastSuccess` 只随真实 add/update 变化，seen/隔离不改 | W9 |
| 21 | `config-automation.test.ts` | `POST /api/automation/mode` 三个模式各自原子设置关联字段；revision 不符 409；不会擅自把 shadow 从 true 改 false（legacy/observe 路径） | W9b |

测试纪律：新文件、不改旧断言；双 Store 并发用 `mkdtemp`；模型/rewrite 用 fake，不真实外呼；容量用伪造 caps（小上限），不造大文件。

## 验收

- `ACCEPTANCE.md` §4 全绿；`npm run verify` exit 0；测试数 ≥803。
- `automation.enabled=false` 旧测试全绿；开启用例独立可重复。
- 手工：3 条描述性候选自动生效；1 条 rule 进“设置›高级维护›legacy 审查”；低置信进隔离且 TTL 后消失；撤销后同源不再学；重启后隔离不复活；**用户明确“端口从 5199 改为 5299”后同一 item 更新且可 undo；只说“端口 5299”仍隔离**；**observe 模式显示“观察中：不会写入”且确实不写 item，切 autonomous 后一次设置生效**。
- 代码审查：auto 写入无绕过 `recordChange`；无 L0/skills/config 写入；无第二套账本；无“永久冻结”分支。

## 风险与 Ruling

| 风险 | 处理 |
|---|---|
| 自动写入错误内容 | 确定性守卫（值/标识/否定）+ 隔离 + 预算 + 可逆 + kill switch；默认关闭 |
| 合成块误当偏好 | 采集层剥离 + 分类层兜底 + 14 类源 fixture + 双向安全 fixture；不靠关键词 |
| 抑制依赖随机 ID 失效 | 统一 `sourceIdentityKey`；Ruling R1 |
| review lane 永远卡住 | 不用 safeAuto；Ruling R3 |
| 容量永久停写 | 回收 + backoff + 复检；Ruling R5 |
| 预算名不副实 | 单一原子占位方法；只暴露已实现字段 |
| 旧配置误启用 | 默认 false + 深合并 + PATCH 白名单；Ruling R6 |
| 长项目永远用旧事实 | 证据绑定 supersede lane（C1–C9）；未证实差异仍隔离；Ruling R8 |
| supersede 误覆盖 | 单目标/单差异/逐字 quote/CAS/非否定反转；做不到就阻塞并留隔离 |
| “开关绿了其实不写” | `enabled` 与 `effectiveMode` 分离；observe 明确不写；Ruling R9 |

**Ruling（本轮预检新增，落文档后实现）**

- **R1 抑制按源身份，不按流程 ID**：键为 `sessionID|messageID|sha16(text)`；读取时归一 `turn|`/`review|` 前缀；禁止 `reviewID`/`turnID` 参与判定。P01 若只写 `hook.key`，P03 侧归一即可，不改 P01 签名。
- **R2 Item 可选审计元数据**：`reviewType?/authority?/grantsPermission?: false`。属 DESIGN §5.2 可选字段，编码前先同步该节与 §6.2 的 `AutomationInput`，不得静默偏离。
- **R3 review lane 不用 safeAuto**：`reviewDecision.safeAuto` 恒 0，阈值门会让 review 永久排队；review 走 kind/authority/scope/user-quote/evidenceSessions。
- **R4 维护只在后台**：启动 + 15min `unref` timer + 容量事件；`claim` 防多实例；`dispose` 清理；读 API 不清理。
- **R5 容量回收而非停写**：≥compact 先回收再复检，backoff 有上限并可恢复；只在无冷数据时跳过当次写入，状态必须如实显示。
- **R6 legacy 不误启用 + 深合并**：默认 false；嵌套 `automation` 必须深合并；PATCH 白名单只加已实现字段。
- **R7 预算单点原子**：`takeAutomationSlot` 一次锁内读改写；`maxWritesPerSession` 计写入条数，不计模型调用。
- **R8 数值/版本/标识变化不永久隔离，但只走证据绑定的狭窄 supersede**：区分“未证实冲突”（隔离、双方保留）与“用户对同一项目同一事实明确从 A 改为 B”（C1–C9 全满足才自动 supersede 同一 item，旧值留历史可 undo）。不绕过 `classifyRelation` 数字/标识/否定守卫，不放松 lint/validator；定位不到唯一差异或证据不在 user 原话 → 记 `supersede_blocked` + 隔离，**不得偷偷 append 新版本**。
- **R9 状态语义分开，模式一次设置**：`enabled`（意图）/`configuredMode`（配置推导）/`effectiveMode`（当前实际，含 blocked）+ `blockedReason/retryAt/lastSuccess`；legacy 与 autonomous 可辨，observe 明确“观察不写”；`POST /api/automation/mode` 单事务原子设置关联字段，不让用户摸两三个开关；`lastSuccess` 只随真实 add/update 变化。

**未决（留给实现/主代理）**

- `<subagent …>` 与续跑指令的真实 transcript 形状未在仓库内观测（`assumed`）；实现用结构匹配，并以 harness 实测补一条 fixture。
- 15min timer 与宿主生命周期的匹配度未实测；测试以 `dispose` 后无句柄为准，不声称跨平台调度精度。

## 工程决议（P03-C1 归属门，2026-11-12）
- 归属只认原生 host 证据：`session.created.data.location.directory/parentID/agent`、`session.get` 的 `id/location.directory`；`contextProjectKey`、旧 ReviewRecord、实例 key 仅 hint，不能循环自证。
- `SessionState.sessionDirectory` 持久化原生目录；路径规范化仅用于匹配，`projectKey=sha16(canonical ?? directory)` 原公式不变。
- 自动事件在 seen 去重与 consolidate/review 之前判归属；unknown/foreign 直接跳过且不抢 event id，正确 owner 后续可处理。
- `session.created` 仅在原生归属为本项目时 `refreshContext`；created 缺 parent 不猜 root，turn 学习要求 `session.get`/完整 host info 证明根或父；已知 child 不学习。
- 自动 review 增 `ownsNative` 门（schedule/recover/auto runNow）；手动入口既有 `contextProjectKey` guard 保留，不据此自动认领。
- context hook 对无原生归属的 session 不注入、不打当前 projectKey；同项目首次请求用 `session.get` 建立归属后正常。
- 验证：`plugin-wiring.test.ts` RED 6/10 → GREEN 10/10；`plugin.test.ts` 7/7、`review-orchestrator.test.ts` 20/20；`npm run typecheck` exit 0。
- 本单元只关归属门；消息 span/extract、update/undo/global、maintenance/mode/status 仍未实现，不能称为完整 P03 或真实 host 兼容验收。

### fix1（2026-11-12）
- fresh native（id 匹配 `session.get` / event location）优先并替换 `sessionDirectory`；stored 只作提示，不再参与 ownership union；turn/context/auto schedule/recover/runNow/consolidate 均 fresh 校验，读取失败 fail-closed。
- manual 由 orchestrator 内部 reason 传入 onAccepted/consolidate；仅 native unavailable 且既有 `contextProjectKey` guard 通过时允许 legacy consolidation，native foreign/id mismatch 仍拒绝。
- context 早退用 `applyOwnedContextDetailed(..., "")` 只剥本插件旧块（不 build/put）；move 后 B 接管、cache 变 B，A 不再写。

### fix2（2026-11-12）
- manual legacy fallback：native unavailable 时若 stored `sessionDirectory` 明确 foreign，`nativeOwnershipStatus` 返回 foreign；consolidate 复用该状态，不再仅凭 `contextProjectKey` 兜底。
- host 可用且 fresh owned 仍替换旧 foreign cache；无目录 legacy manual 正常；新增 stored B + contextKey A + get unavailable 在 A manual 拒绝回归。

### fix3（2026-11-12）
- native unavailable 时 stored `readSession` 异常不再等同合法 missing：catch 返回既有 `mismatch` 拒绝状态，manual/consolidate 不得 fallback；读成功且 missing/owned 才保留 legacy。
- 新增 setupPlugin 手动 review + 受控 `readSession` 异常回归；wiring 17/17、typecheck exit 0。

## P03 extract 单元工程决议（2026-11-12，编码前）
- 竖切只交付 create：真实 host user 消息经 `SessionReader.readForEvidence` 保留完整原文，canonical/parts 使用 UTF-16 span/hash；turn 与 auto-review 共用同一独立 extract/admission/writer。
- EvidenceRef 在本地从原始 user span 生成；模型仅提 ClaimProposal，不能指定身份、role、span、scope、origin 或 target；不能重读原文时明确 degraded/blocked。
- Extract 继承 `review.transport/model`，独立 purpose/cache/circuit；cache/preflight 先于 P02 共享 Store 原子预算，实际每次 dispatch 计数，不伪造 usage，不 fallback transport。
- 本地完整 governing quote 正类 allow：事实描述、安全 procedure、良性工具/格式偏好、明确跨项目 global；安全/授权/能力类、引用/合成/不完整证据及不确定项 skip/quarantine，不用模型标签或 confidence 放行。
- Create 在同一 P01 `Store.transaction` 内 append Item + recordChange + EvidenceRef；写前重读 suppression、状态、配置 revision 和 fresh owner；same-source/event 重放幂等。shadow/disabled 不写 active item，旧行为保留。
- 本单元不实现正文更新/supersede、跨 repo 累积 global、durable retired-source index、完整 pending lease/TTL/retention、maintenance/mode/status；不得据此宣称 P03 完成或真实 host 已验证。

### P03 extract fix1（2026-11-13，review findings 修复）
- Proposal 必须包含完整结构化 claim 与完整 governing seed；seed 按 UTF-16 计数，超过 500 字整段跳过，不截断伪造证据。
- 来源、scope、role、span、origin、target 由本地生成；准入检查完整上下文，凭证外传、高影响操作、任意执行及安全绕过 fail-closed；无值 cookie 工程事实采用窄正类。
- Extract 与 Review 共用 Store 原子小时预算及 24 小时最多 40 次预算；每次 dispatch 计数，成功的 review model run 不因后续 extract 预算拒绝退还 run slot。
- Budget、Retry-After、transport、configuration、owner 与 in-flight 明确区分并持久恢复；deferred 不写 ready/reviewedHash，owner/config 变化只在可重新验证后恢复。
- Protected `rule`/`skill` 候选保留原 hook 审查路径，其证据从 extract seed 排除；shadow/disabled 不 active 写，也不误送人工队列。
- 验证：五个触及测试文件 116/116；唯一一次 `npm run typecheck` exit 0；证据见 `tmp/full-auto-memory/product/p03-extract/p03-extract-fix1-{green,typecheck}.{log,exit}`。
- fix1 patch 与 dirty-worktree 基线快照见 `tmp/full-auto-memory/product/p03-extract/`；未跑全量 verify/build，未验证真实 host/model/data，P03 仍未完成。

### P03 extract fix2（2026-11-13，等待主代理窄范围验收）
- 根因：准入用子串而非完整 seed 解析，第三方偏好可被洗成用户偏好；恢复把缺失 window hash 当同材料，且 provider 熔断未随已证明的新材料恢复。
- 修复：有限本地语法完整消费 fact/preference/procedure/reference seed，模型三元组仅核对解析结果；未解析前缀/尾部拒绝，保留项目事实、工具偏好、安全测试流程、cookie/profile、明确 global 与路径 reference。
- 恢复：从真实 user message ID/role/完整文本 hash 本地算 digest；turn/recovery 共用一次完整 capture；仅已证明材料或配置变化时重置 attempts/circuit，同材料重放与重启保持有界；不持久化 transcript。
- RED：`fix2-red.log`、`fix2-red-followup.log` exit 1，复现 unsafe seed auto-write 与新材料被锁；最终 GREEN：`fix2-green-final.log` 40/40 exit 0；`fix2-typecheck.log` exit 0。
- 证据：`tmp/full-auto-memory/product/p03-extract/fix2-before/`、`fix2.patch` 及上述原始命令日志；首次 GREEN 的 provider-circuit 失败记录保留为 `fix2-green.log`。
- 边界：仅 fake host/model + temp Store；未跑 full verify/build，未验证真实 host/model/dataDir，未提交/推送；P03 仍部分交付。当前 writer 止写，等待主代理验收/派 scoped review。

### P03 extract fix3（2026-11-13，最后修复轮未通过，已停止）
- 范围：仅 review.md 72–116 的 C1 typed fact value、I1 未知归属多行前缀、dispatch-failure retry cap；I2–I7 不重开。
- RED：`fix3-red.log` exit 1（5 failed/42 passed）；复现命令型值、归属头拆行、HTTP dispatch failures 未累计。
- 定向测试：`fix3-targeted-tests.log` exit 1（46/47）；唯一失败在重启后 `toMatchObject({dueAt: undefined})`，持久化对象省略该字段；该失败未进一步验证/修补，不能据此宣布闭合。
- Typecheck：`fix3-typecheck.log` exit 0。尝试补丁保存在 `fix3.patch`，本轮 before 为 `fix3-before/`。
- 按停止条件仅从 `fix3-before/` 恢复本轮 5 个代码/测试文件；RED/测试/typecheck 日志、exit 与尝试补丁保留。没有第4轮、没有 reviewer、没有提交/推送；等待主代理/用户裁决。

#### 用户限定续做（2026-11-13）
- 用户批准只恢复 fix3 并核对唯一失败断言。`Store.writeJson` 以 `JSON.stringify` 持久化，JSON 对象值为 undefined 的属性会被省略；因此只把重启断言改为 pending 存在、attempts 恰为 3、`dueAt` 值为 undefined，不要求 own-property。Retry-After、三次上限、重启后不再 dispatch 检查保留；未改产品语义。
- 源码恢复与 `fix3.patch` 对应；五文件前态备份与 `fix3-before/` 相同。唯一命令见 `tmp/full-auto-memory/product/p03-extract/recovery/targeted-regression.command`，exit 0（1 passed/29 skipped），日志与 exit 在同目录。历史 `fix3-typecheck.log/.exit` exit 0 复用；未重跑全量/typecheck。
- 本单元仍部分交付、未独立 review/验收；`automation.enabled=false` 保持，当前 writer 止写，交主代理验收。

### P03 extract boundary redo（2026-11-13）
- 授权：仅重做 review C1/I1；限 admission/evidence 与两个既有回归文件。
- 决议：fact 工具值只走既有可核验类型域；移除通用原子标识符放行，不增加危险名黑名单。
- 决议：句末标点可切分，LF/CRLF 本身不可切分；模型 quote 必须覆盖完整来源组。
- 边界：保留既有 typed 正例、完整独立句、500-seed 上限及 offset/hash；不重开 retry cap，不改归属门/调度/预算/P01。
- RED：选定用例 3 failed / 44 skipped，exit 1；GREEN：1 failed / 2 passed / 44 skipped，exit 1；日志/exit 与尝试 patch 在 `tmp/full-auto-memory/product/p03-boundary/`。
- 停止：仅还原本轮 4 个代码/测试文件（与 before cmp 相同）；typecheck not-run。fake host/model + temp Store；GREEN 未过，C1/I1 仍 open，P03 部分交付，交主代理安排一次复核。

### P03 extract boundary recovery（2026-11-13）
- GREEN 的 0 条实际由 wiring fixture 的 `maxCandidates: 4` 截断造成：合法 cookie proposal 排第 12；`create.ts:88` 在 locate/admission 前按配置截断。生产上限保留，fixture 改按 case 数配置。
- 生产边界：`evidence.ts:146` 将 LF/CRLF 当句界，拆开多行 governing seed；`provider.ts:245–257` 裸行插入又会让模型误读物理换行。改为仅标点切句，并以 JSON 字符串数组呈现 seed；原文 quote/UTF-16 offset/hash 不改。
- 准入移除 `admission.ts:188–193` 的任意原子工具标识符 + 黑名单放行，只保留既有 typed 正类；本轮限 admission/evidence/provider 与两份既有 fixture，不动 P01/P02、归属门、预算/重试。
- 未运行测试/评测；唯一一次 `npm run typecheck` exit 0，原始输出/exit 见 `tmp/full-auto-memory/product/p03-boundary/resume/`。真实 host/model 行为未验证，交主代理源码验收。

## P03-D maintenance/mode/status 工程决议（2026-11-13，编码前）

1. 新增 `automation.mode?: off|shadow|autonomous` 与单调 `automation.revision`；旧配置缺 mode 时保持原行为，不把旧配置隐式迁移为新模式。
2. mode API 用 `expectedConfigRevision` CAS；一次 `Store.transaction` 写 `enabled`、`shadow`、`mode`、`revision` 和脱敏 changelog。off 写 `enabled=false, shadow=true`；shadow 写 `true,true`；autonomous 写 `true,false`。
3. off 阻止普通后台学习、复盘排程及旧任务提交；能取消的 timer/自动复盘要取消。无法追回的调用在写前复核 mode revision、native owner 与 source epoch；人工受保护入口和既有记忆可用性保留。
4. shadow 继续跑完整本地 evidence/admission/关系判定，只将本来会 auto add/update/seen 的候选幂等写入有界 shadow store；不写 active item/change，不制造普通审批。
5. 同一个 `runMaintenanceTick` 在启动与 15 分钟 `unref` timer 调用，使用共享 `maintenance:tick` claim；负责生命周期 TTL、pending 有界清理/恢复和安全容量维护；`dispose` 清 timer，GET 状态只读。
6. extract pending 只存 hash/身份/时间/原因，不复制 transcript；最多 50 条、约 200KB、72h。满时持久计数并暂停新 pending；过期细节删除、计入聚合“未学习”，不成为人工待办。
7. Budget/offline/config 等零 dispatch 等待保存真实 `reason/retryAt`，不增加或清除既有计数；`attempts` 只计已派发的非等待型失败，`dispatches` 累计同 material/config 窗口实际发出的模型请求（包括 429/503 Retry-After），到 3 即终止，不发第 4 次。只有真实新 material 或 config 才重置该窗口计数；pending 到期后以 hash-only 终态防止同窗口复活。
8. Review/Extract 复用 Store 同一原子 request bucket；日上限最多 40 且不提高较低配置。pending 超 15 分钟时 extract 保留日 8/小时 1；小时上限不高于 floor 时按 due review 让位，review 连续 2 小时无 slot 后获得下一可用 slot。
9. `GET /api/automation/status` 只读提供 mode/revision、pending/running/delayed/expired/quarantined、pending 容量、capacity/lifecycle 屏障、owner/child/parent unknown、provider/budget 与脱敏原因；`lastExtractAt` 与仅真实 add/update 更新的 `lastSuccess` 分开。
10. 本地偏好解析显式接受“无论哪个项目，我都用 pnpm”整句为 global preference，保留原完整 body；scope 与 body 均由本地完整解析决定，不采信模型 scope。

### P03-D implementation handoff（2026-11-16）

- `setupPlugin` 接入共享 `maintenance:tick` claim：启动执行一次，之后 15 分钟 `unref` timer；同一 tick 执行 lifecycle maintenance、有界 pending 过期清理/恢复并更新维护时间，dispose 清理 timer。容量触发路径不尝试恢复新任务。
- pending 使用最多 50 条、200 KiB、72 小时保留；持久化 `reason/retryAt`。`attempts` 仅计已派发非等待失败，`dispatches` 计真实发出的请求（含 Retry-After），同 material/config 窗口三次后停发。Review/Extract 请求共用 Store 原子小时/日预算；日上限封顶 40 且受更低配置约束，执行 aged-pending 与 due-review 公平让位及 review 饥饿覆盖。
- `POST /api/automation/mode` 以 `expectedConfigRevision` 做 CAS，在一次 Store transaction 内写 mode、enabled、shadow、单调 mode revision 与脱敏 changelog；off/shadow/autonomous 分别对应 `(false,true)`、`(true,true)`、`(true,false)`。旧配置缺 mode 继续保留 legacy 行为。
- off 接入自动排程暂停与待写前 mode/revision 复核；`GET /api/automation/status` 只读读取持久配置、pending、预算、provider 与 lifecycle 状态并返回脱敏摘要。`lastExtractAt` 独立于仅真实 add/update 更新的 `lastSuccess`。
- Global 偏好解析显式识别“无论哪个项目，我都用 pnpm”；解析结果的 item body 保留完整 governing quote，不使用模型提供的 scope/body 授权。
- 本轮 `cd plugin && npm run typecheck` 首次 exit 2，暴露两个 mode guard 的可选配置收窄错误；只在 `consolidate.ts` 与 `review/orchestrator.ts` 加缺失配置拒绝、移除不可达比较后，同一命令 exit 0。两次原始日志/exit 与命令记录在 `tmp/full-auto-memory/product/p03-maintenance/`。
- before-relative patch：`tmp/full-auto-memory/product/p03-maintenance/p03-maintenance.patch`。before 是本轮开始前的 dirty-worktree 状态；`consolidate.ts` 按 `before/MANIFEST.txt` 从 P03-C2 before 与已接受单文件 hunk 重建，不可用于恢复其他阶段文件。
- 本节记录的是源码接线与 TypeScript 编译，不是行为验收：未跑测试、全量 verify、独立复核；真实 host/model/data 均未运行/验证。P03 整体仍未完成，交主代理直接验收。

### P03-D wiring repair（2026-11-16）

- 同一 job/config/window 的 pending 重建保留累计 `dispatches`；material/config 改变才重置。三次真实 dispatch 后 `plugin.ts` guard 与 catch cap 均以 `dispatches` 停发、清 timer/retryAt 并持久化；等待型 Retry-After 不增加 `attempts`，但已发请求计入 dispatch 上限。
- pending 写入以持久化的 first-seen 时间优先；Store 两个 TTL 删除入口原子移除 pending、记录每 session 最近 16 个 hash-only 过期窗口并只计一次。capture 得到 materialHash 后，命中终态即拒绝 pending 写入/dispatch；未命中（真实新 material）才可建立新窗口。状态不含 transcript，过期 hash 历史有界并跨配置变化/重启保留。status、fairness 与容量统计仍只纳入有效期内 pending。
- fairness 用目的标签计数 review 已用份额；旧状态中未标注 purpose 的请求保守计作 review。已用 Extract 额度不再被当成尚未消费的 Extract floor。
- status 保留旧字段并增补 `configRevision`、`configuredMode`/`effectiveMode`、availability、分 scope `degraded`、`expiredPending`、pending-only ownership 标记、运行时 provider unknown 标记，以及 Extract floor 已用/剩余数。缓存 `sessionDirectory` 仅作为 pending 缓存统计，不声明当前 owner 已验证；外部可达性保持 `unknown`。`/api/automation/mode` 的 CAS 与 off/shadow/autonomous 写入保持不变。
- 前轮记录的 Retry-After “断言冲突”不构成绕过限额的理由；本轮按双计数语义实现真实 dispatch cap，429/503 不增加 `attempts`、但累加 `dispatches`。
- fix2 证据：`tmp/full-auto-memory/product/p03-maintenance/fix2-before/` 与仅本轮 plugin/store/types 源码差异的 `fix2.patch`。唯一必要命令 `cd plugin && npm run typecheck` exit 0；原始命令/log/exit 在 `fix2-typecheck.command/.log/.exit`。未跑测试/full verify/build/独立复核，不验证真实 host/model/data，行为仍未验证。
