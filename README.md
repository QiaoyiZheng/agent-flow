# agent-flow

agent-flow 让多个 coding agent（claude、codex、omp、gemini）在各自的终端里同时干活。agent-flow 盯着每个 session 的屏幕和对话记录，有结果、提问或异常时叫醒管它们的那个 agent；权限审批和文件夹信任框则留在界面左栏"需要你"里等你处理。

有两种用法：直接派活（你正在说话的 session 用 `af task` 把快活分给新 session，结果回到它的队列），或开一个 agent team（`af team new` 起一个只路由不干活的 router agent，按剧本组织写审循环或接力）。终端和分屏由 Herdr 持久化管理，关掉浏览器或重启 `af server` 都不影响正在跑的 agent。

## 前置依赖

1. **Bun**：运行时与包管理器。
2. **Herdr**：终端与 agent 生命周期后端（`herdr` 命令在 `PATH` 中，或设 `HERDR_BIN_PATH`）。启动 agent-flow 前要先起好 Herdr（在终端跑 `herdr`）。
3. **Agent CLI**：按需安装 `claude`、`codex`、`omp`、`gemini` 中的一个或多个（确保在 `PATH` 中可用）。

## 安装与启动

在仓库根目录安装依赖并构建前端页面：

```bash
bun install
cd packages/web && bun run build && cd ../..
```

启动 `af server`（默认端口 `7477`，可用 `--port N` 或环境变量 `AF_PORT` 改）：

```bash
bun packages/cli/src/main.ts server
```

server 启动时会：
- 生成 `~/.agent-flow/bin/af`（把 `~/.agent-flow/bin` 加进 `PATH` 后即可直接运行 `af` 命令）
- 把 `agent-flow` 和 `deliver-document` skill 写进 `~/.claude/skills`、`~/.codex/skills`、`~/.gemini/skills`（对应目录存在时）
- 把随机生成的访问 token 写进 `~/.agent-flow/token`，并在终端打印带 token 的网页地址：

```
agent-flow server: 0 team(s) loaded
  UI:     http://127.0.0.1:7477/?token=<token>
  socket: ~/.agent-flow/server.sock
  af CLI: ~/.agent-flow/bin/af  (add ~/.agent-flow/bin to PATH)
```

在浏览器打开打印出来的 `http://127.0.0.1:7477/?token=<token>`（也可从 `~/.agent-flow/server.json` 查看当前运行实例的 `url`）。

## 最小例子

把 `~/.agent-flow/bin` 加进 `PATH` 后：

**方式一：在任一 agent session 里直接派活**

在 claude / codex / omp / gemini 里直接说：

> 开两个 session：claude 读一下这个仓库写出结构说明放到 notes.md，codex 跑一遍测试看看有没有挂的。

或者在你的 session 里执行命令：

```bash
af task claude "读一下这个仓库，把目录结构写进 notes.md" --name notes --no-worktree
```

新 session 会在当前 workspace 的新 tab 里跑完一轮，结果进你的队列，终端收到一行通知后执行：

```bash
af queue take
```

**方式二：开一个写审循环的 agent team**

```bash
af team new --playbook humanize-loop --goal "给 CLI 补一份简短的错误码说明文档" --cwd /path/to/repo
```

也可以在网页左栏点 `+ new` → `New team`，选目录、剧本和目标后启动。右侧泳道图会实时显示 router 和各个成员之间的工单流转。

## 开发与测试

在仓库根目录运行测试和类型检查：

```bash
bun test packages
bun run typecheck
```

前端在 `packages/web` 下，用 Vite 开发或构建：

```bash
cd packages/web
bun run dev     # 本地开发服务器 (http://localhost:5173，API 与 WebSocket 代理到 127.0.0.1:7477)
bun run build   # 构建静态文件到 packages/web/dist
```

如果在主 server 运行时要再起一个测试用的第二个 server，可设 `AF_SECOND_SERVER=1` 并指定独立的 `AF_HOME`、`AF_SOCK` 和 `--port`。

## 文档

- [使用指南（docs/usage.md）](docs/usage.md)
- [设计文档（docs/design.md）](docs/design.md)
