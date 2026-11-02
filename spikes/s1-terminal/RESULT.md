# S1 结果：Herdr terminal session control → xterm（2026-11-02，Herdr 0.9.0）

结论：**通过。**

| 指标 | 结果 | 标准 |
|---|---|---|
| 单键回显延迟（60 次） | p50 19.3 ms，p90 20.5 ms，p99 71.3 ms | p50 < 30 ms |
| `seq 1 200000` | 310 ms 跑完；只收到 18 帧、共 8.8 KB；最终画面正确（最后一行 200000、SEQ_DONE、提示符） | 不卡死、不丢最终画面 |
| 滚动历史 | `terminal.scroll {direction:"up"/"down", lines:N}` 后，Herdr 把滚动后的画面推进流里，回看 500 行历史正确 | — |
| PTY 尺寸 | 控制端声明的 cols/rows 会成为 PTY 实际尺寸（`stty size` = 36 120） | — |

## 对设计的影响

1. **流里是渲染后的画面差分，不是 PTY 原始字节流。** Herdr 自己维护终端状态，只发画面变化。好处是高速输出时浏览器几乎没压力。代价是浏览器里的 xterm.js 自己没有回滚历史：
   - 鼠标滚轮要转成 `terminal.scroll` 发给 Herdr，不能用 xterm.js 自带的滚动。
   - xterm.js 的 `scrollback` 设为 0。
   - 查完整历史用 `pane read --source recent-unwrapped`。
2. **输入格式**：`{"type":"terminal.input","text":"..."}` 或 `{"type":"terminal.input","bytes":"<base64>"}`。`data` 字段不认。
3. **尺寸会抢**：同一个 tab 被多个客户端看时，最后操作的那个决定 pane 尺寸。所以 agent-flow 给每个 run 建自己的 Herdr workspace，不和用户的 TUI 共用 tab。
4. **只能一个 controller。** UI 里当前看着的终端用 `control`；缩略图、预览用 `observe`（可以多个同时看）。
5. socket API 的 JSON 方法里没有 terminal session，它走的是内部二进制协议。所以 server 要给每个打开的终端起一个 `herdr terminal session control/observe` 子进程，只给正在看的终端起。

已知未测：浏览器端的真实渲染（headless xterm 验证了数据正确，帧数很少，浏览器渲染不会是瓶颈）；和 Herdr TUI 同时看同一个 tab 的冲突（按文档规则规避）。
