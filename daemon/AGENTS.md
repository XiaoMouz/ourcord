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
- 给 UI 提供 IPC（当前为认证 Unix socket 上的 gRPC；Windows Named Pipe 待实现）
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
| `pkg/media` | 语音引擎（阶段三 v1）：capture→encode→**逐对端 E2E 加密**→RTP→UDP over overlay + jitter/mix。默认 PCM 纯 Go（CGO=0）；`voice` tag 换真 Opus(cgo)+malgo 设备。E2E 密钥由 WG 静态密钥派生（X25519→HKDF→ChaCha20-Poly1305），中继节点转发但读不了媒体 |
| `pkg/ipc` | IPC 层：认证 UDS transport（peercred + HMAC 握手，之后才起 HTTP/2）、domain types、proto 转换（`conv.go`）|
| `pkg/pb` | `proto/ourcord/v1` 生成的 Go bindings（**已提交**，勿手改；CI 重新生成并 diff 校验）|
| `pkg/client` | **UI 无关的客户端核心**：typed daemon ops（gRPC）+ 设备/诊断 + `Watch` view-model。CLI/TUI/未来 GUI 共用，禁止在 presenter 里写 daemon 逻辑 |
| `cmd/ourcordd` | daemon 入口 |
| `cmd/ourcord-cli` | CLI presenter（含 `watch` 实时视图）|
| `cmd/ourcord-tui` | 交互式 TUI presenter（Bubble Tea，基于 `pkg/client`）|

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

跨平台：daemon 必须能编译 linux/amd64、linux/arm64、darwin/arm64、windows/amd64（**默认构建必须 CGO=0**）。

语音真实 Opus + 硬件音频在 `voice` 构建 tag 后（cgo）：
```bash
# Linux 需 libopus-dev libopusfile-dev libasound2-dev；macOS 需 brew opus opusfile pkg-config
CGO_ENABLED=1 go build -tags voice ./...
CGO_ENABLED=1 go test  -tags voice ./pkg/media/   # 两引擎 E2E 会跑真 Opus
```
CI 的 `voice-build` job 在 ubuntu+macos 上跑上述命令。**绝不要**把 cgo 代码放进默认构建——`pkg/media` 里除 `*_voice.go`（`//go:build voice`）外全部纯 Go。

## IPC

- 当前是带 peercred + HMAC 握手的 **gRPC over Unix Socket**（macOS/Linux）；
  Windows Named Pipe 是未来实现。旧 NDJSON transport 已移除，不要恢复或继续按
  JSON IPC 描述当前实现。
- `proto/ourcord/v1/daemon.proto` 是稳定 daemon ↔ UI 契约的事实源。`pkg/ipc/`
  内的 domain types 通过 `conv.go` 映射到 proto；新增稳定能力先更新 proto，再同步
  domain mapping 与生成绑定。
- `DaemonService.GetStatus` 返回地址、peer 数、relay、path summary/flap 等字段；
  `ListPeers` 返回每个 peer 的 direct/derp/next-hop/degraded 等 path。CLI/UI
  直接消费 typed response，不需要解析 wg 表。
- `EnterNetwork` / `LeaveNetwork` 是 daemon 接入业务网络的稳定入口（CLI 的
  `enter-room`/`leave-room` 只是兼容 alias）。进入后按 `vpn_namespace` 拉房间作用域
  peers，离开后回到 user-scope mesh；切换配置必须替换旧 peer set。

## 已知技术债

- `pkg/wg` 在 macOS 上 wgctrl 不能直接配 userspace daemon；当前走 `wireguard-go` 的 IPC socket（`wg/ipc.go` `ConfigureIPC`）。
- 中继链 fallback 已有 daemon 连通性反馈、控制层 next-hop 下发、next-hop 后持续探测并恢复直连的闭环。报告带 epoch+sequence，control 将其按 source-owned 有向边仲裁。路径抖动已由 `path_flap.go` 采样 `routePath()` 计数（per-peer transitions/dwell/flapping，surface 到 status/proto 契约），flapping 会抬高 ICE 重升退避下限降噪。
- M 系列（Minecraft LAN）尚未实现：mDNS 反射 + 25565 端口转发 + lobby 网段广播代理；是否进入阶段二取决于网络完整性主线完成后的产品取舍。
