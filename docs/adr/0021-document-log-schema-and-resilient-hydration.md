# DocumentLogSchema Contract, Manifest Discovery Defaults, In-App Identity Keying, and Resilient Hydration

**Status:** accepted

Organization-wide `DocumentLog` discovery and provisioning defaults live in `assets/manifest.json` (`configuration.documentLog` with optional `DocumentSpaceTypes[].documentLog` overrides), per-`DocumentType` spreadsheet bindings (`columns`, `optionBindings`) and declarative `historyDisplay` templates live in `documentLogSchema` (with `{{status.key}}`), `DocumentLogService` computes `Identity` (`idGroup`, `idDocument`, `id`) in-app over header-inclusive `Log_*` Named Ranges, `Calc Link` stores single-file `=HYPERLINK(...)` references, and `READ_LOG` hydrates human-edited rows on a best-effort basis alongside structured validation warnings.

## Context & Trade-offs

Ticket [DocumentLogSchema Contract, Positive-Termination Sheet Resilience & Row Mapping Rules](https://github.com/amcgoey/INC-IO-Docs/issues/327) pins down the data contracts between `Manifest`, `DocumentType` schemas (`Submittal Arch` and `Submittal FF&E`), `DocumentLogService` (`src/features/document-log/`), `Activity` workflows (`READ_LOG` / `WRITE_LOG`), and `GoogleSheetsClient` (`src/infrastructure/sheets/`). Inspecting [INC Document Log Template](https://docs.google.com/spreadsheets/d/1Ops-suWgiqs-_PbaEvdx1WIdUWdVCctJkjS2rPjB42I/edit?usp=drivesdk) revealed several critical constraints: the unified `Log_Submittal_Arch` (`A3:J25`) and `Log_Submittal_FFE` (`A3:K21`) Named Ranges span headers through `Calc Link` while leaving `Calc File Name`–`Identity Id` formula columns outside; `Submittal FF&E` Column E (`Spec Title`) contains an `ARRAYFORMULA` (`VLOOKUP` against `Options_Submittal_FFE_Specs`) in Row 4; `Identity.id` excludes `contact`, so same-day referrals to two consultants share the same `Identity.id`; `status` is enriched on `Document.data` as `{ key }` rather than a plain string; and template `_Config` tabs currently use `"No Objection as Corrected"` while `DocumentType` JSON schemas use `"No Objections As Corrected"`.

### Considered Options

- **Expanding `Log_*` Named Ranges across `Calc *` and `Identity *` columns (`A3:Q...` / `A3:R...`)**: Rejected because `Log_Submittal_Arch` and `Log_Submittal_FFE` already cleanly bound the columns the app reads and writes (`Status` through `Calc Link`); computing `Identity` keys in `DocumentLogService` avoids coupling `DocumentLog` to sheet-side `Identity *` headers and works on sheets without `Identity *` formula columns.
- **Removing the `Submittal FF&E` `Spec Title` Row 4 `ARRAYFORMULA`**: Rejected because spreadsheet formulas own derived display columns so manual sheet edits stay consistent; custom `Spec Tag` / `Spec Title` write-back into `_Config*` (`Options_Submittal_FFE_Specs`) belongs to [[Idea] LookupField Options from Log](https://github.com/amcgoey/INC-IO-Docs/issues/273).
- **Defaulting `duplicatePolicy` to `"upsert"` or `"reject"` without adding `contact` to `Identity.id`**: Rejected because `{{section}}-{{number}}-{{revision}}-{{date}}-{{action.order}}` collides when the same revision is referred to two consultants on the same day; `"upsert"` would silently overwrite the first referral and `"reject"` would block valid workflows.
- **Silently dropping invalid human-edited rows on `READ_LOG`**: Rejected because a manual typo in a shared spreadsheet would make a real submittal action vanish from Workspace Add-on `idGroup` history instead of surfacing visibly with a warning.
- **Performing `spreadsheets.get` structural pre-filtering inside `resolveLog`**: Rejected because validating tabs/Named Ranges during Drive discovery would misclassify a broken project log as `missing` and prompt the user to **Copy Log**, creating a duplicate spreadsheet; structural checks belong on `READ_LOG` / `WRITE_LOG`.
- **Storing raw Drive URL strings instead of `=HYPERLINK("<uri>", "<label>")` in `Calc Link`**: Rejected because raw Drive URLs clutter human-readable spreadsheets, whereas `=HYPERLINK(...)` renders a clean clickable `"Link"` label while still allowing reliable URL extraction via `FORMULA` reads.

## Decision

1. **`Manifest` `configuration.documentLog` & `DocumentSpaceTypes[].documentLog` Contract**:
   - Organization-wide discovery and provisioning defaults live under `configuration.documentLog` in `assets/manifest.json`:
     ```json
     {
       "preferredFolderPath": "1 Admin",
       "fileNameContains": "Document Log",
       "excludePrefixes": ["Copy of "],
       "excludeSubstrings": ["Template"],
       "templateSpreadsheetId": "1Ops-suWgiqs-_PbaEvdx1WIdUWdVCctJkjS2rPjB42I",
       "copyNameTemplate": "{{DocumentSpace.name}} Document Log"
     }
     ```
   - `DocumentSpaceTypes[].documentLog` accepts any partial subset override deep-merged over `configuration.documentLog`.
   - `LogSchemaRegistryAdapter` in `src/features/document-log/` validates both blocks fail-fast at startup via `RawManifestProviderPort`, keeping `AppManifestProvider` domain-agnostic ([0009-split-manifest-configuration-and-feature-schema-hydration.md](0009-split-manifest-configuration-and-feature-schema-hydration.md)).
   - `configuration.sheets` retains only low-level `GoogleSheetsClient` retry settings (`maxRetries`, `initialDelayMs`, `backoffFactor`); legacy `defaultHeaderRangeName` and `defaultDataRangeName` are removed with no backward compatibility.

2. **Per-`DocumentType` `DocumentLogSchema` (`documentLogSchema`) Contract**:
   - Discriminated by `provider: "google_sheets"` to accommodate future storage engines behind `DocumentLogPort`.
   - `target`: `{ sheetName, rangeName, extentMarker: "<--->", groupDividerMarker: "---" }` pointing to a single header-inclusive Named Range (`Log_Submittal_Arch`, `Log_Submittal_FFE`).
   - `grouping`: `{ groupBy: "idGroup", sortBy: "id", groupSortOrder: "asc" | "desc", rowSortOrder: "asc" | "desc", duplicatePolicy: "insert" | "upsert" | "reject" }`. Both `Submittal Arch` and `Submittal FF&E` set `groupSortOrder: "asc"`, `rowSortOrder: "asc"` (matching live spreadsheet chronology while the Workspace Add-on reverses history newest-first), and `duplicatePolicy: "insert"`.
   - `columns`: keyed by exact sheet column header string, mapping each column to either:
     - A Stage-1 Handlebars `DocumentField` binding `{ template: string, readOnly?: boolean }` (e.g., `Status: "{{status.key}}"`, `Contact: "{{contact.key}}"`, `Action: "{{action.name}}"`, `Vendor: "{{vendor.name}}"`, `Spec Title: { template: "{{specTitle}}", readOnly: true }`), matching the bidirectional Stage-1 template contract of [0018-bidirectional-document-form-schema.md](0018-bidirectional-document-form-schema.md); or
     - A file-link binding `{ source: "fileLink", label?: string }` (`Calc Link`, default label `"Link"`), which writes `=HYPERLINK("<uri>", "<label>")` from `ActivityExecutionContext.files[0]` on `WRITE_LOG` (single-file scope; multi-file logging is out of scope) and populates `fileUri` on `READ_LOG`.
   - `historyDisplay`: `{ topLabel, text, bottomLabel }` Stage-1 Handlebars templates evaluated by `DocumentLogService` before returning pre-formatted history DTOs over `UiContextQueryPort('document-log')`, using `{{status.key}}` so enriched `LookupField` objects never stringify as `[object Object]`:
     - `Submittal Arch`: `topLabel: "Rev {{revision}} • {{section}}-{{number}} • {{status.key}}"`, `text: "<b>{{action.name}}</b> {{date}} ({{contact.key}})"`, `bottomLabel: "{{title}}"`.
     - `Submittal FF&E`: `topLabel: "Rev {{revision}} • {{specTag.key}} • {{status.key}}"`, `text: "<b>{{action.name}}</b> {{date}} ({{contact.key}})"`, `bottomLabel: "{{specTitle}} — {{vendor.name}}"`.
   - `optionBindings`: optional map keyed by `OptionSource` name (`{ sheetName, rangeName, validationRangeName?, endMarker, columns, aliasesColumn? }`) binding `LookupField` tables on `_Config` tabs ([0023-lookup-options-feature-and-document-log-option-tables.md](0023-lookup-options-feature-and-document-log-option-tables.md)):
     - Main `DocumentLog` tabs (`Log_Submittal_Arch`, `Log_Submittal_FFE`) retain prefixed headers (`Action`, `Contact`, `Vendor`, `Spec Tag`, `Spec Title`), whereas `_Config` tabs use Row 1 sheet titles, Row 2 merged table-group headers (`Statuses`, `Actions`, `Contacts`, `Vendors`, `Specs`, `Specification Divisions`), and Row 3 unprefixed column headers (`Options_*` Named Ranges start at Row 3 and terminate at `endMarker: "---"`).
     - `columns` maps exact Row 3 headers to `OptionSource` properties (`statuses`: `Status` -> `key`; `actions`: `Key`/`Name`/`Suffix`/`Order` -> `key`/`name`/`suffix`/`order`; `contacts` and `vendors`: `Key`/`Name` -> `key`/`name`; `specs`: `Tag`/`Title` -> `key`/`name`; `csiDivisions`: `Division Number`/`Division Folder` -> `key`/`folder`). Informational `Type` columns in `Contacts` and `Vendors` remain unmapped in `OptionSource.properties`.
     - The four `allowUserInput` entity tables (`submittal-arch` `contacts`; `submittal-ffe` `contacts`, `vendors`, `specs`) declare optional `aliasesColumn: "Aliases"` and `validationRangeName`; `actions` omits `validationRangeName` (`allowUserInput: false`).

3. **In-App `Identity` Key Computation**:
   - `DocumentLogService` computes `idGroup`, `idDocument`, and `id` for each read row using `DocumentType.documentSchema.identity` templates and passes a domain-agnostic `rowKeyExtractor` callback into `GoogleSheetsClient` inside `KeyedAsyncLock`. Spreadsheet `Calc *` and `Identity *` formulas maintain parity with `CalculatedField`s and `Identity` for spreadsheet users without coupling `DocumentLog` to sheet-side `Identity *` columns.

4. **Formula-Owned Column Policy & Custom `Spec Tag` Scope**:
   - Any column holding a formula in the pre-`<--->` Formula Row is owned by the spreadsheet (including `Submittal FF&E` `Spec Title` in `E4`, plus `Calc File Name`–`Identity Id`). `WRITE_LOG` never writes to formula-owned columns (declared `readOnly: true` in `documentLogSchema` and automatically protected at runtime by `GoogleSheetsClient`). Writing custom `Spec Tag` / `Spec Title` values back to `_Config*` (`Options_Submittal_FFE_Specs`) belongs to [[Idea] LookupField Options from Log](https://github.com/amcgoey/INC-IO-Docs/issues/273) and is out of scope here.

5. **`READ_LOG` Partial-Hydration Resilience & Canonical `NOC` Spelling**:
   - `READ_LOG` returns `{ entries: DocumentLogEntry[], warnings: RowHydrationWarning[] }`, where each `DocumentLogEntry` contains `{ document, valid, fileUri?, rowNumber, validationErrors? }` (`fileUri` and `rowNumber` stay on the entry wrapper rather than polluting `Document.data`).
   - Human-edited rows that fail strict `DocumentType` validation surface as best-effort entries (`valid: false`, `validationErrors`) alongside structured `warnings` so Workspace Add-on history shows manual entries transparently while workflow callers can inspect `valid` and `warnings`.
   - The canonical `NOC` action display name is `"No Objections As Corrected"` (matching `assets/document-types/submittal-arch.json` and `assets/document-types/submittal-ffe.json`; template `_Config` tabs align to this spelling).

6. **Drive-Only `resolveLog` & Minimal `WRITE_LOG` / `READ_LOG` `Activity` Payloads**:
   - `DocumentLogPort.resolveLog` performs Drive-only discovery and leaves tab/Named Range validation to `READ_LOG` and `WRITE_LOG`.
   - `WRITE_LOG` uses `{}` in `documentWorkflowConfig` for linear `MOVE_FILE` -> `WRITE_LOG` pipelines (with optional `fileSourceStepId?: string` to select `context.stepOutputs[stepId].files[0]` in multi-artifact workflows such as [[Idea] Create Submittal Activiites](https://github.com/amcgoey/INC-IO-Docs/issues/274)).
   - `READ_LOG` accepts `{}` (full-log read) or `{ filterBy?: "idGroup" | "idDocument" | "id", values?: string | string[], outputVariable?: string }` (defaulting `outputVariable` to `"logEntries"`), matching `DocumentLogPort.readLog()`.

## Consequences

- `DocumentLog` schemas stay cleanly split: shared discovery/copy settings live in `Manifest`, per-`DocumentType` mappings live in `documentLogSchema`, and column ordering remains decoupled from JSON configuration.
- `documentLogSchema` `columns` tolerate reordered or user-added columns in project logs and preserve spreadsheet `ARRAYFORMULA` ownership without `#REF!` collisions.
- `WRITE_LOG` adds single-file logging cleanly without breaking same-day multi-consultant referrals, and `READ_LOG` remains non-fatal when humans hand-edit spreadsheet rows.
