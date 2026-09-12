# Feature-Based Composition Roots

We will modularize the `src/app/` wiring layer using per-feature factory functions (e.g., `src/app/<feature>.wiring.ts`) instead of a monolithic bootstrap script or a global dependency injection framework.

A single global script becomes an untanglable "Big Ball of Mud" as features grow. By delegating the wiring of each feature to its own setup function, the blast radius of structural refactoring (such as upgrading a Fast-Track Read to a Guarded Read) is contained strictly to that feature's wiring module.

## Considered Options
- **Global DI Framework (e.g., InversifyJS, NestJS):** Rejected. Magic decorators obscure the dependency graph and couple the codebase to a specific framework. Manual functional wiring provides total compile-time safety and clarity.
- **Monolithic `index.ts`:** Rejected. It fails to preserve the isolated, self-contained nature of our feature slices at the application boundary.
