# DocumentLog Feature Isolation, Manifest-Driven Resolution, and Per-Request Selection

**Status:** accepted

`DocumentLog` lives in an isolated `src/features/document-log/` slice wired in `src/app/document-log.wiring.ts`, resolves per-`DocumentSpace` spreadsheets dynamically (zero caching) from `Manifest` `configuration.documentLog` and optional `DocumentSpaceTypes[].documentLog` overrides with a pre-selected `SelectDocumentLog` prompt on `2+` matches, and injects `selectedLogId` per request via `WorkspaceExecutionContext` following the `SourceFile` precedent.

## Context & Trade-offs

Logging `Document`s across Drive and Gmail triggers spans four consumers: `Document` workflows (`READ_LOG` / `WRITE_LOG`), `SchemaDrivenUi` pre-submit history and status blocks (`UiContextQueryPort`), `UiProcessManager` (`copyDocumentLog` command and disambiguation state), and future dynamic option loading in [[Idea] LookupField Options from Log](https://github.com/amcgoey/INC-IO-Docs/issues/273). Putting `DocumentLog` logic inside `src/features/document/`, repeating org-wide discovery settings inside every `DocumentType` JSON file, silently auto-picking a winner when duplicate logs exist, caching Drive search responses prematurely, or embedding `selectedLogId` inside `Document.data` creates coupling, configuration drift, hidden duplicate logs, stale UI state, and leaked UI artifacts in persisted domain records.

### Considered Options

- **Hosting `DocumentLog` inside `src/features/document/`**: Rejected because `DocumentService` would own Google Sheets/Drive log resolution and pre-submit UI queries, breaking feature isolation and forcing [[Idea] LookupField Options from Log](https://github.com/amcgoey/INC-IO-Docs/issues/273) to depend on `document/`.
- **Putting discovery and template defaults inside every `DocumentType`'s `documentLogSchema`**: Rejected because `"1 Admin"`, `"Document Log"`, and the organization template ID are shared across `DocumentType`s (`Submittal Arch`, `Submittal FF&E`); duplicating them across schemas invites drift.
- **Silent auto-selection when `2+` matching spreadsheets exist (e.g., picking `"1 Admin"` automatically)**: Rejected because duplicate logs in a `DocumentSpace` indicate real Drive ambiguity the user needs to see; surfacing `SelectDocumentLog` with the ranked best match pre-selected preserves one-click speed while exposing duplicates.
- **Drive query caching inside `DocumentLogService`**: Rejected for now because users can copy, rename, or delete spreadsheets in Drive outside the add-on; unified caching belongs to a dedicated future architecture.
- **Passing `selectedLogId` in `Document.data` or `WRITE_LOG` payload**: Rejected because UI disambiguation state pollutes validated domain payloads and activity schemas.

## Decision

1. **Isolated Feature Slice (`src/features/document-log/` + `src/app/document-log.wiring.ts`)**:
   - `src/features/document-log/` and `src/features/document/` remain independent sibling slices that exchange data exclusively through thin adapters in `src/app/document-log.wiring.ts` ([0012-feature-based-composition-roots.md](0012-feature-based-composition-roots.md)).
   - `LogSchemaRegistryAdapter` consumes `RawManifestProviderPort` with fail-fast `initialize()` at startup ([0009-split-manifest-configuration-and-feature-schema-hydration.md](0009-split-manifest-configuration-and-feature-schema-hydration.md)), hydrating `documentLogSchema` alongside minimal target `DocumentSchema` metadata (`fields`, `calculatedFields`, `identity`, `options`).
   - `DocumentLogService` exposes driving port `DocumentLogPort` (`resolveLog`, `copyLog`, `readLog`, `writeLog`) and enforces Guarded Reads ([0011-fast-track-and-guarded-reads.md](0011-fast-track-and-guarded-reads.md)) by hydrating `Document`s on `READ_LOG` and dehydrating `Document`s on `WRITE_LOG`. `RowRecord` stays strictly inside `src/infrastructure/sheets/`.
   - `src/app/document-log.wiring.ts` constructs `DocumentLogService` and wires thin adapters to `DocumentLogActivityHandler` in `ActivityEngine`, `UiProcessManager` (`copyLog`), `SchemaDrivenUi` (`UiContextQueryPort`), and future [[Idea] LookupField Options from Log](https://github.com/amcgoey/INC-IO-Docs/issues/273) (reusing `resolveLog` and spreadsheet reads).

2. **`Manifest`-Driven Discovery, `2+` Pre-Selected Selector & Zero Caching**:
   - Organization-wide discovery and provisioning defaults (`preferredFolderPath: "1 Admin"`, `fileNameContains: "Document Log"`, template spreadsheet ID `1Ops-suWgiqs-_PbaEvdx1WIdUWdVCctJkjS2rPjB42I`) live under `configuration.documentLog` in `assets/manifest.json` (`AppManifestProvider`), with optional per-`DocumentSpaceType` overrides under `DocumentSpaceTypes[].documentLog`.
   - `resolveLog` executes live Drive searches with zero caching, matching non-trashed spreadsheets containing `"Document Log"` in their file name while excluding names starting with `"Copy of "` or containing `"Template"` (which also excludes legacy per-discipline `"Submittal Log - Arch/FF&E"` files):
     - `0` matches -> `missing` (surfaces user-triggered **Copy Log** action into `<DocumentSpace>/1 Admin`).
     - `1` match anywhere in the `DocumentSpace` -> `resolved` immediately.
     - `2+` matches anywhere in the `DocumentSpace` -> `ambiguous`: always display the `SelectDocumentLog` selector in the card with the best candidate pre-selected as default, ranked by: (1) presence in `preferredFolderPath` (`"1 Admin"`), (2) `<DocumentSpace.name> Document Log` name match, (3) newest `modifiedTime`. Any optional `spreadsheets.get` structural checks or inspection among `2+` candidates stay encapsulated behind this resolution seam.

3. **`SourceFile`-Style Per-Request Disambiguation Injection**:
   - Following the `SourceFile` precedent and [0005-per-request-dependency-injection-for-context.md](0005-per-request-dependency-injection-for-context.md), `SelectDocumentLog` is registered in `EPHEMERAL_UI_SELECTION_KEYS` in `UiProcessManager`, stripped before `extractDocumentData()` constructs `Document.data`, preserved across `DocumentType` switches within the same `DocumentSpace`, and cleared whenever `DocumentSpace` changes or resets.
   - On `processDocument` (`onSubmit`), `src/app/ui-process-manager.wiring.ts` extracts `selectedLogId` onto `WorkspaceExecutionContext` (parallel to `sourceFiles` and `targetMessageId`) and injects it into the request's `DocumentLog` adapter in `src/app/`, keeping `DocumentModel` and `WRITE_LOG` activity payloads pure.

## Consequences

- `DocumentLog` can evolve independently of `Document` and serve `READ_LOG`, `WRITE_LOG`, card rendering, and [[Idea] LookupField Options from Log](https://github.com/amcgoey/INC-IO-Docs/issues/273) through one `DocumentLogPort` contract.
- `documentLogSchema` stays focused on per-`DocumentType` sheet/tab/range/column bindings, while shared project discovery and provisioning defaults remain single-sourced in `Manifest`.
- Selecting or copying a log updates immediately on the next request without cache invalidation bugs, and `SelectDocumentLog` never leaks into logged `Document` fields.

## Amendment (2026-11-24 — Deepened `DocumentLogPort`, Pre-Flight Submit Guard & Round-Trip Selection Persistence)

- **Deepened `DocumentLogPort` seam**: Alongside `resolveLog`, `copyLog`, `readLog`, and `writeLog`, `DocumentLogPort` exposes `requiresDocumentLog(documentTypeKey)` and a single pre-submit UI context query (`queryUiContext`) so `LogSchemaRegistryPort` lookups, `copyNameTemplate` rendering, `SelectDocumentLog` candidate selection, `idGroup` / `missingIdFields` extraction, candidate label formatting, and `historyDisplay` rendering stay encapsulated inside `src/features/document-log/` while `src/app/` remains wiring-only.
- **Pre-flight submission guard & single injection path**: On `processDocument` for logging `DocumentType`s, `UiProcessManager` executes one live pre-flight `resolveLog(space)` before starting the unchanged `MOVE_FILE` → single `WRITE_LOG` workflow—blocking `missing` or absent/stale `ambiguous` selections before `MOVE_FILE` runs, and forwarding the validated or resolved `selectedLogId` (including single-match `resolved` logs so `WRITE_LOG` skips a duplicate Drive search in the same request) exclusively through `src/app/ui-process-manager.wiring.ts` onto `WorkspaceExecutionContext.selectedLogId`. `src/infrastructure/workspace-addon/context.ts` never parses `SelectDocumentLog`.
- **Round-trip selection persistence within one `DocumentSpace`**: Reactive card action parameters carry `previousSpaceId` and `previousSelectedLogId` so `SelectDocumentLog` survives switching through a non-logging `DocumentType` within the same `DocumentSpace`, while clearing deterministically whenever `DocumentSpace` or `DocumentSpaceType` changes, on `Refresh Document`, or on source resets (`onFileSourceChange`, `onEmailMessageChange`, Pass 1 reset).
