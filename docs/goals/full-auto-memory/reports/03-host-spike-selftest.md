# 03 host-spike sandbox selftest

Date: 2026-11-12
Base: `/private/var/folders/ks/flqyrh0j5wvf2t7v4s7lcnz0b5tfzv/T/opencode/host-spike-selftest.BibKdy`
Scope: child-only `sandbox-exec` selftest；未启动 OpenCode host/fake provider/model，未使用真实凭证/正式配置/用户文件，未改全局设置。
Result: **BLOCKED**。Profile 解析/执行失败，enforcement 与 allow/deny 用例未进入；host 兼容仍 **not-run**。

## 1. 环境与文件

- `selftest.sb`：deny-default 候选；`selftest.sh`：仅 runner；`server.py`：父进程自建 `127.0.0.1` 静态 HTTP。
- 目录：`allowed/`（唯一允许读写）、`outside/`（父进程可读写、sandbox 负例）、`home/xdg/tmp`（`env -i` 隔离）、`http-allow/`、`http-deny/`、`logs/`。
- 运行：`env -i HOME=... XDG_* TMPDIR=... PATH=/usr/bin:/bin:/usr/sbin:/sbin LC_ALL=C /bin/sh selftest.sh "$BASE"`。
- 原始：`logs/wrapper.out|err|exit`、`logs/profile-parse.out|err|exit`、`logs/parent-controls.txt`、`logs/port-*.before|after-start`、`logs/http-*.log`、`http-*.pid`、`logs/status.txt`。
- 无服务 token；日志无 env secret/provider credential。

## 2. 结果（真实退出码）

| 步骤 | 结果 |
|---|---|
| 父进程正向控制：outside sentinel 读、outside write-target 读、自建 HTTP 47831/47832 | `parent-controls.txt` 有内容；两个 listener 由本脚本 PID 创建并 short-request 就绪 |
| Profile 解析（首版 `127.0.0.1:47831`） | **exit 65**；stderr：`sandbox-exec: host must be * or localhost in network address`；指向 `selftest.sb:30:22` |
| 第二次 sandbox-exec 调用（同 loopback 语义改为 `localhost:47831`） | **exit 134（SIGABRT）**；stdout/stderr 空；未进入任何 allow/deny 用例 |
| `allow-root`、`deny-read`、`deny-write`、`allow-http`、`deny-http` | **not-run**（profile parse 失败即停止，未重试放宽） |
| mach/securityd/cfprefsd/trustd/Keychain | **not-run**；profile 只列 `com.apple.system.logger`，不调用 `security`，未读 Keychain/managed prefs |
| OpenCode host 兼容 | **not-run**；未启动 `opencode` |

`http-allow.log` / `http-deny.log` 均 `READY 47831/47832`；`port-47831.before`/`port-47832.before` 为空，`after-start` 有本脚本 listener。脚本 `trap cleanup` 已结束自有 PIDs（`http-allow.pid=40742`、`http-deny.pid=40743`）；事后 `lsof -nP -iTCP:47831/47832 -sTCP:LISTEN` 为空，未操作 shared service。

> 首版 `127.0.0.1` 是 profile 语法不接受（parser 明确要求 `*` 或 `localhost`），改为 `localhost` 仍是同 loopback 范围，不是放宽；第二次为 SIGABRT，未做第三次改 profile。先前日志已由 `logs/profile-parse-first-and-second-note.txt` 记录。

## 3. 结论与边界

- `sandbox-exec` 工具存在、`-f` 可用（见 isolation.md §8），但该候选 profile 在本机未通过解析/执行；因此 **不能声称 deny-default enforcement 成立**。
- 失败发生在 profile 编译/应用、`sandbox-exec` 自身、或 target 启动前后的某一层，当前**无法定层**；不是 allow/deny 断言失败；**allow/deny 成功/EPERM 均未证**。host/provider/parts 也全部未跑。
- 不把“listener 启动成功”当作 sandbox 网络限制成功；不把父进程正向控制当作 child 隔离证据。
- 未读 `~/.config/opencode`、真实 memory、Keychain、`/Library/Application Support/opencode`、Managed Preferences；未改系统网络/权限。
- 后续只能由主代理另立 profile 语法修复/新候选；本段按规则停止，不放宽 profile、不回退 XDG-only、不启动 host。真实 host 兼容仍 **not-run**。

## 4. 产物清单

`selftest.sb`、`selftest.sh`、`server.py`、`logs/`、`http-allow.pid`、`http-deny.pid`、`status.txt`、`outside/*`、`allowed/*`、`home/`、`xdg/`、`tmp/`。全部保留在该唯一 session temp 目录，未 `rm`。

## 5. SIGABRT 失败层诊断（只读，2026-11-12）

### 已证事实

- 失败命令来自 `selftest.sh:87`：`env -i ... /usr/bin/sandbox-exec -f selftest.sb "$@"`；target 为 `/bin/sh -c 'exit 0'`（`:92`）。`run_case` 只把 `$?` 写入 `profile-parse.exit`，没有 target-start/end marker，也没有 sandbox-exec 阶段日志。
- `profile-parse.exit=134`；`profile-parse.out` 与 `.err` 均为 0 字节；`wrapper.err` 记录 `40775 Abort trap: 6`，命令正是 `env -i ... sandbox-exec ...`。这说明 abort 发生在该命令进程内，但 `env` 随后 exec 成 `sandbox-exec`，再 exec target，PID 不变，**不能仅凭 PID 判断是哪一段**。
- 首版 `127.0.0.1:47831` 的 exit 65 有明确 parser 错误：`sandbox-exec: host must be * or localhost in network address`，并指向 `selftest.sb:30:22`。这证明**至少首版已进入 profile 编译/解析**；首版 profile 原文未保留，只有 `logs/profile-parse-first-and-second-note.txt` 的记录。
- 第二次 `localhost:47831` 的 134 没有 stderr；`/bin/sh -c 'exit 0'` 本身不产生输出。若 target 成功执行，exit 应为 0；exit 134 说明在 `exit 0` 之前发生了 abort，但**没有证据**区分 sandbox profile compile/apply、`sandbox-exec` 自身、target 的 dyld/loader，还是 target 内其他初始化。
- 布局直接差异：profile 的 `file-read*/write*` 只允许 `$BASE/allowed`；而 `run_case` 的 `HOME=$BASE/home`、`XDG_*=$BASE/xdg/*`、`TMPDIR=$BASE/tmp` 都不在允许列表内。该差异是事实，但目前**没有证据**证明它触发了本次 abort；`/bin/sh -c 'exit 0'` 通常不需要这些路径。
- `mach-lookup` 只允许 `com.apple.system.logger`，没有 `securityd/cfprefsd/trustd`；没有执行 `security`，未读 Keychain/managed prefs。mach 是否为 abort 原因**未知**。
- 两个 listener 的父进程控制已通过；`cleanup-check.txt` 显示 40742/40743 已结束、47831/47832 无 LISTEN。`status.txt=BLOCKED`，`wrapper.exit=40`。

### 归因表

| 层 | 证据 | 结论 |
|---|---|---|
| profile 编译/解析 | 首版 exit 65 + 明确 parser 行号 | **可能且首版已证**；第二版是否在编译期 abort 未知 |
| profile 应用/sandbox-exec 自身 | 第二版 134、无 stderr、无 marker | **可能，未证** |
| target exec/dyld/初始化 | 无 target marker；`/bin/sh -c exit 0` 无输出 | **可能，未证** |
| allow/deny enforcement | 未进入任何用例 | **not-run** |
| host 兼容 | 未启动 OpenCode | **not-run** |

### 一次 marker 诊断结果（2026-11-12，已执行且停止）

- 执行脚本：`marker-diag.sh`（仅新增；`selftest.sb`/`selftest.sh` 未改）。命令仍为 `env -i ... /usr/bin/sandbox-exec -f selftest.sb /bin/sh -c 'printf TARGET_START > "$ROOT/marker"; exit 0'`；外层 `/usr/bin/perl -e 'alarm shift; exec @ARGV' 15` 提供有界超时。
- 父进程在调用前写 `logs/marker-BEFORE_EXEC.txt`，调用后追加 `AFTER_EXEC`；profile 与 runner 的 sha256 前后完全一致（见 `logs/marker-pre-sha256.txt` / `marker-post-sha256.txt`）。
- 实际结果：`returncode=134`；`marker=absent`；`stdout_bytes=0`；`stderr_bytes=0`；`marker-diag-wrapper.rc=0`；目标未写出 allowed 内 marker。
- 这证明：父进程确实到达 `BEFORE_EXEC` 并调用了 `sandbox-exec`；但**目标 shell builtin 未获证执行**（marker 不存在）。仍不能区分 abort 在 profile compile/apply、`sandbox-exec` 自身、target 的 dyld/loader，还是 target 在 builtin 之前初始化失败。没有任何 allow/deny 或 host 证据。
- `marker-diag` 未创建 listener；事后 47831/47832 无 LISTEN；`status.txt=BLOCKED`。原日志/profile 全部保留，未删除、未改。
- 不再执行任何 profile/变体；allow/deny、mach enforcement、host 兼容仍 **not-run**。若未来另获批准，最小下一步须在 sandbox-exec 内加入阶段 instrumentation 或使用独立最小 profile/target 对照；本任务到此停止。

