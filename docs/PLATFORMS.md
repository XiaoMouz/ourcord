# PLATFORMS — daemon 各 OS 部署 / 权限指南 (AA3 / V12)

> 配套文档：根 [`README.md`](../README.md)、[`SECURITY.md`](../SECURITY.md)、[`daemon/AGENTS.md`](../daemon/AGENTS.md)。
> 本文聚焦「在每个 OS 上把 `ourcordd` 真正跑起来」需要的权限、命令、防火墙规则。

## 1. Overview

`ourcordd` 的核心动作是：

1. 创建 TUN 设备（`golang.zx2c4.com/wireguard/tun.CreateTUN`，`MTU=1280`，见 `daemon/pkg/tun/tun.go`）。
2. 给 TUN 配 OS 级 IPv4/IPv6 地址（`daemon/pkg/tun/addr_*.go`，shell out 到 `ip` / `ifconfig` / `route`）。
3. 安装 v6 lobby ULA `/48` 路由 + 按 peer 增量同步 v4 `/32` 路由。
4. 持有 WireGuard 私钥（`<state-dir>/wg.key`，mode `0600`），优先通过设备 token 换取控制面 auth，旧 JWT 路径仍保留兼容（详见 `SECURITY.md` §3 / Y7）。

这些动作 **在所有 OS 上都需要提升权限**——内核 TUN ioctl、地址分配、路由表写入都不是普通用户能做的事。本文给出每个 OS 的最小权限路径与运维样板。

通用 daemon CLI flags（`daemon/cmd/ourcordd/main.go`）：

| Flag | 默认 | 说明 |
|---|---|---|
| `--control-url` | `https://control.ourcord.app` | 控制面 URL |
| `--socket` | `ipc.DefaultSocketPath()` | IPC unix socket 路径 |
| `--state-dir` | `$XDG_STATE_HOME/ourcord` 或 `$HOME/.local/share/ourcord` | 持久状态目录（含 `wg.key`、`token`） |
| `--log-level` | `info` | `debug` / `info` / `warn` / `error`；控制 JSON runtime 日志的最小级别 |
| `--log-format` | `json` | `json`（JSON Lines，默认）或 `text` |
| `--log-file` | `""` | 可选的追加日志文件；以 `0640` 权限创建 |
| `--wg-listen-port` | `0` | 固定 WG UDP 监听端口（0=临时端口）；smoke / 手动 mesh 时需要固定 |
| `--wg-endpoint` | `""` | 注册时上报给 control 的 `host:port` 公网端点提示 |

认证环境变量：

- `OURCORD_DEVICE_TOKEN`：优先使用，覆盖 `<state-dir>/device.token`，用于 per-device enroll/exchange/revoke 流程。
- `OURCORD_DAEMON_JWT`：旧兼容路径，覆盖 `<state-dir>/token`。新部署应优先使用设备 token。

---

## 2. Linux

### 2.1 权限

需要 `CAP_NET_ADMIN`：用于 `/dev/net/tun` 的 `TUNSETIFF` ioctl 以及 `ip addr` / `ip route` 修改。两条路径任选其一：

**a. 直接 root（最省心）**

```bash
sudo ./ourcordd --control-url https://control.example.com
```

**b. 给二进制打 capability，普通用户跑（推荐生产）**

```bash
sudo setcap cap_net_admin+ep ./ourcordd
./ourcordd --control-url https://control.example.com
```

> 注意：`setcap` 后 `ourcordd` 即便以非 root 身份运行也能管理 TUN/路由，但 **不能** 写到 root-only 的目录。`--state-dir` 必须指向当前用户可写位置（默认 `$HOME/.local/share/ourcord` 已满足）。

### 2.2 依赖

- 内核模块 `tun`（绝大多数主流发行版默认编入）。
- 用户空间工具 `iproute2`（提供 `ip` 命令；`addr_linux.go` 直接 shell 出去）。

无需 `wireguard-tools`——daemon 走 userspace `wireguard-go`，不依赖内核 WG 模块或 `wg`/`wg-quick`。

### 2.3 systemd 单元示例

放到 `/etc/systemd/system/ourcordd.service`：

```ini
[Unit]
Description=OurCord VPN daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ourcord
Group=ourcord
AmbientCapabilities=CAP_NET_ADMIN
CapabilityBoundingSet=CAP_NET_ADMIN
NoNewPrivileges=true
StateDirectory=ourcord
Environment=XDG_STATE_HOME=/var/lib
# 或用文件：放到 /var/lib/ourcord/device.token (mode 0600, owner ourcord)
# Environment=OURCORD_DEVICE_TOKEN=dt_...
# 旧兼容路径仍可用：
# Environment=OURCORD_DAEMON_JWT=eyJhbGciOi...
ExecStart=/usr/local/bin/ourcordd \
  --control-url https://control.example.com \
  --state-dir /var/lib/ourcord
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

启用：`sudo systemctl daemon-reload && sudo systemctl enable --now ourcordd`。

### 2.4 SELinux / AppArmor

- **SELinux**（RHEL/Fedora 系）：默认策略允许带 `CAP_NET_ADMIN` 的用户进程操作 tun 设备；如出现 `avc: denied`，临时验证可用 `setenforce 0`，长期方案 `audit2allow -a -M ourcordd_local && semodule -i ourcordd_local.pp`。
- **AppArmor**（Debian/Ubuntu 系）：默认无 profile，无需配置。如果发行版自带了 strict profile，把 `/dev/net/tun rw` 与 `capability net_admin` 加入。

### 2.5 防火墙（UDP 入站为打洞做准备）

`iptables`（legacy）：

```bash
# 允许已建立 + 允许 WireGuard UDP 入站（端口随机时可放宽至所有 UDP 入站，
# 或固定 --wg-listen-port=51820 后只放该端口）
sudo iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
sudo iptables -A INPUT -p udp --dport 51820 -j ACCEPT
```

`nftables`：

```nft
table inet filter {
  chain input {
    type filter hook input priority 0;
    ct state established,related accept
    udp dport 51820 accept
  }
}
```

如果用临时端口（`--wg-listen-port=0`），打洞依赖出站 → 内向映射，无需特别开放入站；只有当本机当 mesh 中继（A-B-C 链中段）且对端打洞失败时，固定监听端口 + 入站放行体验更好。

---

## 3. macOS

### 3.1 权限

macOS `utun` 设备通过 `socket(PF_SYSTEM, SOCK_DGRAM, SYSPROTO_CONTROL)` + `connect` 到 `com.apple.net.utun_control` 创建——这条系统调用 **必须 root**。后续的 `ifconfig`、`route` 也需要 root。

**a. 直接 sudo（开发/单机使用）**

```bash
sudo ./ourcordd --control-url https://control.example.com
```

注意：`sudo` 下 `$HOME` 仍是原用户的家目录，但 `os.UserHomeDir()` 在 root 上下文里会返回 `/var/root`。建议显式指定：

```bash
sudo ./ourcordd \
  --control-url https://control.example.com \
  --state-dir /usr/local/var/ourcord
```

**b. launchd helper（生产推荐，属于 Phase 4 分发/产品化）**

按设计应通过 `SMJobBless` 或 launchd `LaunchDaemon` 运行 root helper，UI 通过 IPC 与之通信。**当前未实现**——见 §7「已知缺口」。

### 3.2 launchd plist 示例（手动安装版）

`/Library/LaunchDaemons/app.ourcord.daemon.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.ourcord.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/ourcordd</string>
    <string>--control-url</string><string>https://control.example.com</string>
    <string>--state-dir</string><string>/usr/local/var/ourcord</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/log/ourcordd.log</string>
  <key>StandardErrorPath</key><string>/var/log/ourcordd.err</string>
</dict>
</plist>
```

加载：`sudo launchctl bootstrap system /Library/LaunchDaemons/app.ourcord.daemon.plist`。

### 3.3 防火墙（pf）

macOS 默认 pf 关闭。若启用 Application Firewall 或自定义 `/etc/pf.conf`：

```pf
# 允许 WireGuard UDP 入站（端口示例 51820）
pass in proto udp from any to any port 51820 keep state
# 允许任何走 utun* 的 v4/v6 流量
pass quick on utun0
```

`sudo pfctl -f /etc/pf.conf -e`。

### 3.4 Apple Silicon vs Intel

无差异——都走同一条 `utun` 路径，`wireguard-go` 已编译两架构。`ifconfig <utunN> inet <addr> <addr>`、`route -n add -inet6 ...`、`route -n add -inet -host ...` 命令完全一致（见 `addr_darwin.go`）。

---

## 4. Windows

> **当前状态：已支持。** 地址/路由同步由 `daemon/pkg/tun/addr_windows.go` 通过原生
> IP Helper API（`winipcfg`）实现——`assignAddrs`（`SetIPAddresses` + lobby ULA `/48`
> 路由）、`syncPeerV4Routes`（按 peer 增量同步 `/32`，排除接口自身地址）、
> `enableForwarding`（A-B-C 中继需要）。TUN 设备本身由 wireguard-go 的 Wintun 适配器
> 提供。真机行为由 CI 的 `windows-native` job（`windows-latest` + 真 Wintun 适配器
> smoke）验收。

### 4.1 驱动

Windows 没有内置 TUN，需要 [Wintun](https://www.wintun.net/) 驱动（WireGuard 项目维护，BSD-3）：

- 下载 `wintun.zip`，解压后把对应架构的 `wintun.dll` 放到 **二进制同目录** 或 `C:\Program Files\Wintun\`。
- 驱动随 dll 自加载，无需独立安装包（旧版本曾用 .msi）。

### 4.2 权限

**必须以 Administrator 运行**——Wintun 适配器创建走 SetupAPI，路由表写入走 IP Helper API，二者都要管理员令牌。

`Run as Administrator` 启动 PowerShell 后：

```powershell
.\ourcordd.exe --control-url https://control.example.com
```

### 4.3 服务安装

**`sc.exe` 内置：**

```powershell
sc.exe create ourcordd binPath= "C:\Program Files\OurCord\ourcordd.exe --control-url https://control.example.com --state-dir C:\ProgramData\OurCord" start= auto
sc.exe description ourcordd "OurCord VPN daemon"
sc.exe start ourcordd
```

**`NSSM`（推荐，更好的日志/重启策略）：**

```powershell
nssm install ourcordd "C:\Program Files\OurCord\ourcordd.exe"
nssm set ourcordd AppParameters "--control-url https://control.example.com --state-dir C:\ProgramData\OurCord"
nssm set ourcordd Start SERVICE_AUTO_START
nssm set ourcordd AppRestartDelay 5000
nssm start ourcordd
```

### 4.4 防火墙（Windows Defender Firewall）

```powershell
# 允许 WireGuard UDP 入站
netsh advfirewall firewall add rule name="OurCord WG UDP" dir=in action=allow protocol=UDP localport=51820

# 允许 ourcordd.exe 全部入站（替代上面，按需二选一）
netsh advfirewall firewall add rule name="OurCord daemon" dir=in action=allow program="C:\Program Files\OurCord\ourcordd.exe" enable=yes
```

---

## 5. Network requirements（所有 OS）

| 方向 | 协议/端口 | 用途 |
|---|---|---|
| 出站 | UDP/3478（默认 STUN） | NAT 映射探测 |
| 出站 | UDP（随机高端口）→ 对端公网 endpoint | WireGuard 数据面（P2P） |
| 出站 | TCP/443 → DERP 节点 | 中继兜底（打洞失败时） |
| 入站 | UDP（`--wg-listen-port` 或临时端口） | 打洞返程；走 hairpin/对称 NAT 时尤其重要 |

中继链场景（A-B-C，B 当中继）对网络无额外要求——routing 通过 WireGuard `AllowedIPs` 实现，对操作系统透明。详细策略见 `daemon/AGENTS.md` §「TUN 路由」与 `daemon/pkg/routing`。

---

## 6. Troubleshooting

| 症状 | 排查 |
|---|---|
| `permission denied` / `operation not permitted` 创建 TUN | Linux: 检查 `CAP_NET_ADMIN`（`getcap ./ourcordd`）；macOS: 必须 sudo；Windows: 以管理员运行。 |
| `ip ... addr add ...: exit status 2` | 多半是 `iproute2` 缺失或 ifname 冲突；`ip link show` 看是否已存在同名 dev。 |
| `no route to host` 到 peer VPN IP | 1) `ip a` / `ifconfig utun*` / `Get-NetAdapter` 确认 TUN 有期望地址；2) `ip -4 route show dev utun*` / `netstat -rn -f inet` 确认 peer `/32` 已装；3) 防火墙是否拦了出站 UDP。 |
| 一直走中继（DERP），不打洞 | STUN 不可达或对端是对称 NAT。`ourcord-cli status` 看 `PeerCount` 与连接路径；daemon 日志（X9 结构化 JSON）含 ICE 候选信息。 |
| 启动时 `WARN: VPN pool 198.18.0.0/15 may conflict ...` | 已有路由覆盖了 198.18 段（常见于同机跑 Tailscale/lab 网）。daemon 仍会装 per-peer `/32`（优先级高），通常不影响——参见 `daemon/AGENTS.md`「TUN 路由」节。 |
| 子网冲突历史背景 | U 系列已把 v4 池迁到 `198.18.0.0/15` + 随机 ULA `/48`，避开 `100.64/10` 与 `fd7a:115c:a1e0::/48`。详见 `daemon/AGENTS.md`。 |
| `read /var/lib/ourcord/device.token: ...` 或 `read /var/lib/ourcord/token: ...` | 设备未 enroll/exchange，且旧 JWT 兼容 token 也不存在。优先配置 `OURCORD_DEVICE_TOKEN` 或写入 `<state-dir>/device.token`（mode `0600`）；旧路径可用 `OURCORD_DAEMON_JWT` / `<state-dir>/token`。Token 安全语义见 `SECURITY.md` §3 / Y7。 |

---

## 7. Known gaps

- **macOS launchd helper 一键安装**：当前需手动 `sudo` 启动或自行写 plist；`SMJobBless` 集成仍待做。
- **Windows MSI 安装包 + 服务包装**：仍待做，先用 `sc.exe` / `nssm` 手动方案。
- **自动更新**：无内置 updater。

---

> 修订记录：AA3 / V12 / W10 — 初版，对应 `daemon/cmd/ourcordd/main.go`、`daemon/pkg/tun/addr_{linux,darwin,windows,other}.go`、`daemon/pkg/wg/persist.go` 当前实现。Windows Wintun 地址/路由同步已落地（`addr_windows.go` + CI `windows-native`）。
