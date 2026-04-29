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

## 构建/检查

```bash
cd control
npm install            # 仅首次
npx tsc --noEmit       # 类型检查
npx wrangler deploy    # 部署
```

## 已知技术债

- `peers.ts` IP 分配在并发场景下可能冲突 → 待改原子方案。
- 中继链拓扑计算逻辑尚未上线（daemon 端先实现，再决定控制层是否需要做拓扑计算 service）。
