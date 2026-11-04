---
name: 修 bug
description: 先复现并定位，再修复并加回归测试，最后独立验证；验证不过就带着意见打回修复，最多 3 轮。
---

# Bug fix

Members: reproducer (claude), fixer (codex, --worktree when the repository is git), verifier (claude).

1. T1 for reproducer: the problem in the user's words. Task: do not change files; reproduce it; write the smallest reproduction (commands, input, actual and expected result) and the likely cause (file:line) in result.md. Submit ready, or failed if it does not reproduce (what was tried).
2. Reproduced: a ticket for fixer --from T1 --max 3: fix it, add a test that would have caught it, run the reproduction again, commit on its branch. Submit ready with the cause and the fix in the note.
3. Fixer ready: a ticket for verifier --from <fixer's ticket>: in the fixer's worktree (its folder is in the fixer's result), run the reproduction from T1's result.md and the related tests; do not change files; submit ready with PASS or FAIL as the first word of the note, and what is left in result.md.
4. FAIL: a ticket for fixer --from <verifier's ticket>. PASS: af report "<cause, fix, branch, how it was verified>" --done.
5. Not reproducible, or the round limit: af report and ask the user.
