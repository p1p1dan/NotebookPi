---
name: vflow-debug
description: "Deep post-bug analysis to break the fix-forget-repeat cycle: root cause classification, failed-fix review, prevention mechanisms, and knowledge capture. Use when the user says '分析 bug', '根因分析', '为什么出错', 'debug analysis', 'root cause', 'why did this break', or after fixing a recurring bug."
---

# vflow Debug — Break the Loop

When a bug is fixed, use this for deep analysis to prevent the same class of bugs from recurring. The value of debugging is not in fixing the bug, but in making this class of bugs never happen again.

## Input Contract

- A bug that was just fixed (code changes visible in git diff or conversation context)
- Optionally: failed fix attempts from the current session

## Steps

### 1. Root Cause Classification [required·once]

Classify the bug into exactly one category:

| Category | Characteristics | Example |
| :--- | :--- | :--- |
| **A. Missing Spec** | No documentation on the correct approach | New feature without convention guidance |
| **B. Cross-Layer Contract** | Interface between layers unclear or violated | Function returns different format than caller expects |
| **C. Change Propagation** | Changed one place, missed dependent places | Changed function signature, missed call sites |
| **D. Test Coverage Gap** | Unit test passes, integration fails | Works in isolation, breaks when combined |
| **E. Implicit Assumption** | Code relies on undocumented assumption | Coordinate system mismatch, unit confusion |

### 2. Failed Fix Review [on demand]

If multiple fix attempts were tried before succeeding, analyze each failure:

| Pattern | Meaning |
| :--- | :--- |
| Surface Fix | Fixed symptom, not root cause |
| Incomplete Scope | Found root cause, didn't cover all cases |
| Wrong Layer | Kept looking in the same layer, didn't think cross-layer |
| Tool Limitation | grep missed it, type check wasn't strict enough |

### 3. Prevention Mechanisms [required·once]

Identify what would prevent this class of bug from recurring:

| Type | Description | Example |
| :--- | :--- | :--- |
| Documentation | Write it down so future sessions know | Add to spec/ |
| Architecture | Make the error structurally impossible | Type-safe wrappers, enum instead of string |
| Compile-time | Strict type checking catches it | Signature change causes type error |
| Runtime | Monitoring or validation catches it | Assertion at boundary |
| Test | Automated test reproduces it | Regression test for this exact case |

Prioritize: which single mechanism gives the most leverage?

### 4. Systematic Expansion [required·once]

Ask: where else might this same class of bug exist?

- **Similar code**: grep for the same pattern in other files
- **Same interface**: other callers of the same function/API
- **Same assumption**: other places relying on the same undocumented fact

If similar issues found → report them (do not fix silently — inform the user).

### 5. Knowledge Capture [required·once]

The analysis is worthless if it stays in conversation. Capture it where it will be reused:

- If the insight is a reusable convention/pattern/forbidden/gotcha → record it for spec writeback. When an active vflow proposal exists, surface it as a knowledge candidate during the proposal's archive/knowledge step (`knowledge suggest`), classified as Convention / Pattern / Forbidden / Gotcha. Otherwise propose adding it to `.vflow/spec/` (target file: `common/` for principles, `lang/` for language-specific, `modules/` for feature-specific, `domain/` for project knowledge) and ask the user before writing.
- If the insight is ephemeral / one-off → state it in the conversation so the user has it; no permanent writeback needed.

## Output Template

```
## Bug Analysis: {short description}

### Root Cause
**Category**: {A/B/C/D/E} — {category name}
**Specific cause**: {one paragraph}

### Failed Fixes (if applicable)
1. {attempt}: {why it failed} ({pattern})

### Prevention
| Priority | Mechanism | Action | Status |
| :--- | :--- | :--- | :--- |
| P0 | {type} | {specific action} | TODO/DONE |

### Expansion
- Similar issues found: {list or "none found"}

### Knowledge Capture
- {spec file / knowledge candidate / conversation} ← {what was captured}
```

## Guardrails

- Every analysis must produce at least one actionable prevention mechanism — don't just describe the bug
- Spec writeback requires user confirmation — do not write to `.vflow/spec/` without asking
- Do not fix similar issues found in step 4 without informing the user — they may be intentional or out of scope
- 30 minutes of analysis saves 30 hours of future debugging — invest the time
