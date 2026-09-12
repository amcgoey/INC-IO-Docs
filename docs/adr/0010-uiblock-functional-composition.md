# 0010 - Declarative UI with Dumb-Renderer and Smart Presenters

We will build the Google Workspace Add-on user interface using a declarative UI architecture featuring Smart Presenters and a Dumb-Renderer, rather than procedural composition.

## Decisions

### 1. Dumb-Renderer Infrastructure
The infrastructure layer will act as a "dumb renderer". It will expose a single deep module/port (`UiRendererPort` with a `render(card: UiCard)` method) that purely translates an abstract, declarative schema into Google Workspace JSON. It will contain zero domain knowledge.

### 2. Purely Generic Abstract Schema (`UiCard`)
We will use a purely generic declarative UI schema (e.g., `UiText`, `UiDropdown`) rather than Google-specific layout keys. This completely decouples the feature layers from Google's proprietary UI API. Interactivity and routing will be modeled via generic `RouteAction` objects that the dumb renderer maps to concrete endpoints.

### 3. Schema as Infrastructural Contract
The `UiCard` Typebox schemas will live in `src/infrastructure/workspace-addon/models/`. Feature adapters (sitting on the outside of the Hexagon) will import these schemas to build the UI object. This is a pragmatic necessity to share the data contract with the renderer while keeping the presenter decoupled from heavy external SDKs, ensuring testability.

### 4. Smart Presenters (UiBlocks)
Reusable UI component logic ("UiBlocks") will live inside feature adapters as pure presenter functions. They will construct and return the declarative `UiCard` schemas, keeping domain logic and UI layout cleanly co-located without duplicating wiring boilerplate.

## Rejected Alternatives

- **Procedural Composition (Previous ADR-0010 iteration)**: The original strategy mandated pure TypeScript composers but inadvertently allowed domain logic (e.g., `DocumentSelectionState`) to leak into the infrastructure layer, and forced feature adapters to couple to infrastructure-specific UI builder methods. Superseded by this Dumb-Renderer pivot.
- **Returning DTOs for Infrastructure Mapping**: Rejected for requiring excessive mapping boilerplate when the driving adapter's explicit role is to translate domain events into UI responses. The pure generic schema strikes the right balance between abstraction and ergonomics.
