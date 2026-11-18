# 03 host-spike container plan

Date: 2026-11-12
Status: **PLAN ONLY — not-run**。当前仅拟申请 **Stage1-only** 权限；Stage2 保留为未来单独审批。未创建/启动/删除容器，未再查询 Docker daemon，未下载/安装。
Purpose: 用本机已有 `node:20` 启动**唯一 throwaway** 容器，先证具体隔离条件，再（材料齐备时）跑 Linux OpenCode + 本机 fake provider。
Base evidence: `reports/03-host-spike-docker-preflight.md`、`03-images-filtered.json`、`03-host-spike-capabilities.md`、`03-host-spike-review.md` §9/§10。
## 1. 固定镜像与前置门禁

| 项 | 值 |
|---|---|
| image | `node:20` |
| immutable ID | `sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5` |
| size | 1,585,105,309 bytes |
| pull | **never**；创建用 ID，不用 tag；不再 pull/更新 |
| arch | 预检 `/version` 为 linux/arm64，但 image 架构未单独证 |

执行前唯一允许的只读门禁（本次不做，不用裸 `docker` CLI）：
通过**用户批准后新写**的受限 AF_UNIX client（旧版仅验证 3GET，不能复用；`env -i`，固定 `--unix-socket /Users/11169285/.docker/run/docker.sock`，不继承 `DOCKER_HOST`/proxy/凭证）调用 `GET /v1.56/images/<ID>/json`。
只解析并记录：`Id`、`Os`、`Architecture`、`Config.Volumes`。**不读取/不展示** `Config.Env`、Labels、history、registry 配置或任何其他字段。
`Id` 不等于上述值、`Os/Architecture` 非 `linux/arm64`、或 `Config.Volumes` 非空（声明匿名/命名卷）→ **STOP**；不 pull、不换 tag、不创建隐含卷。若无法确认，BLOCKED。
## 1.1 本次 Stage1-only 授权包（新受限 client）

现有 `docker-preflight/probe.py` **只验证了 3 个 GET**（`_ping`、`/version`、`/images/json`），未被验证可写/可 exec；不得以“已验证 client”名义复用它做 create/start/exec/stop/delete。用户批准后另写**仅本次**的临时 AF_UNIX client：

- 固定 socket `/Users/11169285/.docker/run/docker.sock`；`env -i`，不继承 `DOCKER_HOST`/proxy/凭证，不读 Docker config/context；无重试；单请求 ≤5s、Stage1 总 ≤10min；响应 ≤1MiB/≤200 行，超过即 STOP。
- 方法/路径白名单（仅此 9 个）：`GET /v1.56/images/<ID>/json`（第 4 个只读 GET，本次新授权，不沿用旧 3GET）；`POST /v1.56/containers/create`；`POST /v1.56/containers/<id>/start`；`POST /v1.56/containers/<id>/exec`；`POST /v1.56/exec/<execID>/start`；`GET /v1.56/exec/<execID>/json`；`GET /v1.56/containers/<id>/json`；`POST /v1.56/containers/<id>/stop?t=5`；`DELETE /v1.56/containers/<id>`。
- Stage1 不允许 `PUT /archive`；Stage2 材料复制另行批准。
- exec 以 `User=10001:10001`、`Privileged=false`、`CapAdd=[]` 创建；create exec 时 `AttachStdout=true`、`AttachStderr=true`，`POST /exec/<id>/start` 时 `Detach=false` 捕获并解复用 stdout/stderr；`GET /exec/<id>/json` 只核 `ExitCode`，不从 inspect 取输出。create→start→查 ExitCode 的结果均落盘，不能只看 POST 成功。
## 2. 唯一容器与 HostConfig（目标）

```text
POST /v1.56/containers/create?name=openmem-spike-<unique>
{
  "Image": "sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5",
  "Entrypoint": ["/usr/local/bin/node"],
  "Cmd": ["-e", "const fs=require('fs');const root='/spike';for(const d of ['work','home','tmp','config','cache','data','state']){const p=root+'/'+d;fs.mkdirSync(p,{recursive:true,mode:0o700});const s=fs.statSync(p);if(s.uid!==process.getuid())throw new Error('uid mismatch '+p);fs.accessSync(p,fs.constants.R_OK|fs.constants.W_OK);}setInterval(()=>{},1000)"],
  "User": "10001:10001",
  "WorkingDir": "/spike",
  "Env": ["HOME=/spike/home", "TMPDIR=/spike/tmp", "XDG_CONFIG_HOME=/spike/config", "XDG_CACHE_HOME=/spike/cache", "XDG_DATA_HOME=/spike/data", "XDG_STATE_HOME=/spike/state"],
  "Labels": {"openmem.host-spike": "1", "openmem.spike.run": "<unique>"},
  "HostConfig": {
    "NetworkMode": "none", "PortBindings": {}, "PublishAllPorts": false,
    "Binds": [], "Mounts": [],
    "ReadonlyRootfs": true, "CapDrop": ["ALL"], "CapAdd": [],
    "SecurityOpt": ["no-new-privileges:true"], "Privileged": false,
    "IpcMode": "private", "CgroupnsMode": "private",
    "Memory": 1073741824, "MemorySwap": 1073741824, "NanoCpus": 1000000000,
    "PidsLimit": 128, "ShmSize": 16777216,
    "Tmpfs": {"/spike": "rw,exec,nosuid,nodev,size=768m,mode=0700,uid=10001,gid=10001"},
    "LogConfig": {"Type": "json-file", "Config": {"max-size": "1m", "max-file": "1"}},
    "RestartPolicy": {"Name": "no", "MaximumRetryCount": 0}, "AutoRemove": false
  }
}
```

启动、执行、停止、删除均走同一 AF_UNIX client：`POST /containers/<id>/start`、`POST /containers/<id>/exec`（如需脚本）、`POST /containers/<id>/stop?t=5`、`DELETE /containers/<id>`；不调用裸 `docker` CLI，不读 context/config。

**WorkingDir/bootstrap**：`WorkingDir=/spike`，不依赖 Docker 自动创建 `/spike/work`（tmpfs 遮蔽/rootfs 顺序未证）。容器启动命令由 UID 10001 的 Node 先 `mkdir -p /spike/{work,home,tmp,config,cache,data,state}`，逐项检查 owner 为当前 UID 且可读写，失败则进程非零退出；成功后才 idle。

硬边界：

- 无 `Binds`/volume/bind；无 docker.sock、SSH/GPG/Keychain/DBus 转发；无 `--device`、无 `--privileged`、无 host PID/IPC、无端口发布、无 external network。
- rootfs 只读；**应用写入区只有 `/spike` tmpfs**（768MiB）。`/proc`、`/dev`、`/dev/shm` 仍存在，`/dev/shm` 由 `ShmSize=16MiB` 约束；它们是 runtime，不是应用存储，不能把容器说成“除 /spike 外无任何可写路径”。
- 固定非 root UID 10001；`cap-drop ALL` + `no-new-privileges`；内存/CPU/PID/日志/时间有界。
- 只操作 label + name + ID 三重的本容器；不接触用户已有容器/卷/镜像。
## 3. 两阶段执行与停止条件
### Stage 1 — 隔离条件（不依赖 OpenCode 材料）

1. 通过 AF_UNIX client `GET /v1.56/containers/<id>/json` 读取本容器必要字段：确认 `NetworkMode=none`、`Binds=[]`，`HostConfig.Tmpfs` **仅** `/spike`；`Mounts` 允许 `[]` **或恰好一个** `{Type:"tmpfs",Destination:"/spike"}`（Docker 表示不唯一），但不允许 bind/volume/其他 mount。再确认 `Privileged=false`、`ReadonlyRootfs=true`、`CapDrop=["ALL"]`、`CapAdd=[]`、`PidMode`/`IpcMode` 非 host、`PortBindings={}`、`PublishAllPorts=false`、`User=10001:10001`、`Memory=1073741824`、`NanoCpus=1000000000`、`PidsLimit=128`、`ShmSize=16777216`；ID/name/labels 三重匹配。只读本容器两个自有 label 用于核对，不读取镜像 Labels/Env 内容。
2. 容器内 benign selfcheck：UID/EUID=10001、HOME=`/spike/home`；确认 `/spike/{work,home,tmp,config,cache,data,state}` 均存在、owner 10001、可写；写/读 `/spike/work/sentinel` 成功；`/proc/mounts` 中 `/spike` 必须为 `tmpfs`；`/Users`、`/Library/Application Support/opencode`、`/var/run/docker.sock`、`/run/host-services`、`/etc/opencode` 不存在（或仅镜像自有内容，须记录）；不得读真实 home。
3. 容器内回环：`node` 在 `127.0.0.1:<port>` 起临时 HTTP，`fetch` 自测成功；外部 `192.0.2.1:9` 连接在 1s 内失败（ENETUNREACH/EPERM），证明 network none 不是仅“未监听”。
4. Stage 1 全部通过 → 允许进入 Stage 2；任一 metadata/selfcheck/回环/外连不符 → **STOP**，不创建第二容器、不改参数。
### Stage 2 — Linux OpenCode + local fake provider（条件）

**前置**：`reports/03-host-spike-linux-materials.md` 已存在，但状态是 **BLOCKED_TO_DOWNLOAD**；其中没有可验证的 tarball URL、SRI/integrity、实际大小或 license 实证。**“存在报告”不等于材料可用**。Stage2 只有在用户**同时**批准：① 固定包公开 metadata/下载与完整性校验；② 该容器 host 阶段；两者缺一 → Stage1 结束，不猜二进制、不下载。

- 候选坐标仅来自本地 launcher 元数据：`@opencode/cli-linux-arm64@2.1.1` 或 `@opencode/cli-linux-arm64-musl@2.1.1`；在容器内先按 `/etc/alpine-release`/`ldd` 判 libc，再选一个，**不静默 fallback**；无法判定 → STOP。
- 下载门（另批）：只允许官方 registry 公开 metadata/精确 tarball；压缩 ≤200MiB、解包 ≤512MiB；校验 SRI/本地 SHA256/size；tar 先 list，拒绝绝对路径/`..`/链接/device/setuid/意外顶层；不运行 install/postinstall/npm/npx；失败 BLOCKED_TO_DOWNLOAD，不换源/不猜 URL。
- 材料经 AF_UNIX `PUT /containers/<id>/archive?path=/spike`（tar stream）进入本容器 `/spike`（不在 host 挂载）；copy 前按实际 binary+fixture+DB/log 余量核对，**总量超过 `/spike` 768MiB → STOP**，不偷偷增内存/tmpfs。材料完整性校验失败 → STOP。
- 容器内启动 fake provider（Node，绑定 `127.0.0.1:<port>`，固定 SSE/marker，不连接外网）；OpenCode 配置只用合成 home/config/work，无真实 memory/credentials。
- **配额分开**：host/API 探针最多 64 次、总 10min；**fake model dispatch 最多 8 次**；3 个 session + transcript/重读是 API 探针，不占 fake-model 8 次。任一层超限即 STOP。先读 OpenAPI/`ctx` keys，再测：

| 分类 | 断言 | 当前状态 |
|---|---|---|
| HTTP-only | root/child identity、projectID/location/parentID；user/synthetic/skill type/metadata（skill 走 full client/HTTP）；context/message.list/export 重读 hash；HTTP `entry.put` + fake-provider body；full-client `generate.text`/`session.generate`；fake SSE/route | Stage2 not-run |
| **plugin-ABI** | `ctx.generate.text`、`ctx.session.generate`、`context`/`http.request` hook、任何 `ctx.session` 探测 | **not-run**；2.1.1/2.1.4 ABI 未证，不能把 Linux 部分结果当 host/plugin 通过 |

当前**只申请 Stage1**；Stage2 不因 Stage1 批准而下载/启动 host。未来 Stage2 另行批准材料下载/校验、实际复制 cap（按内存余量，≤512MiB 包上限之外再定数）与匹配 ABI 探针；不得声称模型 100% 或 macHost 已证。
- 运行证据：原始响应字段、请求 marker、容器 metadata、退出码；不记录真实用户数据或密钥。
## 4. 资源清理（仅本次自有容器）

用户批准范围仅：通过 AF_UNIX client 创建/启动/执行/`stop`/`delete` **这一个** name+label+ID 容器，及 `/spike` tmpfs；不操作其他用户资源。

- 删除前先输出核对摘要：container ID、name、两个本次自有 label、status、`Mounts`（仅 `/spike` tmpfs 或 `[]`+HostConfig.Tmpfs）、`Binds=[]`、无 port；只读本容器两个自有 label，不读镜像 Labels/Env；任一不匹配 → 不删除，BLOCKED。
- 状态机：
  - `created` 未启动或 `start` 失败 → 直接 `DELETE`（不 stop）。
  - `running` → `POST stop?t=5` 成功后再 `DELETE`。
  - 已 `stopped` → 直接 `DELETE`。
  - 任一 `exec` 失败/超时 → 标记 BLOCKED，但仍按上述状态在 finally 清理本容器。
- 正常：`POST /containers/<ID>/stop?t=5`（仅 running），成功后 `DELETE /containers/<ID>`；随后 `GET /containers/<ID>/json` 应 404、name/label 不再存在。
- stop/delete 失败：保留容器与证据、停止后续阶段、报告 BLOCKED；**不 force、不 prune、不删 image/volume、不碰其他容器/服务**。若需要 force 才能删除，另案审批。
## 5. 能证 / 不能证

- 可证（若 Stage1/2 原始证据齐全）：该容器在给定 HostConfig 下无网络/无 host bind/非特权/只读根/非 root；容器内 OpenCode 的指定接口/字段/出站请求形状（Linux runtime）。
- **不能证**：Docker Desktop 内核/VM 无漏洞、绝对 OS 隔离、host 上其他容器/用户数据安全；Linux 与目标 macOS 宿主行为差异；P01 最终 macOS host 验收关闭。
- 无真实模型/外网；fake provider 只证明 transport，不证明模型行为。host-spike 仍 **not-run/BLOCKED**，本计划不标完成。
## 6. 用户需批准的新动作

1. **本次仅申请 Stage1**：新受限 AF_UNIX client + `GET /images/<ID>/json` image gate + 创建/启动/自检/exec + 仅此容器 stop/delete；总 ≤10min，无新下载/无 host/无模型。Stage2 不随本次批准。
2. 仅 stop/delete 该自有容器；不安装、不升级、不删镜像/卷、不改 Docker Desktop。
3. Stage2（未来单独批准）：固定公开 Linux 2.1.1 材料 metadata/下载/SRI/SHA256/size/path 校验，与该容器 host 阶段**同时**批准；当前未下载、无 URL/hash 实证；若不批准，Stage1 结束。
4. 不启动真实模型、不读真实配置/memory/Keychain；若需放宽网络/挂载/权限 → **STOP**，另案审批。
