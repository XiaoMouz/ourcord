# control/ — 控制层 AGENTS

> 顶层契约见根 [`AGENTS.md`](../AGENTS.md)。

## 职责

控制层管理"网络拓扑与身份"，**不管业务数据**。具体：

- 用户身份（OAuth + 邮箱 OTP）与 JWT 签发
- 节点（peer）注册、IP 分配、配置下发
- 打洞协调（SignalDO WebSocket，Durable Object）
- STUN 服务器池
- 中继服务器登记与租借
- 全局封禁列表（user / peer / relay）

业务数据（房间、消息、文件）属于 `service/` 层，不要混。

## 路由表

入口：`src/index.ts`。所有 API 在这里登记。新增路由时：
1. 在 `src/index.ts` 加路径分发；
2. handler 文件用 `requireAuth(req, env)` 拿到 `claims`；
3. 涉及 schema 改动时同步更新 `src/schema.ts` 并递增版本（init-db 接口幂等）。

## 数据库

- D1：`src/schema.ts` 是事实源；通过 `POST /api/admin/init-db` 创建。
- KV：会话/缓存用，**不要存权威数据**。
- 不要在 KV 上做计数器+条件写来实现"原子分配"——它不原子。用 D1 UNIQUE 约束 + retry。

## Durable Objects

- `SignalDO`：每个 room（peer-pair hash）一个实例，承载打洞 WebSocket。
- 命名空间在 `wrangler.toml` 的 `[[durable_objects.bindings]]` 配置。
- DO 内**假设上游已鉴权**——`src/index.ts` 在路由层校验 JWT + `pk` 所有权后才转发。
- DO 状态都在内存（不持久化），实例迁移会丢；信令本就短命可接受。

## 鉴权

- `src/auth.ts` 是唯一签发 / 校验入口。
- `JWT_SECRET` env var 必须与 `service/` 完全一致。
- `requireAuth` 已处理 401 返回；handler 拿到的若是 `Response` 直接返回即可。
- `requireAdmin` 基于 `Env.ADMIN_USER_IDS`（逗号分隔白名单）；用于 `/api/ban` 等运营级端点。未来引入 `users.role` 列时迁移。
- 控制层 → 服务层调用走 `SERVICE_INTERNAL_TOKEN` + `X-Internal-Token` 头（如 `getPeerConfig?room_id=` 时拉成员列表）。

## 构建/检查

```bash
cd control
npm install            # 仅首次
npx tsc --noEmit       # 类型检查
npx wrangler deploy    # 部署
```

## 设计契约（不要"修"）

- **打洞信令成对语义**：`SignalDO` 双方登记后才广播 `paired`，30s offer/answer replay cache，重复 pk 上线时关旧连接；不是裸 WS 透传。
- **getPeerConfig 默认仅返回该用户自己的 peers**；带 `?room_id=` 才跨 user 暴露同 room 成员的 peers。这就是"每个房间独立组网"的实现。
- **relay map 按 region 过滤、按 headroom 排序**；daemon 自己挑前几个 relay 做候选。
- **per-relay denylist 与全局 ban 解耦**：`/api/relay/banned-keys?relay_id=` 才返回合并集。响应包含 `{keys, derp_keys}` 两数组，分别给 WireGuard 与 DERP admit 用——双 key 体系（G12），daemon 注册 peer 时必须同时上报 `public_key` + `derp_node_key`，否则 DERP 通道封禁失效。
- **schema 加表只能用 `CREATE IF NOT EXISTS`**；现有部署需手工 `wrangler d1 execute` 应用 schema.ts diff（D5 迁移系统未上）。
- **OAuth state 浏览器绑定（P1）**：`oauthRedirect` 同时下发 `state`（KV）与 `oauth_state` HttpOnly cookie；`oauthCallback` 必须常量时间比对二者。修改这条链路时不能去掉 cookie 校验，否则退化为登录 CSRF。
- **OTP 暴力防护（P2）**：`otp_fails:<email>` KV 计数器达到 5 即作废 OTP；`otp_cooldown:<email>` 强制 60s 申请冷却。**KV 读改写非原子**——这是已知短板，并发错码可能漏计 1-2 次。Phase-2 切换 D1 计数行或 Durable Object 解决。新增 OTP 校验路径必须复用 fail counter 而非另起一套。
- **`bans` 表强制生效点（P3）**：`requireAuth` 在 JWT 验签后追加 `isUserBanned`，让现有 30 天 token 在封禁后立即失效；`verifyOTP` / `oauthCallback` 同时检查以拒发新 token。新增登录入口/特权路径同样要补这一行。

## IPAM（U 系列后）

`src/ipam.ts` 是 VPN 地址分配的唯一入口：

- **v4 池：`198.18.0.0/15`**（RFC 2544 基准段）。`VPN_SUBNET_START=0xC6120000`、`VPN_SUBNET_MASK=0x1FFFF`。**不再用** `100.64/10`（与 Tailscale + 中国 ISP CGNAT 冲突）。
- **v6 池：部署级随机 ULA `/48`**。首次注册时 `getULAPrefix(env.KV)` 检测 `KV.vpn_ula_prefix` 为空 → `generateULAPrefix()` 用 `crypto.getRandomValues` 生成 `fd<XX>:<XXXX>:<XXXX>:` → 写回 KV。后续注册都读同一个 prefix。**绝不**硬编码 `fd7a:115c:a1e0::`（Tailscale 字面量）。
- KV 写入 race：两个并发首次注册都看到 null → 都生成 → last write wins；接受这个一次性窗口（部署后只会触发一次）。
- `ipsForOffset(offset, ulaPrefix)` 把 `offset (0..131071)` 映射到 `(v4, v6)` 元组；调用方先取 prefix 再循环。
- 测试见 `src/ipam.test.ts`（21 cases）；改 IPAM 必须先跑 vitest。

## 已知技术债

- `peers.ts` IP 分配在并发场景下用 UNIQUE + retry，已原子化但仍有 race 时 500 重试；无回退池。
- 中继链拓扑计算逻辑尚未上线（daemon 端先实现，再决定控制层是否需要做拓扑计算 service）。
- `invalidateRelayCache` 用硬编码 region 列表清 KV；region 数量上去后改为索引 key。
- 缺 `users.role` 列；admin 用环境变量白名单临时方案。
