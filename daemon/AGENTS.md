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
  - `routing.AddRelayChainRoutes()` 必须把计算出的 nextHopRoutes 真正应用到 `BuildIPCConfig`，不能只算不用。
- **控制面断线要自动重连**（`pkg/control/client.go` readLoop 退出后指数退避重连）。
- **`pkg/control/client.go SendSignal` 用 `wsMu.RLock()` 取出 `*websocket.Conn` 后直接 `wsjson.Write`**：这是有意为之，不是 bug。`nhooyr.io/websocket` 对单个 Conn 的 Write 已自带串行化（内部锁），所以 RLock 仅用来防止与 `Connect`/`Close` 替换 `c.ws` 指针发生竞争，并不需要升级成 Lock 来串行 Write。后续 reviewer 看到「读锁里写」请勿改为写锁，会无谓地序列化所有发送方。

## ICE 注意

- pion/ice v4 默认只 UDP；要 TCP 必须显式 `TCPMux`。
- 当前 `agent.go` 的 `NetworkTypes` 写了 TCP 但没配 TCPMux，等于无效——要么删 TCP，要么加 mux。
- 优先级：UDP IPv6 > UDP IPv4 > TCP（如果配） > DERP relay。

## 构建/检查

```bash
cd daemon
go build ./...
go vet ./...
go test ./...
```

跨平台：daemon 必须能编译 linux/amd64、linux/arm64、darwin/arm64、windows/amd64。

## IPC

- gRPC over Unix Socket（macOS/Linux）/ Named Pipe（Windows）
- proto 定义最终落 `proto/`，当前可在 `pkg/ipc/` 内联但要标 `// TODO(proto): 移到 proto/`

## 已知技术债

- `cmd/ourcordd/main.go` `connect()` 是 stub —— 真实接线属阶段二/三
- `pkg/routing/table.go` `AddRelayChainRoutes` 计算了不用 → `fix-routing-nexthop` todo
- `pkg/control/client.go` 不重连 → `fix-control-reconnect` todo
- `pkg/ice/agent.go` TCP 类型空配 → `fix-ice-tcp` todo
