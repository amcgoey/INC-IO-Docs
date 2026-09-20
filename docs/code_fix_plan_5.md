# Code Fix Plan 5: Refactoring Convergence & Review Evaluation

## Executive Summary
This plan addresses the latest code review findings on Issue 124, Epic 122, and related architectural specifications. The findings have been evaluated against our Hexagonal Architecture rules, and we have separated defects into "Fix Now" (hard violations and strong baseline smells) and "Keep / As-Is" (false positives or items already addressed).

## Convergence & Spec Inconsistency Analysis
The dual-axis code review found strict standards violations relating to the placement of Ports and Types in the wiring layer, as well as baseline duplication smells in adapters. The codebase is converging towards strict separation between the `src/app/` composition layer and the feature/infrastructure layers. We must fix port locations to keep `src/app/` purely for wiring.

## "Keep / As-Is" List
- **Spec Finding (b): Scope Creep (Renaming `clearDocumentInfoSegment` to `retainSelectionState` in `domain.ts`)**
  - **Justification**: This rename was intentionally done in `code_fix_plan_2.md` to resolve a Mysterious Name code smell and better reflect the intent. It is an improvement, not a defect. Keep as-is.

## "Fix Now" List

### 1. Standards Hard Violation 1: `RawManifestProviderPort` in Adapter
- **File**: `src/features/ui-process-manager/adapters/manifest.adapter.ts` and `src/features/ui-process-manager/ports.ts`
- **Change**: Move `RawManifestProviderPort` from `manifest.adapter.ts` into `ports.ts`.
- **Implementation Steps**:
  1. Add `RawManifestProviderPort` definition to `src/features/ui-process-manager/ports.ts`.
  2. Import `RawManifestProviderPort` in `manifest.adapter.ts` from `../ports`.

### 2. Standards Hard Violation 2: `WorkspaceConfiguration` in Wiring Layer
- **File**: `src/app/workspace-addon.wiring.ts`, `src/infrastructure/workspace-addon/config.ts` (new)
- **Change**: Remove `WorkspaceConfiguration` and `WorkspaceConfigProviderPort` from the wiring layer.
- **Implementation Steps**:
  1. Create `src/infrastructure/workspace-addon/config.ts` and define `WorkspaceConfigProviderPort` in it. It should import `WorkspaceConfiguration` from `../manifest/app-manifest-provider`.
  2. Update `src/app/workspace-addon.wiring.ts` to import `WorkspaceConfigProviderPort` from `../infrastructure/workspace-addon/config` and `WorkspaceConfiguration` from `../infrastructure/manifest/app-manifest-provider`.

### 3. Baseline Smell 1: Duplicated `FormChangeEvaluator` Types
- **File**: `src/app/ui-process-manager.wiring.ts`
- **Change**: Remove duplicated `FormChangeEvaluator` type definition and use `FormChangeEvaluatorFn` from `form-evaluator.adapter.ts`.
- **Implementation Steps**:
  1. In `src/app/ui-process-manager.wiring.ts`, delete the `FormChangeEvaluator` type block.
  2. Import `FormChangeEvaluatorFn` from `../features/ui-process-manager/adapters/form-evaluator.adapter` and rename it to `FormChangeEvaluator` in the import, or just use `FormChangeEvaluatorFn`.

### 4. Baseline Smell 2: Repeated branching in `ManifestAdapter`
- **File**: `src/features/ui-process-manager/adapters/manifest.adapter.ts`
- **Change**: Extract array-vs-object manifest parsing into a private helper method `parseDocumentTypes`.
- **Implementation Steps**:
  1. Add `private parseDocumentTypes(rawManifest: unknown)` to normalize and return the document types.
  2. Refactor `getAllDocumentTypes` and `getDocumentTypeSchemas` to use this helper.

### 5. Spec Finding (c): Swallowed Form Evaluation Errors
- **File**: `src/features/ui-process-manager/adapters/workspace-addon.adapter.ts`
- **Change**: Render an error card when form evaluation fails instead of just logging to console.
- **Implementation Steps**:
  1. Extract `renderErrorCard` outside of the `processDocument` block so it is accessible to the whole `processUiEvent` method.
  2. In the `actionName === 'onFormChange'` block, inside the `catch (e)`, return `await renderErrorCard([e instanceof Error ? e.message : 'Form change evaluation failed'])`.

## Verification Plan

### Automated Tests
- Run `npm run test` or `npx jest` to ensure no unit tests are broken.
- Ensure typecheck passes with `npx tsc --noEmit`.

### Manual Verification
- Review the `src/app` layer to verify no domain ports or schemas are exported.
- Confirm form evaluation errors render as an update card with the `validationErrors` prop populated.
