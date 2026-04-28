# OurCord

小群体（5–10 人）通讯平台，底层为自建 WireGuard VPN 覆盖网，上层提供语音/视频/屏幕共享/文件传输/远控功能。

## 架构

```
控制层 (Cloudflare Workers)  ←→  客户端 Daemon (Go)
服务层 (Cloudflare Workers)       ↕
DERP 中继节点 (Go)            ←→  UI (Tauri / Flutter / React)
```

- **控制层** (`control/`) — 打洞协调、节点注册、STUN 指派、中继注册、封禁管理
- **服务层** (`service/`) — 大厅/房间、权限、消息历史、文件存储 (R2)
- **中继节点** (`relay/`) — DERP 协议中继，基于 Tailscale derper，添加控制面集成与限速
- **客户端 Daemon** (`daemon/`) — wireguard-go + ICE 打洞 + DERP 客户端 + IPC

## 网络特性

| 功能 | 实现 |
|---|---|
| P2P 直连 | ICE/STUN，IPv6 优先，IPv4 NAT 穿透 |
| 中继兜底 | DERP over TCP/443 TLS |
| 中继链 A-B-C | WireGuard AllowedIPs 路由 |
| 语音保障 | DERP 节点 128 Kbps 限速下限 |
| 加密 | WireGuard (Curve25519 + ChaCha20-Poly1305) |

## 快速开始

### 前提条件
- Go 1.25+
- Node.js 18+
- Cloudflare 账号 (Workers + D1 + KV + R2)

### 控制层部署

```bash
cd control
npm install
# 配置 wrangler.toml 中的 D1/KV 资源 ID
npx wrangler deploy
# 初始化数据库
curl -X POST https://your-control.workers.dev/api/admin/init-db
```

### 服务层部署

```bash
cd service
npm install
npx wrangler deploy
curl -X POST https://your-service.workers.dev/api/admin/init-db
```

### 中继节点

```bash
cd relay
go build -o ourcord-relay ./cmd/ourcord-relay
./ourcord-relay \
  --addr :443 \
  --region cn-east \
  --control-url https://your-control.workers.dev \
  --auth-token <your-token> \
  --cert /path/to/cert.pem \
  --key /path/to/key.pem
```

### 客户端 Daemon

```bash
cd daemon
go build -o ourcordd ./cmd/ourcordd
go build -o ourcord-cli ./cmd/ourcord-cli
./ourcordd --control-url https://your-control.workers.dev &
./ourcord-cli status
```

## 开发路线图

- [x] **阶段一** — VPN 核心 + 控制层 + DERP 节点（当前）
- [ ] **阶段二** — 服务层（大厅/房间/消息/文件）
- [ ] **阶段三** — 媒体层（语音/视频/屏幕共享/远控）
- [ ] **阶段四** — UI 层（Tauri/Flutter/React）

## 协议与授权

- WireGuard® 是 Jason A. Donenfeld 的注册商标
- DERP 协议实现基于 [Tailscale](https://github.com/tailscale/tailscale)（BSD-3-Clause）
