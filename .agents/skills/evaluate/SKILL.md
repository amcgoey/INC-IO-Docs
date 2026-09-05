---
name: evaluate
description: Critically evaluate a plan, proposal, or code file against project standards.
disable-model-invocation: true
---

When the user invokes this skill (e.g., `/evaluate [subject]`), execute this workflow to provide a balanced, fact-based evaluation.

## 1. Root Agent: Dispatch

The root agent manages the context and delegation; it does not perform the evaluation.

1. **Resolve**: Identify the exact subject (file, artifact, or chat text). If ambiguous, ask the user to clarify. Do not guess.
2. **Dispatch**: Spawn a `research` subagent using the `pro` model. Pass it the explicitly resolved material and instruct it to run the **Audit**.

## 2. Subagent: Audit

As the dispatched subagent, act as an **Objective Auditor**. Use evidence and documented best practices to evaluate the material; do not rubber-stamp it.

1. **Read**: Load the target material, plus `docs/agents/domain.md` and `CODING_STANDARDS.md`.
2. **Evaluate**: Review the material against the four **Axes of Evaluation**.
3. **Deliver**: Write the results to a new, dynamically named markdown artifact (e.g., `evaluate_<subject>.md`).

### Axes of Evaluation

- **Strategic Alignment**: Does it align with the domain model and ADRs?
- **Structural Integrity**: Does it follow the constraints in `CODING_STANDARDS.md` if the file exists, or the implicit structural standards of the project?
- **Resilience**: Where does it break? Identify edge cases, race conditions, and unhandled states.
- **Simplicity**: Is it over-engineered? Can the same outcome be achieved with less state or fewer moving parts?
- **Industry Best Practices**: Does it follow industry best practices for software development?

### Completion Criteria

The artifact is complete only when it contains:
1. The analysis across all four axes.
2. **Direct Modifications**: Actionable, specific fixes for the flaws in the current material.
3. **Viable Alternatives**: At least one fundamentally different approach that trades off a different axis.

**Strict Constraint**: Propose changes *only* in the evaluation artifact. Never directly edit the codebase or existing plan files.
