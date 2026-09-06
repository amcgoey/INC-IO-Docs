# UiBlock Functional Composition

We will build the Google Workspace Add-on user interface using stateless, pure TypeScript functional composers (UiBlocks) rather than a dynamic JSON registry and factory pattern.

## Decisions

### 1. Pure Functional Composers
UiBlocks are pure, stateless functions. We compose the UI in TypeScript (e.g., `buildHeader`, `buildSection`) to gain compile-time validation of the Add-on schema, eliminating the runtime parsing fragility of JSON configurations.

### 2. High Locality
Feature-specific UI cards (e.g., `DriveDocumentProcessCard`) live directly inside their respective feature adapters. This co-locates business flow changes with UI changes.

### 3. Dependency Inversion
Feature adapters depend exclusively on a UI builder port (e.g., `WorkspaceUiBuilderPort`), never on concrete infrastructure files. We inject the concrete `ui-blocks.ts` infrastructure module into the adapters at the composition root (`src/app/server.ts`). This preserves strict Hexagonal Architecture boundaries and ensures UI builders are completely mockable for unit testing.

## Rejected Alternatives

- **JSON-driven factory**: Rejected for introducing unnecessary indirection, masking schema errors until runtime, and centralizing feature-specific definitions into a generic infrastructure layer.
- **Returning DTOs for Infrastructure Mapping**: Rejected for requiring excessive mapping boilerplate when the driving adapter's explicit role is to translate domain events into UI responses.
- **Shared Utilities Folder Exception**: Rejected for blurring architectural boundaries. Injecting pure infrastructure via a port at the composition root is the standard Hexagonal pattern and avoids directory structure exceptions.
