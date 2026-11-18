# Dependency triage（只读风险分级）

Date: 2026-11-11
Scope: `plugin/` 与 `console/` 现有 lockfile
Owner: dependency-triage subagent
Status: done — read-only，未安装、未升级、未改 lockfile/代码
Verdict: **不阻塞本目标上线**；生产运行时依赖树 0 advisory，30 条全部落在 dev/test 工具链

## 0. 基线与方法

P0 已有基线（`tmp/full-auto-memory/verification/npm-ci-plugin.log`）：

- plugin：318 packages，`30 vulnerabilities (27 moderate, 1 high, 2 critical)`
- console：75 packages，`1 moderate`

本次复核命令（只读，官方 registry）：

```bash
npm audit --json
npm audit --omit=dev --json
```

原始输出：

| 文件 | 内容 |
|---|---|
| `tmp/full-auto-memory/verification/audit-plugin.json` | plugin 全树 30 条 |
| `tmp/full-auto-memory/verification/audit-console.json` | console 全树 1 条 |
| `tmp/full-auto-memory/verification/audit-plugin-omit-dev.json` | plugin 生产树：**0** |
| `tmp/full-auto-memory/verification/audit-console-omit-dev.json` | console 生产树：**0** |

计数复核一致：plugin `{critical:2, high:1, moderate:27, total:30}`；console `{moderate:1}`。
**计数本身不构成可利用证据**，以下按包、版本、依赖链与可达性分级。

## 1. 运行时 / 开发归属（先定边界）

| 事实 | 证据 |
|---|---|
| `plugin/package.json` 无 `dependencies`，无 `peerDependencies`，只有 5 个 `devDependencies` | 文件本身 |
| `plugin/src/*.ts` 的 import 仅 `node:*` 内建模块 | `grep '^import .* from "' plugin/src` 去重结果 |
| plugin 对外只导出 `dist/index.js`（tsc 产物） | `exports` + `build` |
| `@opencode/plugin` 在 `src/`、`test/`、`index.js`、`server.js` 中**无任何 import** | 全目录 grep，0 命中 |
| HTTP 服务默认绑定 `127.0.0.1` | `plugin/src/server.ts:109`、`src/cli.ts:84` |
| console 生产依赖仅 `react`、`react-dom`、`@openchamber/sdk`，由 vite 打包为静态产物 | `console/package.json`；`vite`/`esbuild` 均为 devDep |
| 无 `@vitest/ui`、无 `--ui`、无 `launch-editor` | lockfile 与 scripts 查询，均 absent |

结论：**被审计的 30 条全部位于 dev/test 依赖闭包**。`npm audit --omit=dev` 在两个 workspace 均返回 `exit 0`、`total 0`。

## 2. Critical（2）

| # | 包 | 已装版本 | 归属 | 依赖链 | Advisory | 可达性 |
|---|---|---|---|---|---|---|
| C1 | `vitest` | 2.1.9 | **直接 devDep** | `(root) → vitest` | GHSA-5xrq-8626-4rwp（<3.2.6，UI server 任意文件读/执行） | 不可达：未装 `@vitest/ui`，未使用 `--ui`，无监听中的 UI server |
| C2 | `tinypool` | 1.1.1 | 传递 dev | `(root) → vitest 2.1.9 → tinypool ^1.0.1` | GHSA-5gmw-xhrv-c9v3（≤2.1.0）、GHSA-85c8-ppgw-ccpr（<2.1.2），原型污染 gadget → RCE | 不可达：`run()` 的 options 只来自仓库内测试代码，无外部输入通道 |

修复版本：vitest ≥3.2.6（或 4.1.12+），tinypool ≥2.1.2。二者由同一次 vitest major 升级覆盖。

## 3. High（1）

| # | 包 | 已装版本 | 归属 | 依赖链 | Advisory | 可达性 |
|---|---|---|---|---|---|---|
| H1 | `vite` | 5.4.21 | 传递 dev | `(root) → vitest → vite`（另 `vite-node`、`@vitest/mocker`） | GHSA-587h-7wmj-h5pm（≤6.4.3，`launch-editor` Windows `fs.existsSync` 绕过 → 命令执行）；同版本另挂 7 条 moderate（GHSA-4w7w-66w2-5vf9、GHSA-rq7h-c2jc-7f22 等） | 弱：仅 Windows + 本地 dev server 错误浮层路径；`launch-editor` 未安装，该代码路径不存在。CI 为 ubuntu 且只跑 `npm run verify` |

修复版本：vite ≥6.4.4。仅 dev/build 使用，不影响 `dist` 产物。

## 4. Moderate（27）分两簇

### 4.1 npm CLI / sigstore 簇（24 条，全部 dev）

链路：`@opencode/plugin 2.1.4 (devDep) → @opencode/util 2.1.4 → @npmcli/arborist 9.4.0 / pacote 21.5.1 / sigstore 4.1.1`

涉及：`@npmcli/{arborist,config,map-workspaces,metavuln-calculator,package-json,run-script}`、`@sigstore/{sign,tuf}`、`@tufjs/models`、`cacache`、`make-fetch-happen`、`npm-packlist`、`npm-registry-fetch`、`pacote`、`sigstore`、`tuf-js`、`ignore-walk`、`rimraf`、`gaxios`、`gcp-metadata`、`glob 13.0.5`、`minimatch 10.2.5`、`@opencode/util`、`@opencode/plugin`。

- 根因两条：GHSA-3g3m-2fjr-6pw4（glob 9.0.0–14.0.1）、GHSA-g3hv-75wg-m249（minimatch 7.0.0–11.0.0）。
- `fixAvailable: false`（`@opencode/plugin`、`glob`、`minimatch`）：需上游 `@opencode/util` 升级其 npm 依赖，本地无法安全消解（`npm audit fix --force` 会跨 major 改 lockfile，禁止）。
- 可达性：`@opencode/plugin` 在本仓库**零 import**，仅作 devDependency 存在；`@opencode/util` 的 npm CLI 能力不会进入 `dist/index.js`。

### 4.2 vitest/vite 工具链（3 条，全部 dev）

| 包 | 版本 | 链 | Advisory |
|---|---|---|---|
| `@vitest/mocker` | 2.1.9 | `vitest` | GHSA-82fw-gwwq-j7x9（路径穿越/任意文件读）、GHSA-qxg6-89mg-rqv8（未认证 mock 注册 → 代码注入） |
| `esbuild`（vite 内） | 0.21.5 | `vitest → vite → esbuild` | GHSA-67mh-4wv8-2f99（dev server 跨站请求读取） |
| `vite-node` | 2.1.9 | `vitest` | 经由 vite 继承 |

可达性：均要求运行 dev server 或注入 mock 配置；测试在本地/CI 内以仓库代码驱动，无外部客户端。

### 4.3 console（1 条）

| 包 | 版本 | 归属 | Advisory | 可达性 |
|---|---|---|---|---|
| `esbuild` | 0.24.2 | **直接 devDep**（`build-extension.mjs` 构建期调用） | GHSA-67mh-4wv8-2f99 | 不可达：仅 `esbuild.build()` 打包扩展，不启动 dev server；产物为静态文件 |

## 5. 是否阻塞本目标上线

**不阻塞。** 依据：

1. 生产依赖树（`--omit=dev`）两个 workspace 均为 0 条，发布物 `plugin/dist` 与 console 静态产物不含上述包。
2. 全部 critical/high 的触发前提（UI server、外部 worker options、Windows launch-editor、对外 dev server）在本仓库均不成立。
3. 本目标 P01–P07 未新增依赖；30 条是既有基线，非本次引入。
4. CI（`.github/workflows/verify.yml`）只执行 `npm ci` + `npm run verify`，无 dev server 暴露、无 audit 门禁。

需要如实标注的残余风险：在开发机上若把 vite/vitest 服务暴露到非回环地址、或运行不可信测试代码，dev 侧风险转为真实；当前配置不满足该前提。

## 6. 最小修复建议（均未执行）

| 优先级 | 动作 | 覆盖 | 代价 |
|---|---|---|---|
| 建议（非阻塞） | `plugin` devDep `vitest ^2.1.8 → ^3.2.6`（或 4.1.12+），连带 tinypool ≥2.1.2、vite ≥6.4.4 | 2 critical + 1 high + 3 moderate | devDep major；需重跑 803 tests |
| 可选 | `console` devDep `esbuild ^0.24.2 → ^0.25.0` | console 1 moderate | 构建期，需重跑 build:extension |
| 仅跟踪 | `@opencode/util` 的 npm CLI 簇 24 条 | 24 moderate | 上游修复；`fixAvailable: false`，本地无安全解 |
| 防护 | CI 增加 `npm audit --omit=dev --audit-level=high` | 防未来生产依赖回归 | 只读检查 |

明确不做：`npm audit fix` / `--force`（会改写 lockfile，破坏 P01 进行中的工作树）；不为清零计数而升级全部依赖。

## 7. 结论

- 现有告警 = 开发/测试工具链的既有基线，与 P0 绿基线（63 files / 803 tests / verify exit 0）不矛盾。
- 无生产运行时暴露，无已证实的可达利用路径。
- 建议把「vitest 升级」与「CI prod-only audit 门禁」放入后续独立任务，不阻塞统一可撤销记忆的上线裁决。
