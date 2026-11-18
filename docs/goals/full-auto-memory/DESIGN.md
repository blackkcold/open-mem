# OpenMem 全自动记忆 · DESIGN

Version: 1.0
Status: P0 设计冻结（实现未开始）
Baseline: `b992a2e` (v0.5.0, audited running)
Branch: `feat/full-auto-memory`
Worktree: `/Users/11169285/.local/share/opencode/worktree/91548720c853e67e562f9f15a753b3403633633e/full-auto-memory`
UX 输入: `reports/ux-contract.md`（UX 作者修订中；P0 只引用，不修改）

本文件只定义设计与阶段契约，不含产品代码。实施从 `phases/01-reversible-memory.md` 开始。

## 1. 边界与不变量

### 1.1 路径边界（硬性）

| 对象 | 规则 |
|---|---|
| 原正式仓库 `/Users/11169285/Documents/Opencode project/open-mem` | 只读参考；本目标内绝不写入、切换、提交 |
| 真实数据 `~/.config/opencode/memory/autopilot` | 绝不读写；任何脚本/测试/演练不得解析、备份、迁移该路径 |
| `~/.config/opencode` 配置、skills、agents | 不修改 |
| 本 worktree | 唯一代码与文档写入位置 |
| 测试/演练数据 | 仅 `plugin/test` 的 `mkdtemp`、本 worktree `tmp/full-auto-memory/**`、`tmp/ux-smoke-*` |
| 付费模型调用 | P0–P07 一律不发起；测试全部使用 stub/fake |

### 1.2 既有能力不变量

以下能力在全部阶段保留，不得删除、降级或以“简化”为名绕过：

- `Store` 的跨进程文件锁、live PID 检测与 stale 抢占（`plugin/src/util/lock.ts` 已有；不要把“锁会抢占活进程”写成缺陷）。
- 多文件提交的 redo WAL、fsync/rename、启动重放、`maintenance/`、`recovery/`、`merge-journal.jsonl`。
- `itemContentVersion` / `queueItemSnapshotVersion` / target-version 校验与 409 语义。
- 受保护类别（rule/safety/permission/destructive/strict_limit/硬冲突）的审批、apply、undo、promotion 人审路径与安全守卫保留。
- `npm run verify` 的全部内容：Vitest、三处 typecheck、plugin/console build、extension bundle、extension proxy test、`git diff --check`。
- 现有测试断言不降低。新增行为通过“默认关闭 + 显式开启”的配置分支实现，旧 fixture 不改语义。

### 1.3 不可声明

- 不声称 30 天现场运行通过。`scripts/soak-30d.mjs` 是加速模拟，报告必须标注 `simulated`；现场运行尚未执行。
- 不声称正式迁移完成或已正式启用。P06 只交付工具 + 隔离演练；正式启用需用户另行确认。
- 不声称撤销可清除所有副本；P0 的撤销只保证“不再注入 + 可恢复”。全机（含备份）彻底 erase 不在本轮必实现范围。
- 不承诺云端数据删除。本产品无云端同步；后台模型调用仍可能把必要输入发往模型提供方（出网），这是现有能力，不因“自动记忆”改变。
- 不声称 OpenCode V2 API 已核对。实现阶段必须查 V2 官方文档/SDK（当前插件依赖 `@opencode/plugin ^2.1.4`），不得按 V1 形状猜接口。

### 1.4 验收边界

| 边界 | 本轮 P0–P07 | 需要另行确认 |
|---|---|---|
| 最终功能全量验收 | 功能、接口、测试、隔离演练、独立 review 全部完成 | — |
| 30 天现场运行 | 只交付可运行的加速 soak，标注 simulated | 真实 wall-clock 观察、真实数据启用 |
| 正式数据迁移 | 只工具 + 隔离演练，真实数据零接触 | 迁移窗口、备份、回滚演练、用户确认 |
| 正式启用 / 发布 | 不提交、不推送、不打 tag、不发版 | 用户决定 |
| 全机彻底 erase | 不在必实现范围；未实现前不显示假按钮 | 备份/缓存/副本清单与不可逆确认 |

## 2. 目标与非目标

### 2.1 目标

1. 普通描述性记忆（fact / preference / reference / project decision）日常零审批：后台采集、复盘、去重、更新、维护后直接生效。
2. 生效内容随时可见、可停止使用、可撤销、可恢复旧版本；停止使用/撤销成功后，**下一次模型请求**即排除错误记忆（含旧 session）。已开始的请求、已执行的外部动作不可追回。
3. 自动新增与自动更新共用一套变更账本：版本、来源、依赖、操作者、理由齐全。
4. 自动写入失败、模型不可用、召回失败均不阻塞普通对话；不产生新的人工待办。
5. 主界面从“审批队列”转为“记忆 / 活动 / 设置”；普通自动记忆零待审，legacy 审查入口收进“设置 › 高级与维护”，不在活动页用“待确认”徽标继续催人工。
6. 规则语法不等于 L0：长期工作偏好可成为描述性 preference；安全、权限、破坏性、硬限制永不自动提升。
7. 最终功能按本目标全量验收；现场 30 天运行与正式启用是独立边界（见 §1.4）。
8. 每个合格真实用户 prompt 自动获得当前项目相关召回（独立有界动态 block，不写 transcript），无需用户手动查询。

### 2.2 非目标

- 不引入向量数据库、embedding 服务、外部检索服务或新的重依赖。
- 不替换 `items.jsonl` / WAL / Store，不做整库迁移。
- 不自动写 L0（`AGENTS.md`、`memory/*.md`）、不自动装 skill、不自动改 `opencode.json`。
- 不做多用户、权限系统、云同步、移动端 App。
- 不在本轮必实现“全机含备份彻底 erase”；未实现前不显示假按钮，也不承诺云端数据删除。
- 不追求“自动理解一切”；不确定内容跳过或短期隔离，不猜。

## 3. 决策摘要

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 自动化默认关闭：`automation.enabled=false` | 保证旧测试/旧行为不变；启用是显式动作，迁移后由用户确认 |
| D2 | 先补可逆性，再开自动写入（P01 先于 P03） | 没有撤销/范围/恢复的自动化不可接受 |
| D3 | 自动写入仅限真实 `ItemKind` 中的描述性类型：`fact`/`preference`/`reference`；`rule`/`skill` 永不自动。项目 decision 用 `fact` + `reviewType:"decision"`/metadata 表达，不新造 kind | 与 `plugin/src/types.ts` 的 union 和现有 gate 测试一致 |
| D4 | 安全/权限/破坏性/硬限制一律人工；规则语法不升 L0 | 低权限描述性记忆不获得执行权 |
| D5 | 不确定内容进 `quarantine.jsonl`，TTL 到期自动结束，不进队列、不注入 | 不制造人工待办 |
| D6 | 普通自动记忆零待审；legacy 规则/安全/冲突审查入口放“设置 › 高级与维护”，活动页不加待确认徽标 | 不用换位置的待办继续催人工 |
| D7 | 注入块按 `memoryVersion` 失效，不是每轮重建 | 停止使用/撤销下一次模型请求生效（含旧 session）；未变更时保持字节稳定 |
| D8 | 变更账本 `changes.jsonl` 为唯一版本事件源；changelog 保留为轻量操作日志 | 来源/版本/依赖统一，避免两套真相 |
| D9 | 停止使用无时限；版本回退默认保留 90 天（可配置建议）；旧 merge-journal 的 24h 只约束 legacy 事务回滚 | 新统一撤销不受 24h 约束，旧限制不外溢 |
| D10 | 同源抑制按 hook key + text hash；新消息里的明确纠正不受抑制 | 防止复盘反复重学，不阻断真实纠正 |
| D11 | 召回在每个合格真实 prompt 的当次模型请求内自动进行（独立、有界、可失败的动态 `SystemPart`；稳定 prefix 与动态 block 分离），工具/API 只作调试与 UI 复用 | 消除“只有工具/API 才有召回”；撤销/到期靠 owned 替换在下一请求生效；20 轮稳定性只约束 prefix；无需向量依赖 |
| D12 | 模型调用预算拆成 run 与 request 两层 | 修复当前 `maxPerHour` 同时充当两种预算的混杂 |
| D13 | 迁移只做工具 + 隔离演练；正式数据零接触 | 真实数据不可逆风险最高的部分单独确认 |
| D14 | 冲突/版本不安全时禁止“仅恢复文本”覆盖后续正确编辑；只能安全逆转，否则停止使用 | 防止撤销变成新的数据破坏 |
| D15 | UI 以统一事件/版本/来源/可撤销 + 只读活动 API 为稳定契约 | 页面可演进，数据语义不能漂移 |
| D16 | 已开始请求/已执行外部动作不承诺追回 | 只保证下一次请求起排除；不夸大为全局撤回 |

## 4. 运行模型

```
用户消息
  → 采集（user-only，敏感信息前置阻断，hook 持久化）
  → 分类（System One；失败用启发式，nonblocking）
  → 去重/关系（SimHash + relations + write-guard）
  → 路由（decideAutomation）
      ├─ auto        → 事务写入 item + change event + 视图重建
      ├─ update      → 合并/替换已有 item + change event + 失效派生
      ├─ quarantine  → quarantine.jsonl（TTL，不注入、不排队）
      ├─ queue       → 仅 rule/safety/permission/hard-conflict（legacy 高级维护入口，非日常）
      └─ skip        → hook 标记 ignored + 原因，无人工待办
  → 注入（memoryVersion 变化时重建一次，按 scope/project 过滤）
  → 停止使用/撤销/恢复（change event 反向写；下一次模型请求生效）
```

后台任务：

- 会话复盘（idle/checkpoint）→ 证据校验 → hook → 同一路由；描述性候选可自动，rule/skill/session 仍按保护类别处理。
- 定时维护（curator）→ 过期、精确去重、失效派生、视图重建；每次变更写 change event。
- **每次真实用户 prompt 的召回**：在 V2 `session.hook("context")` 中，从当次请求末尾连续真实 user 消息取查询，按当前 `projectKey` 检索 active/global 记忆，作为一个**独立的、有界的动态 system block** 附着到当次模型请求；不写入用户 transcript（`event.messages` 只读），不写入 pinned `contextBlock`。失败 nonblocking（无 block，继续请求）。是否启用：`recall?.enabled ?? automation?.enabled ?? false`（旧配置不意外新增召回；开启 autonomous 默认有动态召回，显式 `false` 才停）；撤销/到期/owned 替换不受该开关影响。父会话三态：`root` 召回、`child` 跳过、`unknown` 跳过动态但不阻塞、不写记忆。

## 5. 数据模型

### 5.1 复用现有类型

- `Item` / `QueueItem` / `HookRecord` / `ReviewRecord` / `MergeJournal` / `PersistedState` 保持兼容，只增可选字段。
- `ItemKind` 的真实 union 只有 `fact | preference | rule | reference | skill`（见 `plugin/src/types.ts`）。**没有 `decision` kind**；review 的 `decision` 类型落为 `fact`，用 `reviewType:"decision"` 或等价 metadata 保留语义。所有接口/配置/UI 不得出现虚构 kind。
- `ItemStatus` 不新增取值；隔离内容放独立文件，避免污染所有既有 status 判断。
- `Scope = "session" | "project" | "global"` 不变；`session` 仍不落 durable item。

### 5.2 新增字段（全部可选，向后兼容）

```ts
// Item
changeID?: string;        // 最近一次变更事件
invalidatedBy?: string;   // 因哪个 item/变更失效
invalidatedAt?: string;
derivedFrom?: string[];   // 依赖的上游 item id
// P03 审计元数据（只增可选；不参与执行权限）
reviewType?: ReviewType;  // review 的 decision/learning 落 fact 时保留语义
authority?: "preference" | "protected" | "task_template" | "quoted_table" | "subagent";
grantsPermission?: false; // 恒为 false 或缺省；偏好不授予执行权限

// SessionState
contextVersion?: string;  // 当前 pinned contextBlock 对应的 memoryVersion
```

### 5.3 新增持久文件（`<dataDir>/`）

| 文件 | 作用 | 上限/保留 |
|---|---|---|
| `changes.jsonl` | 变更事件账本（append-only） | 5000 条 / 90 天；按 item 保留最近 20 条；活跃 item 的最新可逆事件、90 天内可回退事件、以及被引用事件受保护 |
| `suppressions.jsonl` | 撤销后同源抑制键 | 2000 条；按 `until`/90 天清理；清理只影响“防重学”，不影响 active 记忆的撤销 |
| `quarantine.jsonl` | 短期隔离候选 | 200 条；TTL 到期删除并写 changelog；不承载 active 撤销 |
| `change-journal/<id>.json` | 可逆变更的 before/after 快照与进度（redo 保护） | 与 changes 引用对齐；活跃/可回退引用不清理 |

这些上限是**保留策略**，不是让 active 记忆失去撤销：

- active item 至少保留其最新可逆 change 与 `undo.retainDays`（默认 90 天）内的回退快照；超限时先清最旧、无引用、非 active 的事件。
- suppression/quarantine 清理不得删除 active item 的 change 或快照。
- P06/retention/capacity 必须把 `changes.jsonl`、`suppressions.jsonl`、`quarantine.jsonl`、`change-journal/` 计入磁盘/容量与保留预览；受保护依赖（active item、revert 引用、journal 引用）不可被清理。
- 验证日志与备份副本本身有界（按阶段/日期/数量），不无限增长。

不新增数据库、不新增服务、不改变 `items.jsonl` 为 source of truth。

### 5.4 变更事件

```ts
export type ChangeKind =
  | "add" | "update" | "merge" | "replace" | "archive"
  | "revert" | "restore" | "deactivate" | "expire"
  | "invalidate" | "promote" | "migration";

export type ChangeActor = "auto" | "user" | "curator" | "migration" | "system";

/** 无损全量快照；恢复时保留 id/kind/scope/projectKey/status/source/sources/manual/expiresAt/derivedFrom/supersedes/invalidatedBy/aliases/changeID 等全部字段。 */
export type ItemSnapshot = Item;

export interface ChangeEvent {
  id: string;
  at: string;
  kind: ChangeKind;
  actor: ChangeActor;
  itemID: string;
  /** post-change content version; absent when the item is gone */
  itemVersion?: string;
  before?: ItemSnapshot;
  after?: ItemSnapshot;
  source: SourceRef;
  origin?: "turn" | "session-review" | "curator" | "migration" | "user";
  /** other change ids this event depends on (merge inputs, supersede chain) */
  dependsOn?: string[];
  /** upstream item ids */
  derivedFrom?: string[];
  reason: string;
  /** change being reverted, for kind=revert */
  reverts?: string;
  revertible: boolean;
}
```

规则：

1. 每个改变 active item 集合/正文/状态的操作，事务内恰好写 1 条 `ChangeEvent`：自动写入、人工批准/编辑/合并/替换、提升、legacy undoMerge、curator 过期/去重、session-note promotion、迁移基线、restore/revert/deactivate 都算；不允许只更新 item 不写事件。
2. `itemVersion` 使用现有 `itemContentVersion(after)`；before 用 `itemContentVersion(before)`。不新造哈希。
3. `source` 由服务端/工具入口写入，HTTP body 的 `source` 忽略（沿用现有安全语义）。
4. `dependsOn` 指向导致本次写的前提变更；`derivedFrom` 指向被依赖 item。
5. 事件写失败则整个事务失败，不允许“item 已写、账本没写”。
6. `before`/`after` 是**无损全量 Item 快照**；不得为省空间丢掉 identity/status/派生/来源字段。恢复必须还原全部相关字段，而不是只改正文。
7. 任何路径导致 item 失效（deactivate/revert/expire/invalidate/merge replace/legacy undo），都要推进有效版本（`memoryVersion`）并在下一请求生效。

### 5.5 抑制与隔离

```ts
export interface Suppression {
  id: string;
  at: string;
  /** exact hook key, e.g. turn|session|message|textHash or review|... */
  hookKey: string;
  textHash: string;
  itemID: string;
  reason: "reverted" | "deactivated";
  /** only same-source re-learning is suppressed; a new message is not */
  until?: string;
}

export interface QuarantineRecord {
  id: string;
  at: string;
  expiresAt: string;
  text: string; title: string;
  kind: Item["kind"]; scope: Scope; projectKey?: string;
  source: SourceRef; origin?: "turn" | "session-review";
  reason: string;
  evidence?: ReviewEvidence[];
  decision?: DecisionResult;
}
```

抑制键按**源身份**而非流程 ID：`sessionID | messageID | sha16(normalized text)`。缺少真实 `sessionID`/`messageID` 身份时 `sourceIdentityKey` 返回 `undefined`，调用方拒绝学习（fail closed），不得生成可碰撞的空键。读取时同时检查 P01 的 turn 键 `sid|mid|hash` 与 review 键 `review|sid|mid|hash`，不能只依赖归一后的单通道；`reviewID`/`turnID`（`review:<reviewID>` 每次随机）**不参与**判定。新 messageID 即新身份，用户明确纠正可重新学习；`restoreVersion` 删除抑制后可再学。

隔离记录不进入 `AUTOPILOT` 块、不进入 `buildContext`、不进入 queue、不触发人工提醒。到期只删除记录并追加 `quarantine_expired` changelog。

## 6. 自动化策略

### 6.1 配置

```ts
// 新增 AutoMemConfig.automation
export interface AutomationConfig {
  enabled: boolean;                 // 默认 false
  autoWriteKinds: Array<"fact" | "preference" | "reference">; // 真实 ItemKind 子集；无 decision kind
  autoUpdate: boolean;              // 所有正文变更总开关（merge/update/supersede）；false 时普通变更 skip/quarantine
  reviewLane: boolean;              // 复盘描述性候选可自动（global 同 R1 高证据门，不因来源变人工）
  quarantineHours: number;          // 默认 72
  dailyWrites: number;              // 默认 40
  dailyModelCalls: number;          // 默认 40
  minSafeAutoProject: number;       // 默认 0.92
  minSafeAutoGlobal: number;        // 默认 0.96
  minEvidenceSessions: number;      // 附加门；不能单独升级 global
  maxWritesPerSession: number;      // 默认 5
  undoWindowHours: number;          // 仅未接线 legacy merge；不限制新统一撤销，不暴露为控件
}

// 新增 AutoMemConfig.undo
export interface UndoConfig {
  /** 版本回退的保留天数；默认 90，可配置。超出后只能停止使用，不能恢复旧正文。 */
  retainDays: number;
}
```

`autoRules`：保留解析以兼容旧配置，但明确为 **deprecated no-op**。规则永不自动，不能通过 `autoRules=true` 打开。Settings 里显示“已弃用：规则始终人工”。迁移工具把旧值保留原样但不生效。

`review.transport`：P02 新增，可选 `"opencode" | "ollama"`，缺省 `"ollama"` 保持旧行为；与 `rewrite.transport` 解耦，禁止隐式跨 provider fallback。

`review.maxRequestsPerHour`：P02 新增，缺省动态推导 `max(maxPerHour, maxPerHour * (1 + repairAttempts) * 2)`，单独约束实际请求（含 repair/retry）；显式配置优先，不自动抬高。

P03 配置补充（合版）：

- `DEFAULT_CONFIG.automation.enabled=false`；旧 `config.json` 无该字段 → 默认 false，`autoRules=true` 不构成启用。
- `mergeConfig` 对 `automation` 做**深合并**（与 `review` 同构）：部分 PATCH 不得把 `enabled`/`autoWriteKinds` 变成 undefined。
- `PluginOptions.automation?: Partial<AutomationConfig>` 供测试/宿主注入；`PERSISTED_SETTINGS_PATHS`/`applyConfigPatch`/公开状态只加已实现字段。
- 写入模式与状态（P05 消费，服务端现算，不落第二事实源）：

| 字段 | 取值 | 含义 |
|---|---|---|
| `enabled` | boolean | 持久意图 |
| `configuredMode` | `legacy \| observe \| autonomous` | 由 `enabled`+`shadow` 推导：无 automation → legacy；enabled+shadow → observe；enabled+非 shadow → autonomous |
| `effectiveMode` | 同上 + `blocked` | 当前实际行为；observe 只写影子绝不写 item；容量/退避阻断 → blocked |
| `blockedReason` | `capacity \| backoff \| kill_switch \| null` | 仅 blocked 时有值 |
| `retryAt` | ISO \| null | 回收/退避后的下次尝试 |
| `lastSuccess` | `{at, kind, itemID, action:"add"\|"update"}` \| null | 最近真实写入/更新；seen/touch、隔离、跳过不算 |

- `POST /api/automation/mode` 单事务原子设置关联字段：`legacy`→`enabled=false`（shadow 不动）；`observe`→`enabled=true`+`shadow=true`；`autonomous`→`enabled=true`+`shadow=false`；`expectedConfigRevision` 不符 409。一个控件，不让用户摸两三个开关。不擅自开启正式配置。

### 6.2 路由函数（纯函数，便于测试）

```ts
export interface AutomationInput {
  config: AutoMemConfig;
  kind: Item["kind"];
  scope: Scope;
  origin?: "turn" | "session-review";
  strictness: Strictness;
  risk: number; safety?: number; strictLimit?: number;
  duplicate: number; conflict?: number;
  mergeAction?: MergeAction;
  lintOk: boolean;
  safeAuto: number;
  evidenceSessions: number;
  /** distinct known project identities; global needs >=2 different projects or explicit cross-project intent */
  evidenceProjects?: string[];
  crossProjectExplicit?: boolean;
  projectKey?: string;
  suppressed?: boolean;
  capacityFrozen?: boolean;
  writesToday: number;
  now: number;
}

export type AutomationRoute =
  | { route: "auto"; reason: string; expiresAt?: string }
  | { route: "update"; reason: string }
  | { route: "quarantine"; reason: string; expiresAt: string }
  | { route: "queue"; reason: string; requiresApproval: true }
  | { route: "skip"; reason: string };

export function decideAutomation(input: AutomationInput): AutomationRoute;

// P03 合版：源过滤与狭缝更新（纯函数）
export type Authority = "preference" | "protected" | "task_template" | "quoted_table" | "subagent";
export function classifyAuthority(input: {
  text: string; strictness: Strictness; safety?: number; risk: number;
  evidence: ReviewEvidence[]; origin?: "turn" | "session-review"; parentSessionID?: string;
}): { authority: Authority; kind?: Item["kind"]; reason: string };

export function planSupersede(input: {
  existing: Pick<Item, "id"|"text"|"kind"|"scope"|"projectKey"|"status"|"manual"|"aliases">;
  candidateText: string;
  candidateScope: Scope;            // required, explicit
  candidateProjectKey?: string;     // required for project scope; validated, not defaulted
  quote: string; quoteMessageID: string; origin: "turn"|"session-review";
}): { ok: true; text: string; from: string; to: string; reason: string }
 | { ok: false; reason: "no_single_target"|"scope_mismatch"|"no_verbatim_correction"
     |"not_single_diff"|"negation_flip"|"quoted_or_hypothetical"|"not_writable" };
```

顺序（先拒绝后允许）：

1. `automation.enabled=false` → 不进入新策略（调用方走 legacy `canAutoApply`）。
2. 源过滤先于路由：合成片段（`<context>`/`<skill_content>`/`<subagent …>`/续跑 `[Session task state …]`）剥离；任务信封（`TASK:`+`MUST DO`+`MUST NOT DO`+`CONTEXT:`）、引用表格、围栏-only、`parentSessionID` 子会话 → `skip`（不落 hook）；混排消息只丢合成段，保留 genuine user 片段。
3. 敏感/凭据/隐私/破坏性 → `queue`（人工）或 `skip`；永不 auto。提到 cookie/删除/端口等的工程知识**不因关键词**判敏感，按“是否请求授权/存密钥/执行破坏”判定。
4. kind 不在 `autoWriteKinds` → `queue`（rule/skill）或 `skip`。
5. `strictness` 为 `strict_limit`/`permission`/`safety`/`destructive` → `queue`。
6. `lintOk=false`、`duplicate` 超阈值、`conflict>0.5`、`mergeAction` 非 create/merge → `queue` 或 `quarantine`（冲突不覆盖）。
7. `safeAuto` 低于对应 scope 阈值 → `quarantine`（可短期观察）或 `skip`；不 queue、不提示。
8. global 且含易变标识（路径/端口/版本/主机名/session id）→ `quarantine` 带 TTL；不 auto。global 仅在**明确跨项目意图 + 真实 user 逐字证据**，或 **`evidenceProjects` ≥2 个不同已知项目**的独立来源且无项目相对标识时可 auto；同项目多 session、仅 `evidenceSessions` 数字、重复同一句 project 事实不升级。
9. `scope=project` 缺 `projectKey` → `skip`。
10. `origin=session-review` 且 `reviewLane=false` → legacy 人工；`reviewLane=true` 时**描述性 project 与 global 都不因 review 来源变人工**：global 走第 8 条同一高证据门；不满足 → skip/quarantine，不 queue。`safeAuto` 不作为 review 门；review 的 rule/skill 永远人工。
11. 日预算/会话预算/容量 85%/95% 阻断 → `skip` 或 `quarantine`，capture 继续；预算与写入计数跨实例原子占位。
12. 同源抑制命中 → `skip`，reason=`suppressed-after-revert`（按源身份，跨 turn/review）。
13. 通过 → `auto` / `update`。
14. 更新/纠正：exact/covered → `touch`；兼容新证据 → `update`；**唯一目标 + scope 匹配 + 逐字 A→B + 单点差异 + CAS + 非否定反转** → 同一 item supersede（旧值留历史可 undo）；其余不明差异 → `quarantine`，不产生人工待办。

补充（主代理裁决）：

- `safeAuto` 是模型自评分，不是校准概率；不能把阈值从 0.92 提到 0.96 就宣称可靠。可靠性来自确定性证据、范围、无安全语义、可逆、预算与撤销，不来自单一分数。
- benign 长期工作偏好祈使句可转 `preference`（保留 user quote，`grantsPermission=false`），不写 L0、不获得执行权；safety/permission/destructive/strict_limit 永远不转。
- 任务模板（`<task>`/`<template>`/`{{…}}`/占位符）、子会话、引用表格、合成 `<context>`/`<skill_content>` 不进入自动 lane；混排只剥合成段。
- 普通描述性 global（含 review 来源）零日常审批：真实 user 逐字证据 + 明确跨项目意图，或 `evidenceProjects` ≥2 个不同已知项目；同项目多 session/仅计数不升级；证据不足 skip/quarantine，不 queue。
- `autoUpdate` 控制所有正文变更；`false` 时普通更新 skip/quarantine，exact/covered 的 touch 仍允许；`merge_into` 必须 route update，不能当 auto-add。
- `sourceIdentityKey` 缺真实 session/message 身份返回 `undefined`（fail closed）；读取同时对照 P01 turn/review 两通道键。
- `undoWindowHours` 只是未接线 legacy 字段，不给新统一撤销加 24h 限制，也不暴露为控件。
- 普通描述性冲突进 `quarantine`，不制造人工队列；只有 protected 类别进 legacy 审查。隔离 TTL 默认 72h，到期删除并写 `quarantine_expired`，不注入、不 queue、不提醒。
- 维护必须真实接线：启动 + 周期（15min，`unref`）+ 容量事件调用 `runMaintenanceTick`；`claim` 防多实例；`dispose` 清理；读 API 不清理。容量到达 compact/freeze 时**先按已批准 policy 安全回收**（过期 auto、exact 去重、quarantine TTL、shadow/hook caps、派生历史按 P06 保护集合修剪），复检恢复；无安全数据则如实 `blockedReason/retryAt`，不永久停写、不假称自动运行。
- 历史保护边界与 P06 一致：active 最新事件、`undo.retainDays` 窗口、`changeID`/`dependsOn`/`reverts` 闭包、未完成事务、窗口内/pin 的迁移 journal 受保护；必要 suppression tombstone 不清；已完成且窗口外的普通历史**不因 `undone=false`** 无限保留。

### 6.3 与 legacy 的关系

- `canAutoApply` 保持导出与语义（rule/review/session 仍 false），旧测试不动。
- `runConsolidation` 在 `automation.enabled=false` 时走原路径；为 true 时走 `decideAutomation`。
- 现有 `review-integration` gate 测试默认关闭 automation，因此继续断言“review 不自动”；P03 新增独立测试在开启 automation 时断言“仅描述性可自动，rule/skill/session 仍不可”。
- `autoRules=true` 永不自动写 rule；`shadow=true` 在 automation 下仍是“观察不写”，服务端以 `effectiveMode` 如实呈现，不因 `enabled=true` 对外声称已自动写入。
- 启用只来自显式动作（配置或 `POST /api/automation/mode`）；迁移只补 `enabled=false`，不替用户开启正式配置。

## 7. 注入、版本与撤销生效

### 7.1 memoryVersion

```ts
// Store
async memoryVersion(now?: number): Promise<string>;
// sha16 over:
//   sorted active rows [id, itemContentVersion(item), expiresAt?]
//   + expiredCount (rows whose expiresAt <= now)
//   + nextExpiry (smallest future expiresAt, or null)
```

- 只统计 `status` 为 `auto`/`promoted`、未被 `invalidatedBy` 标记的 item；过期项计入 `expiredCount`，立即从 active 集合排除。
- **不能只缓存 mtime/size**：文件未变但时钟跨过 `expiresAt` 时，`expiredCount`/`nextExpiry` 变化会让 version 改变。进程内可按 `(mtime,size,now 的 expiry 状态)` 缓存；跨过任一到期点必须重算。
- 跨进程一致：哈希只看内容 + 时间状态，不看进程状态。
- 测试必须覆盖“无写入、仅时间跨过 expiresAt → version 改变、block 排除该 item”。

### 7.2 refreshContext

```ts
export async function refreshContext(ctx, store, config, sessionID, projectKey?): Promise<void>;
```

1. 读 `pinned = store.readSession(sessionID)`。
2. `version = await store.memoryVersion(Date.now())`（含 nearest-expiry 时间状态）。
3. 若 `pinned.contextBlock` 存在、`contextProjectKey === projectKey`、`contextVersion === version` → 直接返回（不 `entry.put`）。
4. 否则 `buildContext` + `renderContext`；仅当渲染文本与 `contextCache` 不同才 `entry.put`；更新 `contextBlock/contextHash/contextProjectKey/contextVersion`。
5. `buildContext` 过滤 `expiresAt <= now` 与 `invalidatedBy`。
6. `refreshContext` 必须在每次模型请求的 V2 `session.hook("context")` 内执行（见 §8.4 的 per-request 召回），不仅由 API/tool 调用；否则撤销/到期不会在下一请求生效。

结果：停止使用/撤销/恢复在下一次模型请求（下一次 context hook）生效，含已存在的旧 session；未变更时 20 轮**稳定 prefix** 字节一致（动态召回 block 单独断言，不纳入 prefix 稳定性）；不是每轮重建。已经开始的模型请求、已经执行的外部动作不可追回。**当次请求的旧 owned 块能否被安全替换，取决于宿主 metadata 与旧块边界是否可判定**：无 metadata 且旧字面 `<context` 造成边界歧义时不得猜边界，保守标记 `degraded`；此时 `entry.put` 只保证后续存储，不构成“下一请求必已排除”的保证，必须由 P06 真实 host 出站记录验证（见 §8.4）。

### 7.3 撤销动作

| 动作 | 语义 | 时限 | 数据 |
|---|---|---|---|
| `deactivateItem(id, expectedVersion)` | 停止注入，保留内容与历史 | **随时，无时限** | status=archived + `deactivate` 事件 + 同源抑制 |
| `reactivateItem(id, expectedVersion)` | 恢复使用：重新激活当前内容（不是版本回退） | 随时，无时限 | status 回到 deactivate 前状态 + `restore` 事件；清除抑制 |
| `revertChange(changeID, expectedVersion)` | 反向执行某次变更；有 before 则恢复，无则归档 | 新统一撤销不受 24h 约束；受版本记录保留期约束 | 1 条 `revert` 事件；派生失效 |
| `restoreVersion(itemID, changeID, expectedVersion)` | 把历史版本作为新版本重新生效 | 默认保留 90 天，可配置（`undo.retainDays`） | 1 条 `restore` 事件；版本冲突则 409 |
| legacy `undoMerge(journalID)` | 事务性回滚合并 | 24h（不变，仅 legacy） | 原 merge-journal 路径 |

冲突与安全规则：

- 当前 `itemContentVersion` 与 `expectedVersion` 不符 → 409，不写。
- **禁止“仅恢复文本”**：若目标 item 在变更后已被后续正确编辑，不得用旧文本片段覆盖；只能做完整、版本安全的反向变更。做不到就只允许 `deactivateItem`（停止使用），并明确告知无法安全回退。
- `restoreVersion` 的目标快照必须存在且完整；不猜测旧 journal；超出 `undo.retainDays` 后只能停止使用，不能恢复旧正文。
- 撤销/恢复写 `change-journal/<id>.json`，包含 before/after 与 `undoing` 进度；崩溃可重试。
- 派生失效：从被撤销/停用 id 出发，递归标记 `derivedFrom` 或 `supersedes` 指向它的 auto item（`invalidatedBy`），深度上限 + visited set 防环；manual/promoted 派生条目也停止注入并显示“上游已撤销”，但不自动归档。
- 恢复安全：`restoreVersion`/`reactivateItem` 前检查 `derivedFrom` 上游全部 active 且未被 `invalidatedBy`；任一上游无效则拒绝恢复（或只恢复到“无效”状态），不得激活仍有无效上游的项。
- 递归失效与恢复都必须写 1 条 `invalidate`/`restore` 事件；环检测命中时停止并记录，不无限循环。

### 7.4 同源抑制

- 记录触发该 item 的 hook key（turn/review）与 `textHash`。
- 复盘再次产出同一 quote/message 时命中 → `skip`，不写 item、不 queue。
- 新消息（新 messageID）即使文本相同也不命中；用户明确纠正可以重新学习。
- `restoreVersion` 删除对应 suppression，允许恢复。

## 8. 阶段接口契约

这是阶段之间的硬接口。后续阶段只能消费前序阶段已交付的签名；如需变更，先改本文件并说明兼容性。

### 8.1 P01 产出（可逆记忆）

```ts
// plugin/src/changes.ts
export function itemSnapshot(item: Item): ItemSnapshot;
export async function recordChange(
  store: Store,
  input: Omit<ChangeEvent, "id" | "at" | "itemVersion" | "revertible"> & {
    item: Item;
    before?: Item;
  },
): Promise<ChangeEvent>;

export async function deactivateItem(
  store: Store,
  itemID: string,
  opts: { expectedVersion: string; reason?: string },
): Promise<RevertResult>;

export async function reactivateItem(
  store: Store,
  itemID: string,
  opts: { expectedVersion: string },
): Promise<RevertResult>;

export async function revertChange(
  store: Store,
  changeID: string,
  opts: { expectedVersion: string; reason?: string },
): Promise<RevertResult>;

export async function restoreVersion(
  store: Store,
  itemID: string,
  changeID: string,
  opts: { expectedVersion: string },
): Promise<RevertResult>;

export type RevertResult =
  | { ok: true; event: ChangeEvent; invalidated: string[] }
  | { ok: false; code: "not_found" | "version_mismatch" | "not_revertible" | "conflict"; message: string };

// plugin/src/memory/suppression.ts
export async function suppressSource(store: Store, item: Item, reason: "reverted" | "deactivated"): Promise<Suppression[]>;
export async function isSuppressed(store: Store, hookKey: string, textHash: string): Promise<boolean>;

// plugin/src/store.ts 新增
async listChanges(filter?: { itemID?: string; limit?: number }): Promise<ChangeEvent[]>;
async appendChange(event: ChangeEvent): Promise<void>;
async memoryVersion(): Promise<string>;
async listSuppressions(): Promise<Suppression[]>;
```

API（全部要求 Bearer token；agent tool 不可调用）：

```text
GET  /api/items?status=&scope=&projectKey=&q=&includeArchived=
     → 保持旧响应形状 { items: Item[] }；不追加/不改名字段，供旧 console/graph/tests 兼容
GET  /api/memory/items?status=&scope=&projectKey=&q=&includeArchived=
     → { items: Array<Item & { version: string; changeID?: string; latestChange?: ChangeEvent }>, nextCursor?: string }
GET  /api/items/:id/changes → { changes: ChangeEvent[] }
POST /api/items/:id/deactivate  { expectedVersion, reason? } → RevertResult
POST /api/items/:id/reactivate  { expectedVersion } → RevertResult
POST /api/items/:id/revert      { changeID, expectedVersion, reason? } → RevertResult
POST /api/items/:id/restore     { changeID, expectedVersion } → RevertResult
GET  /api/changes?since=&limit= → { changes: ChangeEvent[] }
```

契约规则：

- `GET /api/items` 的旧形状 `{ items: Item[] }` 原样保留；不新增必填字段、不改数组/对象形状、不改默认分页。新能力只走 `/api/memory/items`（或未来显式 `?view=memory` opt-in，默认关闭）。
- `GET /api/changes` 是只读活动 API，稳定供 UI 使用；不返回 prompt/凭据/真实路径内容。
- 三个 POST 都是版本化动作；`expectedVersion` 必填。冲突返回 409 + 当前 version，不写。
- 不提供“仅恢复文本”接口；无法安全逆转时只能 deactivate。
- 所有响应包含 `revertible` 与 `source`，UI 不自行推断。

### 8.2 P02 产出（运行时可靠性）

```ts
// plugin/src/review/provider.ts
// V2 事实：generate 输入只有 { prompt, model? }，输出只有 { text }；
// 无 maxOutputTokens、无 usage。适配层不得伪造。
export type ReviewGenerate = (
  input: { model: ModelRef; prompt: string },
  options?: { signal?: AbortSignal },
) => Promise<{ text: string }>;

export interface ReviewProviderOptions {
  // 既有字段...
  generate?: ReviewGenerate;        // review.transport="opencode" 时必须提供
  maxRequestsPerHour?: number;      // 缺省按下方公式推导；显式值优先
  sleep?: (ms: number) => Promise<void>; // 测试注入；默认 setTimeout
}

export type ReviewFailureKind =
  | "transport" | "http" | "empty" | "format" | "budget" | "config" | "cache" | "retry-after";

export class ReviewRequestError extends Error {
  constructor(message: string, countsAsAttempt?: boolean, kind?: ReviewFailureKind);
  readonly countsAsAttempt: boolean; // 只作兼容标签，不是重试开关
  readonly kind: ReviewFailureKind;
  readonly httpStatus?: number;
  /** 已实际派发的请求数；0 表示确定未派发；缺省=未知。 */
  readonly requestsMade?: number;
}
export class ReviewEmptyResponseError extends ReviewRequestError {} // kind="empty", countsAsAttempt=true
export class ReviewBudgetError extends ReviewRequestError {
  readonly requestsMade: number;
  readonly retryAt?: number;
}
export class ReviewRetryAfterError extends ReviewRequestError {
  readonly retryAt: number;      // 上游完整期限，不得被 30s 截断
  readonly requestsMade: number;
}

// plugin/src/types.ts；默认值在 config.ts
interface ReviewConfig {
  transport?: "opencode" | "ollama"; // 缺省 "ollama"，保持旧行为
  maxRequestsPerHour?: number;
}

// plugin/src/review/orchestrator.ts
export interface ReviewOrchestratorDeps {
  projectKey?: string;
  // onAccepted 第 4 参携带 review 记录的权威 projectKey
  onAccepted(input: ReviewInput, result: ReviewRunResult, reviewID: string, projectKey?: string): Promise<AcceptReviewResult>;
}
```

- `review.transport` 与 `rewrite.transport` 解耦：现有 `rewrite.transport` 对 review 未生效；缺省 `ollama` 保持旧行为。`opencode` 优先 `ctx.experimental.generate.text`，回退 `ctx.generate.text`；缺 API 或返回形状不符 → `kind="config"`，不得静默走 `/api/chat`，不得跨 provider 隐式 fallback。`maxOutputTokens` 只对 ollama 生效；generate 无 usage 时省略，不估算。
- 429/408/425/5xx：`Retry-After` ≤30s 时后台等待后重试 1 次；>30s（含 HTTP date）不得 clamp 成 30s 提前重发，抛 `ReviewRetryAfterError`，orchestrator 把完整 `retryAt` 持久化为 `reviewDueAt` 延后。缺失/非法 header 才用有界默认 1000ms。opencode 无 headers，只对可识别瞬态错误固定 1000ms，不假装读到 `Retry-After`。
- 空返回：`request()` 返回 `raw:""`；有 `repairAttempts` 时 repair 1 次，仍空/无 repair → `ReviewEmptyResponseError`。空返回不计 provider circuit。
- 预算：orchestrator 用 `takeReviewSlot`（run，一次 run 一个 slot）；provider 每次实际派发（首调/重试/repair）前 `takeModelSlot("review", effectiveMaxRequests)`；`effectiveMaxRequests = review.maxRequestsPerHour ?? max(maxPerHour, maxPerHour * (1 + repairAttempts) * 2)`，显式值优先、不自动抬高。预算不足抛 `ReviewBudgetError`：`requestsMade=0` 释放 run slot，`>0` 保留；budget/http-deferred 都不置 failed、不加 attempts、不写成功/失败记录，只按 `retryAt` 延后，窗口不丢。
- `recover()` 只恢复 `session.contextProjectKey === deps.projectKey` 的会话；无 projectKey 的旧会话按最近一条 review 记录的 `projectKey` 判定；无法判定或不匹配则跳过且不写，不跨项目重跑。`schedule()`/`runNow()` 也做同样的归属守卫（事件是 server-wide）。
- `acceptReviewCandidates` 的 `projectKey` 只来自 review 记录权威值；`instanceProjectKey` 仅用于不一致拒绝，不一致返回全部 skipped、不建 hook；无权威 key 的 project 候选降级 session note，不用当前实例 key 覆盖。
- capture hook 的 check+append 放进同一个 `store.transaction`（跨进程文件锁），防并发重复；同 key 原文不同（规范化折叠）保留为 session note/`conflicts`，不静默丢。
- `status` 只 `readAudit`，不 `runAudit`；`auditAgeMs` 由 `runAudit` 写入的 `auditRunAt` 计算，缺失为 `null`（不用 `emptyAudit().generatedAt` 冒充新鲜度）；P02 增 review 的 `runsLastHour`/`requestsLastHour`/`lastError`/`lastDeferred`；`automation`、`quarantine` 由 P03 追加，P02 不伪造。


### 8.3 P03 产出（自主流水线）

```ts
// plugin/src/automation.ts
export function decideAutomation(input: AutomationInput): AutomationRoute;

// plugin/src/memory/sources.ts（源过滤，纯函数）
export function segmentSynthetic(text: string): { text: string; stripped: string[] };
export function sourceIdentityKey(source: { sessionID?: string; messageID?: string }, text: string): string;
export function isTaskEnvelope(text: string): boolean;

// plugin/src/memory/supersede.ts（狭缝更新，纯函数；C1–C9）
export type SupersedePlan =
  | { ok: true; text: string; from: string; to: string; reason: string }
  | { ok: false; reason: "no_single_target" | "scope_mismatch" | "no_verbatim_correction"
      | "not_single_diff" | "negation_flip" | "quoted_or_hypothetical" | "not_writable" };
export function planSupersede(input: {
  existing: Pick<Item, "id"|"text"|"kind"|"scope"|"projectKey"|"status"|"manual"|"aliases">;
  candidateText: string; quote: string; quoteMessageID: string; origin: "turn"|"session-review";
}): SupersedePlan;

// plugin/src/memory/quarantine.ts
export async function enqueueQuarantine(store: Store, record: Omit<QuarantineRecord, "id" | "at" | "expiresAt">, ttlHours: number): Promise<QuarantineRecord>;
export async function expireQuarantine(store: Store, now?: number): Promise<number>;

// plugin/src/memory/maintenance.ts（真实后台接线）
export async function runMaintenanceTick(store: Store, config: AutoMemConfig, opts?: {
  now?: number; reason?: "startup" | "interval" | "capacity";
}): Promise<{ expired: number; reclaimed: number; capacity: CapacityLevel; blocked?: boolean }>;

// plugin/src/store.ts 新增
async appendQuarantine(record: QuarantineRecord): Promise<void>;
async listQuarantine(): Promise<QuarantineRecord[]>;
async pruneQuarantine(max?: number): Promise<number>;
/** 跨实例原子占位：日写/日调用/会话写；锁内一次读改写。 */
async takeAutomationSlot(kind: "writes" | "modelCalls", limit: number, now: number, sessionID?: string): Promise<{ ok: boolean; used: number }>;
```

- `runConsolidation` 的 auto 分支改为：`store.transaction` 内 `appendItem` + `recordChange({kind:"add", actor:"auto"})` + 视图重建；失败回滚。更新/supersede 用 `update` 事件（before/after 全量），版本 CAS 失败不写。
- 源过滤在**入 hook 前**执行：剥离合成段、任务信封/表格/围栏-only/子会话 → skip；混排只丢合成段，保留 genuine user 片段。`classifyAuthority` 在路由前做兜底。
- `reviewLane=true` 时描述性 review 候选可 auto；**不得**用 `safeAuto` 当门，改看 kind/authority/scope/user-quote/evidenceSessions；rule/skill 仍人工。
- 抑制按源身份（`sessionID|messageID|sha16(text)`，归一 `turn|`/`review|` 前缀），跨 turn/review 生效；不依赖 `reviewID`。
- 冲突：未证实差异 `quarantine` 双方保留；已证实单点 A→B 走 `planSupersede` 改写同一 item（旧值留历史可 undo）；否定反转/跨 scope/引用示例/多目标一律不覆盖。
- curator 的过期/去重更新写 `expire`/`update` 事件；不自动合并 rule；回收只在既有已批准 policy 内（过期 auto、exact 去重、quarantine TTL、shadow/hook caps、派生历史按 P06 保护集合），不生成日常人工待办。
- 日预算用 `stats.json` 的 `automationWrites:<YYYY-MM-DD>` / `automationModelCalls:<date>`；UTC 日切；`takeAutomationSlot` 单点原子；`maxWritesPerSession` 计写入条数。不新增调度服务。
- `quarantine` 不进入 queue/context；到期清理。
- 维护接线：启动 + 15min `unref` timer + 容量事件；`claim("maintenance:tick")` 防多实例；`dispose` 清理；`GET` 只读。容量阻断时先回收再复检，恢复或如实 `blockedReason/retryAt`。
- 状态与模式：`GET /api/automation` 返回 `enabled/configuredMode/effectiveMode/blockedReason/retryAt/lastSuccess`（现算）；`POST /api/automation/mode` 单事务原子设置 `enabled`+`shadow`，revision 不符 409。

### 8.4 P04 产出（召回）

```ts
// plugin/src/recall.ts
export interface RecallTokens {
  cjkBigrams: string[];
  identifiers: string[];
  numbers: string[];
  negations: number;   // 奇偶即可
}
export interface RecallHit {
  id: string; version: string; title: string; text: string;
  scope: Scope; kind: Item["kind"];
  score: number; reasons: string[];
  numericConflict?: boolean; negationMismatch?: boolean;
}
export interface RecallResult {
  hits: RecallHit[];
  tokens: number;   // 保守估算，不是计费
  degraded?: { reason: "empty_query" | "store_error" | "budget" | "unlocated" };
}
export function tokenizeRecallQuery(text: string): RecallTokens;
export function scoreRecall(item: Item, tokens: RecallTokens): RecallHit | undefined;
export async function recallMemory(
  store: Store,
  config: AutoMemConfig,
  query: string,
  opts?: { projectKey?: string; limit?: number; tokenBudget?: number; now?: number },
): Promise<RecallResult>;

// V2 context hook adapter; never mutates messages
export async function attachRecallBlock(input: {
  sessionID: string;
  projectKey?: string;
  messages: ReadonlyArray<Message>;   // V2 @opencode/ai Message
  system: SystemPart[];               // event.system: owned 块替换 + 动态追加
  parentSessionID?: string;
}, deps: { store: Store; config: AutoMemConfig; now?: () => number });
```

- `recallMemory` 捕获所有错误，返回 `{ hits: [], tokens: 0, degraded: { reason } }`，不抛出。
- **每次合格真实用户 prompt 自动召回并附着当次请求**：V2 签名已从本地 `@opencode/plugin` 类型核对——`SessionHooks.context: SessionContext`，其中 `SessionContext extends SessionRequest { sessionID; model; system: SystemPart[]; messages: Message[]; options; agent; tools }`（`plugin/node_modules/@opencode/plugin/dist/promise/session.d.ts`）。每次请求顺序固定：`refreshContext`（P01）→ 当次 owned 块替换 → `attachRecallBlock`；**不得因 `entry` 存在提前 return**。`title`/`compaction`/`generate` 由 V2 独立 hook 分流，不走 `context`。
- **只取真实 user 文本**：从 `event.messages` 末尾**连续 user 段**从新到旧选第一条清洗后 ≥4 字符的文本；遇 `assistant`/`tool` 立即停止（工具迭代轮不重复堆 block）。清洗 `<system-update>`/`<context>`/`<skill_content>`/`<task>`/`<template>`/`<synthetic>` 整块；短 slash command（余下参数 <4 字符）跳过。只读 `messages`，**绝不修改/追加用户 transcript**。
- **父会话三态**：`child`（已知 `parentSessionID`）跳过；`root`（session 信息读取成功且无 parentID）召回；`unknown`（读取失败/无该 API）**跳过动态召回，但 hook 正常返回、不阻塞对话、不写记忆**；不得把 unknown 当已证实 root。
- 稳定 prefix 与动态 block 分离：pinned `contextBlock`（小偏好）继续由 `refreshContext` 维护；动态召回作为单独的 `SystemPart` 追加到 `event.system`，形如 `## RELEVANT MEMORY (this request)`，与稳定 prefix 不合并、不写回 `contextBlock`；同一 system 重入时先移除旧动态 part，保证 ≤1。20 轮字节稳定性测试只约束无变更的 pinned prefix；动态 block 单独断言“相关时出现、无关时不出现、有界、失败不阻塞、随查询变化”，不得用 20 轮测试禁止动态召回。
- 匹配保守：中文连续 CJK 取 bigram（单字保留）；标识符（反引号/路径/文件名/命令）原样精确匹配，不被拆词；数字归一化后精确匹配，仅“双方都有数字、无交集、且共享至少一个非数字上下文词”标 `numericConflict` 并排除；否定按保守词表与奇偶，相反排除、同向可命中；scope 仅 `global` + 当前 `projectKey`，`session` 永不进入；排序 `score` desc → `updatedAt` desc → `id` asc，稳定。`score` 只是排序特征和，**不是相关概率/正确率**，API/UI 不得显示百分比。
- 有界：动态默认 `limit=5`、`tokenBudget=600`（可配；API/tool `8/1200`）。token 估算按**整 item 行**（`- [scope/kind] ` + 完整 text + 换行）加 header/分隔符与 16 token 安全余量；CJK 1/字、ASCII 每 3 字符 1（`_./:-` 分段）、其他标点 0.5、空白 0.25，向上取整。整项装不下 → **整项跳过，不截断、不加省略号**；**不设读取字符上限**（写入 linter 长度不是读取上限），合法长 memory 只要整行装得下就可召回；全部装不下 → 空 + `degraded:"budget"`，不保证“至少 1 条”。动态预算与 prefix 分开，按规范化文本去重。
- **owned 替换只认精确证据**：① 精确 `metadata.experimental.instructions` key `api/plugin.memory-autopilot`；② 精确 `<context key="api/plugin.memory-autopilot">…</context>` wrapper；③ 与已知自身完整 `renderContext` 文本精确相等（可精确局部替换）；④ 自身唯一 sentinel。**禁止**泛匹配所有 `## AUTOPILOT` 标题，禁止仅因 part 含同一句事实就判定/删除。撤销校验只作用于 owned parts；原始用户聊天、L0/AGENTS.md、core part 与其他插件 part 中的同一事实必须逐字保留。
- **失效与开关解耦**：`recall?.enabled ?? automation?.enabled ?? false`。旧配置无新字段且 automation 缺省 false → 不意外新增召回；开启 autonomous 默认有动态召回，只有显式 `false` 才停。无论开关如何，`refreshContext`、撤销/`invalidatedBy`/expiry 过滤与 owned 块当次替换都必须执行；开关只决定是否追加动态 block。
- **P01 fix2 现状（2026-11-11）**：P01 是唯一 writer，fix2 正在修 M7（无 metadata fallback 误删宿主 part/截断）与 N2（派生失效 maintenance 副作用），**尚未验收**。P01 若产出同步 owned-block helper，P04 未来直接复用，不双写 `entry.put`。在 helper 未验收前：**无 metadata 且旧字面 `<context` 造成边界歧义时不得猜边界**，保守保留原 part 并标 `degraded`；这**不等于**“下一请求已排除”的保证，`entry.put` 只保证后续存储。
- API `GET /api/recall?q=&projectKey=&limit=`：Bearer；传入 `projectKey` 与实例 `deps.projectKey` 不一致 → 403 `project_mismatch`；失败 200 + degraded。agent tool 新增只读 `action=recall`，**不接受 `projectKey`**，只用实例 key + `context.sessionID` 做 `visible` 二次过滤。API/tool 是调试与 UI 用，不是自动召回的替代。
- **P06 真实 host 门禁**：P06 必须在隔离 host + fake provider（若可行，不读正式 config）记录真实出站 `system`，证明撤销/停用条目不残留在任何 owned 注入中；若无法排除错误 owned 内容，P06 最终状态为 **blocked**，不得以 fake host/pure probe 代替。fake host 只证明模型与接线，不证明真实宿主边界。
- P05 可在“相关记忆”面板/详情关联中复用同一 `recallMemory`，但不重复注入。

### 8.5 P05 产出（UX）

```ts
// console/src/pages/memory-model.ts（新增纯逻辑，供 Vitest）
export type MemorySegment = "active" | "session" | "stopped" | "expired" | "all";
export function segmentOf(item: Item, now: number): MemorySegment;
export function canDeactivate(item: Item): boolean;
export function canRestore(change: ChangeEvent, item: Item, now: number, retainDays: number): boolean;
export function versionLabel(version: string): string;
export function countLabel(scope: "all" | "project" | "session", n: number | undefined): string;

// console/src/pages/activity-model.ts（新增纯逻辑）
export type ActivityKind = "auto" | "skipped" | "failed" | "revert" | "restore" | "deactivate" | "review" | "maintenance" | "migration";
export function activityKindOf(change: ChangeEvent | ChangelogRow): ActivityKind;
export function activitySummary(rows: ActivityRow[], now: number): { auto: number; skipped: number; failed: number; reverted: number };
```

- 路由：`#memory`、`#activity`、`#settings` 三个一级；**活动页不设“待确认”徽标**，普通自动记忆零待审。
- legacy 审查入口（原 Queue：建议/编辑/拒绝/批量/复盘/会话笔记）收进 `#settings/advanced/review`，作为高级维护；旧 `#queue` 重定向到该处，不在活动页继续催人工。
- 依赖 P01 的 `/api/memory/items`、`/api/items/:id/changes`、`/api/changes`（只读活动契约）；旧 `/api/items` 不改为 UI 数据源。P02 的状态字段，P04 的 `/api/recall`。
- 停止使用/撤销文案不得承诺“只对新会话生效”，必须写“下一次模型请求起不再注入（含旧会话）”；已开始请求/已执行外部动作不可追回要写清。
- 版本回退默认 90 天（`undo.retainDays` 可配置）；超过后只提供停止使用，不提供旧正文恢复。
- 冲突时不得提供“仅恢复文本”；只能安全版本逆转或停止使用。
- 不做“彻底删除所有副本”的假入口；不在 UI 承诺云端删除。
- 不修改 `confirm.tsx`、`settings-diff.ts`、`draft-state.ts`、`undo-preview.ts` 的既有保护逻辑。
- UI 的稳定契约是：统一 `ChangeEvent`（版本/来源/依赖/可撤销）+ 只读活动 API；不得依赖仅用于聚合的可变计数。

### 8.6 P06 产出（迁移与验证）

```bash
node scripts/full-auto-memory-migrate.mjs \
  --data <isolated-dir> --dry-run|--apply|--undo \
  --backup <isolated-dir>/backup --confirm <fingerprint>

npm --prefix plugin exec -- tsx ../scripts/soak-30d.mjs --days 30 --sessions 120 --seed 42 --data <isolated-dir>
```

- 迁移拒绝 `~/.config/opencode/memory/autopilot` 及其子路径；拒绝非 `tmp/`/`mkdtemp` 的显式演练目录（除非 `--allow-dir` 且仍拒绝真实路径）。
- 迁移只做：配置补 `automation`（enabled=false）、为 active item 补基线 change 事件、为 queue 行生成提案（keep/adopt/quarantine），不批量删除。
- 迁移必须真实执行 dry-run → apply → 校验 → undo → 校验 → 再 apply（幂等），不是只设计。
- soak 通过 `tsx` 调用真实生产函数（`Store`/`transaction`/`recordChange`/`decideAutomation`/`runConsolidation`/`memoryVersion` 等）+ fake clock，不另写 toy 状态机。
- soak 输出 `reports/soak-30d.json`，字段含 `simulated: true`、seed、天数、不变量结果；不得写成真实运行。

## 9. 安全与权限

- 自动写入不产生任何执行权限：不写 AGENTS.md、memory/*.md、skills、opencode.json，不改端口/命令/权限。
- 规则语法（“必须/禁止/只能”）不是唯一判据：benign 长期工作偏好祈使句可转描述性 `preference`（保留 user quote、`grantsPermission=false`，不写 L0）；`safety`/`permission`/`destructive`/`strict_limit` 始终人工。
- 全局记忆拒绝易变标识（绝对路径、端口、版本、主机名、session id），除非是带 TTL 的 reference。
- `agent-tool` 继续不能 approve/apply/promote；新增 `recall` 只读；撤销/恢复只允许 local-token API。
- 所有新 API 走现有 auth 中间件；`source` 由入口设置，body 忽略。
- 日志/错误不得输出凭据、完整 prompt、真实数据路径内容。
- 迁移/soak 脚本不读取真实数据；测试断言真实路径未被访问（可用注入的 forbidden path 检查）。
- 后台模型仍会出网（分类/复盘/重写）；文档与 UI 不得暗示“全本地、零出网”。不承诺云端数据删除。
- 全机（含备份/缓存）彻底 erase 不在本轮必实现范围；未实现前不提供按钮，不写“已删除所有副本”。

## 10. 失败与降级

| 失败 | 行为 |
|---|---|
| System One 超时/429 | 启发式降级，候选继续；记录 usage/fallback |
| Review 429/5xx | `Retry-After` ≤30s 才后台等待后重试 1 次；>30s 不得 clamp 提前重发，按完整期限持久化延后；重试后仍失败写 failed 记录，不阻塞 turn |
| Review 空返回 | `ReviewEmptyResponseError`，可 repair 一次；不生成通用 Error |
| Review 预算/远期限 | run/request 分离；预算不足或 `Retry-After` >30s 只延后（完整 `retryAt`），不丢窗口、不置 failed、不重复 skipped |
| 跨项目 session | 跳过，不重跑、不写入 |
| 召回失败 | 返回 degraded 空结果，不抛给调用方 |
| 撤销冲突 | 409 + 当前 version，不写；不提供“仅恢复文本”；UI 只给安全逆转或停止使用 |
| 旧 session 已注入 | 下一次模型请求重建并排除；已开始请求/外部动作不追回 |
| 写入中断 | WAL/事务回滚；`change-journal` 可重试 |
| 容量 95% | 冻结自动写入，capture 继续；恢复后重试 |
| 磁盘/读取失败 | 保留原文件，不覆盖；状态标 unknown/stale，不显示 0 |

## 11. 与既有文档的差异决议

`reports/ux-contract.md` 是 P0 前已生成的 UX 报告，主代理已要求 UX 作者在其原 session 修订；**P0 只引用，不修改该文件**。以下决议是方向权威，UX 报告修订以本节为准，但不改变“全量自动化 + 可撤销 + 三入口”的总目标。

| # | 裁决 | 落地要求 / 对 UX 的影响（UX 作者据此修订） |
|---|---|---|
| 1 | 停止使用/撤销成功后，下一次模型请求即排除错误记忆，**含旧 session**；已开始请求/已执行外部动作不可追回 | 修正“只对新会话生效”的表述；增加“下一次请求”与“不可追回”边界 |
| 2 | 随时可停止使用；版本回退默认保留 **90 天**（可配置建议）；旧 merge 的 24h **只约束 legacy**，不能约束新统一撤销 | 修正 §3.3 的 24h 作为通用撤销窗口；过 24h 不得禁用停止使用；90 天后只停用、不回退正文 |
| 3 | 全机含备份彻底 erase 不在本轮必实现范围；不承诺云端删除；后台模型仍可出网 | 删除/隐藏“彻底删除所有副本”的承诺式入口；文案不得写“全本地/云端已删” |
| 4 | 普通自动记忆零待审；legacy 审查入口放“设置 › 高级与维护”，**不能**在活动页换一个“待确认”徽标继续催人工 | 活动页无待确认 badge；原 Queue 功能整体下沉高级维护；记忆页不显示审批数 |
| 5 | 冲突不得“仅恢复文本”覆盖后续正确编辑；版本安全逆转，否则停止使用 | 删除“仅恢复文本”选项；冲突时只给“安全逆转/停止使用/保留结果” |
| 6 | UI 稳定契约 = 统一事件/版本/来源/可撤销 + 只读活动 API | 版本时间线、活动流、行内动作都以 `/api/changes` 与 `/api/memory/items` 为准，不依赖聚合计数；旧 `/api/items` 形状不变 |
| 7 | 旧 `GET /api/items` 响应形状不变；新 envelope 走 `/api/memory/items` | UI 不直接改旧 response；新页面消费新路由 |
| 8 | `ItemKind` 真实 union 无 `decision`；decision 落 `fact` + `reviewType` | 配置/接口/UI 不出现虚构 kind |
| 9 | `memoryVersion` 含 nearest-expiry 时间状态；不是 mtime/size-only | 无写入跨过期点也失效；下一请求 hook 执行刷新 |
| 10 | 保留上限是策略，不剥夺 active 记忆撤销 | active 最新可逆事件/90 天回退受保护；新文件计入容量 |
| 11 | soak 调真实生产函数 + fake clock；迁移真实可回退幂等演练 | 不写 toy 状态机，不冒充 30 天实运行 |

保留 ux-contract 的以下内容：三入口信息架构、暖灰+墨绿 token、来源/版本/撤销可见性、扩展适配、高级审计/图谱/健康/技能/备份保留、键盘与 44px 要求、旧深链重定向、可访问性场景。

`docs/ARCHITECTURE.md` / `QUALITY.md` 的 gate 描述在 P03 后需要同步更新，但 P0 不改；实现阶段以本文件 + 阶段文档为准，完成后回写。

## 12. 风险与未决

| 风险 | 缓解 |
|---|---|
| `memoryVersion` 每轮读 items 的成本 | mtime+size + nearest-expiry 状态缓存；仅 context hook 调用；20 轮稳定性测试 |
| change 账本增长 | 5000 条/90 天/每 item 20 条；active 最新可逆事件/90 天回退受保护；迁移不重写历史 |
| 自动写入错误内容 | 默认关闭；P01 先可逆；P03 高阈值 + 隔离 + 日预算 + 一键 kill switch |
| review 自动 lane 与旧 gate 冲突 | 默认关闭；旧测试不动；新增独立开启测试 |
| 迁移误触真实数据 | 脚本路径白名单 + 拒绝真实路径 + 只隔离演练 + 独立确认 |
| OpenCode V2 transport 差异 | P02 实现前查 V2 文档/SDK；`generate` 注入可 fake；缺 API 时明确报错不静默直连 |
| “全自动”被误解为 L0 自动 | 文档/设置/审计处处写明“描述性记忆，不是规则/权限” |
| 长项目永远用旧事实 | 证据绑定 supersede（唯一目标/scope/逐字 A→B/单点差异/CAS/非否定反转）；未证实差异仍隔离，不 append 掩盖 |
| supersede 误覆盖 | relations 数字/标识/否定守卫与 lint 不放松；定位不到唯一差异即 `supersede_blocked` + 隔离 |
| 合成块误当偏好 | 采集层剥离 + 分类层兜底；不因关键词/长度一刀切；genuine 片段保留 |
| 容量到达上限后永久停写 | 维护 tick 在已批准 policy 内安全回收；复检恢复；无安全数据如实 `blockedReason/retryAt`，不假称自动 |
| “开关绿了其实不写” | `enabled`/`configuredMode`/`effectiveMode` 分开；observe 明确不写；单模式 POST 原子设置 |
| 回收误删历史 | 与 P06 保护集合一致：active 最新/90 天窗口/引用闭包/未完成事务/pin journal 保护；必要 suppression tombstone 不清；窗口外普通历史不因 `undone=false` 永久保留 |

未决（实现阶段前必须回答）：

1. `generate.text` 在 V2 的准确签名与 usage 返回形状（查官方 V2，不猜）。
2. 会话 `contextProjectKey` 对旧会话的补齐策略（P02 先跳过无归属，P06 迁移不批量补）。
3. quarantine 计数只放“设置 › 高级维护”的只读摘要与活动聚合，**不进一级导航徽标、不催人工**（方向已定，展示细节 P05 定）。
