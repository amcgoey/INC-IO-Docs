# Code Fix Plan 6

## Evaluation Summary
The codebase is steadily converging on a robust solution for Issue 124. The current findings are minor cleanups (import path corrections, DRYing up logic) rather than systemic design flaws. The spec remains consistent, and no blockers exist.

## Categorization & Justification

### Fix Now
1. **Rule 4 / Port Leakage in `ui-process-manager.wiring.ts`**
   - **Reason**: Hexagonal architecture standards require wiring modules to import ports directly from the feature's boundary (`ports.ts`), not from other wiring modules.
   - **Action**: Correct the import of `RawManifestProviderPort`.
2. **Duplicated Code in `domain.ts`**
   - **Reason**: The key filtering loop `for (const [key, value] of Object.entries(formData))` is duplicated across `retainSelectionState` and `extractDocumentData`.
   - **Action**: Extract a common helper function to filter form data based on a predicate.
3. **Speculative Generality in `ports.ts`**
   - **Reason**: `UiProcessDocumentExecutionResult.outputs` is defined but not utilized by the `WorkspaceAddonAdapter`. We should avoid speculative features per YAGNI principles. If Issue 125 needs it, it can be added then.
   - **Action**: Remove the `outputs` property.

### Keep / As-Is
1. **Primitive Obsession on literal string `'default'` in `WorkspaceAddonAdapter`**
   - **Reason**: Issue 126 is specifically targeted at "Default values refactoring". We will defer this cleanup to that ticket, consistent with how we deferred the `'projects'` primitive obsession.
2. **Items 1-7 from previous iterations**
   - **Reason**: Already evaluated and justified in previous plans. Kept for continuity.

## Implementation Steps

### 1. Fix Port Leakage
**File**: `src/app/ui-process-manager.wiring.ts`
**Before**:
```typescript
import { RawManifestProviderPort } from './schema-driven-ui.wiring';
```
**After**:
```typescript
import { RawManifestProviderPort } from '../features/ui-process-manager/ports';
```

### 2. DRY up Form Data Filtering
**File**: `src/features/ui-process-manager/domain.ts`
**Action**: Extract a shared filtering function and update `retainSelectionState` and `extractDocumentData`.
**Code Changes**:
```typescript
function filterFormData(formData: Record<string, unknown>, predicate: (key: string) => boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(formData)) {
    if (predicate(key)) {
      result[key] = value;
    }
  }
  return result;
}

// In retainSelectionState:
// const result = filterFormData(formData, key => !key.startsWith('SelectDocument'));

// In extractDocumentData:
// const documentData = filterFormData(formData, key => key.startsWith('SelectDocument'));
```

### 3. Remove Speculative Generality
**File**: `src/features/ui-process-manager/ports.ts`
**Before**:
```typescript
export interface UiProcessDocumentExecutionResult {
  // ... other properties
  outputs?: unknown[] | undefined;
}
```
**After**:
```typescript
export interface UiProcessDocumentExecutionResult {
  // ... other properties without 'outputs'
}
```
