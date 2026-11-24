# Positive-Termination Google Sheets Mechanics, Formula-Row Protection, and Dual-Read Hydration

**Status:** accepted

`GoogleSheetsClient` (`src/infrastructure/sheets/`) operates over a single header-inclusive Named Range (`rangeName`) bounded by positive `<--->` extent anchors, separates groups with `"---"` dividers (writing `"---"` to Column 0 only), automatically protects any column containing a formula in the pre-`<--->` Formula Row, preserves a single clean formatted placeholder row in empty cleared templates, and pairs `FORMATTED_VALUE` reads with a parallel lightweight `FORMULA` read for `=HYPERLINK(...)` link columns and an atomic `rowKeyExtractor` callback inside `KeyedAsyncLock`.

## Context & Trade-offs

Inspecting [INC Document Log Template](https://docs.google.com/spreadsheets/d/1Ops-suWgiqs-_PbaEvdx1WIdUWdVCctJkjS2rPjB42I/edit?usp=drivesdk) against the existing `GoogleSheetsClient` (`src/infrastructure/sheets/google-sheets-client.ts`) exposed several concrete incompatibilities: the template uses one header-inclusive Named Range per tab (`Log_Submittal_Arch` = `A3:J25`, `Log_Submittal_FFE` = `A3:K21`), `<--->` extent bounds, and `"---"` group dividers rather than separate `Headers`/`Data` Named Ranges and blank divider rows; `Submittal FF&E!E4` (`Spec Title`) carries an `ARRAYFORMULA` inside the editable span that fails with `#REF!` if `updateCells` writes an empty or literal cell into `E6+`; clearing all sample rows down to adjacent `<--->` markers strips sheet data validations and conditional formatting and causes `inheritFromBefore: true` to inherit dark-gray 7pt anchor styling onto the first inserted row; `UNFORMATTED_VALUE` reads strip leading zeros (`"071200"` -> `71200`, `"001"` -> `1`) and hide `=HYPERLINK(...)` targets; and passing `'SheetName'!RangeName` to `values.get` triggers `400 Unable to parse range` on workbook-scoped Named Ranges.

### Considered Options

- **Requiring paired `Headers_*` and `Log_*` Named Ranges per sheet tab**: Rejected because a single header-inclusive Named Range (`Row 0` = headers, bounded below by `<--->`) halves template maintenance, eliminates column-axis misalignment failures, and matches the live `INC Document Log Template`.
- **Using blank rows as group dividers instead of `"---"` markers**: Rejected because `"---"` dividers are already established in the template, render distinctly with conditional formatting, and reliably distinguish intentional group boundaries from accidental empty lines.
- **Clearing template sample rows down to zero rows between top and bottom `<--->`**: Rejected because Google Sheets removes column data validations, number formats, and conditional formatting when no data rows remain between `<--->` anchors, and `insertDimension` below Row 5 copies dark-gray 7pt anchor formatting.
- **Reading sheets with `UNFORMATTED_VALUE`**: Rejected because numeric storage in `000000` / `000`-formatted columns strips leading zeros required by `DocumentSchema` patterns and discards `=HYPERLINK(...)` URIs.
- **Full-row `updateCells` writes across all columns in the Named Range**: Rejected because writing empty/placeholder cells into formula-owned columns (like `Spec Title` `E4`) breaks `ARRAYFORMULA` spills with `#REF!`, and overwriting unrecognized user-added columns destroys user data.

## Decision

1. **Single Header-Inclusive Named Range & Reorder/Extra-Column Tolerance**:
   - Positive-terminated tables use a single Named Range (`rangeName`, e.g., `Log_Submittal_Arch`, `Log_Submittal_FFE`), where Row 0 of the resolved range is the header row.
   - `GoogleSheetsClient` resolves headers dynamically by header string regardless of column order; unrecognized user-added columns inside the Named Range are ignored on read and left untouched on write.
   - Resolved Named Range `GridRange` coordinates are converted to explicit A1 bounds (`'SheetName'!A3:J25`) before calling `spreadsheets.values.get` / `batchGet`, avoiding `400 Unable to parse range` on workbook-scoped Named Ranges.

2. **Positive Extent Anchors (`<--->`) & Group Dividers (`---`)**:
   - Editable data rows lie strictly between the first (`topAnchor`) and last (`bottomAnchor`) rows whose anchor cell equals `extentMarker` (`"<--->"`). Missing start or end anchors fail fast with a dedicated structural error.
   - Top and bottom `<--->` cells in templates carry strict `"Reject Input"` (`strict: true`) `ONE_OF_LIST` (`"<--->"`) data validation, while user-entered data columns keep warning-only validations.
   - Group separation uses `groupDividerMarker` (`"---"`) rows. On read, any divider row (first cell or `Status` cell equals `"---"`) and blank row is skipped. On write, group boundary healing maintains exactly one `"---"` divider row between adjacent groups, writing `"---"` to Column 0 (`Status`) only on newly inserted dividers so row-wide conditional formatting triggers cleanly without polluting `Spec Tag` or `Identity` formulas.

3. **Automatic Pre-`<--->` Formula Row Write Protection**:
   - Every row strictly between Row 0 (headers) and `topAnchor` (e.g., Row 4 `"Formula Row"`) is inspected via `valueRenderOption: 'FORMULA'`.
   - Any column containing a formula starting with `=` in that pre-`<--->` zone (such as `Submittal FF&E!E4` or any user-added formula column) is automatically marked formula-owned (read-only).
   - `WRITE_LOG` emits targeted `updateCells` requests covering only mapped writable column runs, never writing into formula-owned columns or unrecognized user columns.

4. **Cleared-Template Single Placeholder Row Preservation**:
   - Empty cleared templates retain one clean, empty, formatted row strictly between top `<--->` (Row 5) and bottom `<--->` (Row 7) so Google Sheets preserves warning-only data validations, `"000000"` / `"000"` number formats, conditional formatting, and white 9pt styling.
   - When inserting into an empty log (only blank row(s) between `<--->` anchors), `GoogleSheetsClient` writes into that clean placeholder row (and removes any excess blanks) rather than inserting with `inheritFromBefore: true` below dark-gray Row 5. When inserting into a non-empty log, row insertions stay strictly within `(topAnchor, bottomAnchor]` so Named Ranges and conditional formatting auto-expand, copying formatting from an adjacent data row rather than `<--->` when inserting at the top of the table.

5. **Formatted Value Reads, `=HYPERLINK` Dual-Read & Atomic `rowKeyExtractor`**:
   - Primary table reads use `valueRenderOption: 'FORMATTED_VALUE'` (preserving `"071200"`, `"001"`, and `"230726"` zero-padding while allowing humans to enter `1` in number-formatted columns), and `WRITE_LOG` writes string field values as `stringValue` (preserving leading zeros and remaining compatible with Row 4 `TEXT(..., "000000")` formulas).
   - Link columns (`=HYPERLINK("<uri>", "<label>")`) are read via a parallel lightweight `valueRenderOption: 'FORMULA'` fetch of the link column (extracting the target URL with a raw-URL fallback), executed alongside the primary `FORMATTED_VALUE` read.
   - `insertIntoGroupedList` accepts a domain-agnostic `rowKeyExtractor: (row: RowRecord) => { groupKey: string; sortKey: string }` callback, explicit `groupSortOrder` / `rowSortOrder` (`"asc" | "desc"`), and `duplicatePolicy` executed atomically inside `KeyedAsyncLock`, preventing domain template coupling inside `src/infrastructure/sheets/`.

## Consequences

- `GoogleSheetsClient` stays domain-agnostic and reusable across `DocumentLog`, [[Idea] LookupField Options from Log](https://github.com/amcgoey/INC-IO-Docs/issues/273), and future spreadsheets while enforcing positive sheet bounds.
- Users can reorder columns, insert custom helper or formula columns, and hand-type numbers into formatted columns without breaking `READ_LOG` or `WRITE_LOG`.
- Template maintenance requires preserving one clean formatted row between `<--->` anchors when clearing sample data and applying strict `"Reject Input"` validation to `<--->` boundary cells.
