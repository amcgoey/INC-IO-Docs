# Hybrid Hexagonal Architecture

We will structure the codebase using a hybrid of Package-by-Feature and standard Hexagonal Architecture, balancing **Locality** with **Leverage**.

1. **Features (src/features/)**: High locality. Each feature is self-contained with its own domain logic, ports (seams), and specific adapters. Deleting a feature folder removes all of its associated code cleanly.
2. **Infrastructure (src/infrastructure/)**: High leverage. Deep, domain-agnostic modules that hide the complexity of external systems (e.g., Google Drive APIs, Fastify setup). These must never import from Features/.
3. **App (src/app/)**: The wiring layer where infrastructure clients are injected into feature-specific adapters.

We rejected the strict layer-first structure (src/ports/, src/adapters/) because it scatters feature logic across too many top-level folders, making it harder to maintain and harder to delete features cleanly.
