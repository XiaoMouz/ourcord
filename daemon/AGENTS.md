# daemon/ — 客户端 VPN Daemon AGENTS

> 顶层契约见根 [`AGENTS.md`](../AGENTS.md)。

## 职责

跑在终端用户机器上的后台进程，负责：

- 创建/管理 tun 接口（macOS utun / Linux /dev/net/tun / Windows wintun）
- WireGuard userspace 内核（`golang.zx2c4.com/wireguard`）
- ICE 打洞（`github.com/pion/ice/v4`，IPv6 优先 → IPv4 NAT → DERP）
- DERP 中继客户端
- 控制面 WebSocket 客户端（拉配置、推状态）
- 路由表计算（含 A-B-C 中继链 `AllowedIPs`）
- 给 UI 提供 IPC（gRPC over Unix socket / Named Pipe）
- 媒体引擎入口（阶段三）

## 包结构

| 包 | 职责 |
|---|---|
| `pkg/tun` | 跨平台 tun 接口抽象 |
| `pkg/wg` | WireGuard 配置/对等体管理（wgctrl + wireguard-go） |
| `pkg/derp` | DERP 客户端 |
| `pkg/ice` | ICE/STUN 打洞 |
| `pkg/routing` | AllowedIPs 计算 + 中继链路由 |
| `pkg/control` | 控制面 WebSocket 客户端 |
| `pkg/media` | 语音/视频/远控（阶段三占位） |
| `pkg/ipc` | gRPC IPC（给 UI） |
| `cmd/ourcordd` | daemon 入口 |
| `cmd/ourcord-cli` | 调试 CLI |

## 关键约束

- **所有出站连接都要通过控制面授权**：先注册 peer 拿配置，再尝试打洞。
- **打洞失败必须 fallback 到 DERP**，不要让连接挂死。
- **A-B-C 中继链路由**走 WireGuard `AllowedIPs`：
  - `routing.AddRelayChainRoutes()` 必须把计算出的 nextHopRoutes 真正应用到 `BuildIPCConfig`，不能只算不用。已在 `BuildIPCConfig` 内调用并合入 AllowedIPs。
- **控制面断线要自动重连**（`pkg/control/client.go` `Run()` 已实现指数退避：min 1s → max 60s）。
- **`pkg/control/client.go SendSignal` 用 `wsMu.RLock()` 取出 `*websocket.Conn` 后直接 `wsjson.Write`**：这是有意为之，不是 bug。`nhooyr.io/websocket` 对单个 Conn 的 Write 已自带串行化（内部锁），所以 RLock 仅用来防止与 `Connect`/`Close` 替换 `c.ws` 指针发生竞争，并不需要升级成 Lock 来串行 Write。后续 reviewer 看到「读锁里写」请勿改为写锁，会无谓地序列化所有发送方。

## TUN 路由（U 系列后）

- **v4 池 `198.18.0.0/15`**（RFC2544）+ **部署级随机 ULA `/48`**（control 在首次注册时生成、KV 持久化）。**绝不**复用 Tailscale 的 `100.64/10` / `fd7a:115c:a1e0::/48`。
- **v4 路由策略：每 peer `/32`**。`tun.SyncPeerV4Routes(want []netip.Addr)` 在 `applyConfig` 流程末端调用，对比 OS 路由表与目标集合做增量 add/del。
  - 不抢 `/15` 整段是为了与 Tailscale / ZeroTier / 实验室网络共存——同机装多个 VPN 工具不会因为路由重叠互相打架。
- **v6 路由：lobby `/48` 一次性装**，在 `assignAddrs` 阶段完成。peers v6 走该 /48 内的 /128 (wg AllowedIPs 已下发)。
- 启动时 `detectVPNSubnetConflicts()` 扫一遍 OS 路由表，命中 `198.18` 段就 warn（不强阻塞）。
- macOS `netstat -rn` 列序在不同版本/路由类型下会变，`listV4HostRoutesOnDevDarwin` 用宽松解析；遇到误报先看那段。

## ICE 注意

- pion/ice v4 默认只 UDP；要 TCP 必须显式 `TCPMux` + `TCP4Listener`。
- 当前 `agent.go` `NetworkTypes` 仅声明 UDP4/UDP6，TCP 通道**已移除**（避免「类型声明了但 mux 没配 → 静默无效」的陷阱）。如阶段二真要 TCP fallback，记得同步加 mux。
- 优先级：UDP IPv6 > UDP IPv4 > DERP relay。

## 构建/检查

```bash
cd daemon
go build ./...
go vet ./...
go test -race ./...
```

跨平台：daemon 必须能编译 linux/amd64、linux/arm64、darwin/arm64、windows/amd64。

## IPC

- gRPC over Unix Socket（macOS/Linux）/ Named Pipe（Windows）
- proto 定义最终落 `proto/`，当前可在 `pkg/ipc/` 内联但要标 `// TODO(proto): 移到 proto/`
- `CmdStatus` 现已返回 `IP4` / `IP6` / `PeerCount` 字段，CLI/UI 可直接读不再需要解析 wg 表。

## 已知技术债

- `pkg/wg` 在 macOS 上 wgctrl 不能直接配 userspace daemon；当前走 `wireguard-go` 的 IPC socket（`wg/ipc.go` `ConfigureIPC`）。
- 中继链 fallback 切换尚未做"主动嗅探→切链"的反馈环，依赖控制层下发新拓扑。
- M 系列（Minecraft LAN）尚未实现：mDNS 反射 + 25565 端口转发 + lobby 网段广播代理。设计在 plan.md 第十五轮规划。
