# 03 host-spike existing isolation entries

Date: 2026-11-12
Scope: 只读静态入口检查；未执行 Docker/VM 工具、未连接 daemon/socket、未启动 App、未读配置/镜像/VM 磁盘、无网络/安装/提权。
Raw: `tmp/full-auto-memory/host-spike/existing-isolation-entries.txt`

## 结果

| 类别 | 入口 | 状态 |
|---|---|---|
| PATH | `docker` | **FOUND** `/usr/local/bin/docker`（符号链接 → `/Applications/Docker.app/Contents/Resources/bin/docker`） |
| PATH | `podman` / `colima` / `limactl` / `lima` / `nerdctl` / `orb` / `utmctl` / `qemu-system-aarch64` / `qemu-system-x86_64` / `prlctl` / `vmrun` / `multipass` | **NOTFOUND** |
| `/Applications` | `Docker.app` | **FOUND**（directory，mtime 2026-08-25） |
| `/Applications` | OrbStack / UTM / Podman Desktop / Parallels Desktop / VMware Fusion / Rancher Desktop / VirtualBuddy / Multipass | **NOTFOUND** |
| `~/Applications` | 上述同一组 App | **NOTFOUND** |

## 边界

- **入口存在 ≠ 本地环境可用**：未运行 `docker version/info/context/ps/images`，未连接 Docker daemon、未检查 socket、未读取 `~/.docker/config.json`、未检查镜像/容器/网络/卷。
- **入口存在 ≠ 隔离成立**：Docker Desktop 的 VM/网络/文件挂载/凭据转发、daemon 是否运行、是否可用、能否从外部证明真实 home/系统 OpenCode 配置/Keychain/managed prefs 不可达，全部 **unknown**。
- 未读取 `/Applications/Docker.app` bundle 内容；仅 metadata（type/mode/size/mtime）与符号链接最终路径。
- 未发现仅表示**这些已知入口未发现**；不断言机器绝对没有容器/VM 环境。
- 未启动 App/服务，未 sudo/安装，未访问正式 config/memory/Keychain/managed prefs，未重跑 sandbox/host。

## 建议（需主代理裁决）

Docker 入口存在，可作为**候选**要求用户确认具体运行方案，但必须先由下一段只读/受控检查证明 daemon 可用性与隔离边界；当前不自动启动，不代表 host-spike 完成。若不能证明隔离，仍 **BLOCKED**，需用户提供独立环境或另行决定安装/其他路径。
