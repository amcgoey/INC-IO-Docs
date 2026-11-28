# ADR 0025: Test Tier Isolation, Live Tracer Bullets, and Google Retry/Resolution Seams

- **Status**: Accepted
- **Date**: 2026-11-27
- **Related Issues**: `#403`
- **Related ADRs**: [ADR 0001](0001-hybrid-hexagonal-architecture.md), [ADR 0005](0005-per-request-dependency-injection-for-context.md), [ADR 0020](0020-document-log-feature-isolation-and-resolution-seam.md), [ADR 0021](0021-document-log-schema-and-resilient-hydration.md), [ADR 0022](0022-positive-termination-sheets-mechanics-and-formula-protection.md), [ADR 0023](0023-lookup-options-feature-and-document-log-option-tables.md), [ADR 0024](0024-document-content-editor-port-template-indirection-and-pdf-grafting.md)

## Context

End-to-end verification against live Google Workspace services shares a per-user `60 ReadRequestsPerMinutePerUser` Google Sheets quota, while offline test suites rely on global `nock` HTTP interceptors, fake timers, and CLI shims. Running live tests inside the default test runner, repeating full combinatorial flows against live spreadsheets, retrying rate-limit errors inconsistently across adapters, caching transient lookup timeouts, or running `nock`/fake-timer cases concurrently inside one file causes quota exhaustion, cross-test flakiness, and masked storage failures.

## Decision

### 1. Four-Tier Test Architecture & Runner Isolation

- Partition verification into four conceptual tiers:
  1. **Offline application and integration (`test`)**: fast, deterministic unit, adapter, and offline E2E suites.
  2. **Infrastructure bootstrap and Pulumi (`test:infra`)**: Pulumi previews, infrastructure workflows, and bootstrap CLI tests.
  3. **Full offline CI gate (`test:all`)**: combined offline application, integration, and infrastructure suites.
  4. **Sequential live Google API (`test:live` and scoped `test:live:<scope>`)**: opt-in contract suites under `test/live/*.live.test.ts`.
- Keep offline E2E suites in `test/e2e/` (`workspace-addon-e2e.test.ts`, `live-google-auth.test.ts`, `live-sheets-helper.test.ts`) inside the offline tier, and configure offline Vitest runners to exclude `test/live/` so local `.env` credentials remain inert during offline runs and workers make zero live network calls.

### 2. Live Contract Tracer Bullets, Offline Seam Coverage & 60/min Quota Ceiling

- Execute live suites sequentially (`fileParallelism: false`) through a shared modular `LiveTestHarness` facade to stay within Google Sheets' `60 ReadRequestsPerMinutePerUser` quota ceiling.
- Budget `<=45` cumulative Google Sheets reads across the full `test:live` run (targeting a `~45–60s` soft runtime benchmark) by keeping `test/live/*.live.test.ts` focused on lean contract tracer bullets (using pre-seeded `MB` contacts for non-writeback checks).
- Place combinatorial, edge-case, `DocumentSpaceType`, and error-matrix coverage in offline seam tests backed by `nock` and `MultiSpreadsheetSim`.

### 3. Google Retry, Timeout Cancellation & `readOptionTables` Seams

- **Unified rate-limit retry**: `GoogleSheetsClient`, `GoogleDriveClient`, and live helpers delegate rate-limit retries to `executeWithRateLimitRetry` (`src/infrastructure/google/retry.ts`). Both clients preserve `private async executeWithRetry` for dynamic configuration reads and prototype spies, and `GoogleSheetsClient` runs retry inside `wrapApiError`'s `try/catch` so raw `403` quota reasons (`isRateLimitOrQuotaError`) remain inspectable before error wrapping.
- **Timeout cancellation and cache integrity**: `LookupOptionsService` keeps `5,000 ms` as its production default timeout while propagating an `AbortSignal` through `DocumentLogOptionSourcePort`, `DriveOptionSourcePort`, and `executeWithRateLimitRetry`. `LookupOptionsService` records only settled non-timeout outcomes in `documentLogBatchCache`, leaving transient timeouts uncached for subsequent requests (`LiveTestHarness` may inject a higher `lookupTimeoutMs` paired with explicit API-call-count assertions).
- **`DocumentLogPort.readOptionTables` resolution seam**:
  - Attempt a `selectedLogId` fast-path read directly against Google Sheets with zero Google Drive discovery.
  - Fall back to `resolveLog(space)` solely when `LogStoragePort` throws a typed inaccessible-storage error mapped from HTTP `404` or non-quota `403` (`!isRateLimitOrQuotaError`), propagating quota `403`, `400`, `401`, `429`, and `5xx` errors directly.
  - Guard the fallback against re-reading the same `spreadsheetId`, memoize the fallback resolution per request, and preserve cross-space `selectedLogId` trust at `DocumentLogPort` (matching [ADR 0020](0020-document-log-feature-isolation-and-resolution-seam.md), with `UiProcessManager` reconciling `DocumentSpace` changes).
  - Return `missing_log` when `space` is omitted and `selectedLogId` is inaccessible.

### 4. Safe Offline Parallelism Seams

- Split monolithic `nock` and fake-timer integration suites (`workspace-drive-integration.test.ts`, `workspace-gmail-integration.test.ts`) across isolated Vitest worker files for safe cross-file parallelism. Keep tests inside each `nock`/fake-timer file sequential (no `it.concurrent`), restore `vi.useRealTimers()` in teardown, and cache `PDFDocument` fixture bytes at module scope.
- Use bounded `it.concurrent` with isolated per-test local shims cleaned up in `try/finally` blocks for CLI-spawning bootstrap tests.

### 5. Two-Stage Live Verification in `implement-spec`

- **Ticket implementers**: run offline verification plus only the relevant scoped `test:live:<scope>` suite when modifying Google API seams.
- **Integration gate**: run the full sequential `test:live` suite once on the integration branch upon entering the Review & Convergence Loop and again after any Google-seam review fix.

## Consequences

- Offline CI (`test:all`) stays fast, deterministic, and isolated from local credentials while parallelizing safely across worker processes.
- Live verification confirms real Google Workspace contract behavior within the `60 ReadRequestsPerMinutePerUser` quota ceiling without duplicating combinatorial offline coverage.
- Rate-limit retries, `AbortSignal` cancellation, and `selectedLogId` fallback behavior remain uniform across Google adapters, `DocumentLog`, and `LookupOptions`.
