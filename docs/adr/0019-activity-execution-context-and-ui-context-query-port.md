# ActivityExecutionContext Pipeline Reducer and UiContextQueryPort

**Status:** accepted

`DocumentService.processDocument()` runs a **Shared Pipeline Reducer** over `workflow.activitySequence` that passes an immutable `ActivityExecutionContext` (`document`, `files`, `stepOutputs`, `contextVariables`) into `ActivityDispatcherPort.dispatch(activity, context?)` and `ActivityHandler.handle(activity, context?)`, while `SchemaDrivenUiService.generateView()` loads read-only pre-submit context through one domain-agnostic `UiContextQueryPort` (parallel to `OptionsFetcherPort`).

## Context & Trade-offs

Sequential workflows such as `MOVE_FILE` followed by `WRITE_LOG`, multi-artifact submittal chains in [[Idea] Create Submittal Activiites](https://github.com/amcgoey/INC-IO-Docs/issues/274) (`MOVE_FILE` -> `DUPLICATE_FILE` -> `INSERT_PAGES` -> `WRITE_LOG`), and workflow reads (`READ_LOG`) need downstream `Activity` steps to consume structured outputs produced by upstream steps without mutating `Document.data` or violating [0004-unified-activity-output.md](0004-unified-activity-output.md). Concurrently, pre-submit card rendering requires supplemental read-only domain data (such as `DocumentLog` resolution status and collapsible `idGroup` history) without turning `UiProcessManager` into a query engine ([0013-cqrs-ui-orchestration.md](0013-cqrs-ui-orchestration.md)) or coupling `src/features/schema-driven-ui/` to domain feature slices.

### Considered Options

- **Fluent TypeScript workflow builders (`moveFile().writeLog()`)**: Rejected because workflows are declared as JSON in `documentWorkflowConfig`; imperative code pipelines bypass schema-driven configuration and require code releases per workflow variant.
- **Handlebars-only duplicated payloads in `documentWorkflowConfig`**: Rejected because duplicating filename/path templates across steps cannot supply runtime Drive IDs/URIs returned by `MOVE_FILE`, cannot address distinct outputs from multi-file chains, and pushes transient artifacts into `Document.data` or ad-hoc `contextVariables` keys.
- **Loading `READ_LOG` state inside `UiProcessManager` (`formData`)**: Rejected because it breaks CQRS command/query boundaries ([0013-cqrs-ui-orchestration.md](0013-cqrs-ui-orchestration.md)) and mixes read-only display models with submission inputs.
- **Feature-specific query ports on `SchemaDrivenUiService` (e.g., `DocumentLogQueryPort`)**: Rejected because direct feature ports leak domain concepts into `schema-driven-ui` and add constructor churn for every new contextual card panel.

## Decision

1. **Shared Pipeline Reducer (`ActivityExecutionContext` + optional `Activity.id`)**:
   - `ActivityDispatcherPort.dispatch(activity, context?)` and `ActivityHandler.handle(activity, context?)` in `src/features/document/ports.ts` share one uniform signature (`context?` preserves source compatibility with single-argument handlers).
   - `DocumentService.processDocument()` folds each step's `ActivityOutput` over `workflow.activitySequence` into a fresh, immutable `ActivityExecutionContext`:
     - `document`: the validated `Document`, immutably replaced when `documentDataPatch` is returned.
     - `files`: `readonly FileLocator[]` from the most recent file-producing `Activity`, giving linear pipelines (`MOVE_FILE` -> `WRITE_LOG`) zero-config access to upstream filed outputs.
     - `stepOutputs`: record keyed by an optional `id` property on `Activity` (and exposed in Handlebars template evaluation as `Context.<id>`), letting multi-artifact chains such as [[Idea] Create Submittal Activiites](https://github.com/amcgoey/INC-IO-Docs/issues/274) address an earlier step's `FileLocator`s explicitly.
     - `contextVariables`: merged key-value state populated across steps (where workflow-invoked `READ_LOG` stores hydrated `Document[]`).
   - Ephemeral request credentials and UI disambiguation selections remain out of `ActivityExecutionContext` and enter adapters through per-request DI in `src/app/` ([0005-per-request-dependency-injection-for-context.md](0005-per-request-dependency-injection-for-context.md)).

2. **Domain-Agnostic Pre-Submit Read Seam (`UiContextQueryPort`)**:
   - `UiProcessManager` remains Command-only (`copyDocumentLog`, selection state, `processDocument`).
   - `SchemaDrivenUiService.generateView()` accepts one optional `UiContextQueryPort` (parallel to `OptionsFetcherPort`), requests only the context keys declared by the active `DocumentType` / `UiViewSchema` (`'document-log'` today), dispatches by query key in `src/app/`, and passes the typed query output into pure `UiBlock`s.

## Consequences

- `Activity` stays serializable (`type`, optional `id`, `payload`), and adapters remain decoupled behind unified `ActivityOutput` ([0004-unified-activity-output.md](0004-unified-activity-output.md)).
- Linear pipelines read `context.files` implicitly while branching multi-artifact pipelines bind `Context.<id>`, keeping `Document.data` restricted to validated document fields.
- `SchemaDrivenUi` stays feature-agnostic; new pre-submit read panels plug into `UiContextQueryPort` in `src/app/` without touching `UiProcessManager` or `SchemaDrivenUiService` signatures.

## Amendment (2026-11-24 — `READ_LOG` `contextVariables` Output Shape)

Reconciling Decision #1 with [0021-document-log-schema-and-resilient-hydration.md](0021-document-log-schema-and-resilient-hydration.md), workflow-invoked `READ_LOG` steps store `DocumentLogEntry[]` (wrapping hydrated `Document` payloads with `valid`, `fileUri`, `rowNumber`, and `validationErrors`) at `contextVariables[outputVariable ?? 'logEntries']`, paired with `RowHydrationWarning[]` at ``contextVariables[`${outputVariable ?? 'logEntries'}Warnings`]`` and summary metadata `{ spreadsheetId, sheetName, entryCount, warningCount }` at `contextVariables.documentLogRead`.
