# P03 Hybrid design — safety stop

Date: 2026-11-12
Status: **设计修订停止，待用户裁决**。不是 P03 通过，不是产品完成。
Scope: 只冻结 v4 设计评审阻塞并核验最后已验收 P02+wiring 产品基线；无 v5、无产品修复、无 host/模型/语料运行。

## 1. 迭代记录

- v1 保留 `tmp/full-auto-memory/reviews/hybrid-design-v1.md`；v2/v3 历史相应保留。
- v4 候选 274 行，快照 `tmp/full-auto-memory/reviews/hybrid-design-v4.md`；SHA-256 `0933bd0240b5ebd5181bd09fe375a1cf2beb29223563558d06e399b0ea44fd3b`；文档 diff `hybrid-design-v4.patch` 135 行；resolution §8。
- 三轮修订后仍未过，触发停止条件；不再自动发 v5。

## 2. 仍未闭合的阻塞

### Builder §18

- O1–O3 已 closed。
- **H5 事务接线归属**仍 open：P01 行为保持 vs `server.ts`/`changes.ts` 外层事务归属未落到单一文件清单。
- **H5 容量语义**仍 open：`retiredSourcesMax` 满时，阻断新 retire 还是新 capture 未写死。
- 明确补一句事务归属与容量优先后才可进入 `writing-plans`；不是重做 global/retired 语义。

### Safety §12

- **H5 stop/undo 容量优先 + 统一 wrapper** blocking：索引满时用户 stop/undo 必须优先；所有 stop 入口（P03/legacy/console）需同一事务 wrapper，否则 legacy 绕过 retired index。
- **H4 linked-source retirement** blocking：global stop/undo/invalidate 必须把 linkGroup 内 project 副本来源写入 retired；新 global admission 检查 retiredGroup，否则刚停的 global 可由同 message 再升。
- **H4 group 单 active** blocking：restore 一个 project 副本时，若 global 仍 active 会双注入；必须保证每 group 至多一个 active，或 restored 副本只作 non-injecting alias。
- **O1 narrow**：`EvidenceRef.id` 未含 `originProjectKey`/`transformVersion`/redaction profile；跨 origin 重用 id 会丢失证据。
- **O2 narrow**：`targetSetHash` 需显式含 scope 过滤，防 project claim 对 global item supersede。
- 其他 H1/H2/H3/H6/H7/H8/H9/H10 已答；H5/H4 仍是契约矛盾，非措辞。

## 3. 产品基线核验

方法：从 `p02-wiring-before/plugin/src` 与 `plugin/test` 复制到唯一 tmp expected 目录，应用 `p02-wiring.patch`，再与当前 `plugin/src/test` 逐文件比较；**未在当前产品 apply/revert**。

- Expected dir: `tmp/full-auto-memory/reviews/p02-wiring-expected.mM8cLB`
- Patch apply: exit 0
- `diff -rq` src/test：**0 输出**
- 结论：当前产品源码/测试等于最后 P02+wiring 基线；本轮无产品净变更。

## 4. 本轮完整门禁（新跑，非旧日志）

```text
npm run verify
Test Files  74 passed (74)
Tests       929 passed (929)
Duration    73.19s
exit=0
git diff --check exit=0
```

日志：

- `tmp/full-auto-memory/verification/verify-hybrid-design-stop.log`
- `tmp/full-auto-memory/verification/verify-hybrid-design-stop.exit`

## 5. 未运行 / 不声明

- 未运行 P03 产品代码、host、真实模型、真实语料、P04/P05/P06/P07。
- 未安装、未提交、未推送、未触碰正式目录/真实配置/真实记忆。
- 候选 v4 是未批准草案；保留证据，不伪称“已回滚已实现功能”（P03 从未起产品代码）。
- 本轮验证只证明产品基线仍为 74/929，不证明设计可批准或 host 隔离成立。

## 6. 待用户裁决

1. **先做隔离 host 能力验证，再集中重设持久状态契约**：需用户授权 spike；当前未启动 host，不能假定 host 原生字段/权限/原文重读可用。
2. **暂停**：保持 P02+wiring 基线，不继续设计修订；P03 不进入实现。

两条路都不授权 v5 自动修补；用户选定后才更新计划。
