# OurCord

小群体（5–10 人）通讯平台，底层为自建 WireGuard VPN 覆盖网，上层提供语音/视频/屏幕共享/文件传输/远控功能。

产品需求与阶段边界见 [PRD.md](PRD.md)。

## 架构

```
控制层 (Cloudflare Workers)  ←→  客户端 Daemon (Go)
服务层 (Cloudflare Workers)       ↕
DERP 中继节点 (Go)            ←→  UI (Tauri / Flutter / React)
```

- **控制层** (`control/`) — 打洞协调、节点注册、STUN 指派、中继注册、封禁管理
- **服务层** (`service/`) — 大厅/房间、权限、消息历史、自治文件后端直传闭环与 R2 fallback
- **中继节点** (`relay/`) — DERP 协议中继，基于 Tailscale derper，添加控制面集成与限速
- **客户端 Daemon** (`daemon/`) — wireguard-go + ICE 打洞 + DERP 客户端 + IPC

## 网络特性

| 功能 | 实现 |
|---|---|
| P2P 直连 | ICE/STUN，IPv6 优先，IPv4 NAT 穿透 |
| 中继兜底 | DERP over TCP/443 TLS |
| 中继链 A-B-C | Control 按链路成本下发 `next_hop_public_key`，daemon 用 WireGuard AllowedIPs 路由 |
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
pnpm install
# 配置 wrangler.toml 中的 D1/KV 资源 ID
npx wrangler deploy
# 应用数据库迁移（schema 由 control/migrations/ 管理）
npx wrangler d1 migrations apply DB --local    # 本地开发
npx wrangler d1 migrations apply DB --remote   # 远程生产
```

### 服务层部署

```bash
cd service
pnpm install
# 本地/测试环境首次使用请应用 service migrations
npx wrangler d1 migrations apply DB --local
npx wrangler deploy
```

### 环境变量 / Environment Variables

生产环境需要配置以下密钥/变量。控制层与服务层均通过 `wrangler secret put` 注入；本地 dev 走 `.dev.vars`。

| Var | Where | Required | Description |
|---|---|---|---|
| `JWT_SECRET` | control | prod | ≥32 chars; HMAC-SHA256 key for JWT signing. Use `openssl rand -base64 48`. |
| `ADMIN_USER_IDS` | control | prod | comma-separated user-id allowlist for `requireAdmin` (ban management). |
| `ADMIN_TOKEN` | control + service | prod | shared bearer for admin endpoints — control: `/api/admin/init-db` (Y3); service: `cleanup-r2` etc. |
| `EMAIL_API_KEY` | control | prod | Resend API key for OTP delivery. Falls back to console.log in dev. |
| `EMAIL_FROM` | control | prod | sender address for OTP emails (e.g. `noreply@yourdomain.com`). |
| `EMAIL_RATE_LIMIT_PER_DAY` | control | optional | per-recipient daily OTP cap (default 10). |
| `SERVICE_URL` | control | prod (room-scoped peers) | service Worker base URL, e.g. `https://service.example.com`; required for room-scoped peer lookup. |
| `SERVICE_INTERNAL_TOKEN` | control + service | prod (room-scoped peers) | shared HMAC key for control→service internal RPC. Control sends `X-Internal-Ts` / `X-Internal-Nonce` / `X-Internal-Sig`; service rejects the old static `X-Internal-Token` bearer shape. |

`wrangler secret put` 示例:

```bash
cd control
echo "your-secret-here" | npx wrangler secret put JWT_SECRET
echo "user_id_1,user_id_2" | npx wrangler secret put ADMIN_USER_IDS
echo "re_xxxxxxxxxxxx" | npx wrangler secret put EMAIL_API_KEY
echo "noreply@yourdomain.com" | npx wrangler secret put EMAIL_FROM

echo "https://service.example.com" | npx wrangler secret put SERVICE_URL
echo "$(openssl rand -base64 32)" | tee /tmp/internal-token | npx wrangler secret put SERVICE_INTERNAL_TOKEN
echo "your-admin-token" | npx wrangler secret put ADMIN_TOKEN

cd ../service
cat /tmp/internal-token | npx wrangler secret put SERVICE_INTERNAL_TOKEN
echo "your-admin-token" | npx wrangler secret put ADMIN_TOKEN
rm /tmp/internal-token
```

> `SERVICE_INTERNAL_TOKEN` 必须在 control 与 service 两侧设置同一值；任一侧缺失会让 room-scoped peer lookup 降级（控制层日志会标 `scopeWarning`）。该值只作为 HMAC key 使用，不会作为 bearer 原样发送。

#### D1 schema bootstrap

Schema is managed via `wrangler d1 migrations` (Y2). Migration files live in `control/migrations/` (`0001_init.sql` ...).

- **Local dev**:
  ```bash
  cd control
  npx wrangler d1 migrations apply DB --local
  ```

- **Prod**:
  ```bash
  cd control
  npx wrangler d1 migrations apply DB --remote
  ```

- **Optional seed** (post-migration, e.g. dev fixture data): the `POST /api/admin/init-db` route is guarded by `ADMIN_TOKEN` bearer (Y3) and only runs in `ENVIRONMENT=development`:
  ```bash
  curl -X POST https://localhost:8787/api/admin/init-db \
    -H "Authorization: Bearer $ADMIN_TOKEN"
  ```
  In production the route returns 503 unless `ENVIRONMENT=development`; rely on `wrangler d1 migrations apply --remote` instead.

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
go build -o ourcord-tui ./cmd/ourcord-tui
./ourcordd --control-url https://your-control.workers.dev &
./ourcord-cli status         # one-shot commands + `ourcord-cli watch` live view
./ourcord-tui                # interactive terminal UI
```

`ourcord-cli` and `ourcord-tui` are thin presenters over one UI-agnostic core
(`daemon/pkg/client`); see [docs/ui/client-core.md](docs/ui/client-core.md).
详见 [docs/PLATFORMS.md](docs/PLATFORMS.md) 了解各 OS 的权限/部署细节。

## 开发路线图

- [x] **阶段一** — VPN 核心 + 控制层 + DERP 节点 + daemon 连接管线已闭环（per-peer ICE 自动直连、startup/runtime DERP fallback、指数退避重试、1:1 pair network、service `vpn_namespace`、A-B-C next-hop 数据面与 next-hop 后直达恢复均已用真实 control/service/relay/daemon + OrbStack 验证；`tests/e2e/smoke_abc_netns.sh` 保留为自动 A-B-C 回归入口）
- [ ] **阶段二** — 网络完整性与自治主线大部分完成（已落地 A-B-C 拓扑闭环、设备级凭证、control↔service HMAC、room-scoped peer refresh、CLI/status、自治文件后端直传/complete/health v1、发布前 direct/DERP/A-B-C/recovery 网络验收；待收口 Windows Wintun、路径抖动观测与降噪）
- [ ] **阶段三** — 媒体层（语音/视频/屏幕共享/远控）
- [ ] **阶段四** — 分发与产品化（Tauri/Flutter/React UI、安装器、更新、运营监控）

内部设备接入、运行日志与诊断包操作见 [docs/ops/internal-operations.md](docs/ops/internal-operations.md)。

### Phase 2 — Stretch

- **M 系列：mDNS reflector + Minecraft LAN 联机** — 网络完整性主线后的候选差异化能力，不阻塞 Phase 1 自动连通关闭。

## 协议与授权

- WireGuard® 是 Jason A. Donenfeld 的注册商标
- DERP 协议实现基于 [Tailscale](https://github.com/tailscale/tailscale)（BSD-3-Clause）
