# AGENTS.md — OurCord 仓库 AI 协作指引

> 这是面向 AI 编码助手（Claude Code、GitHub Copilot、Cursor 等）的权威协作指引。
> 人类贡献者也可阅读，但 README.md 是面向用户的入口。
> `CLAUDE.md` 与 `.github/copilot-instructions.md` 都是本文件的薄包装。

---

## 1. 项目本质

OurCord 是一个面向 5–10 人小群体的通讯平台，**底层是自建的 WireGuard 覆盖网（类 Tailscale）**，上层叠加 Discord 风格的语音/视频/屏幕共享/文件/远控功能。

核心差异点：
- **媒体走 VPN 隧道**而非 SFU/MCU；P2P 优先，DERP 中继兜底
- **A-B-C 中继链**：当 B 与 C 无法直连但 A 与两者都能直连时，A 作为路由中继；这通过 WireGuard `AllowedIPs` 在路由层实现，DERP 层无感
- **DERP 限速兜底**：哪怕走中继也保证 128 Kbps 用于 Opus 语音
- **数据自治**：文件优先走用户自建/分享的服务器，最后才落 R2

请在做任何架构相关决策前先理解这四点。它们是产品定位，不是实现细节。

---

## 2. 架构层次与目录映射

| 层 | 目录 | 技术栈 | 部署形态 |
|---|---|---|---|
| 控制层 | `control/` | TypeScript + Cloudflare Workers + D1 + KV + Durable Objects | `wrangler deploy` |
| 服务层 | `service/` | TypeScript + Cloudflare Workers + D1 + R2 | `wrangler deploy` |
| DERP 中继 | `relay/` | Go (fork tailscale/derp) | 用户/官方裸机或 VPS |
| 客户端 daemon | `daemon/` | Go (wireguard-go + pion/ice) | 跑在终端用户机器上 |
| UI | `ui/{desktop,mobile,web}` | Tauri / Flutter / React | 通过 IPC 与 daemon 通信 |
| 共享 proto | `proto/` | Protobuf（待补） | 给 daemon ↔ UI 用 |

详见各子目录的 `AGENTS.md`。

---

## 3. 关键设计契约（违反这些会破坏跨模块假设）

### 3.1 JWT
- 控制层签发，控制层与服务层都用 **同一个 `JWT_SECRET` env var** 验证。
- 算法：HMAC-SHA256，自实现（避开依赖），见 `control/src/auth.ts`。
- 服务层 `JWT_SECRET` 必须与控制层完全一致；不一致则用户带 token 访问服务层会全部 401。
- ⚠️ 历史上 service 用过 `CONTROL_INTERNAL_SECRET` 作变量名，已统一为 `JWT_SECRET`。**不要回退。**
- 未来如果引入"控制层 → 服务层"的服务对服务认证，应该新增独立变量（建议 `INTERNAL_S2S_SECRET`），不要复用 `JWT_SECRET`。

### 3.2 VPN 地址池
- IPv4：`100.64.0.0/10`（CGNAT 段，避免与用户家网冲突）
- IPv6：`fd7a:115c:a1e0::/48`（ULA 段，与 Tailscale 默认相同段号便于排查）
- 分配在 `control/src/peers.ts` 完成，**必须保证原子性**（DB UNIQUE + 事务 retry）。不要用纯 KV 计数器。

### 3.3 中继链拓扑
- 控制层维护连通性矩阵；当无法直连时计算路径（最多 1 跳中继节点 = A-B-C 链）。
- 路由通过给 A 的 WireGuard 配置增加 `AllowedIPs = C_IP/32`，并给 B 的 endpoint 指向 A 实现。
- DERP 永远不感知链路结构。
- 实现位置：`daemon/pkg/routing/table.go`。

### 3.4 DERP 限速
- 默认每连接 128 Kbps 下限保证（语音）。
- 实现位置：`relay/pkg/limiter/`。
- limiter 必须接 context.Context，禁止 `WaitN(nil, …)`（会 panic）。

### 3.5 文件存储优先级
固定顺序：用户自建服务器 → 别人分享给用户的服务器 → 大厅服务器 → R2 fallback。
R2 配额由后端控制（大小、永久/临时数量、保存天数）。元数据始终保存在 D1。

### 3.6 信令鉴权
- `SignalDO` WebSocket 必须带 `?token=<jwt>&pk=<public_key>`。
- 控制层入口校验：JWT 合法 + `pk` 在该用户的 `peers` 表中存在。**不要在 DO 内重做校验**（DO 假设上游已认证）。

---

## 4. 构建/检查命令（在 PR 前必须全部通过）

```bash
# Workers TypeScript
(cd control && npx tsc --noEmit)
(cd service && npx tsc --noEmit)

# Go modules
(cd relay  && go build ./... && go vet ./...)
(cd daemon && go build ./... && go vet ./...)

# 整工作区
go work sync
```

测试目前几乎为空（阶段一脚手架），新增逻辑请同步加 `_test.go` 或 vitest（待引入）。

---

## 5. 提交规范

- **Conventional Commits**：`feat:` `fix:` `docs:` `refactor:` `chore:` `perf:` `test:`
- 影响多模块时加 scope：`fix(relay): ...`、`feat(control,service): ...`
- 正文用中文或英文均可，但要解释 **为什么**，不只是 **做了什么**
- **必须** 包含 trailer：
  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  ```
- **本机 git 配置启用了 1Password GPG 签名**，AI 助手用以下命令绕过：
  ```bash
  git -c gpg.format=openpgp -c commit.gpgsign=false commit -m "..."
  ```
- 一个逻辑变更一个 commit，不要把 docs + 修 bug + 重构混在一起。

---

## 6. 常见陷阱（踩过的坑，别重复）

1. **不要 import `tailscale.com/derp`** —— 那是协议帧定义。Server 在 `tailscale.com/derp/derpserver`。
2. **不要给 limiter 传 nil context** —— `rate.Limiter.WaitN(nil, n)` 在阻塞路径上会 nil-deref。
3. **D1 没有真正的 `BEGIN/COMMIT`** —— 用 `DB.batch([...])` 做原子语句组，或用 UNIQUE 约束 + retry。
4. **Workers 没有长连接定时器** —— 心跳/清理用 Cron Triggers 或 Durable Object Alarms。
5. **WireGuard userspace 在 macOS 需要 utun**，Linux 用 `/dev/net/tun`，Windows 走 wintun.dll。`daemon/pkg/tun/` 已抽象。
6. **pion/ice v4 默认只 UDP**；要 TCP 必须显式配置 TCPMux，否则 `NetworkTypeTCP4/6` 静默无效。
7. **CF Workers 的 `crypto.subtle`** 与 Node 不完全一致；HMAC 验签按 `control/src/auth.ts` 的写法即可，别引 `jose`。
8. **R2 没有 TTL**——过期文件需要 cron 显式删除，元数据的 `expires_at` 只是标记。

---

## 7. AI 助手工作建议

- **改代码前先 grep**：契约（如 `JWT_SECRET`）会跨多文件出现，统一改不要漏。
- **跨语言改动要双侧验证**：改了 control 的接口字段，relay/daemon 的 client 必须同步更新。
- **不要新增依赖**而不说明：Workers 包大小有 1MB 限制；Go 二进制要全平台编译。
- **proto/ 是未来的事实源**：daemon ↔ UI ↔ control 的共享类型最终都应在这里定义；现阶段允许内联，但要标 `// TODO(proto): 移到 proto/`。
- **plan.md 在 session 文件夹**，不要 commit 它。

---

## 8. 当前阶段

- ✅ 阶段一：VPN 核心 + 控制层 + DERP 节点（脚手架完成）
- 🚧 阶段二：服务层完善（大厅/房间/权限/消息/文件实际打通）
- 📋 阶段三：媒体层（Opus/H.264/H.265、远控）
- 📋 阶段四：UI 层（Tauri/Flutter/React）

判断改动归属哪个阶段，避免提前实现尚未冻结的设计。
