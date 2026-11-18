# 03 host-spike own-process denial log

Date: 2026-11-12
Scope: 仅对 stage2 自测进程 PID `59427` 做一次有界 `log show` 查询；未重跑 sandbox、未改 profile、未启动 host/server/provider/model。
Result: **UNKNOWN / BLOCKED**。查询成功但零条匹配记录；不能据此断言“无 deny”，也不能定位 stage2 abort 层。

## 1. PID 与时间依据

- PID 来源：`host-spike-stages.ftGEtQ/runner.stderr.txt:1` 明确 `59427 Abort trap: 6`，命令为 stage2 的 `env -i ... sandbox-exec ... /bin/sh -c 'printf TARGET_START > "$ROOT/marker"; exit 0'`。
- stage2 artifact mtime：`stage2/logs/before-exec.txt`、`summary.txt`、`returncode.txt`、`runner.stderr.txt` 均为 **2026-11-12 11:47:36 CST**（epoch `1794455256`；UTC `03:47:36`）。
- 查询窗口：**11:47:31–11:47:41 CST**（epoch `1794455251`–`1794455261`，共 10 秒；UTC `03:47:31–03:47:41`）。未使用 `--last`，未扩大窗口。

## 2. 唯一查询

```bash
/usr/bin/log show \
  --start @1794455251 --end @1794455261 --timezone local \
  --predicate '(processIdentifier == 59427) OR ((process == "kernel" OR process == "sandboxd") AND composedMessage CONTAINS "59427")' \
  --style compact --info --debug --no-pager
```

- 谓词直接限制 `processIdentifier == 59427`；kernel/sandboxd 分支必须 message 含精确 `59427`，未泛搜 `sandbox`/其他 PID/其他进程。
- 仅一次查询；`perl alarm 30` 有界；输出重定向到自有目录，未读其他用户/应用日志，未 sudo/授权弹窗/改日志设置。
- 原始输出：`own-process-log/stdout.txt`、`stderr.txt`、`exit.txt`、`query.txt`、`size.txt`。

## 3. 结果

| 项 | 值 |
|---|---|
| returncode | **0** |
| stdout | **1 行、44 bytes**，仅表头 `Timestamp Ty Process[PID:TID]` |
| stderr | 0 bytes |
| matching records | **0** |
| truncation | 无（远低于 1 MB/200 条） |

无 `kernel`/`sandboxd` 的 `59427` 消息，也无 PID 59427 的进程日志；没有可报告的 operation/path 拒绝记录。

## 4. 解释边界

- **不能**把“零条日志”解释为“没有 deny”：可能未产生统一日志、日志未持久化、权限/隐私过滤、事件发生在窗口外，或 `sandbox-exec` abort 不写 log。
- **不能**据此归因 profile 编译/应用、dyld、mach 或某个 allow/deny；仍为 **unknown**。
- 本结果不提供任何放宽 `securityd/cfprefsd`、正式 home、managed prefs 或 host profile 的依据；不得据此修改 profile。
- 未重跑 sandbox、未创建 listener、未启动 host/provider；allow/deny enforcement 与 host 兼容仍 **not-run**。
- 原 stage1/stage2 raw logs、profile 与旧报告全部保留，未覆盖、未删除。

## 5. 结论

`log show` 查询边界与原始结果已留档；因 **0 匹配记录**，最终结论为 **UNKNOWN / BLOCKED**。停止查询，不扩大时间/PID/类型，不进入 profile 修复或 host 运行。
