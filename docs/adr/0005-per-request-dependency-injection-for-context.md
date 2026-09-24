# Per-Request Dependency Injection for Execution Context

**Status:** accepted

We manage ephemeral execution context (like OAuth tokens and request-scoped IDs) using Dependency Injection at the Composition Root, rather than passing context objects down the domain call stack.

## Context
Ephemeral credentials (like OAuth tokens) must remain strictly isolated from domain payloads to prevent credential leakage. Passing a side-channel `ExecutionContext` object alongside activities solves security but pollutes domain method signatures (`processDocument`, `fetchSpaces`) with optional context arguments unrelated to business logic.

## Decision
The application wiring layer (`src/app/`) intercepts authentication and request-scoped variables and uses them to construct the object graph of adapters and domain services.

### Composition Root Lifecycle Criteria

The lifecycle of the object graph depends entirely on the delivery mechanism (driving adapter). The Composition Root must evaluate the environment and choose the appropriate lifecycle strategy:

- **Use Per-Request DI when:** The delivery mechanism is stateless and receives ephemeral credentials per invocation (e.g., Google Workspace Addons, stateless HTTP endpoints). The wiring layer must expose factory functions to spin up a fresh, isolated graph for every request.
- **Use Singleton/Startup DI when:** The delivery mechanism maintains persistent state or uses long-lived credentials (e.g., CLI tools, background daemons, stateful desktop apps). The wiring layer must construct the graph exactly once at startup and reuse it.

## Consequences
- **Security Maintained:** Secrets remain strictly isolated from the domain payload.
- **Pure Domain Signatures:** Domain methods are fully decoupled from authorization mechanics, increasing testability and clarity.
- **Environment Agnosticism:** The domain does not know if it is hosted in a stateless request or a long-lived daemon; it simply receives ready-to-use adapters.
