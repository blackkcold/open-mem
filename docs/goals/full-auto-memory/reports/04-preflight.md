# P04 preflight — recall wiring

Date: 2026-11-11
Scope: 只读静态核查 + 只更新 `phases/04-recall.md` 与本文件；不改产品代码、不跑测试/构建、不提交、不访问真实 config/dataDir/凭证、不发起模型请求、不创建子代理。
Method: 读基线 `b992a2e` 的 plugin/server/config/types（`git show`，避开 P01 正在写的文件）；读本地已安装 V2 类型（`@opencode/plugin`、`@opencode/ai`、`@opencode/schema`、`@opencode/client`）；读官方 V2 文档 `https://opencode.ai/v2/docs/build/plugins/server` 的 Sessions / Hooks 段；读 `DESIGN.md` §7/§8.4、`PLAN.md` §2、`ACCEPTANCE.md` §5、`reports/00-preflight.md`、`phases/01-reversible-memory.md`。

## 1. 结论

预检通过（文档层）。P04 方案已按 V2 生命周期修正：**`context` hook 只覆盖 agent loop，`title/compaction/generate` 走独立 hook；`instructions.entry.put` 的更新/移除在“下一个 step boundary”才宣布，不能替换本次已装载的 `event.system`**。因此 P04 必须每请求在当次 `event.system` 内定位并替换受控 AUTOPILOT 块，`entry.put` 只作为后续请求的持久化通道（P01 负责）。本预检同时落版：真实 user prompt 识别、工具轮去重、prefix/动态分离与去重、中英/数值/否定匹配、保守 token 预算且超限整项跳过、scope/API/tool 越界防护、全失败 nonblocking + 明确 degraded、fake host 端到端测试契约。未修改产品代码，未运行测试，宿主行为**未实测**。

## 2. V2 生命周期证据

### 2.1 官方文档（observed：本次 webfetch 原文）

来源：`https://opencode.ai/v2/docs/build/plugins/server`，Sessions 段与 Hooks → Model requests 段。

原文要点：

> Attach, list, or remove keyed session instruction entries with `instructions.entry`. Entries render as `<context key="...">` blocks in the session's instructions, and updates or removals are announced at the next step boundary without queuing a message turn.

> `context` runs for the agent loop, including tool-driven continuations. `compaction` runs for checkpoint summaries. `generate` runs for transient `ctx.session.generate` calls. `title` runs for title generation.

> Changes affect only the outgoing model call, not persisted history or configuration.

> The `system` part that holds OpenCode's instructions also lists each source in `metadata.experimental.instructions` as `{ key, text }`, such as `core/date` or `core/environment`, so a hook can tell the sources apart. The list is a copy: editing the part's `text` does not update it. This is experimental and may change.

> Multiple plugins can register the same hook. OpenCode runs them in plugin order, so later hooks see changes made by earlier hooks.

### 2.2 本地已安装类型（observed）

```ts
// @opencode/plugin/dist/promise/session.d.ts
export type SessionRequestKind = "primary" | "compaction" | "title" | "generate";
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
export interface SessionHooks {
  readonly prompt: SessionPrompt;
  readonly context: SessionContext;
  readonly compaction: SessionCompaction;
  readonly generate: SessionGenerate;
  readonly title: SessionTitle;
  readonly "model.request": SessionModelRequest;  // kind 在这里，不在 context
  /* ... */
}

// @opencode/ai/dist/schema/messages.d.ts
type SystemPart = {
  type: "text";
  text: string;
  cache?: CacheHint;
  metadata?: Record<string, unknown>;
};

// @opencode/schema/dist/instruction-entry.d.ts
// Key: string；Info: { key; value: Json }；Snapshot: { key; value; removed }[]

// @opencode/client/dist/effect/api/api.d.ts
SessionInstructionsEntryPutInput = { sessionID; key; value: Json }
SessionInstructionsEntryRemoveInput = { sessionID; key }
```

`SessionRequestKind` 只出现在 `model.request` hook，`context` 事件没有 `kind`；不能用它过滤辅助请求。辅助请求由宿主分流到独立 hook，这是比 V1 更可靠的边界。

### 2.3 生命周期裁决

1. **不能依赖 `entry.put` 保证当次请求**：put 之后，`event.system` 已在 hook 前组装完毕（官方称 hook 修改的是“assembled system instructions immediately before model dispatch”，entry 更新在“next step boundary”宣布）。只做 put 会让撤销/到期在“下下次”才生效。
2. **当次请求必须自证**：每次 hook 读取权威 `contextBlock`（P01 刷新后的 session state），重新渲染，并在 `event.system` 内替换受控来源；替换后校验被撤销文本已不存在，否则删掉整个受控来源（宁可本请求无 prefix，也不注入旧事实）。
3. **只改自己的来源**：通过 `metadata.experimental.instructions` 的 `{key,text}` 或 `<context key="api/plugin.memory-autopilot">` 定位；其他 `core/*` part、宿主自定义 part、其他插件 part 一律不动。
4. **动态 block 不承担持久化**：每次请求从 store 重建，天然不会跨请求残留；仍加“先移除旧动态 part 再追加”的幂等保护。
5. **工具轮不重复**：`context` 会在每次工具续跑时执行；只有末尾连续 user 段（未被 assistant/tool 截断）才视为一次新 prompt。

## 3. 基线现状核查（observed，除注明外均来自 `b992a2e`）

| 项 | 观察 | 影响 |
|---|---|---|
| context hook | `plugin/src/plugin.ts:647-656`：`entry && sessionID` 时 `refreshContext` 后**直接 return**，不会 push 动态 block | P04 必须去掉该短路；先刷新 prefix，再动态召回 |
| prefix 刷新 | `refreshContext`（`plugin.ts:1013-1040`）：`entry.put({key:"plugin.memory-autopilot", value:block})`；文本相同则跳过 put；基线只按 `contextBlock/contextProjectKey` 判断，`contextVersion` 由 P01 补 | P04 消费 P01 的版本/失效；不重写 P01 writer |
| prefix 标记 | `renderContext`（`plugin.ts:1089`）固定以 `## AUTOPILOT` 开头 | 可作旧式/自推 part 的最后一级定位标记 |
| prefix 过滤 | `buildContext`（`plugin.ts:1044`）过滤非 active、expired、scope/projectKey；基线无 `invalidatedBy`（P01 加） | P04 依赖 P01 的 `invalidatedBy`/`expiresAt` 语义 |
| 动态召回 | `plugin/src` 无 `recall` 实现；tool 只有 `status/review/review_session/audit/suggest/decide/learn_skill/console_url` | P04 全新文件 + 接线，不改旧 action |
| tool 输入 | `parseToolInput` 无 `q`/`projectKey`；tool execute 有 `context.sessionID` | P04 只加 `q`；projectKey 只能取实例值 |
| API auth | `server.ts:235` 统一 `isAuthorized`；`:1725` 定义；GET 支持 `?token=` 仅 `/api/events` | `/api/recall` 必须 Bearer；不复制 events 的 query token 旁路 |
| 旧 items API | `server.ts:831` 原样 `{items}` | P04 不碰旧形状 |
| 配置 | 基线 `AutoMemConfig` 无 `recall`；`mergeConfig` 对嵌套块逐字段合并 | 只追加 `recall`，不改其他块 |
| Item | 基线 `Item` 有 `expiresAt/status/scope/projectKey`，无 `invalidatedBy` | P04 读 P01 新增字段；测试用 P01 基线形状 + 可选 `invalidatedBy` |

## 4. 预检裁决

1. **每请求接线顺序**：`before = readSession` → `refreshContext`（不提前 return）→ `after = readSession` → 取权威 `contextBlock`/`renderContext` → `rewriteManagedPrefix` → `attachRecallBlock`。全程 `try/catch`，失败只跳过。
2. **owned 当次替换**：只认四类精确证据——① 精确 metadata key `api/plugin.memory-autopilot`；② 精确 `<context key="api/plugin.memory-autopilot">…</context>` wrapper；③ 与已知自身完整 render 文本精确相等（可精确局部替换）；④ 自身唯一 sentinel。**禁止**泛匹配所有 `## AUTOPILOT` 标题，禁止仅因 part 含同一句事实就判定/删除。P01 若产出同步 owned-block helper，P04 复用，不双写 `entry.put`。命中后只替换该来源；只有无任何 owned 证据时才追加；有证据但无法识别时不追加。撤销校验只作用于 owned parts；user message、core part、L0 文件里的同一事实原样保留。无法定位标 `unlocated`/`residual=true`，不改宿主 parts。
3. **合格请求**：只看 `messages` 末尾连续 user 段；遇到 assistant/tool 立即停止（工具续跑跳过）。从新到旧取第一条清洗后 ≥4 字符的文本；清洗 `<system-update>/<context>/<skill_content>/<task>/<template>/<synthetic>` 整块；短 slash command（余下参数 <4 字符）跳过。父会话三态：`child` 跳过；读取**成功且无 parentID**（root）召回；读取失败/无可查 API（unknown）→ **fail-closed** 跳过动态召回，但 hook 正常返回、不阻塞、不写记忆。不得把 unknown 当已证实 root。
4. **辅助请求**：`title/compaction/generate` 由 V2 独立 hook 分流，不会进 `context`；fake host 测试显式断言只有 `context` 被调用。`session.synthetic` 无法从 `@opencode/ai` Message 层拿到 `synthetic` 标志（Message 只有 `id/role/content`；text part 只有可选 `metadata`），因此只做标记/元数据保守跳过，不声称 100% 识别。
5. **prefix/动态分离**：prefix 仍是 `## AUTOPILOT`（P01 writer，原位替换）；动态是独立的 `## RELEVANT MEMORY (this request)` part，只 append 到末尾。动态不写 `contextBlock`/`entry`/session state；同一 system 重入时先移除旧动态 part，保证 ≤1。
6. **预算**：按渲染后完整 block（header、每行 `- [scope/kind] ` + 完整 text、换行、分隔符）估算，CJK 1/字、ASCII 每 3 字符 1（`_./:-` 分段）、其他标点 0.5、空白 0.25、向上取整 + 16 安全余量。整 item 行超预算 → 整项跳过；**不设读取字符上限**，不因 >200 字符或写入 linter 长度丢弃；合法长 item 只要整行装得下就可召回；全部装不下 → 空 + `degraded:"budget"`；不再“至少保留 1 条”。动态预算与 prefix 分开，按规范化文本去重。
7. **数值/否定**：数字归一化后精确匹配；只有“双方都有数字、无交集、且共享至少一个非数字上下文词”才标 `numericConflict`（避免无关日期误伤）。否定用保守词表 + `不` 的非否定搭配排除；奇偶不同标 `negationMismatch`。`scoreRecall` 返回带标记的结果供诊断，`recallMemory` 从 `hits` 排除。
8. **score 语义**：仅排序特征和（score desc → updatedAt desc → id asc），不是校准概率；API/UI 不得显示百分比；测试断言同输入顺序/理由确定。
9. **scope/API**：`recallMemory` 只允许 `global + 当前 projectKey`，`session` 永不自动召回；无 projectKey 时仅 global。`GET /api/recall` 要 Bearer；传入 `projectKey` 与实例 `deps.projectKey` 不一致 → 403 `project_mismatch`。agent tool `recall` **不接受 projectKey**，只用实例 key + `context.sessionID` 做 `visible` 二次过滤。
10. **失败/降级**：`recallMemory`/`attachRecallBlock`/hook 三层 catch；`degraded.reason` 只取 `empty_query|store_error|budget|unlocated`（`budget` 仅在“有条目但无结果”时使用）；API 200，不 500；hook 不记录 query/正文。到期/失效只看 `now` 与 store，不要求新写入。
11. **配置与默认值**：新增 `recall`（`enabled?/limit/tokenBudget/apiLimit/apiTokenBudget`，无字符上限）。`effectiveRecallEnabled = recall?.enabled ?? automation?.enabled ?? false`：旧配置无新字段且 automation 缺省 false → 不意外增加召回；开启 autonomous 默认有动态召回，只有显式 `false` 才停。开关只控制动态 block；撤销/expiry/owned-block 替换无论开关都必须工作。**实施前同步 DESIGN/PLAN/ACCEPTANCE 旧摘要与 `types.ts`，不保留多份冲突默认值。**
12. **稳定性**：20 轮只约束 pinned prefix 字节一致；动态 block 单独断言“相关时出现、无关时不出现、有界、失败不阻塞、随查询变化”，不得用 20 轮禁止动态召回。

## 5. Ruling（2026-11-11 主代理补记）

1. **默认值**：`recall.enabled` 改为可选；`effective = recall?.enabled ?? automation?.enabled ?? false`。旧配置没有新字段且 automation 缺省 false → 不意外增加召回；开启 autonomous 默认有动态召回，明确 `false` 才停。撤销/expiry 失效**无论 recall 开关**都必须工作。实施前同步 DESIGN/PLAN/ACCEPTANCE 旧摘要与 `types.ts`，不保留多份冲突。
2. **预算**：按整 item 行 + headers 计；超预算跳整项；删除“硬编码 >200 字符一律丢弃”。原 linter 长度是写入策略，不是读取上限；合法长 memory 只要整行装得下 token 预算就应可召回。
3. **owned 定位**：只用精确 metadata key / 精确 `<context key>` wrapper / 已知自身完整 render 文本（可精确局部替换）/ 自身唯一 sentinel；不得泛匹配所有 `## AUTOPILOT` 标题，不得因“包含同一句事实”删除宿主 part。撤销排除只保证本插件注入；原始用户聊天和 L0 文件可能含相同事实，必须原样保留；校验 revoked 限定 owned parts。
4. **parentID 三态**：区分“读取成功且无 parentID”（root）与“读取失败”（unknown）；unknown **fail-closed** 跳过动态召回，但不阻塞对话、不写记忆；不得把“查不到 parent”当成已证实 root。
5. **P01 writer/生命周期**：`entry.put` 生命周期已同步 P01 writer；P01 可能产出同步 owned-block helper，P04 复用，不双写互相覆盖。真实 host 未实测时明确 `not-run`，不按 fake 形状声称真实 host 保证；P06 可选隔离 host + fake provider 验证（若可行），不读正式 config。

## 6. fake host 测试契约（不真实调用模型）

`phases/04-recall.md` 的“端到端 fake host 测试契约”是执行标准，核心：

- 捕获 `setup()` 注册的真实 `context` handler；直接传 typed fake `SessionContext`（`system` 含 core part + 旧 `<context key="api/plugin.memory-autopilot">`；`messages` 含真实 user prompt 或 tool 轮）。
- `instructions.entry.put` 默认**只记录、不修改 `event.system`**，显式证明 P04 不依赖 put 同步刷新；撤销场景下第二次请求仍必须无旧条目。
- 每次 emit 前 `structuredClone` 冻结输入；结束后断言 `messages` 深相等、长度不变、未被替换；非受控 system part 文本/metadata 逐字节不变；动态 part ≤1。
- fake clock + `mkdtemp` store；20 轮只断言 prefix；动态单独断言；所有失败注入（store 抛错）都必须 resolve 且请求继续。

## 7. 未决风险 / not-run

| 风险 | 状态 |
|---|---|
| 宿主实际把 entry 渲染成什么文本 | **not-run**：官方只写 `<context key="...">` 块，未在真实 host 验证；只认精确 owned 证据 + `unlocated` 标记，不泛匹配标题 |
| `context` hook 相对 system 组装的精确顺序 | **not-run**：官方语义支持“hook 前已组装”，但未实机验证；方案不依赖 put 的同步性 |
| `session.synthetic` 在 `@opencode/ai` Message 中的形状 | **unknown**：Message 无 synthetic 字段；只能靠注入标记/text metadata；可能漏判后多召回一次（非阻塞、低害） |
| 子会话 parentID | 三态：child 跳过；root（读取成功且无 parentID）召回；unknown（读取失败）fail-closed 跳过动态，不阻塞、不写记忆 |
| owned 误删宿主同事实 | 只校验/删除 owned parts；user message、core part、L0 文件保留；负例测试覆盖 |
| P01 正在同 worktree 写 `plugin.ts/store.ts/types.ts/config.ts` | P04 实现必须等 P01（及 P02/P03）验收后接线；若 P01 产出 owned-block helper，P04 复用不双写；本预检只读基线 |
| 默认值 | `recall?.enabled ?? automation?.enabled ?? false`；旧配置不新增召回，autonomous 开启默认召回，显式 false 才停；矩阵测试 |
| token 估算 | 保守估算，不是计费；不用于 provider 限制；API 标 `tokens` 为 estimate；长 item 仅受整行预算约束 |
| DESIGN/PLAN/ACCEPTANCE/types 旧摘要 | §8.4 “截断 160/至少 1 条”、§5 “预算截断”、默认值与 owned 定位需在实施前同步；本预检不改，列在 §9 |

## 8. 验证记录

| 检查 | 方式 | 结果 |
|---|---|---|
| V2 Sessions/entry 生命周期 | 官方 V2 `build/plugins/server` Sessions 段 | observed（原文见 §2.1）；**host 未实测** |
| V2 Hooks 分流/顺序 | 官方同页 Hooks → Model requests 段 | observed；context 覆盖 agent loop，title/compaction/generate 独立 |
| 本地 SDK 类型 | `@opencode/plugin` session.d.ts、`@opencode/ai` messages.d.ts、`@opencode/schema` instruction-entry.d.ts、`@opencode/client` api.d.ts | observed |
| 基线 context hook/refresh | `git show b992a2e:plugin/src/plugin.ts`（647-656、1013-1040） | observed |
| 基线 API/auth/tool | `git show b992a2e:plugin/src/server.ts`（235、1725、831）；tool/parseToolInput | observed |
| 基线 Item/config | `git show b992a2e:plugin/src/types.ts`、`config.ts` | observed |
| Ruling | 主代理 2026-11-11 补记默认值/预算/owned 定位/parent 三态/P01 helper | 已记入 §5 与 `phases/04-recall.md` |
| 测试/构建 | 未运行（预检只做静态核查；P00 基线日志 63 files/803 tests 已存在） | not-run: 本阶段禁止 |
| 产品代码/真实数据 | 未改、未访问；P01 在写文件未读（仅 `git status` 确认存在） | 符合约束 |
| 真实 host/模型 | 未调用；无 API/网络模型请求 | not-run: 实现阶段另行确认 |

## 9. 合版映射（2026-11-11 已完成）

以下条目已在本次合版写入 `DESIGN.md` / `PLAN.md` / `ACCEPTANCE.md`；保留为映射记录，不再重复修改，也不保留旧的“待同步”表述。

1. `DESIGN.md` §8.4：`每条截断 160 字符`、`至少保留 1 条` → “按整 item 行 + headers 计预算，超预算整项跳过”；删除读取侧 200 字符上限表述（写入 linter 不是读取上限）。
2. `ACCEPTANCE.md` §5：`token 预算截断；顺序稳定` → “整项跳过、总估算不超预算、顺序稳定；合法长 item 预算内可召回”。
3. `DESIGN.md` §8.4：补 `score` 仅为排序特征和、不是相关概率；API/UI 不得显示百分比。
4. `DESIGN.md` / `PLAN.md` §2.8 / `types.ts`：补默认值 `recall?.enabled ?? automation?.enabled ?? false`；旧配置不新增召回，autonomous 开启默认召回；撤销/expiry 与开关解耦；删除单点旧摘要。
5. `DESIGN.md` §8.4：owned 定位只认精确 metadata key / 精确 `<context key>` wrapper / 已知自身完整 render 文本 / 唯一 sentinel；禁止泛匹配 `## AUTOPILOT` 或按“含同一事实”删除宿主 part。

## 10. 结论

P04 方案可进入实施，但**不在本预检**开工。前置：P01（`memoryVersion(now)`、`invalidatedBy`、`refreshContext` 版本失效、owned-block helper 若提供）fix2 与 P02/P03 验收；§9 已合版，实施以合版后的 DESIGN/PLAN/ACCEPTANCE 与 `phases/04-recall.md` 为准；接线顺序为 P01 先落 prefix，P04 只改其后半段并先写失败测试。本预检未修改任何产品代码、未提交、未触碰真实配置/数据/凭证。

## 11. 合版记录（2026-11-11）

冻结来源：`phases/04-recall.md` + 本文件 §1–§10。已合入主文档，**未改产品代码、未改类型、未运行测试/构建、未调用模型**。

### 11.1 已同步

- `DESIGN.md`：D11 从“只工具/API/复盘邻域”改为“每个合格真实 prompt 当次请求自动召回，独立有界动态 SystemPart，稳定 prefix 与动态分离”；§4 运行模型补默认值/父会话三态；§7.2 补“owned 块边界不可判定时 degraded，不等于下一请求保证”；§8.4 重写为：默认 `recall?.enabled ?? automation?.enabled ?? false`、真实 user 文本与工具轮幂等、parent root/child/unknown、保守匹配、token 整项跳过、owned 精确替换、开关与失效解耦、P01 fix2 现状、API/tool scope、P06 真实 host 门禁。
- `PLAN.md`：P04 标“预检与合版完成、未实现”，检查项改为 16 条合版后契约。
- `ACCEPTANCE.md` §5：改为合版后测试契约，标注“新增断言尚未实现/未运行（not-run）”；覆盖默认矩阵、失效不依赖开关、长 item 预算内可召回、owned 负例、unknown 父会话、P06 门禁。

### 11.2 P01 fix2 现状（2026-11-11）

- P01 是唯一产品 writer；fix2 正在修 **M7（blocking：无 metadata fallback 截断/误删宿主 part）** 与 **N2（派生失效 maintenance 副作用）**，**尚未验收**。
- P01 若产出同步 owned-block helper，P04 未来复用，不双写 `entry.put`；helper 验收前只走 P04 自身精确 owned 路径。
- 无 metadata 且旧字面 `<context` 造成边界歧义时**不得猜边界**；保守保留原 part 并标 `degraded`。这**不等于**“下一请求已排除”的保证；`entry.put` 只保证后续存储。

### 11.3 真实 host 门禁（未执行，not-run）

P06 必须在隔离 host + fake provider（若可行，不读正式 config）记录真实出站 `system`，证明撤销/停用条目不残留在任何 owned 注入中；若无法排除错误 owned 内容，P06 最终状态为 **blocked**。fake host/pure probe 不能替代真实宿主验证；当前所有 host 结论仍为 **not-run**。

### 11.4 状态

合版完成，未开始 P04 实现；等 P01 fix2 + P02/P03 验收后同 session 实施。新增测试与 P06 门禁均待验证，不写成已实现。
