# Code Fix Plan 3: Issue #119

## Executive Summary
This document outlines the final remediation steps for Issue #119, evaluating the latest code review findings against the architectural constraints of Epic #113 and the upcoming migration in Issue #120. We have analyzed the implementation's convergence and classified the remaining findings into immediate fixes and accepted technical debt.

## Convergence Analysis
The codebase is converging cleanly towards the target Hexagonal Architecture. While `src/features/workspace` contains legacy inline evaluations and is slated for complete removal in Issue #120, we must maintain strict dependency inversion rules immediately. Injecting `evaluateFormChange` via `WorkspaceFeatureApiOptions` in the wiring layer (`src/app/workspace.wiring.ts`) eliminates the hard architectural violation without over-investing in a module that will soon be purged. Deepening the cascading dropdown test in `test/e2e-tracer-bullet.test.ts` to verify dynamic UI state updates on JSON Logic roundtrips fully satisfies the final Acceptance Criteria of Issue #119.

## "Keep" List with Justifications
The following findings are acknowledged but accepted "As-Is":
1. **Legacy inline evaluation in workspace adapter**: (Accepted) The `handleFormChange` evaluates form changes inline rather than routing through `schema-driven-ui/domain.ts`. The entire `src/features/workspace` module will be deleted in Issue #120.
2. **Repeated switches in wiring ACL**: (Accepted) Type narrowing cascade mapping `UiView` to `AbstractUiView` in `src/app/workspace.wiring.ts` is a standard pattern for type-safe boundary translation.
3. **Data clumps in legacy adapter overrides**: (Accepted) The `overrides` parameter in `prepareDriveDocumentProcessCardContext` within `src/features/workspace/adapters/api.ts` will be deleted in Issue #120.
4. **Scope creep citation for review hardening commits**: (Accepted) These were intentional and necessary review fixes from previous iterations.

## "Fix Now" List

### 1. Architectural Dependency Inversion
**File**: `src/features/workspace/adapters/api.ts`
**Type**: Refactor / Fix Hard Violation
**Changes**:
- Remove direct import of `evaluateFormChange` from `../../../infrastructure/workspace-addon/json-logic-evaluator`.
- Update `WorkspaceFeatureApiOptions` interface to accept an `evaluateFormChange` dependency injection.
- Use the injected `evaluateFormChange` inside `handleFormChange`.

**File**: `src/app/workspace.wiring.ts`
**Type**: Refactor / Wiring
**Changes**:
- Inject `evaluateFormChange` from the infrastructure layer into `registerWorkspaceFeatureRoutes` when initializing the workspace feature API.

### 2. Deepen E2E Tracer Bullet Tests
**File**: `test/e2e-tracer-bullet.test.ts`
**Type**: Test Enhancement
**Changes**:
- Deepen interaction loops test to programmatically navigate cascading dropdowns via simulated JSON Logic roundtrips.
- Assert dynamic UI state updates (e.g., conditional visibility or dependent field options updating based on upstream selection).

## Verification Plan
### Automated Tests
- Execute test suite to verify no regressions in existing flows.
- Run `npx jest test/e2e-tracer-bullet.test.ts` to confirm the deepened interaction loops correctly assert dynamic cascading UI state updates.

### Manual Verification
- Review the module imports in `src/features/workspace/adapters/api.ts` to ensure zero direct dependencies on `infrastructure/`.
