---
name: 调研 → 写作 → 审稿
description: 先调研整理材料，再写正文，codex 以审稿人身份严格审读；不过就带着意见重写，最多 2 轮。适合文档、报告、论文章节。
---

# Research, write, review

Members: researcher (claude), writer (claude), critic (codex).

1. T1 for researcher: the topic in the user's words. Task: collect the material the text needs (files in the repository, the web when needed); do not write the text and do not change files; result.md holds the key points, the source of each, and open questions.
2. A ticket for writer --from T1 --max 2: write the text from the research notes; if the task does not say where, a new Markdown file under docs/; claims backed by sources; formulas in LaTeX. Submit ready with the file's path in the note.
3. A ticket for critic --from <writer's ticket>: review the text as a strict reviewer: does the argument hold, do facts and sources match, is it clear; do not change files; PASS or FAIL as the first word of the note, at most 8 numbered changes in result.md.
4. FAIL: a ticket for writer --from <critic's ticket>. PASS: af tell writer "Hand the text over with af deliver.", then af report "<file, what it covers>" --done.
5. Round limit: af report the last review and ask the user.
