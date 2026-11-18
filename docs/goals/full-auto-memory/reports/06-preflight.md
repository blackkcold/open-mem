# P06 preflight — migration / soak / host / UI 可执行性

Date: 2026-11-11
Scope: 只读预检 + 只更新 `phases/06-migration-verification.md` 与本文件；不改产品代码、不运行迁移/host/测试/构建、不访问真实 config/data/凭证、不提交、不创建子代理、不调用模型。
Baseline: `b992a2e` / `feat/full-auto-memory`；P01 改动在 worktree 中但**未验收**，本预检不读其 fix diff、不重复 P01 review。
Inputs: `phases/06-migration-verification.md`、`reports/01-reversible-memory.md`、`reports/01-review.md` §4、`reports/00/02/03/04-preflight.md`、`DESIGN.md` §5.3/§7.3/§8.1/§8.6、`PLAN.md` §2、`ACCEPTANCE.md` §7、基线源码（`git show b992a2e:...`）、已安装 opencode CLI `--help/--version`、官方 V2 插件/Provider 文档、本地已安装 `@opencode/schema` 类型。

## 1. 结论

**文档层可执行；实现未开始，且存在明确未验证/阻塞项。**

- 迁移/undo/幂等/断电恢复的路径可复用真实 `Store.transaction` + `commitFileBatch`/`recoverFileBatch`，不需要另写 WAL；脚本必须导出核心函数供测试直接调用，不能只测 CLI 文本。
- **回滚不能按 P01 作者原说明“删账本即无损”**。`reports/01-review.md` §4 的四条兼容风险成立；P06 裁决为“完整 checkpoint 恢复优先；兼容导出必须显式报告损失，禁止剥字段复活已停用内容”。
- retention/capacity 可扩展 `previewRetention/applyRetention` + `capacityStatus.counts`；`dirSize()` 已统计新文件，但保护集合与自动修剪必须新增，否则会误清 active 最新事件/90 天回退引用。
- soak 可用 fake clock + 真实生产函数；**未验证**所有生产函数都接受 `now` 注入，若不接受则阻塞，不 monkeypatch `Date`。
- 真实 V2 host + 本地 fake provider **有可行路径**（CLI v2.1.1、官方插件/Provider 文档、XDG 四目录与 `OPENCODE_*` 变量均见证据），但**全部未实跑**；若隔离路径断言/fake provider/插件加载任一失败，明确阻塞，不以 fake host 冒充端到端。
- 正式 UI 必须真实 360px viewport + rail 260/320 + 双主题 + keyboard + 可恢复；`ux-visual-preview.md` 是样稿，不算验收。
- **P01 独立审查尚未通过**（3 Important + 7 Minor；修复在原作者 session 进行）。**Fix round 1 未 clean**：M7 为 blocking 且引入“无 metadata fallback 删除其他宿主 part”回归；N2（maintenance 旁路/磁盘放大）与 N3（重复 id 查账本 O(events×ledger)）deferred。fix2 正在原 owner 修 M7/N2；**N2 在 fix2 复核前不得视为已解决**。P06 一律等 P01–P05 验收后实现，不提前改接线。

## 2. P01 review §4 的兼容风险（原文 165–174 行）与裁决

作者旧 rollback 写“`changes.jsonl` / `suppressions.jsonl` / `change-journal/` 可直接删除，不参与注入；`items.jsonl` 新增可选字段可保留”。代码层属实（`buildContext` 只读 item 字段），但**不是语义无损**。本次预检确认四条风险全部需要 P06 承接：

| # | 风险 | 后果 | P06 裁决 |
|---|---|---|---|
| 1 | 删账本后 `items.jsonl` 仍带 `changeID` | 悬空引用；再启用 P01 时 `revertChange`/`restoreVersion` 一律 `not_found` | checkpoint 恢复优先；兼容导出报告悬空数；迁移遇 dangling 默认**阻断**（退出码 6），仅显式 `--repair-dangling-change` 才补基线并替换指针 |
| 2 | `invalidatedBy` 保留、旧版忽略 | 旧版重新注入已失效内容；再升级又被排除；按 I1 只能逐项显式恢复 | **禁止**剥 `invalidatedBy/invalidatedAt` 让旧版复活；旧版导出只能转 `archived` 非注入状态，并明确仍非无损 |
| 3 | `status=archived && supersededBy="deactivate"` 在旧版 90 天后被清理 | “停止使用无时限”在回滚后无法承诺 | checkpoint 保留；兼容导出显式报告“旧版无 P01 保护，90 天可能清理” |
| 4 | `restoreVersion` 要求 `snapshot.scope === current.scope` 且 projectKey 相等 | P06/旧 scope 迁移修改 scope 后，迁移前历史快照一律 `not_revertible` | **P06 默认不改 scope/projectKey**；scope 迁移保持独立显式工具；若执行，必须导出旧 scope 历史并显式接受损失，不称可恢复 |

补充裁决：

- **checkpoint 时点的完整逻辑状态是唯一可称“无损”的回滚路径**，必须含 `items/queue/state/config/changes/suppressions/change-journal/quarantine/migrations/merge-journal/changelog` 与“被引用历史”；checkpoint 位于 `--data` 外，manifest 显式复制，不嵌套既有 checkpoint/backup；排除 `console-token` 与可重建视图。checkpoint 之后的新用户编辑不在“无损”范围。
- 无 checkpoint 时，兼容导出**默认不写**；`--confirm-losses` 后才写新目录，且报告必须逐项列出：changeID 悬空、invalidated 复活风险、archived 90 天清理、derivedFrom 丢失、scope 历史不可恢复、suppressions/事件历史不再可撤销。
- **任何兼容损失必须显式报告**；不得用“回滚成功/无损”概括。
- P01 I1 裁决：**只允许显式恢复 invalidated 子项；上游恢复不自动复活所有下游**。P06 的迁移/soak/回滚演练按此，不把“上游恢复=全下游恢复”当契约。
- P01 作者旧 rollback 说明**不作为已验证契约**；P06 只以 review §4 + 本文件为准。

## 3. 迁移/回滚可执行性

### 3.1 可复用的真实机制（基线 observed）

| 机制 | 证据 | 用途 |
|---|---|---|
| `Store.transaction` | `git show b992a2e:plugin/src/store.ts:222-249` | 读己写、失败/`{ok:false}` 回滚 |
| `commitFileBatch`/`recoverFileBatch` | `plugin/src/util/transaction.ts` | redo WAL：先写 `.pending-transaction.json` 再 replay；`init()` 先恢复 |
| `safeStorePath` | 同上 | 拒绝路径逃逸与符号链接 |
| `applyScopeMigration`/`undoScopeMigration` | `plugin/src/memory/migrate.ts` | 备份+journal+queue CAS+同事务 undo 的现有先例；P06 不重写它 |
| 崩溃测试先例 | `plugin/test/transaction.test.ts:32-80` | monkeypatch `fs.rename`，每个真实 rename 边界 `exit(73)`，再 `Store.init()` |
| `previewRetention`/`applyRetention` | `plugin/src/retention.ts` | 现有 preview id + confirmed + 同事务删除；P06 扩展新文件 |
| `capacityStatus`/`admitAutoWrite` | `plugin/src/capacity.ts` | 85/95/100 分级；`dirSize()` 已含全部文件 |
| `runCurator(store, config, {now,force})` | `plugin/src/memory/curator.ts` | 真实过期/去重，可注入 now |
| `recordChange`/`deactivate`/`reactivate`/`revert`/`restore`/`invalidateDerived` | `DESIGN.md` §8.1 签名；P01 报告 | 迁移基线事件与 rollback 语义；P06 不手写事件 |

### 3.2 必须做到的契约

1. **路径守卫先于读取**：`realpath` 后拒绝真实 `autopilot`/`~/.config/opencode`/home/`/`；只允许 mkdtemp 或 worktree `tmp/**`（`--allow-dir` 仍拒绝真实路径）；退出码 2。
2. **fingerprint**：canonical JSON + 文件 sha256 + 工具版本 + 排序 proposals；dry-run 可复现；apply 必须精确匹配；不匹配退出码 3、零写入。
3. **业务字段保留 / 审计字段显式**：迁移不改 `id/title/text/kind/scope/projectKey/project/source/sources/createdAt/updatedAt/manual/expiresAt/aliases/derivedFrom/supersedes/supersededBy/invalidatedBy`；`changeID` 是审计指针，可为无值行新增或经 `--repair-dangling-change` 显式修复；除 `changeID` 外不改审计/业务字段。`adopt` 不重新分类 scope、不补造 projectKey。
4. **基线事件**：只对 `status=auto|promoted` 且无任何事件的行补 `kind=migration/actor=migration/before=after`；走 `recordChange`/`stampChange`；不改正文/状态/`updatedAt`；每 item ≤1 条；已有事件 skip。
5. **apply→undo→再 apply**：再 apply 后 `businessStateHash` 相同、baseline 不重复；不要求事件 id/时间戳字节相同（P01 `newChangeID` 随机）。undo 前做**分域 CAS**：per-file hash + `storeStateHash`/`businessStateHash` + 行数/事件数，任一漂移退出码 4、零写入；二次 undo 退出码 6。
6. **断电/checkpoint 拓扑**：checkpoint 位于 `--data` 外，先写 checkpoint（临时目录→fsync→原子改名），再在 `Store.transaction` 内重校验输入并写数据；checkpoint 与数据不是同一 WAL，事务失败只留无引用孤儿 checkpoint。manifest 显式列出运行状态/被引用历史，排除既有 checkpoint/backup 自身，不递归嵌套；记录 `absent`，undo 才能删除新建文件。
7. **不靠 toy 状态机**：脚本导出 `planMigration/applyMigration/undoMigration/assertIsolated` 供测试直接调用；CLI 只做参数/输出。测试覆盖真实 rename 边界，不 mock 掉事务。
8. **配置只补缺省**：仅当不存在时补 `automation.enabled=false`、`undo.retainDays=90`；已有值保留，不改用户 `true`，不启用自动化。
9. **hash 分离**：`businessStateHash`（业务字段 + queue + config，排除事件 id/时间戳/`changeID`）用于判断业务是否改变；`storeStateHash`（完整逻辑状态含事件/抑制/journal/审计字段）用于 undo/CAS。基线只改 `storeStateHash`/`changeID`，不改 `businessStateHash`。

### 3.3 已识别的实现难点（未验证）

- `recordChange` 是否会自动更新 `item.changeID`/`updatedAt`，以及 baseline 事件是否被 `retention` 当作“最新可逆事件”保护；实现前以 P01 最终签名为准，必要时在 P06 retention 中显式保护“每 active item 最新事件”，不依赖 `revertible`。
- 大文件 checkpoint 的内存/原子性：当前 `FileBatch` 以字符串保存；迁移需一次读入 items/changes；在隔离演练规模可接受，但未做生产规模测量，不声称无限规模。
- 迁移 journal 与 checkpoint 的保留：journal 在 dataDir；checkpoint 在 `--data` 外并独立计数；不能只保留 journal 而删掉活跃回退 journal 的唯一 checkpoint，也不能让 checkpoint 随每次迁移嵌套/几何增长。

## 4. retention / capacity 预检

### 4.1 现状（基线 observed）

- `previewRetention` 只读 `state/items/queue/merge-journal/changelog` 与 `maintenance/recovery/curator/session-archive`；**不读** `changes/suppressions/quarantine/change-journal`（`retention.ts:50-120`）。
- `applyRetention` 只删 preview 的 `deleteFiles`、归档 session、重写 items/merges/history；有 preview id + `confirmed===true`。
- `capacityStatus` 用 `itemsTotal/queue/skillDrafts/diskBytes`；`dirSize()` 递归统计全部文件（`store.ts:1015+`），所以新文件已计入 **diskBytes**，但 counts 不可见。
- `recent()` 规则 = 最近 90 天或最少 20 条；`references()` 只识别 `id/*ID/*Id/supersededBy` 字符串；P01 新字段需要显式保护规则，不能靠通用引用扫描。

### 4.2 裁决

1. **保护集合**：每个 active item（auto/promoted，含 invalidated）的最新事件；`at >= now - undo.retainDays` 且快照完整的事件；`item.changeID` 指向的事件；`applying/undoing/restoring` 或 WAL 未完成事务引用的事件；迁移回退窗口内/pin 的已应用 journal 引用的事件；沿 `dependsOn/reverts` 传递闭包。active 最新事件即使 `revertible=false`（migration baseline）也保护。
2. **新文件计入**：`previewRetention` 增加 `pruneChanges/pruneChangeJournals/pruneSuppressions/pruneQuarantine/protectedChanges/protectedJournals/historyBytes`；`id` hash 包含新文件内容；`applyRetention` 只删 preview 项并写 changelog。
3. **自动修剪边界（与 P03 合版）**：`runMaintenanceTick` 可后台安全回收既有 policy 内的过期 auto item/exact 去重/quarantine TTL/shadow/hook caps/派生历史；不做日常人工待办，不硬删 manual/promoted/rule/stopped。**已完成且窗口外**普通事件/journal 按依赖闭包收缩，不因 `undone=false` 永久豁免 5000/90 天；硬删除/超 policy/真实数据部署仍显式 preview+confirm。到上限仍不能删 → `retention_blocked`。
4. **suppression tombstone**：stopped/reverted 来源的必要 tombstone 必须保留；不得因 2000/90 天让同 source 重新学习；必要项超限 → `retention_blocked`，不误删。只有 `until` 已过且无 stopped/reverted item 依赖的 suppression 可清。
5. **容量**：`capacityStatus.counts` 增加新文件计数；`diskBytes` 已含 dataDir 内新文件；85/95/100 语义不变。freeze 时先回收可安全数据再复检；仍不足则 `blockedReason/retryAt` + `reclaimable`，不宣称自动运行。
6. **备份/快照**：`migrations/*.json` 保留“最近 3 次 + 回退窗口内/ pin + 未完成”，不是“全部 undone=false”；checkpoint 根在 `--data` 外，manifest 显式复制、不嵌套既有 checkpoint/backup；保留“活跃回退 journal 引用 + 最近 N=3 + pin”，**永不删活跃 journal 的唯一备份**；checkpoint 数量/字节有界，不随 5 次以上迁移/回滚几何增长。验证日志/截图在 `tmp/`，不占 dataDir，按阶段/日期/数量有界。
7. **测试**：小 caps/小上限构造；断言保护项零删除、窗口外可收缩、必要 tombstone 超限 blocked；`previewRetention.id` 随新文件变化；自动修剪不影响 90 天 `restoreVersion` 窗口、active 最新事件、未完成 journal；连续 ≥5 次迁移/回滚后 checkpoint 有界且活跃唯一备份仍在；输出前后 counts/bytes 证据。

## 5. soak 预检

### 5.1 真实函数清单（实现时逐项 import）

`Store`/`Store.init`/`transaction`、`recordChange`、`memoryVersion`、`runConsolidation`、`decideAutomation`（P03）、`runMaintenanceTick`（P03）、`runCurator`、`expireQuarantine`（P03）、`previewRetention/applyRetention`、`capacityStatus/admitAutoWrite`、`takeAutomationSlot`（P03）、`deactivateItem/reactivateItem/revertChange/restoreVersion/invalidateDerived`。

- 禁止在 soak 内实现同名 `consolidate/decide/expire/budget` 逻辑；只编排调用。
- 使用 `now` 注入：`Store` 构造/`runCurator({now})`/`runMaintenanceTick({now})`/预算 `now`。**未验证**所有函数都支持；不支持则阻塞，不 monkeypatch `Date`。
- 30 天 = 720 个模拟小时（或按会话调度），秒级~分钟级完成；不 sleep。
- 不变量：phase06 原 10 条 + retention 有界/可收缩、tombstone 不复活、WAL 重启、I1 显式恢复、scope 隔离、备份有界、无假自动（共 16 条）。
- 报告：`reports/soak-30d.json` 含 `simulated:true`、`fakeClock:true`、seed/days/sessions/version/模块列表/不变量/失败 id；三处文案禁止“30 天真实运行”。

### 5.2 未验证

- P03 的 `runMaintenanceTick`/`takeAutomationSlot` 尚未实现（P03 方案已预检）；P06 必须等 P03 验收后按其真实签名接线。
- fake clock 与 `claim()` 的时间窗（curator 24h、maintenance 15min）是否都走注入 now；若某个 `claim` 用真实 `Date.now`，soak 会不准，需要 P06 显式报告/修复，不静默忽略。

## 6. 真实 V2 host 预检

### 6.1 已观察（本次只读）

| 检查 | 方式 | 结果 |
|---|---|---|
| CLI 版本 | `opencode --version` | `v2.1.1` |
| 顶层/子命令 | `opencode --help`、`run --help`、`plugin --help`、`debug --help`、`serve --help` | `run --standalone`、`--model`、`--session` 可用；`debug paths` 存在（只打印路径） |
| 插件加载 | 官方 V2 `/v2/docs/build/plugins` | `.opencode/plugins/` 自动；`plugins` 数组支持绝对路径/本地目录/包 |
| Provider | 官方 V2 `/v2/docs/providers` | 自定义 provider：`package`+`settings.baseURL`+`models`；OpenAI-compatible 包；`env` 提供凭证 |
| 配置类型 | `@opencode/schema/dist/config.d.ts`、`config/plugin.d.ts`、`config/provider.d.ts` | `plugins` 支持 string/`{package,options}`；provider 有 `models/settings/headers/body` |
| Hook 类型 | `reports/04-preflight.md` 已记录 `SessionHooks.context`、`SystemPart` | 与 P01/P04 方案一致；本次未重读类型文件 |
| 路径隔离 | 安装包字符串/代码片段：`XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_CACHE_HOME/XDG_STATE_HOME`；`OPENCODE_CONFIG_DIR/OPENCODE_CONFIG/OPENCODE_DB`；`OPENCODE_DISABLE_MODELS_FETCH` | 有隔离手段；**未实跑** |

### 6.2 隔离启动矩阵

`HOME` + XDG 四目录 + `OPENCODE_CONFIG_DIR` + `OPENCODE_CONFIG` + `OPENCODE_DB` + `OPENCODE_DISABLE_MODELS_FETCH=1` + `OPENCODE_DISABLE_AUTOUPDATE=1` + `OPENCODE_DISABLE_CLAUDE_CODE=1` + `OPENCODE_DISABLE_PROJECT_CONFIG=1`，全部指向 `tmp/full-auto-memory/host-<id>/`。

执行时先跑**隔离 env 下**的 `opencode debug paths`，断言 data/config/cache/state 全在临时根；任一落在真实 home/config/data/cache/state → **阻塞**，不启动 host、不猜替代路径。

### 6.3 fake provider / 插件 / 请求验收

- 本地 `127.0.0.1` HTTP，OpenAI-compatible `POST /v1/chat/completions` SSE；请求体落盘到 `requests/<n>.json`；确定性响应；不出网。
- 隔离配置 `providers.fake`：`package:"@opencode/ai/providers/openai-compatible"`、`settings.baseURL:"http://127.0.0.1:<port>/v1"`、`env:["FAKE_API_KEY"]`、`models.fake-chat`；`model:"fake/fake-chat"`；`plugins:["<worktree>/plugin"]`（执行时先 build）。
- recorder 插件放 `tmp/.../recorder-plugin/server.ts`（非产品代码），在 memory 插件之后注册 `context`，落盘每个 `event.system` part 的 type/text/hash/metadata key。
- 断言：先记录宿主形状 `metadata_recorded`/`wrapper_only`/`neither`；请求 1 owned 块含唯一 sentinel，且正文夹带字面 `<context key="fake">INNER</context>` / `</context>`；调隔离 API 停止该 item；请求 2 同一 session 的 owned 块/SystemPart **无 sentinel/撤销内容**；相邻宿主 parts 文本/hash 逐字保留；`messages` 原始用户文本逐字保留；无重复 owned part；无“API 已停用但下一请求仍注入”。
- **失败条件**：出现 `context_ambiguous`、旧正文残片、宿主相邻块被删/改写、`entry.put` 与 `event.system` 转义不一致、或 `neither`/unlocated → **最终验收 blocked**；warning/降级/fake host 结果不放行。
- **M7 边界**：fix2 允许在无 metadata 且正文含字面 open/close 时保留原 part、不删宿主并写 `context_ambiguous`；但“保留旧块”不等于“下一请求已排除”，真实 host 仍须证明 owned 块无撤销内容，否则 blocked。
- **N2/N3**：N2 未解决，不得作为已解决；fix2 复核后验证 maintenance 放大与 undo 不复活无效上游。N3 留 P06 规模验证：2000+300 约 592ms，5000 上限测耗时，不提前重构。

### 6.4 阻塞/未验证

| 项 | 状态 |
|---|---|
| 隔离 XDG 四目录实测 | **not-run**；仅安装包字符串/代码片段证据 |
| `opencode debug paths` 在隔离 env 的结果 | **not-run**；执行时首检 |
| 自定义 provider 无 `/connect` 接受假 key | **unknown**；不接受则阻塞 |
| SSE/OpenAI-compatible 形状被 V2 接受 | **unknown** |
| `plugins` 绝对目录加载构建产物 | 官方文档支持；**未实跑** |
| 真实宿主 system part 形状 | **not-run**；P01/P04 已声明；无 metadata 字面 context 的 M7 形状未验 |
| M7 真实 host 证据 | **not-run**；ambiguous/残片/删宿主/两通道转义不一致 → blocked |
| N2 maintenance 旁路 | **未解决**；fix2 复核后验证，不视为已通过 |
| N3 账本规模 | **not-run**；P06 测 2000+300/5000，不提前重构 |
| 真实模型请求/真实 host 启动 | **未执行**；本预检禁止 |
| 后台 service/Keychain 旁路 | **unknown**；用 `--standalone` + 隔离 HOME/XDG；若仍出现真实路径/凭证，阻塞 |

## 7. 正式 UI 验收预检

- 真实 Chromium/Playwright，**360×800 viewport**，移动 UA+touch；不是 device toolbar 画布列。
- 三页 + 详情 sheet + 行内停止/恢复/撤销 + 旧深链重定向。
- rail **260 与 320** 两宽度：44×44、标题换行、基本动作常显。
- 明/暗双主题：chip/badge/危险按钮 ≥4.5:1；无硬编码色/无效 `var(--primary)`。
- keyboard：Tab 顺序、Escape 关 sheet、焦点回触发行、无陷阱。
- 可恢复：停止 → 刷新同会话仍不出现；“最近操作”可恢复；恢复后重新出现；刷新后仍在。
- 证据：截图 + DOM/axe + 视口尺寸，放 `tmp/full-auto-memory/verification/ui/`。
- **`reports/ux-visual-preview.md` 是样稿，不算正式验收**；extension rail 若无法真实加载 → `blocked`，不得用独立 HTML 冒充扩展通过；Playwright/Chromium runner 不可用 → 同样 `blocked`，不新增仓库依赖。
- 当前 **not-run**：未启动 dev server、未开浏览器、未做任何 UI 验收。

## 8. Rulings（本次预检，供实现/主代理）

| # | 裁决 |
|---|---|
| R1 | P06 实现必须等 P01–P05 验收；P01 修复在原 session 进行，P06 不提前接线/不预写产品代码。 |
| R2 | 回滚优先 checkpoint 时点的完整逻辑状态（items/事件/抑制/配置版本/迁移历史）；checkpoint 位于 data 外，不嵌套既有 checkpoint/backup。 |
| R3 | 无 checkpoint 的兼容导出必须显式报告损失；禁止剥 `invalidatedBy/derivedFrom/supersededBy` 让已停用内容复活。 |
| R4 | P06 迁移默认不改 scope/projectKey；scope 迁移独立显式，旧历史快照导出并标注不可原地恢复。 |
| R5 | 迁移基线事件走 P01 `recordChange`；每 active item ≤1 条；不改正文/状态；dangling changeID 默认阻断。 |
| R6 | retention 保护集合含 active 最新、90 天回退、未完成/显式引用、传递闭包；已完成窗口外可收缩；上限不误清，到界报 `retention_blocked`。 |
| R7 | 派生历史可自动修剪；items 在 P03 policy 内过期/精确去重可后台回收，硬删除/超 policy/sessions/merges 仍显式 preview+confirm；checkpoint 有界且永不删活跃回退 journal 的唯一备份。 |
| R8 | soak 只调真实生产函数 + fake clock；函数不支持 `now` 即阻塞；禁止 toy 状态机/“30 天真实运行”。 |
| R9 | 真实 host 验收只在隔离 env + 本地 fake provider 下做；路径断言失败/fake 不接受/插件未加载 → `blocked`，不以 fake host 冒充。 |
| R10 | 正式 UI 必须真实 360/rail 260/320/双主题/keyboard/可恢复；样稿与画布列不算。 |
| R11 | P01 I1：只允许显式恢复 invalidated 子项；上游恢复不自动复活所有下游；迁移/soak/回滚按此。 |
| R12 | 所有 `not-run/blocked` 必须写进 `06-rehearsal.md` 与最终报告；不得用“全部通过”替代。 |

## 9. 验证记录

| 检查 | 方式 | 结果 |
|---|---|---|
| P01 review §4 | 读 `reports/01-review.md:165-174` | observed：四条兼容风险 + 旧 rollback 非无损 |
| P01 review §7.1.1/§7.2 | 读 `reports/01-review.md:211-247` | observed：M7 A/B/B2 残留/删宿主、N1 并入 blocking、N2/N3 deferred；fix1 未 clean |
| P01 I1 裁决 | 读 `reports/01-review.md:21-42` | observed：显式恢复子项；上游不级联 |
| 基线事务/WAL | `git show b992a2e:plugin/src/store.ts`、`util/transaction.ts` | observed |
| 基线 retention/capacity | `git show b992a2e:plugin/src/retention.ts`、`capacity.ts` | observed |
| 基线迁移先例 | `git show b992a2e:plugin/src/memory/migrate.ts`、`scripts/openmem-migrate-scopes.mjs` | observed |
| 崩溃测试先例 | `git show b992a2e:plugin/test/transaction.test.ts` | observed |
| CLI | `opencode --version/--help/run --help/plugin --help/debug --help/serve --help` | observed；v2.1.1 |
| 官方插件/Provider | `https://opencode.ai/v2/docs/build/plugins`、`/v2/docs/providers` | observed（本次 webfetch 原文） |
| 本地配置类型 | `@opencode/schema` config/plugin/provider d.ts | observed |
| 路径隔离 | 安装包字符串/代码片段 | observed（字符串）；**未实跑** |
| 迁移/测试/构建 | 未运行 | not-run：本阶段禁止 |
| host/模型/UI | 未启动、未请求、未开浏览器 | not-run：本阶段禁止 |
| 真实配置/数据 | 未读取/未写入 | 符合约束 |

## 10. 需要执行阶段回答/可能阻塞

1. P01 fix2 后的真实签名（M7 fallback、`reactivateItem` 对 invalidated 子项、`restoreVersion` 上游检查、N2 maintenance 旁路、`recordChange` 是否更新 item）；N2 未复核前不算解决。
2. `Store`/生产函数是否全部支持 `now` 注入；不支持则 soak 阻塞。
3. 自定义 provider 无 `/connect` 是否接受 `env` 假 key；SSE 形状是否被接受。
4. 隔离 `debug paths` 是否全在临时根；`--standalone` 是否完全避开后台 service。
5. 真实宿主 system part 的 keyed 形状；无 metadata 时字面 context 是否 ambiguous/残片/删宿主；无法定位 owned part 即失败。
6. `dist` 构建产物能否被 `plugins` 绝对目录加载；若必须 `.opencode/plugins/`，隔离项目根方案是否可行。
7. retention 自动修剪是否需要同步 `DESIGN.md` 的配置/文案；实现前同步，不在本预检改。
8. `entry.put` 与 `event.system` 两通道转义是否一致；不一致即 blocked。
9. N3 5000 账本耗时/内存；只记录，不提前重构。
10. M7 真实 host 证据是否通过；ambiguous/残留/宿主块丢失即最终验收 blocked。
11. scope 迁移与旧历史恢复的产品语义：P06 默认不改 scope；若用户要求迁移，必须单独确认接受历史损失。

## 11. 主代理 rulings 补正（2026-11-11）

| # | 裁决 |
|---|---|
| R13 | checkpoint 根在 `--data` 外；manifest 显式复制运行状态/被引用历史，不递归、不嵌套既有 checkpoint/backup。旧 checkpoint 只按“活跃回退 journal 引用 + 最近 N=3 + 显式 pin”保留（回退窗口默认 `undo.retainDays`=90 天）；不得用“所有 undone=false”永久全保留，也不得删活跃回滚 journal 的唯一备份。 |
| R14 | 只有 `applying/undoing/restoring` 或 WAL 未完成才永久保护；`applied` 只在迁移回退窗口内/被 pin/被 checkpoint 引用时保护；已完成且窗口外普通事件/journal 按依赖闭包安全裁剪，不因 `undone=false` 永久豁免 90 天/5000 上限。 |
| R15 | 仍 stopped/reverted 的来源必须保留 suppression tombstone；2000/90 天不能成为同 source 重新学习的理由；必要 tombstone 超限 → `retention_blocked`，无安全收缩时如实 blocked。 |
| R16 | 迁移不改业务字段 `id/title/text/kind/scope/projectKey/project/source/createdAt/updatedAt/manual/expiresAt/aliases/derivedFrom/supersedes/supersededBy/invalidatedBy`；`changeID` 是审计指针，可新增或经显式 `--repair-dangling-change` 修复。`businessStateHash` 与 `storeStateHash` 分开；undo 恢复完整 store hash。 |
| R17 | 与 P03 容量回收合版：既有 policy 内允许后台安全回收过期 auto item、exact 去重、quarantine TTL、shadow/hook caps、派生历史；不生成日常人工待办。硬删除/超 policy/真实数据部署仍需确认；高级 preview+confirm 保留但非唯一路径。无安全数据 → `blockedReason/retryAt`，不假称永不阻断。 |
| R18 | “无损”只限 checkpoint 时点；undo 逐域比较 per-file hash、`storeStateHash`、`businessStateHash`、行数/事件数，任一漂移拒绝（退出码 4）；不覆盖迁移后新用户编辑，只能另存恢复/差异导出。 |
| R19 | 宿主隔离首检保留：隔离 env 下先 `opencode debug paths`，四目录不在临时根即阻塞；fake provider/recorder 验收按原文，全部 `not-run`。 |
| R20 | 回滚保守边界保留：checkpoint 优先；兼容导出显式损失；不剥 `invalidatedBy/derivedFrom/supersededBy` 复活已停用内容；scope 默认不迁移。 |
| R21 | M7 真实 host 门禁：旧 owned 块夹带字面 `<context>`/`</context>` → 停用 → 同 session 下一实际请求 owned 块无撤销内容，相邻宿主块/聊天逐字保留；ambiguous/残片/删宿主/两通道转义不一致 → 最终验收 blocked，warning/fakehost 不放行。 |
| R22 | N2 在 fix2 复核前不得视为已解决；验证 maintenance 放大与 undo 不复活无效上游。N3 留 P06 2000+300/5000 规模测量，记录耗时，不提前重构。 |

## 12. 精确测试矩阵（补正）

| 测试 | 构造 | 证据/断言 | 当前状态 |
|---|---|---|---|
| `checkpoint-bounded.test.ts` | 连续 ≥5 次 apply→undo→再 apply；1 个活跃回退 journal 引用唯一 checkpoint | 数量 ≤ N=3 + 活跃引用 + pin；字节不几何增长；无嵌套 checkpoint/backup；活跃唯一备份仍在；输出 counts/bytes | not-run |
| `history-prune.test.ts` | >90 天普通事件 + active 最新 + 窗口内 + 显式引用 + stopped tombstone | 窗口外可收缩；保护项零删除；无悬空 journal/快照；active 仍可操作 | not-run |
| `suppression-tombstone.test.ts` | 2000+ suppression，必要 tombstone 超限 | 必要项保留并 `retention_blocked`；可安全项清；同 source 不重学 | not-run |
| `changeid-hash.test.ts` | 无 changeID / dangling / 正常 item | 基线新增/显式修复 changeID；business hash 不变；store hash 变化；undo 完整恢复 | not-run |
| `capacity-policy.test.ts` | 95% + 过期 auto/重复；95% 无冷数据；manual/promoted/rule/stopped | policy 内回收后恢复；无冷数据 blocked+retryAt；保护项不动；无日常待办 | not-run |
| `checkpoint-cas.test.ts` | apply 后分别改 item/event/suppression/config/journal | 逐域拒绝（退出码 4）并列漂移域；另存恢复不覆盖；checkpoint 时点状态一致 | not-run |
| `retention-counters.test.ts` | 小 caps + 新文件 | preview/capacity counts/bytes/id 随新文件变化；磁盘前后值 | not-run |
| `host-m7-literal.test.ts` | 真实 host + fake provider；旧 owned 块夹带字面 `<context key="fake">`/`</context>`；停用后同 session 再请求 | 记录 metadata/render 形状；owned 块无撤销内容；相邻宿主块/聊天逐字保留；ambiguous/残留/删宿主 → blocked | not-run |
| `n2-invalidate.test.ts` | 停用有后代的 A；maintenance undo；检查 `.items.bak`/journal | 无异常放大；undo 不复活无效上游；fix2 复核前不判通过 | not-run |
| `n3-ledger-scale.test.ts` | 2000+300；5000 上限 | 记录耗时/事件数；592ms 基线；超时/不可接受 → 规模阻塞；不提前重构 | not-run |

## 13. 结论

P06 的迁移/回滚/retention/soak 方案在文档层可执行，但**不能现在开工**：P01–P05 未验收；P01 fix round 1 未 clean（M7 blocking、N2 未解决、N3 延后），fix2 在原 owner 进行。实现顺序固定为：P01–P05 验收 → P06 先写失败测试（迁移/retention/soak）→ 隔离演练 → host 隔离验收（M7 真实证据门禁，不能跑明确 blocked）→ 正式 UI 真实验收 → 06-rehearsal 报告。

本预检未修改产品代码、未运行迁移/host/测试/构建、未提交、未读取真实配置/数据/凭证、未创建子代理。
