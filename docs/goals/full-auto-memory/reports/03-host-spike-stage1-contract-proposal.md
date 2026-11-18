# 03 host-spike Stage1 网络语义契约（proposal）

Date: 2026-11-12 · Status: **PROPOSAL（提案）/ NOT IMPLEMENTED（未实施）/ NOT RUN（未运行）** · Owner: 本 session（本短文档固定 owner；后续修订与 cleanup 同 session）
Scope: 仅 Stage1 网络收口判据；不扩资料采集/隐私/产品功能，不改代码/判据/容器。cleanup 另章待补。

## 1. 结论与证据边界（observed）
- 两次 Stage1 均 **BLOCKED**，保持 BLOCKED；首次 Networks-empty 是 §13 已证的未计划额外 oracle 误判，不是合同内失败；retry“仅 lo”才是批准 literal 的合同内失败；两者都不回溯改 PASS。
- retry 运行时证据只有 `/proc/net/dev` 的 10 个名字：`lo` + 9 个内核隧道伪接口（`tunl0,gre0,gretap0,erspan0,ip_vti0,ip6_vti0,sit0,ip6tnl0,ip6gre0`）；flags、operstate、地址、路由**均未采集**。
- 仅有名字不能证明可外联，也不能证明安全；本 proposal 不声称当前容器已安全/已联外。
- Docker `NetworkMode=none` 配置合规只是必要结构条件，**不是绝对 OS 隔离证明**；macHost/P01 最终门不因本文关闭。

## 2. 保留的硬边界（结构 metadata，不放宽）
- 固定镜像 digest；`HostConfig.NetworkMode=none`；`PortBindings={}`、`PublishAllPorts=false`、无 Binds/bind mount（仅固定 `/spike` tmpfs）。
- `Privileged=false`、`CapDrop=["ALL"]`、`CapAdd=[]`、`no-new-privileges`、非 host 的 pid/ipc/cgroupns、`User=10001`；任一不满足直接 fail。
- 这些只证明“配置如此”，不替代运行时证据，也不能单独推出“无外路”。

## 3. 运行时被动证据（先完整采集，后评判）
- **有界/被动/固定顺序**（容器自身 netns）：只读 `/proc`、`/sys`、地址/路由/规则 dump；不发包、不 DNS、不建外部 socket；单文件/总时长/每类 dump 次数设固定上限（建议 256 KiB/2 s、至多 1 次），超限记 `unknown`。
- **不 fail-fast**：一次采完再判定；单维度读取/解析失败记 `unknown` 并继续，避免重演“接口名先失败导致路由/回环全未采”。
- **接口集**：`/proc/net/dev` 与 `/sys/class/net/` 必须一致；不一致 → `unknown`。
- **每个接口**：读 `/sys/class/net/<i>/flags`（至少 `IFF_UP=0x1`、`IFF_LOOPBACK=0x8`）、`operstate`、全部 IPv4/IPv6 地址（含 link-local）、所有路由表中以它为 `dev` 的记录。
- **路由完整性（新增提议前提，不是现有能力）**：`PASS_PASSIVE` 需在固定上限内完整枚举全部路由表与规则（`ip -j route show table all` + `ip -j rule`，或等价 netlink dump）；仅有 `/proc/net/route`、`/proc/net/ipv6_route` 时只覆盖 main 表，规则/其他表记 `unknown`。无可用 `ip`/netlink dump、超上限、来源矛盾或缺字段 → `UNKNOWN`/材料能力缺口；不默认新增依赖，也不在本 proposal 实现大型 netlink 栈。
- **loopback 只按 `IFF_LOOPBACK` 判定，不按名字**；带该 flag 者一律 loopback，其余一律非 loopback，重命名不改变判定；`lo` 无白名单地位；地址 IPv6 可用 `/proc/net/if_inet6`，IPv4 用 netlink/`ip` 或交叉校验的 `/proc/net/fib_trie`；地址来源矛盾 → `unknown`。

## 4. 判定规则（可证伪）
1. **loopback（带 `IFF_LOOPBACK`，不论名字）**：允许且仅允许 `127.0.0.0/8` 与 `::1/128`；其他地址 → `unknown`（异常，需人审）。
2. **非 loopback（无 `IFF_LOOPBACK`）可接受**，当且仅当：admin `IFF_UP` 未置位；`operstate` 可读且为 `down`/`notpresent`/`unknown`；无任何 IPv4/IPv6 地址（link-local 也算）；无任何以它为 `dev` 的潜在 egress 路由（见 4）。
3. **非 loopback 有地址**（残留/link-local）或 **`IFF_UP` 置位** → `BLOCKED`，不论 operstate。
4. **路由分类**：`unreachable`/`prohibit`/`blackhole` 是终止型 reject/丢弃，不产生 egress，记录但不据此失败；`throw` 不是终止型，会让策略 lookup 继续到后续规则/表，必须结合完整规则与后续表解析，其后若有非 loopback 的转发路由 → `BLOCKED`，无法判定 → `UNKNOWN`；`local` 是本地记录，不算 egress；`broadcast` 仅在 `dev` 为 loopback 时不算 egress；其余任何带非 loopback `dev` 的路由（unicast/default/scope link/multicast 等，不论 UP）→ 潜在 egress → `BLOCKED`。`unreachable default` 不得当成“有 default 就失败”。
5. **禁止“字段非空即失败”**：`IFF_NOARP`/`POINTOPOINT`、空 `carrier`、隧道 MTU 等正常属性不构成失败，也不构成放行；`unicast`/`local` 的 `via` 与 `dev` 不匹配或 `dev` 缺失 → `unknown`；终止型 reject 无 `dev` 属正常，`throw` 按 4 结合规则解析。
6. **判定顺序**：任一正向 blocker → `BLOCKED`；否则任一必需维度不完整或 4.2 无法满足 → `UNKNOWN`；全部完整且无 blocker → `PASS_PASSIVE`。
7. `PASS_PASSIVE` 只表示“在完整采样范围内未发现可用的对外路径”，**不是绝对证明/Stage1 通过**，不等于安全/已隔离，也不覆盖采样后漂移。**当前不执行任何采集**。

## 5. 证据分层
- 结构 metadata（prestart inspect：NetworkMode/ports/binds/caps）→ 只证明配置符合，不证明运行时无外路；运行时被动（flags/operstate/地址/路由）→ 证明采样时刻 namespace 状态，不证明漂移/宿主行为；未知 host 门（Docker/kernel/macOS host、镜像、模块自动加载）→ 仍 open。

## 6. 正负例（agent-assisted / design 推演，not-run）
| # | 场景 | 期望 | 理由 |
|---|---|---|---|
| P1 | 非 loopback 全 DOWN、无地址、无路由；loopback=127.0.0.1/8+::1 | PASS_PASSIVE | 满足 4.2；名字不参与 |
| P2 | 同 P1，另有 `unreachable/prohibit/blackhole default` | PASS_PASSIVE | 终止型 reject/丢弃 非 egress，不误杀 |
| N1 | 非 loopback `IFF_UP`（有/无地址） | BLOCKED | 4.3，UP 即不可接受 |
| N2 | 非 loopback DOWN，但残留 `172.17.0.2/16` | BLOCKED | 地址残留，4.3 |
| N3 | 非 loopback DOWN 无地址，但有 `default via … dev <非 loopback>`（或 `throw` 后接该 default） | BLOCKED | 已配置潜在 egress，4.4 |
| N4 | `tunl0` UP、无地址、无路由 | BLOCKED | 不以名字放行 |
| U1 | 缺 flags/operstate，或全表/规则无法完整枚举/iface 集不一致 | UNKNOWN | 4.6，不补写 PASS |
| U2 | `throw` 后续表无法解析，或 loopback 出现非 127/8/::1 地址 | UNKNOWN | 4.4/4.1，需人审 |

任意名字（含未来 `eth9`）DOWN+无地址+无路由均按 P1；带 `IFF_LOOPBACK` 者按 loopback 规则；规则无 allow/deny 名单，不为 9 个已见名字放行。
反例（规则失效）：非 loopback UP/有地址/有非 loopback 转发路由仍 PASS；`unreachable default` 被判失败；`throw` 未结合后续表却放行；换名改变结论。

## 7. 只在 PASS_PASSIVE 后才允许的未来探针（当前 not-run）
- 回环：容器内 `127.0.0.1:<临时端口>` 自测成功；只证 loopback 可用，不是外联证明。
- 拒绝探针：`192.0.2.1:9` 1 s 内 `ENETUNREACH`/`EHOSTUNREACH`/`EPERM` 可接受；**超时不算通过**，`ECONNREFUSED` 视为异常。均需另行授权，本文不执行。

## 8. 清理时限章节（待补）

> 占位：cleanup 契约（服务端宽限+客户端余量、timeout 后只读状态核对、不 force、404 收口）待同 session 追加；不影响上文网络判据。

## 9. 边界声明

- 本文为 **PROPOSAL**：未改 `stage1.py`/`selfcheck.js`/任何 parser/判据，未连 Docker/socket，未建/停/删容器，未跑 Stage1/Stage2/host/model/下载。
- 原两次失败证据与 BLOCKED 状态不变；方案通过也不等于 Stage1 已过，最终交原独立 reviewer。
