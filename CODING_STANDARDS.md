# Coding Standards & Repository Structure

This project follows **Hexagonal Architecture** (Ports and Adapters).
Enforce the following rules when creating or modifying code:

## Directory Structure
The structure balances **Locality** (feature-first) with **Leverage** (shared, domain-agnostic infrastructure deep modules):

- `.agents/`: Agent configuration files, local custom skills, and behavior overrides.
- `assets/`: Static assets like images and branding materials.
- `docs/`: Project documentation, architectural decision records (ADRs), and agent-specific guidelines (`docs/agents/`).
- `infra/`: Infrastructure deployment scripts and configuration (e.g., `bootstrap.ps1`).
- `lessons/`: Learning materials, tutorials, or guides.
- `scratch/`: Temporary workspace. Agents should write all temporary files (ticket drafts, subagent exchanges, etc.) here.
- `src/features/`: Contains self-contained feature slices (e.g. `document/`).
  - `.../domain.ts`: Core business logic models. **No external dependencies** (except `Typebox` which acts as a language extension).
  - `.../ports.ts`: Interfaces defining the feature's explicit seams (driving and driven).
  - `.../adapters/`: Implementations that bridge the feature's ports to the outside world or infrastructure.
- `src/infrastructure/`: Pure, domain-agnostic heavy lifters (e.g., `drive/`, `workspace-addon/`, `http/`). These must **never** import from `features/`.
- `src/app/`: The wiring layer. This is the only place where infrastructure modules are injected into feature adapters.
  - **Modular Wiring**: Do not wire feature dependencies in a monolithic `index.ts` or use a global DI framework. You must create per-feature composition roots (e.g., `src/app/document.wiring.ts`). 
  - The main entrypoint simply boots infrastructure and passes it into these feature factories, containing the blast radius of structural refactors to isolated files.
- `test/`: E2E and integration tests that span multiple features. Unit tests must be co-located next to their subjects (e.g., `**/*.test.ts`) inside `src/`.

## Rules
1. **Dependency Inversion**: Domain and Ports must never import from Adapters. Adapters depend on Ports.
2. **Type-Safety**: Use `Typebox` for JSON schema validation and TypeScript type inference.
3. **Testing**: Use `Vitest`. Unit tests must be co-located with their subjects in `src/` and should mock driven ports. Integration tests in `test/` can test the real adapters.
4. **Verification**: A change is not complete until `npm run typecheck` and `npm run lint` pass cleanly.
5. **Read Patterns (Fast-Track vs Guarded):** Route reads based on their need for business logic.
   - **Fast-Track Read**: Route pure data queries directly from a driving adapter to a driven port. Bypass the domain core entirely to keep `domain.ts` strictly focused on business invariants.
     - *Use when*: The query is a direct data extraction requiring no business logic.
     - *Mechanics*: Define the required port interface in `ports.ts` (returning `Typebox` schemas/types, never infrastructure entities). Inject the port directly into the adapter. Wire it in `src/app/`.
     - *Switch to Guarded when*: A new requirement introduces business-level authorization, data masking, or invariant-based calculations.
   - **Guarded Read**: Route queries through `domain.ts` to enforce business rules before returning data.
     - *Use when*: The read must enforce domain invariants, compute derived fields, or apply role-based data masking.
     - *Switch to Fast-Track when*: The domain method degrades into a pure pass-through that solely returns the port's output without applying logic.
