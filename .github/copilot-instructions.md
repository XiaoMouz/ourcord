# GitHub Copilot Instructions

**首要参考：根目录 [`AGENTS.md`](../AGENTS.md)。** 本文件不重复其内容，只补充 Copilot 特定要点。

## Copilot 提交规范

- 所有 commit 必须包含 trailer：
  ```
  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
  ```
- 本机启用了 1Password GPG 签名，使用以下命令绕过签名：
  ```bash
  git -c gpg.format=openpgp -c commit.gpgsign=false commit -m "..."
  ```
- Conventional Commits 风格，scope 标明模块（`control` / `service` / `relay` / `daemon`）。

## 工作流偏好

1. 修改代码前 `grep` 确认跨文件影响范围（尤其涉及 `JWT_SECRET`、IP 池、wrangler env、proto 字段）。
2. 改完后必须跑：`tsc --noEmit`（两个 worker）+ `go build ./...`（两个 Go module）+ `go vet ./...`。
3. 一个 PR / 一个 commit 只做一件事；docs、fix、refactor 不要混。
4. 不引入新的运行时依赖而不说明理由（Workers 包 ≤ 1MB；Go 二进制要全平台编译）。

## 关键契约速查

| 契约 | 位置 | 注意 |
|---|---|---|
| JWT secret | `control` 与 `service` 共用 `JWT_SECRET` env | 不要回退到 `CONTROL_INTERNAL_SECRET` |
| 信令鉴权 | `control/src/index.ts` SignalDO 路由 | `?token=<jwt>&pk=<key>`，DO 内不重复校验 |
| 限速 | `relay/pkg/limiter` | `NewLimitedWriter(ctx, w, l)`，禁止 nil ctx |
| IP 分配 | `control/src/peers.ts` | 必须原子（D1 UNIQUE + retry） |
| 中继链路由 | `daemon/pkg/routing/table.go` | A-B-C 通过 `AllowedIPs`，DERP 无感 |

详细背景见 `AGENTS.md` 第 3 节"关键设计契约"。
