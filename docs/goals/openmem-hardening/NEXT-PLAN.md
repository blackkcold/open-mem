# OpenMem 下一轮整体优化方案

版本：v1.1（第一批已实施）
状态：**第一批（14.4）已实施并通过全量门禁；阶段 0–8 其余部分仍未授权**
日期：2026-11-06
分支：`feat/approval-workflow`（工作树已有大量未提交变更）
关联记录：`PROGRESS.md`、`EXECUTION-REPORT.md`、`REMAINING-PLAN.md`、`docs/BASELINE-COVERAGE.md`

---

## 0. 结论先行

> **推荐：先补"阶段 1 安全收口"，不要直接进入阶段 4（真实自动改写）或 Stage C（语义识别）。**
>
> 下一轮应优先解决：现有写入路径绕过校验、项目范围不一致、覆盖与恢复状态过度承诺。
> 随后再补恢复演练、性能和交付一致性，最后讨论受控改写。

阶段 0–3 确实已交付大量实现，但**"安全路径已统一收口"尚不成立**。本方案基于 3 路 subagent 只读调查与主会话源码交叉核对，不继承任何历史测试数字作为本轮证据。

---

## 1. 调查方法与证据边界

### 1.1 本轮做了什么

| 项目 | 说明 |
|---|---|
| 调查方式 | 3 路 `explore` subagent 并行只读调查 + 主会话独立核对源码 |
| 分工 | ① 安全与数据一致性 ② 恢复与运行交付 ③ 产品与质量 |
| 主会话核对 | `graph.ts`、`baseline.ts`、`compact.ts`、`curator.ts`、`relations.ts`、`scope.ts`、`plugin.ts`、`apply.ts`、`migrate.ts`、`lock.ts`、`server.ts`、`MapView.tsx`、`Queue.tsx` |
| 外部契约 | OpenCode V2 官方插件文档；已安装 `@opencode/plugin` 2.1.4、`@opencode/schema` 2.1.4、`@openchamber/sdk` 2.6.0 声明 |
| 未执行 | 未修改代码；未运行测试/构建/安装；未启动服务或浏览器；未读取真实记忆/配置/凭证；未执行恢复、清理、迁移、提交、发布 |

### 1.2 不作为缺口重复报告的能力

以下能力**已存在**，本方案要求复用而不是重建：

- redo WAL 与跨文件逻辑事务：`plugin/src/util/transaction.ts`、`plugin/src/store.ts:203-239`
- 队列 CAS：`queueItemSnapshotVersion`、`patchQueue(patches, expectedVersions)`
- 保留策略：90 天 / 每类至少最近 20 次、预览确认、引闭包保护
- 冷会话归档与续聊游标恢复
- 跨项目隔离主路径：`sameScopeAndProject`
- 统一关系判断：`classifyRelation`（已接入 consolidate、audit、health、baseline、promotion、review accept）
- 审批与 agent 主门禁：agent 工具禁止 approve / apply_suggestion / promote
- 控制台 token timing-safe 比较、一次性连接票据、CSP/CORS 限制
- Queue 项目筛选、加载失败保留旧列表并禁用写入

剩余限制是**真实断电 / 硬件故障 / ENOSPC / 长期 soak 未验证**，不是"没有 WAL / 没有保留"。

### 1.3 证据分级

| 级别 | 含义 | 本方案中的使用 |
|---|---|---|
| 已确认（observed） | 主会话或 subagent 实际读过源码/声明 | 可直接作为实施依据 |
| 条件性（inferred） | 代码路径成立，但触发取决于配置/数据/环境 | 需标注触发条件，不写成确定故障 |
| 未知（unknown） | 未读取真实数据、未实测宿主能力 | 必须标"未知"，不得用流畅表述掩盖 |

### 1.4 本轮验证状态

- **未运行** `npm run verify`、任何测试、类型检查、构建。
- 文档记录的 **57 文件 / 695 用例** 是 `PROGRESS.md:113` 的历史声明，**不作为本轮证据**。
- 历史 L4 记录同样不继承。
- 本方案中出现的性能目标、恢复结论均为**待验证目标**，不是已测结果。

---

## 2. 调查后需要修正原交接的判断

### 2.1 成立且需要前置的风险

| # | 风险 | 证据 | 严重性 |
|---|---|---|---|
| 1 | compact / curator 仍用 SimHash 或 0.92 相似度归档条目，未全部经过新的数字/版本/否定冲突守卫 | `plugin/src/compact.ts:54`、`plugin/src/memory/curator.ts:126` | 高 |
| 2 | 单条 `apply_suggestion` 服务端未统一要求 `suggestion.validation.ok` 与就绪状态；UI 禁用不能替代 API 校验 | `plugin/src/apply.ts:55`、`plugin/src/actions.ts:233-254`、`plugin/src/server.ts:503-525` | 高 |
| 3 | agent 工具存在跨项目可达入口：`review` 返回完整队列；按 ID 的 `suggest`/`decide` 未带调用方项目范围；`console_url` 把可兑换控制台凭证的链接返回给模型 | `plugin/src/plugin.ts:714`、`plugin/src/plugin.ts:739-751`、`plugin/src/plugin.ts:769-771` | 高 |
| 4 | scope migration 有 CAS，但不是完整事务：备份/journal 用原生 `copyFile`/`writeFile`，与 `patchQueue` 分离；apply 未绑定用户看到的预览 | `plugin/src/memory/migrate.ts:101-127`、`plugin/src/server.ts:1079-1091` | 中高 |
| 5 | "基线已覆盖"和"备份可用"过度表达：匹配只比较正文；覆盖排序优先于冲突；备份主要检查文件存在；恢复能力靠脚本文本匹配；L0 恢复硬编码 `true` | `plugin/src/baseline.ts:163`、`console/src/pages/Queue.tsx:2131`、`plugin/src/graph.ts:506`、`plugin/src/graph.ts:638-647` | 中高 |
| 6 | 关系判断对否定变体漏判，对"新增数字"误判冲突 | `plugin/src/relations.ts:46-47`、`plugin/src/relations.ts:95-96`、`plugin/src/relations.ts:138-164` | 中高 |
| 7 | 作用域分类器把常见项目规则判为 global；复核模型 scope 无确定性校验 | `plugin/src/memory/scope.ts:8-27`、`plugin/src/review/parse.ts:54-59`、`plugin/src/review/validate.ts:56-126` | 中高 |

### 2.2 需要降级或修正的结论（不能写成确定缺陷）

| 原结论 | 修正 | 依据 |
|---|---|---|
| worktree 必然分裂项目记忆 | **条件性风险**：仅在 canonical 缺失回退到 `directory`、项目移动/重命名、legacy 用显示名哈希时成立 | `plugin/node_modules/@opencode/schema/dist/project.d.ts:8-14`；`Worktree.CreateInput.directory` 注释表明使用 canonical configuration |
| live `memory.json` vs 备份 `global.json` 是命名 bug | **不是 bug**，是 live/backup 命名差异；风险在于 adapter 与真实备份布局未验证 | `~/.config/opencode/memory/MEMORY_ARCHITECTURE.md:91` 明确备份为 `global.json` |
| 真实 config 已含 token / 已泄漏 | **未确认**；`Store.writeConfig` 明确剥离 token。应作为**防御性脱敏要求** + 合成回归 | `plugin/src/store.ts:318-320`、`plugin/src/types.ts:464` |
| 同机长事务超过 30s 必被抢锁 | **不成立**；锁已检测同 host 存活的 PID 并继续等待。仅剩跨 host、owner 解析失败、TOCTOU 等条件性风险 | `plugin/src/util/lock.ts:45-83` |
| 移除 `console_url` 即完成强隔离 | **不成立**；token 是本地授权凭证，同 OS 用户有 shell 时可读。移除只收缩模型可见面 | `plugin/src/store.ts:1070-1079`、`PROGRESS.md:49` |
| 已安装 SDK 无 memory 接口 = 宿主绝对无 L1 CAS | **只能说明 SDK 未公开**；不能断言宿主内部无能力 | `console/node_modules/@openchamber/sdk/dist/host.d.ts:100-101` |

### 2.3 仍属未知、必须实测的项

1. 真实备份目录布局与命名；`global-memory/autopilot/items.jsonl` 是否就是当前 dataDir 的备份。
2. `rollback-memory.sh` 是否真的能恢复 OpenMem / 逻辑链图（图谱只做字符串匹配）。
3. 线上安装目录 `~/Documents/Opencode project/open-mem/plugin` 的 `src`/`dist` 一致性（未越界读取）。
4. 安装宿主是否实际传入 `project.id`、`workspaceID`、`canonical`。
5. OpenChamber `projectId` 与 `projects/<dir>/memory.json` 的映射规则。
6. 备份调度文档漂移（`MEMORY_BACKUP.md` 说 launchd，backup-memory skill 说已切 OpenChamber 调度）——是文档不一致，不等于实际调度故障。
7. 真实 store 中 token / cache / log 的排除情况。
8. 真实 500 条规模延迟、真实屏幕阅读器验收、真实模型语义准确率。

---

## 3. 指导原则与不做事项

### 3.1 目标

1. 不因去重、压缩、改写或迁移静默丢失有效信息。
2. 项目范围、调用方范围、图谱范围与基线范围保持一致。
3. "已覆盖、就绪、可恢复"等状态都有明确证据。
4. 所有真实变更可预览、可定位、可冲突拒绝、可安全撤销。
5. 源码、构建产物、安装版本和真实运行实例能够对应。

### 3.2 不做事项

- 不重写存储系统，不新增数据库、向量库或第二套记忆库。
- 不重建已有 WAL、CAS、撤销和保留机制。
- 不把更多模型调用当成确定性判断缺陷的补丁。
- 不自动改写 L0/L2 规则文件。
- 不绕过宿主接口直接改写 OpenChamber L1 JSON。
- 不自动提交、发布、同步安装目录或清理真实数据。
- 不把 console token 或 `confirmedByUser` 布尔值当作人类身份认证。
- 不未经验证就重写锁系统。

### 3.3 路线总览

```text
阶段 0  工程基线与能力边界（前置）
   ↓
阶段 1  现有写入链路安全收口（P0）
   ↓
阶段 2  覆盖判断与状态表达可信（P0/P1）
   ↓
阶段 3  统一项目身份与请求上下文（P1）
   ↓
阶段 4  备份与恢复可验证（P1，真实恢复另授权）
   ↓
阶段 5  性能、解释与操作闭环（P1/P2）
   ↓
阶段 6  受控整理与真实改写（后置、独立 opt-in）
   ↓
阶段 7  可选 Stage C 语义提示（P2，默认关闭）
   ↓
阶段 8  构建、安装与运行版本一致（P1，发布另授权）
```

---

## 4. 阶段 0：冻结工程基线与能力边界

**优先级：前置**

### 4.1 现状

当前工作树有 **54 个已跟踪变更、29 个未跟踪文件**。下一轮实施必须先保护这些既有成果，不能直接从默认分支重做（`npm run verify` / 任何测试本轮均未运行，此数字来自 `git status --porcelain` 统计）。

### 4.2 工作

1. 建立变更清单，区分既有变更与本轮允许修改的文件。
2. 基线记录覆盖未跟踪文件，而不只是 `git diff`。
3. 保持当前分支；不自动 stash、切分支、移动或删除 worktree。
4. 记录插件、console、extension、安装 SDK 的版本与实际入口。
5. 建立能力矩阵：
   - OpenCode 是否实际传入 `project.id` / `workspaceID` / `canonical`。
   - 当前 SDK 的 `worktree` API 形态（安装版 2.1.4 是 `list(sourceDirectory)`，官方最新文档是 `list({projectID})`，不能按最新文档设计）。
   - OpenChamber `projectId` 与 OpenCode 项目身份如何对应。
   - L1 是否存在受支持的读写、版本前置条件和批事务接口。
6. 实施开始时重新运行工程基线验证，记录当前真实结果；历史数字不能作为新修改的验收依据。

### 4.3 验收

- 本轮允许修改范围清楚。
- 所有既有未提交成果保持不变。
- 能力分为"已确认 / 未公开 / 待实测"，不以最新文档替代安装版本。

---

## 5. 阶段 1：现有写入链路安全收口

**优先级：P0｜建议拆成四个小批次，分别测试**

### 5.1 批次 1A — 统一去重与自动维护守卫

**范围**：`plugin/src/compact.ts`、`plugin/src/memory/curator.ts`、`plugin/src/fingerprint.ts`、`plugin/src/relations.ts`、关联测试。

**工作**：

- 清查所有"判重复后跳过、归档、替换"的入口。
- compact/curator 不再直接把 SimHash 或相似度阈值当合并依据。
- 复用统一关系判断；冲突、分类不一致、部分重合不得自动归档。
- 初期自动维护只处理证据充分的同类完全重复。
- `covered` 是有方向的覆盖关系，不等于可随意合并两条。
- 保留来源、时间、版本与撤销记录。
- 冲突时不靠"更新优先"或"旧记录优先"自行选真相。

**已复现证据（只读调用当前 `plugin/dist` 纯函数；仅行为佐证，最终以源码为准）**：

- `"本地 dev server 端口是 5198"` vs `"本地 dev server 端口是 5199"`：`hamming=3`，`textSimilarity=0.714`，`isExactDuplicate=true`。
- 长文本 `"…版本是 2.4.1…"` vs `"…版本是 2.4.2…"`：`textSimilarity=0.920`，`isExactDuplicate=true`。

**验收**：

- 端口、版本、日期、否定极性不同的两条记录均保留。
- 长文本高相似度也不能绕过守卫。
- 同文不同 kind 不自动消失。
- 现有 journal/undo 仍可用。

### 5.2 批次 1B — 把校验放到服务端写入边界

**范围**：`plugin/src/apply.ts`、`plugin/src/actions.ts`、`plugin/src/rewrite/validate.ts`、`plugin/src/memory/promotion.ts`、`plugin/src/memory/session-promotion.ts`。

**工作**：

- 单条 apply 要求建议就绪且 `validation.ok === true`。
- 写入时重新检查当前候选、目标内容版本、项目范围与改写结果。
- 补齐否定极性、关键限定条件、标识符保留校验。
- 人工编辑采用明确的人工修改语义，重新 lint 并展示差异；不能伪装成"模型验证已通过"。
- approve / promote / apply 复用一致的写入检查。
- 检查同目标范围的 active items 与 pending queue，排除候选自身。
- 修正中文端口等易失信息识别（`VOLATILE_RE` 的 `\b(?:port|端口)` 在中文前无法匹配）。
- 自动操作与人工确认使用不同风险策略：自动操作保守拒绝；人工操作展示冲突并允许有记录地处理。

**验收**：

- 未就绪、验证失败、目标过期的单条 API 请求均被拒绝。
- UI 禁用与服务端拒绝保持一致。
- 冲突不会因换一个审批入口而绕过。
- 手工修改不会被统计为模型安全验证通过。

### 5.3 批次 1C — 收口作用域与 agent 工具范围

**范围**：`plugin/src/memory/scope.ts`、`plugin/src/review/parse.ts`、`plugin/src/review/validate.ts`、`plugin/src/review/accept.ts`、`plugin/src/plugin.ts`、`plugin/src/actions.ts`。

**工作**：

- "本项目每次/一律/以后"不能仅因频率词被判为 global（当前 `GLOBAL_RE` 优先级高于 `PROJECT_RE`）。
- global 需要跨项目证据或用户明确选择；模型给出的 `scopeEvidence` 必须接受确定性校验。
- 不确定时保持 session/project，不自动扩大范围。
- agent `review` / `suggest` / `decide` 绑定当前项目和会话身份。
- 外项目 ID 返回明确错误，不只过滤列表。
- `status` / `audit` 输出遵守相同可见范围。
- `edit` 无法实施时返回"需控制台处理"，不能忽略修改后返回 `ok:true`。
- 不把含连接票据的 console URL 直接返回给模型；用户打开控制台走受信命令或宿主 UI。

**安全边界（必须写进文档）**：

移除 `console_url` 只能缩小模型可达面。同一 OS 用户拥有 shell 时，仍可能读取本地凭证。真正的人类审批边界需要受信宿主能力，不能用伪确认字段替代。

**验收**：

- A 项目工具结果不包含 B 的正文、证据和会话标识。
- A 不能按 B 的 ID 延后、拒绝或生成建议。
- 项目内规则不会自行晋升为全局规则。
- 工具返回值不再制造假成功。

### 5.4 批次 1D — 迁移原子化与来源读取安全

**范围**：`plugin/src/memory/migrate.ts`、`plugin/src/server.ts`、`plugin/src/graph.ts`、关联测试。

**工作**：

- scope migration 预览返回 `previewID`。
- `previewID` 绑定条目集合、原版本、目标范围与身份映射。
- apply 必须提交该 `previewID`；数据变化后要求重新预览。
- 备份、queue、journal、after-version 纳入同一现有事务/WAL。
- undo 同样校验版本并记录结果。
- `graph/source` 校验真实路径与允许根边界。
- 符号链接越界拒绝；必要的合法链接需显式声明。
- 来源片段复用现有 `redactText` 脱敏逻辑。
- L1 默认显示统计与元数据，原文查看作为单独隐私动作；二次确认只减少误披露，不宣称它是身份认证。

**验收**：

- 旧预览返回 409 且不写入。
- 每个持久化边界中断后，状态一致且可恢复。
- 不出现"报失败但队列已改、journal 无法撤销"。
- 合成密钥不出现在响应中。
- 越界链接与未知来源 ID 被拒绝。

---

## 6. 阶段 2：让覆盖判断与状态表达可信

**优先级：P0/P1**

### 6.1 批次 2A — 修正关系判断，不只扩词表或调阈值

**工作**：

- 区分同一信息槽位的值替换与新增补充信息。当前 `identifierMismatch = added > 0 || missing > 0` 会把"新增一个数字"判为冲突。
- 否定按子句、对象和条件检查，不只比较否定词出现次数。当前 `NEGATION_RE` 不含"不/别/勿/未/不再/不允许/不支持/不建议"，会漏判。
- 候选标题、段落标题参与主题判断。
- kind 已知时参与判断；来源 kind 未知时保留未知，不强行猜测。
- 短语包含、标题相似只能作为相关证据，不能直接证明覆盖。当前 `right.includes(left)` 无最小证据门槛。
- 最小词面证据只是必要条件，不是语义等价证明。
- 无法判断时返回 `partial` / `related` / `unknown`，保留理由。

**验收样例**：

| 输入 A | 输入 B | 期望 |
|---|---|---|
| 不建议使用 pnpm | 建议使用 pnpm | conflict（当前 partial） |
| 不再使用 nohup | 使用 nohup | conflict（当前 partial） |
| 本项目不允许直接推 main | 本项目允许直接推 main | conflict（当前 related） |
| 回复先给结论，3 个要点 | 回复先给结论 | partial（当前 conflict） |
| 长段落含"使用中文" | 无关短规则"使用中文" | related/partial，不是 covered |

### 6.2 批次 2B — 修正覆盖摘要

**工作**：

- 同时命中覆盖与冲突时，列表优先显示冲突。当前 `rank()` 把 `covered` 排在 `conflict` 前，`CoverageChip` 只取 `coverage[0]`。
- 必要时同时显示"存在覆盖"和"存在冲突"，避免用绿色"已覆盖"掩盖风险。
- 返回 `summaryRelation`，而不是让前端直接取 `coverage[0]`。
- coverage 继续作为派生信息，不因索引刷新改变队列 `decisionVersion`。
- 若后续审批依赖覆盖状态，另绑定 `analysisVersion` / `sourceHash`，不把缓存时间混入候选内容版本。

**验收**：

- 同时命中 exact 与 conflict 时，列表明确提示冲突。
- 来源、标题、行号、关系理由可追溯。
- 基线刷新不会无故导致候选编辑版本变化。

### 6.3 批次 2C — 区分失败、空、旧数据与未完整索引

**工作**：

- Queue 显式区分 `loading` / `ready` / `error` / `stale`。
- 首次加载失败不能显示"队列为空"（当前空态只判断 `loading` 与 `hasFilters`）。
- 已有列表刷新失败时保留内容，但标记旧数据并继续禁写。
- 提供原地重试，保留草稿、选择与筛选条件。
- 基线返回 `filesSeen`、`filesIndexed`、`filesSkipped`、`truncatedFiles`、`errors`、`builtAt`、`projectCoverageState`。
- 区分未配置、空基线、不可读、部分索引、过期。
- 目录读取失败、文件数上限（`MAX_FILES=200`）、文件大小截断（`MAX_READ_BYTES=256KB`）都必须显式记录。

**验收**：

- 首次 500、筛选失败、刷新失败均有准确文案和重试入口。
- 201 个文件、超大文件、权限错误、非法 JSON 均不冒充完整就绪。
- 项目基线没索引时明确说明："该项目基线未索引，未匹配不等于未覆盖。"

### 6.4 批次 2D — 拆开备份存在性、完整性与恢复能力

**工作**：

- `snapshotPresent`：是否发现快照。
- `integrity`：是否校验通过、部分、损坏或未知。
- `freshness`：是否过期。
- `restoreSupport`：自动、手动、不支持或未知。
- `restoreDrill`：最后演练时间、版本、结果。
- 不再通过脚本出现某个字符串判断恢复已验证（当前 `graph.ts:641-647`）。
- 不再硬编码 L0 可恢复（当前 `graph.ts:642`）。
- 最新目录半成品时，分别展示"最新快照"和"最近完整快照"（当前 `latestBackupDir` 仅按目录名倒序取第一项）。

**验收**：

- 空目录、1/5 覆盖、校验失败、过期快照分别准确呈现。
- 没有 manifest 或演练证据时显示未知，不显示已验证。
- OpenMem、L1、L2、逻辑链图分别表达恢复能力，不能互相代替。

---

## 7. 阶段 3：统一项目身份与请求上下文

**优先级：P1**

### 7.1 批次 3A — 先补最小安全表达，再完善多项目能力

**立即可做**：

- 共享 console 明确显示"共享数据目录／启动实例"，不把启动项目冒充每次请求的当前项目（`plugin.ts:871-887` 的 key 只有 `dataDir:port`）。
- 非当前实例的项目候选先标记 `project-unavailable`。
- 不根据 queue 里任意路径扫描其他项目目录。

**完整方案**：

- graph、map、baseline 接受明确的请求级项目身份（`projectKey`）。
- 项目选择仅来自已注册、获准访问的项目目录。
- 全局基线对项目候选单向可见；不因此放宽同级去重与合并的 `sameScopeAndProject` 隔离。
- 默认显示所选项目；"全部项目"必须显式进入。
- 全部项目视图带项目标签，不建立无解释的跨项目重复边。
- 事件缺失归属时标记 `unknown`，不静默归到启动实例（`plugin.ts:530-534` 缺字段时不拦截）。

### 7.2 批次 3B — 项目身份采用兼容适配，不直接迁移路径哈希

**工作**：

1. 实测安装宿主是否提供稳定 `project.id`。
2. 验证 `canonical` 在主目录、worktree、项目改名时的行为。
3. 支持稳定 ID 时优先使用；否则保留规范路径兼容方案。
4. 建立轻量项目注册表：`stableId`、`canonicalPath`、`legacyKeys`、`aliases`、`displayName`。
5. 旧 key 迁移必须 preview + 版本校验 + journal + undo。
6. 不用显示名生成项目身份（当前 legacy 用 `sha16(item.project)`），不用 git remote 直接合并不同仓库。

**L1 特别边界**：

- OpenChamber `projectId` 与 OpenCode `project.id` 分别适配。
- 没有可靠映射时，显示"宿主全部项目汇总"或"归属未知"，不能把聚合条数说成当前项目记忆（`graph.ts:374-401` 当前为聚合语义）。
- 项目发现接口不等于 L1 记忆读写接口。

### 7.3 批次 3C — 统一 dataDir 身份与诊断

**工作**：

- 插件、扩展、CLI 复用一致的解析规则或共享解析契约（当前三套：`plugin.ts:248-252`、`extension/src/service/main.ts:25-41`、`cli.ts:23-27`）。
- 暴露 `dataDirSource`、`storeId`、`formatVersion`，而不是只显示健康分。
- 只读诊断发现空目录时，不自动初始化出一套"健康空库"（当前 `Store.init()` 对任意目录 `mkdir` 并补齐空文件）。
- 旧 store 没有标识时采用兼容识别和明确提示；不突然强制迁移导致已有安装不可用。
- 扩展连接时核对 `storeId` 与上游构建身份。
- 面向 panel 默认不暴露不必要的绝对路径（`extension/src/service/main.ts:393-409` 当前返回绝对 dataDir）。

**验收**：

- A/B 同时共享 dataDir，B 能看到 B 的基线与图谱。
- A 的项目内容不进入 B 的工具结果和注入上下文。
- 主 checkout/worktree 的身份行为有实测证据。
- 错目录显示身份不明或错误，不显示"空队列且完全健康"。
- 身份迁移可预览、可撤销，不覆盖后续编辑。

---

## 8. 阶段 4：建立真正可验证的备份与恢复

**优先级：P1｜真实恢复另行授权**

### 8.1 批次 4A — 建立版本化备份清单

**manifest 建议包含**：

- `formatVersion`、`snapshotId`、`createdAt`
- `storeId`、软件版本、构建标识
- 来源域、项目身份及路径映射
- 文件相对路径、字节数、SHA256
- 必需 / 可重建 / 排除类别
- 快照完成状态与一致性取得方式

**覆盖分类**：

| 类别 | 内容 |
|---|---|
| 必须保护 | items、queue、state、hooks、reviews；merge/recovery/maintenance/curator/migration 相关记录；冷会话归档、技能草稿及有恢复价值的待处理状态 |
| 可重建 | `AUTO_MEMORY.md`、`AUTO_RULES.md` 等生成视图；明确可重算的缓存与派生统计 |
| 排除 | `console-token`、认证材料、日志及明确无恢复价值的缓存；`config` 中兼容旧版本的 token 字段做防御性脱敏 |

**重要**：不能在写入进行中随意复制多个 JSON 文件，然后仅凭 checksum 宣称快照一致。应通过现有锁、事务边界或受控导出取得一致快照。

### 8.2 批次 4B — 实现校验适配，而不是猜备份目录布局

**工作**：

- 核对真实备份脚本与 manifest 格式。
- live `memory.json` → backup `global.json` 作为正常映射处理。
- 自定义 dataDir 必须对应到同一个 `storeId` 的备份。
- roots 可配置（当前 `graph.ts:121-131` 写死 `~/Documents/Opencode project/记忆备份`、`~/.config/opencode`、`~/.config/openchamber`），但不得借配置扩大任意文件读取范围。
- 逻辑链图增加独立快照域，标记为派生资料，不提升其权威等级。
- 同步修正文档中的调度描述漂移；实际使用 launchd 还是 OpenChamber 以运行状态为准。

### 8.3 批次 4C — 先沙箱演练，再讨论真实恢复

**最低演练集合**：

| # | 场景 | 通过标准 |
|---|---|---|
| R1 | manifest、文件大小、checksum 与排除项检查 | 必备份类完整；cache/log/token 不在清单 |
| R2 | OpenMem 完整恢复 | queue、历史和撤销可用 |
| R3 | 冷会话恢复 | 扫描游标与固定上下文仍在 |
| R4 | L0/L2 恢复 | 基线能重新构建 |
| R5 | L1 global/project 恢复 | 保持正确归属，不覆盖新版本 |
| R6 | 逻辑链图快照 | 可校验、可读取 |
| R7 | 半成品、损坏、过期快照 | 被拒绝或准确标记 |
| R8 | 中断恢复 | 可重试，不重复触发外部副作用 |
| R9 | 恢复后生成视图 | 与权威数据一致 |

**边界**：

- 全部先在合成目录、临时 XDG/dataDir 中完成。
- 检验恢复结果时不得顺便触发真实采集或模型调用。
- 真实 L1 恢复仍要求退出 App/server，并在合适的外部终端执行。
- 沙箱跳过进程检查的选项不得用于真实目标。
- 外部备份脚本修改、真实备份读取与真实恢复单独授权。

**验收**：

- "恢复已验证"能指向具体演练、软件版本和快照。
- 备份不是仅有 `items.jsonl`（当前 `graph.ts:511-513` 只检查该文件）。
- 无凭证进入备份清单。
- 恢复不会使冷会话游标、待审批队列或撤销链静默丢失。

---

## 9. 阶段 5：性能、解释与操作闭环

**优先级：P1/P2**

### 9.1 批次 5A — 消除重复计算

**工作**：

- `graph/source` 走轻量来源目录，不重建整张图（当前 `readGraphSource` 调用 `buildMemoryGraph`）。
- 内部切换架构/记忆/路由/自动化/备份不重复拉整图（当前 `MemoryGraph.tsx` 的 load effect 依赖 `view`）。
- 隐藏 Queue 页面暂停无必要轮询，但保留草稿。
- baseline 增加 in-flight 请求合并、文件增量检查与版本失效（文档声称 mtime+size 增量，实际为 30s 全量重读）。
- 预计算归一化文本、指纹和 bigram 集合。
- 分组按 `scope/project/kind` 分桶，再生成候选对（当前 `graph.ts:791-819` 对前 500 条两两比较，最多 124,750 对）。
- 缓存依赖内容版本，不只依赖时间。
- 不为性能优化新增向量库或重写存储。

**基准**：

- 500 items、50 queue、较大 shadow。
- 201 个基线文件、超大文件、多个并发请求。
- 分别记录冷启动、暖缓存、来源详情及后台 IO。

**建议目标（待测，不是已测结果）**：

- 暖缓存 API p95 以 300ms 为初始目标，先测量再校准。
- 同一版本的 groups 只构建一次。
- 5 个并发 queue 请求只触发一次索引构建。
- 未变化文件不重复读正文。

### 9.2 批次 5B — 相似性与分组给出解释

**工作**：

- Map 不再把 Jaccard 高重合直接叫 `duplicate`（当前 `map.ts:89-97` 阈值 0.75）。
- 优先复用统一关系语义；否则明确叫"词面重合"。
- 展示关系理由、关键数值／极性差异、项目与类型。
- "字符 bigram 哈希投影"不再包装成语义词向量（当前 `MapView.tsx:189` 文案）。
- 边按合理 top-K／排序展示，不按遍历顺序提前截断（当前 `MAX_EDGES=300` 在双层循环中途停止，偏向排在前面的 items）。
- groups、edges、nodes 都返回总数、显示数、遗漏数（当前 groups 上限 50 静默截断）。
- inventory 与 groups 使用一致节点集合。
- 误报操作刷新 Map 自身，而不是重建无关图谱（当前 `onChanged=load` 重建 `/api/graph`）。

**验收**：

- 不同端口或相反极性不会显示成安全重复。
- 60 组只显示 50 组时明确告知截断。
- 后段 queue/shadow 不因 items 排在前面而悄悄消失。
- 标记误报后状态及时更新，失败明确可见。

### 9.3 批次 5C — 覆盖进入"辅助复核闭环"，不是自动决策

**工作**：

- 显示索引时间、错误、截断和手动刷新入口（当前 `POST /api/baseline/refresh` 存在但 console 无调用）。
- 提供"这不是覆盖／判断不准确"的反馈。
- 反馈只保存必要标识与关系元数据，避免复制正文。
- 冲突、分类不一致和证据不完整进入单条复核。
- 对 covered 项是否退出批量审批，作为明确策略选择；不能把当前 display-only 设计直接当成既有 bug（当前 `batch-policy.ts` 不读取 coverage）。
- 若采用该策略，预览和执行都绑定覆盖证据版本。
- 单条仍允许用户有记录地选择保留或创建。
- 不因 coverage 自动拒绝、删除或合并候选。

### 9.4 批次 5D — 补齐无障碍

**工作**：

- tabs 补 `tabpanel`、`aria-controls`、方向键和 roving tabindex（当前 `MemoryGraph.tsx:120-134`）。
- 点云提供列表替代或受控焦点，避免上千个 Tab 停靠点（当前每个 SVG 节点 `tabIndex={0}`，节点可至 1050 个）。
- 来源详情打开、关闭时管理焦点。
- 可滚动正文支持键盘操作（当前 `pre` 有 `max-height` 但不可聚焦）。
- 错误与状态变化使用适当的 `alert` / `live` 语义。

**验收**：

- 全键盘完成筛选、选中、查看来源与返回。
- 大量节点下 Tab 路径仍可控。
- 静态断言、浏览器交互和真实屏幕阅读器分别记录；不把自动化检查冒充完整 WCAG 认证。

---

## 10. 阶段 6：受控整理与真实改写

**优先级：后置、独立 opt-in**

### 10.1 三者必须区分

| 形态 | 含义 | 风险承诺 |
|---|---|---|
| 采集与建议生成 | 已有行为 | 已存在，不等于已自动写入 |
| 用户确认后的真实修改 | 单条审批 | 必须可预览、可撤销 |
| 无人值守语义改写 | 无需点击即写入 | 独立开关、默认关闭 |

三者不是同一个开关，也不应共享同一风险承诺。`rewrite.enabled` 只表示"生成建议"，不是"自动应用"。

### 10.2 批次 6A — 先做只读整理计划

每份计划包含：

- 涉及条目、来源域、scope/project。
- `beforeVersion`、目标版本与关系证据。
- 拟保留、拟修改、拟归档内容及理由。
- 风险、预期结果、撤销路径。

不写入、不合并、不删除。

### 10.3 批次 6B — 人工确认后，复用既有应用与撤销机制

**工作**：

- 分组操作复用现有 apply/merge/undo，不另建合并引擎。
- 提交前重新校验版本、范围、关系与改写结果。
- 进入同一事务与现有 journal。
- 冲突或版本变化时要求重新生成计划。
- 撤销发现后续编辑时拒绝覆盖，并展示差异。

**初期范围**：

- OpenMem 自己管理的数据。
- 明确项目内的 fact/preference。
- 规则、全局扩张、跨来源合并继续单条处理。
- L0/L2/L1 不纳入自动改写。

### 10.4 批次 6C — 无人值守语义改写本轮不建议开放

后续若确实需要：

1. 设置独立 `autoApply` 开关，默认关闭。
2. 先只记录"本应执行"的 shadow 结果。
3. 人工抽样、合成并发和中断测试通过后，才逐项目灰度。
4. 配置预算、熔断、运行时关闭与完整审计。
5. 语义冲突、规则、跨项目、未知 kind 不自动处理。
6. 不把模型 confidence 当安全证明。
7. 存在安全疑点时保留两条，不自动选择真相。

**必要指标**：applied / blocked / validationFailure；conflict、undo、版本冲突与异常率；按项目统计，但不记录不必要正文。

### 10.5 批次 6D — L1 写回是独立宿主项目

当前 SDK 声明没有公开可依赖的 memory CAS/批事务接口（`host.d.ts:100-101` 仅通用 `request`/`serviceRequest`）。

单条编辑至少需要：

- 稳定 `memoryId` 与项目身份。
- 服务端强制的 `expectedVersion` / ETag 类前置条件。
- 可定位的修改结果与冲突响应。

跨条目合并还需要：

- 原子批事务，或宿主支持的一致性操作。
- 不能"先改 A 再删 B"，然后假定本地 journal 能保证宿主原子性。

**能力未确认前**：L1 保持只读或输出人工操作计划；不直接写 `memory.json`；不承诺 L1 自动改写的交付日期。

---

## 11. 阶段 7：可选 Stage C 语义提示

**优先级：P2｜默认关闭**

先解决确定性缺陷，再做语义增强。

### 11.1 方案分层

1. **本地标题／段落提示**：无新增模型调用，只帮助用户定位相关来源。
2. **标题级模型提示**：只能叫"主题相关提示"，不能叫语义覆盖验证。
3. **片段级语义复核**：明确 opt-in，发送前可检查实际 payload。

### 11.2 片段模式要求

- 仅发送判断所需的最小完整语句。
- 不机械截断到 120 字而切掉否定或适用条件。
- 不发送整个 L0、完整记忆、绝对路径或无关上下文。
- 脱敏、端点限制、缓存、总预算和功能子预算。
- 支持关闭、超时降级、熔断。
- 不改变已批准的 provider/model。
- 复用请求不代表零成本：仍需统计 token 与缓存变化。
- 模型结论只辅助复核，不自动拒绝、合并或晋升。

### 11.3 评估

- 建立人工标注的中文正例、反例、近义与冲突集。
- 分开统计相关召回、覆盖误报、冲突漏报。
- 先评估再开放，不能靠"接入成功"验收。
- 未启用时新增语义调用为 0。

**注**：现有 System One 在开启时已向 `ollama.com` 发送候选与最多 3 个邻居的标题+正文（trim 240），共享 30 次/小时预算。Stage C 若另开调用会翻倍成本与隐私面，因此优先复用而不是新增。

---

## 12. 阶段 8：构建、安装与运行版本一致

**优先级：P1｜发布另行授权**

### 12.1 工作

1. 构建生成 `build-info`：`version`、`gitSha`、`dirty`、源码内容摘要、SDK 版本、`builtAt`、产物摘要。
2. `dirty` 工作树不能仅靠 `gitSha` 标识，否则不同未提交内容仍显示同一版本。
3. `health` / `meta` 展示兼容且不含凭证的运行身份（当前 `/api/health` 硬编码 `"0.3.0"`，扩展服务硬编码 `"0.1.0"`）。
4. 明确 plugin、console、extension 的版本兼容矩阵；不要求独立版本号必须相同。
5. 验证导出的 dist 入口（`plugin/package.json` 只有 `exports: ./dist/index.js`）与 console 静态资源路径（`bundledConsoleDir()` 依赖 monorepo `../../console/dist`）。
6. 按现有本地分发方式测试真实产物，不只测试 workspace 源码。
7. 若使用 tar/zip 分发，校验文件清单和 SHA256。
8. 在隔离环境完成安装产物冒烟（官方文档强调测试 installed package，而非 workspace linked copy）。
9. 线上同步前，再核对真实安装目录与运行实例。
10. 保留上一份已验收产物，用于软件回滚；不依赖"以后从源码重新构建"重现旧版本。

### 12.2 授权边界

- 不自动改 `private` 标志、不自动发布 npm。
- 不自动升级 SDK。
- 不覆盖当前安装目录。
- 不重启用户真实 App/server。
- 安装、重载、上线与软件回滚分别明确目标和授权。

### 12.3 验收

- 能回答"当前运行的是哪份源码和哪份产物"。
- 过期 dist、错配 console、错 dataDir 可被检测。
- 安装产物可独立加载，不隐含依赖开发目录布局。
- 线上回滚不需要覆盖真实记忆。

---

## 13. 统一验证与放行门槛

### 13.1 每个小批次

- 先补能失败的回归用例，再做最小修复。
- 跑对应单测和类型检查。
- 不夹带重构、依赖升级或真实数据迁移。

### 13.2 阶段完成

- 运行 `npm run verify`。
- 记录实际文件数、用例数、退出码和构建身份。
- API、组件结构、浏览器交互分别保存证据。

### 13.3 必须覆盖的场景

- 数字／端口／版本／日期／否定极性冲突。
- 短文本误覆盖、标题命中、kind 未知。
- 两项目共享 dataDir、外项目 ID、事件归属未知。
- 首次失败、旧数据、筛选失败、原地重试。
- 非法 JSON、权限错误、201 文件、超大文件。
- 500 条规模、并发索引、分组截断。
- 无效建议、过期目标、旧预览、重复提交。
- 迁移及应用每个关键持久化边界中断。
- 备份完整性、冷会话续接、撤销与恢复。
- 键盘焦点和来源详情交互。

### 13.4 条件性验证

- 同机长事务锁已有存活进程保护，应先验证现有机制。
- 跨主机共享目录、异常锁 owner、锁回收竞态另作专项。
- 不未经验证就重写锁系统。

### 13.5 放行分层

| 门槛 | 通过后才允许 |
|---|---|
| G1 | 安全入口与确定性判断通过，才允许讨论代码安装 |
| G2 | 项目身份、状态和安装产物通过，才允许受控运行 |
| G3 | 完整备份与沙箱恢复通过，才允许真实恢复 |
| G4 | 人工受控整理稳定，才讨论无人值守 |
| G5 | 宿主 CAS/事务契约确认，才讨论 L1 写回 |

---

## 14. 工作量、依赖与推荐第一批

### 14.1 估算口径

单人熟悉现有代码、包含测试和复核的工程人日；不是模型运行时长，也不包含等待宿主能力或真实环境窗口。

### 14.2 核心可靠性路线

| 阶段 | 工作量 |
|---|---|
| 工程基线与能力确认（阶段 0） | 0.5–1 人日 |
| 现有安全链路收口（阶段 1） | 6–10 人日 |
| 覆盖与状态可信（阶段 2） | 3–5 人日 |
| 项目身份与请求上下文（阶段 3） | 3–5 人日 |
| 备份与恢复演练（阶段 4） | 4–6 人日 |
| 性能、解释与无障碍（阶段 5） | 3–5 人日 |
| 产物验证与交付（阶段 8） | 2–4 人日 |

**合计约 22–36 人日**。共享测试与重复模块可复用，不能简单累加各路调查估算。

### 14.3 可选增量

| 项目 | 工作量 |
|---|---|
| 人工确认的分组整理闭环（阶段 6A/6B） | 约 2–4 人日 |
| 语义提示与评估（阶段 7） | 约 3–6 人日 |
| L1 写回（阶段 6D） | 宿主契约未明确，暂不估算承诺 |

### 14.4 推荐第一批（仅此范围）

1. compact/curator 接入安全关系守卫。
2. 单条 apply 服务端补齐建议状态与验证检查。
3. 修正项目内频率词导致的 global 扩张。
4. agent 工具绑定项目／会话，拒绝 foreign ID。
5. scope migration 绑定预览并接入现有事务。
6. 每项对应回归测试与完整工程验证。

**第一批不做**：

- 新模型调用。
- 自动合并或自动恢复。
- 真实身份迁移。
- 线上安装同步。
- UI 大改或存储重构。

完成第一批后，以真实验证结果决定第二批；不因计划写完就默认授权后续阶段。

---

## 15. 附：关键证据索引

| 主题 | 位置 |
|---|---|
| 地图节点正文泄漏修复 | `plugin/src/map.ts:74-95` |
| 关系判断 | `plugin/src/relations.ts:69-167` |
| 基线索引与匹配 | `plugin/src/baseline.ts:65-180` |
| 基线测试（仅 2 用例） | `plugin/test/baseline.test.ts:17-100` |
| 图谱来源与备份 | `plugin/src/graph.ts:121-131`、`:469-531`、`:625-654`、`:960-993` |
| 图谱测试（仅 1 用例） | `plugin/test/graph.test.ts:34-165` |
| 旧去重路径 | `plugin/src/compact.ts:54`、`plugin/src/memory/curator.ts:126` |
| 单条 apply | `plugin/src/apply.ts:55-73` |
| 批量策略（有 validation 检查） | `plugin/src/batch-policy.ts:37` |
| agent 工具 | `plugin/src/plugin.ts:714-771` |
| 队列决策 | `plugin/src/actions.ts:233-254`、`:256-328` |
| 迁移 | `plugin/src/memory/migrate.ts:101-127` |
| 作用域分类 | `plugin/src/memory/scope.ts:8-47` |
| 复核 scope 校验缺口 | `plugin/src/review/parse.ts:54-59`、`plugin/src/review/validate.ts:56-126` |
| 文件锁 | `plugin/src/util/lock.ts:31-89` |
| 事务/WAL | `plugin/src/util/transaction.ts:31-101`、`plugin/src/store.ts:203-239` |
| 控制台服务与共享 key | `plugin/src/server.ts:1317-1323`、`plugin/src/plugin.ts:871-887` |
| 扩展 dataDir/版本 | `extension/src/service/main.ts:17-41`、`:393-409` |
| 全局恢复规则 | `~/.config/opencode/memory/MEMORY_ARCHITECTURE.md:84-109` |
| 备份 skill | `~/.config/opencode/skills/backup-memory/SKILL.md` |

---

## 16. 附：本轮未做与未验证

- 未修改任何文件（本文件除外）。
- 未运行 `npm run verify`、测试、类型检查、构建。
- 未启动服务、浏览器或 Playwright。
- 未读取真实记忆正文、真实 config、token 或外部备份目录。
- 未执行恢复、清理、迁移、安装、发布、提交。
- 未验证真实 500 条规模性能、真实屏幕阅读器、真实模型语义准确率。
- 未验证真实断电、硬件故障、ENOSPC、长期 soak、远程 CI。
- 未验证线上安装目录的 `src`/`dist` 一致性。

**任何后续实施都必须以当时真实运行的验证结果为准，不得引用本文件中的历史数字或推断结论作为通过证据。**

---

## 17. 第一批实施记录（2026-11-06）

已按 14.4 的范围实施，未进入阶段 2–8：

| 第一批项 | 实施结果 |
|---|---|
| compact/curator 安全关系守卫 | 只对 `isExactRelation` 的同 kind 完全重复归档；端口、版本、否定差异不再因 SimHash/0.92 相似度被合并 |
| 单条 apply 服务端校验 | 未就绪/未通过校验的建议被拒绝；人工编辑走 `humanEdited` 独立记录；写入前重跑 `validateRewrite`，补否定/限定条件保留 |
| 项目内频率词 global 扩张 | 显式跨项目措辞优先，项目证据次之，频率词最后；review 模型 scope 经确定性钳制，project 无 projectKey 时降级 session note |
| agent 工具项目/会话绑定 | `review`/`suggest`/`decide` 只触达调用方 projectKey/session；外项目 ID 返回明确错误；`status`/`audit` 只输出可见范围 |
| scope migration 预览绑定 | 预览返回 `previewID`，apply 只执行预览集合、逐行校验版本；backup/journal/queue patch 同一事务；undo 写 undone 标记 |
| 复核后补修 | `exact` 只认规范化同文；否定/限定按标记集合比较；`keep_both` 保留候选；跨 kind 不提供合并；UI 正文编辑门槛与状态展示；scope 习惯词/`always|never` 在项目证据下留在项目；review global 只由用户原话证据升级；session 按 sessionID 隔离；`console_url` 不由模型触发浏览器 |
| 回归与工程验证 | `npm run verify` exit 0；59 文件 / 739 用例；三端 typecheck、两端 build、extension bundle/proxy、diff whitespace 全通过 |

**本批未做（留待后续批次）**：approve 与 consolidate 自动写入的冲突守卫、关系判断的“新增数字不等于冲突”细化、阶段 2–8 的覆盖/备份/性能/产物项、真实 store 恢复演练、安装目录同步与发布。真实数据、真实模型、真实断电与远程 CI 仍未验证。

**第二批计划**：见 `BATCH-2-PLAN.md`（基线 v0.4.0 @ `d2eed5d`；覆盖与状态可信、写入一致性、备份状态、UX/可访问性）。
