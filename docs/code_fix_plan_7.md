# Issue 124 Code Review Evaluation & Fix Plan

## Executive Summary
After evaluating the recent code review findings against the Issue 124 spec, the codebase is generally converging well toward the CQRS UI Orchestration epic goals. Most flagged defects are legitimate technical debt items (Standards Violations, Baseline Smells) that should be addressed immediately to preserve architectural boundaries. However, the Spec Review findings are largely false positives. The perceived "scope creep" consists of legitimate refactoring of baseline smells, and the "dead parameter" is actively used in error handling.

## Defect Categorization

### Fix Now
These defects violate strict architectural rules or code quality standards and must be resolved.

1. **Standards Violation (Wiring Modules Tangling):** `src/app/ui-process-manager.wiring.ts` importing mapping logic from `src/app/workspace-addon.wiring.ts`.
   - *Justification:* Hexagonal architecture dictates strict per-feature composition roots. Domain-to-infrastructure mapping logic belongs in the infrastructure layer, not in wiring files.
2. **Baseline Smell (Duplicated Code):** `renderErrorCard` and `viewGenerator.generateCard` in `src/features/ui-process-manager/adapters/workspace-addon.adapter.ts`.
   - *Justification:* DRY principle. Both invoke `evaluateProcessUiState` and `generateCard` with nearly identical shapes.
3. **Baseline Smell (Middle Man):** Pass-through re-exports across `manifest.adapter.ts`, `ui-process-manager.wiring.ts`, and `workspace-addon.wiring.ts`.
   - *Justification:* Unnecessary indirection. Types should be imported directly from their defining modules/ports.
4. **Baseline Smell (Speculative Generality):** `if (this.manifestProvider.readParsedSchema)` check in `manifest.adapter.ts`.
   - *Justification:* `readParsedSchema` is a required method on the `RawManifestProviderPort` interface, rendering the existence check redundant.

### Keep / As-Is
These findings are false positives or misunderstandings of the spec/code context.

1. **Spec Review (Scope Creep Citations):** Removal of `outputs` from `ports.ts` and `filterFormData`.
   - *Justification:* These were explicitly executed in response to code review baseline smells. Fixing baseline smells during a targeted refactor is a standard practice, not scope creep.
2. **Spec Review (Dead Parameter in `api.ts`):** `endpointName` in `handleUiRoute`.
   - *Justification:* The parameter is actively utilized in the catch block on line 79 (`Unknown error in ${endpointName}`) to provide context-rich error logging. It is not dead.

## Implementation Steps

### 1. Fix Wiring Modules Tangling
Move mapping functions from `src/app/workspace-addon.wiring.ts` to `src/infrastructure/workspace-addon/translator.ts`. Update imports.

**Files to Touch:**
- `src/infrastructure/workspace-addon/translator.ts`
- `src/app/workspace-addon.wiring.ts`
- `src/app/ui-process-manager.wiring.ts`

**Before (`src/app/workspace-addon.wiring.ts`):**
```typescript
export function mapSelectionItems(items: Array<{ text: string; value: string; selected?: boolean | undefined }>) { ... }
function mapActionParameters(...) { ... }
function mapUiAction(...) { ... }
export function mapUiViewToAbstractUiView(view: UiView): AbstractUiView { ... }
```

**After (`src/infrastructure/workspace-addon/translator.ts`):**
```typescript
// Add imports for UiView
import type { UiView } from '../../features/schema-driven-ui/domain';

export function mapSelectionItems(items: Array<{ text: string; value: string; selected?: boolean | undefined }>) { ... }
function mapActionParameters(...) { ... }
function mapUiAction(...) { ... }
export function mapUiViewToAbstractUiView(view: UiView): AbstractUiView { ... }
```
*Note: Remove these from `workspace-addon.wiring.ts` and update imports in `ui-process-manager.wiring.ts` to pull from `translator.ts`.*

### 2. DRY up `workspace-addon.adapter.ts`
Create a unified `renderCardState` helper inside `processUiEvent`.

**Files to Touch:**
- `src/features/ui-process-manager/adapters/workspace-addon.adapter.ts`

**Before:**
```typescript
    const renderErrorCard = async (validationErrors: string[]) => {
      const state = evaluateProcessUiState({
        // ...
      });
      return await viewGenerator.generateCard({
        // ...
      });
    };
    // ... later ...
    const state = evaluateProcessUiState({
      // ...
    });
    return await viewGenerator.generateCard({
      // ...
    });
```

**After:**
```typescript
    const renderCardState = async (stateContext: { validationErrors?: string[], isUpdateCard?: boolean, formData?: Record<string, unknown>, hiddenFields?: string[] }) => {
      const state = evaluateProcessUiState({
        context: {
          ...context,
          formData: stateContext.formData ?? context.formData,
          ...(stateContext.isUpdateCard ? { isUpdateCard: true } : {}),
          ...(stateContext.validationErrors ? { validationErrors: stateContext.validationErrors } : {}),
        },
        resolvedDocumentTypeKey,
        resolvedSpaceType: currentSpaceType,
        config: mappedConfig,
        spaceTypes,
        collectionSpaces,
      });

      return await viewGenerator.generateCard({
        viewId: state.viewId,
        documentTypeKey: state.documentTypeKey,
        selectionState: state.selectionState,
        formData: state.formData,
        isUpdateCard: state.isUpdateCard,
        ...(stateContext.hiddenFields !== undefined ? { hiddenFields: stateContext.hiddenFields } : {}),
        ...(state.validationErrors ? { validationErrors: state.validationErrors } : {}),
      });
    };

    // Replace renderErrorCard with:
    const renderErrorCard = async (validationErrors: string[]) => renderCardState({ validationErrors, isUpdateCard: true });

    // Replace end of function with:
    return await renderCardState({
      formData: evaluatedFormData,
      hiddenFields,
      isUpdateCard: actionName === 'onFormChange'
    });
```

### 3. Remove Pass-through Re-exports
**Files to Touch:**
- `src/features/ui-process-manager/adapters/manifest.adapter.ts`
- `src/app/ui-process-manager.wiring.ts`
- `src/app/workspace-addon.wiring.ts`

**Implementation:**
Delete the `export type { ... }` statements in these files. Ensure that consumers are importing these types directly from their original sources (`../ports` or infrastructure configuration).

### 4. Remove Speculative Generality
**Files to Touch:**
- `src/features/ui-process-manager/adapters/manifest.adapter.ts`

**Before:**
```typescript
          if (this.manifestProvider.readParsedSchema) {
            const parsed = (await this.manifestProvider.readParsedSchema(relPath)) as ...
```

**After:**
```typescript
          const parsed = (await this.manifestProvider.readParsedSchema(relPath)) as ...
```

## Verification Plan
1. **Automated Tests:** Run existing unit tests to ensure wiring and view generation logic remain intact after refactoring.
2. **Type Checking:** Run `tsc --noEmit` to guarantee that the removal of re-exports and movement of mapping functions maintain valid TypeScript definitions.
3. **Manual Verification:** Trigger an `onFormChange` event or verify the initial render logic of the UI to ensure components are still wired together properly without the duplicate logic.
