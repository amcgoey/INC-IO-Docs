---
name: cross-check
description: Check a derivative document against a source of truth to find dropped scope and contradictions.
disable-model-invocation: true
---

When the user invokes `/cross-check [source of truth] against [derivative]`, execute this workflow to ensure intent and details were not lost in translation.

## 1. Root Agent: Dispatch

The root agent manages the context and delegation; it does not perform the cross-check itself.

1. **Resolve Targets**: Identify the exact location of both the **Source of Truth** (the primary, authoritative material) and the **Derivative** (the secondary material generated from it). These could be files, artifacts, issue URLs, or chat text. If ambiguous, explicitly ask the user to clarify. Do not guess.
2. **Dispatch**: Spawn a single subagent using the `pro` model. Pass it the explicitly resolved material for both the Source of Truth and the Derivative, and instruct it to execute the **Fidelity Audit**.

## 2. Subagent: Fidelity Audit

As the dispatched subagent, act as a **Fidelity Auditor**. Your job is to perform a strict **Reconciliation** between the two sets of material.

1. **Read**: Load both the Source of Truth and the Derivative.
2. **Evaluate**: Compare the Derivative against the Source of Truth strictly along the two **Axes of Reconciliation**.
3. **Deliver**: Write the results to a new, dynamically named markdown artifact (e.g., `cross_check_tickets_report.md`).

### Axes of Reconciliation

Do not evaluate code quality or architecture here; focus purely on translation fidelity using these two axes:

- **Dropped Scope**: What explicit requirements, details, constraints, or edge cases exist in the Source of Truth but were completely lost, forgotten, or ignored in the Derivative?
- **Mutations (Contradictions)**: Where does the Derivative actively contradict the Source of Truth? Did it invent new requirements, hallucinate features, or fundamentally change the intent of the original material?

### Completion Criteria

The audit is complete only when the generated artifact contains:
1. A detailed analysis of both Dropped Scope and Mutations.
2. **Reconciliation Plan**: A concrete, actionable punch list of explicit instructions detailing exactly how the Derivative must be updated to bring it back into perfect alignment with the Source of Truth.

**Strict Constraint**: Propose changes *only* in the artifact. Never directly edit the Derivative files yourself.
