# Separation of Activity Payload and Execution Context

**Status:** accepted

We established a strict separation between the `payload` processed by an `Activity` and the `context` it executes within, driven by a hard security invariant.

## Context
Previously, the `WorkspaceExecutionContext` was passed through the Record domain as an opaque `TContext = unknown`. To deepen this seam and resolve type-safety issues (Issue 64), we considered mapping workspace context data (like `fileId` and `userOAuthToken`) directly into the activity's JSON `payload`, effectively removing the need for a separate context object.

## Decision
We rejected merging contextual data into the payload. The Record domain now explicitly defines a generic, typed `RecordContext` interface (e.g., exposing `credentials` and `resources`) that adapters must satisfy. The `payload` and `context` remain strictly separated at the interface level.

## Consequences
- **Security:** Ephemeral secrets (like `userOAuthToken`) are kept out of the `payload`. Because the payload represents domain data that may be logged, serialized, or stored, keeping secrets isolated in the `context` prevents accidental credential leaks.
- **Deep Seam:** The Record domain explicitly declares what external context it requires, forcing callers (like the Workspace adapter) to map their specific environment variables into a domain-agnostic shape before dispatching activities.
