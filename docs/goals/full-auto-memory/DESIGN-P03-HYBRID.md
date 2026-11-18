# P03 Hybrid 记忆管线 — 候选设计 v4

Status: **候选设计 v4；未批准。** 合并 O1–O3 与 H5/H4 剩余契约；代码/测试/真实 host/模型/验收全部 **not-run**。未改旧 `DESIGN/PLAN/ACCEPTANCE/phase/PROGRESS`，未恢复旧 A。  
Baseline: P02 + known-foreign wiring **74 files / 929 tests / verify0**（既有证据）；P03 无产品代码。  
Scope: 可计划的候选设计；不写实施计划、不写产品代码、不发起真实调用。  
Review: 逐项处置见 `reports/03-hybrid-design-resolution.md`；本文件不是独立复核通过。

## 1. Goals / Non-goals

### Goals
1. 普通 `fact`/`preference`/`reference`/review `decision`/`learning`（落 `fact` + `reviewType`）零日常审批；turn/review 同门。
2. Host/caller 证据先行；既有模型只做后台结构化提案；本地做来源、身份、范围、版本、关系与生命周期硬校验。
3. global 用独立 **repoIdentity** 证据或明确跨项目 user quote；两个 worktree 不算两个项目；显式 global 仍可直接 auto。
4. 完整保留 P01 事件/WAL/CAS/undo/同源抑制、90 天回退、无时限停用；P04 owned 召回、P05 UX、P06 retention/迁移保护不缩（P04/P05/P06 独立阶段）。
5. 记忆不授予执行权、不写 L0/skills/config；但 host 是否拦截受记忆影响的动作仍是 **U**，不写成已成立。
6. 不做“语义 100% 安全”声明；用正类准入、完整 span、硬负例、可撤销与有界 held-out 质量限制残余风险。

### Non-goals
- 不引入向量/embedding/检索服务/新 provider/新依赖；不复制整 transcript。
- 不自动写 `rule`/`skill`/`session`；不改 `AGENTS.md`/`memory/*.md`/`opencode.json`。
- 不用 `safeAuto`/模型 `confidence`/`modalityHint` 作 allow；不把 `grantsPermission:false` 或 prompt 文案当 host 隔离。
- 不以“宁缺毋滥”暗缩全量 UX；不以“先上线再观察”绕过 hard-negative gate。
- 不实现 P06 迁移/正式启用；不声称真实 host 权限已证。

## 2. 已选 approach 与被排除方案

**已选：host evidence first + 后台模型结构化提案 + 本地正类准入/硬校验/生命周期恢复。** 普通记忆主路径是后台 extract；确定性快速 lane 仅 reference 精确子集或离线兜底，不作为高漏学主路径。

**快速 lane（默认关闭）**：仅当 extract 不可用/预算阻断时，接纳 `kind:"reference"` 的精确 URL/路径/命令；quote 为 host 原文、无 secret/执行/授权命中、用户有明确“记住/以后用”标记。fact/preference/decision 不走快速 lane；启用/降级状态可见。

排除：
- 纯确定性 A 正式主路径（覆盖不足）、旧 authority/workflowSafe 再包 `AtomicClaim`（根因未消）。
- Effect-typed notes 全量自动发布（未证语义）；复用 P02 `review()` prompt/cache 冒充 extract。
- 模型自评分阈值、向量召回、`grantsPermission:false` 当运行时隔离。

## 3. 信任与数据契约

### 3.1 信任分层

| 层 | 生产者 | 能证明 | 不能证明 |
|---|---|---|---|
| Host 原文/role/session/project/repo | host/caller（`SessionReader`/event/state） | 文本、实际 role、ID、原生 owner/repo（若交付） | 用户真实意图、语义、host 权限 |
| `EvidencePacket` | 本地 capture | raw/shown 分区、offset、hash、transform 全覆盖 | 语义正确 |
| `ClaimProposal` | 后台模型 | 只是提案 | 身份、span、scope/target、安全 |
| `ValidatedClaim` | 本地 validator | 归属、完整 span、scope、关系、CAS、body 可读性 | 忠实意图、host 权限 |
| `Item`/P01 event | P01 writer | 可逆、版本、来源、账本 | 执行权限 |
| Host permission/gate | host（未知） | **U：不可证** | 不能写成已拦截 |

### 3.2 EvidencePacket / PendingEvidence / EvidenceRef

```ts
interface EvidencePacket {                 // 只在内存
  sessionID: string; originProjectKey: string;
  messageID: string; observedRole: "user";
  canonicalText: string; shownText: string;
  canonicalHash: string; shownHash: string;
  partMap: Array<{ partIndex: number; rawStart: number; rawEnd: number }>;
  transform: TransformSegment[];           // 必须覆盖整个 canonicalText
  readerTruncated: boolean;
}
interface PendingEvidence {                // 唯一持久 DTO，不含 rawText/shownText
  id: string; seedId: string; sourceHash: string;
  sessionID: string; messageID: string;
  observedRole: "user"; originProjectKey: string;
  sourceIdentityKey: string; originEpoch: string;
  targetSetHash: string; targets: Array<{ itemID: string; baseItemVersion: string }>;
  rawQuote: string;                        // ≤500，完整句/子句；可等于短消息
  seedHash: string; offsetStart: number; offsetEnd: number;
  canonicalHash: string; shownHash: string;
  transformVersion: 1; redactionProfile: "secret-only";
  status: "pending"|"processing"|"retry_wait"|"quarantined"|"skipped"|"done";
  attempts: number; nextRetryAt?: string; expiresAt: string;
}
interface EvidenceRef {                    // 写后最小审计引用
  id: string;                              // "ev:"+sha256(canonical tuple)
  sessionID: string; messageID: string; observedRole: "user";
  originProjectKey: string; rawQuote: string; quoteHash: string;
  seedHash: string; offsetStart: number; offsetEnd: number;
  canonicalHash: string; shownHash: string; transformVersion: 1;
}
interface ProposalEnvelope {               // 本地生成，模型不得填
  proposalID: string; pendingID: string;
  sourceIdentityKey: string; originEpoch: string; targetSetHash: string;
  targetID?: string; baseItemVersion?: string;
}
```

- `EvidenceRef.id = "ev:" + sha256(sessionID|messageID|offsetStart|offsetEnd|seedHash|quoteHash|rawQuoteHash)`；由本地 `EvidenceResolver` 在 claim 通过 host raw/offset 校验后生成，模型/pending 不得提供。持久 canonical 存 `evidences.jsonl`（每 id 一行）；`ChangeEvent/QueueItem/ReviewEvidence/globalCandidate` 只存 `evidenceRefID`/hash。`store.transaction` 同事务写 evidence row + item/change/queue；失败整体回滚。pending 72h 只有 `seedId`，claim 验证后才生成 `EvidenceRef`；禁止拿 pending id 当 90d 外键。retention：active item/queue/review/globalCandidate 引用保护；无引用且超 90d 才清；容量不足 `blocked:evidence-capacity`，不删仍被引用 ref；缺失 ref → degraded/fail closed。
- `originEpoch/baseItemVersion` 在 **capture 时**冻结：`sourceIdentityKey = "src:"+sha256({turnHookKey,reviewHookKey})`（缺失 ID → undefined，不 capture）；候选 target 集由本地确定性 relation/guard 对 seed 生成（≤8），`targetSetHash` 覆盖排序后的 itemID/baseItemVersion；`originEpoch = "ep:"+sha256({sourceIdentityKey,targetSetHash,latest source changeID/tombstone epoch})`。model 只回提案内容，本地 `ProposalEnvelope` 绑定；target 不在冻结集或 epoch/version 不符 → `stale`/quarantine，不按 current 补 target/version。cache key 加 `originEpoch/targetSetHash`，hit 仍重验 P01 ledger/source/status/baseVersion。恢复后新捕获是新 pending/new epoch；旧 job 不得借用新 epoch。

- `EvidenceRef` **由 host/caller/validator 生成**；模型返回的 `sessionID/projectKey/role/offset/span/origin` 一律忽略/拒绝。
- `PendingEvidence` 不存 `canonicalText/shownText/full parts`；只存 bounded `rawQuote` + hash/offset/transformVersion。原文不落全量。
- `rawQuote` 可等于短消息，不能声称“从不存完整短消息”；但不镜像 transcript。
- **capture seed（N1）**：模型前由本地对 `canonicalText` 做结构句界/子句切分；seed 先经 synthetic/secret-only 过滤，是完整句/子句（可带同发言者紧邻句作条件上下文），`≤500`；**绝不“前 500 字”截断**。`PendingEvidence.rawQuote=seed`、`seedHash=hash(seed)`，seed 不可变；模型 quote 必须落在 seed 的 shown 区并映射回 canonical kept，body/claim span 在 quote 内；`EvidenceRef` 可绑定更小完整 claim span（`quoteHash` 为 claim span hash，`seedHash` 保留原 seed），绝不改 seedHash。长消息逐完整句分片；单句 >500 仅在安全子句边界拆，否则 `skipped:source-too-long`；计数 `seedCount/tooLong/dropped`。模型 quote/body 跨 seed 才能成句 → quarantine。

### 3.3 canonical、offset、transform、redact

- `canonicalText` = `SessionReader.readForEvidence` 返回的 `normalizeSessionMessage` 文本（parts 以 `\n` 连接），在现有 4000 字 `slice` **之前**；只能拿裁剪文本时 `readerTruncated=true`，offset 仅在该窗口有效，超出 → `evidence_truncated`。
- 坐标统一 **UTF-16 code units**（JS string index）；所有持久 `offsetStart/End` 指 `canonicalText`，shown 位置只经 `transform` 临时映射，不持久 shown offset。`rawHash=sha256(utf8(canonicalText))`、`shownHash=sha256(utf8(shownText))`、`quoteHash=sha256(utf8(rawQuote))`。`partMap` 只在内存。
- `transform` 必须 **完整分区** 覆盖 `canonicalText`：`kept/redacted/truncated/synthetic`，无 gap/未分类 → skip 整条。`quote` 必须落在连续 `kept` 区；跨边界/hash 不符 → `evidence_transform_gap`。
- Redaction 分 profile：capture/pending/model shown 用 **secret-only**（真实 token/key/password 值）；**不**复用默认 `redactText` 的绝对路径替换。路径/reference 正常保留；secret 命中跳过该句/quote，不持久/不发送/不写日志。
- 若 host 不能重读原文重算 hash → 系统 `degraded:evidence-unavailable`（不是每条 72h 观察）；普通记忆自动模式可整体 blocked，不能伪装可用。

### 3.4 正类准入与模型提案

`ClaimProposal`：`quote/messageID/kind/scope/subject/predicate/value/qualifiers/speechActHint/text?/confidence?`。`text` 只作 title/摘要，不作 body；`confidence` 不参与准入；`speechActHint` 只 deny。

**正类（本地在完整 governing quote 上判定；模型 hint 不能 allow）**：

| 类 | 明确支持条件 | auto |
|---|---|---|
| descriptive | 纯观察/状态/系表/被动状态报告/“使用 X 作为工具”，无主动执行请求；完整句；无 directive/modal | 可 |
| procedure | 前置条件（前/之前/before/when/if）+ safe action（read/test/lint/build/format/backup/check/verify）；无 capability/tail | 可 |
| benign-workflow-preference | 明确偏好标记 + 工具/格式/safe workflow；无 capability/凭证/授权 | 可 |
| instruction/authorization | 第二人称/情态 + 高影响动作；或 capability 类（见下） | 永远 quarantine |
| capability-bearing | 第一人称习惯/过去时/descriptive hint 但含 privilege/arbitrary exec/install/credential storage/export/security bypass/external transfer | quarantine，不论人称/时态 |
| unknown | 无法归入以上 | quarantine |

- **capability 闭合类**：privilege（sudo/root/admin/runas/提权）、arbitrary exec/install（eval/exec/curl-pipe-bash/install/chmod）、credential storage/export（写入/发送 token/key/password/cookie **值或存储指令**）、security bypass（disable/skip/ignore auth/validation/permission）、external transfer/upload。含任一 → quarantine，**不因第一人称习惯、过去时或 `speechActHint=descriptive` 自动注入**。仅描述“cookie 在登录接口设置、测试用 fake”这类**无值工程知识**属 fact/reference，不因出现 cookie 字样 quarantine。
- 高影响动作（deploy/release/publish/merge/delete/drop/reset/push/force/transfer/credential）在 **precondition** 只是触发，不构成授权；在 **main/tail** → quarantine。`上线前先跑测试，随后发布到生产` 的 tail 必须 quarantine。
- **安全工程正例保留**：`npm test`/读测试/lint/build/format/backup 等 safe action 可 procedure/preference；**凭证轮换/刷新策略知识**（无值、无存储/导出）可 fact/reference；真实 token/key/password/cookie 值、存储/导出 → quarantine/skip。
- blocklist 只作额外 deny，永不作为 auto 准入；未命中 ≠ 安全。能力类判定是 **B 有限语料质量门**，不是数学安全，也不换回 regex 穷举。
- 正向控制必须同时过：P1“合并前跑完整测试”→ procedure auto；P2“cookie 只在登录接口设置，测试用 fake”→ descriptive auto；P3“我也喜欢用 pnpm”（旧 npm）→ update/merge，不 supersede；P4“以后默认用 pnpm，不用 npm”→ replacement supersede；P5“无论哪个项目，我都用 pnpm”→ 显式 global auto。只用硬负例牺牲 P1–P5 等于暗缩全量 UX。

## 4. Ownership / repoIdentity

### 4.1 原生来源与映射

优先级：
1. `session.created.data`：required `projectID`、required `location.directory`、optional `parentID`（SDK observed）。
2. `SessionInfo`：`projectID`、`directory`、`parentID`。
3. envelope `event.location.directory`（若存在）。
4. 带 `ownershipEvidence` 的已验证 ReviewRecord。
5. 实例 `projectKey`/`contextProjectKey`：hint only。

- **旧 scopeKey 逐字保留**：`scopeKey = sha16(ctx.location.project.canonical ?? ctx.location.directory)`（`plugin.ts:299-300` 的原始字符串）；路径规范化**只用于匹配**，不得重算/替换旧 key；own 新 item 仍用实例旧 key。`scopeKey` 即持久 `projectKey`/`originProjectKey`。
- `canonicalizeForMatch`：`realpathSync.native` → `path.normalize` → 去尾分隔符（根除外）→ NFC；失败（ENOENT/EACCES/非法）→ `unknown`；Windows 仅比较时 casefold。不得用 `startsWith`；用 `path.relative` 的段边界。
- `sessionPath = realpath(location.directory)` 解析 optional `subpath`（`..`/绝对逃逸 → unknown）。实例侧用 `ctx.location.project.id`、`project.canonical`、`directory`（SDK `location.d.ts:29-35`）。
- **own 判据**：① `session.projectID === ctx.location.project.id` 且 sessionPath 与实例 canonical/directory **exact** → own，旧 scopeKey；② 同 projectID 且 `path.relative(instanceCanonical, sessionPath)` 非空、非 `..`、非绝对 → **subdir own**，仍旧 scopeKey，不新建 key；③ 同 `repoIdentity` 但 sessionPath 在实例 root 之外（worktree）→ **scope foreign**（即使 projectID 相同也不合并），不映射 root、不写当前项目。`projectID` 不匹配或 exact 路径冲突 → fail closed；runtime 无 `ctx.location.project.id` → 只认 exact directory，subdir/worktree → unknown。无足够原生 match → unknown，不写/不召回。
- `repoIdentity` 与 `projectKey` 分离：`repoIdentity` 只取可信 host 原生 repo identity，或当前实例受控 `git common-dir` 证明；两个 worktree 同 repo identity；不同 projectKey 不得凑 global。不可证明 → 不以数量升级；显式 global quote 仍可 auto。不得读取模型提供的路径/远端凭证、不得扫描其他项目；其他 project 的证据必须有 host-native repo identity，否则不计数。
- **parent（N3）**：`session.created.data.parentID` 存在 → child skip，永不 root；created 缺失 parentID → **unknown，不直接 root**；root 仅在 `session.get` 完整 `SessionInfo`（`id===sessionID`、`projectID`/`directory` 与 native 匹配、`parentID` 缺失）或早期 host 能力门已证明“created 缺 parentID = root”并记录 contract。get 缺失/失败/不完整 → unknown；`degraded:parent-unknown` 自动重试；旧 host 无 get 覆盖下降但安全，child 不学成 root。

### 4.2 U1/U2 与 legacy record

- **U1**：owner unknown → `captureEvidence` skip；不写当前项目 hook/queue；不靠“ready/queued”或旧 record 授权。
- **U2**：未知 `session.created` 不调用 `refreshContext(..., instanceProjectKey)`、不写 `contextProjectKey`；置 `ownershipUnknown`，不动态召回；有效 created/get 后绑定 native owner。不得覆盖已有不同 key。
- **legacy `ReviewRecord`**：`status=ready`/`queued>0` 不是 authority；新增可选 `ownershipEvidence`（`source: session_created|session_get|event_location`, `projectID?`, `directory`, `canonical`, `projectKey`, `keySource`, `sourceHash`, `at`, `version:1`）。只有带可核验原生证据、且与当前 session 匹配的记录可 bootstrap；legacy 无字段 → observe/hint，不授权写入/召回/global。
- `contextProjectKey`/实例 key 不得洗成 host 权威；只可用于 known-foreign **skip**（安全方向）。
- **H4 batch**：extract 按单一 `originProjectKey`/`repoIdentity` 分批；一次模型调用永不见两个项目；`evidenceRepos` 只由已验证 origin/repoIdentity 去重，同 repo worktree 算一个，同项目多 session 不升级。
- **globalCandidate 账本（H4）**：为保留“两个可信独立 repo 证据”能力，新增有界 `global-candidates.jsonl`（≤200 条/200KB/TTL 90d）。每项只存 `claimKey`（normalized subject/predicate/value/qualifiers/polarity）与 `evidenceRefID`/hash/`repoIdentity`/`originProjectKey`，**不复制其他项目 rawQuote**、不让模型跨项目配对。单个 project 准入的同一原子 claim 先入账；第二个**不同 repoIdentity**、同 claimKey、无项目相对限定（这个项目/本仓库等）、值/极性/限定一致时，才可升 global；global body 用当前项目已准入的 body，其他 repo 仅以 ref/hash 佐证。不同 repo 仅“同值”但 predicate/qualifier/极性不一致 → 不升；不得抹掉项目限定。evidence 被撤销/失效时移除该 repo；剩 <2 且无显式 global quote → 已 global item 停止注入（写 change event），不静默删；再次校验失败 → stale。账本满 → 背压/计数，不驱逐未过期有效证据；expired 聚合可见，不成为审批。显式跨项目 user quote 仍直接走同高证据门。
- **promotion/降级（H4/O3）**：选“新建 global + 链接原 project 副本”：同 `store.transaction` add global、archive/supersede 两个 project items，写 `linkGroupID` 到 Item/ChangeEvent；global body 用当前 project 已准入 body，其他 repo 仅 ref/hash；**不原地改 scope**，保留 P01 scope/undo 快照。global stop/undo 覆盖 linkGroup：global 停用/撤销后 project 副本保持 archived，不自动复活；只有显式 restore 单个 item 才恢复。candidate 90d TTL 到期视为 evidence invalid；<2 且无显式 global quote → global item 用 `invalidatedBy`+`invalidatedAt`，**status 不变**，写 `ChangeEvent kind:"invalidate" actor:"system" reason:"global-evidence-below-2"`；`itemContentVersion` 不因 invalidatedBy 改变，P04/memoryVersion 已排除 invalidatedBy，不注入。≥2 再现需**新 global admission**，不自动恢复旧 item；invalidated child 仍走上游检查。`claimKey` = kind + source scope domain（project）+ valueBearing + polarity + normalized subject/predicate/value/qualifiers，不含 target global scope；polarity 由本地 validator 从 quote/否定解析，模型无字段，无法判定 → 不入 candidate。裸值两 repo 按原策略可升，但作为 **B 风险**报告，不包装成结构证明，不静默缩成 explicit-only。

## 5. Span、body、关系

- `quote` 必须是 **完整 governing sentence/clause**，句界对齐；原句含否定/条件/归属标记时，quote 必须覆盖全句，否则 quarantine。以“就/则/然后/所以/但/否则/不然/那样的话/这样的话/那么/改成/改为/换成/then/but”开头且为 strict subspan → quarantine；条件在前句时必须把前句纳入 quote，否则 quarantine。
- `body` ≤200，必须是 `rawQuote` 的连续子串，且保留支配它的否定/条件/归属（如“不要/如果/只要”）；若 governing sentence >200 且 body 无法保留限定 → quarantine，**不截断/不丢限定**。保留 `memoryMaxChars=200`、`titleMaxChars=30`、`lintText` errors；示例/比如/transient/secret 命中 → quarantine/skip；多 claim 拆成多个 body，每 packet ≤3，重叠去重。
- `body` 至少一个非代词实体 token、≥8 chars；否则只做 title+quote+source 或 skip；不得 auto 残句/纯代词句。
- `subject` 只展示/排序，不指定 supersede 目标；supersede 目标由 quote 内旧/新 value token 与现有 item 匹配解析；模型 subject 与解析冲突 → quarantine。
- additive（也/还/另外/同时/too/also）→ update/merge；replacement（改成/改为/换成/默认用/不用/不再/now use/instead）才 supersede；additive 永不 supersede。替换必须完整证据、唯一 target、旧/新值、full token、非否定反转、CAS。
- 临时（这次/临时/先/暂时/今天/下次）无持久标记（以后/长期/默认/一贯/always/from now on）→ session note/skip；持久标记才 auto。
- review `learning` 维持 **failing tool**（`!tool.ok`）；tool evidence 的 `kind:"tool"`/`messageID` 指 tool 而不是 user，`quote` 对 digest 校验，新增 `toolCallID/partIndex/digestHash/rawHash?`；tool 不替代 user 身份。preference/global 仍需 user `EvidenceRef`；learning 默认 project，global 仍走同一高证据门。U1b 负责 review/input/validate/accept 的 raw/shown 与 tool 桥。

## 6. 写入、生命周期与 P01

**单一 auto 门**：`ClaimProposal → validateClaim → decideAutomation → P01 writer`。turn/review 只是证据来源；旧 `classifyAuthority/workflowSafe` 删除，不在其上包新名字。`review-origin` 的 legacy 硬拒绝只保留在 `automation.enabled=false` 的 `canAutoApply`；`enabled=true` 走 `EvidenceRef` admission，rule/skill 仍 manual。  
**durable retired-source index（H5，只读 P01 + 最小退休索引）**：
- `retired-sources.jsonl`：键 = `sessionID|messageID`（**message-level**，改 seed/quote/respan 不能绕过）；每行只存 `sessionID/messageID`、`items:[{itemID,changeID,reason:"deactivate"|"revert"|"undo",claimKey?}]`、`quoteHashes[]`、`firstRetiredAt/lastRetiredAt/version`；不存 rawQuote，不随 90d ledger 过期。
- 写入：`deactivate`/`revert-with-before`/`undo` 的用户动作必须在**同一 P01 `store.transaction`** 内写 retired index；动作成功但索引漏写不允许。P01 suppression 行为不改、不重复写。
- capture 先查 message-level 退休键：命中 → `skipped:retired-source`；同一 message 的 seed/quote 变化仍命中；只有**新 messageID** 或对应 item 的**显式 restore/reactivate** 可再学。
- 多 claim 同消息：采用 message-level 粗粒度，`items[]` 记录被停/被撤销的 item；显式 restore 一个 item 只移除对应 entry，若仍有其他 entry 则整条消息仍退休；全部移除才删除。**UX 成本**：同消息其他未停 claim 的新学习也会暂停，状态可见，不隐藏。
- `restore`/`reactivate` 只移除对应 item 的 retired entry；restore 前捕获的 pending/cache 仍按 `originEpoch`/`baseItemVersion` 判 stale，不因清除而复活。`revert-with-before`：把被撤销的**新值 item/source** 加入 retired；恢复的旧值仍保留在 item 内容，不另建 pending；message-level 会同时挡住该消息的旧 pending，这是保守代价，不删旧值。
- retention/容量：不设 90d 过期；`retiredSourcesMax=2000`/200KB，满 → `blocked:retired-source-capacity` 背压，不驱逐未过期条目；只有**host 明确 source/transcript 永久删除证明**才可 prune，不能拿“无旧 job/90d”当证明。`originEpoch`/`baseItemVersion` 仍判 stale；restore 前捕获的 pending/cache 不能复活；停用父项不自动复活 child（P01 upstream 检查保留）。

**P01 实测（不改、不重复实现）**：
- `deactivateItem` 写 suppression（`changes.ts:263`，reason `deactivated`）。
- `revertChange` 仅在结果 `archived`（无 before 快照）时写 suppression（`changes.ts:455-457`）；`revert-with-before` 用 `expectedVersion` CAS 恢复旧版本，不写 suppression。因此 P03 不能假设“所有 undo 都写 suppression”。
- `suppressSource` 同时写 turn/review 两套 source key（`suppression.ts:30-34,41-76`）；`itemContentVersion` 只含 title/text/kind/scope/projectKey/status（`fingerprint.ts:11-15`），**EvidenceRef、linkGroupID、retired 元数据不得进入**。

**生命周期**：
- 每个 proposal 带 `baseItemVersion`（模型调用前快照）+ `originEpoch`（capture 时该 source/item 的 latest changeID/tombstone epoch）；写入用该版本 CAS；写前不偷填 current。版本/epoch 不符 → `stale:base-version`/`stale:epoch`，不写。
- 写前重查 turn+review source tombstone/`isSuppressed`、item `archived/deactivated`、当前 relation/CAS、origin 重导；任一失败 → `skipped:source-changed`/`stale`，不是 72h 观察。
- `origin` 重导与持久 `originProjectKey` 不一致 → `origin_drift` quarantine/no write；session 重绑 B 不写 A。
- stop/undo 后旧 in-flight/pending/cache 结果：baseVersion/status/suppression 任一不符 → 丢弃；不得复活。
- cache hit 仍走 source/status/baseVersion/relation 重验，不绕过。
- 配置：`automation.enabled` 默认 false；`POST /api/automation/mode` 单事务 `enabled+shadow`，revision 不符 409；`effectiveMode/blockedReason/retryAt/lastSuccess` 现算；`lastSuccess` 只随真实 add/update/supersede；旧 API 形状保留；`shadow=true` 只写影子；`undo.retainDays=90`、停用无时限；`undoWindowHours` 仍是未接线 legacy。

## 7. 预算、pending、故障恢复

```ts
interface StructuredGenerate {
  generate(input: { purpose: "p03-extract";
    model: { providerID: string; id: string; variant?: string };
    prompt: string; schemaVersion: 1; cacheKey: string; signal?: AbortSignal;
  }): Promise<{ text: string;
    usage?: { inputTokens: number; outputTokens: number };
    cached: boolean; attempts: number; requestID?: string }>;
}
```

- **原子双预算**：`Store.takeAutomationModelSlot({dailyLimit=40, hourlyLimit, now, purpose, extractEligible})` 单锁同时检查日+共享小时并递增；任一失败都不递增。**extract 日 floor=min(8,dailyLimit)、小时 floor=min(1,hourlyLimit)（pending 年龄 >15min）**；有 pending 时 review 当日最多用 `dailyLimit-floor`、该小时最多 `hourlyLimit-1`；无 pending 时 review 用满。`hourlyLimit<=floor` 时按“最老 pending / 最老 due review”交替；review 连续 2 小时无 slot 则下一 slot 给 review。不新增 provider/预算/上限。
- **Extract 调用契约**：`StructuredGenerate` 是唯一接口；extract **继承** `config.review.transport`/`config.review.model`（含 provider/id/variant），不新增 `automation.model`/provider/UI；transport 不可用 → degraded，不 fallback。`ModelCaller` 复用代码但 **circuit/failures/cache 按 purpose 隔离**；extract 失败不打开 review circuit。cache key 含 purpose/transport/provider/model/variant/promptVersion/schemaVersion/sessionID/seedHash/originEpoch/targetSetHash/rawHash/shownHash/transformVersion/originProjectKey/ownerVersion/redactionProfileVersion；命中仍重验来源/抑制/baseVersion/CAS，`ClaimProposal.messageID` 忽略/重绑当前 seed；cache 独立 200 条/24h。`generate.text` 返回 `unknown`，必须校验 `{text:string}`；usage 仅在真实返回时记录，不伪造。
- **预占/崩溃**：reservation 先写 `reserved`，dispatch 后 `dispatched`，终态 `completed|failed|abandoned`；崩溃遗留按 attempt/reservation 保守计数，不退；不声称真实 network exactly-once。`usage` 缺失记 `usageMissing`，不伪造成 token。
- **缓存/预检**：cache/preflight 在 reserve 前；`StructuredGenerate` 返回 `{text, usage?, cached, attempts, requestID?}`；cache hit `attempts=0` 不占；repair/retry 每次 dispatch 重新 reserve。
- **单飞/并发**：全局 `claim("extract:worker")` 并发 1；batch ≤8；per-session pending lease；不按 session 多开。
- **in-flight**：记录 `configRevision/enabled/model/prompt/schema`；返回后写前重读；disabled 或 revision/model 变化 → discard/abort，不写；pending 回 `retry_wait`，最多 3 次。
- **预算/容量/离线**：一律 `retry_wait`，绝不 `skipped`；当日不足给 **nextday retryAt**，不退款、不伪调用。pending 满（50/200KB）→ **暂停新 capture + `pendingFull` 计数**，不静默丢；pending 年龄/`lastExtractAt` 可见，>24h 显示“普通记忆延迟”；expired 聚合进活动“N 条未学习（提取延迟>72h）”，无永久待办。
- **quarantine**：沿用 200/72h，不注入/不 queue/不催办；只计数/原因。

## 8. Source provenance 与 privacy

- `transform` 全量分区；host 标记为 synthetic 的段不学；quote 必须落在 host 标记 user-authored 区。host 不能标记时，只接受“无合成形状、无引用上下文”的消息；否则 skip。
- 用户粘贴引文/角色文本：`attributed:true`，最多 `reference`，永不 `preference`；含执行/授权 → quarantine。例外：外层明确“记住/以后用/默认”且内层无执行/授权，可升 `preference`，但 quote 必须覆盖外层意图。
- **A/B/C 分层**：A = 可结构证明（marked synthetic/role/source/transform）；B = 冻结未见语料衡量（引用/角色/语义）；C = 未标记 host 合成与真用户文本不可区分。A 的结构测试不能证明 C；C 不写 hard-negative 0 auto，真实 host 必须验 part provenance/source 契约；不成立 → 自动模式 **blocked**，fake host 通过不能遮盖。
- Privacy：`rawQuote` 只在 `PendingEvidence`（临时）或 `EvidenceRef`（唯一持久 canonical）之一；`ChangeEvent`/`QueueItem`/`ReviewEvidence` 只存 `evidenceRefID`/hash+offset，不复制 quote；item body 是 ≤200 投影；活动页 redacted preview；列表 API 不额外暴露完整 quote；`EvidenceRef` 不改变 `itemContentVersion`，queue 预览如因新 evidence 变化需刷新。`rawQuote` 可能等于短消息；不声称从不存完整短消息，但不镜像 transcript。active item evidence 随 item；queue/review 90 天封顶；pending 72h；无全量 transcript。

## 9. UX（P05 全量，非 P03 实现）

| 状态 | 含义/文案 | 恢复 |
|---|---|---|
| 已学习 | 真实 add/update/supersede + 撤销 | 随时 stop |
| 未学习（72h） | “未学习，72h 自动清除，不注入”；只计数/原因，无 per-item approve | 自动清除；再说一次可新学 |
| 等待提取 | 后台提取中，不催办 | 自动 |
| 提取延迟/失败 | 预算/离线/parse；显示 retryAt/原因 | 自动 retry；可见 |
| 归属未确认 | “本会话暂停自动记忆/召回；已有记忆仍可用；新消息自动重试” | native owner 到达自动恢复；可关闭自动记忆；不手工 pin |
| 子会话 | “子会话不学习” | 正常状态 |
| 容量阻断 | “停止学习新记忆；已有记忆仍可召回” | 回收/backoff 后恢复 |
| 影子 | “本来会写入” | 切 autonomous 后生效 |
| legacy rule/skill | 设置›高级维护；活动页不催 | 人工 |

- 360px 真实最小视口；rail 260/320；44px 触控；无横向滚动；键盘、撤销持久、停止无期限、90 天回退、无“仅恢复文本”、无假删除、无“100% 安全”、无“不会执行”。
- `lastSuccess` 文案“上次学到新内容”，不是“上次成功”；owner unknown 不显示“project 记忆仍安全召回”。

## 10. 模块边界（P03 后端契约/状态；P04/P05 独立）

| 单元 | 产品文件（≤3–5） | 责任 |
|---|---|---|
| U0 Types | `types.ts`（可选字段/契约，先做） | EvidenceRef.id、linkGroupID、pending/retired/global ledger 类型 |
| U1 Evidence core | `session/reader.ts`、`session/normalize.ts`、`redact.ts` | readForEvidence、canonical/offset/partMap、secret-only |
| U1b Review bridge | `review/input.ts`、`review/validate.ts`、`review/accept.ts` | raw/shown、user/tool evidence、learning failing tool |
| U2 Extract | `review/provider.ts`、`review/extract.ts`、`review/parse-extract.ts` | StructuredGenerate、ModelCaller、cache |
| U3 Pending/Ledgers | `store.ts`、`memory/pending.ts`、`memory/global-candidates.ts`、`memory/retired-sources.ts` | DTO、lease、TTL、reserveBoth、崩溃、globalCandidate、retired index |
| U4 Admission/Evidence | `automation.ts`、`memory/claim-validate.ts`、`memory/evidence.ts` | 正类、span/body、关系、CAS、lifecycle、EvidenceRef GC |
| U5 Ownership | `plugin.ts`、`consolidate.ts`、`session/filters.ts` | native owner、U1/U2、batch、capture |
| U6 Backend status | `server.ts`、`memory/status.ts` | mode/degraded/pending/expired/retired/global 只读 |
| U7 Integration | `plugin-hybrid.test.ts`（测试） | setupPlugin/fake host 整链 |

- P03 不实现 `console`/P05 UI，不实现 P04 recall；只提供 `effectiveMode/pending/degraded/ownership` 只读字段。P04 recall、P05 frontend 独立阶段，全量目标不变。
- `types.ts` 先行；U1b 认领 review 原始证据改造；每单元 ≤5 产品文件，后续 `writing-plans` 拆短任务。

## 11. 验收与 host 关口

**设计审批 gate（现在）**：协议自洽/可实现/语料方案冻结即可；不要求未实现代码此刻跑过，不产生“代码前先过未来测试”死锁。检查：所有权/来源/生命周期/预算/UX/模块边界无矛盾；resolution 报告逐 ID 有处置。

**实现 release gate（未来实跑）**：
- G1 冻结语料：实现前 seed/hash；两个独立 breaker 只读设计与公开行为，不读实现 regex/validator；fresh reviewer 复核；agent-assisted 标源，不假 human gold。
- G2a hard-negative auto=0（A/B 冻结语料）：F17 family（tail、否定/条件/归属、跨句指代）+ 未见组合；capability 类（privilege/arbitrary exec/install/credential storage/export/security bypass/external transfer）；带标记的 synthetic/role（不得学）；带标记 quoted doc **作为 preference/授权**（reference/attributed 可）；authority（legacy record、owner conflict、origin drift）；global（worktree、mixed batch）；lifecycle（stop/undo/cache）。0 是该语料 0，不是数学证明。
- G2b C host 能力 gate：未标记 host 合成、无标记 role/quoted doc 与真用户文本不可区分；**不放进本地 0 auto 保证**；真实 host 必须验 part provenance/source 契约；fake host 不计通过；不成立 → automation blocked/observe。设计审批只检查 gate 可实施，不要求现在跑过。
- G3 adversarial model：诚实提案 + benign hint/恶意 span + 错 kind/scope/subject + 非 quote 子串 + 伪造 ID；非诚实提案不得 auto。
- G4 positive coverage：P1–P5 及同类自然表达必须 auto；报分母，不设 99%，不以宁缺毋滥暗缩。
- G5 structural：legacy record 0 写；两 worktree 0 global；mixed batch 不可能；stop/undo 0 复活；**same messageID re-scan/respan 0 auto**；retired index 满背压；origin drift 0 写；globalCandidate 90d 到期 invalidation、promotion 单副本/linkGroup 无重复注入；budget/expiry 0 静默丢。
- G6 UX：360/rail 260–320/44、无审批徽标、状态可恢复。
- G7 retention：P01 event/WAL/CAS/undo/90d；P04 owned；P05 全量；P06 保护；无新 provider/service/budget；无 host 硬拦声明。

**Host 能力早期关口**：真实 host 必须验 `part provenance`/source 契约、created/get 原生字段、transcript 可重读、owned block 语义；任一不成立 → automation blocked/observe，不得越过该关口堆完整管线，不得用 fake host 通过宣称可用。

## 12. 未决（U，不是虚假已解）

- host 是否交付 `session.created.data`/`SessionInfo`、是否按目录过滤事件、是否对 system/工具限权、`generate.text` 是否内部启用工具/子会话：U；runtime 不交付按 §4 safe degradation。
- host 能否重读 transcript/原文重算 hash：不能则自动模式整体 degraded，不是每条 72h 观察。
- host 是否提供 source/transcript 永久删除证明：没有则 retired-source 索引只增/背压，不按 90d 或无 job 自行 prune。
- 未标记 host 合成 vs 真用户文本不可区分（C）：只能靠真实 host provenance 契约；fake host 不能证明。
- 旧 `ReviewRecord` 历史污染范围未知；P03 阻止新污染，不证明旧记录干净。
- P04 owned 失效/P06 host gate 未证；不声称最终已可用。
- **批准时需知道的真实取舍**（默认已定，不是现在要求选）：旧 session 无原生 owner → observe-only 覆盖成本；extract floor 8/day 会占 review 吞吐；body 抽取式可读性取舍。默认安全/忠实优先；拒绝只能改目标或要求 host 原生 provenance，不能放宽写入。
