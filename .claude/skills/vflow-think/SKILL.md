---
name: vflow-think
description: "Structured thinking models for development decisions. Mode A: First principles analysis (6-phase). Mode B: SWOT comparison for multi-option decisions. Use when the user says 'first principles', '第一性原理', 'challenge assumptions', 'compare options', 'SWOT', '方案比选', or needs to evaluate decisions systematically."
---

# vflow Think — Structured Decision Analysis

Two modes for two types of decisions:
- **Mode A: First Principles** — Challenge assumptions, reason from ground truths (single approach, deep analysis)
- **Mode B: SWOT Comparison** — Structured comparison of multiple candidate approaches (multi-option, breadth analysis)

## Mode Selection

| Trigger | Mode |
| :--- | :--- |
| "first principles", "第一性原理", "challenge assumptions", "is this the right approach" | Mode A |
| "compare options", "SWOT", "方案比选", "which approach", "A vs B", multiple candidates | Mode B |
| Unclear | Ask: "Are you questioning whether the approach is right (Mode A: First Principles), or choosing between known alternatives (Mode B: SWOT)?" |

---

## Mode A: First Principles Analysis

Decompose complex problems into irreducible truths and reason upward — avoiding the trap of reasoning by analogy, convention, or "best practice".

## When to Use

- Evaluating whether an architecture, design, or strategy is truly optimal
- Questioning "best practices" that may not fit the current context
- Making foundational decisions with long-term impact
- Challenging inherited assumptions in legacy systems
- Any moment where "we've always done it this way" is the primary justification

## When NOT to Use

- Trivial decisions (just pick the simplest option)
- Time-critical emergencies (act first, analyze later)
- Well-validated problems with proven solutions (don't reinvent the wheel)

## Steps

### 0. Frame — Establish Axioms [required·once]

Define irreducible truths that constrain this domain.

**Axiom test**: Can this be further decomposed? Is this provably true (not just commonly believed)? Would violating this definitely cause failure?

**Gate**: Produce ≥3 axioms before proceeding. Each axiom: one sentence + "why irreducible".

### 1. Essence — Identify the Core Problem [required·once]

Strip away implementation details:

1. State the problem in one sentence
2. Separate symptoms from causes
3. Define measurable success criteria

**Key questions**: What is the fundamental job to be done? If this system didn't exist, what would we actually need?

**Gate**: One-sentence problem statement + measurable success criteria.

### 2. Assumptions — Surface and Challenge [required·once]

This is the highest-leverage phase. Most "best practices" are assumptions disguised as facts.

Produce an assumption table with ≥5 rows:

| Assumption | Why Question It | Axiom(s) Used | Verdict |
| :--- | :--- | :--- | :--- |
| "We need X" | {challenge} | A1, A2 | Keep / Discard / Modify |

**Red flags** (likely false assumptions): "We've always done it this way" / "Industry standard says..." / "Everyone uses X" / "That's too simple to work"

**Gate**: ≥5 assumptions challenged with verdicts. Each verdict references at least one axiom.

### 3. Ground Truths — Establish What IS True [required·once]

From challenged assumptions, identify what is irreducibly true for this specific problem.

**Ground truth test**: Can this be further decomposed? Is this provably true? Would violating this cause failure?

```
❌ "Users need fast response times" (too vague)
✅ "P99 latency must be < 200ms per SLA §3.2" (specific, verifiable)
```

**Gate**: ≥3 ground truths, each specific and falsifiable.

### 4. Reason Upward — Build from Ground Truths [required·once]

```
Ground Truth → Minimal Solution → Justified Additions → Final Design
```

1. Start minimal — what's the simplest thing that satisfies all ground truths?
2. Add only what's necessary — each addition must reference a ground truth
3. Challenge each layer — does this earn its complexity?

**Gate**: Reasoning chain where every step traces to a ground truth.

### 5. Validate and Stress-Test [required·once]

Three validation questions:

| # | Question | If "no" |
| :--- | :--- | :--- |
| 1 | Can every conclusion trace back to a ground truth? | Unjustified assumptions in Phase 4 |
| 2 | Is every ground truth covered by at least one conclusion? | Solution ignores a constraint |
| 3 | Were any phases skipped or done shallowly? | Go back and finish |

Apply at least one stress-test model:

| Model | Question | When it helps |
| :--- | :--- | :--- |
| Pre-Mortem | "12 months later, this failed. Why?" | When you're excited about the solution |
| Inversion | "What would guarantee failure?" | Finding blind spots |
| Second-Order | "If this works, what happens next?" | Systemic effects |

**Gate**: All 3 validation answers = "yes" + at least one stress-test applied.

## Progress Tracker (Anti-Drift)

Maintain throughout the analysis. After each phase, output the tracker to the conversation:

```
🧭 FP Progress
- [x] Phase 0: Frame — ✅ 3 axioms
- [x] Phase 1: Essence — ✅ "..."
- [→] Phase 2: Assumptions — 3/6 checked
- [ ] Phase 3: Ground Truths
- [ ] Phase 4: Reason Upward
- [ ] Phase 5: Validate
```

If conversation drifts (user asks a tangent), after addressing it:
> 📍 Returning to FP analysis: Phase N has M items remaining. Continuing.

If the analysis must survive across sessions, ask the user for a file to persist the tracker and phase outputs (e.g. a scratch note), or — when an active vflow proposal exists — record the conclusions in the proposal's design decisions.

## Depth Standards

| Phase | Shallow (Fail) | Deep (Pass) |
| :--- | :--- | :--- |
| Assumptions | "Maybe we don't need this" | Table row with challenge + axiom reference + verdict |
| Ground Truths | "Users want fast" | "P99 < 200ms per SLA §3.2" |
| Reasoning | "So we should use X" | "GT#2 + GT#3 → eliminates Y → X is minimal solution" |

## Common Traps

- **Complexity Trap**: Solution more complex than warranted. FP check: remove one component — still works? That component wasn't essential.
- **Analogy Trap**: "Company X does it this way." FP check: is our problem identical in all dimensions?
- **Legacy Trap**: Maintaining compatibility with obsolete decisions. FP check: do original conditions still exist?

## Top 5 Dangerous Biases

| Bias | How It Corrupts FP | Quick Debias |
| :--- | :--- | :--- |
| Confirmation | "Find" ground truths that confirm preferred solution | Seek disconfirming evidence first |
| Anchoring | Conventional approach becomes mental anchor | Generate 3 alternatives before evaluating |
| Sunk Cost | Legacy decisions feel like ground truths | "Starting from zero, would we choose this?" |
| Status Quo | Current state feels like a constraint | Separate true constraints from current choices |
| Overconfidence | Treat assumptions as ground truths | Assign confidence % to each assumption |

---

## Mode B: SWOT Comparison

For choosing between known alternatives. Build a structured comparison instead of deep single-path analysis.

## Steps

### 1. Enumerate Candidates [required·once]
List 2-4 concrete approaches. Each gets a one-line summary. Reject "do nothing" unless it's a genuine option.

### 2. SWOT Each Candidate [required·once]
For every candidate produce:

| | Helpful | Harmful |
| :--- | :--- | :--- |
| **Internal** | Strengths | Weaknesses |
| **External** | Opportunities | Threats |

Keep entries concrete and specific to this project — no generic platitudes.

### 3. Score Against Criteria [required·once]
Define the decision criteria first (e.g. effort, risk, maintainability, performance, reversibility). Weight them. Score each candidate per criterion.

| Criterion | Weight | Cand A | Cand B | Cand C |
| :--- | :--- | :--- | :--- | :--- |

### 4. Recommend [required·once]
State the winner, the decisive criterion, and what would change the decision. Note the strongest idea from each runner-up worth grafting onto the winner.

## Guardrails

- **No artifact → no next phase.** If a gate is not met, stop and complete it.
- Phase gates are mandatory — no skipping even if the user says "just give me the answer".
- The progress tracker must be output after each phase completion (Mode A).
- This skill is standalone — it can run at any time, independent of any active workflow.
