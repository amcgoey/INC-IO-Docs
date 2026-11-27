# DocumentContentEditorPort, Template Indirection, and Base-Target PDF Grafting

**Status:** accepted

Submittal workflows (`INSERT_PAGES`, `INSERT_DATA`) stamp structured fields and prepend a confidential cover sheet onto filed artifacts through a format-agnostic `DocumentContentEditorPort` Seam, resolve `DocumentTemplate` keys via `TemplateRegistryPort` to runtime environment variables, graft pages into the target PDF in `PdfProcessor` while keeping AcroForm fields editable without flattening, and enforce one centralized in-memory file-size limit configured in `AppConfiguration`.

## Decision

1. **Cohesive `DocumentContentEditorPort` Seam & `DocumentContentActivityHandler` Orchestration**:
   - `DocumentContentEditorPort` (`src/features/document/`) exposes `insertPages` and `insertData` behind a `mimeType`-dispatching `Adapter` in `src/features/document/adapters/` (wired in `src/app/document.wiring.ts`, with `application/pdf` implemented first and `application/vnd.google-apps.document` extensible behind the same `Seam`).
   - `TemplateRegistryPort` resolution and `DocumentFormSchema` write evaluation ([0018-bidirectional-document-form-schema.md](0018-bidirectional-document-form-schema.md)) stay inside `DocumentContentActivityHandler` and `src/features/document/` (without importing from `src/features/source-parser/`, preserving vertical feature isolation per [0001-hybrid-hexagonal-architecture.md](0001-hybrid-hexagonal-architecture.md)) so `DocumentContentEditorPort` accepts only resolved file IDs and evaluated form maps.

2. **`TemplateRegistryPort`, `DocumentTemplate` Indirection & Pre-Flight Validation**:
   - `DocumentType` JSON references logical `templateKey` values rather than storage IDs; `Manifest` `configuration.templates` maps each `templateKey` to an environment variable name (such as `SUBMITTAL_COVER_SHEET_TEMPLATE_ID`) resolved at runtime by `TemplateRegistryPort` ([0009-split-manifest-configuration-and-feature-schema-hydration.md](0009-split-manifest-configuration-and-feature-schema-hydration.md)).
   - `TemplateRegistryPort` validates all active workflow `templateKey` entries during `DocumentService.processDocument()` pre-flight before step 1 mutates Google Drive (keeping `configuration.documentLog` unchanged).
   - Confidential Google Drive file IDs and URLs stay in runtime environment configuration and out of git.

3. **Base-Target `pdf-lib` AcroForm Grafting Without Flattening (`PdfProcessor`)**:
   - This application NEVER flattens PDFs in any process. Both cover-sheet and target AcroForm fields remain editable after grafting.
   - `PdfProcessor` opens the target PDF as the base `PDFDocument` and copies cover-sheet pages via one shared `PDFObjectCopier` (`copyPages` plus manual widget `/P` page reference rewrite and `/AcroForm/Fields` registration) rather than rebuilding the target document into a fresh container, preserving target outlines, links, and metadata.
   - `PdfProcessor.insertPages` pre-populates `copier.traversedObjects` (`srcPage.ref -> copiedPageRef`) before copying `/AcroForm/Fields`, preserves editable fields via `targetAcroFormPolicy` using `"namespace"` collision isolation (wrapping colliding target root fields under a `PDFAcroNonTerminal` parent) or `"strip"` when explicitly requested by non-submittal callers, regenerates appearances only on dirty cover-sheet fields after WinAnsi character sanitization, registers `/AcroForm/DR/Font`, clears `/NeedAppearances`, rejects unknown dropdown options with `PdfFormFieldError`, and saves with `{ updateFieldAppearances: false, objectsPerTick }` (`1000–2000` with `ParseSpeeds.Fast` per [0008-hybrid-pdf-processor-stack.md](0008-hybrid-pdf-processor-stack.md)).

4. **Unmodifiable Target Handling (`onUnmodifiableTarget`) & Fail-Fast Template Errors**:
   - `onUnmodifiableTarget` (`strategy: "createSiblingPdf" | "error"`) handles non-PDF, encrypted, pure-XFA, cryptographically signed (`ByteRange`/`Contents`), and oversized targets; under `"createSiblingPdf"`, `INSERT_PAGES` creates a side-by-side Transmittal PDF and appends a user notice to `ActivityOutput.contextVariables.notices`.
   - `DocumentTemplate` resolution, retrieval, and form-population errors always fail fast with template IDs redacted from errors and logs.

5. **Centralized In-Memory File-Size Limit (`AppConfiguration`) & Buffer Isolation**:
   - `AppConfiguration` defines one canonical, configurable in-memory file-size limit (defaulting to the `200 MB` limit from [0007-drive-content-memory-models.md](0007-drive-content-memory-models.md) with an optional environment override), applied against the cumulative byte total per `PdfProcessor` call and asynchronously injected across `PdfProcessor`, `GoogleDriveClient`, `DocumentContentEditorPort`, and `DriveFormExtractorAdapter`.
   - `ActivityExecutionContext` holds only serializable domain metadata and `FileLocator` references—it never holds `Uint8Array` buffers.

## Consequences

- `Document` workflows remain storage- and format-agnostic while supporting safe multi-page AcroForm cover-sheet prepending in memory without flattening editable PDF fields.
- Adding a new `DocumentTemplate` or tuning the in-memory PDF limit requires only a configuration or environment change rather than hunting duplicated constants across adapters.
