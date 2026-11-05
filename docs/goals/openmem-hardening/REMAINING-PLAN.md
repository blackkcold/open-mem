# Remaining hardening implementation plan

> 主会话采用 executing-plans；用户已一次性授权完成，不再重复询问。禁止 subagent、提交、发布、真实 store 清理与模型调用。

**Goal:** 完成跨文件恢复、90 天历史保留/会话冷归档、项目筛选与最后验收。
**Architecture:** 保留 JSON 文件存储；Store 统一锁内暂存多文件写入，通过持久化 redo WAL 提交和重放。历史清理使用只读指纹预览，确认后锁内校验执行。UI 沿用现有控制台。
**Stack:** TypeScript/Node、React、Vitest。
**Spec:** RETENTION-DESIGN.md、PROGRESS.md 和已批准的 UX/稳定性优先约束。

## Global constraints
- 90 天恢复窗口，每类至少最近 20 次；90 天不活跃会话冷归档。
- 未知/损坏/进行中/被引用记录保守保留；活跃记忆和队列不清理。
- 用户面清理先预览再确认；本次不执行真实数据清理。
- 不抑制类型错误，不覆盖其他会话工作。

## Review focus
- 任一跨文件写入点进程退出：重启后只得到完整提交或原状态，不重复创建。
- 同实例/跨实例并发：事务上下文不得泄漏；读取后的旧快照不能覆盖新结果。
- 保留边界和依赖：90 天/至少 20 次、进行中 journal、恢复引用与缺少时间。
- 冷归档后旧会话续聊：原游标与固定 context 可恢复。
- 恶意/过期预览与 symlink：不删边界外文件，不覆盖预览后新增数据。

## Task 9 first — transaction foundation
Files: plugin/src/store.ts, plugin/src/util/transaction.ts, actions.ts, apply.ts, memory/session-promotion.ts, tests.
- [x] RED: 多文件事务失败不暴露暂存结果；子进程各提交点崩溃后 init 重放；并发隔离。
- [x] Implement: AsyncLocalStorage 暂存、锁内 durable redo WAL、原子替换及重放；包住审批/apply/恢复复合操作。
- [x] Verify: transaction/action/apply/session-note/lock tests + typecheck。
- [x] 补齐关键缓存 RMW 与 lease owner；不增加模型请求。

## Task 8 — retention and cold sessions
Files: retention module, Store session helpers, server.ts, Health.tsx, retention tests.
- [x] RED: 89/90/91 天、最低 20、未知/进行中保护、预览零写入、stale preview、symlink、旧会话恢复。
- [x] Implement: 90 天/20 份默认策略、依赖闭包、预览摘要与确认执行、完整冷归档与定向恢复。
- [x] Verify: retention/API/transaction tests + typecheck；只用合成 store。

## Task 10 — project UX
Files: server.ts, Queue.tsx, console types/tests and fixture.
- [x] RED: 项目筛选不包含其他项目；取消/失败不修改选择。
- [x] Implement: 项目选项与筛选、列表/详情归属标签、可访问的筛选/状态/焦点。
- [x] Verify: API/typecheck + 合成浏览器键盘/窄屏检查。

## Final gate
- [x] npm run verify；文档和 PROGRESS 更新真实数字、已知限制。
- [x] 主会话另行复核恢复/清理边界；关闭自开浏览器和 fixture。
- [x] 只报告真实完成项与未覆盖限制；不声称远程 CI/真实模型/长时间 soak 已运行。

## Final result
2026-11-05 00:00：`npm run verify` exit 0，43 文件 / 284 用例；完整报告见 `EXECUTION-REPORT.md`。
最终主会话复核补齐嵌套异常回滚、纯时间变化导致的旧清理预览失效，以及冷归档不可当过期备份删除的回归。
