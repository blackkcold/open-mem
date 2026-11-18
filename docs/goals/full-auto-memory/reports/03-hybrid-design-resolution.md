# P03 Hybrid v2/v3/v4 — review resolution ledger

Status: **设计修订记录，不是独立复核通过，也不是用户批准。** 候选 v1 存 `tmp/full-auto-memory/reviews/hybrid-design-v1.md`；v2 存 `hybrid-design-v2.md`；v3 存 `hybrid-design-v3.md`；v4 为本轮唯一 design diff。无产品代码/测试/真实 host/模型/配置/提交；所有未来验证 **not-run**。
Inputs: `03-hybrid-builder-review.md`、`03-hybrid-builder-resolutions.md`、`03-hybrid-safety-review.md`、P01 精确实现核对。  
Rule: 每条给处置、证据/兼容、剩余 U；不把“文档已改”写成“已实现/已通过”。

## 1. B1–B9 处置

| ID | v2 位置 | 处置 | 证据 / 剩余 U |
|---|---|---|---|
| B1 | §4.2 | `ReviewRecord.ownershipEvidence`（source/keySource/sourceHash/at）；ready/queued 非权威；legacy 无字段 observe；context/instance 只 hint | `types.ts:38-64`、`orchestrator.ts:476-480`、`plugin.ts:299-300`；旧记录污染范围 U |
| B2 | §4.1 | created.data/SessionInfo 原生 `projectID/directory/parentID`；`projectKey=sha16(canonical)`；有效 created/get 且 parent 缺失才 root；U2 不打 key | SDK `session-event.d.ts:34-56`、`v1/session.d.ts:1555-1576`、`plugin.ts:602-637`；runtime 字段交付 U |
| B3 | §3.2/§3.3 | 内存 Packet vs 持久 Pending 分离；pending 不含 raw/shown；UTF-16 offset；reader 4000 前快照；partMap；secret-only vs path | `reader.ts:32-36,150-160`、`normalize.ts:43-46`、`redact.ts:23-41`；host 重读能力 U |
| B4 | §5 | 保留 200/30/lint；body 必须是 rawQuote 连续子串且 ≤200；不截断/不绕多 claim；review-origin 只 legacy 硬拒 | `config.ts:81-83`、`linter.ts:64-77`、`consolidate.ts:921-923`；语义质量归 held-out |
| B5 | §7 | `takeAutomationModelSlot` 单事务日+小时；reservation 保守；cache/preflight 前置；全局单飞；in-flight 写前丢弃；floor 8/day + 1/hour | `store.ts:670-681`、`provider.ts:282-284`；exact-once 不可证，按 attempt 语义 |
| B6 | §7 | 唯一 `StructuredGenerate`；继承 review transport/model；ModelCaller 代码复用、circuit/cache 隔离；cache key 含 shown/transform/owner；200/24h | `plugin.ts:101-123,464-470`、`provider.ts:125-219`；generate 内部工具 U |
| B7 | §5/§10 U1b | learning 维持 failing tool；tool evidence 不替 user；review/input+validate+accept 归 U1b | `review/validate.ts:170-172`、`review/input.ts:86-102`；tool raw 大输出保留 digest 边界 |
| B8 | §10 | P03 后端契约/状态；U0 types 先行；U6 无 console；P04/P05 独立阶段 | `console/src` 约 40 文件，不能充当 ≤5 单元；全量目标不变 |
| B9 | §9 | 360px、rail 260/320、44px；390 仅设计稿，不是验收替代 | `ux-contract` S12/任务硬约束；无 U |

## 2. H1–H10 处置

| ID | v2 位置 | 处置 | 证据 / 剩余 U |
|---|---|---|---|
| H1 | §3.4/§5/§11 G2 | 正类准入：descriptive/procedure/benign-workflow；instruction/authorization/unknown 不 auto；tail high-impact vs precondition safe；blocklist 只 deny | 安全 C1/C3、P1–P5；F17 family 冻结负例 0 auto 是 release gate，不是数学证明 |
| H2 | §5 | quote 必须完整 governing sentence；否定/条件/归属必须覆盖；body ≤200 不截断限定；subject 只展示；additive 不 supersede | 安全 C2/C3/P3/P4；语义质量归 held-out |
| H3 | §4.2 | legacy record 不能洗白；只接受带原生 evidence 的 record；冲突 fail closed；evidenceRepos 只算 verified | 安全 C6；旧污染范围 U，不回溯证明 |
| H4 | §4.1/§4.2 | projectKey 与 repoIdentity 分离；两 worktree 同 repo 不凑 global；单项目 batch；显式 global 仍 auto | 安全 C7/P5；repoIdentity 其他项目需 host native，不扫描；不可证不计数 |
| H5 | §6 | P01 deactivate 已写 suppression；revert-with-before 不写但 CAS/baseVersion 覆盖；source tombstone 读 ledger；source-changed 终态 skipped；host 不可读 degraded | `changes.ts:263,455-457`、`suppression.ts:30-34,41-76`、`fingerprint.ts:11-15`；不重复实现 P01 |
| H6 | §8 | transform 全量分区；host-marked user region；引用/角色 attributed；A/B/C 分层；未标记合并是 C，不能硬负例 0 auto；真实 host provenance gate | 安全 C4/C5；C 残余 U；fake host 不覆盖；未证则 blocked |
| H7 | §7/§9 | budget/容量/离线 retry_wait；floor `min(8,daily)`/`min(1,hourly)`；pending full 暂停采集；expired 聚合；无永久待办 | 安全 C9；公平成本已定，不新增预算 |
| H8 | §9 | “未学习”非“观察待批”；无 per-item approve；owner unknown/child/capacity/shadow 分开；360/rail/44 | 安全 C10；360 手测未来 not-run |
| H9 | §5 | 每 packet ≤3 claim；重叠去重；body ≥8 chars + 非代词实体；transient 无持久标记 skip；additive merge | 安全 P3/P4；可读性/语料质量归 held-out |
| H10 | §8 | rawQuote 只在 pending 临时或 EvidenceRef 持久一处；其他层 ref/hash/offset；activity redacted；EvidenceRef 不入 itemContentVersion | `fingerprint.ts:11-15`；短消息可等于 rawQuote，不声称从不存完整短消息 |

## 3. P01 实测（不重复实现）

- `deactivateItem` 在 `changes.ts:263` 调 `suppressSource(..., "deactivated")`；turn/review 两套 key 由 `suppression.ts:30-34` 生成。
- `revertChange` 仅在结果 `archived`（无 before）时 `suppressSource(..., "reverted")`（`changes.ts:455-457`）；`revert-with-before` 用 `expectedVersion` CAS 恢复旧版本，不写 suppression。v2 因此增加 **source tombstone 读 P01 ledger + baseItemVersion**，不修改 P01。
- `itemContentVersion` 只含 `title/text/kind/scope/projectKey/status`（`fingerprint.ts:11-15`）；v2 明确 `EvidenceRef` 不进入，避免破坏 stop 后下一次请求失效。

## 4. 工程默认（批准时需知道；不是现在要求选）

1. **旧 session 只有派生 `contextProjectKey`** → 默认 observe-only，不自动写/召回；native created/get/verified record 到达自动恢复；不手工 pin。理由：跨项目安全优先。这是真实覆盖成本；若用户要更高覆盖，只能要求 host 提供原生 provenance，不能放宽写入。
2. **预算**：40/day + 小时上限不提高；extract floor 8/day + 1/hour，review 在有 pending 时最多 32/day；成本是 review 吞吐可能下降，已写进状态；默认不加预算。
3. **body 形态**：默认抽取式（用户原话 ≤200 投影），title+quote+来源补偿可读性；不接受用模型自由改写 body 换“好看”。这是真实可读性/忠实取舍；默认忠实优先。

## 5. 剩余 U（不阻塞本次设计修订，阻塞“最终可用”声明）

- host 是否交付 `session.created.data`/`SessionInfo` 原生字段、是否按目录过滤事件、是否对 system/工具限权、`generate.text` 是否内部启用工具/子会话。
- host 能否重读 transcript/原文重算 hash；不能则自动模式整体 degraded，不是每条 72h quarantine。
- 未标记 host 合成 vs 真用户文本不可区分（C）；只能真实 host provenance 契约证明，fake host 不能。
- 旧 `ReviewRecord` 历史污染范围未知；P03 阻止新污染，不证明旧记录干净。
- P04 owned 失效、P06 host gate 未证；不声称最终已可用。
- 所有 release gate（G1–G7）当前 **not-run**；本文件不是复核通过，候选仍待两 reviewer 限 v2 diff 复核与用户批准。

## 6. v3 窄口追加（N1–N3、H1/H4/H5/H6、H2/H7）

| ID | v3 位置 | 处置 | 剩余 U / 证据 |
|---|---|---|---|
| N1 | §3.2/§7 | capture 句界 seed ≤500、非前 500 字、seed 不可变；模型 quote/body 在 seed/quote 内；offset canonical UTF-16；cache 绑 session+seed，messageID 重绑 | 长消息单句 >500 的拆分质量归 held-out；不声称全覆盖 |
| N2 | §4.1 | 旧 `scopeKey=sha16(ctx.location.project.canonical ?? directory)` 逐字不变；canonicalize 只匹配；exact/subdir own、worktree foreign、projectID 冲突 fail closed | runtime 无 `ctx.location.project.id` 只 exact；host 原生字段 U |
| N3 | §4.1 | created 缺 parentID 先 unknown；完整 get 或已证 host contract 才 root；失败 degraded 自动重试 | 旧 host 无 get 覆盖下降但安全；不猜 root |
| H1 | §3.4 | 正类 stative/safe-action + capability 闭合类（privilege/exec/install/credential storage/export/bypass/external transfer）；hint 只 deny；安全工程正例保留 | 能力判定是 B 有限语料质量门，不声明数学安全 |
| H4 | §4.2 | 保留两可信 repo 证据：有界 `global-candidates.jsonl`（200/200KB/90d），单项目 batch、ref/hash、claimKey 匹配、工作树同 repo 不计数、撤销再验、满则背压 | 不同 repo 同值但限定不同不升；expired 聚合非审批 |
| H5 | §6 | 只读 P01：deactivate 已 suppression、reactivate clear、revert-with-before 无 suppression；P03 source tombstone + originEpoch + baseVersion + 90d、清除前无重放、容量 blocked 不删 | P01 不改；恢复后旧 pending 仍 stale；child 不自动复活 |
| H6 | §11 | G2a A/B 冻结 hard-negative=0；G2b C host provenance gate（untagged 不可区分只属 C，fake host 不计通过，失败 blocked/observe） | 设计审批只查 gate 可实施，不要求现在实测；host 能力 U |
| H2 | §5 | 补跨句指代/前句条件：`那样的话/这样的话/那么/否则` strict subspan 或前句未纳入 → quarantine | B 语义残余 held-out，不阻塞 |
| H7 | §7 | `hourlyLimit<=floor` 时最老 pending/due review 交替；review 连续 2h 无 slot 下一个给它；不新增预算 | 合法配置边界；未来 fixture 验证 |

## 7. O1–O3 窄接口决议（v3 后）

| ID | 决议 |
|---|---|
| O1 | `EvidenceRef` 新增稳定 `id = "ev:" + sha256(canonical tuple: sessionID/messageID/offsetStart/offsetEnd/seedHash/quoteHash/rawQuoteHash)`；由本地 `EvidenceResolver` 在 claim 通过 host raw/offset 校验后生成，模型/pending 不得提供。持久 canonical 存 `evidences.jsonl`（每 id 一行）；`ChangeEvent/QueueItem/ReviewEvidence/globalCandidate` 只存 `evidenceRefID`/hash，不复制 quote。`store.transaction` 同事务写 evidence row + item/change/queue；失败整体回滚。pending 72h 只有 `seedId`，claim 验证后才生成 `EvidenceRef`；禁止拿 pending id 当 90d 外键。retention：active item/queue/review/globalCandidate 引用保护；无引用且超 90d 才清；容量不足 `blocked:evidence-capacity`，不删仍被引用的 ref；缺失 ref → degraded/fail closed。所有持久 `offsetStart/End` 指 `canonicalText` 的 UTF-16，不指 shown。 |
| O2 | `sourceIdentityKey = "src:" + sha256({turnHookKey, reviewHookKey})`（`suppression.ts` 两键；任一缺失 → undefined，不 capture）。capture 在模型前用既有确定性 relation/guard 对 seed 算候选 target 集（≤8），冻结 `targets:[{itemID,baseItemVersion}]`、`targetSetHash`；`originEpoch = "ep:" + sha256({sourceIdentityKey, targetSetHash, latest source changeID/tombstone epoch})`。三者持久写入 `PendingEvidence`；模型返回只作 `ClaimProposal` 内容，本地生成 `ProposalEnvelope {proposalID,pendingID,sourceIdentityKey,originEpoch,targetSetHash,targetID?,baseItemVersion?}`，模型不得填。模型 target 不在冻结集合 → quarantine；不按 current 补 target/version。写事务用冻结 `baseItemVersion` CAS；pending/restart/cache hit 一律读持久 epoch/versions，不重算 current。cache key 加 `originEpoch/targetSetHash`；hit 仍重验 P01 ledger/source/status/baseVersion，失败 `stale`。恢复后新捕获是新 pending/new epoch；恢复前 job 不得借用新 epoch。 |
| O3 | global 证据 <2 时用现有 `Item.invalidatedBy` + `invalidatedAt`，**status 不变**；写 `ChangeEvent kind:"invalidate" actor:"system" reason:"global-evidence-below-2"`；P04/memoryVersion 已排除 invalidatedBy，不注入。不新增 `stale` status；`itemContentVersion` 不因 invalidatedBy 改变。≥2 再现时**不自动恢复旧 item**，走新 global admission 建新 item；旧 item 保持 invalidated；用户显式 stop/suppression 优先；invalidated child 仍走上游检查，不自动复活。`claimKey` 的 polarity 由本地 validator 从 quote/否定解析并校验，模型无 polarity 字段；无法判定 → 不入 candidate。 |

**O1–O3 已并入候选 v4（§3.2/§4.2）；仍是设计接口，不是实现/测试通过。**  
**v4 未跑任何代码/语料/host；候选仍待 reviewer 限 v4 diff 复核与用户批准。**

## 8. v4 合并处置（O1–O3 + H5/H4）

| ID | v4 位置 | 处置 | 剩余 U |
|---|---|---|---|
| O1 | §3.2 | `EvidenceRef.id` 稳定生成、`evidences.jsonl` canonical、同事务写、pending seedId 不作外键、引用闭包 GC、90d 引用保护 | 容量阈值实现；host 删除证明 U |
| O2 | §3.2/§7 | `sourceIdentityKey/originEpoch/targetSetHash/targets/baseItemVersion` 持久、capture 前冻结、`ProposalEnvelope` 本地、cache key 绑定 | 候选 target 集大小/质量归实现与 held-out |
| O3 | §4.2 | 新建 global + linkGroup，archive project 副本；TTL 到期 `invalidatedBy/invalidate/system`；不自动恢复；新 admission | 裸值两 repo 是 B 风险，不包装结构证明 |
| H5 | §6 | 新增 durable `retired-sources.jsonl`（message-level、无 90d、最小身份、同 P01 事务、容量背压、host 删除证明才 prune）；restore 仅清对应 item；同消息其他 claim 暂停学习成本明示 | 旧 host 无删除证明则容量最终背压；P01 不改 |
| H4 | §4.2 | promotion 单副本/linkGroup/stop 覆盖/TTL invalidation；claimKey 加 kind/source scope/valueBearing/polarity，本地极性 | 裸值泛化是 B 残余；显式 global 不缩 |

**v4 未跑任何代码/语料/host；候选仍未批准，待两 reviewer 限 v4 diff 复核与用户批准。**
