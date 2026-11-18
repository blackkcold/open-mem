# 03 host-spike Docker readonly preflight

Date: 2026-11-12
Scope: 仅本机 Docker Desktop Unix socket 的 3 个 GET；未执行 `docker` CLI、未启动 Desktop/daemon/容器、未 pull、未读 `~/.docker/config.json`/凭证/Keychain、未访问外网。
Raw: `tmp/full-auto-memory/host-spike/docker-preflight/`

## Socket 身份（metadata）

| 项 | 值 |
|---|---|
| socket | `/Users/11169285/.docker/run/docker.sock`（Socket，uid 375208955=当前用户） |
| `/var/run/docker.sock` | symlink → 上述路径 |
| owning process | PID `5573`，comm `/Applications/Docker.app/Contents/MacOS/com.docker.backend`，user `11169285` |
| 判定 | 本机 Docker Desktop 后端；非远端/非猜测 `DOCKER_HOST` |

`lsof` 仅按该 socket 路径查得 PID；`ps` 仅取 pid/comm/user；未全局列进程、未读参数。

## 请求（最多 3 个，均 GET，无重试）

| # | path | status | bytes | time | 过滤结果 |
|---|---|---|---|---|---|
| 1 | `/_ping` | 200 | 2 | 56.6 ms | body=`OK` |
| 2 | `/version` | 200 | 892 | 32.8 ms | 见下 |
| 3 | `/v1.56/images/json` | 200 | 9458 | 90.3 ms | 17 images |

总耗时 185.8 ms；exit 0；无 error/truncation；每请求≤5s、总≤30s。未保存完整响应；仅保存下列过滤字段。

## `/version` 过滤字段

```json
{"Version":"29.8.1","ApiVersion":"1.56","Os":"linux","Arch":"arm64","Platform.Name":"Docker Desktop 4.93.0 (240920)"}
```

## 镜像（仅 RepoTags/Id/Size；17 条）

**可作为基础镜像候选的已知 tag（contents 未验）：**

| tag | Size |
|---|---|
| `alpine:latest` | 13,589,479 |
| `ubuntu:24.04` | 141,318,854 |
| `node:20` | 1,585,105,309 |
| `nikolaik/python-nodejs:python3.11-nodejs20` | 2,211,969,974 |

另有 `postgres:16-alpine`、`registry:2`、`hello-world:latest`、`ghcr.io/sigstore/cosign/cosign:v2.4.1`，以及 9 个 `family-ledger`/本地 registry 项目镜像（完整过滤列表见 `03-images-filtered.json`，未展示 Labels/Env/registry 信息）。

## 结论与边界

- **可连接**：本机 Docker Desktop socket 存在、身份明确，`_ping`/`/version`/`images` 均 200；API 1.56。
- **基础镜像候选**：alpine/ubuntu/node/nikolaik 仅是已有 tag+size；**未 inspect**，不能证明内含 OpenCode、Node runtime、Linux 工具链或足够空间/权限。
- **隔离仍未证**：Docker Desktop 的 VM、网络模式、文件挂载、凭据转发、daemon 权限未检查；容器内真实 home/系统 OpenCode 配置/Keychain/managed prefs 是否不可达 **unknown**。socket 读写权限本身也意味着高权限，不能据此宣称安全隔离。
- 未请求 image inspect/config、容器 list/logs/env/volumes、网络 inspect；无 POST/DELETE/pull；不启动任何环境。
- 后续需用户确认**确切运行方案**（镜像、网络、挂载、只读根、资源/清理、隔离证明），再决定是否启动；当前 host-spike 仍 **BLOCKED/not-run**，不标完成。
- 原日志/报告/证据保留，未删除。
