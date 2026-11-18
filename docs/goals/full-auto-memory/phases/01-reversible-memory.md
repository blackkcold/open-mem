# P01 — reversible memory

Status: pending
Depends: P00
Blocks: P03, P05
Global constraints: 见 `PLAN.md` §2

## 目标

先让每一次记忆写入都可追溯、可停止使用、可撤销、可恢复旧版本，再允许自动化。P01 不改变自动写入策略，只补“可逆性 + 版本失效 + 同源抑制”。

## 非目标

- 不扩大自动写入范围（`canAutoApply` 语义不变）。
- 不实现召回、UX 页面、迁移工具。
- 不做“彻底删除所有副本”。
- 不替换 Store/WAL/items.jsonl。

## 文件

| 文件 | 改动 |
|---|---|
| `plugin/src/types.ts` | 新增 `ChangeEvent`、`ItemSnapshot`、`Suppression`、`RevertResult`、`UndoConfig`；`Item` 加 `changeID?/invalidatedBy?/invalidatedAt?/derivedFrom?`；`SessionState` 加 `contextVersion?` |
| `plugin/src/config.ts` | 新增 `undo.retainDays`（默认 90），合并/校验/设置白名单 |
| `plugin/src/changes.ts`（新） | `itemSnapshot`、`recordChange`、`deactivateItem`、`reactivateItem`、`revertChange`、`restoreVersion`、`invalidateDerived` |
| `plugin/src/memory/suppression.ts`（新） | `suppressSource`、`isSuppressed`、`clearSuppression` |
| `plugin/src/store.ts` | `changes.jsonl`/`change-journal/` 路径；`appendChange`/`listChanges`；`memoryVersion(now)`（含 nearest-expiry）；`listSuppressions`/`appendSuppression`；撤销/恢复的事务写；可选 `now` 注入（默认 `Date.now`，供到期/soak 测试） |
| `plugin/src/plugin.ts` | `refreshContext` 版本比较；`buildContext` 过滤 expired/invalidated |
| `plugin/src/consolidate.ts` | 自动写入用 `store.transaction` 包 `appendItem` + `recordChange`；hook 记录 changeID |
| `plugin/src/actions.ts` / `apply.ts` / `memory/promotion.ts` / `memory/session-promotion.ts` | 批准/编辑/合并/替换/提升/legacy undo/session-note promotion 都写 change event；复用现有 journal，不替换 |
| `plugin/src/memory/curator.ts` | 过期/精确去重/失效写 change event |
| `plugin/src/retention.ts` / `capacity.ts` | 仅最小保护：已停止使用（`supersededBy="deactivate"`）的 item 不被 90 天归档清理，保证“恢复使用”无时限。新文件计入保留/容量与受保护依赖归 P06（见 R2） |
| `plugin/src/server.ts` | 旧 `GET /api/items` 形状不变；新增 `GET /api/memory/items`；`/api/items/:id/changes`；deactivate/reactivate/revert/restore；`GET /api/changes` |
| `plugin/test/*` | 见下 |

## 接口

签名以 `DESIGN.md` §8.1 为准，不得偏移。关键点：

```ts
recordChange(store, { kind, actor, item, before?, source, reason, derivedFrom?, dependsOn? })
  → ChangeEvent   // 必须在 store.transaction 内调用
deactivateItem(store, itemID, { expectedVersion, reason? }) → RevertResult
revertChange(store, changeID, { expectedVersion, reason? })  → RevertResult
restoreVersion(store, itemID, changeID, { expectedVersion }) → RevertResult
store.memoryVersion() → string
```

`RevertResult` 失败码：`not_found` / `version_mismatch` / `not_revertible` / `conflict`。API 映射：404 / 409 / 409 / 409。

## 行为细节

### 1. 变更事件

- 每个 active item 变更恰好 1 条事件；`before`/`after` 为**无损全量 `Item` 快照**（保留 id/title/text/kind/scope/projectKey/status/source/sources/manual/expiresAt/derivedFrom/supersedes/invalidatedBy/aliases/changeID 等全部相关字段），不得只存正文导致恢复丢身份/派生/状态。
- 所有路径都写事件：自动、人工批准/编辑/合并/替换、提升、legacy undoMerge、curator、session-note promotion、迁移、restore/revert/deactivate；任何路径使 item 失效都要推进有效版本。
- `itemVersion = itemContentVersion(after)`；before 用 `itemContentVersion(before)`。
- `revertible`：`add`/`update`/`merge`/`replace`/`promote`/`restore` 为 true；`archive`/`expire`/`invalidate` 默认 false（但保留快照用于历史）。
- `source` 由服务端入口设置；HTTP body 的 `source` 忽略。
- 事务失败：item 与事件都不落盘；不允许只写一边。

### 2. 停止使用（无时限）

- 校验 `itemContentVersion(current) === expectedVersion`；不匹配 409。
- `status="archived"`，`supersededBy="deactivate"`；写 `deactivate` 事件。
- 写同源抑制（该 item 的所有 source hook key / textHash）。
- 立即让 `memoryVersion` 变化；**下一次模型请求**（含已存在的旧 session）不再注入；已经开始的请求、已执行外部动作不可追回。
- 无 24h 限制；停止使用后随时可“恢复使用”（`reactivateItem` 重新激活当前内容，不受 90 天版本保留限制；历史版本回退另走 `restoreVersion`，受 90 天限制）。

### 3. 撤销变更（不受 24h 约束）

- `changeID` 对应事件必须 `revertible=true` 且未被撤销。
- 有 `before`：把 before 作为新版本写回（`updateItem` 语义），写 `revert` 事件 `reverts=changeID`。
- 无 `before`：归档当前 item，写 `revert` 事件。
- 撤销后调用 `invalidateDerived`：从目标 id 递归标记 `derivedFrom`/`supersedes` 下游 auto item（visited set + 深度上限防环）；manual/promoted 也停止注入但不自动归档。恢复前检查上游全部有效，否则拒绝激活。
- 撤销写 `change-journal/<changeID>.json`，含 `undoing/undone`；崩溃可重试。
- 若当前 item 在目标变更后又被后续编辑，**不得只覆盖文本片段**；只能做完整、版本安全的反向变更，否则返回 `conflict`，UI 只给停止使用。

### 4. 恢复旧版本（默认 90 天，可配置）

- 目标 `after` 快照必须完整；不完整 → `not_revertible`。
- 当前 item 版本必须等于 `expectedVersion`；否则 409。
- 受 `config.undo.retainDays`（默认 90）约束；超期只允许停止使用，不恢复旧正文。
- 写入旧文本为新版本，`status` 回到 `auto`/`promoted`（按快照），写 `restore` 事件；清除对应 suppression。
- 不覆盖其他字段（`source`/`createdAt` 保留历史，`updatedAt` 更新）；不做 partial merge。

### 5. memoryVersion 与 context

- `memoryVersion(now)` = `sha16` over sorted active rows `[id, itemContentVersion, expiresAt]` + `expiredCount` + `nextExpiry`；排除 `expiresAt<=now`、`invalidatedBy`。文件未变但跨过 `expiresAt` 时 version 必须改变；不得只缓存 mtime/size。
- 读 `items.jsonl` 后可按 `(mtime,size,当前 expiry 状态)` 进程内缓存；跨过任一 `expiresAt` 必须重算，不能只按 mtime/size 判定。
- `refreshContext`：仅当 `contextVersion` 不同才重建；渲染文本相同不 `entry.put`。
- `buildContext` 过滤 expired/invalidated；不改变 block 的稳定结构。

#### 5.1 真实生命周期：`entry.put` 不等于“本次请求已替换”

V2 官方文档（`https://opencode.ai/v2/docs/build/plugins/server`，Sessions / Model requests 段，原文见 `reports/04-preflight.md` §2.1）明确：

> Entries render as `<context key="...">` blocks in the session's instructions, and updates or removals are **announced at the next step boundary** without queuing a message turn.

> The `system` part that holds OpenCode's instructions also lists each source in `metadata.experimental.instructions` as `{ key, text }` … The list is a **copy**: editing the part's `text` does not update it.

本地 SDK 也支持这个形状：`SystemPart = { type:"text"; text:string; cache?; metadata?: Record<string, unknown> }`（`@opencode/ai/dist/schema/messages.d.ts`）。

结论（P01 必须自己成立，不能只靠 P04）：

1. `entry.put` 只是**后续请求**的持久化通道；已经组装好的 `event.system` 不会被它替换，所以“deactivate 后下一次请求不含它”不能只写成 state 更新。
2. `context` hook 必须在**当次** `event.system` 内定位并替换本插件自己的块，然后才返回：
   - 先按 `metadata.experimental.instructions` 里 `key === "plugin.memory-autopilot"` 找专属 part；
   - 否则按文本中的 `<context key="plugin.memory-autopilot"> … </context>` 标记定位（宿主把 keyed entry 渲染成块）；
   - 只替换**这一个**受控块/part 的内容；找不到就追加一个带同一 key 的 part。
3. 绝不能删除或改写其他宿主的 system parts，也不能改 `event.messages`（用户聊天历史/原始发言不属于插件撤销清除范围）。
4. 找不到受控块且新文本为空时不追加空块；有受控块且新文本为空时只移除自己的块。
5. 替换后本请求自证：被撤销/停用的正文不在受控块里；渲染文本未变时字节不变（稳定 prefix 不受影响）。

实现：`plugin/src/plugin.ts` 导出纯函数 `applyOwnedContext(parts, text)`（返回新数组，不修改入参；P04 后续加动态 block 时复用同一 helper，只追加自己的 part），`resolveContext()` 返回当次应注入的 block，`refreshContext()` 保持 `DESIGN §7.2` 的 `Promise<void>` 签名（内部调用 `resolveContext`）。测试用 fake host 模拟“宿主用旧 entry 重新组装 `event.system`”，断言下一请求的 OpenMem 块已排除旧条目。

### 6. 同源抑制

- `hookKey` 使用现有 hook key 规则（turn: `session|message|textHash`；review: `review|session|message|textHash`）。
- 抑制只匹配同一 key；新 message 不命中。
- `restoreVersion`/“恢复使用”删除对应 suppression。
- 抑制不产生新待办；候选直接 `ignored`，changelog 记 `suppressed_after_revert`。

## TDD 顺序

1. `changes.test.ts`：事件形状/事务失败回滚。
2. `revert.test.ts`：version 409、归档、事件、抑制。
3. `restore.test.ts`：90 天保留/超期、冲突、无快照、无 partial 覆盖。
4. `derived.test.ts`：递归派生失效、环保护、上游无效时拒绝恢复。
5. `suppression.test.ts`：同源跳过/新消息可学/清除。
6. `context-version.test.ts`：旧 session 下一次请求排除、20 轮稳定 prefix、expired/invalidated 过滤、无写入仅跨期使 version 改变。
7. `api-items.test.ts`：路由/auth/过滤/409/无“仅恢复文本”；旧 `/api/items` 形状不变，新 envelope 在 `/api/memory/items`。
8. `transaction.test.ts` 扩展：撤销写入中断重放；人工/legacy undo/curator/session-note promotion 都写事件并让版本失效。

先跑失败测试并记录失败原因，再实现。

## 验收

- `ACCEPTANCE.md` §2 全部通过。
- `npm run verify` exit 0；新增测试全绿；baseline 803 不减少。
- `git grep` 无 `as any`/`ts-ignore`/`ts-expect-error`。
- 手工检查：一个已存在的旧 session 在 item 停止使用后的下一次模型请求不再含它；恢复后再次出现；已开始请求不追回。
- 版本回退默认 90 天可配置；超期只停用；冲突无“仅恢复文本”。
- 现有 `context.test.ts`、`transaction.test.ts`、`api*.test.ts`、`review-*` 全绿。

## 实现裁决（2026-11-11，P01 执行者，对照实际代码）

只补细节，不改 `DESIGN.md` §8.1 已定签名。

### R1 `memoryVersion` 接受可选 `now`

DESIGN §8.1 写作 `memoryVersion(): Promise<string>`，§7.1 写作 `memoryVersion(now?: number)`。实际签名 `memoryVersion(now = Date.now()): Promise<string>`：无参调用满足 §8.1，传入时钟满足 §7.1 的到期/soak 测试。

### R2 retention / capacity 归 P06

`reports/00-preflight.md` §3/§4.5 已裁决：`changes/suppressions/quarantine/change-journal` 计入保留/容量与受保护依赖由 P06 完成，`capacity.ts` 公式不变。P01 只做一件必须在本阶段成立的事：已停止使用（`supersededBy="deactivate"`）的 item 不被 90 天归档清理，否则“恢复使用无时限”不成立。其余新文件只做 append-only，不接入 retention 预览。

### R3 `Item.changeID` 由写入路径预生成

`recordChange` 只追加事件，不改写 item（避免与 `applyItemChanges` 的 journal 快照互相污染）。写入路径用新增的 `newChangeID()` 预生成 id，把 `changeID` 一起写进 item，再记录事件，因此事件 `after` 与磁盘完全一致。`applyItemChanges` 批量路径（curator/compact/maintenance）在写入前把 `changeID` 放进 `next` 行，`journal.after` 与 item 仍一致，undoMaintenance 的 JSON 比较不破。

### R4 “后面又被编辑过”以账本顺序判定

`revertChange` 的冲突判定不依赖 `item.changeID`，而是“`changes.jsonl` 中该 item 在目标事件之后是否还有事件”。账本是 append-only 的唯一权威，能覆盖所有写入路径；`item.changeID` 只用于显示与溯源。`restoreVersion` 不走这条规则（它是对当前 `expectedVersion` 的显式 CAS 覆盖）。

### R5 `change-journal/<changeID>.json` 一条事件一个文件

`recordChange` 为每条事件写 `{ id, at, itemID, kind, before, after, reverts?, undoing, undone }`；撤销/恢复在同一事务内把它推进为 `undoing:true → undone:true`。崩溃时 item 与账本/flags 同一文件批次（WAL）落盘，不会出现半状态；`undone` 也是“同一变更不可撤销两次”的判据。

### R6 不写事件的写入路径（可证明覆盖，非遗漏）

- `store.touchItem` 只改 `seenCount/sources/lastSeenAt`，不改 `itemContentVersion` 的任何字段，不改变注入内容，故不写事件。
- `cli.ts` 的 `demo` 子命令只用于本地演示数据，不是插件运行时写入路径（不在 `src/plugin.ts`/`server.ts` 的调用图上）。
- `retention` 的归档清理是保留策略删除，不是记忆语义变更；P06 负责纳入账本引用保护。

### R7 抑制键：同一 source 的 turn / review 两路互通

`suppressSource` 对 item 的每个 source（`source` + `sources[]`）按现有 hook key 规则各写 turn 与 review 两种 key：`session|message|textHash` 与 `review|session|message|textHash`，`textHash = sha16(normalizeForFingerprint(text))`，与 `consolidate.hookKey` / `accept.ts` 现有格式逐字节一致。因此同一来源的 turn 捕获与复盘捕获都会被抑制，且不依赖 reviewID。新 message 的 key 不同，仍可学习。

### R8 `restoreVersion` 的保留期读取

签名不含 config，保留期从 `store.readConfig()` 读 `undo.retainDays`（默认 90）。API 层不另传，避免出现“接口能延长保留期”的旁路。

## 修复轮裁决（2026-11-11，fix round 1，依据 `reports/01-review.md`）

### R9（I1）上游恢复后派生项必须可显式恢复，且不自动复活下游

- 禁止自动复活下游：恢复 A 不自动清 B/C 的失效标记，用户必须逐条显式恢复，形成闭环。
- 允许对 `status ∈ {auto, promoted}` 且 `invalidatedBy` 已设置的条目显式 `reactivateItem`：仅当**该条所有 `derivedFrom` 上游当前有效**（`auto/promoted`、无 `invalidatedBy`、未过期）且自身未过期时，清除 `invalidatedBy/invalidatedAt` 并写一条 `restore` 事件。
- `archived + supersededBy="deactivate"` 且带 `invalidatedBy` 的行同样可恢复（先停用、上游恢复后再恢复的闭环），失败原因必须准确指向“上游已失效：<id>”，不得落回“仍在生效”分支。
- 上游仍无效 → `conflict` 且消息包含具体上游 id；不得用 `status` 分支掩盖。
- 同事务、CAS（`expectedVersion`）、完整快照与事件不变；测试必须让请求真正进入上游检查分支（B 为 `auto + invalidatedBy`，而不仅 `archived`）。

### R10（M1/M2/M4/M6/M7 提升为本轮 blocking）

原 review 标 Minor，但它们分别违反：事件真实性（M1 幽灵 `update` 会挡住更早撤销并复活下游失效）、路由契约 `:id`（M2）、同源抑制（M4）、写锁可用性（M6）、以及“下一请求停用”的核心承诺（M7）。本轮不延后、不降级。

### R11（M6）一次闭包 + 一次批量写，不静默截断

- 一次 `listItems()` 在内存建依赖闭包（`derivedFrom` + `supersededBy` 指向），`visited` 防环，**取消任意深度上限**（有限图求全闭包）。
- 失效集合一次 `store.applyItemChanges(before, after)` 批量写（仍保留 CAS 与 maintenance journal），写前为每条预置 `changeID`，再逐条 `recordChange`（1 item 1 事件）。
- 环命中写**一条**有界 changelog `invalidate_cycle`（含 root、环上 id、数量），不无限记录；不返回“已停用却留后代有效”的状态。
- 测试：300 fanout 与 ≥25 层链路全部失效、`event.system` 不含后代；实测耗时只上报，不做脆弱时间断言。

### R12（M7）转义结构标记 + 精确 owned 边界（fix2 修订，见 R15）

- `buildContext` 生成 block 时即把条目正文里的 `<context` / `</context>` 转义为 `&lt;context` / `&lt;/context`，因此 `entry.put` 持久化的 value 与 `event.system` 拼接两条通道一致，新块不会再破坏宿主结构；`renderContext` 的转义保留为幂等第二层。
- 边界只在可证明时使用（fix2 取代原“上界前最后一个 close”写法）：
  1. metadata 记录可定位 → 精确替换；
  2. part 恰为本插件单块（trim 后以 OPEN 开头、CLOSE 结尾，且各只有一个）→ 整块替换/删除；
  3. 无记录时：第一个 close 之前无 `<context `，且其后的剩余文本在 `<context …>`/`</context>` 上配平 → 替换到该 close。
- 其余（正文含字面 open/额外 close、多个 owned wrapper、尾部不配平）为**歧义**：保留原 part、不追加重复块、不删宿主文本，写一条有界 `context_ambiguous`。此形状下“下一请求排除旧内容”**未获保证**，报告必须写明；真实宿主若出现该形状即阻塞最终验收。
- 必须覆盖**已存在的未转义旧块**（历史数据）；不得用全局 `lastIndexOf("</context>")`、泛匹配或标题等弱规则猜边界或删宿主内容。

### R13（I3）legacy 入口真实覆盖 + 全字段差异

- `recordItemDiff` 的“变化”判定改为全字段比较，仅忽略 `changeID/updatedAt/seenCount/lastSeenAt` 这类非语义变动；`expiresAt/derivedFrom/invalidatedBy/aliases/sources/supersededBy/status/text/...` 任一变化都必须产生事件。
- 补真实 API 测试：`/api/recovery/:id/restore` 与 `/api/maintenance/:id/undo` 每个 changed item 恰好 1 条事件、失败零写、无变化无幽灵事件。
- 报告 §3.9 的旧表述作废，改用新测试路径。

### R14（M5）重复 id fail-fast，零覆盖

`recordChange` 发现 `item.changeID` 已存在于 `changes.jsonl` 时直接抛错（不静默换 id、不改快照）。测试证明：抛错后账本长度不变、旧 `change-journal/<id>.json` 的 `undone` 不被覆盖。

## 修复轮 2 裁决（2026-11-11，fix round 2，依据 `reports/01-review.md` §7）

本轮只修 M7（含 N1 误删 host）、N2（fix1 引入的撤销旁路 + 多余备份）与旧回滚文档；I1–I3/M1–M6 已独立闭合，不重写。

### R15（M7/N1）owned 边界只做“可证明”的替换，歧义不猜

支持的 shape（每条都有无 metadata 的测试）：

1. **有 metadata 记录**：`metadata.experimental.instructions` 含 `key="plugin.memory-autopilot"` 的 `{key,text}` → 用记录文本精确定位 wrapper，整块（含 wrapper）替换；这是首选路径。
2. **part 就是本插件单块**：`trim()` 后 `startsWith(OPEN)`、`endsWith(CLOSE)`，且全 part 只有一个 OPEN、一个 CLOSE、**且 OPEN 之外没有任何 `<context `** → 整块替换/删除。缺少最后一条会把“我们的块未闭合 + 紧随一个宿主块”（S1/S2）误判成单块并删除宿主文本（fix3/N4）。
3. **无记录但可判边界**：从 OPEN 起第一个 `</context>` 作为候选，仅当（a）OPEN 与候选之间没有 `<context `，且（b）候选之后的剩余文本在 `<context …>`/`</context>` 上**配平**（允许相邻其他宿主的完整块）→ 替换到该候选。

其余情况一律**歧义**：保留原 part 不动、**不追加**重复 owned part、不删除任何宿主文本；`applyContextRequest` 写一条**有界** `context_ambiguous` changelog（每进程每 session+shape 一次，只含 part 序号/计数，不含正文）。此时“下一请求排除旧内容”**未获保证**，报告必须如实写明。

删除 fix1 的全局 `lastIndexOf("</context>")` 兜底：它没有任何输入能证明边界，实测会删掉其他宿主块（N1）。

两条渲染通道一致：`buildContext` 生成 block 时即转义 `<context`/`</context>`，因此 `entry.put` 持久化的 value 与 `event.system` 拼接都不含裸结构标记；`renderContext` 的转义保留为幂等的第二层。转义不改变 `itemContentVersion`/`memoryVersion`/去重与版本语义（只改渲染文本）。

明确不支持的 shape（真实 host 若出现即阻塞最终验收，不是“已闭合”）：无 metadata、正文含字面 `<context ` 或额外 `</context>` 导致候选 close 不能唯一确定。测试用 A（close+fake-open）、B/B2（fake-open 无 close）证明**不误删 host**，并断言该形状下保留原 part + 记 `context_ambiguous`，不声称停用已生效。

### R16（N2）批量失效不得生成可绕过上游检查的撤销入口

`invalidateDerived` 改为在同一事务内用 `store.replaceItems(after)` 一次写入：不再创建 `maintenance_<id>.json` 与全库 `items.jsonl.bak`，因而不产生可由 `POST /api/maintenance/:id/undo` 触发、在上游仍 archived 时复活下游的旁路。保留一次闭包计算、每 item 一条 `invalidate` 事件、环审计。不动 Store 的事务/WAL 实现；`compact`/`curator` 的正常 maintenance journal 与其 undo 不回归（`api-undo-legacy.test.ts` 继续覆盖）。恢复 invalidated 行仍只走显式 `reactivateItem`（含上游校验）。

并发说明：事务内已持文件锁并读己写，`replaceItems` 写入的是本次事务读到的最新集合；不再需要 `applyItemChanges` 的 per-item CAS 作为语义保护（它引入的正是本轮要移除的副作用）。

### R17（文档）旧回滚说明作废

`reports/01-reversible-memory.md` §7 改为 **Superseded by `reports/06-preflight.md` §2**：删除“直接删账本/新增字段可保留”的可执行建议，改为指向 checkpoint 契约与兼容损失清单（悬空 changeID、invalidated 复活风险、deactivate 90 天清理、derivedFrom 丢失、scope 历史不可恢复、suppressions/事件历史）。不重写 P06 工具。

## 风险

| 风险 | 处理 |
|---|---|
| 现有写入路径多，漏写事件 | 先集中到 `recordChange`；测试覆盖 approve/merge/promote/auto/curator；code review 查每个 `appendItem/updateItem/archiveItem` |
| 事务嵌套/锁顺序 | 复用 `store.transaction`（AsyncLocalStorage + 文件锁）；禁止在事件写里再开事务 |
| `memoryVersion` 性能 | mtime+size + nearest-expiry 状态缓存；只在 context hook 调用；20 轮测试 |
| 旧 journal 无快照 | `restoreVersion` 明确拒绝；不猜 |
| UI/API 误用 | 三个 POST 只接受 token API；agent tool 不注册这些 action |
