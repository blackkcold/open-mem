# 03 host-spike stage controls

Date: 2026-11-12
Base: `/private/var/folders/ks/flqyrh0j5wvf2t7v4s7lcnz0b5tfzv/T/opencode/host-spike-stages.ftGEtQ`
Scope: 仅 child-only `sandbox-exec` + `/bin/sh` builtin marker；未启动 OpenCode host/plugin/model/fake provider，未访问外网，未读真实 config/Keychain/managed prefs。
Result: **BLOCKED at stage2**；stage3 未执行；host 兼容 **not-run**。

## 1. 设计

| 组 | profile | 唯一变量 |
|---|---|---|
| stage1 | `(version 1)(allow default)` | 最简工具/目标/环境对照 |
| stage2 | deny-default；仅 `/bin/sh` exec、必要系统 runtime、本组 root 读写；无网络 | 加入限制 |
| stage3 | 与 stage2 相同，仅追加 `localhost:47831` 三条网络规则 | 仅网络规则；未执行 |

每组 target 固定 `/bin/sh -c 'printf TARGET_START > "$ROOT/marker"; exit 0'`；marker 只写本组 `root/`（profile 允许区），不写 logs。每组 `env -i`，HOME/XDG/TMPDIR 独立；`BASH_ENV`/`ENV` 未继承；不创建 listener、不连接。

## 2. 实际结果（原始证据）

| 组 | returncode | marker | stdout/stderr | profile sha before=after | 结论 |
|---|---|---|---|---|---|
| stage1 | **0** | `present` / `TARGET_START` | 0 / 0 bytes | `d130f968…` = 同 | allow-default 下工具、`/bin/sh`、env、父目录写入可用 |
| stage2 | **134** | `absent` | 0 / 0 bytes | `406410d5…` = 同 | 切换到 deny-default 限制后 abort；target builtin 未获证执行 |
| stage3 | **not-run** | — | — | — | 首次失败即停止，未增第四组/未重跑 |

- `runner.returncode.txt=1`；`status.txt=STAGE2_FAILED rc=134`；`run.txt`：`STAGE1_PASS`，stage2 failed，stage3 stopped。`runner.stderr.txt` 记录 `59427 Abort trap: 6` 对应 stage2 的 `env -i ... sandbox-exec ...` 命令；stage2 自身 stdout/stderr 为空。
- stage1/2 的 `logs/before-exec.txt` 均有 `BEFORE_EXEC`/`AFTER_EXEC`；`logs/parent-control-read.txt` 为 `PARENT_CONTROL_OK`，证明 marker 目录父进程真实可写。stage2 `root/marker` 不存在。
- 两组的 `profile-before.sha256` 与 `profile-after.sha256` 完全一致；stage3 profile 仅预置、未执行。
- 无 listener；`listener-check.txt` 中 47831/47832 无 LISTEN，无 sandbox/perl 残留进程。未触碰 shared service。

## 3. 能定位 / 不能定位

**有证据：**

1. 在 `(allow default)` 下，`sandbox-exec` + `/bin/sh -c` builtin + 本组 `ROOT` 写入 + `env -i` 可以返回 0 并写出 marker。
2. 换成 stage2 的最小 deny-default 后，同一 target/env/父目录写入路径在 marker 前 abort（134），stage3 未运行。
3. 失败不是父目录不可写（parent control 已通过），也不是服务/listener 问题；stage2 profile 无网络规则，故网络规则不是 stage1→stage2 的变量。

**不能定位：**

- 不能断言 stage2 是 profile **编译/解析**失败，还是 profile **应用**失败，还是 `/bin/sh`/dyld/loader 在 builtin 前被 deny；无 stage2 marker、无 stderr、无 sandbox 内部阶段日志。
- 不能把 134 直接归因于 dyld、mach、`file-read-metadata`、具体 subpath 或缺少某个 allow；没有逐条证据。
- stage1 通过 **不等于** enforcement 通过：`(allow default)` 是受控对照，不是 deny-default 隔离证明。
- stage3 未执行，网络规则差异/回环限制完全未证。
- host 兼容、allow/deny、插件/会话/parts 全部 **not-run**。

## 4. 边界与下一步

- 仅执行 2 组（stage1 通过、stage2 失败），符合“首次失败即停止”；没有 stage3、没有二分重跑、没有第四组、没有改 profile。
- 未读真实 `~/.config/opencode`/memory、Keychain、`/Library/Application Support/opencode`、Managed Preferences；未 sudo/安装/改系统设置。
- 本轮是隔离能力诊断，不是 host 启动批准；即使 stage1 通过也不能写“host 已隔离”。
- 下一步需原独立 reviewer 复核这组证据；若要继续，只能另立最小 stage2 规则归因任务（例如逐条 rule 对照），必须重新批准，不得在本轮自行扩跑。
- 证据保留：`stage1/`、`stage2/`、`stage3/profile.sb`、`run-stages.sh`、`runner.*`、`status.txt`、`run.txt`、`listener-check.txt`；未删除任何旧日志。
