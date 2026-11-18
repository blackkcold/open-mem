# P07 — final review / delivery report

Status: P07 报告完成（2026-11-16）；主代理已读并接收；无运行 writer；native p7 由主代理紧接关闭
Depends: P00–P06 源码已交付并由主代理逐单元读实际 diff 接收
Blocks: 用户启用评审（独立决定）
Global constraints: 见 `PLAN.md` §2.2

## 目标

由主代理基于已读源码、接口与 UX 方向差异，以及既有必要编译证据，形成最终交付报告；文档 writer 负责落版。P07 不是独立审查者复核，不新开评测/复跑/构建，不改产品代码；发现问题回对应阶段。

## 当前执行口径（2026-11-16）

1. 最新 `PLAN.md` §2.2 与用户指令替代旧 P07“独立复跑、逐条二选一复审”的门禁；不设独立 reviewer，不恢复层层评审。
2. 区分：
   - **Development status: Done**：P00–P06 源码交付与接口接线已由主代理读实际 diff 接收。
   - **Overall acceptance: Partial / not-verified**：ACCEPTANCE 行为判据未在当前未提交工作树快照实际运行验证。
3. 报告路径：`reports/final-review.md`。报告不是“独立审查通过”，也不自行放行生产启用。
4. 生产启用/正式迁移/回滚/GC 实际执行是用户另行确认的独立批次。

## 输入

- `DESIGN.md` / `PLAN.md` / `ACCEPTANCE.md` / `PROGRESS.md`
- `phases/00–06`
- 各单元交付目录与 patch：`tmp/full-auto-memory/product/{p03-provenance,p03-lifecycle,p03-maintenance,p03-review-bridge,p04-recall,p05-ux,p06-retention,p06-migration}/`
- 原始编译/语法日志：各单元 `*typecheck*.log/.exit`、`fix-node-check.log/.exit`
- 只读 git 状态：`tmp/full-auto-memory/product/p07-delivery/git-{branch,head,status,diff-stat}.txt`
- 历史测试报告与日志：`tmp/full-auto-memory/verification/`；只作历史证据，不当当前 HEAD 实测。

## 报告方法

1. 逐条覆盖 `ACCEPTANCE.md`：
   - G0–G11；
   - P01 每行测试与手工审查；
   - P02 每行；
   - P03 每行；
   - P04 每行；
   - P05 S1–S19；
   - P06 每行；
   - P07 边界。
2. 每条使用稳定引用（章节/行号/原 ID），不用“全部通过”概括。
3. 状态区分：
   - `observed`：本轮只读 git/日志；
   - `ran/pass`：此前命令实际运行且原始日志 exit 0，本轮仅读取；
   - `historical`：旧快照结果，不是当前 HEAD；
   - `not-run` / `not-verified`：无行为/环境证据。
4. 编译证据只列 TypeScript/`node --check`，不当作测试、bundle、build、CLI 执行或迁移行为。
5. 本轮不运行额外命令补齐 pass；没有日志就写 not-run。

## 报告结构（`reports/final-review.md`）

```text
# Execution Report
## Metadata
## Summary
## 1. 验收模型与状态口径
## 2. 编译/语法证据索引
## 3. ACCEPTANCE 覆盖
### 3.1 G0–G11
### 3.2 P00
### 3.3 P01 每行
### 3.4 P02 每行
### 3.5 P03 每行
### 3.6 P04 每行
### 3.7 P05 S1–S19
### 3.8 P06 每行
### 3.9 P07 边界
## 4. 未验证项
## 5. 安全、回退与数据边界
## 6. Files Changed
## 7. Tests Run
## 8. Risks
## 9. Unfinished Items
## 10. Recommended Next Step
## 11. Need Codex Review?
```

## 验收

- 报告逐条覆盖 `ACCEPTANCE.md`，每条有稳定引用。
- 所有行为判据默认 `not-verified`；编译/语法证据与行为证据分开。
- 明确 Development status Done vs Overall acceptance Partial/not-verified；不写“生产就绪”“全部测试通过”“正式启用完成”。
- 明确旧 P07 独立复跑/二选一复审门已被 `PLAN.md` §2.2 和用户指令替代，未执行。
- 不改 `ACCEPTANCE.md` 判据，不把未跑项改 pass。
- 不修改产品代码；不制造后续独立 review 任务。
- 主代理已读报告并接收，P07 报告完成；native p7 todo 由主代理紧接关闭；报告本身不声称已由第三方审查通过。

## 历史口径（已被替代，不执行）

旧模板要求：

- 由非实现者独立审查 P01–P06；
- 逐条核对 ACCEPTANCE，不抽样；
- 对自动写入/撤销/跨项目/预算/迁移/UX 独立复跑；
- 结论只能二选一：`可进入用户启用评审` / `需修复后复审`；
- 每条 pass 附命令、退出码、测试名、日志。

该模板被最新 `PLAN.md` §2.2 与用户指令替代：取消重复基线、专项评测和独立复核门；P07 改为主代理整体源码/接口/UX 方向验收 + 最终报告。历史报告与失败/未跑证据保留，不改判。

## 风险

| 风险 | 处理 |
|---|---|
| 自审偏差 | 主代理已实际读各单元 diff，不是仅听作者结论；报告明确不是独立审查 |
| 编译证据过期 | 只列原始日志路径与结果；当前 HEAD 未重跑的行为一律标 not-verified |
| typecheck 被误当行为/数据安全 | 报告逐项标注“仅编译/语法”；迁移/回滚/GC 未执行 |
| 把源码完成当生产启用 | Development Done 与 Overall Partial 分离；启用另批确认 |
| 报告改写 ACCEPTANCE | 只解释边界，不改判据、不把未跑项标 pass |
