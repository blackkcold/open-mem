# 03 residual Stage1 container cleanup

Date: 2026-11-12
Status: **CLEANED — precheck owner exact + exited; DELETE 204; same-ID GET 404 confirmed**
Scope: 用户 `delete_stopped_stage1_container` 的精确清理授权。仅 3 个请求，未 stop/force/prune/exec/list，未创建 container，未跑测试/Stage2。

## 1. 目标与 precheck

- ID：`4eae86137cd4bf35be799d2446d692abdada2015338793ae18b4c28cb798122b`
- Name：`/openmem-spike-20261112T080853Z-2f36035f`
- Labels：`openmem.host-spike=1`；`openmem.spike.run=20261112T080853Z-2f36035f`
- `GET` precheck：200，`owner_match=true`，`State.Status=exited`、`Running=false`、`ExitCode=137`、`OOMKilled=false` → 满足删除条件。
- Mounts `[]`；NetworkMode `none`；Binds `[]`；Tmpfs 仅 `/spike`；ReadonlyRootfs `true`；Privileged `false`；CapDrop `["ALL"]`；CapAdd `[]`；Memory `1073741824`、NanoCpus `1000000000`、PidsLimit `128`、ShmSize `16777216`。
- 过滤 snapshot：`precheck.snapshot.json`；无 Env/额外 labels/完整 body。

## 2. 请求清单（3 个，均 5s/1MiB 上限）

| # | 方法/路径 | status | ms | bytes | 证据 |
|---|---|---|---|---|---|
| 1 | GET `/v1.56/containers/<ID>/json` | 200 | 33.5 | 5587 | `precheck.snapshot.json` |
| 2 | DELETE `/v1.56/containers/<ID>`（无 query/force） | 204 | 92.3 | 0 | `delete.response.json` |
| 3 | GET 同 ID `/json` | 404 | 5.0 | 98 | `final.response.json` |

- DELETE 仅一次，`No Content`；未重发。
- `request_count=3`；runner `exit 0`。
- 最终 404 message：`No such container: 4eae86137cd4bf35be799d2446d692abdada2015338793ae18b4c28cb798122b`

## 3. 结果与边界

- `cleaned=true`：同 ID 最终 GET 404 已实际核验，不能视为未核完成。
- 未发 stop、未 force/prune、未 exec；未触碰其他 container/volume/image；未全局列 container。
- 旧 retry/status/源码/原始证据未改；未改 PROGRESS/orchestration/产品/候选/harness。
- 本 scope 仅为清理，不是新测试或 Stage2 授权；Stage1 结论仍以原报告为准（BLOCKED）。

## 4. Evidence

- root：`/private/var/folders/ks/flqyrh0j5wvf2t7v4s7lcnz0b5tfzv/T/opencode/full-auto-memory-stage1-residual-cleanup.VfFX7y/`
- `cleanup_stopped.py`、`precheck.snapshot.json`、`delete.response.json`、`final.response.json`、`requests.json`、`summary.json`、`runner.log`、`runner.exit`
