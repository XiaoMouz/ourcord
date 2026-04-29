# service/ — 服务层 AGENTS

> 顶层契约见根 [`AGENTS.md`](../AGENTS.md)。

## 职责

业务数据层，承载 Discord 风格的应用语义：

- 大厅（lobby，类 Discord server）/ 房间（room/channel）
- 权限系统（厅主、管理员、成员、被禁言等）
- 消息历史（D1）
- 文件元数据（D1）+ R2 兜底存储
- 文件存储策略路由：用户自建 → 分享 → 大厅 → R2

**不**做：身份认证、网络拓扑、打洞——那是控制层的事。

## 鉴权

- 校验控制层签发的 JWT，**共用同一个 `JWT_SECRET`**。
- 历史上叫过 `CONTROL_INTERNAL_SECRET`，已统一；不要回退。
- 入口：`src/auth.ts` `requireAuth(request, env.JWT_SECRET ?? "dev-secret-change-me")`。

## 文件存储优先级（产品契约）

1. 用户自己的服务器（用户 daemon 暴露的端点）
2. 别人分享给该用户的服务器
3. 当前大厅服务器（厅主在权限系统里允许的话）
4. 平台 R2（受配额限制：单文件大小、永久数量、临时数量、保存天数）

`src/files.ts` 实现路由决策；R2 路径只是 fallback，不要默认走 R2。

## R2 配额

- 元数据有 `expires_at`，但 R2 自身没有 TTL；过期清理需要 cron（待补 → `fix-r2-cleanup` todo）。
- 上传大小/数量/天数限制由后端强制，不要相信前端。

## 构建/检查

```bash
cd service
npm install
npx tsc --noEmit
npx wrangler deploy
```

## 已知技术债

- R2 过期文件清理 cron 未实现（元数据已过期 ≠ R2 对象已删）。
- 权限系统目前粗粒度；细粒度（每房间 ACL）阶段二补。
