## Agent skills

### Issue tracker

Issues and specs for this repo live as GitHub issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five canonical triage roles. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo layout. See `docs/agents/domain.md`.

## Coding Standards & Repository Structure

This project follows **Hexagonal Architecture** (Ports and Adapters).
Enforce the following rules when creating or modifying code:

### Directory Structure
The structure balances **Locality** (feature-first) with **Leverage** (shared, domain-agnostic infrastructure deep modules):

- `src/features/`: Contains self-contained feature slices (e.g. `document/`).
  - `.../domain.ts`: Core business logic models. **No external dependencies** (except `Typebox` which acts as a language extension).
  - `.../ports.ts`: Interfaces defining the feature's explicit seams (driving and driven).
  - `.../adapters/`: Implementations that bridge the feature's ports to the outside world or infrastructure.
- `src/infrastructure/`: Pure, domain-agnostic heavy lifters (e.g., `drive/`, `workspace-addon/`, `http/`). These must **never** import from `features/`.
- `src/app/`: The wiring layer. This is the only place where infrastructure modules are injected into feature adapters.
- `test/`: E2E and integration tests that span multiple features. Unit tests must be co-located next to their subjects (e.g., `**/*.test.ts`) inside `src/`.

### Rules
1. **Dependency Inversion**: Domain and Ports must never import from Adapters. Adapters depend on Ports.
2. **Type-Safety**: Use `Typebox` for JSON schema validation and TypeScript type inference.
3. **Testing**: Use `Vitest`. Unit tests must be co-located with their subjects in `src/` and should mock driven ports. Integration tests in `test/` can test the real adapters.
