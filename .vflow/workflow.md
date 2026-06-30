# vflow2 Workflow Definition

Pipeline: intake → analysis → design → plan → execution → verify → pending_acceptance → done → archived

## Tier Guide

- **T0**: Pure Q&A — no proposal created
- **T1**: Clear, local, low-risk change — fast path (single item execution)
- **T2**: Standard feature/fix — full stage walk with execution loop
- **T3**: Architecture/core/high-risk — T2 + mandatory design confirmation before execution

## Skip Detection

If the user's request is clearly T0 (question, explanation, no code change), do NOT create a proposal. Answer directly.

---

[workflow-state:no_proposal]

No active proposal. Evaluate the user's request:

1. If T0 (pure question/explanation): answer directly, no proposal needed.
2. If T1+ (code change required): create a proposal.

Command: `node .vflow/scripts/dist/proposal.js create <slug> --title "..." --type <bug|feature|refactor|reference_build> --tier <T1|T2|T3>`

[workflow-state:intake]

Proposal created. Record the user's original request clearly.

**Required artifact:** analysis.json with `problem` and `scope` filled.

**Actions:**
1. Understand what the user wants
2. Use the Write tool to author `proposals/<id>/analysis.json` (problem, scope, constraints, investigation), copying the field shape from `.vflow/templates/proposal/analysis.json`. Artifacts are hand-written JSON — there is no scaffolding command.
3. Advance when ready

**Gate to analysis:** analysis.json must have non-empty `problem` and `scope`.

Command: `node .vflow/scripts/dist/proposal.js advance`

[workflow-state:analysis]

Analysis complete. Now produce design decisions.

**Required artifact:** design.json with at least 1 decision.

**Actions:**
1. Identify key design decisions, alternatives, and tradeoffs
2. Use the Write tool to author `proposals/<id>/design.json` (decisions array), copying the field shape from `.vflow/templates/proposal/design.json`.
3. For T3: present the design decisions to the user; after they approve in-conversation, run `node .vflow/scripts/dist/proposal.js confirm-design --user-approved`.

**Gate to design:** design.json must have ≥1 decision entry.

Command: `node .vflow/scripts/dist/proposal.js advance`

[workflow-state:design]

Design decisions recorded. Now build the execution plan.

**Required artifact:** plan.json with `execution_outline` and `verify_plan.checks` (≥1 check).

**Actions:**
1. Break down implementation into execution items (ordered, with dependencies)
2. Define verification checks (which are gating?)
3. Use the Write tool to author `proposals/<id>/plan.json` (execution_outline + verify_plan.checks), copying the field shape from `.vflow/templates/proposal/plan.json`.

**Gate to plan:** plan.json must have non-empty `execution_outline` and at least 1 verify check.

Command: `node .vflow/scripts/dist/proposal.js advance`

[workflow-state:plan]

Plan ready. Populate execution items and start executing.

**Required artifact:** execution.json with items (non-empty, DAG valid, ≥1 ready).

**Actions:**
1. Add execution items: `node .vflow/scripts/dist/proposal.js execution add-item --title "..." [--depends E-001,E-002]`
2. Advance to execution stage

**Gate to execution:** execution.json items non-empty, DAG has no cycle, ≥1 item is ready.

Command: `node .vflow/scripts/dist/proposal.js advance`

[workflow-state:execution]

Executing. Work through items serially (one `doing` at a time).

**Loop:**
1. Start next ready item: `node .vflow/scripts/dist/proposal.js execution start-item --item E-NNN`
2. Implement the work described by that item
3. Complete with evidence: `node .vflow/scripts/dist/proposal.js execution complete-item --item E-NNN --evidence "..."`
4. Repeat until all items done/cancelled

**Guardrails:**
- If goal/scope/risk/approach changes significantly → stop, confirm with user
- If major new problem discovered → `node .vflow/scripts/dist/proposal.js back --to design`

**Gate to verify:** All items must be `done` or `cancelled`.

Command: `node .vflow/scripts/dist/proposal.js advance`

[workflow-state:verify]

All execution items complete. Run verification checks.

**Actions:**
1. Execute each check from the verify plan
2. Record results: `node .vflow/scripts/dist/proposal.js verify run`
3. **Spec review (if `.vflow/spec/` exists):** perform a three-dimensional review of the files this proposal changed (`git diff` of the execution work) against the relevant spec conventions:
   - **completeness** — are all planned changes and promised tests actually done?
   - **correctness** — does it meet the analysis/acceptance criteria; are edge cases handled?
   - **consistency** — does it violate any spec entry? Grade each finding CRITICAL / WARNING / SUGGESTION (cite file:line + spec entry).
   Write the findings into `verify.json` under `spec_review` (`scope_files` + graded `findings`), then run `node .vflow/scripts/dist/proposal.js verify review`. An un-waived **CRITICAL** finding forces `all_gating_passed=false` (gating fail).
4. If all gating checks pass (and no un-waived CRITICAL) → advance to pending_acceptance
5. If gating checks fail → back to execution with items reopened

**Gate to pending_acceptance:** verify.json `all_gating_passed` must be `true` and no un-waived CRITICAL spec-review finding.

**On failure:** `node .vflow/scripts/dist/proposal.js back --to execution` (reopen failed items)

Command: `node .vflow/scripts/dist/proposal.js advance`

[workflow-state:pending_acceptance]

Technical work and verification complete. PAUSE and hand off to the user — do not proceed silently.

**Actions:**
1. Report to the user: goal / current state / diff-from-goal / verification results / known risks.
2. Explicitly ask whether the result meets their requirements.
3. ONLY after the user approves in this conversation, relay the acceptance:
   `node .vflow/scripts/dist/proposal.js accept --user-approved`
   (the event is logged with `from=ai_relay` — auditable). Then proceed to archive.

**Guardrail:** Never run `accept --user-approved` without first reporting AND getting the user's explicit in-conversation approval. The user may also accept themselves in a terminal: `node .vflow/scripts/dist/proposal.js accept` (interactive yes/no).

[workflow-state:done]

User accepted. Ready for archival.

**Actions:**
1. Archive the proposal (generates review.md from structured history)
2. Extract knowledge candidates and write back to the spec library. Run `knowledge suggest` — it organizes candidates under the four categories. Classify each kept entry and pick a target spec file under `.vflow/spec/`:
   - **Convention** — naming/format/structure agreement
   - **Pattern** — verified implementation approach
   - **Forbidden** — explicitly banned practice
   - **Gotcha** — counter-intuitive trap
   Target file: `common/` (language-agnostic principle) · `lang/<language>.md` (language-specific) · `modules/` (qt/embedded/...) · `domain/<topic>.md` (project domain knowledge). Persist each with `knowledge save`, or `knowledge skip` if nothing is worth keeping.

Command: `node .vflow/scripts/dist/proposal.js archive [--html]`
Knowledge: `node .vflow/scripts/dist/proposal.js knowledge suggest`

[workflow-state:overview]

vflow2 drives every non-trivial code change through a proposal lifecycle. Read this map BEFORE acting — do not reverse-engineer the process mid-task.

Pipeline: intake → analysis → design → plan → execution → verify → pending_acceptance → done → archived

Tier: T0 = pure Q&A, NO proposal (answer directly). T1 = small local change, fast path. T2 = standard feature/fix. T3 = architecture/core/high-risk (design must be confirmed before plan).

BEFORE touching code: if the request is T1+, create the proposal FIRST, then analyze. Do NOT free-run analysis/edits without a proposal.
  `node .vflow/scripts/dist/proposal.js create <slug> --title "..." --type <bug|feature|refactor|reference_build> --tier <T1|T2|T3>`

Artifacts are hand-written JSON — there is NO scaffolding command. At each stage, use the Write tool to author `proposals/<id>/<name>.json` (analysis / design / plan / execution / verify), copying the field shape from `.vflow/templates/proposal/<name>.json`. Write the file, then `advance`.

Acceptance (pending_acceptance): the AI PAUSES and reports goal / current state / diff-from-goal / verification results / risks, then asks the user. After the user approves in-conversation, the AI runs `accept --user-approved` (logged as ai_relay). The user may also accept themselves in a terminal. Same pattern for T3 `confirm-design --user-approved` and `verify waive --user-approved`.

Full step-by-step guide: the `/vflow-proposal` skill.
