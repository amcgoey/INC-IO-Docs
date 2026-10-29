# Configuration & Schema Guide

Technical reference for configuring the runtime [`Manifest`](../assets/manifest.json) and authoring [`DocumentType`](../CONTEXT.md) JSON schemas in `assets/document-types/`.

> **Domain Glossary (`CONTEXT.md`)**: Use canonical vocabulary from [`CONTEXT.md`](../CONTEXT.md) when naming fields, spaces, workflows, or activities.

---

## 1. Runtime `Manifest` & `AppConfiguration`

At server startup, `AppManifestProvider` (`src/infrastructure/manifest/app-manifest-provider.ts`) loads the root runtime `Manifest` from the filesystem path specified by `APP_MANIFEST_PATH` (defaulting to [`assets/manifest.json`](../assets/manifest.json)) per [ADR-0002](adr/0002-explicit-app-manifest-for-configuration-discovery.md). Feature hydration is split from configuration loading per [ADR-0009](adr/0009-split-manifest-configuration-and-feature-schema-hydration.md): `AppManifestProvider` validates the root envelope and caches `AppConfiguration`, while feature-scoped registry adapters hydrate `DocumentSpaceType` and `DocumentType` domain models.

### Canonical `assets/manifest.json` Structure

```json
{
  "documentTypes": [
    "./document-types/communication-project.json",
    "./document-types/communication-proposal.json"
  ],
  "configuration": {
    "workspace": {
      "defaultDocumentSpaceType": "projects",
      "defaultDocumentType": "communication-project"
    },
    "drive": {
      "defaultFolderName": "Unfiled",
      "maxRetries": 3,
      "initialDelayMs": 1000,
      "backoffFactor": 2
    },
    "sheets": {
      "defaultHeaderRangeName": "Headers",
      "defaultDataRangeName": "Data"
    }
  },
  "DocumentSpaceTypes": [
    {
      "id": "projects",
      "displayName": "Projects",
      "spaceSchema": {
        "allowedDocumentTypes": [
          "communication-project"
        ]
      },
      "storageConfig": {
        "provider": "google_drive",
        "fetchMethod": "shared_drives",
        "paginationLimit": 500
      }
    },
    {
      "id": "proposals",
      "displayName": "Proposals",
      "spaceSchema": {
        "allowedDocumentTypes": [
          "communication-proposal"
        ]
      },
      "storageConfig": {
        "provider": "google_drive",
        "fetchMethod": "folders",
        "sharedDriveName": "INC Marketing",
        "parentFolderName": "Opportunities",
        "paginationLimit": 500
      }
    }
  ]
}
```

### `documentTypes` Registry Array

`documentTypes` is an ordered array of filesystem paths—resolved relative to the directory containing `assets/manifest.json`—pointing to individual `DocumentType` JSON files:

- [`./document-types/communication-project.json`](../assets/document-types/communication-project.json)
- [`./document-types/communication-proposal.json`](../assets/document-types/communication-proposal.json)

During startup initialization, `DocumentSchemaRegistryAdapter` (`src/features/document/adapters/document-schema-registry.ts`) reads each referenced file via `AppManifestProvider.readParsedSchema()`, validates the structure against `DocumentTypeSchema`, statically checks every Handlebars template via `validateManifestTemplates()`, validates `documentUiSchema`, and computes the topological reactive field `evaluationOrder`.

### `configuration` (`AppConfiguration`)

`AppConfiguration` (`AppConfigurationSchema` in `AppManifestProvider`) centralizes domain and administrative defaults across three sub-objects:

| Block | Schema | Key | Production Value | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **`workspace`** | `WorkspaceConfigurationSchema` | `defaultDocumentSpaceType` | `"projects"` | Initial `DocumentSpaceType` pre-selected when the `Workspace Addon` initializes (`defaultDocumentSpaceType: "projects"`). |
| **`workspace`** | `WorkspaceConfigurationSchema` | `defaultDocumentType` | `"communication-project"` | Initial `DocumentType` pre-selected when the `Workspace Addon` initializes (`defaultDocumentType: "communication-project"`). |
| **`drive`** | `DriveConfigurationSchema` | `defaultFolderName` | `"Unfiled"` | Fallback destination folder name (`defaultFolderName: "Unfiled"`) when an `Activity` payload omits `folderName`. |
| **`drive`** | `DriveConfigurationSchema` | `maxRetries` | `3` | Maximum retry attempts for transient Google Drive API errors (`429` / `5xx`). |
| **`drive`** | `DriveConfigurationSchema` | `initialDelayMs` | `1000` | Initial backoff delay in milliseconds before the first Drive retry. |
| **`drive`** | `DriveConfigurationSchema` | `backoffFactor` | `2` | Exponential multiplier applied to `initialDelayMs` on each subsequent retry. |
| **`sheets`** | `SheetsConfigurationSchema` | `defaultHeaderRangeName` | `"Headers"` | Default named range identifying column headers in target Google Sheets. |
| **`sheets`** | `SheetsConfigurationSchema` | `defaultDataRangeName` | `"Data"` | Default named range identifying the data table body in target Google Sheets. |
| **`sheets`** | `SheetsConfigurationSchema` | `maxRetries` / `initialDelayMs` / `backoffFactor` | *(optional; defaults to `3` / `1000` / `2`)* | Optional exponential backoff overrides for Google Sheets API rate limits (`429`). |

### `DocumentSpaceTypes` & Hydration via `DocumentSpaceManifestRegistryAdapter`

Each entry in `DocumentSpaceTypes` defines a `DocumentSpaceType` category of storage containers hydrated at startup by `DocumentSpaceManifestRegistryAdapter` (`src/features/document-space/adapters/document-space-manifest-registry.ts`) and managed by `DocumentSpaceService`:

| Property | Type | Description |
| :--- | :--- | :--- |
| **`id`** | `string` | Canonical technical identifier (`"projects"`, `"proposals"`). |
| **`displayName`** | `string` | Human-readable label shown in the `Workspace Addon` (`"Projects"`, `"Proposals"`). |
| **`spaceSchema.allowedDocumentTypes`** | `string[]` | Whitelist of `DocumentType.key` values permitted when filing into a `DocumentSpace` of this category. |
| **`storageConfig`** | `object` | Provider-specific query parameters consumed by `GoogleDriveStorageAdapter` (`src/features/document-space/adapters/google-drive-storage-adapter.ts`). |
| **`spaceUiSchema`** | `object` *(optional)* | Optional `SpaceUiSchema` blueprint validated by `parseAndValidateSpaceUiSchema`. |

#### Configured `DocumentSpaceType`s

1. **`projects` (`Projects`)**:
   - **Storage Configuration**: `provider: "google_drive"`, `fetchMethod: "shared_drives"`, `paginationLimit: 500` (`SharedDrivesStorageConfigSchema`).
   - **Hydration & Resolution**: `GoogleDriveStorageAdapter` calls `driveClient.listSharedDrives()` in pages of up to 100 items (capped at `paginationLimit`) and maps each Shared Drive to a `DocumentSpace` (`{ id, typeId: "projects", name, abstractStorageId: id }`).
   - **Allowed `DocumentType`s**: `["communication-project"]`.
2. **`proposals` (`Proposals`)**:
   - **Storage Configuration**: `provider: "google_drive"`, `fetchMethod: "folders"`, `sharedDriveName: "INC Marketing"`, `parentFolderName: "Opportunities"`, `paginationLimit: 500` (`FoldersStorageConfigSchema`).
   - **Hydration & Resolution**: `DriveNameResolver` resolves `sharedDriveName: "INC Marketing"` to its Shared Drive ID and `parentFolderName: "Opportunities"` to its folder ID inside that drive, then lists child Opportunity folders as `DocumentSpace` instances (`{ id, typeId: "proposals", name, abstractStorageId: id }`).
   - **Allowed `DocumentType`s**: `["communication-proposal"]`.

When a user selects a `DocumentSpace` display name in the UI, `UiProcessManager` resolves the human-readable name back to the canonical `DocumentSpace` object (`id`, `typeId`, `name`, `abstractStorageId`) before invoking domain services ([ADR-0014](adr/0014-ui-process-manager-space-resolution.md)).

---

## 2. Anatomy of a `DocumentType` Schema

Each `DocumentType` JSON file in `assets/document-types/` defines top-level metadata alongside four structural pillars: `documentSchema`, `storageContextConfig`, `documentUiSchema`, and `documentWorkflowConfig`.

### Side-by-Side Comparison: `communication-project` vs. `communication-proposal`

| Schema Path | [`communication-project.json`](../assets/document-types/communication-project.json) | [`communication-proposal.json`](../assets/document-types/communication-proposal.json) |
| :--- | :--- | :--- |
| **`key`** | `"communication-project"` | `"communication-proposal"` |
| **`name`** | `"Communication Project"` | `"Communication Proposal"` |
| **`allowEmptySourceFiles`** | `true` | `true` |
| **`storageContextConfig.basePath`** | `"1 Admin/Communication"` | `"Communications"` |
| **`contact.options.dynamicConfig.relativePath`** | `"1 Admin/Communication"` | `"Communications"` |
| **`documentUiSchema.events.onSubmit.catchAllWorkflow`** | `"FileCommProject"` | `"FileCommProposal"` |
| **Target Folder Path** | `1 Admin/Communication/<contact>/<commFolderName>` | `Communications/<contact>/<commFolderName>` |

### Top-Level Properties

- **`key`** (`string`, required): Unique machine identifier referenced by `DocumentSpaceType.spaceSchema.allowedDocumentTypes` and `AppConfiguration.workspace.defaultDocumentType`.
- **`name`** (`string`, required): Human-readable display name rendered in the `DocumentType` selector (`"Communication Project"`, `"Communication Proposal"`).
- **`allowEmptySourceFiles`** (`boolean`, optional): When `true`, allows the workflow to create the destination communication folder hierarchy even when zero `SourceFile`s are attached.

### Pillar 1 — `documentSchema` (`DocumentSchema`)

`documentSchema` defines the data contract, lookup enrichment rules, derived fields, and identity templates for a `Document`:

#### `fields` (`DocumentField[]` & `LookupField`)

Each entry in `documentSchema.fields` is a `DocumentField` validated by `buildDocumentTypeSchema`:

| Property | Type | Description |
| :--- | :--- | :--- |
| **`key`** | `string` | Property key in `Document.data` (`"contact"`, `"date"`, `"direction"`, `"description"`). |
| **`name`** | `string` | Human-readable field name. |
| **`type`** | `"string"` | Field data type compiled into a TypeBox validator. |
| **`description`** | `string` *(optional)* | Field documentation string. |
| **`required`** | `boolean` *(optional)* | When `true`, the field is required in `Document.data`; otherwise wrapped in `Type.Optional(...)`. |
| **`defaultValue`** | `string` *(optional)* | Initial value pre-populated in form state (e.g., `"IN"` on `direction`). |
| **`minLength`** / **`pattern`** | `number` / `string` *(optional)* | String validation constraints (e.g., `minLength: 1` and `pattern: "^.*\\S+.*$"` on `contact` to reject whitespace-only strings). |
| **`options`** | `DocumentFieldOption` *(optional)* | Converts the `DocumentField` into a `LookupField` backed by static tuples or dynamic storage queries. |

`LookupField` `options` support two resolution modes:

1. **Static Tuple Lookup (`StaticDocumentFieldOptionType`)**:
   Used by `direction`. Links `source: "direction"` to the in-schema tuple registry `documentSchema.options.direction` (`key: "key"`, `name: "name"`, `defaultValue: "IN"`). Because `allowUserInput` is omitted/false, `buildFieldSchema` compiles a strict TypeBox union of allowed literal keys (`"IN" | "OT"`), and context enrichment expands the selected key into `{ key: "IN", name: "Incoming" }` or `{ key: "OT", name: "Outgoing" }`.
2. **Dynamic Google Drive Folder Lookup (`DynamicDocumentFieldOptionType`)**:
   Used by `contact`. Queries child folders inside the selected `DocumentSpace` at runtime and permits new user-typed folder names (`allowUserInput: true`):
   ```json
   {
     "key": "contact",
     "name": "Contact",
     "type": "string",
     "description": "Contact folder name",
     "required": true,
     "minLength": 1,
     "pattern": "^.*\\S+.*$",
     "options": {
       "source": "contactFolders",
       "key": "key",
       "name": "name",
       "allowUserInput": true,
       "dynamicConfig": {
         "provider": "google_drive",
         "method": "list_folders",
         "relativePath": "1 Admin/Communication"
       }
     }
   }
   ```
   When the user enters a new contact name not present in existing folders, `allowUserInput: true` instructs `DocumentService` to sanitize the path segment via `sanitizeFilePath()` and synthesize a fallback tuple `{ key: "<sanitized>", name: "<sanitized>" }`.

#### `calculatedFields` (`CalculatedField[]`)

`calculatedFields` defines read-only properties derived from the enriched base payload via Handlebars interpolation:

```json
"calculatedFields": [
  {
    "name": "commFolderName",
    "key": "commFolderName",
    "template": "{{date}} {{direction.key}} - {{description}}"
  }
]
```

- **Evaluation Order & Flat Dependency Invariant**: Every `CalculatedField` template is evaluated strictly against `basePayload` (base `DocumentField` values, enriched `LookupField` tuples such as `{{direction.key}}`, and `Document.space`). A `CalculatedField` **cannot** reference other `calculatedFields` or `identity` properties ([ADR-0003](adr/0003-handlebars-for-injection-not-logic.md)). `validateManifestTemplates()` enforces this invariant at startup by validating `calculatedFields` against `getBaseVariables(manifest)`.

#### `identity` (`Identity`)

`identity` defines Handlebars templates that compute canonical identifiers (`id`, `idDocument`, `idGroup`) on the root `Document` entity:

```json
"identity": {
  "id": "{{contact.key}}-{{date}}-{{direction.key}}-{{description}}",
  "idDocument": "{{contact.key}}-{{date}}-{{direction.key}}-{{description}}",
  "idGroup": "{{contact.name}}"
}
```

Like `calculatedFields`, `identity` templates are evaluated against `basePayload` and cannot depend on `calculatedFields` or other `identity` properties.

#### `options` (Static Tuple Registries)

`options` maps a `source` key (such as `"direction"`) to an array of `{ key, name }` objects consumed by static `LookupField`s and `SchemaDrivenUi` selection widgets:

```json
"options": {
  "direction": [
    { "key": "IN", "name": "Incoming" },
    { "key": "OT", "name": "Outgoing" }
  ]
}
```

### Pillar 2 — `storageContextConfig` (`StorageContext`)

`storageContextConfig` defines storage paths evaluated against `{ Document: enrichedDocument }` and injected into the workflow template context as `StorageContext`:

- In `communication-project.json`: `"storageContextConfig": { "basePath": "1 Admin/Communication" }`
- In `communication-proposal.json`: `"storageContextConfig": { "basePath": "Communications" }`

Workflow activity payloads reference these properties via `{{StorageContext.basePath}}`.

### Pillar 3 — `documentUiSchema` (`DocumentUiSchema`)

`documentUiSchema` maps `DocumentSchema` fields to abstract `SchemaDrivenUi` presentation concepts ([ADR-0010](adr/0010-schema-driven-ui.md)) and maps UI submission events to named workflows:

```json
"documentUiSchema": {
  "layout": [
    "contact",
    "date",
    "direction",
    "description"
  ],
  "fields": {
    "contact": {
      "widget": "textInput",
      "label": "Contact"
    },
    "date": {
      "widget": "textInput",
      "label": "Date"
    },
    "direction": {
      "widget": "selectionInput",
      "label": "Direction"
    },
    "description": {
      "widget": "textInput",
      "label": "Description"
    }
  },
  "events": {
    "onSubmit": {
      "catchAllWorkflow": "FileCommProject"
    }
  }
}
```

- **`layout`** (`string[]`): Controls the top-to-bottom rendering order of `DocumentField` keys inside the `DocumentInfo` `UiBlock`.
- **`fields`** (`Record<string, UiField>`): Maps each field key to its abstract widget (`"textInput"` or `"selectionInput"`), human-readable `label`, optional widget `props`, reactive `onChange` trigger (`boolean | string`), and optional JSON Logic rules (`showIf`, `disableIf`, `computeValue`).
- **`events`** (`Record<string, UiEvent>`): Maps UI event names (such as `onSubmit`) to workflow selection rules. Each event supports ordered conditional `rules` (`{ matchFields: Record<string, string>, workflow: string }`) and a fallback `catchAllWorkflow` (`"FileCommProject"` or `"FileCommProposal"`).

### Pillar 4 — `documentWorkflowConfig` & Handlebars Variable Injection

`documentWorkflowConfig` declares named `workflows`, each containing an ordered `activitySequence` of `Activity` definitions:

```json
"documentWorkflowConfig": {
  "workflows": [
    {
      "name": "FileCommProject",
      "activitySequence": [
        {
          "type": "MOVE_FILE",
          "payload": {
            "rootStorageId": "{{Document.space.abstractStorageId}}",
            "parentPath": "{{StorageContext.basePath}}",
            "folderName": "{{Document.data.contact.key}}/{{Document.data.commFolderName}}"
          }
        }
      ]
    }
  ]
}
```

#### Pure Handlebars Variable Injection ([ADR-0003](adr/0003-handlebars-for-injection-not-logic.md))

Handlebars is used strictly as a logic-less variable interpolation engine behind `TemplateEvaluatorPort` (`HandlebarsAdapter`). Conditional branching (`{{#if}}`, `{{#each}}`) belongs in domain code or `documentUiSchema.events` rules, never inside template strings.

| Evaluation Stage | Allowed Handlebars Variable Paths |
| :--- | :--- |
| **Stage 1 — `calculatedFields` & `identity`** (`getBaseVariables`) | Base field keys (`{{date}}`, `{{description}}`), `LookupField` tuple properties (`{{contact.key}}`, `{{contact.name}}`, `{{direction.key}}`, `{{direction.name}}`), and selected space variables (`{{space.id}}`, `{{space.typeId}}`, `{{space.name}}`, `{{space.abstractStorageId}}`, `{{Document.space.abstractStorageId}}`). |
| **Stage 2 — `storageContextConfig` & `documentWorkflowConfig`** (`getExecutionVariables`) | `{{Document.id}}`, `{{Document.type}}`, `{{Document.space.id}}`, `{{Document.space.typeId}}`, `{{Document.space.name}}`, `{{Document.space.abstractStorageId}}`, all base and calculated fields under `{{Document.data.<key>}}` (e.g., `{{Document.data.contact.key}}`, `{{Document.data.commFolderName}}`), `{{StorageContext.<key>}}` (e.g., `{{StorageContext.basePath}}`), `{{documentSchema.*}}`, and runtime `{{Context.*}}` variables emitted by preceding activities. |

---

## 3. Supported `Activity` Types & Data Flow Reference

### `Activity` Reference Table

| `Activity.type` | Primary Adapter / Handler | Input `payload` & `SourceFile` Parameters | Emitted `ActivityOutput` Effect |
| :--- | :--- | :--- | :--- |
| **`MOVE_FILE`** | `DriveActivityHandler` (`src/features/document/adapters/drive-activity-handler.ts`) | `rootStorageId` (`"{{Document.space.abstractStorageId}}"`), `parentPath` (`"{{StorageContext.basePath}}"`), `folderName` (`"{{Document.data.contact.key}}/{{Document.data.commFolderName}}"` or fallback `defaultFolderName: "Unfiled"`), plus `SourceFile[]` from execution context or `payload.fileId`. | Resolves `parentPath` from `rootStorageId`, creates missing target folder segments (`findOrCreateFolder`), moves existing Drive `SourceFile`s (`driveService.move`) or uploads binary `SourceFile.content` buffers (`driveService.saveBuffer`), and returns `{ success: true, files: FileLocator[] }`. |
| **`CREATE_DOCUMENT`** | `ActivityEngine` / Document Creation Handler | `rootStorageId`, `parentPath`, `folderName`, `templateId` or document creation metadata, and `Document.data` fields. | Creates or duplicates the target document in storage and returns `{ success: true, files: [FileLocator], documentDataPatch, contextVariables }`. |
| **`GENERATE_EMAIL_PDF`** | `GmailSourceFileHydratorAdapter` & `PdfProcessor` (`src/features/document/adapters/gmail-source-file-hydrator.adapter.ts`) | Gmail `messageId` (or synthetic `SourceFile` with `id: "email-pdf-<messageId>"`), message headers (`subject`, `from`, `to`, `cc`, `date`), `htmlBody` / `plainTextBody`, `inlineImages`, and `attachmentNames`. | Renders the open Gmail message into an in-memory `Uint8Array` PDF buffer named `"Email - <Sanitized Subject>.pdf"` (`mimeType: "application/pdf"`, [ADR-0008](adr/0008-hybrid-pdf-processor-stack.md)) so `MOVE_FILE` saves it to the target Drive folder and returns its `FileLocator` in `ActivityOutput.files`. |
| **`APPEND_SHEET_ROW`** | `GoogleSheetsClient` (`src/infrastructure/sheets/google-sheets-client.ts`) | `target` (`spreadsheetId`, `sheetName`, `headerRangeName` defaulting to `"Headers"`, `dataRangeName` defaulting to `"Data"`), `rowData` (`Record<string, CellValue>`), `groupConfig` (`{ columnName, value }`), and `sortConfig` (`{ columnName, value }`). | Acquires a per-spreadsheet async lock, aligns columns against the `"Headers"` named range, inserts the row into the matching group and sort position inside `"Data"` (healing group boundary blank rows), and returns `{ success: true, documentDataPatch, contextVariables }`. |

### `SourceFile` Input Flow

A `SourceFile` (`{ id: string, name?: string, mimeType?: string, content?: Uint8Array }`) is an origin-agnostic descriptor representing an input item to be processed by an `Activity`:

1. **Google Drive Selection or Pasted Drive URL**:
   - Selecting items in Google Drive (`onItemsSelectedTrigger`) or pasting a Google Drive file/folder URL populates `SourceFile` descriptors carrying the Drive item `id` (and optional `name` / `mimeType`) without binary `content`.
   - During `MOVE_FILE`, `DriveActivityHandler` moves each Drive `id` directly into the resolved leaf folder via `driveService.move(sourceFile.id, leafFolder.id)`.
2. **Gmail Contextual Trigger (`GENERATE_EMAIL_PDF` & Attachments)**:
   - Opening an email thread in Gmail (`contextualTriggers`) populates a synthetic `SourceFile` with `id: "email-pdf-<messageId>"` alongside any user-selected attachment `SourceFile`s (`partId` / `attachmentId`).
   - Before persisting files in `MOVE_FILE`, `DriveActivityHandler` invokes `GmailSourceFileHydratorAdapter.hydrate(targetSourceFiles)`, which fetches the Gmail message via `GoogleGmailClient`, renders the email thread to a PDF `Uint8Array` via `PdfProcessor.generateEmailPdf()`, downloads selected attachment buffers, and returns hydrated `SourceFile`s with `content: Uint8Array`.
   - `DriveActivityHandler` then uploads each hydrated `Uint8Array` buffer into the target Drive folder via `driveService.saveBuffer()` ([ADR-0007](adr/0007-drive-content-memory-models.md)).

### Unified `ActivityOutput` & `FileLocator` Merging ([ADR-0004](adr/0004-unified-activity-output.md))

Every executed `Activity` returns a unified `ActivityOutput` contract (`ActivityOutputType` in `src/features/document/domain.ts`):

```ts
interface FileLocator {
  id: string;
  name: string;
  parentName?: string;
  mimeType?: string;
  uri?: string;
}

interface ActivityOutput {
  success?: boolean;
  error?: string;
  documentDataPatch?: Record<string, unknown>;
  contextVariables?: Record<string, unknown>;
  files?: FileLocator[];
}
```

As `DocumentService.processDocument()` iterates through a workflow's `activitySequence`:

1. **Fail-Fast Error Propagation**: If an `Activity` returns `output.success === false`, workflow execution halts immediately and returns `{ success: false, errors: [output.error] }`.
2. **`documentDataPatch` Merge**: Keys in `output.documentDataPatch` are merged into `enrichedDocument.data` (`evaluationContext.Document.data`), making them immediately addressable by subsequent activities in the sequence via `{{Document.data.<key>}}`.
3. **`contextVariables` Merge**: Keys in `output.contextVariables` are merged into the in-flight `evaluationContext` and returned in `ProcessDocumentResult.contextVariables`.
4. **`files` (`FileLocator[]`) Collection**: Stored file pointers (`id`, `name`, `parentName`, `mimeType`, `uri`) are collected across all `outputs` so the `Workspace Addon` UI can render confirmation details and links to the filed items.

---

## 4. Validating Configuration & Schema Changes

After editing [`assets/manifest.json`](../assets/manifest.json) or any `DocumentType` JSON file in `assets/document-types/`, run the validation and quality-gate scripts from the repository root:

```bash
npm run typecheck
npm run lint
npm run test:all
```

`test/validation/schema.test.ts` automatically validates `assets/manifest.json` (`AppConfiguration` and `DocumentSpaceTypes`) and every registered `DocumentType` schema against `DocumentTypeSchema`, `UiSchema`, `FormSchemaType`, and static Handlebars template variable checks.
