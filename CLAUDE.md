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
| VPN IP 池 | `198.18.0.0/15` + 部署级随机 ULA `/48` | RFC2544 v4 + 自生成 ULA；避 Tailscale/ISP CGNAT 冲突 |
| 中继链 | WireGuard `AllowedIPs` | DERP 不感知拓扑 |
| 文件优先级 | 自建 → 分享 → 大厅 → R2 | R2 受配额控制 |

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

阶段一已按当前验收口径闭环：per-peer ICE、startup/runtime DERP fallback、1:1 pair network、service `vpn_namespace`、A-B-C next-hop 与恢复都已通过真实 control/service/relay/daemon + OrbStack 验证。阶段二主线已大部分落地；连通性上报已采用 epoch+sequence 仲裁与 source-owned 有向边，direct/DERP/A-B-C/recovery 已有发布验收 workflow。剩余重点是 Windows Wintun、路径抖动观测与降噪；自治文件后端已有直传/complete/health v1。改动前判断归属哪个阶段，不要提前实现阶段三/四（媒体、UI）的内容。Minecraft LAN（M 系列）属阶段二可选附加。
