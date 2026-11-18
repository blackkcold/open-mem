# P03 preflight — autonomous pipeline

Date: 2026-11-11
Scope: 只读静态核查 + 更新 `phases/03-autonomous-pipeline.md`；不改产品代码、不跑测试/构建、不提交、不访问真实记忆/配置/凭证、不发起模型请求、不创建子代理。
Baseline: `b992a2e`（只读 `git show b992a2e:plugin/src/...`）
Method: 读基线 consolidate / curator / capacity / config / store / plugin / server / review.accept / session.filters / write-guard / relations；P01 正在同一 worktree 改 `types/store/consolidate/config/plugin/server/curator/session-promotion/actions/apply/compact` 并新增 `changes.ts`、`memory/suppression.ts`，本预检**未读这些在写文件**、也不据其判断 P01 完工；P03 只以 DESIGN §5/§6/§8.1/§8.3 的签名和基线行为为准。

## 1. 结论

预检通过（文档层），但基线离“全自动”有四道实质缺口，方案已按代码事实修正：

1. **今天是 append-only，且 review 永不自动**：`canAutoApply` 要求 `mergeAction==="create"` 且 `origin==="session-review"` 直接 false（`consolidate.ts:881-896`），`touchItem` 存在（`store.ts:769`）但 consolidate 从不调用。只提高阈值不会变成“按证据更新”，只会变成“更少的高分事实”。
2. **容量只拒绝、不回收**：`capacity.ts:53-55,85` 在 ≥85%/≥95% 直接拒绝自动写；基线唯一维护是启动时一次 `runCurator`（`plugin.ts:286`），没有周期调度，也没有回收路径 → 一旦到 95% 就是事实上的永久停写。
3. **合成文本没有统一入口**：`extractCandidates`（`consolidate.ts:844-880`）只按 `role=user` + 关键词触发 + **8..400 字符**过滤；`session/filters.ts` 只挡 keep-alive 与 synthetic 元数据。任务模板、子代理通知、`<context>`/`<skill_content>`、续跑指令、表格都没有剥离，正是历史污染的来源；同时 6 字的真实偏好（“用 pnpm”）和 400 字以上的真实偏好会被长度一刀切丢掉。
4. **review lane 的门用了错信号**：`reviewDecision` 恒返回 `safeAuto:0, strictness:"unknown"`（`review/decision.ts:26-29`），若沿用 safeAuto 阈值，review 描述性候选会永远进隔离/队列。reviewLane 必须用确定性门。

方案已在 `phases/03-autonomous-pipeline.md` 落盘：源类别矩阵 14 类、路由矩阵、跨 origin 抑制、touch/update/quarantine 三态、**证据绑定 supersede lane（C1–C9）**、TTL 与回收的真实接线、原子预算、legacy 配置保护、**写入模式与状态语义（R8/R9）**、24 组 RED 测试与 12 个生产接线点。**未修改产品代码、未提交、未接触真实数据。**

## 2. 基线证据（观察 → 影响）

| 项 | 观察（`b992a2e`） | 影响 |
|---|---|---|
| 自动写条件 | `canAutoApply` 要求 create、非 review、safeAuto ≥ 阈值（`consolidate.ts:881-920`） | 自动写只能新增；无更新语义 |
| 更新能力 | `store.touchItem` 存在（`store.ts:769`），consolidate 只 `saveHook("ignored")` | 重复证据被丢弃，`seenCount` 不增长 |
| review 硬排队 | `canAutoApply:896` review 恒 false；`reviewDecision` safeAuto=0 | 必须新增 reviewLane，且不能用 safeAuto |
| 冲突守卫 | `classifyRelation`/`findWriteConflicts` 已覆盖数值/标识/否定（`relations.ts:318-353`） | 直接复用，不新造相似度 |
| 重复守卫 | 事务内二次 `findWriteConflicts` + `ownsClaim`（`consolidate.ts:472-560`） | 更新路径沿用同一模式 |
| 隔离 | 无 `quarantine.jsonl`；低分候选直接 ignored（`consolidate.ts:568-586`） | 需新文件 + TTL + 调度 |
| 容量 | `capacity.ts:53-55` freeze/compact 只返回拒绝；`reasonFor:147` 文案“冻结自动写” | 无回收、无退避、无恢复，不能宣称全自动 |
| 维护调度 | 仅启动一次 `void runCurator`（`plugin.ts:286`）；curator 24h 自锁（`curator.ts:63-70`） | 长驻进程内无 TTL/回收触发点 |
| curator 账本 | `applyItemChanges` 记 maintenanceID（`curator.ts:171-190`） | P01 统一事件后改为写 `expire`/`update` |
| 预算原子性 | `takeModelSlot` 在 `withStateLock` 内读改写（`store.ts:634-645`）；`incrementStat` 也单次锁（`:1045`） | 可仿写 `takeAutomationSlot`；禁止两步检查 |
| 事务/锁 | `transaction` = 文件锁 + batch + rollback（`store.ts:208-249`） | 自动写/更新/计数必须在同一事务 |
| 合成过滤 | `filters.ts:7-27` 只有 keep-alive + synthetic 元数据 | 需结构性剥离，不按关键词 |
| 长度阈值 | `extractCandidates` 8..400（`consolidate.ts:854`） | 真实偏好被丢；改为“剥离后按句判断” |
| review 抑制键 | accept 写 `review|sid|mid|hash`，`turnID=review:<reviewID>`（`accept.ts:144-156`） | 抑制不能依赖 reviewID，需身份归一 |
| 配置合并 | `mergeConfig` 对嵌套用 `Object.assign` 整体替换（`config.ts:123`） | 部分 `automation` 补丁会丢 `enabled` 默认值 → 必须深合并 |
| 配置写入 | `applyConfigPatch` 白名单式逐字段（`server.ts:1434`）、`PERSISTED_SETTINGS_PATHS:1595` | P03 只加已实现字段，不暴露假控件 |
| 旧配置 | `readConfig` 直接返回磁盘 JSON（`store.ts:314`），旧文件无 `automation` | 默认 false 可保证；但需测试 fixture 证明不误启用 |
| 生命周期 | `setupPlugin` 返回 dispose（`plugin.ts:922-940`） | 维护 timer 必须在此清理，否则测试/宿主残留 |

## 3. 预检决定

1. **采集层与分类层分离**：`session/filters.ts` + 新 `memory/sources.ts` 负责“剥合成、留真实”，`classifyAuthority` 负责“有没有资格成为描述性记忆”。两层都不授予权限。
2. **不按长度/关键词一刀切**：先剥 `<context>`/`<skill_content>`/`<subagent …>`/续跑指令/引用行/围栏，再按句判断；短句仅在“无触发词且非祈使/偏好”时忽略；超长句进隔离（`too_long`），不静默丢。
3. **任务信封整体不学**：同时含 `TASK:`+`MUST DO`+`MUST NOT DO`+`CONTEXT:` 的消息整体 `task_template`；单独的 MUST NOT DO 行不因标题词被判模板。
4. **敏感判定看意图**：`redactText` 命中真实值才 skip；提到 cookie/删除的工程知识可学；请求授权/存凭证/破坏性动作才 `protected`。
5. **reviewLane 确定性门**：kind ∈ 描述性、authority 非 protected/template/table/subagent、scope=project 或明确 global、user-kind quote 与真实 user 文本逐字匹配（空白归一）、global 另需跨项目措辞或独立会话证据。
6. **更新三态**：exact/covered → touch；同主体兼容新证据 + `autoUpdate` → update（before/after 事件）；数值/标识/否定/kind 冲突 → quarantine（双方保留）。更新走事务 + `expected` 版本 + `ownsClaim`。
7. **抑制按源身份**：`sessionID|messageID|sha16(text)`，归一 `turn|`/`review|` 前缀；新 messageID 才可再学；不依赖 reviewID/turnID。
8. **隔离有真实调度**：启动 + 15min `unref` timer + 容量事件三处都调 `runMaintenanceTick`，内部 `claim("maintenance:tick")`；读接口不写；`dispose` 清理。
9. **容量回收 + 退避**：拒绝时记 backoff（指数上限 60min）并触发回收（过期/精确去重/按 caps 修剪），复检通过即恢复；无冷数据则 skip 并如实显示 `blockedReason/retryAt`，不宣称自动运行。
10. **预算单点原子**：`takeAutomationSlot(kind, limit, now, sessionID?)` 一次锁内读改写；写事务内占位、失败回滚不计数；`maxWritesPerSession` 计写入条数（从 change 账本/等价计数），名实一致。
11. **配置安全**：默认 false；`ConfigPatch`/`PluginOptions` 增加 `automation` 且 `mergeConfig` 深合并；`autoRules` deprecated no-op；PATCH/公开状态只含已实现字段。
12. **supersede 是窄 lane，不是放宽守卫**：只有 C1–C9 全满足才改同一 item；其余数值/版本/标识差异仍隔离。`planSupersede` 做成纯函数便于先写失败测试；relations 的数值/标识/否定判定与 lint 原样保留。
13. **状态字段分开声明**：`enabled`/`configuredMode`/`effectiveMode`/`blockedReason`/`retryAt`/`lastSuccess`；`effectiveMode` 读取时现算；shadow 旧语义不变；`POST /api/automation/mode` 原子设置关联字段。

## 4. Ruling（2026-11-11，预检）

- **R1 抑制按源身份，不按流程 ID**。P01 若只写 `hook.key`，P03 读取时归一前缀即可，不改 P01 签名。
- **R2 Item 可选审计元数据**（`reviewType?`/`authority?`/`grantsPermission?: false`）。属 DESIGN §5.2 可选字段；编码前先同步 §5.2 与 §6.2 的 `AutomationInput`，不静默偏离。
- **R3 review lane 不用 safeAuto**。`reviewDecision.safeAuto=0` 是事实，阈值门会让 review 永久排队。
- **R4 维护只在后台**。启动 + timer + 容量事件；`claim` 防多实例；`dispose` 清理；`GET` 不清理。
- **R5 容量回收而非停写**。≥compact 先回收再复检；backoff 有上限可恢复；无冷数据时如实显示阻断原因。
- **R6 legacy 不误启用 + 深合并**。部分补丁不得丢 `enabled=false`；`autoRules=true` 不能自动写 rule。
- **R7 预算单点原子**。禁止“先读后写”两步；只暴露已实现控件与真实计数。
- **R8 数值/版本/标识变化不得永久隔离**。区分“未证实冲突”（隔离、双方保留）与“用户针对同一项目同一事实明确从 A 改为 B”。后者走证据绑定 supersede：唯一目标、scope 完全匹配、逐字 user quote 同时含 A/B、只允许来源明确支持的单点差异、其余信息保留、版本 CAS、目标 auto 且非 manual/promoted/rule；结果改写同一 item（旧值进历史，可 undo），不新增第二条、不覆盖否定反转/引用示例/多目标。定位不到唯一差异 → `supersede_blocked` + 隔离，**不偷偷 append**。不绕过 `classifyRelation` 的数字/标识/否定守卫，不放松 lint/validator。
- **R9 状态语义分开，模式一次设置**。API 分别声明 `enabled`（意图）/`configuredMode`（legacy|observe|autonomous）/`effectiveMode`（含 blocked）/`blockedReason`/`retryAt`/`lastSuccess`；`shadow=true` 仍是“观察不写”，不得因 `enabled=true` 假装自动；legacy 与 autonomous 可辨；`POST /api/automation/mode` 单事务原子设置关联字段（legacy→enabled=false；observe→enabled+shadow=true；autonomous→enabled+shadow=false），revision 不符 409；不擅自开启正式配置；`lastSuccess` 只随真实 add/update 变化（seen/隔离不算）。

## 5. 与其他阶段的契约

| 阶段 | P03 消费 | P03 不碰 |
|---|---|---|
| P01 | `recordChange`、`ItemSnapshot`、`isSuppressed`、`memoryVersion`、`transaction` | 不另写账本；不改 changes/undo 语义；抑制键只做读取归一 |
| P02 | review 产生的 hook（`origin=session-review`）、预算错误语义、权威 projectKey | 不改 provider/orchestrator/accept 签名；reviewLane 只读 hook 字段 |
| P04 | 只保证 auto 写入的 item 可被检索 | 不做召回、不写 context block |
| P05 | 只提供 `/api/automation` 与 status 字段 | 不做 UI；不实现假开关 |
| P06 | 隔离/回收/新文件计入容量与保留预览 | 不改 retention 公式；不执行迁移 |

## 6. 剩余风险 / 未验证

| 项 | 状态 |
|---|---|
| `<subagent sessionID=… state=…>`、`[Session task state — reference only; …]` 的真实 transcript 形状 | **assumed**（来自任务书，未在仓库观测到常量）：实现用结构匹配，并用 harness 实测补 fixture |
| 15min timer 与宿主生命周期的匹配度 | 未实测；只以 `dispose` 后无句柄、tick 幂等为验收，不声称跨平台调度精度 |
| P01 抑制实现是否已按身份键落盘 | 未读在写文件；P03 侧归一兜底，实现时以 `suppression.test.ts` 跨 origin 用例为门 |
| 容量回收能否在测试中真实越过阈值 | 用较小 `caps`（itemsTotal/diskBytes）构造，不造大文件；不声称生产磁盘实测 |
| review quote 逐字匹配的归一强度 | 空白/换行归一是确定的；同义改写不算证据（保守，可能漏学但不误学） |
| 长会话内 15min tick 的实际触发 | 单测直接调用 tick；进程级只验证接线与清理，不验证 15min 真实等待 |
| supersede 的“唯一差异”定位强度 | 只接受 quote 内可逐字定位的单点替换；定位不到即 blocked，宁可隔离也不猜；不声称覆盖所有自然语言改写 |
| 用户一句话改多个值 | 拆成多条各带自己 quote，或整体隔离；不合并推测 |
| `lastSuccess` 与 touch/seen 混淆 | 定义只含 add/update/supersede；测试断言 seen、隔离、skip 均不更新 |
| `effectiveMode` 与配置漂移 | 只读时由 enabled+shadow+capacity+backoff 现算，不落盘、不做第二事实源 |

## 7. 验证记录

| 检查 | 方式 | 结果 |
|---|---|---|
| 自动写/评审门现状 | 读 `consolidate.ts` 基线 881-920、`review/decision.ts:26-29` | 已核对 |
| 更新/冲突守卫 | 读 `relations.ts:318-353`、`write-guard.ts`、`store.ts:769` | 已核对 |
| 隔离/维护现状 | 读 `capacity.ts:53-147`、`curator.ts`、`plugin.ts:286,922` | 已核对 |
| 预算/事务/锁 | 读 `store.ts:208-249,634-645,1045-1060` | 已核对 |
| 合成过滤/长度 | 读 `session/filters.ts`、`consolidate.ts:844-880` | 已核对 |
| review 抑制键 | 读 `review/accept.ts:144-156` | 已核对 |
| 配置合并/写入口 | 读 `config.ts:115-140`、`server.ts:1206-1300,1434,1595` | 已核对 |
| 测试/构建 | 未运行（预检禁止；P00 基线日志 803 tests 存在） | not-run: 本阶段只做静态预检 |
| 产品代码/真实数据 | 未改、未访问；P01 在写文件未读 | 符合约束 |
| Ruling 补充（supersede / 状态语义） | 主代理要求：数值/版本/标识变化不得永久隔离；`enabled`/`shadow` 不得假装自动 | 已记入 §3 决定 12–13、§4 R8–R9 与 phase §5.1/§十、TDD 9b–9d/19–21 |
| 交付 | `phases/03-autonomous-pipeline.md` 重写 + 本报告 | 完成 |

结论：P03 方案可进入实现（P01 验收后、P02 预算可靠后）。实现按 phase 文档的 12 个接线点与 24 组 RED 测试先写失败测试；任何接口追加先同步 DESIGN §5.2/§6.2，再动代码。

## 8. 合版记录（2026-11-11，等待 P01fix2 期间）

已把冻结方案与裁决合入总文档的 **P03 相关段**，未改产品代码、未跑测试、未提交、未触碰其他阶段段落：

| 文档 | 合入内容 |
|---|---|
| `DESIGN.md` §5.2 | Item 可选审计元数据 `reviewType/authority/grantsPermission:false` |
| §5.5 | 抑制按源身份跨 turn/review、不依赖 reviewID |
| §6.1 | automation 默认关闭/深合并/`PluginOptions`；写入模式与状态字段；`POST /api/automation/mode` 原子设置 |
| §6.2 | `classifyAuthority`、`planSupersede` 签名；源过滤、review 不用 safeAuto、global 升级门、supersede 与 quarantine、维护/回收、跨实例预算 |
| §6.3 | `autoRules` no-op、shadow 观察语义、只显式启用 |
| §8.3 | `sources/supersede/maintenance/takeAutomationSlot` 契约与状态/mode API |
| §12 | supersede/合成块/永久停写/假自动/回收误删风险 |
| `PLAN.md` §3 P03 | 产物与 15 条检查；标注“方案冻结、代码未实现、等 P01/P02 验收” |
| `ACCEPTANCE.md` §4 | 23 条测试判据，标注“全部待验证” |
| 本文 | 合版记录与未实现边界 |

**未实现边界（不得当作已完成）**

- P03 任何代码/配置/API/测试均未落地；上表只是契约，`npm run verify` 未因此运行，测试数未变。
- 未实测 15min timer 与宿主生命周期、`<subagent …>`/续跑指令真实形状、容量回收在真实磁盘的表现；均按 `assumed`/`not-run` 处理。
- P01 fix2 与 P02 验收未完成前不进入实现；不因等待自行开工，不把文档合版计入阶段完成。
- 与 P06 的边界已对齐：policy 内回收、active 最新/90 天窗口/引用闭包/未完成事务/pin journal 保护、必要 suppression tombstone 不清、窗口外普通历史不因 `undone=false` 永久保留。P06 段本身未改动。
