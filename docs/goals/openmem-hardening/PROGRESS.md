# OpenMem 稳定性与 UX 实施记录

用户已批准推荐方案；主会话执行与复核，不调用 subagent，不提交、不发布、不操作线上数据。
当前 main 工作树已有大量其他会话变更，用户已明确同意在原位置增量实施，不覆盖这些变更。

## 目标
优先消除丢数据、跨项目污染、敏感信息外送与不可恢复操作，保持流畅的用户操作，错误可解释、可恢复。

## 已验证
- 损坏 JSON 不再静默回落并覆盖原文件。
- items append/touch、hooks append/upsert/prune 使用跨实例文件锁。
- 维护变更按原快照比较并合并到最新数据；保留新条目，遇并发编辑拒绝覆盖。
- compact 跳过规则、人工批准、promoted 及缺少项目标识的项目条目，按项目隔离。
- turn/review 去重与 merge/apply 目标按 scope + projectKey 隔离。
- 初始化、统计、token、队列操作与大多数持久化写入使用同一跨实例文件锁；双 Node 进程计数测试通过。
- 捕获前拦截凭证、模型请求防御性脱敏；规则永不自动写入，代理工具不得批准、应用建议或提升正式记忆。
- 直接模型端点仅 HTTPS ollama.com / loopback；本地不收云凭证，拒绝重定向。
- 容量阻塞候选保留待重试并复用分类；满队列仍可批准腾空；扫描游标前保存超批次候选。
- Shadow 有界并优先保留误报样本；实际模型请求预算跨实例共享，repair/retry 也计数。
- 复盘租约存储独立过期时间，短 TTL 操作不再提前清掉长租约；事件流重连及 workspace 归属补齐。
- 上下文为 global 预留槽位，known-title、去重、建议和提升按项目身份隔离。
- 控制台提供失效 token 更换、URL 清理、60 秒一次性连接链接、自动重连和真实在线状态。
- session/skill 主操作分别改为提升/转草稿；流程草稿不安装；延后可取消，笔记可忽略/恢复。
- 历史支持批准/拒绝/提升恢复、压缩预览及撤销；curator 撤销接入冲突快照并重建视图。
- 合并建议保存目标内容版本；目标改变要求重新生成。Store CAS 防止读取后并发编辑被覆盖。
- 合并撤销完整恢复原 metadata，拒绝后来编辑/不完整旧 journal；恢复和撤销写入阶段标记，可重试部分中断。
- 移动端导航网格、KPI 两列、主要触控目标 44px；实测详情获得焦点，无页面横向溢出。

## 验证记录
- 早期完整门禁：41 文件 / 242 用例；后续修改不能继承该数字。
- 2026-11-04 18:56：`npm run verify` exit 0，41 文件 / 259 用例；三端类型检查、两端构建、扩展构建及代理测试、diff whitespace 检查通过。
- 最终结果见本节末尾的补记；本仓库新增统一 `verify` 和只读权限 CI，但未 push，未声称远程 CI 已运行。
- 2026-11-04 19:00 最终工程门禁：`npm run verify` **exit 0，41 文件 / 260 用例**；plugin/console/extension typecheck、plugin/console build、扩展 bundle build、service proxy test、`git diff --check` 全部通过。package/lock JSON 与 CI YAML 解析通过。日志：`tmp/hardening-verify-final.log`（忽略目录，不作为已提交交付物）。
- 合成浏览器已检查：session 提升、skill 转草稿跳转、历史恢复、压缩预览取消、token 更换、一次性链接登录、笔记忽略/恢复。
- 390px Playwright：候选详情为 activeElement，选中后滚动进入视野；document scrollWidth 375，无横向溢出。OpenChamber 的点击工具会恢复自己的滚动位置，因此该项另用独立 Playwright 验证。
- 模型网络调用全部禁用；故障注入的 event stream 日志是预期测试输出。真实用户数据/配置未触碰，没有提交或发布。
- 收尾确认：自开的 OpenChamber/Playwright 页面已关闭，fixture PID 已退出，47839 端口拒绝连接。Playwright 页面在 fixture 15 分钟到期后仍尝试重连，记录的是 `ERR_CONNECTION_REFUSED`；未声称该退出后的日志为零错误。

## 实施顺序
1. 完成存储写锁、故障处理、维护恢复；再复核项目隔离边界。
2. 敏感信息前置、审批门禁、服务安全。
3. 容量恢复、reservation/review 并发、预算与上下文优先级。
4. 控制台正确操作、错误反馈、历史与恢复。
5. 全量测试、类型、构建与 UX 冒烟；主会话独立再读 diff 复核。

## 决策
- 保留已配置的模型行为，不偷偷关闭用户已启用的 review；说明 shadow 不等于零模型调用。
- 不执行真实数据历史清理或迁移；代码中的维护必须能解释、可恢复，验证只用合成测试目录。
- 明确 token 是本地授权凭证，而非真人身份断言；不增加没有实际隔离价值的伪确认令牌。
- Ruling: 用户禁止 subagent，因此最终复核在主会话另行读核心路径、diff 与故障边界完成；没有独立第二审阅者，不能宣称同等审查强度。
- Ruling: 对旧版缺少 after 快照的 journal 拒绝自动撤销，而不是冒险覆盖；代价是历史操作需要用户核对备份后手动恢复。
- Ruling: 不擅自选择并执行长期数据清理策略；保留用户数据和恢复窗口，代价是下述增长风险尚未关闭。

## 19:00 主会话复核发现（历史快照，已由后续任务关闭实现缺口）

以下是后续授权实施前的风险快照；任务 8/9/10 的处理和最终门禁见本文后段。真实模型、硬件故障、长期 soak 等验证限制仍然有效。

2026-11-04：用户随后一次性授权完成所有剩余任务，不再逐项询问。为使清理建立在可靠恢复基础上，执行顺序调整为 9 → 8 → 10 → 最终门禁，见 REMAINING-PLAN.md。

1. **长期保留策略待确认/实施**：maintenance/recovery/curator/merge journals、完整 items 备份、archived items、state.sessions 仍可增长。20 MB 是 admission guard，不是文件系统硬配额；达到限制会影响采集。不能把“备份存在”当成“备份保留已实现”。下一步需确定保留天数、最低可恢复份数及冷归档/删除方式。
   - 用户已通过选择页确认：90 天恢复窗口、至少最近 20 次、90 天不活跃状态冷归档、清理先预览并由用户确认。尚未实现；具体保护与恢复边界见 `RETENTION-DESIGN.md`。
2. **审批/apply 的跨文件崩溃提交恢复未完整实现**：单次写入和 undo/restore 有锁、快照与阶段保护，但审批仍跨 items/queue/journal/views 多个写入。需要提交 journal/WAL、重启 replay、逐写入点故障注入；目前仅证明指定的恢复重试，不证明所有断电边界或 fsync 耐久性。
3. **剩余并发边界**：部分缓存和 skill metadata 仍是外部 read-modify-write；极慢操作超过租约后缺少 fencing/owner token 完整保护。预算本身在锁内计数，但缓存丢失会导致多余请求（受预算限制）。容量 admission 与实际追加不是一个事务，跨不同候选并发时仍可能越界。
4. **UX 剩余项**：队列还缺独立 project 筛选；部分次要控件、全套屏幕阅读器和扩展 iframe 交互没有全面认证。当前自动化不覆盖所有视觉/辅助功能状态。
5. **证据与验证限制**：promotion 仍以用户明确批准为主，不强制多会话/多证据门槛；未重新进行付费真实模型、真实用户 store、长时间 soak 或远程 CI。保留已通过的历史 L4 记录，但不能继承为本轮证据。

当时 1–3 未关闭，因此不建议无人值守长期上线；该判断不是当前实现状态。

## 后续执行：任务 9 已验证
- Store 使用 AsyncLocalStorage 隔离事务内暂存，多文件先持久化 redo WAL，再原子替换；init 和后续写操作先重放未完成提交。单文件走 fsync + rename 快路径。
- 审批/apply/合并撤销/session note 提升，以及服务器的恢复、笔记状态和流程转草稿已接入逻辑事务；{ok:false}/异常不提交暂存结果。
- 自动写与队列 admission 在锁内复核并和对应 hook/items/queue 一起提交；并发容量回归 RED→GREEN。
- lease 保存 owner token；旧 owner 不能释放 successor，主要提交入口复核 owner。缓存 RMW 合并、skill metadata 更新加事务；后台 review/event 退出先 drain，避免关闭后残留写入。
- 故障注入：两个文件事务的三个 rename 边界，以及批准操作实际出现的每一个 rename 边界逐一杀掉子进程，重启后验证 queue/item/audit view/history 一致；重放幂等。
- 2026-11-04 22:54：`npm run verify` exit 0，42 文件 / 270 用例，完整类型、构建、扩展代理测试及 diff 检查通过。日志 `tmp/transaction-verify.log`。
- 限制：这是 redo commit 与初始化/写前恢复；并发只读请求在物理多文件替换的瞬间不具备数据库 MVCC 快照。没有声称真实断电、磁盘硬件故障或任意第三方程序绕过锁修改文件也安全。

## 后续执行：任务 8 已验证
- 90 天 / 每类至少最近 20 次；健康页只读预览后明确确认清理，后台不自动删历史。
- 维护 journal+备份成组保留，curator/recovery 引用闭包保护关联 journal/item；时间不明、损坏、进行中记录保守保留。清理路径拒绝 symlink/越界。
- 90 天不活跃状态冷归档；readSession 和 updateSession 按 ID 恢复原扫描游标、parent metadata、固定 context，已扫描用户消息不会因此再次分类。
- 清理进入 redo WAL；实际删除第一个文件后杀掉进程，init 重放后验证剩 20 份、会话完整归档、审计只记一次。
- 合成浏览器：预览 5 个过期文件与 1 个会话；取消无写入；确认后实查 recovery=20、archive=1、active state=0，队列保持 4 条。只操作 tmp/ux-smoke-*。
- 2026-11-04 23:15：`npm run verify` exit 0，43 文件 / 279 用例，扩展清理 job 代理、全部类型/构建与 diff 检查通过。日志 `tmp/retention-verify.log`。
- 保留窗口是保护下限，不承诺数据目录永远小于 20 MB；保护窗口内数据过大时明示不能安全释放，不以删除有效恢复记录换容量。

## 后续执行：任务 10 已验证
- 队列按来源项目精确筛选，项目选项跨筛选保留；支持无归属项。列表/详情显示归属，提升确认明确目标项目而非含糊的“当前项目”。API 回归 21 用例通过。
- 加载失败保留原列表和详情，但禁用写入与批量操作；明确显示失败而不是持续“加载中”，刷新后恢复并正确显示项目 B。
- 浏览器合成检查：项目 A 仅 ux-session / ux-skill；项目 B 仅 ux-project-b。390px 与 1280px 无页面横向溢出。
- 原生候选按钮 Enter 打开并聚焦详情；候选/复选框点击区/窄屏来源按钮至少 44px。确认弹窗隔离背景、Tab 循环、Escape 取消后解除 inert 并回焦“保存到项目”，队列未改变。
- 六个页面可见控件可访问名称检查发现设置页 12 个缺少关联标签的字段；补齐 aria-label 后新 bundle 实测缺失为 0，三端 typecheck 和控制台 build 通过。这不是完整屏幕阅读器或 WCAG 认证。
- Ruling: 按用户禁止 subagent 的要求，最终审查采用主会话单独复核，不声称独立审查；保留现有 main 工作树，不提交、不发布。

## 最终主会话复核与完成门禁（2026-11-05）
- Final review: self-review（用户禁止 subagent）。单独复核事务嵌套、WAL 重放、保留引用、冷归档续聊、项目筛选失败禁写和弹窗焦点，未冒充独立第二审阅者。
- Final: fixed 嵌套事务异常被外层捕获时暂存写入泄漏 — 新增 nested rollback 回归 RED→GREEN，保留外层写入，丢弃内层写入。
- Final: fixed 仅时间经过导致待删行变化而旧预览仍可执行 — 新增 89→91 天行删除回归 RED→GREEN，指纹包含最终保留行集合。
- Final: fixed 冷会话归档被当成历史备份删除 — 25 个过期冷归档回归 RED→GREEN；旧游标仍可读取。
- Ruling: 冷归档是唯一会话状态时始终保留，不按备份窗口删除；否则会破坏续聊游标/context，代价是冷归档磁盘仍可能增长。若判断错误，后续需要用户明确的会话删除策略，而非后台静默清理。
- 补齐 merge apply 实际每个 rename 边界逐点退出验证；批准与 apply 都验证重启后队列、条目、journal、审计视图/历史一致。
- 2026-11-05 00:00：`npm run verify` **exit 0，43 文件 / 284 用例**；plugin/console/extension typecheck、plugin/console build、扩展 bundles、service proxy test、`git diff --check` 全通过。日志 `tmp/hardening-completion-verify.log`。
- 00:01 收尾实查：本轮 Playwright 页面关闭；仅停止身份标记匹配的合成 fixture PID 82972，进程已退出，127.0.0.1:47839 拒绝连接；测试目录保留供追溯，不清理真实数据。package/lock JSON 解析通过。
- 全部已授权实施项已完成；仍未做真实模型/真实 store/远程 CI/长期 soak/完整屏幕阅读器认证/真实断电与硬件故障验证。redo WAL 不等于只读 MVCC；保留保护下限不等于磁盘硬配额。
- 当前工作树未提交、未发布、未安装；已有其他工作树变更保留。最终说明见 `EXECUTION-REPORT.md`。

## 2026-11-06 记忆图谱、基线覆盖与安全复核
- 阶段 0：地图节点不再携带正文；Console 生成建议的邻居按 scope/projectKey 过滤；数值/端口/版本/日期/否定词变化不再被 0.92 相似度静默丢弃；同文本不同 kind 进入分类冲突；false-positive shadow 不再阻塞候选；审计与健康指标按 scope/projectKey 隔离；scope migration 增加 preview 版本与 undo 校验。
- 阶段 1：`GET /api/graph` 五视图（架构/记忆/路由/自动化/备份）；`GET /api/graph/source` 仅按目录白名单读取有界正文；Console `记忆图谱` 单页内部视图；点云保留为“相似性”子视图；备份视图明确 OpenMem/逻辑链图恢复缺口。
- 阶段 2：`plugin/src/baseline.ts` 只读 L0/L2 段落索引，`GET /api/queue` 返回位置型 coverage；Queue 显示“基线已覆盖/相关/冲突”；基线不可用或部分可用时明确提示“未匹配不等于未覆盖”。
- 阶段 3（只读部分）：Inventory 显示无损关系组（完全重复/已覆盖/分类不一致/冲突），不改写、不合并、不删除。
- 全局恢复脚本：将进程停止检查提到任何写入之前，并增加 `opencode serve` 检查；备份文件 `rollback-memory.sh.bak-20261106-114300`。未新增 OpenMem 自动恢复或逻辑链图快照。
- 验证：`npm run verify` exit 0；57 文件 / 695 用例；三端 typecheck、构建、扩展代理测试、`git diff --check` 全通过；合成 UX fixture 检查桌面与窄屏，页面关闭、端口 47839 已关闭。
- 未实施：阶段 4 真实语义改写/无人值守合并（需要后续明确授权）；L1 CAS 未由宿主提供，插件保持只读；未覆盖安装目录 `/Users/11169285/Documents/Opencode project/open-mem/plugin`。

## 2026-11-06 NEXT-PLAN 第一批安全收口（已实施）
- compact/curator 只对 `isExactRelation` 的同 kind 完全重复归档；端口、版本、否定差异不再因 SimHash/0.92 相似度被合并。
- 单条 apply 要求建议 ready 且 `validation.ok`；人工编辑走独立 `humanEdited` 记录；写入前重跑 `validateRewrite`，补否定/限定条件保留。无效建议不再标记为 ready。
- scope classifier 先判显式跨项目，再判项目证据，最后才接受频率词；review 模型 scope 经确定性钳制，project 无 projectKey 时降级为 session note；中文“端口是 5199”和 `port 5199` 纳入 volatile。
- agent `review`/`suggest`/`decide` 按调用方 projectKey/session 过滤，外项目 ID 返回明确错误；`status`/`audit` 只输出可见范围；`console_url`/`/memory-console` 只在宿主浏览器打开一次性链接，不把 ticket 返回模型。
- scope migration 预览返回 `previewID`，apply 只执行预览集合并逐行校验；backup/journal/queue patch 进入同一事务，undo 在同一事务写 undone 标记；迁移脚本同步发送 `previewID`。
- 验证：`npm run verify` exit 0，59 文件 / 739 用例；plugin/console/extension typecheck、plugin/console build、extension bundle 与 service proxy、`git diff --check` 全通过。日志 `tmp/nextplan-first-batch-verify.log`。
- 复核后补修：`exact` 只认规范化同文；否定/限定按标记集合而非“是否存在”比较；`keep_both` 保留候选而非复制目标；跨 kind 不再提供合并建议；UI 仅正文编辑可绕过失败建议，标题编辑不行；`always/never/我习惯` 在项目证据下留在项目；review 的 global 只由用户原话证据升级；session 去重/邻接按 sessionID 隔离；`console_url` 不再由模型触发浏览器。
- 未做：approve/consolidate 自动写入的确定性冲突守卫、关系判断的“新增数字≠冲突”细化、阶段 2–8 其余项；未触碰真实 store、安装目录、发布或提交。
- 安全边界：token/ticket 仍是本机授权凭证，不是真人身份认证；同 OS 用户有 shell 时仍可读取本地凭证。
