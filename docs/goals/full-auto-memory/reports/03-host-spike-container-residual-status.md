# 03 residual Stage1 container read-only status

Date: 2026-11-12
Status: **200 — container exists; State=exited; ExitCode=137; Running=false; owner exact match; cleanup still pending**
Scope: 仅一次只读 `GET /containers/<ID>/json`。未发送 stop/delete/exec，未轮询，未读取其他 container，未改源码/旧 evidence。

## 1. 唯一请求

- URL：`GET /v1.56/containers/4eae86137cd4bf35be799d2446d692abdada2015338793ae18b4c28cb798122b/json`
- socket：`/Users/11169285/.docker/run/docker.sock`；`env -i`；单请求；timeout 5s；body cap 1 MiB。
- 结果：`status=200`、`30.3 ms`、`5587 bytes`、`request_count=1`、runner `exit 0`。
- Evidence：`request.json`、`response.json`、`runner.log`、`runner.exit`。

## 2. 过滤 snapshot（无 Env/额外 labels/完整 body）

| 字段 | 观测 |
|---|---|
| Id | `4eae86137cd4bf35be799d2446d692abdada2015338793ae18b4c28cb798122b` |
| Name | `/openmem-spike-20261112T080853Z-2f36035f` |
| Labels | `openmem.host-spike=1`；`openmem.spike.run=20261112T080853Z-2f36035f` |
| State.Status | `exited` |
| State.Running | `false` |
| State.ExitCode | `137` |
| State.OOMKilled | `false` |
| State.StartedAt | `2026-11-12T08:08:53.78924959Z` |
| State.FinishedAt | `2026-11-12T08:08:59.631111426Z` |
| Config.User / WorkingDir | `10001:10001` / `/spike` |
| NetworkMode / Binds | `none` / `[]` |
| Tmpfs | 仅 `/spike`，固定 options |
| Mounts | `[]` |
| ReadonlyRootfs / Privileged | `true` / `false` |
| CapDrop / CapAdd | `["ALL"]` / `[]` |
| Memory / NanoCpus / PidsLimit / ShmSize | `1073741824` / `1000000000` / `128` / `16777216` |

- `owner_match=true`：Id、Name、两个自有 label 均精确匹配；未读取/打印其他 labels。
- snapshot 文件：`snapshot.json`。

## 3. 结论

- 当前容器存在（200，不是 404），状态为 `exited`、`ExitCode=137`、`Running=false`；**不是 running**。stop timeout 本身不证明状态，本次只读 inspect 给出当前状态。
- 容器尚未删除；无 404，cleanup 仍 pending。按指示未自行 stop/delete/force/prune。
- 本次仅一个 GET；无后续请求、无重试、无其他 container 操作。
- 旧 retry 报告未改写；其中“last observed running”由本次 inspect 更新为上述 exited 状态。

## 4. Evidence

- root：`/private/var/folders/ks/flqyrh0j5wvf2t7v4s7lcnz0b5tfzv/T/opencode/full-auto-memory-stage1-residual-status.FJkDC6/`
- `read_status.py`、`request.json`、`response.json`、`snapshot.json`、`runner.log`、`runner.exit`
- 下一步：等待主代理向用户确认该精确容器的清理动作；本 owner 不自行删除。
