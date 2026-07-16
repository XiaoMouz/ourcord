# OurCord smoke 测试

> Phase 1 已按当前验收口径闭环。下面的 OrbStack real
> control/service/relay/daemon smoke 是阶段一回归证据与复验入口；单机脚本和
> mock-control 流程只作为 daemon connect 管线的快速回归。
> 离线版（mock-control + fake TUN）见 `daemon/cmd/ourcordd/connect_test.go`。

## 前置

- Linux **或** macOS（本地 smoke 脚本用）。Windows 地址/路由装配已由
  `daemon/pkg/tun/addr_windows.go`（winipcfg）支持，真机行为由 CI 的
  `windows-native` job 用真 Wintun 适配器验收——本地脚本仍只跑 Linux/macOS。
- `sudo` 权限（创 TUN 必须）
- Go ≥ 1.26.1（与各 Go module 的 `go` directive 一致）
- Python 3（mock control plane 用，无外部依赖）

## 本地 legacy smoke

```bash
cd /path/to/ourcord
bash tests/e2e/smoke_two_node.sh
```

脚本会自动：

1. 构建 `ourcordd` + `ourcord-cli` 到临时目录
2. 起一个监听 `127.0.0.1:18642` 的 mock control plane（Python，约 100 行，无外部依赖）
3. 起两个 daemon (`A`/`B`)，各自独立 state dir / IPC socket / `XDG_CONFIG_HOME`
4. 对两个 daemon 各 `ourcord-cli connect`
5. 检查 `status` 显示 `vpnActive=true`
6. 用 `ip addr` (Linux) / `ifconfig` (macOS) 验 TUN 上确实有 `198.18.0.x` + `fd<XX>:<XXXX>:<XXXX>::x` 地址（v4 = RFC2544 基准段；v6 = 部署级随机 ULA /48，由 control 在首次注册时生成并存 KV）

## 通过标准

- `==> ALL CHECKS PASSED.` 出现
- 两个 daemon 都报告 `vpnActive=true`
- 两个 utun（或 ourcord*) 接口上能看到 mock 分配的 v4/v6 前缀

## 已知限制（**这个脚本不验证**）

- ~~**跨 daemon 互 ping 不会通**~~ — 已通过 OrbStack 双 VM 验证（见下文）。
  单机版脚本仍只测同主机管线对错；跨 daemon 真实组网用 OrbStack 双 VM。
- **单机脚本不会走 DERP fallback**。真实 DERP 数据面已通过 OrbStack 双 VM
  + real relay 验证（见下文）；单机脚本仍只覆盖 connect/TUN/WG 管线。
- **真实 OAuth 不验**。mock control plane 不签 JWT，daemon 也只是把字符串当 bearer 透传。真的 JWT 校验由 control 的 vitest 套件覆盖。

---

## OrbStack 双 VM + 真实 control ICE 验证（当前 direct smoke）

2026-06-26 已验证：

- control Worker 跑在 `ourcord-test` VM，使用本地 D1 + 最小 service mock 返回同一 room 的成员列表。
- 两个 daemon 分别跑在 `ourcord-test` 与 `ourcord-peer2`。
- daemon 不传 `--wg-endpoint`，只执行 `connect` 后 `enter-room room1`。
- control 路径正常返回：
  - `POST /api/peers/register` → `201`
  - `GET /api/peers/config?room_id=room1` → `200`
  - `GET /api/signal/room1` → `101 Switching Protocols`
- daemon 日志出现 `ice connected`、`ice probe validated`、`peer upgraded to ICE direct`。
- 最终 status 显示 `path_summary=direct`，peer `path=direct`，endpoint 为 `ice`，DERP 计数为 0。
- `198.18.0.2` ↔ `198.18.0.3` 双向 ping 成功，并完成 TCP payload 传输。

这条链路是 Phase 1 direct-connect 的关键回归路径：真实 control 认证、
room-scoped peer config、SignalDO、ICE probe 和 WireGuard 数据面均参与。

同日追加验证：

- 使用真实 service Worker API 创建 lobby、invite、u2 join、voice room。
- daemon 使用该 voice room 返回的 `vpn_namespace` 执行 `enter-network`，control 通过
  service 内部接口按 namespace 解析 room/lobby members。
- 两端最终 `network_id=<vpn_namespace>`、`path_summary=direct`、peer `path=direct`，
  并完成双向 VPN ping。
- 使用 `pair:<pkA>.<pkB>` 执行 1:1 private-call network，不经过 service room；
  control 的 pair-scoped PeerConfig 返回对端 peer，SignalDO pair route 返回 101，
  两端最终 direct 并完成双向 VPN ping。

当前 direct smoke 未覆盖：

- Runtime 受限网络 fallback 已由后续“OrbStack 对称 runtime impairment
  smoke（当前新 binary）”覆盖。
- 真实受限网络下的 A-C 自动拓扑已由后续“三 netns A-B-C smoke”覆盖；
  三独立 VM 仍可作为环境复核，但不再是唯一可重复验收入口。
- Windows Wintun 由 CI `windows-native` job 单独验收（真 Wintun 适配器
  地址装配 + `/32` 路由往返），不在本 Linux/macOS smoke 覆盖内。

---

## OrbStack 双 VM + 真实 DERP startup fallback 验证

2026-06-26 已验证：

- control Worker、service Worker、DERP relay 均为真实进程，relay 通过
  control 注册并出现在 `/api/relay/map`。
- 两个 daemon 分别跑在 `ourcord-test` 与 `ourcord-peer2`，使用同一个真实
  service voice room 的 `vpn_namespace`。
- daemon 以 `--disable-ice` 启动，诊断性关闭 SignalDO/ICE，模拟“启动时
  direct 不可用，只能 DERP”的受限网络。
- 两端执行 `connect` 后 `enter-network
  lobby-2f358f96148ab1250491392d195f0520-77adb192142841377238400b73f9a1ff-voice`。
- status 显示：
  - A: `ip4=198.18.0.2`，`path_summary=derp`，`relay_used=true`，
    `relay_url=http://198.19.249.170:3340/derp`
  - B: `ip4=198.18.0.3`，`path_summary=derp`，`relay_used=true`，
    `relay_url=http://198.19.249.170:3340/derp`
  - 两端 DERP send/recv 计数增长，ICE send/recv/probe 计数均为 0。
- 双向数据面：
  - `ourcord-test` → `198.18.0.3`: 3/3 received, 0% packet loss
  - `ourcord-peer2` → `198.18.0.2`: 3/3 received, 0% packet loss

这个 smoke 覆盖的是 startup fallback：没有 ICE 信令参与时，daemon 从
control 返回的 relay map 自动选择 `derp://` endpoint，WireGuard 数据面可用。
Runtime fallback 已由后续“OrbStack 对称 runtime impairment smoke（当前新
binary）”覆盖。

---

## OrbStack 双 VM + runtime DERP fallback 诊断验证

2026-06-26 已验证：

- control/service/relay/daemon 均为真实进程，两个 daemon 进入同一个 service
  voice `vpn_namespace`。
- A 侧到达 `path_summary=direct`，B 侧在 ICE data-plane validation 失败后进入
  `path_summary=degraded` / DERP。随后在 A 侧执行：

```bash
ourcord-cli --socket /tmp/ourcord-derp-a.sock \
  force-derp YcUBum7E70U1TOFzlvuLJpUcTCcf39nEGfKaiaYsXDs= \
  diagnostic-runtime-fallback
```

- force 后两端 status 均显示：
  - `path_summary=degraded`
  - `relay_used=true`
  - `relay_url=http://198.19.249.170:3340/derp`
- 双向数据面：
  - `ourcord-test` → `198.18.0.3`: 3/3 received, 0% packet loss
  - `ourcord-peer2` → `198.18.0.2`: 3/3 received, 0% packet loss

`force-derp` 是诊断入口，用来在缺少 iptables/nft/pf 的测试环境里触发 daemon
运行时 fallback 代码路径；它不会替代真实网络阻断 smoke。

---

## OrbStack 双 VM + runtime 外部阻断 fallback 验证

2026-06-27 已验证：

- control Worker、service Worker、DERP relay、两个 daemon 均为真实进程。
- service 产品流完整执行：u1 创建 lobby、invite，u2 join，u1 创建 voice room，
  两个 daemon 进入返回的 `vpn_namespace`。
- B 侧 peer 先达到 `path_summary=direct` / peer `path=direct`，ICE probe 和
  WireGuard data-plane validation 均成功。
- 在 B 侧添加只影响 A underlay IPv6 的路由黑洞：

```bash
ip -6 route add blackhole fd07:b51a:cc66:0:2030:a7ff:fe2e:ab06/128
```

- 从 B ping A 的 VPN IP `198.18.0.3`，前 3 个包丢失，随后 5 个包恢复：
  `8 transmitted, 5 received, 37.5% packet loss`。恢复后的 status 显示
  `path_summary=degraded`、`relay_used=true`、peer `last_error=direct-health-degraded`。
- daemon 日志显示：
  - `peer upgraded to ICE direct`
  - `peer ICE validation failed; fallback state applied: ... reason=direct-health-degraded`
- control D1 `peer_connectivity` 中对应 namespace 有
  `transport='derp'`、`wg_reachable=1`、`reason='derp-fallback:...'`。

本次 smoke 同时暴露了一个抖动：fallback 后新的 SignalDO ICE ready 事件会再次
把 degraded peer 拉回 pending。当前实现已改为 sustained probe + 指数退避重试；
完整对称 smoke 需要用包含该实现的新 binary 复跑。

---

## OrbStack 双 VM + ICE 直连稳定性重构验证

2026-06-28 已实现并验证（真实 control + relay + 双 daemon，pair 网络）：

- 直连不再依赖应用层流量保活。ICE manager 改为两阶段 probe：切换 WireGuard
  endpoint 前必须先持续探测确认可靠（≥8 acks/≥3s、≥60% 到达率），之后每
  250ms 持续 keepalive；连续静默 >1.5s 才降级。空闲直连（无任何业务流量）
  稳定保持 >70s、0 次降级（旧实现 ~12s 内必降级、单次抖动即 flap）。
- 降级后自动指数退避重升：10s→10min（×2），新 peer 加入重置回基准。
  `force-derp` 触发降级后，daemon 自动经退避重连并重新升级 direct 且稳定保持。
  这取代了此前"`LastError` 非空跳过 `markPeerICEReady`"的抖动缓解（已不再需要）。
- ICE 候选过滤：排除自身 `utun*`/`ourcord*` 覆盖接口，避免重升时配对到 VPN
  overlay 地址造成 WireGuard 经隧道自环（会过探测但随后 flap）；现仅配对
  underlay（eth0 的 198.19.249.x / fd07 ULA）。
- pair 连通上报修复：`POST /api/peers/connectivity` 现接受 `pair:` network_id
  （按成员鉴权），不再每 ~30s 刷 `400 invalid network_id`；control D1
  `peer_connectivity` 正确记录该 pair 的两条 `ice` 有向边。
- next-hop 后直达恢复探测：daemon 对当前 `NextHop` 间接 peer 仍会启动后台 ICE
  探测；探测通过 `markPeerICEReady` 后会清除 `NextHop`，重新给该 peer 分配自身
  `AllowedIPs` 并切到 `ice://` endpoint，随后向 control 上报 direct 恢复。

---

## OrbStack 对称 runtime impairment smoke（当前新 binary）

2026-06-28 复跑通过（真实 service + control + relay + 双 daemon）：

- 业务入口使用 service 创建 lobby、邀请第二用户、创建 voice room，并让两个 daemon
  进入同一个 `vpn_namespace`：
  `lobby-42291a68cab4d1d5cdbfeae1a155d7cc-3681053568a0ac25be70e59a0375f074-voice`。
- 初始两端 status 均为 `path_summary=direct`、`relay_used=false`，peer endpoint
  为 `ice`；control `peer_connectivity` 记录两条 `transport='ice'`、
  `ice_direct=1`、`wg_reachable=1` 的有向边。
- 单纯 blackhole 对端 IPv4/ULA 不足以构造对称阻断：ICE 会继续找到 IPv6
  link-local 或 NAT 映射候选并恢复 direct。这是预期的直连恢复能力，不应算失败。
- 稳定压到 DERP 的 impairment 使用 `tc clsact` 在两个客户端 VM 的 `eth0 egress`
  drop UDP。DERP/control/service 走 TCP，因此仍可用：
  `sudo tc qdisc replace dev eth0 clsact`
  `sudo tc filter replace dev eth0 egress protocol ip pref 1 flower ip_proto udp action drop`
  `sudo tc filter replace dev eth0 egress protocol ipv6 pref 2 flower ip_proto udp action drop`
- 双向 UDP drop 后，两端在约 1.5s liveness 静默后记录
  `peer ICE validation failed; fallback state applied: ... reason=direct-health-lost`，
  status 均为 `path_summary=degraded`、`relay_used=true`，双向 VPN ping 仍
  `6 transmitted, 6 received, 0% packet loss`。
- 失败 ICE retry 不再固定 10s 刷屏。观测到 A 侧 retry 约为
  `20:01:29 -> 20:01:49 -> 20:02:34 -> 20:03:54`，B 侧约为
  `20:01:30 -> 20:01:55 -> 20:02:40 -> 20:04:05`，即后续 retry 逐步拉开。
- 移除 impairment：
  `sudo tc qdisc del dev eth0 clsact`
  清掉残留 blackhole route 后，两端自动恢复 `path_summary=direct`、
  `relay_used=false`；control D1 最终仍记录两条 `transport='ice'`、
  `ice_direct=1`、`wg_reachable=1`。

验证矩阵：daemon `go test -race ./...` 全过；control vitest 127 过；service
vitest 68 过；relay `go test ./...`、daemon/relay `go vet ./...` 全过。

---

## Control topology / A-B-C contract

2026-06-26 已实现并单测：

- 新增 control D1 migration `0003_peer_connectivity.sql`。
- daemon 在 ICE direct 验证成功后向 control 上报
  `POST /api/peers/connectivity { network_id, peer_public_key, ice_direct: true, wg_reachable: true }`。
- daemon fallback 到 DERP 时上报 `ice_direct: false`；如果 DERP endpoint 仍可用，
  保持 `wg_reachable: true`，并使用 `derp-fallback:<reason>` 作为 report reason。
- control 的 `GET /api/peers/config?room_id=<vpn_namespace>` 读取最近 reachable edge
  并按成本选路：ICE direct 成本最低，未知/user WG relay 居中，DERP baseline
  最高。只有经 B 的 A-B-C 成本低于 A-C 直达边，或 A-C 无 reachable edge 时，
  才在 C 的 peer record 上返回 `next_hop_public_key=B`。
- `peer_connectivity` 是有向图：一次 daemon 上报只写入 `self → peer`，绝不镜像
  成 `peer → self`。因此 NAT、防火墙或 relay 导致的单向不可达会被原样保留；
  A 经 B 到 C 的选择只要求 `A→B` 与 `B→C` 两条必需方向都可达。
- daemon 已能消费 `next_hop_public_key` 并生成 WireGuard `AllowedIPs`：
  next-hop peer 获得被转发 peer 的 `/32`/`/128`，间接 peer 自身不写 endpoint。
- daemon 的 reachability monitor 已有单测覆盖：DERP-baseline peer 长时间无
  handshake/rx 进展时自动上报 `wg_reachable=false, reason='unreachable'`；
  恢复后上报 `transport='derp', wg_reachable=true, reason='derp-recovery'`；
  已判死的 peer 不会被周期性 `derp-baseline` 报告覆盖回 true。
- control 已补防抖：当前 edge 为 `reason='unreachable'` 时，普通周期性
  `derp-baseline` 不会覆盖回 true；只有 ICE direct 或 daemon 明确上报
  `derp-recovery` 才能恢复该 edge。

## 可重复发布验收（direct / DERP / A-B-C / recovery）

`tests/e2e/smoke_abc_netns.sh` 是当前的完整网络发布验收。它在一个 Linux
VM 内创建三个 network namespace，使用真实 control/service Workers、DERP、
TUN、WireGuard 与 ICE，按顺序断言：

1. 三方初始 ICE direct 与 A→C 数据面；
2. 仅阻断 A↔C 的 underlay UDP 后，A/C 进入 runtime DERP fallback 且数据面仍通；
3. control 自动下发经 B 的 A-B-C 路由，A→C TTL 变为 63；
4. 解除阻断后 A/C 自动恢复 ICE direct，TTL 回到 64。

GitHub Actions 的 **Network release acceptance** workflow 可通过
`workflow_dispatch` 手动运行；它在干净 Linux runner 里安装 Worker 的 Linux
依赖、执行同一脚本，并保留 `.smoke-tmp/abc-netns` 日志与本地状态 14 天。
发布前必须成功运行该 workflow。

2026-07-11 本地 `ourcord-test` OrbStack VM 复验：exit code 0，四阶段 ping
均为 0% packet loss；DERP 阶段与恢复 direct 分别有 daemon fallback/ICE upgrade
日志，A-B-C 与恢复 ping 的 TTL 分别为 63 与 64。

2026-07-16 使用当前提交重新复验：exit code 0。三方先达到 ICE direct；A↔C UDP
阻断后 DERP 数据面保持 4/4 ping，随后 control 自动选择经 B 的 next-hop（TTL=63）；
三端 `voice join` 后 A/C 经 B 双向收包且 participant `secure=true`；解除阻断后 A↔C
恢复 direct（TTL=64）。脚本最终输出 `NETWORK ACCEPTANCE PASSED: direct, DERP,
A-B-C next-hop, voice-over-relay, recovery`。

2026-06-29 OrbStack 单 VM 三 netns smoke 通过：

- 新增可重复入口：`tests/e2e/smoke_abc_netns.sh`。脚本在 `ourcord-test`
  Linux VM 内创建 `ocabc-a/b/c` 三个 network namespace，使用 veth bridge
  模拟三台主机；control/service Workers、relay、三个 daemon 都是真进程，
  daemon 使用真实 TUN/WireGuard。
- 产品流完整执行：service 创建 lobby、invite、u2/u3 join、voice room，
  daemon 进入返回的 `vpn_namespace`：
  `lobby-a46238b85e42134af5ba24041ad980d0-e24bfadc2c436f8ad4ca2810057fad92-voice`
  （本次运行值）。
- 脚本只阻断 A<->C UDP underlay，保留 control/service/DERP TCP 和 A-B/B-C
  UDP；daemon 自动上报连通性，control 自动下发 `next_hop_public_key=B`。
- A/C status 均显示 `path_summary=next-hop`；A 的 C peer、C 的 A peer 均
  显示 `path=next-hop` 且 `next_hop` 为 B 的 WireGuard public key，B 保持
  `path_summary=direct`。
- A ping C 的 VPN IPv4 `198.18.0.4`：`4 transmitted, 4 received, 0% packet
  loss`，TTL=63，证明经 B 做内核转发。

2026-06-29 三独立 VM smoke 复跑通过（真实 service + control + relay + 三 daemon）：

- 环境：A=`ourcord-test`、B=`ourcord-peer3`、C=`ourcord-peer4`；control/service
  Workers 与 relay 跑在 C，三个 daemon 使用同一个 service voice `vpn_namespace`：
  `lobby-919767d055e0d0c07c7702c538e94954-c6d51f0b4f3074f77a7871d6c4a4764d-voice`。
- 为构造 A-B-C，只在 A 与 C 的 `eth0 egress` 阻断彼此 UDP underlay；由于 ICE
  仍能找到 NAT 公网候选，本轮额外阻断 A/C 到 `103.142.140.228` 的 UDP，A-B
  与 B-C 保持可达。
- daemon 自动上报 A-C `derp-fallback:direct-health-lost` 与 A-B/B-C 周期性
  `ice_direct=1` 直连边；control 不需要手工写 `/api/peers/connectivity`，
  自动下发 A->C、C->A 的 `next_hop_public_key=B`。
- A/C peer status 分别显示对端 `path=next-hop` 且 `next_hop` 为 B 的 WireGuard
  public key；B 到 A/C 保持 `path=direct`。
- 数据面通过：A->C `198.18.0.4` 与 C->A `198.18.0.3` 各 `5 transmitted,
  5 received, 0% packet loss`，TTL=63，证明经 B 转发。
- 本轮暴露并修复两个卡点：
  1. ICE direct edge 只在升级瞬间上报，超过 control 的 freshness window 后
     A-B/B-C 会变 stale，导致 next-hop 不再被选择；daemon 现每个 mesh poll
     刷新 `ice_direct=1,wg_reachable=1`。
  2. A-C 进入 next-hop 后 `Table.Replace` 会清掉 `LastError`，旧 retry state
     因 `retryDegradedICE` 只看 `LastError` 而不再触发；daemon 现把当前
     `NextHop` peer 也纳入恢复探测，并在缺少 retry state 时补一个到期 state。
- 解除 A-C 公网候选阻断后，A/C 在 `path=next-hop` 状态下自动发起 ICE retry，
  日志出现 `ice connected`、`ice probe validated`、`peer upgraded to ICE direct`；
  最终 control D1 记录 A-C/C-A `transport='ice', ice_direct=1, wg_reachable=1`，
  peer status 回到 `path=direct`，双向 ping `5/5 received` 且 TTL=64。
- 复测尾声观察：A-C 恢复 direct 后，B 相关边在该次重启窗口内暂时落到
  DERP baseline；这不影响 next-hop 恢复结论，但后续可继续降低 ICE startup
  duplicate/gather-timeout 噪音。

2026-06-26 三 VM smoke 进展：

- A、B、C 已进入同一个 service `vpn_namespace`。
- control 收到 A-B、B-C connectivity report 后，真实
  `GET /api/peers/config?room_id=<vpn_namespace>` 为 A→C 和 C→A 返回
  `next_hop_public_key=B`。
- daemon 重新 enter 后，A/C 本机 peer 状态显示 `path=next-hop`。
- B 侧 Linux IPv4 forwarding 已开启。
- 2026-06-27 复测通过：A-B、B-C 底边为 DERP-backed `wg_reachable`，
  A-C 被标记为不可达；A/C 重新 enter 后均显示 `path=next-hop` 且
  `next_hop_public_key=B`。
- A→C `198.18.0.6` 与 C→A `198.18.0.5` 双向 ICMP 均 4/4 received，
  0% packet loss，TTL=63，证明经 B 转发。
- B 侧 Linux `ip_forward=1`，`send_redirects=0`；daemon 已修复 indirect peer
  AllowedIPs 抢路由的问题，间接 peer 的 VPN IP 只挂到 next-hop peer 上。

设计结论：

- `peer_connectivity` 必须表达链路能力，而不是单一 direct 布尔值。
  `ice_direct=false,wg_reachable=true` 是 DERP/user-relay 底边可用的核心状态，
  但控制层不会再把所有 `wg_reachable` 边视为同等优先级。
- 单元测试已覆盖两个容易误判的拓扑：全员仅 DERP baseline 时不生成任意
  next-hop；A-C 仅 DERP 而 A-B/B-C 为 ICE 时优先下发 A-B-C。
- 三独立 OrbStack VM 曾作为环境复核项阻塞在 VM provisioning；2026-06-29
  已完成独立 VM 复核，三 netns smoke 保留为更快的回归入口。

---

## OrbStack 独立 VM 环境复核（真实 product flow）

2026-07-16 使用两台独立 Ubuntu VM（`ourcord-test` / `ourcord-peer3`）复核当前
binary。control、service、relay 跑在第一台 VM；两台 daemon 使用不同用户 JWT，
通过真实 service API 创建 lobby、invite、join、voice room，再进入同一个
`vpn_namespace`。结果：

- 两端先以 DERP baseline 建链，ICE host candidates 完成交换和 probe 后都自动切到
  `path_summary=direct`、`relay_used=false`；不是手工 endpoint 注入。
- VPN `198.18.0.2` → `198.18.0.3` 跨 VM ping 4/4，0% packet loss，TTL=64。
- 两端执行 `voice join` 后互相持续收包；status 均为 `codec=pcm`、
  `speaking=true`、`secure=true`、`loss_percent=0`。

同日 `ourcord-a` 完成 provisioning 后追加三独立 VM 复核。三个当前设备形成全
direct mesh，`198.18.0.4/.5/.6` 六个有向 ping 组合均为 3/3、0% loss、TTL=64；
三端 voice status 对另外两个当前设备都显示持续收包、`speaking=true`、
`secure=true`、`loss_percent=0`。复用的本地 D1 仍保留上一轮 u1/u2 设备，因此
peer list 还包含两个离线旧设备并让汇总 path 显示 DERP；当前三设备的逐 peer path
均为 direct。验收脚本应像 `smoke_abc_netns.sh` 一样每次清空 persist state，或使用
全新用户/显式 revoke 旧设备，不能用“peer 总数恰好等于成员数”作为多设备断言。

历史 `tests/e2e/smoke_orbstack.sh` 依赖 mock-control 原始 WG endpoint hint，已删除：
当前 daemon 有意只把此类 hint 当 ICE candidate，未经 ICE data-plane validation
不会直接写入 WireGuard endpoint。继续保留旧脚本会得到 `no known endpoint`，并且会
鼓励绕过当前安全/连通性契约。日常自动回归使用 `smoke_abc_netns.sh`；独立 VM 只作
环境复核。

本次创建新 VM 时，OrbStack 1.11.1 能启动 Ubuntu 到登录提示，但新实例长期停在
`provisioning`（已有两个旧实例也处于同样状态）。因此复核复用了两台 `running`
实例；这是 OrbStack provisioning 状态问题，不是 OurCord TUN/daemon 失败。遇到同样
情况先看 `orbctl info <vm>` / `orbctl logs <vm>`，不要把 provisioning 实例纳入验收。

### 与 Tailscale 共存测试

OurCord 自 U 系列起 v4 改 `198.18.0.0/15`、v6 改部署级随机 ULA `/48`，与
Tailscale 默认池（v4 `100.64.0.0/10` + v6 `fd7a:115c:a1e0::/48`）完全无交集。

验收方法（macOS 上同时装两者）：

```bash
# Tailscale 上线（如已登）
sudo tailscale up

# OurCord 上线
sudo /usr/local/bin/ourcordd --wg-listen-port 51820 &
ourcord-cli connect

# 预期：两条接口共存
ifconfig | grep -E "utun|tailscale" -A1
# utun7  inet 100.64.x.y    (Tailscale)
# utun8  inet 198.18.0.10   (OurCord)

# Tailscale 节点照常可达，OurCord 节点照常可达，互不影响
ping -c 1 100.64.x.y    # Tailscale peer
ping -c 1 198.18.0.11   # OurCord peer
```

如启动 daemon 时 stderr 出现 `WARN: VPN pool 198.18.0.0/15 may conflict with existing route: …`
说明本机已有 198.18 段使用者（极罕见，通常是测试桩或刻意配置）；Phase-1 不自动切段，可手动停掉冲突源。

### 清理

```bash
# 杀 mock
/bin/kill $(lsof -ti :18642)
# 删 VMs
orb delete -f ourcord-a ourcord-b
rm -rf ~/.cache/ourcord-debug
```

## 排查

- **TUN 创不出来**：检查 `sudo` 是否真给了，Linux 上 `/dev/net/tun` 是否存在
- **IPC 拒绝**：daemon 和 cli 的 `XDG_CONFIG_HOME` 必须一致（共享 `ipc.key`）。脚本用同一个 dir 已经处理
- **mock control 端口冲突**：`MOCK_PORT=18999 bash tests/e2e/smoke_two_node.sh`
- **看日志**：脚本最后一行打印的 `Logs: …/{a,b}.log` 是两个 daemon 的 stdout/stderr
