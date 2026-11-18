# 03 host-spike Stage1 oracle fix

Date: 2026-11-12
Status: **OFFLINE FIX COMPLETE — awaiting independent review; Stage1 remains BLOCKED/not-run**
Scope: 仅离线修复与单测。**未连接 Docker/Unix socket、未创建容器、未跑 Linux selfcheck、未改首次失败证据、未更新 PROGRESS/orchestration。**
Candidate: `/private/var/folders/ks/flqyrh0j5wvf2t7v4s7lcnz0b5tfzv/T/opencode/full-auto-memory-stage1-oracle-fix.nlSAX1/`

## 1. 根因与 RED

- Review §13 已证实：`stage1.py:248` 的 `NetworkSettings.Networks empty` 误用全局 `is_empty`，把 Docker `NetworkMode=none` 的 `{"none":{...全空...}}` 占位判失败；计划 Stage1 并无此断言。
- 先复制旧 `stage1.py` 为 `stage1_before.py`（sha256 `d502bc…c881`），用真实捕获 fixture `fixtures/prestart-none.response.json`（sha256 `f48bb1…e54f`）喂旧 validator：
  - `RED_CONFIRMED kind=metadata failures=['NetworkSettings.Networks empty']`
  - 这是旧 validator 的真实行为失败，不是“helper 未定义/缺模块”。

## 2. Candidate、hash 与 diff

- 旧目录 `/private/var/folders/ks/flqyrh0j5wvf2t7v4s7lcnz0b5tfzv/T/opencode/full-auto-memory-stage1.60cIhN/` 未被编辑；其四个脚本 before/after hash 全部一致。
- 旧/新 sha256：

| 文件 | 旧（original） | 新（candidate） |
|---|---|---|
| `stage1.py` | `d502bceae04c955ab90cf57585fee635e202121b786ef5d6a3b77fa3401fc881` | `58a0b148a0e9dd56f2fc283ef56738c7aa2f7e6e9506e1f51278e880edeaf19e` |
| `docker_client.py` | `4db7a0fdec692f462920c277f020ea3469f3650ef5d01123a1cc5c871df765c6` | 同左（未改） |
| `selfcheck.js` | `38602dbfba9c8467c27daa804f0d1ef541ba602067fecb69e3c75027938d68e7` | `52026dde328423475e8669d812b4e072f85a7ac93333658d82c6f6ff2a3fb84a` |
| `selftest_guard.py` | `b79c5668d82f83a4f008a4bb4e68fa92ebfb8d150c8021c137fae573c4cb2911` | 同左（未改） |

- 本轮 diff：`only-this-round.diff`（sha256 `8bb944b24f35cad84cf9b62845c9e63d2b310d3ff8ebd910eca11507586e0682`）。
  - `stage1.py` +128/−11；`selfcheck.js` +40/−0；`docker_client.py` 0/0；`selftest_guard.py` 0/0。
- AST 证据：`is_empty` 与 `build_payloads` 的 AST 完全一致（`selftest-output/ast-proof.json`）。
- 未改 create payload/HostConfig/资源/权限/镜像；diff 中的 `HostConfig` 字样仅来自只读 snapshot 字段列表，不是配置修改。

## 3. 修改（仅三处）

1. **专用 predicate**：新增 `networks_none_ok()`，只把 `None`/`{}` 或“仅 `none` 键且无非空 IPv4/IPv6/Gateway/MAC、prefix 0”视为通过；`NetworkID`/`EndpointID` 允许 opaque。仅替换 `verify_isolation` 中那一行 Networks 断言；全局 `is_empty` 逐字/AST 未变。
2. **过滤 snapshot**：新增 `filter_container_inspect()`；`send_record(..., snapshot=True)` 对 200 inspect 只落 ID/name/两个自有 label/status/关键 HostConfig/Mounts/NetworkSettings，不含 `Config.Env`、额外 Labels、镜像元数据；非 200 不落 body。`03/05/09/11/02b` 均走 snapshot；`09-cleanup-inspect` 删除前留下可独立核的 owner3 证据。
3. **selfcheck 网络证据**：新增 `/proc/net/dev` 与 `/proc/net/route` 解析；断言仅 `lo`、无 default route；原回环与 `192.0.2.1:9` 拒绝逻辑保留。只做 JS 语法/parser fixture，未执行 Linux selfcheck。

## 4. 验证命令与结果（全部 env -i，离线）

| # | 命令 | 原始结果 | exit |
|---|---|---|---|
| 1 | `python3 selftest_metadata_red.py` | `RED_CONFIRMED ... Networks empty` | 0 |
| 2 | `python3 -m py_compile stage1.py stage1_before.py docker_client.py selftest_guard.py selftest_metadata.py selftest_filter.py selftest_metadata_red.py` | 无输出 | 0 |
| 3 | `python3 selftest_metadata.py` | `SUMMARY total=39 pass=39 fail=0` | 0 |
| 4 | `python3 selftest_filter.py` | `SUMMARY total=13 pass=13 fail=0` | 0 |
| 5 | `python3 selftest_guard.py`（旧 44） | `SUMMARY total=44 pass=44 fail=0` | 0 |
| 6 | `node --check selfcheck.js` | 无输出（Node v22.22.3） | 0 |
| 7 | `node selftest_selfcheck_parsers.js` | `PASS parser fixtures...` | 0 |

- 旧 44 guard 的 socket 项仅 `os.stat` metadata，无 connect；所有 metadata/filter 单测均不调用 transport，filter 单测显式 mock `client.send`。
- 测试 harness 自身修正 2 次（RED 脚本 `build_payloads` 三返回值 unpack；Node vm 跨 realm 数组断言），均 test-only；生产断言无失败，未超过 3 次。

## 5. Metadata 正负例

- GREEN：真实 none fixture 37/37 pass；`None`、`{}`、`{"none":{}}`、全空 none、start 后 opaque `NetworkID`/`EndpointID` 均通过。
- Helper 负例：list/string、bridge、host、none+bridge、none 带 IPv4/IPv6/Gateway/IPv6Gateway/MAC、IPv4/IPv6 prefix 非 0、`none:null`、`none:[]`、opaque ID 类型错误均拒绝。
- 全 validator 负例：`NetworkMode=bridge`、Networks bridge/host/双网络/none 带 IP、Ports/PortBindings 非空、`PublishAllPorts=true`、Binds 非空、Mounts bind/两个 tmpfs、HostConfig.Mounts 非空、CapAdd 非空、Privileged、ReadonlyRootfs、CapDrop 均失败。
- 合法 spike tmpfs（`Mounts=[{Type:tmpfs,Destination:/spike}]`）37/37 pass。

## 6. 过滤审计证据

- fixture 注入 `SECRET_TOKEN=SECRET_VALUE` 与额外 label `image.secret.label=SECRET_LABEL_VALUE`；过滤后的对象与落盘文件均不含两者，`Labels` 精确只有两个自有键。
- snapshot 保留 ID/name/status/关键 HostConfig/Mounts/Networks；`09-cleanup-inspect` 的 snapshot 可独立核对 ID/name/两个 label/status，满足删除前 owner3 证据。
- 非 200 snapshot 只记 `body_note`，不落 body。首次失败目录的 raw logs 未改（mtime 仍 15:18）。

## 7. 边界与下一步

- 能证：离线 RED/GREEN、predicate 正负例、过滤落盘、旧 44 guard 回归、JS 语法/parser fixture。
- 不能证：容器实际 start/exec、`/proc/net/dev`/`/proc/net/route` 真实值、回环、TESTNET 拒绝；这些仍 **not-run**。
- 首次 attempt 仍是 **BLOCKED**，不得改记 PASS；本轮未消费新容器授权，未创建任何容器。
- 下一步：交同一独立 reviewer 核查本报告/candidate/diff/tests；review 通过后由主代理派**唯一一次**同配置新容器 Stage1。Stage2/host/model/下载仍不启动。
