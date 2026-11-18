# 03 host spike isolation preflight

Date: 2026-11-12
Scope: 只读预检；未启动 OpenCode host/server/model/fake provider，未执行任何 sandbox 子进程，未读写真实 `~/.config/opencode`、正式记忆或原仓库。
Verdict: **XDG-only BLOCKED；child-only sandbox 路线 GO_TO_SANDBOX_SELFTEST**。`sandbox-exec` 可用、profile 候选已备；但 enforcement/host 兼容尚未运行（见 §8），不得写成隔离已证。

## 1. 已观察（只读）

| 项 | 证据 | 结论 |
|---|---|---|
| CLI | `opencode --version` = `v2.1.1`；`command -v` = `/Users/11169285/.local/bin/opencode` → `../lib/node_modules/@opencode/cli/bin/opencode.exe`（Mach-O arm64） | 当前安装版已确认 |
| 顶层 flags | `opencode --help`：`--standalone`（private server）、`--server <url>`（explicit server）；默认 help 说明 discovery/shared service | 可用显式 private/explicit server；默认路径禁止 |
| serve | `opencode serve --hostname --port --cors --service --stdio` | 可显式绑定 127.0.0.1/端口；`--service` 禁止使用 |
| run | `opencode run --standalone --server --model --session --format` | 客户端可显式连独立 server，不自动用 shared |
| service | `start/restart/status/stop/get/set/unset` | 任一 `service *` 都可能触碰用户 shared service；本轮禁止 |
| 官方 CLI | `/v2/docs/cli`：默认“discovers or starts one shared background server”；`--standalone`/`--server`；`opencode api` 可能自动起 shared | 不执行无 `--server` 的 run/api |
| 官方 service | `/v2/docs/troubleshooting`：shared service 注册于 `~/.local/state/opencode/service.json`，配置于 `~/.config/opencode/service.json` | 隔离 state/config 后应无该注册；未实跑 |
| 官方 config | `/v2/docs/config`：全局 `~/.config/opencode` 或 `$XDG_CONFIG_HOME/opencode`；项目配置向根祖先合并；系统目录 `/Library/Application Support/opencode` 会加载 agents/commands/skills/plugins，管理偏好最高优先级 | **系统级配置无法用现有环境变量证明禁用** |
| 官方 providers | `/v2/docs/cli/providers`：凭证存 server SQLite（`XDG_DATA_HOME`/`OPENCODE_DB` 可改）；legacy `auth.json` 在 dataDir | dataDir 可隔离；Keychain 未证 |
| 本地 env | 安装包 strings 观察：`OPENCODE_CONFIG_DIR/CONFIG/CONFIG_CONTENT/DB`、`XDG_*_HOME`、`OPENCODE_DISABLE_PROJECT_CONFIG/CONFIG_PROJECT_DISABLE`、`OPENCODE_DISABLE_MODELS_FETCH/AUTOUPDATE/CLAUDE_CODE/CLAUDE_CODE_SKILLS`、`OPENCODE_SERVER_PASSWORD/PASSWORD` | 有隔离开关；官方页面未逐项文档化，行为未实跑 |

原始输出：`tmp/full-auto-memory/host-spike/preflight/`（`cli-version-and-path.txt`、`cli-help.txt`、`serve-help.txt`、`run-help.txt`、`service-help.txt`、`env-vars.txt`、`installed-cli-*`、`docs-refs.txt`）。

## 2. 隔离启动候选（未执行）

```bash
ROOT="<SESSION_TMP>/host-spike/run-<id>"
mkdir -p "$ROOT"/{home,xdg/config/opencode,xdg/data/opencode,xdg/cache,xdg/state,tmp,repo,logs}
git -C "$ROOT/repo" init -q
printf '{"update":"disable"}\n' > "$ROOT/xdg/config/opencode/opencode.jsonc"
umask 077; openssl rand -hex 32 > "$ROOT/service-token"
PORT=47831

ENVV=(env -i
  HOME="$ROOT/home"
  XDG_CONFIG_HOME="$ROOT/xdg/config"
  XDG_DATA_HOME="$ROOT/xdg/data"
  XDG_CACHE_HOME="$ROOT/xdg/cache"
  XDG_STATE_HOME="$ROOT/xdg/state"
  TMPDIR="$ROOT/tmp"
  PATH=/usr/bin:/bin:/usr/sbin:/sbin
  OPENCODE_CONFIG_DIR="$ROOT/xdg/config/opencode"
  OPENCODE_CONFIG="$ROOT/xdg/config/opencode/opencode.jsonc"
  OPENCODE_DB="$ROOT/xdg/data/opencode/opencode.db"
  OPENCODE_DISABLE_PROJECT_CONFIG=1
  OPENCODE_CONFIG_PROJECT_DISABLE=1
  OPENCODE_DISABLE_CLAUDE_CODE=1
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1
  OPENCODE_DISABLE_MODELS_FETCH=1
  OPENCODE_DISABLE_AUTOUPDATE=1
  OPENCODE_DISABLE_FILEWATCHER=1
  OPENCODE_DISABLE_FFF=1
  OPENCODE_PASSWORD="$(cat "$ROOT/service-token")"
  OPENCODE_SERVER_PASSWORD="$(cat "$ROOT/service-token")")

# 仅显式 foreground server；不加 --service
"${ENVV[@]}" /Users/11169285/.local/bin/opencode serve \
  --hostname 127.0.0.1 --port "$PORT" >"$ROOT/logs/server.log" 2>&1 &
echo $! > "$ROOT/server.pid"

# 客户端显式连该 server，不用 shared discovery
"${ENVV[@]}" /Users/11169285/.local/bin/opencode run \
  --server "http://127.0.0.1:$PORT" --format json "<isolated prompt>"

# 关闭：只杀自己的 PID；禁止 opencode service stop/restart
PID=$(cat "$ROOT/server.pid"); kill -TERM "$PID"
for i in $(seq 1 50); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
ps -p "$PID" -o pid=,ppid=,command= || true
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true
```

`OPENCODE_PASSWORD`/`OPENCODE_SERVER_PASSWORD` 的 server/client 角色**未证**；两者同设仅为候选。若握手失败，不降级到 shared service，直接 BLOCKED。

## 3. 进程/端口验收（下一段）

1. 启动前记录 `lsof -nP -iTCP:$PORT -sTCP:LISTEN` 必须为空；端口固定、非 0、非用户服务端口。
2. `ps -p $(cat server.pid) -o pid=,ppid=,command=` 必须是本次 `opencode serve`；PPID 为本 spike shell。
3. `lsof -nP -a -p $PID -i` 只允许 `127.0.0.1:$PORT` LISTEN；出现外部 ESTABLISHED/UDP DNS → **BLOCKED**（不能仅凭 env 假定无外呼）。
4. 隔离 `$ROOT/xdg/state` 下不得生成 `opencode/service.json`；不得读写真实 `~/.local/state/opencode`。真实 shared service PID/端口不属于本 process tree。
5. 关闭后 PID 不存在、端口无 LISTEN；**不得**执行 `opencode service stop/restart`，避免影响用户服务。
6. `OPENCODE_DB` 文件必须在 `$ROOT/xdg/data`；`lsof -p $PID` 不得出现真实 `~/.config/opencode`/data/auth 路径（能观察到的打开文件）。
7. 启动日志不得含 token；若 `serve` 打印 password，立即停止并改候选，不把日志纳入报告。

## 4. 配置/插件/技能/MCP/instructions 风险

- `XDG_CONFIG_HOME` + `OPENCODE_CONFIG_DIR` + 空 `opencode.jsonc` 只隔离用户/项目配置；官方明确系统目录 `/Library/Application Support/opencode` 和管理偏好仍会加载 agents/commands/skills/plugins。**没有发现环境变量可禁用系统配置** → 严格“无正式配置”不能证明。
- 项目/祖先：`OPENCODE_DISABLE_PROJECT_CONFIG`/`OPENCODE_CONFIG_PROJECT_DISABLE` 只在本地 binary strings 观察到，未文档化、未实跑；空 repo 不能保证 `/Users/...` 祖先无 `AGENTS.md`/`.opencode`。
- 自动插件/技能：isolated global config 为空可避免显式 `plugins`/`skills`；`.opencode/plugins`、`.opencode/skills` 自动发现是否随 project-disable 关闭**未证**。MCP 只来自配置；系统配置仍可注入。
- instructions：`AGENTS.md` 发现可能独立于 project config；未证禁用。
- 结论：在上述系统级路径未被证明不存在/被容器隔离前，不能宣称“无正式配置/无自动插件/技能/MCP/instructions”。

## 5. 凭证/网络/更新/模型目录

- `env -i` 去掉继承的 `OPENCODE_API_KEY`、provider keys、proxy；但仍需 `PATH/HOME/XDG/TMPDIR`。真实 provider 凭证未读取。
- auth SQLite 在隔离 dataDir；无 `/connect`、无真实 token。`Keychain` 访问未证；`OPENCODE_PASSWORD` 仅为本地 ephemeral token（tmp 0600），不是用户/provider 凭证；若必须零 token，则 `serve` 候选 BLOCKED。
- `OPENCODE_DISABLE_MODELS_FETCH=1` 仅来自 binary；模型目录/默认模型 fallback 是否仍外呼**未证**。下一段应使用本地 fake provider，且先断网/抓包验证无外呼。
- `OPENCODE_DISABLE_AUTOUPDATE=1` + isolated config `update:"disable"`；实际是否不检查更新**未证**。
- telemetry：官方 CLI/config/service 页面未给 V2 禁用变量；是否存在外呼**未证**。不能把“未看到”当无 telemetry。

## 6. 未证 / 阻塞

| 项 | 状态 |
|---|---|
| 独立 `serve --hostname 127.0.0.1 --port` 实际启动 | not-run |
| `run --server` 不触发 shared discovery | docs 支持；**未实跑** |
| `OPENCODE_PASSWORD` vs `OPENCODE_SERVER_PASSWORD` 角色 | unknown；握手失败即 blocked |
| 系统 `/Library/Application Support/opencode` + managed prefs 不存在/为空 | **无法在不读取系统配置的前提下证明** → 主阻塞 |
| 祖先 `AGENTS.md`/`.opencode`/自动插件/技能/instructions | 未证；可能需容器/文件系统白名单 |
| 真实 `~/.config/opencode`/`~/.local/state` 未被打开 | 仅设计隔离；无 OS 级读取追踪，未证 |
| Keychain/telemetry/模型目录/auto-update 外呼 | unknown；需抓包/文件追踪 |
| 本地 fake provider | 未启动；下一段才允许 |

## 7. 结论

**XDG-only BLOCKED**，不是“命令写错”。`serve` + XDG + `env -i` 是必要基础，但官方 V2 明确系统级配置/管理偏好始终加载；当前无环境变量能证明其禁用，且无 OS 级文件读取隔离。child-only sandbox 路线见 §8（仅 `GO_TO_SANDBOX_SELFTEST`）。主代理需先选择其一：

1. 授权只读核查 `/Library/Application Support/opencode` 与 managed prefs（不存在/空）并接受系统配置风险；或
2. 提供容器/独立用户/文件系统白名单，使系统配置、真实 home、Keychain 不可达；或
3. 明确接受“仅用户级 XDG 隔离”，但不得宣称“无正式配置/无凭证访问”。

满足 1 或 2 后，下一段才可按 §2/§3 实际启动；本预检未启动任何 host/server/model，未写产品代码，未改正式配置/数据。

## 8. Child-only OS sandbox feasibility（新增，未执行）

工具层（observed）：`/usr/bin/sandbox-exec` 存在且可执行（102560 bytes，2026-04-06）；`-f/-n/-p/-D` 语法明确；man 标注 **DEPRECATED**，无 check-only 模式。系统自带 profile 示例证明 `(deny default)`、`file-read*`、`process-exec`、`network-bind/outbound (local/remote ip "localhost:PORT")`、`mach-lookup` 语法可用。原始输出：`sandbox-exec-stat.txt`、`sandbox-exec-help.txt`、`sandbox-exec-man.txt`、`sandbox-profile-examples.txt`、`sandbox-network-syntax.txt`、`sandbox-ip-filter-examples.txt`、`selftest-binaries.txt`。

### Profile 候选 `host.sb`（子进程及其后代）

```scheme
(version 1)
(deny default)
(allow file-read-metadata)                 ; 仅元数据；不读内容
(allow sysctl-read)
(allow process-fork)
(allow process-exec
  (literal "/Users/11169285/.local/lib/node_modules/@opencode/cli/bin/opencode.exe")
  (literal "/Users/11169285/.local/bin/opencode"))
(allow file-read* file-map-executable
  (subpath "<ROOT>")                       ; 唯一可写/可读的 spike root
  (subpath "/usr/lib") (subpath "/usr/share")
  (subpath "/System/Library") (subpath "/Library/Apple/System/Library")
  (subpath "/private/var/db/timezone") (literal "/private/var/db/dyld")
  (subpath "/Users/11169285/.local/lib/node_modules/@opencode/cli")
  (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/tty"))
(allow file-write* (subpath "<ROOT>") (literal "/dev/null"))
(allow network-bind   (local ip "127.0.0.1:<PORT>"))
(allow network-inbound (local ip "127.0.0.1:<PORT>"))
(allow network-outbound (remote ip "127.0.0.1:<PORT>"))
(allow mach-lookup (global-name "com.apple.system.logger"))
```

- 只允许本 CLI、系统动态库/dev/tmp root；**不包含**真实 HOME、`~/.config/opencode`、`/Library/Application Support/opencode`、`/Library/Managed Preferences`、祖先 `.opencode`/`AGENTS.md`。`securityd`、`trustd`、`cfprefsd` 未允许，默认拒绝；不能靠 mach 代理绕过文件白名单。
- 网络只允许 `127.0.0.1:<PORT>`；外部 IP/DNS/telemetry/model catalog 默认 deny。系统示例直接示出的是 `localhost`/`*`，`127.0.0.1` 字面量需 selftest 验证。`<ROOT>`/`<PORT>` 在生成 profile 时替换，不使用真实用户路径；`file-read-metadata` 仅暴露 stat，不读内容。
- 需要 selftest 时复制为 `selftest.sb`，仅追加 `/bin/sh`、`/bin/cat`、`/usr/bin/curl`、`/usr/bin/python3` 的 `process-exec` 与 `/bin`、`/usr/bin` 的 `file-map-executable`；host profile 不放开 shell。
- 该 profile 仅约束本次 `sandbox-exec` 子进程及后代，不改全局网络/权限，不 sudo、不 codesign、不动 shared service。

### 最小无敏感数据自测（下一段，未执行）

1. 在 `ROOT/sentinel` 写/读固定字符串 → 期望 exit 0；在 `ROOT/../forbidden-sentinel` 写/读 → 期望 sandbox deny（使用自建 sentinel，不碰真实文件）。
2. 父进程启动 `python3 -m http.server <PORT> --bind 127.0.0.1`；`curl http://127.0.0.1:<PORT>/` → 期望 200；`curl --max-time 2 http://192.0.2.1:9/` → 期望 sandbox deny，不连接真实 provider。
3. `curl http://127.0.0.1:1/`/真实域名不测；不读 Keychain、不调用 `security`、不读 managed prefs。
4. 先跑 `sandbox-exec -f selftest.sb /bin/sh -c 'exit 0'` 验证 profile 可解析且 `/bin/sh` 可执行；再跑 selftest。若 profile 语法/执行失败 → `BLOCKED`，不回到 XDG-only，不猜 env。

### 四层状态

| 层 | 状态 |
|---|---|
| 工具存在 | observed：`sandbox-exec` 可执行 |
| profile 语法 | candidate：来自系统 profile 示例；**未解析/未执行** |
| enforcement | **not-run**：未启动任何 sandbox 子进程 |
| host 兼容 | **not-run**：未在 profile 内启动 `opencode serve` |

Verdict: **GO_TO_SANDBOX_SELFTEST**（仅允许下一段做上述最小自测；不是 host 启动批准）。若 selftest 的 deny/allow 任一不符、或 host 启动需要 `securityd/cfprefsd`/外部网络 → **BLOCKED**，不得放宽 profile 后继续。

