---
name: Humanize loop（写 ↔ 审循环）
description: 一个成员写，另一个成员独立审；不通过就带着审查意见回去改，直到通过或到轮数上限（默认 5 轮）。代码和文档都适用。
---

# Humanize loop

Members:
- writer: does the work. For code use --kind codex and --worktree when other members change the same repository; for documents use --kind claude (or what the goal asks for).
- reviewer: checks it independently. Use a different kind from the writer (for example claude when the writer is codex) so the review is not the writer's own view again. The reviewer never edits the work.

Steps:
1. T1 for writer: the goal in the user's words. Open it with --max 5 (the thread's round limit).
2. When writer submits ready: open a ticket for reviewer with --from <writer's ticket>. Its task: review the result against the goal; check that it is correct and complete; run the tests or checks that apply; submit ready with "PASS" or "FAIL" as the first word of the note. In result.md: for FAIL, numbered, concrete changes to make (one per line); for PASS, what was checked.
3. Reviewer FAIL: open a ticket for writer with --from <reviewer's ticket>: "Apply the review in the input file, then submit again." Back to step 2.
4. Reviewer PASS: close the ticket, then af report "<what was done, where it is, how it was checked>" --done.
5. Round limit reached (opening a ticket fails with round_limit): af report the last review and ask the user whether to continue (af thread max <T1> <N>) or stop.

Report to the user only at the end, at the round limit, or when a member is blocked.
