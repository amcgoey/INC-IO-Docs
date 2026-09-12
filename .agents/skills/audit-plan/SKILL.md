---
name: audit-plan
description: Audit a completed plan or issue across traceability, logic, architecture, and integration using a team of subagents.
disable-model-invocation: true
---

When the user invokes `/audit-plan [target]`, execute this workflow to thoroughly audit a completed plan, artifact, or issue using a multi-agent team.

## 1. Root Agent: Dispatch Orchestrator

The root agent coordinates the audit orchestrator and conducts the resolution interview.

1. **Resolve Target**: Identify the exact target (e.g., `implementation_plan.md`, an artifact, or a GitHub issue).
2. **Locate Transcript**: Determine the absolute path to the current conversation's transcript file (`<appDataDir>\brain\<conversation-id>\.system_generated\logs\transcript.jsonl`).
3. **Dispatch Orchestrator**: Spawn a single subagent (Model: `pro`) with the role `Senior Auditor`. Pass the target, transcript path, and instruct it to execute the **Senior Auditor Protocol**.
4. **Handoff to `/grill-with-docs`**: When the Senior Auditor reports completion, immediately start an interactive `/grill-with-docs` session with the user:
   - Work through the **Open Decisions** and **Recommended Modifications** in the report using the `grilling` design-tree rounds (asking the frontier questions with your recommended choices).
   - Capture approved architectural decisions as ADRs in `docs/adr/` and update `CONTEXT.md` terminology using the `domain-modeling` skill.
   - Update the audited target with the confirmed modifications once all questions are resolved.

## 2. Senior Auditor Protocol

As the Senior Auditor, you are the orchestrator and synthesizer. You coordinate the specialist auditors, reconcile findings, evaluate architectural impact, formulate recommended changes, and compile the final audit report.

### Step A: Spawn the Audit Team

Use `invoke_subagent` to spawn 4 specialist subagents concurrently (all Model: `pro`). Pass the target material to all of them.

1. **Role: Traceability Auditor**
   - **Prompt**: Use your file tools to read the provided `transcript.jsonl` file. Compare the conversation history against the target plan. Find dropped context, missing details, or ignored user instructions. Report back all deviations.
2. **Role: Stress-Test Auditor**
   - **Prompt**: Review the target plan. Hunt for logic holes, edge cases, race conditions, and missing test decisions. Report back all resilience and logical failures.
3. **Role: Architecture Auditor**
   - **Prompt**: Read `docs/agents/domain.md` and `CODING_STANDARDS.md`. Evaluate the plan's architectural seams, module boundaries, leakage, and simplicity (Occam's razor). Report back structural and best-practice violations.
4. **Role: Integration Auditor**
   - **Prompt**: Scan the relevant codebase to evaluate the plan's consequences. Identify prior art or zombie code that must be removed, missing integrations, and fatal flaws in how the plan wires into the existing app. Report back integration risks.

### Step B: Reconcile and Deduplicate

Wait for all 4 subagents to return their reports. Before compiling:

1. **Cross-Check**: Compare findings across all 4 reports to identify duplicate observations and conflicting assessments.
2. **Autonomous Resolution**: Resolve any conflicts or duplicates that can be settled definitively without human intervention (e.g., merging overlapping points, aligning factual discrepancies against the codebase or coding standards). Record each autonomous resolution and its rationale.
3. **Escalate Ambiguities**: Mark any genuine tradeoffs, conflicting requirements, or value judgements that require human guidance for the **Open Decisions** section.

### Step C: Organize by Architectural Impact

Structure all reconciled findings into logical groupings based on how they affect the codebase architecture:
- **Domain Boundaries & Ubiquitous Language**: Core business concepts, entities, terminology conflicts, and domain invariants.
- **Hexagonal Seams & Module Boundaries**: Ports, adapters, dependency direction, abstraction leaks, and module contracts.
- **State & Data Flow**: Concurrency, transaction boundaries, state transitions, persistence, and consistency models.
- **Integration & Prior Art**: External service seams, wiring with existing subsystems, deprecations, and zombie code cleanup.
- **Resilience & Testing Gaps**: Edge cases, failure modes, race conditions, and missing test coverage.

### Step D: Formulate Recommended Modifications

For each finding and architectural group:
1. Consult the project's strategic goals and domain model (`docs/agents/domain.md`, existing ADRs in `docs/adr/`), coding standards (`CODING_STANDARDS.md`), and software engineering best practices.
2. Formulate explicit, actionable modifications to the target plan that resolve the identified flaws while adhering to repo standards.

### Step E: Compile Report Artifact

Write the complete audit findings into a new artifact named `plan_audit_report.md` with the following structure:

1. **Executive Summary**: High-level audit outcome, major risks, and key strengths.
2. **Architectural Findings**: Findings organized by the architectural impact groupings established in Step C.
3. **Recommended Modifications**: Concrete, numbered proposed edits to the target plan with rationales tied to standards and strategic goals.
4. **Open Decisions**:
   - **User Decisions Needed**: Numbered questions formatted for the grilling interview (`❓ Q1 - <Title>: <Context> ➡️ <Recommended Choice>`).
   - **Autonomous Resolutions**: Table or list of inconsistencies/duplicates resolved during Step B along with the reasoning applied.

### Step F: Completion

The audit is complete when `plan_audit_report.md` is written and verified. Send a final message back to the root agent:

> *"Audit complete. Report generated at `plan_audit_report.md` with [N] recommended modifications and [M] open decisions. Ready for /grill-with-docs session."*
