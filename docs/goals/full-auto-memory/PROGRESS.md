# OpenMem 全自动记忆 · PROGRESS

Updated: 2026-11-16
Baseline: `b992a2e` (v0.5.0)
Branch: `feat/full-auto-memory`

## 方向裁决（2026-11-11）

1. 停止使用/撤销成功后，下一次模型请求即排除错误记忆（含旧 session）；已开始请求/已执行外部动作不可追回。
2. 随时可停止使用；版本回退默认保留 90 天（`undo.retainDays` 可配置建议）；旧 merge 24h 只约束 legacy，不约束新统一撤销。
3. 全机含备份彻底 erase 不在本轮必实现范围；不承诺云端删除；后台模型仍可出网。
4. 普通自动记忆零待审；legacy 审查入口放“设置 › 高级与维护”，活动页不加“待确认”徽标。
5. 冲突不得“仅恢复文本”覆盖后续正确编辑；版本安全逆转，否则停止使用。
6. UI 稳定契约 = 统一事件/版本/来源/可撤销 + 只读活动 API。

UX 报告 `reports/ux-contract.md` 由 UX 作者在原 session 修订；P0 只引用，不修改该文件。方向以 `DESIGN.md` §11 为准。

## 当前交付状态（2026-11-16，P07 报告完成）

- P00–P06 **开发源码已交付并由主代理逐单元读实际 diff 接收**；当前无产品 writer；P07 报告已由文档 writer 落版，主代理已读并接收，P07 报告完成。
- **Development status: Done（源码交付）；Overall acceptance: Partial / not-verified。** P03–P06 行为、真实 host/model、P05 视觉/键盘、P06 迁移/回滚均未运行验证；不声称生产就绪、全部测试通过或正式启用完成。
- 本轮文档 writer 仅写 `reports/final-review.md`、本文件、`phases/07-final-review.md`、`orchestration.md` 与 PLAN 当前进度（status 与 §2.2）；未跑测试/typecheck/build/迁移，未提交/推送/发版，未动正式 config/memory/正式仓库。
- 最终建议：**源码开发交付完成；生产启用暂不建议，行为/宿主/UI/迁移未验证。** 正式启用、生产迁移、回滚/GC 执行需另行确认。

## 实施历史（2026-11-16，原始记录保留；“当前唯一 inprogress”均指当时）

- 用户要求：继续既定 P03-D 工作并维护 todo；UX 优先、长期稳定。当前仍由本 session 收尾 maintenance/mode/status。
- 执行边界：**不重复基线、不跑测试/专项评测、不设独立复核门**；只运行本轮必要 plugin typecheck。旧快照失败证据保留，行为未验证时如实注明。
- 当前产品：P01/P02 保留；**P03-provenance 已 PASS**；extract/create 与 P03-C2 lifecycle 的既有 typecheck exit 0；P03-D 原指定 typecheck 首次 exit 2、mode guard 修正后 exit 0，14 路径 before-relative patch 已生成。该 exit 0 是本轮修正前证据，不覆盖本轮新增改动；行为未验证，P03 未完成。
- 原先 boundary 失败/回退及旧 writer/reviewer 状态均为历史，不作为当前门；不派审或等待审查。
- 既有 typecheck 证据：旧快照 exit 2、import 修正 exit 0、lifecycle 接线修正 exit 0，均保留在 `tmp/full-auto-memory/product/p03-lifecycle/`。此前 D 首次 exit 2 与 guard 修正后 exit 0 分别保存在 `tmp/full-auto-memory/product/p03-maintenance/typecheck.log/.exit`、`typecheck-after-guard-fix.log/.exit`；未跑测试/全量 verify。
- 当前交付材料：lifecycle before-relative patch 已含 `extract/evidence.ts` 和真实 before 重建说明；P03-D dirty before 与 `consolidate.ts` 重建方式见 `tmp/full-auto-memory/product/p03-maintenance/before/MANIFEST.txt`；完整 D patch 已由 14 个快照路径生成，typecheck command/log/exit 已保存。后续：P04 有界召回/撤销下一请求 → P05 正式 UI/扩展 → P06 容量/迁移回滚/集成 → P07 主代理整体源码/接口/UX 验收 + 最终交付报告。
- 本轮 P03-D fix1（2026-11-16）：修复累计 `dispatches` 丢失、pending TTL 复活、fairness 额度和 status 字段/过滤；源码快照/patch 在 `tmp/full-auto-memory/product/p03-maintenance/fix-before/`、`fix.patch`。typecheck 原始记录与复核均 exit 0，分别留存于 `fix-typecheck{,-recheck}.{log,exit}`；未跑测试/评测/build/full verify。
- 本轮 P03-D fix2（2026-11-16）：同 material/config 窗口 cap 与 catch 均按真实累计 `dispatches` 达 3 停发，清 timer/retryAt 并持久化；Retry-After 已发请求计入 `dispatches`，但不增加 `attempts`；零 dispatch 等待保留旧数。Store 两个 TTL 删除入口原子保存最近 16 个 hash-only expired window 并去重计数；capture 的 hash 命中终态即不 dispatch，真实新 material 才开新 pending。仅改 `plugin.ts`、`store.ts`、`types.ts` 与三份交接记录。`fix2.patch`、`fix2-before/`、`fix2-typecheck.command/.log/.exit` 在 `tmp/full-auto-memory/product/p03-maintenance/`；唯一 typecheck exit 0。行为测试未跑，行为仍未验证。
- 本轮 P03-U1b 普通复盘桥（2026-11-16）：`onAccepted` auto+enabled 仍走 extract 用户原文准入，但实际把 review 已见 `ok=false` tool digest 交给同一 extract provider；learning 以 project `fact` + `reviewType:"learning"` 走 P01 writer，shadow 只审计，protected hook 计数分开。主代理已接收 p3-maintenance 的 1934+420+278 行实际差异及 fix2-typecheck exit 0（行为未测）；P03 源码已由主代理接收，行为仍未验证。P04 接口准备已完成，不重复探索。证据与 typecheck 在 `tmp/full-auto-memory/product/p03-review-bridge/`；行为/真实 host/model/dataDir 未验证。
- 本轮 P04 有界召回（2026-11-16，当前唯一 inprogress，本 session 唯一 writer）：新增 `plugin/src/recall.ts`，并接线 `plugin/src/plugin.ts` 的每请求 `refreshContext → owned prefix 当次重写 → 动态独立 recall block`、只读 tool `action=recall`、`GET /api/recall`、`recall` 配置与 `api/plugin.memory-autopilot` 精确 key/wrapper 兼容。动态默认 5/600，API/tool 默认 8/1200；query ≤400；scope/version/expiry/invalidated 当次过滤；开关关闭仍执行 owned 过滤。唯一检查 `cd plugin && npm run typecheck` exit 0；未跑测试/评测/build/full verify，未接真实 host/model/dataDir/正式配置。before 快照、完整 patch、typecheck 与 import smoke 在 `tmp/full-auto-memory/product/p04-recall/`；行为仍未验证。
- 本轮 P04 修正（2026-11-16，主代理源码验收后）：补普通 ASCII 整词/命令匹配（不拆 `plugin.ts`、`npm` 不命中 `pnpm`）；text part 级 synthetic 过滤（含 `metadata.source==="synthetic"`，混合消息保留真实 part）；parent 三态恢复 `parentKnown` fail-closed（缺 key=unknown，不动态召回）；prefix 去重前置到 `recallMemory` 的 limit/预算之前；context hook 进入即清理旧动态块，失败/unknown/关闭不留旧动态；known before/after 完整 render 作为精确定位证据，歧义不追加。`fix-before/`、`fix.patch`、`fix-typecheck.log/.exit`（exit 0），完整 `p04.patch` 已同步。未跑行为测试；真实 host 的 parent slot/metadata/wrapper 与下一请求剔除仍未实测。2026-11-18 发版裁决：R2 取代该轮的 parentKnown fail-closed 口径——owned + hostRead + id 匹配 + 无 parentID 即 root，读取失败/不可用才是 unknown；新增 28 个 recall/context-recall 测试。
- P03-U1b fix1（2026-11-16，源码验收后）：失败工具只接纳 native assistant/tool 消息，`observedRole` 保留真实 role；学习正文改由 `projectToolFailure` 从 state.error/content/output 生成完整有界失败句，先 secret-only 脱敏再裁剪，命令/args 不入正文；`rawHash` 覆盖完整脱敏诊断，`offsetSpace:"tool-projection"` 明示投影坐标。捕获与写前复核共享同一投影/摘要 helper，复核 role/partIndex/callID/失败状态/digest/rawHash。`fix-before/`、`fix.patch`、`fix-typecheck3.log/.exit`（exit 0）；未跑测试/真实 host。
- 本轮 P05 正式 UI/扩展（2026-11-16，当前唯一 inprogress，本 session 唯一 writer；此前所有作者/reviewer 止写）：主路径改为 `#memory[/id]`、`#activity[/event/id]`、`#settings[/advanced/<section>]`；旧 queue/health/audit/map/skills hash 用 `replaceState` 规范化，未知 hash 保持不跳。记忆页接 `/api/memory/items` 的 version/changeID/revertible 与服务端 `stoppable/restorable/expired` 能力，停止/恢复/撤销均为 versioned POST，409 只留停止，未知结果复用队列锁；活动页聚合 changes/changelog/reviews/hooks 并标“部分事件”，无待确认徽标；设置按写入自动化/模型阈值/容量/高级/环境/危险区分组，模式使用 `POST /api/automation/mode` + 字符串 `configRevision` 一次 CAS，legacy 仅作兼容状态，kill switch 真停后台；legacy 审查/批量/草稿/决策版本与健康/审计/图谱/技能/历史/备份全部迁入设置高级。扩展 page 复用桌面 App，rail 状态→最近写入→最近操作→打开控制台，status 88 只读；新增 `/api/console/open` 由服务端持 token 打开，不下发 token。检查仅 console/plugin/extension 三处 typecheck，均 exit 0；before 快照、完整 patch、日志与 exit 在 `tmp/full-auto-memory/product/p05-ux/`。未跑测试/评测/build/full verify，未做真实 360、rail 260/320、键盘、明暗主题或宿主视觉实测；P05 行为与 S1–S19 未通过，交主代理直接读源码验收。
- P05 fix1（2026-11-16，主代理验收后）：409 在 `api()` 抛出处统一捕获，撤销冲突锁只留停止、停止/恢复报准确动作与最新版本；未知结果必须真实读取服务端 envelope 比对版本后才解锁，失败保持锁。成功写入重新读取 `/api/memory/items` 使用服务端能力，刷新失败禁用该条动作；焦点在 busy 后新 render 恢复，sheet 进入/Tab 约束/Esc 归还，保留 window/list/detail 滚动。本次会话仅用 extension `host.onSession`，standalone 标不可确认；当前项目计数排除 session。写入轴显示配置/有效/阻断，legacy 改“按旧配置运行”，shadow 改“不写入生效记忆，保留观察记录”；新鲜度改服务端 `generatedAt` 快照，最近真实写入单独显示。活动页补 changelog reason/count/reasons 与 extract 诊断、复盘 P03 计数、失败源清空、硬 limit 范围、用户 update 不计自动写入；rail 打开控制台检查 `{ok:false}`，动作级 focus key，轮询失败禁用旧动作。仅 console/plugin/extension 三处 typecheck 重新运行均 exit 0，原 p05 证据保留；未跑测试/评测/build/full verify，行为/真实 360/rail/键盘/宿主仍未实测，S1–S19 不通过。
- P05 fix2（2026-11-16，锁作用域收尾）：新增共享 `item-action-locks` 模块，按 dataDir+project 指纹分域，持久 itemHash/action/version/changeID/kind/at；轮询/页面重挂载不再洗掉冲突与 unknown 锁。冲突锁绑定具体 item+动作+提交版本（revert/restore 加 changeID），新服务端版本才允许重试；unknown 锁跨主 tab 与 rail 共享，多个条目并存，仅在显式核对成功读取 `/api/memory/items` 并比较版本后解除；读取失败保持锁。存储不可用显示“无法跨刷新持久化”并注册 beforeunload。仅 console typecheck 重跑 exit 0（`fix2-console-typecheck.log/.exit`），plugin/extension 未重跑；未跑测试/评测/build/full verify，行为/360/rail/键盘/宿主视觉仍未实测。
- 本轮 P06 产品单元 1（2026-11-16，当前唯一 inprogress；retention 唯一 writer）：真实接线 `previewRetention/applyRetention` 与 P03 `runMaintenanceTick`，派生历史（changes/journal/suppressions/quarantine）按 90 天/5000/每 item 20/2000/200 上限与引用闭包预览和后台回收；保护 active 最新、item.changeID、窗口内完整 before/after、dependsOn/reverts 传递闭包、未完成 journal/WAL、迁移窗口/pin；停用来源 tombstone 无时限；无 `reclaimable` 时如实 blocked。`capacityStatus.counts` 增加新文件计数，freeze 前一次有界回收后复检，95/85 阈值不变。活动记录 `retention_auto`/`retention_blocked`，status 暴露 live capacity 与最近 retention 快照，设置/健康按真实口径显示。仅 `plugin`/`console` typecheck exit 0；未跑测试/soak/迁移/清理/真实 dataDir，行为未验证。证据 `tmp/full-auto-memory/product/p06-retention/`；迁移/回滚脚本下一单元。
- P06 根因修正（2026-11-16，主代理源码验收后）：统一保护根与一次传递闭包，item/journal 删除集基于最终保护集；修复 journal-only 保护被重算丢弃。新增 `Store.tryReserveRetentionRun` 5min 持久 gate（30s lease 仅并发），请求/maintenance 扫描前短路且零回收也 backoff；checkpoint 相对路径+hash 入 preview id，migrationJournals/checkpointBackups 拆分，retired/global state bytes 入 historyBytes，status 分离 reclaimedBytes/remainingReclaimableBytes。changes/changeJournals 达 5000 时自动 writer 一次回收后仍满则 `history-protected-capacity` 阻断新学习，停止/撤销/恢复不受影响。仅 plugin/console typecheck exit 0；未跑测试/清理/迁移/真实 dataDir，行为未验证。
- P06 迁移/回滚工具 fix2（2026-11-16，源码）：凭证检测复用 redactText 并覆盖 headers/URL/递归字段，checkpoint 复制前复检配置；staging 发布前用同一 manifest 校验器验证固定文件/白名单/唯一/hash/bytes/domain/inputFiles；collect/gcJournals 枚举前验目录链接，manifestRelative 拒绝原始 .. 分量。仅 plugin typecheck exit0；未运行任何 dataDir。
- P06 迁移/回滚工具修正（2026-11-16，源码）：state 纳入分域 CAS；checkpoint 在 Store 锁内一致读并校验 manifest；compat 支持无 checkpoint 的 --data 源、预览不写 target、清除 pinned context；GC 内容绑定+锁内复核+pinned 保护；repair 补真实 baseline；no-op 零写入。
- P06 迁移/回滚工具（2026-11-16，源码）：新增 `scripts/full-auto-memory-migrate.mjs`、`scripts/full-auto-memory-rollback.mjs` 与 `plugin/src/migration/{guard,core,cli}.ts`；经本地 `tsx` loader 调真实 Store/WAL/recordChange，不要求 build。migrate dry-run/apply/undo/status/GC、rollback restore/compat-export、严格路径守卫、外部 checkpoint manifest、fingerprint、分域 hash、baseline/queue 分类、兼容损失报告均已接线。retention journal 引用闭包补 stable 反向引用，迁移 journal `changeIDs` 由 retention 消费。未执行任何 dataDir 清理/迁移/演练；仅 plugin typecheck 与 mjs `node --check` exit 0，行为/回滚未测。证据 `tmp/full-auto-memory/product/p06-migration/`。
- P03–P06 功能目标全部保留；真实迁移/正式启用另批；无 commit/push/release、真实 config/memory/正式仓库不动。

## 归档旁支：host spike 历史（不作为开发目标）

- `sandbox_stage_controls`：stage1 `(allow default)` rc0 + marker；stage2 最小 deny-default rc134 + marker absent；stage3 未运行。报告 `reports/03-host-spike-stage-controls.md`（53 行）；原生成物在 `host-spike-stages.ftGEtQ`。不据此声称 host profile 隔离。
- own-process log：对 stage2 PID 59427 单次 10 秒窗口查询 `log show`，0 条匹配；结论 **UNKNOWN/BLOCKED**，见 `reports/03-host-spike-own-process-log.md`。未扩大窗口/PID/类型。
- existing isolation 静态检查：`docker` PATH 入口与 `/Applications/Docker.app` **FOUND**；podman/colima/lima/nerdctl/orb/utmctl/qemu/prlctl/vmrun/multipass 及对应 App **NOTFOUND**。未运行/连接/读配置；daemon、镜像、网络、挂载与隔离能力全部 **unknown**。报告 `reports/03-host-spike-existing-isolation.md`（27 行），raw `tmp/full-auto-memory/host-spike/existing-isolation-entries.txt`。
- Docker readonly preflight（2026-11-12）：本机 Docker Desktop socket `/Users/11169285/.docker/run/docker.sock` 可连接，owner PID 5573 `com.docker.backend`；3 个 GET 200（`_ping`/`/version`/`images`），API 1.56、Docker 29.8.1、Platform Docker Desktop 4.93.0；17 张镜像，基础候选仅 `alpine/ubuntu/node/nikolaik` tag+size，未 inspect。隔离/挂载/网络/容器内 OpenCode 能力 **unknown**。报告 `reports/03-host-spike-docker-preflight.md`（54 行），raw `tmp/full-auto-memory/host-spike/docker-preflight/`。
- Stage1 首尝试已消耗：96 行；44 guard/image/create 201；prestart 36/37；未 start/exec；DELETE 204/GET 404；不 PASS。
- Retry 已消耗并失败：报告 81 行；prestart 37 PASS；uid 10001/dirs 700 RW/sentinel/tmpfs pass；interfaces `lo` + 9 内核隧道伪接口触发仅 lo 断言；route/forbidden/回环/TESTNET not-run；exit 2；stop 5s timeout；无 DELETE/404。严禁第三 container。
- Residual snapshot retained: ID `4eae8613...b798122b`; name `openmem-spike-20261112T080853Z-2f36035f`; exited/Exit137/OOM false/owner_match true; FinishedAt 08:08:59Z. **Deleted after verified precheck**: DELETE 204 → same ID GET 404; 3 requests/exit 0; no force/stop/prune/other resources; old evidence kept.
- Review §15 completed (173–186; main read): both attempts BLOCKED, no retro PASS. metadata 37/UID 10001/7 dirs/sentinel/tmpfs proven; interface names only, no flags/addresses/routes; route/forbidden/loopback/TESTNET not-run; only-lo approved literal, later semantic contract proposal. stopclient5/grace5 no margin; 137/OOM false consistent with post-grace termination but signal cause unproven.
- Cleanup completed: exact container `4eae…122b` precheck 200 → DELETE 204 → same ID GET 404; main read raw; no further delete/global residue.
- All create/retry auth consumed; no live Docker agent/container. Old network/contract author `ses_e30fed41effe7IFKwrZ4J0bO5R` stopped writing; no cleanup/review or contract continuation. Historical followups retained in old reports only, not a delivery objective.
- No code/harness/old-result change; no Docker/new container/download/host/model; Stage1 not pass; no auto harness fix/new trial. Host capability issues fold into product adaptation/final integration.

## 验收边界

- 最终功能全量验收：**未完成**；P00–P06 仅源码交付，ACCEPTANCE 行为判据未验证。
- 30 天现场运行：尚未执行；`soak-30d` 为加速模拟，必须标注 `simulated`。
- 正式数据迁移/正式启用/发布：未执行，需用户另行确认。

## 状态总览

| 阶段 | 状态 | 证据 | 备注 |
|---|---|---|---|
| P00 baseline | done | `docs/goals/full-auto-memory/reports/00-baseline.md`；`tmp/full-auto-memory/verification/verify-baseline.log` | 63 files / 803 tests，exit 0 |
| P00 preflight | done | `docs/goals/full-auto-memory/reports/00-preflight.md` | 共享文件/接口冲突 + 主代理裁决 |
| P01 reversible-memory | done（支持形状范围 review 通过） | `reports/01-reversible-memory.md`；`reports/01-review.md` §9；`tmp/full-auto-memory/verification/verify-p01-fix3.log/.exit` | 72 files / 896 tests，exit 0；P06 真实 host 门禁仍 not-run+blocked；歧义保留旧块≠下一请求生效；N3 deferred |
| P02 runtime-reliability | done（组件/wiring 窄范围）；U1/U2 转 P03 | `02-host-wiring-review.md`；既有 74 files/929 tests 证据 | 不重跑；U1 unknown consolidate、U2 created 错误认领归 P03 首个代码单元 |
| P03 autonomous-pipeline | **源码完成（主代理已接收）；行为/真实 host/model 未验证；阶段未验收** | `tmp/full-auto-memory/product/p03-provenance/`；`.../p03-lifecycle/typecheck-after-production-fixes.log/.exit`；`.../p03-maintenance/fix-typecheck-recheck.log/.exit`；`.../p03-review-bridge/fix-typecheck3.log/.exit` | 首次 D typecheck exit 2 已保留；U1b 含 fix1（native role/失败投影/error-hash）；仅编译通过 |
| P04 recall | **源码/接线完成+修正轮（主代理已读完整 patch 并接收；fix-typecheck exit 0；行为未测）** | `docs/goals/full-auto-memory/phases/04-recall.md`；`tmp/full-auto-memory/product/p04-recall/{p04.patch,fix.patch,fix-typecheck.log,fix-typecheck.exit}` | 有界召回 + 撤销下一请求；真实 host/UI 未验证；当前未提交工作树快照未重跑测试 |
| P05 ux | **源码完成+fix1/fix2（主代理已读实际差异并接收；行为未测）** | `tmp/full-auto-memory/product/p05-ux/{before/,p05.patch,fix-before/,fix.patch,fix2-before/,fix2.patch,fix2-console-typecheck.log,.exit}` | 三主路由/旧 hash 重定向、记忆/活动/设置、legacy 高级、extension rail/status；fix2 共享锁分域与 unknown 持久；仅 typecheck exit 0；真实 360/rail/键盘/宿主未测，S1–S19 未通过 |
| P06 migration-verification | **retention/capacity + 隔离迁移/回滚工具源码完成（主代理已接收）；行为/演练未验证** | `tmp/full-auto-memory/product/p06-retention/{before/,fix.patch,fix-plugin-typecheck.exit,fix-console-typecheck.exit}`；`tmp/full-auto-memory/product/p06-migration/{before/,new-files.txt,p06-migration.patch,fix2-typecheck.exit,fix-node-check.log}` | retention preview/apply/auto prune/status；migrate dry-run/apply/undo/status/GC、rollback restore/compat-export；仅 typecheck/node --check exit 0；未跑任何 dataDir 迁移/演练 |
| P07 final-review | **主代理已读并接收；P07 报告完成；无运行 writer** | `docs/goals/full-auto-memory/reports/final-review.md` | 源码开发交付完成；生产启用暂不建议；行为/宿主/UI/迁移未验证；不设独立复核门；native p7 由主代理紧接关闭 |

## P0 预检修正（2026-11-11）

主代理预检裁决已落入文档，详见 `docs/goals/full-auto-memory/reports/00-preflight.md`：

1. 基线报告已补真实路径与日志原文（63 files / 803 tests / exit 0），未重跑。
2. P04 改为每请求自动召回：V2 `session.hook("context")` 内附着独立有界 system block，不写 transcript；稳定 prefix 与动态 block 分离。
3. 旧 `GET /api/items` 保持 `{ items: Item[] }`；新 envelope 走 `/api/memory/items`。
4. `ItemKind` 无 `decision`；decision 用 `fact` + `reviewType` 表达。
5. `memoryVersion` 纳入 nearest-expiry；无写入跨期也失效；下一请求 hook 执行刷新。
6. P03 增加 benign 祈使句→preference、任务模板/子会话/引用表格过滤、普通冲突隔离；safeAuto 不作校准概率。
7. 全路径写 change event；`ItemSnapshot = Item` 无损；派生递归+环保护；恢复不激活无效上游。
8. 保留上限不剥夺 active 撤销；P06/retention/capacity 纳入新文件与保护依赖。
9. 迁移真实可回退幂等演练；soak 调真实生产函数 + fake clock，标注 simulated。

## P00 证据摘要

- Worktree: `/Users/11169285/.local/share/opencode/worktree/91548720c853e67e562f9f15a753b3403633633e/full-auto-memory`
- HEAD: `b992a2e608f3531988f25bca105d9530b5a5174a`
- Node `v22.22.3` / npm `10.9.8`
- `npm ci` plugin exit 0（318 packages）；console exit 0（75 packages）；仅使用现有 lockfile
- `npm run verify` exit 0：Test Files 63 passed，Tests 803 passed，Duration 52.00s；plugin/console/extension typecheck、build、extension proxy、`git diff --check` 全部通过
- 源代码改动：无；`git status --short` 为空（`tmp/`、`node_modules/`、`dist/` 均被忽略）
- 未发起任何模型/付费调用；未读取真实数据目录；未修改 `~/.config/opencode`

原始日志（不提交）：

```text
tmp/full-auto-memory/verification/npm-ci-plugin.log
tmp/full-auto-memory/verification/npm-ci-console.log
tmp/full-auto-memory/verification/verify-baseline.log
```

## 当前事实（只读核对，非根因）

- 现有 `canAutoApply` 对 `rule`/`session-review`/`session` 返回 false；`autoRules` 配置存在但不产生效果。
- 自动写入路径（`consolidate.ts` 约 541 行）没有与 items 同一事务的变更 journal；P01 补。
- `refreshContext`（`plugin.ts` 约 1013 行）只在缺失/project 不匹配时重建，pinned block 不会因撤销失效；P01 补 `memoryVersion`。
- `GET /api/items` 只有 GET 列表；P01 扩展。
- `review/provider.ts` 约 151 行直接拼 `/api/chat`，未使用 `rewrite.transport`；429 只按 `>=500` 重试；空返回是通用 Error；P02 修。
- 复盘 run 预算与 request 预算都走 `maxPerHour`；P02 拆。
- `recover()` 未按项目归属过滤；`accept.ts` 约 163 行用当前实例 `projectKey`；P02 修。
- `status` 只 `readAudit`，不 `runAudit`；这是正确现状，P02 保持。
- 文件锁已检查 live PID 并防 stale 抢占；不要写成缺陷。
- 历史数据（active 0 / shadow true / queue 50 / session 34；review failed 225 / ready 28 / skipped 155）只作为动机背景，未在本阶段重新读取，不能作为任何根因结论。

## P01 修复轮 1 清单（2026-11-11，依据 `reports/01-review.md`）

裁决：独立 review 拒绝冻结（0 Critical / 3 Important / 7 Minor）。M1/M2/M4/M6/M7 由 Minor 提升为本轮 blocking（见 phase01 R10）。逐项先 RED 再 GREEN，不弱化断言。

| ID | 缺陷 | 本轮状态 | 证明 |
|---|---|---|---|
| I1 | 上游恢复后派生项永久失效；reactivate 走错分支 | fixed | `derived.test.ts` 新增 2 例（逐个恢复闭环、不自动复活下游）+ 旧用例改为断言上游 id；`probe-p01.ts` 复跑 `reactivate B result ok:true` |
| I2 | `undo.retainDays` 未进 PATCH 白名单 | fixed | `api-undo-config.test.ts`（PATCH 持久化 200 + 立即生效 + 0 拒绝 400） |
| I3 | `recordItemDiff` 证据不存在；比较漏关键字段 | fixed | 比较改全字段（除 changeID/updatedAt/seenCount/lastSeenAt）；`changes.test.ts` 2 例 + `api-undo-legacy.test.ts` 4 例 |
| M1 | compact 全局 merged 产生幽灵 `update` | fixed | `changes.test.ts` 新增分组用例；`probe-p01b.ts` `item_b1 events: []` |
| M2 | `POST /items/:id/revert` 忽略 `:id` | fixed | `api-items.test.ts` 跨条目 → 404 且 B 未动 |
| M3 | 过期快照 restoreVersion 返回成功却不注入 | fixed | `restore.test.ts` 过期快照 → `not_revertible` 且零写入；`probe-p01.ts` `restoreVersion ok:false` |
| M4 | create/keep_both 改写后抑制不命中原文 | fixed | `suppression.test.ts` 改写后 aliases 含原文、两路 key 均命中 |
| M5 | 复用 changeID 可能覆盖 journal | fixed | `changes.test.ts` fail-fast + 账本/journal 零覆盖 |
| M6 | 300 派生 12.3s、>20 层静默漏 | fixed | 一次闭包 + 一次 `applyItemChanges` + 每 item 事件；`derived.test.ts` 300 fanout/25 层/环审计；`probe-p01c.ts` 12256ms → 220ms |
| M7 | 正文含 `</context>` 替换残留 | fixed | `context-version.test.ts` 4 例（转义、旧未转义块、fake open、相邻外部块） |

修复轮门禁：`npm run verify` exit 0，`Test Files 72 passed (72)` / `Tests 886 passed (886)`；日志 `tmp/full-auto-memory/verification/verify-p01-fix1.log`（39664 bytes）/ `.exit`。

## P01 修复轮 2 清单（2026-11-11，依据 `reports/01-review.md` §7）

范围：只修 M7（含 N1 误删 host）、N2（fix1 新引入）、旧回滚文档。I1–I3/M1–M6 已 ADDRESSED，不重写。N3（重复读账本 592ms）按裁决 deferred 留 P06，不做性能重构。

| ID | 缺陷 | 本轮状态 | 证明 |
|---|---|---|---|
| M7/N1 | 无 metadata fallback 残留 + 全局 lastIndexOf 删宿主；entry.put 存未转义值 | fixed | `context-version.test.ts` 23 例（无 metadata A/B/B2、单块、安全边界、entry.put 转义、context_ambiguous 有界）；`probe-fix1.ts` 五种形状 `host kept: true` |
| N2 | `invalidateDerived` 经 `applyItemChanges` 生成 maintenance journal + 全库 bak，可绕过上游检查复活下游 | fixed | `derived.test.ts` 11 例：`replaceItems` 1 / `applyItemChanges` 0 / 无 `maintenance` 与 `.bak`；fanout 215ms；`api-undo-legacy` 4 例证明正常 maintenance undo 不回归 |
| 文档 §7 | 旧“删账本即无损”可执行建议 | fixed | 改为 Superseded by `reports/06-preflight.md` §2 + 六类损失 + checkpoint 契约 |

修复轮 2 门禁：`npm run verify` exit 0，`Test Files 72 passed (72)` / `Tests 894 passed (894)`；日志 `tmp/full-auto-memory/verification/verify-p01-fix2.log`（39643 bytes）/ `.exit`。

修复前快照：`tmp/full-auto-memory/reviews/p01-fix2-before/`；本轮 diff：`tmp/full-auto-memory/reviews/p01-fix2.patch`。

## P01 修复轮 3 清单（2026-11-11，依据 `reports/01-review.md` §8.2/§8.4）

范围仅 N4（单块判据）与报告半句说明；不改对外接口、不重写 M7/N2、不做 N3 性能重构。

| ID | 缺陷 | 状态 | 证明 |
|---|---|---|---|
| N4 | `isSingleOwnedBlock` 未排除 OPEN 之后的 `<context `，S1/S2 会整块误删宿主且无审计 | fixed | `plugin.ts` 判据加 `countOccurrences(text, "<context ") === 1`；`context-version.test.ts` S1/S2 各 stop+replace 两例（先 RED 2 failed → GREEN 25 passed）；`probe-fix2.ts` S1/S2 `ambiguous=[0] host=true parts=1` |
| 文档 | §9 补“歧义路径当次新记忆也不注入”；§7 拆分 `derivedFrom` 损失来源 | fixed | `reports/01-reversible-memory.md` §7/§9/§10 |

修复轮 3 门禁：`npm run verify` exit 0，72 files / **896 tests**；日志 `tmp/full-auto-memory/verification/verify-p01-fix3.log`（39759 bytes）/ `.exit`。

边界：P01 接口可冻结供 P02；P06 保留真实 host 实际运行门禁，不支持形状 = 最终验收 blocked。before 快照 `tmp/full-auto-memory/reviews/p01-fix3-before/`；本轮 diff `tmp/full-auto-memory/reviews/p01-fix3.patch`。



修复前快照（供只含本轮 fix 的 diff）：`tmp/full-auto-memory/reviews/p01-fix1-before.patch`（本轮开始时产品树 + 测试 + 文档的完整快照）。本轮 fix diff 输出：`tmp/full-auto-memory/reviews/p01-fix1.patch`。



- 产物：`plugin/src/changes.ts`、`plugin/src/memory/suppression.ts`；Store/context/API/写入路径改造；7 个新测试文件 + 2 处扩展。
- `npm test`（plugin）：`Test Files 70 passed (70)` / `Tests 864 passed (864)`（baseline 63/803，+7 files / +61 tests）。
- `npm run verify`（worktree 根）：**exit 0**，同上测试数，plugin/console/extension typecheck、build、extension proxy、`git diff --check` 全通过。
- 原始日志（不提交）：

```text
tmp/full-auto-memory/verification/verify-p01.log   37325 bytes
tmp/full-auto-memory/verification/verify-p01.exit   exit=0
```

- 禁用项：`grep -rn "as any\|@ts-ignore\|@ts-expect-error" plugin/src console/src extension/src` → 无匹配。
- 接口：严格按 `DESIGN.md` §8.1；补充细节与 8 条裁决写在 `phases/01-reversible-memory.md` 的「实现裁决 R1–R8」。
- 关键修复（TDD 暴露）：
  1. `restoreVersion` 初版用 `updateItem` 合并语义，会把当前版本独有的 `manual` 等字段带进恢复结果；`restore.test.ts` 先红，改为 `store.replaceItem` 整体替换后转绿。
  2. **真实 V2 生命周期**：`instructions.entry.put` 的更新/移除在“下一个 step boundary”才宣布，不能替换当次已装载的 `event.system`（官方文档原文 + 本地 `SystemPart.metadata` 形状，见 `reports/04-preflight.md` §2.1）。P01 改为每次 context 请求用 `applyContextRequest` + 纯函数 `applyOwnedContext` 只替换本插件自己的块；`context-version.test.ts` 用 fake host「旧块 → deactivate → 下一请求仍用旧 entry 组装」验证，临时关掉当次替换即 `1 failed`，恢复后 `Tests 12 passed (12)`。
- 未做/边界：retention·capacity 全量接入与迁移基线事件归 P06；`/api/memory/items` 暂无 `nextCursor`；宿主真实渲染未实测、未发真实模型请求（需用户授权/付费）；若宿主既无 `<context key>` 标记也无 `metadata.experimental.instructions`，helper 只追加自己的 part、不删未知文本。

## P01 阶段验收（fix3，2026-11-11）

- 独立 review `reports/01-review.md` §9：N4 clean；支持形状范围 spec/quality 通过；P01 对外接口可冻结供 P02/P03/P04。
- 门禁：`npm run verify` exit 0；**72 files / 896 tests**；`verify-p01-fix3.log/.exit` 由主代理亲读；`git diff --check` 无输出。
- **未闭合边界**：P06 真实 host 实际出站验证仍 **not-run + blocked**；无 metadata 且正文含字面 `<context `/额外 `</context>` 为不支持形状，歧义路径保留旧块**不等于**撤销已生效；N3 读账本性能 deferred P06。
- 其他阶段（当时状态，后续已推进）：P02/P03/P04 文档合版完成、代码未开始；P05 后续已落正式源码并由主代理接收；P06 后续已交付 retention/capacity 与迁移/回滚源码；当前总状态见文件顶部。

## P02 组件级验收 / host wiring（窄范围通过）

- 作者原实现 + fix1：`ses_e36134397ffeC1p765rU6H7wes`；**73 files / 926 tests，`verify-p02-fix1.exit=0`**；主代理亲读；diff `tmp/full-auto-memory/reviews/p02-fix1.patch`。
- Fresh reviewer `ses_e35c4ad4cffeHKSlDvkNXIb1I5`：`reports/02-review.md` **组件级 spec/quality 通过**。
- Wiring fix：`verify-p02-wiring.exit=0`，**74 files / 929 tests**，原 audit probe exit 0；主代理亲核；原 reviewer 通过（仅 known-foreign 范围），报告 `reports/02-host-wiring-review.md`。
- **未闭合**：U1 unknown consolidate 仍写当前项目 hook；U2 created 错误认领必须由 P03 source contract 关闭；host 真实权限/过滤 unknown。不能写“全项目隔离通过”或“真实越项目已发生”。
- P02 wiring 6 Minor、原 P02 followups、P01 N3 账本规模均保留指向原报告，不丢；P02 不重开 fix2，E2E 缺口转 P03。
- 其他：P04 源码/修正完成、主代理已接收（行为未测）；P05 源码完成待验收（行为未测）；P06 预检 done/真实验收 not-run。

## 归档旁支：host spike / 契约研究（不作为开发目标）

- 设计 v2/v3/v4 三轮未过，v4 停止候选保留（274 行、快照、resolution）；不 v5、不恢复旧 A。
- Docker 只读预检仅证明 socket 3 GET 200；Linux materials BLOCKED_TO_DOWNLOAD；Stage1 first/retry 均 BLOCKED；container 清理 204/404；所有 create/retry 额度耗尽。
- 旧网络/契约 author `ses_e30fed41effe7IFKwrZ4J0bO5R` 已止写，不再追加 cleanup/review；当前无 live 旁支。
- 这些历史只保留为失败/not-run 证据，不构成功能进度、隔离结论或 Stage1 通过；真实 host 问题并入产品适配/最终集成。

## P03 当前实际代码单元

- 已交付：P03-provenance PASS（U1/U2 原生归属门）；extract/create 与 C2 生命周期相关代码已接线，但不代表 P03 完成。
- 代码范围：完整 seed 本地准入、关系目标/版本/record hash/source epoch 冻结、additive/replacement 更新、source retirement、TTL、trusted git common-dir global promotion/invalidation。
- 首次旧快照检查：`cd plugin && npm run typecheck`，exit **2**；原始输出/exit：`tmp/full-auto-memory/product/p03-lifecycle/typecheck.log/.exit`。错误为 `admission.ts` 缺 `sha16` 导入、`lifecycle.ts` 从 `types.ts` 导入不存在的 `ChangeInput`。
- 两处 import 已修正并包含在 patch；当前快照唯一必要重检 `cd plugin && npm run typecheck` exit **0**，原始输出/exit：`typecheck-after-import.log/.exit`。此结果只证明 TypeScript 编译；测试、全量 verify、独立复核、真实 host/model/data 均未运行/验证。
- before 快照：`tmp/full-auto-memory/product/p03-lifecycle/before/`；完整 15 路径相对 patch：`tmp/full-auto-memory/product/p03-lifecycle/p03-lifecycle.patch`，含 `review/input.ts` 与 `review/accept.ts` 的生命周期时间戳传递；补充快照重建方式见 `before/MANIFEST.txt`。
- 下一步：再接 maintenance/mode/status → P04 → P05 → P06 → P07 主代理整体验收与最终报告；保留所有历史失败/未运行证据。

## P03-C1 归属门（2026-11-12，代码事实）

- 产品改动：`plugin.ts` 自动事件、`session.created`、context hook 均先校验原生归属；新增 `session/provenance.ts`；`SessionState.sessionDirectory`；`review/orchestrator.ts` 增自动 `ownsNative` 门。
- 结果：unknown/foreign 不写当前项目 hook/queue/review、不抢 seen；created unknown/foreign 不 refresh/不接管；同项目 root 正常采集/refresh/review；created 缺 parent 不猜 root；child 不学习。
- 证据：`plugin-wiring.test.ts` RED 6 failed/10，GREEN 10/10；`plugin.test.ts` 7/7；`review-orchestrator.test.ts` 20/20；`npm run typecheck` exit 0；日志在 `tmp/full-auto-memory/product/p03-provenance/`。
- 边界：未实现 extract/消息 span、update/undo/global、maintenance/mode/status；未跑 `npm run verify`、未验证真实 host、未 commit/push；P03 未完成。

### P03-C1 fix1（2026-11-12，代码事实）

- I1：`resolveFreshOwnership` 让 fresh event/`session.get` 优先并替换 `sessionDirectory`；turn/context/auto schedule/recover/runNow/consolidate 均 fresh 校验，旧 cache 不再放行 A；move 测试 B 接管且 cache 变 B。
- I2：orchestrator 内部 `reason` 传到 `onAccepted`，manual 仅在 native unavailable 时回退既有 contextProjectKey guard；legacy manual accept→consolidate→queue/items 已验证，native foreign manual 拒绝。context 早退仅精确剥离旧 owned 块。
- 证据：`fix1-red.log` 5 failed/15 → `fix1-green.log` 15/15；`fix1-plugin.log` 7/7；`fix1-orchestrator.log` 20/20；`fix1-typecheck.log` exit 0。

### P03-C1 fix2（2026-11-12，代码事实）

- manual legacy fallback：native unavailable 时 stored `sessionDirectory` foreign → `nativeOwnershipStatus` 返回 foreign；`consolidate` 复用该状态，不再仅凭 contextKey 兜底；fresh owned 仍覆盖旧 foreign cache，无目录 legacy manual 保持。
- 证据：新增 stored B + contextKey A + get unavailable 的 setupPlugin 回归；`fix2-red.log` failed → `fix2-green.log` 16/16 exit 0；`fix2-typecheck.log` exit 0。

### P03-C1 fix3（2026-11-12，代码事实）

- native unavailable 时 stored `readSession` 异常返回 `mismatch`，不再被当作合法 missing 走 legacy manual fallback；读成功 missing/owned 保持原行为，fresh owned 优先不变。
- 证据：setupPlugin 受控 read-error 回归；`fix3-red.log` failed → `fix3-green.log` 17/17 exit 0；`fix3-typecheck.log` exit 0。

### P03 extract create-only 竖切（2026-11-12）

- 代码：完整 user message evidence 与 UTF-16 span/hash；独立 extract provider、严格 parser、本地正类准入；turn 与 auto-review 共用 P01 transactional create。写入前重读 config revision、suppression 与 fresh native root；模型不能指定 source identity/scope；默认关闭、shadow 不写 active item、manual review 保留 legacy 路径。
- RED：`tmp/full-auto-memory/product/p03-extract/p03-extract-red-final.log/.exit`，4 个新增 wiring 断言失败、原有 17 项通过；复现旧队列接收 unsafe 内容及 extract 无接线。
- 定向验收：`cd plugin && npx vitest run test/plugin-wiring.test.ts`，21/21 passed，exit 0；日志 `p03-extract-wiring-attempt3.log/.exit`。过程中的两次分类顺序失败也保留为 `p03-extract-wiring-attempt1/2.log/.exit`。
- 类型检查：`cd plugin && npm run typecheck`，exit 0；`p03-extract-typecheck.log/.exit`。
- 单元 patch：`tmp/full-auto-memory/product/p03-extract/p03-extract.patch`；before 快照在同目录 `before/`（含当时 dirty P01/P02/provenance 状态，不是 clean-HEAD，禁止用于恢复无关文件）。
- 边界：仅 fake host/model + temp Store；未跑完整 `npm run verify`，未验证真实 host/真实模型或真实 dataDir；P03 不完整。`automation.enabled` 仍默认 false，shadow/disabled 不进入 active create。

### P03 extract fix1（2026-11-13，review findings 修复；仅 create 竖切）

- 修复 Critical 本地准入：完整 governing seed 正类校验，危险授权/凭证外传/任意执行/安全绕过 fail-closed；模型字段不能授权；完整 seed 超过 UTF-16 500 字整段跳过；窄增无值 cookie 工程事实正类。
- 修复 Important：protected auto-review `rule`/`skill` 保留原 hook 审查路径并从 extract seed 排除；deferred/pending 不标 ready/reviewedHash，状态可持久恢复；shadow/disabled 不 active 写或误入人工队列。
- Review/Extract 共用原子小时与 24 小时最多 40 次 request 预算；dispatch 与 Retry-After 语义明确。review model 已成功后，extract 预算拒绝不返还已消费的 review run slot。
- 证据：`p03-extract-fix1-green.log/.exit`（五个触及文件 116/116）；`p03-extract-fix1-typecheck.log/.exit`（exit 0）；唯一一次 typecheck。RED 与中间失败记录保留在同目录。
- 补丁：`tmp/full-auto-memory/product/p03-extract/p03-extract-fix1.patch`；`fix1-before/` 是本轮编辑前 dirty-worktree 快照，不是 clean-HEAD，禁止用于恢复无关变更。
- 边界：仅 fake host/model + temp Store；未跑全量 verify/build，未验证真实 host/model/dataDir；未 commit/push/release；仅交付 create 竖切，P03 不完整。

### P03 extract fix2（2026-11-13，历史）

- 根因：旧准入按子串授权，可能把第三方偏好洗成用户偏好；pending 缺少材料摘要时被当作同材料，且新材料未解除 provider 熔断。
- 修复：用有限本地语法完整解析 fact/preference/procedure/reference seed，模型三元组仅与本地解析核对；摘要只含真实 user message ID、role 与完整文本 hash。turn/recovery 共用一次完整 evidence capture；仅确认材料或配置变化时重置 attempts/circuit，同材料重放与重启保持有界，不保存 transcript。
- 证据：`fix2-red.log` 与 `fix2-red-followup.log` 各 exit 1（均复现目标失败）；`fix2-green-final.log` 为 2 个定向测试文件、40/40 通过，exit 0；唯一一次 `npm run typecheck` 的 `fix2-typecheck.log` exit 0。首次 GREEN 的 circuit 失败保留在 `fix2-green.log`。
- 补丁：`tmp/full-auto-memory/product/p03-extract/fix2.patch`（7 个源/测试文件）；本轮 dirty-worktree 快照为同目录 `fix2-before/`，不能用于恢复无关变更。
- 边界：仅 fake host/model + temp Store；未跑 full verify/build，未验证真实 host/model/dataDir；未 commit/push/release。当时 writer 止写等待主代理验收；之后 review findings 触发唯一 fix3 轮，见下。

### P03 extract fix3（2026-11-13，最后修复轮未通过，已停止）

- 范围仅 review.md 72–116 的 C1 typed fact value、I1 未知归属多行前缀、dispatch-failure retry cap；I2–I7 不重开。
- RED：`fix3-red.log` exit 1（5 failed/42 passed）；覆盖命令型值、未知归属拆行、已 dispatch HTTP failure 与零 dispatch 边界。
- 定向测试：`fix3-targeted-tests.log` exit 1（46/47）；唯一失败为重启后 `toMatchObject({dueAt: undefined})` 要求属性存在，而持久化对象省略该字段；未作第4轮验证/修补，不宣称闭合。
- Typecheck：`fix3-typecheck.log` exit 0。尝试补丁：`fix3.patch`；before：`fix3-before/`。
- 失败停止后，仅从本轮 before 恢复 5 个代码/测试文件；RED、测试、typecheck 日志/exit 与尝试 patch 保留。未派 reviewer、未提交/推送；等待主代理/用户裁决。

#### 用户限定续做（2026-11-13）
- `recovery/before/` 与 `fix3-before/` 五文件逐字节相同；`recovery/recovery.patch` 与 `fix3.patch` 相同。fix3 源码按补丁恢复；仅改 `plugin/test/plugin-wiring.test.ts` 重启断言，要求 pending 存在、attempts 恰为 3、dueAt 值为 undefined；Retry-After、三次上限及重启无第4次 dispatch 检查均保留。
- `Store.writeJson` 使用 `JSON.stringify`，JSON 对象会省略值为 undefined 的属性；失败为断言形状不匹配。唯一指定回归 exit 0（1 passed/29 skipped），command/log/exit 在 `recovery/`。fix3 源码未变，复用 `fix3-typecheck.log/.exit` exit 0；未重跑全量或 typecheck。
- 本轮未独立 review、未宣称 P03 完成；当前 writer 止写，交主代理验收。

### P03-U1b 普通复盘桥（2026-11-16，代码已接；仅 typecheck）

- 入口：`plugin.ts` `ReviewOrchestrator.onAccepted` auto+automation.enabled → `extractCreate(sessionID,"session-review",{excludeEvidence, includeFailedTools, toolEvidence})` → `extract/create.ts` 复用单一 P01 writer；随后只把 rule/skill 交给 `acceptReviewCandidates` 的 protected hook lane。
- 普通候选：fact/preference/reference/decision 仍由 extract 从完整用户原文独立提案并本地准入；不再把普通候选算成 review skipped。
- learning：只取 review input 实际展示过的 `ok=false` tool digest（messageID + digestHash），由同一 extract provider（同 transport/model/variant/purpose/预算）重新提案；`admitToolLearning` 固定 project `fact` + `reviewType:"learning"`，拒绝 user/global 升级。
- 原生核对：写前用 `SessionReader.readForEvidence` 重读 part，核对 tool/partIndex/callID/失败状态，并重算 digestHash/rawHash；不一致 skip 并写 `extract_tool_source_changed`/`extract_learning_rejected` changelog。只持久化 hash/offset/bounded digest，不存工具 args 或 transcript。
- 生命周期：learning create-only，不建立 relation target；`freezeRelationTargets` 忽略 learning item，避免挡住后续用户 claim。source retirement/suppression/owner/config/mode 写前检查沿用既有路径；tool item 停用/撤销仍以 message-level 来源退休，同 message 重扫不能绕过。
- 模式与计数：off 不调用；shadow 只写 ShadowRecord 并返回 `shadowed`；autonomous 真实 add 返 `learned`，已有 item 更新返 `updated`，protected hook 仍走 `queued`，另有 `learningSkipped`/`protectedCandidates`/`learningDeferred` 可选字段。`lastSuccess` 只在真实 add/update 更新。
- 证据：before 快照 `tmp/full-auto-memory/product/p03-review-bridge/before/`；patch `p03-review-bridge.patch`；typecheck 原始日志/exit：`typecheck.log/.exit`（首次 exit 2）、`typecheck-after-fix.log/.exit`（0）、`typecheck-final.log/.exit`（0）、`typecheck-final2.log/.exit`（0）、`typecheck-final3.log/.exit`（0）、`typecheck-final4.log/.exit`（0，最终代码快照）。仅编译；未跑测试/评测/build/full verify，未验证真实 host/model/dataDir。
- fix1（2026-11-16）：`fix-before/` 保存本轮前源码；`fix.patch` 为 fix-before→current；`fix-typecheck3.log/.exit` exit 0；完整 `p03-review-bridge.patch` 已同步到 current。未重跑测试/评测。


## P03-A 历史（archived，不恢复）

- A 三轮失败、review NOT PASS；产品/测试已回滚归档 `p03a-breaker-20261111-202537`；`verify-p03a-rollback.exit=0` 73/926。不是 fix4，不恢复旧 regex。

### P03-A fix1（2026-11-11，review F01–F11/Q01）

- 独立 review `reports/03a-review.md` 判 A 不通过（5 High/4 Medium + Q01）；B 未启动。
- 修复范围仅 A：task/template/placeholder 源边界、无授权词 destructive、review/turn 同一 global 高证据门、`autoUpdate` 全正文变更、显式 `candidateScope`/projectKey、token 边界、真实 `sameNegationObject` 否定守卫、benign 直接执行/token 轮换、`evidenceProjects` 项目身份、`sourceIdentityKey` fail-closed、automation undefined 深合并。
- RED：`p03a-fix1-red.log`，3 files / **19 failed | 76 passed (95)**，均行为断言；非 module-not-found。GREEN：3 files / **95 passed**；`tsc --noEmit` exit 0。
- 完整 `npm run verify` exit 0：**76 files / 1021 tests**；日志 `tmp/full-auto-memory/verification/verify-p03a-fix1.log` / `.exit`（557 行）；`git diff --check` 通过。
- 产物：基准 `tmp/full-auto-memory/reviews/p03a-fix1-before/`；diff `p03a-fix1.patch`（7 files / 752 行，dry-run apply 0）；报告 `reports/03a-policy.md` §8（含 F03 文档矛盾裁决记录与 C1/C2 交接）。
- 边界：未接线 Store/plugin/consolidate/server；C1 仍需组合 classify+verbatim+parent 三态与 P01 双通道键；C2 仍负责唯一 target/CAS；`undoWindowHours=24` 仅未接线 legacy；**P03 未完成**。

### P03-A fix2（2026-11-11，F12/F13/F14）

- F12：supersede token 计数与定位同源（唯一边界索引），混排 15199/5199、v1.20/v1.2、路径片段只改独立 token；不唯一/无完整 token → not_single_diff。
- F13：destructive/deploy 从“字样即 protected”改为分句安全流程判定；删库前先备份/上线前先测试/清空前先停服务→preference；同句真实删除/部署或“不用问”仍 protected。
- F14：`types.autoUpdate` 注释同步 R2 总开关；R7 窄裁决已落 phase03，R1–R6 不变。
- RED 3 files / **5 failed | 99 passed (104)**（`p03a-fix2-red.log`）；GREEN **104 passed**；tsc exit 0；完整 verify **76 files / 1030 tests exit 0**（`verify-p03a-fix2.log/.exit`，556 行）；`git diff --check` 0。
- 基准 `p03a-fix2-before/`；diff `p03a-fix2.patch`（6 files / 252 行，dry-run 0）；报告 `reports/03a-policy.md` §9；B 未启动，**P03 未完成**。

### P03-A fix3（2026-11-11，F15/F16）

- F15：安全前缀不得掩盖无分隔执行尾部；准备子句须“条件段恰一个敏感动作 + 前/之前 + 准备步骤”，尾部再出现敏感动作/执行意图即 protected。
- F16：`前/之前` 后可选空白/逗号再接先/要/需要/必须；`上线前，先跑测试` 等与无逗号同义 → preference/auto。
- R8 窄裁决已落 phase03；F12 token 索引、F14 注释、R1–R7 与 source keys 未改。
- RED 2 files / **3 failed | 102 passed (105)**（`p03a-fix3-red.log`）；GREEN **105 passed**；tsc exit 0；完整 verify **76 files / 1031 tests exit 0**（`verify-p03a-fix3.log/.exit`，555 行）；`git diff --check` 0。
- 基准 `p03a-fix3-before/`；diff `p03a-fix3.patch`（3 files / 160 行，dry-run 0）；报告 `reports/03a-policy.md` §10；B 未启动，**P03 未完成**。

## P03 安全停止（2026-11-11，A 三轮后 breaker）

- `03a-review.md` §10 仍 **NOT PASS**：F16 已闭合；F15 因 **F17** 未闭合——`workflowClauseSafe` 对无敏感目标的“随后部署/直接删除”等执行尾早退放行，route 仍 auto。三轮修复后仍 blocking，按硬规则停止，不进入 fix4。
- 1031 tests 全绿仅是事实，**不构成策略通过**；A 未验收，B 未启动。
- 已安全撤回 A 自有 8 个产品/测试文件：`types.ts`/`config.ts` 用反向 patch 恢复 `p03a-before`；6 个新增文件移入 `tmp/full-auto-memory/reviews/p03a-breaker-20261111-202537/`（含 MANIFEST + 4 个 patch + review/policy 证据）。
- 验证：`diff -rq p03a-before/plugin/src plugin/src` 与 `plugin/test` 均 exit 0；`npm run verify` exit 0，**73 files / 926 tests**；日志 `tmp/full-auto-memory/verification/verify-p03a-rollback.log/.exit`；`git diff --check` 0。
- P01/P02 源码、测试、未提交状态与全部证据保留；未使用 `rm`/`git reset`/`git clean`/`git checkout`；未提交/推送。
- **P03 安全停止后用户已选择重设计继续**：`redesign_resume`，无附加 note；不是 fix4，不恢复旧 regex。P02 followups 未做，B/C1/C2/D/E 未启动。
- 归档路径：`p03a-breaker-20261111-202537`；回滚验证 `verify-p03a-rollback.exit=0`（73 files / 926 tests）已亲读。

## 当前阻塞 / 后续

- 历史记录保留：P03 extract 限定续做回归 exit 0；C1/I1 边界重做 GREEN exit 1 后四个文件已回退，typecheck not-run。均为历史，不是当前 live 门。
- 当前无产品 writer、无独立 reviewer、无运行中测试/迁移任务。P00–P06 源码已由主代理接收；P07 报告已落版并由主代理读后接收，P07 报告完成。
- 当前唯一剩余动作是主代理紧接关闭 native p7；不启动新的开发/验证/独立 review 任务，文档 writer 已止写。
- 行为、真实 host/model/dataDir、P05 视觉/键盘、P06 迁移/回滚/GC/soak 均未验证；正式启用与生产迁移需用户另行确认。
- 验证纪律：不重复基线。产品既有 P01/P02 74/929 与 P00 63/803 仅为历史证据，本次不重跑、不宣称新验证；未跑项已在最终报告如实注明。

本机调度恢复索引：`tmp/full-auto-memory/orchestration.md`（gitignored；P01 若同时写 PROGRESS，以 P01 版本为准，稍后补此行）。

## 2026-11-18 v0.6.0 发版验证（追加）

- `npm run verify` exit 0：82 files / 1080 tests；plugin/console/extension typecheck、plugin/console build、extension service proxy、`git diff --check` 全过。
- 0.6.0 已安装到本机（plugin `~/.config/opencode/plugins/open-mem`；extension `~/.config/openchamber/extensions/openmem`，仍 disabled）。
- 扩展包：`dist/openmem-console-extension-0.6.0-20261118T074418Z.zip`。
- 发布流程：`release/v0.6.0` → PR → `main` → tag `v0.6.0` → GitHub Release。上文 11-16 的“未验证/唯一剩余动作”保留为历史，不再代表当前状态。
