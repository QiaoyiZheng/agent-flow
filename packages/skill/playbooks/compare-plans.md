---
name: 两个方案择优再实现
description: codex 和 claude 各自独立出方案，router 让第三个成员比较定稿，再实现并审查；审查不过就打回实现，最多 3 轮。
---

# Compare two plans, then build

Members: plan-a (codex), plan-b (claude), chooser (claude), reviewer (claude): all --no-worktree. builder (codex): --worktree in a git repository.

1. Open T1 for plan-a and T2 for plan-b at the same time, both with the goal in the user's words. Task: do not change files; design an implementation: files to change, how, risks and trade-offs, how to test; another member designs one independently, so give reasons. Plan in result.md.
2. When both are ready: a ticket for chooser with --from T2 and the T1 result.md as an input (af ticket open chooser ... --from T2, and name T1's result.md in the task): compare them, pick one or merge the best parts, write the final plan in result.md.
3. Optional: if the plans differ in a way the user should decide, af report both and the chooser's pick, and wait for the user's answer (it comes as a new request).
4. A ticket for builder --from <chooser's ticket> --max 3: implement the final plan, run the tests, commit on its branch.
5. Builder ready: a ticket for reviewer --from <builder's ticket>: review the change against the final plan; PASS or FAIL as the first word of the note, concrete fixes in result.md. FAIL: back to the builder with --from. PASS: af report "<what was built, branch, how it was checked>" --done.
