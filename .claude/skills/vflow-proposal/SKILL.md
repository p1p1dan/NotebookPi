---
name: vflow-proposal
description: "vflow2 proposal-driven workflow guide. Use when starting or progressing ANY non-trivial code change under vflow, or when the user mentions 'proposal', '提案', 'vflow workflow', '走流程', 'create proposal', '建提案', 'advance', 'accept', '验收', or asks how the lifecycle / artifacts / acceptance work. Covers tier classification, the intake→…→archived lifecycle, hand-written JSON artifacts, and the pause-report-approve acceptance protocol."
---

# vflow2 Proposal Workflow

Guides the proposal-driven lifecycle for code changes. Every non-trivial change goes through a structured lifecycle ensuring quality, traceability, and user control.

**The authoritative CLI is `node .vflow/scripts/dist/proposal.js <command>`.** Stage prompts are also injected automatically by the hook system — read them.

## Tier Classification (do this FIRST)

- **T0**: Pure question/explanation → answer directly, NO proposal
- **T1**: Clear, local, low-risk → fast path (abbreviated analysis, single execution item)
- **T2**: Standard feature/fix → full stage walk with execution loop
- **T3**: Architecture/core/high-risk → T2 + mandatory design confirmation

**Before touching code on a T1+ task, create the proposal FIRST — do not free-run analysis or edits without one.**

## Lifecycle

```
intake → analysis → design → plan → execution → verify → pending_acceptance → done → archived
```

## Artifacts are hand-written JSON

There is **no scaffolding command**. At each stage you author the artifact yourself with the Write tool, then `advance`:

| Stage produces | File | Copy field shape from |
| :--- | :--- | :--- |
| intake → | `proposals/<id>/analysis.json` | `.vflow/templates/proposal/analysis.json` |
| analysis → | `proposals/<id>/design.json` | `.vflow/templates/proposal/design.json` |
| design → | `proposals/<id>/plan.json` | `.vflow/templates/proposal/plan.json` |
| plan → | `proposals/<id>/execution.json` | `.vflow/templates/proposal/execution.json` |
| verify → | `proposals/<id>/verify.json` | `.vflow/templates/proposal/verify.json` |

`<id>` is the `P-YYYYMMDD-NNN` printed by `create`. The gate to advance checks the artifact's required fields are non-empty — see each stage prompt.

## Quick Reference

```bash
# Create
node .vflow/scripts/dist/proposal.js create <slug> --title "..." --type <bug|feature|refactor|reference_build> --tier <T1|T2|T3>

# Status
node .vflow/scripts/dist/proposal.js status
node .vflow/scripts/dist/proposal.js list

# Advance (after the stage artifact is written)
node .vflow/scripts/dist/proposal.js advance

# Execution loop
node .vflow/scripts/dist/proposal.js execution add-item --title "..." [--depends E-001]
node .vflow/scripts/dist/proposal.js execution start-item --item E-001
node .vflow/scripts/dist/proposal.js execution complete-item --item E-001 --evidence "..."

# Verify
node .vflow/scripts/dist/proposal.js verify run
node .vflow/scripts/dist/proposal.js verify check --check V1 --passed --evidence "..."

# T3 design confirmation (after the user approves in-conversation)
node .vflow/scripts/dist/proposal.js confirm-design --user-approved

# Acceptance (after the user approves in-conversation) + archive
node .vflow/scripts/dist/proposal.js accept --user-approved
node .vflow/scripts/dist/proposal.js knowledge suggest
node .vflow/scripts/dist/proposal.js archive [--html]
```

## Acceptance Protocol (pending_acceptance)

This is where the AI hands control back. **Do not silently run `accept`.**

1. **PAUSE.** Report to the user: goal / current state / diff-from-goal / verification results / known risks.
2. **ASK** whether the result meets their requirements.
3. **Only after the user approves in this conversation**, relay it: `accept --user-approved`. The event is logged with `from=ai_relay` — auditable.
4. Then process knowledge and archive.

The user may also accept themselves in a terminal (`accept`, interactive yes/no). The same pause-report-approve pattern applies to T3 `confirm-design --user-approved` and `verify waive --user-approved`.

## Key Invariants

1. `proposal.stage` is the single source of truth for lifecycle progress
2. `execution.items[].status` is the single source of truth for execution progress
3. Stage and item status never cross-contaminate
4. Session runtime is hint-only — never overwrites proposal truth
5. Only one `doing` item per proposal at any time (serial execution)
6. **The AI may run `accept` / `confirm-design` / `verify waive` only with `--user-approved`, and only after explicitly reporting to and getting the user's in-conversation approval.** The acceptance event (`confirmed_by_user:true`) remains the hard gate for `done`/`archived`; `--user-approved` only records that the AI relayed the user's approval (`from=ai_relay`).
7. `review.md` is derived at archive time from structured history, not maintained during runtime
8. T3 design confirmation is invalidated on back-to-design — must re-confirm after changes

## Guardrails

During execution, STOP and confirm with the user if the goal changed, scope expanded, risk increased, or the key approach switched. If a major new problem is discovered:

```bash
node .vflow/scripts/dist/proposal.js back --to design
```
