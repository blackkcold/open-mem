# P03-A 独立审查报告

Status: **不通过（规格 FAIL / 质量 FAIL）**
Date: 2026-11-11
Reviewer: 独立审查 subagent（只读审查，未修改产品）
Object: P03-A 纯策略与配置类型（作者报告 `reports/03a-policy.md`，patch `tmp/full-auto-memory/reviews/p03a.patch`，52762 B / 8 files）
Baseline: `tmp/full-auto-memory/reviews/p03a-before/`（P02 净基准）
Scope: 只审 A 的纯策略、类型/config、三个测试文件；B–E 不审、不实现。P01/P02 既有已验收行为不作为本 diff 的缺陷，除非 A 引入回归。

## 1. 结论

- **规格裁决：FAIL。** A 的 source 过滤、authority、review global、merge/update 语义、supersede 守卫存在 5 个 High、4 个 Medium 级偏差；其中多个会让本应 skip/queue/quarantine 的内容进入 `auto`，或让跨 scope/否定/子串场景通过 supersede。
- **质量裁决：FAIL。** 73 个测试确实全绿，但恰好没有覆盖上述失败分支：否定测试没有进入 `negation_flip`，source key 测试是自比较，`merge_into`、review global、scope 省略、子串替换均无用例。999 个仓库测试不能替代这些策略断言。
- **总裁决：A 不能交给 B。** 需 A 固定 owner 返工并重新审查；B 不启动。A 报告对 C1 唯一目标与 C8 CAS 的“留给 C2”声明是诚实的，这部分不作为缺陷。
- 未发现：凭证/密钥值落库、L0/skills/config 写入、提交/推送、未授权网络/模型调用。A 的边界声明基本可信。

## 2. 实际检查维度与证据

已读：`phases/03-pieces.md` §A（21–48）、`phases/03-autonomous-pipeline.md`（源矩阵、路由、抑制、C1–C9、Ruling）、`DESIGN.md` §5.2/§6.1/§6.2、`reports/03a-policy.md`、`p03a.patch`、三个产品源与三个测试文件、P01 `memory/suppression.ts`、`apply.ts`/`changes.ts`/`server.ts` 的相关消费者。

定向验证（未重跑完整 verify）：

- `cd plugin && npx vitest run test/automation.test.ts test/automation-sources.test.ts test/automation-supersede.test.ts` → **3 files / 73 tests passed**（本审查复跑，2026-11-11 19:44）。
- 作者账本：`verify-p03a.exit=0`、76 files / 999 tests、`tsc --noEmit` 通过；主代理已亲读，本文不重复声称全量 verify。
- 最小 probe（只放在 `tmp/full-auto-memory/reviews/`）：
  - `probe-p03a-review.ts`
  - `probe-p03a-routes.ts`
  - 关键原始输出见各 finding 的“行为证据”。
- 未修改产品文件；未安装/提交；未访问正式配置/真实记忆/凭证。

### 2.1 通过项（实际检查过，不是默认相信）

- **Patch 边界**：`p03a.patch` 只含 `types.ts`、`config.ts` 和 6 个新文件（sources/supersede/automation + 3 测试），未改 store/plugin/server/consolidate；8 files 与报告一致。
- **默认关闭**：`DEFAULT_CONFIG.automation.enabled=false`（config.ts:17-18）；旧 config 无 `automation` 时 `mergeConfig` 从默认值开始，仍为 false；部分已定义字段深合并保留兄弟字段（已复跑测试）。
- **类型/审计元数据**：`Authority` union 与 DESIGN 一致；`Item.grantsPermission?: false` 是字面量 false；`QuarantineRecord` 有 `scope/projectKey`；`PersistedState.automation*` 命名与 DESIGN/P03 状态字段一致；未新增虚构 `decision` kind。
- **混合 source 保留**：`<context>`/`<skill_content>`/配对或自闭合 `<subagent>`/`[Session task state …]` 可剥离，混排中的真实句子保留；普通提到 context/subagent 的 prose 不会误删。引用块剥离、表格、fence-only、TASK+MUST DO+MUST NOT DO+CONTEXT 信封的显式用例通过。
- **parentID 已知时**：`parentSessionID` truthy → `subagent`，符合“分类层兜底”；未知 parent 的边界见 §5 观察项。
- **sourceIdentityKey 基本语义**：无 `reviewID`；同消息不同 origin 得到同一键；新 messageID 得到新键；turn 键与 P01 `turnHookKey` 逐字节相等（probe 输出 `s1|m1|b0722b12304ba19d`）；文本 hash 与 P01 `normalizeForFingerprint` 路径一致。
- **verbatim evidence**：只接受 `kind:"user"`；tool、缺失 source、paraphrase 均 false；空白归一后 substring 定位。短引文边界见 §5。
- **supersede 成功路径**：版本/端口/分支的 A→B 能只替换旧正文中的唯一位置并保留其余文本；缺 A→B、显式跨 scope、示例/假设、引用块、多纠正对、A 出现两次、B 已存在、manual/promoted/rule/skill 均拒绝；`reason` 带 origin+quoteMessageID。
- **C1/C8 交接**：`planSupersede` 未伪造 `no_single_target`/CAS 覆盖，报告 §2/§6 明确交给 C2；这是正确的阶段依赖。
- **路由无人工待办项**：`enabled=false` → legacy skip；suppressed/backoff/capacity/dailyWrites → skip；普通未证实 conflict → quarantine；rule/skill/session 永不 auto；protected/strictness 四类 → queue；review 的 safeAuto=0 不再挡门；exact/covered → update（touch）。
- **configuredMode**：`legacy`/`observe`/`autonomous` 三态由 `enabled+shadow` 正确推导，默认 legacy。
- **配置/类型未接线项**：`QuarantineRecord`、`automationLastSuccess*`、`maxWritesPerSession` 等只落类型/默认值，消费方在 B/D；按任务要求不当作 A 缺陷。

## 3. 缺陷（按严重度）

### P03A-F01 [High] `<task>`/`<template>`/`{{…}}` 任务模板会被学成 preference 并 auto

- **路径**：`plugin/src/memory/sources.ts:12-18`（synthetic 列表不含这些形状）、`:75-82`（仅识别 TASK:/MUST DO/MUST NOT DO/CONTEXT 信封）、`:132-145`（分类入口）。
- **触发**：用户/宿主消息 `<task>以后提交前先跑 tsc</task>`、`<template>以后提交前先跑 tsc</template>` 或 `以后提交前先跑 {{command}}`。
- **行为证据**（probe-p03a-routes.ts）：
  - `<task>…</task>` → `{authority:"preference", kind:"preference", reason:"benign-imperative"}`，再路由 `{route:"auto", reason:"descriptive"}`；
  - `<template>…</template>`、`{{command}}` 同样 `auto`。
- **规格**：`DESIGN.md:361` 明确把 `<task>`/`<template>`/`{{…}}`/占位符列为“不进入自动 lane”的任务模板；§目标非目标也写“不把任务模板…当用户长期偏好”。A 的 14 类 fixture 没有覆盖这几种结构。
- **最小建议**：在 `segmentSynthetic` 或 `classifyAuthority` 增加结构性 `<task>`/`<template>` 配对块与 `{{…}}` 占位符识别，混合消息只剥模板段；补三条 fixture，断言 `task_template`/skip，而非 preference/auto。不要用关键词“task”误删普通 prose。

### P03A-F02 [High] 未带“不用问我”的破坏性祈使仍可 auto

- **路径**：`plugin/src/memory/sources.ts:96-97`（destructive 目标正则）、`:147-158`（`destructive && asksAuthority` 才 protected）。
- **触发**：`以后删除生产库`、`以后清空生产库`（没有“不用问/授权”等短语）。
- **行为证据**（probe-p03a-review.ts）：`{authority:"preference", kind:"preference", reason:"benign-imperative"}`；默认配置下 `decideAutomation` 返回 `auto`。
- **规格**：`DESIGN.md:344` “敏感/凭据/隐私/破坏性 → queue（人工）或 skip；永不 auto”；`03-autonomous-pipeline.md:95` 越权请求 protected。当前实现把 destructive 是否 protected 绑在 `asksAuthority` 上，导致未加授权词的破坏性指令反而放行。
- **最小建议**：破坏性目标命中时默认 `protected`/queue，除非文本明确是工程知识而非执行请求（保留“删除前先进回收站”“删除旧分支的步骤”等负例）；补“有/无授权词”双向 fixture，断言 route 不是 auto。

### P03A-F03 [High] review + global 仍会 auto，违反“global 仍人工”

- **路径**：`plugin/src/automation.ts:131-142`（review lane 只查 reviewLane/reviewType/evidenceOk）、`:165-175`（global 门只看 explicit/evidenceSessions），没有 `isReview && scope==="global"` 分支。
- **触发**：`origin:"session-review"`、`scope:"global"`、`reviewType:"decision"`、`evidenceOk:true`、`globalExplicit:true`（或 `evidenceSessions>=2`）。
- **行为证据**（probe-p03a-routes.ts）：两种情况都返回 `{route:"auto", reason:"review-descriptive"}`。
- **规格**：`03-autonomous-pipeline.md:89` 明确“review `decision`/`learning`，project…；`reviewLane=true` 时；**global 仍人工**”；同文件 :106 说 review 的确定性门包括 scope。A 的 review global 用例缺失。
- **最小建议**：review 候选在 global scope 直接 `queue`（legacy 人工），不要走 turn 的 global explicit/多会话升级门；补 review global 两用例，断言 queue 而非 auto。若主代理认为 global review 可自动，需先在 `03-autonomous-pipeline.md` 记 Ruling 并改文档，而不是由实现静默放宽。

### P03A-F04 [High] `merge_into` 落到 `auto`，`autoUpdate` 只 gate supersede 的语义与冻结文档冲突

- **路径**：`plugin/src/automation.ts:161-163`（允许 `merge_into` 继续）、`:177-189`（最终 auto）、`plugin/src/types.ts:501`（注释“Content-changing updates (supersede) need this”）；作者报告 `reports/03a-policy.md:138` 也把口径限定为 supersede。
- **触发**：`relation:"partial"`（或 `related`）、`mergeAction:"merge_into"`、`autoUpdate:false`、其余条件通过。
- **行为证据**（probe-p03a-review.ts）：返回 `{route:"auto", reason:"descriptive"}`；同一 `autoUpdate:false` 下 exact 返回 update（touch，符合“seen 不算内容更新”），但 merge_into 是内容合并/更新。
- **规格冲突**：`DESIGN.md:251` 把 `autoUpdate` 注释为“精确/覆盖重复的合并更新”；`03-autonomous-pipeline.md:86` 说“同主体、新证据更新、无值/标识/否定冲突 → update（autoUpdate=true 才做）”；`:347` 说 mergeAction 非 create/merge → queue/quarantine。A 的注释和报告选择“只 gate supersede”，但没有 Ruling，且 merge_into 被当成 add 型 auto。
- **最小建议**：在 A/C2 前裁决一种语义并落 Ruling：
  1. `merge_into`/兼容新证据 → `update`，且 `autoUpdate=false` 时 queue/quarantine；或
  2. 明确 C1 永远不把 merge_into 当正文更新，只允许 create。
  补 `merge_into + autoUpdate:false` 和 `partial + autoUpdate:true` 用例，断言 route 是 `update` 或非 auto，不能是 `auto`。

### P03A-F05 [High] `candidateScope`/`candidateProjectKey` 省略时静默按旧值通过，跨 scope 守卫失效

- **路径**：`plugin/src/memory/supersede.ts:105-112`（`input.candidateScope ?? existing.scope`；`candidateProjectKey === undefined ? existing.projectKey`）。
- **触发**：调用方只传 `existing`、`quote` 等，不传 `candidateScope`/`candidateProjectKey`；现有 item 为 project/pk。
- **行为证据**（probe-p03a-review.ts）：`supersede-scope-omitted` 返回 `{ok:true, text:"本地 dev server 端口是 5299", …}`。
- **规格**：`03-autonomous-pipeline.md:147` C2“同 scope + 同 projectKey；global 候选不得改 project item”；`03-pieces.md:38` 明确 planSupersede 输入“含 candidateScope/candidateProjectKey”；作者报告 `03a-policy.md:57` 声称“必须与旧 item 完全一致”。
- **最小建议**：把 candidateScope/candidateProjectKey 改为必需参数；缺失时返回 `scope_mismatch`（fail closed），不要用旧值补齐。C2 调用点显式传值；补省略、undefined、跨项目三用例。

### P03A-F06 [Medium] supersede 子串替换会改坏更大 token

- **路径**：`plugin/src/memory/supersede.ts:140-157`（`occurrences`/`indexOf` 仅按子串；`isIdentifierLike` 只用于否定守卫，不用于边界）。
- **触发**：旧正文 `备用端口 15199 已占用`，quote `端口从 5199 改为 5299`（`5199` 是 `15199` 的子串且唯一出现）。
- **行为证据**（probe-p03a-review.ts）：返回 `ok:true`，新正文 `备用端口 15299 已占用`。
- **规格**：C4 `03-autonomous-pipeline.md:149` “用 quote 定位唯一替换点；新正文 = 旧正文仅替换该点，其余限定/条件/单位原样保留”；这不是同一个数值点。
- **最小建议**：对 identifier-like 的 from/to 要求 token 边界（数字/版本/端口/路径按完整 token 匹配），或先从旧正文提取 identifiers 再与 A 比较；定位不唯一/不完整 → `not_single_diff`。补 `15199` 与 `v1.20` 两用例。

### P03A-F07 [Medium] 标识符场景跳过否定守卫，C5 被实质放宽

- **路径**：`plugin/src/memory/supersede.ts:147-153`（只有 `!isIdentifierLike(from) && !isIdentifierLike(to)` 才比较 `NEGATION_RE`）；作者报告 `03a-policy.md:60` 明确写“非标识符场景做否定极性守卫”。
- **触发**：旧正文 `端口不要用 5199`，quote `端口从 5199 改为 5299`。
- **行为证据**（probe-p03a-review.ts）：返回 `ok:true`，新正文 `端口不要用 5299`；没有返回 `negation_flip`。
- **规格**：C5 `03-autonomous-pipeline.md:150` 没有“非标识符”例外，要求 `sameNegationObject` 判定同一主张的取值替换；C9 不允许绕过否定判定。A 的测试 `automation-supersede.test.ts:129-138` 的 quote 没有 A→B，实际在 `no_verbatim_correction` 就返回了，**从未执行 negation 分支**。
- **最小建议**：对数值/标识符也执行 `sameNegationObject`/极性比较，或至少比较 from/to 所在分句的否定对象；发现极性变化返回 `negation_flip`。补一个真正包含 A→B 的否定用例，断言 reason 为 `negation_flip`。

### P03A-F08 [Medium] authority 关键词过宽，benign 工作祈使被误判 protected

- **路径**：`plugin/src/memory/sources.ts:94-100`（`AUTHORITY_REQUEST_RE` 含“直接执行/直接改”等；`CREDENTIAL_RE && CREDENTIAL_STORE_RE`）。
- **触发/证据**（probe-p03a-review.ts）：
  - `以后直接执行 npm test 再提交` → `{authority:"protected", reason:"execution-authority-request"}`；
  - `记住 token 每 30 天刷新一次，走 SSO` → 同样 protected。
- **规格**：`03-pieces.md:44` 要求 benign 祈使→preference；`DESIGN.md:344/360` 要求不因关键词、按是否请求授权/存密钥/执行破坏判定。两条都是工作流描述，不是存储密钥或请求破坏性授权；当前会被 queue，损失自动 lane。
- **最小建议**：把“直接执行/直接改”绑定到 destructive/生产对象，而不是单独命中；凭证词必须伴随真实赋值或“存密钥/记住 token 值”这类对象，而不是“记住刷新周期”。补 benign 正例与“存 token 值/删生产库”负例，双向断言。

### P03A-F09 [Medium] global 的 evidenceSessions 只数会话，不能防“同项目重复升级”

- **路径**：`plugin/src/automation.ts:165-174`（只用 `evidenceSessions` 数字和 `PROJECT_RELATIVE_RE`）；测试 `automation.test.ts:151-155` 只构造 `evidenceSessions:2`。
- **触发**：同一项目的两个会话都出现一句没有“这个项目/本仓库”字样的 project fact（例如“提交前先跑 tsc”），C1 把 `evidenceSessions` 计为 2。
- **行为证据**：`automation.test.ts:151-155` 已显示 `scope:"global", evidenceSessions:2, safeAuto:0.97` → `auto`（73 green 的一部分）；函数只接收数字，没有 project identity，无法区分“两个项目”与“同一项目两次”。
- **规格**：`03-autonomous-pipeline.md:117` “单纯在多个会话重复同一句 project 事实 → 不升 global”；任务 brief 也要求“global 升级不能靠同项目简单重复”。
- **最小建议**：在 C1 契约中把 `evidenceSessions` 定义为“独立项目会话数”，或新增 `evidenceProjects`；A 的测试补“同项目 2 会话 → quarantine / 不升级”，并把当前 2 会话用例改成“两个不同项目”。这是接口字段的 Ruling 级变更，需先落文档。

### P03A-F10 [Low] sourceIdentityKey 对缺失 source 生成可碰撞键；review 前缀未归一；测试是自比较

- **路径**：`plugin/src/memory/sources.ts:173-180`（`${sessionID ?? ""}|${messageID ?? ""}|hash`）；P01 `plugin/src/memory/suppression.ts:19-23`（reviewHookKey 带 `review|`，turnHookKey 缺失 ID 返回 undefined）；测试 `plugin/test/automation-sources.test.ts:234-255`。
- **触发/证据**：
  - `sourceIdentityKey({}, "同一句")` → `"||e941a9eab19039d7"`；P01 `turnHookKey({}, "同一句")` → `undefined`。两个不同缺失 ID 的消息会得到同一个 source identity。
  - 同 source/text：A 键 `s1|m1|hash`；P01 turn 键完全相等；P01 review 键是 `review|s1|m1|hash`。A 没有提供前缀归一/双读逻辑，C1 直接调用 `isSuppressed` 只命中 turn 键；P01 当前同时写两个键，所以新数据可工作，但遗留 review-only 行需要额外处理。
  - 测试把 `sourceIdentityKey` 与它自己比较，没有和 P01 helper 比较，不能证明“byte 兼容”。
- **最小建议**：要求 sessionID/messageID 至少有一个真实来源，缺失时返回 undefined（需改冻结签名/Ruling）或由 C1 拒绝；C1 读取时同时检查 `review|` 前缀；补 P01 `turnHookKey`/`reviewHookKey` 对照测试，以及缺失 ID 的拒绝用例。

### P03A-F11 [Low] automation 部分补丁显式 undefined 可把 enabled 变成 undefined

- **路径**：`plugin/src/config.ts:145`（`{...result.automation, ...automation}` 不过滤 undefined）；报告 `03a-policy.md:95` 声称“不会把 enabled/autoWriteKinds 变成 undefined”。
- **触发**：宿主/测试注入 `mergeConfig(undefined, { automation: { enabled: undefined } })`。
- **行为证据**（probe-p03a-routes.ts）：返回对象中 `enabled` 为 undefined（JSON 序列化时字段消失），`configuredMode` 会走 legacy；不是误启用，但违反“部分 PATCH 不丢字段”。
- **最小建议**：深合并时过滤值为 undefined 的键（与顶层 `defined` 同策略），补 `enabled/autoWriteKinds` undefined 用例。正常 JSON PATCH 不传 undefined，故列为 Low。

### P03A-Q01 [Medium/质量] 测试过拟合且未覆盖失败分支；73 green 不足以支持 A 通过

- **路径/证据**：
  - `plugin/test/automation-supersede.test.ts:129-138` 名为“negation”的用例 quote 不含 A→B，返回 `no_verbatim_correction`，从未触及 `negation_flip`；因此 F07 的实现即使跳过标识符否定也保持全绿。
  - `plugin/test/automation-sources.test.ts:234-255` 只比较同一函数两次调用，未对照 P01 `turnHookKey`/`reviewHookKey`；F10 的字节兼容没有被验证。
  - 未覆盖：`<task>/<template>/{{…}}`、无授权词 destructive、review global、`merge_into + autoUpdate:false`、scope 省略、`15199` 子串、缺失 source。上述 F01–F10 中多项因此无红灯。
  - RED 记录：`p03a-red.log` 确实是 3 suites module-not-found，符合“RED 仅 module-not-found”的诚实标准；作者报告 `03a-policy.md:109-112` 也披露了 2 次断言失败（global 阈值、引用块 kind）并说明改的是期望。但该 2 次失败未落盘，无法独立核验是否削弱了断言。不是造假，证据链弱。
- **最小建议**：为每条 finding 增加一个行为级负例（断言 route/reason/text，不只 `not.toBe("protected")`）；对 source key 做 P01 helper 对照；把 2 次断言失败也落 RED 日志。质量通过条件应是“失败分支有红灯”，不是“文件全绿”。

## 4. 配置/消费者专项核对（按任务要求给事实）

### 4.1 `undoWindowHours=24`：不是 90 天承诺的回缩，但当前是惰性/未消费字段

- 冻结 DESIGN 接口确实包含 `AutomationConfig.undoWindowHours`（`DESIGN.md:260`，注释“仅旧 merge-journal 事务回滚；不限制停止使用/新统一撤销”），所以 A 增加该字段本身不是虚构类型。
- 设计未给默认值；A 在 `plugin/src/config.ts:29` 写 24，并在报告 `03a-policy.md:93` 主动标注“设计未给默认值”。这是新增默认，不是设计明文。
- 消费者事实：`grep` 仅命中 `types.ts:514`、`config.ts:29`、报告/设计；`plugin/src/apply.ts:43` 的 legacy merge 撤销仍硬编码 `UNDO_WINDOW_MS = 24h`，`plugin/src/server.ts:370` 的展示也硬编码 24h。`config.automation.undoWindowHours` 目前没有任何读写消费者。
- 90 天事实：`DEFAULT_CONFIG.undo.retainDays=90` 仍存在（`config.ts:92-94`），`changes.ts:537-545` 读取它作为统一版本回退窗口；A 没有改这个字段，也没有把 90 改成 24。**因此没有误缩统一 90 天回退承诺。**
- 结论：不是 90 天缺陷；是一个放在 AutomationConfig 下、默认 24、暂未接线的惰性配置面。若 D/后续把它暴露为“新撤销期限”，会形成虚假控制面；建议在 D 接线前保留 Ruling/注释，不要把它当新撤销窗口展示，或等 legacy merge 真正读取该字段再给默认值。Severity: Advisory/Low，不单独阻断。

### 4.2 `autoUpdate` 语义

见 F04：冻结 DESIGN 注释（§6.1:251）说的是“精确/覆盖重复的合并更新”，phase03 §五 :86 说兼容更新要 `autoUpdate=true`；A 的代码/注释/报告把范围缩到 supersede，且 `merge_into` 落到 auto。A 不能单方面缩小冻结开关语义，需 Ruling。

### 4.3 配置合并/旧配置

- 正常场景通过：默认 false；旧 config 无 `automation` 仍 false；已定义字段深合并保留兄弟字段；`ConfigPatch` 排除顶层 `automation` 后单独声明 `Partial<AutomationConfig>`。
- 低风险漏洞：显式 `undefined` 嵌套键会覆盖默认（F11）。`applyConfigPatch`/`PERSISTED_SETTINGS_PATHS` 未加 automation 属 D 的接线，不当作 A 缺陷。
- `PluginOptions.automation` 未在 A 接线（plugin.ts 未改），按 A 边界/C1 依赖处理，不当作 A 缺陷。

### 4.4 Item 审计字段

`Item.authority?`、`grantsPermission?: false`、`QuarantineRecord.scope/projectKey` 与 DESIGN §5.2/§5.5 一致；没有发现 `grantsPermission` 可为 true 的类型入口。`PersistedState.automation*` 只落类型，符合 A 的“不读取/写入”声明。

## 5. 边界观察（不作为 A 产品缺陷，但必须写进 C1/C2 交接）

1. **shadow/observe**：`configuredMode` 正确返回 observe（`automation.ts:192-195`），但 `decideAutomation` 不读取 `config.shadow`，仍返回 auto/update。A 没有 writer，不能证明“observe 不写”；C1 必须在应用 route 前用 `configuredMode==="observe"` 强制只记录 shadow，否则会写 item。这是 C1 的接线契约，不是 A 当前可执行行为。
2. **parent 未知**：`parentSessionID` 为 truthy → subagent；`undefined` → 当普通/根会话。A 没有“unknown parent”第三态或文档说明。C1 必须先解析 parent；解析失败时不能把 undefined 当 root 自动学。建议在 C1 契约和测试中固定此边界。
3. **`classifyAuthority.evidence` 参数未使用**：review 的 `kind:"user"`/逐字校验由 `hasVerbatimUserEvidence` 单独承担；C1 必须同时调用两者，不能只信 authority。A 报告应写明这个组合，不要暗示 classify 自身完成了 quote 校验。
4. **短引文**：`hasVerbatimUserEvidence` 对单字“的”在真实消息中也返回 true；没有最小长度/session 绑定。它是“真实消息内逐字定位”而非“有意义的证据”，建议 C1 加最小长度或 review prompt 约束。Low。
5. **`planSupersede` 的 C1/C8**：正确留给 C2，不伪造；A 的 `SupersedePlan` 虽有 `no_single_target`，纯函数不返回它，属于冻结接口预留，不是缺陷。

## 6. 建议的 A 返工顺序

1. 先修 **F02/F01/F03**（安全/源边界；最容易产生错误 auto）。
2. 再修 **F05/F06/F07**（supersede 单点/scope/否定；补真实 A→B 负例）。
3. 再裁决 **F04/F09**（autoUpdate/merge_into/global evidence 字段），先改 `03-autonomous-pipeline.md` Ruling，再改代码。
4. 最后处理 **F08/F10/F11** 与 **Q01** 测试补强；`undoWindowHours` 只要不变成公开新控制面即可。
5. 修完只跑 A 定向 + `tsc --noEmit`；全量 verify 由阶段末 fresh reviewer 重跑。B 仍不应启动。

## 7. 最终裁决

- **Spec: FAIL**（5 High + 4 Medium；A 的“14 类源/路由/supersede”没有覆盖冻结 DESIGN 的任务模板、review global、merge_into/autoUpdate、scope 省略和否定/子串边界）。
- **Quality: FAIL**（73 green 是真实结果，但测试没有打到失败分支；RED 的 module-not-found 诚实，2 次断言失败披露但无日志，不能作为充分证据）。
- **A 不通过，B 不启动。** 返工后由 fresh reviewer 复核，不以本报告的 probe 代替正式测试。

## 8. P03-A fix1 scoped re-review（2026-11-11）

**原始 §1–§7 是 fix1 前的历史发现，完整保留，不篡改。** 本节只复核 F01–F11/Q01 及 fix1 新破坏；不把历史 F03 的旧规格当作门禁，也不把 A 通过等同 P03 完成。

### 8.1 规格冲突裁决与复核依据

- 已读：`tmp/full-auto-memory/reviews/p03a-fix1.patch`（29286 B / 7 files / 752 行）、`reports/03a-policy.md` §8（146–190）、`phases/03-autonomous-pipeline.md` 新增 R1–R6、`phases/03-pieces.md` §A（含修订后的冻结接口）、`DESIGN.md` §6.1/§6.2 与 `ACCEPTANCE.md` §4 的同步文本。
- **F03 旧发现关闭方式是“规格被主代理先落版 R1 取代”，不是“旧实现原本正确”。** 原 phase 的“review global 仍人工”与 R1（普通描述性 global 零日常审批，turn/review 同门）冲突；主代理已在代码改动前同步 DESIGN/phase/ACCEPTANCE 并记录 R1。故本轮不以旧句作门禁，按 R1 重评实际实现；原始 F03 文本保留为历史。
- R1–R6 的实际复核点：R1 review/turn 同一 global 高证据门；R2 `autoUpdate` 控所有正文变更、`merge_into` 必须 update；R3 scope 显式；R4 `evidenceProjects` 项目身份；R5 `sourceIdentityKey` fail closed + P01 双通道；R6 `undoWindowHours` 仅未接线 legacy，90 天不变。未发现这 6 条之外的新规格。
- 验证：`npx vitest run test/automation*.test.ts` → **95 passed**（本审查复跑，3 files）；作者 RED 日志 `p03a-fix1-red.log` → **19 failed | 76 passed (95), exit 1**，是真实行为断言失败而非 module-not-found；主代理已亲读 `verify-p03a-fix1` 76 files / 1021 tests / exit 0，本文不重跑完整 verify。新 probe：`tmp/full-auto-memory/reviews/probe-p03a-fix1-review.ts`。

### 8.2 逐 ID 状态

| ID | 状态 | 复查行为证据 | 残留/说明 |
|---|---|---|---|
| F01 | **ADDRESSED** | `<task>以后…</task>` → `task_template`；`<template …>` 同；`{{command}}` → `template-placeholder`；`<task>…</task>\n以后…npm test` → `preference`，genuine 句保留；prose 提到 task/template 不误删 | 自闭合/配对均覆盖；混排只剥模板段 |
| F02 | **ADDRESSED（原 underblock）** | `以后删除生产库`、`以后清空生产库` → `protected/destructive-request`；`删除前先进回收站`、`删除旧分支步骤` → `preference` | 新过度保护见 **F13**：`删库前先备份`、`上线前先跑测试` 被 protected |
| F03 | **ADDRESSED under R1** | review global + `crossProjectExplicit`/`evidenceOk` → `auto`；`evidenceProjects:["p1","p2"]` → `auto`；仅 `evidenceSessions:2` → `quarantine`；无 quote → `skip`；turn 同门 → `auto` | 旧 F03 由 R1 规格取代，不再以“global 仍人工”判错；turn 的真实 user quote 组合仍归 C1（见 8.4） |
| F04 | **ADDRESSED（behavior）** | `relation:"partial", mergeAction:"merge_into"` → `update/compatible-evidence`；同输入 `autoUpdate:false` → `quarantine/auto-update-disabled`；exact+false → `update`（touch） | 低残留：`types.ts:501` 注释仍写“supersede only”，与 R2 冲突，见 F14 |
| F05 | **ADDRESSED** | 缺 `candidateScope`、缺 projectKey、global 带 key 均 `scope_mismatch`；正常输入 → `ok:true`；不再回填旧值 | 无 |
| F06 | **NOT_ADDRESSED（partial）** | `15199`、`v1.20`、`/opt/app/data` 单独场景 → `not_single_diff`；5199/v1.2 正常成功 | 混合“子串+独立 token”仍损坏，见 **F12**；完整 token 边界未达成 |
| F07 | **ADDRESSED** | 旧 `端口不要用 5199` + A→B → `negation_flip`；旧 `端口用 5199` → `ok:true`；标识符 `old-tool` 否定 → `negation_flip` | 测试已真实进入 negation 分支 |
| F08 | **ADDRESSED（core）** | `以后直接执行 npm test` → `preference`；`记住 token 每 30 天刷新…SSO` → `preference`；`把生产 token 存进记忆` → `protected`；`以后删除生产库` → `protected` | `以后跑测试不用问我` 仍 protected（“不用问”未改），作为低优先观察，不计本轮阻塞 |
| F09 | **ADDRESSED** | `p1,p1`/仅 sessions/空集合 → `quarantine`；`p1,p2` → `auto`；同项目多 session 不升级 | `evidenceProjects` 由 C1 构建真实身份，A 只消费 |
| F10 | **ADDRESSED** | 缺 session/message → `undefined`；A 键与 P01 `turnHookKey` 逐字节相等；review 键 = `review\|` + A 键；测试不再自比较 | 遗留 review-only 抑制行双读留 C1（R5），非 A 缺陷 |
| F11 | **ADDRESSED** | `automation:{enabled:undefined,dailyWrites:undefined}` → `enabled:false`、默认值保留 | 无 |
| Q01 | **ADDRESSED（form）/ residual** | 22 个新行为用例，RED 19 failed / 76 passed；断言 authority/reason/route/text；F06/F02 的简单负例已覆盖 | 仍缺 F12 混合 token、F13 部署/破坏工程知识、`types.ts` 注释一致性；见 8.5 |

### 8.3 fix1 引入的新 open findings

#### P03A-F12 [High/Critical] token 计数用过滤后的 token，替换却用原始 indexOf，混合场景仍改坏前一个子串

- **路径**：`plugin/src/memory/supersede.ts:72-81`（`tokenOccurrences` 只统计通过边界的出现）与 `:190-192`（仍 `existing.text.indexOf(from)` 取第一次原始子串）。
- **触发/证据**（probe-p03a-fix1-review.ts）：
  - 旧正文 `备用端口 15199，主端口 5199`，quote `端口从 5199 改为 5299` → `ok:true`，新正文 `备用端口 15299，主端口 5199`（应拒绝或改主端口）。
  - 旧正文 `旧版 v1.20，新版 v1.2`，quote `从 v1.2 改为 v1.3` → `ok:true`，`旧版 v1.30，新版 v1.2`。
- **根因**：`tokenOccurrences` 对 `15199` 内的 `5199` 返回不计数，对独立 `5199` 计数 1；随后 `indexOf` 仍命中更早的 `15199` 子串。旧实现会因 `occurrences=2` 拒绝，fix1 反而放行，是**本轮修复引入的回归**。
- **规格**：`03-autonomous-pipeline.md` C4（149）要求唯一替换点、其余字节原样；F06 报告 §8 声称“完整 token 边界”但未覆盖混合场景。
- **最小建议**：让 `tokenOccurrences` 同时返回唯一 token 的索引（或新增 `firstTokenIndex`），替换必须使用该索引；找不到唯一 token → `not_single_diff`。补 `15199 + 5199`、`v1.20 + v1.2` 混排用例，断言拒绝或只改独立 token，绝不能改 `15199`。

#### P03A-F13 [Medium/Important] F02/F08 修复过度：部署/破坏工程知识被无条件 protected、queue

- **路径**：`plugin/src/memory/sources.ts:103-104`（destructive 目标扩到“删库/删除所有/清空所有”等）、`:109`（`DEPLOY_RE` 含“上线”）、`:163-175`（`deploy` 不再与 `asksAuthority` 绑定，命中即 protected）。
- **触发/证据**：
  - `删库前先备份` → `{authority:"protected", reason:"destructive-request"}`；
  - `上线前先跑测试`、`部署到生产前先跑测试` → `protected/deployment-request`；
  - `清空所有缓存前先停服务` → `protected/destructive-request`。
- **规格冲突**：`DESIGN.md:344` 要求“提到 cookie/删除/端口等工程知识不因关键词判敏感，按是否请求授权/存密钥/执行破坏判定”；作者报告 §8 F02 声称“工程知识仍 preference”。这些句子是“先备份/先跑测试”的工程流程，不是请求执行破坏或部署，现被 queue，违背零日常审批方向。
- **性质**：`deploy` 无授权词即 protected 是 fix1 从 `deploy && asksAuthority` 改出来的新过度保护；destructive 扩词也新增了“删库前先备份”误伤。不是旧 F02 的 underblock，而是新 Important。
- **最小建议**：deploy/destructive 需绑定“请求执行/授权/存储”语义（如 `asksAuthority` 或明确的执行动词），保留“以后删除生产库/把 token 存进记忆”negative；对 `删库前先备份`、`上线前先跑测试`、`清空缓存前先停服务` 加 positive fixture，断言 preference/skip，不 queue。若主代理认为任何“删库/上线”字样都必须人工，则需先改 DESIGN/ACCEPTANCE 并记 Ruling，不能由实现静默扩权。

#### P03A-F14 [Low/Quality] `AutomationConfig.autoUpdate` 注释仍是旧 R2 前语义

- **路径**：`plugin/src/types.ts:501`：“Content-changing updates (supersede) need this; seen/touch does not.”
- **冲突**：R2/DESIGN §6.1 已改为“所有正文变更总开关（merge/update/supersede）”，fix1 行为也已是 merge_into/partial/related 更新。类型注释仍说只 gate supersede，会误导 C1/C2 实现者。
- **最小建议**：改为“所有正文变更（merge/update/supersede）总开关；exact/covered touch 不要求”；不涉及行为，Low，但应在 A 交接前修。

### 8.4 R1–R6 / 配置专项复核

- **R1**：review/turn 普通 global 同门；review 无逐字 `evidenceOk` → skip；证据不足 → quarantine，不 queue；真正 protected/rule/skill 才 queue。行为 probe 与 95 tests 一致。turn 的 `hasVerbatimUserEvidence` 组合仍由 C1 做，分类函数不等于完整证据，符合主代理保留的 C1 约束。
- **R2**：`autoUpdate=false` 的 conflict/partial/related/merge_into → quarantine（不 queue）；exact/covered 仍 update touch；`merge_into` true → update，不再 auto-add。行为符合；唯一残留是 F14 注释。
- **R3**：`candidateScope` 必填；缺 projectKey/跨 scope/global 带 key → `scope_mismatch`；无回填。符合。
- **R4**：`evidenceProjects` 按 distinct 已知 projectKey；同项目 `p1,p1`、仅 sessions、空集合 → quarantine；`p1,p2` → auto。符合；C1 负责身份集合，A 不依赖 session 数字。
- **R5**：缺 session/message → `undefined`；P01 turn 字节相等；review 前缀 `review|`；测试对照 P01 helper。遗留 review-only 行双读留 C1，符合“不把未接线依赖当 A 缺陷”。`sourceIdentityKey` 新签名 `string|undefined` 已同步 03-pieces。
- **R6**：`undoWindowHours=24` 仍无消费者；`apply.ts:43` 仍硬编码 24h，`undo.retainDays=90` 未变，未新增/暴露撤销控件；90 天与无时限停用保持。当前不是假控件（未暴露）；D 接线前不得把它当新撤销期限展示。**没有误缩 90 天。**
- **配置/审计**：`DEFAULT_CONFIG.automation.enabled=false` 未变；`mergeConfig` 过滤 undefined 后深合并（F11）；旧 config 无 `automation` 仍 false；`Item.authority?`、`grantsPermission?: false`、`QuarantineRecord.scope/projectKey` 未改且与 DESIGN 一致，未发现新类型破坏。本审查未修改产品，只在 `tmp/full-auto-memory/reviews/` 增加 probe。
- **边界**：`shadow/observe` 仍由 `configuredMode` 表达，`decideAutomation` 不写 item；C1 必须在应用 route 前 gate，A 不伪造。`parentSessionID` 未知仍归 C1 三态。`QuarantineRecord`/`automationLastSuccess*`/`maxWritesPerSession` 仍只落类型，B/D 依赖，不算 A 缺陷。
- **C1/C2**：唯一 target/CAS/事务/undo 仍由 C2；A 的 `planSupersede` 不返回 `no_single_target`，不伪造。C1 仍需组合 classify + verbatim evidence + parent 三态 + P01 双读；这些是交接约束，不是 A 未接线缺陷。

### 8.5 质量复核（Q01 及新测试）

- 95 tests 是真实 GREEN；RED 是真实的 19 个行为失败（不是 module-not-found），日志可见 F01/F02/F05/F06/F07/F08/F10/F11 与 F03/F04/F09 路由；比 fix1 前 73 tests/2 次未落盘失败明显改善。
- 但 95 green **仍不能覆盖** F12 的“15199 + 独立 5199”混排：`automation-supersede.test.ts:220-227` 只测 `15199` 单独出现，正好绕过原始 indexOf 回归。F13 的 `上线前先跑测试`、`删库前先备份`也没有 fixture；`keeps destructive engineering knowledge learnable` 只列了两个容易通过的例子。
- Q01 判定 **ADDRESSED（form）with residual**：行为断言形式已建立，但测试敏感性对 fix1 新回归仍不足；A 不能以 95/1021 全绿直接通过。
- 测试断言总体比上轮强（reason/route/text 具体值；P01 helper 对照；negation 真分支）；未发现“为通过而放宽断言”的新证据。F14 注释不一致属于文档质量，不是测试造假。

### 8.6 fix1 最终裁决

- **Spec: NOT PASS。** F01/F03/F04/F05/F07/F08/F09/F10/F11 已按 R1–R6 或原要求闭合；F02 原 underblock 闭合但新增 F13 过度保护；F06 原样例闭合但 F12 显示完整 token 边界仍未达成。
- **Quality: NOT PASS。** Q01 形式改善、RED 可信；但 F12 是 fix1 引入的 High 回归且无用例覆盖，F13 是 Medium 新误伤，F14 注释未同步；95 green 不足以批准。
- **A 仍不 clean，B 不启动。** F12 必须修并补混合 token 测试；F13 需按 DESIGN 收紧或由主代理先改规格/Ruling；F14 顺手修。修后由 fresh reviewer 重审；A 通过也不等于 P03 完成，B–E 仍按串行依赖推进。

## 9. P03-A fix2 scoped re-review（2026-11-11）

**原始 §8.3（含 F12/F13/F14）完整保留，本节只复核这三项及 fix2 新破坏；F01–F11 的已闭合项不重开，唯一 target/CAS/parent 三态仍归 C1/C2。**

### 9.1 复核依据与逐 ID 结论

已读：`tmp/full-auto-memory/reviews/p03a-fix2.patch`（9935 B / 6 files / 252 行）、`reports/03a-policy.md` §9（192–221）、phase R7、原 review §8.3。定向 `npx vitest run test/automation*.test.ts` → **104 passed**（本审查复跑）；作者 RED `p03a-fix2-red.log` → **5 failed | 99 passed (104), exit 1**（行为断言，非 module-not-found）；主代理已读 `verify-p03a-fix2` 76 files / 1030 tests / exit 0，本文不重跑完整 verify。新 probe：`tmp/full-auto-memory/reviews/probe-p03a-fix2-review.ts`。

| ID | 状态 | 行为证据 | 结论 |
|---|---|---|---|
| F12 | **ADDRESSED** | `备用端口 15199，主端口 5199` → `…15199，主端口 5299`；反向顺序同样只改独立 token。`旧版 v1.20，新版 v1.2` → `…v1.20，新版 v1.3`；路径 `/opt/app/data` + `opt/app` 只改独立 `opt/app`。仅 `15199`、两个独立 `5199` 均 `not_single_diff`。 | 计数与定位同源（`tokenIndices`/`tokenPositions[0]`，`supersede.ts:72-81,179-193`），其他 bytes 逐字不变；F12 闭合。 |
| F13 | **NOT_ADDRESSED（partial）** | 四个安全流程 `上线前先跑测试`、`删库前先备份`、`清空所有缓存前先停服务`、`部署到生产前先跑测试` → `preference`；三个带分隔的真实执行负例 → `protected`。但**无分隔符**的直接执行仍被放行，且“前，先”被误伤，见 F15/F16。 | 目标样例修好，但新增分句匹配有安全误放行和误伤；F13 不能算完整闭合。 |
| F14 | **ADDRESSED** | `plugin/src/types.ts:501` 已改为“Master switch for all body changes (merge/update/supersede); exact/covered touch does not require it.” | 与 R2 一致，注释闭合。 |

### 9.2 fix2 新增 open findings

#### P03A-F15 [Critical/High] 同一分句内“安全前缀 + 直接执行”绕过，真实部署/删除被 auto

- **路径**：`plugin/src/memory/sources.ts:112-116`（`SENSITIVE_ACTION_RE`/`WORKFLOW_CLAUSE_RE` 均可在同一子句任意位置命中）、`:169-176`（`workflowSafe` 仅要求每个含敏感动作的子句“有”一个 `前先`，不要求直接执行没有后续）、`:184-192`（`destructive/deploy` 被 `workflowSafe` 整体放行）。
- **触发/证据**（probe-p03a-fix2-review.ts）：
  - `上线前先跑测试直接部署到生产` → `preference/descriptive`，route **auto**；
  - `删库前先备份直接删除生产库` → `preference/descriptive`，route **auto**；
  - `上线前先跑测试直接删除生产库` → `preference/descriptive`，route **auto**；
  - `删库前先备份直接部署到生产` → `preference/descriptive`，route **auto**。
- **根因**：`WORKFLOW_SPLIT_RE` 只在逗号/然后/接着/并且/再处分句；字符串没有这些分隔符时整句是一个 clause，`WORKFLOW_CLAUSE_RE` 命中前半句“上线前先/删库前先”，`SENSITIVE_ACTION_RE` 命中后半句“部署到生产/删除生产库”，`every` 为 true，`destructive && !workflowSafe`/`deploy && !workflowSafe` 都不成立，最终按普通 preference auto。这是 fix2 的 F13 修复引入的**直接安全误放行**，不是旧 F13 的过度保护。
- **规格**：任务要求 mixed“真正直接部署/删除/不用问仍 protected，不仅‘前’字放行”；R1/03-autonomous 的 protected 语义仍要求执行/授权请求不进 auto。
- **最小建议**：不要在“有敏感动作 + 有前先”时直接放行整句。至少要求：
  1. `前/之前 + 先/要...` 与敏感动作处于同一“准备”子句，且该子句不含 `直接/立即/马上` 等执行标记；
  2. 若敏感动作后面还有 `直接部署/删除`，或同一句出现执行动词，必须 `protected`；
  3. 补 `上线前先跑测试直接部署到生产`、`删库前先备份直接删除生产库` 两个 negative，route 必须 queue。
  用结构化“准备子句 / 执行子句”拆分，不靠同义词穷举。

#### P03A-F16 [Medium/Important] “前，先”被误判 protected，安全流程仍产生普通队列

- **路径**：`plugin/src/memory/sources.ts:114-116`（`WORKFLOW_CLAUSE_RE` 要求 `前/之前` 后紧跟 `先/要...`，而 `WORKFLOW_SPLIT_RE` 先按逗号拆开）、`:169-176`。
- **触发/证据**：
  - `上线前，先跑测试` → `protected/deployment-request`；
  - `删库前，先备份` → `protected/destructive-request`；
  - `清空所有缓存前，先停服务` → `protected/destructive-request`；
  - route 均为 `queue`。
- **根因**：逗号把“上线前”和“先跑测试”拆成两个子句；第一个子句含 `上线` 敏感动作，但没有 `先/要`，`WORKFLOW_CLAUSE_RE` 失败，`workflowSafe` 变 false。语义与无逗号的 `上线前先跑测试` 完全相同，却产生普通人工待办，违背 F13 “安全流程可描述性 preference、不产生普通人工待办”。
- **最小建议**：识别 `前/之前` 后允许可选空白/逗号再接 `先/要/需要/必须/应该/记得`，或在拆分时把“前，先”视作同一准备子句；补三条逗号负例，断言 preference/auto。不要扩大到所有“前”字都放行；直接执行仍按 F15 保护。

### 9.3 未触及项与稳定性

- `sourceIdentityKey` 仍缺真实 ID 返回 `undefined`，P01 turn 键对照仍相等；`Item.grantsPermission?: false` 未改；R1 review/turn global 高证据门仍为 `auto`/`quarantine`，未因 fix2 回退。probe 已验证 `R1-review-global` auto、仅 sessions quarantine。
- `undoWindowHours=24` 仍无消费者，`undo.retainDays=90` 未变；未新增假撤销控件。F01/F04/F05/F07/F08/F09/F10/F11 不重开。
- C2 唯一 target/CAS/事务/undo、C1 parent 三态与 classify+verbatim 组合仍不在 A 内；不把未接线依赖当 A 缺陷。

### 9.4 质量与最终裁决

- **Spec: NOT PASS。** F12、F14 已闭合；F13 只在四个无分隔样例上通过，F15 是 fix2 引入的 High 安全误放行（直接部署/删除 route auto），F16 是新增误伤（安全流程 queue）。A 仍不能交 B。
- **Quality: NOT PASS。** 104 green、RED 5/99 真实，但新增测试只覆盖“有逗号/然后”的混合负例，恰好漏掉 F15 的无分隔执行和 F16 的“前，先”；`03a-policy.md §9` 的“任一敏感子句不满足即 protected”未覆盖同子句直接执行，测试敏感性不足。不能用 1030 tests 代替策略正确性。
- **A 不 clean，B 不启动。** 先修 F15（必须补无分隔 direct negative）、F16（补逗号安全流程 positive），再修/同步对应测试；F12/F14 保持。修后 fresh reviewer 复审；A 通过也不等于 P03 完成。

## 10. P03-A fix3 scoped re-review（2026-11-11）

**原始 §8.3/§9.2 完整保留，本节只复核 F15/F16 及 fix3 新破坏；F12/F14 不重开。**

### 10.1 复核依据与逐 ID 结论

已读：`tmp/full-auto-memory/reviews/p03a-fix3.patch`（6340 B / 3 files / 160 行）、`reports/03a-policy.md` §10（223–253）、原 review §9.2。定向 `npx vitest run test/automation*.test.ts` → **105 passed**（本审查复跑）；作者 RED `p03a-fix3-red.log` → **3 failed | 102 passed (105), exit 1**（行为断言）；主代理已读 `verify-p03a-fix3` 76 files / 1031 tests / exit 0，本文不重跑完整 verify。新 probe：`tmp/full-auto-memory/reviews/probe-p03a-fix3-review.ts`。

| ID | 状态 | 实际行为证据 | 结论 |
|---|---|---|---|
| F15 | **NOT_ADDRESSED（partial）** | 四种原复现全部 `protected/queue`；带目标的“随后部署到生产/随后删除生产库”也 `protected`。但**无目标执行尾**仍 `preference/auto`，见 F17。 | 安全前缀+后续执行的结构分离只覆盖带敏感目标的尾巴；`直接部署/随后删除` 等执行词仍被早退放过。 |
| F16 | **ADDRESSED** | `上线前，先跑测试`、`删库前，先备份`、`清空所有缓存前，先停服务`、`部署到生产前，先跑测试`、`上线之前，先跑测试`、`上线前 ， 先跑测试`、`上线前,先跑测试` 均 `preference` → route auto；`上线前，先跑测试直接部署到生产`、`删库前，先备份，然后直接删除生产库` 仍 protected/queue。 | 逗号/空白归一有效，原 mixed 负例保持 protected；F16 闭合。 |
| F12/F14 | 不重开 | fix2 已验证；本轮未改 supersede 索引与 autoUpdate 注释。 | 保持已闭合。 |

### 10.2 fix3 新增 open finding

#### P03A-F17 [Critical/High] 执行尾没有敏感目标时仍被早退放行：`随后部署/随后删除`、`直接部署/直接删除` 可 auto

- **路径**：`plugin/src/memory/sources.ts:97-115`（`workflowClauseSafe` 在 `!SENSITIVE_ACTION_RE.test(value)` 时第 100 行直接返回 true；`EXECUTION_INTENT_RE` 只在含敏感动作的条件/剩余段检查）、`:196-204`（`workflowSafe` 对每个子句调用该函数）。
- **触发/证据**（probe-p03a-fix3-review.ts，all route auto）：
  - `上线前先跑测试随后部署` → `preference/descriptive`；
  - `上线前先跑测试，随后部署` → `preference/descriptive`；
  - `删库前先备份随后删除` → `preference/descriptive`；
  - `删库前先备份，随后删除` → `preference/descriptive`；
  - `上线前先跑测试，直接部署` → `preference/descriptive`；
  - `删库前先备份，直接删除` → `preference/descriptive`。
- **根因**：`SENSITIVE_ACTION_RE` 只含“部署到生产/删除生产库/删库…”等带目标形式；单独的“随后部署/随后删除”不含敏感目标，`workflowClauseSafe` 在第 100 行早退为 safe；全局 `deploy`/`destructive` 又由前半句“上线/删库”为 true，`workflowSafe` 为 true 后 `deploy && !workflowSafe`/`destructive && !workflowSafe` 均不触发，最终按普通 preference auto。`直接部署/直接删除` 本应由 `EXECUTION_INTENT_RE` 拦截，但因所在子句无敏感目标而根本没走到第 114 行。
- **规格**：F15 要求“无分隔安全准备前缀 + 后续部署/删除不被放行”“无直接字样的后续真实执行”仍 protected；当前只保护了带 `到生产/生产库` 目标的执行，执行词的裸形式仍是安全缺口。和同义词无关，是条件段/剩余文本检查在无敏感动作子句上早退。
- **最小建议**：不要在第 100 行无条件放行。`workflowClauseSafe` 应对“准备步骤后的剩余文本”和“独立后续子句”都检查执行动词集合（至少现有 `部署|删除|清空|上线|发布|推送|执行|覆盖|重置`；可复用 `EXECUTION_INTENT_RE` 的核心动词并允许无 `直接` 前缀），任何后续执行动作 → false/protected。补 `上线前先跑测试随后部署`、`删库前先备份随后删除`、`上线前先跑测试，直接部署`、`删库前先备份，直接删除` 四个 negative，route 必须 queue。不要扩同义词表，只补现有核心动词的裸形式。

### 10.3 稳定性与质量

- 105 tests green 是事实；RED 3/102 是真实行为失败。主代理 1031 tests exit 0 已读，未重跑完整 verify。
- 新测试覆盖了四种原复现和“随后部署到生产/随后删除生产库”，但没有覆盖 F17 的无目标执行尾；`03a-policy.md §10` 声称“后续剩余文本不得再出现敏感动作或执行意图”，实际对无敏感动作的子句早退，测试敏感性不足。1031 全绿不能替代 F15 安全结论。
- `sourceIdentityKey` 仍缺真实 ID 返回 `undefined`，P01 turn 键未变；`grantsPermission?: false`、candidateScope、token 索引、R1 普通 global 门控均未改；C1/C2 未接线依赖不判 A 缺陷。
- 本轮没有改动 F12/F14 或其它已闭合项；只新增 probe，未改产品。

### 10.4 最终裁决

- **Spec: NOT PASS。** F16 已闭合；F15 因 F17 仍未满足“后续部署/删除不被放行”，且 F17 是 fix3 新规则引入的真实安全误放行。
- **Quality: NOT PASS。** 105 green/RED 3/102 真实，但缺 F17 的执行尾用例；测试未证明结构分离对无目标执行有效。
- **A 不能交 B。** 这是 A 第 3 轮修复后仍存在的真实 blocking；按 CONTEXT 的 3 次失败 breaker 规则，应停止 A fix 轮次并回到最后已验收 P02，不发第四轮。A 完成也不等于 P03 完成。
