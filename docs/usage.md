# agent-flow 使用指南

agent-flow 让多个 agent（claude、codex、omp、gemini）同时干活。每个 agent 在自己的终端里跑，agent-flow 盯着它们，有事就叫醒管它们的那个 agent。网页右侧显示谁派了什么活、做到哪了。

有两种用法：

| | 直接派活（模式一） | agent team（模式二） |
|---|---|---|
| 谁管 | 你正在说话的 session | 一个专门的 router agent |
| 适合 | 几件快活，先后由你的 session 安排 | 写 ↔ 审循环、多人接力、一直开着接活 |
| 右侧显示 | 你的 session 的时间轴 | 泳道图：router 一条线，每个成员一条线 |

## 1. 直接派活

在你平时用的 claude、codex、omp 或 gemini 里，直接用大白话说，例如：

> 开几个 session：claude 先把登录页改版拆成计划写进 plan.md，codex 按计划实现第 1 步，gemini 写一份发布说明。

这个 session 会用 agent-flow 的 skill（服务器启动时装进 `~/.claude/skills`、`~/.codex/skills`、`~/.gemini/skills`），每派一件活就执行一次：

```bash
af task claude "把登录页改版拆成 3 步，写进 plan.md" --name plan --no-worktree
af task codex  "按 plan.md 第 1 步实现" --name exec --worktree
af task claude "在 GPU 上跑 profile" --name profile --no-worktree --on allinai2plus --cwd '~/nagas'
```

- 每个 `af task` 是一张**工单**（T1、T2……）。新 session 开在同一个 workspace 的新 tab 里，任务就是它收到的第一条消息。`--to plan` 把活交给已经开过的 session，它的上下文还在。
- 新 session 是普通 session，不用学任何命令。它做完一轮后，agent-flow 从它的对话记录里取最后的回复，放进你那个 session 的**队列**，再往你的 session 里打一行：
  `[agent-flow] 1 new in your queue: T1 plan finished. Run: af queue take`
  你的 session 执行 `af queue take` 拿到结果，接着派下一步或向你汇报。
- **项目上下文（agent.md）**：你的 session 开出的每个新 session，第一件事是读这个 team 的 `agent.md`。它分两部分：上半部分是 agent-flow 写的固定规矩（怎么交结果、什么时候 `af report`），下半部分"Project context"由你的主 session 维护，放所有子 session 都该遵守的东西（范围、口径、决定、约束、数据在哪）。主 session 用 `af context` 看到要编辑的文件（`context.md`），改完存盘，几秒后 agent-flow 就把改动（连同改了哪几行）发给已经在干活的子 session；正忙的等它这一轮结束再收，因空闲被暂停的等它恢复再收。子 session 回一行"已读"，这一轮不进主 session 的队列。也可以 `af context set --file <文件>` 整个替换（远程机器上的主 session 只能用这个）。
- **上下文快满时交接（handoff）**：主 session（派过活的那个）每做完一轮，agent-flow 就从它的对话记录里看上下文用了多少（就是界面底部那个上下文条）。到 80% 时，agent-flow 往里打一条请求：用 `handoff` skill 把交接文档写到给定路径（`~/.agent-flow/handoffs/` 下），再运行 `af handoff ready <文档>`。这一轮结束后由 agent-flow 接手：先关掉它开过的、已经没事可做的子 session（结果已取走、没在干活）；还在干活的、结果还没取的、你正在跟它聊的、代表整个 team 的都留着；再关掉主 agent，在同一个 pane 里用同样的参数开一个新会话，第一条消息让它先读交接文档，并列出关掉了谁、谁还在跑。新会话仍是这些子 session 的主 session，它们的结果照常进它的队列。你随时也可以直接说"交接一下"。阈值在 `~/.agent-flow/config.json` 里改：`{"handoff": {"at": 0.7}}`；`{"handoff": false}` 关掉自动请求（手动交接还能用）。旧会话的记录还在，新会话需要时可以去里面查。
- 结果交回以后，你可以直接去那个 session 跟它聊（问问题、讨论）。这些对话**不会**每轮都转给你的主 session；只有聊出了项目进展或口径（范围、表述、决定、数字）的变化，它才用 `af report "<变了什么>"` 告诉主 session（任务的第一条消息里写了这条规矩）。主 session 用 `af tell` 交给它的新活，结果照常回队列。
- 队列里还会出现：某个 session 屏幕上在问和任务有关的问题（你的 session 用 `af answer T2 <选项号>` 回答）、可能卡住了、进程退出了、API 报错（agent-flow 已经自动让它"继续"过 3 次）。
- **权限审批和"信任这个文件夹"永远只交给你**：出现在左栏"需要你"里，你的 session 碰不到。
- **在 git 仓库里，每个新 session 都要选 `--worktree` 或 `--no-worktree`**，不选 af 会拒绝。`--worktree`：在自己的 git worktree 和分支（`af/<team>/<名字>`）上改，适合几个 session 同时改同一个仓库；agent-flow 不合并，分支名在工单里，要不要合由你决定。`--no-worktree`：直接在目录里干活（只读的活，或只有它在改）。
- `--on <机器> --cwd '<那台机器上的目录>'`：把它开在一台已连接的 SSH 机器上（GPU、数据、那边的代码）。它在那台机器上 team 自己的 workspace 里跑，结果照样回到你的队列。`--cwd` 里的 `~` 要加引号，才表示那台机器的 home。
- `--prepare "<命令>"`（可选，默认没有）：启动前在它的目录里跑一次，比如装依赖。输出在工单的 `prepare.log`，失败时工单标为 failed。

右侧时间轴：竖线是你的 session，每张工单是挂在派出时间上的一个框，结果回来时有一行 "◀ T1 plan: …" 回到竖线上。点框看工单（任务、结果、它的终端），"Go to its pane" 跳过去。一个 session 自己又派了活，它的框上有 ⊕，点开是它的时间轴。

## 2. agent team

在 session 里说"开个 agent team，写和审循环，给登录页加验证码"，它会执行：

```bash
af playbook list
af team new --playbook humanize-loop --goal "给登录页加验证码"
```

也可以在网页左栏 "+ new" → New team 里开：选目录（可点 Browse… 在文件浏览器里选文件夹）、剧本、目标、router 用哪种 agent。点 "+ new" → New workspace（或机器行上的 "+"）新建普通 workspace：本地机器上会在 shell 旁边打开这个文件夹的查看器 pane。`af team new --on <机器> --cwd '<目录>'` 把 router 开在远程机器上。

远程机器上你自己开的 session 也能直接派活：agent-flow 连上一台机器后，会在那边放一个 `~/.agent-flow/bin/af`（经 SSH 转给 Mac 上的 server），并把 agent-flow skill 装进那边的 `~/.claude/skills`、`~/.codex/skills`、`~/.gemini/skills`（有这些目录时）。那边能用的只有派活、工单、队列、`af machines` 这些命令。

- agent-flow 新开一个 workspace，起一个 **router**。router 只路由不干活：按剧本开成员、开工单、把一个成员的结果交给下一个成员、数循环的轮数、在需要你拍板时汇报。
- 成员之间不直接说话。成员做完写 `result.md`，执行 `af submit`；结果进 router 的队列，由 router 决定下一步交给谁。
- 在你的 session 的时间轴上，整个 team 是一个框。router 的汇报进你的 session 的队列；网页里开的 team 的汇报进"需要你"。要给 team 加要求：`af tell <那张工单> "再加一个暗色模式"`。
- 循环有上限：用 `--from` 串起来的工单是一个线程，router 开线程时定最多几轮（默认 3，humanize-loop 是 5）。到上限时 router 开不了新工单，"需要你"里出现一条；要继续就 `af thread max <T> <N>`。

内置剧本：

| id | 做什么 |
|---|---|
| `humanize-loop` | 一个写，另一个（不同种类的 agent）独立审；不通过就带着意见回去改，最多 5 轮 |
| `super-agent` | router 一直开着，每个新要求一张工单，交给合适的成员，做完汇报，等下一个 |
| `bugfix` | 复现 → 修复（带回归测试）→ 独立验证；不过就打回修复，最多 3 轮 |
| `compare-plans` | codex、claude 各出一份方案 → 比较定稿 → 实现 → 审查循环 |
| `research-write-review` | 调研 → 写作 → codex 严格审稿；不过就重写，最多 2 轮 |

自己写剧本：一个 markdown 文件，头部写 `name` 和 `description`，正文用文字写角色和规则。放在 `~/.agent-flow/playbooks/<id>.md`（所有项目可用）或 `<仓库>/.agent-flow/playbooks/<id>.md`（只在这个项目里，可以提交共享）。同名的覆盖内置的。

## 工单文件夹

每张工单在 `~/.agent-flow/teams/<team>/tickets/T3/`：`task.md`（要做什么）、`result.md`（做完的结果）、`files/`（其他交付文件）。成员之间交接的其他文件放 `$AF_OUT`（`~/.agent-flow/teams/<team>/out/`）。所有变化记在 `events.jsonl` 里，server 重启后队列、工单、通知都接得上。

## 打开文件、交付文档

- **打开文件**：pane 的 ＋ → "open a file, folder or page…"。预览顶栏有 Obsidian / VS Code / Open / Finder 按钮。
- **agent 写完文档会交给你**：`deliver-document` skill 让 agent 执行 `af deliver <文件>`（一轮结束时改过的文档也会自动记录），在聊天视图里那个 agent 的回复下面出现一行，带 Obsidian / VS Code / 默认应用（Open）/ Finder / 旁边预览（Preview）这些按钮，不会自动开查看器 pane，不进"需要你"，也不发通知。⚙ 里可以设成直接打开、按文件类型选应用。
- 远程机器上的文件只能用 VS Code（Remote-SSH）打开。

## 常用命令速查

| 做什么 | 命令 |
|---|---|
| 派一件活 | `af task <claude\|codex\|omp\|gemini> "…" --worktree\|--no-worktree [--name N] [--on 机器 --cwd D] [--prepare "…"]` |
| 看 `--on` 能用的机器 | `af machines` |
| 给已有的 session 更多活 | `af task --to <名字> "…"` · `af tell <工单\|名字> "…"` |
| 看 / 取队列 | `af queue` · `af queue take` |
| 回答成员屏幕上的问题 | `af answer <工单\|名字> <选项号> [--text "…"]` |
| 看某个成员在干嘛 | `af status <名字>` · `af read <名字>` |
| 工单 | `af tickets` · `af ticket show <T>` |
| 开 team | `af playbook list` · `af team new --goal "…" [--playbook P]` |
| router 用 | `af ticket open/close` · `af reply <seq>` · `af report "…" [--done]` · `af thread max` · `af queue done <seq>` |
| 成员用 | `af submit --status ready\|blocked\|failed\|dropped --note "…"` · `af progress` · `af ask` |
| 停掉 team | `af team stop [<team>]`，或关掉它的 workspace |
| 交接给新 session | `af handoff`（给出交接文档的路径）· `af handoff ready <文档>`（写好后运行；agent-flow 在这一轮结束后重开这个 session） |
| 项目上下文 | `af context`（看要编辑的文件和当前内容）· `af context set "…"` / `--file <文件>` |
| 交付文档 / 打开文件 | `af deliver <文件> --title "…"` · `af open <文件> [--app vscode\|obsidian\|default\|finder]` |
| 完整说明 | `af guide router` · `af guide member` · `af help` |
