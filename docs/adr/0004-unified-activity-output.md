# Unified Activity Output Interface

Activities executed by the workflow engine (e.g. moving a file) originally returned `void` and mutated a shared context object to pass data back to the Workspace UI. This destroyed the strict port/adapter seam and broke one-way data flow.

With over 14 distinct activities planned (inserting pages, drafting emails, extracting AI data), strongly typing each activity's specific return shape (e.g., `FileMoveResult`, `EmailDraftResult`) would bloat the core domain and violate the Open-Closed Principle.

We decided to model activity returns as a unified "Domain-Effect" interface (`ActivityOutput`) rather than activity-specific events. Every driven adapter can map its result into this uniform shape, which consists of `success`, `error`, `recordDataPatch`, and `contextVariables`.

**Consequences:**
- The domain remains decoupled from the growing list of specific adapter capabilities.
- The workflow engine can process any activity output by merging `recordDataPatch` and `contextVariables` into the in-flight workflow evaluation context.
- Workflow execution halts and propagates errors if an activity returns `success: false`.
- Adapters avoid mutating shared context objects, preserving clean one-way data flow across ports.
