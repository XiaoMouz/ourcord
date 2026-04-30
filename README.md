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
# 应用数据库迁移（schema 由 control/migrations/ 管理）
npx wrangler d1 migrations apply DB --local    # 本地开发
npx wrangler d1 migrations apply DB --remote   # 远程生产
```

### 服务层部署

```bash
cd service
npm install
npx wrangler deploy
curl -X POST https://your-service.workers.dev/api/admin/init-db
```

### 环境变量 / Environment Variables

生产环境需要配置以下密钥/变量。控制层与服务层均通过 `wrangler secret put` 注入；本地 dev 走 `.dev.vars`。

| Var | Where | Required | Description |
|---|---|---|---|
| `JWT_SECRET` | control | prod | ≥32 chars; HMAC-SHA256 key for JWT signing. Use `openssl rand -base64 48`. |
| `ADMIN_USER_IDS` | control | prod | comma-separated user-id allowlist for `requireAdmin` (ban management). |
| `ADMIN_TOKEN` | service | prod | shared secret for admin endpoints (cleanup-r2 etc). |
| `EMAIL_API_KEY` | control | prod | Resend API key for OTP delivery. Falls back to console.log in dev. |
| `EMAIL_FROM` | control | prod | sender address for OTP emails (e.g. `noreply@yourdomain.com`). |
| `EMAIL_RATE_LIMIT_PER_DAY` | control | optional | per-recipient daily OTP cap (default 10). |
| `INTERNAL_TOKEN` | control + service | phase-2 | shared HMAC for control↔service RPC (not used in phase-1). |

`wrangler secret put` 示例:

```bash
cd control
echo "your-secret-here" | npx wrangler secret put JWT_SECRET
echo "user_id_1,user_id_2" | npx wrangler secret put ADMIN_USER_IDS
echo "re_xxxxxxxxxxxx" | npx wrangler secret put EMAIL_API_KEY
echo "noreply@yourdomain.com" | npx wrangler secret put EMAIL_FROM

cd ../service
echo "your-admin-token" | npx wrangler secret put ADMIN_TOKEN
```

#### D1 schema bootstrap

- **Dev**: 启动 `npx wrangler dev` 后调用一次
  ```bash
  curl -X POST https://localhost:8787/api/admin/init-db
  ```
  即可基于 `src/schema.ts` 中导出的 `SCHEMA_SQL` 建表。

- **Prod** (until W7 迁移系统落地): 手动执行
  ```bash
  npx wrangler d1 execute ourcord-control --file=src/schema.sql --remote
  ```
  ⚠️ 当前 schema 实际上以 TypeScript 常量 `SCHEMA_SQL` 形式存放在 `src/schema.ts`，并没有独立的 `.sql` 文件。在 W7 自动迁移系统就绪之前，运维需要手动把 `SCHEMA_SQL` 字符串复制到一个临时 `.sql` 文件，再喂给上面的命令。这个流程目前确实不优雅，等 W7 完成后会改成正式的 migrations 目录。

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
