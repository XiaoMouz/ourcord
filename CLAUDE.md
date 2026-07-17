# Claude Code Instructions

**首要参考：根目录 [`AGENTS.md`](./AGENTS.md)。** 本文件不重复其内容，只补充 Claude Code 特定偏好。

## Claude Code 工作偏好

- **复杂改动先在 PLAN 模式（Shift+Tab）**写计划到 `~/.copilot/session-state/<id>/plan.md`，与用户对齐后再退出 plan 模式开干。
- **优先并行工具调用**：读多个文件、跑多种 lint/build 时一次性发起，别串行。
- **任务分发优先级**：简单文件改动自己做；多文件跨模块研究用 `explore` agent；非平凡设计/实现先过 `rubber-duck`。
- **plan.md 是 session 私有的，永远不 commit**。

## Commit 规范

- Conventional Commits + scope（`control` / `service` / `relay` / `daemon`）
- 必须包含 trailer：
  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  ```
- 本机启用 1Password ssh-sign，非交互会卡。统一加 `--no-gpg-sign`：
  ```bash
  git commit --no-gpg-sign -m "..."
  ```

## 关键契约速查

| 契约 | 位置 | 备注 |
|---|---|---|
| `JWT_SECRET` | control + service 共用 | 不要再叫 `CONTROL_INTERNAL_SECRET` |
| SignalDO WS 鉴权 | `control/src/index.ts` | `?token&pk`，DO 假设上游已校验 |
| limiter ctx | `relay/pkg/limiter` | 禁止 nil context |
| VPN IP 池 | `198.18.0.0/15` + 部署级随机 ULA `/48` | 分配自 `198.19.0.2` 起（避 Clash fake-ip 默认段）；避 Tailscale/ISP CGNAT 冲突 |
| 中继链 | WireGuard `AllowedIPs` | DERP 不感知拓扑 |
| 文件优先级 | 自建 → 分享 → 大厅 → R2 | R2 受配额控制 |
| 运营者中继凭证 | control `ADMIN_TOKEN` ↔ relay `OURCORD_RELAY_AUTH_TOKEN` | lobby/rental 长驻节点用；personal 仍走用户 JWT |

详细背景见 `AGENTS.md` 第 3 节。

## 构建/检查（PR 前必跑）

```bash
# Workers 用 pnpm（corepack 自动取 package.json 里 pinned 的 pnpm@9）
(cd control && pnpm exec tsc --noEmit)
(cd service && pnpm exec tsc --noEmit)
(cd relay   && go build ./... && go vet ./...)
(cd daemon  && go build ./... && go vet ./...)
```

## 当前阶段

阶段一已按当前验收口径闭环：per-peer ICE、startup/runtime DERP fallback、1:1 pair network、service `vpn_namespace`、A-B-C next-hop 与恢复都已通过真实 control/service/relay/daemon + OrbStack 验证。阶段二主线已闭环：连通性 epoch+sequence 仲裁 + source-owned 有向边；Windows Wintun 地址/路由（`addr_windows.go` winipcfg + CI `windows-native`）；路径抖动 per-peer 遥测 + ICE 退避降噪 + control 端 flap 仲裁；自治文件后端直传/complete/health；direct/DERP/A-B-C/recovery 有可重复发布验收 workflow（`tests/e2e/smoke_abc_netns.sh`，已 de-flake）。部署遵循 migrate-before-deploy（`docs/ops/release.md` + Deploy workflow）。

客户端已把 **UI 无关的核心** 抽到 `daemon/pkg/client`（typed ops + 设备/诊断 + `Watch` view-model）；IPC 传输已从 JSON 换成 **gRPC over 认证 UDS**（`proto/ourcord/v1`，bindings 提交在 `daemon/pkg/pb`，CI diff 校验）。`ourcord-cli`/`ourcord-tui` 只是 presenter，共用同一核心——阶段四多平台 GUI 的复用底座，**presenter 里不要写 daemon 逻辑**（详见 `docs/ui/client-core.md`）。

阶段三媒体：**语音 v1 已落地**（`daemon/pkg/media`，engine+E2E 加密+relay 验收，`ourcord-cli voice`），Windows Tauri 客户端已接入正式语音 UI（VAD/PTT）。默认构建 PCM 纯 Go/CGO=0；真 Opus+硬件音频和设备列举/切换在 `voice` tag 后（cgo，见 `daemon/AGENTS.md`）。剩余阶段三：视频/屏幕共享/远控。

阶段四已开工：Windows Tauri/React 客户端（`ui/desktop`）、NSIS 安装器、SCM 服务包装、深链登录、签名 beta 更新流水线（`desktop-release.yml`）与 mou.best 下载落地页（`ui/web`，与 daemon 无 IPC）已落地；桌面客户端已对齐 Discord 操作体验：文字房间聊天+附件（收发，走 service files API 分层上传/下载）、成员列表、房间管理+拖动排序、音频设备选择、显示名编辑、加载骨架屏/语音连接态、逐参与者连接质量（信号格）、常驻语音状态栏、连接诊断面板（peer 详情/force-derp/ping/传输计数/设备吊销，对齐 TUI/CLI 深度）、应用内弹窗替代浏览器 prompt/confirm、右键上下文菜单。Tauri 壳 ↔ Go bridge 为**常驻 sidecar**（NDJSON + id 关联，别改回每调用 spawn，见 `ui/desktop/README.md`）；文件传输走 bridge 独立无超时 HTTP client，语音偏好持久化在前端 localStorage（daemon 不回报 threshold）。Windows 真机发布验收、macOS/Linux/Flutter/Web 客户端与运营监控待做。UI 一律作为 presenter 复用 `daemon/pkg/client` 核心。

Minecraft LAN 属阶段二可选附加（注意：近期 commit 里的 M1–M3 指语音里程碑，不是 Minecraft 系列编号）。
