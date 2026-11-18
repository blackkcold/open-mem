# P01 reversible-memory — 独立审查

Reviewer: 独立审查 subagent（非实现者，未改产品代码）
Date: 2026-11-11
对象: 工作树未提交改动（diff 包 `tmp/full-auto-memory/reviews/p01.patch`，202251 bytes，4562 行；HEAD 仍 `b992a2e`）
依据: `phases/01-reversible-memory.md`、`reports/01-reversible-memory.md`、`DESIGN.md` §5.4/§7/§8.1、`ACCEPTANCE.md` §2
方法: 只读代码 + 静态审查 + 3 个 tmp 复现脚本（不跑作者完整 verify；仅定向重跑 `context-version.test.ts` 12/12 通过以确认工作树状态）
安全边界: 全部复现在 `mkdtemp` 临时 dataDir 中，未触碰真实 `~/.config/opencode`、正式 dataDir、配置与 UI，未发任何模型请求

## 0. 裁决

| 裁决 | 结论 |
|---|---|
| **Spec verdict** | **有条件通过（2 项需修复后复审）**：§8.1 全部签名与 §5.4/§7 的原子性、CAS、抑制、版本、当次 context 替换均已落地并有可执行证据；但阶段文档明文要求的 `undo` 设置白名单未实现（I2），派生项在上游恢复后无法恢复使用（I1）破坏了本阶段“可逆”的核心承诺 |
| **Quality verdict** | **实现质量良好，但不建议直接作为 P02/P03 的冻结接口**：无 Critical，3 Important + 7 Minor；事务/WAL/CAS 设计正确，测试大体真实（含子进程 kill 点重放）；主要问题是恢复生命周期不闭环、配置白名单缺口、以及报告 §3.9 的一处证据陈述与仓库不符 |

Critical: **0**。

## 1. Important

### I1. 上游恢复使用后，派生项永久停留在“已失效”，`reactivateItem` 还给出错误原因

- 路径: `plugin/src/changes.ts:240-296`（`reactivateItem`，`invalidatedBy` 判定在 `:258`）、`plugin/src/changes.ts:527-583`（`invalidateDerived`）、`plugin/src/plugin.ts:1221-1240`（`buildContext` 过滤 `invalidatedBy`）、`plugin/test/derived.test.ts:151-167`
- 复现（`tmp/full-auto-memory/reviews/probe-p01.ts`，已实跑）:

```text
deactivate A ok: true
B after A stop -> status: auto invalidatedBy: item_a      # B 不归档，只打失效标记
B injected while invalidated: false
reactivate A ok: true
B after A resumed -> status: auto invalidatedBy: item_a   # A 已恢复，B 标记不清
B injected after upstream resumed: false
reactivate B result: {"ok":false,"code":"conflict","message":"该条目仍在生效，不需要恢复使用"}
deactivate B ok: true
reactivate B after explicit deactivate: {"ok":false,"code":"conflict","message":"该条目的上游已撤销或停用，不能恢复使用"}
restoreVersion(add event of B) ok: true
B injected after restoreVersion workaround: true
```

- 违反要求: 阶段文档 §2「停止使用后随时可恢复使用」与 DESIGN §7.3「恢复安全：…检查 upstream 全部 active…任一上游无效则拒绝恢复」的反面（上游已 active 时应可恢复）；用户在 A 上反悔后，B 无法通过任何“恢复使用”动作回到注入，只能走语义完全不同的 `restoreVersion`（回写旧正文并清抑制）。B 也没有被用户“停止使用”，`deactivateItem`→`reactivateItem` 也无法救回（先被 `invalidatedBy` 挡住）。
- 测试为何没暴露: `derived.test.ts:151` 名为 “refuses to reactivate a row whose upstream is still stopped”，但 B 此时 `status === "auto"`（该测试自己在 `:160` 断言），`reactivateItem:252-254` 先在“仍在生效”分支返回 `conflict`，**根本没有走到 `:258`/`:264` 的上游检查**；断言只校验 `code === "conflict"`，因此用例以错误分支通过。
- 最小修复: 在 `reactivateItem`（以及 `restoreVersion` 成功后）对“以该 id 为上游、`invalidatedBy === 该 id`、status 为 auto/promoted、且其余上游都 active”的行清除标记并各写一条 `restore`/`update` 事件（同一事务、visited set 防环）；或让 `reactivateItem` 同时接受 `status=auto && invalidatedBy` 的行（上游全 active 时清除标记）。同时把 `derived.test.ts:151` 改成构造 `archived + derivedFrom → 已停用上游` 的行，断言确实走 `invalidUpstreams` 分支。

### I2. `undo.retainDays` 未接入配置白名单：`PATCH /api/config` 返回 200 但静默不生效

- 路径: `plugin/src/config.ts:76-78`（默认 90）、`plugin/src/config.ts:116`（`ConfigPatch.undo`）、`plugin/src/server.ts:1563-1668`（`applyConfigPatch` 无 `undo` 分支）、`plugin/src/server.ts:1670-1688`（`validateNumericPatch` 会接受该字段）
- 复现（`tmp/full-auto-memory/reviews/probe-p01b.ts`，已实跑）:

```text
PATCH /api/config {"undo":{"retainDays":200}} -> status: 200
disk config.json -> "undo": {"retainDays": 90}     # 未写入、无 changelog、无报错
```

调用链：`server.ts:1382-1383` 只调 `applyConfigPatch(diskNext/liveNext, body)`；`validateNumericPatch` 递归校验通过后 `applyConfigPatch` 不认识 `undo`，`changedFields` 为空，写盘后仍是旧值。因此“版本回退默认 90 天可配置”只能手改 `config.json`。
- 违反要求: 阶段文档文件表 `plugin/src/config.ts` 明列“新增 `undo.retainDays`（默认 90），合并/**校验**/**设置白名单**”；验收“版本回退默认 90 天可配置”。
- 最小修复: 在 `applyConfigPatch` 增加 `if (isRecord(body.undo)) assignNumbers(config.undo, body.undo, ["retainDays"]);`（`assignNumbers` 已有 `>0 && finite` 语义），并补一条 PATCH 持久化 + `restoreVersion` 实际使用新窗口的 API 测试（`restore.test.ts:105` 目前只测 `store.writeConfig` 直写，绕过了 API 白名单）。

### I3. 报告 §3.9 关于 `recordItemDiff` 的测试证据不存在；两个 legacy 撤销入口无任何覆盖

- 路径: `docs/goals/full-auto-memory/reports/01-reversible-memory.md:151`（“另有 `recordItemDiff` 覆盖 legacy `/api/recovery/:id/restore` 与 `/api/maintenance/:id/undo`”）、`plugin/src/changes.ts:122-149`、`plugin/src/server.ts:1134-1168`
- 复现: `grep -rn recordItemDiff plugin/test` → 0 命中；`grep -rln 'api/recovery' plugin/test` 只有基线 `api.test.ts`（不检查账本）；`grep -rn 'api/maintenance' plugin/test` → 0 命中。`recordItemDiff` 仅通过 `undoMerge` 被间接执行（`changes.test.ts:315-336`）。
- 违反要求: 审查依赖的证据必须可复现（“item 与事件同事务、所有写入路径都写事件”在这两条入口上未被验证）。同时静态审查发现同一函数的真实缺口：`:132` 只比较 `itemContentVersion`（title/text/kind/scope/projectKey/status），`expiresAt`/`aliases`/`sources`/`derivedFrom`/`invalidatedBy`/`supersededBy` 变化不产生事件；这些字段里 `expiresAt` 会改变 active 集合，`derivedFrom` 会改变递归失效边界。
- 最小修复: 补两条 API 级测试（mock 一个 recovery/maintenance journal，断言“每条 changed item 恰好 1 条事件 + 事务失败零写入”）；把报告 §3.9 该句改为“`undoMerge` 通过 `recordItemDiff` 被覆盖；recovery/maintenance 入口待补测”。若要覆盖字段差异，最小改动是把比较改为 `JSON.stringify(prior) !== JSON.stringify(item)` 或显式比较上述字段。

## 2. Minor

### M1. 压缩会为“完全没变化”的 canonical 写一条 `update` 事件（可复活下游失效）

- 路径: `plugin/src/compact.ts:92`（`if (kinds.has(canonical.id) || merged > 0) kinds.set(canonical.id, "update")`，`merged` 是全局累计值）
- 复现（`probe-p01b.ts`，已实跑）: 一个组有精确重复（merged=1），另一个组只有两个近似但非重复项 → 后一组 canonical 也被标 `update`：

```text
[compact] events: archive:item_a2, update:item_a1, update:item_b1
[compact] item_b1 before/after text equal: true | seenCount: undefined undefined
```

事件 `before`/`after` 内容完全相同（只换了 `changeID`），`revertible=true`。后果：账本/UI 出现幽灵可撤销项；用户撤销它会对 canonical 执行 `invalidateDerived`，把真实的下游记忆打上失效标记；同时它会挡住该条目更早变更的 `revertChange`（`changes.ts:353-360` 的“后续有事件”判定）。
- 违反要求: DESIGN §5.4 规则 1 的“每个改变…的操作写 1 条事件”被反向违反（无改变也写事件），并污染可撤销语义。
- 最小修复: 用 per-cluster 计数（`let clusterMerged = 0`，在 `merged += 1` 处同步自增），仅当本组确实合并过才 `kinds.set(canonical.id, "update")`。

### M2. `POST /api/items/:id/revert` 完全忽略 `:id`，可用 A 的路径撤销 B 的变更

- 路径: `plugin/src/server.ts:907-935`（`revertChange(store, body.changeID, …)`，`current` 仍按 `:id` 查）、`plugin/src/changes.ts:318-329`（只按 `changeID` 找 target）
- 复现条件: 两个条目 A、B；`POST /api/items/<A>/revert { changeID: <B 的 add 事件>, expectedVersion: <A 的 version> }` → B 被撤销并返回 200，`broadcast` 与 409 里的 `version` 却是 A 的。不需要越权（调用方已有 token 可直接撤销 B），但路由契约被破坏，客户端会刷新错误的行。
- 违反要求: DESIGN §8.1 该路由语义 `POST /api/items/:id/revert`；以及“响应包含当前 version”的 409 约定。
- 最小修复: 在 `revertChange` 增加可选 `itemID` 参数并校验 `target.itemID === itemID`，不匹配返回 `not_found`；server 用 `target.itemID`（或校验后的 `id`）生成 409 的 `version` 与 broadcast。

### M3. `restoreVersion` 可以“成功恢复”一个已经过期的快照：200 + 清抑制，但永远不注入

- 路径: `plugin/src/changes.ts:483-502`（`next = {...snapshot}`，未检查 `snapshot.expiresAt`）、`plugin/src/changes.ts:163-167`、`plugin/src/plugin.ts:1221-1232`（`buildContext` 过滤 expired）
- 复现（`probe-p01.ts`，已实跑）: 老版本 `expiresAt` 已过、当前版本 `expiresAt` 在未来 → 恢复老版本返回 `ok`，行 `status=auto`、`expiresAt` 在过去，`buildContext` 不含其正文：

```text
[expiry] restoreVersion ok: true
[expiry] after restore status: auto expiresAt in past: true
[expiry] restored text injected: false
```

- 违反要求: DESIGN §7.3「`restoreVersion` 把历史版本作为新版本重新生效」；实际是“成功但无效”，且已清抑制、写了 `restore` 事件，用户难以判断。
- 边界说明: 当前产品代码没有任何写入路径会给 `Item` 设置/更新 `expiresAt`（只在 curator/`memoryVersion`/`buildContext` 读取），所以这是潜在缺陷、不是已发生故障。
- 最小修复: 在写回前判断 `snapshot.expiresAt <= now` → `not_revertible`（与 `reactivateItem:261-263` 的过期拒绝一致）；或保留 `expiresAt` 但明确返回“已过期，需要重新学习”。

### M4. 建议写入改了正文后，同源抑制键与 hook key 不再相等（create/keep_both 车道）

- 路径: `plugin/src/memory/suppression.ts:41-76`（用 `item.text` + `aliases` 计算 key）、`plugin/src/consolidate.ts:855-861`（hook key 用原始 `candidate.text`）、`plugin/src/apply.ts:309-340`（`text` 取 `suggestion.proposedText`/人工编辑，且不写 alias）
- 复现条件: 队列项原始文本 `T`、建议改写为 `T'`，`create`/`keep_both` 落库 `item.text = T'`，`aliases` 未包含 `T`；之后停止使用该条目，抑制行是 `hash(T')`，而重新捕获同一条消息得到 `hash(T)` → `isSuppressed` 不命中。`merge_into`/`replace` 因为 `apply.ts:265` 把 `item.text` 追加进 `aliases` 不受影响；`approve`（`actions.ts` 用 `found.text`）不受影响。
- 违反要求: DESIGN §7.4「记录触发该 item 的 hook key（turn/review）与 textHash」及阶段文档「同一 source 的 turn 捕获与复盘捕获都会被抑制」。
- 最小修复: `apply.ts` 的 create/keep_both 分支在 `text !== item.text` 时补 `aliases: [...(item.aliases ?? []), item.text]`；或在 item 上持久化创建时的 `hookKey`/`textHash` 供 `suppressSource` 使用。
- 现状缓解: `captureHooks` 会按已有 hook 的 key 去重（`consolidate.ts:770-771`），旧 hook 未被裁剪前不会重新捕获，因此当前影响有限。

### M5. `recordChange` 用 `item.changeID` 当事件 id，但不查账本是否已存在（潜在重复 id）

- 路径: `plugin/src/changes.ts:70-72`
- 复现条件（当前无活路径，属 API 脆弱性）: 任何未来写入者把“未经 `newChangeID()` 重新标记的行”直接传给 `recordChange`（例如 P02/P03 新增的 update 分支复用了 `store.updateItem` 返回的旧行），事件 id 会等于该行**上一次**的事件 id：`changes.jsonl` 出现重复 id，`revertChange:325` 的 `findIndex` 命中旧事件，`writeChangeJournal` 覆盖旧 journal 的 `undone` 状态。现有 11 个调用点都先 `newChangeID()`（已逐个核对），所以是 latent。
- 违反要求: 阶段文档 R3 的“事件 `after` 与磁盘完全一致”、§5.4 规则 5 的事务/事件一一对应。
- 最小修复: `recordChange` 里若 `item.changeID` 已在 `changes.jsonl` 中出现，则生成新 id（或直接抛错要求调用方预生成），成本是一次 `listChanges` 或读取时去重。

### M6. `invalidateDerived` 扇出成本高（实测 300 子项 / 2301 条 = 12.3s），深度上限静默截断

- 路径: `plugin/src/changes.ts:548-581`（每个 child 都 `await store.listItems()` 全量重读，再 `replaceItem` 全量重写）、`:26`（`MAX_INVALIDATION_DEPTH = 20`）
- 复现（`tmp/full-auto-memory/reviews/probe-p01c.ts`，已实跑）:

```text
[fanout] items: 2301 children: 300 invalidated: 300
[fanout] elapsed ms: 12256
```

一个 `deactivateItem` 在一个写事务内持有文件锁 12.3s；同进程其它写入排队，另一个进程的 `withWriteLock` 5s 超时（`store.ts:238`）。深度 >20 时第 21 层之后的派生行仍会被注入，且 DESIGN §7.3 要求的“环/上限命中时记录”没有 changelog。
- 违反要求: DESIGN §7.3「递归标记…深度上限 + visited set 防环」「环检测命中时停止并记录」；无显式性能门槛，但“立即生效”的 UX 与写锁时长直接相关。
- 最小修复: 一次 `listItems()` 后在内存里算闭包，用 `store.applyItemChanges(before, after)` 一次写入并逐条 `recordChange`（仍保持 1 item 1 事件）；命中深度上限时 `appendChangelog({action:"invalidate_depth_cap",…})`。

### M7. `applyOwnedContext` 在正文含字面 `</context>` 时会截断替换，残留旧内容

- 路径: `plugin/src/plugin.ts:1057-1089`（`replaceOwnedBlocks` 找**第一个** `</context>`）
- 复现条件: 某条记忆的正文/标题包含字面 `</context>`（用户引用 OpenMem 块格式、或粘贴了插件自己的渲染产物）。宿主块为 `<context key="plugin.memory-autopilot">\n…</context>…</context>`，替换时只吃掉第一个 close，close 之后到真正块尾的旧正文留在 part 里；停用后仍可能被注入。
- 违反要求: 阶段文档 §5.1「被撤销/停用的正文不在受控块里」。
- 最小修复: 以“下一个 `<context ` 出现位置”为上界，取它之前最后一个 `</context>`；或在 `renderContext` 输出时把正文里的 `<context`/`</context>` 转义。

## 3. 实际检查维度与结论（通过项也列，避免“864 通过即批准”）

| 维度 | 结论 | 依据 |
|---|---|---|
| 无损快照（id/title/kind/scope/projectKey/status/source(s)/manual/expiresAt/derivedFrom/supersedes/invalidatedBy/aliases/changeID） | 通过 | `changes.ts:38-40` `structuredClone`；`changes.test.ts:95-153` 逐字段断言；`revert.test.ts:63-107` 断言旧版本整体回写（含 aliases/derivedFrom/expiresAt/seenCount） |
| item + 事件 + journal 同 WAL 原子 | 通过 | `store.ts:229-261`（事务只在 `withWriteLock` 的 batch 内进行，`readText/writeText` 读写同一 batch）；`changes.ts:68` 强制 in-transaction；`transaction.test.ts:131-207` 在**每个 rename 边界** `process.exit(73)`，断言“全成/全不成 + 未提交可重试”，并校验 `row.changeID === revertEvent.id` |
| CAS 与时间边界（deactivate/reactivate/revert/restore） | 通过（一处语义缺口见 I1） | `changes.ts:202/251/349/441` 均为 `itemContentVersion` CAS；`restoreVersion:483-490` 用事件 `at` 与 `config.undo.retainDays`；`reactivateItem` 无时限；`retention.ts:116-123` 保护 `supersededBy="deactivate"` 行不被 90 天清理 |
| 并发/重试/幂等 | 通过（性能见 M6） | 文件锁 + 进程内链；`revertChange:337-344` 以 journal `undone` 拒绝二次撤销；`changes.test.ts` 二次撤销用例；`api-items.test.ts:154-167` 409 零写入 |
| scope 不漂移 | 通过 | `restoreVersion:462-478` 校验 scope 与 project scope 的 projectKey；`restore.test.ts:177-192` |
| 递归失效/环/深链/上游恢复 | 部分通过 | `invalidateDerived` BFS + visited + 20 层；`derived.test.ts:186-247` 覆盖 A→B→C 与 A→B→C→A；**恢复不越上游**：`restoreVersion:491-494` / `reactivateItem:264-267` 拒绝无效上游；**上游恢复后**见 I1 |
| 同源抑制（turn/review 跨 origin、新 message 可纠正、clear） | 通过（改写文本边界见 M4） | `suppression.ts:13-34` 两路 key、`sha16` 与 `consolidate.hookKey` 逐字节一致；`consolidate.ts:178-190` 命中即 `ignored` + changelog `suppressed_after_revert`；`suppression.test.ts` 5 例；`suppression.ts:92-98` 只清该 item 的行 |
| `memoryVersion`（无写入跨 expiry、外部写、排除 invalidated、稳定 prefix） | 通过 | `store.ts:1078-1121`：`sha16(rows[ id, itemContentVersion, expiresAt ] + expiredCount + nextExpiry)`，缓存键 `mtimeMs:size:ino` 且 `now < nextExpiry` 才复用；`context-version.test.ts` 实测（本次定向重跑 12/12 通过） |
| 真实 hook 当次替换 owned block | 通过（两种文档化形状；真实宿主见边界） | `plugin.ts:1199-1213` 每次 `context` hook 内 `resolveContext` → `applyOwnedContext`；`plugin.ts:1091-1139` 只改自己的块/part，空文本只删自己的块；测试用旧 entry 组装的 `event.system` 验证下一请求排除、其他 part 字节不变、`messages` 深比较不变；`setupPlugin` 真实注册 hook 的用例也在 |
| legacy `/api/items` 形状 / 新 envelope / 鉴权 / body source 不可信 | 通过（路由 id 见 M2） | `server.ts:244-247` 全局 Bearer 校验在路由之前；`api-items.test.ts:87-97` 断言 `Object.keys(body) === ["items"]` 且无 `version/latestChange`；`:123-142` 8 条路由逐条 401（`test/http-client.ts` 只在 URL 带 token 时才加 header，故 401 断言有效）；`:168-192` body `source` 被忽略、事件 source 为真实来源 |
| 旧 gate 不放开 | 通过 | `canAutoApply` 无改动（`git diff` 无该符号）；未新增 automation 配置；agent tool action enum 未含四个动作（`api-items.test.ts:247-255`，虽为源码字符串断言，结论与代码一致） |
| 写入路径事件覆盖 | 基本通过 | 逐个核对 `appendItem/updateItem/replaceItem/replaceItems/applyItemChanges/undoMaintenance/restoreQueueAction`：`actions.ts:299/458/521`、`apply.ts:246/257/301/335`、`consolidate.ts:559`、`curator.ts:176-206`、`compact.ts:102-126`、`session-promotion.ts:190` 均有事件；`retention.ts:165` 删归档行、`cli.ts:285` demo、`applyScopeMigration` 只改 queue 属报告 R2/R6 已声明；遗留缺口见 I3 |
| `as any` / ts-ignore | 通过 | `grep -rn "as any\|@ts-ignore\|@ts-expect-error" plugin/src console/src extension/src` 无匹配（与报告一致） |

### 未由本次审查验证的边界（保留，不作为通过依据）

1. **真实 OpenCode V2 宿主未实测**：helper 仅证明在“`<context key>` 标记”和“`metadata.experimental.instructions` 副本”两种形状下工作，且 fake host 只能证明“模型不能冒充宿主实测”。若现场宿主既无标记也无 metadata，helper 会**追加**自己的 part，宿主旧块里的被停用正文仍会被渲染（报告 §6.6 已承认）——这正是需要真实宿主补验的一条。
2. **未发真实模型请求**：自动写入→撤销→同源抑制的端到端时序只在 fake/fixture 中成立。
3. **retention/capacity 全量接入、`changes/suppressions/change-journal` 的保留与受保护依赖、迁移基线事件**：报告已声明归 P06；本次只确认“停止项不被 90 天清理”与“新文件 append-only 不参与注入”成立，不据此判 P01 通过或失败。
4. `/api/memory/items` 无 `nextCursor`（DESIGN 标记可选）；`/api/changes?since=&limit=` 在新增事件数 > limit 时用 `slice(-limit)` 丢掉最早的新事件（`server.ts:847-857`），UI 无法感知——归 P05 分页。
5. `Item.expiresAt` 当前无生产写入者，M3 的过期快照场景目前只能由导入/手工数据触发。

## 4. 回滚承诺与 P06 兼容风险（按任务要求列出，非 P01 失败依据）

作者的 rollback 写“`changes.jsonl` / `suppressions.jsonl` / `change-journal/` 可直接删除，不参与注入；`items.jsonl` 中新增可选字段可保留”。代码层面属实（`buildContext` 只读 item 字段），但**不是语义无损**：

1. 删除账本后，`items.jsonl` 仍带 `changeID`（指向不存在的事件）→ 重新启用 P01 时 `revertChange`/`restoreVersion` 对这些历史一律 `not_found`；`item.changeID` 成为悬空引用。
2. `invalidatedBy` 标记会保留：旧代码忽略它（注入恢复），但一旦再启用 P01，这些行立即重新被排除，并按 I1 无法通过 `reactivateItem` 清除。
3. `status=archived && supersededBy="deactivate"` 的行在旧代码的 retention 下 90 天后会被清理（保护逻辑在 `retention.ts:116-123`，旧代码没有）→ “恢复使用无时限”在回滚后无法承诺。
4. `restoreVersion` 要求 `snapshot.scope === current.scope` 且 project scope 的 `projectKey` 相等（`changes.ts:462-478`）。P06 迁移若修改 scope/projectKey，迁移前的历史快照将一律 `not_revertible`——这是保守选择，但 P06 需要为跨 scope 历史提供路径或显式接受损失。

建议：rollback 脚本除了删账本，还应剥离 `changeID/invalidatedBy/invalidatedAt/derivedFrom` 与 `supersededBy="deactivate"`（或保留账本与保护逻辑），并在 P06 迁移时处理第 4 条。

## 5. 复现脚本（tmp，可删除）

- `tmp/full-auto-memory/reviews/probe-p01.ts` — I1（sticky invalidation + 错误提示 + restore 绕行）、M3（过期快照恢复）
- `tmp/full-auto-memory/reviews/probe-p01b.ts` — I2（PATCH 配置静默不生效）、M1（压缩幽灵事件）
- `tmp/full-auto-memory/reviews/probe-p01c.ts` — M6（300 子项扇出 12.3s）

运行方式：`cd plugin && npx tsx ../tmp/full-auto-memory/reviews/probe-p01*.ts`（全部使用 `mkdtemp` 临时 dataDir，结束即删）。

## 6. 审查范围内未改动的既有问题（非本 diff 引入）

- `undoMergeEntry`（`store.ts:957-997`）的整行 JSON CAS 会被 `touchItem` 的 `seenCount/lastSeenAt` 更新打破；这是基线行为，P01 只是在其后追加 `recordItemDiff`。
- `changes.jsonl` 无保留/裁剪策略（DESIGN §5.3 的 5000 条/90 天/每 item 20 条）——P06 明确承接，本次不据此判失败。

## 7. Fix round 1 复核（2026-11-11，scoped re-review）

Reviewer: 同一独立审查者；只核 I1–I3/M1–M7 与 fix 新引入的破坏，不重做全仓审查，不改产品代码。
范围依据: `tmp/full-auto-memory/reviews/p01-fix1.patch`（75304 bytes / 1597 行 / 16 文件，其中新测试 2 个）、作者 `reports/01-reversible-memory.md` §8（211–285）、phase01 R9–R14。作者完整 verify（72 files / 886 tests / exit 0、`git diff --check` 无输出）由主代理亲读，本轮**未重跑**。
本轮实跑（全部 `mkdtemp` 临时 dataDir）: `probe-p01.ts`、`probe-p01b.ts`、`probe-p01c.ts` + 新增 `tmp/full-auto-memory/reviews/probe-fix1.ts`（M7 fallback / invalidation 副作用 / 账本规模）。

### 7.1 逐项裁决

| ID | 裁决 | 独立证据 |
|---|---|---|
| I1 | **ADDRESSED** | `changes.ts:282-340`：两种合法形状；先 `invalidUpstreams`（`derivedFrom ∪ {invalidatedBy}`，均需 active/未过期）；CAS `:293`；`restore` 事件 + 同事务；`supersededBy` 仅在 deactivate 形状清空；无自动复活。probe 实跑：A 恢复后 `B invalidatedBy: item_a` 保持且不注入；显式 `reactivate B` → `ok:true`（`kind:"restore"`，`before.invalidatedBy=item_a`，`after` 已清除）；deactivate B 后同样 `ok:true`。测试 `derived.test.ts:151-167` 已改为断言消息含 `item_a`，真正进入上游分支；新增“不自动恢复下游”“逐个恢复 B→C”两例 |
| I2 | **ADDRESSED** | `server.ts:1636` 已加 `assignNumbers(config.undo, body.undo, ["retainDays"])`，disk/live 同补；`probe-p01b.ts` → `PATCH 200`、`persisted undo: {"retainDays":200}`；`api-undo-config.test.ts` 覆盖“100 天前版本 PATCH 后立即恢复”“retainDays=0 → 400 且不落盘”（`validateNumericPatch` 的 `>0` 生效） |
| I3 | **ADDRESSED** | `changes.ts:135` `semanticSnapshot` 仅忽略 `changeID/updatedAt/seenCount/lastSeenAt`；`recordItemDiff:159` 用其比较，事件 `before/after` 仍是全量快照。`changes.test.ts` 2 例覆盖 derivedFrom/expiresAt/invalidatedBy 变化与纯计数无事件；`api-undo-legacy.test.ts` 4 例覆盖 recovery/maintenance 各“恰好 1 事件 + 重复/不存在 409 零写”。报告 §3.9 已加更正说明，不再声称旧证据 |
| M1 | **ADDRESSED** | `compact.ts:57/97` 改为 `clusterMerged` 按组计数；probe 实跑 `events: archive:item_a2, update:item_a1`、`item_b1 events: []`（原多出 `update:item_b1`）；`changes.test.ts` “merged nothing” 用例断言 f1/f2 零事件 |
| M2 | **ADDRESSED** | `changes.ts:373/382` 新增 `itemID` 校验（不一致 `not_found`）；`server.ts:932-940` 传 `itemID: id`，成功 broadcast 用 `result.event.itemID`；`api-items.test.ts:193` 断言错配 404 且 B 保持 auto、事件数不变。因为校验先于一切写入，409 的 `version` 与 `:id` 已保证同对象 |
| M3 | **ADDRESSED** | `changes.ts:548-556` 写回前 `isExpired(snapshot)` → `not_revertible`；probe 实跑 `restoreVersion ok: false`，当前 `expiresAt` 未被改写；`restore.test.ts` 新例断言零写入 |
| M4 | **ADDRESSED** | `apply.ts:336-340` 在 create/keep_both 且 `text !== item.text` 时把原捕获文本放入 `aliases`；`suppressSource` 由 aliases 派生两路 key。`suppression.test.ts` 新例：改写落库后 deactivate，`turnHookKey(reviewHookKey)` + 原文 hash 均 `isSuppressed === true`。merge/replace 原有 alias 路径不变 |
| M5 | **ADDRESSED** | `changes.ts:69-77`：已存在 → 抛 `change id already exists`，不静默换 id；`changes.test.ts` 断言账本长度不变、旧 journal 的 `undone===true` 未被覆盖、item 仍 archived。现有调用点均预生成新 id（逐个复核）。成本见 N3 |
| M6 | **ADDRESSED（正确性）**，有 1 项新副作用见 N2 | `changes.ts:606-691`：一次 `listItems()` 建图、BFS+visited+`parentOf` 祖先判环、取消深度上限、`applyItemChanges` 一次批量写、每条 `invalidate` 事件、环写一条 `invalidate_cycle`。测试：300 fanout（`replaceItem` 1 次 / `applyItemChanges` 1 次 / 300 事件）、25 层全失效、环审计 1 条。probe：300 子项 235ms（原 12256ms）。原子性：批量写与全部事件在同一 `store.transaction` 内；`change-journal` 只对 revertible 写不影响原重放——目标 journal（add/update 等 revertible）仍在，`revertChange` 的 `undone` 判定与 `transaction.test.ts` 的 kill 点重放语义未变（完整 verify 已 exit 0） |
| M7 | **NOT_ADDRESSED（blocking）** | 见 7.1.1：metadata 分支与转义成立，但**无 metadata 的旧未转义块（正是本轮要求的定向场景）仍然失败，且新增“误删其他宿主 system part”回归** |
| 文档 §7 回滚 | **NOT_ADDRESSED（doc）** | 见 7.1.2 |

#### 7.1.1 M7：fallback 未闭合 + 新回归（host content 被删除）

`plugin.ts:1057-1083`（`replaceOwnedBlocks`）在无 `metadata.experimental.instructions` 记录时，回退到 `boundary = 下一个 "<context "`、`close = lastIndexOf("</context>", boundary-1)`，若 open 后无 close 则 `close = output.lastIndexOf("</context>")`（全局最后一个）。实测（`probe-fix1.ts`，纯函数直调、无 metadata、只有精确 wrapper）：

```text
--- A close+fake-open, replace
out: PRE\n<context key="plugin.memory-autopilot">\nNEW\n</context> MID <context key="fake">INNER</context> TAIL\n</context>\n<context key="host">HOST</context>
residue: [ 'MID', 'TAIL', 'key="fake"', 'INNER' ] | host kept: true

--- B fake-open no-close, stop        (text="")
out: "PRE\n"
residue: [] | host kept: false        <-- 其他宿主的 <context key="host"> 被整块删除

--- B2 fake-open no-close, replace
out: "PRE\n<context key="plugin.memory-autopilot">\nNEW\n</context>"
residue: [] | host kept: false        <-- 同样删除宿主块
```

- 场景 A 违反阶段文档 §5.1「被撤销/停用的正文不在受控块里」：旧块尾部（含字面 close 之后的内容）仍留在 part 中。
- 场景 B/B2 违反 §5.1「绝不能删除或改写其他宿主的 system parts」：**这是本轮修复新引入的回归**——修复前的实现（`p01.patch` 原 `replaceOwnedBlocks`，`close = indexOf("</context>", open)`）在同样输入下会取到真正的外层 close，宿主块被保留；新加的全局 `lastIndexOf` 分支把它删掉了。
- 触发条件明确：part 有我们的精确 wrapper、无 metadata 记录、正文含字面 `<context ` 且该 open 之前正文无 `</context>`（A 为另一种：正文 close 在 fake open 之前 → 只替换到该 close，留下残片）。A/B 都是“旧数据/宿主不记录 metadata”的真实边界，不是构造的畸形输入。
- 作者测试为何没暴露：`context-version.test.ts:326/346/360` 三个旧块用例**全部带 metadata 记录**，走的是 `replaceRecordedBlock`（该分支实现正确）；`R12` 声称“回退到…上界前最后一个 close 这样字面 close 不会截断或误删”，但唯一能证明它的无-record 用例缺失，且实测不成立；报告 §8 的“残余边界”只写了“既无标记也无 metadata”，未覆盖“有我们精确 wrapper、无 metadata”的情况。
- 转义本身：`plugin.ts:1310-1316` 幂等（`&lt;` 不会被再次匹配）、不改 `items.jsonl` 存储；但它只作用于 `renderContext` / `event.system` 拼接通道，`entry.put({ value: block })` 仍存未转义正文。若真实宿主自行渲染 entry 且不在 metadata 记录我们 key，则**新数据**同样会落回上述不安全 fallback。此点在真实宿主实测前不能宣称闭合。
- **最小明确契约（建议，不取“最后一个 close”泛删）**：
  1. 删除 `output.lastIndexOf(CONTEXT_CLOSE)` 的全局回退（`plugin.ts:1093`），它没有任何能安全判断边界的输入；
  2. 无-record 分支只在“候选 close 之前没有出现 `<context `”时替换到该 close；若正文出现 `<context `（歧义），**不要改这个 part**：若 part 恰好等于单块 `OPEN … CLOSE`（`text.startsWith(OPEN)` 且唯一 close 是尾部）则整块替换，否则保留原 part、不追加空块，并写一条 `context_ambiguous` changelog（一次性、有界；报告 §6.6 的残余边界同步更新为“有 wrapper 但无 record 且正文含 open 时不保证当次移除”）；
  3. 两条通道对齐：把转义后的行也放进 `entry.put` 的 value（或显式持久化 record 文本），使宿主渲染出的块本身不含裸标记，fallback 只服务升级前数据。

#### 7.1.2 文档：旧回滚说明必须标 superseded

`reports/01-reversible-memory.md:205-209`（§7）仍是“删 `changes.jsonl`/`suppressions.jsonl`/`change-journal/` 即可、`items.jsonl` 可选字段可保留”。`reports/06-preflight.md:13/22/37` 已裁决该说法**不是已验证契约**，并明确“P06 只以 review §4 + 06-preflight 为准；完整 checkpoint 才是‘无损’”。作者本轮未改 §7、也未加 superseded 标记 → 只读该报告的操作者仍可能照旧执行，导致 `invalidatedBy`/`changeID` 悬空、`deactivate` 保护丢失、已停用内容在旧版清理后不可恢复。最小处理（文档项）：§7 标题或首行加 `Superseded by reports/06-preflight.md §2；不要按本条执行`，正文改为链接，不重写 P06 工具。

### 7.2 本轮新发现（仅在 review 记录，不扩展修复范围）

- **N1（并入 M7 blocking）**：无 metadata fallback 可删除其他宿主 system part；见 7.1.1 的 B/B2。
- **N2（Minor，deferred）**：`invalidateDerived` 改用 `store.applyItemChanges` 带来两个新副作用（`changes.ts:606` 起）：每次“停用/撤销且有后代”都会新建一个 `maintenance_<id>.json` 与一份**完整 `items.jsonl.bak`**，并留下可由 `POST /api/maintenance/<id>/undo` 触发的入口。实测：deactivate A 后 `maintenance/` 出现 `.json + .items.bak`；`undoMaintenance` 后 `root: archived, child: auto, invalidatedBy: undefined`，`buildContext` 又注入 `派生偏好` —— 即**上游仍停用却复活了下游**（DESIGN §7.3 “不得激活仍有无效上游的项”）。该 id 不出现在 changelog，UI（`Health.tsx` 仅对 compact/curator 显示撤销）没有入口，故当前只能由持 token 且知道 id 的调用者触发；但磁盘放大与语义旁路是真实的。最小修复：为批量失效增加一个不写 maintenance journal 的批量写（`replaceItems` 一次写，仍在同一事务），或让 maintenance undo 在写回前复用 `invalidUpstreams` 拒绝复活无效上游的行。
- **N3（Minor，deferred）**：`recordChange` 的重复 id 检查对每条事件 `await store.listChanges()`（`changes.ts:76`），复杂度 O(账本长度)/事件。实测 2000 条既有账本 + 300 子项失效 = 592ms（相同场景空账本 235ms），仍在同一数量级、未破坏原子性；但账本接近 DESIGN 上限 5000 时需改成一次读数建 `Set` 或按批次传入。不阻塞。
- **N4（Doc）**：见 7.1.2。

### 7.3 裁决

| 裁决 | 结论 |
|---|---|
| **Fix round 1** | **未 clean（不通过）**：I1/I2/I3/M1–M6 全部 ADDRESSED 且证据可复现；**M7 NOT_ADDRESSED 且引入 host 内容删除回归**，按主代理既定规则 M7 为 blocking；文档 §7 仍与 06-preflight 冲突 |
| **Spec verdict（P01 整体）** | **仍为有条件通过，但本轮不放行**：功能契约已闭合，唯一边界承诺（旧未转义块在下一请求被完整替换 / 不误删宿主）在无 metadata 的真实形状下不成立 |
| **Quality verdict** | **良好**：修复是真实的、测试大体可信（含子进程 kill 点、API 级 legacy 入口、300/25 层与环）；缺陷集中在 fallback 边界与一个批量写副作用，修复面小、可定位 |
| **保留的未实测边界** | 真实 OpenCode V2 宿主的 `event.system` 形状与 metadata 记录行为仍未实测；fake host / 纯函数 probe 只能证明模型，不能替代真实 host。转义只覆盖 `event.system` 一侧，`entry.put` value 仍为未转义正文，需在真实宿主或补齐 7.1.1 第 3 条后再宣称闭合 |
| **下一步** | 回原作者同 session 只修 M7（7.1.1 三条 + B/B2 回归用例）与 §7 superseded 一行；N2/N3 可留到最后复核或 P06，不扩大本轮。修复后只需定向复跑 `context-version.test.ts`、`derived.test.ts` 与 `probe-fix1.ts` 三段 |

## 8. Fix round 2 复核（2026-11-11，scoped）

Reviewer: 同一独立审查者；范围限 M7/N1、N2、旧 rollback 文档与本轮新破坏；I1–I3/M1–M6 已 ADDRESSED，不重新扩面。
依据: `tmp/full-auto-memory/reviews/p01-fix2.patch`（40710 bytes / 665 行 / 7 文件）、作者 `reports/01-reversible-memory.md` §9（292–340）、phase01 R15–R17、PROGRESS 修复轮 2 清单。完整 verify（72 files / 894 tests / exit 0、`git diff --check` 无输出）由主代理亲读，本轮未重跑整套；定向实跑 `context-version + derived + api-undo-legacy` = **38 passed (3 files)**（我自己的运行），并跑 `probe-fix1.ts` 与新增 `probe-fix2.ts`。

### 8.1 逐项裁决

| ID | 裁决 | 独立证据 |
|---|---|---|
| M7/N1 | **ADDRESSED（文档化支持形状）**，另见 N4 | 全局 `lastIndexOf` 与旧 `replaceOwnedBlocks` 已删除；`isSingleOwnedBlock`/`balancedAfter`/`replaceUnrecordedBlock` 只做可证明替换（`plugin.ts:1067/1082/1108`）。我的 probe（原 `probe-fix1.ts`）复跑：A/B/B2/C 均 `host kept: true` 且 `ambiguous=[0]`（原 B/B2 宿主块被删，现保留原 part + 残片留在 part 内）；D 与单块形状正确替换。`applyOwnedContextDetailed` 在歧义时 `handled=true` 但保留原 part、不追加重复块（`plugin.ts:1192-1250`），`context_ambiguous` 只含 `sessionID/count/parts`、每 session+shape 一次（`:1161-1181`）。两条渲染通道已一致：`buildContext` 的 `clean()` 就转义（`:1375`），probe 显示 block 的 `autoMemory` 无裸 `</context>`、`renderContext` 两次输出完全相同、对已替换结果再 `apply` 幂等（parts 数量稳定）。既有形状用例（metadata 精确、单块、配平尾部）与 38 个定向用例通过 |
| N2 | **ADDRESSED** | `changes.ts:678` 改为同一事务内 `store.replaceItems(after)`；无 `applyItemChanges`。probe：deactivate root 后 `maintenance/` 为 `[]`、无 `*.items.bak`、`child.invalidatedBy=root`、注入为空、事件恰为 `deactivate:root` + `invalidate:child` 各 1。300 fanout 仍 1 次全量写、每 item 1 事件、环审计 1 条（`derived.test.ts` 11 例通过）；`api-undo-legacy.test.ts` 4 例仍证明 `compact` 产生的正常 maintenance journal 与其 undo 未回归 |
| 文档 §7 | **ADDRESSED** | `reports/01-reversible-memory.md:205-211` 改为 `Superseded by reports/06-preflight.md §2 — 不要按本节旧说法执行`，删除可执行步骤，列六类损失 + checkpoint 为唯一“无损”路径，并明确 P06 只以 review §4 + 06-preflight §2 为准；phase R17 与 PROGRESS 同步 |
| 真实 host 边界 | 文档化保留 | 报告 §9、phase R15、PROGRESS 三处都写明“无 metadata 且正文含字面 `<context `/额外 `</context>` 为不支持形状，下一请求停用未获保证；真实 host 出现即阻塞最终验收”，未把 fake host 当实测。**本报告不据此宣称 P01 最终验收通过** |
| N3（账本复杂度） | **deferred（P06）** | `recordChange` 重复 id 检查仍每条读账本；probe 2000 条既有账本 + 300 子项 = 621ms（空账本 235ms），未破坏原子性，按裁决只记录不扩实现 |

### 8.2 新发现 N4（Important，narrow trigger）：单块判据仍可能吞掉宿主内容

`isSingleOwnedBlock`（`plugin.ts:1067-1074`）只要求“trim 后以我们的 OPEN 开头、以某个 CLOSE 结尾、我们的 OPEN 恰好 1 个、`</context>` 恰好 1 个”，**没有检查这唯一的 close 是否属于我们**，也没有排除正文里的其他 `<context `。实测（`probe-fix2.ts`，无 metadata）：

```text
S1 nested host, stop     part: <context key="ours">\nOLD <context key="host">HOST</context>
  -> ambiguous=[] host=false parts=0        # 整个 part 被删除，HOST 丢失
S1 nested host, replace
  -> out=<context key="ours">\nNEW\n</context>   # HOST 丢失，且无 context_ambiguous 记录
S2 unclosed ours + host after
  part: <context key="ours">\nOLD\n<context key="host">HOST</context>
  -> ambiguous=[] host=false parts=1        # HOST 丢失
```

即输入是“我们的块未闭合 + 紧随一个宿主块”时，判据把它当成“单块”整块替换/删除，删掉宿主文本且不记审计——这与本轮要消除的 N1 同类，只是触发形状更窄（需要宿主组装出未闭合的 owned 块；插件自身不会产生，宿主文档也未描述）。按作者自己的契约（“part 恰为本插件单块”）这是判据实现错误，不是契约放宽。

- 最小修复（1 处 + 2 个用例）：`isSingleOwnedBlock` 增加“OPEN 之后不得再出现任何 `<context `”（`countOccurrences(text, "<context ") === 1`，或用 `text.indexOf("<context ", OPEN.length) === -1`）。S1/S2 随即落入 shape 2 → 正文含 `<context ` → `undefined` → 保留原 part + `context_ambiguous`，宿主不再被删。
- 不阻塞的说明：该形状不在文档化支持集合内，P02/P03/P04 不消费该 helper 的边界判定；但它属于“可删除宿主指令”，建议在同 session 一并修掉后再宣布本轮 clean（改动无接口影响）。

### 8.3 本轮其它观察（不新增缺陷）

- 歧义路径下**新记忆也不会在当次请求注入**（`handled=true` 抑制追加）；文档只写了“停用未获保证”。建议报告 §9 补半句“同次请求的新增内容也延后到宿主重建/entry.put 生效”，避免被读成“只是旧内容残留”。
- 文档 §7 六类损失里 “`derivedFrom` 丢失” 与“删账本”无直接因果关系（`derivedFrom` 在 `items.jsonl`；它来自 P06 兼容导出剥字段的选项）。属措辞混用，不影响 supersede 结论。
- 转义把模型可见正文里的 `<context`/`</context>` 变为 `&lt;…`：这是有意的 prompt 注入加固，不改 `itemContentVersion`/`memoryVersion`/去重；但对含该字面量的条目是一次性可见文本变化，P05 展示时需知悉。

### 8.4 裁决

| 裁决 | 结论 |
|---|---|
| **Fix round 2** | **M7/N1 与 N2、文档 §7 均 ADDRESSED；因 N4 本轮仍未 clean**。N4 是一处 1 行判据 + 2 个用例的窄触发问题，不影响 P01 对外接口 |
| **Spec verdict（P01）** | **支持形状内成立**：metadata / 单块 / 无记录但可证边界三条路径不误删、不残留（D、单块、配平尾部实测）；歧义路径按契约保留并不声称生效。**不支持形状下“撤销后下一请求不再注入错误 owned”未获保证**——这正是最终目标的残留缺口，必须由 P06 真实 host 验证关闭，不得以 fake host 或 `context_ambiguous` 当通过 |
| **Quality verdict** | **良好**：本轮修的是上一轮实测缺陷（误删 host、maintenance 旁路、旧 rollback 误导），文档与门禁如实；唯一新问题是判据实现比其声称的“可证明”弱一档 |
| **P01 接口能否冻结供 P02** | **可以（有条件）**：`recordChange`/`RevertResult`/`reactivateItem`/`restoreVersion`/suppression/store 与 `applyOwnedContext` 对外签名未变（新增 `applyOwnedContextDetailed` 为附加导出，已有 R15 记录），P02/P03/P04 不依赖该边界判据。条件：N4 在同 session 修掉并通过定向用例；P06 保留“真实 host 不支持形状 = 最终 blocked”的硬门禁 |
| **最终验收** | **仍 blocked**：真实 OpenCode V2 的 `event.system`/metadata 行为未实测；歧义形状下“旧 session 下一请求不再使用错误 owned”未闭合。不得把“保守不删 + 记一条日志”当作验收通过 |
| **下一步** | 回原作者只做 N4（`isSingleOwnedBlock` 加一条 `<context ` 唯一性检查 + S1/S2 用例）与 §9 半句说明；复跑 `context-version.test.ts` + `probe-fix2.ts` 即可。N3 留 P06；其余不再扩面 |

## 9. Fix round 3 复核（2026-11-11，仅 N4）

范围：只核 N4 与本轮新破坏；M7/N1、N2、文档 §7 已在 §8 ADDRESSED，不重做。依据 `tmp/full-auto-memory/reviews/p01-fix3.patch`（12647 bytes / 153 行 / 5 文件，无新增文件）与作者 §10。完整 verify（72 files / **896 tests** / exit 0、`git diff --check` 无输出）由主代理亲读，本轮未重跑；我实跑 `context-version.test.ts`（**25 passed**）与 `probe-fix2.ts`。

### 9.1 逐项

| 项 | 裁决 | 独立证据 |
|---|---|---|
| **N4 判据唯一性** | **ADDRESSED** | `plugin.ts:1073-1075` 增加 `countOccurrences(text, "<context ") === 1`。probe 实跑：S1 stop/replace → `ambiguous=[0] host=true parts=1`、part 逐字保留；S2 → 同；S6（ours 闭合 + 未闭合宿主）→ 保留；S5/S7（杂散 close / 两个 wrapper）仍歧义。原 fix2 的 `host=false` 消失，且**没有**转成“静默替换”，而是落入歧义并保留 |
| **支持形状不回归** | **ADDRESSED** | 同一次 probe：S3（单块 + 纯文本尾）、S4（宿主块在 ours 之前）、D（`ours+host` 相邻）、单块 stop/replace 仍正确替换；`context-version.test.ts` 既有 23 例 + 新增 S1/S2 各 stop/replace = **25 passed**。判据新增只影响“单块内还有 `<context `”的输入，符合 phase R15 修订后的契约 |
| **幂等/转义不回归** | **ADDRESSED** | `buildContext` 的 block 无裸 `</context>`；`renderContext` 两次输出一致；对已替换 parts 再 `applyOwnedContextDetailed` 结果字节一致（parts 数稳定 2） |
| **N2 不回归** | **ADDRESSED** | probe：deactivate 后 `maintenance/` 空、无 `.bak`、`child.invalidatedBy=root` 不注入、`deactivate:root`+`invalidate:child` 各 1 |
| **文档两处措辞** | **ADDRESSED** | 报告 §9 已补“歧义路径当次新增内容同样不注入，要等宿主重建或 `entry.put` 生效，不得当作停用成功”；§7 已把 `derivedFrom` 损失从“删账本”拆出并归到 P06 兼容导出剥字段，两类损失分开列 |
| **N3** | deferred（P06） | 未改 `recordChange` 账本读取；仍为 2000 条账本 + 300 项 ≈ 0.6s，不阻塞 |

### 9.2 本轮观察（非缺陷）

- 判据变严后，“part 恰为本插件单块、但正文含一个字面 `<context `（无 close）”也从“可替换”变为“歧义保留”。这符合 R15 修订后的契约（单块要求 OPEN 之外无 `<context `），且新数据在 `buildContext` 已转义；旧数据在下一次需要重建（version 变化 → `entry.put`）时由宿主重写为干净块。属有意的保守取舍，不阻塞。
- 未发现本轮新 Critical/Important；无接口变化（判据为内部函数）。

### 9.3 裁决

| 裁决 | 结论 |
|---|---|
| **Fix round 3** | **clean**：N4 修复真实（S1/S2 不再删宿主、转歧义并保留 part），支持形状、转义幂等与 N2 均无回归，文档口径与实现一致 |
| **Spec verdict（P01，支持形状范围）** | **通过**：metadata 记录、单块、无记录但可证边界三条路径行为符合 R15；歧义路径明确不声称停用生效，并写有界 `context_ambiguous`。P01 的账本/CAS/抑制/版本/API 契约不变 |
| **Quality verdict** | **良好**：三处 blocking 缺陷（I1、M7/N1、N2）均以“先复现→最小修复→独立 probe 复验”闭环；测试与文档未掩盖歧义边界 |
| **P01 接口冻结供 P02** | **可以冻结**：对外签名（`recordChange`/`RevertResult`/`reactivateItem`/`restoreVersion`/suppression/store、`applyOwnedContext`）未变；N4 仅内部判据。P02/P03/P04 可在此基础上实现 |
| **最终验收 / 真实 host** | **仍 not-run + blocked（P06 硬门禁）**：真实 OpenCode V2 的 `event.system` 形状与 metadata 记录行为未实测；出现“无 metadata 且正文含字面 `<context `/额外 `</context>`”即阻塞最终验收。保留歧义旧块**不等于**撤销已生效，不得以 `context_ambiguous` 或 fake host 通过 |



