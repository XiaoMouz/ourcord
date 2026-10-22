# service/ — 服务层 AGENTS

> 顶层契约见根 [`AGENTS.md`](../AGENTS.md)。

## 职责

业务数据层，承载 Discord 风格的应用语义：

- 大厅（lobby，类 Discord server）/ 房间（room/channel）
- 权限系统（厅主、管理员、成员、被禁言等）
- 消息历史（D1）
- 文件元数据（D1）+ 自治文件后端直传/complete/health + R2 兜底存储
- 文件存储策略路由：用户自建 → 分享 → 大厅 → R2（固定优先级，`storage_preference` 不可重排）

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

- 元数据有 `expires_at`，但 R2 自身没有 TTL；`runR2Cleanup` 与文件删除触发器通过 `r2_deletion_queue` 清理对象。队列必须独立于 room/lobby 的 FK 级联；仅 R2 删除成功后才移除队列行并释放 `r2_usage` 预留。
- 上传大小/数量/天数限制由后端强制，不要相信前端。
- 运营者 `R2_MAX_BYTES` / `R2_MAX_FILES` / `R2_MAX_FILE_BYTES` 是跨大厅上限。预留与配额检查必须同一语句完成；D1 `meta.changes` 包含触发器写入，不能用 `=== 1` 判断预留成功。
- R2 PUT 先原子占用 reservation，10 分钟超时；删除队列至少等到 upload_started_at + 660 秒后才能删对象，避免进行中的上传重建已清理对象。调整超时必须同步迁移中的 grace period。

## 构建/检查

```bash
cd service
pnpm install               # corepack 自动取 pnpm@9
pnpm exec tsc --noEmit
pnpm test
pnpm exec wrangler deploy
```

## 设计契约（不要"修"）

- **房间消息只允许 type ∈ {text, voice}**：`messages.sendMessage` 拒绝 file/video 房间发文字。这是 by design——文件/视频房间不存聊天历史，附带说明走对应类型房间。
- **lobby 加入需邀请码**：`POST /api/lobbies/:id/join?code=...`，code 在 `lobby_invites` 表（owner 通过 `POST /api/lobbies/:id/invites` 生成）。
- **文件存储优先链 fallback**：固定按 user_server（自建/分享）→ lobby_server → r2 顺序自动降级，不直接 503；`storage_preference` 只作兼容输入，不能重排优先链。
- **/api/internal/* 仅供控制层调用**：用 `SERVICE_INTERNAL_TOKEN` HMAC 短签名校验（`X-Internal-Ts` / `X-Internal-Nonce` / `X-Internal-Sig`）；不要给客户端暴露，不要恢复旧静态 token 头。

## 已知技术债

- R2 过期文件清理已上线，但删失败仅记日志。
- 权限系统目前粗粒度（owner/admin/member/guest）；细粒度位掩码权限仍是后续产品化技术债。
- D1 schema 已走版本化 migrations；`src/schema.ts` / dev `init-db` 只能作为开发辅助。新增列必须配套迁移脚本并保持两者同步。
