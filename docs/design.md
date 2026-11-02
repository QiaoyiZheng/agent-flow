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
| **run** | 一次完整的协作任务。有自己的图、信箱、集成分支 `af/<run>` |
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

- 每个节点二选一：`--isolated`（写代码的节点默认用这个）或 `--shared`（只读节点，如审查、调研；不是 git 仓库的目录也只能用这个）。
- run 开始时，从当前 HEAD 建集成分支 `af/<run>`。**用户的 main 在整个 run 期间不会被碰。**
- isolated 节点第一次执行时，从 `af/<run>` 的最新状态切出 `af/<run>/<node>`，并通过 `herdr worktree create --path` 开 worktree。
- **worktree 放在仓库里面**：`<repo>/.agent-flow/worktrees/<run>/<node>`，并写进 `.git/info/exclude`。原因是 claude 的"信任此文件夹"会从父目录继承（已实测）：用户信任过仓库，新 worktree 就不会在启动时弹框卡住。
- accept 时，server 把 `af/<run>/<node>` 合并进 `af/<run>`。下游节点在合并之后才切分支，所以**图的依赖关系 = git 的先后关系**。
- 合并冲突：不自动处理。实例退回 submitted 状态，并通知 lead。lead 可以 reject 打回（让原 agent 基于最新的 `af/<run>` 解决冲突），也可以加一个修复节点。
- run 结束后，`af/<run>` 交给用户，由用户决定怎么合进 main。
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
- 已知风险：要靠 agent 守规矩用 `af done`。第 0 步要实测遵守率；如果超时还没交，server 提醒它一次，再不行就进"需要你"。

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
| `af open <url\|path>` | 所有 agent、人 | 在 UI 里打开网页或文件 |

- 用 `bun build --compile` 打包成单个二进制，启动要快，因为 agent 会频繁调用它。
- 所有命令都支持 `--json`，方便 agent 解析输出。

## 9. Skill

- 有两份：`skill/lead/SKILL.md`（建图、改图、校验、何时用 auto-accept / isolated / 具名 agent）和 `skill/worker/SKILL.md`（读任务、`af done` 的用法、outcome 约定、大结果传路径）。
- **不依赖各家的 skill 目录**（skill 是按需加载的，不保证一定会读）。协议在启动 agent 时直接注入系统提示；任务通过信箱送达。
- 启动参数（第 0 步实测有效，见 `spikes/s2s3-agents/`）：

| agent | 注入协议 | 必须加的其他参数 |
|---|---|---|
| claude | `--append-system-prompt-file <worker.md>` | 权限模式由用户配置（spike 用 `--permission-mode auto`） |
| codex | `-c developer_instructions=<协议，压成一行>` | `-c check_for_update_on_startup=false`（否则更新提示会卡住启动）；如果用沙盒模式，还要 `-c sandbox_workspace_write.network_access=true`（否则连不上 af 的 Unix socket） |
| omp | `--append-system-prompt=<worker.md>` | 无 |

- 环境变量（`AF_RUN`、`AF_AGENT`、`AF_SOCK`、`PATH` 里加上 af）通过 `herdr tab create --env` 注入，在 login shell 里也能保住（已实测）。
- 启动流程：建 pane → `herdr agent start --kind <k> -- <参数>` → 等到 idle → 送第一条通知。启动时卡在 blocked（信任框、更新提示、登录过期等）就进"需要你"，不自动按键。

## 10. UI

### 10.1 布局：以 lead 对话为中心

```
+- runs ------+- [lead] [shell] [report.md] [localhost:3000] -+- 图 ----------+
| * auth-fix  | > refactor login to ...                       | design  ✓     |
|   docs-sync | ● built 4 nodes, dispatching...              |  ├ api   ●    |
|-------------|                                               |  └ ui    ●    |
| 需要你 2     |                                               | code ⟳ 2/3    |
| ! coder-2   |                                               |               |
|   等待审批    |                                               | 点节点 →       |
| ! api 合并冲突|  > _                                          | 终端|消息|diff  |
+-------------+-----------------------------------------------+---------------+
| $ 持久终端                                                        (ctrl+`)  |
+-----------------------------------------------------------------------------+
```

- **左栏**：run 列表；"需要你"待办（agent 卡在审批、合并冲突、环到达上限、agent 异常退出、lead 主动找你）。
- **中间**：标签页。默认是 lead 的终端，还可以开：
  - **终端**：普通 shell，也是 Herdr pane，所以是持久的。
  - **网页**：用 iframe 嵌入。禁止被嵌入的网站提供"在系统浏览器打开"按钮；以后换成 Tauri webview 就没这个限制了。
  - **文件**：只读。Shiki 代码高亮、Markdown、图片、PDF、diff，带"在 VS Code / $EDITOR 打开"按钮。
- **右栏**：实时的图（React Flow）。节点上显示状态、执行者、轮数；环显示 `⟳ 当前轮 / 上限`。
- **节点详情**（点节点后打开）：这个节点 agent 的终端 / 消息 / diff / 它打开过的文件和网页。也可以在这里开终端、文件、网页标签，默认目录是这个节点的 worktree。
- **底部**：一个常驻的持久终端抽屉，按 ctrl+` 展开或收起。
- 下属 agent 平时不占屏幕。

### 10.2 `af open` 打开到哪里

- lead 或人执行：在中间区域开新标签。
- 下属执行：挂到它那个节点的详情面板里，图上的节点出现一个角标，**不抢焦点**。

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
4. 所有节点通过，合并进 `af/<run>`，用户的 main 不变。
5. 用户只看网页 UI 就能看懂发生了什么。中途关掉浏览器、甚至重启 af server，再打开时状态完整。

## 15. 以后再做

- 常驻总控：一个常驻的具名 agent，盯着 GitHub 或群聊，自己执行 `af run new`。现有设计已经能承载它。
- 脚本式 workflow：TS 脚本调用同一套 `af` 命令，用于需要严格可重复的流水线。
- 文件编辑：基于 CodeMirror，保存前检查 agent 有没有改过这个文件。
- Tauri 打包：解决快捷键被浏览器抢走、iframe 不能嵌入部分网站、系统通知受限这几个问题。
- worktree 依赖安装：团队模板里的 `setup:`。
