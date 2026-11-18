# P01 reversible-memory — 实施报告

Date: 2026-11-11
Phase doc: `phases/01-reversible-memory.md`（含「实现裁决 R1–R8」与两轮「修复轮裁决 R9–R17」）
Baseline: `b992a2e` / `feat/full-auto-memory`；版本号未改（0.5.0）
Scope: 只改本 worktree 的产品代码与测试；未提交、未推送、未打 tag；未触碰 `~/.config/opencode` 与正式数据。

## 1. 结论

DONE。接口按 `DESIGN.md` §8.1 落地，签名无偏移；所有签名以外的补充只写在 phase01「实现裁决」里。

- `npm run verify` **exit 0**：`Test Files 72 passed (72)` / `Tests 896 passed (896)`（baseline 63/803，新增 9 个测试文件、93 个用例，无减少、无断言下调）。
- 日志：`tmp/full-auto-memory/verification/verify-p01-fix3.log`（39759 bytes）；退出码：`tmp/full-auto-memory/verification/verify-p01-fix3.exit`（`exit=0`）。前几轮日志 `verify-p01.log`、`verify-p01-fix1.log`、`verify-p01-fix2.log` 保留作历史。
- `grep -rn "as any\|@ts-ignore\|@ts-expect-error" plugin/src console/src extension/src` → 无匹配。
- 未新增依赖，lockfile 未改，未发起任何模型/网络调用。

## 2. 文件与改动

### 新增产品代码

| 文件 | 内容 |
|---|---|
| `plugin/src/changes.ts` | `itemSnapshot`、`recordChange`、`newChangeID`、`stampChange`、`recordItemDiff`、`deactivateItem`、`reactivateItem`、`revertChange`、`restoreVersion`、`invalidateDerived` |
| `plugin/src/memory/suppression.ts` | `suppressSource`、`isSuppressed`、`clearSuppression`、`turnHookKey`/`reviewHookKey`/`hookKeysFor`、`suppressionTextHash` |

### 修改

| 文件 | 改动 |
|---|---|
| `plugin/src/types.ts` | `ChangeKind/ChangeActor/ItemSnapshot/ChangeEvent/ChangeJournal/Suppression/UndoConfig/RevertResult`；`Item.changeID/invalidatedBy/invalidatedAt/derivedFrom`；`SessionState.contextVersion`；`AutoMemConfig.undo` |
| `plugin/src/config.ts` | `DEFAULT_CONFIG.undo.retainDays = 90`；`ConfigPatch.undo`；`mergeConfig` 嵌套合并（不互相覆盖） |
| `plugin/src/store.ts` | `changes.jsonl` / `suppressions.jsonl` / `change-journal/` 路径与初始化；`appendChange`/`listChanges`/`writeChangeJournal`/`readChangeJournal`/`listSuppressions`/`appendSuppression`/`writeSuppressions`；`memoryVersion(now?)`（文件身份 + nearest-expiry 缓存）；`inTransaction`；`replaceItem`（整体替换，不做字段合并） |
| `plugin/src/plugin.ts` | `refreshContext` 改为「版本比较 → 必要时重建」；`buildContext(store, config, projectKey?, now?)` 过滤 expired/invalidated；渲染文本相同则不 `entry.put` |
| `plugin/src/consolidate.ts` | 自动写入在同一事务内 `recordChange(kind=add)`；候选进模型前先查同源抑制，命中则 `ignored` + changelog `suppressed_after_revert` |
| `plugin/src/actions.ts` | approve / promote / deny 写事件（`add` / `promote` / `add(denied)`），item 预置 `changeID` |
| `plugin/src/apply.ts` | merge_into → `merge`；replace → `replace`(旧行归档) + `update`(目标)；create/keep_both/reject_duplicate → `add`；`undoMerge` → 按 journal 快照写 `revert` 并 `reverts` 指向原变更 |
| `plugin/src/memory/session-promotion.ts` | session-note 提升写 `promote` 事件 |
| `plugin/src/memory/curator.ts` | 过期 → `expire`，精确去重 → `update`(canonical) + `merge`(被归档行)；写入前预置 changeID，使 `journal.after` 与 item 一致 |
| `plugin/src/compact.ts` | 压缩写入包进事务，canonical → `update`、重复行 → `archive`，同样预置 changeID |
| `plugin/src/server.ts` | 新增 `/api/memory/items`、`/api/items/:id/changes`、`/api/items/:id/{deactivate,reactivate,revert,restore}`、`/api/changes`；legacy `/api/recovery/:id/restore`、`/api/maintenance/:id/undo` 补事件；`/api/items` 原样 `{ items: Item[] }` |
| `plugin/src/retention.ts` | `supersededBy="deactivate"` 的停止项不被 90 天归档清理（R2），其余保留/容量规则不动 |

### 新增测试（7 个文件）

`changes.test.ts`(13)、`revert.test.ts`(8)、`restore.test.ts`(7)、`derived.test.ts`(5)、`suppression.test.ts`(5)、`context-version.test.ts`(12，含 6 个真实生命周期用例)、`api-items.test.ts`(9)。
`transaction.test.ts` +1（撤销中断重放）、`retention.test.ts` +1（停止项保护）。合计 +61。

## 3. 行为要点与证据

### 3.1 无损事件快照 + 同事务

- `recordChange` 必须在 `store.transaction` 内，否则抛 `recordChange must run inside store.transaction`（`changes.test.ts` → `refuses to write a change outside a transaction`）。
- 事件 `before/after` 是 `structuredClone(Item)` 全量快照；`itemVersion = itemContentVersion(after)`。测例 `keeps every identity field in a lossless snapshot` 逐字段断言 projectKey/derivedFrom/aliases/sources/expiry/manual/reviewType/reviewID 等。
- 写入失败两侧都不落盘：`rolls back the item when the ledger write fails`（抛错 + `{ok:false}` 两条路径）。
- `change-journal/<changeID>.json` 与事件一一对应；撤销时 `undoing → undone` 在同一文件批次内提交（`replays an interrupted undo without leaving a half state` 在每个 rename 边界杀进程后校验「全成」或「全不成」，且未提交时可重试成功）。

### 3.2 停止使用 / 恢复使用（无时限）

`deactivateItem`：CAS 版本 → `status=archived` + `supersededBy="deactivate"` + `deactivate` 事件 + 同源抑制 + 递归派生失效。
`reactivateItem`：只接受 `status=archived && supersededBy="deactivate"`，拒绝 superseded / invalidated / expired / 上游无效；写 `restore` 事件并清除抑制。
测例：`stops injection immediately with no time limit and re-allows it later`、`refuses to revive superseded, expired or invalidated rows`。

### 3.3 撤销（不受 24h 限制，无「仅恢复文本」）

- 有 `before` → 把旧版本整体写回（`replaceItem`，非字段合并）；无 `before` → 归档并抑制。
- version 不符 → `version_mismatch`，零写入；账本中该 item 在目标事件之后还有事件 → `conflict`（`refuses to overwrite a later edit and never restores only text`、`does not reopen an item invalidated by an upstream undo`）。
- 已撤销/不可撤销 kind → `not_revertible`。
- 撤销成功即递归 `invalidateDerived`。

### 3.4 恢复旧版本（默认 90 天，可配置）

- 只接受完整 `after` 快照（缺字段 → `not_revertible`，不猜旧 journal）；`status` 必须是 auto/promoted；`scope`/`projectKey` 必须与当前一致；超过 `config.undo.retainDays` → `not_revertible`（默认 90；配置 200 后同一条历史版本可恢复）；上游无效 → `conflict`。
- 测例全部在 `restore.test.ts`（含“不 partial merge”：restore 后 `manual` 等仅当前版本有的字段不会残留）。

> 这里发现并修掉一个真实缺陷：初版用 `updateItem` 的合并语义恢复，会把当前版本独有的 `manual: true` 留在恢复后的条目上。测试 `records a full before/after snapshot for the restore event` 先红（`expected undefined, received true`），改为 `store.replaceItem` 整体替换后转绿。这就是「无损快照」的实现级证据。

### 3.5 递归派生失效

`invalidateDerived`：BFS + visited + 深度上限 20；下游 = `derivedFrom` 指向它，或 `supersededBy` 指向它；只标 `auto/promoted`，写 `invalidatedBy/invalidatedAt` 与每条 `invalidate` 事件；manual/promoted 只停止注入、不归档。
测例：A→B→C 递归（`follows A -> B -> C recursively and drops them from the injected block`）、环 A→B→C→A 终止（`terminates on a derived cycle instead of looping`）、上游无效拒绝 reactivate/restore。

### 3.6 memoryVersion 与 context

- `memoryVersion(now?)` = `sha16` over 排序后的 active 行 `[id, itemContentVersion, expiresAt]` + `expiredCount` + `nextExpiry`；排除 `expiresAt<=now` 与 `invalidatedBy`。
- 进程内缓存以 `(mtimeMs, size, ino)` 为键，并用 `nextExpiry` 兜住「文件没变但时钟跨过到期点」；事务内绕过缓存。
- 测例 `changes the version when the clock crosses an expiry with no write` 先取 `stat` 记录 mtime/size，跨期后断言**文件未变**而 version 变化、block 排除该项；`keeps the version stable across reads but reacts to an external write` 用第二个 Store 实例写盘验证跨进程失效。
- `refreshContext`：`contextVersion === memoryVersion()` 且 projectKey 相同 → 直接返回（不重建、不 `entry.put`）；否则重建，仅当渲染文本不同才 `entry.put`。
- 旧 session：`excludes a stopped item on the next request of an already existing session`（同一 session 第二次 refresh 后 `entry.put` 的 block 不含已停止项）；`includes new memory on the next request instead of pinning it forever`（版本失效后新记忆进入下一请求，稳定 prefix 语义只约束「无变更」）。
- hook 挂载点未变（`plugin.ts` 的 `ctx.session.hook("context")` 每次请求都走 `applyContextRequest`），所以失效不只靠 API 触发。

#### 3.6.1 真实生命周期：只更新 state/`entry.put` 不够（P04 预检同步的事实）

V2 官方文档（原文与出处见 `reports/04-preflight.md` §2.1）：

> Entries render as `<context key="...">` blocks in the session's instructions, and updates or removals are **announced at the next step boundary** without queuing a message turn.

> The `system` part that holds OpenCode's instructions also lists each source in `metadata.experimental.instructions` as `{ key, text }` … The list is a **copy**: editing the part's `text` does not update it.

本地 SDK 形状一致：`SystemPart = { type:"text"; text:string; cache?; metadata?: Record<string, unknown> }`（`@opencode/ai/dist/schema/messages.d.ts`）。

因此原来的实现（deactivate → 改 session state → `entry.put` → 等宿主替换）**不能保证“下一次请求”**：下一次请求的 `event.system` 仍是宿主在上一个 step 组装的旧块，`entry.put` 要到下一个 step boundary 才宣布。这不是文档推断，下面用 fake host 复现了“宿主继续用旧 entry 组装 system”的时序。

P01 的修正（`plugin/src/plugin.ts`）：

- `applyContextRequest(ctx, store, config, event, projectKey?)`：每次 context 请求先 `resolveContext` 拿权威 block，再 `applyOwnedContext(event.system, renderContext(block))` 原地替换本插件自己的内容。
- `applyOwnedContext(parts, text)` 是纯函数（不改入参，返回新数组），定位顺序：
  1. 文本里的 `<context key="plugin.memory-autopilot"> … </context>` 标记 → 只替换块内内容（保留同一 part 里其他来源的文字）；
  2. `metadata.experimental.instructions` 里 `key === "plugin.memory-autopilot"` 的 `{key, text}` 副本 → 专属 part 整体替换，或大 part 里只替换那一段记录文本；
  3. 都没有 → 追加一个带同一 key 的 part（不会重复追加，下一次能定位）。
- 新文本为空时只移除自己的块/part；其他宿主的 system parts、`event.messages`（用户聊天历史）一律不碰。找不到受控内容时不会“模糊删除包含 AUTOPILOT 的文本”。
- `refreshContext` 保持 `DESIGN §7.2` 的 `Promise<void>`（内部调用 `resolveContext`），API/tool 调用方不需要改。
- 该 helper 是 P04 的共用点：P04 只追加自己的动态 block，不重写 P01 的稳定 prefix。

测试（`context-version.test.ts` → `real context hook lifecycle`，6 个用例）：

- `drops a stopped item on the next request even when the host still carries the old block`：第 1 次请求的 `event.system` 含旧 pinned 块；deactivate 后第 2 次请求**仍用同一份旧入口文本**（模拟 step boundary 未到）→ 断言 OpenMem 块里已无被停止的正文、`## AUTOPILOT` 仍在、其他两个宿主 part 字节不变、parts 数量不变、`messages` 深比较不变、`entry.put` 也更新了后续通道。
- `rewrites event.system through the hook that setupPlugin actually registers`：用 `setupPlugin` 捕获真实注册的 hook，再发两次 context 请求，证明不是只测 helper。
- 另外 3 个纯函数用例覆盖：仅 metadata 的专属 part、共享 instructions part 只替换记录副本、缺失时追加一次不重复、空文本只删除自己的块。

红/绿证据（真实命令）：

```text
# 临时把 applyContextRequest 的 splice 关掉（模拟“只 entry.put”的旧实现）
OPENMEM_RED_CHECK=1 npx vitest run test/context-version.test.ts -t "next request"
→ 1 failed：ownedTextOf(second.system) 仍含「要被停止的偏好」，并打印旧 AUTOPILOT 块

# 恢复真实实现
npx vitest run test/context-version.test.ts
→ Tests 12 passed (12)
```

也就是说：若只做 state/`entry.put`，本阶段最核心的“下一次请求即排除”会失败；现在它由真实 hook + fake host 时序保证。

### 3.7 同源抑制

- 键格式与现有捕获完全一致：turn `session|message|textHash`、review `review|session|message|textHash`，`textHash = sha16(normalizeForFingerprint(text))`；同一 source 两路都写，因此 turn 捕获与复盘捕获互通，且不依赖 reviewID。
- 新 message → 不同键 → 不抑制（明确纠正可重新学习）；`until` 到期后不再抑制；`restoreVersion`/`reactivateItem` 清除该 item 的抑制。
- 候选进入模型前先查抑制：`consolidate.ts` 命中即 `ignored(error=suppressed_after_revert)` + changelog `suppressed_after_revert`，不产生新待办（`ignores a re-captured hook from the reverted source and logs why`）。

### 3.8 API

- 旧 `GET /api/items` 形状不变：`keeps the legacy /api/items response shape byte-compatible` 断言 `Object.keys(body) === ["items"]` 且行内没有 `version`/`latestChange`。
- 新 envelope 只在 `/api/memory/items`：返回 `{ items: Array<Item & {version, changeID?, latestChange?, source, revertible}> }`；支持 `status/scope/projectKey/q/includeArchived`。
- `deactivate/reactivate/revert/restore` 都要求 `expectedVersion`；冲突 409 且带当前 `version`；`not_found` → 404；`not_revertible`/`conflict` → 409。
- 无 token 全部 401（8 条路由逐条断言）；body 里的 `source` 被忽略（事件 `source` 等于条目真实来源）。
- agent tool 未注册撤销/恢复动作：`exposes no undo/restore action to the agent tool` 读取 `plugin/src/plugin.ts` 的 action enum 断言不含四个动作。

### 3.9 写入路径覆盖（不漏路径）

`changes.test.ts` 的 `every write path records a change event` 覆盖：auto（同源抑制测例走真实 `runConsolidation` 自动写入）、approve(+edit)、promote、merge_into、replace、legacy `undoMerge`、session-note promotion、curator（expire/merge/update）、compaction。
另有 `recordItemDiff` 覆盖 legacy `/api/recovery/:id/restore` 与 `/api/maintenance/:id/undo`：调用前后读 items，按**全字段语义快照**（仅忽略 `changeID/updatedAt/seenCount/lastSeenAt`）逐条写事件并推进版本。

> 修复轮更正（原表述失实）：P01 首轮并没有这两条入口的测试证据（`grep -rn recordItemDiff plugin/test` 为 0）。现在由 `plugin/test/api-undo-legacy.test.ts`（4 例：recovery/maintenance 各「恰好 1 条事件 + 重复操作 409 零写」）与 `changes.test.ts` 的 `recordItemDiff covers semantic fields`（2 例：`derivedFrom/expiresAt/invalidatedBy` 变化必产生事件；纯计数变化不产生事件）真实覆盖。
可证明不写事件的路径见 phase01 R6（`touchItem` 只改 seenCount/sources/lastSeenAt；`cli demo` 不在运行时调用图）。

## 4. TDD 证据（真实命令）

| 步骤 | 命令 | 观察 |
|---|---|---|
| RED（事件底座） | `cd plugin && npx vitest run test/changes.test.ts` | `Failed to load url ../src/changes.js ... Test Files 1 failed (1) / Tests no tests` |
| GREEN 前 5 项 | 同上 | `Tests 8 failed | 5 passed (13)`，失败项正是尚未接入事件的写入路径 |
| GREEN 全部 | 同上 | `Tests 13 passed (13)` |
| RED（恢复语义） | `npx vitest run test/restore.test.ts` | `expected true to be undefined`（`manual` 从当前版本泄漏）→ 改 `replaceItem` |
| GREEN | 同上 | `Tests 7 passed (7)` |
| RED（retention 保护） | `npx vitest run test/retention.test.ts` | `expected 0, received 1`（停止项被当作可清理） |
| GREEN | 同上 | `Tests 11 passed (11)` |
| 全量 | `npm test`（plugin） | `Test Files 70 passed (70) / Tests 864 passed (864)` |
| 阶段门禁 | `npm run verify` | `exit=0`，日志见 §1 |

补充：真实生命周期这一项单独做了红/绿验证，避免“只断言 `entry.put`”的假通过——临时把当次 `event.system` 替换关掉（模拟只写 state 的实现）后，`OPENMEM_RED_CHECK=1 npx vitest run test/context-version.test.ts -t "next request"` 变为 `1 failed`，旧块里的被停用正文仍在；恢复真实实现后 `Tests 12 passed (12)`。详见 §3.6.1。

失败时按 systematic-debugging 处理：先看真实断言与调用链再改代码；「restore 泄漏字段」是代码缺陷（不是测试错），「revert 409」是测试用了陈旧变更（代码按设计拒绝后续编辑后的撤销），两者都单独定位后分别修正。

## 5. 与 DESIGN/PLAN 的对应

| 要求 | 状态 | 证据 |
|---|---|---|
| `DESIGN §8.1` 签名不偏移 | 是 | `changes.ts` 导出与 §8.1 逐项一致；补充项（`newChangeID`/`stampChange`/`recordItemDiff`/`invalidateDerived`）写在 phase01 R3/R7 |
| 旧 `/api/items` 形状不变 | 是 | `api-items.test.ts` 形状断言 |
| 新 envelope/详情/changes/四个 POST/`/api/changes` | 是 | 同上 + `requires a token for every memory route` |
| mutation version 校验、409 不写 | 是 | `api-items.test.ts` 409 用例检查账本长度不变 |
| item/change 同 WAL 事务 | 是 | `changes.test.ts` 回滚用例 + `transaction.test.ts` 撤销中断重放 |
| 停止使用无时限、恢复使用只对合法停止项 | 是 | `revert.test.ts` 两组用例 |
| 版本回退 90 天可配置、只接受完整快照/scope 不变 | 是 | `restore.test.ts` |
| 后续编辑拒绝 revert；restore 对当前 CAS 不混同 | 是 | `changes.test.ts` + `restore.test.ts` |
| 递归派生失效 + 环保护 + 不越过无效上游 | 是 | `derived.test.ts` |
| 同源抑制（turn/review 互通、新 message 可学） | 是 | `suppression.test.ts` + `revert.test.ts` |
| `memoryVersion` nearest-expiry、无写入跨期失效、外部写 | 是 | `context-version.test.ts` |
| 每次真实 model-request context hook 刷新版本 | 是（代码路径 + fake host） | `applyContextRequest` 在每次 `ctx.session.hook("context")` 内 `resolveContext`；`context-version.test.ts` 用注册后的真实 hook 验证 |
| 真实 lifecycle：`entry.put` 不替换当次 `event.system` | 是 | `applyContextRequest` + `applyOwnedContext`；`real context hook lifecycle` 用旧块 + deactivate 的两次请求验证，关掉替换即失败 |
| 持久 prefix 与 fallback 两路都排除 | 是 | 同一 helper 覆盖有/无 `entry`；其他宿主 parts 与 `event.messages` 不动 |
| 保留旧 gate（不扩大自动化） | 是 | 未改 `canAutoApply`；`autoRules`/review/session 行为一字未动 |

## 6. 未完成 / 边界 / 风险（不隐藏）

1. **retention/capacity 全量接入归 P06**（R2，依据 `reports/00-preflight.md` §3/§4.5 与 PLAN P06 清单）。P01 只做必须的一步：停止项不被 90 天清理。因此 `changes/suppressions/change-journal` 目前尚未计入 retention 预览与容量公式——这是明确的后续阶段项，不是「已实现」。
2. **迁移基线事件归 P06**（preflight §3：`apply.ts/actions.ts` 行「P06 迁移只读/基线事件，不重写」）。`applyScopeMigration` 只改 queue 行，不写 items，因此 P01 未给它加事件；P06 的迁移 apply 必须写 `migration` 基线事件。
3. **`/api/memory/items` 暂无 `nextCursor`**：字段在 DESIGN 里是可选的，当前返回全量过滤结果。P05 若需要分页需在后端补 cursor（不改变现有形状）。
4. **恢复旧版本不级联恢复下游**：`restoreVersion`/`reactivateItem` 只恢复本条；被 `invalidate` 的下游保持停止注入，用户可逐条“恢复使用”。这是保守选择（避免自动复活被上游污染过的派生内容），已在 R4 语义内。
5. **`revertChange` 的冲突判定偏保守**：目标事件之后该 item 有任何事件即 `conflict`（含后续 deactivate/expire）。宁可只给“停止使用”，也不覆盖后续状态。
6. **宿主行为未实测，且未发真实模型请求**：「旧 session 下一次请求不含被停用项」由**真实注册的 context hook + fake host**（宿主继续用旧 entry 组装 `event.system`）验证，覆盖的正是文档描述的 step-boundary 时序；但真实 OpenCode V2 端到端调用需要用户单独授权与付费，本轮未执行。已开始请求、已执行外部动作不可追回，符合方向裁决。若现场宿主把 keyed entry 渲染成完全不同的形状（既无 `<context key>` 标记、也无 `metadata.experimental.instructions`），helper 会追加自己的 part 而不是删除未知文本——这种情况下旧块可能仍被宿主渲染，需要在真实宿主上补验。
7. **`Item.changeID` 语义**：由写入路径预生成并写入行；账本是撤销冲突判定的权威（R4）。`touchItem` 这类只改溯源计数、不改 `itemContentVersion` 的路径不写事件、也不刷新 changeID（R6）。
8. **`hookKeysFor` 依赖 `source.sessionID + source.messageID`**：没有 messageID 的来源（例如手工 CLI 演示数据）不会产生抑制键；这类数据本来也不在 turn/review 捕获链路里。

## 7. 回滚方式（Superseded）

> **Superseded by `reports/06-preflight.md` §2 — 不要按本节旧说法执行。**
>
> 旧版本曾写“删 `changes.jsonl`/`suppressions.jsonl`/`change-journal/` 即可，`items.jsonl` 的可选字段可保留”。该说法**不是已验证契约**，会造成：`changeID` 悬空（`revertChange`/`restoreVersion` 全部 `not_found`）、`invalidatedBy` 在旧版被忽略导致已失效内容重新注入、`supersededBy="deactivate"` 保护丢失后 90 天清理、scope 迁移后历史快照不可恢复、suppressions/事件历史不可撤销。另有一类**不来自删账本**的损失：`derivedFrom` 存在 `items.jsonl`，它的丢失来自 P06 兼容导出时剥字段的选项，与删账本无直接因果；两类损失在 P06 报告中分别列出。
>
> 唯一可称“无损”的回滚是 **checkpoint 时点的完整逻辑状态**（items/queue/state/config/changes/suppressions/change-journal/quarantine/migrations/merge-journal/changelog + 被引用历史，位于 `--data` 外，manifest 明确复制；排除 `console-token` 与可重建视图）。无 checkpoint 时的兼容导出默认不写；`--confirm-losses` 后必须逐项报告上述损失。P06 只以 `reports/01-review.md` §4 + `reports/06-preflight.md` §2 为准，本报告不再提供可执行的回滚步骤。
>
> 代码层事实（仅用于理解，不构成回滚指令）：`buildContext` 只读 item 字段，所以删除账本不会立即影响注入；但语义引用会悬空。未提交任何东西，不需要 revert 提交。


## 8. 修复轮 1 逐项处置（依据 `reports/01-review.md`）

方法：每项先复现/断言 RED，再做最小修复；用 reviewer 的三个独立 probe 复跑交叉验证，不拿测试自己的结论代替。修复前快照：`tmp/full-auto-memory/reviews/p01-fix1-before/`；只含本轮 fix 的 diff：`tmp/full-auto-memory/reviews/p01-fix1.patch`。

### I1 — 上游恢复后派生项可显式恢复（blocking）

- 根因：`reactivateItem` 先按 `status !== archived` 拒绝，`invalidatedBy` 分支永远走不到；`status=auto + invalidatedBy` 的行没有任何 UI/API 恢复路径。
- 修复（`changes.ts`）：合法形状扩为两种 —— `archived+supersededBy="deactivate"`，或 `auto/promoted+invalidatedBy`。**先**跑真实上游检查（`derivedFrom ∪ {invalidatedBy}` 全部 active/未过期），通过后清除 `invalidatedBy/invalidatedAt`，写 `restore` 事件（CAS + 同事务）；失败消息包含具体上游 id。**不自动复活下游**。
- RED：`npx vitest run test/derived.test.ts` → `2 failed`（旧用例消息不含上游 id；恢复路径不存在）。
- GREEN：`derived.test.ts` 10 例全过；新增「不自动恢复下游」「逐个恢复 B→C 闭环」「拒绝时点名上游 id」。
- probe：`npx tsx ../tmp/full-auto-memory/reviews/probe-p01.ts` → `reactivate B result: {"ok":true,...}`（原为 `conflict`），显式 deactivate 后也能 `ok:true`；`B after A resumed -> invalidatedBy: item_a` 保持不变（无自动复活）。

### I2 — `undo.retainDays` 进入 PATCH 白名单

- 修复（`server.ts` `applyConfigPatch`）：`assignNumbers(config.undo, body.undo, ["retainDays"])`；`validateNumericPatch` 已有 `>0` 校验。
- RED：`api-undo-config.test.ts` → `PATCH 200` 但 `readConfig().undo.retainDays === 90`。
- GREEN：`2 passed`；测试同时证明「PATCH 后 100 天前的版本可恢复」与「retainDays=0 → 400 且不落盘」。
- probe：`probe-p01b.ts` → `persisted undo: {"retainDays":200}`。

### I3 — legacy 入口真实覆盖 + 全字段差异

- 修复（`changes.ts`）：新增 `semanticSnapshot`，仅忽略 `changeID/updatedAt/seenCount/lastSeenAt`；`expiresAt/derivedFrom/invalidatedBy/aliases/sources/supersededBy` 等任一变化都产生事件。
- RED：`changes.test.ts -t "semantic fields"` → `expected [] to deeply equal ["item_d1","item_d3"]`。
- GREEN：`changes.test.ts` 17 例；新增 `api-undo-legacy.test.ts` 4 例（recovery/maintenance 各「恰好 1 条事件」「重复/不存在 → 409 零写」）。
- 报告 §3.9 原表述已更正（见上），不再声称不存在的证据。

### M1 — compact 幽灵 `update`

- 修复（`compact.ts`）：`clusterMerged` 按组计数，只有本组真的合并过才给 canonical 标 `update`。
- RED：`changes.test.ts -t "merged nothing"` → `item_f1` 收到 1 条幽灵事件。
- GREEN：该用例通过；`probe-p01b.ts` → `events: archive:item_a2, update:item_a1`、`item_b1 events: []`（原来多出 `update:item_b1`）。

### M2 — `:id` 路由一致性

- 修复：`revertChange` 新增可选 `itemID`，与 `target.itemID` 不符返回 `not_found`；server 传 `itemID: id`，broadcast 用 `result.event.itemID`。
- RED：`api-items.test.ts -t "wrong route id"` → 期望 404 实得其他状态。
- GREEN：`10 passed`；B 保持 `auto`、无 `invalidatedBy`、事件数不变。

### M3 — 过期快照

- 修复（`changes.ts`）：写回前 `isExpired(snapshot)` → `not_revertible`（与 reactivate 的过期拒绝一致），零写入。
- RED：`restore.test.ts -t "already expired"` → `result.ok` 为 true。
- GREEN：`8 passed`；probe → `restoreVersion ok: false`，当前版本 `expiresAt` 未被改写。

### M4 — 改写后的同源抑制

- 修复（`apply.ts` create/keep_both）：正文被改写时把原始捕获文本放入 `aliases`，`suppressSource` 会为它派生两路 key。
- RED：`suppression.test.ts -t "rewrite"` → `aliases` 不含原文。
- GREEN：`6 passed`；原文 T 的 turn/review key 均 `isSuppressed === true`。

### M5 — 重复 change id fail-fast

- 修复（`changes.ts`）：`item.changeID` 已在账本存在 → 抛 `change id already exists: <id>`，不静默换 id、不覆盖 journal。
- RED：`changes.test.ts -t "reused id"` → 未抛错、账本多一条。
- GREEN：抛错后账本长度不变、`readChangeJournal(add.id).undone === true` 保持、item 仍 archived。

### M6 — 闭包批量失效（blocking）

- 修复（`changes.ts` `invalidateDerived`）：一次 `listItems()` 建 `derivedFrom`/`supersededBy` 依赖图，BFS + visited + 祖先判定（精确环检测，不用深度上限），一次 `applyItemChanges` 批量写 + 每条一个 `invalidate` 事件；环命中写一条 `invalidate_cycle` changelog。另：change-journal 只对可撤销事件写（DESIGN §5.3/§7.3 的 redo 保护），非可撤销历史仍有完整账本快照——这条把 300 行 fanout 的 fsync 从 300 降到 ~2，已在 phase01 修复轮裁决记录。
- RED：`derived.test.ts` 3 例全红（301 次 `replaceItem`、25 层只到 20、无环审计）。
- GREEN：`10 passed`；断言 `replaceItem` 仅 1 次（根条）、`applyItemChanges` 1 次、300 条事件、25 层全失效、环审计 1 条。
- probe：`probe-p01c.ts` → `invalidated: 300`，`elapsed ms: 220`（review 原值 12256ms）。

### M7 — 结构标记与 owned 边界（blocking）

- 修复（`plugin.ts`）：`renderContext` 对正文里的 `<context` / `</context>` 做幂等转义；`applyOwnedContext` 优先用 `metadata.experimental.instructions` 的记录文本精确定位旧块（正文含字面 open/close 也能整块替换），否则回退到「下一个 `<context ` 为上界 + 上界前最后一个 `</context>`」；空文本只移除自己的块；其他宿主 parts 与 `event.messages` 不动。
- RED：`context-version.test.ts` → 2 failed（未转义、含字面 close 的旧块残留）。
- GREEN：`16 passed`；新增 4 例：转义、旧未转义块含字面 close、body 含 fake open（靠记录文本精确替换）、相邻外部 `<context>` 块不受影响。
- 残余边界（fix2 修订）：无 metadata 记录时只支持三种可证明形状（metadata 精确、part 恰为单块、无记录但 close 前无 `<context ` 且尾部配平）。正文含字面 `<context ` / 额外 `</context>` 的旧未转义块属于**歧义**：保留原 part、不追加重复块、不删宿主文本，并写一条有界 `context_ambiguous`；该形状下“下一请求排除旧内容”**未获保证**；该形状不宣称残留已清除。真实宿主若出现该形状即阻塞最终验收。

### 修复轮对既有承诺的影响

- 旧 API 形状、旧 gate、WAL/CAS、完整快照、用户聊天与宿主其他指令均未改变；`recordChange` 增加重复 id 抛错是**更严**的约束，现有 11 个调用点全部预生成新 id。
- `change-journal` 只对可撤销事件写入：`revertChange` 只读可撤销目标；`restoreVersion` 不读 journal；`undoMerge`/maintenance/recovery 走 `recordItemDiff`。已有测试（`revert.test.ts`、`changes.test.ts`、`transaction.test.ts`）全部通过。
- 新增/调整测试共 22 个：api-undo-config 2、api-undo-legacy 4、changes +4、derived +5、restore +1、suppression +1、context-version +4、api-items +1。

## 9. 修复轮 2 逐项处置（依据 `reports/01-review.md` §7，M7/N1 + N2 + 文档）

范围仅 M7（含 N1 误删 host）、N2（fix1 新引入）与旧回滚文档；I1–I3/M1–M6 已 ADDRESSED，不重写。N3 按裁决 deferred 留 P06。

### M7/N1 — owned 边界只做可证明的替换（blocking）

- 根因（review 7.1.1）：fix1 的 `replaceOwnedBlocks` 在无 metadata 时用“下一个 `<context ` 为上界 + 上界前最后一个 close”，无 close 时再退回**全局** `lastIndexOf("</context>")`；B/B2 因此把相邻宿主块整块删掉，A/C 留下残片。三个旧块测试全部带 metadata，没覆盖 fallback。
- 修复（`plugin.ts`）：
  1. 删除全局 `lastIndexOf` 兜底与整个 `replaceOwnedBlocks`。
  2. `replaceUnrecordedBlock` 只接受三种可证明形状：part 恰为本插件单块（`trim` 后以 OPEN 开头/CLOSE 结尾，各出现一次）→ 整块替换/删除；否则要求唯一 OPEN、OPEN 与第一个 close 之间无 `<context `、且 close 之后在 `<context …>`/`</context>` 上配平 → 替换到该 close。
  3. 其余为歧义：保留原 part、不追加重复块、不删宿主文本；`applyContextRequest` 写**有界** `context_ambiguous`（每进程每 session+shape 一次，只含 part 序号/计数）。
  4. 两条通道一致：转义移到 `buildContext`（`entry.put` 的 value 不再含裸标记），`renderContext` 的转义保留为幂等第二层。
- RED：`context-version.test.ts` 7 例红（无 metadata A/B/B2、单块、安全边界、`entry.put` 转义、`context_ambiguous`）。
- GREEN：`23 passed`；新增 `owned block boundaries without metadata` 6 例 + 既有形状用例。
- probe（review 原始脚本）复跑：

```text
--- A close+fake-open, replace   ... | host kept: true
--- B fake-open no-close, stop    ... | host kept: true
--- B2 fake-open no-close, replace... | host kept: true
--- C close only no fake, replace ... | host kept: true
--- D adjacent host right after open residue [] | host kept: true
```

A/B/B2/C 为歧义形状：保留原 part（residue 仍在）但宿主块完好，并记 `context_ambiguous`；**该形状下停用未获下一请求保证**。D 与单块形状可精确替换。

### N2 — 批量失效不再生成可绕过上游检查的撤销入口（blocking，fix1 引入）

- 根因：`invalidateDerived` 用 `applyItemChanges` 批量写，会创建 `maintenance_<id>.json` + 全库 `items.jsonl.bak`，暴露 `POST /api/maintenance/:id/undo`：在 A 仍 archived 时把 B 恢复为 auto 并清 `invalidatedBy`，`buildContext` 重新注入（probe 实测）。
- 修复（`changes.ts`）：同一事务内改为 `store.replaceItems(after)` 一次全量写；保留一次闭包、每 item 一条 `invalidate` 事件、环审计。不动 Store 事务/WAL。
- RED：`derived.test.ts` 2 例红（fanout 断言 `replaceItems`/`applyItemChanges===0`；新用例断言无 `maintenance/` 与 `.bak`）。
- GREEN：`11 passed`；fanout 215ms；`probe-fix1.ts` → `maintenance files: []`（无 journal、无 bak、无 undo 入口）。
- 不回归：`api-undo-legacy.test.ts` 4 例仍覆盖 `compact` 产生的正常 maintenance journal 与其 undo（`maintenance undo records exactly one event per changed item`）。恢复 invalidated 行仍只走显式 `reactivateItem`（含上游校验）。

### 文档 §7 — 旧回滚说明作废

`reports/01-reversible-memory.md` §7 改为 **Superseded by `reports/06-preflight.md` §2**，删除“直接删账本/字段可保留”的可执行建议，列出六类兼容损失，并要求以 checkpoint（完整逻辑状态）为唯一“无损”路径；不重写 P06 工具。

### 本轮门禁与证据

- `npm run verify` exit 0：`Test Files 72 passed (72)` / `Tests 894 passed (894)`；日志 `tmp/full-auto-memory/verification/verify-p01-fix2.log` / `.exit`。
- 定向：`context-version.test.ts` 23、`derived.test.ts` 11、`api-undo-legacy.test.ts` 4、`api-items.test.ts` 10、`api-undo-config.test.ts` 2 全绿；`probe-fix1.ts` 如上。
- 本轮 diff：`tmp/full-auto-memory/reviews/p01-fix2.patch`（含新增/修改测试与文档）；before 快照 `tmp/full-auto-memory/reviews/p01-fix2-before/`。

### 修复轮 2 之后的真实边界

- 支持的 owned 形状：metadata 记录、单块 part、无记录但边界可证明。**不支持**：无 metadata 且正文含字面 `<context `/额外 `</context>` 的旧未转义块——不猜、不删，记 `context_ambiguous`，下一请求停用未获保证。
- 歧义路径下**当次请求的新增内容也不会注入**（`handled=true` 抑制追加），要等宿主重建 part 或 `entry.put` 在下一 step boundary 生效后才可见；这不是“只残留旧内容”，报告与 UI 文案都不能把它当成停用已生效。
- 真实 OpenCode V2 宿主的 `event.system` 形状与 metadata 记录行为仍未实测；P06 若出现不支持形状即阻塞最终验收。不得把“保守不删”当作“停用已闭合”。

## 10. 修复轮 3 逐项处置（依据 `reports/01-review.md` §8.2/§8.4，N4）

范围仅 N4（`isSingleOwnedBlock` 单块判据）与报告半句说明；P01 对外接口、M7/N2 已闭合部分、N3 均未改动。

### N4 — 单块判据必须排除“OPEN 之后还有 `<context `”

- 根因（review 8.2）：`isSingleOwnedBlock` 只数“我们的 OPEN 1 个、`</context>` 1 个”，没有排除 OPEN 之后出现的其他 `<context `。当宿主组装出“我们的块未闭合 + 紧随一个宿主块”（S1/S2）时，唯一的 close 属于宿主，判据却把它当单块整块替换/删除 → 宿主文本丢失且无审计。
- 修复（`plugin.ts`，1 行判据）：追加 `countOccurrences(text, "<context ") === 1`（我们的 OPEN 是唯一的 `<context `）。S1/S2 随即落入 shape 2 的“正文含 `<context `”分支 → `undefined` → 保留原 part、不追加重复块、记 `context_ambiguous`。
- RED：`context-version.test.ts` 新增 S1/S2 两例（stop 与 replace 各跑一次）→ `2 failed`（`host` 被删、`ambiguous=[]`）。
- GREEN：`25 passed`；`probe-fix2.ts` 复跑：

```text
[S1 nested host, stop]     ambiguous=[0] host=true residue=["OLD"] parts=1
[S1 nested host, replace]  ambiguous=[0] host=true residue=["OLD"] parts=1
[S2 unclosed ours + host after] ambiguous=[0] host=true residue=["OLD"] parts=1
```

（原为 `ambiguous=[] host=false parts=0/1`，宿主块被删。）

### 文档两处措辞

- §9 增补：歧义路径下**当次请求的新增内容也不会注入**（`handled=true` 抑制追加），要等宿主重建 part 或 `entry.put` 在下一 step boundary 生效；避免被读成“只是旧内容残留”。
- §7：把 `derivedFrom` 从“删账本造成的损失”里拆出——它存在 `items.jsonl`，丢失来自 P06 兼容导出剥字段选项，与删账本无直接因果；两类损失分别列出。

### 本轮门禁与证据

- `npm run verify` exit 0：`Test Files 72 passed (72)` / `Tests 896 passed (896)`；日志 `tmp/full-auto-memory/verification/verify-p01-fix3.log`（39759 bytes）/ `.exit`；类型检查包含在 verify 内（`tsc --noEmit` 无输出）。
- 定向：`context-version.test.ts` 25 全绿；`probe-fix2.ts` 如上；未重跑/未修改任何旧日志。
- 本轮 diff：`tmp/full-auto-memory/reviews/p01-fix3.patch`；before 快照 `tmp/full-auto-memory/reviews/p01-fix3-before/`。

### 边界（未变）

- P01 对外接口可冻结供 P02；**P06 保留真实 host 实际运行门禁**：宿主若出现不支持形状（无 metadata 且正文含字面 `<context `/额外 `</context>`）即阻塞最终验收。本轮不声称整体最终目标已验收。

