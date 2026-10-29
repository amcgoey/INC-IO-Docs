# INC-IO Docs

![INC-IO Docs](assets/branding/logo-one-line-220x30.png)

**INC-IO Docs** is a schema-driven document management system and Google Workspace Add-on for Google Drive and Gmail. It enables organization members to file project and proposal communications into standardized Google Shared Drive and Opportunity folder hierarchies (`yyMMdd IN/OT - Description`) with automatic folder creation and email-to-PDF conversion.

### Core Capabilities

- **Google Drive & Gmail Integration**: File items directly from Google Drive selections, pasted Google Drive URLs, or open Gmail threads from the right-hand Google Workspace companion sidebar.
- **Schema-Driven Filing Rules**: Validate user inputs, resolve dynamic folder lookups, and compute target paths from declarative JSON schemas (`DocumentSpaceType` and `DocumentType`).
- **Automatic Folder Hierarchy Creation**: Create missing contact and communication subfolders automatically inside the selected Project Shared Drive or Proposal Opportunity folder (`yyMMdd IN/OT - Description`).
- **Email-to-PDF Conversion**: Render open Gmail messages into archivable PDF documents (`GENERATE_EMAIL_PDF`) and file them alongside selected email attachments in a single workflow (`MOVE_FILE`).

---

## User Guide — Filing Documents in Google Drive & Gmail

### Launching & Environment Identification

Open **INC-IO Docs** from the right-hand Google Workspace companion sidebar in Google Drive or Gmail. When both development and production add-ons are installed in your workspace, distinguish them by display name and companion icon:

| Environment | Display Name | Companion Icon | Visual Appearance |
| :--- | :--- | :--- | :--- |
| **Production (`prod`)** | `"INC-IO Docs"` | ![Production Icon](assets/branding/icon-48x48.png) [`icon-48x48.png`](assets/branding/icon-48x48.png) | Pure black hex mark on a transparent background |
| **Development (`dev`)** | `"INC-IO Docs (Dev)"` | ![Development Icon](assets/branding/icon-dev-48x48.png) [`icon-dev-48x48.png`](assets/branding/icon-dev-48x48.png) | Medium-gray hex mark on a solid light-gray (`#EAEAEA`) tile |

### Step 1 — Select a `DocumentSpaceType` & `DocumentSpace`

1. Choose a **`DocumentSpaceType`** category:
   - **Projects** (`projects`): Lists existing Project Google Shared Drives (`fetchMethod: "shared_drives"`).
   - **Proposals** (`proposals`): Lists existing Opportunity folders inside the **`INC Marketing`** Shared Drive under **`Opportunities`** (`INC Marketing / Opportunities`, `fetchMethod: "folders"`).
2. Select the target **`DocumentSpace`** from the populated suggestions. Selecting a `DocumentSpaceType` filters the available `DocumentType` options to those permitted for that category.

### Step 2 — Select a `DocumentType` & Enter Details

Select the **`DocumentType`** for your communication and complete each required **`DocumentField`**:

- **Target Filing Paths**:
  - **Communication Project** (`communication-project`, under **Projects**):
    `1 Admin/Communication/<Contact>/<yyMMdd> <IN|OT> - <Description>`
  - **Communication Proposal** (`communication-proposal`, under **Proposals**):
    `Communications/<Contact>/<yyMMdd> <IN|OT> - <Description>`
- **Form Inputs (`DocumentField`s)**:
  - **`Contact`** (`contact`): Select an existing contact folder dynamically loaded from Google Drive (`dynamicConfig` with `method: "list_folders"` under `1 Admin/Communication` or `Communications`), or type a new contact folder name directly (`allowUserInput: true`).
  - **`Date`** (`date`): Enter the communication date in 6-digit `yyMMdd` format (for example, `261028`).
  - **`Direction`** (`direction`): Choose **`Incoming`** (`IN`) or **`Outgoing`** (`OT`). Defaults to **`Incoming`** (`IN`).
  - **`Description`** (`description`): Enter a concise subject or summary for the communication folder name.

### Step 3 — Attach or Select `SourceFile`s & File

Provide the **`SourceFile`** inputs from your active Google Workspace host and submit the form:

- **Filing from Google Drive**:
  - Select one or more files or folders directly in Google Drive (`onItemsSelectedTrigger`) to populate the active `SourceFile` selection, or paste a Google Drive file/folder URL into the form.
  - Submit the form to create the `<Contact>/<yyMMdd> <IN|OT> - <Description>` folder hierarchy and move the selected items (`MOVE_FILE`).
- **Filing from Gmail**:
  - Open an email thread in Gmail (`contextualTriggers`).
  - Select any email attachments to include alongside the automatically generated email PDF (`GENERATE_EMAIL_PDF`).
  - Submit the form to render the email thread to PDF and file both the PDF and selected attachments into the target communication folder.

---

## System Overview & Domain Glossary

The core rules engine validates input payloads against a declarative `DocumentType`, resolves dynamic `LookupField` tuples, evaluates logic-less Handlebars templates for `CalculatedField`s and `Identity` properties, and emits serializable `Activity` instructions executed by driven infrastructure adapters. Ephemeral credentials (such as caller OAuth tokens) travel exclusively through an `ExecutionContext` side-channel injected at the composition root, keeping domain payloads and `Activity` objects strictly serializable and credential-free.

> **Domain Glossary (`CONTEXT.md`)**: Read [`CONTEXT.md`](CONTEXT.md) when naming domain models, introducing or modifying a port or TypeBox schema, or checking avoided synonyms.

### Canonical Domain Glossary (24 Terms)

| Term | Definition |
| :--- | :--- |
| **`DocumentType`** | The structural definition for a class of managed documents (`communication-project`, `communication-proposal`). |
| **`DocumentSchema`** | The subset of a `DocumentType` defining the shape, validation rules, calculated fields, and identity templates of the data payload. |
| **`DocumentUiSchema`** | A condensed, abstract blueprint mapping `DocumentSchema` fields to UI widgets, labels, field ordering (`layout`), and reactive events. |
| **`DocumentSpaceType`** | The structural definition for a category of storage containers (such as `Projects` or `Proposals`), specifying allowed `DocumentType`s and how `DocumentSpace` instances are fetched. |
| **`DocumentSpace`** | A pre-existing storage container instance (a Google Shared Drive or Opportunity folder) identified by canonical ID, display name, and `abstractStorageId`. |
| **`SpaceUiSchema`** | The abstract blueprint mapping `DocumentSpaceType` attributes to UI concepts. |
| **`Document`** | A validated, immutable instance satisfying a `DocumentType` and referencing stored file locations rather than embedding binary content. |
| **`DocumentField`** | A definition of a single data property expected within a `Document` (`contact`, `date`, `direction`, `description`). |
| **`CalculatedField`** | A read-only field derived dynamically from base payload fields via Handlebars interpolation (for example, `commFolderName`); never references other calculated fields or `Identity`. |
| **`LookupField`** | A `DocumentField` linked to static or dynamically queried option tuples (`key`/`name`), optionally accepting new user-entered values when `allowUserInput` is enabled. |
| **`Identity`** | Handlebars templates generating unique identifiers (`id`, `idDocument`, `idGroup`) from the base payload for workflows and activities. |
| **`StorageContext`** | A configuration block (`basePath`) defining storage identifiers and relative paths evaluated against the enriched `Document` payload. |
| **`SourceFile`** | An origin-agnostic descriptor representing an input file or folder to be processed by an `Activity` (Drive selection, Drive URL, Gmail attachment, or generated email PDF). |
| **`Activity`** | A declarative instruction (`MOVE_FILE`, `CREATE_DOCUMENT`, `GENERATE_EMAIL_PDF`, `APPEND_SHEET_ROW`) emitted by the domain containing only serializable `payload` data. |
| **`ActivityOutput`** | The unified domain-effect patch returned by an executed `Activity` (`documentDataPatch`, `contextVariables`, `files`) and merged into the workflow execution context. |
| **`FileLocator`** | An infrastructure-agnostic output pointer to a stored file produced by an `Activity` and returned in `ActivityOutput.files`. |
| **`Manifest`** | The root runtime registry (`assets/manifest.json`) declaring available `DocumentType` schema paths, `AppConfiguration`, and `DocumentSpaceType` definitions. |
| **`AppConfiguration`** | Domain and administrative defaults (`workspace`, `drive`, `sheets`) governing application behavior, distinct from environment-bound secrets. |
| **`Workspace Addon`** | The primary Google Workspace user interface acting as a driving adapter to the core engine across Google Drive and Gmail. |
| **`UiProcessManager`** | The CQRS command/write-model orchestrator that evaluates UI events, translates display names (`DocumentSpace` and `DocumentType`) into technical keys/IDs, and emits intent payloads. |
| **`SchemaDrivenUi`** | The CQRS read-model orchestrator that receives clean view state and constructs declarative `UiView` models from schemas and resolved display names. |
| **`UiBlock`** | A pure, host- and trigger-agnostic presenter function inside `SchemaDrivenUi` that maps state and schemas into modular abstract UI elements. |
| **`UiView`** | A compiled, declarative view model emitted by `SchemaDrivenUi` and consumed by infrastructure card translators. |
| **`UiViewSchema`** | A declarative layout inside `SchemaDrivenUi` driving adapters that orchestrates which `UiBlock`s compose a `UiView` for a specific trigger. |

---

## Architecture & Repository Structure

> **Coding Standards (`CODING_STANDARDS.md`)**: Read [`CODING_STANDARDS.md`](CODING_STANDARDS.md) before creating or modifying source files, adding TypeBox schemas, wiring ports and adapters, or writing unit and integration tests.

### Hybrid Hexagonal Architecture & Directory Layout

The codebase follows a **Hybrid Hexagonal Architecture** (Ports and Adapters) that balances **Locality** (self-contained vertical feature slices in `src/features/`) with **Leverage** (shared, domain-agnostic infrastructure modules in `src/infrastructure/`):

```text
/
├── .agents/               # Agent skills and workflow definitions
├── assets/                # Runtime Manifest, DocumentType JSON schemas, and branding assets
│   ├── branding/          # Deterministic PNG icons, banners, screenshots, and Marketplace config
│   ├── document-types/    # Runtime DocumentType definitions (communication-project, communication-proposal)
│   └── manifest.json      # Root runtime Manifest
├── docs/                  # Architectural Decision Records (docs/adr/) and agent guidelines
├── infra/                 # GCP bootstrap script, deployment manifest generator, branding generator, and Pulumi IaC
├── src/
│   ├── features/          # Vertical feature slices (domain.ts, ports.ts, adapters/)
│   ├── infrastructure/    # Domain-agnostic heavy lifters (drive, gmail, sheets, pdf, http, manifest, workspace-addon)
│   └── app/               # Per-feature composition roots (*.wiring.ts) and HTTP server entrypoint
└── test/                  # Cross-feature integration, E2E, infrastructure, and contract validation tests
```

### Feature Slices (`src/features/`)

Every feature slice strictly isolates its business rules from external SDKs:
- `domain.ts`: Pure business logic and TypeBox schemas with zero external dependencies (other than `@sinclair/typebox`).
- `ports.ts`: Driving and driven TypeScript interfaces and port-specific DTO schemas.
- `adapters/`: Driving and driven adapter implementations bridging ports to infrastructure.

| Feature Slice | Responsibility |
| :--- | :--- |
| **`document`** (`src/features/document/`) | Validates `Document` payloads against `DocumentType` schemas, resolves `LookupField`s, evaluates `CalculatedField` and `Identity` templates, and orchestrates `Activity` workflows. |
| **`document-space`** (`src/features/document-space/`) | Hydrates `DocumentSpaceType` definitions from the `Manifest`, fetches `DocumentSpace` containers (`shared_drives` or `folders`), and enforces allowed `DocumentType` invariants. |
| **`ui-process-manager`** (`src/features/ui-process-manager/`) | Command-side UI orchestrator that evaluates user interaction events, resolves human-readable `DocumentSpace` and `DocumentType` names to canonical IDs/keys, and emits `UiProcessResultSchema` intents. |
| **`schema-driven-ui`** (`src/features/schema-driven-ui/`) | Query-side UI engine that composes host-agnostic `UiBlock` presenters through trigger-specific `UiViewSchema` layouts into declarative `UiView` payloads. |

### CQRS UI Orchestration

UI state evaluation and view construction are decoupled across command and query slices:
1. **Command Evaluation (`UiProcessManager`)**: Evaluates incoming Workspace Add-on form submissions and selection changes, translates display names into technical identifiers, invokes domain ports, and returns a validated `UiProcessResultSchema` intent (such as a render request or notification intent) without constructing UI widgets.
2. **Application Layer Coordination (`src/app/`)**: The composition root intercepts `UiProcessResultSchema` intents. When a render intent is emitted, the coordinator dispatches a query to `SchemaDrivenUi` and binds request-scoped infrastructure context (such as the HTTP base URL) during translation.
3. **Query View Assembly (`SchemaDrivenUi`)**: Composes pure, host-agnostic `UiBlock`s according to a trigger-specific `UiViewSchema` (Drive homepage, Drive items selected, Gmail contextual trigger) into an abstract `UiView`, which the Workspace Add-on translator serializes into Google Card Service JSON.

### Fast-Track vs. Guarded Reads

- **Fast-Track Read**: Pure data queries that require no domain invariant enforcement route directly from a driving adapter to a driven port (wired in `src/app/`), keeping `domain.ts` free of pass-through boilerplate.
- **Guarded Read**: Queries that enforce business authorization, data masking, or invariant-based calculations route through `domain.ts`.

### Per-Request vs. Singleton DI Lifecycles

Domain method signatures never accept `ExecutionContext` or OAuth token parameters. Instead, the composition root (`src/app/*.wiring.ts`) chooses the dependency injection lifecycle based on statefulness:
- **Singleton Lifecycle**: Stateless or startup-cached adapters (such as `AppManifestProvider` and `DocumentSchemaRegistryAdapter`) are instantiated once at server boot.
- **Per-Request Lifecycle**: Request-scoped adapters that depend on the caller's delegated Google OAuth token (`authorizationEventObject.userOAuthToken`) are instantiated per HTTP request in `src/app/` and injected into feature adapters via constructors.

### Architectural Decision Records (ADRs)

| ADR | Decision Summary |
| :--- | :--- |
| [ADR-0001: Hybrid Hexagonal Architecture](docs/adr/0001-hybrid-hexagonal-architecture.md) | Combines vertical feature slices (`src/features/`) for locality with shared domain-agnostic modules (`src/infrastructure/`) for leverage. |
| [ADR-0002: Explicit App Manifest for Configuration Discovery](docs/adr/0002-explicit-app-manifest-for-configuration-discovery.md) | Discovers `DocumentType` schemas and `AppConfiguration` via an explicit `manifest.json` path (`APP_MANIFEST_PATH`) rather than filesystem scanning. |
| [ADR-0003: Handlebars for Injection, Not Logic](docs/adr/0003-handlebars-for-injection-not-logic.md) | Restricts Handlebars to pure variable interpolation for `CalculatedField`s, `Identity`, and workflow parameters, banning branching helpers in JSON/YAML. |
| [ADR-0004: Unified Activity Output Interface](docs/adr/0004-unified-activity-output.md) | Standardizes all driven `Activity` executions on a single `ActivityOutput` return contract (`documentDataPatch`, `contextVariables`, `files`). |
| [ADR-0005: Per-Request Dependency Injection for Execution Context](docs/adr/0005-per-request-dependency-injection-for-context.md) | Injects request-scoped OAuth credentials into adapters at the composition root instead of threading `ExecutionContext` through domain methods. |
| [ADR-0006: Drive File Resolution Strategy](docs/adr/0006-drive-file-resolution-strategy.md) | Resolves Google Drive folder paths top-down with level consolidation and a 20-match fail-fast ambiguity threshold. |
| [ADR-0007: Separation of Drive Content Memory Models](docs/adr/0007-drive-content-memory-models.md) | Separates in-memory buffer operations (`saveBuffer`) from pass-through streaming uploads (`uploadStream`) on the Drive client. |
| [ADR-0008: Hybrid PDF Processor Stack](docs/adr/0008-hybrid-pdf-processor-stack.md) | Pairs `pdf-lib` (structural modification) and `unpdf` (text extraction) behind an in-memory `PdfProcessor` facade. |
| [ADR-0009: Split Manifest Configuration and Feature Schema Hydration](docs/adr/0009-split-manifest-configuration-and-feature-schema-hydration.md) | Splits domain-agnostic `AppManifestProvider` configuration loading from feature-scoped `DocumentSchemaRegistryAdapter` schema hydration. |
| [ADR-0010: Centralized Schema-Driven UI](docs/adr/0010-schema-driven-ui.md) | Centralizes abstract `UiView` and `UiBlock` presentation assembly inside the `schema-driven-ui` feature slice. |
| [ADR-0011: Fast-Track and Guarded Reads](docs/adr/0011-fast-track-and-guarded-reads.md) | Routes pure data queries directly from driving adapters to driven ports while keeping invariant-checked reads in `domain.ts`. |
| [ADR-0012: Feature-Based Composition Roots](docs/adr/0012-feature-based-composition-roots.md) | Modularizes dependency injection into manual per-feature wiring modules (`src/app/<feature>.wiring.ts`) without global DI frameworks. |
| [ADR-0013: CQRS UI Orchestration](docs/adr/0013-cqrs-ui-orchestration.md) | Splits UI command evaluation (`UiProcessManager`) from read-only view assembly (`SchemaDrivenUi`) coordinated by `src/app/`. |
| [ADR-0014: Space Name-to-ID Resolution and Dual State in UI Process Manager](docs/adr/0014-ui-process-manager-space-resolution.md) | Resolves human-readable `DocumentSpace` display names to canonical storage IDs inside `UiProcessManager` before querying downstream ports. |
| [ADR-0015: Multi-Environment GCP Workload Identity Isolation and Least-Privilege IAM](docs/adr/0015-multi-environment-gcp-isolation-and-least-privilege-iam.md) | Isolates `dev` and `prod` GCP projects with 3-way OIDC Workload Identity Federation, a least-privilege `ci-deployer`, and a zero-privilege `addon-runtime` service account. |

---

## Configuration & Schema Overview

Runtime behavior is driven by [`assets/manifest.json`](assets/manifest.json) (`Manifest`), which binds three top-level sections:

1. **`AppConfiguration` (`configuration`)**:
   - **`workspace`**: Default selection state (`defaultDocumentSpaceType: "projects"`, `defaultDocumentType: "communication-project"`).
   - **`drive`**: Fallback folder name (`defaultFolderName: "Unfiled"`) and exponential backoff settings (`maxRetries`, `initialDelayMs`, `backoffFactor`).
   - **`sheets`**: Default named ranges (`defaultHeaderRangeName: "Headers"`, `defaultDataRangeName: "Data"`).
2. **`DocumentSpaceType` Registry (`DocumentSpaceTypes`)**:
   - **`projects`** (`Projects`): Queries Google Shared Drives (`fetchMethod: "shared_drives"`) and permits `communication-project`.
   - **`proposals`** (`Proposals`): Queries child Opportunity folders (`fetchMethod: "folders"`) inside `INC Marketing / Opportunities` and permits `communication-proposal`.
3. **`DocumentType` Schemas (`documentTypes`)**:
   - [`assets/document-types/communication-project.json`](assets/document-types/communication-project.json): Defines `contact`, `date`, `direction`, and `description` fields, computes `commFolderName` (`{{date}} {{direction.key}} - {{description}}`), sets `storageContextConfig.basePath` to `"1 Admin/Communication"`, and runs the `FileCommProject` `MOVE_FILE` workflow.
   - [`assets/document-types/communication-proposal.json`](assets/document-types/communication-proposal.json): Mirrors the communication fields and `commFolderName` calculation under `storageContextConfig.basePath: "Communications"` and runs the `FileCommProposal` `MOVE_FILE` workflow.

---

## Getting Started & Local Development

### Prerequisites

- **Node.js**: v20 or newer
- **npm**: Included with Node.js
- **Pulumi CLI**: Required for infrastructure typechecking and unit tests in `infra/pulumi/`
- **Semgrep**: Required for architectural boundary lint checks (`npm run lint`)

### Installation & Environment Variables

1. Install root and infrastructure dependencies:
   ```bash
   npm install
   npm --prefix infra/pulumi install
   ```
2. Copy [`/.env.example`](.env.example) to `.env` for local execution or integration testing:
   ```bash
   cp .env.example .env
   ```

| Variable | Default in `.env.example` | Description |
| :--- | :--- | :--- |
| **`APP_MANIFEST_PATH`** | `./assets/manifest.json` | Relative or absolute filesystem path to the runtime `Manifest` JSON file. |
| **`PORT`** | `8080` | TCP port the Fastify HTTP server listens on. |
| **`HOST`** | `0.0.0.0` | Network interface address bound by the Fastify HTTP server. |
| **`GOOGLE_CLIENT_ID`** | `your-google-client-id.apps.googleusercontent.com` | Google Cloud OAuth 2.0 Client ID used for local E2E tests against live Google APIs. |
| **`GOOGLE_CLIENT_SECRET`** | `your-google-client-secret` | Google Cloud OAuth 2.0 Client Secret paired with `GOOGLE_CLIENT_ID`. |
| **`GOOGLE_REFRESH_TOKEN`** | `your-user-oauth-refresh-token` | Delegated user OAuth 2.0 refresh token used by local E2E tests. |
| **`TEST_DRIVE_FILE_ID`** | *(empty)* | Optional Google Drive file ID targeted by synthetic E2E tests. |
| **`SKIP_JWT_VERIFICATION`** | `false` | When set to `true` in local development, bypasses Google Workspace Add-on request JWT signature verification. |

### Development & Quality Gate Commands

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Start the local Fastify server (`src/app/server.ts`) via `tsx`. |
| `npm run build` | Compile TypeScript source files into `dist/` using `tsconfig.build.json`. |
| `npm start` | Run the compiled production server (`node dist/src/app/server.js`). |
| `npm test` | Run the full Vitest suite and Pulumi infrastructure unit tests. |
| `npm run test:all` | Run all application unit, integration, validation, and Pulumi infrastructure tests. |
| `npm run test:infra` | Run the Pulumi infrastructure unit test suite (`infra/pulumi`). |
| `npm run typecheck` | Run strict TypeScript typechecking across both the root project and `infra/pulumi`. |
| `npm run lint` | Run ESLint and Semgrep hexagonal architecture guardrail rules (`semgrep.yml`). |
| `npm run generate:manifest` | Render and validate the Google Workspace Add-on deployment manifest from `infra/deployment.template.json`. |
| `npm run generate:branding` | Deterministically generate the `48x48` companion icons (`icon-48x48.png`, `icon-dev-48x48.png`) and `1280x800` Marketplace screenshot (`screenshot-1280x800.png`). |

---

## Deployment & Release Summary

`INC-IO Docs` deploys to isolated Google Cloud Platform projects for development and production via GitHub Actions OIDC Workload Identity Federation and Pulumi Infrastructure as Code:

| Dimension | Development (`dev`) | Production (`prod`) |
| :--- | :--- | :--- |
| **Git Branch** | `develop` | `main` |
| **GCP Project** | `inc-io-docs-dev` | `inc-io-docs-prod` |
| **Pulumi Stack** | `dev` (`infra/pulumi/Pulumi.dev.yaml`) | `prod` (`infra/pulumi/Pulumi.prod.yaml`) |
| **Add-on Display Name** | `"INC-IO Docs (Dev)"` | `"INC-IO Docs"` |
| **Companion Icon** | [`icon-dev-48x48.png`](assets/branding/icon-dev-48x48.png) (greyscale on `#EAEAEA` tile) | [`icon-48x48.png`](assets/branding/icon-48x48.png) (black hex mark on transparent background) |
| **Distribution & Install** | Unlisted developer CLI deployment (`gcloud workspace-add-ons deployments replace`) | Private Domain-Only (`PRIVATE_DOMAIN_ONLY`) Google Workspace Marketplace listing & Admin Console domain install |
| **Release Artifact** | Continuous deployment on push to `develop` | Tagged `v0.5.0` GitHub Release archive with auto-generated release notes on `main` |

---

## License

This project is licensed under the **ISC License**.
