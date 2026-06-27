# OurCord smoke 测试

> 当前脚本验证 daemon connect 管线对真实 kernel TUN + WireGuard 的端到端表现；它不是完整 Phase 1 关闭验收。
> 离线版（mock-control + fake TUN）见 `daemon/cmd/ourcordd/connect_test.go`。

## 前置

- Linux **或** macOS（Windows 暂不支持，TUN 地址装配在 `addr_other.go` 直接报错）
- `sudo` 权限（创 TUN 必须）
- Go ≥ 1.22（需能 `go build`）
- Python 3（mock control plane 用，无外部依赖）

## 跑一遍

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

这条链路是当前 Phase 1 direct-connect 的主验收路径：真实 control
认证、room-scoped peer config、SignalDO、ICE probe 和 WireGuard 数据面均参与。

同日追加验证：

- 使用真实 service Worker API 创建 lobby、invite、u2 join、voice room。
- daemon 使用该 voice room 返回的 `vpn_namespace` 执行 `enter-network`，control 通过
  service 内部接口按 namespace 解析 room/lobby members。
- 两端最终 `network_id=<vpn_namespace>`、`path_summary=direct`、peer `path=direct`，
  并完成双向 VPN ping。
- 使用 `pair:<pkA>.<pkB>` 执行 1:1 private-call network，不经过 service room；
  control 的 pair-scoped PeerConfig 返回对端 peer，SignalDO pair route 返回 101，
  两端最终 direct 并完成双向 VPN ping。

仍未覆盖：

- Runtime 受限网络 fallback：当前已有单元测试覆盖 ICE failure 后回写
  `derp://` UAPI endpoint；`force-derp` 诊断路径已通过真实 relay 验证
  runtime 数据面；2026-06-27 又通过真实 OS route blackhole 验证了一个已
  validated direct peer 自动进入 degraded/DERP 并恢复 ping。仍建议补一次
  双端都先 direct 的完全对称 smoke。
- 真实受限网络下的 A-C 不可达自动发现：A-B-C 三 VM 数据面已经跑通，
  但本轮 A-C blocked edge 仍通过 `/api/peers/connectivity` 手工塑形。
- Windows Wintun。

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
Phase 1 关闭前还需要 runtime fallback smoke：先建立 direct，再人为破坏直连，
观察 daemon 是否自动切回 DERP。

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
把 degraded peer 拉回 pending。代码已修复为 `LastError` 非空时跳过新的
`markPeerICEReady`，并新增单测；完整对称 smoke 需要用包含该修复的新 binary 复跑。

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
- daemon 已能消费 `next_hop_public_key` 并生成 WireGuard `AllowedIPs`：
  next-hop peer 获得被转发 peer 的 `/32`/`/128`，间接 peer 自身不写 endpoint。

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
- 仍需把 startup DERP reachable edge 与真实 constrained-network unreachable
  edge 做成 daemon 自动上报；本次三 VM smoke 中 A-C blocked edge 是通过
  `/api/peers/connectivity` 手工塑形，用于验证控制层和数据面能力。

---

## OrbStack 双 VM 跨主机互通验证（legacy mock-control smoke）

这是历史上的"两节点组网互通"手工 smoke，仍可用于回归 TUN/WireGuard
基础管线，但它依赖 mock control 和手工 endpoint 注入，不再代表 direct
connect 的主验收路径。

### 跑一遍

```bash
# 1. 启 mock control（背景，监听 0.0.0.0:18642，VM 通过 host.orb.internal 访问）
mkdir -p ~/.cache/ourcord-debug
nohup python3 tests/e2e/mock_control.py \
  --bind 0.0.0.0 --port 18642 \
  --state ~/.cache/ourcord-debug/mock.json \
  > ~/.cache/ourcord-debug/mock.log 2>&1 &

# 2. 跑 OrbStack smoke（自动建两个 Ubuntu VM、推送二进制、ipc.key、起 daemon）
KEEP_VMS=1 bash tests/e2e/smoke_orbstack.sh
```

完成后两个 VM (ourcord-a / ourcord-b) 各跑一份 daemon，都已 `connect`。

### 手工验证跨 daemon ping

```bash
# 注入 B 的 endpoint 到 mock（A 拉 config 时学到 B 的真实 IP:port）
B_HOST=$(orb info ourcord-b | awk '/^[Ii][Pp][Vv]4/{print $2}')
A_HOST=$(orb info ourcord-a | awk '/^[Ii][Pp][Vv]4/{print $2}')
python3 -c "
import json; p='$HOME/.cache/ourcord-debug/mock.json'
d=json.load(open(p))
for k,v in d['peers'].items():
    if v['name']=='ourcord-b': v['endpoint']='$B_HOST:51820'
    if v['name']=='ourcord-a': v['endpoint']='$A_HOST:51820'
json.dump(d, open(p,'w'), indent=2)"

# 在 A/B 内打通到对端的 VPN /32 路由 — 现在 daemon 自动做（U6），手工命令仅作 fallback：
#   sudo ip route add 198.18.0.10/32 dev utun
#   sudo ip route add 198.18.0.11/32 dev utun

# 强制 B 重新拉 config（学到 A endpoint）
orb run -m ourcord-b sudo XDG_CONFIG_HOME=/home/xiaomouz/.config \
  /home/xiaomouz/ourcord-cli --socket /tmp/ourcord.sock disconnect
orb run -m ourcord-b sudo XDG_CONFIG_HOME=/home/xiaomouz/.config \
  /home/xiaomouz/ourcord-cli --socket /tmp/ourcord.sock connect

# 互 ping
orb run -m ourcord-a sudo ping -c 4 198.18.0.10   # ourcord-b
orb run -m ourcord-b sudo ping -c 4 198.18.0.11   # ourcord-a
```

预期：4 packets transmitted, 4 received, 0% packet loss。

### 已知坑

- **必须固定 wg 监听端口**：daemon 默认端口 0（ephemeral），重启后变化让 mock 注入的 endpoint 失效。
  `smoke_orbstack.sh` 已默认传 `--wg-listen-port 51820`。
- **ipc.key 路径**：daemon 与 CLI 都必须读 `XDG_CONFIG_HOME=/home/xiaomouz/.config`，否则 HMAC 失配 → 静默断连。
- **mock control 是 HTTP/1.0**：daemon 的 `control` HTTP body 必须是 `bytes.Reader`（非自定义 io.Reader），否则 net/http 走 chunked transfer-encoding，Python BaseHTTPServer 解析不了会挂死。本仓库已修复 (`daemon/pkg/control/client.go bytesReader`)。
- **IPC handshake 拖尾字节**：服务端 HMAC handshake 用 `json.Decoder` 时其 bufio 会预读到 client 紧随其后的第一个 IPC 请求；handleConn 必须用 `dec.Buffered()` 拼回 `io.MultiReader`，否则首条请求丢失、连接挂死。本仓库已修复 (`daemon/pkg/ipc/{auth,server}.go`)。
- **v6 暂不通**（已知，记入 follow-up）：默认 daemon 已自动 `route add fd<XX>::/48 dev utun`（U6），但 wg AllowedIPs 必须含对端 /128。当前由 control 下发的 ip6 已是 /128，理论应通；若不通见 `daemon/pkg/routing/table.go`。

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
