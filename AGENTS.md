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
| 自治文件后端 | `filebackend/` | Go | 用户/大厅自建服务器 |
| DERP 中继 | `relay/` | Go (fork tailscale/derp) | 用户/官方裸机或 VPS |
| 客户端 daemon | `daemon/` | Go (wireguard-go + pion/ice) | 跑在终端用户机器上 |
| UI 客户端 | `ui/desktop`（已落地）/ `ui/mobile`（占位） | Tauri + React / Flutter | 通过 gRPC IPC 与 daemon 通信 |
| 官网/下载页 | `ui/web` | React (vinext) + Cloudflare Workers | `npm run deploy:apex`；纯落地页，**不与 daemon 通信** |
| 共享 proto | `proto/` | Protobuf v1 契约 | 给 daemon ↔ UI 用 |

`control/`、`service/`、`relay/`、`daemon/` 各有自己的 `AGENTS.md`，改对应模块前先读。

---

## 3. 关键设计契约（违反这些会破坏跨模块假设）

### 3.1 JWT
- 控制层签发，控制层与服务层都用 **同一个 `JWT_SECRET` env var** 验证。
- 算法：HMAC-SHA256，自实现（避开依赖），见 `control/src/auth.ts`。
- 服务层 `JWT_SECRET` 必须与控制层完全一致；不一致则用户带 token 访问服务层会全部 401。
- ⚠️ 历史上 service 用过 `CONTROL_INTERNAL_SECRET` 作变量名，已统一为 `JWT_SECRET`。**不要回退。**
- 未来如果引入"控制层 → 服务层"的服务对服务认证，应该新增独立变量（建议 `INTERNAL_S2S_SECRET`），不要复用 `JWT_SECRET`。

### 3.2 VPN 地址池（U 系列后已迁段）
- IPv4：`198.18.0.0/15`（RFC 2544 基准段）。**不再用** `100.64.0.0/10`，因其与 Tailscale 默认池及中国部分大宽带 ISP 的家宽 CGNAT 同段，会被路由表/接口冲突。
- **分配从上半段 `198.19.0.0/16` 起（U3）**：Clash/mihomo 默认 `fake-ip-range` 是 `198.18.0.1/16`，恰为池的下半段，且双方都从低位顺序分配——daemon 自身的 `/32` 路由会精确遮蔽代理分给 control 域名的假 IP（表现为注册成功但 fetch-config 超时）。下半段仅作耗尽兜底，**不要把分配起点改回 198.18**。daemon 侧有配套探测：control 域名解析进池内时打 WARN 并拼进 fetch 失败错误（`controlFakeIPHint`）。
- IPv6：**部署级随机 ULA `/48`**（首次注册时由 `ipam.generateULAPrefix` 生成、`KV.vpn_ula_prefix` 持久化）。**不再用** Tailscale 的 `fd7a:115c:a1e0::/48` 字面量。
- 分配在 `control/src/peers.ts` 完成，**必须保证原子性**（DB UNIQUE + 事务 retry）。不要用纯 KV 计数器。
- 路由策略：daemon 在 connect/applyConfig 时用 `tun.SyncPeerV4Routes` 给每个 peer 装 v4 `/32` 路由（不抢 `/15` 整段），v6 在 TUN 上线时一次性装 `/48` 路由。这样与 Tailscale / ZeroTier / 任何同机 VPN 工具完全互不干扰。

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

**后端能力令牌（capability）**：自建/大厅后端由 per-backend 共享密钥门禁——
运营者在 `ourcord-filebackend --upload-secret`（或 `OURCORD_FILE_BACKEND_SECRET`）
与注册时的 `upload_secret` 设同一个值（16..128 字符）。service 把短时能力签进
上传/下载 URL：`?cap=<exp>.base64url(HMAC-SHA256(secret, storage_key\nop\nexp))`，
`op` ∈ {put, get}；签名对象是**原始** storage_key（URL 路径段做百分号编码，
后端从已解码的 `r.URL.Path` 还原）。实现见 `service/src/backends.ts`
`signBackendCapability`/`backendFileURL` ↔ `filebackend` `verifyCap`。
`upload_secret` 只进 D1、**永不出现在任何 API 响应**；空密钥 = 开放后端
（仅限 dev，服务端启动会打 WARN）。

### 3.6 信令鉴权
- `SignalDO` WebSocket 必须带 `?token=<jwt>&pk=<public_key>`。
- 控制层入口校验：JWT 合法 + `pk` 在该用户的 `peers` 表中存在。**不要在 DO 内重做校验**（DO 假设上游已认证）。

### 3.7 封禁双 key 体系（G12）
- 控制层 peers 表同时记录 `public_key`（WireGuard base64）和 `derp_node_key`（Tailscale `tailcfg.NodePublic.String()`，形如 `nodekey:HEX...`）。
- daemon 注册 peer 时**必须**同时上报两者，否则 DERP 通道封禁会失效。
- `/api/relay/banned-keys` 返回 `{keys, derp_keys}` 两个数组：`keys` 给 WireGuard 层用，`derp_keys` 给 DERP admit hook 用。
- relay `controlclient.BanList` 提供 `IsBanned` 与 `IsBannedDERP` 两个方法，分别针对两个层面。

### 3.8 D1 参数上限（G20）
- D1 prepared statement 单语句参数上限约 100 个。
- `peers` IN(?,?,...) 查询直接绑定成员 ID，对 5–10 人小群无问题；任何"成员列表→IN 查询"的实现需要在拼 SQL 前确认成员数 ≤ 100 或拆批。

### 3.9 控制 ↔ 服务层信任（G6，已升级为 HMAC 短签名）
- `SERVICE_INTERNAL_TOKEN` 仍是双方共享密钥，但**不再作为 bearer 直接发送**。
- control 每次内部调用发送 `X-Internal-Ts` / `X-Internal-Nonce` / `X-Internal-Sig`，
  其中 Sig = base64url(HMAC-SHA256(secret, `ts\nnonce\nMETHOD\npathname+search`))。
- service 校验 ±90s 时间窗 + 常数时间比较 + D1 `internal_nonces` 全局 nonce
  重放拒绝（per-isolate map 仅作快速负缓存）。
  实现：`control/src/internalAuth.ts` ↔ `service/src/internalAuth.ts`（契约需保持同步，
  标注 `TODO(proto)` 待迁 proto/）。
- 残余风险：D1 写入异常时 verifier 会降级到 per-isolate 缓存以保持可用性，
  该异常窗口内跨 isolate 重放理论上可行；需要更高保证时改为 D1 故障 fail-closed。
  旧的静态 `X-Internal-Token` 已被拒收，不要回退。

### 3.10 运营者中继凭证（ADMIN_TOKEN）
- control env `ADMIN_TOKEN` 是长期运营者凭证：官方 lobby/rental relay 在
  `/api/relay/register` 与 `/api/relay/banned-keys` 上以 `Authorization: Bearer`
  发送它（用户 JWT 寿命仅 1 小时，不适合长驻 relay）。personal 模式 relay
  仍走用户 JWT，**不要**把 ADMIN_TOKEN 下发给个人节点。
- 归属：命中时行归到 `ADMIN_USER_IDS` 的第一个 id；`ADMIN_USER_IDS` 为空则
  整体回落 JWT 校验并 401（fail-secure）。
- relay 侧从 env `OURCORD_RELAY_AUTH_TOKEN` 读取，避免凭证出现在进程参数里。
- 实现：`control/src/relay.ts` `authenticateOperatorRelay`（常数时间比较）。

---

## 4. 构建/检查命令（在 PR 前必须全部通过）

```bash
# Workers TypeScript（包管理用 pnpm；corepack 会按 package.json 的
# packageManager 字段自动取 pnpm@9，native 依赖锁文件跨平台）
(cd control && pnpm install && pnpm exec tsc --noEmit && pnpm test)
(cd service && pnpm install && pnpm exec tsc --noEmit && pnpm test)

# Go modules
(cd relay  && go build ./... && go vet ./... && go test ./...)
(cd daemon && go build ./... && go vet ./... && go test -race ./...)
(cd filebackend && go build ./... && go vet ./... && go test -race ./...)

# 整工作区
go work sync
```

测试矩阵已成形（control/service 完整 vitest、daemon 多包 race tests、relay/filebackend 单测）；新增逻辑请同步加 `_test.go` 或 vitest，不再算"脚手架"阶段。

---

## 5. 提交规范

- **Conventional Commits**：`feat:` `fix:` `docs:` `refactor:` `chore:` `perf:` `test:`
- 影响多模块时加 scope：`fix(relay): ...`、`feat(control,service): ...`
- 正文用中文或英文均可，但要解释 **为什么**，不只是 **做了什么**
- **必须** 包含 trailer：
  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  ```
- **本机 git 配置启用了 1Password ssh-sign**，非交互 shell 会因 1Password agent prompt 卡死。AI 助手提交时统一加 `--no-gpg-sign`：
  ```bash
  git commit --no-gpg-sign -m "..."
  ```
  （`-c gpg.format=openpgp -c commit.gpgsign=false` 也可，但更长。）
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
9. **`/api/relay/map` 是按调用者作用域的**（J2）：`mode='personal'` 的中转只对 owner 可见。响应不再使用全局 KV 缓存，因为它依赖 caller 身份。`relay_servers` 表规模小（操作者数量级），buildRelayMap 没有 LIMIT，规模化前要补。
10. **`/api/relay/register` 的 admin/auth 网关由 peek + clone 决定**（J10）：先 peek 一次 body 看 mode，再用 clone 走 requireAdmin/requireAuth。peek 解析失败会降级到 requireAuth（fail-secure：requireAuth 仍然成立，并且后续真读 body 也会失败被外层 catch），不是绕过点。

---

## 7. AI 助手工作建议

- **改代码前先 grep**：契约（如 `JWT_SECRET`）会跨多文件出现，统一改不要漏。
- **跨语言改动要双侧验证**：改了 control 的接口字段，relay/daemon 的 client 必须同步更新。
- **不要新增依赖**而不说明：Workers 包大小有 1MB 限制；Go 二进制要全平台编译。
- **proto/ 是 daemon ↔ UI 的事实源**：`proto/ourcord/v1/daemon.proto` 冻结稳定 IPC
  契约。当前 JSON Unix-socket IPC 是兼容层；新增稳定 UI 能力先改 proto，再在同一
  改动中更新生成绑定/兼容层。control/service 的浏览器 REST API 仍可保持 JSON。
- **plan.md 在 session 文件夹**，不要 commit 它。

---

## 8. 当前阶段

- ✅ **阶段一**：VPN 核心 + 控制层 + DERP 节点 + daemon 连接管线 + IPC + 路由（含 A-B-C 链配置能力）+ 限速 + 封禁双 key 体系 + IPAM 198.18/15+ULA 已闭环。per-peer ICE 自动直连、startup/runtime DERP fallback、1:1 pair network、service `vpn_namespace`、A-B-C next-hop 与 next-hop 后直达恢复，均已通过真实 control/service/relay/daemon + OrbStack 验证。
- ✅ **阶段二**：网络完整性与自治主线已闭环：A-B-C 拓扑计算/路由下发/daemon 连通性反馈、设备级凭证、control↔service HMAC 短签名、房间作用域 peer refresh、CLI/status、自治文件后端直传/complete/health v1 均已实现。连通性报告已用 epoch+sequence 仲裁、以 source-owned 有向边保存；direct/DERP/A-B-C/recovery 已有发布验收 workflow。路径抖动已有 per-peer 转换计数/dwell/flapping 遥测与 ICE 退避降噪；Windows Wintun 地址/路由同步（`addr_windows.go` + winipcfg）已落地并由 CI `windows-native` job 用真 Wintun 适配器验收。剩余为可选附加（Minecraft LAN）与打包/UI（阶段三/四）。
- 🚧 **阶段三**：语音 v1 已落地（逐 peer E2E 加密、RTP/UDP over overlay、jitter/loss、mute/deafen、真 Opus + malgo 音频设备与设备选择），Windows Tauri 客户端已接入正式语音 UI、VAD/PTT；视频、屏幕共享和远控待实现。
- 🚧 **阶段四**：Windows Tauri/React 客户端、NSIS 安装器、SCM 服务包装、深链登录、签名 beta 更新流水线和 mou.best 下载落地页（`ui/web`）已落地；Windows 真机发布验收、macOS/Linux/Flutter/Web 客户端与运营监控待完成。
- 📋 **阶段二可选附加**：Minecraft LAN 联机；是否作为阶段二差异化能力仍需在网络完整性主线之后确认。

判断改动归属哪个阶段，避免提前实现尚未冻结的设计。
