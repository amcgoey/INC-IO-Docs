# 0010 - Centralized Schema-Driven UI

Date: 2026-09-19

## Status

Accepted

## Context

Building a cohesive UI across the application requires coordination between different domain features and schemas. Previously, UI creation was decentralized, with each domain feature responsible for constructing its own UI objects.

Because our core schemas (`UiSchema`, `DocumentSchema`, etc.) are designed to specify implementation details abstractly, allowing core features to individually construct their UI resulted in dependency problems and polluted the domain features with presentation logic. Furthermore, the UI requires knowledge of how to translate JSON Logic into infrastructure-specific behaviors, which should not bleed into core domains.

## Decision

We have centralized UI presentation into a dedicated `schema-driven-ui` feature module. 

1. **Centralized UI Translation**: The `schema-driven-ui` feature acts as a pure consumer of abstract schemas. It fetches these schemas (like `UiSchema` and `DocumentSchema`) directly from the App Manifest via a driven port. It uses pure `UiBlock` functions to translate these schemas into a coordinated, abstract, and flattened `UiView`.
2. **Schema Purity**: Core domain features remain strictly focused on their domain logic and no longer construct UI. Their schemas (`DocumentSchema`) are used independently by the `schema-driven-ui` module for presentation.
3. **Guarded Read**: As established in [ADR 0011](0011-fast-track-and-guarded-reads.md), UI generation is modeled as a Guarded Read routed through `schema-driven-ui/domain.ts`, ensuring validation and safe orchestration of the UI blocks.
4. **Infrastructure-Specific Adapters (`UiViewSchema`)**: The exact composition of `UiBlock`s is dictated by a `UiViewSchema`. These `UiViewSchema`s are hard-coded into infrastructure-specific driving adapters located *inside* the `schema-driven-ui` feature (e.g., `workspace-addon.adapter.ts`).
5. **Dumb-Renderer Infrastructure**: The `schema-driven-ui` feature emits a generic `UiView`. The actual infrastructure UI modules (like Google Workspace Addon, React) act as dumb renderers that translate the `UiView`—including its JSON Logic interactions—into platform-specific UI behaviors (e.g., mapping to server roundtrips).
6. **Mutation Routing**: The infrastructure module handles all interaction triggers. It routes action mutations directly back to the core domain, bypassing the UI feature. If a mutation yields `validationErrors`, the infrastructure passes that error context back into its subsequent read request to `schema-driven-ui` so error blocks can be rendered inline.
7. **Abstract Terminology**: We use `UiView` instead of proprietary names (like `UiCard`) to ensure the feature logic remains entirely infrastructure-agnostic.

## Consequences

- **Pros**: UI logic is completely isolated from core domain logic. Pure schemas drive the app presentation. Cross-feature UI coordination has a dedicated home. The infrastructure remains dumb.
- **Cons**: This introduces an intentional deviation from strict vertical feature locality in Hexagonal Architecture, as UI presentation for a feature is separated from the feature itself. This trade-off was accepted to prevent cross-feature UI coupling.
