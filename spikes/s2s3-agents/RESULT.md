# S2 + S3 结果：agent 注入与协议遵守（2026-11-02）

结论：**都通过。**

## S3：启动注入

三种 agent 都能用一条命令启动，并拿到协议（系统提示）、环境变量和任务。参数见 `run-one.sh`，已写入 `docs/design.md` 第 9 节。

踩到并解决的坑：
1. **claude 在未信任的新目录会弹信任框，卡在 blocked。** 信任会从父目录继承（在已信任的 `/Users/zhengqiaoyi/agent-flow` 下的子目录启动，不弹框）。→ worktree 放在仓库内的 `.agent-flow/worktrees/`。
2. **codex 启动时弹更新提示，卡住。** → `-c check_for_update_on_startup=false`。
3. **codex 在 `workspace-write` 沙盒里连不上 Unix socket**（`codex sandbox` 实测：默认失败，`sandbox_workspace_write.network_access=true` 后成功）。→ 沙盒模式下派发时加上这个参数。连不上时 codex 仍按协议尝试 `af done --outcome error` 并写明原因。
4. 环境变量用 `herdr tab create --env` 注入，在 login shell 里保留，包括改过的 `PATH`。

## S2：协议遵守率

每种 agent 5 个任务，任务通过信箱送达，通知行是 `[agent-flow] New message ... Run: af inbox`。

| agent | 一次交对 | 平均耗时 |
|---|---|---|
| claude | 5/5 | 17 s |
| codex | 5/5 | 21 s |
| omp | 5/5 | 48 s |

5 个任务：写文件（pass）；判断数字之和（应答 fail）；列文件写报告并交路径；读不存在的文件（应答 error）；修 bug 并跑测试（pass）。全部 outcome 正确，没有重复提交，没有用到提醒。

## 发现的小问题

- omp 交的 `--result` 是相对路径（`ts-files.txt`），claude 和 codex 交的是绝对路径。→ `af done` 由 CLI 按调用时的 cwd 把路径转成绝对路径。
- omp 的任务 1 用了 118 s，其他任务 20–50 s，原因没查（可能是模型思考时间）。

## 这次没有覆盖的

- 任务都很小、说明很明确。长任务、上下文被压缩之后还守不守协议，要在 v0 的真实场景里看。
- 通知都是在 agent 空闲时送的。agent 正在忙时排队送达的逻辑，v0 再测。
