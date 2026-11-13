# agent-flow 设计文档

状态：v0 设计 2026-11-02 定；2026-11-04 把 run + 图重构成两种模式（第 4–9 节）。实现中发现与本文冲突的地方，先改本文，再改代码。

## 1. 要解决什么

一个"harness 的 harness"：

- 让人和 AI 都能**自由组合** coding agent（claude、codex、omp……）。
- 一个总控 agent 可以指挥多个下属 agent，彼此之间用很轻的方式通信。
- 有一套 **CLI + skill**，agent 之间能互相控制。
- 每个 agent 都有好看的 UI；终端是持久化的。

设计时始终记住一个前提：**人的注意力是瓶颈。** DeepSeek Super-Agent 给出的估计是，一个人同时只盯得住 3–5 个 agent session。所以 UI 的重点是"现在谁需要我"，而不是把所有终端平铺出来；调度的重点是尽量不叫醒总控和人。

## 2. 总体架构

```
浏览器 UI (React + xterm.js + React Flow)
        │ WebSocket（只监听 127.0.0.1，校验 Origin + token）
        ▼
af server（Bun）─────────────── af CLI（agent 和人都用它）
  · Herdr 适配层                    │ HTTP over Unix socket
  · team / 工单 / 队列              │
  · 监视成员、送达通知              │
  · events.jsonl                   │
        │ JSON socket API + terminal session observe/control
        ▼
Herdr server（原版，不 fork）
  · 持久化 PTY、pane / tab / workspace
  · 23 种 agent 的状态识别（idle / working / blocked / done）
  · worktree 创建
```

**原则：**
- Herdr 负责终端和 agent 生命周期；agent-flow 负责派活、监视、通知、UI。
- 所有对 Herdr 的调用都经过适配层（`server/src/herdr/`），以后可以换成 tmux 或自研的 PTY server。
- 浏览器关掉或 af server 崩掉，agent 照常运行。af server 重启后从磁盘恢复状态，并和 Herdr 的实际状态对一遍。

## 3. 为什么用 Herdr

| 方式 | 结论 |
|---|---|
| Herdr 插件 | 不行：插件 v1 不支持非终端 UI，只能开终端 pane、换主题色 |
| Fork Herdr | 不选：Rust 0.x，更新快，合并上游痛苦；改完仍是 TUI |
| **原版 Herdr 当后端，另写前端** | **选这个**：Herdr 的 server 与界面是分开的，官方为第三方 bridge 提供了 `terminal session observe/control` |

已实测：`herdr terminal session observe <pane>` 输出 NDJSON 格式的 `terminal.frame`，字段有 `bytes`（base64 编码的 ANSI 字节）、`width`、`height`、`full`、`seq`，可以直接交给 xterm.js 渲染。Herdr 用 Apache-2.0 许可证。

### 3.1 终端流的实测结论（见 `spikes/s1-terminal/RESULT.md`）

- 流里是 **Herdr 渲染后的画面差分**，不是 PTY 原始字节。`seq 1 200000` 只产生 18 帧、8.8 KB，浏览器不会有压力。
- 浏览器端 xterm.js 的 `scrollback` 设为 0。滚轮转成 `terminal.scroll {direction, lines}` 发给 Herdr，由 Herdr 渲染滚动后的画面。完整历史用 `pane read --source recent-unwrapped`。
- 输入：`terminal.input {text}` 或 `terminal.input {bytes: base64}`。
- 控制端声明的 cols/rows 就是 PTY 的实际尺寸。同一个 tab 被多个客户端看时，最后操作的那个决定尺寸，所以**每个 run 用自己的 Herdr workspace**，不和用户的 TUI 共用 tab。
- 一个终端同时只能有一个 controller。正在看的终端用 `control`，缩略图和预览用 `observe`。
- terminal session 不在 JSON socket API 里。server 给每个打开的终端起一个 `herdr terminal session control|observe` 子进程，只给正在看的终端起。
- 单键回显延迟：p50 19 ms，p90 21 ms。

## 4. 两种模式（2026-11-04 重构，替换原来的"run + 图"）

原来的 run 是"lead 建一张图，server 按依赖自动派发，lead 逐个 accept/reject，每个节点一条 git 分支，accept 时自动合并"。对快速派活太重；循环靠图引擎的回边，也不灵活。重构后分两种模式，共用一套基础：**一个 session 开出新 session，agent-flow 盯着它们，有事就叫醒管它们的那个 agent。** 两种模式只差"谁来管"：

| | 模式一：直接派活 | 模式二：agent team |
|---|---|---|
| 谁管 | 用户正在说话的 session（主 agent） | 一个专门的 router agent |
| 怎么开始 | 主 agent 调 `af task` | 用户的 session 调 `af team new`，或网页 "New team" |
| 成员 | 普通 session，不注入协议 | 注入成员协议，用 `af submit` 交结果 |
| 结果怎么回来 | 成员做完一轮，agent-flow 从对话记录取最后的回复 | 成员 `af submit`；没交就算"做完一轮没提交" |
| 成员之间 | 不通信，由主 agent 安排先后 | 不直接通信，一切经过 router 的队列 |
| 界面 | 主 agent 的竖时间轴，每张工单一个框 | 泳道图：router 一条线，每个成员一条线 |

### 4.1 概念

| 概念 | 含义 |
|---|---|
| **team** | 一个管理者和它开出的所有工单。模式一的 team 在主 agent 第一次 `af task` 时自动建，挂在它的 pane 上；模式二的 team 有自己的 Herdr workspace |
| **管理者（manager）** | 收队列的那个 agent：模式一是主 agent，模式二是 router |
| **成员（member）** | team 里被派活的 session。一个成员可以先后做多张工单，上下文连续 |
| **工单（ticket）** | 让一个成员做一件事。T1、T2…… 每张工单一个文件夹 |
| **线程（thread）** | 用 `--from` 串起来的一串工单（一个循环）。管理者开线程时定最多几轮 |
| **队列（queue）** | 每个管理者一个，只有 server 往里写：成员交结果、提问、卡住、退出，用户的新要求 |
| **剧本（playbook）** | 模式二里 router 照着做的一份 markdown：角色、规则、什么时候向用户汇报 |

### 4.2 存储

```
~/.agent-flow/teams/<team>/
  events.jsonl        所有变化，只追加；唯一的事实来源
  team.json           当前状态的快照（server 每次变化后写，给人看）
  out/                $AF_OUT：成员之间交接的其他文件
  tickets/T3/
    task.md           管理者写：要做什么（名字固定）
    result.md         成员写：做完的结果（名字固定）
    files/            其他交付文件
```

- 状态由 `events.jsonl` 回放得到（`packages/core/src/team.ts` 的 reducer，server 和网页共用），server 重启不丢东西。实现在 `packages/server/src/teams.ts`，测试在 `packages/server/test/teams.test.ts`。
- 工单状态：`open`（已派出，还没送到）→ `working`（已送到成员）→ `submitted`（结果在队列里等管理者）→ `closed`（`done` / `failed` / `dropped` / `cancelled`）。
- **关掉的工单不再改。** 要返工就开新工单，`--from` 指向原来那张，交给同一个成员 session。`--from X` 开新工单时，X 如果还是 submitted 就自动关成 done。
- **线程和轮数**：工单的 thread = `--from` 那张的 thread，没有 `--from` 就是它自己。轮数 = 线程里分给同一个成员的工单数。线程的上限在第一张工单上用 `--max` 定（默认 3），`af thread max <T> <N>` 改。到上限后 server 拒绝再开，并在"需要你"里放一条。
- 旧的 `~/.agent-flow/runs/` 留在磁盘上，网页不再显示（显示要保留整套图引擎）。

### 4.3 模式一：直接派活

```bash
af task claude "把登录页拆成 3 步，写成 plan.md" --name plan
af task codex  "按 plan.md 第 1 步实现" --name exec --worktree
af task gemini "根据 plan.md 写一份发布说明" --name write
```

- 第一次调用时自动建 team，不用先 `af here`。新成员开在主 agent 所在 workspace 的新 tab 里，任务就是它收到的第一条消息（末尾加一句"最后用几句话总结结果"）。
- 成员默认在主 agent 的目录里工作。**在 git 仓库里，新成员必须选 `--worktree` 或 `--no-worktree`**（2026-11-04 用户要求：不替它猜，每个都问）：`--worktree` 在 `<repo>/.agent-flow/worktrees/<team>/<成员>` 开 worktree，分支 `af/<team>/<成员>`，从主 agent 目录当前的 HEAD 切出，用于几个 session 同时改同一个仓库；`--no-worktree` 就在目录里工作（只读的活，或只有它在改）。都不给时 af 拒绝，并说明怎么选；拿不准就问用户。**不自动合并**，分支名写在工单里。不在 git 仓库里时不用选。
- `--prepare "<命令>"`（可选，默认没有）：成员启动前在它的目录里跑一次（装依赖、链数据）。最多 10 分钟，输出存进工单的 `prepare.log`；失败时工单关成 failed，管理者在队列里收到最后几行。用户的意见：大多数活用不上，所以不设默认的准备脚本。
- `--on <机器> [--cwd <那台机器上的目录>]`：成员开在一台已连接的 SSH 机器上，见 4.8。
- `af task --to plan "…"` 把新工单交给已有的成员（同一个 session）；`af tell T1 "…"` 在同一张工单上追加要求。
- 成员做完一轮（working → idle/done，6 秒后仍空闲且无后台任务、屏幕上也没有提示或提问，防止状态抖动），agent-flow 从它的对话记录里取这一轮最后的回复，写进 `result.md`，工单变 submitted，队列里进一条 `turn`。对话记录里找不到回复时，标明没有找到回复并附上屏幕最后 25 行。
- 模式一里 `af queue take` 取走即算处理完；工单不需要显式关闭。
- **agent.md**（`server/src/context.ts`）：每个 team 的文件夹里有 `agent.md`，成员拿到第一张工单时先读它。静态部分由 agent-flow 生成（模式一：交结果的方式、`af report` 的规矩；模式二：照成员协议办），每次派工单时按当前版本重写；动态部分"Project context"来自同一文件夹的 `context.md`，由管理者编辑（`af context` 给出路径）。server 每秒看一次 `context.md`，内容变了且 3 秒内没再变，就写进 `agent.md`（`context.published.md` 记着已发出的版本），并给每个读过 agent.md、还在的成员排一条 `context` 消息：读哪一部分、改了哪几行（逐行增删，最多 1500 字）。成员空闲时打进去；还没送出的旧消息被新消息替换（`message.dropped`）；因空闲被暂停的成员不叫醒，恢复后再送。远程成员的 agent.md 在它那台机器 `~/.agent-flow` 下同样的位置，派工单和送 context 消息前拷过去，里面的 af 路径是那台机器的。成员回应 context 消息的那一轮不进管理者的队列：结果取走后它为此重新干活（`ticket.resumed`），这一轮最后一条打进去的消息是 context 消息，就把工单直接再关上。
- **交接（`server/src/handoff.ts`）**：主 session（模式一的管理者）每次状态变化后看一次上下文用量（`peek.ts` 从对话记录的 meta 里取 contextTokens/contextWindow，和界面底部的上下文条同源；claude、codex、gemini 有窗口大小，omp 没有，所以 omp 不会被自动请求）。用量 ≥ `at`（默认 0.8，`config.json` 的 `handoff.at`）且它空闲、用户没在打字时，打一条请求，给出文档路径（`~/.agent-flow/handoffs/<时间>-<workspace>.md`，远程机器上在那台机器的同一位置）；同一会话再涨 5 个百分点才再请求一次，用量掉下去（压缩过）就重新计。`af handoff ready <文档>` 检查文档存在且非空，记下时间，并 hold 这个 pane（`Workspaces.hold`：agent-flow 不再往里打队列通知和排队消息）。这之后它的一轮结束（空闲、没在等后台任务、输入框空、用户没在打字），agent-flow：1）`Teams.closeFinished` 关掉它开过的、已经没事的子 session：所有工单都 closed、没有待送消息、没在干活、不代表整个 team、用户没在跟它聊（最后一张工单的关闭说明是"the user talked with it"，或 10 分钟内在它的网页终端按过键）；先标 exited 再关 pane，所以不会进"exited"队列项；2）`Workspaces.replaceAgent`：Ctrl+C 两次（再 TERM）结束旧进程，在同一个 shell 里用 `freshArgs`（启动参数去掉 --resume/--session-id 等只属于一个会话的，claude 加新的 --session-id 和 agent-flow 的 hook）开新会话，等到输入框出现；3）把接手消息作为第一条打进去：读文档、旧会话记录的路径、关掉了谁、谁还在跑（工单号、状态）。pane 不变，所以新会话还是那个 direct team 的管理者，还在跑的子 session 的结果进它的队列。team 成员和 `af task` 开的 session 不交接（由派活的 session 换新的）。
- **Refresh 和 close idle**：Refresh（`POST /pane/refresh`，`Handoffs.refresh`）往 session 里发一条和上下文快满时同样的交接请求（空闲时马上发，忙时进 agent-flow 的排队消息），之后走同一条交接流程。close idle（`server/src/idle.ts`，`GET /idle`、`POST /idle/close`）列出所有已连接机器上：team 成员中 `Teams.keepReason` 为空的（不代表整个 team、没在干活、用户没在它终端里按键、team 已停止或：模式一里没有未关的工单、结果已取、没有待送消息；router team 还在跑时成员一律保留），以及单独占一个 tab、前台只有 shell 的 pane；跳过预览 pane、持久 shell 的 workspace、会让 workspace 没有 tab 的那个。用户直接聊过的成员（`Teams.talkedWith`：事件里有"the user talked with it"，或它对话里有既不是 agent-flow 也不是派活的人打进去的消息）带 `talked`，界面默认不勾。关之前再列一次，只关仍然空闲的；成员先标 exited 再关 pane（不进"exited"队列项），输入框里有字的跳过。交接时关子 session 用同一套规则，外加聊过的保留。
- 读"最后一轮回复"（`transcripts/peek.ts`）时，agent-flow 自己打进去的消息（以 `[agent-flow]` 开头，界面上显示成提示）也算一轮的开头，不只是用户消息。
- 模式一里结果取走后成员又干起活来（后台任务叫醒它，或用户直接跟它说话），工单重新打开（`ticket.resumed`）。这一轮结束时看它对话记录里最后一条用户消息：不是 agent-flow 打进去的（任务、`af tell`、"continue"），而且写在结果取走之后，就算用户自己的对话：不进队列，工单直接再关上。成员自己判断聊出了进展或口径变化时用 `af report "…"` 告诉主 agent（任务消息末尾写了这条规矩）。后台任务叫醒的那一轮没有新的用户消息，结果照常进队列。

### 4.4 模式二：agent team 和 router

```bash
af team new --playbook humanize-loop --goal "给登录页加验证码" [--router claude] [--name captcha]
```

- agent-flow 新开一个 workspace，起 router（默认 claude，注入 `packages/skill/router.md`），第一条消息是目标和剧本的路径。在调用者自己的 team 里同时开一张工单，执行者就是这个 team：调用者的时间轴上整个 team 占一个框，点进去是泳道图。
- router 自己不写代码也不写文档，只做这些事：开成员和工单、决定下一步交给谁、管轮数、回答成员的问题、向用户汇报。
- 成员（注入 `packages/skill/member.md`）收到工单后读 `task.md`，做完写 `result.md`，然后 `af submit --status ready|blocked|failed|dropped --note "…" [--to <成员>]`。`--to` 只是建议，下一步给谁由 router 决定。中途可以 `af progress "…"`（只更新工单，不进队列），有问题 `af ask "…"`（进队列，等 router `af reply`）。
- router 向用户汇报用 `af report "…" [--done]`：进调用者的队列；`--done` 把调用者那张工单交成 ready。网页里开的 team 没有调用者，汇报进"需要你"。
- 调用者对 team 工单 `af tell T5 "再加一个暗色模式"`，router 的队列里进一条 `user`（排在最前）。这样 router 可以一直开着接新活（super agent 剧本）。
- 剧本：内置 `packages/skill/playbooks/*.md`（humanize-loop、super-agent、bugfix、compare-plans、research-write-review），用户的 `~/.agent-flow/playbooks/`，项目的 `<repo>/.agent-flow/playbooks/`，同名的后者覆盖前者。原来的 4 个 workflow 模板改写成了剧本。

humanize loop 用工单走一遍：

```
T1 coder     写第 1 版         submit → #1 → router 开 T2（--from T1，线程 T1，--max 5）
T2 reviewer  审 T1             submit fail → #2 → router 开 T3（--from T2）
T3 coder     按 T2 的意见改     submit → #3 → router 开 T4
T4 reviewer  审 T3             submit pass → #4 → router 关 T4，af report --done
```

### 4.5 队列

一条队列项：

```json
{ "seq": 17, "kind": "submit", "ticket": "T2", "from": "coder", "to": "reviewer",
  "text": "第 1 版写完，测试过了", "state": "queued" }
```

- 种类：`user`（用户或上级的新要求）、`ask`（成员提问）、`asking`（成员屏幕上有任务相关的提问）、`approval`（成员屏幕上有权限审批或等按键的提示，需等用户处理）、`stuck`（可能卡住）、`exited`（进程退出）、`error`（API 错误重试 3 次仍失败）、`submit`（成员交结果）、`turn`（做完一轮：模式一是结果，模式二是"没提交"）、`report`（下级 team 的汇报）。
- 状态：`queued` → `taken` → `handled`。
- **一次取走全部**（借鉴 Super-Agent 的批处理）：`af queue take` 取走所有 queued 项，按 user > ask/asking/approval/stuck/exited/error > submit/turn/report、同类按先后打印。每项带工单号、成员、前 400 字和文件路径（全文按路径读）。
- 模式二里每一项都要用一个动作结束：对它的工单 `af ticket open --from` / `af ticket close` / `af reply` / `af answer` / `af tell`，或 `af report`、`af queue done <seq>`。对某张工单做了动作，这张工单已取走的项都算处理完。router 空闲了手上还压着取走没处理的项，server 提醒一次，再不处理就进"需要你"。
- **通知**：管理者空闲、屏幕上没有菜单或面板、队列里有没通知过的项时，往它的终端打一行：`[agent-flow] 3 new in your queue: T2 reviewer submitted; T3 coder asking. Run: af queue take`。它忙时只排队，不重复通知。通知打出去 30 秒内它没开始工作，再打一次；两次都没反应就进"需要你"。server 重启后，没通知过的项照样会通知。

### 4.6 监视成员

server 每秒看一次 Herdr 的状态，再加上屏幕和对话记录：

| 看到什么 | 怎么做 |
|---|---|
| 做完一轮 | 见 4.3（模式一）；模式二里没 `af submit` 就等 20 秒，进一条 `turn`（"做完一轮没提交"，带最后的回复）。**判定做完前先读一次屏幕**：如果屏幕上有提问或提示（包括等按键的提示，如 claude 的 auto mode 计费通知"Enter to continue"，此时 Herdr 可能报 `done`），**不算这一轮做完** |
| 屏幕上有提问或提示 | 任务本身的问题（"用 A 还是 B"）进队列（`asking`），管理者 `af answer <工单> <选项号> [--text …]` 回答（和用户在卡片上点选一样：先确认菜单没变，再按键）。**权限审批、"信任这个文件夹"和等按键的通知面板**由用户在界面处理（连续两次检查仍在屏幕上的等按键提示也会把 pane 标为 `asking`，workspace 显示 blocked，进"需要你"并挡住队列投递）；成员遇上这类提示时，管理者的队列只收到一次 `approval` 知会（告知成员正在等用户按键、不要代答） |
| 还在工作中，但对话记录 10 分钟没有变长 | 进一条 `stuck`，带屏幕最后几行；同一段只报一次 |
| 进程退出 | 进一条 `exited` |
| 一轮以临时错误结束（429、5xx、overloaded、连接被重置、超时） | 自动打一句"继续"，最多 3 次；还不行进一条 `error` |
| 成员 session 是 server 重启前在工作的 | 重新送达时附一句恢复说明："先看看你的目录和 git 历史，再决定要不要重做对外的操作" |

- 一个成员同时只做一张工单：后开的工单排着，等它交了前一张、空闲了再送。
- 送达和通知都**先记进 events.jsonl 再做**：`ticket.delivered`、`queue.notified` 只在打字成功后记；agent 开着菜单或面板时等着，下一秒再试。

### 4.7 工单阶段（界面用的唯一判断）

按顺序检查，取第一条符合的（`packages/core/src/team.ts` 的 `ticketStage`）：

1. 送达失败 → `undelivered`
2. 成员屏幕上有提问 → `asking`（权限审批是 `approval`）
3. 已交、status ready → `review`（等管理者看）
4. 已交、blocked / failed → `blocked` / `failed`
5. open（还没送到）→ `queued`
6. working、成员在工作 → `working`
7. working、成员空闲 → `idle`
8. closed → `done` / `failed` / `dropped` / `cancelled`

时间轴的框、泳道图、"需要你"都用这一个函数。

### 4.8 远程机器上的 team（2026-11-04）

用户要求三步都做：

1. **Mac 上的 session 把成员开在远程。** `af task claude "…" --on allinai2plus --cwd '~/nagas'`。成员开在那台机器上 team 自己的 workspace 里（第一次用这台机器时建），命令、GPU、文件都在那台机器上。监视（屏幕、对话记录、后台任务）走已有的 SSH 连接；结果拷回 Mac 上 team 的文件夹。
2. **router 的成员开在远程。** 同上，另外：成员的协议文件、codex 的 profile 写在那台机器上；`task.md` 和输入在送达前拷到那台机器的 `~/.agent-flow/teams/<team>/tickets/<T>/`，成员 `af submit` 时 server 把那边的 `result.md` 拷回 Mac。
3. **远程的 router 或 session 自己派活。** `af team new --on <机器>` 把 router 开在远程；远程机器上用户自己开的 session 也能直接 `af task`，它的成员默认开在同一台机器上。

**远程的 `af`**（`packages/server/src/remote-af.ts`）：
- 每台连上的机器，server 在 Mac 上开一个只服务它的 socket（`~/.agent-flow/ssh/<机器>.af.sock`），用这台机器的 SSH 主连接反向转发到那边的 `~/.agent-flow/af.sock`（`ssh -O forward -R`），并写一个 `~/.agent-flow/bin/af` 脚本（只要 sh 和 curl）。
- 那边执行 `af …` 时，脚本把参数、目录、`AF_TEAM` / `AF_AGENT` / `HERDR_PANE_ID` 送过来，server 在 Mac 上用 `AF_REMOTE=<机器>` 跑同一个 af CLI，输出和退出码送回去。所以所有命令在哪里都一样。
- 只开放派活、工单、队列、`af machines` 相关的命令；不能往 pane 里打字，也不能读 Mac 上的文件。调用者的 pane 加上机器前缀；成员只能代表在这台机器上跑的成员说话。`af read` 只读这台机器上的 pane。
- 远程机器上有 `~/.claude`、`~/.codex`、`~/.gemini` 时，写入 agent-flow skill（af 路径是那台机器上的）。
- 后台任务的判断由 `background.ts` 负责，对远程机器同样有效（通过 SSH 检查；每次状态变化只查一次，不会在普通一轮结束后循环重查）。
- claude 的 SessionStart hook（`--settings`）是 Mac 上的文件，不用于远程成员；远程 claude 的对话记录按 `--session-id` 找。
- 第二个 server（`AF_SECOND_SERVER=1`）不接管远程的 `af.sock`。

## 5. 借鉴 DeepSeek Super-Agent 的地方

来源：`deepseek-ai/dsh-superagent-prototype`（2026-10-31 开源）的源码和设计文章。

- **相同**：router 不干活（文章的对照实验：一个 session 带 subagent 工具，提示词中性时 5 次里一次也没交出去，p95 29.5 分钟；Super-Agent 15.7 分钟）；工单 + 派工；成员不直接说话；界面只显示要人处理的事。
- **不同**：它常驻 GitHub 仓库、接团队群聊，有一大块准入和授权；我们是一个用户在本地说话。它的成员之间几乎不接力（一张工单一个 PR）；我们的成员要接力和循环，这正是文章列为"还没解决"的部分。它控制 agent 内部（能在一轮中间插消息、长命令转后台）；我们驱动的是原版 CLI，只能打字、读屏幕和对话记录。它让后续消息绕过 router 直接给 worker；我们一切经过 router（它的数据：去掉直通后完成时间几乎不变，router 多做约 30% 的决定，cache read token 多约 37%）。
- **借来的**：一次处理整个队列（4.5）；router 不改写，只转原文（task.md 放原话或上游 result.md 的路径，备注一句）；固定的几种报告（ready / blocked / failed / dropped，progress 不进队列）；先存再做、确认送到（4.6）；一个函数算阶段（4.7）；空闲不等于做完（`turn` 项、`af status`）；临时错误自动"继续"；重启后的恢复说明；通知里带 id、前 400 字和路径，`af ticket show` 带相关工单的 id，可以一步步往回找。
- **以后再说**：Watchdog（一个独立 agent 定时检查成员有没有实际进展）、同时工作的成员数上限、成员把不属于自己的活交回 router。
- **不借**：异步工具（要改 agent 自己的工具循环）、事件来源和准入规则、计算/状态/环境分离（Herdr 已经让终端独立于 af server）。

## 6. 仓库

- 成员默认在管理者的目录里工作（模式二是 team 的目录），和用户平时开一个新 session 一样。
- `--worktree` / `--no-worktree`（`af task` 和 `af ticket open` 都有；在 git 仓库里新成员必须二选一，见 4.3）：`--worktree` 在 `<repo>/.agent-flow/worktrees/<team>/<成员>` 开 worktree，分支 `af/<team>/<成员>`，从管理者目录当前的 HEAD 切出；写进 `.git/info/exclude`（claude 的文件夹信任按仓库算，worktree 不会再弹框）。远程成员的 worktree 通过 SSH 在那台机器上建。
- agent-flow 不替成员提交、不合并。成员自己提交（剧本会说明），分支名写在工单里。
- 原来的集成分支、自动提交、accept 时合并、合并冲突处理都去掉了。

## 7. 送达方式

- 往 agent 终端里打字：`herdr agent prompt`。打之前读一次屏幕，有菜单或面板就不打（`Workspaces.prompt` 已经这样做）；gemini 的"文字留在输入框里没发出去"也由它处理。
- 送给成员的工单消息：

  ```
  [agent-flow] Ticket T3 for you (thread T1, round 2): 按审查意见改
  Read /…/teams/<team>/tickets/T3/task.md and do it. Inputs: /…/tickets/T2/result.md
  When finished: write /…/tickets/T3/result.md, then af submit --status ready --note "<one line>"
  ```

  模式一的成员收到的就是任务原文，末尾一句"(agent-flow ticket T3; end with a short summary of the result)"。
- 送给管理者的只有一行通知（4.5），内容由它自己 `af queue take` 取。

## 8. CLI：`af`

成员和 router 启动时注入 `AF_TEAM`、`AF_AGENT`、`AF_SOCK`、`AF_OUT`；模式一的主 agent 没有这些变量，CLI 带上 `HERDR_PANE_ID`，server 按 pane 认出它。

| 命令 | 谁用 | 作用 |
|---|---|---|
| `af task <kind> "<任务>" --worktree\|--no-worktree [--name N] [--on 机器 --cwd D] [--prepare "…"] [--task-file F]` | 主 agent | 开一张工单，交给新成员（git 仓库里必须选 worktree） |
| `af task --to <成员> "<任务>"` | 主 agent | 交给已有成员 |
| `af team new --goal "…" [--playbook P] [--router K] [--name N] [--cwd D] [--on 机器]` | 主 agent、用户 | 开一个 agent team |
| `af team list` · `af team stop [T]` · `af playbook list` | 所有人 | |
| `af queue` · `af queue take` · `af queue done <seq>` | 管理者 | 看队列、一次取走全部、手动标为处理完 |
| `af ticket open <成员> --title "…" (--task "…" \| --task-file F) [--from T] [--max N] [--kind K] [--worktree\|--no-worktree] [--on 机器 --cwd D] [--prepare "…"] [--note "…"]` | router | 开工单（成员不存在就按 `--kind` 新开） |
| `af ticket close <T> [--failed\|--dropped\|--cancelled] [--note "…"]` · `af ticket show <T>` · `af tickets` | 管理者 | |
| `af thread max <T> <N>` | 管理者 | 改线程的轮数上限 |
| `af tell <T\|成员> "…"` | 管理者 | 追加要求（对 team 工单就是给 router 的新要求） |
| `af answer <T\|成员> <选项号> [--text "…"]` | 管理者 | 回答成员屏幕上的提问 |
| `af reply <seq> "…"` | router | 回答成员的 `af ask` |
| `af status <成员>` | 管理者 | 成员的状态、最后的回复、屏幕最后几行 |
| `af report "…" [--done]` | router | 向调用者（或"需要你"）汇报 |
| `af report "…"` | 模式一里 `af task` 开的 session | 用户直接跟它聊出了进展或口径变化时，告诉派活的 session（进它的队列） |
| `af context` · `af context set "…"\|--file F` | 管理者（主 session、router） | 项目上下文：team 的 agent.md 里动态的那部分（见 4 节） |
| `af handoff` · `af handoff ready <文档>` | 用户直接对话的 session（不含 team 成员和 `af task` 开的 session） | 交接给同一 pane 里的新会话（见 4 节） |
| `af submit --status ready\|blocked\|failed\|dropped --note "…" [--to 成员] [--ticket T]` | 成员 | 交结果（result.md 写在工单文件夹里） |
| `af progress "…"` · `af ask "…"` | 成员 | 进展（不进队列）· 提问（进队列） |
| `af machines` | 所有人 | 列出 `--on` 能用的机器（本机和已连接的 SSH 机器，远程机器上也可调用） |
| `af ls` / `af read` / `af open` / `af deliver` / `af split` / `af close` …… | 所有人 | 不变 |

## 9. 协议和 skill

- `packages/skill/router.md`：router 的规则（不干活、不改写、每项用一个动作结束、只在里程碑和需要用户时汇报、做完就结束这一轮、不轮询）。
- `packages/skill/member.md`：成员的规则（读 task.md、写 result.md、`af submit` 正好一次、提问用 `af ask`、不和别的成员说话）。
- 注入方式：claude `--append-system-prompt-file`，codex profile，omp `--append-system-prompt=`。gemini 没有追加系统提示的参数，协议作为它的**第一条消息打进去**（再等它回 ready 才送工单）。不用 `-i "@<文件>"`：那要把协议所在的文件夹加进 gemini 的 workspace，gemini 会为这个文件夹弹"是否信任"（2026-11-04 实测，每个 gemini 成员都会卡住）。**协议文本绝不能放在命令行上**（macOS 单行 1024 字节）。
- 模式一的成员不注入协议，用平常的启动参数（claude 带 `--session-id` 和 SessionStart hook，codex `--no-alt-screen`，gemini YOLO）。
- `agent-flow` 和 `deliver-document` skill（server 启动时写进 `~/.claude/skills`、`~/.codex/skills`、`~/.gemini/skills`）：`agent-flow` 教会用户的 session 直接派活用 `af task`、要循环或长期运转的活用 `af team new`；`deliver-document` 让 agent 写完给用户看的文档后执行 `af deliver`。

### 9.1 第二个 server

`AF_SECOND_SERVER=1`（配合自己的 `AF_HOME`、`AF_SOCK`、`--port`）：在主 server 旁边再开一个（测试、试一个分支）。它不改写用户 skill 目录里的 skill，也不交付 agent 改过的文档（这两件事由主 server 做），所以不会影响用户正在用的 session。

## 10. UI

### 10.1 布局（2026-11-02 第一次 UI 评审后改定）

```
+- 需要你 · rhv93 --+- [lead] [div] [review] [+ tab] ------------+- 图 | 消息 ---+
| ! div 待校验       | +- ● lead claude idle -+- ≡ calc.js -------+ | design ✓       |
|-------------------| | > ...                | export function   | |  ├ api   ●     |
| 机器              | |                      |   mul(a, b) {     | |  └ ui    ●     |
| ▾ Local           | +- ● div omp ----------+                   | | code ⟳ 1/3     |
|   ▸ llm-solver    | | ...                  |                   | |                |
|   ▾ af rhv93 ◆rhv93| +----------------------+-------------------+ | 点节点 → 详情   |
|     ● lead claude |                                              |                |
|     ● div  omp    |                                              |                |
| ▸ SSH machines 12 |                                              |                |
+-------------------+----------------------------------------------+----------------+
| $ 常驻终端                                                              (ctrl+`) |
+-----------------------------------------------------------------------------------+
```

- **布局归 Herdr 管。** 网页显示 Herdr 真实的 机器 → workspace → tab → 分屏 pane；在网页里分屏、关闭、拖分隔线都直接改 Herdr，所以 Herdr TUI 和网页永远一致，在 TUI 里建的分屏网页里也看得到。
- **左栏**：顶部是"需要你"（由 team 或旧 run 派出的成员/worker 的完成状态由派活的 session 处理，不进用户的"需要你"；用户自己 fork 的 agent 照旧提醒）；下面是一棵树：机器 → workspace（有 team 的 workspace 带 ◆ 标记）。已关闭 workspace 的 team 列在"Past teams"。SSH 机器折叠成一组。
- **中间**：所选 workspace 的 Herdr tab；每个 tab 是 Herdr 的二叉分屏树。pane 有三种：终端（shell）、agent、查看器（文件 / 文件夹 / 网页）。pane 头上有分屏（右 / 下）、"＋"（在旁边开 claude / codex / omp / gemini agent，或文件 / URL）、关闭。run 的 workspace 默认打开 lead 的 tab。
- **右栏**（2026-11-04 改）：workspace 里有 team 时出现。
  - 模式一：主 agent 的竖时间轴。每张工单是挂在时间轴上的一个框（成员名、agent 种类、阶段、用时、结果的第一句），结果回来时画一条回到时间轴的线。点框跳到成员的 tab；框下方展开工单详情（task.md、result.md、轮次、"Go to pane"）。成员自己又开了 team 的，框上有 ⊕，点开是那个 team。team 工单的框点进去切到那个 team 的 workspace。
  - 模式二：泳道图。router 一条竖线，每个成员一条；每张工单是 router → 成员的箭头，每次提交是成员 → router 的箭头，标出线程和轮次。点箭头打开对应的 task.md 或 result.md。上方显示队列里还没处理的项。
- **底部**：常驻终端抽屉，它自己的 Herdr workspace 不在树里显示。

### 10.2 查看器 pane、`af open` 与 `af deliver`

- 查看器是一个普通的 Herdr pane，里面运行 `af viewer`。server 在 `~/.agent-flow/views.json` 里记"哪个 pane 显示什么"。网页看到这个记录，就画高亮的文件 / Markdown / 图片 / PDF / 网页；Herdr TUI 里则显示 `af viewer` 打出的纯文本（有 bat 就用 bat 高亮）。pane 被关掉后记录自动清除。
- `af open` 默认在**调用者自己的 pane 旁边**开查看器，所以 worker 开的文件出现在它自己的 tab 里，不抢用户的焦点；`--of` 指定开在谁旁边，`--in` 换掉已有查看器的内容（避免越开越多），`--tab` 开新 tab，`--app vscode|obsidian|default|finder` 在对应应用里打开（远程机器上的文件只能用 VS Code 通过 Remote-SSH 打开）。
- **交付文档（`af deliver` 与自动检测）**：agent 执行 `af deliver <文件>` 交付写完的文档，或一轮结束时 `doc-watch.ts` 自动发现在该轮内修改过的文档（本地 agent），都记在 `~/.agent-flow/deliveries.json` 里。聊天视图里在该轮 agent 的回复下方显示一行打开按钮（Obsidian / VS Code / 默认应用 Open / Finder / 旁边预览 Preview，每轮每个文件一行）；**不会自动在旁边分屏开查看器 pane，不进"需要你"，也不发通知**（除非用户在"需要你"旁的 ⚙ 设置里勾选了立即用应用打开）。
- agent 也能直接用 `herdr` CLI 做其余的排布（`herdr pane move`、`herdr tab create`……），因为它们本来就跑在 Herdr pane 里。

### 10.2.1 与 Herdr 同步的实现（实测）

- server 维护一份 Herdr 模型：`session.snapshot`（约 110 ms）+ 每个 tab 的 `layout.export`（二叉树：`split{direction, ratio, first, second}` / `pane{pane_id}`）。只对布局签名变了的 tab 重新导出。
- 触发：订阅 Herdr 的生命周期事件（workspace / tab / pane / layout，全部可以不带过滤条件订阅；只有 `pane.agent_status_changed` 必须指定 pane），80 ms 防抖；外加每 1.5 秒轮询一次以更新 agent 状态。变化时推给所有网页。
- 分隔线：`layout.set_split_ratio {tab_id, path, ratio}`，path 是从根往下的布尔数组，`false` = first，`true` = second（实测）。
- 远程机器：见 10.2.3。
- 分屏之间是 5 px 的分隔条，当前聚焦的 pane 有蓝色描边（用户要求边界更明显）。
- 查看器进程在 server 重启时不退出（以前会退出，导致查看器 pane 随之关闭）。
- 已知副作用：网页打开某个 pane 时，会把它的 PTY 调成网页里的尺寸；如果用户同时在 Herdr TUI 里看着同一个 tab，两边会按"最后操作的一方"来回调尺寸（Herdr 的多客户端规则）。

### 10.2.2 agent 输出自动渲染（2026-11-02，用户要求：像 Claude app / VS Code 插件那样渲染 markdown 和 LaTeX）

- agent pane（claude / codex / omp）默认显示**渲染视图**，pane 头上可以切换"rendered | terminal"，选择按 pane 记在浏览器里。
- 渲染视图：上面是已经完成的输出，markdown（GFM 表格、列表、引用）+ LaTeX（KaTeX：`$$…$$`、`\[…\]` 为独立公式，`$…$`、`\(…\)` 为行内；"$5 和 $10" 这类不当成公式）+ 代码高亮（Shiki，关闭连字，`<=` 照原样显示）；工具调用是可展开的卡片（命令、输出、编辑的 diff）；agent-flow 的唤醒通知、斜杠命令显示成小字。下面保留一条**实时终端**：用来打字、回答审批、看正在生成的内容。它显示的是终端里最后有内容的那几行（claude 的输入框紧跟在输出后面，不一定在屏幕底部），PTY 尺寸不变；agent 在等审批时自动变高。
- **数据来源是 agent 自己写的对话记录，不是终端画面**（画面已被折叠、截断）：
  - claude：`~/.claude/projects/*/<session>.jsonl`。agent-flow 启动的 claude 一律加 `--session-id <uuid>` 和 `--settings ~/.agent-flow/claude-settings.json`；后者加一个 SessionStart hook（`af hook claude-session`），claude 启动、`/clear`、恢复会话时都会把 session id 和对话文件路径报给 agent-flow（实测可用，和用户自己的 settings 合并）。别人启动的 claude：先看进程参数里的 `--resume` / `--session-id`；同目录只有一个 claude 就取该目录最新的对话文件；**同目录有多个 claude**（如 rhv93 的 review 和 review3）时，把 pane 屏幕上的提问行（❯）和回答行（●）去掉空白和 markdown 符号后，与各候选文件的最后 2 MB 比对，命中最多且明显领先的那个就是它的（实测 rhv93 三个 claude 全部匹配正确）；比不出来才显示终端。
  - codex：Herdr 记录的 session id → `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`。
  - omp：Herdr 直接记录的路径。
- server 每 0.5 秒看一次文件有没有变长，只解析新增的行，通过 WebSocket 推给网页（实测：工具调用写入后约 1 秒内出现在网页上）。不是逐字流式：文件按"一段正文 / 一次工具调用"写入。
- 这些文件格式没有文档、可能随版本变化：解析器对未知字段一律跳过；找不到或解析不了就显示终端并说明原因。实现：`packages/server/src/transcripts/`，测试：`packages/server/test/transcripts.test.ts`。
- 查看器里打开的 markdown 文件用同一套渲染（含 LaTeX）。
- **折叠**（用户要求）：连续的工具调用合成一行"N steps · Bash ×3 · edited calc.js"，默认折叠，点开是各个工具卡片，卡片再点开才显示命令、输出、diff。用户消息超过 4 行折叠，"show more" 展开。
- **发出去的消息立刻显示**：发送后先在对话末尾显示一个虚线气泡（"sending…" → agent 忙时 "queued — the agent reads it after its current step"），等它出现在 agent 的对话记录里再变成正常消息。claude 在忙时收到的消息不记成普通 user 消息，而是 `queued_command` 类型的 attachment（实测），解析器按用户消息处理并去重。草稿（文字和正在上传的附件）按 pane 保存，切到别处再回来还在；文字还存在浏览器里，刷新也不丢。
- **我们自己的输入框**（用户要求，代替终端自带的输入行）：Enter 发送、Shift+Enter 换行、中文输入法组字时不误发。可以粘贴图片、拖入文件、点 ＋ 选文件，支持多个。文件先上传到 `~/.agent-flow/attachments/<日期>/<随机>-<名字>`，发送时在提示词最前面加：
  ```
  Read these attached files first:
  - /…/attachments/2026-11-02/jlp8h7-pasted-081607.png
  - …
  ```
  再接用户的话，通过 `herdr agent prompt <pane>` 送达（实测：claude 按路径读到图片并正确回答）。
- **选项菜单渲染**（用户要求）：agent 弹出选项时（claude 的提问 AskUserQuestion、工具审批、文件夹信任框、codex 审批），server 从屏幕上读出这个菜单（`packages/server/src/menu.ts`：找最靠下的 ❯/› 指针，读同一缩进的选项、更深缩进的说明、上方的问题、下方的按键提示），渲染视图里显示成一张选项卡片：点选项、按 1–9、或 ↑/↓ 加 Enter；"Type something." 这类自由输入选项点开是一个输入框；"Cancel (Esc)"。选择时 server 重新读一次屏幕，确认选项文字没变（防止菜单已经换了），再发方向键和 Enter，和用户亲手按键完全一样。读不出菜单时照旧显示实时终端。实测：claude 的提问，点 "LaTeX"，claude 收到 `"…"="LaTeX"`。
  - **读菜单必须用 `--source visible`**（2026-11-02 修复）：`recent-unwrapped` 会把"占满整行"的行和下一行拼起来，而对话框的每一行都补齐到整行宽，结果 claude 权限提示的 4 个选项被拼成 2 个、问题里混进虚线，卡片不显示（用户报告"claude 要确认 auto mode 的时候没有显示"）。claude 真实的权限提示（2.1.316）已作为测试样本：`Bash command / 说明 / ╌╌╌ / 命令 / ╌╌╌ / Do you want to proceed? / 1. Yes / 2. Yes, and always allow … / 3. Yes, and switch to auto mode … / 4. No / Esc to cancel · Tab to amend`。╌ 虚线是对话框内部的分隔，不是边界；两条虚线之间是被询问的命令，卡片里用代码样式显示。
  - 不只在 Herdr 报 blocked 时读：平时每 4 秒也读一次屏幕，屏幕上有菜单就当作在等人回答（显示卡片、禁用输入框），因为有些对话框 Herdr 认不出来。
  - **agent 的输入框还在屏幕底部时，不算菜单**（2026-11-03 修复）：对话框会取代 agent 的输入框（claude、codex 画在输入框的位置，omp 把编辑器换成选择框），所以输入框还在时，上面像菜单的文字只是对话内容。此前整屏都会被搜索，lead 的回复里引用了 codex 的"Trust this folder? / › 1. Trust and continue / 2. Quit"，就被当成了 lead 自己的提问（显示卡片、禁用输入框，通知也因此停发）；用户消息里的 `1.`/`2.` 编号列表同理。输入框的判断和"面板和通知"用的是同一个（`menu.ts` 的 `inputBoxShown`）。shell 或还没认出类型的 agent，照旧搜索整屏。
- 实时终端默认隐藏，只在三种情况出现：agent 等审批或提问（blocked，自动出现，输入框禁用并提示去终端回答）；发送了以 `/` 开头的斜杠命令（可能弹菜单）；用户点状态栏的 "terminal"。agent 工作时状态栏有 "■ Stop"（发 Esc）。

### 10.2.3 远程机器（2026-11-02）

- **不需要升级 Herdr，也不在远程装任何东西。** Herdr 自己的 TUI 就是 SSH 到每台机器、直接连那台机器的 Herdr server；agent-flow 做同样的事。机器列表来自 `herdr machine list`（用户在 Herdr 里存过的机器）。
- **每台机器一条 SSH 主连接**（ControlMaster，`~/.agent-flow/ssh/<机器>.ctl`），上面跑三样东西：
  1. **把远程 Herdr 的 Unix socket 转发到本机**（`ssh -O forward -L ~/.agent-flow/ssh/<机器>.sock:<远程 home>/.config/herdr/herdr.sock`）。于是本地的 Herdr 适配层原样可用：JSON API、事件订阅、`herdr` CLI（`HERDR_SOCKET_PATH` 指过去）。实测：snapshot 115 ms，订阅正常。
  2. **终端实时流**：`ssh <机器> <远程 herdr> terminal session control|observe <pane>`，和本地同一种 NDJSON。实测：首帧 32–180 ms，打字回显中位数 8 ms（同一局域网）。
  3. **短命令**：读远程 agent 的对话记录（`ls`、`tail -c`，按字节偏移增量读）、把附件写到远程的 `~/.agent-flow/attachments/`。
- **id 带机器前缀**：远程的 workspace / tab / pane id 写成 `<机器>~<原 id>`，如 `allinai2plus~w6:p3`；本地 id 不变。所有操作按前缀路由到那台机器。`af ls`、`af read`、`af split` 等对远程 id 一样可用；`af connect <机器>` 手动连接。
- **连上就一直连着**（用户要求）：
  - 第一次在侧栏展开或 `af connect` 时连接；连过的机器记在 `~/.agent-flow/machines.json`，之后每次 server 启动都自动重连，直到用户点"Disconnect"（或 `af disconnect`）。
  - SSH 主连接在后台独立运行（`ssh -f -N -o ControlPersist=yes`），**agent-flow server 重启不会断**；新 server 用 `ssh -O check` 找到它直接复用（实测：重启后不需要任何操作，远程 pane 立刻都在）。
  - 心跳：ServerAliveInterval 10 s × 6 次，网络抖动一分钟以内不会断。
  - 健康检查：每 15 秒检查主连接和转发的 Herdr socket；连续两次拉取失败也会立刻检查。坏了就马上重连，之后 3 s、6 s……最长 30 s 无限重试。实测：手动杀掉 SSH 主连接，4.9 秒发现，5.7 秒恢复。
  - 重连期间保留最后一次看到的 workspace 和 pane（侧栏变暗，pane 上显示"Reconnecting to …"），不会消失；网页里打开着的终端流断了会每 2 秒自动重开（实测约 2.4 秒恢复）。
  - "Disconnect" 结束后台 SSH 连接（`ssh -O exit`）并不再自动重连；"Remove machine" 同时从 Herdr 的列表里删除。
- 需要免密 SSH（BatchMode）。实测 allinai2plus、ds03 可以；其余机器未测。
- **增删机器**（用户要求）：侧栏"+ machine"填 SSH 目标（和可选名字）→ `herdr machine add`，写进 Herdr 自己的机器列表（Herdr TUI 里也会出现），随后自动连接。远程没装 Herdr、需要确认安装时，Herdr 要交互确认：表单给出"在常驻终端里运行 setup"按钮，把 `herdr machine add …` 打进常驻终端，由用户回答。机器"⋯"菜单里"Remove machine…"→ `herdr machine remove`；那台机器上的 Herdr server 和 agent 继续运行，再加回来就能接上。每 15 秒同步一次 Herdr 的机器列表，在 Herdr TUI 里增删的机器也会跟着变；机器的 id 按 Herdr profile 固定。
- **增删 workspace**（用户要求）：每台机器行上的"+"（或 "+ new" → New workspace）新建 workspace（表单里本机可点 Browse… 选目录，远程机器支持 `~` 路径且目录在那台机器上检查；本机新建普通 workspace 时会在 shell 右侧分屏打开该文件夹的查看器 pane）；workspace"⋯"菜单里"Close workspace…"关闭并停止其中所有进程（如果是 team 的 workspace，同时停止该 team），确认框里写明会停掉几个 agent、几个 pane。
- 远程 agent 的渲染视图：对话记录在远程读，按 session 精确匹配（实测 3 个远程 agent 都命中）；轮询 1.5 秒一次；打开时只读最后 8 MB。
- 远程 agent 粘贴图片：附件写到**远程机器**上，提示词里给的是远程路径，agent 能直接读。
- 暂不支持：在远程 pane 旁边开查看器（查看器是本地进程）。
- 注意：网页里打开远程 pane 时，那个 pane 的 PTY 会变成网页里的尺寸（和本地同一条 Herdr 多客户端规则）。

### 10.2.4 报错信息、"/" 菜单、fork（2026-11-02，用户要求）

- **报错信息**：server 有一个 notices 列表（`server/src/notices.ts`），推给所有网页。来源：远程机器连不上（带原因，如"Could not resolve hostname"）/ 断线 / 重新连上；本地 Herdr 不响应 / 恢复；终端流异常结束（远程 ssh 退出码 255 视为连接断了，直接触发连接检查，不另报）。网页里所有操作失败（原来是 alert 弹窗）也进同一个列表。显示：右下角 toast（info 5 秒、warn 9 秒、error 15 秒，点一下关掉），底栏"▲/✕ N"未读徽标，点开是完整列表（来源、时间、详情、清空）。同一来源同一条反复出现时计数（×N），不刷屏。机器的错误原因在侧栏里一直显示。
- **"/" 菜单（skill 预览）**：输入框第一个词以 `/`（codex 的 skill 是 `$`）开头时弹出列表：该 agent 的内置命令 + **它这次会话实际加载的 skill**。claude 从对话记录里的 `skill_listing` 附件读（含插件 skill）；codex 从会话里的 "### Available skills" 目录读，插入 `$name`；omp 扫它会读的 skill 目录（`~/.omp/agent/skills`、`~/.claude/skills`、`~/.agents/skills` 和项目里的同名目录）读 SKILL.md 头部，插入 `/skill:name`。内置命令列表取自各 agent 自己的界面文字。前缀匹配优先，其次名字包含、描述包含；下方预览区显示完整描述；Tab / Enter 插入，↑/↓ 选择，Esc 关闭。实测：claude 57 项（35 个 skill），codex 79 项，omp 55 项。
- **fork**：
  - 状态栏"⑂ Fork"：在旁边开一个新 agent，带上到目前为止的整个对话。
  - 用户消息上悬停出现"⑂ fork from here"（claude、omp）：新 agent 的历史停在这条消息之前，这条消息放进新 agent 的输入框，可以改了再发（类似 Claude app 的编辑重发）。
  - 实现：claude 和 omp 复制对话文件到新的 session id（到这条消息所在行的起始字节为止），再 `--resume` 新文件；原对话不动。两个 CLI 都实测过：恢复后只记得分叉点之前的内容。fork 点只放在用户消息前，因为在一轮中间切断会留下没有结果的工具调用（omp 实测会提示）。codex 用 `codex fork <id>`，只能整段 fork。远程 pane 的复制在那台机器上做（`head -c | sed`）。
  - 新 agent 启动时的提示（如 codex 的"信任此文件夹"）在渲染视图里也显示成选项卡片，即使还没有对话记录。

### 10.2.5 剧本、`$AF_OUT` 和 agent-flow skill（2026-11-03，2026-11-04 改）

- **剧本**（原来的 workflow 模板改写而来）：见 4.4。网页 "+ new" → New team：选目录（可点 Browse… 选文件夹）、剧本、目标、router 的 agent 种类。
- **`$AF_OUT`**：每个 team 的输出目录（`~/.agent-flow/teams/<team>/out`，不在仓库里），成员之间交接报告用。
- `af here` 去掉了：模式一第一次 `af task` 时自动建 team，按调用者的 `HERDR_PANE_ID` 认人。
- **agent-flow skill**：server 启动时写进 `~/.claude/skills/agent-flow/SKILL.md`、`~/.codex/skills/agent-flow/SKILL.md` 和 `~/.gemini/skills/agent-flow/SKILL.md`（omp 读 claude 的目录），内容含本 server 的 af 路径（af shim 里带默认 AF_SOCK）。实测：新开的 claude 收到"让一个 codex 和一个 omp 同时做…"后自己加载 skill、执行 `af here`、建两个并行节点、校验 omp 的结果；codex 卡在"信任此文件夹"时它停下来问用户，没有替用户选。
- **面板和通知**：除了选项菜单，agent 的屏幕底部如果不是它平常的输入框（claude 的 ──/❯/── 框、codex 的 `›` 行、omp 的 `╰─` 行、gemini 的输入行），就是开着一个面板或通知（如 claude 的 auto mode 计费通知，它要回车确认）。渲染视图把它显示成一张卡片（文字、链接、Continue / Esc 按钮）；pane 往上滚动时不判断。连续两次检查（本地约 2.5 秒、远程约 6 秒）仍停留在屏幕上的等按键通知会把该 pane 标为 `asking`（带通知文字），workspace 显示 blocked，进"需要你"，且不算这一轮做完。**agent-flow 绝不往开着菜单或面板的 agent 里打字**（输入框、通知投递都检查屏幕）：Herdr 有时认不出这些对话框，此前一次通知就这样误答了 claude 的提问。
- 问题预览：claude 在选项右边画预览框，屏幕上只有当前高亮那项的预览；卡片从 claude 自己的对话记录里取每个选项的预览和说明，显示在旁边（窄 pane 时在下方）。
- codex 没向 Herdr 报告 session 时，按目录找它的 rollout 文件（session_meta 里有 cwd），同目录多个 codex 时用屏幕内容比对，和 claude 一样。
- 中文 Markdown 里 `**位置：**main.tex` 这类粗体按 CommonMark 不成立，agent 自己的界面却显示为粗体；渲染时按 agent 的写法处理。
- 侧栏的 workspace 下不再列出 agent（用户要求）。

### 10.3 视觉

- Linear / Raycast 风格：深色为主，低饱和，细边框，只用一个强调色。
- 字体：Inter（界面）+ JetBrains Mono（终端和代码）。
- 节点的 5 种状态（等待 / 运行中 / 待校验 / 已通过 / 被打回）和"需要你"各用一种状态色，在灰底上要一眼能分清。
- v0 只做深色，浅色以后做。

### 10.4 文件和网页的安全

- af server 只监听 127.0.0.1，并且校验 Origin，防止别的网页连上本地的 WebSocket 去操控终端。
- 启动时生成一个随机 token，UI 的 URL 带上它。
- 文件预览只允许读 run 涉及的仓库、worktree 和 `~/.agent-flow` 下的路径。

## 11. 技术栈与目录

全部用 TypeScript，运行时用 Bun。

```
agent-flow/
  packages/
    core/     共享类型：team、工单、队列、事件
    server/   Bun：Herdr 适配层、team 与工单调度、对话记录、git、WebSocket
    cli/      af
    web/      React + Vite + xterm.js
    skill/    router.md、member.md 与内置 playbooks/
  spikes/     第 0 步的验证代码，验证完就丢
  docs/
```

**状态全部用文件保存，不用数据库：** 见 4.2。`~/.agent-flow/` 下另有 `server.sock`、`views.json`、`queue.json`（用户发给忙碌 agent 的消息）、`deliveries.json`、`machines.json` 等。

- `events.jsonl` 是唯一的事实来源。`team.json` 可以从它重建，只由 server 写。

## 12. v0 范围

**包含：**
- server：Herdr 适配层（含 SSH 远程机器）、两种模式（直接派活与 router team）、工单与队列（含循环上限 `--max`、准备命令 `--prepare`）、worktree 隔离、`events.jsonl`
- cli：第 8 节列出的全部命令
- skill：`router.md`、`member.md`、内置剧本（含常驻接活的 `super-agent`），支持 claude、codex、omp、gemini
- web：第 10 节的布局、标签页、时间轴与泳道图、"需要你"待办、渲染视图与交付文档按钮、深色主题

**不包含：** 外部事件来源（盯 GitHub 或群聊自动接活）、脚本式 workflow、文件编辑、Tauri 打包、手机端和远程访问 UI、claude / codex / omp / gemini 以外的 agent、浅色主题。

## 13. 第 0 步：风险验证（2026-11-02 完成，全部通过）

结果：S1 见 `spikes/s1-terminal/RESULT.md`；S2、S3 见 `spikes/s2s3-agents/RESULT.md`。三种 agent 共 15 个任务全部一次交对。对设计的修改已经写进第 3.1、6、9 节。另外一条：`af done --result` 由 CLI 把相对路径转成绝对路径。

原计划如下：

| # | 验证什么 | 通过标准 | 不通过怎么办 |
|---|---|---|---|
| S1 | `terminal session control` 接到 xterm.js 上的延迟和流畅度 | 打字回显延迟中位数低于 30 ms；`seq 1 200000` 时界面不卡死、不丢最终画面；和 Herdr TUI 同时开着时不打架 | 改用 observe 读画面 + `pane send-text` 写输入；还不行就重新评估自研 PTY |
| S2 | claude / codex / omp 拿到 skill 后会不会老实用 `af done` 交结果 | 每种 agent 跑 5 个小任务，交结果的格式正确、outcome 合法的比例不低于 90% | 加强 skill；加超时提醒；或者让 server 在 agent 变 idle 时追问一次 |
| S3 | 派发时能不能自动给新开的 agent 注入 skill、角色和环境变量 | 三种 agent 都能用一条命令起来，并且拿到任务 | 某种 agent 只能退回"第一条 prompt 里写全部说明" |

## 14. 验收场景

用沙盒仓库（不用 agent-flow 自己）：

1. **模式一**：在一个 claude session 里说"开几个 session：claude 规划，codex 执行，gemini 写说明"。它调 3 次 `af task`；时间轴上出现 3 个框；每个成员做完后主 agent 收到通知、`af queue take` 拿到结果，接着派下一步或汇报。
2. 一个成员屏幕上出现任务问题时，主 agent 用 `af answer` 回答；出现权限审批时进"需要你"，主 agent 不碰。
3. **模式二**：`af team new --playbook humanize-loop --goal …`。router 开 coder 和 reviewer，至少发生一次 fail → 改 → pass；泳道图上看得到每一轮；router 最后 `af report --done`，主 agent 收到。
4. 中途重启 af server，再打开时队列、工单、时间轴都完整，没送达的通知照样送达。

2026-11-04 实测（第二个 server，沙盒 `.sandbox/modes`）：
- 模式一：主 claude 读 skill 后两次 `af task`（codex、gemini），结束这一轮不等待。gemini 做完 6 秒内结果进队列，主 agent `af queue take` 拿到。codex 卡在"信任此文件夹"（会信任整个仓库），没有替用户点；重启 server 后主 agent 收到"等你批准"的通知，向用户说明了后果，没有去点。
- 模式二：主 claude `af team new --playbook humanize-loop`；router 开 writer（claude），交了以后 `--from` 开 reviewer（gemini）。gemini 卡在 agent-flow 自己的协议文件夹的信任框（已修，见第 9 节），router `af report` 给主 agent，主 agent 告诉用户。用户让换人后，主 agent `af tell T3`，router 开 reviewer2（gemini，协议作为第一条消息，不再弹框），审核 PASS，router `af report --done`，主 agent 汇报了俳句、每行音节、季语和轮数。
- 这次跑出来并修掉的：重启后同一个对话框重复通知；`af report` 没有算作处理了"等你批准"这类项；开工单没有算作处理了用户的新要求；`af report` 的输出让 router 误以为发错了地方；团队工单在时间轴上显示"空闲"。

## 15. 以后再做

- 外部事件来源：super-agent 剧本的 router 已经能一直开着接活；盯 GitHub 或群聊的事件来源以后再做。
- Watchdog、成员数上限、把活交回 router：见第 5 节。
- 脚本式 workflow：TS 脚本调用同一套 `af` 命令，用于需要严格可重复的流水线。
- 文件编辑：基于 CodeMirror，保存前检查 agent 有没有改过这个文件。
- Tauri 打包：解决快捷键被浏览器抢走、iframe 不能嵌入部分网站、系统通知受限这几个问题。
