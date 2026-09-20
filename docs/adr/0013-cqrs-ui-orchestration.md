# 13. CQRS UI Orchestration

Date: 2026-09-20

## Status

Accepted

## Context

The Google Workspace Addon infrastructure adapter (`api.ts`) was found to contain complex business logic regarding UI state management (e.g., defaulting Document Spaces, parsing Document Types, building SelectionState). Moving this logic into the `src/app/` wiring layer violated the strict "wiring only" constraint of our coding standards. Placing it within the `schema-driven-ui` feature violated feature isolation, as it forced the generic UI engine to know about specific domains like `document-space`.

## Decision

We will implement a CQRS pattern for the UI layer by splitting responsibilities across two distinct feature slices:

1. **`ui-process-manager` (Command/Write Model)**: A new feature slice responsible for state management orchestration. It evaluates incoming UI state and events, decomposes the appropriate information, and passes it to various domains via ports. It translates human-readable display names back into domain keys for backend processing.
2. **`schema-driven-ui` (Read Model)**: Acts as a pure, read-only UI orchestrator. It receives a clean view state and constructs the abstract `UiView`. It is responsible for fetching or resolving display names for rendering.

The workflow:
- On an event trigger, the infrastructure UI passes the UI state, triggers/events, and context to the `ui-process-manager` through the `src/app/` wiring layer.
- The `ui-process-manager` evaluates the state, decomposes the information, and passes it to the various features via ports.
- Once the state change is complete, the `ui-process-manager` passes the state back to the `schema-driven-ui` feature (through ports/wiring) to generate the UI update.
- The infrastructure UI module then receives this and updates the client UI.

## Consequences

- **Pros**: Perfectly isolates `schema-driven-ui` as a generic rendering engine. Keeps infrastructure (`api.ts`) pure. Maintains feature isolation by defining explicit ports for cross-domain orchestration.
- **Cons**: Increases structural complexity by requiring a new feature slice and additional port definitions for the round-trip CQRS flow.
