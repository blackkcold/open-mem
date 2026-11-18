# P00 preflight — shared-file / interface conflict scan

Date: 2026-11-11
Scope: P0 静态预检 + 既有基线日志复核；不改产品代码、不改真实数据、不提交。
Baseline: `b992a2e` / `feat/full-auto-memory`
Method: 只读 `rg`/`sed` 读现有源码与已安装 V2 SDK 类型；只读 `tmp/full-auto-memory/verification/*`；**未重跑** `npm run verify`（原日志已足以证明）。

## 1. 基线证据复核（读日志，不重跑）

日志文件：

```text
tmp/full-auto-memory/verification/verify-baseline.log   31994 bytes
tmp/full-auto-memory/verification/npm-ci-plugin.log      1005 bytes
tmp/full-auto-memory/verification/npm-ci-console.log      271 bytes
```

从日志直接读到的原文：

```text
 Test Files  63 passed (63)
      Tests  803 passed (803)
exit=0
```

`npm ci`：plugin `added 318 packages` / console `added 75 packages`，两份日志均 `exit=0`。报告同时落在 `docs/goals/full-auto-memory/reports/00-baseline.md` 与根 `reports/00-baseline.md`（内容一致，避免旧链接/新路径任一读不到）。

## 2. V2 hook 签名（已核对本地 SDK，不按 V1 猜）

来源：`plugin/node_modules/@opencode/plugin/dist/promise/session.d.ts`

```ts
export interface SessionRequest {
  readonly sessionID: Session.ID;
  readonly model: Model.Ref;
  system: Array<SystemPart>;
  messages: Array<Message>;
  options: SessionRequestOptions;
}
export interface SessionContext extends SessionRequest {
  readonly agent: Agent.ID;
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>;
}
export interface SessionHooks { readonly context: SessionContext; /* prompt/compaction/generate/... */ }
```

现有代码已使用 `ctx.session.hook("context", async (event) => { event.system.push({ type: "text", text }) })`（`plugin/src/plugin.ts:647`）。P04 的每请求动态召回应复用此附着点：只读 `event.messages`，向 `event.system` 追加一个独立 `SystemPart`；不写 transcript。

## 3. 共享文件 / 接口冲突矩阵

| 文件 | 涉及阶段 | 冲突点 | 裁决 |
|---|---|---|---|
| `plugin/src/types.ts` | P01/P02/P03/P04 | 多人加类型 | P01 先落 `ChangeEvent/UndoConfig/ItemSnapshot`；P02/P03/P04 只追加，不改已落签名 |
| `plugin/src/config.ts` | P01/P02/P03 | `undo` / `review.maxRequestsPerHour` / `automation` 同文件 | 每字段单一 owner；P03 依赖 P01/P02 已落字段；`mergeConfig` 嵌套键不互相覆盖 |
| `plugin/src/store.ts` | P01/P03/P06 | changes/suppressions/quarantine/memoryVersion/retention 同 Store | P01 先落事务与账本；P03 只加 quarantine/预算；P06 只扩展 retention/capacity，不重写事务 |
| `plugin/src/server.ts` | P01/P02/P03/P04 | 单一路由表 | P01 旧 `/api/items` 不动 + 新 `/api/memory/items`；P02/P03/P04 只加路由/字段；P05 只消费 |
| `plugin/src/plugin.ts` | P01/P02/P04 | 同一个 context hook | P01 负责稳定 prefix/版本失效；P04 在其后追加动态 block；P02 注入 provider/status；不得互相覆盖 hook |
| `plugin/src/consolidate.ts` | P01/P03 | 自动写入事务 + 路由 | P03 必须调用 P01 `recordChange`；禁止另写一套写入 |
| `plugin/src/apply.ts` / `actions.ts` | P01/P06 | 人工/legacy undo 也要推进版本 | P01 覆盖 approve/merge/replace/undo；P06 迁移只读/基线事件，不重写 |
| `plugin/src/review/*` | P02 | provider/orchestrator/accept 同批 | P02 单一 owner；不跨阶段拆 |
| `plugin/src/retention.ts` / `capacity.ts` | P01/P06 | 新文件是否计入/受保护 | `dirSize()` 已统计全部文件；P06 必须把新文件加入 retention 预览/保护依赖，容量不必改公式 |
| `console/src/App.tsx` / `Queue.tsx` / `Settings.tsx` | P05 | 路由/拆分 | P05 单一 owner；其他阶段不改 UI |
| `extension/*` | P05 | rail/status | P05 单一 owner |
| `plugin/test/*` | P01–P06 | 测试文件名重叠 | 新测试用独立文件；旧测试不改断言；默认关闭 automation 保持旧行为 |

## 4. 接口/事实裁决

### 4.1 `/api/items` 兼容

现状（`plugin/src/server.ts:831-833`）：

```ts
if (requestURL.pathname === "/api/items" && req.method === "GET") {
  sendJson(res, 200, { items: await store.listItems() });
  return;
}
```

裁决：**旧 `/api/items` 精确保持 `{ items: Item[] }`**，不追加字段、不改分页、不改数组/对象形状。新 memory envelope 走 `GET /api/memory/items`（返回 `{ items: Array<Item & { version; changeID?; latestChange? }>, nextCursor? }`）。未来如要 `?view=memory`，必须显式 opt-in 且默认关闭。

### 4.2 `ItemKind`

`plugin/src/types.ts:1`：

```ts
export type ItemKind = "fact" | "preference" | "rule" | "reference" | "skill";
```

没有 `decision` kind。裁决：P03 的 `autoWriteKinds` 只含 `fact/preference/reference`；review `decision` 落 `fact` + `reviewType:"decision"` / metadata；所有接口/配置/UI 不出现 `decision` kind。

### 4.3 `memoryVersion` 与到期

裁决：`memoryVersion(now)` 必须包含 `expiredCount` + `nextExpiry`（nearest-expiry 时间状态），不能只按文件 mtime/size 缓存。测试：无写入、仅时钟跨过 `expiresAt`，version 改变且 block 排除。`refreshContext` 在每次模型请求的 V2 `context` hook 内执行，不仅 API/tool。

### 4.4 变更账本与快照

裁决：所有路径（自动、人工批准/编辑/合并/替换、提升、legacy undoMerge、curator、session-note promotion、迁移、revert/deactivate/restore）都写 `ChangeEvent` 并推进有效版本。`ItemSnapshot = Item`（无损全量），不省 identity/status/派生/来源字段。派生失效递归 + visited set/深度上限防环；恢复前检查上游全部有效，否则拒绝激活。

### 4.5 保留上限

5000 changes / 2000 suppressions / 200 quarantine 是保留策略，不是让 active 记忆失去撤销。active item 的最新可逆 change 与 `undo.retainDays`（默认 90 天）内的回退快照受保护；保留清理先删最旧、无引用、非 active 事件。`dirSize()` 已统计全部文件；`retention.ts` 需显式加入新文件与保护依赖，`capacity.ts` 公式无需改。

### 4.6 P03 benign 祈使句

裁决：`classifyAuthority` 把“以后提交前先跑 tsc”这类 benign 工作偏好祈使句转 `preference`（保留 user quote、`grantsPermission=false`），不写 L0、不获得执行权；safety/permission/destructive/strict_limit 永不转。任务模板（`<task>`/`<template>`/`{{…}}`）、子会话、引用表格跳过。普通描述性冲突进 `quarantine`，只有 protected 类别进 legacy 高级审查；不制造普通人工队列。`safeAuto` 是模型自评分，不是校准概率，不能单靠 0.96 阈值宣称可靠。

### 4.7 P04 自动召回

裁决：P04 不再只是 tool/API/UI；每个合格真实 user prompt 在 V2 `context` hook 内自动召回当前项目相关记忆，作为一个独立、有界的 `SystemPart` 附着当次请求；不写用户 transcript、不写 pinned `contextBlock`。稳定小偏好 prefix 与动态检索 block 分离；20 轮测试只约束无变更的稳定 prefix。失败 nonblocking。

### 4.8 迁移与 soak

裁决：迁移必须真实执行 dry-run → apply → 校验 → undo → 校验 → 再 apply（幂等），备份/journal/路径守卫齐全。soak 通过 `tsx` 调用真实生产函数（`Store`/`transaction`/`recordChange`/`decideAutomation`/`runConsolidation`/`memoryVersion` 等）+ fake clock，不另写 toy 状态机；报告标注 `simulated: true`，不冒充 30 天现场运行。

## 5. 残余风险

| 风险 | 状态 |
|---|---|
| V2 辅助请求（title/compaction/generate）是否也触发 `context` hook | 未实测；P04 保守跳过，实现阶段用 V2 实测确认 |
| `context` hook 与 `model.request` 顺序 | 未实测；不依赖顺序，只按 `messages`/合成标记过滤 |
| `ItemSnapshot = Item` 后账本体积 | 用保留策略/引用保护；P06 容量演练验证有界 |
| retention 新文件保护规则 | P06 必须补测试；当前 retention 不识别新文件 |
| 旧 `/api/items` 的真实消费者 | 静态扫描未发现 console 调用，但按主代理裁决仍保持形状不变 |

## 6. 结论

P0 预检通过（文档层）：基线日志可证 63 files / 803 tests / exit 0；V2 hook 签名已核对；共享文件冲突均有单一 owner 与顺序；主代理裁决已落入 DESIGN/PLAN/ACCEPTANCE/对应 phases/PROGRESS。未修改产品代码、未提交、未触碰真实数据。
