---
name: vflow-commit
description: "Smart git commit workflow with change classification, split suggestions, Chinese commit messages, and safety checks. Use when the user says '提交', '提交代码', 'commit', 'commit changes', '保存改动', or asks to save their work."
---

# vflow-commit — Smart Commit

Classify changes → suggest splits → generate Chinese commit message → one-shot confirmation → execute.

## Flow

### Stage 1: Repository Validation

1. Confirm inside a git repo, no rebase/merge in progress
2. `git status` + `git diff` (staged and unstaged) to gather all changes

### Stage 2: Change Classification [required]

Split dirty files into two categories — **never silently commit the second**:

- **Session-related**: Files edited in this session
- **Unrecognized**: Files not touched in this session (may be manual edits or parallel work) → list and ask whether to include, default exclude

### Stage 3: Split Suggestions

Cluster by concern (source / test / docs / config). If multiple independent change groups are detected (>300 lines spanning multiple top-level directories), suggest splitting into multiple commits with a grouping plan; proceed as a single commit if the user declines.

### Stage 4: Generate Commit Message

Follow project conventions (Chinese commit messages):

```
类型: 简短描述

- 要点（可选，动机/影响范围）
```

Types: feat/fix/refactor/docs/test/chore. First line ≤72 characters.

**Desensitization check**: Scan staged content for token/key/password/secret patterns. If suspicious → stop and warn.

### Stage 5: One-Shot Confirmation [HARD STOP]

Show the complete plan (file list + commit message), wait for the user's response:
- "ok" / "可以" / "行" → execute
- "我自己来" / "manual" → abort, don't generate a second version
- Other feedback → adjust based on feedback and re-show

### Stage 6: Execute

```bash
git add <explicit file list>   # never git add -A
git commit -m "<message>"
git log --oneline -1           # echo confirmation
```

## Hard Rules

1. Don't commit unrecognized files without explicit user consent
2. Don't use --no-verify / --force; hook failure → fix the issue then make a new commit, no --amend
3. Don't push (push requires a separate user request)
4. One commit = one concern
