# P04 — recall

Status: implemented（源码/接线已落版；`npm run typecheck` exit 0；行为与真实 host 未验证）
Depends: P01（version/scope/invalidatedBy/expiresAt 过滤）、P02（可选，错误分类）
Blocks: P05（相关记忆面板/详情关联）
Global constraints: 见 `PLAN.md` §2
Preflight: `reports/04-preflight.md`（2026-11-11，含 V2 生命周期证据与未决风险）
V2 依据: 官方 `https://opencode.ai/v2/docs/build/plugins/server`（Hooks/Sessions 段）+ 本地 `@opencode/plugin`、`@opencode/ai`、`@opencode/schema` 类型

## 实施记录（2026-11-16，P04 唯一 writer）

已完成的生产接线：

- 新 `plugin/src/recall.ts`：`tokenizeRecallQuery` / `scoreRecall` / `recallMemory` / `estimateTokens` / `selectRecallQuery` / `renderRecallBlock` / `stripRecallBlock` / `rewriteManagedPrefix` / `attachRecallBlock`。
- `plugin/src/plugin.ts`：`context` hook 固定顺序为 `refreshContext` → 当次 owned prefix 重写（`rewriteManagedPrefix` 复用 `applyOwnedContextDetailed`）→ `attachRecallBlock`；非 owned/foreign 提前退出时同时剥离 pinned 与动态块；tool 增加只读 `action=recall`；`ContextHookEvent.messages` 放宽为只读数组。
- `plugin/src/server.ts`：`GET /api/recall`（Bearer、实例 `projectKey` 越界 403 `project_mismatch`、失败仍 200 + degraded、只读）；config PATCH 增加 `recall.limit 1..8`、`recall.tokenBudget 100..2000` 等边界。
- `plugin/src/config.ts` / `types.ts`：`RecallConfig` 与默认 `5/600/8/1200`；`recall.enabled` 缺省继承 `automation.enabled`；旧配置无 `recall` 不新增召回。
- owned 定位增加 `api/plugin.memory-autopilot` 与本地 `plugin.memory-autopilot` 两种**精确** key/wrapper 兼容；仍只认精确 metadata / wrapper / 完整 render / sentinel，不泛匹配 `## AUTOPILOT`。
- 动态 block 使用独立 metadata 标记 + 唯一 sentinel，重入先移除同一来源；不写 `contextBlock`、`entry`、`messages` 或 usage/学习状态。
- 撤销兜底只在 owned 来源内清除；shared part 只移除自身 recorded 片段，保留宿主其余文本。

未验证边界：

- 未运行测试/vitest/专项评测/full verify；未做真实 V2 host、真实 model、真实 dataDir、正式配置或 P05 UI 验证。
- shared console server 的 `/api/recall` 只使用首个启动实例的 `projectKey`；同一 dataDir 多项目共享 server 时的多项目取数未验证。
- `api/plugin.memory-autopilot` 是 V2 文档命名，真实宿主实际 metadata/wrapper 形状仍未实测；无法定位时保持宿主内容并标 `unlocated`。
- 动态 block 对 prefix 缓存的实际影响、以及真实 host 是否在下一请求丢弃旧动态 part，未实测。
- 未新增 P04 测试文件；原有测试与 fixture 未改（2026-11-18 发版补充：新增 `recall.test.ts` / `context-recall.test.ts`，28 cases，随 `npm run verify` 运行）。

证据：`tmp/full-auto-memory/product/p04-recall/{before/,p04.patch,typecheck.log,typecheck.exit,import-smoke.log,import-smoke.exit}`。`typecheck.exit=0`；`import-smoke` 仅证明模块可加载与 tokenizer 基本形状，不是行为/host 证据。

### 修正轮（2026-11-16，主代理源码验收后）

逐项落地：

1. **普通 ASCII 词/命令**：`extractIdentifiers` 只把含 `._/:@-` 或多词命令的 token 保留为标识符；纯 `npm`/`pnpm install`/英文自然词进入 `words`，按小写整词集合匹配，`npm` 不再命中 `pnpm`。结构性标识符仍大小写敏感、不拆 `plugin.ts`/路径。
2. **text part synthetic**：复用 `session/filters.ts` 的 `isSyntheticMessage`，并补 `metadata.source === "synthetic"` 与 direct `synthetic/source/warming`；`textOfMessage` 逐 part 过滤 synthetic text part，混合消息只保留真实 user part；keep-alive 文本跳过。
3. **parent 三态（R2/ACCEPTANCE 最终语义）**：`ownershipParentState` 只对“owned + host-read + id 匹配”的读取回答三态：`parentID` 存在 → `child`；读取成功但无 `parentID` → `root`（`@opencode/schema` 的 `Session.Info.parentID` 是可选字段，root 会话正常缺 key）；读取失败/不可用/非 host-read/身份不匹配 → `unknown`，不动态召回。早期修正轮曾要求 `identity.parentKnown === true`、缺 parent key 一律 `unknown`，该决议已由 R2 取代：host 对 root 省略 parent key 是正常形状，旧规则会让召回恒死。不改 P03 provenance，owned prefix 同步仍执行。
4. **prefix 去重前置**：`recallMemory` 新增可选 `excludeTexts`，在排序后、limit/预算选取前按“escape 后规范化完整正文”排除 prefix 条目；动态用 prefix 行传入，API/tool 默认不传。被排除的 top 条目不再占 5 条/600 token 名额。
5. **旧动态先清理**：context hook 一进入、拿到 `system` 就先 `stripRecallBlock`，再执行 ownership/refresh/build；上述任一步失败或 parent unknown/开关关闭都不会留下上一次动态块。无最新 prefix（build 失败）时不追加动态。P04 路径错误日志只输出错误类别（`Error.name`/typeof），不输出 message、query 或 item 正文。
6. **已知完整 render**：`applyOwnedContextDetailed` 新增可选 `knownTexts`；`rewriteManagedPrefix` 传入 before/after 的 `renderContext` 完整文本。仅当完整文本精确、唯一且位于整个 part 或 part 边缘时替换；part 内含未知 `<context>` 或已知文本居中出现歧义时保持原 part、标 `unlocated`/`residual=true`，不追加第二份。旧 wrapper/metadata 分支不变。

本轮证据：`tmp/full-auto-memory/product/p04-recall/fix-before/`、`fix.patch`、`fix-typecheck.log/.exit`；同时已用原始 `before/` 重新生成完整 `p04.patch`。`fix-typecheck.exit=0`。未运行行为测试；真实 V2 host 是否会给出显式 parent slot、`api/...` metadata/wrapper 实际形状、真实下一请求剔除仍未实测。共享 console server 多项目 `/api/recall` 取数仍未实测，留给 P05 接口适配。

## 目标

让普通对话“自动有记性”：每个**合格的真实用户 prompt**，按当前项目自动召回相关记忆，并作为**当次模型请求**的动态 system block 附着；不修改用户 transcript、不写 pinned `contextBlock`。稳定小偏好 prefix 与动态检索 block 分离；有界、失败 nonblocking。匹配覆盖中文、标识符、否定、数值，不依赖向量。

## 非目标

- 不引入 embedding/向量库/外部检索服务。
- 不把动态召回写入 `contextBlock`、用户 `messages` 或 durable memory。
- 不做语义推理/跨语言翻译。
- 不做 ranking 学习模型；`score` 只是排序特征和，**不是相关概率/正确率**，任何 UI/API 不得把它显示成百分比。
- 不用 20 轮 prefix 稳定性测试禁止动态召回。

## V2 hook / entry 生命周期（2026-11-11 核对，按官方文档 + 本地类型）

```ts
// @opencode/plugin/dist/promise/session.d.ts
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
export interface SessionHooks { readonly context: SessionContext; /* title/compaction/generate/model.request/... */ }

// @opencode/ai/dist/schema/messages.d.ts
type SystemPart = {
  type: "text";
  text: string;
  cache?: CacheHint;
  metadata?: Record<string, unknown>;   // 可含 experimental.instructions
};
```

官方文档（Hooks → Model requests / Sessions）已确认：

1. `context` 只覆盖 agent loop（含 tool-driven continuations）；`title` / `compaction` / `generate` 有**各自独立**的 hook，不会走 `context`。因此“辅助请求”不再靠猜 `kind`，而是由宿主分流；`context` 内仍要防 `session.synthetic` 与注入块。
2. hook 对 `system` 的修改只影响本次外发请求，不写历史/配置；多个插件按注册顺序执行，后注册者能看到前面的修改。P04 只追加/替换自己受控的块，不重排、不改宿主其他 part。
3. instruction entry：`ctx.session.instructions.entry.put({ sessionID, key, value })`，宿主按 `api/<key>` 命名空间渲染为 `<context key="...">` 块；**更新/移除在“下一个 step boundary”才被宣布**，不排队消息 turn。
4. `system` 中承载 instructions 的 part 会在 `metadata.experimental.instructions` 暴露来源列表 `{ key, text }`（如 `core/date`、`core/environment`）；该列表是副本，改 `part.text` 不会同步它。该字段是 experimental，只能 type-guard 后宽松读取。

**生命周期结论（P04 必须按此接线）**：在 `context` hook 里 `entry.put` 只能保证后续 step/请求的存储状态，**不能保证替换本次已装载的 `event.system`**。停止使用/撤销/到期后，若只依赖 `entry.put`，当前请求仍可能带旧条目，即“下下次才生效”。P04 必须在当次 `event.system` 内定位并替换/过滤受控 AUTOPILOT 块，同时保留宿主所有其他 system parts；`entry.put` 只作为后续请求的持久化通道（P01 负责）。

**与 P01 的分工**：P01 是唯一产品 writer。若 P01 产出“当次 system 内同步替换/移除 owned block”的 helper，P04 **直接复用**，不重复 `entry.put`、不另写第二套替换逻辑；P04 只负责动态召回、资格判定和 helper 缺失时的精确 owned 定位兜底。两阶段实现前先对齐该 helper 签名，避免双写互相覆盖。

## 文件

| 文件 | 改动 |
|---|---|
| `plugin/src/recall.ts`（新） | tokenizer、`scoreRecall`、`recallMemory`、`estimateTokens`、`selectRecallQuery`、`renderRecallBlock`、`rewriteManagedPrefix`、`attachRecallBlock`、预算/降级 |
| `plugin/src/plugin.ts` | V2 `context` hook：去掉 `entry` 存在时的提前 `return`；每次请求先 `refreshContext`（P01），再 `rewriteManagedPrefix`，再 `attachRecallBlock`；tool 增加只读 `action=recall`；`ContextHookEvent.system` 放宽为带可选 `metadata` 的 text part；父会话用进程内缓存 |
| `plugin/src/server.ts` | `GET /api/recall?q=&projectKey=&limit=`（Bearer；projectKey 只允许实例自身） |
| `plugin/src/config.ts` / `types.ts` | 追加 `recall` 配置块（单一 owner，只加字段） |
| `plugin/test/recall.test.ts`（新） | 匹配/冲突/scope/预算/降级/确定性 |
| `plugin/test/context-recall.test.ts`（新） | 每请求附着、transcript 不变、prefix/动态分离、撤销下一请求、20 轮 prefix、fake host 端到端 |
| `plugin/test/recall-api.test.ts`（新） | `/api/recall` auth、projectKey 越界 403、tool visible、失败 200 |
| `plugin/test/context.test.ts` / `context-version.test.ts` | 不改旧断言；20 轮只约束 pinned prefix（P01 文件不重写） |

## 接口

以 `DESIGN.md` §8.4 为准；本阶段只新增不改变语义的本地纯函数：

```ts
export interface RecallTokens {
  cjkBigrams: string[];
  identifiers: string[];
  numbers: string[];
  negations: number;   // 奇偶即可
}

export interface RecallHit {
  id: string; version: string; title: string; text: string;
  scope: Scope; kind: Item["kind"];
  score: number;            // 排序特征和，不是概率
  reasons: string[];        // 稳定特征名，如 "cjk:复盘" / "identifier:plugin.ts"
  numericConflict?: boolean;
  negationMismatch?: boolean;
}

export interface RecallResult {
  hits: RecallHit[];
  tokens: number;           // 保守估算，不是计费
  degraded?: { reason: "empty_query" | "store_error" | "budget" | "unlocated" };
}

export function tokenizeRecallQuery(text: string): RecallTokens;
export function scoreRecall(item: Item, tokens: RecallTokens): RecallHit | undefined;
export async function recallMemory(
  store: Store,
  config: AutoMemConfig,
  query: string,
  opts?: { projectKey?: string; limit?: number; tokenBudget?: number; now?: number },
): Promise<RecallResult>;

/** 保守 token 估算；用于预算，不用于 provider 限制/计费。 */
export function estimateTokens(text: string): number;

/** 从 messages 末尾连续 user 段中选真实文本；不跨 assistant/tool 边界。 */
export function selectRecallQuery(messages: ReadonlyArray<Message>): string | undefined;

/** 渲染一个动态 block；空 hits 返回 ""。 */
export function renderRecallBlock(hits: RecallHit[], maxChars: number): string;

/**
 * 在当次 event.system 内替换/过滤受控 AUTOPILOT 块。
 * 只改自己的来源；保留所有宿主其他 parts。
 */
export function rewriteManagedPrefix(input: {
  system: SystemPart[];
  freshText: string;
  revokedTexts: ReadonlyArray<string>;
  entryKey?: string;        // 默认 "plugin.memory-autopilot"
}): { mode: "none" | "metadataKey" | "contextWrapper" | "knownText" | "sentinel" | "appended" | "unlocated"; residual: boolean };

/** V2 context hook adapter; appends one bounded SystemPart, never touches messages. */
export async function attachRecallBlock(input: {
  sessionID: string;
  projectKey?: string;
  messages: ReadonlyArray<Message>;   // 只读
  system: SystemPart[];               // event.system
  parentSessionID?: string;
}, deps: {
  store: Store;
  config: AutoMemConfig;
  now?: () => number;
}): Promise<void>;
```

默认：动态 `limit=5`、`tokenBudget=600`；API/tool 用 `limit=8`、`tokenBudget=1200`。只取 `status` 为 `auto`/`promoted`、未过期（`expiresAt > now`）、未被 `invalidatedBy` 标记的 item；scope 仅 `global` + 当前 `projectKey`，`session` 永不进入自动召回。读取不设“内容长度上限”：能否召回只由 token 预算决定（见预算节）。

## 每请求行为（顺序固定）

1. 召回开关解析：`effectiveRecallEnabled = config.recall?.enabled ?? config.automation?.enabled ?? false`。旧配置没有 `recall.enabled` 且 `automation` 缺省 false → 不新增召回；开启 autonomous 后默认有动态召回，只有显式 `recall.enabled=false` 才停。**无论该开关如何，`refreshContext`、撤销/`invalidatedBy`/expiry 过滤、owned-block 当次替换都必须执行**；开关只决定是否追加动态 block。`recall` 字段整体可缺省。
2. `before = await store.readSession(sessionID)`（用于算 revoked 文本）。
3. `await refreshContext(ctx, store, config, sessionID, projectKey)`（P01；不得因 `entry` 存在提前 return）。失败只记类别，继续。
4. `after = await store.readSession(sessionID)`；取 `after.contextBlock`（`contextProjectKey === projectKey` 时）否则 `buildContext`；`freshText = renderContext(block)`。这是当次请求的**权威 prefix**，不依赖 `entry.put` 是否已反映到 `event.system`。
5. `rewriteManagedPrefix({ system: event.system, freshText, revokedTexts })`：
   - **owned 判定只允许四类精确证据**：① `metadata.experimental.instructions` 中**精确** key `api/plugin.memory-autopilot`；② **精确** `<context key="api/plugin.memory-autopilot">…</context>` wrapper；③ 与已知自身完整 render 文本**精确相等**（`before.contextBlock` / `after.contextBlock` 的 `renderContext` 结果，可做精确局部替换）；④ 自身唯一 sentinel（P01/P04 注入的固定标记，精确匹配）。**禁止**泛匹配所有以 `## AUTOPILOT` 开头的 part，禁止仅因 part 包含同一句事实就判定/删除它。
   - P01 若产出同步 owned-block helper（当次 system 内替换/移除），P04 **复用**该 helper，不再自行 `entry.put` 或另写一套替换，避免双写互相覆盖。
   - 命中后只替换该 owned 来源：保留宿主 `<context key>` 包裹格式；同步该 metadata 副本的 `text`（只为调试真实，不要求宿主使用）；文本相同则不改。
   - 只有**没有任何 owned 证据**且 `freshText` 非空时，才追加一个新 part（本请求原先没有 prefix）。有 owned 证据但格式无法识别时**不追加**，避免旧块+新块重复注入。
   - **撤销兜底只作用于 owned parts**：替换后仅在 owned 来源内检查 `revokedTexts`；若仍出现，移除整个 owned 来源（宁可本请求没有 prefix，也不注入已撤销事实），`residual=false`。**不得**因此删除宿主其他 part：原始用户聊天、L0/AGENTS.md 或其他插件可能含同一事实，必须原样保留。若 owned 来源无法定位，标 `degraded:"unlocated"`、`residual=true`，不改宿主 parts。
6. `attachRecallBlock`：
   - 先移除 `event.system` 中已存在的 `## RELEVANT MEMORY (this request)` part（幂等，防重复堆叠），再决定是否追加。
   - 资格：见下节；不合格直接 return（不改 system）。
   - 查询：`selectRecallQuery(event.messages)`，最多 400 字符；只读。
   - 检索：`recallMemory`；失败 catch 后 return，不阻塞请求。
   - 去重：把 `after.contextBlock.autoMemory/autoRules` 规范化文本作为排除集，避免 prefix 与动态重复占预算；因此动态最多补足 `limit`，不重复。
   - 附着：仅当有命中且能装进预算，向 `event.system` push **一个** part：
     ```text
     ## RELEVANT MEMORY (this request)
     - [scope/kind] text
     ...
     ```
   - 不写 `contextBlock`、不写 `entry`、不写 `event.messages`、不写 session state。
7. 外层 `try/catch` 兜底；任何失败都让请求继续，不记录 query/正文。

## 合格请求识别（eligible）

在 `selectRecallQuery` 内实现，**只看 `messages` 末尾连续 user 段**：

| 条件 | 处理 |
|---|---|
| `messages` 为空，或最后一条是 `assistant`/`tool` | 跳过（工具迭代轮不重复堆 block） |
| 末尾连续 user 段中，从新到旧找第一条清洗后 ≥4 字符的文本 | 用它；通常只有 1 条 |
| 文本清洗后为空 | 跳过（synthetic 通知/纯注入） |
| 短 slash command（`/name` 且余下参数 <4 字符） | 跳过（`/status`、`/help`） |
| 父会话状态：`child`（已知 `parentSessionID`） | 跳过（subagent 不作为用户记忆来源） |
| 父会话状态：`root`（session 信息读取**成功**且无 parentID） | 正常召回 |
| 父会话状态：`unknown`（`session.get` 失败/超时/无该 API） | **fail-closed**：跳过动态召回，但 hook 正常返回、不阻塞对话、不写任何记忆 |
| 命中合成/注入标记 | 跳过：`<system-update>`、`<context …>`、`<skill_content>`、`<task>`、`<template>`、`<synthetic>`、`Session task state` |
| text part `metadata.synthetic === true` / `metadata.source === "synthetic"` | 跳过（若宿主提供） |
| `title` / `compaction` / `generate` | 由宿主分流到独立 hook，不会到这里；fake host 测试显式覆盖“只发 context” |

清洗只移除**整块标签内容**，不删除用户正文；清洗后仍保留代码块、路径、数字、否定词。父会话用三态缓存：`child` / `root` / `unknown`；只有“读取成功且确实没有 parentID”才算 `root`，**读取失败不得当成已证实 root**，按 `unknown` fail-closed 跳过动态召回（nonblocking、不写记忆）。

## 匹配规则

| 维度 | 规则 |
|---|---|
| 中文 | 连续 CJK 片段取 bigram（单字查询保留单字）；bigram 重合计分，封顶防长文刷分 |
| 标识符 | 反引号/路径/文件名/API/命令按原样匹配；大小写敏感；`plugin.ts` 不得被拆成 `plugin`；分词前先提取标识符 |
| 数字 | 归一化（去千分位/常见单位）后精确匹配；查询与 item 都有数字、无交集、且共享至少一个非数字上下文词 → `numericConflict`，不返回为命中；没有共享上下文只是“不匹配”，不误标冲突 |
| 否定 | 检测 `不/不要/别/禁止/避免/无需/不用/不准/不得` 与 `not/no/never/don't/avoid/without`；`不` 后接 `错/仅/但/过/少/久/断/同/凡` 视为非否定；否定奇偶不同 → `negationMismatch`，不返回为命中；同向否定可命中 |
| 冲突 | `numericConflict`/`negationMismatch` 在 `scoreRecall` 返回值里标出（供测试/诊断），`recallMemory` 从 `hits` 排除 |
| scope | `global` + 当前 `projectKey`；`session` 不进入自动召回；无 `projectKey` 时仅 `global` |
| 排序 | `score` desc → `updatedAt` desc → `id` asc；稳定、无随机、无 `Date.now()` 参与排序 |

`score` 只用于排序与 tie-break，不是校准概率；不得用阈值宣称“可靠”。可靠性来自 scope/冲突排除/可撤销/预算，不来自单一分数。

## token 预算

预算按**渲染后的完整 block**计算，包含 header、每行 `- [scope/kind] ` 前缀、换行与分隔符，再额外加 16 token 固定安全余量（宿主包裹/隐式分隔）：

```text
CJK/日文假名/韩文    每字符 1
ASCII 字母数字段      每 3 字符 1（向上取整；按 _ . / : - 分段）
其他非空白标点        0.5
空白                  0.25
结果向上取整 + 16
```

规则：

- 预算按“整 item 行”（`- [scope/kind] ` + 完整 `text` + 换行）加 header/分隔符累计；读取侧**不设独立字符上限**。
- 任一整 item 行加入后超预算 → 跳过该**整项**并继续看下一条；不截断正文、不加省略号、不破坏事实。
- **不硬编码“超过 200 字符一律丢弃”**：写入侧的 linter/`thresholds.memoryMaxChars` 是写入策略，不是读取上限；已有合法长 memory 只要整行仍装得进 token 预算，就应可召回。
- 全部装不下 → 空结果 + `degraded:"budget"`（不保证“至少 1 条”）。
- 动态预算与 pinned prefix 预算**分开**；动态不因 prefix 占用而缩水，但按规范化文本去重，避免同一事实重复占预算。
- 结果是保守估算，不是模型计费；任何日志/API 标 `tokens` 为 estimate。

## 失败与降级

- `recallMemory` / `attachRecallBlock` / hook 三层 `try/catch`；任何 store/解析错误返回空/无 block，不抛。
- `degraded.reason` 只用一个明确类别：`empty_query` / `store_error` / `budget` / `unlocated`。`budget` 只在“有条目但因整行超预算导致无结果”时使用；若仍返回了其他命中，不设 degraded。
- API 返回 200 + `degraded`，不返回 500；tool 返回 `{hits,degraded}` 文本，不抛。
- hook 内失败不写日志正文；只允许记录错误类别（不写 query/item 文本）。
- 时间到期、`invalidatedBy`、archived 过滤只依赖 `now` 与 store 内容，**不要求新写入**；跨过 `expiresAt` 的下一请求必须排除。

## 安全

- 结果受现有 `visible()` 过滤；不返回其他 project/session 的 item。`session` scope 即使同会话也不进入自动召回。
- `/api/recall` 要求 Bearer token；`projectKey` 只能是本插件实例的 `deps.projectKey`，不一致 → **403 `project_mismatch`**，不允许 token 持有者借一个实例查其他项目。缺省查询用实例 key。
- agent tool 的 `recall` **不接受 `projectKey`**；只用实例 key + `context.sessionID` 做 `visible` 二次过滤，防止 tool 越 scope。
- API/tool 只返回 `id/title/text/scope/kind/version/score/reasons`，不返回 `source.sessionID`、绝对路径、token、prompt。
- 动态 block 不写入 transcript/durable state；`rewriteManagedPrefix` 只改自己的来源文本。
- 不修改 `~/.config/opencode`、正式插件数据、DESIGN/PLAN/PROGRESS。

## 配置

```ts
recall?: {
  enabled?: boolean;       // 可选；未显式设置时继承 automation.enabled
  limit: number;           // 5
  tokenBudget: number;     // 600
  apiLimit: number;        // 8
  apiTokenBudget: number;  // 1200
}
```

- `effectiveRecallEnabled = recall?.enabled ?? automation?.enabled ?? false`。旧配置没有 `recall`、`automation` 也缺省 false → 不意外增加召回；开启 autonomous 后默认有动态召回，只有显式 `recall.enabled=false` 才停。
- `recall` 可整体缺省（旧配置兼容）；`mergeConfig` 按嵌套对象合并，不因缺省字段清掉 `automation`。
- 服务端 PATCH 校验类型与上下限（`limit 1..8`、`tokenBudget 100..2000`），不引入字符长度上限。
- **开关只控制动态 block**：`effectiveRecallEnabled=false` 时仍执行 `refreshContext`、撤销/`invalidatedBy`/expiry 过滤与 owned-block 当次替换；API/tool 仍可显式查询（只读调试）。

## TDD（先写失败测试，记录失败原因）

1. `recall.test.ts`
   - 中文：“复盘失败”命中含“复盘失败原因”的 item；单字查询可用；长文 bigram 不刷分。
   - 标识符：`plugin.ts`、`/api/items`、`npm run verify` 精确命中，不被拆词。
   - 数字：5199 命中 5199；端口 5198 vs 5199 且共享“端口” → `numericConflict` 且不进 `hits`；无关日期不误标冲突。
   - 否定：“不要用 pnpm”不命中“用 pnpm”；“禁止使用 pnpm”同向命中。
   - scope：项目 A 查询不返回 B；global 始终可见；session 不出现；无 projectKey 仅 global。
   - 预算：构造超预算集合，`estimateTokens(block) <= budget`；超预算项整项缺席（不是部分文本）；顺序稳定。
   - 长 memory：一个 300+ 字符的合法 item，在放大 `tokenBudget` 后**可以**被召回；同一 item 在小预算下整项缺席。不得因“超过 200 字符”或写入侧 linter 长度而丢弃。
   - 降级：store 抛错 → `{hits:[],degraded:"store_error"}`，不抛。
   - 确定性：同输入两次调用 hits 顺序与 reasons 完全一致；`score` 不作为概率字段导出。
2. `context-recall.test.ts`（fake host，不真实 API）
   - 真实 prompt：多一个动态 part；`messages` 深比较字节不变；`entry.put` 不被动态调用（warm 后 0 次）。
   - 无关 prompt：无 block（或空结果不 push）。
   - 工具轮：最后一条 `tool`/`assistant` → 不追加、不报错。
   - 合成/短命令/子会话/注入块：不追加。
   - 父会话三态：`child` 跳过；成功读取且无 parentID（root）召回；`session.get` 抛错（unknown）→ 不召回、hook 正常 resolve、不写记忆。测试断言 unknown 不会被当作 root。
   - 开关矩阵：`recall` 缺省 + `automation.enabled=false` → 无动态；`automation.enabled=true` 且无 `recall.enabled` → 有动态；`recall.enabled=false` + automation true → 无动态；`recall.enabled=true` + automation false → 有动态；任一情况下撤销/expiry 过滤都生效。
   - 撤销下一请求：第一次请求后把 item 标 archived/invalidated；fake `entry.put` 故意 no-op（模拟“只写存储不换 system”）；第二次请求的 system 全文不含旧事实，prefix 是新内容；动态也不含。**`recall.enabled=false` 时同样必须排除旧 prefix**（失效不依赖召回开关）。
   - owned 定位负例：宿主 part 只含“同一句事实”但不是 owned（无精确 key/wrapper/完整文本/sentinel）→ 原样保留；泛 `## AUTOPILOT` 标题但文本不是自身完整 render → 不删除、不替换；原始 user message 与 core part 含 revoked 文本 → 保留。
   - P01 helper：若注入同步 owned-block helper，P04 调用它且不重复 `entry.put`；helper 缺失时才走自身精确 owned 路径。
   - 到期无写入：仅推进 fake now 跨过 `expiresAt`，下一请求排除。
   - prefix/动态分离：动态不写 `contextBlock`/`entry`/session state；20 轮 prefix 字节一致；不同 prompt 的动态结果可不同。
   - 宿主 parts：core/date 等其他 part 与 metadata 逐字节保留；`<context key>` 包裹格式保留。
   - 失败：store 抛错 → hook resolve、请求继续、无 block。
   - 幂等：同一 system 重复进入（模拟 host 重入）仍只有 1 个动态 part。
3. `recall-api.test.ts`
   - 无 Bearer → 401；`projectKey` 与实例不符 → 403；缺省/相同 → 200。
   - store 错误 → 200 + degraded，不 500。
   - tool `action=recall`：不需要 `projectKey`，只返回本实例 + `visible` 的条目；不写任何文件。
4. `npm run verify` exit 0；baseline 803 测试不减少；`git grep` 无 `as any`/`ts-ignore`/`ts-expect-error`。

## 端到端 fake host 测试契约

```ts
type FakeHost = {
  ctx: PluginContext;                 // 真实 setup() 返回值所需最小面
  emit(event: {
    sessionID: string;
    agent: string;
    model: { providerID: string; id: string };
    system: SystemPart[];             // 含 core part + 旧 <context key="api/plugin.memory-autopilot">
    messages: Message[];              // 含真实 user prompt 或 tool 轮
    options: Record<string, unknown>;
    tools: Record<string, unknown>;
  }): Promise<SystemPart[]>;          // 深拷贝输出，供断言
  puts: Array<{ sessionID: string; key: string; value: unknown }>;
};
```

- `setup()` 注册的 `context` handler 被捕获后直接调用；测试**不启动 server、不发真实模型请求**。
- `instructions.entry.put` 用可控 fake：默认只记录、不修改传入的 `event.system`（显式证明 P04 不依赖 put 的同步刷新）。
- 每次 `emit` 前用 `structuredClone` 冻结输入；结束后断言 `messages` 深相等、长度不变、对象未被替换。
- 断言 system 中 `## RELEVANT MEMORY` 出现次数 ≤1；所有非受控 part 的文本与 metadata 不变。
- 20 轮只断言 pinned prefix（`## AUTOPILOT` 来源）字节一致；动态 block 单独断言出现/不出现/有界/随查询变化。
- 所有断言基于 fake clock 与临时 `mkdtemp` store；不读写真实 `dataDir`/config/凭证。

## 验收

- `ACCEPTANCE.md` §5 全部通过（若与本文“整项跳过/不保证至少 1 条”冲突，以本文为准；实施前先同步旧摘要，见文末）。
- `npm run verify` exit 0。
- 代码审查：无 embedding/向量依赖；`attachRecallBlock` 无未捕获异常；`messages` 只读；只改自己的 system 来源；不删除含同一事实的宿主 part。
- 手工（host 可用时，另行确认）：真实/模拟 V2 context hook 下，相关 prompt 出现动态 block，transcript 不变；无关 prompt 不出现；旧 session 停止使用后的**下一次**请求不再含该条目；无跨项目泄漏。**真实 host 未实测时必须写 `not-run`**，不得用 fake host 形状声称真实 host 保证；可选 P06 在隔离 host + fake provider 下验证（不读正式 config）。

## 风险

| 风险 | 处理 |
|---|---|
| 宿主把 entry 渲染成非 `<context key>` 格式，定位失败 | 只认精确 metadata key / 精确 `<context key>` wrapper / 已知自身完整 render 文本 / 唯一 sentinel；全失败标 `unlocated` 不改宿主；**不泛匹配 `## AUTOPILOT`**；报告中列为未实测风险 |
| owned 误删宿主内容 | 撤销校验只作用于 owned parts；含同一事实的 user message/core part/L0 文件原样保留；负例测试覆盖 |
| 中文分词质量 | bigram + 单字兜底；测试覆盖常见短语 |
| 标识符被拆 | 先提取反引号/路径/文件名/命令，再分词 |
| 否定误判 | 保守词表 + 非否定搭配排除；不确定时排除而非高分 |
| 数字误判冲突 | 仅“无交集且共享上下文词”才算冲突；否则只是不匹配 |
| 动态 block 破坏缓存 | 稳定 prefix 原位替换；动态只做有界尾部 part；20 轮只测 prefix |
| 召回变成每轮全量注入 | top-K + token 预算 + 去重；无关不注入；长 item 也受整行预算约束 |
| 子会话识别不全 | 三态 parent：child 跳过、root 召回、unknown fail-closed；官方 hook 分流已排除 title/compaction/generate |
| 开关默认值 | `recall?.enabled ?? automation?.enabled ?? false`；旧配置不意外新增召回；autonomous 开启默认召回；显式 false 才停；矩阵测试 |
| 失效依赖开关 | 撤销/expiry/owned-block 替换与召回开关解耦；开关关闭也必须下一请求排除旧 prefix |

## 需主代理同步的文档（本预检不改；实施前必须完成，避免多份冲突）

1. `DESIGN.md` §8.4：`每条截断 160 字符`、`至少保留 1 条` → “按整 item 行 + headers 计预算，超预算整项跳过，不强行超预算”；删除“读取侧 200 字符上限”的表述（写入 linter 长度不是读取上限）。
2. `ACCEPTANCE.md` §5：`token 预算截断；顺序稳定` → “整项跳过、总估算不超预算、顺序稳定；合法长 item 在预算内可召回”。
3. `DESIGN.md` §8.4：补 `score` 仅为排序特征和、不是相关概率；API/UI 不得显示为百分比。
4. `DESIGN.md` / `PLAN.md` §2.8 / `types.ts`：补默认值规则 `recall?.enabled ?? automation?.enabled ?? false`；旧配置无新字段不新增召回，autonomous 开启默认召回；撤销/expiry 与开关解耦。删除任何“recall 默认 true/false”的单点旧摘要。
5. `DESIGN.md` §8.4：owned 定位只认精确 metadata key / 精确 `<context key>` wrapper / 已知自身完整 render 文本 / 唯一 sentinel；禁止泛匹配 `## AUTOPILOT` 或按“含同一事实”删除宿主 part。
