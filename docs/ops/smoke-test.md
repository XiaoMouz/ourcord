# OurCord 单机双 daemon smoke 测试

> 当前脚本验证 daemon connect 管线对真实 kernel TUN + WireGuard 的端到端表现；它不是 Phase 1 关闭验收。
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
- **DERP fallback 不会被走**。per-peer ICE 仍未启用；这是 Phase 1 关闭前必须补齐的能力。
- **真实 OAuth 不验**。mock control plane 不签 JWT，daemon 也只是把字符串当 bearer 透传。真的 JWT 校验由 control 的 vitest 套件覆盖。

---

## OrbStack 双 VM 跨主机互通验证（当前手工 smoke）

这是当前"两节点组网互通"手工 smoke。Phase 1 关闭验收必须移除手工 endpoint 注入。

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
