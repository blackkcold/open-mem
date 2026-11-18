# OpenMem 全自动记忆 · PLAN

Version: 1.0
Status: active（P00–P06 源码交付已接收；P07 报告落版；行为/宿主/UI/迁移未验证）
DESIGN: `DESIGN.md`
ACCEPTANCE: `ACCEPTANCE.md`
Progress: `PROGRESS.md`

## 1. 阶段顺序与依赖

```
P00 baseline ──> P01 reversible-memory ──> P03 autonomous-pipeline ──> P06 migration-verification ──> P07 final-review
                        │                          ▲
                        └──> P02 runtime-reliability ┘
                        └──> P04 recall
                        └──> P05 ux
```

硬依赖：

- P03 必须等 P01（变更账本/撤销/抑制）与 P02（预算/跨项目/空返回）完成。
- P05 必须等 P01 API + P02 状态字段 + P04 召回 API；P05 不能先造后端。
- P06 必须等 P03 + P05；P06 不修改产品语义，只做迁移/演练/验证。
- P07 必须等 P06 功能完成；P07 由主代理做整体源码/接口/UX方向验收并写最终报告，不设独立复核门。

## 2. 全局约束（所有阶段适用）

1. 只在当前 worktree 写代码；`workdir` 明确。
2. 不提交、不推送、不打 tag、不发版。
3. 不修改 `~/.config/opencode`、skills、agents、正式插件数据/配置。
4. 不读取/写入 `~/.config/opencode/memory/autopilot` 与正式仓库路径。
5. 测试只用 `mkdtemp` 或 `tmp/full-auto-memory/**`；原始日志写 `tmp/full-auto-memory/verification/`，不提交。
6. 不使用 `as any`、`@ts-ignore`、`@ts-expect-error`；不用 `any` 逃逸。
7. 不引入重依赖/服务/向量库；需要依赖时仅 `npm ci`，禁止 `npm update`/改 lockfile。
8. 不删除现有功能，不降低原测试断言；行为变化用默认关闭的配置分支。
9. 保留 WAL、事务、文件锁、target/version、安全守卫。
10. 不实际调用付费模型；测试用 fake/stub。
11. 每个新行为先写失败测试（TDD），再实现；测试名描述用户可见结果。
12. 每阶段结束更新 `PROGRESS.md`，把命令、退出码、日志路径、测试数写进证据。
13. 任何“完成/通过”声明必须有命令输出；没有输出就写“未验证”。
14. 文档与代码不一致时，先改文档决策，再改代码；不得悄悄偏离 DESIGN。
15. OpenCode API 一律查 V2 官方文档/SDK；不按 V1 形状猜。
16. 不声称 30 天真实运行；soak 必须标注 simulated。
17. 最终功能全量验收 ≠ 30 天现场运行；现场运行尚未执行，正式启用另行确认（见 DESIGN §1.4）。

### 2.1 方向裁决（2026-11-11，主代理 / UX 作者修订依据）

1. **生效时点**：停止使用/撤销成功后，下一次模型请求即排除错误记忆，含旧 session；已开始请求、已执行外部动作不可追回。
2. **时限**：随时可停止使用；版本回退默认保留 90 天（`undo.retainDays` 可配置建议）；旧 merge 的 24h 只约束 legacy，不能约束新统一撤销。
3. **erase 边界**：全机含备份彻底 erase 不在本轮必实现范围；不承诺云端删除；后台模型仍可出网。
4. **入口**：普通自动记忆零待审；legacy 审查入口放“设置 › 高级与维护”，不能活动页换“待确认”徽标继续催人工。
5. **冲突安全**：不得“仅恢复文本”覆盖后续正确编辑；版本安全逆转，否则停止使用。
6. **UI 稳定契约**：统一事件/版本/来源/可撤销 + 只读活动 API；不依赖聚合计数。
7. UX 报告 `reports/ux-contract.md` 由 UX 作者原 session 修订；P0 只引用，不修改该文件。方向冲突以 DESIGN §11 为准，不改变总目标。

### 2.2 执行决议（2026-11-12 用户纠偏，优先于历史实验计划）

**目标**：交付当前方案的产品功能，不是继续增加契约、测试设施或状态核对。

主线功能：

- **P03**：普通描述性记忆零日常审批的 hybrid 采集、复盘、自动写入、更新/纠错、停止后不重学、维护闭环；未知来源 fail-closed，不借此放宽写入门。
- **P04**：有界相关召回；撤销/停止后下一次模型请求不再注入。
- **P05**：正式“记忆 / 活动 / 设置”UI 与扩展；保持 360/rail 260–320/44px 和上下文注入体验。
- **P06**：容量、迁移回滚与必要集成验收；正式迁移/启用另批。
- **P07**：主代理整体源码/接口/UX方向验收 + 最终交付报告（不再要求独立全量复核）。
- P01/P02 已有代码保留；P03–P06 源码已交付但行为未验证，不得虚报为生产完成。

交付进度（源码已按此完成）：

1. P03-provenance PASS；extract/create、update/undo/global、maintenance/mode/status 源码已交付。
2. P04 有界召回与撤销下一请求源码已交付。
3. P05 正式 UI/扩展源码已交付。
4. P06 容量/迁移回滚/集成源码已交付；真实迁移/启用另批。
5. P07 报告已落版，待主代理读后完成 p7；行为/宿主/UI/迁移未验证，生产启用暂不建议。

停止与归档：

- 取消 sandbox / container / Linux materials / network / cleanup 契约研究；不再以隔离实验、独立契约或重复验证作为开发目标。
- 历史 failed/not-run 保留原样，不改 PASS；文档草稿不计功能进度；hybrid v4 停止候选不自动 v5，不恢复旧 A 第四轮。
- 真实 host 能力问题并入对应产品适配与最终集成，不再阻塞全部业务编码；未知来源仍 fail-closed。
- 剩余必要工程决策在对应代码模块最小落版，不另开独立契约工程/审查循环。

验证策略（2026-11-13 用户最新要求，替代旧执行门）：

- 不重复基线、不做专项评测、不设独立复核门；不层层等待评审。
- 仅改动后做必要编译/类型检查；不因文档、微调或重复 review 跑全量测试。
- 历史已跑 failed/not-run/pass 记录保留，不改写、不把未跑当 pass；ACCEPTANCE 的行为目标不降低，未实际验证项在最终报告如实注明。
- 用户闭环与可运行功能优先；不以文档数、测试数增长代替交付。

边界：无 commit/push/release；不动正式 config/真实 memory/原正式仓库；真实迁移启用另批。

## 3. 阶段清单

### P00 — baseline（完成）

产物：`phases/00-baseline.md`、`docs/goals/full-auto-memory/reports/00-baseline.md`、`tmp/full-auto-memory/verification/*.log`。

检查：

- [x] HEAD / 分支 / worktree 记录
- [x] Node/npm 版本记录
- [x] `npm ci`（plugin/console）退出码与日志
- [x] `npm run verify` 实际退出码、测试文件/用例数、构建结果
- [x] 工作树无源代码改动
- [x] 环境错误与代码失败区分（本次无失败）
- [x] 既有锁/PID、WAL、gate 现状只读核对
- [x] 不读真实数据、不跑模型、不改配置

### P01 — reversible-memory

产物：`plugin/src/changes.ts`、`plugin/src/memory/suppression.ts`、Store/context/API 改动、新测试、`phases/01` 证据。

检查：

- [ ] `ChangeEvent` 类型 + `changes.jsonl` + 事务内写入
- [ ] 自动写入（consolidate）先写 before/after 快照
- [ ] 所有路径（自动/人工/legacy undo/curator/session-note promotion/迁移）都写事件
- [ ] `ItemSnapshot = Item` 无损；恢复保留 identity/status/来源/派生
- [ ] `deactivateItem` / `reactivateItem` / `revertChange` / `restoreVersion` + version 冲突 409
- [ ] 停止使用随时可用；版本回退默认 90 天可配置；无“仅恢复文本”的覆盖
- [ ] 派生失效递归 + 环保护；上游无效时拒绝恢复
- [ ] 同源抑制（hook key + textHash；新消息可学）
- [ ] `memoryVersion` 含 nearest-expiry；无写入跨期失效；`refreshContext` 下一请求生效（含旧 session）
- [ ] 旧 `GET /api/items` 形状不变；新增 `/api/memory/items`、`/api/items/:id/changes`、四个 POST、`/api/changes`
- [ ] 撤销/恢复只能 token API，agent tool 不可调用
- [ ] WAL/崩溃重放覆盖撤销写
- [ ] 现有 gate/WAL/version 测试全绿

### P02 — runtime-reliability

产物：`review/provider.ts`、`review/orchestrator.ts`、`review/accept.ts`、`plugin.ts` status、server 状态字段、新测试。

检查：

- [ ] V2 `generate` 按 `{ prompt, model? } -> { text }`；优先 `experimental.generate.text`，不伪造 `maxOutputTokens`/`usage`
- [ ] `review.transport` 独立生效并默认 `ollama` 兼容旧配置；`opencode` 缺 API 明确失败，禁止跨 provider 隐式 fallback
- [ ] 429/408/425/5xx 的 `Retry-After` ≤30s 才等待重试 1 次；>30s（含 HTTP date）完整期限持久化延后，不得 clamp 后提前重发
- [ ] 空返回 `ReviewEmptyResponseError`，可 repair 一次
- [ ] run 预算与 request 预算分离；request 按实际派发计数，公式以 02-preflight 为准
- [ ] 预算不足/http-deferred 只延后：不置 failed、不加 attempts、不丢窗口、不重复 skipped/成功记录
- [ ] `recover()`/`schedule()`/`runNow()` 不跨项目；`accept()` 用 review 记录权威 `projectKey`，不用实例 key 覆盖
- [ ] capture hook 的 check+append 在同一事务内，跨进程并发不重复；差异/冲突候选保留
- [ ] `status` 只读 audit，不触发 `runAudit`；`auditAgeMs` 用真实 `auditRunAt`，缺失为 null；不伪造 automation/quarantine
- [ ] 所有失败 nonblocking，有 failed 记录与原因；现有 review 测试全绿，新增 fake 不发起真实网络

### P03 — autonomous-pipeline

产物：`plugin/src/automation.ts`、`memory/sources.ts`、`memory/supersede.ts`、`memory/quarantine.ts`、`memory/maintenance.ts`、`consolidate.ts` 分支、`curator.ts`、config/store/plugin/server、测试。
Preflight: `docs/goals/full-auto-memory/reports/03-preflight.md`（含合版裁决）。
**状态：P03-provenance 已 PASS；当前 p3-extract-delivery 未完成，源码 owner 继续定位多行 fact 真实入库链路。后续直接 update/undo/global → maintenance/mode/status → P04 → P05 → P06 → P07。**

检查：

- [ ] `automation.enabled=false` 时旧行为完全不变；legacy 配置/`autoRules=true` 不误启用
- [ ] 源过滤：`<context>`/`<skill_content>`/`<subagent …>`/`Session task state`/任务信封/引用表格/围栏-only/`parentID` 子会话不学；混排只剥合成段保留 genuine 片段
- [ ] benign 工作偏好祈使句 → preference（user quote、`grantsPermission=false`）；decision 用 fact+reviewType
- [ ] review 描述性候选可 auto，不以 `safeAuto=0` 硬挡；rule/skill/session 永不
- [ ] safety/permission/destructive/strict_limit 一律 legacy 人工
- [ ] 描述性冲突 → quarantine（TTL，不注入/不 queue/不提醒）；不制造普通人工待办
- [ ] 未证实数值/标识/否定差异不覆盖；**唯一目标+scope+逐字 A→B+CAS** 的狭缝 supersede 改写同一 item、旧值留历史可 undo；做不到则 `supersede_blocked`，不 append
- [ ] 同源抑制跨 turn/review（源身份键，不依赖 reviewID）；明确纠正可重新学习
- [ ] 自动写入/更新 = 事务 + `recordChange` + 视图重建；失败回滚
- [ ] 日写/日调用/会话写跨实例原子；容量 85%/95% 先按 policy 回收再复检，无冷数据如实 blocked
- [ ] 维护真实接线：启动+15min timer+容量事件，`claim`/`dispose`；读 API 只读
- [ ] 状态分开：`enabled/configuredMode/effectiveMode/blockedReason/retryAt/lastSuccess`；`shadow=true` 仍观察不写；`POST /api/automation/mode` 单事务原子设置
- [ ] curator 过期/精确去重写 change event；rule 不自动合并
- [ ] 不写 L0/skills/config；`autoRules` deprecated no-op
- [ ] 不新增调度服务/依赖；保留 WAL/事务/文件锁

### P04 — recall

Status: 预检与合版完成（2026-11-11）；**未实现**，等 P01 fix2 + P02/P03 验收后同 session 实施。

产物：`plugin/src/recall.ts`、V2 context hook 每请求附着、owned 块当次替换、API、tool 只读 action、测试。

检查：

- [ ] 默认 `recall?.enabled ?? automation?.enabled ?? false`：旧配置不意外召回；开 autonomous 默认动态召回；显式 false 才停
- [ ] 撤销/`invalidatedBy`/expiry/owned 替换不受召回开关影响
- [ ] 每个合格真实 prompt 在当次 V2 context hook 附着独立、有界 `SystemPart`；`messages` 只读
- [ ] 只取末尾连续 user 段真实文本；清洗 system-update/context/skill/task；短 command/synthetic 跳过
- [ ] 父会话三态：child 跳过、root 召回、unknown 跳过动态且不阻塞、不写记忆
- [ ] 工具迭代轮不重复堆 block；动态 part 幂等 ≤1；不写 transcript/contextBlock/entry
- [ ] 稳定小偏好 prefix 与动态 block 分离；20 轮只约束无变更 prefix
- [ ] 中文 bigram、标识符精确、数值冲突（共享上下文词）、否定相反不误召回；scope 严格 global+当前 project；score 仅排序非概率
- [ ] token 按整 item 行+headers/分隔符/余量；超预算整项跳过不截断；无 200 字符读取上限；无“至少 1 条”假保底
- [ ] owned 定位只认精确 metadata key/wrapper/自身完整 render/唯一 sentinel；不泛匹配 `## AUTOPILOT`；不按同事实删宿主 part
- [ ] 撤销校验只限 owned parts；用户聊天/L0/core/其他插件同事实逐字保留
- [ ] 无 metadata 且旧字面 `<context` 歧义时不猜边界，保守 degraded；不宣称下一请求保证
- [ ] 失败返回 degraded 空结果，不抛；API 200；hook nonblocking
- [ ] `/api/recall` 有 auth；projectKey 不一致 403；agent tool 只读、不接受 projectKey、受 visible 过滤
- [ ] 新增测试先失败后实现（TDD）；实施前对齐 `types.ts`（`recall?` 可选字段与 `automation`）并确认三份文档无冲突
- [ ] P06 真实 host 出站记录门禁：错误 owned 未排除即最终 blocked；fake host 不替代

### P05 — ux

产物：`console/src/pages/Memory.tsx`、`Activity.tsx`、纯逻辑模块、App 路由、样式、extension、测试/手工记录。

检查：

- [ ] 默认落地 `#memory`；三入口 记忆/活动/设置
- [ ] 普通自动记忆零待审；活动页无“待确认”徽标
- [ ] legacy 审查入口整体下沉 `#settings/advanced/review`；旧 `#queue` 重定向；不在活动页催人工
- [ ] 生效/本次会话/已停止/已过期分段
- [ ] 每条显示来源、版本、scope、时间；行内停止使用/恢复
- [ ] 停止使用/撤销下一次模型请求生效（含旧 session）；文案写清不可追回边界
- [ ] 版本回退默认 90 天可配置；超期只停用；冲突无“仅恢复文本”
- [ ] 撤销/恢复结果持久可见（不是 toast），活动可追溯
- [ ] 活动页/详情以只读 `/api/changes` + 统一事件/版本/来源/可撤销为稳定契约
- [ ] 旧深链重定向；高级审计/图谱/健康/技能/备份全部保留
- [ ] 不显示“彻底删除所有副本”假入口；不承诺云端删除
- [ ] 暖灰 + 墨绿现有 token，无新色板
- [ ] 390/560/900/1280 断点；44px 触控；键盘/aria
- [ ] extension page/panel/status 适配
- [ ] 不修改 confirm/settings-diff/draft-state/undo-preview 保护逻辑

### P06 — migration-verification

产物：`scripts/full-auto-memory-migrate.mjs`、`scripts/soak-30d.mjs`、隔离演练报告、验证矩阵。

检查：

- [ ] dry-run 提案 + fingerprint；apply 备份 + journal；undo 幂等；真实跑 apply→undo→再 apply
- [ ] 拒绝真实路径；只接受隔离目录
- [ ] 不批量删除 queue；逐行提案 keep/adopt/quarantine
- [ ] 不自动启用 automation；正式启用另行确认
- [ ] soak 调真实生产函数 + fake clock，不写 toy 状态机
- [ ] soak 模拟 30 天不变量：无规则自动、无重复 active、每条 auto 可撤销、容量有界、无跨项目泄漏
- [ ] retention/capacity 纳入 changes/suppressions/quarantine/change-journal 与受保护依赖
- [ ] soak 报告标明 simulated/seed/版本
- [ ] `npm run verify` 实跑日志与退出码
- [ ] 边界记录：最终功能全量验收完成；30 天现场运行未执行；正式启用另行确认

### P07 — final-review

产物：最终交付报告（沿用 `reports/final-review.md`，P07 执行时）。不再要求独立审查者。

检查：

- [ ] 主代理整体验收源码、接口与 UX 方向，不使用独立复核门
- [ ] 每条“通过”附实际证据；未验证项如实注明
- [ ] 反声明检查：无 30 天真实运行、无正式迁移、无发布
- [ ] 明确写出“最终功能全量验收”与“30 天现场运行/正式启用”的边界
- [ ] 已知缺口/风险列表
- [ ] 发布/启用建议（默认“不发布，等用户确认”）

## 4. 测试与证据规则

### 4.1 TDD

每个任务：

1. 写失败测试（断言用户可见结果，不断言内部实现细节）。
2. 跑该测试，确认失败原因正确。
3. 最小实现。
4. 跑该测试 + 相邻测试。
5. 阶段末跑 `npm run verify`。

### 4.2 测试分层

| 层 | 位置 | 内容 |
|---|---|---|
| 单元 | `plugin/test/*.test.ts` | changes、suppression、automation、recall、provider、policy |
| API | `plugin/test/api-*.test.ts` | items/changes/revert/restore/recall/auth/409 |
| 集成 | `plugin/test/consolidate*.test.ts`、`review-*.test.ts` | 自动写入、复盘 lane、预算、跨项目 |
| 存储/崩溃 | `plugin/test/transaction.test.ts` 扩展 | WAL、撤销中断、重放 |
| 纯逻辑 UI | `plugin/test/console-*.test.ts` | 分段、活动映射、版本标签、路由 |
| 手工 | `tmp/full-auto-memory/ux-smoke-*.md` | 390px、键盘、明暗主题、extension |

不新引 React 测试框架；UI 纯逻辑用现有 Vitest + 手工 smoke。

### 4.3 证据格式

`PROGRESS.md` 每阶段一行：

```text
P01 | done | npm run verify exit 0, 66 files/845 tests | tmp/full-auto-memory/verification/verify-p01.log | 2026-11-xx
```

P07 的通过声明必须能追溯到日志文件；日志不进 git（`tmp/` 已忽略）。

## 5. 阶段接口契约（速查）

| 阶段 | 消费 | 产出 |
|---|---|---|
| P01 | Store、Item、itemContentVersion、context hook、server auth | `changes.ts`、`suppression.ts`、`memoryVersion`、items/changes API、contextVersion |
| P02 | P01 的 session/projectKey、Store 预算方法 | `ReviewGenerate`（V2 `{prompt,model?}->{text}`）、独立 transport、typed errors、Retry-After 完整期限延后、run/request 预算、跨项目修复、事务化 hook 去重、status 只读字段 |
| P03 | P01 change/undo、P02 预算 | `decideAutomation`、quarantine、自动写入事务、curator 事件 |
| P04 | P01 version/scope、Store items | `recall.ts`、`/api/recall`、只读 tool action |
| P05 | P01/P02/P04 API | `Memory.tsx`、`Activity.tsx`、纯逻辑、路由/样式/extension |
| P06 | P01–P05 全部 | 迁移工具、soak、演练报告、验证矩阵 |
| P07 | 全部证据 | 主代理整体验收报告、发布建议 |

签名细节见 `DESIGN.md` §8；任何签名变更先改 DESIGN。

## 6. 非目标（阶段中反复确认）

- 不做向量/embedding/外部检索。
- 不自动写 L0、不自动装 skill、不改配置。
- 不自动处理安全/权限/破坏性/硬限制。
- 不做整库迁移、不删除历史 queue。
- 不做多用户/云同步/移动 App。
- 不在本轮必实现全机含备份彻底 erase；不承诺云端删除；后台模型仍可出网。
- 不发布、不提交、不推送。
- 不用“现场已跑 30 天”替代 soak 或验收。

## 7. 执行方式

用户已批准全量实施；所有实际操作由 subagent 执行，主代理负责方向、源码验收、管理与最终报告。后续按 P01→P07 顺序直接完成；不重复基线/专项评测/独立复核，仅改动后必要编译/类型检查，不层层等待评审。阶段失败时报告并继续处理受影响项，不把未跑当 pass。
