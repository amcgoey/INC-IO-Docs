# ADR 0023: LookupOptions Feature Isolation, Split Option Schemas, and DocumentLog Option Tables

- **Status**: Accepted
- **Date**: 2026-11-25
- **Related Issue**: `#273` (`[Idea] LookupField Options from Log`)
- **Related ADRs**: ADR 0001, ADR 0005, ADR 0009, ADR 0011, ADR 0012, ADR 0013, ADR 0014, ADR 0017, ADR 0019, ADR 0020, ADR 0021, ADR 0022

## Context

Previously, `Submittal Arch` and `Submittal FF&E` option lists (`statuses`, `actions`, `contacts`, `vendors`, `specs`) were hard-coded inside `DocumentType` JSON manifests while `Communication Project` and `Communication Proposal` resolved project contacts via an ad-hoc `dynamicConfig` field block handled in a wiring-layer `DynamicOptionsAdapter`. Meanwhile, every project `DocumentLog` spreadsheet already maintains `_Config` option tables bounded by Named Ranges (`Options_*`) and companion data-validation Named Ranges (`Validation_*`), ending at a `"---"` sentinel row and arranged side-by-side on shared tabs.

Two additional gaps existed:
1. Custom entries written into `allowUserInput` `LookupField`s (`contact`, `vendor`, `specTag`, `relatedTag`) were not inserted into the spreadsheet's `_Config` tables, breaking `VLOOKUP`-based `Spec Title` cells and spreadsheet data validations unless users updated `_Config` manually.
2. Selecting a known `specTag` did not compute or lock sibling `LinkedField` `specTitle` in the `Workspace Addon`, and `LinkedField` behavior could conflict with `VLOOKUP` or leave custom tags without a required title.

## Decision

### 1. Isolated Per-Request `LookupOptions` Feature (`src/features/lookup-options/`)
- Extract option resolution, validation, tuple enrichment, and `LinkedField` derivation into a dedicated per-request feature module wired via `src/app/lookup-options.wiring.ts`, removing `src/app/dynamic-options.adapter.ts`.
- Share one `LookupOptionsPort` instance per HTTP request across `SchemaDrivenUi`, `SourceParser`, `UiProcessManager`, and `Document` (`DocumentService`), supporting both card rendering and `POST /documents`.
- Accept explicit per-call context (`space`, `documentTypeKey`, optional `selectedLogId`) on `LookupOptionsPort` methods instead of binding mutable state at construction.
- Deduplicate concurrent/repeated lookups within a single HTTP request via in-flight `Promise` memoization, invalidated whenever `copyLog` or `writeLog` succeeds in that request; retain zero cross-request Drive or Sheets caching.
- Read static option arrays directly inside `LookupOptions` from `DocumentSchema` without an extra adapter layer, while adapting `DocumentLogPort.readOptionTables` and Google Drive folder traversal behind driven ports.
- Surface explicit `LookupOptions` status codes including `missing_log`, `ambiguous_log`, and `config_error` (distinct from Google Drive folder statuses).

### 2. Split Manifest Option Schemas (`OptionSource` & `OptionBinding`)
- Split dynamic option configuration across ADR 0009's domain boundaries:
  - `DocumentSchema.optionSources` (`OptionSource`) stays storage-agnostic (`provider: "document_log" | "google_drive"`, expected tuple `properties`, and optional Drive traversal parameters). Migrate `Communication Project` and `Communication Proposal` off legacy inline `dynamicConfig` onto `optionSources`.
  - `DocumentLogSchema.optionBindings` (`OptionBinding`) holds Google Sheets mechanics (`sheetName`, `rangeName`, optional companion `validationRangeName`, sentinel `endMarker`, header-to-property `columns` map, and optional RFC 4180 CSV `aliasesColumn`).
- Enforce fail-fast startup validation across `DocumentSchemaRegistryAdapter`, `LogSchemaRegistryAdapter`, and `ParseSchemaRegistryAdapter` verifying that every `document_log` `OptionSource` has a matching `OptionBinding` covering all declared `properties`, valid `LinkedField` references, and valid template dot-notation paths.
- Keep local static JSON reads memoized in `AppManifestProvider.readParsedSchema()`, returning `structuredClone`d copies so downstream consumers cannot mutate cached manifests.

### 3. Acyclic, Deepened `DocumentLog` Option Tables & Atomic `WRITE_LOG` Write-Back
- Maintain a strict DAG: `LookupOptions` depends on `DocumentLogPort`, while `DocumentLogService` never depends on `LookupOptions`. Inside `readLog`, `writeLog`, and `queryUiContext`, `DocumentLogService` reads and hydrates option tables directly from the resolved spreadsheet.
- `DocumentLogService` owns domain option-table parsing, `config_error` validation (missing Named Range or missing `"---"` sentinel on read or write), first-row-wins trimmed case-insensitive key deduplication on read, RFC 4180 CSV `aliasesColumn` parsing (`""`-escaped quotes), and strict canonical validation for non-`allowUserInput` fields on `READ_LOG` hydration (reporting `partial_hydration` when invalid).
- `DocumentLogPort.readOptionTables` resolves omitted or stale `selectedLogId` to the active/top-ranked `candidates[0]` when `ambiguous`; `writeLog` remains strict and rejects `ambiguous_log`.
- `GoogleSheetsClient` executes range-level mechanics only:
  - Batched reads resolve all requested Named Ranges in 1 `spreadsheets.get` call + 1 `spreadsheets.values.batchGet` call (`FORMATTED_VALUE`).
  - Atomic option write-back executes **inside `WRITE_LOG`** (`insertIntoGroupedList` / `LogStoragePort.insertRow`) under one process-shared `KeyedAsyncLock` keyed by `spreadsheetId`, adding 0 extra Google Sheets API calls.
  - Write-back deduplicates candidate rows by trimmed, case-insensitive **key only** (preserving legitimate shared names across distinct keys such as FF&E spec titles), coalesces same-submit writes targeting the same `OptionSource` (e.g. `specTag` and `relatedTag` both bound to `specs`), and backfills blank sibling cells on an existing key row without overwriting non-blank cells.
  - New rows use range-scoped `insertRange` (`shiftDimension: "ROWS"` bounded to the target Named Range's columns) right above the `"---"` row, `updateCells` with `stringValue` literals only (preventing formula injection), and explicit `updateNamedRange` to extend companion `Validation_*` (`validationRangeName`) ranges when needed.
  - When inserting into an empty option table (no existing data row above `"---"`), copy formatting from `configuration.documentLog.templateSpreadsheetId`'s matching table data row so template style updates take effect without hard-coding styles in application code.
  - Keep `sanitizeFilePath()` scoped to path/filename generation rather than option-table or `LinkedField` values.

### 4. Reactive `LinkedField` Locking & UI / Validation Semantics
- `LookupField` key matching checks trimmed case-insensitive `key` first, then `name` only when `options.name` is configured; autocomplete display uses `name` if configured else `key`, disambiguating `"Name (KEY)"` only on duplicate display names.
- Normalize `AliasDictionary` lookup keys trimmed case-insensitively.
- `UiProcessRenderResult` and `GenerateViewRequest` carry an explicit `lockedFields` map/structure so `SchemaDrivenUi` remains a pure renderer.
- A `LinkedField` renders as read-only `decoratedText` **only** when its sibling `LookupField` matches an option tuple AND the derived `sourceProperty` is non-blank; otherwise (custom value, blank lookup, blank property value, error, or timeout) it renders as an editable `textInput` (e.g., entering a custom `specTag` triggers `onChange`, unlocks `specTitle`, and requires both `specTag` and `specTitle` before `Process Document` can write the log).
- `DocumentService` authoritatively re-derives matching non-blank `LinkedField` values during `validateDocument()` and `processDocument()`, enforcing UI and headless `POST /documents` invariants alike.
- Switching `SelectDocumentLog` reloads options, history, and lock state while preserving user inputs; **Copy Log** invalidates single-request memoization and reloads options immediately from the newly copied `DocumentLog`.

## Consequences

- Project teams manage `Submittal Arch` and `Submittal FF&E` option lists directly in their `DocumentLog` `_Config` tabs without code deployments, while `DocumentLog` formulas (`VLOOKUP`) and data validations remain aligned automatically.
- Static schemas (`Communication Project`, `Communication Proposal`) and Google Drive folder lookups continue working unchanged under one unified `LookupOptions` module.
- Atomic write-back avoids extra Sheets API round-trips and prevents concurrent write races across the process, at the cost of holding `KeyedAsyncLock` for the duration of a single `WRITE_LOG` sequence per `spreadsheetId` and requiring template availability (`templateSpreadsheetId`) only when inserting the first row into a previously empty `_Config` table.
