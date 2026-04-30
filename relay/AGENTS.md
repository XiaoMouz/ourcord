# relay/ — DERP 中继 AGENTS

> 顶层契约见根 [`AGENTS.md`](../AGENTS.md)。

## 职责

OurCord 的 DERP 中继节点。基于 Tailscale derper 复用，加上控制面集成与限速。

**只**做：DERP 协议中继 + 控制面对接。**不**做：信令（信令在控制层 SignalDO）、业务（业务在服务层）。

## 关键导入路径

- ✅ `tailscale.com/derp/derpserver` —— Server 实现
- ❌ `tailscale.com/derp` —— 那是协议帧定义，不是 server
- STUN 用 `tailscale.com/net/stunserver`

## 启动流程（cmd/ourcord-relay）

1. 加载/生成 Curve25519 私钥
2. 创建 `derpserver.New(privKey, logf)`
3. 注册 HTTP 路由：`derpserver.Handler(s)` + `ProbeHandler` + `ServeNoContent("/generate_204")`
4. 启动 STUN：`stunserver.New(ctx).ListenAndServe(":3478")`
5. 启动控制面 client：心跳 + 拉封禁 key
6. TLS 监听 :443

## 限速

- `pkg/limiter/`：每连接 token bucket。
- 必须接 `context.Context`（`NewLimitedWriter(ctx, w, limiter)`）；禁止 nil。
- 默认 128 Kbps 下限保证语音可用——这是产品契约，不是优化。

## 控制面对接

- 心跳每 30s POST `/api/relay/heartbeat`，**必须**带：
  - `id`（自身 relay id）
  - `region`、`hostname`、`port`
  - `mode`：`personal` / `lobby` / `rental`
  - `capacity_kbps`、当前连接数、`load_pct`
- 启动 + 每 5min 拉 `/api/relay/banned-keys` 同步封禁列表，对照本地连接做断开。
- **封禁双 key**：`/api/relay/banned-keys` 返回 `{keys, derp_keys}`；`controlclient.BanList.IsBanned`（WireGuard pk）与 `IsBannedDERP`（`nodekey:HEX...`）必须分别用对地方，不要交叉传。

## 构建/检查

```bash
cd relay
go build ./...
go vet ./...
go test ./...
```

跨平台编译：
```bash
GOOS=linux GOARCH=amd64 go build -o ourcord-relay ./cmd/ourcord-relay
GOOS=linux GOARCH=arm64 go build -o ourcord-relay-arm64 ./cmd/ourcord-relay
```

## 已知技术债

- 限速 manager 已通过 `limiter.WrapListener` 包到底层 `net.Listener`，DERP 写路径继承这层 wrap；如果未来改成 HTTP/3 或 QUIC 直传，要重新核对包装点。
- 长连接 idle 清理（G10）已加 `lm.GCLoop`，仍然依赖 limiter map key 与连接生命周期一致；新引入的连接类型要确认正确 release。
- Relay 自检（探活、容量上报准确性）尚无独立测试套件，依赖控制层 fleet 监控指标兜底。
