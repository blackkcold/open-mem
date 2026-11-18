# P06 — migration & verification

Status: **retention/capacity + 隔离迁移/回滚工具源码完成 2026-11-16；行为/演练未执行**
Depends: P01–P05 全部验收；P01 独立审查问题修复并复验
Blocks: P07
Global constraints: 见 `PLAN.md` §2
Preflight: `reports/06-preflight.md`
P01 review: `reports/01-review.md` §4（回滚兼容风险，本阶段必须承接）

## 0. 门禁（先读）

1. 本文件与 `06-preflight.md` 是**需求基线**；早期“等独立审查/演练/soak/host 前置”已由 PLAN §2.2 与用户 2026-11-16 执行方式替代，仅保留为历史说明，不再阻塞产品编码。
2. P01 独立审查与 fix2 历史记录保留；当前按主代理源码验收 + 必要 typecheck 推进，不重开旧审查门。
3. **P01 I1 裁决**：只允许显式恢复 `invalidated` 子项；上游恢复**不自动**复活全部下游。P06 的迁移/soak 断言按此裁决，不把“上游恢复 = 下游全部恢复”当契约。
4. 作者旧 rollback 说明（删 `changes/suppressions/change-journal` 即“无损”）**不是已验证契约**；P06 以 `reports/01-review.md` §4 的兼容风险为准。
5. 正式启用、真实数据迁移、真实宿主请求、30 天现场运行均**未执行**；需要用户另行确认。
6. M7/N2/N3 历史复核记录保留；P06 产品编码不再等待，真实 host/UI 验收按最终报告如实标注 not-run/blocked。

## 0.1 产品单元 1 交接（2026-11-16，≤15 行决议）

1. 只改真实入口：`previewRetention/applyRetention`、`capacityStatus/admitAutoWrite`、P03 `runMaintenanceTick`；不建第二套 quarantine/事务/调度。
2. 新文件计入 counts/bytes/preview id：`changes.jsonl`、`change-journal/`、`suppressions.jsonl`、`extract-quarantine.jsonl`、`retired-sources.jsonl`、`global-candidates.jsonl`、`migrations/`、`backup/checkpoint-*`；`diskBytes` 仍全盘一次。
3. 保护闭包：active 最新、任何 item.changeID、窗口内完整 before/after、dependsOn/reverts 传递、未完成 journal/WAL、迁移窗口/pin、无法解析 journal；只删窗口外且无引用。
4. 停用/撤销来源 tombstone 与 retired 屏障无时限；必要 tombstone 超 2000 只 `retention_blocked`，不释放同源重学。
5. quarantine 仅 TTL/200 上限；global 候选满只阻 global 升级，不影响 project 学习；retired 不套 quarantine TTL。
6. 后台回收只含 policy 内派生历史；items 过期/精确去重仍由 curator，sessions/merges/changelog/manual/promoted/rule/stopped 不在后台硬删范围。
7. 删除事件与 journal 同一事务提交，先算闭包后删除；apply 在锁内重算 plan 并比对 preview id。
8. 95% freeze / 85% compact 不变；freeze 前一次有界回收后复检，claim/cooldown 共享，不递归、不每请求全盘扫描。
9. 无回收空间时 status/预览给 blockedReasons、受保护计数、retryAt；停止/撤销不受容量影响。
10. 活动记录 `retention_auto`/`retention_blocked`；status 返回 live capacity 与最近 retention 快照；设置/健康只读展示真实口径，不新增未实现按钮。
11. 边界：本轮未执行任何清理/迁移/soak/测试/真实 dataDir；typecheck 通过不等于行为验证。


## 0.2 根因修正（2026-11-16，主代理源码验收后）

- 统一保护根/闭包：窗口、迁移有效窗口/pin、WAL/undoing/无法解析 journal、retired/旧 recovery refs、active 最新与 item.changeID 一次闭包；item 仅在其事件不被最终保护集引用时删除，journal-only 保护不再被重算丢弃。
- 冷却：新增 `Store.tryReserveRetentionRun` 持久 gate（5min）与 30s 并发 lease 分离；请求与 maintenance 自动路径在扫描前短路，失败/零回收同样 backoff；显式 preview/confirm 不受限。
- 指纹/口径：checkpoint 文件相对路径+hash 纳入 preview id（symlink/未知 fail-closed）；migrationJournals/checkpointBackups 拆分；retired/global state bytes 计入 historyBytes；status 分离 reclaimedBytes 与 remainingReclaimableBytes。
- 上限生效：changes/changeJournals 达 5000 时自动 writer 先一次有界回收，仍满则 `history-protected-capacity` + retryAt；停止/撤销/恢复与审计 append 不受影响。
- 未跑测试/清理/迁移/真实 dataDir；行为未验证。

## 0.3 迁移/回滚工具（2026-11-16，源码）

- `scripts/full-auto-memory-migrate.mjs` / `...-rollback.mjs` 为可调用薄入口，经本地 `tsx` loader 进入 `plugin/src/migration/{guard,core,cli}.ts`；不要求先 build，不读 token/网络。
- migrate：`--data --checkpoint` 严格显式；`--dry-run` 默认、`--apply --confirm <64hex>`、`--undo <id>`、`--status`、`--checkpoint-gc-preview`/`--checkpoint-gc --confirm`、`--repair-dangling-change`、`--pin-checkpoint`。rollback：`--checkpoint <id-dir> --target <new-empty> --restore|--compat-export --confirm-losses`。
- 路径守卫先于读取：字符串/realpath/祖先 symlink；拒绝 home、`/`、`~/.config/opencode` 子树；只允许 worktree `tmp/**`、临时根、`--allow-dir`；data/checkpoint 互斥祖先；target 必须新空目录；manifest 相对路径白名单。
- checkpoint 外部 staging/fsync/原子 rename；manifest 记录 absent/bytes/hash/referencedBy/inputFiles/beforeDomains；staging 发布前用同一 `readCheckpointManifest` 校验固定文件/白名单/unique/hash/bytes/domain/inputFiles 一致性；含凭证配置在复制前拒绝。apply 在 Store 锁内用 transaction-aware staged view 重校验输入，再写 queue/items/quarantine/baseline/config/journal/changelog；post-commit 分域校验，不 force。
- undo 分域 after hash（含 state 与 checkpoint 实际运行文件/absent）一致才同事务恢复 checkpoint（排除当前 journal），二次 undo exit6；checkpoint 漂移只允许 rollback restore 到新目录。checkpoint 在 Store 锁内单次读取生成 hash/正文/inputFiles/beforeDomains，发布前校验；迁移新建文件记录 afterFiles，undo 仅删该次新增。
- compat 支持 `--checkpoint` 或 `--data` 源；未确认只输出损失预览、不建 target；确认后仅写新空目录。清除 state 中 pinned context/cache 版本引用，失效/停止行转 archived，不剥字段；不称无损。
- GC fingerprint 绑定 journal 状态/引用与 checkpoint manifest/文件 hash；在 Store 共享锁内重校验 digest/bytes；pinned 始终保护，仅显式确认删除批准根内对象。
- 目录枚举先验链接；`manifestRelative` 拒绝原始任意 `..`/跨平台分隔符；`containsSecret` 复用 redactText(token/私钥/高熵)+Authorization/Cookie/URL credential/递归字段，env 引用与 apiKeyEnv 名合法。所有工具未对任何 dataDir 执行；仅 typecheck/node --check。

## 目标

交付可复现的迁移/回滚工具、加速 soak 与隔离验收路径，覆盖：

- legacy 数据迁移：保留身份/scope/来源；active item 基线事件；queue 逐行提案；配置只补默认值。
- apply → 校验 → undo → 校验 → 再 apply 的真实幂等演练；断电/WAL 恢复；二次 undo 报错。
- P01 新字段的**兼容回滚**：完整 checkpoint 优先；兼容导出必须显式报告损失，不得靠剥字段让已停用内容复活。
- retention/capacity 纳入 `changes/suppressions/quarantine/change-journal/migrations/backup`，并保护 active 最新事件、90 天可回退引用、journal 引用。
- soak 只做 fake-clock 模拟，调用真实生产 scheduler/maintenance/expiry/budget 函数，拒绝声称 30 天实运行。
- 真实 V2 host + 本地 fake provider 的隔离验收路径；能证明则证明，不能证明则明确阻塞。
- 正式 UI 的真实 360px / rail 260/320 / 双主题 / keyboard / 可恢复验收计划；假样稿不算正式验收。

## 非目标

- 不读取/写入 `~/.config/opencode/memory/autopilot` 或任何真实 memory/config/凭证。
- 不执行正式数据迁移、不自动启用 `automation.enabled`、不修改用户已有配置值。
- 不删除旧 queue 历史、不做批量清理、不重写 item 正文。
- 不声称 30 天现场运行、不声称真实宿主已通过、不声称正式迁移完成。
- 不修改 P01–P05 的产品语义；P06 只做工具、演练、验证与必要的 retention 扩展。
- 不提交/推送/发布；不创建子代理；不调用模型/付费 API。

## 文件

| 文件 | 改动 |
|---|---|
| `scripts/full-auto-memory-migrate.mjs`（新） | dry-run/apply/undo/status；checkpoint + journal；路径守卫；fingerprint；真实演练；导出核心函数供测试直接调用 |
| `scripts/full-auto-memory-rollback.mjs`（新） | 完整 checkpoint 恢复；无 checkpoint 时生成兼容导出并显式报告损失；拒绝真实路径 |
| `scripts/soak-30d.mjs`（新） | 调真实生产函数 + fake clock；不变量检查；`reports/soak-30d.json` |
| `plugin/test/migration-auto.test.ts`（新） | 提案/身份保留/幂等/apply→undo→再 apply/路径拒绝/fingerprint/并发漂移/dangling changeID |
| `plugin/test/migration-crash.test.ts`（新） | 每个真实 rename/WAL 边界杀进程；恢复后全成或全不成；resume/undo 可用 |
| `plugin/test/soak.test.ts`（新） | 小规模（3 天）不变量；真实函数 + fake clock |
| `plugin/test/retention-changes.test.ts`（新） | 新文件计入容量/保留；active 最新/90 天引用/未完成或显式 journal 引用受保护；上限不误清 |
| `plugin/test/rollback-compat.test.ts`（新） | checkpoint 时点无损；兼容导出损失清单；不复活已停用内容 |
| `plugin/test/checkpoint-bounded.test.ts`（新） | 连续 ≥5 次迁移/回滚；checkpoint 数量/字节有界、无嵌套、活跃唯一备份保留 |
| `plugin/test/history-prune.test.ts`（新） | >90 天普通历史可收缩；active 最新/窗口内/引用闭包/stopped tombstone 保留 |
| `plugin/test/suppression-tombstone.test.ts`（新） | 必要 tombstone 超限 blocked；同 source 不重新学习 |
| `plugin/test/changeid-hash.test.ts`（新） | 业务字段不改；changeID 可授权新增/修复；business/store hash 分离；undo 完整恢复 |
| `plugin/test/capacity-policy.test.ts`（新） | P03 policy 内后台回收；无冷数据 blocked；保护项不动 |
| `plugin/test/checkpoint-cas.test.ts`（新） | 分域漂移拒绝；另存恢复；不覆盖新编辑 |
| `plugin/test/retention-counters.test.ts`（新） | preview/capacity counts/bytes/id 与磁盘体积证据 |
| `plugin/test/host-m7-literal.test.ts`（新，执行时） | 真实 host 字面 context/停用/相邻块保留/ambiguous blocked 证据 |
| `plugin/test/n2-invalidate.test.ts`（新，fix2 复核后） | maintenance 放大与 undo 不复活无效上游 |
| `plugin/test/n3-ledger-scale.test.ts`（新） | 2000+300 / 5000 上限规模耗时；不提前重构 |
| `plugin/test/host-acceptance.test.ts`（新，执行时按需） | 隔离 env/fake provider/recorder 的契约测试（不启动真实 host 时只做静态断言） |
| `docs/goals/full-auto-memory/reports/06-rehearsal.md`（执行时） | 隔离演练记录、命令、退出码、日志路径、未验证项 |
| `tmp/full-auto-memory/verification/*` | 原始日志/截图（不提交） |

## 迁移工具契约

```bash
node scripts/full-auto-memory-migrate.mjs \
  --data <isolated-dir> \
  --checkpoint <separate-checkpoint-root> \
  --dry-run | --apply --confirm <fingerprint> | --undo <migration-id> | --status

node scripts/full-auto-memory-rollback.mjs \
  --checkpoint <separate-checkpoint-root>/<migration-id> \
  --target <new-isolated-dir> \
  --restore | --compat-export [--confirm-losses]
```

### 路径守卫（先于任何读取）

1. `--data` 必须已存在且为目录；`realpath` 后若等于/位于真实 `~/.config/opencode/memory/autopilot`、`~/.config/opencode`、`/`、home 根 → 退出码 **2**，不读取任何文件。
2. 允许范围：`mkdtemp` 目录或本 worktree `tmp/**`；其他路径必须 `--allow-dir`，但 `--allow-dir` 仍拒绝真实路径。
3. 符号链接：对 data/checkpoint 均做 realpath；指向禁止路径 → 退出码 2。
4. `--checkpoint` 根必须在 `--data` 之外；realpath 后若位于 `--data` 内 → 退出码 2（防嵌套/自引用）。
5. 脚本先做纯字符串+realpath 守卫，再 `Store.init()`；测试用注入的 `forbiddenRoot` + fs spy 断言“未发生读取”。
6. **不复用** `scripts/openmem-migrate-scopes.mjs` 的默认 `dataDir`/port：它默认指向真实 `autopilot`；P06 只参考其“备份+journal+事务”模式，不调用该脚本。
7. 任何错误信息只含路径类别/退出码，不回显正文、token、配置内容。

### Fingerprint

- `sha256` over canonical JSON：`toolVersion`、`dataSchema`、`options`、每个输入文件相对路径+sha256、排序后的 proposals、config patch；排除 mtime、token、日志、`console-token`。
- 输出 64 hex；`--apply` 的 `--confirm` 必须逐字相等，否则退出码 **3**，零写入。
- 同一输入状态重复 dry-run 必须得到同一 fingerprint；文件变化/提案变化必须变化。
- `--status` 只读 journal 摘要（id/status/counts），不读正文。

### 提案分类（逐行，不含正文）

| 分类 | 条件 | 动作 |
|---|---|---|
| `keep_protected` | rule/safety/protected、manual、promoted、无法确定 | 保持 queue 原样 |
| `keep_missing_project_key` | scope=project 但无 `projectKey` | 保持原样；不猜 key |
| `adopt_descriptive` | 描述性 kind、无冲突、身份字段完整 | 同 id 写入 items，`status:"queue"`（不注入），同事务移除该 queue 行 |
| `quarantine_uncertain` | 不确定/冲突/过长/TTL | 写 `quarantine.jsonl`（若 P03 已交付），同事务移除 queue 行；否则保持 queue |
| `skip_duplicate` | 与已有 item/queue 精确重复 | 保留原行，不删除 |
| `skip_invalid` | 缺 id/kind/scope/source 或非法 scope | 保留原行，报告 |
| `skip_dangling_change` | `changeID` 指向不存在事件 | **默认阻断 apply**（退出码 6）；仅显式 `--repair-dangling-change` 才补基线并替换指针 |
| `skip_invalidated_upstream` | `invalidatedBy` 上游缺失/无效 | 保持失效状态；不清标记、不复活 |

规则：

1. **业务字段原样保留**：`id/title/text/kind/scope/projectKey/project/source/sources/createdAt/updatedAt/manual/expiresAt/aliases/derivedFrom/supersedes/supersededBy/invalidatedBy` 不得被迁移改写；`adopt` 不重新分类 scope，不补造 projectKey。
2. 只对 `status=auto|promoted` 的 active item 补基线事件；已有任何事件 → `keep_history`。
3. 基线事件：`kind:"migration"`、`actor:"migration"`、`origin:"migration"`、`before=after=itemSnapshot(item)`、`reason:"baseline:<toolVersion>"`；必须走 P01 `recordChange`/`stampChange`，禁止手写事件。
4. **审计字段可显式新增/修复**：`changeID` 是审计指针，不是业务字段；基线可为无 `changeID` 的行新增，`--repair-dangling-change` 可在显式授权下修复悬空值；除 `changeID` 外不得改业务字段/`updatedAt`。不得无授权重写已有 `changeID`。
5. 配置只补：`automation.enabled=false`（不存在时）、`undo.retainDays=90`（不存在时）；已有值一律保留，尤其不得把 `automation.enabled=true` 改成 false 后声称“未启用”。
6. 不批量删除；`adopt/quarantine` 的 queue 行移除必须在同一事务、可由 undo 恢复；`skip/keep` 不删。
7. 所有输出不含正文/凭据；日志只记 id/类别/计数/fingerprint。
8. **两种 hash 分开**：`businessStateHash`（items 业务字段 + queue + config，排除事件 id/时间戳/审计 `changeID`）用于判断迁移是否改业务内容；`storeStateHash`（含 changes/suppressions/journals/审计字段的完整逻辑状态）用于 undo/CAS。基线只应改变 `storeStateHash` 与 `changeID`，不得改变 `businessStateHash`。

## Apply / Undo / 幂等 / 断电

### Apply

1. `Store.init()` 先恢复 `.pending-transaction.json`；任何残留 WAL 未恢复则中止。
2. **先写外部 checkpoint**：`--checkpoint` 根必须在 `--data` 之外（realpath 校验），按显式 manifest 复制“运行状态 + 被引用历史”，不复制任何既有 `backup/checkpoint-*`、不复制自身；写临时目录 → fsync → 原子改名。崩溃只会留下完整或不存在的外部 checkpoint，不改数据。
3. 在 `store.transaction` 内重新校验输入文件 hash，且必须与 checkpoint manifest 的 source hash 一致（防 dry-run/checkpoint 后漂移；不一致退出码 4、零写入，checkpoint 成孤儿）→ 写 `migrations/<id>.json`（`status:"applying"`，含 before/after 的**分域** hash、checkpointID/checkpoint 内容 hash、`beforeExists`/`afterExists`、proposals、config patch）→ queue/items/quarantine 变更 → 基线事件 → `changelog` 的 `migration` 记录 → journal `status:"applied"`。
4. checkpoint 与数据**不是同一 WAL**：checkpoint 是外部、不可变工件；数据事务失败/回滚时 checkpoint 成为无引用孤儿，只能由 checkpoint GC 清理，不得在被 journal 引用时删除。
5. manifest 必须记录“迁移前不存在的文件”（迁移新建的 `changes.jsonl`/`change-journal/`/`quarantine.jsonl` 等），undo 时据此删除，不能只恢复已有文件。
6. 提交后重读并校验分域 `after` hash（items/queue/config/changes/suppressions/change-journal/quarantine 各自 + 汇总）；不符 → 抛错回滚 batch，退出码 **5**。
7. 退出码：0 成功/已应用/无需变更；2 路径拒绝；3 fingerprint 不符；4 并发/版本漂移；5 校验失败；6 兼容性阻断（dangling/invalidated/scope 历史等）。

### Undo

1. 必须给出 `<migration-id>`；`status` 必须是 `applied`（`applying`/`undoing` 由恢复流程处理，不直接 undo）。
2. **分域 CAS**：逐域比较 `items/queue/config/changes/suppressions/change-journal/quarantine/migrations` 的 per-file hash + `storeStateHash`/`businessStateHash` + 行数/事件数；不能只看 config 或一条总 hash。任一域漂移（迁移后新用户编辑/新事件）→ 退出码 **4**，零写入，列出漂移域。
3. 无漂移时，同一事务恢复 checkpoint 的完整文件集（含删除迁移新建的文件），恢复 config/items/queue/changes/suppressions/quarantine/change-journal/migrations；**排除当前 `migrations/<id>.json` 与任何 checkpoint 目录**，最后单独把当前 journal 写为 `undone`/`undoneAt`，保留审计记录；不得在恢复过程中丢掉 journal 或 checkpoint。
4. 二次 undo → 退出码 **6**，不写；undo 不删除 checkpoint。
5. 漂移时**不允许**覆盖当前数据：只能 `--restore-to-new-dir` 把 checkpoint 恢复到新目录，或生成差异导出；不提供 `--force`。
6. “无损”只指 checkpoint 时点的完整逻辑状态；checkpoint 之后的新用户编辑不在恢复范围，必须显式告知。

### apply → undo → 再 apply 幂等

- 再 apply 使用同一 fingerprint；必须得到同一 `businessStateHash` + 同一基线语义集（每 item ≤1 条 `migration:baseline:<toolVersion>`；事件 id/时间戳除外）。
- 不要求事件 id/时间戳字节相同（P01 `newChangeID` 随机）；要求事件**数量与语义**不重复。
- 测试断言：第一次 apply 后 baseline 数 = active 无历史 item 数；undo 后 `storeStateHash` 回到 checkpoint before；再 apply 后 `businessStateHash` 相同、baseline 数不变、无重复、queue/config 同 hash。
- 若 undo 后数据被外部改动，再 apply 必须按新 fingerprint 重新 dry-run，不能复用旧确认。

### 断电 / WAL 恢复

- 复用真实 `commitFileBatch`/`recoverFileBatch`，不自写 WAL。
- 崩溃测试沿用现有 transaction 测试方式：monkeypatch `fs.rename`，在真实 rename 边界 `process.exit(73)`；每个边界后新开 `Store.init()`，断言：
  - 要么 old state + 无 migration journal，要么 new state + 完整 journal；
  - 不出现“queue 已改、items/事件未写”或“事件已写、item 未改”；
  - 恢复后可继续 `--status`，再 undo/apply 成功；
  - 不出现重复 baseline 事件。
- 额外测试：手工写入合法 `.pending-transaction.json` 后 `init()` 必须重放并删除 WAL；非法 WAL 保留原文件并报错，不猜测。

## 回滚兼容（承接 P01 review §4）

### 优先级 1：checkpoint 时点的完整逻辑状态（唯一可称“时点无损”的路径）

“无损”严格限定为 **checkpoint 创建时点**的完整逻辑状态；checkpoint 之后的新用户编辑不在范围内，不能宣称回滚会保留它们。

Checkpoint 位于 `--data` 之外的独立根；manifest **显式列出**要复制的“运行状态 + 被引用历史”，不递归扫描、不把既有 checkpoint/backup 当普通源：

| 类别 | 文件/目录 |
|---|---|
| 运行状态（必选） | `items.jsonl`、`queue.json`、`state.json`、`config.json` |
| 账本（必选） | `changes.jsonl`、`suppressions.jsonl`、`change-journal/`、`quarantine.jsonl` |
| 迁移/历史（显式） | `migrations/*.json`、`merge-journal.jsonl`、`changelog.jsonl` |
| 被引用历史（仅被 protectedChanges/Journals 引用） | `recovery/*.json`、`maintenance/*.json`、`curator/*.json`、`session-archive/*.json`、对应 `.bak` |
| 清单 | `manifest.json`（每文件 sha256/bytes/count、toolVersion、sourceFingerprint、createdAt、`absent`、`referencedBy`） |

- **排除**：`console-token`、任何凭证、`AUTO_MEMORY.md`/`AUTO_RULES.md` 等可重建视图；**排除所有既有 checkpoint/backup 目录**，禁止嵌套。
- 缺失文件在 manifest 中标 `absent`，不伪造空文件；undo/restore 时按 absent 删除或保持不存在。
- 恢复目标必须是**新的隔离目录**；目标非空 → 拒绝，不覆盖。恢复后校验 manifest，再让用户显式切换 `dataDir`；工具不删除原目录。
- 恢复后必须能读回：items 业务字段/scope/source、事件、抑制、journal、配置版本；审计 `changeID` 按 checkpoint 时点恢复。
- **旧 checkpoint 管理**：只保留 (a) 被 `applying/undoing` 或迁移回退窗口内已应用 journal 引用的 checkpoint；(b) 最近 N=3 个已完成 checkpoint；(c) 显式 `--pin-checkpoint` 的 checkpoint。迁移回退窗口默认 `undo.retainDays`（90 天），pin 可延长。已完成且超出窗口/未被引用的 checkpoint 可按依赖闭包裁剪；**不得以“所有 undone=false 的 journal”永久保留**。若待删 checkpoint 是某个活跃回滚 journal 的唯一备份 → 保留并报 `checkpoint_retention_blocked`。

### 优先级 2：兼容导出（默认不写，必须显式报告损失）

当没有 checkpoint 时，只能生成**旧版可读导出**，并输出 `downgrade-report.json`；默认不覆盖源目录。

必须逐项报告：

1. **`changeID` 悬空**：删账本后 item 仍带 `changeID`，旧代码不读但再升级时 `revertChange/restoreVersion` 会 `not_found`。
2. **`invalidatedBy` 被旧版忽略**：旧代码会重新注入这些行；再升级 P01 又会排除，且按 I1 只能显式逐项恢复。
3. **`status=archived && supersededBy="deactivate"`**：旧版 retention 没有 P01 的保护，90 天后会清理；“停止使用无时限”在旧版**无法承诺**。
4. **`derivedFrom`/派生关系**：旧版不识别，导出后派生失效/恢复语义丢失。
5. **scope 迁移前的历史快照**：`restoreVersion` 要求 `snapshot.scope === current.scope` 且 projectKey 相等；迁移过 scope 的 item 旧历史一律 `not_revertible`，必须单独导出旧 scope 历史并标注“不可原地恢复”。
6. **suppressions/事件历史**：导出后不再参与抑制/撤销；清理只影响防重学，但不能宣称“历史仍可撤销”。

硬规则：

- **禁止**通过剥 `invalidatedBy/derivedFrom/changeID/supersededBy` 让旧版重新注入；这会造成“用户已停止的内容复活”。
- 兼容导出如必须让旧版不注入，只能把失效/停止行转为旧版可识别的非注入状态（`status:"archived"`），并在报告中明确：旧版仍可能在 90 天后清理，**不是无损**。
- 无 `--confirm-losses` 不写；有确认也只写新目录，不改源。
- 任何兼容损失必须在 `06-rehearsal.md` 与最终报告显式列出；不得用“回滚成功”概括。

### P01 新字段对旧版语义的影响（裁决）

| 字段/状态 | 旧版行为 | 回滚风险 | P06 处理 |
|---|---|---|---|
| `changeID` | 忽略 | 悬空引用；升级后撤销 `not_found` | checkpoint 恢复；否则报告并阻断“无损”声明 |
| `invalidatedBy/invalidatedAt` | 忽略 → 重新注入 | 已失效内容复活 | 不剥；旧版导出转 archived（仍非无损）并报告 |
| `derivedFrom` | 忽略 | 派生失效/恢复链丢失 | checkpoint；否则报告 |
| `supersededBy="deactivate"` | 旧 retention 不保护 | 90 天后被清理 | checkpoint；否则报告“停止无时限不可承诺” |
| `status=archived` + 新事件 | 只按 archived 处理 | 停止原因/可恢复性丢失 | 保留事件；旧版导出报告 |
| scope/projectKey 迁移 | 旧快照 scope 不匹配 | 迁移前历史不可恢复 | P06 默认不改 scope；单独 scope 工具须导出旧历史并显式接受损失 |

## Retention / Capacity

实现状态（2026-11-16，单元 1）：`previewRetention/applyRetention`、`capacityStatus.counts`、P03 `runMaintenanceTick` 已按本节实接；保护闭包与 blocked 口径见 §0.1。测试/soak/演练与迁移脚本未执行，下一单元处理迁移/回滚工具。

### 原则

1. 上限是**保留策略**，不是让 active 记忆失去撤销。
2. 新文件必须计入 `previewRetention` 的 counts/bytes 与 `id` hash；`dirSize()` 已统计全部文件，`capacityStatus.counts` 增加可观测计数，容量公式不另造。
3. 受保护依赖不可清理；到上限仍无法清理时**停在上限并报告**，不得误删保护项。
4. **两条清理路径并存**：P03 `runMaintenanceTick` 在既有已批准 policy 内可后台安全回收——过期 auto item（`expiresAt`）、exact 去重、quarantine TTL、shadow/hook caps、派生历史（changes/suppressions/change-journal）超上限/超期且无保护项；不需要每天生成人工待办。**硬删除/超 policy/真实数据部署**仍走显式 preview+confirm。高级手工清理保留，但不是普通容量恢复的唯一路径。
5. 没有可安全回收数据时，如实 `blockedReason/retryAt` + `reclaimable` 计数；不得假称“永不阻断”或“自动运行”。

### 保护集合（transitive）

```text
protectedChanges =
  每个 active item（auto/promoted，含 invalidated）的最新事件
  ∪ at >= now - undo.retainDays 且 before/after 完整的事件
  ∪ item.changeID 指向的事件
  ∪ 从上述事件沿 dependsOn/reverts 传递闭包
  ∪ 实际未完成事务（undoing/applying/restoring 或存在 WAL）引用的事件
  ∪ 迁移回退窗口内/显式 pin 的已应用 journal 引用的事件

protectedJournals =
  undoing/applying/restoring 或存在 WAL 的 journal
  ∪ changeID 在 protectedChanges 的 journal
  ∪ 迁移回退窗口内/显式 pin 的已应用 journal
```

- active item 的最新事件即使 `revertible=false`（如 migration baseline）也保护；否则“可停止使用”的历史会先被清掉。
- `restoreVersion` 只看 `event.at` 与 `retainDays`；P06 必须保护窗口内所有可回退事件，不只最新一条。
- **已完成且窗口外**的普通事件/journal 不因 `undone=false` 自动永久保护；按依赖闭包安全裁剪，只删“无 active 最新/无 90 天窗口/无显式引用/无未完成事务”的项。删事件前先删/保留对应 journal，不能留下指向已删快照的引用。
- **suppression tombstone**：`until` 未到、或 `itemID` 仍是 stopped/reverted 来源的，必须保留；不得因 2000 条/90 天到期就让同一 source 重新学习。只有 `until` 已过且无 stopped/reverted item 依赖的 suppression 才可清。必要 tombstone 超过 2000 → `retention_blocked`，不误删。
- quarantine：TTL（默认 72h）/200 上限；到期删除 + `quarantine_expired` changelog；不注入、不承载 active 撤销。
- 迁移 journal：`applying/undoing` 永不清理；`applied` 只在迁移回退窗口内/被 pin/仍有 checkpoint 依赖时保护；超出窗口后可作为审计元数据保留少量（最近 N），但**其 checkpoint 不再因“undone=false”永久保留**。

### 保留/容量矩阵

| 文件/目录 | 上限/保留 | 受保护依赖 | 清理前置 | 失败行为 |
|---|---|---|---|---|
| `items.jsonl` | 现有 items caps + 90 天归档 | active 最新/90 天引用/manual/promoted/rule | policy 内过期/精确去重可后台回收；超 policy/硬删除显式 preview+confirm | 停在上限，报告 |
| `changes.jsonl` | 5000 条 / 90 天 / 每 item 20 | 上述 protectedChanges | 仅删最旧、无引用、非保护、已完成且窗口外 | 保留保护项，`retention_blocked` |
| `change-journal/*.json` | 与 changes 对齐 + 90 天 | protectedJournals | 仅删已完成且窗口外/无引用；未完成/引用项保留 | 保留引用项 |
| `suppressions.jsonl` | 2000 条 / `until` / 90 天 | stopped/reverted source tombstone + protected item | 仅删 `until` 已过且无 stopped/reverted 依赖 | 必要 tombstone 超限 → `retention_blocked` |
| `quarantine.jsonl` | 200 条 / TTL 72h | 无 active 依赖 | 到期/超上限最旧 | 记录 changelog，不复活 |
| `migrations/*.json` | 最近 3 次 + 回退窗口内/ pin + 未完成 | 当前 apply/undo 链 | 已完成且窗口外、无 checkpoint 依赖 | 保留唯一备份 |
| `backup/checkpoint-*` | 最近 3 份 + 活跃回退 journal 引用 + pin | 未完成/窗口内迁移 | 超 N/无引用/窗口外 | 永不删被活跃 journal 依赖的唯一备份 |
| `recovery/maintenance/curator/session-archive` | 现有 90 天/最少 20 | 现有引用链 | 显式 preview+confirm | 保持现有保护 |
| 验证日志/截图 | 按阶段/日期/数量有界 | 无 | 手动/脚本清理 | 不提交；不占 dataDir |

### 容量接线

- `previewRetention` 新增字段：`pruneChanges`、`pruneChangeJournals`、`pruneSuppressions`、`pruneQuarantine`、`protectedChanges`、`protectedJournals`、`historyBytes`；`id` hash 包含新文件内容。
- `applyRetention` 只删 preview 列出的项；删除后写 `retention` changelog（计数，不含正文）。
- `runMaintenanceTick`（P03 W1/W4/W5/W7）先按 P03 既有 policy 做安全回收（`runCurator(force)` 过期 auto/exact 去重、`expireQuarantine`、shadow/hook caps），再调用 `pruneManagedHistory(store, now)` 修剪派生历史；写 `retention_auto`/`curator` changelog；失败只记录，不阻塞对话。不得硬删 manual/promoted/rule/stopped 项，不得硬删 sessions/merges/changelog；超 policy 的硬删除仍走 preview+confirm。
- `capacityStatus.counts` 增加 `changes/suppressions/quarantine/changeJournals/migrationJournals/checkpointBackups`；`diskBytes` 已含新文件；95% freeze/85% compact 语义不变。到 freeze 时先回收派生历史，再复检；仍不足则如实 `blockedReason/retryAt` + `reclaimable`，不宣称自动运行。
- 测试：构造小 caps/小上限，验证“上限到达时保护项仍在”；验证 `previewRetention.id` 随 `changes.jsonl` 变化；验证自动修剪不影响 `restoreVersion` 90 天窗口、不影响 active 最新事件、不影响未完成 journal。**连续 ≥5 次 apply/undo/再 apply** 后 checkpoint 数量/字节有界、无嵌套、无几何增长，且活跃回退 journal 的唯一 checkpoint 未被删。

## soak-30d

```bash
npm --prefix plugin exec -- tsx ../scripts/soak-30d.mjs --days 30 --sessions 120 --seed 42 --data <isolated-dir>
```

### 真实性要求

- **调用真实生产函数**：`Store`/`transaction`/`recordChange`/`memoryVersion`、`runConsolidation`、`decideAutomation`、`runMaintenanceTick`、`runCurator`、`expireQuarantine`、`previewRetention/applyRetention`、`capacityStatus/admitAutoWrite`、`takeAutomationSlot`、`deactivateItem/reactivateItem/revertChange/restoreVersion/invalidateDerived`。
- 禁止在 soak 内重写 `consolidate`/`decide`/`expire`/`budget` 逻辑；只允许编排调用与断言。静态门禁：脚本内不得出现同名本地函数实现；import 列表必须来自生产模块。
- **fake clock**：使用生产函数已支持的 `now` 注入（`Store` 构造/`runCurator({now})`/`runMaintenanceTick({now})`/预算 `now`）。若某生产函数拒绝注入时钟，**阻塞并报告**，不得 monkeypatch 全局 `Date` 或另写时钟层。
- 合成数据用确定性 seed；不调用真实模型；不读写真实数据；不 sleep 30 天。
- 输出 `reports/soak-30d.json`：`simulated:true`、`fakeClock:true`、`seed`、`days`、`sessions`、`toolVersion`、开始/结束、生产模块列表、不变量结果、失败样本 id、`retentionCounts`、`capacityMax`。
- 报告/控制台/文档三处标注 `simulated`；**不得出现“30 天真实运行通过”**。

### 不变量（在 phase 原有 10 条上补充）

1. 无 rule/skill/safety 自动写入。
2. 无重复 active（exact/covered 去重后）。
3. 每条 auto item 有 change 事件且可停止使用。
4. 容量/日预算有界，95% 冻结生效；回收后恢复。
5. 无跨 project/session 注入/召回泄漏。
6. 隔离 TTL 到期清理。
7. 撤销后同源不再重学；新纠正可学。
8. 递归失效/环保护不无限循环；恢复不激活无效上游。
9. 保留策略不删除 active 最新可逆事件；日志/副本有界。
10. 无未处理异常/未捕获 rejection。
11. **retention 保护与收缩**：protectedChanges/protectedJournals 零删除；已完成且窗口外的普通历史可收缩；stopped/reverted source tombstone 不因 2000/90 天被清后复活；必要项超限时 `retention_blocked` 而非误删。
12. **重启/WAL**：模拟日随机重开 `Store`，无重复事件、无半状态、`init()` 恢复成功。
13. **I1 裁决**：上游 deactivate → 子项不注入；上游 restore → 子项仍不注入；显式恢复子项后才注入，且各写事件。
14. **scope 隔离**：project A 的召回/上下文不出现在 project B。
15. **备份有界**：连续 ≥5 次迁移/回滚后 checkpoint/backup 数量与字节有界、无嵌套、无几何增长；活跃回退 journal 的唯一备份未被删。
16. **无“假自动”**：`effectiveMode` 与真实写入一致；shadow 不写；冻结/预算拒绝不冒充成功；无可安全回收数据时如实 blocked。

### 小规模测试

- `soak.test.ts` 跑 3 天：同一生产函数、同一 fake clock、同一不变量断言；快速、确定性。
- `soak-30d.mjs` 与测试共享编排模块（`scripts/soak-core.mjs` 或脚本导出函数），禁止两份逻辑漂移。
- 断言 `simulated:true` 且 `days` 为模拟值；断言总耗时不依赖真实 30 天。

## 真实 V2 host + 本地 fake provider（隔离验收）

### 已观察证据（本次只读）

| 项 | 证据 | 结论 |
|---|---|---|
| CLI | `opencode --version` → `v2.1.1`；`opencode --help`/`run --help` | 已安装；`run --standalone`、`--model` 可用 |
| 插件加载 | 官方 V2 `/v2/docs/build/plugins`：`.opencode/plugins/` 自动；`plugins` 数组支持绝对路径/目录/包 | 可用隔离配置的 `plugins` 指向本 worktree 构建产物 |
| Provider | 官方 V2 `/v2/docs/providers`：`providers.<id>.package` + `settings.baseURL` + `models`；OpenAI-compatible 包 | 可接本地 HTTP fake provider |
| 本地类型 | `@opencode/plugin` `SessionHooks.context`/`SystemPart`；`@opencode/schema` `ConfigPlugin`/provider config | hook/配置形状与 P01/P04 预检一致 |
| 路径隔离 | 安装包字符串可见 `XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_CACHE_HOME/XDG_STATE_HOME` 分支；`OPENCODE_CONFIG_DIR/OPENCODE_CONFIG/OPENCODE_DB`；`OPENCODE_DISABLE_MODELS_FETCH` | 有隔离手段；**未实跑验证** |

### 隔离启动矩阵（执行时）

| 变量 | 值 | 目的 |
|---|---|---|
| `HOME` | `tmp/full-auto-memory/host-<id>/home` | 防 `os.homedir()` 旁路；隔离 shell/Claude/技能扫描 |
| `XDG_CONFIG_HOME` | `.../xdg/config` | 全局 `opencode` 配置 |
| `XDG_DATA_HOME` | `.../xdg/data` | DB、auth、插件数据 |
| `XDG_CACHE_HOME` | `.../xdg/cache` | 缓存 |
| `XDG_STATE_HOME` | `.../xdg/state` | 状态 |
| `OPENCODE_CONFIG_DIR` | `.../xdg/config/opencode` | 与 XDG 对齐，防两套路径 |
| `OPENCODE_CONFIG` | `.../xdg/config/opencode/opencode.jsonc` | 只读隔离配置 |
| `OPENCODE_DB` | `.../xdg/data/opencode/opencode.db` | 隔离会话 DB |
| `OPENCODE_DISABLE_MODELS_FETCH=1` | 禁默认模型目录网络 | 离线 |
| `OPENCODE_DISABLE_AUTOUPDATE=1` | 禁自更新 | 无网络副作用 |
| `OPENCODE_DISABLE_CLAUDE_CODE=1` | 禁真实 home 的 Claude 技能 | 防旁路 |
| `OPENCODE_DISABLE_PROJECT_CONFIG=1` | 禁项目 `.opencode` 自动配置 | 防读到本仓库/真实项目配置 |

执行前先跑 **隔离 env 下的** `opencode debug paths`（只打印路径，不读配置内容），断言四个 path 全部落在临时根内；任一落在真实 home/config/data/cache/state → **立即阻塞**，不启动 host，不猜替代路径。

### fake provider 协议

- 本地 `127.0.0.1:<random>` HTTP 服务；OpenAI-compatible `POST /v1/chat/completions`，`stream:true` 返回 SSE（`data: {...}` + `data: [DONE]`）；可选 `GET /v1/models`。
- 配置：

```jsonc
{
  "providers": {
    "fake": {
      "name": "Fake",
      "env": ["FAKE_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:<port>/v1", "apiKey": "fake" },
      "models": { "fake-chat": { "name": "Fake Chat" } }
    }
  },
  "model": "fake/fake-chat",
  "plugins": ["<worktree>/plugin"]
}
```

- 服务端把每次请求体原样落盘到 `tmp/.../requests/<n>.json`（含 `messages`/system 内容），并返回确定性短文本；不调用真实模型、不出网。
- 若自定义 provider 在无 `/connect` 时仍要求真实凭证，或 SSE 形状不被接受 → 记录**阻塞**；不得改用真实 provider/真实网络。

### 插件加载

- 执行阶段先 `npm run build` 产出 `plugin/dist/index.js`（P06 允许的构建），`plugins` 指向 `<worktree>/plugin`，走 package `exports`。
- 测试 harness 插件放 `tmp/.../recorder-plugin/server.ts`（不提交、非产品代码），在 memory 插件之后注册 `context` hook，把 `event.system` 的每个 part（type/text/hash/metadata key）写入 `captures/<n>.json`，用于证明 owned part 与宿主 part 的边界。
- 若宿主要求插件为 `.opencode/plugins/` 目录形式，则用隔离项目根下的 `.opencode/plugins/recorder` + 全局 `plugins` 指向本 worktree；不把任何文件写入真实 home。

### 真实请求验收（M7 证据门禁）

必须用真实 host + 本地 fake provider 捕获**实际出站请求**；recorder 只作旁证，不能替代 provider 请求体。先记录本次宿主形状：`metadata_recorded`（有 `metadata.experimental.instructions` 记录） / `wrapper_only`（只有精确 `<context key=...>` wrapper） / `neither`（两者都无）。`neither` 或无法判定 → **最终验收 blocked**，不得以 fake host/单测结论替代。

必须构造并执行：

1. 请求 1（同一 session）：seed 一个 active item（唯一 sentinel），并让旧 owned 块正文**夹带字面** `<context key="fake">INNER</context>` / `</context>`；fake provider 收到的 system 中存在插件 owned 块，且含 sentinel。
2. 通过隔离 API（Bearer token 从隔离 dataDir 读取）停止该 item；不重启 host。
3. 请求 2（同一 session，新 prompt）：fake provider 实际请求中的 **owned 块不含 sentinel/撤销正文**；recorder 捕获的 owned SystemPart 同样不含；不得出现“API 已停用但下一请求仍注入”。
4. **宿主相邻块逐字保留**：非 owned system parts（尤其紧邻的 `<context key="host">HOST</context>`）的文本/hash 与请求 1 一致；不得因 fallback 误删宿主块。
5. **原始聊天逐字保留**：`messages` 中请求 1 的用户文本、宿主 other parts 不被插件改写/删除。
6. **无 ambiguous/残留**：若出现 `context_ambiguous`、旧正文残片、或 owned 块仍含撤销内容 → 直接判**最终验收 blocked**；不得以 warning、降级或 fake host 结果放行。
7. **两通道转义一致**：`entry.put` 的 value 与当次 `event.system` 渲染必须使用同一转义语义（`<context`/`</context>` 不形成裸标记）；若 `entry.put` 仍未转义、或宿主自行渲染 entry 且不记录 metadata → 在真实 host 证明安全前 blocked。
8. 无重复 owned part；空文本时只删自己的块，不删宿主块。
9. 若真实宿主渲染形状无法定位 owned part：记录 **unlocated** 失败，不以 fake host 结果替代。

### M7 边界歧义（fix2 未闭环前）

`reports/01-review.md` §7.1.1 已实测：无 metadata、只有精确 wrapper、正文含字面 `<context ` 时，旧 fallback 会留下残片（A）或删除其他宿主 part（B/B2）。P06 的验收必须覆盖该形状：

- 允许 fix2 在歧义时**保留原 part、不删宿主**并写一条有界 `context_ambiguous`；但“保留旧块”**不等于**“下一请求已排除”。
- 因此只要真实 host 出现 ambiguous/残留，就按失败处理；不能把“安全保留”当作功能通过。
- 修复后仍需真实 host 证据；P06 不重做 M7 review、不读在改源码。

### N2 / N3 交接

- **N2（未解决，不得视为已解决）**：`invalidateDerived` 批量写可能产生 `maintenance_<id>.json` + 完整 `items.jsonl.bak`，并留下 `POST /api/maintenance/<id>/undo` 旁路；若 undo 复活“上游仍停用”的下游，属于语义失败。P06 在 fix2 复核后必须验证：停用有后代时无异常磁盘放大；maintenance undo 不得激活无效上游；否则最终验收 blocked。
- **N3（deferred，P06 规模验证）**：`recordChange` 重复 id 检查当前 O(events×ledger)；实测 2000 条账本 + 300 子项约 592ms。P06 在 5000 条上限附近做规模测量并记录耗时/事件数；**不提前重构**。若接近上限导致超时/不可接受，报告为规模阻塞，不静默放宽。

### 阻塞规则

- 任一隔离变量无法证明生效、`debug paths` 落在真实目录、fake provider 不被接受、插件未加载、真实请求未发出 → 在 `06-rehearsal.md` 标 `blocked`/`not-run`。
- **不得**用 fake host / 单测结果冒充真实端到端通过；不得为了跑通而读取正式 config 或使用真实 key。

## 正式 UI 浏览器验收

- 使用真实浏览器（Playwright/Chromium，外部 runner，不新增仓库依赖），**真实 360×800 viewport**，移动 UA + touch；不是 device toolbar 的画布列。
- 页面：`#memory`、`#activity`、`#settings`；详情 sheet；行内停止/恢复/撤销；旧深链重定向。
- 断言：
  1. `document.documentElement.scrollWidth <= 360`，无横向滚动；分段/表格不裁切。
  2. rail **260 与 320** 两种宽度分别测：可点目标 ≥44×44；标题换行；基本动作常显，不靠 hover。
  3. 明/暗双主题：状态 chip、badge、危险按钮对比度 ≥4.5:1；无硬编码颜色；`var(--primary)` 类无效 token 不出现。
  4. keyboard：Tab 顺序、Escape 关 sheet、焦点回到触发行、无焦点陷阱；所有动作可键盘完成。
  5. 可恢复：停止一条 → 刷新同会话 → 仍不出现；“最近操作”出现恢复；恢复后重新出现；刷新后仍在。
  6. 无“仅恢复文本”冲突入口；活动页无“待确认”徽标。
- 记录：截图 + DOM/axe 结果 + 视口尺寸，放 `tmp/full-auto-memory/verification/ui/`；**`reports/ux-visual-preview.md` 是样稿，不算正式验收**。
- extension rail 若无法在真实扩展运行时加载 → 标 `blocked`，不得用独立 HTML 冒充扩展通过；若 Playwright/Chromium runner 不可用，同样 `blocked`，不新增仓库依赖。

## 生产函数驱动矩阵

| 测试/脚本 | 必须调用的真实入口 | 关键断言 |
|---|---|---|
| `migration-auto.test.ts` | 脚本导出的 `planMigration/applyMigration/undoMigration/assertIsolated`；`Store.transaction`；P01 `recordChange`/`stampChange`；`store.patchQueue`/`appendItem`/`writeChangeJournal` | 业务字段/scope/source 逐字段不变；changeID 按授权新增/修复；dry-run 零写入；fingerprint 复现；apply 只补基线/提案；undo 恢复；二次 undo 报错；再 apply 无重复 baseline |
| `migration-crash.test.ts` | `Store.init`、`commitFileBatch`、`recoverFileBatch`、真实 `fs.rename` 边界 | 每个边界后全成或全不成；无半状态/重复事件；恢复后 status/undo/apply 可用 |
| `rollback-compat.test.ts` | `full-auto-memory-rollback.mjs` 的 `restoreCheckpoint/exportCompat`；manifest 校验 | checkpoint 时点 items/事件/抑制/config 版本逐项一致；兼容导出损失清单完整；不复活已停用内容 |
| `retention-changes.test.ts` | `previewRetention`、`applyRetention`、`capacityStatus`、`dirSize`、`runMaintenanceTick`（P06 新增 `pruneManagedHistory`） | 新文件计入 bytes/counts/id；保护项零删除；窗口外可收缩；90 天窗口可用；超上限 `retention_blocked`；active 最新事件仍在 |
| `soak.test.ts` / `soak-30d.mjs` | `Store`/`transaction`、`recordChange`、`memoryVersion`、`runConsolidation`、`decideAutomation`、`runMaintenanceTick`、`runCurator`、`expireQuarantine`、`previewRetention/applyRetention`、`capacityStatus/admitAutoWrite`、`takeAutomationSlot`、`deactivateItem/reactivateItem/revertChange/restoreVersion/invalidateDerived` | 16 条不变量；fake clock；无 toy 状态机；I1 显式恢复；scope 隔离；WAL 重启；备份有界 |

## 主代理补正 rulings（2026-11-11）

| # | 裁决 |
|---|---|
| R13 | **checkpoint 与数据目录分离**：`--checkpoint` 根在 `--data` 外；manifest 显式复制运行状态/被引用历史，不递归、不嵌套既有 checkpoint/backup。旧 checkpoint 只按“活跃回退 journal 引用 + 最近 N=3 + 显式 pin”保留；不得用“所有 undone=false”造成永久全保留，也不得删活跃回滚 journal 的唯一备份。 |
| R14 | **未完成/窗口外分离**：`applying/undoing/restoring` 或 WAL 未完成才永久保护；`applied` 只在迁移回退窗口内/被 pin/被 checkpoint 引用时保护；已完成且窗口外普通事件/journal 按依赖闭包安全裁剪，不因 `undone=false` 永久豁免 90 天/5000 上限。 |
| R15 | **suppression tombstone**：仍 stopped/reverted 的来源必须有 tombstone；2000 条/90 天不能成为“同 source 重新学习”的理由。必要 tombstone 超限 → `retention_blocked`，不误删；无安全收缩时如实 blocked。 |
| R16 | **业务字段 vs 审计字段**：迁移不改 `id/title/text/kind/scope/projectKey/project/source/createdAt/updatedAt/manual/expiresAt/aliases/derivedFrom/supersedes/supersededBy/invalidatedBy`；`changeID` 是审计指针，可新增或经显式 `--repair-dangling-change` 修复。`businessStateHash` 与 `storeStateHash` 分开；undo 恢复完整 store hash。 |
| R17 | **P03 容量回收同版**：既有已批准 policy 内允许后台安全回收过期 auto item、exact 去重、quarantine TTL、shadow/hook caps、派生历史；不生成日常人工待办。硬删除/超 policy/真实数据部署仍需确认；高级 preview+confirm 保留但非唯一路径。无安全数据 → `blockedReason/retryAt`，不假称永不阻断。 |
| R18 | **时点无损 + 分域 CAS**：“无损”只限 checkpoint 时点；undo 逐域比较 per-file hash、`storeStateHash`、`businessStateHash`、行数/事件数，任一漂移拒绝（退出码 4）；不覆盖迁移后新用户编辑，只能另存恢复/差异导出。 |
| R19 | **宿主首检保留**：隔离 env 下先跑 `opencode debug paths`，四目录不在临时根即阻塞；fake provider/recorder 验收继续按原文，全部 `not-run`。 |
| R20 | **回滚保守边界保留**：checkpoint 优先；兼容导出显式损失；不剥 `invalidatedBy/derivedFrom/supersededBy` 复活已停用内容；scope 默认不迁移。 |

## 精确测试矩阵（补正）

| 测试 | 必须构造 | 断言/证据 |
|---|---|---|
| `checkpoint-bounded.test.ts` | 连续 ≥5 次 apply→undo→再 apply；每次外部 checkpoint；另建 1 个活跃回退 journal 引用唯一 checkpoint | checkpoint 数量 ≤ N=3 + 活跃引用 + pin；字节不几何增长；checkpoint 内无嵌套 `checkpoint-*`/`backup-*`；无引用旧 checkpoint 被裁；活跃唯一备份仍在；`--status` 给出 counts/bytes |
| `history-prune.test.ts` | >90 天普通已完成事件 + 1 条 active 最新 + 1 条窗口内 + 1 条显式 `dependsOn` 引用 + stopped/reverted source suppression | 普通窗口外可裁；active 最新/窗口内/引用闭包零删除；stopped source 不复活；active 仍可 deactivate/revert/restore；删除后无悬空 journal/快照；输出 counts/bytes |
| `suppression-tombstone.test.ts` | 2000+ suppression，其中必要 tombstone 超限；另有过期且无 stopped/reverted 依赖的 suppression | 必要 tombstone 保留并 `retention_blocked`；可安全项被清；同 source 不重新学习；无静默超限 |
| `changeid-hash.test.ts` | 无 changeID item、dangling changeID item、正常 item | 基线新增/显式修复 changeID；`businessStateHash` 不变；`storeStateHash` 变化；undo 恢复完整 store hash；无授权不改已有 changeID |
| `capacity-policy.test.ts` | 95% + 过期 auto/exact 重复；95% 无冷数据；manual/promoted/rule/stopped | policy 内后台回收后复检恢复；无冷数据 blocked+retryAt；保护项不动；不产生日常人工待办；高级 preview 仍可用 |
| `checkpoint-cas.test.ts` | apply 后分别改 item/event/suppression/config/journal 各一次 | undo 逐域检测并拒绝（退出码 4），列出漂移域；不覆盖新编辑；`--restore-to-new-dir` 成功且原数据不变；checkpoint 时点状态逐项一致 |
| `retention-counters.test.ts` | 小 caps + 新文件 | `previewRetention` counts/bytes/id 随 changes/journal/suppression/quarantine 变化；`capacityStatus.counts` 可见；磁盘体积实测有前后值 |
| `host-m7-literal.test.ts`（执行时，真实 host） | 旧 owned 块正文含字面 `<context key="fake">`/`</context>`；无 metadata/wrapper_only 两形状 | 请求 1 有 sentinel；停用后请求 2 owned 块无撤销内容；宿主相邻块/聊天逐字保留；ambiguous/残留 → `blocked`；记录 metadata/render 形状 |
| `n2-invalidate.test.ts` | 停用有后代的 A；maintenance undo；检查 `maintenance/` 体积 | 无异常 `.items.bak` 放大；maintenance undo 不复活无效上游；否则 `blocked`（fix2 复核前不判通过） |
| `n3-ledger-scale.test.ts` | 2000 条既有账本 + 300 子项；再逼 5000 上限 | 记录耗时/事件数；592ms 基线不劣化为不可接受；超时/不可接受 → 规模阻塞；不提前重构 |

## 验证矩阵

| 项 | 命令/方式 | 通过条件 |
|---|---|---|
| 完整门禁 | `npm run verify` | exit 0；测试数 ≥ P01–P05 验收后的基线 + 新增；无断言下调 |
| 迁移 dry-run | `node scripts/full-auto-memory-migrate.mjs --data <tmp> --dry-run` | 提案 + 64 hex fingerprint；无写入（文件 hash 不变） |
| 迁移 apply/undo | 隔离目录，连续 ≥5 次 | checkpoint 外部/无嵌套/有界；二次 undo 报错；apply→undo→再 apply 业务 hash 相同、无重复 baseline；活跃唯一 checkpoint 保留 |
| 路径守卫 | 传真实路径/symlink | 退出码 2；fs spy 证明未读取 |
| fingerprint | 改文件/改提案 | dry-run fingerprint 变化；apply 旧 fingerprint 退出码 3、零写入 |
| 断电 | 每个 rename 边界杀进程 | 全成或全不成；`init()` 恢复；无半状态/重复事件 |
| retention | `retention-changes/history-prune/suppression-tombstone/retention-counters` | 新文件计入 counts/bytes/id；保护项零删除；窗口外可收缩；必要 tombstone blocked；磁盘体积有前后值 |
| soak 3d | `npx vitest run test/soak.test.ts` | 16 条不变量；`simulated:true` |
| soak 30d | `npm --prefix plugin exec -- tsx ../scripts/soak-30d.mjs --days 30` | 16 条不变量；`simulated:true`、`fakeClock:true`；快速完成 |
| 真实 host | 隔离 env + fake provider + recorder | `debug paths` 全在临时根；记录 metadata/render 形状；请求 1 有 sentinel、请求 2 无撤销内容；宿主相邻块/聊天逐字保留；ambiguous/残留 → blocked |
| N2/N3 | `n2-invalidate.test.ts`、`n3-ledger-scale.test.ts` | N2 fix2 复核前不判通过；N3 记录 2000+300/5000 耗时，不提前重构 |
| 正式 UI | 真实 Chromium 360/rail 260/320/双主题/keyboard | 全部断言；样稿不计 |
| 禁用项 | `grep -rn "as any\|@ts-ignore\|@ts-expect-error" plugin/src console/src extension/src` | 无匹配 |
| 工作树 | `git status` | 只有预期文件；无提交/推送 |

## 验收

- `ACCEPTANCE.md` §7 全部满足；新增 P06 判据（checkpoint 时点无损、兼容损失显式、retention 有界且不误删 tombstone、分域 CAS、host/UI 真实验收或明确 blocked）。
- `reports/06-rehearsal.md` 明确写：最终功能全量验收是否完成；30 天现场运行**未执行**；正式迁移/启用**未执行**；真实 host 与真实 UI 是否执行（逐项 `ran`/`blocked`/`not-run`）；M7 真实 host 证据（metadata/render 形状、literal context、相邻块/聊天保留）与 N2/N3 结果。
- M7 门禁：真实 host 出现 `context_ambiguous`、残留、宿主块被删、两通道转义不一致、`neither` → 最终验收 **blocked**。N2 在 fix2 复核前不得写“已解决”；N3 只记录规模耗时，不提前重构。
- 真实路径未被访问（路径守卫 + fs spy 断言）。
- 所有日志/截图在 `tmp/full-auto-memory/verification/`，不提交。
- 任何 `not-run`/`blocked` 不得用“全部通过”替代。

## 风险

| 风险 | 处理 |
|---|---|
| 误触真实数据 | 路径白名单 + realpath + 真实路径拒绝 + 只隔离演练 + 独立确认 |
| 迁移不可逆 | checkpoint 时点备份 + journal + undo + fingerprint；不批量删除；undo 分域 CAS |
| checkpoint 嵌套/无限增长 | checkpoint 根在 data 外；manifest 显式复制、排除既有 checkpoint/backup；最近 3 + 活跃引用 + pin；连续 ≥5 次演练验证有界 |
| “undone=false”永久全保留 | 只保护未完成事务/回退窗口/pin/显式引用；窗口外按依赖闭包收缩 |
| 回滚复活已停用内容 | 不剥 `invalidatedBy/derivedFrom/supersededBy`；checkpoint 优先；兼容导出显式报告损失 |
| 旧版 90 天清理停止项 | 旧版无 P01 保护；报告“停止无时限不可承诺”，不称无损 |
| scope 迁移破坏历史 | P06 不自动改 scope；单独工具导出旧历史并接受损失 |
| soak 被误读为真实运行 | 报告/控制台/文档三处 `simulated:true`；禁止“30 天真实运行” |
| 假 host 冒充真实 | 真实 host 未跑即 `not-run`；不以单测/fake host 替代 |
| M7 无 metadata fallback 歧义/删宿主 | 真实 host + fake provider 捕获出站请求；ambiguous/残留/宿主块丢失 → 最终验收 blocked |
| N2 maintenance 旁路复活下游 | fix2 复核前不判通过；P06 测 `.items.bak` 放大与 maintenance undo 不激活无效上游 |
| N3 账本规模 O(events×ledger) | P06 测 2000+300/5000；只记录/阻塞，不提前重构 |
| 保留上限误清保护项 | protectedChanges 传递闭包；必要 suppression tombstone 超限报 `retention_blocked`，不误删 |
| 自动修剪删历史 | policy 内只回收过期/去重/派生历史；硬删除/超 policy 显式确认；写 changelog |
| 单 hash 回滚覆盖新编辑 | 分域 CAS + business/store hash + 行数；漂移拒绝，另存恢复 |
| P01 修复改变签名 | 等 P01 复验；P06 只消费验收后的签名，不提前接线 |

## 未决 / not-run（执行前必须回答）

1. P01 fix2 后的最终签名与语义（M7 fallback、I1 显式恢复、N2 maintenance 旁路）——**未验**；N2 在 fix2 复核前不算已解决。
2. `Store`/生产函数是否都支持注入 `now`；若不支持，soak 阻塞，不 monkeypatch。
3. 自定义 provider 在无 `/connect` 时是否接受 `env` 假 key——**未验**。
4. 真实宿主 system part 是否同时有 `<context key>` 与 `metadata.experimental.instructions`，以及无 metadata 时字面 context 的 render 行为——**未验**；ambiguous 即 blocked。
5. OpenCode V2 插件加载是否要求 `dist` 构建产物/是否支持绝对目录——官方文档支持，**未实跑**。
6. retention 自动修剪是否需要在 `DESIGN.md` 新增配置/文案——实现前同步，不在本预检改。
7. `entry.put` 与 `event.system` 两通道转义是否在真实宿主一致——**未验**；不一致即 blocked。
8. N3 在 5000 账本上限的实际耗时/内存——**未验**；只测不提前重构。
9. M7 真实 host 是否出现 `context_ambiguous`/残片/删宿主——**未验**；出现即最终验收 blocked。
