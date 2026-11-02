# agent-flow 设计文档

状态：v0 设计已定（2026-11-02，通过 grill-me 逐条讨论确定）。实现中发现与本文冲突的地方，先改本文，再改代码。

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
  · 图调度器                        │
  · 信箱                            │
  · git worktree 管理               │
  · events.jsonl                   │
        │ JSON socket API + terminal session observe/control
        ▼
Herdr server（原版，不 fork）
  · 持久化 PTY、pane / tab / workspace
  · 23 种 agent 的状态识别（idle / working / blocked / done）
  · worktree 创建
```

**原则：**
- Herdr 负责终端和 agent 生命周期；agent-flow 负责组合、通信、调度、UI。
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

## 4. 核心概念

| 概念 | 含义 |
|---|---|
| **run** | 一次完整的协作任务。有自己的图、信箱、集成分支 `af/<run>/main` |
| **团队模板** | YAML 文件，声明一个 run 启动时要起哪些 agent、各自的角色。**不写控制流** |
| **agent** | 跑在某个 Herdr pane 里的一个 coding agent 实例，在 run 内有唯一名字 |
| **lead（总控）** | run 的入口 agent。用户主要和它对话；它负责建图、改图、校验 |
| **图（graph）** | lead 维护的一张**有向图，允许有环**。是一份"活的计划"，可以随时修改 |
| **节点（node）** | 图里的一块活：任务说明 + 执行者 + 隔离方式 |
| **实例（instance）** | 节点的一次执行，记作 `code#1`、`code#2`。图有环，执行记录没有环 |
| **边（edge）** | 依赖关系，可以带条件 `on <outcome>` |
| **outcome** | 节点交结果时附带的标签（如 `pass` / `fail`），用来决定走哪条边 |

### 团队模板示例

```yaml
# <repo>/.agent-flow/teams/review-loop.yaml（也可放在 ~/.agent-flow/teams/）
name: review-loop
entry: lead
agents:
  lead:     { kind: claude, role: "拆任务、建图、校验结果" }
  reviewer: { kind: claude, role: "审 diff，回 pass/fail 和理由" }
# 其他执行者由 lead 按节点用 --kind 现开
```

`af up review-loop` 会新建一个 run，起模板里的 agent，注入 skill 和角色，把焦点交给 lead。lead 觉得某种组合好用时，可以自己写一份新的团队模板存起来。

## 5. 图与调度

### 5.1 节点实例的状态

```
pending ──触发条件满足──▶ ready ──派发──▶ running ──af done──▶ submitted
                                            ▲                     │
                                            └── reject + 理由 ◀────┤
                                                                  ├── accept ──▶ accepted
                                                                  └── (auto-accept 直接通过)
另有：cancelled（lead 取消）、skipped（run 结束时仍未触发）
```

- **accepted 的实例不可修改。** 要改就让节点再执行一次（产生新实例），或者新建节点。
- `af graph edit` 只影响还没派发的节点。在跑的节点要先 `af graph cancel`。

### 5.2 边与环

```bash
af graph add  code   --kind codex  --task "实现 X"
af graph add  review --kind claude --after code --auto-accept \
              --task "审 diff，结束时 af done --outcome pass 或 fail"
af graph link review code --on fail --max 3     # 回边
af graph add  docs   --after review --on pass
```

规则：
1. 边上的 `--on <outcome>` 不写时，匹配任何 outcome。
2. 一个实例被 accept 后，它所有条件匹配的出边**触发**。
3. **正向边**：一个节点的所有正向入边都触发过后，它进入 ready。
4. **回边**：`link` 时如果这条边会形成环，就自动标记为回边。
   - 回边**必须带 `--on`**。一个环里如果没有任何带条件的边，`link` 直接报错。
   - 回边触发时，目标节点直接开始下一个实例，不等其他入边。
   - `--max` 是这条回边最多触发的次数，默认 3。到达上限时不再触发：在"需要你"里出现一条待办，同时通知 lead，由 lead 或用户决定加轮数、改图还是放弃。
5. 一个实例的 outcome 没有匹配到任何出边时，这条路径就在这里结束。
6. 没有节点在 ready / running / submitted 状态、也没有回边可以触发时，图进入 **quiescent（静止）**，通知 lead。run 不会自动结束，因为 lead 看完结果可能还要加节点。结束 run 要显式执行 `af run stop`，这时剩下没触发的节点标为 skipped。
7. 一个节点同一时间最多只有一个活动实例（ready / running / submitted）。它忙的时候到达的触发会排队，等它空出来再生成新实例；回边触发优先于正向触发。
8. 新建的正向边如果来自一个已经 accepted 的节点，并且条件匹配，会立刻触发一次（"迟到绑定"）。所以 lead 在上游做完以后再接一个下游节点，下游会马上开始。
9. 删除节点时连带删除它的边。如果下游因此没有任何正向入边了，下游就变成根节点，立刻开始。

实现：`packages/core/src/graph.ts`（纯逻辑，事件溯源：`decide` 校验命令并产出全部事件，包括派生事件；`apply` 只机械地应用事件，所以回放 `events.jsonl` 能精确重建状态）。测试：`packages/core/test/graph.test.ts`。

### 5.3 派发

- **自动派发**：节点一进入 ready，server 就把"任务说明 + 上游实例的结果路径 + 回边带来的意见"打包，发给它的执行者。
- `--hold`：这个节点进入 ready 后不自动派发，等 lead 执行 `af graph start <node>`。
- **执行者**由 lead 按节点选：
  - `--kind codex|claude|omp`（默认方式）：新开一个 agent。
  - `--agent <name>`：排队给一个常驻的具名 agent，适合需要连续上下文的场景。
- **同一节点再次执行**（被 reject，或回边触发）时，交给**上一次的同一个 agent session**，在同一条分支上继续做。
- 新开的 agent 一直存活到 run 结束，因为它的节点随时可能被回边再次触发。run 结束后统一回收，pane 的终端记录保留，可以回看。

### 5.4 校验

- 实例进入 submitted 后，server 给 lead 发一条消息，内容包括结果路径和 diff 命令。
- lead 执行 `af graph accept <node>` 或 `af graph reject <node> --reason "..."`。
- 标了 `--auto-accept` 的节点（默认关闭）交了就算通过，不叫醒 lead。适合审查这类本身就是在做判断的节点，这样"写 → 审 → 改"的小循环可以自己转。

## 6. 仓库隔离（git）

- 每个节点二选一：`--isolated`（默认）或 `--shared`（只读节点，如审查、调研）。不是 git 仓库的目录，所有节点都直接在 run 的目录里跑。
- **分支命名**：集成分支 `af/<run>/main`，节点分支 `af/<run>/node/<node>`。（不能用 `af/<run>` 加 `af/<run>/<node>`：git 里一个 ref 不能同时是文件和目录。）
- run 开始时，从当前 HEAD 建 `af/<run>/main`，并在 `<repo>/.agent-flow/worktrees/<run>/_main` 开一个集成 worktree。**用户的分支在整个 run 期间不会被碰。** 所有 git 操作都是 `git -C <目录>`，不切换用户的分支。
- isolated 节点第一次执行时，从 `af/<run>/main` 切出节点分支，在 `<repo>/.agent-flow/worktrees/<run>/<node>` 开 worktree。直接用 git 创建，不用 `herdr worktree create`，因为我们有自己的 UI，不需要 Herdr 的分组。
- **worktree 放在仓库里面**，并写进 `.git/info/exclude`。原因是 claude 的"信任此文件夹"会从父目录继承（已实测）：用户信任过仓库，新 worktree 就不会在启动时弹框卡住。已知副作用：仓库里的其他工具（测试运行器、搜索）可能扫到 `.agent-flow/`，需要时让用户在工具配置里排除它。
- shared 节点在集成 worktree 里跑，能看到到目前为止所有已接受的工作。
- **提交**：worker 执行 `af done` 时，server 把它目录里的改动自动提交（提交作者 `agent-flow`）。worker 自己不需要 commit。
- **合并**：accept 时，server 把节点分支 `--no-ff` 合并进 `af/<run>/main`。下游节点在合并之后才切分支或刷新，所以**图的依赖关系 = git 的先后关系**。
- **再次执行**（回边触发）：节点的 worktree 保留，派发前先把 `af/<run>/main` 合并进节点分支，拿到别的节点已接受的改动。
- **合并冲突**：不自动处理。合并被中止，实例留在 submitted 状态，"需要你"里出现一条待办，并通知 lead。lead reject 时，给 worker 的消息里会附上"先执行 `git merge af/<run>/main` 并解决冲突"。
- run 结束后，`af/<run>/main` 交给用户，由用户决定怎么合进自己的分支。
- 已知成本：每个 worktree 都要重新装依赖。v0 不处理，以后在团队模板里加 `setup:` 命令。

## 7. 通信：终端唤醒 + 文件信箱

- 消息正文存成 JSON 文件：`~/.agent-flow/runs/<run>/mail/<agent>/<ts>-<id>.json`。
  ```json
  { "id": "m_…", "run": "…", "from": "lead", "to": "coder-1", "node": "code#2",
    "kind": "task|notice|reply|submit|system", "body": "…",
    "attachments": ["/abs/path/…"], "reply_to": null, "ts": "…" }
  ```
- 发送方执行 `af send <agent> "..."`。server 写好消息文件，再往对方终端打一行短通知：
  `[agent-flow] 来自 lead 的新消息 m_xxx，运行 af inbox 查看`
- **对方的状态决定怎么送**（通过订阅 Herdr 的 `pane.agent_status_changed` 事件判断）：
  - idle / done：立刻送通知。
  - working：先排队，等它变成 idle 再送。
  - blocked：不往终端里打字（避免误答审批提示），在"需要你"里出现一条待办。
- 结果由 agent 主动交：`af reply` 或 `af done`，**不靠读屏**。大的结果（diff、报告）只传文件路径。
- server 监听信箱目录，UI 据此画出消息流。
- 要靠 agent 守规矩用 `af done`（第 0 步实测 15/15）。兜底规则：worker **读过任务后**连续空闲 20 秒仍没提交，server 提醒它一次；再空闲 20 秒就进"需要你"。必须等它读过任务、并且要有宽限期，是因为 agent 的状态会抖动（端到端测试里 codex 收到通知后 1 秒内 working → done → working），立刻提醒会误报。

## 8. CLI：`af`

agent 被派发时，server 会注入环境变量 `AF_RUN`、`AF_AGENT`、`AF_SOCK`，CLI 靠这些知道"我是谁、在哪个 run"。

| 命令 | 谁用 | 作用 |
|---|---|---|
| `af server` | 人 | 启动 af server |
| `af up <team>` | 人 | 按团队模板新建一个 run |
| `af run list / show / stop` | 人、lead | 管理 run |
| `af spawn <name> --kind K [--role ...]` | lead | 起一个具名 agent |
| `af graph add / edit / link / unlink / rm` | lead | 建图、改图 |
| `af graph start / cancel / accept / reject` | lead | 手动派发、取消、校验 |
| `af graph show [--json]` | 所有 agent | 查看图和实例状态 |
| `af diff <node>` | lead | 查看节点分支相对起点的 diff |
| `af send <agent> <text> [--attach PATH]` | 所有 agent | 发消息 |
| `af inbox [--all]` | 所有 agent | 读消息 |
| `af reply <msg-id> <text> [--attach PATH]` | 所有 agent | 回复消息 |
| `af done [--outcome X] [--result PATH] [--note ...]` | 下属 | 提交当前节点 |
| `af ls [--json]` | 所有 agent、人 | 列出机器、workspace、tab、pane（agent、查看器、shell） |
| `af read <agent\|pane> [--lines N]` | 所有 agent | 读另一个 agent 或 pane 最近的输出 |
| `af open <path\|url> [--down] [--of PANE] [--in VIEWER] [--tab [WS]]` | 所有 agent、人 | 在自己旁边（或指定 pane 旁边、已有查看器里、新 tab 里）显示文件、文件夹或网页 |
| `af split [PANE] [--down] [--agent K]` | 所有 agent、人 | 分屏出一个 shell，或一个 agent（在 run 的 workspace 里会作为 run 的成员加入） |
| `af close <pane>` | 所有 agent、人 | 关闭 pane |

- 用 `bun build --compile` 打包成单个二进制，启动要快，因为 agent 会频繁调用它。
- 所有命令都支持 `--json`，方便 agent 解析输出。

## 9. Skill

- 有两份：`skill/lead/SKILL.md`（建图、改图、校验、何时用 auto-accept / isolated / 具名 agent）和 `skill/worker/SKILL.md`（读任务、`af done` 的用法、outcome 约定、大结果传路径）。
- **不依赖各家的 skill 目录**（skill 是按需加载的，不保证一定会读）。协议在启动 agent 时直接注入系统提示；任务通过信箱送达。
- 启动参数（第 0 步实测有效，见 `spikes/s2s3-agents/`）：

| agent | 注入协议 | 必须加的其他参数 |
|---|---|---|
| claude | `--append-system-prompt-file <worker.md>` | 权限模式由用户配置（spike 用 `--permission-mode auto`） |
| codex | `-p agent-flow-<role>`：server 把协议写进 `$CODEX_HOME/agent-flow-<role>.config.toml` 的 `developer_instructions` | profile 里写 `check_for_update_on_startup = false`（否则更新提示会卡住启动）；命令行加 `-c sandbox_workspace_write.network_access=true`（沙盒模式下否则连不上 af 的 Unix socket） |
| omp | `--append-system-prompt=<worker.md>` | 无 |

- 环境变量（`AF_RUN`、`AF_AGENT`、`AF_SOCK`、`PATH` 里加上 af）通过 `herdr tab create --env` 注入，在 login shell 里也能保住（已实测）。
- **协议文本绝不能放在命令行上。** Herdr 是把启动命令"打"进 shell 的，macOS 终端单行输入上限 1024 字节（MAX_CANON），超出部分被截断，codex 会卡在半截命令里（端到端测试实测）。所以只传文件路径或 profile 名，命令行保持在 200 字节以内（有测试守着）。
- 启动流程：建 pane → `herdr agent start --kind <k> -- <参数>` → 等到 idle → 送第一条通知。
  - 卡在 blocked（信任框、登录过期等）：进"需要你"，不自动按键，用户在 UI 里打开它的终端回答。
  - 根本没起来（如超时）：关掉它的 tab，取消该实例，通知 lead"修好原因后 `af graph retry <node>`"，不自动重试。
- **claude 的文件夹信任以 git 仓库为单位**（端到端测试实测）：worktree 算主仓库的一部分；不在 git 里的目录才沿父目录往上找。所以每个新仓库，lead 第一次启动时用户确认一次信任即可，之后所有 worktree 都不再弹框。
- `af graph retry <node>`：给一个空闲节点手动开新实例（输入沿用上一个实例），并且**一律换新 agent**：该节点原来的 agent 被退役（关 tab、标记退出）。用于 agent 挂掉后的恢复。下属 agent 意外退出时，server 会把这条恢复命令发给 lead。

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
- **左栏**：顶部是当前 run 的"需要你"；下面是一棵树：机器 → workspace（run 的 workspace 带 ◆ 标记和待办数）→ 其中的 agent 及状态。点 agent 跳到它所在的 tab 和 pane。已关闭 workspace 的旧 run 列在"Past runs"。SSH 机器折叠成一组。
- **中间**：所选 workspace 的 Herdr tab；每个 tab 是 Herdr 的二叉分屏树。pane 有三种：终端（shell）、agent、查看器（文件 / 文件夹 / 网页）。pane 头上有分屏（右 / 下）、"＋"（在旁边开 claude / codex / omp agent，或文件 / URL）、关闭。run 的 workspace 默认打开 lead 的 tab。
- **右栏**：只在 run 的 workspace 里出现：图（或消息列表）+ 节点详情。节点详情里的终端是只读观察模式，不抢分屏里那个 pane 的控制权，旁边有"Go to pane"跳过去。
- **底部**：常驻终端抽屉，它自己的 Herdr workspace 不在树里显示。

### 10.2 查看器 pane 和 `af open`

- 查看器是一个普通的 Herdr pane，里面运行 `af viewer`。server 在 `~/.agent-flow/views.json` 里记"哪个 pane 显示什么"。网页看到这个记录，就画高亮的文件 / Markdown / 图片 / PDF / 网页；Herdr TUI 里则显示 `af viewer` 打出的纯文本（有 bat 就用 bat 高亮）。pane 被关掉后记录自动清除。
- `af open` 默认在**调用者自己的 pane 旁边**开查看器，所以 worker 开的文件出现在它自己的 tab 里，不抢用户的焦点；`--of` 指定开在谁旁边，`--in` 换掉已有查看器的内容（避免越开越多），`--tab` 开新 tab。run 里的调用仍然记一条 `open.requested`，节点详情的 "opened" 列表照旧。
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
- 实时终端默认隐藏，只在三种情况出现：agent 等审批或提问（blocked，自动出现，输入框禁用并提示去终端回答）；发送了以 `/` 开头的斜杠命令（可能弹菜单）；用户点状态栏的 "terminal"。agent 工作时状态栏有 "■ Stop"（发 Esc）。

### 10.2.3 远程机器（2026-11-02）

- **不需要升级 Herdr，也不在远程装任何东西。** Herdr 自己的 TUI 就是 SSH 到每台机器、直接连那台机器的 Herdr server；agent-flow 做同样的事。机器列表来自 `herdr machine list`（用户在 Herdr 里存过的机器）。
- **每台机器一条 SSH 主连接**（ControlMaster，`~/.agent-flow/ssh/<机器>.ctl`），上面跑三样东西：
  1. **把远程 Herdr 的 Unix socket 转发到本机**（`ssh -O forward -L ~/.agent-flow/ssh/<机器>.sock:<远程 home>/.config/herdr/herdr.sock`）。于是本地的 Herdr 适配层原样可用：JSON API、事件订阅、`herdr` CLI（`HERDR_SOCKET_PATH` 指过去）。实测：snapshot 115 ms，订阅正常。
  2. **终端实时流**：`ssh <机器> <远程 herdr> terminal session control|observe <pane>`，和本地同一种 NDJSON。实测：首帧 32–180 ms，打字回显中位数 8 ms（同一局域网）。
  3. **短命令**：读远程 agent 的对话记录（`ls`、`tail -c`，按字节偏移增量读）、把附件写到远程的 `~/.agent-flow/attachments/`。
- **id 带机器前缀**：远程的 workspace / tab / pane id 写成 `<机器>~<原 id>`，如 `allinai2plus~w6:p3`；本地 id 不变。所有操作按前缀路由到那台机器。`af ls`、`af read`、`af split` 等对远程 id 一样可用；`af connect <机器>` 手动连接。
- **按需连接**：远程机器默认不连；在侧栏展开、或 `af connect` 时才连。断线后按 5 s、10 s、20 s……最长 60 s 重试；断线期间那台机器的 pane 从模型里去掉，侧栏显示原因（需要密码、主机不可达、主机密钥变了、远程没有运行 Herdr……），并有"retry"。
- 需要免密 SSH（BatchMode）。实测 allinai2plus、ds03 可以；其余机器未测。
- **增删机器**（用户要求）：侧栏"+ machine"填 SSH 目标（和可选名字）→ `herdr machine add`，写进 Herdr 自己的机器列表（Herdr TUI 里也会出现），随后自动连接。远程没装 Herdr、需要确认安装时，Herdr 要交互确认：表单给出"在常驻终端里运行 setup"按钮，把 `herdr machine add …` 打进常驻终端，由用户回答。机器"⋯"菜单里"Remove machine…"→ `herdr machine remove`；那台机器上的 Herdr server 和 agent 继续运行，再加回来就能接上。每 15 秒同步一次 Herdr 的机器列表，在 Herdr TUI 里增删的机器也会跟着变；机器的 id 按 Herdr profile 固定。
- **增删 workspace**（用户要求）：每台机器行上的"+"新建 workspace（远程机器支持 `~` 路径，目录在那台机器上检查）；workspace"⋯"菜单里"Close workspace…"关闭并停止其中所有进程（如果是 run 的 workspace，同时停止该 run），确认框里写明会停掉几个 agent、几个 pane。
- 远程 agent 的渲染视图：对话记录在远程读，按 session 精确匹配（实测 3 个远程 agent 都命中）；轮询 1.5 秒一次；打开时只读最后 8 MB。
- 远程 agent 粘贴图片：附件写到**远程机器**上，提示词里给的是远程路径，agent 能直接读。
- 暂不支持：在远程 pane 旁边开查看器（查看器是本地进程）；在远程机器上跑 run 的 worker。
- 注意：网页里打开远程 pane 时，那个 pane 的 PTY 会变成网页里的尺寸（和本地同一条 Herdr 多客户端规则）。

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
    core/     共享类型：图、实例、消息、事件
    server/   Bun：Herdr 适配层、调度器、信箱、git、WebSocket
    cli/      af
    web/      React + Vite + xterm.js + React Flow
    skill/    lead/ 与 worker/ 两份 SKILL.md
  spikes/     第 0 步的验证代码，验证完就丢
  docs/
```

**状态全部用文件保存，不用数据库：**

```
~/.agent-flow/
  server.sock                 CLI ↔ server
  teams/                      全局团队模板
  runs/<run>/
    run.json                  run 元数据（仓库、集成分支、lead）
    graph.json                图 + 所有实例的当前状态（只由 server 写）
    events.jsonl              只追加的事件流：所有状态变化、消息、派发
    mail/<agent>/*.json       信箱
    out/                      结果文件
```

- `graph.json` 只能由 server 写。CLI 一律通过 server 修改，避免几个 agent 同时提交时把文件写坏。
- `events.jsonl` 是唯一的事实来源。`graph.json` 可以从它重建，UI 的回放也靠它。

## 12. v0 范围

**包含：**
- server：Herdr 适配层、信箱、图调度（自动派发、条件边、回边、`--max`）、worktree 隔离与合并、`events.jsonl`
- cli：第 8 节列出的全部命令
- skill：lead 和 worker 两份，支持 claude、codex、omp
- web：第 10 节的布局、标签页、图、节点详情、"需要你"待办、深色主题

**不包含：** 常驻总控（Super-Agent 那种一直在线接活的）、脚本式 workflow、文件编辑、Tauri 打包、手机端和远程访问、claude / codex / omp 以外的 agent、浅色主题、worktree 依赖安装（`setup:`）。

## 13. 第 0 步：风险验证（2026-11-02 完成，全部通过）

结果：S1 见 `spikes/s1-terminal/RESULT.md`；S2、S3 见 `spikes/s2s3-agents/RESULT.md`。三种 agent 共 15 个任务全部一次交对。对设计的修改已经写进第 3.1、6、9 节。另外一条：`af done --result` 由 CLI 把相对路径转成绝对路径。

原计划如下：

| # | 验证什么 | 通过标准 | 不通过怎么办 |
|---|---|---|---|
| S1 | `terminal session control` 接到 xterm.js 上的延迟和流畅度 | 打字回显延迟中位数低于 30 ms；`seq 1 200000` 时界面不卡死、不丢最终画面；和 Herdr TUI 同时开着时不打架 | 改用 observe 读画面 + `pane send-text` 写输入；还不行就重新评估自研 PTY |
| S2 | claude / codex / omp 拿到 skill 后会不会老实用 `af done` 交结果 | 每种 agent 跑 5 个小任务，交结果的格式正确、outcome 合法的比例不低于 90% | 加强 skill；加超时提醒；或者让 server 在 agent 变 idle 时追问一次 |
| S3 | 派发时能不能自动给新开的 agent 注入 skill、角色和环境变量 | 三种 agent 都能用一条命令起来，并且拿到任务 | 某种 agent 只能退回"第一条 prompt 里写全部说明" |

## 14. 验收场景

用一个专门的沙盒仓库（不用 agent-flow 自己，避免 agent 一边被这个工具调度、一边改这个工具的代码）：

1. 用户在 UI 里对 lead 说一个任务。
2. lead 建图：2 个并行的写代码节点（一个 codex、一个 omp，都是 isolated），加 1 个 claude 审查节点（`--auto-accept`），审查到 fail 就回到写代码节点（`--max 3`）。
3. 全程自动派发。至少发生一次 fail → 重写 → pass 的循环；lead 至少 reject 一次。
4. 所有节点通过，合并进 `af/<run>/main`，用户的 main 不变。
5. 用户只看网页 UI 就能看懂发生了什么。中途关掉浏览器、甚至重启 af server，再打开时状态完整。

## 15. 以后再做

- 常驻总控：一个常驻的具名 agent，盯着 GitHub 或群聊，自己执行 `af run new`。现有设计已经能承载它。
- 脚本式 workflow：TS 脚本调用同一套 `af` 命令，用于需要严格可重复的流水线。
- 文件编辑：基于 CodeMirror，保存前检查 agent 有没有改过这个文件。
- Tauri 打包：解决快捷键被浏览器抢走、iframe 不能嵌入部分网站、系统通知受限这几个问题。
- worktree 依赖安装：团队模板里的 `setup:`。
