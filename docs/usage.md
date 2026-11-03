# agent-flow 使用指南

agent-flow 让多个 agent（claude、codex、omp）同时干活，每个 agent 在自己的终端里跑，你在网页里看到它们之间的关系图（右侧的 graph）。有三种用法，从轻到重：

## 1. 在任何一个 session 里直接说（最常用）

在你平时用的 claude、codex 或 omp 里，直接用大白话说要让别的 agent 做什么，例如：

> 让一个 codex 和一个 omp 同时做两件事：codex 统计 calc.js 里有几个导出函数，omp 检查 test.js 的断言。做完汇总给我。

> 开两个 codex 并行：一个改登录页，一个改注册页；改完让 claude 审一遍，不过就打回。

这个 session 会用 agent-flow 的 skill（服务器启动时装进 `~/.claude/skills/agent-flow` 和 `~/.codex/skills/agent-flow`；omp 也读 claude 的 skill 目录）：

1. 执行 `af here`：这个 session 成为一个 run 的 lead，右侧出现这个 workspace 的 graph。
2. 用 `af graph add …` 把每件事建成一个节点。没有依赖的节点同时开始，每个节点在这个 workspace 里开一个新 tab，起一个新 agent。
3. worker 交结果时，这个 session 的终端里会出现 `[agent-flow] New message …`，它会去看结果、通过或打回。
4. 全部做完后它向你汇报。

改代码的节点在自己的 git 分支上改，通过后合并进这个 run 的集成分支 `af/<run>/main`，**不会动你当前的分支**；要不要合进来由你决定。

## 2. 从 workflow 模板开始一个 run

workflow 模板就是一张事先画好的图：有哪些节点、各用哪种 agent、谁接谁、哪里不通过就打回重做。

**在网页里**：左栏 "+ new" → New run → 选目录 → 在 "Workflow" 里选一个模板（下面会显示它的图）→ 写一句目标 → Start。图立刻建好并开始跑，lead 负责盯着和校验，你也可以随时改图。

**在命令行里**：

```bash
af workflow list                                   # 有哪些模板
af up --workflow implement-review --goal "给登录页加验证码"
```

内置的 4 个模板：

| id | 名字 | 图 |
|---|---|---|
| `implement-review` | 实现 + 审查循环 | code（codex）→ review（claude）；review 不通过 → 打回 code，最多 3 轮 |
| `bugfix` | 修 bug | reproduce（claude）→ fix（codex）→ verify（claude）；不通过 → 打回 fix |
| `compare-plans` | 两个方案择优再实现 | plan-a（codex）、plan-b（claude）同时出方案 → choose → implement → review，不通过打回 |
| `research-write-review` | 调研 → 写作 → 审稿 | research → draft（claude）→ critique（codex）；不通过 → 打回 draft，最多 2 轮 |

一个已经在跑的 run（包括用 `af here` 开的）也可以加入模板：`af graph apply implement-review --goal "…"`。

## 3. 自己写模板，或把跑得好的 run 存成模板

- **存下来**：run 的图面板右上角点 "save as workflow"（或 `af workflow save "名字"`）。目标会变回 `{{goal}}`，下次换个目标直接用。
- **自己写**：放在 `~/.agent-flow/workflows/<id>.yaml`（你自己的，所有项目都能用）或 `<仓库>/.agent-flow/workflows/<id>.yaml`（只在这个项目里出现，可以提交进仓库和别人共享）。同名的会覆盖内置的。

```yaml
name: 实现 + 审查循环
description: codex 写代码，claude 审查；不通过就打回重写。
lead: claude                    # 可选
nodes:
  - id: code
    kind: codex                 # claude | codex | omp，默认 claude
    task: |
      目标：{{goal}}
      实现它，跑测试。完成后提交 outcome pass。
  - id: review
    kind: claude
    after: [code]               # 依赖；也可以写 [{ from: code, on: pass }]
    shared: true                # 只读工作，在集成分支上做，不单独开分支
    autoAccept: true            # 它交的结果不用 lead 校验
    task: |
      审查 {{goal}} 的改动。没问题提交 pass，否则 fail 并写修改意见。
loops:
  - { from: review, to: code, on: fail, max: 3 }   # 环：review 交 fail 就回到 code
```

写任务时让一个**没看过这段对话的新 agent** 也能照着做：目标、涉及的文件、怎么验证、可以交哪些 outcome。长的结果让它写到 `$AF_OUT`（这个 run 的输出目录，不在仓库里），用 `--result` 交上来。

## 常用命令速查

| 做什么 | 命令 |
|---|---|
| 让当前 session 当 lead | `af here` |
| 加节点 | `af graph add <id> --kind codex --task "…" [--after a,b] [--shared] [--auto-accept]` |
| 加环 | `af graph link review code --on fail --max 3` |
| 看图 | `af graph show` |
| 看某个 agent 在干嘛 | `af read <agent>` |
| 看结果 / 通过 / 打回 | `af inbox` · `af diff <node>` · `af graph accept <node>` · `af graph reject <node> --reason "…"` |
| 改图 | `af graph edit / rm / cancel / retry <node>` |
| 结束 | `af run stop` |
| 完整说明 | `af guide lead` |
