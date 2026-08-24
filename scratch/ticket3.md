## Parent
#21

## What to build
Completes the side-effect orchestration. The Core domain is updated to yield a declarative `Activity` command for valid payloads. This command is dispatched across the new `ActivityDispatcherPort` to a stateless `ActivityEngine` adapter, which executes a mock operation (like a console log) to prove the driven seam.

## Acceptance criteria
- [ ] `Activity` and `ActivityDispatcherPort` are defined in the domain/ports.
- [ ] Domain yields an `Activity` command upon successful validation.
- [ ] `ActivityEngine` is implemented as a driven adapter and logs to the console.
- [ ] The wiring layer (`server.ts`) injects `ActivityEngine` into the feature.
- [ ] Unit tests mock the driven port and assert the correct `Activity` is yielded.

## Blocked by
- #23
