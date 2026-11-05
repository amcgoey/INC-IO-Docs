# Two-Pass SourceParser Architecture and Lazy SourceContext Hydration

`SourceParser` (`src/features/source-parser/`) is structured as a deep domain feature module invoked by `UiProcessManager` across two distinct driving passes—Pass 1 (`inferRouting`) and Pass 2 (`extractFields`)—backed by two-tier lazy `SourceContext` hydration, strict canonical-only `LookupField` matching, and non-blocking user-facing status degradation.

### Context & Trade-offs

Pre-populating the Google Workspace Add-on filing card from Gmail and Google Drive sources requires resolving both **where** a document belongs (`DocumentSpaceType`, `DocumentSpace`, `DocumentType`) and **what** field values it contains (`Document.data`). A single-pass schema-driven parser with upfront eager `SourceContext` hydration was rejected because:
1. Routing selects *which* `DocumentSpace` collection `UiProcessManager` must load ([0014-ui-process-manager-space-resolution.md](0014-ui-process-manager-space-resolution.md)) and *which* `DocumentType`'s `DocumentParseSchema` applies in the first place.
2. Eagerly downloading Drive PDF buffers or diffing Google Docs against templates before knowing whether the active `DocumentType`'s `DocumentParseSchema` needs them would blow Google Workspace Add-on card load budgets.
3. Automated extraction heuristics can produce noisy text fragments that must not pollute `LookupField`s with unverified custom strings.

### Decision

1. **Two-Pass Driving Interface (`SourceParserPort`)**:
   - **Pass 1 (`inferRouting`)**: Driven by modular, source-specific resolvers (`drive`, `gmail`) rather than `DocumentType` JSON schemas. Returns best-effort, partial-friendly `{ spaceTypeId?, spaceIdOrName?, documentTypeKey?, statusMessages? }`. `UiProcessManager` applies these on source-reset events (`isResetOrInitialLoad`, `refresh`, `onEmailMessageChange`, `onFileSourceChange`), loads the active `DocumentSpace` collection, and resolves `spaceId` and `documentTypeKey`.
   - **Pass 2 (`extractFields`)**: Driven by the resolved `DocumentType`'s `DocumentParseSchema`. Runs on both source-reset events and manual type-switch events (`onSpaceTypeChange`, `onDocumentTypeChange`), populating only fields not already edited by the user for that `DocumentType`. After merging extracted fields into `formData`, `UiProcessManager` invokes `formEvaluator.evaluate` so `showIf`, `computeValue`, and `LinkedField` rules immediately reflect pre-populated values.
2. **Two-Tier `SourceContext` Hydration & Multi-Item Ordering**:
   - **Tier 1 (Base Envelope)**: Hydrated upfront with enriched `GmailMessageDetails` (`subject`, `from`, `to`, `cc`, `date`, `plainTextBody`, `htmlBody`, `attachments`), parsed Google Drive URL targets (in Gmail mode), and an ordered `items` array of selected files/folders (where single-file extractors evaluate against the first matching selected item in order).
   - **Tier 2 (Lazy Driven Content Ports)**: Expensive operations—Drive folder ancestry (`DriveSourceContextPort`), PDF AcroForm extraction (`PdfFormExtractorPort`), Google Doc template variable extraction (`DocVariableExtractorPort`), and dynamic lookup option fetching (`CanonicalOptionsProviderPort`)—sit behind driven ports and execute on demand (cached per request) only when required by Pass 1 or the active `DocumentParseSchema`.
3. **Canonical-Only `LookupField` Pre-Population**:
   - For any `LookupField` (static `documentSchema.options` or dynamic `dynamicConfig` resolved via `CanonicalOptionsProviderPort` when `spaceId` is known), `SourceParser` matches extracted candidates strictly against canonical options (`key` or case-insensitive `name`). Even when `allowUserInput: true` is enabled on the field, `SourceParser` never pre-populates non-canonical custom values.
4. **Pure Deterministic Evaluators + Pluggable Fallback & Non-Blocking Notices**:
   - Deterministic text/metadata/regex/date evaluators live as pure functions in `src/features/source-parser/domain.ts`, while future AI extraction plugs into an optional driven `FallbackFieldExtractorPort`.
   - Extractor or I/O failures never block card rendering; `SourceParser` catches errors at the extractor seam, leaves affected fields unpopulated, and returns clear user-facing notices via `statusMessages` stating what could not be auto-populated and that the user can proceed manually.
