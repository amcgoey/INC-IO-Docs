---
name: audit-plan
description: Audit a completed plan or issue across traceability, logic, architecture, and integration using a team of subagents.
disable-model-invocation: true
---

When the user invokes `/audit-plan [target]`, execute this workflow to thoroughly audit a completed plan, artifact, or issue using a multi-agent team.

## 1. Root Agent: Dispatch Orchestrator

The root agent does NOT perform the audit. Its job is to set up the orchestrator and wait.

1. **Resolve Target**: Identify the exact target (e.g., `implementation_plan.md`, an artifact, or a GitHub issue).
2. **Locate Transcript**: Determine the absolute path to the current conversation's transcript file (`<appDataDir>\brain\<conversation-id>\.system_generated\logs\transcript.jsonl`).
3. **Dispatch**: Spawn a single subagent (Model: `pro`) with the role `Senior Auditor`. Pass it the target, the transcript file path, and instruct it to execute the **Senior Auditor Protocol**.
4. **Handoff**: Wait for the Senior Auditor to message you back, then immediately prompt the user with the questions it flags.

## 2. Senior Auditor Protocol

As the Senior Auditor, you are the orchestrator. You do not perform the audits yourself. Do NOT read or parse the `transcript.jsonl` file yourself; your only responsibility with the transcript is to pass its file path to the Traceability Auditor.

### Step A: Spawn the Audit Team
Use the `invoke_subagent` tool to spawn the following 4 subagents concurrently (all Model: `pro`). Pass the target material to all of them.

1. **Role: Traceability Auditor**
   - **Prompt**: Use your file tools to read the provided `transcript.jsonl` file. Compare the conversation history against the target plan. Find dropped context, missing details, or ignored user instructions. Report back all deviations.
2. **Role: Stress-Test Auditor**
   - **Prompt**: Review the target plan. Hunt for logic holes, edge cases, race conditions, and missing test decisions. Report back all resilience and logical failures.
3. **Role: Architecture Auditor**
   - **Prompt**: Read `docs/agents/domain.md` and `CODING_STANDARDS.md`. Evaluate the plan's architectural seams, module boundaries, leakage, and simplicity (Occam's razor). Report back structural and best-practice violations.
4. **Role: Integration Auditor**
   - **Prompt**: Scan the relevant codebase to evaluate the plan's consequences. Identify prior art or zombie code that must be removed, missing integrations, and fatal flaws in how the plan wires into the existing app. Report back integration risks.

### Step B: Compile Report
Wait for all 4 subagents to send their final reports via message. Once all 4 are received, write the compiled findings into a single new artifact named `plan_audit_report.md`.

### Step C: Required Resolutions
Analyze the 4 reports. Identify any contradictions between the sub-auditors, inconsistencies in the plan, or critical missing decisions.
Create a section at the bottom of the artifact titled **Required Resolutions** and list these as explicit questions that the user must answer.

### Step D: Completion
The audit is complete when the artifact is saved. Send a final message back to the root agent: *"Audit complete. Please ask the user the questions listed in the Required Resolutions section of the report."*
