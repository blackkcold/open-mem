# 03 host-spike container Stage1

Date: 2026-11-12
Status: **BLOCKED — Stage1 stopped at pre-start metadata; start/exec/selfcheck not-run; cleanup confirmed**
Scope: 仅用户批准的 `container_stage1_only` throwaway spike（新受限 AF_UNIX client + image gate + 唯一容器 create/start/exec/selfcheck/stop/delete + 自有 `/spike` tmpfs）。Stage2、host、模型、下载、PUT archive 均未执行。
Evidence root: `/private/var/folders/ks/flqyrh0j5wvf2t7v4s7lcnz0b5tfzv/T/opencode/full-auto-memory-stage1.60cIhN/`

## 1. 结论

- Image gate：`GET /v1.56/images/sha256:8f69…c9ba5/json` → 200；`Id` 匹配、`Os=linux`、`Architecture=arm64`、`Config.Volumes=null`（按空语义）。仅保存这 4 个字段；未保存镜像 Env/Labels/完整响应。
- Create：仅一次，`POST /containers/create?name=openmem-spike-20261112T071814Z-368a2456` → 201；容器 ID `4999bd5d…64f4a0`，`Warnings=[]`，两个自有 label 已核。
- 创建后先 inspect：37 项 metadata 检查 **36 pass / 1 fail**。`HostConfig.NetworkMode=none`、`Binds=[]`、`HostConfig.Tmpfs` 仅 `/spike`、`Mounts=[]`、`Privileged=false`、`ReadonlyRootfs=true`、`CapDrop=["ALL"]`、`CapAdd=[]`、`User=10001:10001`、资源/端口/日志限制均通过。
- 唯一失败：额外加的 `NetworkSettings.Networks empty`；实际值为 Docker 的 `"none"` 网络占位对象（`NetworkID=""`、`EndpointID=""`、`IPAddress=""`、`Gateway=""`）。这不是有 IP 的额外网络，但按“非空不得当空”规则判失败。
- 因真实 metadata 断言失败，按任务要求在 start 前停止；**未 start、未 exec、未跑容器内 selfcheck/回环/外连**；未建第二容器、未改断言重跑。
- Cleanup：状态 `created` → 直接 `DELETE` → 204；同一 ID `GET` → **404**（46.8 ms，98 bytes）。本次无残留。
- 因此如实状态是 **BLOCKED / Stage1 未完成**，不是 PASS。

## 2. 固定输入与 owner 核查

| 项 | 观测 |
|---|---|
| image | `sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5` |
| image Os/Arch | `linux` / `arm64` |
| image declared volumes | `null`（空） |
| socket | `/Users/11169285/.docker/run/docker.sock`，Socket，uid `375208955`=当前用户，mode `0755` |
| client env | `env -i` 启动；记录键中无 `DOCKER_HOST`/`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`；另有 `SDKROOT`/`CPATH`/`LC_CTYPE` 等非传输键（仅记录键名） |
| temp dir | 唯一目录，uid 当前用户，mode `0700`；audit 文件 `0600` |
| plan / delta sha256 | `d5dcd3e9…ff0af` / `faaddede…54c53` |
| image gate raw | 未落完整响应；仅 `01-image-gate.filtered.json`（169 B） |

## 3. 真实请求（6 次，总 1,348.8 ms）

| # | 请求 | status | ms | 证据 |
|---|---|---|---|---|
| 1 | GET image json | 200 | 464.8 | `01-image-gate.response.json` |
| 2 | POST containers/create（唯一一次） | 201 | 486.6 | `02-create-response.response.json` |
| 3 | GET container inspect（pre-start） | 200 | 48.2 | `03-inspect-pre-start.response.json` |
| 4 | GET container inspect（cleanup） | 200 | 13.1 | `09-cleanup-inspect.response.json` |
| 5 | DELETE container | 204 | 236.5 | `12-delete.response.json` |
| 6 | GET own-ID after delete | 404 | 46.8 | `13-cleanup-404.response.json` |

未发 stop：容器从未 start，状态为 `created`，按状态机直接 delete。无全局 list/prune、无 force、无 pull、无镜像/卷操作。

## 4. 唯一容器与固定 payload

- name: `openmem-spike-20261112T071814Z-368a2456`
- ID: `4999bd5d66712751fe643ab9f7b9c00d17bad70fa11e62fd7f006fbc2c64f4a0`
- labels: `openmem.host-spike=1`，`openmem.spike.run=20261112T071814Z-368a2456`（只读这两键）
- create payload sha256: `bff1ed61…dcd82`；完整 payload 在 `02-create-request.json`，含固定 Image ID、Entrypoint `/usr/local/bin/node`、WorkingDir `/spike`、User `10001:10001`、6 个合成 Env、HostConfig。
- HostConfig 关键值：`NetworkMode=none`、`Binds=[]`、`Mounts=[]`、`PortBindings={}`、`PublishAllPorts=false`、`ReadonlyRootfs=true`、`CapDrop=["ALL"]`、`CapAdd=[]`、`SecurityOpt=["no-new-privileges:true"]`、`Privileged=false`、`IpcMode=private`、`CgroupnsMode=private`、`Memory=MemorySwap=1073741824`、`NanoCpus=1000000000`、`PidsLimit=128`、`ShmSize=16777216`、`Tmpfs={"/spike":"rw,exec,nosuid,nodev,size=768m,mode=0700,uid=10001,gid=10001"}`、`RestartPolicy=no`、`AutoRemove=false`。
- create 响应 `Warnings=[]`；未出现第二次 create。

## 5. Pre-start metadata 结果（37 项）

通过的 36 项：ID/name/image/两个自有 label、`Config.User=10001:10001`、`WorkingDir=/spike`、`Entrypoint`、`Config.Volumes` 空、`State=created`；`NetworkMode=none`、`NetworkSettings.Ports={}`、`Binds=[]`、`HostConfig.Mounts=[]`、`Devices=[]`；`Tmpfs` 仅 `/spike` 且 options token 匹配、`Mounts=[]`；`Privileged=false`、`ReadonlyRootfs=true`、`CapDrop=["ALL"]`、`CapAdd=[]`、`no-new-privileges:true`、`PidMode!=host`、`IpcMode=private`、`CgroupnsMode=private`、`PortBindings={}`、`PublishAllPorts=false`；`Memory=MemorySwap=1073741824`、`NanoCpus=1000000000`、`PidsLimit=128`、`ShmSize=16777216`、`AutoRemove=false`、`RestartPolicy=no`、`LogConfig=json-file 1m/1`。

失败项：
- `NetworkSettings.Networks empty` → observed `{"none":{"NetworkID":"","EndpointID":"","IPAddress":"","Gateway":"",...}}`（其余字段均为空/null）。
- 解释与边界：`HostConfig.NetworkMode=none` 已通过；从键名 `none` 与全空 `NetworkID`/`EndpointID`/`IPAddress`/`Gateway` 看，表现为 none 网络的占位对象（解释，非额外探测）。但它不是 `null/[]/{}`；按任务“非空不得当空”规则，本次不能判过。是否为过严的额外断言，留给主代理/独立 reviewer 判定。

## 6. 未执行（not-run）

- container start、exec create、exec start、exec/json；
- UID/EUID=10001、HOME、7 目录 owner/RW、sentinel、`/proc/mounts` tmpfs；
- `/Users`、`/Library/Application Support/opencode`、`/var/run/docker.sock`、`/run/host-services`、`/etc/opencode` 不存在性检查；
- 127.0.0.1 回环 HTTP、192.0.2.1:9 拒绝（非 timeout）；
- running→stop→delete 路径、stop 响应；
- Stage2、host/OpenCode/plugin、模型、下载/安装/新镜像、PUT archive。

## 7. Cleanup 证据

- 删除前 cleanup inspect：200；`Id`/`Name`/两个 label 匹配；`State.Status=created`；`Mounts=[]`；`HostConfig.Tmpfs` 仅 `/spike`；`Binds=[]`；ports 空。
- `DELETE /v1.56/containers/4999…f4a0` → 204（236.5 ms，0 B）。
- `GET` 同 ID → 404（46.8 ms，98 B）；证据 `13-cleanup-404.response.json`。
- 未 stop（未 start）；未 force、未 prune、未触碰其他容器/卷/镜像。未做全局“确认无残留”查询，仅本 ID 404。

## 8. Client 离线 guard 自测

- `selftest/guard-selftest.log`：44/44 PASS（首轮，无根因修正）。
- 覆盖：非白名单 method/path（global list、pull、image delete、archive PUT、prune、resize）、其他 container/exec ID、重复 create、篡改 create 的 privileged/network/capadd/memory/bind/ports/user/image tag/labels、篡改 exec 的 user/privileged/capadd/tty/attach/cmd、已签发请求的 path/body 篡改、rawstream 解复用与坏帧、1 MiB/200 行上限、socket owner metadata。
- 自测不连接 socket；真实请求仅由 `stage1.py` 在自测通过后发出。

## 9. 证据清单

- root: `/private/var/folders/ks/flqyrh0j5wvf2t7v4s7lcnz0b5tfzv/T/opencode/full-auto-memory-stage1.60cIhN/`
- `delta.md`（9 行边界/可证反例）
- `docker_client.py`、`stage1.py`、`selfcheck.js`、`selftest_guard.py`
- `audit/00-boundary.json`、`00-owner.json`、`01-image-gate.filtered.json`、`02-create-request.json`、`02-create-response.response.json`、`03-inspect-pre-start.checks.json`、`03-inspect-pre-start.response.json`、`09-cleanup-inspect.response.json`、`12-delete.response.json`、`13-cleanup-404.response.json`、`99-summary.json`
- `selftest/guard-selftest.log`、`selftest/guard-selftest.json`、`stage1-run.log`
- 所有 audit 文件 0600；目录 0700；未删除证据。

## 10. 能证 / 不能证与下一步

- 能证：本次固定 image 的 4 字段符合；唯一容器按固定 payload 创建成功；pre-start 读回的 36 项具体 metadata 符合（含 none 网络模式、无 bind/volume/port、只读根、cap-drop、非 root、资源上限）；容器已按 own ID 删除并 404。
- 不能证：容器 start 后行为、目录/权限、tmpfs、回环、外连拒绝；Docker Desktop VM/内核无漏洞；mac host/OpenCode/plugin；Stage2。
- 下一步（需主代理/用户决定，不自行执行）：reviewer 判定 `NetworkSettings.Networks` 的 none 占位是否应视为符合 `NetworkMode=none`；若认可，需**新的批准**再跑 Stage1（新唯一容器），不得把本次当作 PASS。若要求严格空 `Networks`，当前 Docker 表示下 Stage1 维持 BLOCKED。
