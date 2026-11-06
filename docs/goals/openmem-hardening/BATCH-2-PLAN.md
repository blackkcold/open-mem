# OpenMem 第二批计划：覆盖与状态可信

版本：v1.0（落版）
状态：**计划已落版，未授权实施**
日期：2026-11-06
基线：`release/v0.4.0` @ `d2eed5d`（工作树 clean）
目标版本：v0.5.0（建议，发布另行授权）
关联：`NEXT-PLAN.md` §5.2、§6、§14；`PROGRESS.md`；`docs/ARCHITECTURE.md`；`docs/BASELINE-COVERAGE.md`

---

## 0. 结论先行

> **推荐第二批：先修“关系判断”，再用同一套关系语义收口 approve / consolidate / promote，随后修覆盖摘要、队列与基线状态、备份状态、UX 与可访问性。**
>
> 不进入阶段 3（项目身份迁移）、阶段 4（真实恢复）、阶段 6（无人值守改写）、阶段 7（Stage C 语义模型）或阶段 8（安装/发布）。

v0.4.0 已关闭第一批的写入入口、项目可见性和迁移预览问题。第二批的首要目标不再是“再加一层校验”，而是让**用户看到的“已覆盖/相关/冲突/备份可用/加载完成”都有可追溯证据**，并让剩余的人工写入路径使用同一套确定性关系守卫。

推荐先手（P0，约 4–6 人日）：

1. **2A** 关系判断：区分“同一信息槽位的值替换”和“新增补充信息”，把否定/限定按子句对象比较。
2. **2E** 写入一致性：approve、consolidate 自动写入、promote 复用同一守卫；冲突需要显式确认并记录。
3. **2B** 覆盖摘要：冲突优先于覆盖；返回 `summaryRelation`；覆盖不进入 `decisionVersion`。

随后（P1，约 2.5–4 人日）：

4. **2C** 队列状态与基线元数据：`loading/ready/error/stale`，首次失败不显示“空队列”，部分索引不冒充完整就绪。
5. **2D** 备份状态：拆开“快照存在 / 完整性 / 新鲜度 / 恢复能力 / 演练证据”，没有 manifest 就显示未知。
6. **2F** UX、可访问性与完整门禁：冲突优先的视觉层级、重试焦点、状态播报、键盘与窄屏验收。

**本批不做**：新模型调用、自动合并/自动恢复、真实数据迁移、L1 写回、安装目录同步、发布。**不把“计划写完”当成实施授权。**

---

## 1. 基线与证据边界

### 1.1 本轮基线

| 项目 | 值 |
|---|---|
| 分支 | `release/v0.4.0` |
| 提交 | `d2eed5d release: v0.4.0 — memory graph, baseline coverage, safer approvals` |
| 工作树 | clean（规划开始时） |
| 基线门禁 | `npm run verify` exit 0；**59 文件 / 739 用例**；日志 `tmp/next-batch-baseline-verify.log` |
| 第一批 | `NEXT-PLAN.md` §14.4 已实施；见 `PROGRESS.md` 与 v0.4.0 提交 |
| 目标版本 | v0.5.0（建议；版本号与发布另由用户确认） |

> 本计划落版后，工作树会出现 `M docs/goals/openmem-hardening/NEXT-PLAN.md` 与 `?? docs/goals/openmem-hardening/BATCH-2-PLAN.md`；这是文档变更，不是代码变更。`plugin/`、`console/`、`extension/` 仍保持 v0.4.0 基线。

### 1.2 本轮做了什么

- 只读核对当前源码、测试与 v0.4.0 提交，不修改代码。
- 2 路 `explore` 只读调查均已返回：① 覆盖/关系/基线/队列状态；② 备份状态与 approve/consolidate 写入路径。两路均用 `release/v0.4.0` 当前源码行号校准，未运行 vitest/build。
- 主会话独立核对计划、文档、发布提交与现有测试边界。
- 调查结果用于校准本计划；如与主会话判断冲突，以当时源码为准。下面 §12.1 的证据表只列已读到的源码事实，不把推断写成已确认。
- 本轮**没有**运行新增模型调用、真实 store、真实备份、安装或浏览器操作；基线 `verify` 是唯一执行的门禁。

### 1.3 证据分级

| 级别 | 含义 | 本计划用法 |
|---|---|---|
| 已确认（observed） | 主会话或只读调查实际读过源码/测试 | 可直接作为实施依据 |
| 条件性（inferred） | 代码路径成立，但触发取决于配置/数据/环境 | 必须写触发条件，不写成确定故障 |
| 未知（unknown） | 未读取真实数据、未实测宿主/浏览器 | 必须标“未知”，不得用流畅表述掩盖 |

历史测试数字只作为 v0.4.0 基线，不作为本批实施的通过证据；实施开始时必须重新运行 `npm run verify`。

---

## 2. 为什么是这批

### 2.1 第一批已关闭的

- compact/curator 只对规范化同文归档；端口、版本、否定、预发布版本差异不会被 0.92 相似度静默合并。
- 单条 apply 要求 ready + `validation.ok`；人工正文编辑独立记录；标题编辑不能绕过；`keep_both` 保留候选。
- agent 工具的 review/suggest/decide 按调用方 project/session 收窄；console ticket 不再返回模型。
- scope migration 预览绑定 `previewID`，backup/journal/queue patch 同一事务。
- review scope 由确定性证据钳制；session 行按 sessionID 隔离。

### 2.2 仍然存在的用户可见风险

| # | 风险 | 当前表现 | 本批对应 |
|---|---|---|---|
| 1 | 关系判断把“新增一个数字”判成冲突，且没有槽位级证据区分“同一槽位换值”与“新增补充信息” | 覆盖摘要、提升、审计和自动维护都会受影响 | 2A |
| 2 | approve 与 consolidate 自动写入没有统一的确定性关系守卫 | 人工确认可以绕过 conflict/classification 检查；自动写入可能制造新的重复 | 2E |
| 3 | 覆盖摘要只取 `coverage[0]`，`covered` 排在 `conflict` 前，且 conflict 可能被 `limit=3` 截掉 | 同时存在覆盖和冲突时，列表可能显示绿色“已覆盖”；3 条覆盖可把冲突挤出响应 | 2B |
| 4 | 首次加载失败、刷新失败、部分基线都可能被读成“空/就绪” | 用户把“没有加载”当成“没有候选”，或把“未匹配”当成“未覆盖” | 2C |
| 5 | 备份视图主要检查文件存在，恢复能力靠脚本字符串匹配 | “备份可用/可恢复”可能没有 manifest 或演练证据 | 2D |
| 6 | 新增的确认/状态缺少统一 UX 与可访问性验收 | 功能正确但用户不知道冲突在哪、为什么不能写、如何重试 | 2F |

### 2.3 本批不解决

- 真实断电、硬件故障、ENOSPC、长期 soak。
- 真实 L1 写回、宿主 CAS/批事务。
- 自动合并、无人值守改写、自动恢复。
- 安装产物与线上运行实例一致性。
- Stage C 语义模型与任何新增模型调用。

这些分别属于阶段 3–8 或独立宿主项目，不在本批承诺。

---

## 3. 范围、裁决与不做事项

### 3.1 范围

1. 2A 关系判断的确定性语义。
2. 2E approve / consolidate / promote 的统一写入守卫与人工确认记录。
3. 2B 覆盖摘要、排序、分析版本绑定。
4. 2C 队列状态机、基线元数据、部分索引与失败文案。
5. 2D 备份快照的存在性、完整性、新鲜度、恢复能力与演练证据。
6. 2F 对应 UX、可访问性、浏览器验收与完整门禁。

### 3.2 裁决（默认按此执行；实施前如无异议不另行询问）

| # | 裁决 | 代价/边界 |
|---|---|---|
| R1 | `exact` 只认规范化同文；高分相似降为 `partial`，由人工决定 | 部分安全合并会进入队列，不自动消失 |
| R2 | 覆盖摘要冲突优先；绿色“已覆盖”不得掩盖冲突 | 列表可能同时显示“存在冲突”和“存在覆盖” |
| R3 | approve 的 exact/covered/classification-mismatch 直接拒绝；conflict 必须显式确认并记录关系版本 | 用户多一步确认；不会把冲突伪装成无风险 |
| R4 | consolidate 自动写入遇到 conflict/classification-mismatch 一律转队列；partial/related 仅在模型 duplicate < 0.20 时自动写 | 自动写入量下降，换取不制造新重复 |
| R5 | 没有 manifest 或演练证据时，备份完整性/恢复能力显示“未知”，不显示“已验证” | 备份视图会更保守，但不冒充恢复能力 |
| R6 | 本批覆盖仍为只读建议，不自动拒绝/合并/批量排除候选；只加 `analysisVersion` 供后续绑定 | 覆盖不改变 `decisionVersion`，不阻断人工审批 |
| R7 | 实施从 `release/v0.4.0` 切出特性分支（建议 `feat/coverage-trust`），不直接改 release 分支；发布另行授权 | 分支名与目标版本由用户最终确认 |

### 3.3 不做事项

- 不新增模型调用；不把模型 confidence 当安全证明。
- 不自动合并、自动拒绝、自动恢复或自动改写 L0/L2/L1。
- 不重写存储、队列 CAS、WAL、保留或撤销机制。
- 不读取/修改真实记忆、真实 config、真实 token、真实备份目录。
- 不安装、不发布、不覆盖安装目录、不重启真实 App/server。
- 不做全站 UI 改版；沿用现有控制台设计 token、组件与版式。
- 不把 `confirmedByUser`、本地 token 或确认勾选当成人类身份认证。

---

## 4. 2A — 关系判断：从“词面相似”到“可解释的关系”

**优先级：P0｜估算：2–3 人日｜依赖：无｜被 2B、2E 依赖**

### 4.1 现状与缺口

当前 `plugin/src/relations.ts` 已经区分 `exact / classification-mismatch / conflict / covered / partial / related / unknown`，并保护端口、版本、日期和否定词。v0.4.0 已修复否定词表（`不建议/不支持/不再/不允许` 均已是 `conflict`），**2A 不应重复扩词表**，真正要补的是：

1. `identifierMismatch = added > 0 || missing > 0` 把“候选新增一个数字”也判成冲突。例：`回复先给结论，3 个要点` 对 `回复先给结论`。
2. 否定只按“是否出现否定词/标记集合”比较，没有按子句对象比较。`不要使用 nohup` 对 `禁止使用 force push` 可能都含否定而漏判对象丢失。关系层不必把两个不同禁令都判 `conflict`（它们可以并存），但必须暴露否定子句对象，让 rewrite 校验发现合并输出丢失了哪一条。
3. `candidateCovered = right.includes(left)` 没有最小证据门槛；长段落包含一个短规则时可能误判 `covered`。短候选 `使用中文` 对长段落、甚至对反义长段落都会被判 `covered`。
4. kind 已知且不同时，`identifier` 冲突分支没有先返回 `classification-mismatch`；`baseline.ts` 从不传 kind/heading；`consolidate.ts:184-187` 的 exact 预检也只传 `{ text }`，同文本不同 kind 会被当成 `already known` 静默丢弃。

### 4.2 工作

#### 4.2.1 信息槽位（identifier slots）

- 为每个数字/端口/版本/日期/路径/URL/ID 提取局部上下文：前 2–3 个 token、后 2–4 个 token，形成 `identifierSlots`。
- 判定顺序：
  1. 两侧都有同一槽位且值不同 → `conflict`（端口、版本、日期、数量替换）。
  2. 候选有新增槽位、但 entry 没有对应槽位 → `partial`（补充信息，不自动冲突）。
  3. entry 有、候选没有对应槽位、候选也没有替换值 → `partial` 或 `covered`（按包含证据决定），不直接 `conflict`。
  4. 槽位上下文不足（token < 2）→ 保留 `unknown`/`partial`，不猜。
- 预发布版本、构建号、日期区间必须作为完整标识提取；不要把 `1.2.3-beta` 截成 `1.2.3`。
- **不要用 `score` 作为 covered 门槛**：现有 `使用 nohup` covered 用例 score 仅约 0.18，而 `使用中文` 误覆盖仅约 0.15，区间重叠；用“子句边界 + 最小长度 + entry 多一个完整子句”更稳。

#### 4.2.2 否定子句与对象

- 按标点/连接词切子句；每个否定标记提取“标记 + 后续对象 token（最多 8 个）”。
- 判定：
  - 同一对象、极性相反 → `conflict`。
  - 一侧有否定子句，另一侧有同对象的肯定句 → `conflict`。
  - 否定对象不同（如 `不要 nohup` 对 `禁止 force push`）→ `partial`/`related`，保留理由；关系层允许并存，但 rewrite 校验必须拒绝丢失任一条的合并输出。
  - 两侧都有否定、对象不同且不是替换关系 → `partial`/`related`，保留理由。
- 词表继续覆盖 `不建议/不支持/不允许/不再/不要/不得/不能/不可/严禁/不准/禁用/请勿/切勿/无需/不用` 及英文 `never/must not/do not/avoid/no longer`。
- **不要把裸“不”加进 `NEGATION_RE`**：`不同/未来/不仅` 会被误报；子句对象比较才是本批要补的能力。
- 同步更新 `plugin/src/rewrite/validate.ts`：merge/replace 的否定校验从“标记集合”升级为“子句对象集合”。同一标记但对象不同（`不要 nohup` → `不要 screen`）也必须报丢失，不能因为都含“不要”就通过。

#### 4.2.3 标题、kind 与包含门槛

- `RelationEntry` 增加可选 `title?`；`topicScore` 同时使用标题与正文。标题相似只能作为相关证据，不能单独证明覆盖。`plugin/src/baseline.ts` 必须把 section heading 作为 `title`、把 section kind（若可得）传入，否则 2A 只改 `relations.ts` 不会让基线覆盖受益。
- `plugin/src/consolidate.ts` 的 exact 预检必须传 `kind`；否则同文本不同 kind 会被 `isExactRelation` 当成已确认重复，进不了队列。`plugin/src/baseline.ts` 同样要传 kind，才能报 `classification-mismatch`。
- kind 已知且不同：同文/高相似时返回 `classification-mismatch`；`identifier` 冲突分支也要先检查 `sameKind`。正文只是相关时保留 `partial/related`，并说明 kind 不同。
- `covered` 需要同时满足：候选规范化长度达到最小门槛（建议 CJK ≥ 6 字或 ≥ 3 个 ASCII token，并用现有 `使用 nohup`/`回复先给结论` covered 用例校准）、候选是 entry 的完整词面子集、entry 至少比候选多一个完整子句；否则返回 `partial/related`。不要为了覆盖长段落而放宽到 4 字以下。
- 无法判断时返回 `unknown`，附 `reasons`，不强行给 `covered`。

### 4.3 验收样例

| 输入 A | 输入 B | 期望 |
|---|---|---|
| 回复先给结论，3 个要点 | 回复先给结论 | `partial`（新增补充信息，不是冲突） |
| 本地端口是 5198 | 本地端口是 5199 | `conflict`（同一槽位换值） |
| 不建议使用 pnpm | 建议使用 pnpm | `conflict`（同一对象极性相反） |
| 不再使用 nohup | 使用 nohup | `conflict` |
| 本项目不允许直接推 main | 本项目允许直接推 main | `conflict` |
| 不要使用 nohup | 禁止使用 force push | `partial/related`（两个不同禁令，不能合并；合并输出丢失任一条应拒绝） |
| 长段落含“使用中文” | 无关短规则“使用中文” | `related/partial`，不是 `covered` |
| 版本 1.2.3-beta | 版本 1.2.3-alpha | `conflict` |
| 标题“部署检查”相同、正文无关 | 标题“部署检查”相同、正文无关 | `related`，不是 `covered` |

### 4.4 测试与边界

- 扩展现有 `relations.test.ts`：槽位替换、新增数字、否定对象、标题、kind、包含门槛、预发布版本、日期区间。
- 扩展 `rewrite.test.ts`：同一否定标记、不同对象的合并输出必须拒绝；`不要 nohup` + `不要 screen` 输出只留一侧时不能通过。
- 现有 `使用 nohup` 与 `回复先给结论` 的 covered 用例必须保留；若 6 字门槛仍误伤，改用“子句边界 + entry 多一个完整子句”，不要把门槛降到 4 字。
- 回归所有消费者：compact、curator、consolidate、audit、health、baseline、graph、promotion、review accept、apply 写入前复核。
- 不改变 `exact` 的“规范化同文”定义；不把 `partial/related` 当自动归档依据。
- 不做语义模型；不新增网络调用。

---

## 5. 2E — 写入一致性：approve / consolidate / promote 共用守卫

**优先级：P0｜估算：1.5–2 人日｜依赖：2A**

### 5.1 现状与缺口

- `approve` 目前只做 lint、容量和目标文件写入；没有对同 scope/project 的 active items 与 pending queue 做确定性关系检查。它也不读 `found.suggestion`，不校验 `validation.ok`/`humanEdited`，写入时仍无条件 `manual: true`、`approvedBy: "user"`；本地 HTTP API 可以用 approve 绕过失败/待定的合并建议。
- `consolidate` 的自动写入依赖模型 JEV 与 `canAutoApply`；`isExactRelation` 只保护“完全相同”的早期跳过，且预检只传 `{ text }`，同文本不同 kind 会被当成 `already known` 静默丢弃。冲突/部分重合仍可能自动写入。
- `promote` 使用 `canPromote` 检查 active items，但不检查 pending queue；人工提升仍可能制造重复。
- 人工确认与自动操作没有共享同一个关系策略；UI 的覆盖提示与服务端写入判断没有绑定版本。`humanEdited`/`validation` 只覆盖 `apply_suggestion`，不能直接当 approve/consolidate 的关系门。

### 5.2 统一守卫

建议新增纯函数模块 `plugin/src/memory/write-guard.ts`：

```ts
interface WriteConflict {
  id: string;
  title: string;
  relation: RelationKind;
  score: number;
  reasons: string[];
  version: string; // itemContentVersion / queueItemSnapshotVersion
}

function findWriteConflicts(
  candidate: { text; title; kind; scope; projectKey?; source? },
  entries: Array<Item | QueueItem>,
  options: { excludeID?: string },
): WriteConflict[]
```

- 只比较同 scope/project 的条目；project 必须有相同 `projectKey`；候选无 projectKey 时 **fail closed**；session 不进入 approve/consolidate；跨项目不比较。
- 复用 `classifyRelation` + `sameScopeAndProject`；不新建第二套相似度。过滤 `archived`，排除候选自身。
- 结果按 `conflict > classification-mismatch > covered > exact > partial > related > unknown` 排序。
- 每条冲突带版本；确认时必须绑定当前版本，版本变化要求重新确认。
- `canPromote` 改为调用同一个 `findWriteConflicts`，保留 target tier/taskOnly/confirmedByUser 语义；避免 approve/promote/consolidate 三套策略漂移。

### 5.3 策略矩阵

| 路径 | exact / covered | classification-mismatch | conflict | partial / related |
|---|---|---|---|---|
| consolidate 自动写入 | 跳过（already known） | 转队列，不自动写 | 转队列，不自动写 | 仅当模型 `duplicate < 0.20` 时自动写；否则转队列 |
| approve（人工） | 拒绝，提示用拒绝/合并路径 | 拒绝，提示分类不一致 | 返回 409 + 冲突列表；显式确认后写入 | 允许写入 |
| promote（人工） | 拒绝（重复） | 拒绝（分类不一致） | 返回 409 + 冲突列表；显式确认后写入 | 允许提升 |
| apply create/keep_both（人工） | 结果附 warning，不阻断 | warning | warning + 可确认 | 允许 |
| apply merge/replace | 继续使用 targetVersion/scope/关系复核；不因其他条目重复而阻断 | 同上 | 同上 | 同上 |

`apply create/keep_both` 的 warning 只用于提示和审计，不阻断写入；changelog 记录关系 id/version，不复制正文。`apply merge/replace` 仍以目标版本、scope 和写入前 `validateRewrite` 为主，其他条目的关系不阻断，避免把“用户有意保留两条”误判成必须拒绝。

`deny` / `edit` / `defer` 不创建 active memory，不进入关系守卫；`edit` 仍受 lint、长度和现有版本校验约束。守卫只作用于会写入 active memory 的路径。

`approve` 若队列项已有 `suggestion`：必须拒绝并提示先处理建议，或要求显式 `ignoreSuggestion` 并记录；不能静默绕过 `validation.ok`/`humanEdited`。若 approve 带 `title`/`text` 且与队列原文不同，记录 `humanEdited` 与 diff，不把人工修改标成“模型验证通过”。

approve / promote 的确认列表只包含 `exact` / `covered` / `classification-mismatch` / `conflict`；`partial` / `related` 不弹窗，避免把正常补充信息变成审批噪音。exact/covered/classification-mismatch 仍直接拒绝，只有 conflict 进入显式确认。

### 5.4 API 与 UI

- `QueueDecision` 增加：
  ```ts
  acknowledgedRelations?: Array<{
    id: string;
    relation: RelationKind;
    version: string;
  }>;
  ```
- `server.ts` 的 `parseQueueDecision` 同步解析该字段；只接受字符串 id/relation/version，忽略未知字段。
- 缺确认时返回 409：
  ```json
  {
    "code": "RELATION_ACK_REQUIRED",
    "error": "存在需要确认的关系",
    "conflicts": [{ "id", "title", "relation", "reasons", "version" }]
  }
  ```
- 服务端重新计算冲突并逐条比较 `id + relation + version`；任一变化返回 409，不写入。
- UI 复用现有确认弹窗的焦点隔离与 Escape 取消（approve / promote 共用）：
  - 标题：“存在需要确认的关系”
  - 正文逐条显示：目标标题、关系、理由
  - 勾选：“我已核对以上关系，仍然写入”
  - 主按钮建议为“取消”；“仍然写入”为次要/危险样式
  - 确认后带 `acknowledgedRelations` 重试；队列版本变化则提示刷新
- journal/changelog 记录 `acknowledgedRelations`（只存 id/relation/version，不复制正文）。

### 5.5 验收

- approve 的 exact/covered/classification-mismatch 无确认被拒；conflict 无确认 409，有确认写入。
- approve 遇到已有 `suggestion` 时拒绝或要求显式 `ignoreSuggestion`；人工改标题/正文记录 `humanEdited` 与 diff。
- consolidate 的 conflict/classification-mismatch 不自动写；partial 高 duplicate 转队列；additive 仍可自动写；同文本不同 kind 不被 exact 预检静默丢弃。
- promote 对 pending queue 的重复/冲突同样生效；`canPromote` 与 approve/consolidate 使用同一守卫。
- 跨项目、跨 scope 不产生冲突；候选自身不与自己比较；archived 不参与。
- 确认版本变化后旧确认被拒；journal/changelog 能追溯确认内容。
- UI 键盘可完成“查看冲突 → 取消/仍然写入”，焦点回到触发按钮。

---

## 6. 2B — 覆盖摘要：冲突优先，覆盖可追溯

**优先级：P1｜估算：0.5–1 人日｜依赖：2A**

### 6.1 工作

- 服务端计算 `coverageSummary`：
  ```ts
  {
    relation: "conflict" | "classification-mismatch" | "covered" | "partial" | "related" | "unknown",
    conflictCount: number,
    coveredCount: number,
    total: number,
    analysisVersion: string
  }
  ```
- 排序：`conflict > classification-mismatch > covered > partial > related > unknown`；`exact` 在摘要中计入 `covered`，作为覆盖的一种展示，不压过冲突。
- **摘要必须在 `coverage` 数组 `slice(0, 3)` 之前用全量 matches 计算**；否则 3 条 covered/exact 会把 conflict 挤出响应，summary 也统计不到。
- 前端不再直接取 `coverage[0]`；使用 `summaryRelation` + 计数。
- 同时存在覆盖和冲突时，列表显示两个 chip：
  - “存在冲突 · N”（warning/error 语义，优先）
  - “存在覆盖 · N”（info/neutral 语义）
  - 不允许用单一绿色“已覆盖”掩盖冲突。
- 详情列出每条覆盖的 `source › heading:line`、关系、分数、理由；正文仍不返回。
- `analysisVersion` = 基线索引**内容**摘要（sourceId + bytes + updatedAt + section 内容哈希 + 上限参数），**不要只用 builtAt**：当前缓存 TTL 约 30 秒，builtAt 会抖动，UI 会不停提示“分析版本变化”。覆盖刷新不得改变队列 `decisionVersion`。
- 本批覆盖仍是 display-only；不自动拒绝、不自动合并、不排除批量候选。

### 6.2 验收

- 同时命中 exact 与 conflict 时，列表明确提示冲突。
- 只有 partial/related 时显示中性提示，不显示绿色“已覆盖”。
- 基线刷新后 `decisionVersion` 不变；`analysisVersion` 变化可见。
- 来源、标题、行号、关系理由可追溯；不返回基线正文。
- 覆盖为只读：不因覆盖自动 deny/merge/defer。

---

## 7. 2C — 队列状态与基线元数据：失败、空、旧数据、部分索引分开

**优先级：P1｜估算：1–1.5 人日｜依赖：2B**

### 7.1 队列状态机

建议在 console 侧新增纯函数 `queue-load.ts`，由 Queue 页面消费：

```ts
type QueueLoadState = "loading" | "ready" | "error" | "stale";
```

| 状态 | 触发 | 文案 | 写入 |
|---|---|---|---|
| loading | 首次加载/筛选请求中 | “正在加载队列…” | 禁用 |
| ready | 成功且无旧数据 | 正常列表；无筛选且无条目才显示“队列为空” | 允许 |
| error | 首次加载失败 | “队列加载失败。未显示为空；请重试。” | 禁用 |
| stale | 已有列表后刷新/筛选失败 | “显示的是上次成功加载的数据（时间）。刷新失败，写入已暂停。” | 禁用 |
| ready + filters + 0 | 筛选成功但无结果 | “没有匹配的候选” + 清除筛选 | 允许浏览 |

- 首次加载失败不得显示“队列为空”。当前 `Queue.tsx` 的空态只判 `loading` 与 `hasFilters`，500 时会同时出现错误横幅和“队列为空”，这是 2C 要修的首要 UX 缺陷。
- 刷新失败保留列表、详情、草稿、选择与筛选；不自动清空。当前 catch 保留 items 但无 `lastLoadedAt`/旧数据文案，用户不知道列表已过期。
- 筛选失败后 `filterPending` 不能永久停在 true；必须清除 pending、保留上次成功筛选、提供原地重试。
- 原地重试保留筛选/草稿/选择；重试按钮获得焦点；状态变化用 `aria-live` 播报。
- 批量操作在 `loading/error/stale` 下禁用；单条写入同样暂停。

### 7.2 基线元数据

`GET /api/baseline/status` 与 queue 响应增加：

```ts
{
  state: "unconfigured" | "empty" | "partial" | "stale" | "ready" | "error",
  filesSeen: number,
  filesIndexed: number,
  filesSkipped: number,
  truncatedFiles: number,
  errors: Array<{ path: string; reason: string }>,
  builtAt?: string,
  projectKey?: string,
  projectCoverageState: string,
  maxFiles: number,
  maxReadBytes: number
}
```

- 当前 `plugin/src/baseline.ts` 的 status 只有 `state/builtAt/sources/sections/errors`；`filesSeen/filesIndexed/filesSkipped/truncatedFiles/projectCoverageState` 不存在。`MAX_FILES=200`/`MAX_READ_BYTES=256KB` 在 `graph.ts`，达到上限时静默 `return`/`subarray`，目录 `readdir` 失败也静默。2C 必须把这些统计显式化，不能只在 UI 猜。
- 区分：未配置、空基线、不可读、部分索引（文件数上限/单文件截断/权限/非法 JSON）、过期、完整。当前 `sources==0` 统一 `unavailable`，无法区分“未配置/空目录/不可读”。
- Queue 顶部显示基线状态：
  - 未索引：“该项目基线未索引；未匹配不等于未覆盖。”
  - 部分：“基线仅索引 X/Y 个文件；未匹配不等于未覆盖。”
  - 过期：“基线索引已过期（builtAt）；覆盖判断可能不完整。”
  - 失败：“基线读取失败；覆盖判断不可用。”
- 201 个文件、超大文件、权限错误、非法 JSON 都必须显式记录，不冒充完整就绪。
- 基线正文不进入 API、日志或模型。

### 7.3 验收

- 首次 500、筛选失败、刷新失败都有准确文案与重试入口。
- 201 文件、超大文件、权限错误、非法 JSON 均不显示为完整就绪。
- 未索引项目明确显示“未匹配不等于未覆盖”。
- 重试后草稿、选择、筛选不丢失；键盘焦点可回到重试按钮。

---

## 8. 2D — 备份状态：存在性、完整性、新鲜度、恢复能力分开

**优先级：P1｜估算：1–1.5 人日｜依赖：2C**

### 8.1 数据形状

```ts
interface BackupSnapshotStatus {
  latest?: { dir: string; name: string; createdAt?: string; complete: boolean | "unknown" };
  latestComplete?: { dir: string; name: string; createdAt?: string };
  snapshotPresent: boolean;
  integrity: "verified" | "partial" | "corrupt" | "unknown";
  freshness: "fresh" | "stale" | "unknown";
  restoreSupport: "automatic" | "manual" | "none" | "unknown";
  restoreDrill?: {
    at: string;
    softwareVersion?: string;
    snapshotID?: string;
    result: "passed" | "failed";
  };
  coverage: { required: number; present: number; missing: string[] };
}
```

- 分别返回 **L0、L1、OpenMem、L2、逻辑链图五个域**；不能用一个域的“可恢复”代替另一个域。当前 graph 已有 L0 哨兵，不要删掉。
- 没有 manifest/校验和 → `integrity: "unknown"`，不显示“已验证”。
- `latestComplete` 的语义是“结构完整（manifest/布局未校验）”，不是“可恢复”；不要把它写成 `verified`。
- 最新目录半成品 → 同时展示“最新快照”和“最近结构完整快照”；没有完整快照就明确说明。
- 恢复能力只认实际演练证据；`automatic` 只能由已验证的自动恢复路径 + 演练记录产生。脚本里出现函数名/变量名最多算 `manual`/claim，不能算 `automatic`。
- 没有演练 → `restoreDrill` 缺省，文案“未演练/未知”。
- 不再通过脚本出现某个字符串判断“恢复已验证”；不再硬编码 L0 可恢复（当前 `graph.ts:642` 的 `l0: true` 要删除）。

### 8.2 验收

- 空目录、1/5 必需文件、零字节文件、校验失败、过期快照、半成品最新目录、无 manifest、manifest 校验通过分别准确呈现。
- 没有 manifest 或演练证据时显示未知，不显示已验证；L0 不得硬编码“自动”。
- 空 `project-memory`/`logic-chain` 目录、权限错误、不可读目录不能计入“已覆盖”或“缺失”而不说明。
- 最新目录半成品时，同时展示最新快照与最近结构完整快照；不能只按目录名排序。
- L0/L1/OpenMem/L2/逻辑链图分别表达；不互相代替。
- 只读展示；本批不执行真实备份或恢复。

---

## 9. 2F — UX、可访问性与完整门禁

**优先级：P1｜估算：0.5–1 人日｜依赖：2A–2D**

### 9.1 UX

- 覆盖 chip：冲突优先、覆盖次之；颜色不是唯一信号，文案与图标同时表达。
- 队列状态 banner：loading/error/stale/ready 四态清晰；stale 必须显示上次成功时间与“写入已暂停”。
- 基线状态 banner：未索引/部分/过期/失败四种文案，不把“未匹配”说成“未覆盖”。
- 备份状态：存在/完整性/新鲜度/恢复能力四组标签，未知就写未知。
- 冲突确认弹窗：列出目标、关系、理由；默认安全选项是取消；确认后焦点回到触发按钮。
- 不改变现有控制台视觉语言、间距、字号与设计 token；不做全站改版。

### 9.2 可访问性

- 状态变化使用 `role="status"` / `aria-live="polite"`；错误使用 `role="alert"`。
- 覆盖/冲突 chip 有可访问名称，不只靠颜色。
- 重试、取消、仍然写入均可键盘操作；Escape 取消；焦点陷阱与回焦复用现有 `confirm.tsx`。
- 备份与基线状态在屏幕阅读器下顺序合理；表格/卡片有标题。
- 390px 与 1280px 无页面横向溢出；主要触控目标 ≥ 44px。

### 9.3 验证

- 静态断言：状态文案、aria 属性、冲突优先顺序。
- 浏览器合成 fixture：首次失败、刷新失败、重试、冲突确认、覆盖+冲突并存、备份未知状态。
- 不把自动化检查冒充完整 WCAG 认证；真实屏幕阅读器仍标“未验证”。

---

## 10. 执行顺序、依赖与估算

### 10.1 推荐顺序

```text
2A 关系判断（P0）
  ↓
2E 写入守卫（P0，依赖 2A）
  ↓
2B 覆盖摘要（P1，依赖 2A）
  ↓
2C 队列/基线状态（P1，依赖 2B）
  ↓
2D 备份状态（P1，依赖 2C）
  ↓
2F UX/a11y/门禁（P1，依赖 2A–2D）
```

2D 与 2A/2E 没有共享代码，可在 2A 进行时并行；若单人串行执行，按上图放在 2C 之后。2D 的只读状态修复不依赖真实备份布局，**不要**为了“更确定”去猜 manifest 或修改 `rollback-memory.sh`。

### 10.2 估算

| 子批 | 内容 | 优先级 | 估算 |
|---|---|---|---|
| 2A | 关系判断语义、槽位、否定子句、标题/kind、包含门槛 | P0 | 2–3 人日 |
| 2E | 统一写入守卫、approve/consolidate/promote、确认 API/UI | P0 | 1.5–2 人日 |
| 2B | 覆盖摘要、冲突优先、analysisVersion | P1 | 0.5–1 人日 |
| 2C | 队列状态机、基线元数据、部分索引文案 | P1 | 1–1.5 人日 |
| 2D | 备份状态拆分、manifest/演练未知状态 | P1 | 1–1.5 人日 |
| 2F | UX、可访问性、浏览器验收、完整门禁 | P1 | 0.5–1 人日 |
| **合计** | 不含真实恢复/发布/长期 soak | | **约 7–10 人日** |

估算口径：熟悉现有代码、包含测试与复核的工程人日；不是模型运行时长，不包含等待宿主能力或真实环境窗口。

### 10.3 如果只能做一小批

推荐 2A + 2E + 2B：

- 先修关系语义，避免覆盖/冲突判断继续误导。
- 再用同一语义收口 approve/consolidate/promote，关闭人工写入绕过。
- 再让覆盖摘要冲突优先，用户不再被绿色“已覆盖”欺骗。

2C/2D/2F 顺延到下一小批，仍在本计划范围内。

---

## 11. 统一验证与放行门槛

### 11.1 每个子批

1. 先写能失败的回归用例（RED），再做最小修复（GREEN）。
2. 跑对应单测、类型检查；记录退出码和用例数。
3. 不夹带重构、依赖升级、真实数据迁移或 UI 全站改版。
4. 每个 API/UI 状态变化保留结构化证据（JSON、截图或静态断言）。

### 11.2 批量边界

- 2A + 2E 完成后跑一次 `npm run verify`。
- 2B + 2C 完成后跑一次 `npm run verify`。
- 2D + 2F 完成后跑完整 `npm run verify` + 浏览器合成 fixture。
- 最终记录：文件数、用例数、退出码、构建身份、已知限制。

### 11.3 必须覆盖的场景

- 端口/版本/日期/数量/预发布版本冲突；新增数字为补充；否定对象不同；标题命中但正文无关；长段落包含短规则。
- approve exact/covered/classification-mismatch 无确认拒绝；conflict 无确认 409、有确认写入、确认版本变化拒绝。
- consolidate 自动写入 conflict/classification-mismatch 转队列；partial 高 duplicate 转队列；additive 自动写。
- promote 对 active items 与 pending queue 的重复/冲突。
- 首次加载 500、筛选失败、刷新失败、重试保留草稿/筛选/选择。
- 201 文件、超大文件、权限错误、非法 JSON、基线过期/部分/未索引。
- 备份空目录、1/5 覆盖、零字节文件、校验失败、过期、半成品、无 manifest、演练缺失、L0 不得自动。
- 覆盖+冲突并存、覆盖刷新不改 decisionVersion、覆盖不自动决策。
- 键盘完成冲突确认与取消；状态 aria-live；390/1280 无横向溢出。

### 11.4 放行分层

| 门槛 | 本批能推进的部分 |
|---|---|
| G1 安全入口与确定性判断 | 2A + 2E 通过后才允许讨论受控运行 |
| G2 项目身份、状态与安装产物 | 2B/2C/2D 只推进“状态可信”，不完成项目身份与安装一致性 |
| G3 完整备份与沙箱恢复 | 本批只改展示；真实恢复仍另授权 |
| G4 人工受控整理 | 本批不进入无人值守 |
| G5 L1 写回 | 本批不做 |

**本批通过不等于 v0.5.0 可发布；发布、安装、真实恢复分别授权。**

---

## 12. 关键证据索引

> 行号以 `release/v0.4.0` @ `d2eed5d` 为基线；实施时以当时源码为准。

| 主题 | 位置 | 本批用途 |
|---|---|---|
| 关系判断与标识/否定 | `plugin/src/relations.ts` | 2A 主改动 |
| 覆盖匹配与关系 | `plugin/src/baseline.ts` | 2A/2B/2C |
| 队列 coverage 与 API | `plugin/src/server.ts` | 2B/2C |
| 审计/健康/图谱关系消费 | `plugin/src/audit.ts`、`health.ts`、`graph.ts` | 2A 回归 |
| 自动写入 | `plugin/src/consolidate.ts` | 2E |
| 人工审批/提升 | `plugin/src/actions.ts` | 2E |
| apply 写入前复核 | `plugin/src/apply.ts` | 2E 边界 |
| 队列 UI 状态/覆盖 chip | `console/src/pages/Queue.tsx`、`queue-triage.ts` | 2B/2C/2F |
| 备份图谱 UI | `console/src/pages/MemoryGraph.tsx`、`memory-graph.ts` | 2D/2F |
| 现有测试 | `plugin/test/relations.test.ts`、`baseline.test.ts`、`actions.test.ts`、`consolidate.test.ts`、`graph.test.ts`、`console-*.test.ts` | RED/GREEN 起点 |
| 质量与安全政策 | `docs/QUALITY.md`、`docs/ARCHITECTURE.md`、`docs/BASELINE-COVERAGE.md` | 验收口径 |

### 12.1 当前行为证据（只读核对）

| 观察 | 当前源码 | 影响 |
|---|---|---|
| 新增数字被判冲突 | `relations.ts:101-102,116`；分支 `:160-174` | 2A 首要修复；现有测试只断言“不是 covered” |
| 否定词表已修复 | `relations.ts:53-54`；`relations.test.ts:42-56` | 2A 不重复扩表 |
| 否定未按子句对象比较 | `relations.ts:103-105` | 2A 增加 `negationClauses` |
| 包含式 covered 无门槛 | `relations.ts:114,160-163` | 短规则 `使用中文` 对长段落/反义长段落也会 `covered` |
| kind 在 identifier 分支被绕过 | `relations.ts:172-174`；`baseline.ts:163-166` 不传 kind/title | 2A 补 `sameKind`；baseline 传 heading/kind |
| covered 排在 conflict 前 | `baseline.ts:182-199`；排序 `:177-179` | 2B 冲突优先 |
| 前端取 `coverage[0]` | `Queue.tsx:2167,2173`；详情 `:1889` | 2B 用 summary |
| `limit=3` 可能截掉 conflict | `baseline.ts:151,179`；`server.ts:297` | 2B summary 在 slice 前算 |
| 无 `summaryRelation`/`analysisVersion` | 全仓无匹配 | 2B 新增 |
| Queue 只有 loading/queueError，无 stale | `Queue.tsx:128-130,146` | 2C 状态机 |
| 首次 500 仍显示“队列为空” | `Queue.tsx:1679-1693`；catch `:298-302` | 2C 首要 UX 修复 |
| 基线 status 字段不足 | `baseline.ts:48-54`；`graph.ts:108-109,200,208,164-167,202-206`；`server.ts:304,868`；`Queue.tsx:130` | 2C 显式记录截断/跳过/错误 |
| 现有测试覆盖 | `relations.test.ts:42-56,83-89,91-98,100-119`；`baseline.test.ts:17-70,72-100`；`api.test.ts:214-222,224-233` | 2A/2B 的 RED 起点；缺口见 §4.4/§6.2/§7.3 |

> `docs/BASELINE-COVERAGE.md` 是设计记录，不是当前实现的规格；其中 `baseline` 配置块、`truncated:true`、Settings 基线块、secret 跳过等在当前代码中不存在。实施以源码和本计划验收为准，不按该文档补不存在的功能。

### 12.2 备份与写入路径证据（只读核对）

| 观察 | 当前源码 | 影响 |
|---|---|---|
| 每个备份域只查一个哨兵；OpenMem 只查 `items.jsonl` | `graph.ts:507-517`、`140-153`、`155-162` | 2D 需要 manifest/完整性状态 |
| L0 可恢复硬编码 `true` | `graph.ts:641-647`（`642`） | 2D 删除硬编码 |
| `latestBackupDir` 只按目录名倒序 | `graph.ts:900-911`（`903-908`） | 2D 增加 latest vs latest complete |
| snapshot 节点只要目录存在就 `ready` | `graph.ts:506`、`525-529`、`655-668`（`661`）、`727-739` | 2D 拆 `snapshotPresent`/`integrity` |
| 恢复能力由脚本文本匹配 | `graph.ts:638-647` | 2D 降级为 manual/claim；无演练不 automatic |
| console 头部取 `snapshot.status`、覆盖 X/5 | `MemoryGraph.tsx:537-594`（`547-549`、`553`、`556-561`、`582-584`）；架构来源 `:252` | 2D/2F 统一文案，未知就写未知 |
| approve 只 lint/容量/写入 | `actions.ts:256-328`（`260`、`267-278`、`288-289`、`313-316`）；`1-13` 未导入 relations；`listItems` 只在 `171` 的 promote | 2E 抽共享守卫 |
| approve 可绕过 suggestion 校验 | approve 分支不读 `found.suggestion`；`apply.ts:70-71`、`83-95`、`190`；`server.ts:1737-1759`；`Queue.tsx:2094-2111`；`plugin.ts:803-805` | 2E 拒绝或显式 `ignoreSuggestion` |
| consolidate exact 预检不传 kind | `consolidate.ts:184-187`、`191-193`；`relations.ts:94-96` | 2A/2E 传 kind，同文本不同 kind 进队列 |
| consolidate 自动写入只依赖模型分/lint/容量 | `consolidate.ts:298-338`、`761-795`（`783-786`）、`405-439`、`359-369`；`decision.ts:32-54`、`161-178` | 2E 事务内重查关系 |
| promote 有四向关系门但不查 pending queue | `promotion.ts:31`、`60-80`；`actions.ts:171-189`；`session-promotion.ts:75-78` | 2E 复用守卫并传 queue |
| baseline conflict chip 不是写入门 | `server.ts:297`；`Queue.tsx:1887-1895`；`baseline.ts:163` | 2E 的 409 与 UI 确认绑定 |

---

## 13. 未做与未验证

本轮规划未做：

- 未修改代码、未运行新增实验、未启动真实 console、未读取真实记忆/备份/token。
- 未验证真实 500 条规模、真实屏幕阅读器、真实模型语义准确率。
- 未验证真实断电、硬件故障、ENOSPC、长期 soak、远程 CI。
- 未验证线上安装目录与运行实例一致性。
- 未执行提交、发布、安装或真实恢复。

基线 `npm run verify` 只证明 v0.4.0 的工程门禁；实施开始后必须重新运行，不得引用本文件的数字作为新修改的通过证据。

---

## 14. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-11-06 | 第二批计划落版：2A/2E/2B/2C/2D/2F；基线 v0.4.0；未授权实施 |
