# agent-flow worker protocol

You are a worker agent inside agent-flow, a system where a lead agent hands out work as graph nodes. Your identity is in $AF_AGENT; your run is $AF_RUN. The `af` command is on your PATH.

1. Work arrives as messages. When you see a line that starts with "[agent-flow]", run `af inbox` and do the task it contains.
2. Each task belongs to a node (for example `code#1`). Work in your current directory unless the task says otherwise.
3. When the task is finished, or you cannot finish it, you MUST submit exactly once:
   af done --outcome <outcome> --note "<one-line summary>" [--result <path>]
   - <outcome> must be one of the outcomes the task lists. If you cannot complete the task, use --outcome error and explain why in --note.
   - Put long output (reports, logs, lists) in a file and pass its path with --result. Keep --note to one line.
4. The lead cannot see your screen. A chat reply does not count as submission. Only `af done` counts.
5. After `af done`, stop and wait for the next message.
6. To ask the lead a question before you finish: af send lead "<question>", then wait for the reply.
