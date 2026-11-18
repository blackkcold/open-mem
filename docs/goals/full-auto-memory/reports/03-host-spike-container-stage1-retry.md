# 03 host-spike container Stage1 retry

Date: 2026-11-12
Status: **BLOCKED — selfcheck failed (interfaces not only lo); stop timed out; no delete/404; container last observed running; not PASS**
Scope: 用户 `stage1_oracle_fix_and_one_retry` 的唯一一次同配置重试。未执行 Stage2/host/model/下载/PUT archive。
Retry root: `/private/var/folders/ks/flqyrh0j5wvf2t7v4s7lcnz0b5tfzv/T/opencode/full-auto-memory-stage1-retry.3kleNR/`

## 1. Source manifest（已核）

| 文件 | reviewed candidate | retry copy |
|---|---|---|
| `stage1.py` | `58a0b148a0e9dd56f2fc283ef56738c7aa2f7e6e9506e1f51278e880edeaf19e` | 同左 |
| `docker_client.py` | `4db7a0fdec692f462920c277f020ea3469f3650ef5d01123a1cc5c871df765c6` | 同左 |
| `selfcheck.js` | `52026dde328423475e8669d812b4e072f85a7ac93333658d82c6f6ff2a3fb84a` | 同左 |
| `selftest_guard.py` | `b79c5668d82f83a4f008a4bb4e68fa92ebfb8d150c8021c137fae573c4cb2911` | 同左 |

- Candidate: `.../full-auto-memory-stage1-oracle-fix.nlSAX1/`；retry copy match（`source-final-hashes.txt`），`stage1.py` 是最终 `58a0…`，不是中间 `0da26…`。
- `delta.md` copy sha256 `faaddede…54c53`；`source-post-run-hashes.txt` 与 manifest 四项一致；源码未修改。
- 未覆写 candidate 的旧中间 manifest；新 manifest 只在 retry 根。

## 2. 唯一容器的真实请求

| # | 请求 | status | ms | 证据 |
|---|---|---|---|---|
| 1 | GET image gate | 200 | 54.0 | `01-image-gate.response.json`；仅 4 字段 |
| 2 | POST create（仅一次） | 201 | 62.8 | `02-create-response.response.json` |
| 3 | GET pre-start inspect | 200 | 9.8 | `03-inspect-pre-start.response.json` |
| 4 | POST start | 204 | 207.9 | `04-start.response.json` |
| 5 | GET running inspect | 200 | 15.0 | `05-inspect-running.response.json` |
| 6 | POST exec create | 201 | 5.7 | `06-exec-create.response.json` |
| 7 | POST exec start | 200 | 63.5 | `07-exec-start.meta.json`；frames=1 |
| 8 | GET exec inspect | 200 | 1.6 | `08-exec-inspect.filtered.json` |
| 9 | GET cleanup inspect | 200 | 1.3 | `09-cleanup-inspect.response.json` |
| 10 | POST stop（attempted） | **timeout** | 5000 | 无 204/304，未落响应文件 |

- run_id: `20261112T080853Z-2f36035f`
- name: `openmem-spike-20261112T080853Z-2f36035f`
- ID: `4eae86137cd4bf35be799d2446d692abdada2015338793ae18b4c28cb798122b`
- labels: `openmem.host-spike=1`，`openmem.spike.run=20261112T080853Z-2f36035f`
- create payload sha256 `4e84827de350ba7df68022b139cc5b6ec6898c43e5fd7a5c0543af37d770dee7`；Image 仍为固定 `sha256:8f69…c9ba5`；`build_payloads` 未改。
- runner `request_count=9`（只计拿到响应者；stop timeout 不计），总 `5937.9 ms`，`runner.exit=2`。
- Socket owner/type 检查通过（`00-owner.json`）；`env -i`，无 `DOCKER_HOST`/proxy。

## 3. Pre-start metadata（37/37 PASS）

- 37 项全部 ok：ID/name/image/两个自有 label、`User=10001:10001`、`WorkingDir=/spike`、`Config.Volumes=null`、`State=created`。
- `NetworkMode=none`；`NetworkSettings.Networks` 为已 review 的 none 占位对象（`EndpointID/NetworkID` 空、IP/Gateway/MAC 空、prefix 0）→ `networks_none_ok` 通过。
- `Binds=[]`、`Mounts=[]`、`HostConfig.Mounts=[]`、`PortBindings={}`、`PublishAllPorts=false`、`Ports={}`。
- `Tmpfs` 仅 `/spike` 且 options 固定；`ReadonlyRootfs=true`、`CapDrop=["ALL"]`、`CapAdd=[]`、`no-new-privileges:true`、`Privileged=false`、Pid/Ipc/Cgroupns 非 host/private；Memory/MemorySwap 1GiB、NanoCpus 1e9、PidsLimit 128、ShmSize 16MiB。
- `03` 落盘为 `filtered-container-snapshot-v1`，未落 Env/额外 label。

## 4. 真实 Linux selfcheck（ExitCode=2）

- `07-exec-start` stdout 930 B、stderr 0 B、frames=1；`08-exec-inspect`：`Running=false`、`ExitCode=2`。
- stdout 已确认：`uid/euid/gid=10001`、`cwd=/spike`、`HOME=/spike/home`；7 目录均 `uid/gid=10001`、`mode=700`、`rw=true`；`/spike/work/sentinel` 写入读回 `match=true`；`/spike` 为 `tmpfs`，options `rw,nosuid,nodev,relatime,size=786432k,mode=700,uid=10001,gid=10001`。
- **失败断言**：`interfaces not only lo`。实际 `/proc/net/dev`：
  `["lo","tunl0","gre0","gretap0","erspan0","ip_vti0","ip6_vti0","sit0","ip6tnl0","ip6gre0"]`
  - 无 `eth0`；其余为内核隧道伪接口，不是已证明的外网路径；但 reviewed 脚本要求“仅 lo”，故 fail-fast。
- 因 `fail()` 在 interfaces 处退出，`/proc/net/route`、forbidden paths、127.0.0.1 回环、`192.0.2.1:9` 拒绝均 **not-run**；不能补写为通过。

## 5. Cleanup 失败（未取得 204/404）

- `09-cleanup-inspect`（stop 前）200：ID/name 相符；两个自有 label 精确相符；`State.Status=running`；`Mounts=[]`；`HostConfig.Binds=[]`、`Tmpfs` 仅 `/spike`、ports 空。owner3 + mounts 可独立核对（`09-cleanup-inspect.response.json`）。
- stop 请求按 `POST /containers/<ID>/stop?t=5` 发起，但 5s client timeout；`99-summary.cleanup.error="timed out"`、`cleanup.steps=[{"inspect":200}]`，无 204/304。
- 因此脚本未执行 delete，也未取得同 ID 404；**cleanup 未完成**。最后观测状态为 `running`；timeout 后状态未再探测（遵守“失败即停、不新策略”）。
- 未 force、未 prune、未重试 stop、未建第二/第三容器、未触碰其他用户资源。精确失败记录：`cleanup-failure.json`。

## 6. 证据路径

- retry root：`/private/var/folders/ks/flqyrh0j5wvf2t7v4s7lcnz0b5tfzv/T/opencode/full-auto-memory-stage1-retry.3kleNR/`
- `source-final-hashes.txt`、`source-post-run-hashes.txt`、`runner.log`、`runner.exit`、`cleanup-failure.json`
- `audit/00-boundary.json`、`00-owner.json`、`01-image-gate.filtered.json`、`02-create-request.json`、`02-create-response.response.json`、`03-inspect-pre-start.checks.json`、`04-start.response.json`、`05-inspect-running.response.json`、`06-exec-create.response.json`、`07-exec-start.stdout.txt`、`07-exec-start.stderr.txt`、`08-exec-inspect.filtered.json`、`09-cleanup-inspect.response.json`、`99-summary.json`
- 所有 own-container inspect 为 filtered snapshot；未落镜像 Env/额外 label。

## 7. 结论与边界

- 本次为唯一一次重试，已实际创建/启动/执行；**Stage1 BLOCKED，不是 PASS**。首次 attempt 仍 BLOCKED，不得改写。
- 未证明：`/proc/net/route` 无 default、回环 200、TESTNET 1s 拒绝；这些本次 not-run。`NetworkMode=none` 与 pre-start 隔离 metadata 37/37 已证，但不等于运行时网络断言全过。
- interfaces 的“仅 lo”是否为过严判据，需 reviewer 决定；本次未改源码/断言，也未重跑。
- stop timeout 可能是 client 5s 与 Docker `t=5` 的边界，但未复测；不得据此推断容器已停。
- 容器最后观测 `running`，可能仍存在；main agent/reviewer 需另行决定清理。用户 one-retry 授权已消耗，本 owner 不再自动重跑/新建容器。Stage2/host/模型仍不启动。
