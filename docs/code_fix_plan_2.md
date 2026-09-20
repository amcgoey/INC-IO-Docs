# Code Fix Plan: Issue #119 vs Epic #113 Review

## Executive Summary
The codebase is generally converging well against Epic #113 and Issue #119. A recent code review surfaced a few standard violations and spec discrepancies. A critical constraint in the Google Workspace Cards API requires clarification regarding how validation errors are rendered, directly conflicting with the literal acceptance criteria of Issue #119. Furthermore, upcoming maintenance (Issue #120) impacts how we should treat legacy glue code. This plan categorizes findings into immediate action items ("Fix Now") and deliberate acceptances ("Keep / As-Is") to maintain forward momentum without wasted churn.

## Convergence & Spec Inconsistency Analysis
The primary spec inconsistency stems from a direct conflict between the acceptance criteria of Issue #119 and the technical realities of the Google Workspace Cards API.
- **The Conflict:** Issue #119 states, "Validation errors are passed back as context to the schema-driven-ui read to display inline error messages." However, Google Workspace Card widgets (e.g., `textInput`, `selectionInput`) do not support native, per-input inline error properties.
- **The Resolution:** Epic #113 explicitly anticipated this limitation by specifying the use of a `Status Message Block` to render validation errors at the card level. The implementation must honor the Epic's architectural directive over the Issue's literal (but technically impossible) AC.
- **Subagent Misinterpretation:** The Spec subagent incorrectly interpreted prompt exclusions ("exclude X") as prohibitions ("developer is not allowed to build X"). This led to false positive spec violations that can be safely ignored.
- **Convergence:** Overall convergence is positive. Legacy glue code in `src/features/workspace` is slated for complete deletion in upcoming Issue #120 ("Scavenge and Purge Legacy Code (Contract)"). Therefore, refactoring efforts within that boundary should be minimized to avoid wasted effort.

## "Keep / As-Is" List
The following findings represent deliberate acceptances and will **not** be fixed:

1.  **Spec Finding: "Inline error messages" (Issue #119 AC conflict)**
    *   **Justification:** The Google Workspace Cards API lacks per-input inline error support. We will follow Epic #113's directive to use the `Status Message Block` for validation errors. The literal AC from Issue #119 is technically unimplementable as written and represents an inconsistent spec, not a developer error.
2.  **Spec Finding: Subagent Prompt Exclusions**
    *   **Justification:** The subagent misinterpreted negative constraints in its prompt as spec prohibitions. These are false positives.
3.  **Baseline Smell: `src/infrastructure/workspace-addon/translator.ts` manual type narrowing**
    *   **Justification:** While primitive obsession and repeated switches for action unions are a smell, this infrastructure translator code is constrained by the shape of the external API it's mapping to. If it's isolated to the infrastructure boundary, the cost of abstracting it right now outweighs the benefit, especially if it works reliably.

## "Fix Now" List
The following findings represent actionable improvements that enforce clean boundaries without generating wasted churn.

1.  **Hard Violation: `src/app/workspace.wiring.ts` Action Parameter Mapping**
    *   **Finding:** `view` is passed directly to `translateUiViewToNavigationAction(view)` and `translateUiViewToUpdateCardAction(view)` without properly mapping `UiViewAction.parameters` (`Record<string, unknown>`) to `AbstractUiAction.parameters` (`Array<{key: string, value: string}>`).
    *   **Implementation:** Update `src/app/workspace.wiring.ts` to explicitly map the `Record<string, unknown>` to the `Array<{key: string, value: string}>` format required by the infrastructure boundary before passing it to the translation functions.
    *   *Note on Issue #120:* Although `src/features/workspace` will be purged in Issue #120, `src/app/workspace.wiring.ts` represents the core wiring of the application. Fixing the boundary mapping here is crucial for ensuring the new `schema-driven-ui` feature communicates correctly with the infrastructure layer, regardless of legacy code.
2.  **Baseline Smell: `src/features/schema-driven-ui/blocks/document-type-selection.ts` Duplicated Code**
    *   **Finding:** Inlines `...(onChangeAction !== undefined ? { onChangeAction } : {})` instead of reusing a shared helper.
    *   **Implementation:** Extract the logic into a reusable `withOnChangeAction` helper function (or utilize an existing one if present in the block utilities) and apply it in `document-type-selection.ts` to DRY up the code.

## Verification Plan

### Automated Tests
-   Run the unit test suite to ensure the parameter mapping in `src/app/workspace.wiring.ts` does not break existing application wiring.
-   Verify that schema-driven-ui block tests continue to pass after refactoring `document-type-selection.ts`.

### Manual Verification
-   **Parameter Mapping:** Verify through the Workspace Add-on interface that actions (navigation or card updates) triggered from the UI correctly pass their parameters to the backend. The translation from `Record` to `Array<{key, value}>` should be transparent.
-   **Validation Errors:** Manually trigger a validation error (e.g., submitting an empty required field). Verify that the error is displayed gracefully within the `Status Message Block` at the card level, confirming adherence to Epic #113's architectural constraint.
