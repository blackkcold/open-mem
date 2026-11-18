# 03 host spike 独立复核

Date: 2026-11-12
Role: 独立复核（只读；非原 runner/owner）
Inputs: `reports/03-host-spike-{isolation,capabilities,selftest}.md`；`tmp/full-auto-memory/host-spike/preflight/*`；`/private/var/folders/ks/flqyrh0j5wvf2t7v4s7lcnz0b5tfzv/T/opencode/host-spike-selftest.BibKdy/{selftest.sb,selftest.sh,marker-diag.sh,logs/*}`；`lsof` 47831/47832；`git diff --check`。
Scope: 未启动 sandbox/host/server/model/provider；未改 profile、runner、产品、测试或候选；仅新增本报告。
Verdict: **BLOCKED — spike 未成功，不得标验收通过**。真实 host 未启动；隔离 enforcement 与 host 兼容均未证。

## 1. 结论

- 现有证据只支持“child-only sandbox 自测在 target 启动前 abort”，不支持任何隔离或 host 能力结论。
- 安全边界在**脚本/产物层**成立：自测 runner 未调用 OpenCode host/serve，未执行 `service *`，只建了两个自有回环 listener，未指向真实配置/Keychain/managed prefs。
- 但这不是形式化 OS 安全证明：没有包捕获、文件读取审计或内核级追踪；**没看到外呼/读取日志，不能当作从未外呼/读取的绝对证明**。
- 第一版 65 的 parser 归因“按现有唯一记录成立”，但原始 stderr 已被第二次运行覆盖；134 的失败层仍不能定层。
- 三份报告的 BLOCKED 结论基本克制；候选 `host.sb` 仍含已被拒绝的 `127.0.0.1` 语法；能力计划的两处插件接口错误已在 §9 确认更正，但仍不能当作 host 可执行计划。

## 2. 已证（具体 artifact → 结论）

| Artifact | 核到的事实 | 能推出 / 不能推出 |
|---|---|---|
| `cli-version-and-path.txt`、`installed-cli-package.json`、help 文件 | `opencode v2.1.1`；`serve --hostname/--port`、`run --server/--standalone`、`service` 子命令存在 | flags 存在；不能推出 host 实际行为 |
| `sandbox-exec-*.txt` | `/usr/bin/sandbox-exec` 存在、可执行、已 DEPRECATED、无 check-only | 工具存在；不能推出可用性 |
| `logs/profile-parse-first-and-second-note.txt` | 首版 65；stderr 记录为 `host must be * or localhost in network address`，指向 `selftest.sb:30:22` 的 `127.0.0.1:47831` | 按**事后 note**成立；首版 profile 与原始 stderr 未保留，不能独立复算。改 `localhost` 仍是 loopback（可能含 `::1`），不是外部放宽 |
| `profile-parse.exit=134`、`.out/.err` 均 0 字节、`wrapper.err` `Abort trap: 6` | 改为 `localhost:47831` 后仍 SIGABRT，target 无输出 | 未达到 `exit 0`；失败层不能定 |
| `marker-diag.summary.txt`、`marker-BEFORE_EXEC.txt`、`marker-before-state.txt` | rc=134；`marker=absent`；stdout/stderr 0；BEFORE 后追加 AFTER；运行前无 marker | 父进程确实到达调用；**target builtin 未获证执行** |
| `marker-pre-sha256.txt` / `marker-post-sha256.txt` | `selftest.sb` 与 `selftest.sh` sha256 前后逐字节相同 | 该次诊断未改 profile/runner；“不变”成立 |
| `marker-diag-wrapper.rc=0`、`marker-diag.rc=134` | wrapper 自身退出 0，内层 sandbox 调用 134 | wrapper rc=0 **不是成功信号**；`status.txt=BLOCKED` 才权威 |
| `port-*.before` 空、`after-start` 为 Python 40742/40743、`cleanup-check.txt` 无 lsof/ps、当前 lsof 空 | 仅 `127.0.0.1:47831/47832` 两个自有 listener；`server.py` 只 bind 127.0.0.1；脚本无 `opencode service` | runner 只 own 两个回环 listener 并已清理；无 shared service 影响证据；不能证明零外部副作用 |
| `parent-controls.txt`、`allowed/` 为空、`outside/*` | 父进程 outside 读/写与两个 HTTP 正向控制通过；子进程 allow/deny 用例全部未进入 | 父控制有效；**child enforcement 未证** |
| base 目录与 `tmp/full-auto-memory/host-spike/` | 无 host/provider/model 日志或运行产物；仅 preflight 与 selftest 文件 | 无 host 运行产物；这是脚本/产物边界，不是 OS 审计 |

## 3. 未证 / 不能声称

- profile 编译/应用、allow/deny、网络 deny、mach deny、host 兼容：全部 **not-run**。
- 134 只能定“target builtin 未获证执行”，**不能定 compile 失败，也不能定 compile 成功**。至少可能是 profile compile/apply、`sandbox-exec` 自身、target 的 dyld/loader 或初始化；没有阶段 marker 可区分。
- 首版 65 只能说明**首版**进入 parser 并被拒；不能推出第二版也进入 parser，更不能推出第二版编译失败。
- 严格隔离未证：XDG-only 不能排除系统 `/Library/Application Support/opencode`、managed prefs、Keychain、祖先 `.opencode`/`AGENTS.md`；也没有 OS 级文件读取审计。
- 能力矩阵 A–D 全部 not-run：root/child 原生身份、`projectID`/`location`/`parentID`、消息类型、synthetic 来源、part provenance、transcript/list/export/hash、`entry.put`、`http.request`、`generate.text`、SSE 均无运行证据。
- `message.type="user"` 与客户端 `metadata.synthetic` 都不是人类亲写证据：metadata 客户端可控，未标记的 synthetic 与真实 user 在当前过滤器中不可区分；该风险仍成立。
- SDK/CLI 版本错位：静态字段来自 `@opencode/*` **2.1.4**，运行 CLI 是 **2.1.1**；静态类型不是运行时保证。
- 原静态计划的接口错误已更正（§9）：`ctx.session.skill` 与 `ctx.session.instructions` 不在 2.1.4 的 `SessionDomain` Pick 中；`ctx.skill` 只有 `list`（另加 `transform`/`reload`），不是“向 session 激活 skill”；`ctx.experimental` 只有 terminal，没有 generate。静态更正不等于 runtime 可用。
- 没有包捕获、DNS 日志或文件系统审计；报告中的“未外呼/未读”只能按脚本和已知产物表述，不能升级为绝对保证。
- 候选 profile 文本上未见外部网络或真实路径放宽：`localhost`/127.0.0.1 均为 loopback；但 profile 从未成功应用，文本审查不能当作 enforcement。

## 4. 具体阻塞

1. `sandbox-exec` 在 target 启动前 abort；没有 stage instrumentation，无法判断是 profile、tool 还是 target，故不能进入 allow/deny，更不能启动 host。
2. `03-host-spike-isolation.md` §8 的 `host.sb` 仍写 `(local ip "127.0.0.1:<PORT>")`，正是首版被 65 拒绝的构造；按现有 parser 行为会先被 65 拒绝，到不了 host 启动。即使改为 `localhost`，134 仍未解决。
3. 没有经批准的严格隔离运行环境；XDG-only 已被判定不足，不能拿它冒充严格隔离。
4. 能力探针计划与 2.1.4 插件 Context 的两处接口不符已更正（§9）；但 host 仍未跑，不能把静态更正当成运行时断言。
5. 尚无证据表明 deny-default 下的 `opencode serve` 能完成 exec、dyld、mach 或子进程初始化；host 兼容是 unknown，不是“待跑一下”。

## 5. 下一步最小安全路径（均需主代理转请用户另行批准；本报告不启动）

**A. 最小 sandbox stage controls（推荐先做，仍不启动 host）**

- 仅批准运行 `sandbox-exec` + `/bin/sh`，在 tmp 内用三组最小对照：`(allow default)` 内联 profile、无网络的最小 deny-default、再加回 loopback 规则；每组 target 先写 `TARGET_START` 再 `exit 0`，父进程记录 BEFORE/AFTER、rc、stdout/stderr 字节数。
- 目的是分层：若连 `(allow default)` 都 134，则 sandbox-exec 路径在该机不可用（或与 target 组合不可用），直接转 B；若 allow-default 通过而 deny-default abort，再逐条二分 profile 规则。不得借机放宽 host profile，不得启动 host/provider。
- 需要的信息：用户批准“仅 sandbox 诊断”、允许的 tmp 根、可接受的停止条件。无需安装、提权、读取真实 config 或 Keychain。

**B. 独立隔离运行环境（A 不能定层时的正路）**

- 使用已有的容器/VM（或经额外证明的独立用户环境），要求能从外部证明：真实 home、`~/.config/opencode`、`/Library/Application Support/opencode`、Keychain、managed prefs 不可达，且出站网络默认拒绝；然后才在其中启动临时 host + 本地 fake provider。独立用户本身不足以排除系统级路径/managed prefs，必须单独证明。
- 需要的信息：环境位置、隔离证明方式（挂载/网络/用户边界）、谁负责启动与清理。默认不安装 Docker/Colima，不提权，不读真实配置。

**C. 不推荐：XDG-only 直接跑**

- 只有在用户明确接受“非严格隔离、不能声称无正式配置/无凭证访问”的降级时，才可作为另一次独立决策；本报告不建议用它替代 A/B，也不能把它写成严格隔离。

## 6. 产品/候选与验收边界

- 本次复核未改产品代码、测试或候选 profile；仅新增本报告。`git diff --check` 返回 0；工作树中已有的 P02/wiring 改动保持原样，不是本次复核产生。
- 先前 P02 + known-foreign wiring 的 **74 files / 929 tests / verify exit 0** 证据保留，本轮**不重跑**产品整 verify；该证据不因本报告失效。
- 用户原全量目标（P03–P06、真实 host 出站、30 天运行）**未完成**；本 spike 是前置门禁，当前 BLOCKED，不能记作验收通过。

## 7. 证据质量与局限

- 强证据：真实退出码、0 字节输出、sha256 前后一致、PID/端口 before/after、清理记录；这些能支持“发生了什么”的窄结论。
- 弱证据：首版 65 只有事后 note，原始 stderr 与首版 profile 未保留；134 无 stderr、无 target marker，无法定层；`marker-diag-wrapper.rc=0` 易被误读为成功。
- 自测 profile 与 `host.sb` 不同：前者额外放开 `/bin/sh`、`/bin/cat`、`/usr/bin/curl`、`/usr/bin/python3`；即使自测未来通过，也只证明该放宽 profile 的形状，不证明 host profile。
- profile 的 `file-read-metadata` 是全局允许，严格说可 stat 真实路径（内容读取未允许）；`localhost` 也可能覆盖 IPv6 loopback。未来报告应把这些列为设计边界。
- 以上保证都指向具体 artifact（日志、hash、lsof、脚本），不是形式化 OS 安全证明，也不是对真实 host 行为的保证。

## 8. 追加复核：sandbox stage controls（2026-11-12）

**总体仍 BLOCKED；stage controls 只把失败层推进了一步，不改变 host 结论。** 按本轮授权最多 3 组，实际只执行 stage1/stage2，stage2 首次失败即停，stage3 未执行。

- **stage1 已证**：`(version 1)(allow default)`、target `/bin/sh -c 'printf TARGET_START > "$ROOT/marker"; exit 0'`，returncode **0**；`root/marker` 内容 **TARGET_START**（target builtin 已执行）；stdout/stderr 0；parent control `PARENT_CONTROL_OK`；profile sha256 `d130f968…` before=after。
- **stage2 已证**：deny-default、无网络、仅 `/bin/sh` exec、系统 runtime 与本组 root 读写；returncode **134**；marker **absent**（target builtin 未获证执行）；stdout/stderr 0；parent control `PARENT_CONTROL_OK`；profile sha256 `406410d5…` before=after。`runner.returncode=1`，`status=STAGE2_FAILED rc=134`。
- **原始证据**：stage1/stage2 的 `before-exec.txt` 均有 BEFORE/AFTER；`marker-before=no`；当前复算 profile hash 与记录一致；`listener-check` 与当前 lsof 47831/47832 均空；runner 无 opencode/curl/python/provider，无新 listener、无模型/外网调用路径或证据。parent control 只证明父侧可写 root，不是 child 权限。stage3 文件只有预置 `profile.sb`/`profile.sha256`，`logs/` 为空、无 returncode，符合“未运行”；未发现旧日志被覆写。
- **可定位**：失败由“从 allow-default 切换到 stage2 的限制集”引入；stage2 无网络规则，故网络规则不是 stage1→stage2 的变量。**不能定位**：具体规则、profile compile/apply、`sandbox-exec` 自身、`/bin/sh`/dyld/mach 初始化；无 stage2 marker/stderr/内部阶段日志。stage1 的 allow-default 只用于 `/bin/sh` marker，**没有给 host**；allow/deny、mach、网络、host 兼容仍 not-run。
- **报告核对**：stage-controls §2 表格与上述原始文件一致；§3/§4 未把 stage1 通过写成隔离成立，未夸大 134 归因，结论可用。
- **下一最小决策**：若继续，只能另批“stage2 单变量规则二分”（限组数、首次失败即停、仍不启动 host），或转独立容器/VM；不得把 stage1 通过写成隔离成立，也不得直接启动 host。

## 9. 追加复核：capabilities 接口更正（2026-11-12）

**静态 PASS；runtime 仍 U。** 本节记录对更正后内容的复核；§3/§4 的旧结论已随之更新。按更新后的报告与 2.1.4 SDK 复核：

- `client.session.skill` 与 `client.session.instructions.entry.*` 确属 **full client**（`client.d.ts:43`、`:60-66`）；`ctx.session` 的 `SessionDomain` Pick 明确不含 `skill`/`instructions`（`session.d.ts:144-146`）。B3/C6 与步骤 3/4 已改为 full client/HTTP；旧断言已失效，只在 §0 注记与 do-not-call 警告中出现。
- `ctx.skill` 是 `SkillDomain`，只有 `list` + `transform`/`reload`（`skill.d.ts:1-16`），与 session skill activation 不同；full client/HTTP 是外部调用路径，不是 `ctx` 自动可用。
- `ctx.generate.text` 存在；DOC 的 `ctx.experimental.generate.text` 与 2.1.4 Context（`experimental` 仅 terminal）冲突仍标 **U**，未强行对齐。SDK 2.1.4 与 CLI 2.1.1 的版本差保留，未安装/升级掩盖。
- 结论：接口更正**静态准确**，但不等于 2.1.1 运行时可用，也不等于 host spike 通过；A–D 运行时仍全部 not-run/U。下一步仅在 host 另行获批后，按修正后的 full client/HTTP 断言验证，当前不启动。

## 10. 追加复核：own-process denial log（2026-11-12）

**结论：查询范围与原始结果基本一致，但仍为 UNKNOWN/BLOCKED；查询完成不等于 host spike 通过。**

- **范围**：`query.txt` 记录 `start=@1794455251`、`end=@1794455261`、`pid=59427`；谓词为 `processIdentifier == 59427 OR ((process == "kernel" OR process == "sandboxd") AND composedMessage CONTAINS "59427")`。PID 与 `runner.stderr.txt` 的 `59427 Abort trap: 6` 一致；epoch 经 `date -r` 复核为 11:47:36 CST / 03:47:36 UTC，窗口 11:47:31–41 / 03:47:31–41，恰好 10 秒。主分支精确 PID；kernel/sandboxd 分支仅接受含 `59427` 的消息，不是泛搜 sandbox 事件，但 `CONTAINS` 不是数字边界（可匹配 `159427`、`594270` 等）。查询 artifact 无 sudo/提权字段，报告命令亦无 sudo；无 sandbox/host/provider 新运行。
- **原始结果**：`stdout` 44 bytes、仅 1 行表头；`stderr` 0 bytes；`exit=0`；`size=44/1`；0 条匹配记录。`runner.stderr.txt` 与 stage2 日志 mtime 仍为 11:47:36，未见本次复查改写原始证据。
- **局限**：`query.txt` 未保存完整 argv、30s alarm、wrapper 或 1 MB/200 条 hardcap；44 bytes 是观测结果，不是强制上限，授权弹窗/日志设置也只能按报告自述。`log show` 对统一日志的底层读取也不能由“0 输出”证明为绝对未读其他日志；本次只能确认“该窗口/PID 下未返回记录”。
- **可推出/不可推出**：只能推出该窗口/PID 下没有匹配的返回记录；不能推出无 deny、无 sandbox 事件，也不能定位 profile 编译/应用、dyld、mach 或具体规则。仍 UNKNOWN/BLOCKED，host 未启动，allow/deny 与 host 兼容未证。
- **下一决策**：停止扩大窗口/PID/规则试探；主代理应向用户报告环境阻塞，请用户在“已有隔离环境”与“暂停”之间选择，不得把本次查询当作 host 通过。

## 11. 追加复核：container plan pre-execution（2026-11-12）

**结论：不能按现文直接执行；修完下列 5 项后可呈请 Stage1 only 批准。Stage2 仍须单独批准，当前全部 runtime not-run。**

- **已核 OK**：`node:20` ID `sha256:8f69…` 与 `03-images-filtered.json` 一致、size 相符；计划固定 ID、`pull=never`，固定 socket/`env -i`、不读 Docker config 的原则正确。HostConfig 无 bind/volume/port、`NetworkMode=none`、non-root 10001、read-only root、cap-drop ALL、no-new-privileges、资源/日志上限；`/spike` tmpfs 是唯一应用写入区（`/dev/shm` 已如实列为 runtime）。Stage2 材料为 `BLOCKED_TO_DOWNLOAD`，计划要求同时批准“公开 metadata/下载/SRI/size/安全解包”和“容器 host 阶段”，不会因报告存在自动运行；坐标来自本地 launcher 的 2.1.1 optionalDependencies，不是猜 URL。≤64 API/≤8 fake model/10min 是可执行计数；Linux runtime ≠ mac host gate，计划已声明不能证 mac host。
- **必须修 1 — WorkingDir/bootstrap**：没有证据表明镜像内存在 `/spike/work`，计划未包含创建；Docker 是否在 tmpfs 前/后创建、创建在 rootfs 还是 tmpfs 也未证。若落在 rootfs 会被 tmpfs 遮蔽；若落在 tmpfs，`/spike/home`、`/spike/tmp` 与 XDG 目录仍为空，Stage1 的 HOME 检查只看变量可能 false-pass，Stage2 会在写配置/tmp 时失败。改为 `WorkingDir=/spike`，并由 Node/启动脚本以 10001 执行 `mkdir -p /spike/{work,home,tmp,config,cache,data,state}`；或给出等价的顺序证明。
- **必须修 2 — Mounts 自洽**：`GET /containers/<id>/json` 的 `Mounts` 对 `HostConfig.Tmpfs` 可能为 `[]`；当前“恰好只有 tmpfs entry”会 false-STOP。应接受 `Mounts=[]` + `HostConfig.Tmpfs` 仅 `/spike`，并在容器内 `/proc/mounts` 验证 `/spike` 为 tmpfs；若 Docker 返回 tmpfs entry，也允许该唯一项。不要把 inspect 表示当作唯一真相。
- **必须修 3 — 写 client/exec**：现有可核的 client 是 `docker-preflight/probe.py`，只支持 3 个 GET；计划却用“已验证 AF_UNIX client”做 create/start/exec/stop/delete/PUT archive，当前不可执行。需另写受限 client（method/path allowlist、无重试、输出 cap、`env -i`、固定 socket、不读 Docker config），并明确 exec 是 `POST /containers/<id>/exec` 创建 + `POST /exec/<id>/start` 两步，exec 继承 10001、`Privileged=false`、无新增 caps。另：image gate 的 `GET /images/<ID>/json` 是第 4 个 GET，超出上轮 3 GET 授权，需单独批准。
- **必须修 4 — cleanup 状态**：§4 只写正常 stop→delete 和 stop/delete 失败保留，未覆盖 `created` 未启动、start 失败、exec 失败。需加状态机：created/start 失败→直接 delete（不 stop）；running→stop 后 delete；stopped→直接 delete；stop/delete 失败→保留、BLOCKED、不 force；删除前按 ID+name+两个自有 label+status+Mounts 核对。Stage1 又说“不读取 Labels 内容”，但三重核对/cleanup 需要两个 labels；应明确只读本容器两个自有 label，不读镜像 Labels/Env。
- **必须修 5 — HTTP-only/plugin 分层**：Stage2 列表混写了 HTTP-only 与 plugin-context。插件 ABI 2.1.1/2.1.4 未知时，可测：API identity、message type/metadata、transcript/export、HTTP `entry.put`、full-client `generate.text`/`session.generate`、fake-provider body；必须 not-run：plugin `ctx.generate.text`、`ctx.session.generate`、context/http hook、任何 `ctx.session` 探测。计划应逐条标 `HTTP-only`/`plugin-ABI`，否则会把 Linux 部分结果误报为 host/plugin 通过。
- **用户需批准**：① 第 4 个只读 `GET /images/<ID>/json`；② 新写 client + 仅此一个 name/label/ID 容器的 create/start/exec/stop/delete；③ Stage2 的公开材料下载/校验与该容器 host 阶段（两者同时，缺一仅 Stage1）。不安装、不提权、不读真实 config；若需放宽网络/挂载/权限则 STOP。
- **资源备注**：`/spike` 768MiB + `/dev/shm` 16MiB 与 `Memory=1GiB` 是紧预算；tmpfs 页计入 cgroup，copy 前应按内存余量设更低实际 cap（≤512MiB 解包上限只是包本身），否则可能 OOM。不是当前启动的硬矛盾，但必须在 Stage2 copy 前定数。

## 12. 追加复核：container plan fix2（2026-11-12）

**结论：§11 五项均可判 ADDRESSED；第 3 项附一条实现修正、§1 附一条措辞修正，均非新授权缺口。可向用户呈请 Stage1-only；Stage2 不被覆盖，全部 runtime 仍 not-run。**

| # | §11 项 | 状态 | 核对 |
|---|---|---|---|
| 1 | WorkingDir/bootstrap | ADDRESSED | `WorkingDir=/spike`；Node Cmd 以 10001 创建 7 个目录并检查 uid/RW；Stage1 再查目录与 `/proc/mounts` tmpfs。 |
| 2 | Mounts 自洽 | ADDRESSED | `Mounts=[]` 或唯一 tmpfs 均可；`HostConfig.Tmpfs` 仅 `/spike`；容器内 `/proc/mounts` 复核。 |
| 3 | client/exec/image gate | ADDRESSED* | §1.1 明确旧 3GET 不可复用，新 client 9-method allowlist、第 4 个 GET 新授权、exec User/Privileged/CapAdd；**修正**：`GET /exec/{id}/json` 只给 ExitCode，stdout/stderr 必须从 `POST /exec/{id}/start` 取（create 时 `AttachStdout/Stderr=true`，start 时 `Detach=false`）；§1 仍写“已验证 client”，应改为“新受限 client”。 |
| 4 | cleanup | ADDRESSED | created/start fail→delete；running→stop+delete；stopped→delete；exec fail→BLOCKED+finally；三重 ID/name/两自有 label/status/Mounts；不读镜像 Labels/Env。 |
| 5 | HTTP-only/plugin | ADDRESSED | 表已分开；HTTP-only 可测，plugin-ABI 全 not-run；Stage2 明确不随 Stage1 批准。 |

**Stage1 授权包**：§1.1 的 9 个方法 + §6.1 的 fixture client/单容器 create/start/exec/selfcheck/stop/delete、≤10min、无 download/host/model、无 PUT archive；第 4 个 GET 已单列。卡面需写入第 3 项的输出修正与 §1 措辞修正。

**边界**：Stage1 通过只证明该容器在给定 HostConfig 下的隔离条件，不是 host/OpenCode/plugin 通过；Stage2 材料仍 `BLOCKED_TO_DOWNLOAD`，mac host 仍未证。

## 13. 追加复核：Stage1 首次尝试（2026-11-12）

**结论：本轮仍 BLOCKED，不能改记 PASS；根因是 pre-start 额外 oracle 检查误判，不是已证的 Docker none 网络失败。**

- **执行事实**：image gate 4 字段 200；唯一 create 201；真实请求 **6 次**（无 start/exec/stop/list/pull/prune/archive）；状态 `created`；`DELETE 204` → 同 ID `404`；本 ID 无残留，未做全局残留查询。`99-summary.request_count=6`、`02-create-id`、`12/13` 原始响应一致。Stage2/host/model/下载仍 not-run。
- **37 checks**：36 pass；唯一失败 `NetworkSettings.Networks empty`；实际为 `{"none":{NetworkID:"",EndpointID:"",IPAddress:"",Gateway:"",...全空...}}`，`HostConfig.NetworkMode=none`、`Ports={}`、无 IP/gateway/MAC。计划 Stage1 只要求 `NetworkMode=none`/Binds/Mounts/Ports 等，**没有** `Networks empty`；`stage1.py:248` 用全局 `is_empty` 把 Docker 的 none 占位对象判失败。属 oracle/实现错误，不是隔离失败；本轮不能标 PASS。
- **44/44 guard**：真实、离线、无 socket；覆盖 method/path allowlist、他容器/exec ID、重复 create、create/exec tamper、path mutation、rawstream、caps、socket owner。它**不覆盖** `verify_isolation` 的 37 个 metadata 断言，所以 44/44 不能证明 Networks 判据正确；本轮实际跑才暴露。本次未发现第二个实际触发误判的未计划 pre-start 断言；其余 36 项与计划/HostConfig 对应。
- **数据边界**：image gate 只落 4 字段，`01-image-gate.response.json` 仅是审计信封无 body；pre-start 原始 body 含 6 个合成 Env + 镜像默认 `PATH/NODE_VERSION/YARN_VERSION` 与两个自有 label，无真实用户/凭证；cleanup 只读两个自有 label，不读他人 Env/Labels。若“连镜像默认 Env 也不落盘”按字面执行，pre-start full body 是小 OPEN（非凭证）；下次可落过滤 body。**cleanup 证据缺口**：`09-cleanup-inspect` 以 `save_body=False` 保存，只有 `99-summary` 的 owner/mounts 结果 + 代码核对；204/404 原始响应证明同 ID 删除，但 owner 三重核查不能从 09 raw body 独立复核。下次应落一份过滤后的 owner 证据。
- **predicate 修正**：新增专用 `networks_none_ok(ns)`，不要改全局 `is_empty`（否则会放行 volume/ports/binds/caps）。接受 `ns in (None,{})`；或 `set(ns)=={"none"}` 且 `none` 对象的 `IPAddress/GlobalIPv6Address/Gateway/IPv6Gateway/MacAddress` 为空、prefix 为 0；`NetworkID`/`EndpointID` 允许 opaque（start 后 Docker metadata），其余 metadata 字段忽略。仍需单独断言 `HostConfig.NetworkMode=="none"`、`NetworkSettings.Ports=={}`、`HostConfig.PortBindings=={}`、`PublishAllPorts=false`、`Binds=[]`、`Mounts` 为空/仅 `/spike` tmpfs。
  - 正例：`{}`；`{"none":{...全空...}}`；start 后 `{"none":{NetworkID:"<opaque>",EndpointID:"<opaque>",IPAddress:"",Gateway:"",...}}`。
  - 负例：`{"bridge":...}`、`{"host":...}`、`{"none":...,"bridge":...}`、`none` 带非空 IP/Gateway/MAC/prefix、Ports/PortBindings 非空、PublishAllPorts=true、Binds/Mounts 非空、NetworkMode 非 none。离线单测这组正负例，不连 socket。
- **实际网络证明**：下一轮 Stage1 必须在容器内补 `ip -br addr`/`/proc/net/dev`（仅 `lo`，无 `eth0`）、`ip route`/`/proc/net/route`（无 default）、回环 200、`192.0.2.1:9` 1s 内 ENETUNREACH/EPERM；inspect 不能替代运行证据。当前这些均 not-run/unknown。
- **下一步**：先离线修 `networks_none_ok` 并加正负例测试；再由用户**新授权**一次唯一新容器 Stage1（首次授权已消耗并清理，严禁自动复跑）；HostConfig/资源/权限不变，predicate 修复不得放行 extra network。Stage2 不随 Stage1；产品 74/929 不变。

## 14. 追加复核：Stage1 oracle fix（2026-11-12）

**结论：离线修复 PASS；可交原执行者用 candidate 重试一次（用户已选 `stage1_oracle_fix_and_one_retry`）；首次 Stage1 仍 BLOCKED，Linux/runtime 仍 not-run。**

| # | §13 项 | 状态 | 证据/残留 |
|---|---|---|---|
| 1 | `networks_none_ok` | ADDRESSED | 专用函数接受 `None`/`{}`、仅 `none` 且无 IPv4/IPv6/Gateway/MAC、prefix 0；允许 opaque `NetworkID/EndpointID`；拒绝 bridge/host/双网络/none 带 IP。39/39 metadata 日志含正负例；`is_empty`、`build_payloads` AST 与原版相同；全局守卫未改。 |
| 2 | snapshot/filter/cleanup | ADDRESSED | `filter_container_inspect` 只保留 ID/name/两自有 label/status/关键 HostConfig/Mounts/Networks，丢弃 Env/额外 labels；`03/05/09/11/02b` 走 snapshot；13/13 filter 日志含 secret Env/label 与 404 no-body；fixture 的 `09-cleanup-inspect` 可独立核 owner3/status/mounts。 |
| 3 | runtime 网络证据 | ADDRESSED（仅离线 parser） | selfcheck 新增 `/proc/net/dev` 仅 `lo`、`/proc/net/route` 无 default；parser fixture 覆盖 only-lo/extra-iface/default/non-default；旧回环与 `192.0.2.1:9` 拒绝保留。Linux 未执行，仍是 not-run。 |
| 4 | 回归/hash | ADDRESSED* | `docker_client.py` 与旧 `selftest_guard.py` 字节未变；旧目录四文件 hash 仍 d502/4db/386/b79；当前 candidate `stage1.py=58a0b148…`、diff `8bb944…` 与报告一致。**一条非阻塞备注**：`original-hashes-after.txt` 的 candidate `0da26bdf…` 是 15:48 中间版，与最终 58a0b148 不一致；raw 不覆写，下次重生成该记录即可。 |
| 5 | RED/测试 | ADDRESSED | 旧 validator 对真实 none fixture 精确 RED（`NetworkSettings.Networks empty`），不是缺模块；39 metadata / 13 filter / 旧 44 guard 原始日志全绿；负例覆盖 bridge/host/双网络/none+IP/Ports/Binds/Mounts/Caps；未按测试数量单独批准。 |

**离线 PASS 与 runtime 分开**：以上只证明 predicate/过滤/parser 与离线回归，不证明容器 start/exec、Linux `/proc` 实际值、回环/外连拒绝；首次 attempt 仍是 BLOCKED，不能改记 PASS。

**可重试**：candidate 无阻断性代码回归；主代理可 resume 原 owner，用同配置唯一新容器跑一次 Stage1，无需重复用户确认（卡已选 oracle fix + one retry；首次授权已消耗，新授权未消耗）。Stage2 未授权；HostConfig/资源/权限/镜像不变；本 review 未运行 Docker/socket。

## 15. 追加复核：Stage1 retry + residual cleanup（2026-11-12）

**结论：retry 仍 BLOCKED，不是 PASS；首次 attempt 也仍 BLOCKED。根因是按已批准字面 selfcheck 的“仅 lo”失败，不是首次 Networks-empty 的 oracle bug。runtime 网络语义仍未证。**

- **源/请求**：retry copy 的 `stage1.py=58a0b148…`、`docker_client.py=4db7…`、`selfcheck.js=5202…`、`selftest_guard.py=b79c…` 与 reviewed candidate 及 post-run manifest 一致；唯一 create 201，prestart 37/37 PASS，start 204，running inspect 200，exec create 201/start 200，exec inspect `ExitCode=2/Running=false`。真实为 10 次请求尝试（表列 1–10；stop timeout 无响应），`request_count=9` 只计有响应者。
- **已证**：`uid/euid/gid=10001`、`cwd=/spike`、HOME 正确；7 目录 uid/gid 10001/mode700/rw；sentinel 写读 match；`/spike` 为 tmpfs、固定 options；selfcheck 在 interfaces 断言处 fail-fast，stdout 930B/stderr 0B、frames=1。
- **接口证据不足**：实际 `/proc/net/dev` 为 `lo,tunl0,gre0,gretap0,erspan0,ip_vti0,ip6_vti0,sit0,ip6tnl0,ip6gre0`，**只有名字**；未采集 flags/地址/路由，不能单凭名字推外网可达，也不能单凭伪接口名推一定安全。因 fail-fast，`/proc/net/route`、forbidden、127.0.0.1 回环、`192.0.2.1:9` 拒绝均 **not-run**。
- **契约判断**：“仅 lo”是本次已批准 literal 条件（与首次未批准的额外 Networks-empty 不同），故本次失败是合同内失败，不能改记 PASS。语义目标仍是无可用外联；若认为“仅 lo”过严，只能作为后续契约 proposal：采集接口 flags/地址/路由，拒绝非 loopback 的 UP+地址/default route，而不是逐个增加接口名白名单。不能把现有 failed 回溯改 pass；也不能无限扩名单。
- **stop**：代码/日志确定 `REQ_TIMEOUT=5.0`、`stop?t=5`；`09` 在 08:08:54 仍 running；后续只读 status 显示 start 08:08:53.789、FinishedAt 08:08:59.631、ExitCode137、OOM false。确定的只是“客户端 5s 无余量 + 服务端 5s 宽限”的时限冲突；timeout 既不等同于仍 running，也不等同于已清理。137/OOM false 与 stop grace 后 SIGKILL 一致，但无 stop response/daemon log，具体信号/daemon 原因仍未证。
- **cleanup**：retry 内 stop timeout 后未 delete、无同 ID 404；后续用户另批 `delete_stopped_stage1_container`：precheck owner exact、exited137；仅 3 请求 GET/DELETE/GET，唯一 DELETE 204，同 ID 404；未 stop/force/prune/list/其他资源。首轮与 retry 的原始失败证据未改；旧 retry 报告的“last observed running”由后续只读 status 更新为 exited。
- **审计边界**：retry 的 03/05/09 snapshot 均为 filtered，无 `Config.Env`、无额外 labels（top-level 仅两个自有 label）；selfcheck stdout 只含合成路径/接口名；未发现新的真实 Env/secret/用户资源落盘。无新越界。
- **可证/不可证**：可证固定镜像/HostConfig、37 项 prestart、start/exec 与 UID/dirs/sentinel/tmpfs；不可证接口 flags/地址/路由、无 default route、回环/外联拒绝、stop 的 204/信号原因；Stage2/host/model/下载仍 not-run。
- **后续最小工程裁决（proposal/notimplemented）**：若继续，下一契约应为“接口语义断言”而非名字：采集 flags/地址/路由，拒绝非 lo 的 UP+地址/default route；cleanup 给服务端宽限 + 客户端余量，并对 timeout 做有界只读状态核对，不 force。当前不改代码/判据。
- **当前 Stage1 必须保持 BLOCKED**；不补写未跑项为 PASS。所有 create/retry 授权已消耗，cleanup 授权仅限本 ID；任何新容器、修改判据或 Stage2 材料/host 都需另行决定，不自动续跑。stage1 失败不等于产品 P01/P02 失败；产品 74/929 基线保留、不重跑。
